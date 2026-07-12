"""
test_future_branching.py — Card B
FutureBranchingCalculator のユニットテスト。

テスト方針:
  - stdlib-only（math / ast / json / pathlib / re / dataclasses）+ pytest
  - import numpy / scipy / pandas 禁止
  - 禁止フィールド / 禁止語 / 予言・タイミング文言の absence assertion
  - dataclass frozen / to_dict() JSON serializable を検証
  - edge cases:
    - empty regime maps
    - missing regime
    - unknown base_regime
    - invalid z_score
    - probability missing / partial / sum != 1 / negative / NaN / non-dict
    - vol = 0

設計原則:
  - 禁止判定語（BUY/SELL/HOLD/WAIT）と日本語予言文言（予測/予想/タイミング/今すぐ/
    次に買う）は absence assertion 用の定数として宣言。出力に現れないことを assert。
  - 禁止フィールド名も absence assertion 用に宣言。
"""
from __future__ import annotations

import ast
import json
import math
import re
from dataclasses import fields
from pathlib import Path

import pytest

from engine.frontier.future_branching import (
    CANONICAL_REGIMES,
    FutureBranch,
    FutureBranchingCalculator,
    FutureBranchingInput,
    FutureBranchingResult,
)


# ── 禁止フィールド / 禁止語の検証用定数（absence assertion 用） ────────────────

_FORBIDDEN_FIELD_NAMES: frozenset = frozenset({
    "action", "recommendation", "is_buy", "is_sell", "is_hold",
    "is_recommended", "verdict", "decision", "approve", "reject",
    "conditional", "rating", "rebalance_order", "buy_amount",
    "sell_amount", "shares", "quantity",
    "final_verdict", "order", "amount", "entry_price",
    "stop_loss", "take_profit",
    "timing", "forecast", "prediction", "signal",
})

_FORBIDDEN_DECISION_TOKENS_UPPER: tuple = ("BUY", "SELL", "WAIT")
_FORBIDDEN_DECISION_HOLD_PATTERN = re.compile(r"\bHOLD\b")
_FORBIDDEN_TIMING_TOKENS_JA: tuple = ("予測", "予想", "タイミング", "今すぐ", "次に買う", "買うべき", "売るべき")


# ── fixture helpers ───────────────────────────────────────────────────────────


_FULL_REGIME_RETURNS: dict = {
    "bull_calm":     0.090,
    "bull_volatile": 0.070,
    "bear":          0.030,
    "crisis":        0.010,
    "uncertain":     0.060,
}

_FULL_REGIME_VOLS: dict = {
    "bull_calm":     0.120,
    "bull_volatile": 0.180,
    "bear":          0.200,
    "crisis":        0.300,
    "uncertain":     0.150,
}

_FULL_REGIME_DDS: dict = {
    "bull_calm":     -0.08,
    "bull_volatile": -0.15,
    "bear":          -0.20,
    "crisis":        -0.35,
    "uncertain":     -0.12,
}


def _basic_input(
    pf_weights=None,
    base_regime: str = "bull_calm",
    regime_expected_returns=None,
    regime_expected_vols=None,
    regime_max_dds=None,
    regime_probabilities=None,
    downside_z_score: float = 2.0,
    horizon: str = "long_term",
) -> FutureBranchingInput:
    if pf_weights is None:
        pf_weights = {"A": 0.5, "B": 0.5}
    if regime_expected_returns is None:
        regime_expected_returns = dict(_FULL_REGIME_RETURNS)
    if regime_expected_vols is None:
        regime_expected_vols = dict(_FULL_REGIME_VOLS)
    if regime_max_dds is None:
        regime_max_dds = dict(_FULL_REGIME_DDS)
    if regime_probabilities is None:
        regime_probabilities = {r: 1.0 / 5 for r in CANONICAL_REGIMES}
    return FutureBranchingInput(
        pf_weights=pf_weights,
        base_regime=base_regime,
        regime_expected_returns=regime_expected_returns,
        regime_expected_vols=regime_expected_vols,
        regime_max_dds=regime_max_dds,
        regime_probabilities=regime_probabilities,
        downside_z_score=downside_z_score,
        horizon=horizon,
    )


