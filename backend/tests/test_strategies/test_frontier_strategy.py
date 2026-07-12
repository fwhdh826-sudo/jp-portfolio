"""
test_frontier_strategy.py — Card 7-2
FrontierStrategy のユニットテスト。

テスト方針:
  - stdlib-only; pytest のみ
  - 実 get_axis_weights() を使用（DI テスト）
  - BUY/SELL/HOLD/WAIT 判定・action フィールドが存在しないことを確認
  - observation フラグのみ（P2-7E 参照値テスト）
  - DEFAULT_SCORE=50.0 フォールバック確認
  - unknown regime fallback 確認
  - empty universe guard 確認
  - diagnostics フォーマット確認
  - import が engine.regime を直接 import しないことの確認
"""
from __future__ import annotations

import importlib
import math

import pytest

from engine.strategies.frontier_strategy import (
    DEFAULT_SCORE,
    FrontierStrategy,
    _FALLBACK_REGIME,
    _REGIME_EXPECTED_RETURN,
    _REGIME_EXPECTED_VOL,
    _REGIME_MAX_DD,
)
from engine.strategies.base_strategy import StrategyInput, StrategyOutput


# ── fixtures ──────────────────────────────────────────────────────────────────

AXES = ("value", "quality", "growth", "safety", "momentum", "shareholder_return")

def _make_scores(
    tickers: tuple[str, ...],
    total: float = 80.0,
) -> dict:
    """全銘柄・全軸に同一 total を持つ scores fixture を返す。"""
    return {
        ticker: {axis: {"total": total} for axis in AXES}
        for ticker in tickers
    }

def _make_input(
    universe: tuple[str, ...] = ("AAPL", "MSFT", "NVDA"),
    regime: str = "bull_calm",
    scores: dict | None = None,
) -> StrategyInput:
    if scores is None:
        scores = _make_scores(universe)
    return StrategyInput(universe=universe, scores=scores, regime=regime)


# ── CLASS: インスタンス化・属性 ───────────────────────────────────────────────

class TestFrontierStrategyClass:
    def test_strategy_id(self):
        assert FrontierStrategy.STRATEGY_ID == "frontier"

    def test_strategy_name(self):
        assert FrontierStrategy.STRATEGY_NAME == "Frontier AI Index"

    def test_instantiation(self):
        s = FrontierStrategy()
        assert isinstance(s, FrontierStrategy)

    def test_default_score_constant(self):
        assert DEFAULT_SCORE == 50.0

    def test_fallback_regime_constant(self):
        assert _FALLBACK_REGIME == "uncertain"


# ── CLASS: compute() — empty universe ────────────────────────────────────────

class TestComputeEmptyUniverse:
    def setup_method(self):
        self.s = FrontierStrategy()

    def test_empty_universe_returns_output(self):
        inp = _make_input(universe=())
        out = self.s.compute(inp)
        assert isinstance(out, StrategyOutput)

    def test_empty_universe_ideal_pf_empty(self):
        inp = _make_input(universe=())
        out = self.s.compute(inp)
        assert out.ideal_pf == ()

    def test_empty_universe_expected_return_zero(self):
        inp = _make_input(universe=())
        out = self.s.compute(inp)
        assert out.expected_return == 0.0

    def test_empty_universe_expected_vol_zero(self):
        inp = _make_input(universe=())
        out = self.s.compute(inp)
        assert out.expected_vol == 0.0

    def test_empty_universe_sharpe_zero(self):
        inp = _make_input(universe=())
        out = self.s.compute(inp)
        assert out.sharpe_ratio == 0.0

    def test_empty_universe_max_dd_zero(self):
        inp = _make_input(universe=())
        out = self.s.compute(inp)
        assert out.max_dd_estimate == 0.0

    def test_empty_universe_diagnostics_contains_empty(self):
        inp = _make_input(universe=())
        out = self.s.compute(inp)
        joined = " ".join(out.diagnostics)
        assert "universe is empty" in joined

    def test_empty_universe_diagnostics_contains_reference_values(self):
        inp = _make_input(universe=())
        out = self.s.compute(inp)
        joined = " ".join(out.diagnostics)
        assert "reference values" in joined

    def test_empty_universe_strategy_id_set(self):
        inp = _make_input(universe=())
        out = self.s.compute(inp)
        assert out.strategy_id == "frontier"

    def test_empty_universe_strategy_name_set(self):
        inp = _make_input(universe=())
        out = self.s.compute(inp)
        assert out.strategy_name == "Frontier AI Index"


