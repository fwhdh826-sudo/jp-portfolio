"""
test_cross_factor_strategy.py — Card 7-5
CrossFactorStrategy のユニットテスト。

テスト方針:
  - stdlib-only; pytest のみ
  - CROSS_SIGNAL_WEIGHTS（固定4シグナル）を使った計算確認
  - TOP_N_CAP_CF（universe > 25 のみ適用）の動作確認
  - 等加重選択（score-proportional ではない）の確認
  - size_signal の解決（scores / context / default）の確認
  - all-zero cross-factor score fallback の確認
  - BUY/SELL/HOLD/WAIT 判定・action フィールドが存在しないことを確認
  - DEFAULT_SCORE=50.0 フォールバック確認
  - unknown regime fallback 確認
  - empty universe guard 確認
  - diagnostics の「calculation-only / not a recommendation」趣旨の確認
  - engine.regime / get_axis_weights を直接 import しないことの確認
  - STRATEGY_ID が VALID_STRATEGY_IDS に含まれることの確認
"""
from __future__ import annotations

import importlib
import math

import pytest

from engine.strategies.cross_factor_strategy import (
    CROSS_SIGNAL_WEIGHTS,
    DEFAULT_SCORE,
    DEFAULT_SIZE_SIGNAL,
    SIZE_SIGNAL_MAP,
    TOP_N_CAP_CF,
    CrossFactorStrategy,
    _FALLBACK_REGIME,
    _REGIME_EXPECTED_RETURN,
    _REGIME_EXPECTED_VOL,
    _REGIME_MAX_DD,
)
from engine.strategies.base_strategy import (
    VALID_STRATEGY_IDS,
    StrategyInput,
    StrategyOutput,
)


# ── fixtures ──────────────────────────────────────────────────────────────────

ALL_AXES = ("value", "quality", "growth", "safety", "momentum", "shareholder_return")
CROSS_AXES = ("quality", "value", "momentum")  # 今回 score 計算で使う軸


def _make_scores(
    tickers: tuple[str, ...],
    total: float = 80.0,
) -> dict:
    """全銘柄・全軸に同一 total を持つ scores fixture を返す。"""
    return {
        ticker: {axis: {"total": total} for axis in ALL_AXES}
        for ticker in tickers
    }


def _make_cross_scores(
    tickers: tuple[str, ...],
    quality: float = 80.0,
    value: float = 70.0,
    momentum: float = 75.0,
    size_segment: str | None = None,
) -> dict:
    """cross-axis で使う軸だけ指定する scores fixture を返す。"""
    result = {}
    for ticker in tickers:
        d: dict = {
            "quality":  {"total": quality},
            "value":    {"total": value},
            "momentum": {"total": momentum},
        }
        if size_segment is not None:
            d["size_segment"] = size_segment
        result[ticker] = d
    return result


def _make_input(
    universe: tuple[str, ...] = ("AAPL", "MSFT", "NVDA"),
    regime: str = "bull_calm",
    scores: dict | None = None,
    context: dict | None = None,
) -> StrategyInput:
    if scores is None:
        scores = _make_scores(universe)
    if context is None:
        context = {}
    return StrategyInput(universe=universe, scores=scores, regime=regime, context=context)


def _make_large_universe(n: int, total: float = 80.0) -> tuple[tuple[str, ...], dict]:
    """n 銘柄のユニバースと scores を作成する。"""
    tickers = tuple(f"T{i:04d}" for i in range(n))
    scores = _make_scores(tickers, total=total)
    return tickers, scores


# ── CLASS: インスタンス化・属性 ───────────────────────────────────────────────

class TestCrossFactorStrategyClass:
    def test_strategy_id(self):
        assert CrossFactorStrategy.STRATEGY_ID == "cross_factor"

    def test_strategy_name(self):
        assert CrossFactorStrategy.STRATEGY_NAME == "Cross-Factor (Alquist 2018)"

    def test_instantiation(self):
        s = CrossFactorStrategy()
        assert isinstance(s, CrossFactorStrategy)

    def test_default_score_constant(self):
        assert DEFAULT_SCORE == 50.0

    def test_default_size_signal_constant(self):
        assert DEFAULT_SIZE_SIGNAL == 50.0

    def test_top_n_cap_cf_constant(self):
        assert TOP_N_CAP_CF == 25

    def test_strategy_id_in_valid_ids(self):
        assert CrossFactorStrategy.STRATEGY_ID in VALID_STRATEGY_IDS