def _calc() -> FutureBranchingCalculator:
    return FutureBranchingCalculator()


# ── CLASS 1: TestFutureBranchingInputContract ────────────────────────────────


class TestFutureBranchingInputContract:
    def test_is_frozen(self):
        inp = _basic_input()
        with pytest.raises(Exception):
            inp.base_regime = "bear"  # type: ignore

    def test_required_fields_exist(self):
        inp = _basic_input()
        for fname in (
            "pf_weights", "base_regime",
            "regime_expected_returns", "regime_expected_vols", "regime_max_dds",
            "regime_probabilities",
            "downside_z_score", "horizon", "context",
        ):
            assert hasattr(inp, fname)

    def test_default_values(self):
        inp = FutureBranchingInput(pf_weights={"A": 1.0})
        assert inp.base_regime == "uncertain"
        assert inp.regime_expected_returns == {}
        assert inp.regime_expected_vols == {}
        assert inp.regime_max_dds == {}
        assert inp.regime_probabilities == {}
        assert inp.downside_z_score == 2.0
        assert inp.horizon == "long_term"
        assert inp.context == {}

    def test_non_dict_pf_weights_falls_back_to_empty(self):
        inp = FutureBranchingInput(pf_weights="not_a_dict")  # type: ignore
        assert inp.pf_weights == {}

    def test_non_dict_regime_returns_falls_back_to_empty(self):
        inp = FutureBranchingInput(
            pf_weights={"A": 1.0},
            regime_expected_returns=None,  # type: ignore
        )
        assert inp.regime_expected_returns == {}

    def test_non_dict_context_falls_back_to_empty(self):
        inp = FutureBranchingInput(pf_weights={"A": 1.0}, context=123)  # type: ignore
        assert inp.context == {}

    def test_context_default_factory_independence(self):
        inp1 = _basic_input()
        inp2 = _basic_input()
        assert inp1.context is not inp2.context

    def test_no_forbidden_fields_on_input_dataclass(self):
        field_names = {f.name for f in fields(FutureBranchingInput)}
        for forbidden in _FORBIDDEN_FIELD_NAMES:
            assert forbidden not in field_names


# ── CLASS 2: TestFutureBranchContract ────────────────────────────────────────