# ── CLASS: compute() — happy path ────────────────────────────────────────────

class TestComputeHappyPath:
    def setup_method(self):
        self.s = FrontierStrategy()

    def test_returns_strategy_output(self):
        out = self.s.compute(_make_input())
        assert isinstance(out, StrategyOutput)

    def test_strategy_id_in_output(self):
        out = self.s.compute(_make_input())
        assert out.strategy_id == "frontier"

    def test_strategy_name_in_output(self):
        out = self.s.compute(_make_input())
        assert out.strategy_name == "Frontier AI Index"

    def test_ideal_pf_length_matches_universe(self):
        universe = ("AAPL", "MSFT", "NVDA")
        out = self.s.compute(_make_input(universe=universe))
        assert len(out.ideal_pf) == len(universe)

    def test_ideal_pf_weights_sum_to_one(self):
        out = self.s.compute(_make_input())
        total = sum(w for _, w in out.ideal_pf)
        assert abs(total - 1.0) < 1e-9

    def test_ideal_pf_equal_weight_when_scores_equal(self):
        # 全銘柄スコアが同一 → 等ウェイト
        universe = ("AAPL", "MSFT", "NVDA")
        out = self.s.compute(_make_input(universe=universe))
        weights = [w for _, w in out.ideal_pf]
        expected = 1.0 / len(universe)
        for w in weights:
            assert abs(w - expected) < 1e-9

    def test_expected_return_positive(self):
        out = self.s.compute(_make_input(regime="bull_calm"))
        assert out.expected_return > 0.0

    def test_expected_vol_positive(self):
        out = self.s.compute(_make_input(regime="bull_calm"))
        assert out.expected_vol > 0.0

    def test_sharpe_ratio_positive(self):
        out = self.s.compute(_make_input(regime="bull_calm"))
        assert out.sharpe_ratio > 0.0

    def test_max_dd_estimate_nonpositive(self):
        out = self.s.compute(_make_input(regime="bull_calm"))
        assert out.max_dd_estimate <= 0.0

    def test_diagnostics_contains_reference_values(self):
        out = self.s.compute(_make_input())
        joined = " ".join(out.diagnostics)
        assert "reference values" in joined

    def test_rationale_contains_regime(self):
        out = self.s.compute(_make_input(regime="bull_calm"))
        assert "bull_calm" in out.rationale

    def test_rationale_contains_frontier(self):
        out = self.s.compute(_make_input())
        assert "Frontier AI Index" in out.rationale

    def test_output_is_frozen(self):
        out = self.s.compute(_make_input())
        with pytest.raises((AttributeError, TypeError)):
            out.strategy_id = "changed"  # type: ignore[misc]

    def test_single_ticker(self):
        universe = ("SOLO",)
        out = self.s.compute(_make_input(universe=universe))
        assert len(out.ideal_pf) == 1
        assert abs(out.ideal_pf[0][1] - 1.0) < 1e-9


# ── CLASS: compute() — regime reference values ────────────────────────────────

