"""
test_covariance_model.py — Card 8-2 テスト（covariance_model.py）
stdlib-only, pytest only
"""
from __future__ import annotations

import math
import pytest

from engine.frontier.covariance_model import (
    DEFAULT_MONTHLY_VARIANCE,
    CovarianceInput,
    CovarianceModel,
    CovarianceResult,
    _clamp,
    _safe_float,
)

# ── フィクスチャ ──────────────────────────────────────────────────────────────

def _model() -> CovarianceModel:
    return CovarianceModel()


def _inp(
    tickers=("A",),
    returns_data=None,
    shrinkage_alpha=0.0,
    min_periods=3,
    regime="uncertain",
) -> CovarianceInput:
    if returns_data is None:
        returns_data = {"A": [0.1, 0.0, -0.1]}
    return CovarianceInput(
        tickers=tickers,
        returns_data=returns_data,
        shrinkage_alpha=shrinkage_alpha,
        min_periods=min_periods,
        regime=regime,
    )


# 数値検証用の既知リターン系列
_RETURNS_A_3 = [0.1, 0.0, -0.1]        # mean=0, monthly_var=0.01
_RETURNS_B_3 = [-0.1, 0.0, 0.1]        # 逆符号（mean=0）
_SAME_RETURNS = [0.1, -0.05, 0.08, -0.03]  # 同一リターン（完全相関チェック用）
# 完全無相関: mean=0, cov_AB=0 の組合せ
_UNCORR_A = [0.1, -0.1, 0.1, -0.1]
_UNCORR_B = [0.1, 0.1, -0.1, -0.1]


# ── TestSafeFloat ─────────────────────────────────────────────────────────────

class TestSafeFloat:
    def test_normal_float(self):
        assert _safe_float(0.08) == pytest.approx(0.08)

    def test_zero_is_valid(self):
        assert _safe_float(0.0) == pytest.approx(0.0)

    def test_nan_returns_default(self):
        assert _safe_float(math.nan) == pytest.approx(0.0)

    def test_inf_returns_default(self):
        assert _safe_float(math.inf) == pytest.approx(0.0)

    def test_none_returns_default(self):
        assert _safe_float(None, 99.0) == pytest.approx(99.0)


# ── TestCovarianceInput ───────────────────────────────────────────────────────

class TestCovarianceInput:
    def test_valid_creation(self):
        ci = _inp()
        assert ci.tickers == ("A",)
        assert ci.min_periods == 3

    def test_list_tickers_converted_to_tuple(self):
        ci = CovarianceInput(
            tickers=["A", "B"],  # type: ignore[arg-type]
            returns_data={},
        )
        assert isinstance(ci.tickers, tuple)

    def test_shrinkage_alpha_negative_clamped_to_zero(self):
        ci = CovarianceInput(tickers=("A",), returns_data={}, shrinkage_alpha=-0.5)
        assert ci.shrinkage_alpha == pytest.approx(0.0)

    def test_shrinkage_alpha_above_1_clamped_to_1(self):
        ci = CovarianceInput(tickers=("A",), returns_data={}, shrinkage_alpha=1.5)
        assert ci.shrinkage_alpha == pytest.approx(1.0)

    def test_shrinkage_alpha_valid_passthrough(self):
        ci = CovarianceInput(tickers=("A",), returns_data={}, shrinkage_alpha=0.3)
        assert ci.shrinkage_alpha == pytest.approx(0.3)

    def test_min_periods_default(self):
        ci = CovarianceInput(tickers=("A",), returns_data={})
        assert ci.min_periods == 3

    def test_invalid_context_becomes_empty_dict(self):
        ci = CovarianceInput(tickers=("A",), returns_data={}, context="bad")  # type: ignore[arg-type]
        assert ci.context == {}

    def test_frozen(self):
        ci = _inp()
        with pytest.raises((AttributeError, TypeError)):
            ci.min_periods = 99  # type: ignore[misc]

    def test_regime_default(self):
        ci = CovarianceInput(tickers=("A",), returns_data={})
        assert ci.regime == "uncertain"


# ── TestCovarianceResult ──────────────────────────────────────────────────────

