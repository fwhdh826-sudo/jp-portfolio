"""
test_opportunity_loss_calc.py — Card B
OpportunityLossCalculator のユニットテスト。

テスト方針:
  - stdlib-only（math / ast / json / pathlib / re / dataclasses）+ pytest
  - import numpy / scipy / pandas 禁止
  - 禁止フィールド / 禁止語の absence assertion を含める
  - dataclass frozen / to_dict() JSON serializable を検証
  - edge cases:
    - empty PFs
    - missing ticker
    - invalid / negative weight
    - empty expected_return_by_ticker
    - unknown regime
    - 非 dict 入力

設計原則:
  - 禁止判定語（BUY/SELL/HOLD/WAIT）は absence assertion 用の定数として
    のみ宣言し、出力には現れないことを assert する
  - 禁止フィールド名は absence assertion 用の定数として宣言する
"""
from __future__ import annotations

import ast
import json
import math
import re
from dataclasses import fields
from pathlib import Path

import pytest

from engine.frontier.opportunity_loss_calc import (
    OpportunityLossCalculator,
    OpportunityLossInput,
    OpportunityLossResult,
)


# ── 禁止フィールド / 禁止語の検証用定数（absence assertion 用） ────────────────

_FORBIDDEN_FIELD_NAMES: frozenset = frozenset({
    "action", "recommendation", "is_buy", "is_sell", "is_hold",
    "is_recommended", "verdict", "decision", "approve", "reject",
    "conditional", "rating", "rebalance_order", "buy_amount",
    "sell_amount", "shares", "quantity",
    "final_verdict", "order", "amount", "entry_price",
    "stop_loss", "take_profit",
})

_FORBIDDEN_DECISION_TOKENS_UPPER: tuple = ("BUY", "SELL", "WAIT")
_FORBIDDEN_DECISION_HOLD_PATTERN = re.compile(r"\bHOLD\b")
_FORBIDDEN_TIMING_TOKENS_JA: tuple = ("予測", "予想", "タイミング", "今すぐ", "次に買う")


# ── fixture helpers ───────────────────────────────────────────────────────────


def _basic_input(
    current_pf=None,
    ideal_pf=None,
    constrained_ideal_pf=None,
    expected_return_by_ticker=None,
    expected_vol: float = 0.15,
    sharpe_ratio: float = 0.50,
    regime: str = "bull_calm",
) -> OpportunityLossInput:
    if current_pf is None:
        current_pf = {"A": 0.50, "B": 0.30, "C": 0.20}
    if ideal_pf is None:
        ideal_pf = {"A": 0.40, "B": 0.40, "C": 0.20}
    if constrained_ideal_pf is None:
        constrained_ideal_pf = {"A": 0.45, "B": 0.35, "C": 0.20}
    if expected_return_by_ticker is None:
        expected_return_by_ticker = {"A": 0.10, "B": 0.08, "C": 0.05}
    return OpportunityLossInput(
        current_pf=current_pf,
        ideal_pf=ideal_pf,
        constrained_ideal_pf=constrained_ideal_pf,
        expected_return_by_ticker=expected_return_by_ticker,
        expected_vol=expected_vol,
        sharpe_ratio=sharpe_ratio,
        regime=regime,
    )


def _calc() -> OpportunityLossCalculator:
    return OpportunityLossCalculator()


# ── CLASS 1: TestOpportunityLossInputContract ────────────────────────────────


