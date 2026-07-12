"""
test_efficient_frontier.py — Card 8-3 テスト（efficient_frontier.py）
scipy 1.13+ required（インストール済み）
"""
from __future__ import annotations

import math
import pytest

from engine.frontier.covariance_model import (
    CovarianceModel,
    CovarianceResult,
    CovarianceInput,
    DEFAULT_MONTHLY_VARIANCE,
)
from engine.frontier.optimizer_constraints import (
    BoundConstraint,
    ConstraintBuilder,
    ConstraintInput,
    OptimizerConstraints,
    SectorCapConstraint,
    SoftPenaltyParam,
)
from engine.frontier.efficient_frontier import (
    _SCIPY_AVAILABLE,
    EfficientFrontierInput,
    EfficientFrontierOptimizer,
    EfficientFrontierResult,
    OptimalWeights,
)

# ── フィクスチャ ──────────────────────────────────────────────────────────────

def _opt() -> EfficientFrontierOptimizer:
    return EfficientFrontierOptimizer()


def _cov_two_tickers() -> CovarianceResult:
    """A, B の 2 ticker covariance（A 高 vol, B 低 vol）"""
    return CovarianceModel().calculate(CovarianceInput(
        tickers=("A", "B"),
        returns_data={
            "A": [0.10, -0.08, 0.12, -0.06, 0.04],
            "B": [0.02, -0.01, 0.03, -0.01, 0.02],
        },
        shrinkage_alpha=0.0,
        min_periods=3,
    ))


def _build_constraints(
    tickers=("A", "B"),
    asset_meta=None,
    locked_weights=None,
    max_single_weight=1.0,  # 2-ticker テストで T7 を無効化（feasible に）
) -> OptimizerConstraints:
    if asset_meta is None:
        asset_meta = {
            "A": {"sector": "tech", "is_core": False, "is_leveraged": False},
            "B": {"sector": "finance", "is_core": False, "is_leveraged": False},
        }
    if locked_weights is None:
        locked_weights = {}
    return ConstraintBuilder().build(ConstraintInput(
        tickers=tickers,
        asset_meta=asset_meta,
        locked_weights=locked_weights,
        max_single_weight=max_single_weight,
    ))


def _basic_input(
    tickers=("A", "B"),
    expected_returns=None,
    locked_weights=None,
    max_single_weight=1.0,
) -> EfficientFrontierInput:
    if expected_returns is None:
        expected_returns = {"A": 0.10, "B": 0.04}
    return EfficientFrontierInput(
        tickers=tickers,
        expected_returns=expected_returns,
        cov_result=_cov_two_tickers(),
        constraints=_build_constraints(
            tickers=tickers,
            locked_weights=locked_weights,
            max_single_weight=max_single_weight,
        ),
    )


def _clean_constraints(
    tickers=("A", "B"),
    locked_weights=None,
    sector_caps=(),
    risk_aversion=3.0,
) -> OptimizerConstraints:
    """SLSQP 収束テスト用: soft_penalties=() の最小制約セット。"""
    locked = locked_weights or {}
    bounds_list = []
    for t in tickers:
        if t in locked:
            w = float(locked[t])
            bounds_list.append(BoundConstraint(ticker=t, lower=w, upper=w))
        else:
            bounds_list.append(BoundConstraint(ticker=t, lower=0.0, upper=1.0))
    return OptimizerConstraints(
        tickers=tickers,
        bounds=tuple(bounds_list),
        sector_caps=tuple(sector_caps),
        group_constraints=(),
        soft_penalties=(),
        risk_aversion=risk_aversion,
        budget_sum=1.0,
        regime_used="uncertain",
        diagnostics=(),
    )


def _clean_input(
    tickers=("A", "B"),
    expected_returns=None,
    locked_weights=None,
    sector_caps=(),
) -> EfficientFrontierInput:
    """SLSQP 収束テスト用: clean constraints の input。"""
    if expected_returns is None:
        expected_returns = {"A": 0.10, "B": 0.04}
    return EfficientFrontierInput(
        tickers=tickers,
        expected_returns=expected_returns,
        cov_result=_cov_two_tickers(),
        constraints=_clean_constraints(
            tickers=tickers,
            locked_weights=locked_weights,
            sector_caps=sector_caps,
        ),
    )


