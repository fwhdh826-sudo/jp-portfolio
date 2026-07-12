"""
test_aggregator.py — Card 7-6
StrategyAggregator のユニットテスト。

テスト方針:
  - stdlib-only; pytest のみ
  - 実 get_strategy_weights() を使用（DI テスト）
  - BUY/SELL/HOLD/WAIT 判定・action フィールドが存在しないことを確認
  - observation フラグのみ（P2-7Q 参照値テスト）
  - invalid strategy_id / missing strategy / non-dict 入力の安全処理確認
  - 戦略間 Pearson r / diversification_score の計算確認
  - weights_used / strategy_correlations / aggregated_ideal_pf が tuple であることを確認
  - to_dict() が JSON serializable であることを確認
  - import が engine.regime / operation 等を直接 import しないことを確認
"""
from __future__ import annotations

import importlib
import json
import math
from dataclasses import fields

import pytest

from engine.strategies.aggregator import (
    CORRELATION_PAIRS,
    HIGH_CORR_THRESHOLD,
    StrategyAggregateInput,
    StrategyAggregateResult,
    StrategyAggregator,
    _EMPTY_CORRELATIONS,
    _clamp,
    _safe_float,
)
from engine.strategies.base_strategy import (
    StrategyInput,
    StrategyOutput,
    VALID_STRATEGY_IDS,
)
from engine.dynamic_weight.regime_strategy_weights import (
    CANONICAL_STRATEGIES,
    REGIME_STRATEGY_WEIGHTS,
)


# ── fixtures / helpers ────────────────────────────────────────────────────────

AXES = ("value", "quality", "growth", "safety", "momentum", "shareholder_return")

def _make_scores(tickers: tuple[str, ...], total: float = 70.0) -> dict:
    return {
        ticker: {axis: {"total": total} for axis in AXES}
        for ticker in tickers
    }

def _make_output(
    strategy_id: str,
    ideal_pf: dict,
    expected_return: float = 0.07,
    expected_vol: float = 0.15,
    sharpe_ratio: float = 0.45,
    max_dd_estimate: float = -0.12,
    diagnostics: tuple = (),
) -> StrategyOutput:
    names = {
        "frontier":     "Frontier AI Index",
        "quality_size": "Quality-Size (Asness 2018)",
        "fundamental":  "Fundamental Weighted (Arnott 2005)",
        "cross_factor": "Cross-Factor (Alquist 2018)",
    }
    return StrategyOutput(
        strategy_id=strategy_id,
        strategy_name=names.get(strategy_id, strategy_id),
        ideal_pf=ideal_pf,
        expected_return=expected_return,
        expected_vol=expected_vol,
        sharpe_ratio=sharpe_ratio,
        max_dd_estimate=max_dd_estimate,
        rationale=f"observation: {strategy_id} calculation-only result",
        diagnostics=diagnostics,
    )

def _four_outputs(
    universe: tuple[str, ...] = ("A", "B", "C"),
    weight: float = 1.0 / 3,
) -> dict[str, StrategyOutput]:
    pf = {t: weight for t in universe}
    return {
        "frontier":     _make_output("frontier",     pf, 0.090, 0.120, 0.70, -0.08),
        "quality_size": _make_output("quality_size", pf, 0.080, 0.110, 0.68, -0.07),
        "fundamental":  _make_output("fundamental",  pf, 0.082, 0.115, 0.67, -0.075),
        "cross_factor": _make_output("cross_factor", pf, 0.072, 0.095, 0.72, -0.065),
    }

def _agg() -> StrategyAggregator:
    return StrategyAggregator()


# ── CLASS: モジュール定数 ─────────────────────────────────────────────────────

class TestModuleConstants:
    def test_high_corr_threshold_value(self):
        assert HIGH_CORR_THRESHOLD == 0.70

    def test_correlation_pairs_length(self):
        assert len(CORRELATION_PAIRS) == 6

    def test_correlation_pairs_are_2tuples(self):
        for pair in CORRELATION_PAIRS:
            assert isinstance(pair, tuple)
            assert len(pair) == 2

    def test_correlation_pairs_contain_canonical_ids(self):
        all_ids = {sid for pair in CORRELATION_PAIRS for sid in pair}
        assert all_ids == set(CANONICAL_STRATEGIES)

    def test_empty_correlations_length(self):
        assert len(_EMPTY_CORRELATIONS) == 6

    def test_empty_correlations_all_zero(self):
        for key, val in _EMPTY_CORRELATIONS:
            assert val == 0.0

    def test_empty_correlations_key_format(self):
        for key, _ in _EMPTY_CORRELATIONS:
            assert "_vs_" in key

    def test_correlation_pairs_cover_all_6_expected_pairs(self):
        expected = {
            ("frontier", "quality_size"),
            ("frontier", "fundamental"),
            ("frontier", "cross_factor"),
            ("quality_size", "fundamental"),
            ("quality_size", "cross_factor"),
            ("fundamental", "cross_factor"),
        }
        assert set(CORRELATION_PAIRS) == expected


# ── CLASS: StrategyAggregateInput ────────────────────────────────────────────