class TestCovarianceResult:
    def _make_single(self, var: float = 0.12) -> CovarianceResult:
        vol = math.sqrt(var)
        return CovarianceResult(
            tickers=("A",),
            cov_matrix=((var,),),
            correlation_matrix=((1.0,),),
            volatilities=(vol,),
            shrinkage_applied=False,
            fallback_used=False,
            diagnostics=(),
        )

    def test_get_portfolio_variance_single_ticker(self):
        r = self._make_single(0.12)
        assert r.get_portfolio_variance([1.0]) == pytest.approx(0.12)

    def test_get_portfolio_variance_zero_weight(self):
        r = self._make_single(0.12)
        assert r.get_portfolio_variance([0.0]) == pytest.approx(0.0)

    def test_get_portfolio_vol_equals_sqrt_variance(self):
        r = self._make_single(0.25)
        assert r.get_portfolio_vol([1.0]) == pytest.approx(math.sqrt(0.25))

    def test_get_portfolio_variance_empty_tickers(self):
        r = CovarianceResult(
            tickers=(), cov_matrix=(), correlation_matrix=(),
            volatilities=(), shrinkage_applied=False, fallback_used=False,
            diagnostics=(),
        )
        assert r.get_portfolio_variance([]) == pytest.approx(0.0)

    def test_to_dict_required_keys(self):
        d = self._make_single().to_dict()
        assert set(d.keys()) == {
            "tickers", "cov_matrix", "correlation_matrix",
            "volatilities", "shrinkage_applied", "fallback_used", "diagnostics",
        }

    def test_to_dict_cov_matrix_is_list_of_list(self):
        d = self._make_single(0.12).to_dict()
        assert isinstance(d["cov_matrix"], list)
        assert isinstance(d["cov_matrix"][0], list)

    def test_frozen(self):
        r = self._make_single()
        with pytest.raises((AttributeError, TypeError)):
            r.shrinkage_applied = True  # type: ignore[misc]


# ── TestCovarianceModel_Basic ─────────────────────────────────────────────────

class TestCovarianceModel_Basic:
    def test_single_ticker_1x1_matrix(self):
        result = _model().calculate(_inp(("A",), {"A": _RETURNS_A_3}))
        assert len(result.cov_matrix) == 1
        assert len(result.cov_matrix[0]) == 1

    def test_single_ticker_vol_positive(self):
        result = _model().calculate(_inp(("A",), {"A": _RETURNS_A_3}))
        assert result.volatilities[0] > 0.0

    def test_two_identical_tickers_corr_one(self):
        data = {"A": _SAME_RETURNS, "B": _SAME_RETURNS}
        result = _model().calculate(_inp(("A", "B"), data))
        assert result.correlation_matrix[0][1] == pytest.approx(1.0, abs=1e-9)

    def test_two_opposite_tickers_corr_minus_one(self):
        data = {
            "A": [0.1, -0.05, 0.08],
            "B": [-0.1, 0.05, -0.08],
        }
        result = _model().calculate(_inp(("A", "B"), data))
        assert result.correlation_matrix[0][1] == pytest.approx(-1.0, abs=1e-9)

    def test_two_uncorrelated_tickers_cov_near_zero(self):
        data = {"A": _UNCORR_A, "B": _UNCORR_B}
        result = _model().calculate(_inp(("A", "B"), data))
        assert result.cov_matrix[0][1] == pytest.approx(0.0, abs=1e-12)

    def test_three_tickers_3x3_matrix(self):
        data = {"A": _RETURNS_A_3, "B": _RETURNS_B_3, "C": [0.05, -0.05, 0.05]}
        result = _model().calculate(_inp(("A", "B", "C"), data))
        assert len(result.cov_matrix) == 3
        assert all(len(row) == 3 for row in result.cov_matrix)

    def test_cov_matrix_symmetric(self):
        data = {"A": _SAME_RETURNS, "B": list(reversed(_SAME_RETURNS))}
        result = _model().calculate(_inp(("A", "B"), data))
        assert result.cov_matrix[0][1] == pytest.approx(result.cov_matrix[1][0])

    def test_diagonal_non_negative(self):
        data = {"A": _RETURNS_A_3, "B": _RETURNS_B_3}
        result = _model().calculate(_inp(("A", "B"), data))
        for i in range(2):
            assert result.cov_matrix[i][i] >= 0.0

    def test_tickers_order_preserved(self):
        data = {"A": _RETURNS_A_3, "B": _RETURNS_B_3}
        result = _model().calculate(_inp(("A", "B"), data))
        assert result.tickers == ("A", "B")


