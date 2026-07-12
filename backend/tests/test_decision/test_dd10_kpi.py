"""
test_dd10_kpi.py — Card 5-10B テスト

calc_max_drawdown / calc_dd10_uniform_return / DD10KPIResult /
DD10Calculator.compute の全仕様を検証する。

算術リターン有効値フィルタリング / r < -1.0 除外 / r == -1.0 許容 /
scaled_mean <= -1.0 下限 / dd_threshold fallback / is_drawdown_defined /
判断フィールドなし / 禁止 import なし を含む。
"""
from __future__ import annotations

import inspect
import json
import math

import pytest

from backend.engine.decision.dd10_kpi import (
    DD10Calculator,
    DD10KPIResult,
    _safe_mean,
    _to_valid_floats,
    calc_dd10_uniform_return,
    calc_max_drawdown,
)

_CALC = DD10Calculator()


# ── ヘルパー ───────────────────────────────────────────────────────────────────

def _manual_max_dd(returns: list[float]) -> float:
    """テスト用 手計算 max drawdown（有効値フィルタリングなし、前提: 全値 >= -1.0）。"""
    equity, peak, max_dd = 1.0, 1.0, 0.0
    for r in returns:
        equity = equity * (1.0 + r)
        peak   = max(peak, equity)
        if peak > 0:
            dd = equity / peak - 1.0
            max_dd = min(max_dd, dd)
    return max_dd


def _manual_dd10(
    returns: list[float],
    threshold: float = 0.10,
    ppy: int = 12,
) -> float:
    """テスト用 手計算 dd10 uniform return。"""
    mean_r    = sum(returns) / len(returns) if returns else 0.0
    actual_dd = _manual_max_dd(returns)
    if actual_dd >= 0.0:
        scaled_mean = mean_r
    else:
        scale = abs(threshold / actual_dd)
        scaled_mean = mean_r * scale
    if scaled_mean <= -1.0:
        return -1.0
    return (1.0 + scaled_mean) ** ppy - 1.0


# ── TestToValidFloats ─────────────────────────────────────────────────────────

class TestToValidFloats:
    def test_normal_floats(self):
        result = _to_valid_floats([0.01, 0.02, -0.01])
        assert result == [0.01, 0.02, -0.01]

    def test_invalid_type_excluded(self):
        result = _to_valid_floats([0.01, None, 0.02])
        assert result == [0.01, 0.02]

    def test_string_number_ok(self):
        result = _to_valid_floats(["0.01", "0.02"])
        assert result == [0.01, 0.02]

    def test_string_non_numeric_excluded(self):
        result = _to_valid_floats([0.01, "abc", 0.02])
        assert result == [0.01, 0.02]

    def test_r_less_than_minus_one_excluded(self):
        result = _to_valid_floats([-1.01, -2.0, 0.01])
        assert result == [0.01]

    def test_r_equals_minus_one_allowed(self):
        result = _to_valid_floats([-1.0, 0.01])
        assert -1.0 in result
        assert 0.01 in result

    def test_empty_list(self):
        assert _to_valid_floats([]) == []

    def test_all_invalid(self):
        assert _to_valid_floats([None, "abc", -2.0]) == []


# ── TestSafeMean ──────────────────────────────────────────────────────────────

class TestSafeMean:
    def test_normal(self):
        assert abs(_safe_mean([0.01, 0.03]) - 0.02) < 1e-12

    def test_empty(self):
        assert _safe_mean([]) == 0.0

    def test_single(self):
        assert abs(_safe_mean([0.05]) - 0.05) < 1e-12


# ── TestCalcMaxDrawdown ────────────────────────────────────────────────────────

