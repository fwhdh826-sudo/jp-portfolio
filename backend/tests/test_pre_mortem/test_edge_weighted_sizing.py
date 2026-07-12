"""
test_edge_weighted_sizing.py — Card 7-9
EdgeSizingInput / EdgeSizingResult / EdgeWeightedSizer のテスト。
"""
from __future__ import annotations

import json

import pytest

import engine.pre_mortem.edge_weighted_sizing as _mod
from engine.pre_mortem.edge_weighted_sizing import (
    EDGE_FACTOR_MIN,
    EdgeSizingInput,
    EdgeSizingResult,
    EdgeWeightedSizer,
)


# ── helpers ───────────────────────────────────────────────────────────────────

def _make_input(**kwargs) -> EdgeSizingInput:
    defaults = dict(
        base_size=0.05,
        exposure_multiplier=1.0,
        committee_confidence=0.7,
        behavioral_score=30.0,
        sizing_multiplier_cap=1.0,
    )
    defaults.update(kwargs)
    return EdgeSizingInput(**defaults)


def _calc(**kwargs) -> EdgeSizingResult:
    return EdgeWeightedSizer().calculate(_make_input(**kwargs))


# ── stdlib only ───────────────────────────────────────────────────────────────

class TestStdlibOnly:
    def test_no_numpy_import(self):
        src = open(_mod.__file__).read()
        assert "import numpy" not in src

    def test_no_pandas_import(self):
        src = open(_mod.__file__).read()
        assert "import pandas" not in src

    def test_no_scipy_import(self):
        src = open(_mod.__file__).read()
        assert "import scipy" not in src

    def test_no_behavioral_import(self):
        src = open(_mod.__file__).read()
        assert "from engine.behavioral" not in src

    def test_no_agents_import(self):
        src = open(_mod.__file__).read()
        assert "from engine.agents" not in src

    def test_no_decision_import(self):
        src = open(_mod.__file__).read()
        assert "from engine.decision" not in src

    def test_no_llm_call(self):
        src = open(_mod.__file__).read()
        assert "call_llm_json" not in src


# ── 禁止フィールド ────────────────────────────────────────────────────────────

class TestForbiddenFields:
    def test_no_action_field(self):
        assert not hasattr(_calc(), "action")

    def test_no_is_buy_field(self):
        assert not hasattr(_calc(), "is_buy")

    def test_no_is_sell_field(self):
        assert not hasattr(_calc(), "is_sell")

    def test_no_verdict_field(self):
        assert not hasattr(_calc(), "verdict")

    def test_no_approve_field(self):
        assert not hasattr(_calc(), "approve")

    def test_no_reject_field(self):
        assert not hasattr(_calc(), "reject")

    def test_no_order_field(self):
        assert not hasattr(_calc(), "order")

    def test_no_shares_field(self):
        assert not hasattr(_calc(), "shares")

    def test_no_buy_amount_field(self):
        assert not hasattr(_calc(), "buy_amount")

    def test_no_recommendation_field(self):
        assert not hasattr(_calc(), "recommendation")


# ── EDGE_FACTOR_MIN ───────────────────────────────────────────────────────────

class TestEdgeFactorMin:
    def test_edge_factor_min_value(self):
        assert EDGE_FACTOR_MIN == pytest.approx(0.1)

    def test_floor_applied_when_confidence_zero(self):
        result = _calc(committee_confidence=0.0)
        assert result.edge_factor == pytest.approx(EDGE_FACTOR_MIN)

    def test_floor_applied_when_confidence_below_min(self):
        result = _calc(committee_confidence=0.05)
        assert result.edge_factor == pytest.approx(EDGE_FACTOR_MIN)

    def test_floor_not_applied_when_confidence_equals_min(self):
        result = _calc(committee_confidence=0.1)
        assert result.edge_factor == pytest.approx(0.1)

    def test_floor_not_applied_when_confidence_above(self):
        result = _calc(committee_confidence=0.5)
        assert result.edge_factor == pytest.approx(0.5)

    def test_floor_diagnostic_when_applied(self):
        result = _calc(committee_confidence=0.0)
        assert any("minimum floor" in d for d in result.diagnostics)

    def test_floor_diagnostic_not_present_when_not_applied(self):
        result = _calc(committee_confidence=0.7)
        assert not any("minimum floor" in d for d in result.diagnostics)

    def test_floor_diagnostic_says_not_execution_decision(self):
        result = _calc(committee_confidence=0.0)
        assert any(
            "not an execution decision" in d
            for d in result.diagnostics
        )


# ── EdgeSizingInput ───────────────────────────────────────────────────────────