# ── TestEfficientFrontierInput ────────────────────────────────────────────────

class TestEfficientFrontierInput:
    def test_valid_creation(self):
        inp = _basic_input()
        assert inp.tickers == ("A", "B")

    def test_list_tickers_converted_to_tuple(self):
        inp = EfficientFrontierInput(
            tickers=["A", "B"],  # type: ignore[arg-type]
            expected_returns={},
            cov_result=_cov_two_tickers(),
            constraints=_build_constraints(),
        )
        assert isinstance(inp.tickers, tuple)

    def test_invalid_context_becomes_empty_dict(self):
        inp = EfficientFrontierInput(
            tickers=("A",),
            expected_returns={},
            cov_result=_cov_two_tickers(),
            constraints=_build_constraints(("A",)),
            context="bad",  # type: ignore[arg-type]
        )
        assert inp.context == {}

    def test_n_frontier_points_default_zero(self):
        inp = _basic_input()
        assert inp.n_frontier_points == 0

    def test_risk_free_rate_default_zero(self):
        inp = _basic_input()
        assert inp.risk_free_rate == pytest.approx(0.0)

    def test_frozen(self):
        inp = _basic_input()
        with pytest.raises((AttributeError, TypeError)):
            inp.risk_free_rate = 0.05  # type: ignore[misc]

    def test_cov_result_field_type(self):
        inp = _basic_input()
        assert isinstance(inp.cov_result, CovarianceResult)

    def test_constraints_field_type(self):
        inp = _basic_input()
        assert isinstance(inp.constraints, OptimizerConstraints)


# ── TestOptimalWeights ───────────────────────────────────────────────────────

class TestOptimalWeights:
    def _make(self, **kw) -> OptimalWeights:
        defaults = dict(
            tickers=("A", "B"),
            weights=(0.6, 0.4),
            expected_return=0.08,
            expected_vol=0.15,
            sharpe_ratio=0.53,
            soft_penalty=0.0,
            solver_converged=True,
            solver_message="converged",
            diagnostics=("observation: test",),
        )
        defaults.update(kw)
        return OptimalWeights(**defaults)

    def test_basic_creation(self):
        ow = self._make()
        assert ow.tickers == ("A", "B")

    def test_to_dict_required_keys(self):
        d = self._make().to_dict()
        assert set(d.keys()) == {
            "tickers", "weights", "expected_return", "expected_vol",
            "sharpe_ratio", "soft_penalty", "solver_converged",
            "solver_message", "diagnostics",
        }

    def test_as_weight_dict_type(self):
        d = self._make().as_weight_dict()
        assert isinstance(d, dict)

    def test_as_weight_dict_values_match(self):
        ow = self._make(tickers=("A", "B"), weights=(0.3, 0.7))
        d = ow.as_weight_dict()
        assert d["A"] == pytest.approx(0.3)
        assert d["B"] == pytest.approx(0.7)

    def test_get_weight_known(self):
        ow = self._make(tickers=("A",), weights=(1.0,))
        assert ow.get_weight("A") == pytest.approx(1.0)

    def test_get_weight_unknown(self):
        ow = self._make()
        assert ow.get_weight("XXX") == pytest.approx(0.0)

    def test_frozen(self):
        ow = self._make()
        with pytest.raises((AttributeError, TypeError)):
            ow.solver_converged = False  # type: ignore[misc]


# ── TestEfficientFrontierResult ──────────────────────────────────────────────

