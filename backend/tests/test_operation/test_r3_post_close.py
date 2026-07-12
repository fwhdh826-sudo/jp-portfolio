"""
Card 2-5 — R3 Post-Close Routine テスト
any_critical トリガー・Tier 3 スコープ・書き込み安全条件を担保するテスト群。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from backend.engine.operation.r3_post_close import (
    PostCloseRoutineResult,
    run_post_close_routine,
)
from backend.engine.operation.discord_notifier import DiscordNotifierConfig
from backend.engine.operation.watchdog import SourceEvent

# ── Fixtures ──────────────────────────────────────────────────────────────────

TZ_JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 4, 29, 15, 30, 0, tzinfo=TZ_JST)


def _fresh_timestamps() -> dict:
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
    return {
        "market": NOW - timedelta(hours=2),
        "regime": NOW - timedelta(hours=2),
        "news":   NOW - timedelta(hours=2),
    }


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


# ── TestPostCloseRoutineResult ────────────────────────────────────────────────

class TestPostCloseRoutineResult:

    def test_result_fields_present(self):
        result = run_post_close_routine(_fresh_timestamps(), [], now=NOW)
        assert hasattr(result, "freshness")
        assert hasattr(result, "watchdog")
        assert hasattr(result, "safe_mode")
        assert hasattr(result, "notify_result")
        assert hasattr(result, "recovery_entry")
        assert hasattr(result, "safe_mode_written")
        assert hasattr(result, "recovery_log_written")
        assert hasattr(result, "completed_at")

    def test_result_has_no_trade_field(self):
        result = run_post_close_routine(_fresh_timestamps(), [], now=NOW)
        assert not hasattr(result, "trade")

    def test_result_has_no_order_field(self):
        result = run_post_close_routine(_fresh_timestamps(), [], now=NOW)
        assert not hasattr(result, "order")

    def test_completed_at_populated(self):
        result = run_post_close_routine(_fresh_timestamps(), [], now=NOW)
        assert result.completed_at == NOW


# ── TestHealthyPath ───────────────────────────────────────────────────────────

class TestHealthyPath:

    def test_all_healthy_no_notification(self):
        result = run_post_close_routine(
            _fresh_timestamps(), [],
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is None

    def test_all_healthy_no_recovery_entry(self):
        result = run_post_close_routine(_fresh_timestamps(), [], now=NOW)
        assert result.recovery_entry is None


# ── TestAnyCritical ───────────────────────────────────────────────────────────

class TestAnyCritical:

    def test_any_critical_triggers_notify_attempt(self):
        """Tier 1 critical → any_critical=True → notification"""
        events = _three_failures("market")
        result = run_post_close_routine(
            _fresh_timestamps(), events,
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is not None

    def test_tier3_critical_also_triggers_notify(self):
        """R3 は Tier 3 (correlation) critical でも通知する（R2 との違い）"""
        events = _three_failures("correlation")
        result = run_post_close_routine(
            _fresh_timestamps(), events,
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        # correlation is not in DEFAULT_SAFE_MODE_SOURCES → system_error=False
        # but any_critical=True → R3 should still notify
        assert result.watchdog.any_critical is True
        assert result.watchdog.system_error is False
        assert result.notify_result is not None

    def test_tier3_critical_recovery_entry_created(self):
        events = _three_failures("correlation")
        result = run_post_close_routine(_fresh_timestamps(), events, now=NOW)
        assert result.recovery_entry is not None
        assert result.recovery_entry.source == "correlation"


# ── TestSafeModeActive ────────────────────────────────────────────────────────

class TestSafeModeActive:

    def test_safe_mode_active_snapshot_written(self, tmp_path):
        out = tmp_path / "safe_mode.json"
        result = run_post_close_routine(
            _stale_timestamps(), [],
            safe_mode_output_path=out,
            now=NOW,
        )
        assert result.safe_mode_written is True
        assert out.exists()
        data = json.loads(out.read_text())
        assert data["safe_mode"]["active"] is True


# ── TestRecoveryLog ───────────────────────────────────────────────────────────

class TestRecoveryLog:

    def test_recovery_entry_created_on_issues(self):
        # "correlation" is Tier 3 → not in DEFAULT_SAFE_MODE_SOURCES
        # → any_critical=True but system_error=False → safe_mode.active=False
        events = _three_failures("correlation")
        result = run_post_close_routine(_fresh_timestamps(), events, now=NOW)
        assert result.recovery_entry is not None
        assert result.recovery_entry.safe_mode_triggered is False

    def test_recovery_log_written_with_path(self, tmp_path):
        events = _three_failures("market")
        out = tmp_path / "recovery_log.json"
        result = run_post_close_routine(
            _fresh_timestamps(), events,
            recovery_log_output_path=out,
            now=NOW,
        )
        assert result.recovery_log_written is True
        data = json.loads(out.read_text())
        assert len(data["recovery_log"]) == 1


# ── TestNoOutputPaths ─────────────────────────────────────────────────────────

class TestNoOutputPaths:

    def test_no_safe_mode_path_no_write(self):
        result = run_post_close_routine(_stale_timestamps(), [], now=NOW)
        assert result.safe_mode_written is False

    def test_no_recovery_log_path_no_write(self):
        events = _three_failures("market")
        result = run_post_close_routine(_fresh_timestamps(), events, now=NOW)
        assert result.recovery_log_written is False


# ── TestDryRun ────────────────────────────────────────────────────────────────

class TestDryRun:

    def test_notifier_config_none_no_notify(self):
        events = _three_failures("market")
        result = run_post_close_routine(
            _fresh_timestamps(), events,
            notifier_config=None,
            now=NOW,
        )
        assert result.notify_result is None

    def test_dry_run_config_no_http_call(self):
        events = _three_failures("market")
        with patch("backend.engine.operation.discord_notifier._http_post") as mock_post:
            run_post_close_routine(
                _fresh_timestamps(), events,
                notifier_config=_dry_run_config(),
                now=NOW,
            )
            mock_post.assert_not_called()