# ── CLASS: CROSS_SIGNAL_WEIGHTS 定数 ─────────────────────────────────────────

class TestCrossSignalWeights:
    def test_four_signals_present(self):
        for sig in ("size_quality", "size_value", "size_momentum", "quality_value"):
            assert sig in CROSS_SIGNAL_WEIGHTS

    def test_weights_sum_to_one(self):
        total = sum(CROSS_SIGNAL_WEIGHTS.values())
        assert abs(total - 1.0) < 1e-9

    def test_size_quality_weight(self):
        assert abs(CROSS_SIGNAL_WEIGHTS["size_quality"] - 0.30) < 1e-9

    def test_size_value_weight(self):
        assert abs(CROSS_SIGNAL_WEIGHTS["size_value"] - 0.25) < 1e-9

    def test_size_momentum_weight(self):
        assert abs(CROSS_SIGNAL_WEIGHTS["size_momentum"] - 0.25) < 1e-9

    def test_quality_value_weight(self):
        assert abs(CROSS_SIGNAL_WEIGHTS["quality_value"] - 0.20) < 1e-9

    def test_all_weights_positive(self):
        for sig, w in CROSS_SIGNAL_WEIGHTS.items():
            assert w > 0.0, f"{sig} weight must be positive"

    def test_exactly_four_signals(self):
        assert len(CROSS_SIGNAL_WEIGHTS) == 4

    def test_size_signal_map_keys(self):
        assert set(SIZE_SIGNAL_MAP.keys()) == {"small_cap", "mid_cap", "large_cap"}

    def test_size_signal_map_values(self):
        assert SIZE_SIGNAL_MAP["small_cap"] == 80.0
        assert SIZE_SIGNAL_MAP["mid_cap"]   == 50.0
        assert SIZE_SIGNAL_MAP["large_cap"] == 30.0


# ── CLASS: compute() — empty universe ────────────────────────────────────────

class TestComputeEmptyUniverse:
    def setup_method(self):
        self.s = CrossFactorStrategy()

    def test_empty_universe_returns_output(self):
        out = self.s.compute(_make_input(universe=()))
        assert isinstance(out, StrategyOutput)

    def test_empty_universe_ideal_pf_empty(self):
        out = self.s.compute(_make_input(universe=()))
        assert out.ideal_pf == ()

    def test_empty_universe_expected_return_zero(self):
        out = self.s.compute(_make_input(universe=()))
        assert out.expected_return == 0.0

    def test_empty_universe_expected_vol_zero(self):
        out = self.s.compute(_make_input(universe=()))
        assert out.expected_vol == 0.0

    def test_empty_universe_sharpe_zero(self):
        out = self.s.compute(_make_input(universe=()))
        assert out.sharpe_ratio == 0.0

    def test_empty_universe_max_dd_zero(self):
        out = self.s.compute(_make_input(universe=()))
        assert out.max_dd_estimate == 0.0

    def test_empty_universe_diagnostics_contains_empty(self):
        out = self.s.compute(_make_input(universe=()))
        joined = " ".join(out.diagnostics)
        assert "universe is empty" in joined

    def test_empty_universe_diagnostics_contains_reference_values(self):
        out = self.s.compute(_make_input(universe=()))
        joined = " ".join(out.diagnostics)
        assert "reference values" in joined

    def test_empty_universe_strategy_id_set(self):
        out = self.s.compute(_make_input(universe=()))
        assert out.strategy_id == "cross_factor"

    def test_empty_universe_strategy_name_set(self):
        out = self.s.compute(_make_input(universe=()))
        assert out.strategy_name == "Cross-Factor (Alquist 2018)"


# ── CLASS: compute() — happy path ────────────────────────────────────────────