class TestEfficientFrontierResult:
    def _make_result(self) -> EfficientFrontierResult:
        opt = OptimalWeights(
            tickers=("A",), weights=(1.0,),
            expected_return=0.1, expected_vol=0.15,
            sharpe_ratio=0.67, soft_penalty=0.0,
            solver_converged=True, solver_message="converged",
            diagnostics=(),
        )
        return EfficientFrontierResult(
            optimal=opt, regime_used="bull_calm",
            frontier_points=(), diagnostics=(),
        )

    def test_optimal_field_type(self):
        assert isinstance(self._make_result().optimal, OptimalWeights)

    def test_to_dict_structure(self):
        d = self._make_result().to_dict()
        assert "optimal" in d
        assert "regime_used" in d
        assert "frontier_points" in d
        assert "diagnostics" in d
        assert isinstance(d["optimal"], dict)

    def test_get_weight_delegates_to_optimal(self):
        r = self._make_result()
        assert r.get_weight("A") == pytest.approx(1.0)
        assert r.get_weight("XXX") == pytest.approx(0.0)

    def test_frontier_points_default_empty(self):
        r = self._make_result()
        assert r.frontier_points == ()

    def test_frozen(self):
        r = self._make_result()
        with pytest.raises((AttributeError, TypeError)):
            r.regime_used = "bear"  # type: ignore[misc]


# ── TestSoftPenalty ──────────────────────────────────────────────────────────

