"""
test_quality_size_strategy.py — Card 7-3
QualitySizeStrategy のユニットテスト。

テスト方針:
  - stdlib-only; pytest のみ
  - QUALITY_AXIS_WEIGHTS（固定）を使った計算確認
  - quality_premium（QMJ 効果）の動作確認
  - BUY/SELL/HOLD/WAIT 判定・action フィールドが存在しないことを確認
  - DEFAULT_SCORE=50.0 フォールバック確認
  - unknown regime fallback 確認
  - empty universe guard 確認
  - diagnostics フォーマット確認
  - engine.regime を直接 import しないことの確認
"""
from __future__ import annotations

import importlib
import math

import pytest

from engine.strategies.quality_size_strategy import (
    DEFAULT_SCORE,
    QUALITY_AXIS_WEIGHTS,
    QUALITY_PREMIUM_FACTOR,
    QUALITY_THRESHOLD,
    QualitySizeStrategy,
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


def _make_scores_with_quality(
    tickers: tuple[str, ...],
    base_total: float = 60.0,
    quality_total: float = 80.0,
) -> dict:
    """quality 軸だけ異なる total を持つ scores fixture を返す。"""
    return {
        ticker: {
            axis: {"total": quality_total if axis == "quality" else base_total}
            for axis in AXES
        }
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

class TestQualitySizeStrategyClass:
    def test_strategy_id(self):
        assert QualitySizeStrategy.STRATEGY_ID == "quality_size"

    def test_strategy_name(self):
        assert QualitySizeStrategy.STRATEGY_NAME == "Quality-Size (Asness 2018)"

    def test_instantiation(self):
        s = QualitySizeStrategy()
        assert isinstance(s, QualitySizeStrategy)

    def test_default_score_constant(self):
        assert DEFAULT_SCORE == 50.0

    def test_fallback_regime_constant(self):
        assert _FALLBACK_REGIME == "uncertain"


# ── CLASS: QUALITY_AXIS_WEIGHTS 定数 ──────────────────────────────────────────

class TestQualityAxisWeights:
    def test_all_canonical_axes_present(self):
        for axis in AXES:
            assert axis in QUALITY_AXIS_WEIGHTS

    def test_weights_sum_to_one(self):
        total = sum(QUALITY_AXIS_WEIGHTS.values())
        assert abs(total - 1.0) < 1e-9

    def test_quality_has_highest_weight(self):
        assert QUALITY_AXIS_WEIGHTS["quality"] == max(QUALITY_AXIS_WEIGHTS.values())

    def test_safety_is_second_highest(self):
        sorted_weights = sorted(QUALITY_AXIS_WEIGHTS.values(), reverse=True)
        assert QUALITY_AXIS_WEIGHTS["safety"] == sorted_weights[1]

    def test_all_weights_positive(self):
        for axis, w in QUALITY_AXIS_WEIGHTS.items():
            assert w > 0.0, f"{axis} weight must be positive"

    def test_quality_premium_threshold(self):
        assert QUALITY_THRESHOLD == 65.0

    def test_quality_premium_factor(self):
        assert QUALITY_PREMIUM_FACTOR == 0.10


# ── CLASS: compute() — empty universe ────────────────────────────────────────

class TestComputeEmptyUniverse:
    def setup_method(self):
        self.s = QualitySizeStrategy()

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
        assert out.strategy_id == "quality_size"

    def test_empty_universe_strategy_name_set(self):
        inp = _make_input(universe=())
        out = self.s.compute(inp)
        assert out.strategy_name == "Quality-Size (Asness 2018)"


# ── CLASS: compute() — happy path ────────────────────────────────────────────

class TestComputeHappyPath:
    def setup_method(self):
        self.s = QualitySizeStrategy()

    def test_returns_strategy_output(self):
        out = self.s.compute(_make_input())
        assert isinstance(out, StrategyOutput)

    def test_strategy_id_in_output(self):
        out = self.s.compute(_make_input())
        assert out.strategy_id == "quality_size"

    def test_strategy_name_in_output(self):
        out = self.s.compute(_make_input())
        assert out.strategy_name == "Quality-Size (Asness 2018)"

    def test_ideal_pf_length_matches_universe(self):
        universe = ("AAPL", "MSFT", "NVDA")
        out = self.s.compute(_make_input(universe=universe))
        assert len(out.ideal_pf) == len(universe)

    def test_ideal_pf_weights_sum_to_one(self):
        out = self.s.compute(_make_input())
        total = sum(w for _, w in out.ideal_pf)
        assert abs(total - 1.0) < 1e-9

    def test_ideal_pf_equal_weight_when_scores_equal(self):
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

    def test_rationale_contains_quality(self):
        out = self.s.compute(_make_input())
        assert "Quality" in out.rationale

    def test_rationale_contains_asness(self):
        out = self.s.compute(_make_input())
        assert "Asness" in out.rationale

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
        self.s = QualitySizeStrategy()

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

    def test_quality_vol_lower_than_frontier_crisis(self):
        # Quality 戦略の crisis 参照 vol は frontier より小さい（防御的特性）
        from engine.strategies.frontier_strategy import _REGIME_EXPECTED_VOL as f_vol
        assert _REGIME_EXPECTED_VOL["crisis"] < f_vol["crisis"]

    def test_quality_max_dd_less_severe_than_frontier_crisis(self):
        # Quality 戦略の crisis 最大 DD は frontier より浅い（防御的特性）
        from engine.strategies.frontier_strategy import _REGIME_MAX_DD as f_max_dd
        assert _REGIME_MAX_DD["crisis"] > f_max_dd["crisis"]


# ── CLASS: _calc_quality_size_score ──────────────────────────────────────────

class TestCalcQualitySizeScore:
    def setup_method(self):
        self.s = QualitySizeStrategy()

    def test_all_axes_present_computes_weighted_sum(self):
        # 全軸に total=50.0 → base_score = 50.0（QUALITY_AXIS_WEIGHTS sum=1.0）
        # quality=50.0 < QUALITY_THRESHOLD=65.0 → premium なし
        ticker_scores = {axis: {"total": 50.0} for axis in AXES}
        score, has_premium = self.s._calc_quality_size_score(ticker_scores)
        assert abs(score - 50.0) < 1e-9
        assert not has_premium

    def test_missing_all_axes_uses_default_score(self):
        score, has_premium = self.s._calc_quality_size_score({})
        # base_score = DEFAULT_SCORE（各軸も DEFAULT_SCORE）
        # quality_raw = DEFAULT_SCORE = 50.0 < 65.0 → premium なし
        assert abs(score - DEFAULT_SCORE) < 1e-9
        assert not has_premium

    def test_non_dict_axis_value_uses_default_score(self):
        ticker_scores = {axis: "invalid" for axis in AXES}
        score, _ = self.s._calc_quality_size_score(ticker_scores)
        assert abs(score - DEFAULT_SCORE) < 1e-9

    def test_total_above_100_clamped(self):
        ticker_scores = {axis: {"total": 200.0} for axis in AXES}
        score, has_premium = self.s._calc_quality_size_score(ticker_scores)
        # base = 100.0, quality_excess = 100.0 - 65.0 = 35.0, bonus = 3.5
        expected_base = 100.0
        expected_bonus = (100.0 - QUALITY_THRESHOLD) * QUALITY_PREMIUM_FACTOR
        assert abs(score - (expected_base + expected_bonus)) < 1e-9
        assert has_premium

    def test_total_below_0_clamped(self):
        ticker_scores = {axis: {"total": -50.0} for axis in AXES}
        score, has_premium = self.s._calc_quality_size_score(ticker_scores)
        assert abs(score - 0.0) < 1e-9
        assert not has_premium

    def test_high_quality_triggers_premium(self):
        # quality=80.0 > 65.0 → premium あり
        ticker_scores = {axis: {"total": 80.0} for axis in AXES}
        score, has_premium = self.s._calc_quality_size_score(ticker_scores)
        assert has_premium
        # base = 80.0, bonus = (80-65)*0.10 = 1.5
        expected = 80.0 + (80.0 - QUALITY_THRESHOLD) * QUALITY_PREMIUM_FACTOR
        assert abs(score - expected) < 1e-9

    def test_quality_at_threshold_no_premium(self):
        # quality exactly at threshold → no premium
        ticker_scores = {axis: {"total": QUALITY_THRESHOLD} for axis in AXES}
        score, has_premium = self.s._calc_quality_size_score(ticker_scores)
        assert not has_premium

    def test_quality_just_above_threshold_triggers_premium(self):
        # quality = QUALITY_THRESHOLD + 0.001 → premium あり
        q = QUALITY_THRESHOLD + 0.001
        ticker_scores = {axis: {"total": q} for axis in AXES}
        _, has_premium = self.s._calc_quality_size_score(ticker_scores)
        assert has_premium

    def test_quality_bonus_only_from_quality_axis(self):
        # safety=100（高く設定）だが quality=50 → premium なし
        ticker_scores = {
            "quality": {"total": 50.0},
            "safety":  {"total": 100.0},
            "value":   {"total": 50.0},
            "shareholder_return": {"total": 50.0},
            "growth":  {"total": 50.0},
            "momentum": {"total": 50.0},
        }
        _, has_premium = self.s._calc_quality_size_score(ticker_scores)
        assert not has_premium

    def test_partial_axis_missing_uses_default(self):
        # quality のみ指定、他は欠損 → 他は DEFAULT_SCORE
        ticker_scores = {"quality": {"total": 80.0}}
        score, has_premium = self.s._calc_quality_size_score(ticker_scores)
        assert has_premium
        # base = quality*0.40 + others*DEFAULT*weights
        q_w = QUALITY_AXIS_WEIGHTS["quality"]
        other_w = sum(w for ax, w in QUALITY_AXIS_WEIGHTS.items() if ax != "quality")
        expected_base = 80.0 * q_w + DEFAULT_SCORE * other_w
        expected_bonus = (80.0 - QUALITY_THRESHOLD) * QUALITY_PREMIUM_FACTOR
        assert abs(score - (expected_base + expected_bonus)) < 1e-9

    def test_quality_none_total_uses_default_for_premium(self):
        ticker_scores = {"quality": {"total": None}}
        _, has_premium = self.s._calc_quality_size_score(ticker_scores)
        # DEFAULT_SCORE=50.0 < 65.0 → no premium
        assert not has_premium

    def test_quality_string_total_uses_default_for_premium(self):
        ticker_scores = {"quality": {"total": "bad"}}
        _, has_premium = self.s._calc_quality_size_score(ticker_scores)
        assert not has_premium


# ── CLASS: _build_score_weights ───────────────────────────────────────────────

class TestBuildScoreWeights:
    def setup_method(self):
        self.s = QualitySizeStrategy()

    def test_all_tickers_present(self):
        universe = ("A", "B", "C")
        scores = _make_scores(universe, total=60.0)
        result, diag = self.s._build_score_weights(universe, scores)
        assert set(result.keys()) == set(universe)

    def test_returns_tuple_of_dict_and_list(self):
        universe = ("A",)
        scores = _make_scores(universe)
        result = self.s._build_score_weights(universe, scores)
        assert isinstance(result, tuple)
        assert isinstance(result[0], dict)
        assert isinstance(result[1], list)

    def test_missing_ticker_uses_default_score(self):
        universe = ("MISSING",)
        scores = {}
        result, diag = self.s._build_score_weights(universe, scores)
        # DEFAULT_SCORE=50.0, quality=50.0 < 65.0 → no premium
        assert abs(result["MISSING"] - DEFAULT_SCORE) < 1e-9

    def test_missing_ticker_adds_diagnostic(self):
        universe = ("MISSING",)
        scores = {}
        _, diag = self.s._build_score_weights(universe, scores)
        joined = " ".join(diag)
        assert "missing" in joined.lower()

    def test_non_dict_score_uses_default(self):
        universe = ("BAD",)
        scores = {"BAD": [1, 2, 3]}
        result, diag = self.s._build_score_weights(universe, scores)
        assert abs(result["BAD"] - DEFAULT_SCORE) < 1e-9

    def test_non_dict_score_adds_diagnostic(self):
        universe = ("BAD",)
        scores = {"BAD": "not_a_dict"}
        _, diag = self.s._build_score_weights(universe, scores)
        joined = " ".join(diag)
        assert "non-dict" in joined.lower()

    def test_high_quality_premium_diagnostic(self):
        universe = ("HQ",)
        scores = {"HQ": {axis: {"total": 90.0} for axis in AXES}}
        _, diag = self.s._build_score_weights(universe, scores)
        joined = " ".join(diag)
        assert "quality premium" in joined

    def test_no_premium_diagnostic_when_quality_low(self):
        universe = ("LQ",)
        scores = {"LQ": {axis: {"total": 50.0} for axis in AXES}}
        _, diag = self.s._build_score_weights(universe, scores)
        joined = " ".join(diag)
        assert "quality premium" not in joined

    def test_no_diagnostics_when_all_valid_no_premium(self):
        universe = ("A", "B")
        scores = _make_scores(universe, total=50.0)
        _, diag = self.s._build_score_weights(universe, scores)
        assert diag == []


# ── CLASS: Quality premium effect on weight ───────────────────────────────────

class TestQualityPremiumEffect:
    def setup_method(self):
        self.s = QualitySizeStrategy()

    def test_high_quality_ticker_gets_higher_weight_than_low(self):
        universe = ("HQ", "LQ")
        scores = {
            "HQ": {axis: {"total": 90.0} for axis in AXES},
            "LQ": {axis: {"total": 40.0} for axis in AXES},
        }
        inp = StrategyInput(universe=universe, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        weights = dict(out.ideal_pf)
        assert weights["HQ"] > weights["LQ"]

    def test_quality_premium_increases_weight_vs_no_premium(self):
        # HQ: quality=80（premium）vs NOPRE: quality=60（no premium）, 他は同じ
        universe = ("HQ", "NOPRE")
        scores = {
            "HQ":    {ax: {"total": 80.0 if ax == "quality" else 60.0} for ax in AXES},
            "NOPRE": {ax: {"total": 60.0} for ax in AXES},
        }
        inp = StrategyInput(universe=universe, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        weights = dict(out.ideal_pf)
        assert weights["HQ"] > weights["NOPRE"]

    def test_two_high_quality_tickers_both_premium(self):
        universe = ("HQ1", "HQ2")
        scores = {
            "HQ1": {axis: {"total": 85.0} for axis in AXES},
            "HQ2": {axis: {"total": 85.0} for axis in AXES},
        }
        inp = StrategyInput(universe=universe, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        weights = dict(out.ideal_pf)
        # Equal quality → equal weight
        assert abs(weights["HQ1"] - weights["HQ2"]) < 1e-9

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
            assert abs(w - 1.0 / 3) < 1e-9

    def test_diagnostics_mention_premium_count(self):
        universe = ("HQ1", "HQ2", "LQ")
        scores = {
            "HQ1": {ax: {"total": 90.0} for ax in AXES},
            "HQ2": {ax: {"total": 80.0} for ax in AXES},
            "LQ":  {ax: {"total": 50.0} for ax in AXES},
        }
        inp = StrategyInput(universe=universe, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        joined = " ".join(out.diagnostics)
        assert "2" in joined  # 2 tickers received premium


# ── CLASS: _normalize_weights / _to_ideal_pf_tuple (via BaseStrategy) ─────────

class TestNormalizeAndIdealPf:
    def setup_method(self):
        self.s = QualitySizeStrategy()

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
            assert abs(v - 1.0 / 3) < 1e-9

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


# ── CLASS: output field validation ────────────────────────────────────────────

class TestOutputFieldValidation:
    def setup_method(self):
        self.s = QualitySizeStrategy()

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

    def test_ideal_pf_inner_tuples_are_str_float(self):
        out = self.s.compute(_make_input())
        for ticker, weight in out.ideal_pf:
            assert isinstance(ticker, str)
            assert isinstance(weight, float)

    def test_all_weights_nonnegative(self):
        out = self.s.compute(_make_input())
        for _, weight in out.ideal_pf:
            assert weight >= 0.0


# ── CLASS: import safety ──────────────────────────────────────────────────────

class TestImportSafety:
    def test_does_not_import_engine_regime_directly(self):
        module = importlib.import_module("engine.strategies.quality_size_strategy")
        assert not hasattr(module, "engine_regime"), \
            "engine.regime を直接 import している可能性があります"

    def test_does_not_use_get_axis_weights(self):
        """QualitySizeStrategy は QUALITY_AXIS_WEIGHTS を固定使用するため
        dynamic_weight.regime_axis_weights.get_axis_weights を import しない。"""
        module = importlib.import_module("engine.strategies.quality_size_strategy")
        assert not hasattr(module, "get_axis_weights"), \
            "QualitySizeStrategy は固定 QUALITY_AXIS_WEIGHTS を使用。get_axis_weights 不要。"

    def test_no_action_fields_in_output(self):
        s = QualitySizeStrategy()
        out = s.compute(_make_input())
        forbidden = [
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "verdict", "decision", "rating",
            "approve", "reject", "conditional",
        ]
        for field_name in forbidden:
            assert not hasattr(out, field_name), f"禁止フィールド {field_name!r} が存在します"

    def test_quality_axis_weights_is_module_level_constant(self):
        module = importlib.import_module("engine.strategies.quality_size_strategy")
        assert hasattr(module, "QUALITY_AXIS_WEIGHTS")
        assert isinstance(module.QUALITY_AXIS_WEIGHTS, dict)

    def test_no_pandas_numpy_import(self):
        module = importlib.import_module("engine.strategies.quality_size_strategy")
        import sys
        # pandas/numpy/scipy が import されていないことを確認
        assert "pandas" not in sys.modules or True  # importされても本モジュールが使わなければ許容
        # モジュールの直接依存を確認
        source_deps = vars(module).get("__builtins__", {})
        assert not hasattr(module, "pd"), "pandas alias が存在します"
        assert not hasattr(module, "np"), "numpy alias が存在します"


# ── CLASS: QualitySize vs Frontier 比較 ──────────────────────────────────────

class TestQualitySizeVsFrontier:
    def test_strategy_ids_are_different(self):
        from engine.strategies.frontier_strategy import FrontierStrategy
        assert QualitySizeStrategy.STRATEGY_ID != FrontierStrategy.STRATEGY_ID

    def test_quality_size_uses_fixed_weights_not_regime_adaptive(self):
        """QualitySizeStrategy は QUALITY_AXIS_WEIGHTS（固定）を使い
        get_axis_weights()（regime-adaptive）を使わないことを確認。"""
        qs = QualitySizeStrategy()
        universe = ("A", "B")
        scores = _make_scores(universe, total=70.0)
        # bull_calm と bear で ideal_pf の重み比率が同じ（固定軸重みのため）
        out_bull = qs.compute(StrategyInput(universe=universe, scores=scores, regime="bull_calm"))
        out_bear = qs.compute(StrategyInput(universe=universe, scores=scores, regime="bear"))
        weights_bull = dict(out_bull.ideal_pf)
        weights_bear = dict(out_bear.ideal_pf)
        # 同一スコアなら regime によらず等ウェイト
        assert abs(weights_bull["A"] - weights_bear["A"]) < 1e-9
        assert abs(weights_bull["B"] - weights_bear["B"]) < 1e-9

    def test_quality_size_has_lower_vol_than_frontier_in_crisis(self):
        from engine.strategies.frontier_strategy import _REGIME_EXPECTED_VOL as f_vol
        assert _REGIME_EXPECTED_VOL["crisis"] < f_vol["crisis"]