class TestOpportunityLossInputContract:
    def test_is_frozen(self):
        inp = _basic_input()
        with pytest.raises(Exception):
            inp.regime = "bear"  # type: ignore

    def test_required_fields_exist(self):
        inp = _basic_input()
        for fname in (
            "current_pf", "ideal_pf", "constrained_ideal_pf",
            "expected_return_by_ticker",
            "expected_vol", "sharpe_ratio", "regime", "context",
        ):
            assert hasattr(inp, fname)

    def test_default_values(self):
        inp = OpportunityLossInput(
            current_pf={"A": 1.0},
            ideal_pf={"A": 1.0},
            constrained_ideal_pf={"A": 1.0},
            expected_return_by_ticker={"A": 0.05},
        )
        assert inp.expected_vol == 0.0
        assert inp.sharpe_ratio == 0.0
        assert inp.regime == "uncertain"
        assert inp.context == {}

    def test_non_dict_current_pf_falls_back_to_empty(self):
        inp = OpportunityLossInput(
            current_pf="not_a_dict",  # type: ignore
            ideal_pf={"A": 1.0},
            constrained_ideal_pf={"A": 1.0},
            expected_return_by_ticker={},
        )
        assert inp.current_pf == {}

    def test_non_dict_ideal_pf_falls_back_to_empty(self):
        inp = OpportunityLossInput(
            current_pf={"A": 1.0},
            ideal_pf=None,  # type: ignore
            constrained_ideal_pf={"A": 1.0},
            expected_return_by_ticker={},
        )
        assert inp.ideal_pf == {}

    def test_non_dict_context_falls_back_to_empty(self):
        inp = OpportunityLossInput(
            current_pf={"A": 1.0},
            ideal_pf={"A": 1.0},
            constrained_ideal_pf={"A": 1.0},
            expected_return_by_ticker={},
            context=123,  # type: ignore
        )
        assert inp.context == {}

    def test_context_default_factory_independence(self):
        inp1 = _basic_input()
        inp2 = _basic_input()
        assert inp1.context is not inp2.context

    def test_no_forbidden_fields_on_input_dataclass(self):
        field_names = {f.name for f in fields(OpportunityLossInput)}
        for forbidden in _FORBIDDEN_FIELD_NAMES:
            assert forbidden not in field_names


# ── CLASS 2: TestOpportunityLossResultContract ───────────────────────────────


class TestOpportunityLossResultContract:
    def test_is_frozen(self):
        res = _calc().calculate(_basic_input())
        with pytest.raises(Exception):
            res.regime_used = "bear"  # type: ignore

    def test_all_result_fields_exist(self):
        res = _calc().calculate(_basic_input())
        for fname in (
            "weight_drift_per_ticker",
            "total_drift_l1", "total_drift_l2",
            "constraint_return_gap", "drift_return_gap",
            "estimated_opportunity_return_gap",
            "regime_used", "diagnostics",
        ):
            assert hasattr(res, fname)

    def test_to_dict_is_json_serializable(self):
        res = _calc().calculate(_basic_input())
        as_dict = res.to_dict()
        s = json.dumps(as_dict)
        assert isinstance(s, str)

    def test_to_dict_weight_drift_is_list_of_pairs(self):
        res = _calc().calculate(_basic_input())
        as_dict = res.to_dict()
        assert isinstance(as_dict["weight_drift_per_ticker"], list)
        for entry in as_dict["weight_drift_per_ticker"]:
            assert isinstance(entry, list)
            assert len(entry) == 2
            assert isinstance(entry[0], str)
            assert isinstance(entry[1], float)

    def test_weight_drift_is_tuple_of_2tuples(self):
        res = _calc().calculate(_basic_input())
        assert isinstance(res.weight_drift_per_ticker, tuple)
        for entry in res.weight_drift_per_ticker:
            assert isinstance(entry, tuple)
            assert len(entry) == 2

    def test_total_drift_l1_is_nonnegative_float(self):
        res = _calc().calculate(_basic_input())
        assert isinstance(res.total_drift_l1, float)
        assert res.total_drift_l1 >= 0.0

    def test_total_drift_l2_is_nonnegative_float(self):
        res = _calc().calculate(_basic_input())
        assert isinstance(res.total_drift_l2, float)
        assert res.total_drift_l2 >= 0.0

    def test_return_gaps_are_float(self):
        res = _calc().calculate(_basic_input())
        assert isinstance(res.constraint_return_gap, float)
        assert isinstance(res.drift_return_gap, float)
        assert isinstance(res.estimated_opportunity_return_gap, float)

    def test_diagnostics_is_tuple_of_strings(self):
        res = _calc().calculate(_basic_input())
        assert isinstance(res.diagnostics, tuple)
        for d in res.diagnostics:
            assert isinstance(d, str)


