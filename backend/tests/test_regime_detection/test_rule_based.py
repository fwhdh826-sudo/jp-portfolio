"""
Card 3-1 — Rule-Based Regime Detection テスト
Detection-only であることを担保するテスト群。
"""
from __future__ import annotations

import pytest

from backend.engine.regime.rule_based import (
    CRISIS_VIX_THRESHOLD,
    CRISIS_SP500_DD_THRESHOLD,
    BEAR_SP500_DD_THRESHOLD,
    BULL_VOLATILE_VIX_THRESHOLD,
    BULL_CALM_VIX_THRESHOLD,
    REGIME_LABELS,
    RuleBasedInput,
    RuleBasedResult,
    detect_regime_rule_based,
    evaluate_rule_based,
)


# ── Fixtures / helpers ────────────────────────────────────────────────────────

def make_input(
    vix: float = 20.0,
    nikkei_5d_return: float = 0.02,
    nikkei_60ma: float = 38_000.0,
    nikkei_200ma: float = 37_000.0,
    sp500_dd_30d: float = -0.05,
) -> RuleBasedInput:
    return RuleBasedInput(
        vix=vix,
        nikkei_5d_return=nikkei_5d_return,
        nikkei_60ma=nikkei_60ma,
        nikkei_200ma=nikkei_200ma,
        sp500_dd_30d=sp500_dd_30d,
    )


def make_market_data(
    vix: float = 20.0,
    nikkei_5d_return: float = 0.02,
    nikkei_60ma: float = 38_000.0,
    nikkei_200ma: float = 37_000.0,
    sp500_dd_30d: float = -0.05,
) -> dict:
    return {
        "vix": vix,
        "nikkei_5d_return": nikkei_5d_return,
        "nikkei_60ma": nikkei_60ma,
        "nikkei_200ma": nikkei_200ma,
        "sp500_dd_30d": sp500_dd_30d,
    }


# ── Constants sanity ──────────────────────────────────────────────────────────

def test_constants_match_regime_md():
    assert CRISIS_VIX_THRESHOLD == 40.0
    assert CRISIS_SP500_DD_THRESHOLD == -0.20
    assert BEAR_SP500_DD_THRESHOLD == -0.10
    assert BULL_VOLATILE_VIX_THRESHOLD == 25.0
    assert BULL_CALM_VIX_THRESHOLD == 18.0


def test_regime_labels_complete():
    assert set(REGIME_LABELS) == {"bull_calm", "bull_volatile", "bear", "crisis", "uncertain"}


# ── Crisis ────────────────────────────────────────────────────────────────────

def test_crisis_by_vix():
    result = evaluate_rule_based(make_input(vix=41.0, sp500_dd_30d=-0.05))
    assert result.regime == "crisis"
    assert "vix > 40" in result.primary_rule


def test_crisis_by_sp500_dd():
    result = evaluate_rule_based(make_input(vix=30.0, sp500_dd_30d=-0.21))
    assert result.regime == "crisis"
    assert "sp500_dd_30d < -20%" in result.primary_rule


def test_crisis_both_conditions():
    result = evaluate_rule_based(make_input(vix=45.0, sp500_dd_30d=-0.25))
    assert result.regime == "crisis"


def test_crisis_vix_exactly_40_not_triggered():
    """境界値: VIX = 40.0 は crisis 未トリガー（厳密大なり）"""
    result = evaluate_rule_based(make_input(vix=40.0, sp500_dd_30d=-0.05))
    assert result.regime != "crisis"


def test_crisis_sp500_dd_exactly_minus_20pct_not_triggered():
    """境界値: sp500_dd = -0.20 は crisis 未トリガー（厳密小なり）"""
    result = evaluate_rule_based(make_input(vix=20.0, sp500_dd_30d=-0.20))
    assert result.regime != "crisis"


def test_crisis_rules_evaluated_populated():
    result = evaluate_rule_based(make_input(vix=42.0))
    assert len(result.rules_evaluated) == 2
    rule_names = [r[0] for r in result.rules_evaluated]
    assert "vix > 40" in rule_names
    assert "sp500_dd_30d < -20%" in rule_names


# ── Bear ──────────────────────────────────────────────────────────────────────

def test_bear_death_cross_and_dd():
    result = evaluate_rule_based(make_input(
        vix=22.0,
        nikkei_60ma=35_000.0,
        nikkei_200ma=38_000.0,
        sp500_dd_30d=-0.12,
    ))
    assert result.regime == "bear"
    assert result.primary_rule == "death_cross + dd"


