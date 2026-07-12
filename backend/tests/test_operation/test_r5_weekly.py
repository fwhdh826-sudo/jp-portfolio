"""
Card 2-6 — R5 Weekly Routine テスト
SQ アラート・広域通知閾値（Tier 2/3 stale）・書き込み安全条件を担保するテスト群。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from backend.engine.operation.r5_weekly import (
    SQEventInput,
    WeeklyRoutineResult,
    run_weekly_routine,
)
from backend.engine.operation.discord_notifier import DiscordNotifierConfig
from backend.engine.operation.watchdog import SourceEvent

# ── Fixtures ──────────────────────────────────────────────────────────────────

TZ_JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 4, 28, 7, 0, 0, tzinfo=TZ_JST)  # Monday morning


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


def _stale_tier2() -> dict:
    """scoring/strategy stale (max 240 min; set to 10h = 600 min → stale)."""
    base = _fresh_timestamps()
    base["scoring"] = NOW - timedelta(hours=10)
    base["strategy"] = NOW - timedelta(hours=10)
    return base


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


# ── TestWeeklyRoutineResult ───────────────────────────────────────────────────

class TestWeeklyRoutineResult:

    def test_result_fields_present(self):
        result = run_weekly_routine(_fresh_timestamps(), [], now=NOW)
        assert hasattr(result, "freshness")
        assert hasattr(result, "watchdog")
        assert hasattr(result, "safe_mode")
        assert hasattr(result, "notify_result")
        assert hasattr(result, "recovery_entry")
        assert hasattr(result, "safe_mode_written")
        assert hasattr(result, "recovery_log_written")
        assert hasattr(result, "sq_alert")
        assert hasattr(result, "completed_at")

    def test_result_has_no_trade_field(self):
        result = run_weekly_routine(_fresh_timestamps(), [], now=NOW)
        assert not hasattr(result, "trade")


# ── TestSQAlert ───────────────────────────────────────────────────────────────

class TestSQAlert:

    def test_sq_alert_true_when_days_until_7(self):
        sq = SQEventInput(days_until=7)
        result = run_weekly_routine(_fresh_timestamps(), [], sq_event=sq, now=NOW)
        assert result.sq_alert is True

    def test_sq_alert_false_when_days_until_8(self):
        sq = SQEventInput(days_until=8)
        result = run_weekly_routine(_fresh_timestamps(), [], sq_event=sq, now=NOW)
        assert result.sq_alert is False

    def test_sq_alert_false_when_no_sq_event(self):
        result = run_weekly_routine(_fresh_timestamps(), [], now=NOW)
        assert result.sq_alert is False


# ── TestNotification ──────────────────────────────────────────────────────────

class TestNotification:

    def test_healthy_no_notification(self):
        result = run_weekly_routine(
            _fresh_timestamps(), [],
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is None

    def test_any_critical_triggers_notify(self):
        events = _three_failures("market")
        result = run_weekly_routine(
            _fresh_timestamps(), events,
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is not None

    def test_tier2_stale_triggers_notify(self):
        result = run_weekly_routine(
            _stale_tier2(), [],
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is not None

    def test_dry_run_no_http_call(self):
        events = _three_failures("market")
        with patch("backend.engine.operation.discord_notifier._http_post") as mock_post:
            run_weekly_routine(
                _fresh_timestamps(), events,
                notifier_config=_dry_run_config(),
                now=NOW,
            )
            mock_post.assert_not_called()


# ── TestRecoveryLog ───────────────────────────────────────────────────────────

class TestRecoveryLog:

    def test_recovery_entry_created_on_critical(self):
        events = _three_failures("market")
        result = run_weekly_routine(_fresh_timestamps(), events, now=NOW)
        assert result.recovery_entry is not None
        assert result.recovery_entry.source == "market"

    def test_no_recovery_log_path_no_write(self):
        events = _three_failures("market")
        result = run_weekly_routine(_fresh_timestamps(), events, now=NOW)
        assert result.recovery_log_written is False

    def test_healthy_no_recovery_entry(self):
        result = run_weekly_routine(_fresh_timestamps(), [], now=NOW)
        assert result.recovery_entry is None