class TestSoftPenalty:
    def _build_with_soft_constraint(
        self,
        constraint_id="T7",
        tickers=("A",),
        upper_warn=0.08,
        upper_severe=0.12,
        lower_warn=0.0,
        lower_severe=0.0,
        coef_warn=8.0,
        coef_severe=80.0,
    ) -> OptimizerConstraints:
        sp = SoftPenaltyParam(
            constraint_id=constraint_id,
            tickers=tickers,
            lower_warn=lower_warn,
            upper_warn=upper_warn,
            penalty_coef_warn=coef_warn,
            lower_severe=lower_severe,
            upper_severe=upper_severe,
            penalty_coef_severe=coef_severe,
        )
        return OptimizerConstraints(
            tickers=("A", "B"),
            bounds=(),
            sector_caps=(),
            group_constraints=(),
            soft_penalties=(sp,),
            risk_aversion=3.0,
            budget_sum=1.0,
            regime_used="uncertain",
            diagnostics=(),
        )

    def test_no_violations_zero_penalty(self):
        c = self._build_with_soft_constraint()
        p = _opt()._calc_soft_penalty([0.05, 0.95], c, ("A", "B"))
        assert p == pytest.approx(0.0)

    def test_t7_below_upper_warn(self):
        c = self._build_with_soft_constraint()
        p = _opt()._calc_soft_penalty([0.05, 0.95], c, ("A", "B"))
        assert p == pytest.approx(0.0)

    def test_t7_above_upper_warn(self):
        c = self._build_with_soft_constraint()  # T7 warn=0.08, coef=8.0
        # A=0.10: violation_warn = 0.02, penalty_warn = 8.0 * 0.02 = 0.16
        p = _opt()._calc_soft_penalty([0.10, 0.90], c, ("A", "B"))
        assert p == pytest.approx(0.16, abs=1e-9)

    def test_t7_above_upper_severe(self):
        c = self._build_with_soft_constraint()
        # A=0.15: warn=8.0*(0.15-0.08)=0.56, severe=80.0*(0.15-0.12)=2.4, total=2.96
        p = _opt()._calc_soft_penalty([0.15, 0.85], c, ("A", "B"))
        assert p == pytest.approx(8.0 * 0.07 + 80.0 * 0.03, abs=1e-9)

    def test_t7_at_upper_warn_boundary_zero(self):
        c = self._build_with_soft_constraint()
        # A=0.08 exactly at upper_warn → violation = 0
        p = _opt()._calc_soft_penalty([0.08, 0.92], c, ("A", "B"))
        assert p == pytest.approx(0.0)

    def test_t5_core_meets_floor(self):
        c = self._build_with_soft_constraint(
            constraint_id="T5", tickers=("A", "B"),
            lower_warn=0.55, lower_severe=0.45,
            upper_warn=1.0, upper_severe=1.0,
            coef_warn=5.0, coef_severe=50.0,
        )
        # core sum = 1.0 >= 0.55, no violation
        p = _opt()._calc_soft_penalty([0.60, 0.40], c, ("A", "B"))
        assert p == pytest.approx(0.0)

    def test_t5_below_lower_warn(self):
        c = self._build_with_soft_constraint(
            constraint_id="T5", tickers=("A",),
            lower_warn=0.55, lower_severe=0.45,
            upper_warn=1.0, upper_severe=1.0,
            coef_warn=5.0, coef_severe=50.0,
        )
        # A=0.50: lower_viol_warn=0.05, penalty=5*0.05=0.25
        p = _opt()._calc_soft_penalty([0.50, 0.50], c, ("A", "B"))
        assert p == pytest.approx(5.0 * 0.05, abs=1e-9)

    def test_t5_below_lower_severe(self):
        c = self._build_with_soft_constraint(
            constraint_id="T5", tickers=("A",),
            lower_warn=0.55, lower_severe=0.45,
            upper_warn=1.0, upper_severe=1.0,
            coef_warn=5.0, coef_severe=50.0,
        )
        # A=0.40: warn=5*(0.55-0.40)=0.75, severe=50*(0.45-0.40)=2.5, total=3.25
        p = _opt()._calc_soft_penalty([0.40, 0.60], c, ("A", "B"))
        assert p == pytest.approx(5.0 * 0.15 + 50.0 * 0.05, abs=1e-9)

    def test_t6_below_upper_warn(self):
        c = self._build_with_soft_constraint(
            constraint_id="T6", tickers=("B",),
            lower_warn=0.0, lower_severe=0.0,
            upper_warn=0.20, upper_severe=0.25,
            coef_warn=10.0, coef_severe=100.0,
        )
        # B=0.15 <= 0.20, no violation
        p = _opt()._calc_soft_penalty([0.85, 0.15], c, ("A", "B"))
        assert p == pytest.approx(0.0)

    def test_t6_above_upper_warn(self):
        c = self._build_with_soft_constraint(
            constraint_id="T6", tickers=("B",),
            lower_warn=0.0, lower_severe=0.0,
            upper_warn=0.20, upper_severe=0.25,
            coef_warn=10.0, coef_severe=100.0,
        )
        # B=0.30: warn=10*(0.30-0.20)=1.0, severe=100*(0.30-0.25)=5.0, total=6.0
        p = _opt()._calc_soft_penalty([0.70, 0.30], c, ("A", "B"))
        assert p == pytest.approx(10.0 * 0.10 + 100.0 * 0.05, abs=1e-9)

    def test_t8_empty_tickers_no_contribution(self):
        sp_t8 = SoftPenaltyParam(
            constraint_id="T8",
            tickers=(),  # 空
            lower_warn=0.077, upper_warn=1.0,
            penalty_coef_warn=6.0,
            lower_severe=0.05, upper_severe=1.0,
            penalty_coef_severe=60.0,
        )
        c = OptimizerConstraints(
            tickers=("A",),
            bounds=(),
            sector_caps=(),
            group_constraints=(),
            soft_penalties=(sp_t8,),
            risk_aversion=3.0, budget_sum=1.0,
            regime_used="uncertain", diagnostics=(),
        )
        p = _opt()._calc_soft_penalty([1.0], c, ("A",))
        assert p == pytest.approx(0.0)

    def test_multiple_constraints_additive(self):
        # T7 on A (warn=0.08, coef=8.0)
        sp1 = SoftPenaltyParam(
            constraint_id="T7", tickers=("A",),
            lower_warn=0.0, upper_warn=0.08, penalty_coef_warn=8.0,
            lower_severe=0.0, upper_severe=0.12, penalty_coef_severe=80.0,
        )
        # T6 on B (warn=0.20, coef=10.0)
        sp2 = SoftPenaltyParam(
            constraint_id="T6", tickers=("B",),
            lower_warn=0.0, upper_warn=0.20, penalty_coef_warn=10.0,
            lower_severe=0.0, upper_severe=0.25, penalty_coef_severe=100.0,
        )
        c = OptimizerConstraints(
            tickers=("A", "B"), bounds=(),
            sector_caps=(), group_constraints=(),
            soft_penalties=(sp1, sp2),
            risk_aversion=3.0, budget_sum=1.0,
            regime_used="uncertain", diagnostics=(),
        )
        # A=0.10 (T7 warn=8*(0.10-0.08)=0.16), B=0.30 (T6 warn=10*0.10=1.0 + severe=100*0.05=5.0=6.0)
        p = _opt()._calc_soft_penalty([0.10, 0.30], c, ("A", "B"))
        expected = 8.0 * 0.02 + 10.0 * 0.10 + 100.0 * 0.05
        assert p == pytest.approx(expected, abs=1e-9)


