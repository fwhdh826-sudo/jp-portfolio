"""
test_index_builder.py — Card 8-3 テスト（index_builder.py）
scipy 1.13+ required（インストール済み）
"""
from __future__ import annotations

import pytest

from engine.frontier.covariance_model import (
    CovarianceInput,
    CovarianceModel,
)
from engine.frontier.optimizer_constraints import (
    BoundConstraint,
    ConstraintBuilder,
    ConstraintInput,
    OptimizerConstraints,
)
from engine.frontier.efficient_frontier import (
    EfficientFrontierInput,
    EfficientFrontierOptimizer,
    EfficientFrontierResult,
    OptimalWeights,
)
from engine.frontier.index_builder import (
    FrontierIndex,
    IndexBuilder,
    IndexBuilderInput,
)

# ── フィクスチャ ──────────────────────────────────────────────────────────────

def _builder() -> IndexBuilder:
    return IndexBuilder()


def _make_optimal(
    tickers=("A", "B"),
    weights=(0.6, 0.4),
    converged=True,
    msg="converged",
) -> OptimalWeights:
    return OptimalWeights(
        tickers=tickers,
        weights=weights,
        expected_return=0.08,
        expected_vol=0.15,
        sharpe_ratio=0.53,
        soft_penalty=0.0,
        solver_converged=converged,
        solver_message=msg,
        diagnostics=(),
    )


def _make_result(
    optimal=None,
    regime_used="bull_calm",
) -> EfficientFrontierResult:
    if optimal is None:
        optimal = _make_optimal()
    return EfficientFrontierResult(
        optimal=optimal,
        regime_used=regime_used,
        frontier_points=(),
        diagnostics=(),
    )


def _real_optimization_result() -> EfficientFrontierResult:
    """実 SLSQP 経由で得た結果を作成（soft_penalties=() で T7 を完全に無効化）"""
    cov = CovarianceModel().calculate(CovarianceInput(
        tickers=("A", "B"),
        returns_data={
            "A": [0.10, -0.05, 0.08, -0.03, 0.06],
            "B": [0.02, -0.01, 0.03, -0.01, 0.02],
        },
        shrinkage_alpha=0.0,
    ))
    constraints = OptimizerConstraints(
        tickers=("A", "B"),
        bounds=(
            BoundConstraint(ticker="A", lower=0.0, upper=1.0),
            BoundConstraint(ticker="B", lower=0.0, upper=1.0),
        ),
        sector_caps=(),
        group_constraints=(),
        soft_penalties=(),
        risk_aversion=3.0,
        budget_sum=1.0,
        regime_used="uncertain",
        diagnostics=(),
    )
    return EfficientFrontierOptimizer().optimize(EfficientFrontierInput(
        tickers=("A", "B"),
        expected_returns={"A": 0.10, "B": 0.04},
        cov_result=cov,
        constraints=constraints,
    ))


# ── TestFrontierIndex ────────────────────────────────────────────────────────

class TestFrontierIndex:
    def _make(self, **kw) -> FrontierIndex:
        defaults = dict(
            index_name="Frontier AI Index",
            tickers=("A", "B"),
            weights=(0.6, 0.4),
            expected_return=0.08,
            expected_vol=0.15,
            sharpe_ratio=0.53,
            regime_used="bull_calm",
            calculation_date="2026-05-13",
            diagnostics=("observation: test",),
        )
        defaults.update(kw)
        return FrontierIndex(**defaults)

    def test_basic_creation(self):
        idx = self._make()
        assert idx.index_name == "Frontier AI Index"

    def test_get_weight_known(self):
        idx = self._make()
        assert idx.get_weight("A") == pytest.approx(0.6)
        assert idx.get_weight("B") == pytest.approx(0.4)

    def test_get_weight_unknown_zero(self):
        idx = self._make()
        assert idx.get_weight("XXX") == pytest.approx(0.0)

    def test_to_dict_required_keys(self):
        d = self._make().to_dict()
        assert set(d.keys()) == {
            "index_name", "tickers", "weights",
            "expected_return", "expected_vol", "sharpe_ratio",
            "regime_used", "calculation_date", "diagnostics",
        }

    def test_index_name_default_in_dataclass(self):
        # FrontierIndex requires index_name; check IndexBuilderInput default
        ibi = IndexBuilderInput(frontier_result=_make_result())
        assert ibi.index_name == "Frontier AI Index"

    def test_frozen(self):
        idx = self._make()
        with pytest.raises((AttributeError, TypeError)):
            idx.index_name = "Other Index"  # type: ignore[misc]

    def test_to_dict_weights_is_list(self):
        d = self._make().to_dict()
        assert isinstance(d["weights"], list)

    def test_as_weight_dict_type(self):
        d = self._make().as_weight_dict()
        assert isinstance(d, dict)
        assert d["A"] == pytest.approx(0.6)