class TestFutureBranchContract:
    def test_is_frozen(self):
        b = FutureBranch(
            regime="bull_calm",
            expected_return=0.09,
            expected_vol=0.12,
            sharpe_ratio=0.75,
            max_dd_estimate=-0.08,
            downside_case=-0.15,
            upside_case=0.33,
            probability=0.2,
            is_base_regime=True,
        )
        with pytest.raises(Exception):
            b.regime = "bear"  # type: ignore

    def test_all_fields_exist(self):
        b = FutureBranch(
            regime="bull_calm", expected_return=0.09, expected_vol=0.12,
            sharpe_ratio=0.75, max_dd_estimate=-0.08,
            downside_case=-0.15, upside_case=0.33,
            probability=0.2, is_base_regime=True,
        )
        for fname in (
            "regime", "expected_return", "expected_vol", "sharpe_ratio",
            "max_dd_estimate", "downside_case", "upside_case",
            "probability", "is_base_regime",
        ):
            assert hasattr(b, fname)

    def test_expected_vol_clamped_nonneg(self):
        b = FutureBranch(
            regime="bull_calm", expected_return=0.09, expected_vol=-0.10,
            sharpe_ratio=0.0, max_dd_estimate=-0.08,
            downside_case=0.0, upside_case=0.0,
            probability=0.2, is_base_regime=False,
        )
        assert b.expected_vol == 0.0

    def test_max_dd_clamped_nonpos(self):
        b = FutureBranch(
            regime="bull_calm", expected_return=0.09, expected_vol=0.10,
            sharpe_ratio=0.0, max_dd_estimate=0.10,
            downside_case=0.0, upside_case=0.0,
            probability=0.2, is_base_regime=False,
        )
        assert b.max_dd_estimate == 0.0

    def test_probability_clamped_to_unit_interval(self):
        b_high = FutureBranch(
            regime="bull_calm", expected_return=0.0, expected_vol=0.0,
            sharpe_ratio=0.0, max_dd_estimate=0.0,
            downside_case=0.0, upside_case=0.0,
            probability=1.5, is_base_regime=False,
        )
        assert b_high.probability == 1.0
        b_low = FutureBranch(
            regime="bull_calm", expected_return=0.0, expected_vol=0.0,
            sharpe_ratio=0.0, max_dd_estimate=0.0,
            downside_case=0.0, upside_case=0.0,
            probability=-0.5, is_base_regime=False,
        )
        assert b_low.probability == 0.0

    def test_nan_inputs_fall_back_to_zero(self):
        b = FutureBranch(
            regime="bull_calm", expected_return=float("nan"),
            expected_vol=float("nan"), sharpe_ratio=float("nan"),
            max_dd_estimate=float("nan"), downside_case=float("nan"),
            upside_case=float("nan"), probability=float("nan"),
            is_base_regime=False,
        )
        assert b.expected_return == 0.0
        assert b.expected_vol == 0.0
        assert b.sharpe_ratio == 0.0
        assert b.max_dd_estimate == 0.0

    def test_to_dict_is_json_serializable(self):
        b = FutureBranch(
            regime="bull_calm", expected_return=0.09, expected_vol=0.12,
            sharpe_ratio=0.75, max_dd_estimate=-0.08,
            downside_case=-0.15, upside_case=0.33,
            probability=0.2, is_base_regime=True,
        )
        s = json.dumps(b.to_dict())
        assert isinstance(s, str)

    def test_no_forbidden_fields_on_branch_dataclass(self):
        field_names = {f.name for f in fields(FutureBranch)}
        for forbidden in _FORBIDDEN_FIELD_NAMES:
            assert forbidden not in field_names


# ── CLASS 3: TestFutureBranchingResultContract ───────────────────────────────


class TestFutureBranchingResultContract:
    def test_is_frozen(self):
        res = _calc().calculate(_basic_input())
        with pytest.raises(Exception):
            res.base_regime = "bear"  # type: ignore

    def test_all_fields_exist(self):
        res = _calc().calculate(_basic_input())
        for fname in (
            "branches", "base_regime",
            "weighted_expected_return", "weighted_expected_vol",
            "worst_case_dd", "worst_case_downside", "best_case_upside",
            "diagnostics",
        ):
            assert hasattr(res, fname)

    def test_branches_is_tuple(self):
        res = _calc().calculate(_basic_input())
        assert isinstance(res.branches, tuple)

    def test_branches_length_is_5(self):
        res = _calc().calculate(_basic_input())
        assert len(res.branches) == 5

    def test_to_dict_is_json_serializable(self):
        res = _calc().calculate(_basic_input())
        s = json.dumps(res.to_dict())
        assert isinstance(s, str)

    def test_to_dict_branches_is_list_of_dicts(self):
        res = _calc().calculate(_basic_input())
        as_dict = res.to_dict()
        assert isinstance(as_dict["branches"], list)
        for entry in as_dict["branches"]:
            assert isinstance(entry, dict)

    def test_weighted_vol_clamped_nonneg(self):
        res = _calc().calculate(_basic_input())
        assert res.weighted_expected_vol >= 0.0

    def test_worst_case_dd_nonpos(self):
        res = _calc().calculate(_basic_input())
        assert res.worst_case_dd <= 0.0

    def test_diagnostics_is_tuple_of_strings(self):
        res = _calc().calculate(_basic_input())
        assert isinstance(res.diagnostics, tuple)
        for d in res.diagnostics:
            assert isinstance(d, str)

    def test_no_forbidden_fields_on_result_dataclass(self):
        field_names = {f.name for f in fields(FutureBranchingResult)}
        for forbidden in _FORBIDDEN_FIELD_NAMES:
            assert forbidden not in field_names


# ── CLASS 4: TestCanonicalRegimesOrder ───────────────────────────────────────