class TestStrategyAggregateInput:
    def test_is_frozen(self):
        inp = StrategyAggregateInput(strategy_outputs={}, regime="bull_calm")
        with pytest.raises(Exception):
            inp.regime = "bear"  # type: ignore

    def test_strategy_outputs_field_exists(self):
        inp = StrategyAggregateInput(strategy_outputs={}, regime="bull_calm")
        assert hasattr(inp, "strategy_outputs")

    def test_regime_field_exists(self):
        inp = StrategyAggregateInput(strategy_outputs={}, regime="bull_calm")
        assert inp.regime == "bull_calm"

    def test_context_default_factory_independence(self):
        inp1 = StrategyAggregateInput(strategy_outputs={}, regime="bull_calm")
        inp2 = StrategyAggregateInput(strategy_outputs={}, regime="bull_calm")
        assert inp1.context is not inp2.context

    def test_non_dict_strategy_outputs_fallback(self):
        inp = StrategyAggregateInput(strategy_outputs="not_a_dict", regime="bull_calm")  # type: ignore
        assert inp.strategy_outputs == {}

    def test_non_dict_context_fallback(self):
        inp = StrategyAggregateInput(strategy_outputs={}, regime="bull_calm", context=123)  # type: ignore
        assert inp.context == {}

    def test_none_strategy_outputs_fallback(self):
        inp = StrategyAggregateInput(strategy_outputs=None, regime="bull_calm")  # type: ignore
        assert inp.strategy_outputs == {}

    def test_dict_strategy_outputs_preserved(self):
        out = _make_output("frontier", {"A": 1.0})
        inp = StrategyAggregateInput(strategy_outputs={"frontier": out}, regime="bull_calm")
        assert "frontier" in inp.strategy_outputs

    def test_no_forbidden_fields(self):
        field_names = {f.name for f in fields(StrategyAggregateInput)}
        forbidden = {
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "verdict", "decision", "rating",
            "approve", "reject", "conditional",
        }
        assert not field_names & forbidden


# ── CLASS: StrategyAggregateResult ───────────────────────────────────────────

class TestStrategyAggregateResult:
    def _make_result(self, **kwargs) -> StrategyAggregateResult:
        defaults = dict(
            aggregated_ideal_pf=(("A", 0.5), ("B", 0.5)),
            expected_return=0.07,
            expected_vol=0.15,
            sharpe_ratio=0.45,
            max_dd_estimate=-0.10,
            weights_used=(("frontier", 0.4), ("quality_size", 0.6)),
            regime="bull_calm",
            strategy_correlations=_EMPTY_CORRELATIONS,
            diversification_score=0.65,
            diagnostics=(),
        )
        defaults.update(kwargs)
        return StrategyAggregateResult(**defaults)

    def test_is_frozen(self):
        r = self._make_result()
        with pytest.raises(Exception):
            r.regime = "bear"  # type: ignore

    def test_all_fields_exist(self):
        r = self._make_result()
        for fname in (
            "aggregated_ideal_pf", "expected_return", "expected_vol",
            "sharpe_ratio", "max_dd_estimate", "weights_used", "regime",
            "strategy_correlations", "diversification_score", "diagnostics",
        ):
            assert hasattr(r, fname)

    def test_expected_vol_clamp_negative(self):
        r = self._make_result(expected_vol=-0.1)
        assert r.expected_vol == 0.0

    def test_max_dd_clamp_positive(self):
        r = self._make_result(max_dd_estimate=0.1)
        assert r.max_dd_estimate == 0.0

    def test_diversification_score_clamp_high(self):
        r = self._make_result(diversification_score=2.0)
        assert r.diversification_score == 1.0

    def test_diversification_score_clamp_low(self):
        r = self._make_result(diversification_score=-0.5)
        assert r.diversification_score == 0.0

    def test_diversification_score_clamp_valid(self):
        r = self._make_result(diversification_score=0.65)
        assert abs(r.diversification_score - 0.65) < 1e-9

    def test_weights_used_is_tuple(self):
        r = self._make_result()
        assert isinstance(r.weights_used, tuple)

    def test_strategy_correlations_is_tuple(self):
        r = self._make_result()
        assert isinstance(r.strategy_correlations, tuple)

    def test_aggregated_ideal_pf_is_tuple(self):
        r = self._make_result()
        assert isinstance(r.aggregated_ideal_pf, tuple)

    def test_diagnostics_is_tuple(self):
        r = self._make_result()
        assert isinstance(r.diagnostics, tuple)

    def test_to_dict_aggregated_ideal_pf_is_dict(self):
        r = self._make_result()
        d = r.to_dict()
        assert isinstance(d["aggregated_ideal_pf"], dict)

    def test_to_dict_weights_used_is_dict(self):
        r = self._make_result()
        d = r.to_dict()
        assert isinstance(d["weights_used"], dict)

    def test_to_dict_strategy_correlations_is_dict(self):
        r = self._make_result()
        d = r.to_dict()
        assert isinstance(d["strategy_correlations"], dict)

    def test_to_dict_json_serializable(self):
        r = self._make_result()
        d = r.to_dict()
        json_str = json.dumps(d)
        assert isinstance(json_str, str)

    def test_to_dict_diagnostics_is_list(self):
        r = self._make_result(diagnostics=("obs1", "obs2"))
        d = r.to_dict()
        assert isinstance(d["diagnostics"], list)

    def test_no_forbidden_fields(self):
        field_names = {f.name for f in fields(StrategyAggregateResult)}
        forbidden = {
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "verdict", "decision", "rating",
            "approve", "reject", "conditional", "final_verdict",
            "order", "amount", "entry_price", "stop_loss", "take_profit",
        }
        assert not field_names & forbidden


# ── CLASS: aggregate — 空 / fallback ─────────────────────────────────────────