# ── CLASS 3: TestWeightDriftCalculation ──────────────────────────────────────


class TestWeightDriftCalculation:
    def test_drift_equals_current_minus_constrained(self):
        inp = _basic_input(
            current_pf={"A": 0.6},
            ideal_pf={"A": 0.4},
            constrained_ideal_pf={"A": 0.4},
            expected_return_by_ticker={},
        )
        res = _calc().calculate(inp)
        drifts = dict(res.weight_drift_per_ticker)
        assert abs(drifts["A"] - 0.2) < 1e-9

    def test_missing_ticker_treated_as_zero(self):
        inp = _basic_input(
            current_pf={"A": 0.6},
            ideal_pf={"A": 0.4, "B": 0.6},
            constrained_ideal_pf={"A": 0.4},
            expected_return_by_ticker={},
        )
        res = _calc().calculate(inp)
        drifts = dict(res.weight_drift_per_ticker)
        # B は current に存在しないので current[B]=0 - constrained[B]=0 = 0
        assert "B" in drifts
        assert drifts["B"] == 0.0

    def test_union_includes_all_tickers(self):
        inp = _basic_input(
            current_pf={"A": 0.5, "B": 0.5},
            ideal_pf={"B": 0.5, "C": 0.5},
            constrained_ideal_pf={"D": 1.0},
            expected_return_by_ticker={},
        )
        res = _calc().calculate(inp)
        drifts = dict(res.weight_drift_per_ticker)
        assert set(drifts.keys()) == {"A", "B", "C", "D"}

    def test_l1_equals_sum_abs(self):
        inp = _basic_input(
            current_pf={"A": 0.6, "B": 0.4},
            ideal_pf={"A": 0.4, "B": 0.6},
            constrained_ideal_pf={"A": 0.4, "B": 0.6},
            expected_return_by_ticker={},
        )
        res = _calc().calculate(inp)
        # drift A = 0.2, B = -0.2
        assert abs(res.total_drift_l1 - 0.4) < 1e-9

    def test_l2_equals_sqrt_sum_squares(self):
        inp = _basic_input(
            current_pf={"A": 0.6, "B": 0.4},
            ideal_pf={"A": 0.4, "B": 0.6},
            constrained_ideal_pf={"A": 0.4, "B": 0.6},
            expected_return_by_ticker={},
        )
        res = _calc().calculate(inp)
        expected = math.sqrt(0.2 ** 2 + 0.2 ** 2)
        assert abs(res.total_drift_l2 - expected) < 1e-9

    def test_sort_order_abs_desc_then_ticker_asc(self):
        # binary-exact fractions to avoid float precision ties
        inp = _basic_input(
            current_pf={"A": 0.125, "B": 0.625, "C": 0.500},
            ideal_pf={"A": 0.250, "B": 0.250, "C": 0.250},
            constrained_ideal_pf={"A": 0.250, "B": 0.250, "C": 0.375},
            expected_return_by_ticker={},
        )
        res = _calc().calculate(inp)
        # drifts (exact):
        #   A = 0.125 - 0.250 = -0.125, abs = 0.125
        #   B = 0.625 - 0.250 = +0.375, abs = 0.375
        #   C = 0.500 - 0.375 = +0.125, abs = 0.125
        # sort: B (0.375), then ties A/C resolved by ticker asc → A, C
        tickers_in_order = [t for t, _ in res.weight_drift_per_ticker]
        assert tickers_in_order == ["B", "A", "C"]

    def test_all_pfs_identical_drift_zero(self):
        inp = _basic_input(
            current_pf={"A": 0.5, "B": 0.5},
            ideal_pf={"A": 0.5, "B": 0.5},
            constrained_ideal_pf={"A": 0.5, "B": 0.5},
            expected_return_by_ticker={},
        )
        res = _calc().calculate(inp)
        assert res.total_drift_l1 == 0.0
        assert res.total_drift_l2 == 0.0

    def test_empty_current_drift_all_negative_or_zero(self):
        inp = _basic_input(
            current_pf={},
            ideal_pf={"A": 0.5},
            constrained_ideal_pf={"A": 0.6},
            expected_return_by_ticker={},
        )
        res = _calc().calculate(inp)
        for _, drift in res.weight_drift_per_ticker:
            assert drift <= 0.0

    def test_empty_constrained_drift_all_positive_or_zero(self):
        inp = _basic_input(
            current_pf={"A": 0.5},
            ideal_pf={"A": 0.5},
            constrained_ideal_pf={},
            expected_return_by_ticker={},
        )
        res = _calc().calculate(inp)
        for _, drift in res.weight_drift_per_ticker:
            assert drift >= 0.0

    def test_input_dicts_not_mutated(self):
        cur = {"A": 0.5}
        ide = {"A": 0.4}
        con = {"A": 0.45}
        cur_copy = dict(cur)
        ide_copy = dict(ide)
        con_copy = dict(con)
        inp = _basic_input(
            current_pf=cur,
            ideal_pf=ide,
            constrained_ideal_pf=con,
            expected_return_by_ticker={"A": 0.1},
        )
        _calc().calculate(inp)
        assert cur == cur_copy
        assert ide == ide_copy
        assert con == con_copy