# ── TestCovarianceModel_Annualization ─────────────────────────────────────────

class TestCovarianceModel_Annualization:
    def test_annual_variance_equals_12x_monthly(self):
        # returns = [0.1, 0.0, -0.1] → mean=0, monthly_var = (0.01+0+0.01)/2 = 0.01
        result = _model().calculate(_inp(("A",), {"A": [0.1, 0.0, -0.1]}))
        expected_monthly_var = 0.01
        assert result.cov_matrix[0][0] == pytest.approx(expected_monthly_var * 12)

    def test_annual_vol_equals_sqrt12_times_monthly_std(self):
        result = _model().calculate(_inp(("A",), {"A": [0.1, 0.0, -0.1]}))
        expected_monthly_std = math.sqrt(0.01)
        assert result.volatilities[0] == pytest.approx(expected_monthly_std * math.sqrt(12))

    def test_cov_matrix_diagonal_equals_volatility_squared(self):
        result = _model().calculate(_inp(("A",), {"A": [0.1, 0.0, -0.1]}))
        vol = result.volatilities[0]
        assert result.cov_matrix[0][0] == pytest.approx(vol ** 2)


# ── TestCovarianceModel_Shrinkage ─────────────────────────────────────────────

class TestCovarianceModel_Shrinkage:
    def test_alpha_zero_no_change_to_off_diagonal(self):
        data = {"A": _SAME_RETURNS, "B": _SAME_RETURNS}
        res0 = _model().calculate(_inp(("A", "B"), data, shrinkage_alpha=0.0))
        res1 = _model().calculate(_inp(("A", "B"), data, shrinkage_alpha=0.5))
        # alpha=0: off-diagonal preserved as-is
        off_diag_0 = res0.cov_matrix[0][1]
        off_diag_1 = res1.cov_matrix[0][1]
        assert abs(off_diag_1) < abs(off_diag_0) + 1e-12

    def test_alpha_one_off_diagonal_zero(self):
        data = {"A": _SAME_RETURNS, "B": _SAME_RETURNS}
        result = _model().calculate(_inp(("A", "B"), data, shrinkage_alpha=1.0))
        assert result.cov_matrix[0][1] == pytest.approx(0.0, abs=1e-12)

    def test_shrinkage_reduces_off_diagonal_magnitude(self):
        data = {"A": _SAME_RETURNS, "B": _SAME_RETURNS}
        res_no = _model().calculate(_inp(("A", "B"), data, shrinkage_alpha=0.0))
        res_sh = _model().calculate(_inp(("A", "B"), data, shrinkage_alpha=0.5))
        assert abs(res_sh.cov_matrix[0][1]) < abs(res_no.cov_matrix[0][1]) + 1e-12

    def test_shrinkage_applied_true_when_alpha_positive(self):
        data = {"A": _RETURNS_A_3}
        result = _model().calculate(_inp(("A",), data, shrinkage_alpha=0.1))
        assert result.shrinkage_applied is True

    def test_shrinkage_applied_false_when_alpha_zero(self):
        data = {"A": _RETURNS_A_3}
        result = _model().calculate(_inp(("A",), data, shrinkage_alpha=0.0))
        assert result.shrinkage_applied is False

    def test_shrinkage_diagonal_moves_toward_avg_variance(self):
        # 2 tickers with different variances: shrinkage should move diagonals toward mean
        data = {
            "A": [0.2, -0.2, 0.2, -0.2],    # higher variance
            "B": [0.02, -0.02, 0.02, -0.02], # lower variance
        }
        res_no = _model().calculate(_inp(("A", "B"), data, shrinkage_alpha=0.0))
        res_sh = _model().calculate(_inp(("A", "B"), data, shrinkage_alpha=0.5))
        # A's variance should decrease, B's should increase (moving toward mean)
        assert res_sh.cov_matrix[0][0] < res_no.cov_matrix[0][0]
        assert res_sh.cov_matrix[1][1] > res_no.cov_matrix[1][1]


# ── TestCovarianceModel_Fallback ──────────────────────────────────────────────