class TestAggregateEmpty:
    def test_empty_dict_empty_ideal_pf(self):
        r = _agg().aggregate({}, "bull_calm")
        assert r.aggregated_ideal_pf == ()

    def test_empty_dict_all_zero_metrics(self):
        r = _agg().aggregate({}, "bull_calm")
        assert r.expected_return == 0.0
        assert r.expected_vol == 0.0
        assert r.sharpe_ratio == 0.0
        assert r.max_dd_estimate == 0.0

    def test_empty_dict_empty_correlations_schema(self):
        r = _agg().aggregate({}, "bull_calm")
        assert len(r.strategy_correlations) == 6
        for _, val in r.strategy_correlations:
            assert val == 0.0

    def test_empty_dict_diversification_score_is_one(self):
        r = _agg().aggregate({}, "bull_calm")
        assert r.diversification_score == 1.0

    def test_non_dict_strategy_outputs_returns_empty(self):
        r = _agg().aggregate("not_a_dict", "bull_calm")  # type: ignore
        assert r.aggregated_ideal_pf == ()
        assert r.expected_return == 0.0

    def test_non_dict_strategy_outputs_diagnostic(self):
        r = _agg().aggregate("not_a_dict", "bull_calm")  # type: ignore
        assert any("strategy_outputs is not a dict" in d for d in r.diagnostics)

    def test_none_strategy_outputs_returns_empty(self):
        r = _agg().aggregate(None, "bull_calm")  # type: ignore
        assert r.aggregated_ideal_pf == ()

    def test_empty_weights_used_for_empty_input(self):
        r = _agg().aggregate({}, "bull_calm")
        assert r.weights_used == ()


# ── CLASS: aggregate — happy path (4戦略) ────────────────────────────────────

class TestAggregateHappyPath:
    @pytest.mark.parametrize("regime", list(REGIME_STRATEGY_WEIGHTS.keys()))
    def test_weights_match_regime_table(self, regime):
        outputs = _four_outputs()
        r = _agg().aggregate(outputs, regime)
        w = dict(r.weights_used)
        expected = REGIME_STRATEGY_WEIGHTS[regime]
        for sid in CANONICAL_STRATEGIES:
            assert abs(w[sid] - expected[sid]) < 1e-9

    def test_aggregated_ideal_pf_not_empty(self):
        r = _agg().aggregate(_four_outputs(), "bull_calm")
        assert len(r.aggregated_ideal_pf) > 0

    def test_expected_return_positive(self):
        r = _agg().aggregate(_four_outputs(), "bull_calm")
        assert r.expected_return > 0.0

    def test_expected_vol_positive(self):
        r = _agg().aggregate(_four_outputs(), "bull_calm")
        assert r.expected_vol > 0.0

    def test_max_dd_estimate_negative(self):
        r = _agg().aggregate(_four_outputs(), "bull_calm")
        assert r.max_dd_estimate < 0.0

    def test_diversification_score_in_range(self):
        r = _agg().aggregate(_four_outputs(), "bull_calm")
        assert 0.0 <= r.diversification_score <= 1.0

    def test_regime_preserved_in_result(self):
        r = _agg().aggregate(_four_outputs(), "bear")
        assert r.regime == "bear"

    def test_strategy_correlations_always_6_pairs(self):
        r = _agg().aggregate(_four_outputs(), "bull_calm")
        assert len(r.strategy_correlations) == 6

    def test_to_dict_works_on_full_result(self):
        r = _agg().aggregate(_four_outputs(), "bull_calm")
        d = r.to_dict()
        assert json.dumps(d)  # JSON serializable


# ── CLASS: aggregate — 1戦略のみ ─────────────────────────────────────────────

class TestAggregateSingleStrategy:
    def test_weight_equals_one(self):
        outputs = {"frontier": _make_output("frontier", {"A": 0.5, "B": 0.5})}
        r = _agg().aggregate(outputs, "bull_calm")
        w = dict(r.weights_used)
        assert abs(w["frontier"] - 1.0) < 1e-9

    def test_ideal_pf_matches_strategy(self):
        pf = {"A": 0.6, "B": 0.4}
        outputs = {"frontier": _make_output("frontier", pf)}
        r = _agg().aggregate(outputs, "bull_calm")
        result_pf = dict(r.aggregated_ideal_pf)
        assert abs(result_pf["A"] - 0.6) < 1e-9
        assert abs(result_pf["B"] - 0.4) < 1e-9

    def test_all_correlations_zero_for_single_strategy(self):
        outputs = {"frontier": _make_output("frontier", {"A": 1.0})}
        r = _agg().aggregate(outputs, "bull_calm")
        for _, val in r.strategy_correlations:
            assert val == 0.0

    def test_diversification_score_is_one_for_single_strategy(self):
        outputs = {"frontier": _make_output("frontier", {"A": 1.0})}
        r = _agg().aggregate(outputs, "bull_calm")
        assert r.diversification_score == 1.0

    def test_missing_strategies_in_diagnostics(self):
        outputs = {"frontier": _make_output("frontier", {"A": 1.0})}
        r = _agg().aggregate(outputs, "bull_calm")
        missing_diags = [d for d in r.diagnostics if "not provided" in d]
        assert len(missing_diags) == 3  # quality_size, fundamental, cross_factor


# ── CLASS: aggregate — 2戦略 ─────────────────────────────────────────────────