# ── CLASS 4: TestConstraintReturnGap ─────────────────────────────────────────


class TestConstraintReturnGap:
    def test_gap_equals_ideal_minus_constrained_return(self):
        inp = _basic_input(
            current_pf={"A": 0.5, "B": 0.5},
            ideal_pf={"A": 1.0, "B": 0.0},
            constrained_ideal_pf={"A": 0.5, "B": 0.5},
            expected_return_by_ticker={"A": 0.10, "B": 0.05},
        )
        res = _calc().calculate(inp)
        # return(ideal) = 1.0 * 0.10 + 0 * 0.05 = 0.10
        # return(constrained) = 0.5 * 0.10 + 0.5 * 0.05 = 0.075
        # gap = 0.10 - 0.075 = 0.025
        assert abs(res.constraint_return_gap - 0.025) < 1e-9

    def test_zero_gap_when_ideal_equals_constrained(self):
        inp = _basic_input(
            current_pf={"A": 0.5},
            ideal_pf={"A": 0.5},
            constrained_ideal_pf={"A": 0.5},
            expected_return_by_ticker={"A": 0.1},
        )
        res = _calc().calculate(inp)
        assert abs(res.constraint_return_gap) < 1e-9

    def test_empty_expected_return_makes_gap_zero(self):
        inp = _basic_input(
            current_pf={"A": 0.5},
            ideal_pf={"A": 0.7},
            constrained_ideal_pf={"A": 0.5},
            expected_return_by_ticker={},
        )
        res = _calc().calculate(inp)
        assert res.constraint_return_gap == 0.0

    def test_empty_expected_return_diagnostic_added(self):
        inp = _basic_input(
            current_pf={"A": 0.5},
            ideal_pf={"A": 0.5},
            constrained_ideal_pf={"A": 0.5},
            expected_return_by_ticker={},
        )
        res = _calc().calculate(inp)
        joined = " ".join(res.diagnostics)
        assert "expected_return_by_ticker is empty" in joined

    def test_missing_ticker_in_expected_return_contributes_zero(self):
        inp = _basic_input(
            current_pf={"A": 0.5, "B": 0.5},
            ideal_pf={"A": 0.5, "B": 0.5},
            constrained_ideal_pf={"A": 0.5, "B": 0.5},
            expected_return_by_ticker={"A": 0.10},  # B missing
        )
        res = _calc().calculate(inp)
        # 全 PF 同一なので gap は 0
        assert abs(res.constraint_return_gap) < 1e-9

    def test_constraint_gap_sign_positive_when_ideal_richer(self):
        inp = _basic_input(
            current_pf={"A": 0.5},
            ideal_pf={"A": 1.0},
            constrained_ideal_pf={"A": 0.5},
            expected_return_by_ticker={"A": 0.10},
        )
        res = _calc().calculate(inp)
        assert res.constraint_return_gap > 0.0

    def test_constraint_gap_sign_negative_when_constrained_richer(self):
        inp = _basic_input(
            current_pf={"A": 0.5},
            ideal_pf={"A": 0.3},
            constrained_ideal_pf={"A": 1.0},
            expected_return_by_ticker={"A": 0.10},
        )
        res = _calc().calculate(inp)
        assert res.constraint_return_gap < 0.0


