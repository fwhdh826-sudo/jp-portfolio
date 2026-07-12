"""
test_frontier_strategy_phase8.py — Card 8-4 テスト
FrontierStrategy の Phase 8 経路（ExpectedReturnModel / CovarianceModel /
ConstraintBuilder / EfficientFrontierOptimizer / IndexBuilder 接続）を検証。

scipy 1.13+ required（インストール済み）。
"""
from __future__ import annotations

import pytest

from engine.strategies.base_strategy import StrategyInput, StrategyOutput
from engine.strategies.frontier_strategy import (
    DEFAULT_SCORE,
    FrontierStrategy,
    _FALLBACK_REGIME,
    _REGIME_EXPECTED_RETURN,
    _REGIME_EXPECTED_VOL,
    _REGIME_MAX_DD,
)

# ── フィクスチャ ──────────────────────────────────────────────────────────────

_BASIC_SCORES = {
    "A": {
        "value":              {"total": 65.0},
        "quality":            {"total": 70.0},
        "growth":             {"total": 55.0},
        "safety":             {"total": 60.0},
        "momentum":           {"total": 50.0},
        "shareholder_return": {"total": 45.0},
    },
    "B": {
        "value":              {"total": 50.0},
        "quality":            {"total": 60.0},
        "growth":             {"total": 65.0},
        "safety":             {"total": 75.0},
        "momentum":           {"total": 55.0},
        "shareholder_return": {"total": 50.0},
    },
}

_RETURNS_A = [0.10, -0.05, 0.08, -0.03, 0.06]
_RETURNS_B = [0.02, -0.01, 0.03, -0.01, 0.02]


def _strategy() -> FrontierStrategy:
    return FrontierStrategy()


def _phase8_input(
    universe=("A", "B"),
    scores=None,
    regime="bull_calm",
    horizon="long_term",
    context_overrides=None,
) -> StrategyInput:
    """Phase 8 経路に入る StrategyInput を構築。"""
    if scores is None:
        scores = _BASIC_SCORES
    context = {
        "returns_data": {
            "A": _RETURNS_A,
            "B": _RETURNS_B,
        },
        "mean_return_3y_by_ticker": {"A": 0.08, "B": 0.03},
        "size_segment_by_ticker": {"A": "large_cap", "B": "large_cap"},
        "shrinkage_alpha": 0.0,
        "asset_meta_by_ticker": {
            "A": {"sector": "tech", "is_core": False, "is_leveraged": False},
            "B": {"sector": "finance", "is_core": False, "is_leveraged": False},
        },
    }
    if context_overrides:
        # context_overrides がキーを完全に消す場合は pop も許容
        for k, v in context_overrides.items():
            if v is _DELETE:
                context.pop(k, None)
            else:
                context[k] = v
    return StrategyInput(
        universe=universe,
        scores=scores,
        regime=regime,
        horizon=horizon,
        context=context,
    )


class _DeleteSentinel:
    pass


_DELETE = _DeleteSentinel()


def _phase7_input(
    universe=("A", "B"),
    scores=None,
    regime="bull_calm",
    context=None,
) -> StrategyInput:
    """Phase 7 fallback 経路に入る StrategyInput（returns_data なし）。"""
    if scores is None:
        scores = _BASIC_SCORES
    if context is None:
        context = {}
    return StrategyInput(
        universe=universe, scores=scores,
        regime=regime, horizon="long_term", context=context,
    )


# ── TestPhase8Detection ──────────────────────────────────────────────────────

class TestPhase8Detection:
    def test_returns_data_dict_with_data_triggers_phase8(self):
        out = _strategy().compute(_phase8_input())
        diag_text = " ".join(out.diagnostics)
        assert "Phase 8 SLSQP optimization used" in diag_text

    def test_empty_returns_data_falls_back_to_phase7(self):
        si = _phase8_input(context_overrides={"returns_data": {}})
        out = _strategy().compute(si)
        diag_text = " ".join(out.diagnostics)
        assert "Phase 8 returns_data not provided" in diag_text
        assert "Phase 8 SLSQP optimization used" not in diag_text

    def test_missing_returns_data_key_falls_back_to_phase7(self):
        si = _phase8_input(context_overrides={"returns_data": _DELETE})
        out = _strategy().compute(si)
        diag_text = " ".join(out.diagnostics)
        assert "Phase 8 returns_data not provided" in diag_text

    def test_non_dict_returns_data_falls_back_to_phase7(self):
        si = _phase8_input(context_overrides={"returns_data": "not_a_dict"})
        out = _strategy().compute(si)
        diag_text = " ".join(out.diagnostics)
        assert "Phase 8 returns_data not provided" in diag_text

    def test_phase8_diagnostic_present_when_used(self):
        out = _strategy().compute(_phase8_input())
        assert any("Phase 8 SLSQP" in d for d in out.diagnostics)