class TestAggregateTwoStrategies:
    def test_weights_renormalized_to_one(self):
        outputs = {
            "frontier":    _make_output("frontier",    {"A": 0.5, "B": 0.5}),
            "quality_size": _make_output("quality_size", {"A": 0.5, "B": 0.5}),
        }
        r = _agg().aggregate(outputs, "bull_calm")
        w = dict(r.weights_used)
        total = sum(w.values())
        assert abs(total - 1.0) < 1e-9

    def test_only_one_correlation_pair_computed(self):
        pf_a = {"A": 0.8, "B": 0.2}
        pf_b = {"A": 0.2, "B": 0.8}
        outputs = {
            "frontier":    _make_output("frontier",    pf_a),
            "quality_size": _make_output("quality_size", pf_b),
        }
        r = _agg().aggregate(outputs, "bull_calm")
        corr = dict(r.strategy_correlations)
        # frontier vs quality_size should be non-zero, rest 0.0
        non_zero_pairs = [(k, v) for k, v in corr.items() if v != 0.0]
        assert len(non_zero_pairs) == 1
        assert non_zero_pairs[0][0] == "frontier_vs_quality_size"

    def test_two_missing_strategy_diagnostics(self):
        outputs = {
            "frontier":    _make_output("frontier",    {"A": 1.0}),
            "quality_size": _make_output("quality_size", {"A": 1.0}),
        }
        r = _agg().aggregate(outputs, "bull_calm")
        missing_diags = [d for d in r.diagnostics if "not provided" in d]
        assert len(missing_diags) == 2

    def test_expected_return_is_weighted_average(self):
        pf = {"A": 1.0}
        out_f  = _make_output("frontier",    pf, expected_return=0.10)
        out_qs = _make_output("quality_size", pf, expected_return=0.08)
        outputs = {"frontier": out_f, "quality_size": out_qs}
        r = _agg().aggregate(outputs, "bull_calm")
        # bull_calm: frontier=0.40, quality_size=0.25 → normalized: 0.40/0.65, 0.25/0.65
        w_f  = 0.40 / (0.40 + 0.25)
        w_qs = 0.25 / (0.40 + 0.25)
        expected = w_f * 0.10 + w_qs * 0.08
        assert abs(r.expected_return - expected) < 1e-9


# ── CLASS: aggregate — invalid / missing ─────────────────────────────────────

class TestAggregateInvalidMissing:
    def test_invalid_strategy_id_skipped(self):
        outputs = {
            "unknown_xyz": _make_output("frontier", {"A": 1.0}),
            "frontier":    _make_output("frontier", {"A": 1.0}),
        }
        r = _agg().aggregate(outputs, "bull_calm")
        w = dict(r.weights_used)
        assert "unknown_xyz" not in w
        assert "frontier" in w

    def test_invalid_strategy_id_diagnostic(self):
        outputs = {"bad_id": _make_output("frontier", {"A": 1.0})}
        r = _agg().aggregate(outputs, "bull_calm")
        assert any("invalid strategy_id 'bad_id'" in d for d in r.diagnostics)

    def test_empty_string_strategy_id_skipped(self):
        outputs = {"": _make_output("frontier", {"A": 1.0})}
        r = _agg().aggregate(outputs, "bull_calm")
        assert r.aggregated_ideal_pf == ()

    def test_missing_strategy_diagnostic_message_format(self):
        outputs = {"frontier": _make_output("frontier", {"A": 1.0})}
        r = _agg().aggregate(outputs, "bull_calm")
        missing = [d for d in r.diagnostics if "not provided" in d]
        for d in missing:
            assert d.startswith("observation:")
            assert "weight redistributed" in d

    def test_all_invalid_returns_empty(self):
        outputs = {"bad1": _make_output("frontier", {"A": 1.0})}
        r = _agg().aggregate(outputs, "bull_calm")
        assert r.aggregated_ideal_pf == ()
        assert r.expected_return == 0.0

    def test_non_strategyoutput_value_skipped(self):
        outputs = {"frontier": "not_a_strategy_output"}  # type: ignore
        r = _agg().aggregate(outputs, "bull_calm")
        assert r.aggregated_ideal_pf == ()

    def test_non_strategyoutput_value_diagnostic(self):
        outputs = {"frontier": "not_a_strategy_output"}  # type: ignore
        r = _agg().aggregate(outputs, "bull_calm")
        assert any("not a StrategyOutput" in d for d in r.diagnostics)


# ── CLASS: aggregate — unknown regime ────────────────────────────────────────

class TestAggregateUnknownRegime:
    def test_unknown_regime_diagnostic(self):
        outputs = {"frontier": _make_output("frontier", {"A": 1.0})}
        r = _agg().aggregate(outputs, "foo_regime")
        assert any("unknown regime 'foo_regime'" in d for d in r.diagnostics)

    def test_unknown_regime_falls_back_to_uncertain_weights(self):
        outputs = _four_outputs()
        r = _agg().aggregate(outputs, "unknown_regime_xyz")
        w = dict(r.weights_used)
        # uncertain weights: frontier=0.40, quality_size=0.20, fundamental=0.20, cross_factor=0.20
        uncertain = REGIME_STRATEGY_WEIGHTS["uncertain"]
        for sid in CANONICAL_STRATEGIES:
            assert abs(w[sid] - uncertain[sid]) < 1e-9

    def test_known_regime_no_unknown_diagnostic(self):
        outputs = _four_outputs()
        r = _agg().aggregate(outputs, "bull_calm")
        assert not any("unknown regime" in d for d in r.diagnostics)


# ── CLASS: aggregate — ideal_pf 合成 ─────────────────────────────────────────