# ── TestIndexBuilderInput ────────────────────────────────────────────────────

class TestIndexBuilderInput:
    def test_basic_creation(self):
        inp = IndexBuilderInput(frontier_result=_make_result())
        assert inp.index_name == "Frontier AI Index"

    def test_invalid_context_becomes_empty_dict(self):
        inp = IndexBuilderInput(
            frontier_result=_make_result(),
            context="bad",  # type: ignore[arg-type]
        )
        assert inp.context == {}

    def test_frozen(self):
        inp = IndexBuilderInput(frontier_result=_make_result())
        with pytest.raises((AttributeError, TypeError)):
            inp.index_name = "Other"  # type: ignore[misc]

    def test_calculation_date_default_empty(self):
        inp = IndexBuilderInput(frontier_result=_make_result())
        assert inp.calculation_date == ""

    def test_empty_index_name_fallback(self):
        inp = IndexBuilderInput(
            frontier_result=_make_result(),
            index_name="",  # empty → fallback default
        )
        assert inp.index_name == "Frontier AI Index"


# ── TestIndexBuilder_Basic ───────────────────────────────────────────────────

class TestIndexBuilder_Basic:
    def test_build_returns_frontier_index(self):
        result = _builder().build(IndexBuilderInput(frontier_result=_make_result()))
        assert isinstance(result, FrontierIndex)

    def test_weights_sum_to_one(self):
        result = _builder().build(IndexBuilderInput(frontier_result=_make_result()))
        assert sum(result.weights) == pytest.approx(1.0, abs=1e-9)

    def test_tickers_match_optimal(self):
        opt = _make_optimal(tickers=("X", "Y", "Z"), weights=(0.3, 0.3, 0.4))
        result = _builder().build(IndexBuilderInput(frontier_result=_make_result(optimal=opt)))
        assert result.tickers == ("X", "Y", "Z")

    def test_expected_return_match_optimal(self):
        opt = _make_optimal()
        result = _builder().build(IndexBuilderInput(frontier_result=_make_result(optimal=opt)))
        assert result.expected_return == pytest.approx(opt.expected_return)

    def test_expected_vol_match_optimal(self):
        opt = _make_optimal()
        result = _builder().build(IndexBuilderInput(frontier_result=_make_result(optimal=opt)))
        assert result.expected_vol == pytest.approx(opt.expected_vol)

    def test_sharpe_ratio_match_optimal(self):
        opt = _make_optimal()
        result = _builder().build(IndexBuilderInput(frontier_result=_make_result(optimal=opt)))
        assert result.sharpe_ratio == pytest.approx(opt.sharpe_ratio)

    def test_regime_used_match_frontier_result(self):
        result = _builder().build(IndexBuilderInput(
            frontier_result=_make_result(regime_used="bear"),
        ))
        assert result.regime_used == "bear"

    def test_index_name_from_input(self):
        result = _builder().build(IndexBuilderInput(
            frontier_result=_make_result(),
            index_name="Custom Index",
        ))
        assert result.index_name == "Custom Index"

    def test_calculation_date_preserved(self):
        result = _builder().build(IndexBuilderInput(
            frontier_result=_make_result(),
            calculation_date="2026-05-13",
        ))
        assert result.calculation_date == "2026-05-13"


# ── TestIndexBuilder_Normalization ───────────────────────────────────────────

class TestIndexBuilder_Normalization:
    def test_weights_sum_within_tolerance(self):
        # Slight drift: 0.6 + 0.4 = 1.0 exactly but test with drift
        opt = _make_optimal(weights=(0.6000001, 0.4000002))
        result = _builder().build(IndexBuilderInput(frontier_result=_make_result(optimal=opt)))
        assert abs(sum(result.weights) - 1.0) < 1e-9

    def test_floating_point_drift_normalized(self):
        # weights that sum to 0.99 → should be normalized to 1.0
        opt = _make_optimal(weights=(0.5, 0.49))
        result = _builder().build(IndexBuilderInput(frontier_result=_make_result(optimal=opt)))
        assert sum(result.weights) == pytest.approx(1.0, abs=1e-9)

    def test_weights_non_negative_after_normalization(self):
        # Tiny negative due to floating point → should be clipped to 0
        opt = _make_optimal(weights=(-1e-12, 1.0))
        result = _builder().build(IndexBuilderInput(frontier_result=_make_result(optimal=opt)))
        assert all(w >= 0.0 for w in result.weights)


