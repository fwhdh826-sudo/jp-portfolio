"""
Card 1-4 — Alerts Emitter テスト
L1/L2/L3/OPPORTUNITY アラートイベント生成ロジックを担保するテスト群。
"""
from __future__ import annotations

import pytest

from backend.engine.tier_a.alerts_emitter import (
    L1_DD_THRESHOLD,
    L1_VIX_THRESHOLD,
    L2_DD_THRESHOLD,
    L3_DD_THRESHOLD,
    AlertEvent,
    AlertsPortfolioInput,
    AlertsResult,
    evaluate_alerts,
)
from backend.engine.tier_a.capitulation_signal import (
    CapitulationMarketInput,
    check_capitulation,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

def _portfolio(drawdown: float = -0.05, vix: float = 20.0) -> AlertsPortfolioInput:
    return AlertsPortfolioInput(portfolio_drawdown=drawdown, vix=vix)


def _cap_true() -> object:
    """Capitulation Signal 4条件全成立"""
    market = CapitulationMarketInput(
        vix=40.0, nikkei_5d_return=-0.10,
        nikkei_rsi_14=25.0, nikkei_volume=3.0, avg_volume_60d=1.0,
    )
    return check_capitulation(market)


def _cap_false() -> object:
    """Capitulation Signal 未成立（0条件）"""
    market = CapitulationMarketInput(
        vix=22.5, nikkei_5d_return=0.01,
        nikkei_rsi_14=52.0, nikkei_volume=1.0, avg_volume_60d=1.0,
    )
    return check_capitulation(market)


def _cap_partial() -> object:
    """Capitulation Signal 3条件成立（部分のみ）"""
    market = CapitulationMarketInput(
        vix=40.0, nikkei_5d_return=-0.10, nikkei_rsi_14=25.0,
        nikkei_volume=1.5, avg_volume_60d=1.0,   # volume_spike 未成立
    )
    return check_capitulation(market)


# ── Constants ─────────────────────────────────────────────────────────────────

def test_constants_match_spec():
    assert L1_DD_THRESHOLD == pytest.approx(-0.10)
    assert L1_VIX_THRESHOLD == pytest.approx(30.0)
    assert L2_DD_THRESHOLD == pytest.approx(-0.20)
    assert L3_DD_THRESHOLD == pytest.approx(-0.30)


# ── L1 ────────────────────────────────────────────────────────────────────────

def test_l1_triggered_by_dd():
    result = evaluate_alerts(_portfolio(drawdown=-0.15), _cap_false())
    assert result.l1.triggered is True
    assert result.l1.level == "L1"
    assert result.l1.action_recommended == "reduce_new_position_size_50pct_recommended"


def test_l1_triggered_by_vix():
    # DD は軽微だが VIX > 30
    result = evaluate_alerts(_portfolio(drawdown=-0.05, vix=35.0), _cap_false())
    assert result.l1.triggered is True
    assert any("VIX" in r for r in result.l1.trigger_reasons)


def test_l1_not_triggered():
    result = evaluate_alerts(_portfolio(drawdown=-0.05, vix=20.0), _cap_false())
    assert result.l1.triggered is False
    assert result.l1.action_recommended == "none"


def test_l1_dd_at_threshold_triggered():
    # DD = -0.10 は ≤ -0.10 → triggered
    result = evaluate_alerts(_portfolio(drawdown=-0.10), _cap_false())
    assert result.l1.triggered is True


def test_l1_vix_at_threshold_not_triggered():
    # VIX = 30.0 は NOT > 30 → not triggered (DD も浅い)
    result = evaluate_alerts(_portfolio(drawdown=-0.05, vix=30.0), _cap_false())
    assert result.l1.triggered is False


# ── L2 ────────────────────────────────────────────────────────────────────────

def test_l2_triggered():
    result = evaluate_alerts(_portfolio(drawdown=-0.25), _cap_false())
    assert result.l2.triggered is True
    assert result.l2.action_recommended == "reduce_tactical_50pct_ensure_cash_15pct_recommended"


def test_l2_at_threshold_triggered():
    # DD = -0.20 は ≤ -0.20 → triggered
    result = evaluate_alerts(_portfolio(drawdown=-0.20), _cap_false())
    assert result.l2.triggered is True


# ── L3 ────────────────────────────────────────────────────────────────────────

def test_l3_triggered():
    result = evaluate_alerts(_portfolio(drawdown=-0.35), _cap_false())
    assert result.l3.triggered is True
    assert result.l3.action_recommended == "reduce_all_risk_50pct_freeze_buys_48h_recommended"


def test_l3_at_threshold_triggered():
    # DD = -0.30 は ≤ -0.30 → triggered
    result = evaluate_alerts(_portfolio(drawdown=-0.30), _cap_false())
    assert result.l3.triggered is True


# ── OPPORTUNITY ───────────────────────────────────────────────────────────────

def test_opportunity_triggered():
    result = evaluate_alerts(_portfolio(drawdown=-0.05), _cap_true())
    assert result.opportunity.triggered is True
    assert result.opportunity.action_recommended == "deploy_strategic_cash_4m_jpy_recommended"
    assert result.has_opportunity is True


def test_opportunity_not_triggered_partial():
    # 3条件成立（部分）は OPPORTUNITY にならない
    result = evaluate_alerts(_portfolio(drawdown=-0.05), _cap_partial())
    assert result.opportunity.triggered is False
    assert result.has_opportunity is False
    assert result.opportunity.action_recommended == "none"


# ── highest_level ─────────────────────────────────────────────────────────────

def test_highest_level_opportunity_overrides_l3():
    # DD=-35% (L1+L2+L3) + Capitulation(OPPORTUNITY) → highest="OPPORTUNITY"
    result = evaluate_alerts(_portfolio(drawdown=-0.35), _cap_true())
    assert result.highest_level == "OPPORTUNITY"
    assert result.l3.triggered is True   # L3 も同時にアクティブ


def test_highest_level_l3_no_opportunity():
    # DD=-35% → L1+L2+L3 アクティブ、OPPORTUNITY なし → highest="L3"
    result = evaluate_alerts(_portfolio(drawdown=-0.35), _cap_false())
    assert result.highest_level == "L3"


def test_none_when_all_clear():
    # 全クリア → highest="NONE"
    result = evaluate_alerts(_portfolio(drawdown=-0.05, vix=20.0), _cap_false())
    assert result.highest_level == "NONE"
    assert result.has_opportunity is False
    assert result.l1.triggered is False
    assert result.l2.triggered is False
    assert result.l3.triggered is False