class TestCanonicalRegimesOrder:
    def test_canonical_regimes_exact_order(self):
        assert CANONICAL_REGIMES == (
            "bull_calm", "bull_volatile", "bear", "crisis", "uncertain",
        )

    def test_canonical_regimes_length_5(self):
        assert len(CANONICAL_REGIMES) == 5

    def test_branches_in_canonical_order(self):
        res = _calc().calculate(_basic_input())
        regime_order = [b.regime for b in res.branches]
        assert regime_order == list(CANONICAL_REGIMES)

    def test_is_base_regime_flag_correct(self):
        res = _calc().calculate(_basic_input(base_regime="crisis"))
        for b in res.branches:
            if b.regime == "crisis":
                assert b.is_base_regime is True
            else:
                assert b.is_base_regime is False

    def test_base_regime_preserved_in_result(self):
        for regime in CANONICAL_REGIMES:
            res = _calc().calculate(_basic_input(base_regime=regime))
            assert res.base_regime == regime

    def test_branches_each_have_canonical_regime(self):
        res = _calc().calculate(_basic_input())
        seen = {b.regime for b in res.branches}
        assert seen == set(CANONICAL_REGIMES)


# ── CLASS 5: TestRegimeMetricsExtraction ─────────────────────────────────────


class TestRegimeMetricsExtraction:
    def test_returns_extracted_from_input_map(self):
        res = _calc().calculate(_basic_input(base_regime="bull_calm"))
        for b in res.branches:
            assert b.expected_return == _FULL_REGIME_RETURNS[b.regime]

    def test_vols_extracted_from_input_map(self):
        res = _calc().calculate(_basic_input(base_regime="bull_calm"))
        for b in res.branches:
            assert b.expected_vol == _FULL_REGIME_VOLS[b.regime]

    def test_dds_extracted_from_input_map(self):
        res = _calc().calculate(_basic_input(base_regime="bull_calm"))
        for b in res.branches:
            assert b.max_dd_estimate == _FULL_REGIME_DDS[b.regime]

    def test_missing_regime_falls_back_to_base_value(self):
        partial_returns = {"bull_calm": 0.090}
        res = _calc().calculate(_basic_input(
            base_regime="bull_calm",
            regime_expected_returns=partial_returns,
        ))
        for b in res.branches:
            assert b.expected_return == 0.090

    def test_empty_returns_map_yields_zero_branch_returns(self):
        res = _calc().calculate(_basic_input(
            base_regime="bull_calm",
            regime_expected_returns={},
        ))
        for b in res.branches:
            assert b.expected_return == 0.0

    def test_vol_clamped_nonneg(self):
        res = _calc().calculate(_basic_input(
            base_regime="bull_calm",
            regime_expected_vols={r: -0.10 for r in CANONICAL_REGIMES},
        ))
        for b in res.branches:
            assert b.expected_vol == 0.0

    def test_dd_clamped_nonpos(self):
        res = _calc().calculate(_basic_input(
            base_regime="bull_calm",
            regime_max_dds={r: 0.05 for r in CANONICAL_REGIMES},
        ))
        for b in res.branches:
            assert b.max_dd_estimate == 0.0

    def test_sharpe_equals_er_over_vol(self):
        res = _calc().calculate(_basic_input(base_regime="bull_calm"))
        for b in res.branches:
            if b.expected_vol > 0.0:
                assert abs(b.sharpe_ratio - b.expected_return / b.expected_vol) < 1e-9
            else:
                assert b.sharpe_ratio == 0.0

    def test_sharpe_zero_when_vol_zero(self):
        zero_vols = {r: 0.0 for r in CANONICAL_REGIMES}
        res = _calc().calculate(_basic_input(
            base_regime="bull_calm",
            regime_expected_vols=zero_vols,
        ))
        for b in res.branches:
            assert b.sharpe_ratio == 0.0


# ── CLASS 6: TestDownsideUpsideCalculation ───────────────────────────────────