class TestComputeHappyPath:
    def setup_method(self):
        self.s = CrossFactorStrategy()

    def test_returns_strategy_output(self):
        out = self.s.compute(_make_input())
        assert isinstance(out, StrategyOutput)

    def test_strategy_id_in_output(self):
        out = self.s.compute(_make_input())
        assert out.strategy_id == "cross_factor"

    def test_strategy_name_in_output(self):
        out = self.s.compute(_make_input())
        assert out.strategy_name == "Cross-Factor (Alquist 2018)"

    def test_ideal_pf_weights_sum_to_one(self):
        out = self.s.compute(_make_input())
        total = sum(w for _, w in out.ideal_pf)
        assert abs(total - 1.0) < 1e-9

    def test_ideal_pf_all_equal_weight_small_universe(self):
        # universe <= 25 → 全銘柄等加重
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

    def test_rationale_contains_alquist(self):
        out = self.s.compute(_make_input())
        assert "Alquist" in out.rationale

    def test_rationale_contains_calculation_only(self):
        out = self.s.compute(_make_input())
        assert "calculation-only" in out.rationale

    def test_rationale_contains_not_recommendation(self):
        out = self.s.compute(_make_input())
        assert "not a recommendation" in out.rationale

    def test_output_is_frozen(self):
        out = self.s.compute(_make_input())
        with pytest.raises((AttributeError, TypeError)):
            out.strategy_id = "changed"  # type: ignore[misc]

    def test_single_ticker(self):
        universe = ("SOLO",)
        out = self.s.compute(_make_input(universe=universe))
        assert len(out.ideal_pf) == 1
        assert abs(out.ideal_pf[0][1] - 1.0) < 1e-9


# ── CLASS: regime reference values ───────────────────────────────────────────

class TestRegimeReferenceValues:
    def setup_method(self):
        self.s = CrossFactorStrategy()

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

    def test_unknown_regime_fallback_return(self):
        out = self.s.compute(_make_input(regime="unknown_xyz"))
        assert out.expected_return == _REGIME_EXPECTED_RETURN["uncertain"]

    def test_unknown_regime_fallback_vol(self):
        out = self.s.compute(_make_input(regime="unknown_xyz"))
        assert out.expected_vol == _REGIME_EXPECTED_VOL["uncertain"]

    def test_unknown_regime_fallback_max_dd(self):
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

    def test_crisis_vol_lowest_among_strategies(self):
        # CrossFactor crisis vol は4戦略中最低
        from engine.strategies.frontier_strategy import _REGIME_EXPECTED_VOL as f_vol
        from engine.strategies.quality_size_strategy import _REGIME_EXPECTED_VOL as qs_vol
        from engine.strategies.fundamental_weighted_strategy import _REGIME_EXPECTED_VOL as fw_vol
        assert _REGIME_EXPECTED_VOL["crisis"] < qs_vol["crisis"]
        assert _REGIME_EXPECTED_VOL["crisis"] < fw_vol["crisis"]
        assert _REGIME_EXPECTED_VOL["crisis"] < f_vol["crisis"]


# ── CLASS: _calc_cross_factor_score ──────────────────────────────────────────