class TestAggregateIdealPf:
    def test_overlapping_tickers_summed(self):
        # Both strategies hold ticker "A" → weights should add up
        pf_f  = {"A": 0.5, "B": 0.5}
        pf_qs = {"A": 0.5, "C": 0.5}
        outputs = {
            "frontier":    _make_output("frontier",    pf_f),
            "quality_size": _make_output("quality_size", pf_qs),
        }
        r = _agg().aggregate(outputs, "bull_calm")
        result_pf = dict(r.aggregated_ideal_pf)
        # A should have contribution from both strategies
        # bull_calm: frontier=0.40, quality_size=0.25, normalized: ~0.615, ~0.385
        w_f  = 0.40 / 0.65
        w_qs = 0.25 / 0.65
        expected_a = w_f * 0.5 + w_qs * 0.5
        assert abs(result_pf["A"] - expected_a) < 1e-9

    def test_non_overlapping_tickers_both_present(self):
        pf_f  = {"A": 1.0}
        pf_qs = {"B": 1.0}
        outputs = {
            "frontier":    _make_output("frontier",    pf_f),
            "quality_size": _make_output("quality_size", pf_qs),
        }
        r = _agg().aggregate(outputs, "bull_calm")
        result_pf = dict(r.aggregated_ideal_pf)
        assert "A" in result_pf
        assert "B" in result_pf

    def test_weight_desc_ordering(self):
        # Create strategies with clearly different weights for different tickers
        pf = {"X": 0.7, "Y": 0.2, "Z": 0.1}
        outputs = {"frontier": _make_output("frontier", pf)}
        r = _agg().aggregate(outputs, "bull_calm")
        weights = [w for _, w in r.aggregated_ideal_pf]
        assert weights == sorted(weights, reverse=True)

    def test_ticker_asc_tiebreak(self):
        # Equal weights should sort by ticker ascending
        pf = {"B": 0.5, "A": 0.5}
        outputs = {"frontier": _make_output("frontier", pf)}
        r = _agg().aggregate(outputs, "bull_calm")
        tickers = [t for t, _ in r.aggregated_ideal_pf]
        assert tickers[0] == "A"
        assert tickers[1] == "B"

    def test_aggregated_ideal_pf_sum_approx_one(self):
        r = _agg().aggregate(_four_outputs(), "bull_calm")
        total = sum(w for _, w in r.aggregated_ideal_pf)
        assert abs(total - 1.0) < 1e-6


# ── CLASS: aggregate — 期待メトリクス集約 ────────────────────────────────────

class TestAggregateMetrics:
    def test_expected_return_weighted_sum(self):
        pf = {"A": 1.0}
        outputs = {
            "frontier":     _make_output("frontier",     pf, expected_return=0.09),
            "quality_size": _make_output("quality_size", pf, expected_return=0.08),
            "fundamental":  _make_output("fundamental",  pf, expected_return=0.082),
            "cross_factor": _make_output("cross_factor", pf, expected_return=0.072),
        }
        r = _agg().aggregate(outputs, "bull_calm")
        # bull_calm weights: frontier=0.40, quality_size=0.25, fundamental=0.20, cross_factor=0.15
        expected = 0.40 * 0.09 + 0.25 * 0.08 + 0.20 * 0.082 + 0.15 * 0.072
        assert abs(r.expected_return - expected) < 1e-9

    def test_expected_vol_weighted_sum(self):
        pf = {"A": 1.0}
        outputs = {
            "frontier":     _make_output("frontier",     pf, expected_vol=0.12),
            "quality_size": _make_output("quality_size", pf, expected_vol=0.11),
            "fundamental":  _make_output("fundamental",  pf, expected_vol=0.115),
            "cross_factor": _make_output("cross_factor", pf, expected_vol=0.095),
        }
        r = _agg().aggregate(outputs, "bull_calm")
        expected = 0.40 * 0.12 + 0.25 * 0.11 + 0.20 * 0.115 + 0.15 * 0.095
        assert abs(r.expected_vol - expected) < 1e-9

    def test_max_dd_estimate_weighted_sum(self):
        pf = {"A": 1.0}
        outputs = {
            "frontier":     _make_output("frontier",     pf, max_dd_estimate=-0.08),
            "quality_size": _make_output("quality_size", pf, max_dd_estimate=-0.07),
            "fundamental":  _make_output("fundamental",  pf, max_dd_estimate=-0.075),
            "cross_factor": _make_output("cross_factor", pf, max_dd_estimate=-0.065),
        }
        r = _agg().aggregate(outputs, "bull_calm")
        expected = 0.40 * (-0.08) + 0.25 * (-0.07) + 0.20 * (-0.075) + 0.15 * (-0.065)
        assert abs(r.max_dd_estimate - expected) < 1e-9

    def test_sharpe_ratio_equals_return_over_vol(self):
        outputs = _four_outputs()
        r = _agg().aggregate(outputs, "bull_calm")
        if r.expected_vol > 0:
            expected_sharpe = r.expected_return / r.expected_vol
            assert abs(r.sharpe_ratio - expected_sharpe) < 1e-9

    def test_sharpe_zero_when_vol_zero(self):
        pf = {"A": 1.0}
        outputs = {"frontier": _make_output("frontier", pf, expected_return=0.07, expected_vol=0.0)}
        r = _agg().aggregate(outputs, "bull_calm")
        assert r.sharpe_ratio == 0.0

    def test_max_dd_is_non_positive(self):
        r = _agg().aggregate(_four_outputs(), "bear")
        assert r.max_dd_estimate <= 0.0


# ── CLASS: _pearson_r ─────────────────────────────────────────────────────────