# ── TestInitialWeights / Fallback ────────────────────────────────────────────

class TestFallbackWeights:
    def test_all_free_equal_weight(self):
        w = _opt()._fallback_weights(("A", "B"), [(0.0, 1.0), (0.0, 1.0)])
        assert w == pytest.approx([0.5, 0.5])

    def test_some_locked_remainder_distributed(self):
        # A locked at 0.3, B free → B gets 0.7
        w = _opt()._fallback_weights(("A", "B"), [(0.3, 0.3), (0.0, 1.0)])
        assert w[0] == pytest.approx(0.3)
        assert w[1] == pytest.approx(0.7)

    def test_all_locked_sum_one(self):
        w = _opt()._fallback_weights(("A", "B"), [(0.6, 0.6), (0.4, 0.4)])
        assert w == pytest.approx([0.6, 0.4])

    def test_locked_sum_exceeds_one_normalized(self):
        # A=0.7, B=0.7 (locked) → sum=1.4 > 1.0 → normalize: 0.5, 0.5
        w = _opt()._fallback_weights(("A", "B"), [(0.7, 0.7), (0.7, 0.7)])
        assert w[0] == pytest.approx(0.5, abs=1e-9)
        assert w[1] == pytest.approx(0.5, abs=1e-9)

    def test_single_free_gets_all_remainder(self):
        # A locked at 0.2, B free → B gets 0.8
        w = _opt()._fallback_weights(("A", "B"), [(0.2, 0.2), (0.0, 1.0)])
        assert w[1] == pytest.approx(0.8)

    def test_empty_tickers_empty_weights(self):
        w = _opt()._fallback_weights((), [])
        assert w == []

    def test_locked_sum_with_free_remainder_zero(self):
        # locked sum = 1.0, free exists → free gets 0
        w = _opt()._fallback_weights(
            ("A", "B", "C"),
            [(0.5, 0.5), (0.5, 0.5), (0.0, 1.0)],
        )
        assert w[0] == pytest.approx(0.5)
        assert w[1] == pytest.approx(0.5)
        assert w[2] == pytest.approx(0.0)


# ── TestAlignExpectedReturns ─────────────────────────────────────────────────

class TestAlignExpectedReturns:
    def test_all_present(self):
        diag: list[str] = []
        mu = _opt()._align_expected_returns(("A", "B"), {"A": 0.10, "B": 0.05}, diag)
        assert mu == pytest.approx([0.10, 0.05])

    def test_missing_returns_zero(self):
        diag: list[str] = []
        mu = _opt()._align_expected_returns(("A", "B"), {"A": 0.10}, diag)
        assert mu[1] == pytest.approx(0.0)
        assert any("expected_return missing for B" in d for d in diag)

    def test_extra_keys_ignored(self):
        diag: list[str] = []
        mu = _opt()._align_expected_returns(("A",), {"A": 0.10, "Z": 0.99}, diag)
        assert mu == pytest.approx([0.10])

    def test_order_matches_input_tickers(self):
        diag: list[str] = []
        mu = _opt()._align_expected_returns(("B", "A"), {"A": 0.10, "B": 0.05}, diag)
        assert mu == pytest.approx([0.05, 0.10])

    def test_empty_tickers_empty_vector(self):
        diag: list[str] = []
        mu = _opt()._align_expected_returns((), {}, diag)
        assert mu == []


