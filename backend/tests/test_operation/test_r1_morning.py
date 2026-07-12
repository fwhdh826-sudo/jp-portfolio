"""
Card 2-5 — R1 Morning Routine テスト
detection-only・通知/書き込みの安全条件を担保するテスト群。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

from backend.engine.operation.r1_morning import (
    MorningRoutineResult,
    run_morning_routine,
)
from backend.engine.operation.discord_notifier import DiscordNotifierConfig
from backend.engine.operation.watchdog import SourceEvent

# ── Fixtures ──────────────────────────────────────────────────────────────────

TZ_JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 4, 29, 7, 0, 0, tzinfo=TZ_JST)


def _fresh_timestamps() -> dict:
    """All Tier 1/2/3 sources fresh (within max_age)."""
    return {
        "market":      NOW - timedelta(minutes=10),
        "regime":      NOW - timedelta(minutes=10),
        "news":        NOW - timedelta(minutes=10),
        "scoring":     NOW - timedelta(minutes=30),
        "strategy":    NOW - timedelta(minutes=30),
        "macro":       NOW - timedelta(hours=2),
        "correlation": NOW - timedelta(hours=12),
        "trust":       NOW - timedelta(hours=12),
    }


def _stale_timestamps() -> dict:
    """Tier 1 sources stale."""
    return {
        "market":      NOW - timedelta(hours=2),   # stale (max_age 30min)
        "regime":      NOW - timedelta(hours=2),   # stale (max_age 60min)
        "news":        NOW - timedelta(hours=2),   # stale (max_age 30min)
    }


def _ok_event(source: str, minutes_ago: float) -> SourceEvent:
    return SourceEvent(
        source=source,
        timestamp=NOW - timedelta(minutes=minutes_ago),
        success=True,
    )


def _fail_event(source: str, minutes_ago: float) -> SourceEvent:
    return SourceEvent(
        source=source,
        timestamp=NOW - timedelta(minutes=minutes_ago),
        success=False,
        error_type="timeout",
    )


def _three_failures(source: str) -> list[SourceEvent]:
    return [_fail_event(source, 15), _fail_event(source, 10), _fail_event(source, 5)]


def _dry_run_config() -> DiscordNotifierConfig:
    return DiscordNotifierConfig(webhook_url="https://example.com/hook", dry_run=True)


# ── TestMorningRoutineResult ──────────────────────────────────────────────────

class TestMorningRoutineResult:

    def test_result_fields_present(self):
        result = run_morning_routine(_fresh_timestamps(), [], now=NOW)
        assert hasattr(result, "freshness")
        assert hasattr(result, "watchdog")
        assert hasattr(result, "safe_mode")
        assert hasattr(result, "notify_result")
        assert hasattr(result, "recovery_entry")
        assert hasattr(result, "safe_mode_written")
        assert hasattr(result, "recovery_log_written")
        assert hasattr(result, "completed_at")

    def test_result_has_no_trade_field(self):
        result = run_morning_routine(_fresh_timestamps(), [], now=NOW)
        assert not hasattr(result, "trade")

    def test_result_has_no_order_field(self):
        result = run_morning_routine(_fresh_timestamps(), [], now=NOW)
        assert not hasattr(result, "order")

    def test_completed_at_populated(self):
        result = run_morning_routine(_fresh_timestamps(), [], now=NOW)
        assert result.completed_at == NOW


# ── TestHealthyPath ───────────────────────────────────────────────────────────

class TestHealthyPath:

    def test_all_healthy_safe_mode_inactive(self):
        result = run_morning_routine(_fresh_timestamps(), [], now=NOW)
        assert result.safe_mode.active is False

    def test_all_healthy_no_notify_result(self):
        result = run_morning_routine(
            _fresh_timestamps(), [],
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is None

    def test_all_healthy_no_recovery_entry(self):
        result = run_morning_routine(_fresh_timestamps(), [], now=NOW)
        assert result.recovery_entry is None

    def test_all_healthy_not_written(self):
        result = run_morning_routine(_fresh_timestamps(), [], now=NOW)
        assert result.safe_mode_written is False
        assert result.recovery_log_written is False


# ── TestSystemError ───────────────────────────────────────────────────────────

class TestSystemError:

    def test_watchdog_system_error_triggers_notify_attempt(self):
        events = _three_failures("market")
        result = run_morning_routine(
            _fresh_timestamps(), events,
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is not None
        assert result.notify_result.dry_run is True

    def test_watchdog_system_error_recovery_entry_created(self):
        events = _three_failures("market")
        result = run_morning_routine(_fresh_timestamps(), events, now=NOW)
        assert result.recovery_entry is not None
        assert result.recovery_entry.source == "market"
        assert result.recovery_entry.error_type == "watchdog_critical"

    def test_watchdog_system_error_recovery_entry_written_with_path(self, tmp_path):
        events = _three_failures("market")
        out = tmp_path / "recovery_log.json"
        result = run_morning_routine(
            _fresh_timestamps(), events,
            recovery_log_output_path=out,
            now=NOW,
        )
        assert result.recovery_log_written is True
        assert out.exists()
        data = json.loads(out.read_text())
        assert len(data["recovery_log"]) == 1


# ── TestSafeModeActive ────────────────────────────────────────────────────────

class TestSafeModeActive:

    def test_tier1_stale_safe_mode_active(self):
        result = run_morning_routine(_stale_timestamps(), [], now=NOW)
        assert result.safe_mode.active is True

    def test_safe_mode_active_triggers_notify(self):
        result = run_morning_routine(
            _stale_timestamps(), [],
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is not None

    def test_safe_mode_snapshot_written_when_path_provided(self, tmp_path):
        out = tmp_path / "safe_mode.json"
        result = run_morning_routine(
            _stale_timestamps(), [],
            safe_mode_output_path=out,
            now=NOW,
        )
        assert result.safe_mode_written is True
        assert out.exists()
        data = json.loads(out.read_text())
        assert data["safe_mode"]["active"] is True


# ── TestNoOutputPaths ─────────────────────────────────────────────────────────

class TestNoOutputPaths:

    def test_no_safe_mode_path_no_write(self):
        result = run_morning_routine(_stale_timestamps(), [], now=NOW)
        assert result.safe_mode_written is False

    def test_no_recovery_log_path_no_write(self):
        events = _three_failures("market")
        result = run_morning_routine(_fresh_timestamps(), events, now=NOW)
        assert result.recovery_log_written is False


# ── TestDryRun ────────────────────────────────────────────────────────────────

class TestDryRun:

    def test_notifier_config_none_no_notify_result(self):
        events = _three_failures("market")
        result = run_morning_routine(
            _fresh_timestamps(), events,
            notifier_config=None,
            now=NOW,
        )
        assert result.notify_result is None

    def test_dry_run_config_no_http_call(self):
        events = _three_failures("market")
        with patch("backend.engine.operation.discord_notifier._http_post") as mock_post:
            run_morning_routine(
                _fresh_timestamps(), events,
                notifier_config=_dry_run_config(),
                now=NOW,
            )
            mock_post.assert_not_called()