class TestDownsideUpsideCalculation:
    def test_downside_equals_er_minus_z_times_vol(self):
        res = _calc().calculate(_basic_input(downside_z_score=2.0))
        for b in res.branches:
            expected = b.expected_return - 2.0 * b.expected_vol
            assert abs(b.downside_case - expected) < 1e-9

    def test_upside_equals_er_plus_z_times_vol(self):
        res = _calc().calculate(_basic_input(downside_z_score=2.0))
        for b in res.branches:
            expected = b.expected_return + 2.0 * b.expected_vol
            assert abs(b.upside_case - expected) < 1e-9

    def test_z_default_is_2(self):
        inp = FutureBranchingInput(pf_weights={"A": 1.0})
        assert inp.downside_z_score == 2.0

    def test_z_zero_falls_back_to_2_with_diagnostic(self):
        res = _calc().calculate(_basic_input(downside_z_score=0.0))
        joined = " ".join(res.diagnostics)
        assert "downside_z_score" in joined
        for b in res.branches:
            expected_down = b.expected_return - 2.0 * b.expected_vol
            assert abs(b.downside_case - expected_down) < 1e-9

    def test_z_negative_falls_back_to_2_with_diagnostic(self):
        res = _calc().calculate(_basic_input(downside_z_score=-1.5))
        joined = " ".join(res.diagnostics)
        assert "downside_z_score" in joined
        for b in res.branches:
            expected_down = b.expected_return - 2.0 * b.expected_vol
            assert abs(b.downside_case - expected_down) < 1e-9

    def test_z_custom_value_applied(self):
        res = _calc().calculate(_basic_input(downside_z_score=1.5))
        for b in res.branches:
            expected_down = b.expected_return - 1.5 * b.expected_vol
            assert abs(b.downside_case - expected_down) < 1e-9

    def test_downside_equals_upside_when_vol_zero(self):
        zero_vols = {r: 0.0 for r in CANONICAL_REGIMES}
        res = _calc().calculate(_basic_input(regime_expected_vols=zero_vols))
        for b in res.branches:
            assert b.downside_case == b.expected_return
            assert b.upside_case == b.expected_return

    def test_downside_less_than_upside_when_vol_positive(self):
        res = _calc().calculate(_basic_input())
        for b in res.branches:
            if b.expected_vol > 0:
                assert b.downside_case < b.upside_case


# ── CLASS 7: TestProbabilityHandling ─────────────────────────────────────────