class TestCalcMaxDrawdown:
    def test_empty_list(self):
        assert calc_max_drawdown([]) == 0.0

    def test_all_positive_returns(self):
        assert calc_max_drawdown([0.01, 0.02, 0.03]) == 0.0

    def test_single_positive_return(self):
        assert calc_max_drawdown([0.05]) == 0.0

    def test_single_negative_return(self):
        # equity: 1.0 → 0.95, peak=1.0, dd = 0.95/1.0 - 1 = -0.05
        result = calc_max_drawdown([-0.05])
        assert abs(result - (-0.05)) < 1e-12

    def test_all_zero_returns(self):
        assert calc_max_drawdown([0.0, 0.0, 0.0]) == 0.0

    def test_down_then_recovery(self):
        # [0.10, -0.20, 0.10]:
        # equity: 1.10, 0.88, 0.968
        # peak:   1.10, 1.10, 1.10
        # dd:     0.0, 0.88/1.10-1≈-0.1818, 0.968/1.10-1≈-0.12
        rets = [0.10, -0.20, 0.10]
        expected = _manual_max_dd(rets)
        assert abs(calc_max_drawdown(rets) - expected) < 1e-12

    def test_monotone_decrease(self):
        # equity: 0.9, 0.81, 0.729
        # peak: 1.0, 1.0, 1.0
        rets = [-0.10, -0.10, -0.10]
        expected = _manual_max_dd(rets)
        assert abs(calc_max_drawdown(rets) - expected) < 1e-12

    def test_multiple_peaks(self):
        # 複数の高値更新がある場合
        rets = [0.10, 0.05, -0.15, 0.20, -0.10]
        expected = _manual_max_dd(rets)
        assert abs(calc_max_drawdown(rets) - expected) < 1e-12

    def test_result_always_le_zero(self):
        for rets in [
            [], [0.01], [-0.01], [0.1, -0.2, 0.1],
            [-0.05, -0.05, 0.15], [0.0, 0.0],
        ]:
            assert calc_max_drawdown(rets) <= 0.0

    def test_invalid_values_excluded(self):
        # None は除外 → [0.01, -0.05] で計算
        rets_clean = [0.01, -0.05]
        result_clean = calc_max_drawdown(rets_clean)
        result_with_none = calc_max_drawdown([0.01, None, -0.05])
        assert abs(result_clean - result_with_none) < 1e-12

    def test_r_less_than_minus_one_excluded(self):
        # -2.0 は除外 → [-0.10] のみ
        result = calc_max_drawdown([-2.0, -0.10])
        expected = calc_max_drawdown([-0.10])
        assert abs(result - expected) < 1e-12

    def test_r_equals_minus_one_allowed(self):
        # r == -1.0 → equity = 0, peak = 1.0, dd = -1.0
        result = calc_max_drawdown([-1.0])
        assert abs(result - (-1.0)) < 1e-12

    def test_large_list(self):
        rets = [0.005 * (i % 3 - 1) for i in range(1000)]
        result = calc_max_drawdown(rets)
        assert result <= 0.0


# ── TestCalcDD10UniformReturn ──────────────────────────────────────────────────