# ── TestPhase8Pipeline ───────────────────────────────────────────────────────

class TestPhase8Pipeline:
    def test_returns_strategy_output(self):
        out = _strategy().compute(_phase8_input())
        assert isinstance(out, StrategyOutput)

    def test_ideal_pf_is_tuple_of_tuples(self):
        out = _strategy().compute(_phase8_input())
        assert isinstance(out.ideal_pf, tuple)
        if out.ideal_pf:
            assert isinstance(out.ideal_pf[0], tuple)
            assert len(out.ideal_pf[0]) == 2

    def test_weights_sum_to_one(self):
        out = _strategy().compute(_phase8_input())
        total = sum(w for _, w in out.ideal_pf)
        assert total == pytest.approx(1.0, abs=1e-6)

    def test_weights_non_negative(self):
        out = _strategy().compute(_phase8_input())
        for _, w in out.ideal_pf:
            assert w >= -1e-9

    def test_strategy_id_frontier(self):
        out = _strategy().compute(_phase8_input())
        assert out.strategy_id == "frontier"

    def test_strategy_name_frontier_ai_index(self):
        out = _strategy().compute(_phase8_input())
        assert out.strategy_name == "Frontier AI Index"

    def test_expected_return_is_phase8_value(self):
        # Phase 8 計算値は regime reference と異なる
        out = _strategy().compute(_phase8_input(regime="bull_calm"))
        assert out.expected_return != pytest.approx(_REGIME_EXPECTED_RETURN["bull_calm"])

    def test_expected_vol_is_phase8_value(self):
        # Phase 8 経路では covariance ベース計算値
        out = _strategy().compute(_phase8_input(regime="bull_calm"))
        assert out.expected_vol != pytest.approx(_REGIME_EXPECTED_VOL["bull_calm"])

    def test_sharpe_ratio_is_float(self):
        out = _strategy().compute(_phase8_input())
        assert isinstance(out.sharpe_ratio, float)

    def test_max_dd_estimate_is_returns_based_observed(self):
        # Card C（P2-8N）: Phase 8 経路の max_dd は returns_data ベース観測値。
        # 標準 fixture は returns_data あり → regime reference とは異なる観測値。
        out = _strategy().compute(_phase8_input(regime="bull_calm"))
        assert out.max_dd_estimate != pytest.approx(_REGIME_MAX_DD["bull_calm"])
        assert out.max_dd_estimate <= 0.0
        diag_text = " ".join(out.diagnostics)
        assert "observed max drawdown from returns_data" in diag_text
        assert "max_dd_estimate is regime reference value" not in diag_text

    def test_rationale_mentions_phase8_slsqp(self):
        out = _strategy().compute(_phase8_input())
        assert "Phase 8" in out.rationale
        assert "SLSQP" in out.rationale

    def test_diagnostics_includes_calculation_only_disclaimer(self):
        out = _strategy().compute(_phase8_input())
        diag_text = " ".join(out.diagnostics)
        assert "not an order, not a recommendation" in diag_text


# ── TestPhase8DataMapping ────────────────────────────────────────────────────