class TestPearsonR:
    def _r(self, xs, ys) -> float:
        return _agg()._pearson_r(xs, ys)

    def test_identical_vectors_approx_one(self):
        xs = [0.1, 0.3, 0.6]
        r = self._r(xs, xs)
        assert abs(r - 1.0) < 1e-9

    def test_opposite_vectors_approx_neg_one(self):
        xs = [0.1, 0.3, 0.6]
        ys = [0.9, 0.7, 0.4]
        # These are not perfectly negatively correlated, let's use exact negatives
        xs = [1.0, 2.0, 3.0]
        ys = [-1.0, -2.0, -3.0]
        r = self._r(xs, ys)
        assert abs(r - (-1.0)) < 1e-9

    def test_n_less_than_2_returns_zero(self):
        assert self._r([0.5], [0.5]) == 0.0
        assert self._r([], []) == 0.0

    def test_std_x_zero_returns_zero(self):
        assert self._r([1.0, 1.0, 1.0], [0.1, 0.5, 0.9]) == 0.0

    def test_std_y_zero_returns_zero(self):
        assert self._r([0.1, 0.5, 0.9], [1.0, 1.0, 1.0]) == 0.0

    def test_result_clamped_to_minus_one(self):
        # Floating point should not go below -1.0
        xs = [0.3, 0.3, 0.4]
        ys = [0.4, 0.3, 0.3]
        r = self._r(xs, ys)
        assert r >= -1.0

    def test_result_clamped_to_plus_one(self):
        xs = [0.1, 0.2, 0.7]
        r = self._r(xs, xs)
        assert r <= 1.0

    def test_uncorrelated_approx_zero(self):
        # Constant x cannot correlate
        xs = [0.5, 0.5, 0.5, 0.5]
        ys = [0.1, 0.4, 0.2, 0.3]
        r = self._r(xs, ys)
        assert r == 0.0


# ── CLASS: _calc_correlations ─────────────────────────────────────────────────

class TestCalcCorrelations:
    def test_always_returns_6_pairs(self):
        outputs = _four_outputs()
        corr = _agg()._calc_correlations(outputs)
        assert len(corr) == 6

    def test_missing_strategy_pair_is_zero(self):
        # Only frontier provided → all 5 pairs involving other strategies = 0.0
        outputs = {"frontier": _make_output("frontier", {"A": 0.5, "B": 0.5})}
        corr = _agg()._calc_correlations(outputs)
        assert all(v == 0.0 for k, v in corr.items() if "frontier_vs" not in k)

    def test_identical_portfolios_correlation_approx_one(self):
        pf = {"A": 0.3, "B": 0.4, "C": 0.3}
        outputs = {
            "frontier":    _make_output("frontier",    pf),
            "quality_size": _make_output("quality_size", pf),
        }
        corr = _agg()._calc_correlations(outputs)
        assert abs(corr["frontier_vs_quality_size"] - 1.0) < 1e-9

    def test_disjoint_portfolios_zero_std(self):
        # If portfolios don't share any tickers, one vector is all zeros → std=0 → r=0
        pf_a = {"A": 1.0}
        pf_b = {"B": 1.0}
        outputs = {
            "frontier":    _make_output("frontier",    pf_a),
            "quality_size": _make_output("quality_size", pf_b),
        }
        corr = _agg()._calc_correlations(outputs)
        # union = ["A", "B"], xs=[1.0, 0.0], ys=[0.0, 1.0]
        # mean_x=0.5, mean_y=0.5, cov=(-0.5)*(−0.5)+(0.5)*(0.5)=0.5... wait
        # Let me recalculate: xs=[1.0, 0.0], ys=[0.0, 1.0]
        # mean_x=0.5, mean_y=0.5
        # cov = (1-0.5)*(0-0.5) + (0-0.5)*(1-0.5) = 0.5*(-0.5) + (-0.5)*0.5 = -0.25 - 0.25 = -0.5
        # var_x = (0.5)^2 + (0.5)^2 = 0.5
        # var_y = 0.5
        # r = -0.5 / sqrt(0.5*0.5) = -0.5/0.5 = -1.0
        # So disjoint portfolios are perfectly negatively correlated
        assert corr["frontier_vs_quality_size"] == -1.0

    def test_key_format_is_a_vs_b(self):
        corr = _agg()._calc_correlations(_four_outputs())
        for key in corr:
            assert "_vs_" in key
            parts = key.split("_vs_")
            assert len(parts) == 2

    def test_only_two_strategies_other_pairs_zero(self):
        # Use non-uniform weights so Pearson r is defined (not std=0)
        pf = {"A": 0.3, "B": 0.7}
        outputs = {
            "frontier":    _make_output("frontier",    pf),
            "fundamental": _make_output("fundamental", pf),
        }
        corr = _agg()._calc_correlations(outputs)
        assert abs(corr["frontier_vs_fundamental"] - 1.0) < 1e-9  # Same pf → r=1.0
        assert corr["frontier_vs_quality_size"] == 0.0
        assert corr["frontier_vs_cross_factor"] == 0.0
        assert corr["quality_size_vs_fundamental"] == 0.0
        assert corr["quality_size_vs_cross_factor"] == 0.0
        assert corr["fundamental_vs_cross_factor"] == 0.0


# ── CLASS: diversification_score ─────────────────────────────────────────────

class TestDiversificationScore:
    def test_formula_one_minus_max_positive_corr(self):
        # Use non-uniform identical portfolios → correlation = 1.0 → div_score = 0.0
        # std must be non-zero: use {"A": 0.3, "B": 0.7}
        pf = {"A": 0.3, "B": 0.7}
        outputs = {
            "frontier":    _make_output("frontier",    pf),
            "quality_size": _make_output("quality_size", pf),
        }
        r = _agg().aggregate(outputs, "bull_calm")
        assert r.diversification_score == 0.0

    def test_negative_correlation_does_not_exceed_one(self):
        # Disjoint portfolios → correlation = -1.0 → max_positive_corr = 0.0 → div_score = 1.0
        pf_a = {"A": 1.0}
        pf_b = {"B": 1.0}
        outputs = {
            "frontier":    _make_output("frontier",    pf_a),
            "quality_size": _make_output("quality_size", pf_b),
        }
        r = _agg().aggregate(outputs, "bull_calm")
        assert r.diversification_score <= 1.0

    def test_no_correlations_gives_one(self):
        r = _agg().aggregate({}, "bull_calm")
        assert r.diversification_score == 1.0

    def test_score_always_in_zero_to_one(self):
        for regime in REGIME_STRATEGY_WEIGHTS:
            r = _agg().aggregate(_four_outputs(), regime)
            assert 0.0 <= r.diversification_score <= 1.0