class TestCalcDD10UniformReturn:
    def test_empty_list(self):
        # valid が空 → mean=0.0, actual_dd=0.0 → (1+0)^12-1=0.0
        assert calc_dd10_uniform_return([]) == 0.0

    def test_no_drawdown_uses_unscaled(self):
        rets = [0.02, 0.01, 0.02, 0.03]
        result = calc_dd10_uniform_return(rets)
        mean_r = sum(rets) / len(rets)
        expected = (1.0 + mean_r) ** 12 - 1.0
        assert abs(result - expected) < 1e-9

    def test_dd_exactly_threshold_scale_one(self):
        # max_dd == -0.10 → scale = 1.0 → 変化なし
        # equity: 1.0 → 0.9 (r=-0.10) をシミュレート
        # [0.0, -0.10]: equity [1.0, 0.9], peak [1.0, 1.0], dd [0, -0.10]
        rets = [0.0, -0.10]
        result = calc_dd10_uniform_return(rets, dd_threshold=0.10)
        mean_r = sum(rets) / len(rets)
        expected = (1.0 + mean_r) ** 12 - 1.0
        assert abs(result - expected) < 1e-9

    def test_dd_half_threshold_scale_two(self):
        # max_dd == -0.05 → scale = 0.10/0.05 = 2.0
        # [0.0, -0.05]: dd = -0.05
        rets = [0.0, -0.05]
        result = calc_dd10_uniform_return(rets, dd_threshold=0.10)
        mean_r = sum(rets) / len(rets)  # -0.025
        scaled_mean = mean_r * 2.0       # -0.05
        expected = (1.0 - 0.05) ** 12 - 1.0
        assert abs(result - expected) < 1e-9

    def test_dd_double_threshold_scale_half(self):
        # max_dd == -0.20 → scale = 0.10/0.20 = 0.5
        rets = [0.0, -0.20]
        result = calc_dd10_uniform_return(rets, dd_threshold=0.10)
        mean_r = sum(rets) / len(rets)  # -0.10
        scaled_mean = mean_r * 0.5       # -0.05
        expected = (1.0 - 0.05) ** 12 - 1.0
        assert abs(result - expected) < 1e-9

    def test_dd_threshold_zero_uses_default(self):
        rets = [0.01, 0.02, -0.05, 0.01]
        result_zero = calc_dd10_uniform_return(rets, dd_threshold=0.0)
        result_default = calc_dd10_uniform_return(rets, dd_threshold=0.10)
        assert abs(result_zero - result_default) < 1e-12

    def test_dd_threshold_negative_uses_default(self):
        rets = [0.01, 0.02, -0.05, 0.01]
        result_neg = calc_dd10_uniform_return(rets, dd_threshold=-0.05)
        result_default = calc_dd10_uniform_return(rets, dd_threshold=0.10)
        assert abs(result_neg - result_default) < 1e-12

    def test_scaled_mean_at_minus_one_returns_minus_one(self):
        # scaled_mean == -1.0 になる条件: mean_r * scale_factor == -1.0
        # scale_factor = abs(dd_threshold / actual_dd)
        # [-1.0] → mean=-1.0, actual_dd=-1.0
        # dd_threshold=1.0 → scale=1.0/1.0=1.0, scaled_mean=-1.0*1.0=-1.0 → return -1.0
        result = calc_dd10_uniform_return([-1.0], dd_threshold=1.0)
        assert result == -1.0

    def test_scaled_mean_below_minus_one_returns_minus_one(self):
        # scaled_mean < -1.0 のケース: dd_threshold が大きく mean が負のとき
        # [-1.0, 0.01]*10 → mean ≈ -0.045, actual_dd ≈ -1.0 (after -1.0 equity=0)
        # dd_threshold=2.0 → scale=2.0/1.0=2.0, scaled ≈ -0.09 (still not < -1.0)
        # 別構成: [0.01]*9 + [-0.01] → mean≈0.009, max_dd≈-0.01
        # dd_threshold=10.0 → scale=10.0/0.01=1000, scaled≈9.0 (positive)
        # 正しい構成: mean_r が十分負で scale が大きい場合
        # returns = [-0.5]*2 → mean=-0.5, equity:0.5,0.25; peak=1.0; max_dd=-0.75
        # scale = 0.10/0.75=0.133, scaled=-0.5*0.133=-0.0667 NOT < -1.0
        # dd_threshold=1.0, returns=[-0.5]*2: scale=1.0/0.75=1.333, scaled=-0.667 NOT < -1.0
        # dd_threshold=2.0, returns=[-0.5]*2: scale=2.0/0.75=2.667, scaled=-1.333 < -1.0 → -1.0
        result = calc_dd10_uniform_return([-0.5, -0.5], dd_threshold=2.0)
        assert result == -1.0

    def test_periods_per_year_52(self):
        rets = [0.02, 0.01, 0.02, 0.03]
        result = calc_dd10_uniform_return(rets, periods_per_year=52)
        mean_r = sum(rets) / len(rets)
        expected = (1.0 + mean_r) ** 52 - 1.0
        assert abs(result - expected) < 1e-9

    def test_periods_per_year_252(self):
        rets = [0.001, 0.002, 0.001]
        result = calc_dd10_uniform_return(rets, periods_per_year=252)
        mean_r = sum(rets) / len(rets)
        expected = (1.0 + mean_r) ** 252 - 1.0
        assert abs(result - expected) < 1e-9

    def test_returns_float(self):
        result = calc_dd10_uniform_return([0.01, 0.02])
        assert isinstance(result, float)