# ── TestAlignCovMatrix ───────────────────────────────────────────────────────

class TestAlignCovMatrix:
    def test_all_present_correct_submatrix(self):
        diag: list[str] = []
        cov = _cov_two_tickers()
        aligned = _opt()._align_cov_matrix(("A", "B"), cov, diag)
        # Should match cov_result.cov_matrix in same order
        for i in range(2):
            for j in range(2):
                assert aligned[i][j] == pytest.approx(cov.cov_matrix[i][j])

    def test_missing_ticker_fallback_diagonal(self):
        diag: list[str] = []
        cov = _cov_two_tickers()
        aligned = _opt()._align_cov_matrix(("A", "B", "C"), cov, diag)
        # C is missing → diagonal = DEFAULT_MONTHLY_VARIANCE * 12
        assert aligned[2][2] == pytest.approx(DEFAULT_MONTHLY_VARIANCE * 12)
        assert aligned[0][2] == pytest.approx(0.0)
        assert aligned[2][0] == pytest.approx(0.0)

    def test_order_matches_input(self):
        diag: list[str] = []
        cov = _cov_two_tickers()
        # Reverse order
        aligned_rev = _opt()._align_cov_matrix(("B", "A"), cov, diag)
        aligned_norm = _opt()._align_cov_matrix(("A", "B"), cov, diag)
        # aligned_rev[0][1] should equal aligned_norm[1][0]
        assert aligned_rev[0][1] == pytest.approx(aligned_norm[1][0])

    def test_symmetric_aligned(self):
        diag: list[str] = []
        cov = _cov_two_tickers()
        aligned = _opt()._align_cov_matrix(("A", "B"), cov, diag)
        assert aligned[0][1] == pytest.approx(aligned[1][0])

    def test_single_ticker_aligned(self):
        diag: list[str] = []
        cov = _cov_two_tickers()
        aligned = _opt()._align_cov_matrix(("A",), cov, diag)
        assert len(aligned) == 1
        assert aligned[0][0] == pytest.approx(cov.cov_matrix[0][0])


# ── TestOptimizer_SLSQP（scipy available） ───────────────────────────────────