# ── CLASS: high correlation diagnostic ────────────────────────────────────────

class TestHighCorrelationDiagnostic:
    def test_high_correlation_adds_diagnostic(self):
        # Identical portfolios → correlation = 1.0 > 0.70
        pf = {"A": 0.4, "B": 0.3, "C": 0.3}
        outputs = {
            "frontier":    _make_output("frontier",    pf),
            "quality_size": _make_output("quality_size", pf),
        }
        r = _agg().aggregate(outputs, "bull_calm")
        assert any("max strategy correlation" in d for d in r.diagnostics)

    def test_high_correlation_diagnostic_contains_calculation_only(self):
        pf = {"A": 0.5, "B": 0.5}
        outputs = {
            "frontier":    _make_output("frontier",    pf),
            "quality_size": _make_output("quality_size", pf),
        }
        r = _agg().aggregate(outputs, "bull_calm")
        high_corr_diags = [d for d in r.diagnostics if "max strategy correlation" in d]
        if high_corr_diags:
            assert any("calculation-only" in d for d in high_corr_diags)

    def test_low_correlation_no_high_corr_diagnostic(self):
        # Disjoint portfolios → correlation ≈ -1.0 → no high corr diagnostic
        pf_a = {"A": 1.0}
        pf_b = {"B": 1.0}
        outputs = {
            "frontier":    _make_output("frontier",    pf_a),
            "quality_size": _make_output("quality_size", pf_b),
        }
        r = _agg().aggregate(outputs, "bull_calm")
        assert not any("max strategy correlation" in d for d in r.diagnostics)


# ── CLASS: _normalize_strategy_weights ────────────────────────────────────────

class TestNormalizeStrategyWeights:
    def _norm(self, raw, ids):
        return _agg()._normalize_strategy_weights(raw, ids)

    def test_empty_available_ids_returns_empty(self):
        assert self._norm({"frontier": 0.4}, set()) == {}

    def test_normalizes_to_sum_one(self):
        result = self._norm(
            {"frontier": 0.40, "quality_size": 0.25},
            {"frontier", "quality_size"},
        )
        assert abs(sum(result.values()) - 1.0) < 1e-9

    def test_all_zero_weights_equal_weight_fallback(self):
        result = self._norm(
            {"frontier": 0.0, "quality_size": 0.0},
            {"frontier", "quality_size"},
        )
        assert abs(result["frontier"] - 0.5) < 1e-9
        assert abs(result["quality_size"] - 0.5) < 1e-9

    def test_extracts_only_available_ids(self):
        result = self._norm(
            {"frontier": 0.40, "quality_size": 0.25, "fundamental": 0.20, "cross_factor": 0.15},
            {"frontier", "quality_size"},
        )
        assert "fundamental" not in result
        assert "cross_factor" not in result

    def test_all_four_strategies_sum_one(self):
        raw = REGIME_STRATEGY_WEIGHTS["bull_calm"]
        result = self._norm(raw, set(CANONICAL_STRATEGIES))
        assert abs(sum(result.values()) - 1.0) < 1e-9


# ── CLASS: _aggregate_ideal_pf ───────────────────────────────────────────────

class TestAggregateIdealPfHelper:
    def test_uses_ideal_pf_as_dict(self):
        pf = {"X": 0.6, "Y": 0.4}
        output = _make_output("frontier", pf)
        result = _agg()._aggregate_ideal_pf(
            {"frontier": output},
            {"frontier": 1.0},
        )
        assert abs(result["X"] - 0.6) < 1e-9
        assert abs(result["Y"] - 0.4) < 1e-9

    def test_ticker_weights_summed_across_strategies(self):
        pf_f  = {"A": 0.5, "B": 0.5}
        pf_qs = {"A": 0.8, "B": 0.2}
        outputs = {
            "frontier":    _make_output("frontier",    pf_f),
            "quality_size": _make_output("quality_size", pf_qs),
        }
        nw = {"frontier": 0.6, "quality_size": 0.4}
        result = _agg()._aggregate_ideal_pf(outputs, nw)
        expected_a = 0.6 * 0.5 + 0.4 * 0.8
        assert abs(result["A"] - expected_a) < 1e-9

    def test_zero_strategy_weight_excluded(self):
        pf = {"A": 1.0}
        output = _make_output("frontier", pf)
        result = _agg()._aggregate_ideal_pf(
            {"frontier": output},
            {"frontier": 0.0},
        )
        assert result == {}


# ── CLASS: weights_used / strategy_correlations tuple形式 ─────────────────────

class TestTupleFormats:
    def test_weights_used_contains_tuples_of_two(self):
        r = _agg().aggregate(_four_outputs(), "bull_calm")
        for item in r.weights_used:
            assert isinstance(item, tuple)
            assert len(item) == 2

    def test_strategy_correlations_contains_tuples_of_two(self):
        r = _agg().aggregate(_four_outputs(), "bull_calm")
        for item in r.strategy_correlations:
            assert isinstance(item, tuple)
            assert len(item) == 2

    def test_weights_used_keys_are_strings(self):
        r = _agg().aggregate(_four_outputs(), "bull_calm")
        for sid, _ in r.weights_used:
            assert isinstance(sid, str)

    def test_strategy_correlations_values_in_range(self):
        r = _agg().aggregate(_four_outputs(), "bull_calm")
        for _, val in r.strategy_correlations:
            assert -1.0 <= val <= 1.0