class TestCalcCrossFactorScore:
    def setup_method(self):
        self.s = CrossFactorStrategy()

    def test_known_values_mid_cap(self):
        # quality=80, value=70, momentum=75, size_signal=50
        # size_quality  = 50*80/100 = 40
        # size_value    = 50*70/100 = 35
        # size_momentum = 50*75/100 = 37.5
        # quality_value = 80*70/100 = 56
        # score = 40*0.30 + 35*0.25 + 37.5*0.25 + 56*0.20
        # = 12.0 + 8.75 + 9.375 + 11.2 = 41.325
        ticker_scores = {
            "quality":  {"total": 80.0},
            "value":    {"total": 70.0},
            "momentum": {"total": 75.0},
        }
        score = self.s._calc_cross_factor_score(ticker_scores, 50.0)
        expected = 40.0*0.30 + 35.0*0.25 + 37.5*0.25 + 56.0*0.20
        assert abs(score - expected) < 1e-9

    def test_small_cap_gives_higher_size_signals(self):
        # size_signal=80 vs 50 → size_quality/value/momentum が大きい
        ticker_scores = {"quality": {"total": 80.0}, "value": {"total": 70.0}, "momentum": {"total": 75.0}}
        score_small = self.s._calc_cross_factor_score(ticker_scores, 80.0)
        score_mid   = self.s._calc_cross_factor_score(ticker_scores, 50.0)
        assert score_small > score_mid

    def test_large_cap_gives_lower_size_signals(self):
        ticker_scores = {"quality": {"total": 80.0}, "value": {"total": 70.0}, "momentum": {"total": 75.0}}
        score_large = self.s._calc_cross_factor_score(ticker_scores, 30.0)
        score_mid   = self.s._calc_cross_factor_score(ticker_scores, 50.0)
        assert score_large < score_mid

    def test_missing_axes_uses_default_score(self):
        score = self.s._calc_cross_factor_score({}, 50.0)
        # quality=value=momentum=DEFAULT=50, size=50
        sq = 50.0*50.0/100.0; sv = 50.0*50.0/100.0; sm = 50.0*50.0/100.0; qv = 50.0*50.0/100.0
        expected = sq*0.30 + sv*0.25 + sm*0.25 + qv*0.20
        assert abs(score - expected) < 1e-9

    def test_growth_does_not_affect_score(self):
        # growth を高くしても score は変わらない
        ts_base = {"quality": {"total": 70.0}, "value": {"total": 60.0}, "momentum": {"total": 65.0}}
        ts_high_growth = {**ts_base, "growth": {"total": 100.0}}
        score_base = self.s._calc_cross_factor_score(ts_base, 50.0)
        score_growth = self.s._calc_cross_factor_score(ts_high_growth, 50.0)
        assert abs(score_base - score_growth) < 1e-9

    def test_safety_does_not_affect_score(self):
        ts_base = {"quality": {"total": 70.0}, "value": {"total": 60.0}, "momentum": {"total": 65.0}}
        ts_high_safety = {**ts_base, "safety": {"total": 100.0}}
        score_base = self.s._calc_cross_factor_score(ts_base, 50.0)
        score_safety = self.s._calc_cross_factor_score(ts_high_safety, 50.0)
        assert abs(score_base - score_safety) < 1e-9

    def test_shareholder_return_does_not_affect_score(self):
        ts_base = {"quality": {"total": 70.0}, "value": {"total": 60.0}, "momentum": {"total": 65.0}}
        ts_high_sr = {**ts_base, "shareholder_return": {"total": 100.0}}
        score_base = self.s._calc_cross_factor_score(ts_base, 50.0)
        score_sr = self.s._calc_cross_factor_score(ts_high_sr, 50.0)
        assert abs(score_base - score_sr) < 1e-9

    def test_total_above_100_clamped(self):
        ts = {"quality": {"total": 200.0}, "value": {"total": 200.0}, "momentum": {"total": 200.0}}
        score = self.s._calc_cross_factor_score(ts, 50.0)
        # clamped to 100
        sq = 50.0*100.0/100.0; sv = 50.0*100.0/100.0; sm = 50.0*100.0/100.0; qv = 100.0*100.0/100.0
        expected = sq*0.30 + sv*0.25 + sm*0.25 + qv*0.20
        assert abs(score - expected) < 1e-9

    def test_total_below_0_clamped(self):
        ts = {"quality": {"total": -50.0}, "value": {"total": -50.0}, "momentum": {"total": -50.0}}
        score = self.s._calc_cross_factor_score(ts, 50.0)
        assert abs(score - 0.0) < 1e-9

    def test_none_total_uses_default(self):
        ts = {"quality": {"total": None}, "value": {"total": None}, "momentum": {"total": None}}
        score = self.s._calc_cross_factor_score(ts, 50.0)
        # same as missing
        expected = self.s._calc_cross_factor_score({}, 50.0)
        assert abs(score - expected) < 1e-9

    def test_quality_value_interaction(self):
        # quality_value = quality * value / 100
        ts = {"quality": {"total": 100.0}, "value": {"total": 100.0}, "momentum": {"total": 0.0}}
        score = self.s._calc_cross_factor_score(ts, 0.0)
        # size_quality=0, size_value=0, size_momentum=0, quality_value=100
        expected = 100.0 * 0.20
        assert abs(score - expected) < 1e-9

    def test_size_quality_interaction(self):
        # size_quality = size_signal * quality / 100
        ts = {"quality": {"total": 100.0}, "value": {"total": 0.0}, "momentum": {"total": 0.0}}
        score = self.s._calc_cross_factor_score(ts, 80.0)
        # size_quality=80, size_value=0, size_momentum=0, quality_value=0
        expected = 80.0 * 0.30
        assert abs(score - expected) < 1e-9

    def test_non_dict_axis_uses_default(self):
        ts = {"quality": "invalid", "value": "invalid", "momentum": "invalid"}
        score = self.s._calc_cross_factor_score(ts, 50.0)
        expected = self.s._calc_cross_factor_score({}, 50.0)
        assert abs(score - expected) < 1e-9

    def test_zero_size_signal_eliminates_size_signals(self):
        # size_signal=0 → size_quality/value/momentum = 0
        ts = {"quality": {"total": 80.0}, "value": {"total": 70.0}, "momentum": {"total": 75.0}}
        score = self.s._calc_cross_factor_score(ts, 0.0)
        # only quality_value contributes
        qv = 80.0 * 70.0 / 100.0
        expected = qv * 0.20
        assert abs(score - expected) < 1e-9