@pytest.mark.skipif(not _SCIPY_AVAILABLE, reason="scipy not installed")
class TestOptimizer_SLSQP:
    """SLSQP 収束を確認するテスト群。T7 soft penalty が小さなユニバースで支配的に
    なるのを避けるため、soft_penalties=() の _clean_input を使う。"""

    def test_two_ticker_returns_valid_weights(self):
        result = _opt().optimize(_clean_input())
        assert isinstance(result, EfficientFrontierResult)
        assert len(result.optimal.weights) == 2

    def test_weights_sum_to_one(self):
        result = _opt().optimize(_clean_input())
        total = sum(result.optimal.weights)
        assert total == pytest.approx(1.0, abs=1e-6)

    def test_weights_within_bounds(self):
        result = _opt().optimize(_clean_input())
        for w in result.optimal.weights:
            assert -1e-9 <= w <= 1.0 + 1e-9

    def test_expected_return_computed(self):
        result = _opt().optimize(_clean_input())
        # expected_return = w_A * 0.10 + w_B * 0.04
        opt = result.optimal
        manual = opt.weights[0] * 0.10 + opt.weights[1] * 0.04
        assert opt.expected_return == pytest.approx(manual, abs=1e-9)

    def test_expected_vol_computed(self):
        result = _opt().optimize(_clean_input())
        assert result.optimal.expected_vol >= 0.0

    def test_sharpe_ratio_computed(self):
        result = _opt().optimize(_clean_input())
        opt = result.optimal
        if opt.expected_vol > 0:
            expected = (opt.expected_return - 0.0) / opt.expected_vol
            assert opt.sharpe_ratio == pytest.approx(expected, abs=1e-9)

    def test_solver_converged_true_normal_case(self):
        result = _opt().optimize(_clean_input())
        assert result.optimal.solver_converged is True

    def test_locked_ticker_weight_fixed(self):
        inp = _clean_input(locked_weights={"A": 0.3})
        result = _opt().optimize(inp)
        idx_a = result.optimal.tickers.index("A")
        assert result.optimal.weights[idx_a] == pytest.approx(0.3, abs=1e-6)

    def test_sector_cap_respected(self):
        # tech sector cap = 0.5、3 ticker のうち A, B が tech
        sector_cap = SectorCapConstraint(
            sector_id="tech",
            tickers=("A", "B"),
            max_weight=0.5,
        )
        cov = CovarianceModel().calculate(CovarianceInput(
            tickers=("A", "B", "C"),
            returns_data={
                "A": [0.05, -0.03, 0.04, -0.02, 0.03],
                "B": [0.04, -0.02, 0.03, -0.01, 0.02],
                "C": [0.01, -0.01, 0.01, -0.01, 0.01],
            },
            shrinkage_alpha=0.0,
        ))
        constraints = _clean_constraints(
            tickers=("A", "B", "C"),
            sector_caps=(sector_cap,),
        )
        inp = EfficientFrontierInput(
            tickers=("A", "B", "C"),
            expected_returns={"A": 0.20, "B": 0.20, "C": 0.02},
            cov_result=cov,
            constraints=constraints,
        )
        result = _opt().optimize(inp)
        # tech sector (A+B) should be <= 0.5
        tech_sum = result.optimal.weights[0] + result.optimal.weights[1]
        assert tech_sum <= 0.5 + 1e-6

    def test_soft_penalty_in_result(self):
        # ここでは _basic_input を使う（soft penalty が計算される確認）
        result = _opt().optimize(_basic_input())
        assert isinstance(result.optimal.soft_penalty, float)
        assert result.optimal.soft_penalty >= 0.0


# ── TestOptimizer_NonConvergence ─────────────────────────────────────────────

class TestOptimizer_NonConvergence:
    def test_infeasible_locked_returns_non_converged(self):
        # Both tickers locked at 0.7 → sum=1.4 → infeasible budget
        inp = _basic_input(locked_weights={"A": 0.7, "B": 0.7})
        result = _opt().optimize(inp)
        # SLSQP should fail; result uses fallback weights
        assert result.optimal.solver_converged is False
        # fallback normalizes locked sum to 1.0: A=B=0.5
        assert result.optimal.weights[0] == pytest.approx(0.5, abs=1e-6)
        assert result.optimal.weights[1] == pytest.approx(0.5, abs=1e-6)

    def test_fallback_diagnostic_present(self):
        inp = _basic_input(locked_weights={"A": 0.7, "B": 0.7})
        result = _opt().optimize(inp)
        diag_text = " ".join(result.optimal.diagnostics)
        assert "fallback weights used" in diag_text or "did not converge" in diag_text


# ── TestOptimizer_EmptyTickers ───────────────────────────────────────────────

class TestOptimizer_EmptyTickers:
    def test_empty_tickers_skip_optimization(self):
        inp = EfficientFrontierInput(
            tickers=(),
            expected_returns={},
            cov_result=CovarianceModel().calculate(CovarianceInput(
                tickers=(), returns_data={},
            )),
            constraints=ConstraintBuilder().build(ConstraintInput(
                tickers=(), asset_meta={}, locked_weights={},
            )),
        )
        result = _opt().optimize(inp)
        assert result.optimal.tickers == ()
        assert result.optimal.weights == ()
        assert result.optimal.solver_converged is False


# ── TestOptimizer_MissingExpectedReturns ─────────────────────────────────────

class TestOptimizer_MissingExpectedReturns:
    def test_missing_expected_return_uses_zero_fallback(self):
        # No expected return for B → 0.0 fallback + diagnostic
        inp = EfficientFrontierInput(
            tickers=("A", "B"),
            expected_returns={"A": 0.10},  # B missing
            cov_result=_cov_two_tickers(),
            constraints=_build_constraints(),
        )
        result = _opt().optimize(inp)
        diag_text = " ".join(result.optimal.diagnostics)
        assert "expected_return missing for B" in diag_text