def test_bear_requires_both_conditions_missing_dd():
    """デスクロスのみ（dd が -10% 未満でない）→ bear 未トリガー"""
    result = evaluate_rule_based(make_input(
        vix=22.0,
        nikkei_60ma=35_000.0,
        nikkei_200ma=38_000.0,
        sp500_dd_30d=-0.05,
    ))
    assert result.regime != "bear"


def test_bear_requires_both_conditions_missing_death_cross():
    """sp500_dd < -10% だが golden cross → bear 未トリガー"""
    result = evaluate_rule_based(make_input(
        vix=22.0,
        nikkei_60ma=40_000.0,
        nikkei_200ma=38_000.0,
        sp500_dd_30d=-0.15,
    ))
    assert result.regime != "bear"


def test_bear_sp500_dd_exactly_minus_10pct_not_triggered():
    """境界値: sp500_dd = -0.10 は bear 未トリガー（厳密小なり）"""
    result = evaluate_rule_based(make_input(
        vix=22.0,
        nikkei_60ma=35_000.0,
        nikkei_200ma=38_000.0,
        sp500_dd_30d=-0.10,
    ))
    assert result.regime != "bear"


def test_bear_rules_evaluated_populated():
    result = evaluate_rule_based(make_input(
        nikkei_60ma=35_000.0, nikkei_200ma=38_000.0, sp500_dd_30d=-0.12,
    ))
    assert len(result.rules_evaluated) == 2
    rule_names = [r[0] for r in result.rules_evaluated]
    assert "60MA < 200MA" in rule_names
    assert "sp500_dd_30d < -10%" in rule_names


# ── Bull Volatile ─────────────────────────────────────────────────────────────

def test_bull_volatile_high_vix_positive_trend():
    result = evaluate_rule_based(make_input(vix=28.0, nikkei_5d_return=0.01))
    assert result.regime == "bull_volatile"
    assert result.primary_rule == "high_vol_uptrend"


def test_bull_volatile_requires_positive_trend():
    result = evaluate_rule_based(make_input(vix=28.0, nikkei_5d_return=-0.01))
    assert result.regime != "bull_volatile"


def test_bull_volatile_requires_high_vix():
    result = evaluate_rule_based(make_input(vix=24.0, nikkei_5d_return=0.01))
    assert result.regime != "bull_volatile"


def test_bull_volatile_vix_exactly_25_not_triggered():
    """境界値: VIX = 25.0 は bull_volatile 未トリガー（厳密大なり）"""
    result = evaluate_rule_based(make_input(vix=25.0, nikkei_5d_return=0.01))
    assert result.regime != "bull_volatile"


def test_bull_volatile_nikkei_5d_exactly_zero_not_triggered():
    """境界値: nikkei_5d = 0.0 は bull_volatile 未トリガー（厳密大なり）"""
    result = evaluate_rule_based(make_input(vix=28.0, nikkei_5d_return=0.0))
    assert result.regime != "bull_volatile"


# ── Bull Calm ─────────────────────────────────────────────────────────────────

def test_bull_calm_low_vix_flat_trend():
    result = evaluate_rule_based(make_input(vix=15.0, nikkei_5d_return=0.0))
    assert result.regime == "bull_calm"
    assert result.primary_rule == "low_vol_uptrend"


def test_bull_calm_low_vix_positive_trend():
    result = evaluate_rule_based(make_input(vix=12.0, nikkei_5d_return=0.03))
    assert result.regime == "bull_calm"


def test_bull_calm_requires_low_vix():
    result = evaluate_rule_based(make_input(vix=20.0, nikkei_5d_return=0.02))
    assert result.regime != "bull_calm"


def test_bull_calm_requires_non_negative_trend():
    result = evaluate_rule_based(make_input(vix=15.0, nikkei_5d_return=-0.01))
    assert result.regime != "bull_calm"


def test_bull_calm_vix_exactly_18_not_triggered():
    """境界値: VIX = 18.0 は bull_calm 未トリガー（厳密小なり）"""
    result = evaluate_rule_based(make_input(vix=18.0, nikkei_5d_return=0.01))
    assert result.regime != "bull_calm"


# ── Uncertain ─────────────────────────────────────────────────────────────────

def test_uncertain_no_condition_matches():
    """VIX 18-25、5d return 小幅マイナス → uncertain"""
    result = evaluate_rule_based(make_input(
        vix=20.0,
        nikkei_5d_return=-0.005,
        nikkei_60ma=38_000.0,
        nikkei_200ma=37_000.0,
        sp500_dd_30d=-0.05,
    ))
    assert result.regime == "uncertain"
    assert result.primary_rule == "no_match"