# ── CLASS: _resolve_size_signal ───────────────────────────────────────────────

class TestSizeSignalResolution:
    def setup_method(self):
        self.s = CrossFactorStrategy()

    def test_small_cap_from_scores(self):
        scores = {"A": {"size_segment": "small_cap"}}
        sig = self.s._resolve_size_signal("A", scores, {})
        assert sig == 80.0

    def test_mid_cap_from_scores(self):
        scores = {"A": {"size_segment": "mid_cap"}}
        sig = self.s._resolve_size_signal("A", scores, {})
        assert sig == 50.0

    def test_large_cap_from_scores(self):
        scores = {"A": {"size_segment": "large_cap"}}
        sig = self.s._resolve_size_signal("A", scores, {})
        assert sig == 30.0

    def test_scores_priority_over_context(self):
        # scores → small_cap(80), context → large_cap(30) → scores が優先
        scores = {"A": {"size_segment": "small_cap"}}
        context = {"size_segments": {"A": "large_cap"}}
        sig = self.s._resolve_size_signal("A", scores, context)
        assert sig == 80.0

    def test_context_fallback_when_scores_missing(self):
        # scores に size_segment なし → context から取得
        scores = {"A": {"quality": {"total": 80.0}}}
        context = {"size_segments": {"A": "small_cap"}}
        sig = self.s._resolve_size_signal("A", scores, context)
        assert sig == 80.0

    def test_default_when_both_missing(self):
        scores = {"A": {}}
        sig = self.s._resolve_size_signal("A", scores, {})
        assert sig == DEFAULT_SIZE_SIGNAL

    def test_unknown_size_segment_in_scores_uses_default(self):
        scores = {"A": {"size_segment": "nano_cap"}}
        sig = self.s._resolve_size_signal("A", scores, {})
        assert sig == DEFAULT_SIZE_SIGNAL

    def test_non_str_size_segment_in_scores_uses_default(self):
        scores = {"A": {"size_segment": 80}}
        sig = self.s._resolve_size_signal("A", scores, {})
        assert sig == DEFAULT_SIZE_SIGNAL

    def test_context_not_dict_uses_default(self):
        scores = {}
        context = "not_a_dict"
        sig = self.s._resolve_size_signal("A", scores, context)  # type: ignore
        assert sig == DEFAULT_SIZE_SIGNAL

    def test_context_size_segments_not_dict_uses_default(self):
        scores = {}
        context = {"size_segments": "not_a_dict"}
        sig = self.s._resolve_size_signal("A", scores, context)
        assert sig == DEFAULT_SIZE_SIGNAL

    def test_unknown_size_segment_in_context_uses_default(self):
        scores = {}
        context = {"size_segments": {"A": "gigantic_cap"}}
        sig = self.s._resolve_size_signal("A", scores, context)
        assert sig == DEFAULT_SIZE_SIGNAL


# ── CLASS: _select_top_n ─────────────────────────────────────────────────────