# ── TestDD10KPIResultFrozen ────────────────────────────────────────────────────

class TestDD10KPIResultFrozen:
    def _make(self) -> DD10KPIResult:
        return DD10KPIResult(
            actual_max_drawdown=-0.10,
            dd10_uniform_return=0.15,
            scale_factor=1.0,
            mean_return=0.012,
            is_drawdown_defined=True,
            periods_per_year=12,
        )

    def test_frozen_actual_max_drawdown(self):
        r = self._make()
        with pytest.raises(Exception):
            r.actual_max_drawdown = 0.0  # type: ignore[misc]

    def test_frozen_dd10_uniform_return(self):
        r = self._make()
        with pytest.raises(Exception):
            r.dd10_uniform_return = 9.0  # type: ignore[misc]

    def test_types(self):
        r = self._make()
        assert isinstance(r.actual_max_drawdown, float)
        assert isinstance(r.dd10_uniform_return, float)
        assert isinstance(r.scale_factor, float)
        assert isinstance(r.mean_return, float)
        assert isinstance(r.is_drawdown_defined, bool)
        assert isinstance(r.periods_per_year, int)


# ── TestDD10KPIResultToDict ────────────────────────────────────────────────────

class TestDD10KPIResultToDict:
    def _result(self) -> DD10KPIResult:
        return DD10KPIResult(
            actual_max_drawdown=-0.15,
            dd10_uniform_return=0.20,
            scale_factor=0.667,
            mean_return=0.015,
            is_drawdown_defined=True,
            periods_per_year=12,
        )

    def test_returns_dict(self):
        assert isinstance(self._result().to_dict(), dict)

    def test_all_keys_present(self):
        d = self._result().to_dict()
        expected = {
            "actual_max_drawdown", "dd10_uniform_return", "scale_factor",
            "mean_return", "is_drawdown_defined", "periods_per_year",
        }
        assert set(d.keys()) == expected

    def test_values_correct(self):
        d = self._result().to_dict()
        assert abs(d["actual_max_drawdown"] - (-0.15)) < 1e-12
        assert abs(d["dd10_uniform_return"] - 0.20) < 1e-12
        assert d["is_drawdown_defined"] is True
        assert d["periods_per_year"] == 12

    def test_json_serializable(self):
        json.dumps(self._result().to_dict())

    def test_no_judgment_fields(self):
        d = self._result().to_dict()
        for field in ("action", "recommendation", "is_buy", "is_sell",
                      "is_hold", "is_recommended", "rating"):
            assert field not in d, f"{field} が to_dict() に存在する"


# ── TestDD10CalculatorNormal ───────────────────────────────────────────────────

class TestDD10CalculatorNormal:
    def setup_method(self):
        self.calc = DD10Calculator()
        self.rets = [0.02, 0.01, 0.02, -0.05, 0.03, 0.01, 0.02, -0.03, 0.01, 0.02]

    def test_returns_dd10_kpi_result(self):
        assert isinstance(self.calc.compute(self.rets), DD10KPIResult)

    def test_is_drawdown_defined_true(self):
        assert self.calc.compute(self.rets).is_drawdown_defined is True

    def test_actual_max_drawdown_matches_manual(self):
        result = self.calc.compute(self.rets)
        expected = _manual_max_dd(self.rets)
        assert abs(result.actual_max_drawdown - expected) < 1e-12

    def test_dd10_uniform_return_matches_manual(self):
        result = self.calc.compute(self.rets)
        expected = _manual_dd10(self.rets)
        assert abs(result.dd10_uniform_return - expected) < 1e-9

    def test_mean_return_correct(self):
        result = self.calc.compute(self.rets)
        expected_mean = sum(self.rets) / len(self.rets)
        assert abs(result.mean_return - expected_mean) < 1e-12

    def test_periods_per_year_stored(self):
        result = self.calc.compute(self.rets, periods_per_year=52)
        assert result.periods_per_year == 52

    def test_scale_factor_stored(self):
        result = self.calc.compute(self.rets)
        assert isinstance(result.scale_factor, float)
        assert result.scale_factor > 0.0