# ── TestIndexBuilder_Diagnostics ─────────────────────────────────────────────

class TestIndexBuilder_Diagnostics:
    def test_all_diagnostics_start_with_observation(self):
        result = _builder().build(IndexBuilderInput(frontier_result=_make_result()))
        for d in result.diagnostics:
            assert d.startswith("observation:"), f"bad diag: {d!r}"

    def test_calculation_only_disclaimer_present(self):
        result = _builder().build(IndexBuilderInput(frontier_result=_make_result()))
        diag_text = " ".join(result.diagnostics)
        assert "not an order, not a recommendation" in diag_text

    def test_calculation_date_empty_still_works(self):
        result = _builder().build(IndexBuilderInput(frontier_result=_make_result()))
        assert isinstance(result, FrontierIndex)

    def test_solver_not_converged_diagnostic(self):
        opt = _make_optimal(converged=False, msg="failed to converge")
        result = _builder().build(IndexBuilderInput(frontier_result=_make_result(optimal=opt)))
        diag_text = " ".join(result.diagnostics)
        assert "did not converge" in diag_text or "fallback" in diag_text

    def test_no_prohibited_fields_in_frontier_index(self):
        result = _builder().build(IndexBuilderInput(frontier_result=_make_result()))
        for prohibited in (
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "verdict", "decision", "approve", "reject",
            "rating", "order", "trade_order", "rebalance_order",
            "buy_amount", "sell_amount", "shares", "quantity",
        ):
            assert not hasattr(result, prohibited), f"prohibited: {prohibited}"


# ── TestIndexBuilder_Integration ─────────────────────────────────────────────

class TestIndexBuilder_Integration:
    def test_build_from_real_frontier_result(self):
        real_result = _real_optimization_result()
        idx = _builder().build(IndexBuilderInput(
            frontier_result=real_result,
            index_name="Test Frontier Index",
            calculation_date="2026-05-13",
        ))
        assert idx.index_name == "Test Frontier Index"
        assert idx.calculation_date == "2026-05-13"

    def test_weights_non_negative(self):
        real_result = _real_optimization_result()
        idx = _builder().build(IndexBuilderInput(frontier_result=real_result))
        assert all(w >= 0.0 for w in idx.weights)

    def test_weights_sum_exactly_one(self):
        real_result = _real_optimization_result()
        idx = _builder().build(IndexBuilderInput(frontier_result=real_result))
        assert sum(idx.weights) == pytest.approx(1.0, abs=1e-9)

    def test_as_weight_dict_non_empty(self):
        real_result = _real_optimization_result()
        idx = _builder().build(IndexBuilderInput(frontier_result=real_result))
        d = idx.as_weight_dict()
        assert len(d) == 2

    def test_to_dict_json_serializable(self):
        import json
        real_result = _real_optimization_result()
        idx = _builder().build(IndexBuilderInput(frontier_result=real_result))
        serialized = json.dumps(idx.to_dict())
        assert "Frontier AI Index" in serialized

    def test_build_from_non_converged_result(self):
        opt = _make_optimal(weights=(0.5, 0.5), converged=False, msg="non-convergence")
        idx = _builder().build(IndexBuilderInput(frontier_result=_make_result(optimal=opt)))
        # Should still build successfully
        assert isinstance(idx, FrontierIndex)
        assert sum(idx.weights) == pytest.approx(1.0, abs=1e-9)


# ── TestIndexBuilder_DefaultIndexName ────────────────────────────────────────

class TestIndexBuilder_DefaultIndexName:
    def test_default_index_name_when_input_default(self):
        idx = _builder().build(IndexBuilderInput(frontier_result=_make_result()))
        assert idx.index_name == "Frontier AI Index"

    def test_custom_index_name_respected(self):
        idx = _builder().build(IndexBuilderInput(
            frontier_result=_make_result(),
            index_name="Quantum Index 2026",
        ))
        assert idx.index_name == "Quantum Index 2026"