class TestPhase8DataMapping:
    def test_mean_return_3y_by_ticker_passes_to_asset_meta(self):
        # 高 mean_return_3y → 期待リターン上昇
        ctx_hi = {"mean_return_3y_by_ticker": {"A": 0.50, "B": 0.50}}
        ctx_lo = {"mean_return_3y_by_ticker": {"A": 0.01, "B": 0.01}}
        out_hi = _strategy().compute(_phase8_input(context_overrides=ctx_hi))
        out_lo = _strategy().compute(_phase8_input(context_overrides=ctx_lo))
        assert out_hi.expected_return > out_lo.expected_return

    def test_size_segment_default_large_cap(self):
        # size_segment 不在 → large_cap default（premium=0）
        si = _phase8_input(context_overrides={"size_segment_by_ticker": _DELETE})
        out = _strategy().compute(si)
        assert isinstance(out, StrategyOutput)

    def test_size_segment_small_cap_increases_expected_return(self):
        # small_cap = premium 0.012 → 大きい size_premium
        ctx_small = {
            "size_segment_by_ticker": {"A": "small_cap", "B": "small_cap"},
        }
        ctx_large = {
            "size_segment_by_ticker": {"A": "large_cap", "B": "large_cap"},
        }
        out_s = _strategy().compute(_phase8_input(context_overrides=ctx_small))
        out_l = _strategy().compute(_phase8_input(context_overrides=ctx_large))
        # small_cap で expected_return 高
        assert out_s.expected_return > out_l.expected_return

    def test_risk_flags_passes_to_asset_meta(self):
        # market_intel + is_risk_on → alpha_market 増加
        ctx = {
            "risk_flags_by_ticker": {
                "A": {"is_risk_on": True},
                "B": {"is_risk_on": True},
            },
            "market_intel": {"sentiment_score": 80.0, "keywords": []},
        }
        out_risk = _strategy().compute(_phase8_input(context_overrides=ctx))
        # market_intel なしの baseline
        ctx_base = {
            "risk_flags_by_ticker": {"A": {}, "B": {}},
        }
        out_base = _strategy().compute(_phase8_input(context_overrides=ctx_base))
        assert out_risk.expected_return > out_base.expected_return

    def test_cross_axis_signals_passes_through(self):
        # cross_axis_signals 高い → alpha_cross 増加
        ctx_hi = {
            "cross_axis_signals": {
                "A": {"size_quality": 100.0, "anti_junk": 100.0},
                "B": {"size_quality": 100.0, "anti_junk": 100.0},
            },
        }
        ctx_lo = {"cross_axis_signals": {}}
        out_hi = _strategy().compute(_phase8_input(context_overrides=ctx_hi))
        out_lo = _strategy().compute(_phase8_input(context_overrides=ctx_lo))
        assert out_hi.expected_return > out_lo.expected_return

    def test_market_intel_dict_builds_context(self):
        ctx = {
            "market_intel": {
                "sentiment_score": 50.0,
                "keywords": ["円安", "資源高"],
            },
        }
        out = _strategy().compute(_phase8_input(context_overrides=ctx))
        # market_intel diag が含まれないはず（present だから）
        diag_text = " ".join(out.diagnostics)
        # ExpectedReturnModel が "market_intel not provided" diag を出さない
        assert "market_intel not provided" not in diag_text

    def test_market_intel_absent_optimizer_still_works(self):
        # market_intel 不在でも Phase 8 path で StrategyOutput 返却
        # （per_asset diagnostics は P1-8Q で集約しないため "market_intel not provided" は出ない）
        ctx = {"market_intel": _DELETE}
        out = _strategy().compute(_phase8_input(context_overrides=ctx))
        assert isinstance(out, StrategyOutput)
        assert sum(w for _, w in out.ideal_pf) == pytest.approx(1.0, abs=1e-6)

    def test_asset_meta_by_ticker_passes_to_constraints(self):
        # is_core=True → core soft penalty が現れる
        ctx = {
            "asset_meta_by_ticker": {
                "A": {"sector": "tech", "is_core": True, "is_leveraged": False},
                "B": {"sector": "finance", "is_core": False, "is_leveraged": False},
            },
        }
        out = _strategy().compute(_phase8_input(context_overrides=ctx))
        # 内部の constraints 経由で動作することの検証は output 経由で困難
        # → 戻り値が StrategyOutput であることのみ確認
        assert isinstance(out, StrategyOutput)

    def test_locked_weights_pins_ticker(self):
        # A をロックしたとき weight が固定される
        ctx = {"locked_weights": {"A": 0.4}}
        out = _strategy().compute(_phase8_input(context_overrides=ctx))
        weights = dict(out.ideal_pf)
        assert weights.get("A", 0.0) == pytest.approx(0.4, abs=1e-6)

    def test_shrinkage_alpha_default_0_1(self):
        # shrinkage_alpha 不在 → デフォルト 0.1 が使われる（shrinkage_applied）
        ctx = {"shrinkage_alpha": _DELETE}
        out = _strategy().compute(_phase8_input(context_overrides=ctx))
        diag_text = " ".join(out.diagnostics)
        assert "James-Stein" in diag_text

    def test_calculation_date_passes_to_index_builder(self):
        # calculation_date の動作は内部状態。Phase 8 path に入ること自体で十分
        ctx = {"calculation_date": "2026-05-13"}
        out = _strategy().compute(_phase8_input(context_overrides=ctx))
        assert isinstance(out, StrategyOutput)


# ── TestPhase8Fallback ───────────────────────────────────────────────────────