class TestSelectTopN:
    def setup_method(self):
        self.s = CrossFactorStrategy()

    def test_universe_at_cap_no_filtering(self):
        weights = {f"T{i:04d}": float(i) for i in range(TOP_N_CAP_CF)}
        result, diag = self.s._select_top_n(weights)
        assert len(result) == TOP_N_CAP_CF
        assert diag == []

    def test_universe_below_cap_no_filtering(self):
        weights = {"A": 1.0, "B": 2.0, "C": 3.0}
        result, diag = self.s._select_top_n(weights)
        assert len(result) == 3
        assert diag == []

    def test_universe_above_cap_filters_to_top_n(self):
        weights = {f"T{i:04d}": float(i) for i in range(TOP_N_CAP_CF + 5)}
        result, diag = self.s._select_top_n(weights)
        assert len(result) == TOP_N_CAP_CF
        assert len(diag) > 0

    def test_universe_one_above_cap_filters(self):
        weights = {f"T{i:04d}": float(i) for i in range(TOP_N_CAP_CF + 1)}
        result, _ = self.s._select_top_n(weights)
        assert len(result) == TOP_N_CAP_CF

    def test_all_weights_are_equal(self):
        # universe <= cap → 全等加重
        weights = {"A": 100.0, "B": 50.0, "C": 10.0}
        result, _ = self.s._select_top_n(weights)
        for w in result.values():
            assert abs(w - 1.0 / 3) < 1e-9

    def test_selected_weights_are_equal(self):
        # universe > cap → 抽出後も全等加重
        n = TOP_N_CAP_CF + 5
        weights = {f"T{i:04d}": float(i) for i in range(n)}
        result, _ = self.s._select_top_n(weights)
        for w in result.values():
            assert abs(w - 1.0 / TOP_N_CAP_CF) < 1e-9

    def test_weights_sum_to_one_small(self):
        weights = {"A": 10.0, "B": 20.0}
        result, _ = self.s._select_top_n(weights)
        assert abs(sum(result.values()) - 1.0) < 1e-9

    def test_weights_sum_to_one_large(self):
        n = TOP_N_CAP_CF + 10
        weights = {f"T{i:04d}": float(i) for i in range(n)}
        result, _ = self.s._select_top_n(weights)
        assert abs(sum(result.values()) - 1.0) < 1e-9

    def test_top_n_keeps_high_scorers(self):
        n = TOP_N_CAP_CF + 5
        weights = {f"T{i:04d}": 1.0 for i in range(n)}
        weights["ZZZHIGH"] = 999.0  # 最高スコア
        result, _ = self.s._select_top_n(weights)
        assert "ZZZHIGH" in result

    def test_top_n_excludes_lowest_scorer(self):
        # 1銘柄だけ低スコア → 除外される
        n = TOP_N_CAP_CF + 1
        weights = {f"T{i:04d}": 100.0 for i in range(n)}
        weights[f"T{n-1:04d}"] = 0.0  # 最低スコア
        result, _ = self.s._select_top_n(weights)
        assert f"T{n-1:04d}" not in result

    def test_tie_break_ticker_asc(self):
        # 全同スコア → ticker 昇順で先頭 TOP_N_CAP_CF が選ばれる
        n = TOP_N_CAP_CF + 5
        weights = {f"T{i:04d}": 50.0 for i in range(n)}
        result, _ = self.s._select_top_n(weights)
        expected = {f"T{i:04d}" for i in range(TOP_N_CAP_CF)}
        assert set(result.keys()) == expected

    def test_diagnostic_contains_calculation_only(self):
        n = TOP_N_CAP_CF + 1
        weights = {f"T{i:04d}": float(i) for i in range(n)}
        _, diag = self.s._select_top_n(weights)
        joined = " ".join(diag)
        assert "calculation-only" in joined

    def test_diagnostic_contains_not_recommendation(self):
        n = TOP_N_CAP_CF + 1
        weights = {f"T{i:04d}": float(i) for i in range(n)}
        _, diag = self.s._select_top_n(weights)
        joined = " ".join(diag)
        assert "not a recommendation" in joined

    def test_empty_input_returns_empty(self):
        result, diag = self.s._select_top_n({})
        assert result == {}
        assert diag == []


# ── CLASS: equal weight property ─────────────────────────────────────────────