class TestProbabilityHandling:
    def test_empty_probabilities_uniform_1_5(self):
        res = _calc().calculate(_basic_input(regime_probabilities={}))
        for b in res.branches:
            assert abs(b.probability - 1.0 / 5) < 1e-9
        joined = " ".join(res.diagnostics)
        assert "regime_probabilities" in joined

    def test_non_dict_probabilities_uniform(self):
        # __post_init__ で non-dict は {} fallback、その後 uniform
        inp = FutureBranchingInput(
            pf_weights={"A": 1.0},
            regime_probabilities="not_a_dict",  # type: ignore
        )
        res = _calc().calculate(inp)
        for b in res.branches:
            assert abs(b.probability - 1.0 / 5) < 1e-9

    def test_all_zero_probabilities_uniform(self):
        zero_probs = {r: 0.0 for r in CANONICAL_REGIMES}
        res = _calc().calculate(_basic_input(regime_probabilities=zero_probs))
        for b in res.branches:
            assert abs(b.probability - 1.0 / 5) < 1e-9

    def test_partial_probabilities_normalized(self):
        partial = {"bull_calm": 0.5, "bear": 0.5}
        res = _calc().calculate(_basic_input(regime_probabilities=partial))
        probs = {b.regime: b.probability for b in res.branches}
        # bull_calm 0.5 / 1.0 = 0.5, bear 0.5 / 1.0 = 0.5, others 0
        assert abs(probs["bull_calm"] - 0.5) < 1e-9
        assert abs(probs["bear"] - 0.5) < 1e-9
        assert probs["bull_volatile"] == 0.0
        assert probs["crisis"] == 0.0
        assert probs["uncertain"] == 0.0

    def test_sum_less_than_one_normalized(self):
        partial = {r: 0.1 for r in CANONICAL_REGIMES}  # sum = 0.5
        res = _calc().calculate(_basic_input(regime_probabilities=partial))
        for b in res.branches:
            assert abs(b.probability - 1.0 / 5) < 1e-9
        joined = " ".join(res.diagnostics)
        assert "normalized" in joined

    def test_sum_greater_than_one_normalized(self):
        excess = {r: 0.3 for r in CANONICAL_REGIMES}  # sum = 1.5
        res = _calc().calculate(_basic_input(regime_probabilities=excess))
        total = sum(b.probability for b in res.branches)
        assert abs(total - 1.0) < 1e-9
        joined = " ".join(res.diagnostics)
        assert "normalized" in joined

    def test_negative_probabilities_clamped_to_zero(self):
        probs = {
            "bull_calm": -0.5, "bull_volatile": 0.5,
            "bear": -0.2, "crisis": 0.5, "uncertain": 0.0,
        }
        res = _calc().calculate(_basic_input(regime_probabilities=probs))
        m = {b.regime: b.probability for b in res.branches}
        # Negatives → 0, positives sum 1.0 → no normalization, no negatives
        assert m["bull_calm"] == 0.0
        assert m["bear"] == 0.0
        assert m["bull_volatile"] > 0.0

    def test_nan_probability_treated_as_zero(self):
        probs = {r: 0.2 for r in CANONICAL_REGIMES}
        probs["bull_calm"] = float("nan")
        res = _calc().calculate(_basic_input(regime_probabilities=probs))
        m = {b.regime: b.probability for b in res.branches}
        # NaN → 0.0, others 0.2 sum 0.8 → all rescaled
        assert m["bull_calm"] == 0.0

    def test_inf_probability_treated_as_zero(self):
        probs = {r: 0.2 for r in CANONICAL_REGIMES}
        probs["bull_calm"] = float("inf")
        res = _calc().calculate(_basic_input(regime_probabilities=probs))
        m = {b.regime: b.probability for b in res.branches}
        assert m["bull_calm"] == 0.0

    def test_string_probability_treated_as_zero(self):
        probs = {r: 0.2 for r in CANONICAL_REGIMES}
        probs["bull_calm"] = "bad"
        res = _calc().calculate(_basic_input(regime_probabilities=probs))
        m = {b.regime: b.probability for b in res.branches}
        assert m["bull_calm"] == 0.0

    def test_extra_regime_keys_ignored(self):
        probs = {r: 0.2 for r in CANONICAL_REGIMES}
        probs["unknown_regime"] = 0.5
        res = _calc().calculate(_basic_input(regime_probabilities=probs))
        # CANONICAL_REGIMES のみ反映、unknown は無視
        canonical_total = sum(b.probability for b in res.branches)
        assert abs(canonical_total - 1.0) < 1e-9

    def test_individual_prob_above_one_clamped(self):
        probs = {r: 0.0 for r in CANONICAL_REGIMES}
        probs["crisis"] = 2.5  # > 1.0
        res = _calc().calculate(_basic_input(regime_probabilities=probs))
        m = {b.regime: b.probability for b in res.branches}
        # 2.5 → 1.0, others 0.0 → crisis 1.0 / 1.0 = 1.0 after normalization
        assert m["crisis"] == 1.0


# ── CLASS 8: TestWeightedAggregation ─────────────────────────────────────────


class TestWeightedAggregation:
    def test_weighted_er_is_probability_weighted_sum(self):
        res = _calc().calculate(_basic_input())
        expected = sum(b.probability * b.expected_return for b in res.branches)
        assert abs(res.weighted_expected_return - expected) < 1e-9

    def test_weighted_vol_is_linear_weighted_sum(self):
        res = _calc().calculate(_basic_input())
        expected = sum(b.probability * b.expected_vol for b in res.branches)
        assert abs(res.weighted_expected_vol - expected) < 1e-9

    def test_worst_case_dd_is_min_across_branches(self):
        res = _calc().calculate(_basic_input())
        expected = min(b.max_dd_estimate for b in res.branches)
        assert res.worst_case_dd == expected

    def test_worst_case_downside_is_min_across_branches(self):
        res = _calc().calculate(_basic_input())
        expected = min(b.downside_case for b in res.branches)
        assert res.worst_case_downside == expected

    def test_best_case_upside_is_max_across_branches(self):
        res = _calc().calculate(_basic_input())
        expected = max(b.upside_case for b in res.branches)
        assert res.best_case_upside == expected

    def test_linear_aggregation_disclaimer_present(self):
        res = _calc().calculate(_basic_input())
        joined = " ".join(res.diagnostics)
        assert "linear aggregation" in joined

    def test_weighted_vol_clamped_nonneg(self):
        res = _calc().calculate(_basic_input())
        assert res.weighted_expected_vol >= 0.0