class TestCovarianceModel_Fallback:
    def test_insufficient_data_fallback_used_true(self):
        data = {"A": [0.1, 0.0]}  # n_obs=2 < min_periods=3
        result = _model().calculate(_inp(("A",), data, min_periods=3))
        assert result.fallback_used is True

    def test_insufficient_data_off_diagonal_zero(self):
        data = {"A": [0.1, 0.0], "B": [0.05, -0.05]}  # n_obs=2 < 3
        result = _model().calculate(_inp(("A", "B"), data, min_periods=3))
        assert result.cov_matrix[0][1] == pytest.approx(0.0)

    def test_single_observation_triggers_fallback(self):
        data = {"A": [0.1]}  # n_obs=1 < 2
        result = _model().calculate(_inp(("A",), data, min_periods=1))
        assert result.fallback_used is True

    def test_missing_ticker_local_fallback_diagonal(self):
        # "B" is missing, "A" has sufficient data
        data = {"A": _RETURNS_A_3}  # "B" not in data
        result = _model().calculate(_inp(("A", "B"), data))
        # B's diagonal = DEFAULT_MONTHLY_VARIANCE * 12
        idx_b = result.tickers.index("B")
        assert result.cov_matrix[idx_b][idx_b] == pytest.approx(DEFAULT_MONTHLY_VARIANCE * 12)

    def test_missing_ticker_off_diagonal_zero(self):
        data = {"A": _RETURNS_A_3}
        result = _model().calculate(_inp(("A", "B"), data))
        idx_a = result.tickers.index("A")
        idx_b = result.tickers.index("B")
        assert result.cov_matrix[idx_a][idx_b] == pytest.approx(0.0)
        assert result.cov_matrix[idx_b][idx_a] == pytest.approx(0.0)

    def test_missing_ticker_valid_tickers_still_computed(self):
        # A and B have valid data, C is missing
        data = {
            "A": [0.1, 0.0, -0.1],
            "B": [-0.1, 0.0, 0.1],
        }
        result = _model().calculate(_inp(("A", "B", "C"), data))
        idx_a = result.tickers.index("A")
        idx_b = result.tickers.index("B")
        # A and B's covariance should be computed (not fallback)
        # They have opposite returns → negative covariance (annual)
        assert result.cov_matrix[idx_a][idx_b] < 0.0

    def test_all_tickers_missing_all_diagonal_fallback(self):
        data = {}  # no returns for any ticker
        result = _model().calculate(_inp(("A", "B"), data))
        assert result.fallback_used is True
        assert result.cov_matrix[0][0] == pytest.approx(DEFAULT_MONTHLY_VARIANCE * 12)
        assert result.cov_matrix[1][1] == pytest.approx(DEFAULT_MONTHLY_VARIANCE * 12)

    def test_empty_tickers_empty_result(self):
        result = _model().calculate(CovarianceInput(tickers=(), returns_data={}))
        assert result.tickers == ()
        assert result.cov_matrix == ()
        assert result.correlation_matrix == ()
        assert result.volatilities == ()


# ── TestCovarianceModel_ZeroVol ───────────────────────────────────────────────

class TestCovarianceModel_ZeroVol:
    def _zero_vol_result(self) -> CovarianceResult:
        # Constant returns (all 0.0) → zero variance
        data = {"A": [0.0, 0.0, 0.0]}
        return _model().calculate(_inp(("A",), data))

    def test_zero_variance_corr_diagonal_is_one(self):
        result = self._zero_vol_result()
        assert result.correlation_matrix[0][0] == pytest.approx(1.0)

    def test_zero_variance_diagnostic_identity_structure(self):
        result = self._zero_vol_result()
        diag_text = " ".join(result.diagnostics)
        assert "zero variance detected" in diag_text
        assert "identity structure" in diag_text

    def test_normal_variance_corr_in_range(self):
        data = {"A": _SAME_RETURNS, "B": list(reversed(_SAME_RETURNS))}
        result = _model().calculate(_inp(("A", "B"), data))
        for i in range(2):
            for j in range(2):
                assert -1.0 - 1e-9 <= result.correlation_matrix[i][j] <= 1.0 + 1e-9


# ── TestCovarianceModel_Diagnostics ──────────────────────────────────────────

