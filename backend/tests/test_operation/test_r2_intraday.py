"""
Card 2-5 — R2 Intraday Routine テスト
Tier 1 限定・通知閾値・書き込み安全条件を担保するテスト群。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from backend.engine.operation.r2_intraday import (
    IntradayRoutineResult,
    run_intraday_routine,
)
from backend.engine.operation.discord_notifier import DiscordNotifierConfig
from backend.engine.operation.watchdog import SourceEvent

# ── Fixtures ──────────────────────────────────────────────────────────────────

TZ_JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 4, 29, 12, 30, 0, tzinfo=TZ_JST)


def _fresh_timestamps() -> dict:
    return {
        "market":  NOW - timedelta(minutes=10),
        "regime":  NOW - timedelta(minutes=10),
        "news":    NOW - timedelta(minutes=10),
    }


def _stale_tier1() -> dict:
    return {
        "market": NOW - timedelta(hours=2),   # stale
        "regime": NOW - timedelta(hours=2),   # stale
        "news":   NOW - timedelta(hours=2),   # stale
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


# ── TestIntradayRoutineResult ─────────────────────────────────────────────────

class TestIntradayRoutineResult:

    def test_result_fields_present(self):
        result = run_intraday_routine(_fresh_timestamps(), [], now=NOW)
        assert hasattr(result, "freshness")
        assert hasattr(result, "watchdog")
        assert hasattr(result, "safe_mode")
        assert hasattr(result, "notify_result")
        assert hasattr(result, "recovery_entry")
        assert hasattr(result, "safe_mode_written")
        assert hasattr(result, "recovery_log_written")
        assert hasattr(result, "completed_at")

    def test_result_has_no_trade_field(self):
        result = run_intraday_routine(_fresh_timestamps(), [], now=NOW)
        assert not hasattr(result, "trade")

    def test_result_has_no_order_field(self):
        result = run_intraday_routine(_fresh_timestamps(), [], now=NOW)
        assert not hasattr(result, "order")


# ── TestHealthyPath ───────────────────────────────────────────────────────────

class TestHealthyPath:

    def test_healthy_no_notification(self):
        result = run_intraday_routine(
            _fresh_timestamps(), [],
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is None

    def test_healthy_no_recovery_entry(self):
        result = run_intraday_routine(_fresh_timestamps(), [], now=NOW)
        assert result.recovery_entry is None


# ── TestSystemError ───────────────────────────────────────────────────────────

class TestSystemError:

    def test_system_error_triggers_notify_attempt(self):
        events = _three_failures("market")
        result = run_intraday_routine(
            _fresh_timestamps(), events,
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is not None

    def test_system_error_recovery_entry_created(self):
        events = _three_failures("news")
        result = run_intraday_routine(_fresh_timestamps(), events, now=NOW)
        assert result.recovery_entry is not None
        assert result.recovery_entry.source == "news"
        assert result.recovery_entry.error_type == "watchdog_critical"

    def test_system_error_recovery_entry_written_with_path(self, tmp_path):
        events = _three_failures("market")
        out = tmp_path / "recovery_log.json"
        result = run_intraday_routine(
            _fresh_timestamps(), events,
            recovery_log_output_path=out,
            now=NOW,
        )
        assert result.recovery_log_written is True
        assert out.exists()


# ── TestFreshnessTrigger ──────────────────────────────────────────────────────

class TestFreshnessTrigger:

    def test_tier1_stale_triggers_safe_mode_in_result(self):
        result = run_intraday_routine(_stale_tier1(), [], now=NOW)
        assert result.safe_mode.active is True
        assert result.freshness.safe_mode_triggered is True

    def test_tier1_stale_triggers_notify_attempt(self):
        result = run_intraday_routine(
            _stale_tier1(), [],
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is not None


# ── TestNoOutputPaths ─────────────────────────────────────────────────────────

class TestNoOutputPaths:

    def test_no_safe_mode_path_no_write(self):
        result = run_intraday_routine(_stale_tier1(), [], now=NOW)
        assert result.safe_mode_written is False


# ── TestDryRun ────────────────────────────────────────────────────────────────

class TestDryRun:

    def test_notifier_config_none_no_notify(self):
        events = _three_failures("market")
        result = run_intraday_routine(
            _fresh_timestamps(), events,
            notifier_config=None,
            now=NOW,
        )
        assert result.notify_result is None

    def test_dry_run_config_no_http(self):
        events = _three_failures("market")
        with patch("backend.engine.operation.discord_notifier._http_post") as mock_post:
            run_intraday_routine(
                _fresh_timestamps(), events,
                notifier_config=_dry_run_config(),
                now=NOW,
            )
            mock_post.assert_not_called()
