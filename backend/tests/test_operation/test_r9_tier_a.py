"""
Card 2-7 — R9 Tier A Routine テスト
Tier A 4モジュール呼び出し・tier_a_triggered フラグ・通知閾値・書き込み安全条件を担保するテスト群。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from backend.engine.operation.r9_tier_a import (
    TierARoutineResult,
    run_tier_a_routine,
)
from backend.engine.operation.discord_notifier import DiscordNotifierConfig
from backend.engine.tier_a.tier_a_hard_gate import PortfolioInput, PositionInput
from backend.engine.tier_a.tier_a_soft_penalty import SoftPortfolioInput, SoftAssetInput
from backend.engine.tier_a.capitulation_signal import CapitulationMarketInput
from backend.engine.tier_a.alerts_emitter import AlertsPortfolioInput

# ── Fixtures ──────────────────────────────────────────────────────────────────

TZ_JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 4, 29, 9, 0, 0, tzinfo=TZ_JST)

_NIKKEI_FLAT = [0.01, 0.01, 0.01]   # no consecutive decline
_NIKKEI_CRASH = [-0.03, -0.03, -0.03]  # 3日連続 -3% → T4 trigger if VIX > 40


def _healthy_portfolio() -> PortfolioInput:
    return PortfolioInput(
        positions=[
            PositionInput(ticker="7203", sector="auto", unrealized_return=0.15, weight=0.05)
        ],
        drawdown=-0.05,
    )


def _t1_portfolio() -> PortfolioInput:
    """T1: unrealized_return ≤ -40%"""
    return PortfolioInput(
        positions=[
            PositionInput(ticker="9999", sector="tech", unrealized_return=-0.45, weight=0.05)
        ],
        drawdown=-0.05,
    )


def _t3_portfolio() -> PortfolioInput:
    """T3: PF drawdown ≤ -30%"""
    return PortfolioInput(positions=[], drawdown=-0.32)


def _healthy_cap_market() -> CapitulationMarketInput:
    return CapitulationMarketInput(
        vix=20.0,
        nikkei_5d_return=0.01,
        nikkei_rsi_14=55.0,
        nikkei_volume=1.0,
        avg_volume_60d=2.0,
    )


def _healthy_soft_portfolio() -> SoftPortfolioInput:
    """各非現金ポジション ≤ 7% → T7 クリア。Core 8本 × 7% = 56% → T5 クリア。"""
    assets = [
        SoftAssetInput(ticker="cash", is_core=False, is_leveraged=False, is_cash=True, weight=0.10, v3_target_weight=0.10),
    ]
    for i in range(8):
        assets.append(SoftAssetInput(
            ticker=f"c{i}", is_core=True, is_leveraged=False, is_cash=False,
            weight=0.07, v3_target_weight=0.07,
        ))
    return SoftPortfolioInput(assets=assets)


def _healthy_alerts() -> AlertsPortfolioInput:
    return AlertsPortfolioInput(portfolio_drawdown=-0.05, vix=20.0)


def _l1_alerts() -> AlertsPortfolioInput:
    """DD -12% → L1 alert"""
    return AlertsPortfolioInput(portfolio_drawdown=-0.12, vix=20.0)


def _dry_run_config() -> DiscordNotifierConfig:
    return DiscordNotifierConfig(webhook_url="https://example.com/hook", dry_run=True)


# ── TestTierARoutineResult ────────────────────────────────────────────────────

class TestTierARoutineResult:

    def test_result_fields_present(self):
        result = run_tier_a_routine(
            _healthy_portfolio(), _healthy_cap_market(),
            _healthy_soft_portfolio(), _healthy_alerts(),
            _NIKKEI_FLAT, now=NOW,
        )
        assert hasattr(result, "hard_gate")
        assert hasattr(result, "soft_penalty")
        assert hasattr(result, "capitulation")
        assert hasattr(result, "alerts")
        assert hasattr(result, "tier_a_triggered")
        assert hasattr(result, "notify_result")
        assert hasattr(result, "recovery_entry")
        assert hasattr(result, "recovery_log_written")
        assert hasattr(result, "completed_at")

    def test_result_has_no_freshness_field(self):
        result = run_tier_a_routine(
            _healthy_portfolio(), _healthy_cap_market(),
            _healthy_soft_portfolio(), _healthy_alerts(),
            _NIKKEI_FLAT, now=NOW,
        )
        assert not hasattr(result, "freshness")


# ── TestTierATriggered ────────────────────────────────────────────────────────

class TestTierATriggered:

    def test_healthy_not_triggered(self):
        result = run_tier_a_routine(
            _healthy_portfolio(), _healthy_cap_market(),
            _healthy_soft_portfolio(), _healthy_alerts(),
            _NIKKEI_FLAT, now=NOW,
        )
        assert result.tier_a_triggered is False

    def test_t1_violation_triggers(self):
        result = run_tier_a_routine(
            _t1_portfolio(), _healthy_cap_market(),
            _healthy_soft_portfolio(), _healthy_alerts(),
            _NIKKEI_FLAT, now=NOW,
        )
        assert result.hard_gate.any_triggered is True
        assert result.tier_a_triggered is True

    def test_t3_violation_triggers(self):
        result = run_tier_a_routine(
            _t3_portfolio(), _healthy_cap_market(),
            _healthy_soft_portfolio(), _healthy_alerts(),
            _NIKKEI_FLAT, now=NOW,
        )
        assert result.tier_a_triggered is True

    def test_l1_alert_triggers_tier_a(self):
        result = run_tier_a_routine(
            _healthy_portfolio(), _healthy_cap_market(),
            _healthy_soft_portfolio(), _l1_alerts(),
            _NIKKEI_FLAT, now=NOW,
        )
        assert result.alerts.l1.triggered is True
        assert result.tier_a_triggered is True


# ── TestNotification ──────────────────────────────────────────────────────────

class TestNotification:

    def test_healthy_no_notification(self):
        result = run_tier_a_routine(
            _healthy_portfolio(), _healthy_cap_market(),
            _healthy_soft_portfolio(), _healthy_alerts(),
            _NIKKEI_FLAT,
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is None

    def test_tier_a_triggered_notifies(self):
        result = run_tier_a_routine(
            _t1_portfolio(), _healthy_cap_market(),
            _healthy_soft_portfolio(), _healthy_alerts(),
            _NIKKEI_FLAT,
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is not None

    def test_dry_run_no_http_call(self):
        with patch("backend.engine.operation.discord_notifier._http_post") as mock_post:
            run_tier_a_routine(
                _t1_portfolio(), _healthy_cap_market(),
                _healthy_soft_portfolio(), _healthy_alerts(),
                _NIKKEI_FLAT,
                notifier_config=_dry_run_config(),
                now=NOW,
            )
            mock_post.assert_not_called()


# ── TestRecoveryLog ───────────────────────────────────────────────────────────

class TestRecoveryLog:

    def test_recovery_entry_created_on_trigger(self):
        result = run_tier_a_routine(
            _t1_portfolio(), _healthy_cap_market(),
            _healthy_soft_portfolio(), _healthy_alerts(),
            _NIKKEI_FLAT, now=NOW,
        )
        assert result.recovery_entry is not None
        assert result.recovery_entry.source == "tier_a"

    def test_no_recovery_log_path_no_write(self):
        result = run_tier_a_routine(
            _t1_portfolio(), _healthy_cap_market(),
            _healthy_soft_portfolio(), _healthy_alerts(),
            _NIKKEI_FLAT, now=NOW,
        )
        assert result.recovery_log_written is False
