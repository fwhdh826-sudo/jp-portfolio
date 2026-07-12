"""
Card 2-7 — R10 Capitulation Deploy Routine テスト
Capitulation Signal 4条件検出・DeployRecommendation 生成（推奨のみ）・通知・書き込み安全条件を担保するテスト群。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from backend.engine.operation.r10_capitulation import (
    CapitulationDeployRoutineResult,
    DeployRecommendation,
    DEPLOY_AMOUNT_JPY,
    run_capitulation_routine,
)
from backend.engine.operation.discord_notifier import DiscordNotifierConfig
from backend.engine.tier_a.capitulation_signal import CapitulationMarketInput

# ── Fixtures ──────────────────────────────────────────────────────────────────

TZ_JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 4, 29, 9, 0, 0, tzinfo=TZ_JST)


def _healthy_market() -> CapitulationMarketInput:
    """0 conditions met."""
    return CapitulationMarketInput(
        vix=20.0,
        nikkei_5d_return=0.01,
        nikkei_rsi_14=55.0,
        nikkei_volume=1.0,
        avg_volume_60d=2.0,
    )


def _partial_market() -> CapitulationMarketInput:
    """3 conditions met: vix_spike + panic_selling + oversold."""
    return CapitulationMarketInput(
        vix=36.0,             # > 35 ✓
        nikkei_5d_return=-0.09,  # < -0.08 ✓
        nikkei_rsi_14=29.0,   # < 30 ✓
        nikkei_volume=1.0,    # NOT spike ✗
        avg_volume_60d=2.0,
    )


def _full_cap_market() -> CapitulationMarketInput:
    """4 conditions met: all."""
    return CapitulationMarketInput(
        vix=36.0,             # > 35 ✓
        nikkei_5d_return=-0.09,  # < -0.08 ✓
        nikkei_rsi_14=29.0,   # < 30 ✓
        nikkei_volume=5.0,    # > avg * 2 ✓ (5 > 2*2=4)
        avg_volume_60d=2.0,
    )


def _dry_run_config() -> DiscordNotifierConfig:
    return DiscordNotifierConfig(webhook_url="https://example.com/hook", dry_run=True)


# ── TestCapitulationDeployRoutineResult ───────────────────────────────────────

class TestCapitulationDeployRoutineResult:

    def test_result_fields_present(self):
        result = run_capitulation_routine(_healthy_market(), now=NOW)
        assert hasattr(result, "capitulation")
        assert hasattr(result, "deploy_recommendation")
        assert hasattr(result, "notify_result")
        assert hasattr(result, "recovery_entry")
        assert hasattr(result, "recovery_log_written")
        assert hasattr(result, "completed_at")

    def test_result_has_no_safe_mode_field(self):
        result = run_capitulation_routine(_healthy_market(), now=NOW)
        assert not hasattr(result, "safe_mode")

    def test_result_has_no_freshness_field(self):
        result = run_capitulation_routine(_healthy_market(), now=NOW)
        assert not hasattr(result, "freshness")

    def test_completed_at_populated(self):
        result = run_capitulation_routine(_healthy_market(), now=NOW)
        assert result.completed_at == NOW


# ── TestDeployRecommendation ──────────────────────────────────────────────────

class TestDeployRecommendation:

    def test_no_deploy_when_0_conditions(self):
        result = run_capitulation_routine(_healthy_market(), now=NOW)
        assert result.capitulation.is_capitulation is False
        assert result.deploy_recommendation is None

    def test_no_deploy_on_partial_3_conditions(self):
        result = run_capitulation_routine(_partial_market(), now=NOW)
        assert result.capitulation.is_partial_capitulation is True
        assert result.deploy_recommendation is None

    def test_deploy_recommendation_on_full_capitulation(self):
        result = run_capitulation_routine(_full_cap_market(), now=NOW)
        assert result.capitulation.is_capitulation is True
        assert result.deploy_recommendation is not None

    def test_deploy_amount_4m_jpy(self):
        result = run_capitulation_routine(_full_cap_market(), now=NOW)
        assert result.deploy_recommendation.amount_jpy == DEPLOY_AMOUNT_JPY
        assert result.deploy_recommendation.amount_jpy == 4_000_000


# ── TestNotification ──────────────────────────────────────────────────────────

class TestNotification:

    def test_healthy_no_notification(self):
        result = run_capitulation_routine(
            _healthy_market(),
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is None

    def test_partial_triggers_notify(self):
        result = run_capitulation_routine(
            _partial_market(),
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is not None

    def test_full_capitulation_triggers_notify(self):
        result = run_capitulation_routine(
            _full_cap_market(),
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is not None

    def test_dry_run_no_http_call(self):
        with patch("backend.engine.operation.discord_notifier._http_post") as mock_post:
            run_capitulation_routine(
                _full_cap_market(),
                notifier_config=_dry_run_config(),
                now=NOW,
            )
            mock_post.assert_not_called()


# ── TestRecoveryLog ───────────────────────────────────────────────────────────

class TestRecoveryLog:

    def test_recovery_entry_created_on_partial(self):
        result = run_capitulation_routine(_partial_market(), now=NOW)
        assert result.recovery_entry is not None
        assert result.recovery_entry.source == "capitulation_signal"

    def test_no_recovery_entry_when_healthy(self):
        result = run_capitulation_routine(_healthy_market(), now=NOW)
        assert result.recovery_entry is None

    def test_no_recovery_log_path_no_write(self):
        result = run_capitulation_routine(_partial_market(), now=NOW)
        assert result.recovery_log_written is False