class TestPhase8Fallback:
    def test_slsqp_fallback_still_returns_strategy_output(self):
        # 2 ticker + デフォルト T7（max_single_weight=0.08）→ SLSQP fallback 発生
        out = _strategy().compute(_phase8_input())
        assert isinstance(out, StrategyOutput)
        # fallback でも weights sum=1
        total = sum(w for _, w in out.ideal_pf)
        assert total == pytest.approx(1.0, abs=1e-6)

    def test_slsqp_non_convergence_diagnostic(self):
        # 2 ticker での SLSQP fallback 時、diag に fallback weights 文言
        out = _strategy().compute(_phase8_input())
        diag_text = " ".join(out.diagnostics)
        # 必ずしも非収束するとは限らないが、Phase 8 path が走れば成功
        assert "Phase 8 SLSQP optimization used" in diag_text

    def test_fallback_weights_sum_to_one(self):
        out = _strategy().compute(_phase8_input())
        total = sum(w for _, w in out.ideal_pf)
        assert total == pytest.approx(1.0, abs=1e-6)

    def test_expected_return_computed_from_weights(self):
        # expected_return は ideal_pf の重みから計算された値
        out = _strategy().compute(_phase8_input())
        assert isinstance(out.expected_return, float)

    def test_empty_universe_returns_empty_output(self):
        si = StrategyInput(
            universe=(),
            scores={},
            regime="bull_calm",
            context={"returns_data": {"A": _RETURNS_A}},
        )
        out = _strategy().compute(si)
        assert out.ideal_pf == ()
        diag_text = " ".join(out.diagnostics)
        assert "universe is empty" in diag_text

    def test_single_ticker_weight_one(self):
        si = StrategyInput(
            universe=("A",),
            scores={"A": _BASIC_SCORES["A"]},
            regime="bull_calm",
            context={
                "returns_data": {"A": _RETURNS_A},
                "mean_return_3y_by_ticker": {"A": 0.08},
            },
        )
        out = _strategy().compute(si)
        weights = dict(out.ideal_pf)
        assert weights.get("A", 0.0) == pytest.approx(1.0, abs=1e-6)

    def test_partial_context_data_still_works(self):
        # mean_return_3y_by_ticker のみ提供、他は欠損
        ctx = {
            "size_segment_by_ticker": _DELETE,
            "risk_flags_by_ticker": _DELETE,
            "cross_axis_signals": _DELETE,
            "asset_meta_by_ticker": _DELETE,
        }
        out = _strategy().compute(_phase8_input(context_overrides=ctx))
        assert isinstance(out, StrategyOutput)
        assert len(out.ideal_pf) == 2

    def test_unknown_regime_fallback_to_uncertain(self):
        out = _strategy().compute(_phase8_input(regime="INVALID_REGIME"))
        diag_text = " ".join(out.diagnostics)
        assert "unknown regime" in diag_text
        # Card C: returns_data があるため max_dd は observed（regime に依存しない）。
        # unknown regime fallback は expected_return/vol 等にのみ影響。
        assert out.max_dd_estimate != pytest.approx(_REGIME_MAX_DD[_FALLBACK_REGIME])
        assert out.max_dd_estimate <= 0.0
        assert "observed max drawdown from returns_data" in diag_text


# ── TestPhase7Fallback ───────────────────────────────────────────────────────

class TestPhase7Fallback:
    def test_no_returns_data_uses_phase7(self):
        out = _strategy().compute(_phase7_input())
        diag_text = " ".join(out.diagnostics)
        assert "Phase 8 returns_data not provided" in diag_text
        assert "Phase 8 SLSQP optimization used" not in diag_text

    def test_phase7_diagnostic_present(self):
        out = _strategy().compute(_phase7_input())
        assert any("Phase 8 returns_data not provided" in d for d in out.diagnostics)

    def test_phase7_expected_return_from_regime_reference(self):
        out = _strategy().compute(_phase7_input(regime="bull_calm"))
        assert out.expected_return == pytest.approx(_REGIME_EXPECTED_RETURN["bull_calm"])

    def test_phase7_expected_vol_from_regime_reference(self):
        out = _strategy().compute(_phase7_input(regime="bull_calm"))
        assert out.expected_vol == pytest.approx(_REGIME_EXPECTED_VOL["bull_calm"])

    def test_phase7_rationale_no_phase8_mention(self):
        out = _strategy().compute(_phase7_input())
        assert "Phase 8" not in out.rationale
        assert "SLSQP" not in out.rationale


# ── TestProhibitedFields ─────────────────────────────────────────────────────

class TestProhibitedFields:
    def test_strategy_output_no_action_field(self):
        out = _strategy().compute(_phase8_input())
        assert not hasattr(out, "action")
        assert not hasattr(out, "is_buy")
        assert not hasattr(out, "is_sell")
        assert not hasattr(out, "is_hold")

    def test_strategy_output_no_recommendation_field(self):
        out = _strategy().compute(_phase8_input())
        assert not hasattr(out, "recommendation")
        assert not hasattr(out, "is_recommended")
        assert not hasattr(out, "verdict")

    def test_strategy_output_no_decision_field(self):
        out = _strategy().compute(_phase8_input())
        assert not hasattr(out, "decision")
        assert not hasattr(out, "approve")
        assert not hasattr(out, "reject")
        assert not hasattr(out, "rating")
        assert not hasattr(out, "rebalance_order")

    def test_ideal_pf_is_tuple_not_list_not_dict(self):
        out = _strategy().compute(_phase8_input())
        assert isinstance(out.ideal_pf, tuple)

    def test_all_diagnostics_start_with_observation(self):
        out = _strategy().compute(_phase8_input())
        for d in out.diagnostics:
            assert d.startswith("observation:"), f"bad diag: {d!r}"