# ── CLASS 9: TestBaseRegimeFallback ──────────────────────────────────────────


class TestBaseRegimeFallback:
    def test_unknown_base_regime_falls_back_to_uncertain(self):
        res = _calc().calculate(_basic_input(base_regime="unknown_xyz"))
        assert res.base_regime == "uncertain"
        joined = " ".join(res.diagnostics)
        assert "base_regime" in joined
        assert "uncertain" in joined

    def test_known_base_regime_preserved(self):
        for regime in CANONICAL_REGIMES:
            res = _calc().calculate(_basic_input(base_regime=regime))
            assert res.base_regime == regime

    def test_empty_base_regime_falls_back_to_uncertain_via_post_init(self):
        # Input.__post_init__ で空文字 → "uncertain"
        inp = FutureBranchingInput(pf_weights={"A": 1.0}, base_regime="")
        assert inp.base_regime == "uncertain"

    def test_is_base_regime_set_only_on_uncertain_after_fallback(self):
        res = _calc().calculate(_basic_input(base_regime="something_invalid"))
        for b in res.branches:
            if b.regime == "uncertain":
                assert b.is_base_regime is True
            else:
                assert b.is_base_regime is False


# ── CLASS 10: TestMandatoryDisclaimers ───────────────────────────────────────


class TestMandatoryDisclaimers:
    def test_scenario_disclaimer_present(self):
        res = _calc().calculate(_basic_input())
        joined = " ".join(res.diagnostics)
        assert "scenario calculations" in joined
        assert "not predictions" in joined

    def test_not_an_order_disclaimer_present(self):
        res = _calc().calculate(_basic_input())
        joined = " ".join(res.diagnostics)
        assert "not an order, not a recommendation" in joined

    def test_linear_aggregation_disclaimer_present(self):
        res = _calc().calculate(_basic_input())
        joined = " ".join(res.diagnostics)
        assert "linear aggregation, not covariance-aware" in joined

    def test_all_diagnostics_use_observation_prefix(self):
        res = _calc().calculate(_basic_input())
        for diag in res.diagnostics:
            assert diag.startswith("observation: "), (
                f"diagnostic lacks 'observation: ' prefix: {diag!r}"
            )

    def test_disclaimers_present_even_with_empty_inputs(self):
        inp = FutureBranchingInput(pf_weights={})
        res = _calc().calculate(inp)
        joined = " ".join(res.diagnostics)
        assert "scenario calculations" in joined
        assert "not an order" in joined
        assert "linear aggregation" in joined


# ── CLASS 11: TestForbiddenFieldsAbsent ──────────────────────────────────────


class TestForbiddenFieldsAbsent:
    def test_input_dataclass_has_no_forbidden_fields(self):
        field_names = {f.name for f in fields(FutureBranchingInput)}
        for forbidden in _FORBIDDEN_FIELD_NAMES:
            assert forbidden not in field_names

    def test_branch_dataclass_has_no_forbidden_fields(self):
        field_names = {f.name for f in fields(FutureBranch)}
        for forbidden in _FORBIDDEN_FIELD_NAMES:
            assert forbidden not in field_names

    def test_result_dataclass_has_no_forbidden_fields(self):
        field_names = {f.name for f in fields(FutureBranchingResult)}
        for forbidden in _FORBIDDEN_FIELD_NAMES:
            assert forbidden not in field_names

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


# ── CLASS 12: TestStaticImportConstraints ────────────────────────────────────


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
            / "engine" / "frontier" / "future_branching.py"
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