class TestCovarianceModel_Diagnostics:
    def test_all_diagnostics_start_with_observation(self):
        data = {"A": [0.1]}  # insufficient data → fallback
        result = _model().calculate(_inp(("A",), data))
        for d in result.diagnostics:
            assert d.startswith("observation:"), f"bad diag: {d!r}"

    def test_fallback_diagnostic_present(self):
        data = {"A": [0.1]}
        result = _model().calculate(_inp(("A",), data))
        diag_text = " ".join(result.diagnostics)
        assert "fallback" in diag_text

    def test_missing_ticker_diagnostic_present(self):
        data = {"A": _RETURNS_A_3}
        result = _model().calculate(_inp(("A", "B"), data))
        diag_text = " ".join(result.diagnostics)
        assert "off-diagonal covariance set to 0.0" in diag_text

    def test_shrinkage_diagnostic_when_alpha_positive(self):
        data = {"A": _RETURNS_A_3}
        result = _model().calculate(_inp(("A",), data, shrinkage_alpha=0.2))
        diag_text = " ".join(result.diagnostics)
        assert "James-Stein" in diag_text


# ── TestCovarianceModel_PortfolioVariance ─────────────────────────────────────

class TestCovarianceModel_PortfolioVariance:
    def test_all_weight_in_one_asset_equals_that_variance(self):
        data = {"A": _RETURNS_A_3, "B": _RETURNS_B_3}
        result = _model().calculate(_inp(("A", "B"), data))
        var_a = result.cov_matrix[0][0]
        pvar = result.get_portfolio_variance([1.0, 0.0])
        assert pvar == pytest.approx(var_a)

    def test_portfolio_vol_non_negative(self):
        data = {"A": _RETURNS_A_3, "B": _RETURNS_B_3}
        result = _model().calculate(_inp(("A", "B"), data))
        assert result.get_portfolio_vol([0.5, 0.5]) >= 0.0

    def test_zero_weights_variance_zero(self):
        data = {"A": _RETURNS_A_3}
        result = _model().calculate(_inp(("A",), data))
        assert result.get_portfolio_variance([0.0]) == pytest.approx(0.0)

    def test_equal_weight_portfolio_variance_finite(self):
        data = {"A": _RETURNS_A_3, "B": _RETURNS_B_3}
        result = _model().calculate(_inp(("A", "B"), data))
        var = result.get_portfolio_variance([0.5, 0.5])
        assert math.isfinite(var)

    def test_weights_not_summing_to_one_still_computes(self):
        data = {"A": _RETURNS_A_3}
        result = _model().calculate(_inp(("A",), data))
        # weight=2.0: variance = 4 * cov[0][0]
        var_2 = result.get_portfolio_variance([2.0])
        var_1 = result.get_portfolio_variance([1.0])
        assert var_2 == pytest.approx(4.0 * var_1)

    def test_portfolio_vol_equals_sqrt_variance(self):
        data = {"A": _RETURNS_A_3, "B": _RETURNS_B_3}
        result = _model().calculate(_inp(("A", "B"), data))
        pvar = result.get_portfolio_variance([0.4, 0.6])
        pvol = result.get_portfolio_vol([0.4, 0.6])
        assert pvol == pytest.approx(math.sqrt(max(pvar, 0.0)))


# ── TestCovarianceModel_ToDictIntegration ─────────────────────────────────────

class TestCovarianceModel_ToDictIntegration:
    def test_to_dict_serializable_json(self):
        import json
        data = {"A": _RETURNS_A_3, "B": _RETURNS_B_3}
        result = _model().calculate(_inp(("A", "B"), data))
        serialized = json.dumps(result.to_dict())
        assert "A" in serialized
        assert "B" in serialized

    def test_to_dict_volatilities_is_list(self):
        data = {"A": _RETURNS_A_3}
        result = _model().calculate(_inp(("A",), data))
        d = result.to_dict()
        assert isinstance(d["volatilities"], list)

    def test_to_dict_correlation_matrix_is_list_of_list(self):
        data = {"A": _RETURNS_A_3}
        result = _model().calculate(_inp(("A",), data))
        d = result.to_dict()
        assert isinstance(d["correlation_matrix"], list)
        assert isinstance(d["correlation_matrix"][0], list)