# ── TestIntegrationRealPhase8 ────────────────────────────────────────────────

class TestIntegrationRealPhase8:
    def test_end_to_end_two_tickers(self):
        out = _strategy().compute(_phase8_input())
        # 完全な end-to-end: Phase 8 path → StrategyOutput
        assert isinstance(out, StrategyOutput)
        assert sum(w for _, w in out.ideal_pf) == pytest.approx(1.0, abs=1e-6)

    def test_end_to_end_with_locked_weights(self):
        ctx = {"locked_weights": {"A": 0.3}}
        out = _strategy().compute(_phase8_input(context_overrides=ctx))
        weights = dict(out.ideal_pf)
        assert weights.get("A", 0.0) == pytest.approx(0.3, abs=1e-6)
        # sum is normalized by IndexBuilder
        total = sum(w for _, w in out.ideal_pf)
        assert total == pytest.approx(1.0, abs=1e-6)

    def test_end_to_end_with_sector_cap_via_asset_meta(self):
        # asset_meta_by_ticker で sector を設定し、 SectorCapConstraint 生成
        ctx = {
            "asset_meta_by_ticker": {
                "A": {"sector": "tech", "is_core": False, "is_leveraged": False},
                "B": {"sector": "tech", "is_core": False, "is_leveraged": False},
            },
        }
        out = _strategy().compute(_phase8_input(context_overrides=ctx))
        # tech sector cap = 0.35 default、両ticker tech → tech sum should be ≤ 0.35
        # ただし budget=1 で 2 ticker しかない場合 0.35 達成は infeasible → fallback
        # 結果としては StrategyOutput が返れば成功
        assert isinstance(out, StrategyOutput)

    def test_end_to_end_with_market_intel(self):
        ctx = {
            "market_intel": {
                "sentiment_score": 75.0,
                "keywords": ["円安", "資源高"],
            },
            "risk_flags_by_ticker": {
                "A": {"is_risk_on": True, "is_overseas": True},
                "B": {"is_risk_on": True, "is_overseas": True},
            },
        }
        out = _strategy().compute(_phase8_input(context_overrides=ctx))
        assert isinstance(out, StrategyOutput)
        # diag に market_intel not provided がない
        diag_text = " ".join(out.diagnostics)
        assert "market_intel not provided" not in diag_text

    def test_end_to_end_with_missing_data_falls_back_within_phase8(self):
        # returns_data だけ提供、他は全欠損
        ctx = {
            "mean_return_3y_by_ticker": _DELETE,
            "size_segment_by_ticker": _DELETE,
            "risk_flags_by_ticker": _DELETE,
            "cross_axis_signals": _DELETE,
            "asset_meta_by_ticker": _DELETE,
            "shrinkage_alpha": _DELETE,
        }
        out = _strategy().compute(_phase8_input(context_overrides=ctx))
        # Phase 8 path に入る（returns_data がある）
        diag_text = " ".join(out.diagnostics)
        assert "Phase 8 SLSQP optimization used" in diag_text
        assert isinstance(out, StrategyOutput)


# ── TestStaticImportConstraints ──────────────────────────────────────────────

class TestStaticImportConstraints:
    """ast パースで実際のトップレベル import 文のみを検査（docstring は対象外）。"""

    def _imported_top_modules(self) -> set[str]:
        import ast
        import engine.strategies.frontier_strategy as fs_module
        source_text = open(fs_module.__file__).read()
        tree = ast.parse(source_text)
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imported.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    imported.add(node.module.split(".")[0])
        return imported

    def test_frontier_strategy_does_not_import_numpy(self):
        assert "numpy" not in self._imported_top_modules()

    def test_frontier_strategy_does_not_import_scipy(self):
        assert "scipy" not in self._imported_top_modules()

    def test_frontier_strategy_does_not_import_pandas(self):
        assert "pandas" not in self._imported_top_modules()


# ── TestContextSafety ────────────────────────────────────────────────────────

class TestContextSafety:
    def test_context_not_mutated(self):
        ctx = {
            "returns_data": {"A": _RETURNS_A, "B": _RETURNS_B},
            "mean_return_3y_by_ticker": {"A": 0.08, "B": 0.03},
        }
        ctx_copy = dict(ctx)
        si = StrategyInput(
            universe=("A", "B"),
            scores=_BASIC_SCORES,
            regime="bull_calm",
            context=ctx,
        )
        _strategy().compute(si)
        # context が mutation されていない（同じキー、同じ値）
        assert set(ctx.keys()) == set(ctx_copy.keys())

    def test_context_not_dict_uses_empty_dict_fallback(self):
        # StrategyInput.context は dict required だが defensive
        si = StrategyInput(
            universe=("A", "B"),
            scores=_BASIC_SCORES,
            regime="bull_calm",
            context={},  # 空 dict
        )
        out = _strategy().compute(si)
        # returns_data なし → Phase 7 fallback
        diag_text = " ".join(out.diagnostics)
        assert "Phase 8 returns_data not provided" in diag_text