class TestRegimeReferenceValues:
    def setup_method(self):
        self.s = FrontierStrategy()

    @pytest.mark.parametrize("regime", ["bull_calm", "bull_volatile", "bear", "crisis", "uncertain"])
    def test_known_regime_expected_return(self, regime):
        out = self.s.compute(_make_input(regime=regime))
        assert out.expected_return == _REGIME_EXPECTED_RETURN[regime]

    @pytest.mark.parametrize("regime", ["bull_calm", "bull_volatile", "bear", "crisis", "uncertain"])
    def test_known_regime_expected_vol(self, regime):
        out = self.s.compute(_make_input(regime=regime))
        assert out.expected_vol == _REGIME_EXPECTED_VOL[regime]

    @pytest.mark.parametrize("regime", ["bull_calm", "bull_volatile", "bear", "crisis", "uncertain"])
    def test_known_regime_max_dd(self, regime):
        out = self.s.compute(_make_input(regime=regime))
        assert out.max_dd_estimate == _REGIME_MAX_DD[regime]

    @pytest.mark.parametrize("regime", ["bull_calm", "bull_volatile", "bear", "crisis", "uncertain"])
    def test_known_regime_sharpe_ratio(self, regime):
        out = self.s.compute(_make_input(regime=regime))
        expected_vol = _REGIME_EXPECTED_VOL[regime]
        expected_ret = _REGIME_EXPECTED_RETURN[regime]
        expected_sharpe = expected_ret / expected_vol if expected_vol > 0.0 else 0.0
        assert abs(out.sharpe_ratio - expected_sharpe) < 1e-9

    def test_unknown_regime_fallback_to_uncertain_return(self):
        out = self.s.compute(_make_input(regime="unknown_xyz"))
        assert out.expected_return == _REGIME_EXPECTED_RETURN["uncertain"]

    def test_unknown_regime_fallback_to_uncertain_vol(self):
        out = self.s.compute(_make_input(regime="unknown_xyz"))
        assert out.expected_vol == _REGIME_EXPECTED_VOL["uncertain"]

    def test_unknown_regime_fallback_to_uncertain_max_dd(self):
        out = self.s.compute(_make_input(regime="unknown_xyz"))
        assert out.max_dd_estimate == _REGIME_MAX_DD["uncertain"]

    def test_unknown_regime_diagnostic_message(self):
        out = self.s.compute(_make_input(regime="unknown_xyz"))
        joined = " ".join(out.diagnostics)
        assert "unknown regime" in joined
        assert "uncertain" in joined

    def test_max_dd_bull_calm_is_negative(self):
        out = self.s.compute(_make_input(regime="bull_calm"))
        assert out.max_dd_estimate < 0.0

    def test_max_dd_crisis_most_negative(self):
        out_crisis = self.s.compute(_make_input(regime="crisis"))
        out_bull = self.s.compute(_make_input(regime="bull_calm"))
        assert out_crisis.max_dd_estimate < out_bull.max_dd_estimate


# ── CLASS: _calc_frontier_score ───────────────────────────────────────────────

class TestCalcFrontierScore:
    def setup_method(self):
        self.s = FrontierStrategy()
        self.equal_weights = {axis: 1.0 / 6 for axis in AXES}

    def test_all_axes_present_computes_weighted_sum(self):
        ticker_scores = {axis: {"total": 80.0} for axis in AXES}
        score = self.s._calc_frontier_score(ticker_scores, self.equal_weights)
        assert abs(score - 80.0) < 1e-9

    def test_missing_axis_data_uses_default_score(self):
        # 全軸欠損 → DEFAULT_SCORE=50.0 が使われる
        score = self.s._calc_frontier_score({}, self.equal_weights)
        assert abs(score - DEFAULT_SCORE) < 1e-9

    def test_non_dict_axis_value_uses_default_score(self):
        ticker_scores = {axis: "invalid" for axis in AXES}
        score = self.s._calc_frontier_score(ticker_scores, self.equal_weights)
        assert abs(score - DEFAULT_SCORE) < 1e-9

    def test_total_above_100_clamped(self):
        ticker_scores = {axis: {"total": 200.0} for axis in AXES}
        score = self.s._calc_frontier_score(ticker_scores, self.equal_weights)
        assert abs(score - 100.0) < 1e-9

    def test_total_below_0_clamped(self):
        ticker_scores = {axis: {"total": -50.0} for axis in AXES}
        score = self.s._calc_frontier_score(ticker_scores, self.equal_weights)
        assert abs(score - 0.0) < 1e-9

    def test_total_none_uses_default_score(self):
        ticker_scores = {axis: {"total": None} for axis in AXES}
        score = self.s._calc_frontier_score(ticker_scores, self.equal_weights)
        assert abs(score - DEFAULT_SCORE) < 1e-9

    def test_total_string_uses_default_score(self):
        ticker_scores = {axis: {"total": "bad"} for axis in AXES}
        score = self.s._calc_frontier_score(ticker_scores, self.equal_weights)
        assert abs(score - DEFAULT_SCORE) < 1e-9

    def test_partial_axis_missing_uses_default_for_missing(self):
        # value だけ 100.0、他は欠損 → equal_weights: 各 1/6
        # value 100.0 * 1/6 + 5 axes * 50.0 * 1/6
        ticker_scores = {"value": {"total": 100.0}}
        score = self.s._calc_frontier_score(ticker_scores, self.equal_weights)
        expected = 100.0 * (1.0/6) + 50.0 * (5.0/6)
        assert abs(score - expected) < 1e-9

    def test_axis_weights_explicitly_passed(self):
        # axis_weights に safety のみを含む
        custom_weights = {"safety": 1.0}
        ticker_scores = {"safety": {"total": 75.0}}
        score = self.s._calc_frontier_score(ticker_scores, custom_weights)
        assert abs(score - 75.0) < 1e-9

    def test_zero_axis_weight_produces_zero_contribution(self):
        custom_weights = {axis: 0.0 for axis in AXES}
        custom_weights["value"] = 1.0
        ticker_scores = {axis: {"total": 80.0} for axis in AXES}
        score = self.s._calc_frontier_score(ticker_scores, custom_weights)
        assert abs(score - 80.0) < 1e-9


