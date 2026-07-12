"""
Card 2-6 — R6 Earnings Routine テスト
EarningsEvent 通知・recovery_log 不使用・safe_mode パイプライン不使用を担保するテスト群。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from backend.engine.operation.r6_earnings import (
    EarningsEvent,
    EarningsRoutineResult,
    run_earnings_routine,
)
from backend.engine.operation.discord_notifier import DiscordNotifierConfig

# ── Fixtures ──────────────────────────────────────────────────────────────────

TZ_JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 4, 29, 8, 0, 0, tzinfo=TZ_JST)


def _event(ticker: str, days_until: int) -> EarningsEvent:
    return EarningsEvent(
        ticker=ticker,
        company_name=f"Company {ticker}",
        earnings_date=NOW + timedelta(days=days_until),
        days_until=days_until,
    )


def _dry_run_config() -> DiscordNotifierConfig:
    return DiscordNotifierConfig(webhook_url="https://example.com/hook", dry_run=True)


# ── TestEarningsRoutineResult ─────────────────────────────────────────────────

class TestEarningsRoutineResult:

    def test_result_fields_present(self):
        result = run_earnings_routine([], now=NOW)
        assert hasattr(result, "events")
        assert hasattr(result, "upcoming_events")
        assert hasattr(result, "notify_result")
        assert hasattr(result, "completed_at")

    def test_result_has_no_trade_field(self):
        result = run_earnings_routine([], now=NOW)
        assert not hasattr(result, "trade")

    def test_result_has_no_safe_mode_field(self):
        result = run_earnings_routine([], now=NOW)
        assert not hasattr(result, "safe_mode")

    def test_result_has_no_recovery_log_written_field(self):
        result = run_earnings_routine([], now=NOW)
        assert not hasattr(result, "recovery_log_written")

    def test_completed_at_populated(self):
        result = run_earnings_routine([], now=NOW)
        assert result.completed_at == NOW


# ── TestUpcomingEvents ────────────────────────────────────────────────────────

class TestUpcomingEvents:

    def test_no_events_count_zero(self):
        result = run_earnings_routine([], now=NOW)
        assert result.upcoming_events == 0

    def test_single_event_count_one(self):
        result = run_earnings_routine([_event("7203", 3)], now=NOW)
        assert result.upcoming_events == 1

    def test_multiple_events_count_matches(self):
        events = [_event("7203", 3), _event("6758", 5), _event("9984", 7)]
        result = run_earnings_routine(events, now=NOW)
        assert result.upcoming_events == 3


# ── TestNotification ──────────────────────────────────────────────────────────

class TestNotification:

    def test_no_events_no_notification(self):
        result = run_earnings_routine(
            [],
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is None

    def test_upcoming_events_triggers_notify(self):
        result = run_earnings_routine(
            [_event("7203", 3)],
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is not None

    def test_notifier_config_none_no_notify(self):
        result = run_earnings_routine(
            [_event("7203", 3)],
            notifier_config=None,
            now=NOW,
        )
        assert result.notify_result is None

    def test_dry_run_no_http_call(self):
        events = [_event("7203", 3)]
        with patch("backend.engine.operation.discord_notifier._http_post") as mock_post:
            run_earnings_routine(
                events,
                notifier_config=_dry_run_config(),
                now=NOW,
            )
            mock_post.assert_not_called()
