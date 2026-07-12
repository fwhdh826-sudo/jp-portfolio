"""
Card 1-3 — Tier A Soft Penalty テスト
T5-T8 + T_v3 のペナルティ算出ロジックを担保するテスト群。
"""
from __future__ import annotations

import pytest

from backend.engine.tier_a.tier_a_soft_penalty import (
    T5_CORE_TARGET,
    T5_LOWER_WARN,
    T5_LOWER_SEVERE,
    T5_COEF_WARN,
    T5_COEF_SEVERE,
    T6_UPPER_WARN,
    T6_UPPER_SEVERE,
    T6_COEF_WARN,
    T6_COEF_SEVERE,
    T7_UPPER_WARN,
    T7_UPPER_SEVERE,
    T7_COEF_WARN,
    T7_COEF_SEVERE,
    T8_LOWER_WARN,
    T8_LOWER_SEVERE,
    T8_COEF_WARN,
    T8_COEF_SEVERE,
    TV3_COEF,
    SoftAssetInput,
    SoftPortfolioInput,
    SoftViolation,
    SoftPenaltyResult,
    check_t5_core_ratio,
    check_t6_leverage_ratio,
    check_t7_single_concentration,
    check_t8_cash_ratio,
    check_tv3_diff,
    evaluate_soft_penalty,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

def _asset(
    ticker: str,
    *,
    is_core: bool = False,
    is_leveraged: bool = False,
    is_cash: bool = False,
    weight: float = 0.05,
    v3: float | None = None,
) -> SoftAssetInput:
    return SoftAssetInput(
        ticker=ticker,
        is_core=is_core,
        is_leveraged=is_leveraged,
        is_cash=is_cash,
        weight=weight,
        v3_target_weight=v3 if v3 is not None else weight,
    )


def _healthy_portfolio() -> SoftPortfolioInput:
    """T5-T8 + T_v3 全クリアのポートフォリオ。各個別 weight ≤ 8%。"""
    cores = [_asset(f"C{i}", is_core=True, weight=0.08) for i in range(7)]
    # core = 7 × 8% = 56% ≥ 50% (T5 ok)
    return SoftPortfolioInput(assets=cores + [
        _asset("LEV", is_leveraged=True, weight=0.06),  # lev 6% ≤ 20% (T6 ok), ≤ 8% (T7 ok)
        _asset("CASH", is_cash=True, weight=0.08),      # cash 8% ≥ 7.7% (T8 ok)
        _asset("SAT", weight=0.08),                     # sat 8% = 0.08 not > 0.08 (T7 ok)
    ])


# ── Constants ─────────────────────────────────────────────────────────────────

def test_constants_match_spec():
    assert T5_CORE_TARGET == 0.55
    assert T5_LOWER_WARN == 0.50
    assert T5_LOWER_SEVERE == 0.45
    assert T5_COEF_WARN == 5.0
    assert T5_COEF_SEVERE == 50.0

    assert T6_UPPER_WARN == 0.20
    assert T6_UPPER_SEVERE == 0.25
    assert T6_COEF_WARN == 10.0
    assert T6_COEF_SEVERE == 100.0

    assert T7_UPPER_WARN == 0.08
    assert T7_UPPER_SEVERE == 0.12
    assert T7_COEF_WARN == 8.0
    assert T7_COEF_SEVERE == 80.0

    assert T8_LOWER_WARN == pytest.approx(0.077)
    assert T8_LOWER_SEVERE == 0.05
    assert T8_COEF_WARN == 6.0
    assert T8_COEF_SEVERE == 60.0

    assert TV3_COEF == 2.0


# ── T5: Core 比率 下限 ────────────────────────────────────────────────────────

def test_t5_ok():
    assets = [_asset("CORE", is_core=True, weight=0.55)]
    v = check_t5_core_ratio(assets)
    assert v.severity == "ok"
    assert v.penalty_score == pytest.approx(0.0)


def test_t5_warn_below_50():
    assets = [_asset("CORE", is_core=True, weight=0.48)]
    v = check_t5_core_ratio(assets)
    assert v.severity == "warn"
    assert v.rule_id == "T5"
    assert v.penalty_score == pytest.approx(T5_COEF_WARN * (T5_LOWER_WARN - 0.48))


def test_t5_severe_below_45():
    assets = [_asset("CORE", is_core=True, weight=0.43)]
    v = check_t5_core_ratio(assets)
    assert v.severity == "severe"
    assert v.penalty_score == pytest.approx(T5_COEF_WARN * (T5_LOWER_WARN - T5_LOWER_SEVERE) + T5_COEF_SEVERE * (T5_LOWER_SEVERE - 0.43))


def test_t5_exactly_at_warn_boundary():
    # core = 0.50 is NOT < 0.50 → ok
    assets = [_asset("CORE", is_core=True, weight=0.50)]
    v = check_t5_core_ratio(assets)
    assert v.severity == "ok"
    assert v.penalty_score == pytest.approx(0.0)


def test_t5_exactly_at_severe_boundary():
    # core = 0.45 is NOT < 0.45 → warn (between lower_warn and lower_severe)
    assets = [_asset("CORE", is_core=True, weight=0.45)]
    v = check_t5_core_ratio(assets)
    assert v.severity == "warn"
    assert v.penalty_score == pytest.approx(T5_COEF_WARN * (T5_LOWER_WARN - 0.45))


# ── T6: レバレッジ 上限 ───────────────────────────────────────────────────────

def test_t6_ok():
    assets = [_asset("LEV", is_leveraged=True, weight=0.15)]
    v = check_t6_leverage_ratio(assets)
    assert v.severity == "ok"
    assert v.penalty_score == pytest.approx(0.0)


def test_t6_warn_above_20():
    assets = [_asset("LEV", is_leveraged=True, weight=0.22)]
    v = check_t6_leverage_ratio(assets)
    assert v.severity == "warn"
    assert v.rule_id == "T6"
    assert v.penalty_score == pytest.approx(T6_COEF_WARN * (0.22 - T6_UPPER_WARN))


def test_t6_severe_above_25():
    assets = [_asset("LEV", is_leveraged=True, weight=0.27)]
    v = check_t6_leverage_ratio(assets)
    assert v.severity == "severe"
    assert v.penalty_score == pytest.approx(T6_COEF_WARN * (T6_UPPER_SEVERE - T6_UPPER_WARN) + T6_COEF_SEVERE * (0.27 - T6_UPPER_SEVERE))


def test_t6_exactly_at_warn_no_violation():
    # lev = 0.20 is NOT > 0.20 → ok
    assets = [_asset("LEV", is_leveraged=True, weight=0.20)]
    v = check_t6_leverage_ratio(assets)
    assert v.severity == "ok"
    assert v.penalty_score == pytest.approx(0.0)


# ── T7: 単一銘柄集中 上限 ────────────────────────────────────────────────────

def test_t7_ok_all_under_8pct():
    assets = [
        _asset("A", weight=0.07),
        _asset("B", weight=0.05),
        _asset("CASH", is_cash=True, weight=0.10),  # is_cash → T7 除外
    ]
    result = check_t7_single_concentration(assets)
    assert result == []


def test_t7_warn_single_over_8pct():
    assets = [_asset("CONC", weight=0.09)]
    result = check_t7_single_concentration(assets)
    assert len(result) == 1
    assert result[0].severity == "warn"
    assert result[0].rule_id == "T7"
    assert result[0].penalty_score == pytest.approx(T7_COEF_WARN * (0.09 - T7_UPPER_WARN))


def test_t7_severe_single_over_12pct():
    assets = [_asset("CONC", weight=0.15)]
    result = check_t7_single_concentration(assets)
    assert len(result) == 1
    assert result[0].severity == "severe"
    assert result[0].penalty_score == pytest.approx(T7_COEF_WARN * (T7_UPPER_SEVERE - T7_UPPER_WARN) + T7_COEF_SEVERE * (0.15 - T7_UPPER_SEVERE))


def test_t7_multiple_violations():
    assets = [
        _asset("A", weight=0.09),   # warn
        _asset("B", weight=0.06),   # ok
        _asset("C", weight=0.14),   # severe
    ]
    result = check_t7_single_concentration(assets)
    assert len(result) == 2
    severities = {v.detail.split()[0]: v.severity for v in result}
    assert severities["A"] == "warn"
    assert severities["C"] == "severe"


def test_t7_exactly_at_warn_no_violation():
    # weight = 0.08 is NOT > 0.08 → ok → not included
    assets = [_asset("A", weight=0.08)]
    result = check_t7_single_concentration(assets)
    assert result == []


# ── T8: 現金比率 下限 ─────────────────────────────────────────────────────────

def test_t8_ok():
    assets = [_asset("CASH", is_cash=True, weight=0.10)]
    v = check_t8_cash_ratio(assets)
    assert v.severity == "ok"
    assert v.penalty_score == pytest.approx(0.0)


def test_t8_warn_below_077():
    assets = [_asset("CASH", is_cash=True, weight=0.06)]
    v = check_t8_cash_ratio(assets)
    assert v.severity == "warn"
    assert v.rule_id == "T8"
    assert v.penalty_score == pytest.approx(T8_COEF_WARN * (T8_LOWER_WARN - 0.06))


def test_t8_severe_below_05():
    assets = [_asset("CASH", is_cash=True, weight=0.04)]
    v = check_t8_cash_ratio(assets)
    assert v.severity == "severe"
    assert v.penalty_score == pytest.approx(T8_COEF_WARN * (T8_LOWER_WARN - T8_LOWER_SEVERE) + T8_COEF_SEVERE * (T8_LOWER_SEVERE - 0.04))


def test_t8_exactly_at_warn_boundary():
    # cash = 0.077 is NOT < 0.077 → ok
    assets = [_asset("CASH", is_cash=True, weight=0.077)]
    v = check_t8_cash_ratio(assets)
    assert v.severity == "ok"
    assert v.penalty_score == pytest.approx(0.0)


# ── T_v3: v3.0 乖離 ──────────────────────────────────────────────────────────

def test_tv3_no_diff():
    assets = [
        SoftAssetInput("A", False, False, False, 0.30, 0.30),
        SoftAssetInput("B", False, False, True, 0.10, 0.10),
    ]
    v = check_tv3_diff(assets)
    assert v.severity == "ok"
    assert v.penalty_score == pytest.approx(0.0)
    assert v.current_value == pytest.approx(0.0)


def test_tv3_positive_diff():
    assets = [
        SoftAssetInput("A", False, False, False, 0.35, 0.30),  # diff = 0.05
        SoftAssetInput("B", False, False, True, 0.10, 0.10),   # diff = 0
    ]
    v = check_tv3_diff(assets)
    assert v.severity == "warn"
    assert v.rule_id == "T_v3"
    assert v.penalty_score == pytest.approx(TV3_COEF * 0.05)
    assert v.current_value == pytest.approx(0.05)


# ── evaluate_soft_penalty ─────────────────────────────────────────────────────

def test_evaluate_no_violations():
    pf = _healthy_portfolio()
    result = evaluate_soft_penalty(pf)
    assert isinstance(result, SoftPenaltyResult)
    assert result.total_penalty == pytest.approx(0.0)
    assert result.any_warn is False
    assert result.any_severe is False


def test_evaluate_mixed_violations():
    # T6 warn (lev=22% > 20%), T7 severe (lev=22% > 12%) が同時発生するケース
    cores = [_asset(f"C{i}", is_core=True, weight=0.07) for i in range(8)]  # core=56% T5 ok
    pf = SoftPortfolioInput(assets=cores + [
        _asset("LEV", is_leveraged=True, weight=0.22),  # T6 warn + T7 severe
        _asset("CASH", is_cash=True, weight=0.08),      # T8 ok
    ])
    result = evaluate_soft_penalty(pf)
    assert result.any_warn is True
    assert result.any_severe is True
    t6 = next(v for v in result.violations if v.rule_id == "T6")
    assert t6.severity == "warn"
    t7_vs = [v for v in result.violations if v.rule_id == "T7"]
    assert any(v.severity == "severe" for v in t7_vs)


def test_evaluate_total_penalty_sum():
    """total_penalty は各 violation.penalty_score の合計と常に一致する"""
    pf = SoftPortfolioInput(assets=[
        _asset("C1", is_core=True, weight=0.48, v3=0.50),  # T5 warn + T_v3 diff
        _asset("CASH", is_cash=True, weight=0.08),
        _asset("LEV", is_leveraged=True, weight=0.07),
    ])
    result = evaluate_soft_penalty(pf)
    expected = sum(v.penalty_score for v in result.violations)
    assert result.total_penalty == pytest.approx(expected)
    # T5 warn の penalty 値も確認
    t5 = next(v for v in result.violations if v.rule_id == "T5")
    assert t5.severity == "warn"
    assert t5.penalty_score == pytest.approx(T5_COEF_WARN * (T5_LOWER_WARN - 0.48))
    # T_v3 penalty の確認
    tv3 = next(v for v in result.violations if v.rule_id == "T_v3")
    assert tv3.penalty_score == pytest.approx(TV3_COEF * 0.02)


def test_evaluate_any_flags():
    # any_warn/any_severe が正しくセットされることを確認
    # all ok → both False
    pf_ok = _healthy_portfolio()
    r_ok = evaluate_soft_penalty(pf_ok)
    assert r_ok.any_warn is False
    assert r_ok.any_severe is False

    # T8 severe → any_severe=True
    pf_severe = SoftPortfolioInput(assets=[
        _asset("C1", is_core=True, weight=0.55),
        _asset("CASH", is_cash=True, weight=0.03),  # T8 severe
    ])
    r_severe = evaluate_soft_penalty(pf_severe)
    assert r_severe.any_severe is True

    # T8 warn only → any_warn=True, any_severe=False
    pf_warn = SoftPortfolioInput(assets=[
        _asset("C1", is_core=True, weight=0.55),
        _asset("CASH", is_cash=True, weight=0.06),  # T8 warn
    ])
    r_warn = evaluate_soft_penalty(pf_warn)
    assert r_warn.any_warn is True


def test_evaluate_all_rules_checked_always():
    """evaluate_soft_penalty は T5-T8 + T_v3 を常に全て評価する"""
    pf = _healthy_portfolio()
    result = evaluate_soft_penalty(pf)
    rule_ids = {v.rule_id for v in result.violations}
    assert "T5" in rule_ids
    assert "T6" in rule_ids
    assert "T7" in rule_ids
    assert "T8" in rule_ids
    assert "T_v3" in rule_ids