# ── CLASS: _build_score_weights ───────────────────────────────────────────────

class TestBuildScoreWeights:
    def setup_method(self):
        self.s = FrontierStrategy()
        self.axis_weights = {axis: 1.0 / 6 for axis in AXES}

    def test_all_tickers_present(self):
        universe = ("A", "B", "C")
        scores = _make_scores(universe, total=60.0)
        result, diag = self.s._build_score_weights(universe, scores, self.axis_weights)
        assert set(result.keys()) == set(universe)

    def test_returns_tuple_of_dict_and_list(self):
        universe = ("A",)
        scores = _make_scores(universe)
        result = self.s._build_score_weights(universe, scores, self.axis_weights)
        assert isinstance(result, tuple)
        assert isinstance(result[0], dict)
        assert isinstance(result[1], list)

    def test_missing_ticker_uses_default_score(self):
        universe = ("MISSING",)
        scores = {}
        result, diag = self.s._build_score_weights(universe, scores, self.axis_weights)
        assert abs(result["MISSING"] - DEFAULT_SCORE) < 1e-9

    def test_missing_ticker_adds_diagnostic(self):
        universe = ("MISSING",)
        scores = {}
        _, diag = self.s._build_score_weights(universe, scores, self.axis_weights)
        joined = " ".join(diag)
        assert "missing" in joined.lower()

    def test_non_dict_score_uses_default(self):
        universe = ("BAD",)
        scores = {"BAD": [1, 2, 3]}
        result, diag = self.s._build_score_weights(universe, scores, self.axis_weights)
        assert abs(result["BAD"] - DEFAULT_SCORE) < 1e-9

    def test_non_dict_score_adds_diagnostic(self):
        universe = ("BAD",)
        scores = {"BAD": "not_a_dict"}
        _, diag = self.s._build_score_weights(universe, scores, self.axis_weights)
        joined = " ".join(diag)
        assert "non-dict" in joined.lower()

    def test_score_propagates_correctly(self):
        universe = ("X",)
        scores = {"X": {axis: {"total": 100.0} for axis in AXES}}
        result, _ = self.s._build_score_weights(universe, scores, self.axis_weights)
        assert abs(result["X"] - 100.0) < 1e-9

    def test_no_diagnostics_when_all_valid(self):
        universe = ("A", "B")
        scores = _make_scores(universe)
        _, diag = self.s._build_score_weights(universe, scores, self.axis_weights)
        assert diag == []


# ── CLASS: _normalize_weights / _to_ideal_pf_tuple (via BaseStrategy) ─────────

class TestNormalizeAndIdealPf:
    def setup_method(self):
        self.s = FrontierStrategy()

    def test_normalize_sums_to_one(self):
        weights = {"A": 30.0, "B": 70.0}
        result = self.s._normalize_weights(weights)
        assert abs(sum(result.values()) - 1.0) < 1e-9

    def test_normalize_empty_returns_empty(self):
        result = self.s._normalize_weights({})
        assert result == {}

    def test_normalize_all_zero_equal_weight(self):
        weights = {"A": 0.0, "B": 0.0, "C": 0.0}
        result = self.s._normalize_weights(weights)
        for v in result.values():
            assert abs(v - 1.0/3) < 1e-9

    def test_to_ideal_pf_tuple_type(self):
        weights = {"A": 0.5, "B": 0.5}
        result = self.s._to_ideal_pf_tuple(weights)
        assert isinstance(result, tuple)
        assert all(isinstance(item, tuple) for item in result)

    def test_to_ideal_pf_tuple_values(self):
        weights = {"A": 0.6, "B": 0.4}
        result = self.s._to_ideal_pf_tuple(weights)
        result_dict = dict(result)
        assert abs(result_dict["A"] - 0.6) < 1e-9
        assert abs(result_dict["B"] - 0.4) < 1e-9


# ── CLASS: weight proportionality ────────────────────────────────────────────