# ── CLASS 5: TestDriftReturnGap ──────────────────────────────────────────────


class TestDriftReturnGap:
    def test_gap_equals_constrained_minus_current_return(self):
        inp = _basic_input(
            current_pf={"A": 0.5, "B": 0.5},
            ideal_pf={"A": 0.5, "B": 0.5},
            constrained_ideal_pf={"A": 1.0, "B": 0.0},
            expected_return_by_ticker={"A": 0.10, "B": 0.05},
        )
        res = _calc().calculate(inp)
        # return(constrained) = 1.0 * 0.10 = 0.10
        # return(current) = 0.5 * 0.10 + 0.5 * 0.05 = 0.075
        # gap = 0.10 - 0.075 = 0.025
        assert abs(res.drift_return_gap - 0.025) < 1e-9

    def test_zero_gap_when_current_equals_constrained(self):
        inp = _basic_input(
            current_pf={"A": 0.6},
            ideal_pf={"A": 0.6},
            constrained_ideal_pf={"A": 0.6},
            expected_return_by_ticker={"A": 0.1},
        )
        res = _calc().calculate(inp)
        assert abs(res.drift_return_gap) < 1e-9

    def test_empty_expected_return_makes_drift_gap_zero(self):
        inp = _basic_input(
            current_pf={"A": 0.5},
            ideal_pf={"A": 0.5},
            constrained_ideal_pf={"A": 0.7},
            expected_return_by_ticker={},
        )
        res = _calc().calculate(inp)
        assert res.drift_return_gap == 0.0

    def test_drift_gap_sign_positive_when_constrained_richer(self):
        inp = _basic_input(
            current_pf={"A": 0.3},
            ideal_pf={"A": 0.5},
            constrained_ideal_pf={"A": 1.0},
            expected_return_by_ticker={"A": 0.10},
        )
        res = _calc().calculate(inp)
        assert res.drift_return_gap > 0.0

    def test_drift_gap_sign_negative_when_current_richer(self):
        inp = _basic_input(
            current_pf={"A": 1.0},
            ideal_pf={"A": 0.5},
            constrained_ideal_pf={"A": 0.5},
            expected_return_by_ticker={"A": 0.10},
        )
        res = _calc().calculate(inp)
        assert res.drift_return_gap < 0.0

    def test_drift_gap_zero_when_returns_zero(self):
        inp = _basic_input(
            current_pf={"A": 0.5, "B": 0.5},
            ideal_pf={"A": 0.5, "B": 0.5},
            constrained_ideal_pf={"A": 0.3, "B": 0.7},
            expected_return_by_ticker={"A": 0.0, "B": 0.0},
        )
        res = _calc().calculate(inp)
        assert abs(res.drift_return_gap) < 1e-9


# ── CLASS 6: TestEstimatedOpportunityReturnGap ───────────────────────────────