class TestEqualWeightProperty:
    def setup_method(self):
        self.s = CrossFactorStrategy()

    def test_equal_weight_regardless_of_score_difference(self):
        # HIGH score vs LOW score → どちらも等加重
        universe = ("HIGH", "LOW")
        scores = {
            "HIGH": {"quality": {"total": 100.0}, "value": {"total": 100.0}, "momentum": {"total": 100.0}},
            "LOW":  {"quality": {"total": 10.0},  "value": {"total": 10.0},  "momentum": {"total": 10.0}},
        }
        inp = StrategyInput(universe=universe, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        weights = dict(out.ideal_pf)
        # 等加重なので両者同じ
        assert abs(weights["HIGH"] - weights["LOW"]) < 1e-9

    def test_equal_weight_sum_to_one(self):
        universe = ("A", "B", "C", "D", "E")
        scores = _make_scores(universe, total=70.0)
        inp = StrategyInput(universe=universe, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        total = sum(w for _, w in out.ideal_pf)
        assert abs(total - 1.0) < 1e-9

    def test_all_selected_same_weight(self):
        universe = ("A", "B", "C")
        scores = {
            "A": {"quality": {"total": 90.0}, "value": {"total": 90.0}, "momentum": {"total": 90.0}},
            "B": {"quality": {"total": 50.0}, "value": {"total": 50.0}, "momentum": {"total": 50.0}},
            "C": {"quality": {"total": 10.0}, "value": {"total": 10.0}, "momentum": {"total": 10.0}},
        }
        inp = StrategyInput(universe=universe, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        weights = [w for _, w in out.ideal_pf]
        for w in weights:
            assert abs(w - 1.0 / 3) < 1e-9

    def test_all_zero_scores_equal_weight_fallback(self):
        n = TOP_N_CAP_CF + 1
        tickers = tuple(f"Z{i:04d}" for i in range(n))
        scores = {t: {"quality": {"total": 0.0}, "value": {"total": 0.0}, "momentum": {"total": 0.0}} for t in tickers}
        inp = StrategyInput(universe=tickers, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        assert len(out.ideal_pf) == TOP_N_CAP_CF
        for _, w in out.ideal_pf:
            assert abs(w - 1.0 / TOP_N_CAP_CF) < 1e-9

    def test_all_zero_diagnostic_recorded(self):
        n = TOP_N_CAP_CF + 1
        tickers = tuple(f"Z{i:04d}" for i in range(n))
        scores = {t: {"quality": {"total": 0.0}, "value": {"total": 0.0}, "momentum": {"total": 0.0}} for t in tickers}
        inp = StrategyInput(universe=tickers, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        joined = " ".join(out.diagnostics)
        assert "equal-weight fallback" in joined

    def test_regime_does_not_affect_weights(self):
        universe = ("A", "B", "C")
        scores = _make_scores(universe, total=70.0)
        inp_bull = StrategyInput(universe=universe, scores=scores, regime="bull_calm")
        inp_crisis = StrategyInput(universe=universe, scores=scores, regime="crisis")
        out_bull = self.s.compute(inp_bull)
        out_crisis = self.s.compute(inp_crisis)
        w_bull = dict(out_bull.ideal_pf)
        w_crisis = dict(out_crisis.ideal_pf)
        for t in universe:
            assert abs(w_bull[t] - w_crisis[t]) < 1e-9


# ── CLASS: _build_cross_scores ────────────────────────────────────────────────

class TestBuildCrossScores:
    def setup_method(self):
        self.s = CrossFactorStrategy()

    def test_all_tickers_present(self):
        universe = ("A", "B", "C")
        scores = _make_scores(universe, total=60.0)
        result, _ = self.s._build_cross_scores(universe, scores, {})
        assert set(result.keys()) == set(universe)

    def test_returns_tuple_of_dict_and_list(self):
        universe = ("A",)
        scores = _make_scores(universe)
        result = self.s._build_cross_scores(universe, scores, {})
        assert isinstance(result, tuple)
        assert isinstance(result[0], dict)
        assert isinstance(result[1], list)

    def test_missing_ticker_adds_diagnostic(self):
        universe = ("MISSING",)
        _, diag = self.s._build_cross_scores(universe, {}, {})
        assert any("missing" in d.lower() for d in diag)

    def test_non_dict_score_adds_diagnostic(self):
        universe = ("BAD",)
        scores = {"BAD": "not_a_dict"}
        _, diag = self.s._build_cross_scores(universe, scores, {})
        assert any("non-dict" in d.lower() for d in diag)

    def test_no_diagnostics_when_all_valid(self):
        universe = ("A", "B")
        scores = _make_scores(universe)
        _, diag = self.s._build_cross_scores(universe, scores, {})
        # valid scores with default size_segment → no diagnostics
        assert diag == []

    def test_invalid_size_segment_adds_diagnostic(self):
        universe = ("A",)
        scores = {"A": {"quality": {"total": 70.0}, "value": {"total": 60.0}, "momentum": {"total": 65.0}, "size_segment": "invalid_segment"}}
        _, diag = self.s._build_cross_scores(universe, scores, {})
        assert any("size_segment" in d for d in diag)

    def test_size_segment_from_context(self):
        universe = ("A",)
        scores = {"A": {"quality": {"total": 80.0}, "value": {"total": 70.0}, "momentum": {"total": 75.0}}}
        context = {"size_segments": {"A": "small_cap"}}
        result_small, _ = self.s._build_cross_scores(universe, scores, context)
        context_mid = {"size_segments": {"A": "mid_cap"}}
        result_mid, _ = self.s._build_cross_scores(universe, scores, context_mid)
        # small_cap → higher size_signal → higher score
        assert result_small["A"] > result_mid["A"]


# ── CLASS: output field validation ────────────────────────────────────────────

class TestOutputFieldValidation:
    def setup_method(self):
        self.s = CrossFactorStrategy()

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
        module = importlib.import_module("engine.strategies.cross_factor_strategy")
        assert not hasattr(module, "engine_regime")

    def test_does_not_use_get_axis_weights(self):
        module = importlib.import_module("engine.strategies.cross_factor_strategy")
        assert not hasattr(module, "get_axis_weights")

    def test_no_action_fields_in_output(self):
        s = CrossFactorStrategy()
        out = s.compute(_make_input())
        forbidden = [
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "verdict", "decision", "rating",
            "approve", "reject", "conditional",
        ]
        for field_name in forbidden:
            assert not hasattr(out, field_name), f"禁止フィールド {field_name!r} が存在します"

    def test_cross_signal_weights_is_module_level_constant(self):
        module = importlib.import_module("engine.strategies.cross_factor_strategy")
        assert hasattr(module, "CROSS_SIGNAL_WEIGHTS")
        assert isinstance(module.CROSS_SIGNAL_WEIGHTS, dict)

    def test_no_pandas_numpy_alias(self):
        module = importlib.import_module("engine.strategies.cross_factor_strategy")
        assert not hasattr(module, "pd")
        assert not hasattr(module, "np")


# ── CLASS: CrossFactor vs 他戦略比較 ─────────────────────────────────────────

class TestCrossFactorVsOtherStrategies:
    def test_strategy_ids_all_unique(self):
        from engine.strategies.frontier_strategy import FrontierStrategy
        from engine.strategies.quality_size_strategy import QualitySizeStrategy
        from engine.strategies.fundamental_weighted_strategy import FundamentalWeightedStrategy
        ids = {
            CrossFactorStrategy.STRATEGY_ID,
            FrontierStrategy.STRATEGY_ID,
            QualitySizeStrategy.STRATEGY_ID,
            FundamentalWeightedStrategy.STRATEGY_ID,
        }
        assert len(ids) == 4

    def test_cross_factor_crisis_vol_lowest(self):
        from engine.strategies.frontier_strategy import _REGIME_EXPECTED_VOL as f_vol
        from engine.strategies.quality_size_strategy import _REGIME_EXPECTED_VOL as qs_vol
        from engine.strategies.fundamental_weighted_strategy import _REGIME_EXPECTED_VOL as fw_vol
        cf_crisis_vol = _REGIME_EXPECTED_VOL["crisis"]
        assert cf_crisis_vol < f_vol["crisis"]
        assert cf_crisis_vol < qs_vol["crisis"]
        assert cf_crisis_vol < fw_vol["crisis"]

    def test_equal_weight_unlike_other_strategies(self):
        # CrossFactor: score が違っても同じ weight
        # frontier: score に比例した weight → 差がある
        universe = ("HIGH", "LOW")
        scores = {
            "HIGH": {ax: {"total": 100.0} for ax in ALL_AXES},
            "LOW":  {ax: {"total": 10.0}  for ax in ALL_AXES},
        }
        cf = CrossFactorStrategy()
        inp = StrategyInput(universe=universe, scores=scores, regime="bull_calm")
        out_cf = cf.compute(inp)
        cf_weights = dict(out_cf.ideal_pf)
        # CrossFactor は等加重
        assert abs(cf_weights["HIGH"] - cf_weights["LOW"]) < 1e-9

    def test_all_four_strategies_have_unique_approach(self):
        # CrossFactor は top-25 等加重という独自アプローチ
        assert TOP_N_CAP_CF == 25  # Fundamental は 50

    def test_cross_signal_weights_sum_to_one(self):
        total = sum(CROSS_SIGNAL_WEIGHTS.values())
        assert abs(total - 1.0) < 1e-9