class TestEdgeSizingInput:
    def test_basic_construction(self):
        inp = _make_input()
        assert inp.base_size == pytest.approx(0.05)
        assert inp.exposure_multiplier == pytest.approx(1.0)
        assert inp.committee_confidence == pytest.approx(0.7)

    def test_base_size_clamped_low(self):
        assert _make_input(base_size=-0.1).base_size == 0.0

    def test_base_size_clamped_high(self):
        assert _make_input(base_size=1.5).base_size == pytest.approx(1.0)

    def test_exposure_multiplier_clamped_low(self):
        assert _make_input(exposure_multiplier=-1.0).exposure_multiplier == 0.0

    def test_exposure_multiplier_clamped_high(self):
        assert _make_input(exposure_multiplier=3.0).exposure_multiplier == pytest.approx(2.0)

    def test_committee_confidence_clamped_low(self):
        assert _make_input(committee_confidence=-0.5).committee_confidence == 0.0

    def test_committee_confidence_clamped_high(self):
        assert _make_input(committee_confidence=1.5).committee_confidence == pytest.approx(1.0)

    def test_behavioral_score_clamped_low(self):
        assert _make_input(behavioral_score=-10.0).behavioral_score == 0.0

    def test_behavioral_score_clamped_high(self):
        assert _make_input(behavioral_score=150.0).behavioral_score == pytest.approx(100.0)

    def test_sizing_multiplier_cap_clamped_low(self):
        assert _make_input(sizing_multiplier_cap=-0.5).sizing_multiplier_cap == 0.0

    def test_sizing_multiplier_cap_clamped_high(self):
        assert _make_input(sizing_multiplier_cap=1.5).sizing_multiplier_cap == pytest.approx(1.0)

    def test_nan_base_size_becomes_zero(self):
        assert _make_input(base_size=float("nan")).base_size == 0.0

    def test_inf_behavioral_score_safe_float_fallback(self):
        # inf → _safe_float fallback → 0.0 (not 100.0)
        assert _make_input(behavioral_score=float("inf")).behavioral_score == pytest.approx(0.0)

    def test_frozen(self):
        inp = _make_input()
        with pytest.raises((AttributeError, TypeError)):
            inp.base_size = 0.9  # type: ignore

    def test_context_default_empty(self):
        assert _make_input().context == {}

    def test_context_invalid_becomes_empty(self):
        assert _make_input(context="bad").context == {}  # type: ignore


# ── EdgeSizingResult ──────────────────────────────────────────────────────────

class TestEdgeSizingResult:
    def test_result_is_frozen(self):
        result = _calc()
        with pytest.raises((AttributeError, TypeError)):
            result.sizing_multiplier = 0.5  # type: ignore

    def test_to_dict_keys(self):
        d = _calc().to_dict()
        assert set(d.keys()) == {
            "sizing_multiplier", "adjusted_size", "is_size_capped",
            "edge_factor", "behavioral_damping", "diagnostics",
        }

    def test_to_dict_json_serializable(self):
        json.dumps(_calc().to_dict())  # must not raise

    def test_diagnostics_is_tuple(self):
        assert isinstance(_calc().diagnostics, tuple)


# ── 計算式検証 ────────────────────────────────────────────────────────────────