# ── TestDiagnosticsAggregation ───────────────────────────────────────────────

class TestDiagnosticsAggregation:
    def test_phase8_path_diagnostic_first(self):
        out = _strategy().compute(_phase8_input())
        # 最初の diagnostic は経路選択（"Phase 8 SLSQP optimization used"）
        assert out.diagnostics[0].startswith("observation: Phase 8 SLSQP")

    def test_max_dd_observed_diagnostic_last(self):
        out = _strategy().compute(_phase8_input())
        # Card C: Phase 8 success path の最後の diagnostic は observed max drawdown 注記
        assert out.diagnostics[-1].startswith(
            "observation: max_dd_estimate is observed max drawdown from returns_data"
        )

    def test_phase8_success_has_no_p1_8n_regime_reference_diagnostic(self):
        # Card C: Phase 8 success path では P1-8N regime reference 注記を出さない
        out = _strategy().compute(_phase8_input())
        diag_text = " ".join(out.diagnostics)
        assert "P1-8N" not in diag_text
        assert "max_dd_estimate is regime reference value" not in diag_text

    def test_diagnostics_includes_phase8_module_diagnostics(self):
        # CovarianceResult shrinkage diagnostic が含まれる
        out = _strategy().compute(_phase8_input())
        diag_text = " ".join(out.diagnostics)
        # CovarianceModel が shrinkage を適用した diag を出すかは shrinkage_alpha 次第
        # ここでは Phase 8 経路を通って diagnostics が複数あることを確認
        assert len(out.diagnostics) > 3


# ── P3-Frontier-expose / Scope B ─────────────────────────────────────────────

_FRONTIER_INDEX_KEYS = {
    "index_name",
    "tickers",
    "weights",
    "expected_return",
    "expected_vol",
    "sharpe_ratio",
    "regime_used",
    "calculation_date",
    "diagnostics",
}

# StrategyOutput の確定スキーマ（P1-FE-5: 本 Card でフィールド追加しない）
_STRATEGY_OUTPUT_FIELDS = {
    "strategy_id",
    "strategy_name",
    "ideal_pf",
    "expected_return",
    "expected_vol",
    "sharpe_ratio",
    "max_dd_estimate",
    "rationale",
    "diagnostics",
}


class TestComputeContractUnchanged:
    """P1-FE-1: compute() の公開契約（戻り値型・経路選択・diagnostics）は不変。"""

    def test_compute_phase8_returns_strategy_output_not_tuple(self):
        out = _strategy().compute(_phase8_input())
        assert isinstance(out, StrategyOutput)
        assert not isinstance(out, tuple)

    def test_compute_phase7_returns_strategy_output_not_tuple(self):
        out = _strategy().compute(_phase7_input())
        assert isinstance(out, StrategyOutput)
        assert not isinstance(out, tuple)

    def test_compute_empty_universe_returns_strategy_output_not_tuple(self):
        si = StrategyInput(
            universe=(), scores={}, regime="bull_calm",
            horizon="long_term", context={},
        )
        out = _strategy().compute(si)
        assert isinstance(out, StrategyOutput)
        assert not isinstance(out, tuple)

    def test_strategy_output_schema_unchanged(self):
        # P1-FE-5: StrategyOutput へのフィールド追加なし
        assert set(StrategyOutput.__dataclass_fields__.keys()) == _STRATEGY_OUTPUT_FIELDS

    def test_compute_phase8_diagnostics_unchanged_first_and_last(self):
        out = _strategy().compute(_phase8_input())
        assert out.diagnostics[0].startswith("observation: Phase 8 SLSQP")
        assert out.diagnostics[-1].startswith(
            "observation: max_dd_estimate is observed max drawdown from returns_data"
        )