class TestWeightProportionality:
    def setup_method(self):
        self.s = FrontierStrategy()

    def test_higher_score_ticker_gets_higher_weight(self):
        universe = ("HIGH", "LOW")
        scores = {
            "HIGH": {axis: {"total": 90.0} for axis in AXES},
            "LOW":  {axis: {"total": 10.0} for axis in AXES},
        }
        inp = StrategyInput(universe=universe, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        weights = dict(out.ideal_pf)
        assert weights["HIGH"] > weights["LOW"]

    def test_proportional_weights_ratio(self):
        universe = ("DOUBLE", "SINGLE")
        scores = {
            "DOUBLE": {axis: {"total": 80.0} for axis in AXES},
            "SINGLE": {axis: {"total": 40.0} for axis in AXES},
        }
        inp = StrategyInput(universe=universe, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        weights = dict(out.ideal_pf)
        ratio = weights["DOUBLE"] / weights["SINGLE"]
        assert abs(ratio - 2.0) < 1e-6

    def test_all_zero_score_equal_weight(self):
        universe = ("A", "B", "C")
        scores = {
            ticker: {axis: {"total": 0.0} for axis in AXES}
            for ticker in universe
        }
        inp = StrategyInput(universe=universe, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        weights = [w for _, w in out.ideal_pf]
        for w in weights:
            assert abs(w - 1.0/3) < 1e-9


# ── CLASS: import safety (engine.regime 禁止) ─────────────────────────────────

class TestImportSafety:
    def test_does_not_import_engine_regime_directly(self):
        """
        frontier_strategy は engine.regime を直接 import してはならない。
        engine.dynamic_weight.regime_axis_weights は許可（軸重み取得のため）。
        """
        module = importlib.import_module("engine.strategies.frontier_strategy")
        # 直接 engine.regime を参照していないことを確認
        # engine.dynamic_weight.regime_axis_weights 経由は許可
        assert not hasattr(module, "engine_regime"), \
            "engine.regime を直接 import している可能性があります"

    def test_get_axis_weights_importable_from_frontier(self):
        """dynamic_weight.regime_axis_weights.get_axis_weights は import 可能であること。"""
        module = importlib.import_module("engine.strategies.frontier_strategy")
        assert hasattr(module, "get_axis_weights")

    def test_no_action_fields_in_output(self):
        s = FrontierStrategy()
        out = s.compute(_make_input())
        forbidden = [
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "verdict", "decision", "rating",
            "approve", "reject", "conditional",
        ]
        for field in forbidden:
            assert not hasattr(out, field), f"禁止フィールド {field!r} が存在します"


# ── CLASS: StrategyOutput field validation ────────────────────────────────────

class TestOutputFieldValidation:
    def setup_method(self):
        self.s = FrontierStrategy()

    def test_ideal_pf_is_tuple(self):
        out = self.s.compute(_make_input())
        assert isinstance(out.ideal_pf, tuple)

    def test_diagnostics_is_tuple(self):
        out = self.s.compute(_make_input())
        assert isinstance(out.diagnostics, tuple)

    def test_expected_return_is_float(self):
        out = self.s.compute(_make_input())
        assert isinstance(out.expected_return, float)

    def test_expected_vol_nonnegative(self):
        out = self.s.compute(_make_input())
        assert out.expected_vol >= 0.0

    def test_max_dd_nonpositive(self):
        out = self.s.compute(_make_input())
        assert out.max_dd_estimate <= 0.0

    def test_sharpe_ratio_is_float(self):
        out = self.s.compute(_make_input())
        assert isinstance(out.sharpe_ratio, float)

    def test_rationale_is_str(self):
        out = self.s.compute(_make_input())
        assert isinstance(out.rationale, str)

    @pytest.mark.parametrize("regime", ["bull_calm", "bull_volatile", "bear", "crisis", "uncertain"])
    def test_sharpe_consistency(self, regime):
        out = self.s.compute(_make_input(regime=regime))
        if out.expected_vol > 0.0:
            expected = out.expected_return / out.expected_vol
            assert abs(out.sharpe_ratio - expected) < 1e-9

    def test_no_nan_in_numeric_fields(self):
        out = self.s.compute(_make_input())
        assert not math.isnan(out.expected_return)
        assert not math.isnan(out.expected_vol)
        assert not math.isnan(out.sharpe_ratio)
        assert not math.isnan(out.max_dd_estimate)