class TestCalculationFormula:
    def test_basic_calculation(self):
        # edge_factor = clamp(0.7, 0.1, 1.0) = 0.7
        # behavioral_damping = 1 - 30/100 = 0.7
        # raw = 1.0 * 0.7 * 0.7 = 0.49
        # sizing_multiplier = clamp(0.49, 0.0, 1.0) = 0.49
        # adjusted_size = 0.05 * 0.49
        result = _calc(
            base_size=0.05,
            exposure_multiplier=1.0,
            committee_confidence=0.7,
            behavioral_score=30.0,
            sizing_multiplier_cap=1.0,
        )
        assert result.edge_factor == pytest.approx(0.7)
        assert result.behavioral_damping == pytest.approx(0.7)
        assert result.sizing_multiplier == pytest.approx(0.7 * 0.7)
        assert result.adjusted_size == pytest.approx(0.05 * 0.7 * 0.7, abs=1e-9)
        assert result.is_size_capped is False

    def test_zero_base_size_zero_adjusted(self):
        result = _calc(base_size=0.0)
        assert result.adjusted_size == pytest.approx(0.0)

    def test_zero_behavioral_score_max_damping(self):
        result = _calc(behavioral_score=0.0)
        assert result.behavioral_damping == pytest.approx(1.0)

    def test_full_behavioral_score_zero_damping(self):
        result = _calc(behavioral_score=100.0)
        assert result.behavioral_damping == pytest.approx(0.0)
        assert result.sizing_multiplier == pytest.approx(0.0)
        assert result.adjusted_size == pytest.approx(0.0)

    def test_confidence_one_max_edge(self):
        result = _calc(committee_confidence=1.0)
        assert result.edge_factor == pytest.approx(1.0)

    def test_high_exposure_cap_binding(self):
        # raw = 2.0 * 1.0 * 1.0 = 2.0, cap=1.0 → capped
        result = _calc(
            exposure_multiplier=2.0,
            committee_confidence=1.0,
            behavioral_score=0.0,
            sizing_multiplier_cap=1.0,
        )
        assert result.is_size_capped is True
        assert result.sizing_multiplier == pytest.approx(1.0)

    def test_cap_binding_at_05(self):
        # raw = 1.0 * 1.0 * 1.0 = 1.0, cap=0.5 → capped
        result = _calc(
            exposure_multiplier=1.0,
            committee_confidence=1.0,
            behavioral_score=0.0,
            sizing_multiplier_cap=0.5,
        )
        assert result.is_size_capped is True
        assert result.sizing_multiplier == pytest.approx(0.5)

    def test_cap_not_binding(self):
        # raw = 1.0 * 0.5 * 0.7 = 0.35 < cap=1.0
        result = _calc(
            exposure_multiplier=1.0,
            committee_confidence=0.5,
            behavioral_score=30.0,
            sizing_multiplier_cap=1.0,
        )
        assert result.is_size_capped is False
        assert result.sizing_multiplier == pytest.approx(1.0 * 0.5 * 0.7)

    def test_zero_cap_zero_multiplier_is_capped(self):
        result = _calc(sizing_multiplier_cap=0.0)
        assert result.sizing_multiplier == pytest.approx(0.0)
        assert result.adjusted_size == pytest.approx(0.0)
        assert result.is_size_capped is True

    def test_adjusted_size_within_weight_range(self):
        result = _calc(
            base_size=1.0,
            exposure_multiplier=2.0,
            committee_confidence=1.0,
            behavioral_score=0.0,
            sizing_multiplier_cap=1.0,
        )
        assert 0.0 <= result.adjusted_size <= 1.0

    def test_negative_exposure_multiplier_becomes_zero(self):
        # __post_init__ で clamp → exposure_multiplier=0 → raw=0 → adjusted=0
        result = _calc(exposure_multiplier=-1.0)
        assert result.sizing_multiplier == pytest.approx(0.0)
        assert result.adjusted_size == pytest.approx(0.0)

    def test_cap_02_from_pre_mortem(self):
        # cap=0.2 の場合（PreMortemResult.sizing_multiplier_cap=0.2 シナリオ）
        result = _calc(
            exposure_multiplier=2.0,
            committee_confidence=1.0,
            behavioral_score=0.0,
            sizing_multiplier_cap=0.2,
        )
        assert result.sizing_multiplier == pytest.approx(0.2)
        assert result.is_size_capped is True

    def test_adjusted_size_is_weight_not_jpy(self):
        # adjusted_size は weight（0–1）、JPY 金額ではない（P2-7AC）
        result = _calc(base_size=0.1)
        assert 0.0 <= result.adjusted_size <= 1.0


# ── end-to-end 高リスクシナリオ ───────────────────────────────────────────────

class TestEndToEnd:
    def test_high_risk_scenario_from_pre_mortem(self):
        """全リスクフラグ時: cap=0.2 を受け取り sizing が制限される"""
        result = _calc(
            base_size=0.05,
            exposure_multiplier=1.5,
            committee_confidence=0.6,
            behavioral_score=75.0,
            sizing_multiplier_cap=0.2,
        )
        # edge_factor = 0.6, damping = 1-75/100 = 0.25
        # raw = 1.5 * 0.6 * 0.25 = 0.225 > cap=0.2 → capped
        assert result.is_size_capped is True
        assert result.sizing_multiplier == pytest.approx(0.2)
        assert result.adjusted_size == pytest.approx(0.05 * 0.2, abs=1e-9)

    def test_low_risk_scenario_no_cap(self):
        """リスクなし: cap=1.0、full sizing が適用される"""
        result = _calc(
            base_size=0.1,
            exposure_multiplier=1.0,
            committee_confidence=0.8,
            behavioral_score=10.0,
            sizing_multiplier_cap=1.0,
        )
        # edge_factor = 0.8, damping = 0.9
        # raw = 1.0 * 0.8 * 0.9 = 0.72 <= cap=1.0
        assert result.is_size_capped is False
        assert result.sizing_multiplier == pytest.approx(0.72)
        assert result.adjusted_size == pytest.approx(0.1 * 0.72, abs=1e-9)


# ── observation: prefix ───────────────────────────────────────────────────────

class TestObservationPrefixes:
    def test_all_diagnostics_have_observation_prefix(self):
        result = _calc()
        for d in result.diagnostics:
            assert d.startswith("observation:"), f"Missing prefix: {d}"

    def test_diagnostics_contain_weight_note(self):
        result = _calc()
        assert any("weight" in d for d in result.diagnostics)

    def test_diagnostics_contain_calculation_only(self):
        result = _calc()
        assert any("calculation-only" in d for d in result.diagnostics)

    def test_diagnostics_not_empty(self):
        assert len(_calc().diagnostics) > 0

    def test_cap_diagnostic_when_capped(self):
        result = _calc(sizing_multiplier_cap=0.2, exposure_multiplier=2.0,
                       committee_confidence=1.0, behavioral_score=0.0)
        assert any("capped" in d for d in result.diagnostics)