def test_uncertain_is_default_fallback():
    result = evaluate_rule_based(make_input(vix=22.0, nikkei_5d_return=-0.01))
    assert result.regime == "uncertain"


def test_uncertain_rules_evaluated_empty():
    result = evaluate_rule_based(make_input(vix=22.0, nikkei_5d_return=-0.01))
    assert result.rules_evaluated == []


# ── Priority ordering ─────────────────────────────────────────────────────────

def test_crisis_takes_priority_over_bear():
    """VIX > 40 → crisis（death cross + dd を満たしていても crisis 優先）"""
    result = evaluate_rule_based(make_input(
        vix=45.0,
        nikkei_60ma=34_000.0,
        nikkei_200ma=38_000.0,
        sp500_dd_30d=-0.25,
    ))
    assert result.regime == "crisis"


def test_bear_takes_priority_over_bull_volatile():
    """death_cross + dd → bear（VIX > 25 AND nikkei_5d > 0 でも bear 優先）"""
    result = evaluate_rule_based(make_input(
        vix=28.0,
        nikkei_5d_return=0.01,
        nikkei_60ma=35_000.0,
        nikkei_200ma=38_000.0,
        sp500_dd_30d=-0.15,
    ))
    assert result.regime == "bear"


def test_all_five_regimes_reachable():
    """5レジーム全てが evaluate_rule_based で到達可能なことを確認"""
    cases = [
        make_input(vix=45.0),                                                          # crisis
        make_input(vix=22.0, nikkei_60ma=35_000.0, nikkei_200ma=38_000.0, sp500_dd_30d=-0.15),  # bear
        make_input(vix=28.0, nikkei_5d_return=0.01),                                   # bull_volatile
        make_input(vix=15.0, nikkei_5d_return=0.01),                                   # bull_calm
        make_input(vix=22.0, nikkei_5d_return=-0.01),                                  # uncertain
    ]
    regimes = {evaluate_rule_based(inp).regime for inp in cases}
    assert regimes == {"crisis", "bear", "bull_volatile", "bull_calm", "uncertain"}


# ── detect_regime_rule_based (dict interface) ─────────────────────────────────

def test_dict_interface_returns_dict():
    result = detect_regime_rule_based(make_market_data())
    assert isinstance(result, dict)
    assert "regime" in result
    assert "primary_rule" in result
    assert "rules_evaluated" in result


def test_dict_interface_regime_in_valid_labels():
    result = detect_regime_rule_based(make_market_data())
    assert result["regime"] in REGIME_LABELS


def test_dict_interface_crisis():
    result = detect_regime_rule_based(make_market_data(vix=45.0))
    assert result["regime"] == "crisis"


def test_dict_interface_bear():
    result = detect_regime_rule_based(make_market_data(
        nikkei_60ma=35_000.0, nikkei_200ma=38_000.0, sp500_dd_30d=-0.15,
    ))
    assert result["regime"] == "bear"


def test_dict_interface_bull_volatile():
    result = detect_regime_rule_based(make_market_data(vix=28.0, nikkei_5d_return=0.01))
    assert result["regime"] == "bull_volatile"


def test_dict_interface_bull_calm():
    result = detect_regime_rule_based(make_market_data(vix=15.0))
    assert result["regime"] == "bull_calm"


def test_dict_interface_uncertain():
    result = detect_regime_rule_based(make_market_data(vix=22.0, nikkei_5d_return=-0.01))
    assert result["regime"] == "uncertain"


# ── RuleBasedResult validation ────────────────────────────────────────────────

def test_result_invalid_regime_raises():
    with pytest.raises(ValueError, match="Invalid regime"):
        RuleBasedResult(regime="unknown_regime", primary_rule="test")


def test_result_valid_regime_does_not_raise():
    for label in REGIME_LABELS:
        result = RuleBasedResult(regime=label, primary_rule="test")
        assert result.regime == label


# ── Detection-only 担保 ───────────────────────────────────────────────────────

def test_no_order_no_trade_in_result():
    """RuleBasedResult に order / trade / execute / action フィールドなし"""
    result = evaluate_rule_based(make_input(vix=45.0))
    result_fields = {f for f in vars(result)}
    forbidden = {"order", "trade", "execute", "action"}
    assert result_fields.isdisjoint(forbidden)


def test_detect_rule_based_no_side_effects():
    """同一入力を複数回呼び出しても結果が変わらない（副作用なし）"""
    inp = make_input(vix=28.0, nikkei_5d_return=0.01)
    results = [evaluate_rule_based(inp).regime for _ in range(3)]
    assert len(set(results)) == 1