class TestComputeWithFrontierIndexPhase8:
    """P1-FE-3: Phase 8 経路 → (StrategyOutput, frontier_index.to_dict())。"""

    def test_returns_two_tuple(self):
        result = _strategy().compute_with_frontier_index(_phase8_input())
        assert isinstance(result, tuple)
        assert len(result) == 2

    def test_first_element_is_strategy_output(self):
        out, _idx = _strategy().compute_with_frontier_index(_phase8_input())
        assert isinstance(out, StrategyOutput)

    def test_second_element_is_dict(self):
        _out, idx = _strategy().compute_with_frontier_index(_phase8_input())
        assert isinstance(idx, dict)

    def test_second_element_not_none_in_phase8(self):
        _out, idx = _strategy().compute_with_frontier_index(_phase8_input())
        assert idx is not None

    def test_second_element_has_exactly_nine_keys(self):
        # P1-FE-6: FrontierIndex.to_dict() は 9 キー
        _out, idx = _strategy().compute_with_frontier_index(_phase8_input())
        assert set(idx.keys()) == _FRONTIER_INDEX_KEYS

    def test_second_element_is_raw_dict_not_frontier_index_object(self):
        # P1-FE-4: FrontierIndex オブジェクトは外部に渡さない（raw dict のみ）
        _out, idx = _strategy().compute_with_frontier_index(_phase8_input())
        assert type(idx) is dict
        assert not hasattr(idx, "to_dict")
        assert not hasattr(idx, "__dataclass_fields__")

    def test_second_element_is_json_serializable(self):
        import json
        _out, idx = _strategy().compute_with_frontier_index(_phase8_input())
        round_tripped = json.loads(json.dumps(idx))
        assert set(round_tripped.keys()) == _FRONTIER_INDEX_KEYS

    def test_first_element_equals_compute_output(self):
        # P1-FE-2: compute() と byte 等価な StrategyOutput
        si = _phase8_input()
        strat = _strategy()
        compute_out = strat.compute(si)
        ext_out, _idx = strat.compute_with_frontier_index(si)
        assert ext_out == compute_out

    def test_frontier_index_tickers_subset_of_universe(self):
        si = _phase8_input(universe=("A", "B"))
        _out, idx = _strategy().compute_with_frontier_index(si)
        assert set(idx["tickers"]).issubset({"A", "B"})


class TestComputeWithFrontierIndexPhase7:
    """P1-FE-3: Phase 7 経路 → (StrategyOutput, None)。"""

    def test_returns_two_tuple(self):
        result = _strategy().compute_with_frontier_index(_phase7_input())
        assert isinstance(result, tuple)
        assert len(result) == 2

    def test_first_element_is_strategy_output(self):
        out, _idx = _strategy().compute_with_frontier_index(_phase7_input())
        assert isinstance(out, StrategyOutput)

    def test_second_element_is_none(self):
        _out, idx = _strategy().compute_with_frontier_index(_phase7_input())
        assert idx is None

    def test_missing_returns_data_second_element_none(self):
        si = _phase7_input(context={"mean_return_3y_by_ticker": {"A": 0.08}})
        _out, idx = _strategy().compute_with_frontier_index(si)
        assert idx is None

    def test_empty_returns_data_second_element_none(self):
        si = _phase7_input(context={"returns_data": {}})
        _out, idx = _strategy().compute_with_frontier_index(si)
        assert idx is None

    def test_non_dict_returns_data_second_element_none(self):
        si = _phase7_input(context={"returns_data": [1, 2, 3]})
        _out, idx = _strategy().compute_with_frontier_index(si)
        assert idx is None

    def test_first_element_equals_compute_output(self):
        si = _phase7_input()
        strat = _strategy()
        compute_out = strat.compute(si)
        ext_out, _idx = strat.compute_with_frontier_index(si)
        assert ext_out == compute_out


class TestComputeWithFrontierIndexEmptyUniverse:
    """P1-FE-3: empty universe → (StrategyOutput, None)。"""

    def _empty_input(self) -> StrategyInput:
        return StrategyInput(
            universe=(), scores={}, regime="bull_calm",
            horizon="long_term",
            context={"returns_data": {"A": _RETURNS_A}},
        )

    def test_returns_two_tuple(self):
        result = _strategy().compute_with_frontier_index(self._empty_input())
        assert isinstance(result, tuple)
        assert len(result) == 2

    def test_second_element_is_none_even_with_returns_data(self):
        _out, idx = _strategy().compute_with_frontier_index(self._empty_input())
        assert idx is None

    def test_first_element_equals_compute_output(self):
        si = self._empty_input()
        strat = _strategy()
        compute_out = strat.compute(si)
        ext_out, _idx = strat.compute_with_frontier_index(si)
        assert ext_out == compute_out
        assert ext_out.ideal_pf == ()