# ── TestDD10CalculatorFallback ─────────────────────────────────────────────────

class TestDD10CalculatorFallback:
    def setup_method(self):
        self.calc = DD10Calculator()

    def test_empty_returns_is_drawdown_defined_false(self):
        result = self.calc.compute([])
        assert result.is_drawdown_defined is False

    def test_empty_returns_zeros(self):
        result = self.calc.compute([])
        assert result.actual_max_drawdown == 0.0
        assert result.dd10_uniform_return == 0.0
        assert result.scale_factor == 1.0
        assert result.mean_return == 0.0

    def test_all_invalid_values_fallback(self):
        result = self.calc.compute([None, "abc", -2.0])
        assert result.is_drawdown_defined is False

    def test_single_valid_return_defined(self):
        result = self.calc.compute([0.05])
        assert result.is_drawdown_defined is True

    def test_dd_threshold_zero_uses_default(self):
        rets = [0.01, -0.05, 0.02]
        r_zero    = self.calc.compute(rets, dd_threshold=0.0)
        r_default = self.calc.compute(rets, dd_threshold=0.10)
        assert abs(r_zero.dd10_uniform_return - r_default.dd10_uniform_return) < 1e-12

    def test_dd_threshold_negative_uses_default(self):
        rets = [0.01, -0.05, 0.02]
        r_neg     = self.calc.compute(rets, dd_threshold=-0.1)
        r_default = self.calc.compute(rets, dd_threshold=0.10)
        assert abs(r_neg.dd10_uniform_return - r_default.dd10_uniform_return) < 1e-12

    def test_r_below_minus_one_excluded(self):
        rets_clean  = [0.02, -0.05, 0.01]
        rets_dirty  = [0.02, -1.5, -0.05, 0.01]  # -1.5 は除外
        r_clean = self.calc.compute(rets_clean)
        r_dirty = self.calc.compute(rets_dirty)
        assert abs(r_clean.actual_max_drawdown - r_dirty.actual_max_drawdown) < 1e-12
        assert abs(r_clean.mean_return - r_dirty.mean_return) < 1e-12

    def test_r_equals_minus_one_allowed(self):
        result = self.calc.compute([-1.0])
        assert result.is_drawdown_defined is True
        assert abs(result.actual_max_drawdown - (-1.0)) < 1e-12


# ── TestDD10CalculatorScaleFactor ──────────────────────────────────────────────

