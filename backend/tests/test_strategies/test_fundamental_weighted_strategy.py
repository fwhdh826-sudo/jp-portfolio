"""
test_fundamental_weighted_strategy.py — Card 7-4
FundamentalWeightedStrategy のユニットテスト。

テスト方針:
  - stdlib-only; pytest のみ
  - FUNDAMENTAL_AXIS_MAP（固定4軸）を使った計算確認
  - TOP_N_CAP（universe > 50 のみ適用）の動作確認
  - TOP_N_CAP tie-break deterministic 確認（score 降順・ticker 昇順）
  - all-zero fallback 確認
  - BUY/SELL/HOLD/WAIT 判定・action フィールドが存在しないことを確認
  - DEFAULT_SCORE=50.0 フォールバック確認
  - safety / momentum が無視されること
  - unknown regime fallback 確認
  - empty universe guard 確認
  - diagnostics フォーマット確認
  - engine.regime / get_axis_weights を直接 import しないことの確認
  - STRATEGY_ID が VALID_STRATEGY_IDS に含まれることの確認
"""
from __future__ import annotations

import importlib
import math

import pytest

from engine.strategies.fundamental_weighted_strategy import (
    DEFAULT_SCORE,
    FUNDAMENTAL_AXIS_MAP,
    TOP_N_CAP,
    FundamentalWeightedStrategy,
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
FUNDAMENTAL_AXES = ("growth", "quality", "value", "shareholder_return")


def _make_scores(
    tickers: tuple[str, ...],
    total: float = 80.0,
) -> dict:
    """全銘柄・全軸に同一 total を持つ scores fixture を返す。"""
    return {
        ticker: {axis: {"total": total} for axis in ALL_AXES}
        for ticker in tickers
    }


def _make_fundamental_scores(
    tickers: tuple[str, ...],
    growth: float = 80.0,
    quality: float = 80.0,
    value: float = 80.0,
    shareholder_return: float = 80.0,
) -> dict:
    """FUNDAMENTAL_AXIS_MAP の4軸だけ指定する scores fixture を返す。"""
    return {
        ticker: {
            "growth":             {"total": growth},
            "quality":            {"total": quality},
            "value":              {"total": value},
            "shareholder_return": {"total": shareholder_return},
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


def _make_large_universe(n: int, base_score: float = 80.0) -> tuple[tuple[str, ...], dict]:
    """n 銘柄のユニバースと scores を作成する。"""
    tickers = tuple(f"T{i:04d}" for i in range(n))
    scores = _make_scores(tickers, total=base_score)
    return tickers, scores


# ── CLASS: インスタンス化・属性 ───────────────────────────────────────────────

class TestFundamentalWeightedStrategyClass:
    def test_strategy_id(self):
        assert FundamentalWeightedStrategy.STRATEGY_ID == "fundamental"

    def test_strategy_name(self):
        assert FundamentalWeightedStrategy.STRATEGY_NAME == "Fundamental Weighted (Arnott 2005)"

    def test_instantiation(self):
        s = FundamentalWeightedStrategy()
        assert isinstance(s, FundamentalWeightedStrategy)

    def test_default_score_constant(self):
        assert DEFAULT_SCORE == 50.0

    def test_top_n_cap_constant(self):
        assert TOP_N_CAP == 50

    def test_strategy_id_in_valid_ids(self):
        assert FundamentalWeightedStrategy.STRATEGY_ID in VALID_STRATEGY_IDS


# ── CLASS: FUNDAMENTAL_AXIS_MAP 定数 ─────────────────────────────────────────

class TestFundamentalAxisMap:
    def test_four_axes_present(self):
        for axis in FUNDAMENTAL_AXES:
            assert axis in FUNDAMENTAL_AXIS_MAP

    def test_weights_sum_to_one(self):
        total = sum(FUNDAMENTAL_AXIS_MAP.values())
        assert abs(total - 1.0) < 1e-9

    def test_growth_weight(self):
        assert abs(FUNDAMENTAL_AXIS_MAP["growth"] - 0.30) < 1e-9

    def test_quality_weight(self):
        assert abs(FUNDAMENTAL_AXIS_MAP["quality"] - 0.30) < 1e-9

    def test_value_weight(self):
        assert abs(FUNDAMENTAL_AXIS_MAP["value"] - 0.20) < 1e-9

    def test_shareholder_return_weight(self):
        assert abs(FUNDAMENTAL_AXIS_MAP["shareholder_return"] - 0.20) < 1e-9

    def test_all_weights_positive(self):
        for axis, w in FUNDAMENTAL_AXIS_MAP.items():
            assert w > 0.0, f"{axis} weight must be positive"

    def test_safety_not_in_axis_map(self):
        assert "safety" not in FUNDAMENTAL_AXIS_MAP

    def test_momentum_not_in_axis_map(self):
        assert "momentum" not in FUNDAMENTAL_AXIS_MAP

    def test_exactly_four_axes(self):
        assert len(FUNDAMENTAL_AXIS_MAP) == 4


# ── CLASS: compute() — empty universe ────────────────────────────────────────

class TestComputeEmptyUniverse:
    def setup_method(self):
        self.s = FundamentalWeightedStrategy()

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
        assert out.strategy_id == "fundamental"

    def test_empty_universe_strategy_name_set(self):
        inp = _make_input(universe=())
        out = self.s.compute(inp)
        assert out.strategy_name == "Fundamental Weighted (Arnott 2005)"


# ── CLASS: compute() — happy path ────────────────────────────────────────────

class TestComputeHappyPath:
    def setup_method(self):
        self.s = FundamentalWeightedStrategy()

    def test_returns_strategy_output(self):
        out = self.s.compute(_make_input())
        assert isinstance(out, StrategyOutput)

    def test_strategy_id_in_output(self):
        out = self.s.compute(_make_input())
        assert out.strategy_id == "fundamental"

    def test_strategy_name_in_output(self):
        out = self.s.compute(_make_input())
        assert out.strategy_name == "Fundamental Weighted (Arnott 2005)"

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

    def test_rationale_contains_arnott(self):
        out = self.s.compute(_make_input())
        assert "Arnott" in out.rationale

    def test_rationale_contains_fundamental(self):
        out = self.s.compute(_make_input())
        assert "Fundamental" in out.rationale

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
        self.s = FundamentalWeightedStrategy()

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

    def test_max_dd_crisis_most_negative(self):
        out_crisis = self.s.compute(_make_input(regime="crisis"))
        out_bull = self.s.compute(_make_input(regime="bull_calm"))
        assert out_crisis.max_dd_estimate < out_bull.max_dd_estimate


# ── CLASS: _calc_fundamental_score ───────────────────────────────────────────

class TestCalcFundamentalScore:
    def setup_method(self):
        self.s = FundamentalWeightedStrategy()

    def test_all_fundamental_axes_present(self):
        # 全4軸に total=80.0 → fundamental_score = 80.0（FUNDAMENTAL_AXIS_MAP sum=1.0）
        ticker_scores = {axis: {"total": 80.0} for axis in ALL_AXES}
        score = self.s._calc_fundamental_score(ticker_scores)
        assert abs(score - 80.0) < 1e-9

    def test_missing_all_axes_uses_default_score(self):
        score = self.s._calc_fundamental_score({})
        assert abs(score - DEFAULT_SCORE) < 1e-9

    def test_non_dict_axis_value_uses_default_score(self):
        ticker_scores = {axis: "invalid" for axis in ALL_AXES}
        score = self.s._calc_fundamental_score(ticker_scores)
        assert abs(score - DEFAULT_SCORE) < 1e-9

    def test_total_above_100_clamped(self):
        ticker_scores = {axis: {"total": 200.0} for axis in ALL_AXES}
        score = self.s._calc_fundamental_score(ticker_scores)
        assert abs(score - 100.0) < 1e-9

    def test_total_below_0_clamped(self):
        ticker_scores = {axis: {"total": -50.0} for axis in ALL_AXES}
        score = self.s._calc_fundamental_score(ticker_scores)
        assert abs(score - 0.0) < 1e-9

    def test_safety_ignored(self):
        # safety だけ高くしても fundamental_score に影響しない
        ticker_scores_with_safety = {
            "growth":             {"total": 50.0},
            "quality":            {"total": 50.0},
            "value":              {"total": 50.0},
            "shareholder_return": {"total": 50.0},
            "safety":             {"total": 100.0},  # 無視される
        }
        score = self.s._calc_fundamental_score(ticker_scores_with_safety)
        assert abs(score - 50.0) < 1e-9

    def test_momentum_ignored(self):
        # momentum だけ高くしても fundamental_score に影響しない
        ticker_scores_with_momentum = {
            "growth":             {"total": 50.0},
            "quality":            {"total": 50.0},
            "value":              {"total": 50.0},
            "shareholder_return": {"total": 50.0},
            "momentum":           {"total": 100.0},  # 無視される
        }
        score = self.s._calc_fundamental_score(ticker_scores_with_momentum)
        assert abs(score - 50.0) < 1e-9

    def test_growth_contributes_030(self):
        # growth のみ 100.0、他は 0.0
        ticker_scores = {
            "growth":             {"total": 100.0},
            "quality":            {"total": 0.0},
            "value":              {"total": 0.0},
            "shareholder_return": {"total": 0.0},
        }
        score = self.s._calc_fundamental_score(ticker_scores)
        assert abs(score - 30.0) < 1e-9

    def test_quality_contributes_030(self):
        ticker_scores = {
            "growth":             {"total": 0.0},
            "quality":            {"total": 100.0},
            "value":              {"total": 0.0},
            "shareholder_return": {"total": 0.0},
        }
        score = self.s._calc_fundamental_score(ticker_scores)
        assert abs(score - 30.0) < 1e-9

    def test_value_contributes_020(self):
        ticker_scores = {
            "growth":             {"total": 0.0},
            "quality":            {"total": 0.0},
            "value":              {"total": 100.0},
            "shareholder_return": {"total": 0.0},
        }
        score = self.s._calc_fundamental_score(ticker_scores)
        assert abs(score - 20.0) < 1e-9

    def test_shareholder_return_contributes_020(self):
        ticker_scores = {
            "growth":             {"total": 0.0},
            "quality":            {"total": 0.0},
            "value":              {"total": 0.0},
            "shareholder_return": {"total": 100.0},
        }
        score = self.s._calc_fundamental_score(ticker_scores)
        assert abs(score - 20.0) < 1e-9

    def test_none_total_uses_default_score(self):
        ticker_scores = {axis: {"total": None} for axis in FUNDAMENTAL_AXES}
        score = self.s._calc_fundamental_score(ticker_scores)
        assert abs(score - DEFAULT_SCORE) < 1e-9

    def test_string_total_uses_default_score(self):
        ticker_scores = {axis: {"total": "bad"} for axis in FUNDAMENTAL_AXES}
        score = self.s._calc_fundamental_score(ticker_scores)
        assert abs(score - DEFAULT_SCORE) < 1e-9

    def test_partial_fundamental_axis_missing(self):
        # growth=100, 他は欠損 → DEFAULT_SCORE
        ticker_scores = {"growth": {"total": 100.0}}
        score = self.s._calc_fundamental_score(ticker_scores)
        # growth*0.30 + DEFAULT*(0.30+0.20+0.20)
        expected = 100.0 * 0.30 + DEFAULT_SCORE * (0.30 + 0.20 + 0.20)
        assert abs(score - expected) < 1e-9


# ── CLASS: TOP_N_CAP ─────────────────────────────────────────────────────────

class TestTopNCap:
    def setup_method(self):
        self.s = FundamentalWeightedStrategy()

    def test_universe_at_cap_no_filtering(self):
        # universe == TOP_N_CAP → フィルタしない
        tickers, scores = _make_large_universe(TOP_N_CAP)
        inp = StrategyInput(universe=tickers, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        assert len(out.ideal_pf) == TOP_N_CAP

    def test_universe_below_cap_no_filtering(self):
        # universe < TOP_N_CAP → フィルタしない
        universe = ("AAPL", "MSFT", "NVDA")
        out = self.s.compute(_make_input(universe=universe))
        assert len(out.ideal_pf) == len(universe)

    def test_universe_above_cap_filters_to_top_n(self):
        # universe > TOP_N_CAP → TOP_N_CAP 銘柄に絞込
        tickers, scores = _make_large_universe(TOP_N_CAP + 10)
        inp = StrategyInput(universe=tickers, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        assert len(out.ideal_pf) == TOP_N_CAP

    def test_universe_one_above_cap_filters(self):
        # universe == TOP_N_CAP + 1 → フィルタが発動する境界
        tickers, scores = _make_large_universe(TOP_N_CAP + 1)
        inp = StrategyInput(universe=tickers, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        assert len(out.ideal_pf) == TOP_N_CAP

    def test_top_n_keeps_high_scorers(self):
        # 1銘柄だけ高スコア、残りは低スコア → 高スコアが残る
        tickers = tuple(f"T{i:04d}" for i in range(TOP_N_CAP + 5))
        high_ticker = tickers[0]
        scores = {t: {axis: {"total": 10.0} for axis in FUNDAMENTAL_AXES} for t in tickers}
        scores[high_ticker] = {axis: {"total": 100.0} for axis in FUNDAMENTAL_AXES}
        inp = StrategyInput(universe=tickers, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        tickers_in_pf = {t for t, _ in out.ideal_pf}
        assert high_ticker in tickers_in_pf

    def test_top_n_excludes_low_scorers(self):
        # 最低スコアの銘柄（最後の1つ）が除外される
        n = TOP_N_CAP + 1
        tickers = tuple(f"T{i:04d}" for i in range(n))
        low_ticker = tickers[-1]
        scores = {t: {axis: {"total": 80.0} for axis in FUNDAMENTAL_AXES} for t in tickers}
        scores[low_ticker] = {axis: {"total": 0.0} for axis in FUNDAMENTAL_AXES}
        inp = StrategyInput(universe=tickers, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        tickers_in_pf = {t for t, _ in out.ideal_pf}
        assert low_ticker not in tickers_in_pf

    def test_top_n_weights_sum_to_one(self):
        tickers, scores = _make_large_universe(TOP_N_CAP + 10)
        inp = StrategyInput(universe=tickers, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        total = sum(w for _, w in out.ideal_pf)
        assert abs(total - 1.0) < 1e-9

    def test_top_n_cap_diagnostic_recorded(self):
        tickers, scores = _make_large_universe(TOP_N_CAP + 5)
        inp = StrategyInput(universe=tickers, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        joined = " ".join(out.diagnostics)
        assert "top-N cap" in joined or "cap applied" in joined

    def test_no_cap_diagnostic_when_under_limit(self):
        universe = ("A", "B", "C")
        out = self.s.compute(_make_input(universe=universe))
        joined = " ".join(out.diagnostics)
        assert "cap applied" not in joined

    def test_top_n_tie_break_deterministic(self):
        # 全銘柄同スコアで universe > TOP_N_CAP → ticker 昇順で先頭 TOP_N_CAP が選ばれる
        n = TOP_N_CAP + 5
        tickers = tuple(f"T{i:04d}" for i in range(n))
        scores = {t: {axis: {"total": 50.0} for axis in FUNDAMENTAL_AXES} for t in tickers}
        inp = StrategyInput(universe=tickers, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        selected = {t for t, _ in out.ideal_pf}
        # ticker 昇順なので T0000〜T0049 が選ばれるはず
        expected = {f"T{i:04d}" for i in range(TOP_N_CAP)}
        assert selected == expected

    def test_top_n_all_zero_equal_weight_fallback(self):
        # all-zero scores で universe > TOP_N_CAP → 等加重 fallback
        n = TOP_N_CAP + 1
        tickers = tuple(f"Z{i:04d}" for i in range(n))
        scores = {t: {axis: {"total": 0.0} for axis in FUNDAMENTAL_AXES} for t in tickers}
        inp = StrategyInput(universe=tickers, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        assert len(out.ideal_pf) == TOP_N_CAP
        for _, w in out.ideal_pf:
            assert abs(w - 1.0 / TOP_N_CAP) < 1e-9

    def test_top_n_all_zero_diagnostic_recorded(self):
        n = TOP_N_CAP + 1
        tickers = tuple(f"Z{i:04d}" for i in range(n))
        scores = {t: {axis: {"total": 0.0} for axis in FUNDAMENTAL_AXES} for t in tickers}
        inp = StrategyInput(universe=tickers, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        joined = " ".join(out.diagnostics)
        assert "equal weight fallback" in joined


# ── CLASS: _apply_top_n_cap ───────────────────────────────────────────────────

class TestApplyTopNCap:
    def setup_method(self):
        self.s = FundamentalWeightedStrategy()

    def test_under_cap_returns_same_dict(self):
        weights = {f"T{i}": float(i) for i in range(10)}
        result, diag = self.s._apply_top_n_cap(weights)
        assert result == weights
        assert diag == []

    def test_at_cap_returns_same_dict(self):
        weights = {f"T{i:04d}": float(i) for i in range(TOP_N_CAP)}
        result, diag = self.s._apply_top_n_cap(weights)
        assert len(result) == TOP_N_CAP
        assert diag == []

    def test_over_cap_returns_top_n(self):
        weights = {f"T{i:04d}": float(i) for i in range(TOP_N_CAP + 10)}
        result, diag = self.s._apply_top_n_cap(weights)
        assert len(result) == TOP_N_CAP
        assert len(diag) > 0

    def test_over_cap_selects_highest_scores(self):
        # T0000〜T0059 まで。スコアが高い方（T0050〜T0059）が残る
        weights = {f"T{i:04d}": float(i) for i in range(TOP_N_CAP + 10)}
        result, _ = self.s._apply_top_n_cap(weights)
        # 最高スコアの銘柄が含まれる
        assert "T0059" in result

    def test_tie_break_ticker_asc(self):
        # 全て同スコア → ticker 昇順で先頭 TOP_N_CAP
        weights = {f"T{i:04d}": 50.0 for i in range(TOP_N_CAP + 5)}
        result, _ = self.s._apply_top_n_cap(weights)
        expected_keys = {f"T{i:04d}" for i in range(TOP_N_CAP)}
        assert set(result.keys()) == expected_keys

    def test_diagnostic_contains_cap_info(self):
        weights = {f"T{i:04d}": float(i) for i in range(TOP_N_CAP + 1)}
        _, diag = self.s._apply_top_n_cap(weights)
        joined = " ".join(diag)
        assert str(TOP_N_CAP) in joined


# ── CLASS: _build_score_weights ───────────────────────────────────────────────

class TestBuildScoreWeights:
    def setup_method(self):
        self.s = FundamentalWeightedStrategy()

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
        result, _ = self.s._build_score_weights(universe, scores)
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
        result, _ = self.s._build_score_weights(universe, scores)
        assert abs(result["BAD"] - DEFAULT_SCORE) < 1e-9

    def test_non_dict_score_adds_diagnostic(self):
        universe = ("BAD",)
        scores = {"BAD": "not_a_dict"}
        _, diag = self.s._build_score_weights(universe, scores)
        joined = " ".join(diag)
        assert "non-dict" in joined.lower()

    def test_score_propagates_correctly(self):
        universe = ("X",)
        scores = {"X": {axis: {"total": 100.0} for axis in FUNDAMENTAL_AXES}}
        result, _ = self.s._build_score_weights(universe, scores)
        assert abs(result["X"] - 100.0) < 1e-9

    def test_no_diagnostics_when_all_valid(self):
        universe = ("A", "B")
        scores = _make_scores(universe)
        _, diag = self.s._build_score_weights(universe, scores)
        assert diag == []


# ── CLASS: weight proportionality ────────────────────────────────────────────

class TestWeightProportionality:
    def setup_method(self):
        self.s = FundamentalWeightedStrategy()

    def test_higher_fundamental_score_gets_higher_weight(self):
        universe = ("HIGH", "LOW")
        scores = {
            "HIGH": {axis: {"total": 90.0} for axis in FUNDAMENTAL_AXES},
            "LOW":  {axis: {"total": 10.0} for axis in FUNDAMENTAL_AXES},
        }
        inp = StrategyInput(universe=universe, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        weights = dict(out.ideal_pf)
        assert weights["HIGH"] > weights["LOW"]

    def test_proportional_weight_ratio(self):
        universe = ("DOUBLE", "SINGLE")
        scores = {
            "DOUBLE": {axis: {"total": 80.0} for axis in FUNDAMENTAL_AXES},
            "SINGLE": {axis: {"total": 40.0} for axis in FUNDAMENTAL_AXES},
        }
        inp = StrategyInput(universe=universe, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        weights = dict(out.ideal_pf)
        ratio = weights["DOUBLE"] / weights["SINGLE"]
        assert abs(ratio - 2.0) < 1e-6

    def test_all_zero_score_equal_weight(self):
        universe = ("A", "B", "C")
        scores = {t: {axis: {"total": 0.0} for axis in FUNDAMENTAL_AXES} for t in universe}
        inp = StrategyInput(universe=universe, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        weights = [w for _, w in out.ideal_pf]
        for w in weights:
            assert abs(w - 1.0 / 3) < 1e-9

    def test_regime_does_not_affect_weights(self):
        # fundamental は regime 非依存 → bull_calm と bear で同じ weight 比率
        universe = ("A", "B")
        scores = {
            "A": {axis: {"total": 80.0} for axis in FUNDAMENTAL_AXES},
            "B": {axis: {"total": 40.0} for axis in FUNDAMENTAL_AXES},
        }
        inp_bull = StrategyInput(universe=universe, scores=scores, regime="bull_calm")
        inp_bear = StrategyInput(universe=universe, scores=scores, regime="bear")
        out_bull = self.s.compute(inp_bull)
        out_bear = self.s.compute(inp_bear)
        w_bull = dict(out_bull.ideal_pf)
        w_bear = dict(out_bear.ideal_pf)
        assert abs(w_bull["A"] - w_bear["A"]) < 1e-9

    def test_two_equal_tickers_equal_weight(self):
        universe = ("EQ1", "EQ2")
        scores = {t: {axis: {"total": 75.0} for axis in FUNDAMENTAL_AXES} for t in universe}
        inp = StrategyInput(universe=universe, scores=scores, regime="bull_calm")
        out = self.s.compute(inp)
        weights = dict(out.ideal_pf)
        assert abs(weights["EQ1"] - weights["EQ2"]) < 1e-9


# ── CLASS: normalize / ideal_pf (via BaseStrategy) ───────────────────────────

class TestNormalizeAndIdealPf:
    def setup_method(self):
        self.s = FundamentalWeightedStrategy()

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
        self.s = FundamentalWeightedStrategy()

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
        module = importlib.import_module("engine.strategies.fundamental_weighted_strategy")
        assert not hasattr(module, "engine_regime"), \
            "engine.regime を直接 import している可能性があります"

    def test_does_not_use_get_axis_weights(self):
        """FundamentalWeightedStrategy は FUNDAMENTAL_AXIS_MAP（固定）を使用するため
        dynamic_weight.regime_axis_weights.get_axis_weights を import しない。"""
        module = importlib.import_module("engine.strategies.fundamental_weighted_strategy")
        assert not hasattr(module, "get_axis_weights"), \
            "FundamentalWeightedStrategy は固定 FUNDAMENTAL_AXIS_MAP を使用。get_axis_weights 不要。"

    def test_no_action_fields_in_output(self):
        s = FundamentalWeightedStrategy()
        out = s.compute(_make_input())
        forbidden = [
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "verdict", "decision", "rating",
            "approve", "reject", "conditional",
        ]
        for field_name in forbidden:
            assert not hasattr(out, field_name), f"禁止フィールド {field_name!r} が存在します"

    def test_fundamental_axis_map_is_module_level_constant(self):
        module = importlib.import_module("engine.strategies.fundamental_weighted_strategy")
        assert hasattr(module, "FUNDAMENTAL_AXIS_MAP")
        assert isinstance(module.FUNDAMENTAL_AXIS_MAP, dict)

    def test_no_pandas_numpy_alias(self):
        module = importlib.import_module("engine.strategies.fundamental_weighted_strategy")
        assert not hasattr(module, "pd"), "pandas alias が存在します"
        assert not hasattr(module, "np"), "numpy alias が存在します"


# ── CLASS: Fundamental vs 他戦略比較 ─────────────────────────────────────────

class TestFundamentalVsOtherStrategies:
    def test_strategy_id_unique(self):
        from engine.strategies.frontier_strategy import FrontierStrategy
        from engine.strategies.quality_size_strategy import QualitySizeStrategy
        ids = {
            FundamentalWeightedStrategy.STRATEGY_ID,
            FrontierStrategy.STRATEGY_ID,
            QualitySizeStrategy.STRATEGY_ID,
        }
        assert len(ids) == 3

    def test_uses_fixed_weights_not_regime_adaptive(self):
        """FundamentalWeightedStrategy は FUNDAMENTAL_AXIS_MAP（固定）を使い
        regime によって ideal_pf の weight 比率が変わらないことを確認。"""
        fw = FundamentalWeightedStrategy()
        universe = ("A", "B")
        scores = {
            "A": {axis: {"total": 80.0} for axis in FUNDAMENTAL_AXES},
            "B": {axis: {"total": 40.0} for axis in FUNDAMENTAL_AXES},
        }
        for regime in ["bull_calm", "bull_volatile", "bear", "crisis", "uncertain"]:
            inp = StrategyInput(universe=universe, scores=scores, regime=regime)
            out = fw.compute(inp)
            w = dict(out.ideal_pf)
            # A:B の比率は常に 2:1
            assert abs(w["A"] / w["B"] - 2.0) < 1e-9, \
                f"regime={regime} で weight 比率が異なります"

    def test_crisis_vol_between_frontier_and_quality_size(self):
        # Fundamental crisis vol は frontier と quality_size の間
        from engine.strategies.frontier_strategy import _REGIME_EXPECTED_VOL as f_vol
        from engine.strategies.quality_size_strategy import _REGIME_EXPECTED_VOL as qs_vol
        f_vol_crisis = f_vol["crisis"]       # 0.300
        qs_vol_crisis = qs_vol["crisis"]     # 0.240
        fund_vol_crisis = _REGIME_EXPECTED_VOL["crisis"]  # 0.250
        assert qs_vol_crisis < fund_vol_crisis < f_vol_crisis