# ── CLASS: import safety ──────────────────────────────────────────────────────

class TestImportSafety:
    def _src(self) -> str:
        import inspect
        import engine.strategies.aggregator as m
        return inspect.getsource(m)

    def test_no_pandas_import(self):
        assert "import pandas" not in self._src()

    def test_no_numpy_import(self):
        assert "import numpy" not in self._src()

    def test_no_scipy_import(self):
        assert "import scipy" not in self._src()

    def test_no_sklearn_import(self):
        assert "import sklearn" not in self._src()

    def test_no_cvxpy_import(self):
        assert "import cvxpy" not in self._src()

    def test_no_requests_import(self):
        assert "import requests" not in self._src()

    def test_no_httpx_import(self):
        assert "import httpx" not in self._src()

    def test_no_openai_import(self):
        assert "import openai" not in self._src()

    def test_no_anthropic_import(self):
        assert "import anthropic" not in self._src()

    def test_no_engine_regime_import(self):
        assert "from engine.regime" not in self._src()
        assert "import engine.regime" not in self._src()

    def test_no_engine_operation_import(self):
        assert "from engine.operation" not in self._src()
        assert "import engine.operation" not in self._src()

    def test_no_engine_market_intel_import(self):
        assert "from engine.market_intel" not in self._src()

    def test_no_engine_news_import(self):
        assert "from engine.news" not in self._src()

    def test_get_strategy_weights_is_imported(self):
        import engine.strategies.aggregator as m
        assert hasattr(m, "get_strategy_weights")


# ── CLASS: 判断フィールド確認 ─────────────────────────────────────────────────

class TestNoJudgmentFields:
    def test_result_has_no_action_field(self):
        r = _agg().aggregate(_four_outputs(), "bull_calm")
        assert not hasattr(r, "action")

    def test_result_has_no_recommendation_field(self):
        r = _agg().aggregate(_four_outputs(), "bull_calm")
        assert not hasattr(r, "recommendation")

    def test_result_has_no_verdict_field(self):
        r = _agg().aggregate(_four_outputs(), "bull_calm")
        assert not hasattr(r, "verdict")

    def test_result_has_no_is_buy_field(self):
        r = _agg().aggregate(_four_outputs(), "bull_calm")
        assert not hasattr(r, "is_buy")

    def test_result_has_no_is_sell_field(self):
        r = _agg().aggregate(_four_outputs(), "bull_calm")
        assert not hasattr(r, "is_sell")

    def test_aggregator_module_importable(self):
        mod = importlib.import_module("engine.strategies.aggregator")
        assert hasattr(mod, "StrategyAggregator")


# ── CLASS: end-to-end with real strategies ────────────────────────────────────

class TestEndToEnd:
    def _real_input(
        self,
        universe: tuple[str, ...] = ("7011", "9984", "6758", "4661", "7203"),
        regime: str = "bull_calm",
    ) -> StrategyInput:
        scores = _make_scores(universe, total=75.0)
        return StrategyInput(universe=universe, scores=scores, regime=regime)

    def test_frontier_output_can_be_aggregated(self):
        from engine.strategies.frontier_strategy import FrontierStrategy
        si = self._real_input()
        out = FrontierStrategy().compute(si)
        r = _agg().aggregate({"frontier": out}, "bull_calm")
        assert isinstance(r, StrategyAggregateResult)
        assert len(r.aggregated_ideal_pf) > 0

    def test_quality_size_output_can_be_aggregated(self):
        from engine.strategies.quality_size_strategy import QualitySizeStrategy
        si = self._real_input()
        out = QualitySizeStrategy().compute(si)
        r = _agg().aggregate({"quality_size": out}, "bull_calm")
        assert isinstance(r, StrategyAggregateResult)

    def test_four_real_strategies_aggregate(self):
        from engine.strategies.frontier_strategy import FrontierStrategy
        from engine.strategies.quality_size_strategy import QualitySizeStrategy
        from engine.strategies.fundamental_weighted_strategy import FundamentalWeightedStrategy
        from engine.strategies.cross_factor_strategy import CrossFactorStrategy

        universe = ("7011", "9984", "6758", "4661", "7203", "6367", "8306")
        si = StrategyInput(
            universe=universe,
            scores=_make_scores(universe, total=75.0),
            regime="bull_calm",
        )
        outputs = {
            "frontier":     FrontierStrategy().compute(si),
            "quality_size": QualitySizeStrategy().compute(si),
            "fundamental":  FundamentalWeightedStrategy().compute(si),
            "cross_factor": CrossFactorStrategy().compute(si),
        }
        r = _agg().aggregate(outputs, "bull_calm")
        assert isinstance(r, StrategyAggregateResult)
        assert len(r.aggregated_ideal_pf) > 0
        assert abs(sum(w for _, w in r.aggregated_ideal_pf) - 1.0) < 1e-6
        assert len(r.strategy_correlations) == 6

    def test_to_dict_on_real_result(self):
        from engine.strategies.frontier_strategy import FrontierStrategy
        si = self._real_input()
        out = FrontierStrategy().compute(si)
        r = _agg().aggregate({"frontier": out}, "bull_calm")
        d = r.to_dict()
        assert json.dumps(d)  # serializable

    def test_regime_crisis_uses_frontier_heavy_weights(self):
        r = _agg().aggregate(_four_outputs(), "crisis")
        w = dict(r.weights_used)
        # crisis: frontier=0.70 (dominant)
        assert w["frontier"] > w["quality_size"]
        assert w["frontier"] > w["fundamental"]