class TestDD10CalculatorScaleFactor:
    def setup_method(self):
        self.calc = DD10Calculator()

    def test_no_drawdown_scale_one(self):
        result = self.calc.compute([0.01, 0.02, 0.03])
        assert abs(result.scale_factor - 1.0) < 1e-12

    def test_max_dd_equals_threshold_scale_one(self):
        # [0.0, -0.10] → max_dd = -0.10, threshold = 0.10 → scale = 1.0
        result = self.calc.compute([0.0, -0.10], dd_threshold=0.10)
        assert abs(result.scale_factor - 1.0) < 1e-12

    def test_max_dd_half_threshold_scale_two(self):
        # max_dd = -0.05, threshold = 0.10 → scale = 2.0
        result = self.calc.compute([0.0, -0.05], dd_threshold=0.10)
        assert abs(result.scale_factor - 2.0) < 1e-12

    def test_max_dd_double_threshold_scale_half(self):
        # max_dd = -0.20, threshold = 0.10 → scale = 0.5
        result = self.calc.compute([0.0, -0.20], dd_threshold=0.10)
        assert abs(result.scale_factor - 0.5) < 1e-12

    def test_dd10_consistent_with_scale(self):
        # dd10 = (1 + mean * scale) ** 12 - 1 と一致すること（scaled_mean > -1.0 の場合）
        rets = [0.02, 0.01, -0.05, 0.02, 0.01]
        result = self.calc.compute(rets)
        scaled_mean = result.mean_return * result.scale_factor
        if scaled_mean > -1.0:
            expected = (1.0 + scaled_mean) ** 12 - 1.0
            assert abs(result.dd10_uniform_return - expected) < 1e-9

    def test_scaled_mean_minus_one_returns_minus_one(self):
        # [-1.0] with threshold=1.0 → max_dd=-1.0, scale=1.0, scaled=-1.0 → return -1.0
        result = self.calc.compute([-1.0], dd_threshold=1.0)
        assert result.dd10_uniform_return == -1.0

    def test_periods_per_year_52(self):
        rets = [0.01, 0.02, -0.03, 0.01]
        result = self.calc.compute(rets, periods_per_year=52)
        assert result.periods_per_year == 52

    def test_periods_per_year_252(self):
        rets = [0.001, 0.002, 0.001]
        result = self.calc.compute(rets, periods_per_year=252)
        assert result.periods_per_year == 252


# ── TestDD10CalculatorDefaults ─────────────────────────────────────────────────

class TestDD10CalculatorDefaults:
    def test_default_dd_threshold(self):
        assert abs(DD10Calculator.DEFAULT_DD_THRESHOLD - 0.10) < 1e-12

    def test_default_periods_per_year(self):
        assert DD10Calculator.DEFAULT_PERIODS_PER_YEAR == 12


# ── TestNoJudgmentFields ───────────────────────────────────────────────────────

class TestNoJudgmentFields:
    def test_no_calc_total_score_dynamic(self):
        import backend.engine.decision.dd10_kpi as mod
        assert not hasattr(mod, "calc_total_score_dynamic")

    def test_no_rating_labels(self):
        import backend.engine.decision.dd10_kpi as mod
        assert not hasattr(mod, "RATING_LABELS")

    def test_result_has_no_judgment_fields(self):
        result = DD10Calculator().compute([0.01, 0.02, -0.03, 0.01])
        for field in ("action", "recommendation", "is_buy", "is_sell",
                      "is_hold", "is_recommended", "rating"):
            assert not hasattr(result, field), f"{field} が DD10KPIResult に存在する"

    def test_to_dict_has_no_judgment_fields(self):
        d = DD10Calculator().compute([0.01, 0.02, -0.03, 0.01]).to_dict()
        for field in ("action", "recommendation", "is_buy", "is_sell",
                      "is_hold", "is_recommended", "rating"):
            assert field not in d, f"{field} が to_dict() に存在する"


# ── TestForbiddenImports ───────────────────────────────────────────────────────

class TestForbiddenImports:
    def test_no_forbidden_imports(self):
        import backend.engine.decision.dd10_kpi as mod
        import_lines = [
            line.strip()
            for line in inspect.getsource(mod).splitlines()
            if line.strip().startswith(("import ", "from "))
        ]
        src_imports = "\n".join(import_lines)
        forbidden = [
            "import requests", "import httpx", "import aiohttp",
            "import urllib.request", "import openai", "import anthropic",
            "import litellm", "import ollama", "import pandas", "import numpy",
            "from backend.engine.scoring",
            "from backend.engine.regime",
            "from backend.engine.operation",
            "from backend.engine.market_intel",
            "from backend.engine.news",
        ]
        for item in forbidden:
            assert item not in src_imports, f"禁止 import が含まれている: {item}"