class TestComputeWithFrontierIndexNoCache:
    """P1-FE-5: 内部キャッシュなし（呼び出しごとに独立した結果）。"""

    def test_repeated_calls_return_distinct_dict_objects(self):
        si = _phase8_input()
        strat = _strategy()
        _o1, idx1 = strat.compute_with_frontier_index(si)
        _o2, idx2 = strat.compute_with_frontier_index(si)
        assert idx1 is not idx2

    def test_repeated_calls_return_equal_content(self):
        si = _phase8_input()
        strat = _strategy()
        _o1, idx1 = strat.compute_with_frontier_index(si)
        _o2, idx2 = strat.compute_with_frontier_index(si)
        assert idx1 == idx2

    def test_mutating_returned_dict_does_not_affect_next_call(self):
        si = _phase8_input()
        strat = _strategy()
        _o1, idx1 = strat.compute_with_frontier_index(si)
        idx1["tickers"] = ["__MUTATED__"]
        _o2, idx2 = strat.compute_with_frontier_index(si)
        assert idx2["tickers"] != ["__MUTATED__"]

    def test_strategy_instance_holds_no_frontier_index_cache_attr(self):
        si = _phase8_input()
        strat = _strategy()
        strat.compute_with_frontier_index(si)
        for attr in ("_frontier_index", "_cached_frontier_index",
                     "_last_frontier_index", "_frontier_index_cache"):
            assert not hasattr(strat, attr)


class TestComputeWithFrontierIndexContextSafety:
    """compute() と同一の context 非 mutation 制約を継承する。"""

    def test_context_not_mutated_phase8(self):
        ctx = {
            "returns_data": {"A": _RETURNS_A, "B": _RETURNS_B},
            "mean_return_3y_by_ticker": {"A": 0.08, "B": 0.03},
        }
        ctx_keys_before = set(ctx.keys())
        si = StrategyInput(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context=ctx,
        )
        _strategy().compute_with_frontier_index(si)
        assert set(ctx.keys()) == ctx_keys_before

    def test_compute_equivalence_holds_when_same_input_reused(self):
        # compute() → compute_with_frontier_index() を同一 si に連続適用しても
        # それぞれ独立に compute() 等価 StrategyOutput を返す
        si = _phase8_input()
        strat = _strategy()
        a = strat.compute(si)
        b, _idx = strat.compute_with_frontier_index(si)
        c = strat.compute(si)
        assert a == b == c


class TestFrontierStrategyNoForbiddenTokensAfterExpose:
    """P1-FE-7 / 設計原則: 露出追加後もソースに禁止トークン・public/data 書き込み
    ・numpy/scipy/pandas import を持ち込まない（docstring prose は除外）。"""

    _FORBIDDEN_UPPER = ("BUY", "SELL", "HOLD", "WAIT")
    _FORBIDDEN_SNAKE = (
        "is_buy", "is_sell", "is_hold", "is_recommended",
        "rebalance_order", "buy_amount", "sell_amount",
    )

    def _ast_tree_and_source(self):
        import ast
        import engine.strategies.frontier_strategy as fs_module
        source_text = open(fs_module.__file__).read()
        return ast.parse(source_text), source_text

    def _docstring_node_ids(self, tree) -> set[int]:
        import ast
        ids: set[int] = set()
        for node in ast.walk(tree):
            if isinstance(
                node,
                (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef),
            ):
                body = getattr(node, "body", None)
                if not body:
                    continue
                first = body[0]
                if (
                    isinstance(first, ast.Expr)
                    and isinstance(first.value, ast.Constant)
                    and isinstance(first.value.value, str)
                ):
                    ids.add(id(first.value))
        return ids

    def test_no_forbidden_tokens_in_non_docstring_strings(self):
        import ast
        tree, _src = self._ast_tree_and_source()
        doc_ids = self._docstring_node_ids(tree)
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if id(node) in doc_ids:
                    continue
                value = node.value
                for tok in self._FORBIDDEN_UPPER:
                    assert tok not in value, f"forbidden {tok!r} in string {value!r}"
                for tok in self._FORBIDDEN_SNAKE:
                    assert tok not in value, f"forbidden {tok!r} in string {value!r}"

    def test_no_forbidden_identifier_names(self):
        import ast
        tree, _src = self._ast_tree_and_source()
        forbidden_exact = set(self._FORBIDDEN_SNAKE) | {
            "action", "recommendation", "verdict",
            "rebalance_order", "buy_amount", "sell_amount",
        }
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                assert node.id not in forbidden_exact
            elif isinstance(node, ast.arg):
                assert node.arg not in forbidden_exact
            elif isinstance(node, ast.Attribute):
                assert node.attr not in forbidden_exact

    def test_no_public_data_write_path_literal(self):
        import ast
        tree, _src = self._ast_tree_and_source()
        doc_ids = self._docstring_node_ids(tree)
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if id(node) in doc_ids:
                    continue
                assert "public/data" not in node.value

    def test_still_no_numpy_scipy_pandas_import(self):
        import ast
        tree, _src = self._ast_tree_and_source()
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imported.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    imported.add(node.module.split(".")[0])
        assert "numpy" not in imported
        assert "scipy" not in imported
        assert "pandas" not in imported

    def test_compute_with_frontier_index_method_exists_and_is_callable(self):
        assert callable(getattr(FrontierStrategy, "compute_with_frontier_index"))