# ── TestProhibitedFields ─────────────────────────────────────────────────────

class TestProhibitedFields:
    def test_optimal_weights_no_action_field(self):
        ow = OptimalWeights(
            tickers=(), weights=(),
            expected_return=0.0, expected_vol=0.0,
            sharpe_ratio=0.0, soft_penalty=0.0,
            solver_converged=False, solver_message="",
            diagnostics=(),
        )
        assert not hasattr(ow, "action")
        assert not hasattr(ow, "is_buy")
        assert not hasattr(ow, "is_sell")
        assert not hasattr(ow, "is_hold")

    def test_optimal_weights_no_decision_field(self):
        ow = OptimalWeights(
            tickers=(), weights=(),
            expected_return=0.0, expected_vol=0.0,
            sharpe_ratio=0.0, soft_penalty=0.0,
            solver_converged=False, solver_message="",
            diagnostics=(),
        )
        assert not hasattr(ow, "decision")
        assert not hasattr(ow, "verdict")
        assert not hasattr(ow, "approve")

    def test_result_no_recommendation_field(self):
        opt = OptimalWeights(
            tickers=(), weights=(),
            expected_return=0.0, expected_vol=0.0,
            sharpe_ratio=0.0, soft_penalty=0.0,
            solver_converged=False, solver_message="",
            diagnostics=(),
        )
        r = EfficientFrontierResult(
            optimal=opt, regime_used="uncertain",
            frontier_points=(), diagnostics=(),
        )
        assert not hasattr(r, "recommendation")
        assert not hasattr(r, "rebalance_order")
        assert not hasattr(r, "order")
        assert not hasattr(r, "rating")

    def test_all_diagnostics_start_with_observation(self):
        result = _opt().optimize(_basic_input())
        for d in result.optimal.diagnostics:
            assert d.startswith("observation:"), f"bad diag: {d!r}"


# ── TestPortfolioCalculations ────────────────────────────────────────────────

class TestPortfolioCalculations:
    def test_expected_return_single_asset(self):
        ret = _opt()._calc_portfolio_expected_return([1.0], [0.08])
        assert ret == pytest.approx(0.08)

    def test_expected_return_two_assets(self):
        ret = _opt()._calc_portfolio_expected_return([0.6, 0.4], [0.10, 0.05])
        assert ret == pytest.approx(0.6 * 0.10 + 0.4 * 0.05)

    def test_variance_single_asset(self):
        var = _opt()._calc_portfolio_variance([1.0], [[0.04]])
        assert var == pytest.approx(0.04)

    def test_variance_zero_weights(self):
        var = _opt()._calc_portfolio_variance([0.0, 0.0], [[0.04, 0.01], [0.01, 0.09]])
        assert var == pytest.approx(0.0)

    def test_vol_non_negative(self):
        vol = _opt()._calc_portfolio_vol([0.5, 0.5], [[0.04, 0.01], [0.01, 0.09]])
        assert vol >= 0.0

    def test_sharpe_zero_vol_returns_zero(self):
        s = _opt()._calc_sharpe_ratio(0.10, 0.0, 0.0)
        assert s == pytest.approx(0.0)

    def test_sharpe_normal_case(self):
        s = _opt()._calc_sharpe_ratio(0.10, 0.20, 0.0)
        assert s == pytest.approx(0.5)

    def test_sharpe_with_risk_free_rate(self):
        s = _opt()._calc_sharpe_ratio(0.10, 0.20, 0.02)
        assert s == pytest.approx((0.10 - 0.02) / 0.20)


# ── TestSCIPY_AVAILABLE Flag ─────────────────────────────────────────────────

class TestScipyFlag:
    def test_scipy_flag_is_bool(self):
        assert isinstance(_SCIPY_AVAILABLE, bool)