class TestEstimatedOpportunityReturnGap:
    def test_equals_drift_return_gap(self):
        inp = _basic_input()
        res = _calc().calculate(inp)
        assert res.estimated_opportunity_return_gap == res.drift_return_gap

    def test_sign_preserved_negative_case(self):
        inp = _basic_input(
            current_pf={"A": 1.0},
            ideal_pf={"A": 0.5},
            constrained_ideal_pf={"A": 0.5},
            expected_return_by_ticker={"A": 0.10},
        )
        res = _calc().calculate(inp)
        # current > constrained → drift_gap < 0 → opp_gap < 0
        assert res.estimated_opportunity_return_gap < 0.0

    def test_sign_preserved_positive_case(self):
        inp = _basic_input(
            current_pf={"A": 0.3},
            ideal_pf={"A": 0.5},
            constrained_ideal_pf={"A": 0.8},
            expected_return_by_ticker={"A": 0.10},
        )
        res = _calc().calculate(inp)
        # constrained > current → drift_gap > 0 → opp_gap > 0
        assert res.estimated_opportunity_return_gap > 0.0

    def test_not_clamped_to_nonnegative(self):
        inp = _basic_input(
            current_pf={"A": 1.0},
            ideal_pf={"A": 0.5},
            constrained_ideal_pf={"A": 0.5},
            expected_return_by_ticker={"A": 0.10},
        )
        res = _calc().calculate(inp)
        assert res.estimated_opportunity_return_gap < 0.0

    def test_zero_when_empty_returns(self):
        inp = _basic_input(
            current_pf={"A": 0.5},
            ideal_pf={"A": 0.5},
            constrained_ideal_pf={"A": 0.5},
            expected_return_by_ticker={},
        )
        res = _calc().calculate(inp)
        assert res.estimated_opportunity_return_gap == 0.0


# ── CLASS 7: TestRegimeFallback ──────────────────────────────────────────────


class TestRegimeFallback:
    def test_empty_regime_falls_back_to_uncertain(self):
        inp = OpportunityLossInput(
            current_pf={"A": 1.0},
            ideal_pf={"A": 1.0},
            constrained_ideal_pf={"A": 1.0},
            expected_return_by_ticker={"A": 0.1},
            regime="",
        )
        assert inp.regime == "uncertain"
        res = _calc().calculate(inp)
        assert res.regime_used == "uncertain"

    def test_unknown_regime_preserved_in_result(self):
        inp = OpportunityLossInput(
            current_pf={"A": 1.0},
            ideal_pf={"A": 1.0},
            constrained_ideal_pf={"A": 1.0},
            expected_return_by_ticker={"A": 0.1},
            regime="some_unknown_regime",
        )
        res = _calc().calculate(inp)
        assert res.regime_used == "some_unknown_regime"

    def test_known_regime_preserved(self):
        for regime in ("bull_calm", "bull_volatile", "bear", "crisis", "uncertain"):
            res = _calc().calculate(_basic_input(regime=regime))
            assert res.regime_used == regime


# ── CLASS 8: TestMandatoryDisclaimers ────────────────────────────────────────


class TestMandatoryDisclaimers:
    def test_calculation_only_disclaimer_present(self):
        res = _calc().calculate(_basic_input())
        joined = " ".join(res.diagnostics)
        assert "calculation-only estimates" in joined

    def test_not_an_order_disclaimer_present(self):
        res = _calc().calculate(_basic_input())
        joined = " ".join(res.diagnostics)
        assert "not an order, not a recommendation" in joined

    def test_comparative_estimates_disclaimer_present(self):
        res = _calc().calculate(_basic_input())
        joined = " ".join(res.diagnostics)
        assert "comparative estimates, not realized losses" in joined

    def test_all_diagnostics_use_observation_prefix(self):
        res = _calc().calculate(_basic_input())
        for diag in res.diagnostics:
            assert diag.startswith("observation: "), (
                f"diagnostic lacks 'observation: ' prefix: {diag!r}"
            )

    def test_disclaimers_present_even_with_empty_pfs(self):
        inp = OpportunityLossInput(
            current_pf={},
            ideal_pf={},
            constrained_ideal_pf={},
            expected_return_by_ticker={},
        )
        res = _calc().calculate(inp)
        joined = " ".join(res.diagnostics)
        assert "calculation-only estimates" in joined
        assert "not an order, not a recommendation" in joined
        assert "comparative estimates, not realized losses" in joined


