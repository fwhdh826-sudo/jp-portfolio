"""
Card 2-7 — R7 Scenario Routine テスト
ScenarioPortfolioInput・L1/L2/L3 アラート判定・通知閾値・書き込み安全条件を担保するテスト群。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from backend.engine.operation.r7_scenario import (
    ScenarioPortfolioInput,
    ScenarioRoutineResult,
    run_scenario_routine,
)
from backend.engine.operation.discord_notifier import DiscordNotifierConfig

# ── Fixtures ──────────────────────────────────────────────────────────────────

TZ_JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 4, 29, 9, 0, 0, tzinfo=TZ_JST)


def _healthy() -> ScenarioPortfolioInput:
    return ScenarioPortfolioInput(portfolio_drawdown=0.0, vix=15.0)


def _l1() -> ScenarioPortfolioInput:
    """DD -12% → L1 (DD ≤ -10%)"""
    return ScenarioPortfolioInput(portfolio_drawdown=-0.12, vix=15.0)


def _l3() -> ScenarioPortfolioInput:
    """DD -32% → L3 (DD ≤ -30%)"""
    return ScenarioPortfolioInput(portfolio_drawdown=-0.32, vix=35.0)


def _dry_run_config() -> DiscordNotifierConfig:
    return DiscordNotifierConfig(webhook_url="https://example.com/hook", dry_run=True)


# ── TestScenarioRoutineResult ─────────────────────────────────────────────────

class TestScenarioRoutineResult:

    def test_result_fields_present(self):
        result = run_scenario_routine(_healthy(), now=NOW)
        assert hasattr(result, "portfolio_input")
        assert hasattr(result, "alerts")
        assert hasattr(result, "scenario_triggered")
        assert hasattr(result, "notify_result")
        assert hasattr(result, "recovery_entry")
        assert hasattr(result, "recovery_log_written")
        assert hasattr(result, "completed_at")

    def test_result_has_no_safe_mode_field(self):
        result = run_scenario_routine(_healthy(), now=NOW)
        assert not hasattr(result, "safe_mode")

    def test_result_has_no_freshness_field(self):
        result = run_scenario_routine(_healthy(), now=NOW)
        assert not hasattr(result, "freshness")


# ── TestScenarioTriggered ─────────────────────────────────────────────────────

class TestScenarioTriggered:

    def test_no_alert_when_healthy(self):
        result = run_scenario_routine(_healthy(), now=NOW)
        assert result.scenario_triggered is False
        assert result.alerts.highest_level == "NONE"

    def test_l1_triggers_scenario(self):
        result = run_scenario_routine(_l1(), now=NOW)
        assert result.scenario_triggered is True
        assert result.alerts.l1.triggered is True

    def test_l3_triggers_scenario(self):
        result = run_scenario_routine(_l3(), now=NOW)
        assert result.scenario_triggered is True
        assert result.alerts.highest_level == "L3"


# ── TestNotification ──────────────────────────────────────────────────────────

class TestNotification:

    def test_healthy_no_notification(self):
        result = run_scenario_routine(
            _healthy(),
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is None

    def test_scenario_triggered_notifies(self):
        result = run_scenario_routine(
            _l1(),
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is not None

    def test_notifier_config_none_no_notify(self):
        result = run_scenario_routine(
            _l1(),
            notifier_config=None,
            now=NOW,
        )
        assert result.notify_result is None

    def test_dry_run_no_http_call(self):
        with patch("backend.engine.operation.discord_notifier._http_post") as mock_post:
            run_scenario_routine(
                _l1(),
                notifier_config=_dry_run_config(),
                now=NOW,
            )
            mock_post.assert_not_called()


# ── TestRecoveryLog ───────────────────────────────────────────────────────────

class TestRecoveryLog:

    def test_recovery_entry_created_on_trigger(self):
        result = run_scenario_routine(_l1(), now=NOW)
        assert result.recovery_entry is not None
        assert result.recovery_entry.source == "portfolio_scenario"

    def test_no_recovery_entry_when_healthy(self):
        result = run_scenario_routine(_healthy(), now=NOW)
        assert result.recovery_entry is None

    def test_no_recovery_log_path_no_write(self):
        result = run_scenario_routine(_l1(), now=NOW)
        assert result.recovery_log_written is False