# ── CLASS 9: TestEdgeCases ───────────────────────────────────────────────────


class TestEdgeCases:
    def test_empty_current_pf(self):
        inp = OpportunityLossInput(
            current_pf={},
            ideal_pf={"A": 1.0},
            constrained_ideal_pf={"A": 1.0},
            expected_return_by_ticker={"A": 0.1},
        )
        res = _calc().calculate(inp)
        joined = " ".join(res.diagnostics)
        assert "current_pf is empty" in joined

    def test_empty_ideal_pf(self):
        inp = OpportunityLossInput(
            current_pf={"A": 1.0},
            ideal_pf={},
            constrained_ideal_pf={"A": 1.0},
            expected_return_by_ticker={"A": 0.1},
        )
        res = _calc().calculate(inp)
        joined = " ".join(res.diagnostics)
        assert "ideal_pf is empty" in joined

    def test_empty_constrained_ideal_pf(self):
        inp = OpportunityLossInput(
            current_pf={"A": 1.0},
            ideal_pf={"A": 1.0},
            constrained_ideal_pf={},
            expected_return_by_ticker={"A": 0.1},
        )
        res = _calc().calculate(inp)
        joined = " ".join(res.diagnostics)
        assert "constrained_ideal_pf is empty" in joined

    def test_all_empty_pfs(self):
        inp = OpportunityLossInput(
            current_pf={},
            ideal_pf={},
            constrained_ideal_pf={},
            expected_return_by_ticker={},
        )
        res = _calc().calculate(inp)
        assert res.weight_drift_per_ticker == ()
        assert res.total_drift_l1 == 0.0
        assert res.total_drift_l2 == 0.0
        assert res.constraint_return_gap == 0.0
        assert res.drift_return_gap == 0.0
        assert res.estimated_opportunity_return_gap == 0.0

    def test_negative_weights_clamped_to_zero(self):
        inp = OpportunityLossInput(
            current_pf={"A": -0.5, "B": 1.5},
            ideal_pf={"A": 0.5, "B": 0.5},
            constrained_ideal_pf={"A": 0.5, "B": 0.5},
            expected_return_by_ticker={"A": 0.1, "B": 0.05},
        )
        res = _calc().calculate(inp)
        # A weight clamped to 0, drift A = 0 - 0.5 = -0.5
        drifts = dict(res.weight_drift_per_ticker)
        assert drifts["A"] == -0.5

    def test_nan_weight_treated_as_zero(self):
        inp = OpportunityLossInput(
            current_pf={"A": float("nan")},
            ideal_pf={"A": 0.5},
            constrained_ideal_pf={"A": 0.5},
            expected_return_by_ticker={"A": 0.1},
        )
        res = _calc().calculate(inp)
        drifts = dict(res.weight_drift_per_ticker)
        # nan → 0, drift = 0 - 0.5 = -0.5
        assert drifts["A"] == -0.5

    def test_inf_weight_treated_as_zero(self):
        inp = OpportunityLossInput(
            current_pf={"A": float("inf")},
            ideal_pf={"A": 0.5},
            constrained_ideal_pf={"A": 0.5},
            expected_return_by_ticker={"A": 0.1},
        )
        res = _calc().calculate(inp)
        drifts = dict(res.weight_drift_per_ticker)
        assert drifts["A"] == -0.5

    def test_string_weight_treated_as_zero(self):
        inp = OpportunityLossInput(
            current_pf={"A": "bad"},  # type: ignore
            ideal_pf={"A": 0.5},
            constrained_ideal_pf={"A": 0.5},
            expected_return_by_ticker={"A": 0.1},
        )
        res = _calc().calculate(inp)
        drifts = dict(res.weight_drift_per_ticker)
        assert drifts["A"] == -0.5

    def test_single_ticker_universe(self):
        inp = OpportunityLossInput(
            current_pf={"X": 1.0},
            ideal_pf={"X": 1.0},
            constrained_ideal_pf={"X": 1.0},
            expected_return_by_ticker={"X": 0.08},
        )
        res = _calc().calculate(inp)
        assert len(res.weight_drift_per_ticker) == 1
        assert res.weight_drift_per_ticker[0][0] == "X"
        assert res.weight_drift_per_ticker[0][1] == 0.0

    def test_large_universe(self):
        n = 50
        pf = {f"T{i:03d}": 1.0 / n for i in range(n)}
        inp = OpportunityLossInput(
            current_pf=pf,
            ideal_pf=pf,
            constrained_ideal_pf=pf,
            expected_return_by_ticker={f"T{i:03d}": 0.05 for i in range(n)},
        )
        res = _calc().calculate(inp)
        assert len(res.weight_drift_per_ticker) == n
        assert res.total_drift_l1 == 0.0


# ── CLASS 10: TestForbiddenFieldsAbsent ──────────────────────────────────────


class TestForbiddenFieldsAbsent:
    def test_input_dataclass_has_no_forbidden_fields(self):
        field_names = {f.name for f in fields(OpportunityLossInput)}
        for forbidden in _FORBIDDEN_FIELD_NAMES:
            assert forbidden not in field_names

    def test_result_dataclass_has_no_forbidden_fields(self):
        field_names = {f.name for f in fields(OpportunityLossResult)}
        for forbidden in _FORBIDDEN_FIELD_NAMES:
            assert forbidden not in field_names

    def test_to_dict_keys_have_no_forbidden_names(self):
        res = _calc().calculate(_basic_input())
        as_dict = res.to_dict()
        for key in as_dict.keys():
            for forbidden in _FORBIDDEN_FIELD_NAMES:
                assert key != forbidden

    def test_diagnostics_have_no_decision_tokens(self):
        res = _calc().calculate(_basic_input())
        for diag in res.diagnostics:
            for tok in _FORBIDDEN_DECISION_TOKENS_UPPER:
                assert tok not in diag, (
                    f"Forbidden token '{tok}' in diagnostic: {diag!r}"
                )

    def test_diagnostics_have_no_HOLD_as_word(self):
        res = _calc().calculate(_basic_input())
        for diag in res.diagnostics:
            assert not _FORBIDDEN_DECISION_HOLD_PATTERN.search(diag)

    def test_diagnostics_have_no_japanese_timing_tokens(self):
        res = _calc().calculate(_basic_input())
        for diag in res.diagnostics:
            for tok in _FORBIDDEN_TIMING_TOKENS_JA:
                assert tok not in diag, (
                    f"Forbidden timing token '{tok}' in diagnostic: {diag!r}"
                )


# ── CLASS 11: TestStaticImportConstraints ────────────────────────────────────


class TestStaticImportConstraints:
    """テストファイル / 実装モジュールに numpy / scipy / pandas import がない。"""

    @staticmethod
    def _top_level_imports_of_test() -> set:
        source = Path(__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        names: set = set()
        for node in tree.body:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    names.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                if node.module is not None:
                    names.add(node.module.split(".")[0])
        return names

    @staticmethod
    def _top_level_imports_of_module() -> set:
        module_path = (
            Path(__file__).parent.parent.parent
            / "engine" / "frontier" / "opportunity_loss_calc.py"
        )
        source = module_path.read_text(encoding="utf-8")
        tree = ast.parse(source)
        names: set = set()
        for node in tree.body:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    names.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                if node.module is not None:
                    names.add(node.module.split(".")[0])
        return names

    def test_test_file_no_numpy(self):
        assert "numpy" not in self._top_level_imports_of_test()

    def test_test_file_no_scipy(self):
        assert "scipy" not in self._top_level_imports_of_test()

    def test_test_file_no_pandas(self):
        assert "pandas" not in self._top_level_imports_of_test()

    def test_module_no_numpy(self):
        assert "numpy" not in self._top_level_imports_of_module()

    def test_module_no_scipy(self):
        assert "scipy" not in self._top_level_imports_of_module()

    def test_module_no_pandas(self):
        assert "pandas" not in self._top_level_imports_of_module()
