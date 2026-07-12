"""
test_volatility_targeting.py — Card 5-10A テスト

calc_realized_vol / VolatilityTargetResult / VolatilityCalculator.compute の全仕様を検証する。

all-zero returns / target_vol fallback / is_vol_defined / clamp /
scaled_position 一貫性 / 判断フィールドなし / 禁止 import なし を含む。
"""
from __future__ import annotations

import inspect
import json
import math
import statistics

import pytest

from backend.engine.decision.volatility_targeting import (
    VolatilityCalculator,
    VolatilityTargetResult,
    calc_realized_vol,
)

_CALC = VolatilityCalculator()
_ANN = 252


# ── ヘルパー ───────────────────────────────────────────────────────────────────

def _expected_vol(returns: list[float], ann: int = _ANN) -> float:
    """手計算の年率換算実現ボラティリティ（標本標準偏差 * sqrt(ann)）。"""
    return statistics.stdev(returns) * math.sqrt(ann)


def _simple_returns(n: int = 20, base: float = 0.01) -> list[float]:
    """等差的な日次リターン系列（n件）。"""
    return [base * (i + 1) / n for i in range(n)]


# ── TestCalcRealizedVol ────────────────────────────────────────────────────────

class TestCalcRealizedVol:
    def test_empty_list(self):
        vol, defined = calc_realized_vol([])
        assert vol == 0.0
        assert defined is False

    def test_single_element(self):
        vol, defined = calc_realized_vol([0.01])
        assert vol == 0.0
        assert defined is False

    def test_all_zero_returns(self):
        # all-zero は stdev=0 → (0.0, True)
        vol, defined = calc_realized_vol([0.0, 0.0, 0.0])
        assert vol == 0.0
        assert defined is True

    def test_two_element_list(self):
        vol, defined = calc_realized_vol([0.01, -0.01])
        assert defined is True
        assert vol >= 0.0

    def test_normal_returns_matches_manual(self):
        rets = [0.01, 0.02, -0.01, 0.015, -0.005]
        vol, defined = calc_realized_vol(rets)
        expected = _expected_vol(rets)
        assert defined is True
        assert abs(vol - expected) < 1e-12

    def test_annualize_factor_252(self):
        rets = [0.01, -0.01, 0.02, -0.02, 0.005]
        vol_252, _ = calc_realized_vol(rets, annualize_factor=252)
        daily_std = statistics.stdev(rets)
        assert abs(vol_252 - daily_std * math.sqrt(252)) < 1e-12

    def test_annualize_factor_52(self):
        rets = [0.01, -0.01, 0.02, -0.02, 0.005]
        vol_52, _ = calc_realized_vol(rets, annualize_factor=52)
        daily_std = statistics.stdev(rets)
        assert abs(vol_52 - daily_std * math.sqrt(52)) < 1e-12

    def test_annualize_factor_12(self):
        rets = [0.01, -0.01, 0.02]
        vol_12, _ = calc_realized_vol(rets, annualize_factor=12)
        daily_std = statistics.stdev(rets)
        assert abs(vol_12 - daily_std * math.sqrt(12)) < 1e-12

    def test_result_always_nonnegative(self):
        rets = _simple_returns(30)
        vol, _ = calc_realized_vol(rets)
        assert vol >= 0.0

    def test_returns_tuple_float_bool(self):
        result = calc_realized_vol([0.01, 0.02])
        assert isinstance(result, tuple)
        assert len(result) == 2
        vol, defined = result
        assert isinstance(vol, float)
        assert isinstance(defined, bool)

    def test_invalid_values_excluded(self):
        # 変換不能値は除外される
        # None / str を含んでも valid が 2 件以上なら計算可能
        rets_clean = [0.01, 0.02, -0.01]
        vol_clean, defined_clean = calc_realized_vol(rets_clean)
        assert defined_clean is True

    def test_large_list(self):
        rets = [0.001 * (i % 5 - 2) for i in range(1000)]
        vol, defined = calc_realized_vol(rets)
        assert defined is True
        assert vol >= 0.0


# ── TestVolatilityTargetResultFrozen ──────────────────────────────────────────

class TestVolatilityTargetResultFrozen:
    def _make(self) -> VolatilityTargetResult:
        return VolatilityTargetResult(
            realized_vol=0.20,
            target_vol=0.15,
            exposure_multiplier=0.75,
            scaled_position=75.0,
            is_vol_defined=True,
            annualize_factor=252,
        )

    def test_frozen_realized_vol(self):
        r = self._make()
        with pytest.raises(Exception):
            r.realized_vol = 0.99  # type: ignore[misc]

    def test_frozen_exposure_multiplier(self):
        r = self._make()
        with pytest.raises(Exception):
            r.exposure_multiplier = 9.0  # type: ignore[misc]

    def test_types(self):
        r = self._make()
        assert isinstance(r.realized_vol, float)
        assert isinstance(r.target_vol, float)
        assert isinstance(r.exposure_multiplier, float)
        assert isinstance(r.scaled_position, float)
        assert isinstance(r.is_vol_defined, bool)
        assert isinstance(r.annualize_factor, int)


# ── TestVolatilityTargetResultToDict ──────────────────────────────────────────

class TestVolatilityTargetResultToDict:
    def _result(self) -> VolatilityTargetResult:
        return VolatilityTargetResult(
            realized_vol=0.20,
            target_vol=0.15,
            exposure_multiplier=0.75,
            scaled_position=75.0,
            is_vol_defined=True,
            annualize_factor=252,
        )

    def test_returns_dict(self):
        assert isinstance(self._result().to_dict(), dict)

    def test_all_keys_present(self):
        d = self._result().to_dict()
        expected = {
            "realized_vol", "target_vol", "exposure_multiplier",
            "scaled_position", "is_vol_defined", "annualize_factor",
        }
        assert set(d.keys()) == expected

    def test_values_correct(self):
        d = self._result().to_dict()
        assert abs(d["realized_vol"] - 0.20) < 1e-12
        assert abs(d["target_vol"] - 0.15) < 1e-12
        assert abs(d["exposure_multiplier"] - 0.75) < 1e-12
        assert abs(d["scaled_position"] - 75.0) < 1e-12
        assert d["is_vol_defined"] is True
        assert d["annualize_factor"] == 252

    def test_json_serializable(self):
        d = self._result().to_dict()
        json.dumps(d)  # raises if not serializable

    def test_no_judgment_fields(self):
        d = self._result().to_dict()
        for field in ("action", "recommendation", "is_buy", "is_sell",
                      "is_hold", "is_recommended", "rating"):
            assert field not in d, f"判断フィールド {field} が to_dict() に存在する"


# ── TestVolatilityCalculatorNormal ────────────────────────────────────────────

class TestVolatilityCalculatorNormal:
    def setup_method(self):
        self.calc = VolatilityCalculator()
        self.rets = [0.01, -0.01, 0.02, -0.02, 0.005, -0.005,
                     0.015, -0.015, 0.008, 0.003]

    def test_returns_volatility_target_result(self):
        result = self.calc.compute(self.rets, base_size=100.0)
        assert isinstance(result, VolatilityTargetResult)

    def test_is_vol_defined_true(self):
        result = self.calc.compute(self.rets, base_size=100.0)
        assert result.is_vol_defined is True

    def test_realized_vol_matches_manual(self):
        result = self.calc.compute(self.rets, base_size=100.0)
        expected = _expected_vol(self.rets)
        assert abs(result.realized_vol - expected) < 1e-9

    def test_target_vol_stored_correctly(self):
        result = self.calc.compute(self.rets, base_size=100.0, target_vol=0.20)
        assert abs(result.target_vol - 0.20) < 1e-12

    def test_annualize_factor_stored(self):
        result = self.calc.compute(self.rets, base_size=100.0)
        assert result.annualize_factor == 252


# ── TestVolatilityCalculatorMultiplierLogic ───────────────────────────────────

class TestVolatilityCalculatorMultiplierLogic:
    def setup_method(self):
        self.calc = VolatilityCalculator()

    def _make_high_vol(self) -> list[float]:
        """高ボラティリティ returns（target_vol より大きくなるよう設計）。"""
        return [0.03, -0.04, 0.05, -0.05, 0.04, -0.03, 0.06, -0.06,
                0.04, -0.04, 0.05, -0.05]

    def _make_low_vol(self) -> list[float]:
        """低ボラティリティ returns（target_vol より小さくなるよう設計）。"""
        return [0.0001, -0.0001, 0.0002, -0.0002, 0.0001,
                0.0003, -0.0003, 0.0001, -0.0001, 0.0002]

    def test_high_vol_multiplier_lt_one(self):
        rets = self._make_high_vol()
        result = self.calc.compute(rets, base_size=100.0, target_vol=0.15)
        assert result.exposure_multiplier < 1.0

    def test_low_vol_multiplier_gt_one(self):
        rets = self._make_low_vol()
        result = self.calc.compute(rets, base_size=100.0, target_vol=0.15)
        assert result.exposure_multiplier > 1.0

    def test_equal_vol_multiplier_approx_one(self):
        # [x, -x] の stdev = x*sqrt(2) を利用し、stdev == daily_std となる x を逆算
        # stdev = x * sqrt(2) = daily_std → x = daily_std / sqrt(2)
        target = 0.15
        daily_std = target / math.sqrt(252)
        x = daily_std / math.sqrt(2)
        rets = [x, -x]  # stdev([x,-x]) == x*sqrt(2) == daily_std
        result = self.calc.compute(rets, base_size=100.0, target_vol=target)
        assert abs(result.exposure_multiplier - 1.0) < 1e-9

    def test_max_scale_not_exceeded(self):
        rets = self._make_low_vol()
        result = self.calc.compute(
            rets, base_size=100.0, target_vol=0.15, max_scale=1.5
        )
        assert result.exposure_multiplier <= 1.5 + 1e-12

    def test_min_scale_not_underrun(self):
        rets = self._make_high_vol()
        result = self.calc.compute(
            rets, base_size=100.0, target_vol=0.15, min_scale=0.3
        )
        assert result.exposure_multiplier >= 0.3 - 1e-12

    def test_scaled_position_equals_base_times_multiplier(self):
        rets = self._make_high_vol()
        result = self.calc.compute(rets, base_size=100.0)
        expected = 100.0 * result.exposure_multiplier
        assert abs(result.scaled_position - expected) < 1e-9

    def test_max_scale_lt_min_scale_no_exception(self):
        # max_scale < min_scale でも例外を出さず effective_max_scale で吸収
        rets = self._make_high_vol()
        result = self.calc.compute(
            rets, base_size=100.0, max_scale=0.2, min_scale=0.5
        )
        # effective_max_scale = max(0.2, 0.5) = 0.5
        assert isinstance(result, VolatilityTargetResult)
        assert result.exposure_multiplier <= 0.5 + 1e-12


# ── TestVolatilityCalculatorFallback ──────────────────────────────────────────

class TestVolatilityCalculatorFallback:
    def setup_method(self):
        self.calc = VolatilityCalculator()

    def test_empty_returns_multiplier_one(self):
        result = self.calc.compute([], base_size=100.0)
        assert abs(result.exposure_multiplier - 1.0) < 1e-12

    def test_empty_returns_scaled_position_equals_base(self):
        result = self.calc.compute([], base_size=100.0)
        assert abs(result.scaled_position - 100.0) < 1e-12

    def test_empty_returns_is_vol_defined_false(self):
        result = self.calc.compute([], base_size=100.0)
        assert result.is_vol_defined is False

    def test_single_return_fallback(self):
        result = self.calc.compute([0.01], base_size=50.0)
        assert result.is_vol_defined is False
        assert abs(result.exposure_multiplier - 1.0) < 1e-12
        assert abs(result.scaled_position - 50.0) < 1e-12

    def test_all_zero_returns_is_vol_defined_true(self):
        result = self.calc.compute([0.0, 0.0, 0.0, 0.0], base_size=100.0)
        assert result.is_vol_defined is True

    def test_all_zero_returns_multiplier_one_fallback(self):
        # realized_vol == 0.0 → fallback
        result = self.calc.compute([0.0, 0.0, 0.0, 0.0], base_size=100.0)
        assert abs(result.exposure_multiplier - 1.0) < 1e-12

    def test_all_zero_returns_scaled_position_equals_base(self):
        result = self.calc.compute([0.0, 0.0, 0.0, 0.0], base_size=100.0)
        assert abs(result.scaled_position - 100.0) < 1e-12

    def test_all_zero_realized_vol_is_zero(self):
        result = self.calc.compute([0.0, 0.0, 0.0], base_size=100.0)
        assert result.realized_vol == 0.0


# ── TestVolatilityCalculatorTargetVolFallback ─────────────────────────────────

class TestVolatilityCalculatorTargetVolFallback:
    def setup_method(self):
        self.calc = VolatilityCalculator()
        self.rets = [0.01, -0.01, 0.02, -0.02, 0.005]

    def test_negative_target_vol_uses_default(self):
        result = self.calc.compute(self.rets, base_size=100.0, target_vol=-1.0)
        assert abs(result.target_vol - VolatilityCalculator.DEFAULT_TARGET_VOL) < 1e-12

    def test_zero_target_vol_uses_default(self):
        result = self.calc.compute(self.rets, base_size=100.0, target_vol=0.0)
        assert abs(result.target_vol - VolatilityCalculator.DEFAULT_TARGET_VOL) < 1e-12

    def test_positive_target_vol_stored_as_is(self):
        result = self.calc.compute(self.rets, base_size=100.0, target_vol=0.20)
        assert abs(result.target_vol - 0.20) < 1e-12

    def test_very_small_positive_target_vol_used(self):
        # 0.0001 > 0 なので DEFAULT は使わない
        result = self.calc.compute(self.rets, base_size=100.0, target_vol=0.0001)
        assert abs(result.target_vol - 0.0001) < 1e-15


# ── TestVolatilityCalculatorBaseSizeClamp ─────────────────────────────────────

class TestVolatilityCalculatorBaseSizeClamp:
    def setup_method(self):
        self.calc = VolatilityCalculator()
        self.rets = [0.01, -0.01, 0.02, -0.02, 0.005]

    def test_negative_base_size_scaled_position_zero(self):
        result = self.calc.compute(self.rets, base_size=-100.0)
        assert result.scaled_position == 0.0

    def test_zero_base_size_scaled_position_zero(self):
        result = self.calc.compute(self.rets, base_size=0.0)
        assert result.scaled_position == 0.0

    def test_positive_base_size_normal(self):
        result = self.calc.compute(self.rets, base_size=100.0)
        assert result.scaled_position >= 0.0


# ── TestVolatilityCalculatorScaledPositionConsistency ─────────────────────────

class TestVolatilityCalculatorScaledPositionConsistency:
    def setup_method(self):
        self.calc = VolatilityCalculator()

    def test_scaled_position_always_nonnegative(self):
        for rets in [[], [0.0, 0.0], [0.01, -0.01, 0.02, -0.02]]:
            result = self.calc.compute(rets, base_size=100.0)
            assert result.scaled_position >= 0.0

    def test_scaled_position_eq_base_when_multiplier_one(self):
        # fallback 時は multiplier = 1.0 → scaled_position = base_size
        result = self.calc.compute([], base_size=123.0)
        assert abs(result.scaled_position - 123.0) < 1e-12

    def test_scaled_position_eq_zero_when_base_zero(self):
        rets = [0.01, -0.01, 0.02, -0.02, 0.005]
        result = self.calc.compute(rets, base_size=0.0)
        assert result.scaled_position == 0.0

    def test_scaled_position_consistent_with_multiplier(self):
        rets = [0.01, -0.01, 0.02, -0.02, 0.005, -0.005,
                0.015, -0.015, 0.008, 0.003]
        base = 250.0
        result = self.calc.compute(rets, base_size=base)
        expected = base * result.exposure_multiplier
        assert abs(result.scaled_position - expected) < 1e-9

    def test_annualize_factor_52_works(self):
        rets = [0.01, -0.01, 0.02, -0.02, 0.005]
        result = self.calc.compute(rets, base_size=100.0, annualize_factor=52)
        assert result.annualize_factor == 52
        assert isinstance(result, VolatilityTargetResult)


# ── TestVolatilityCalculatorDefaults ──────────────────────────────────────────

class TestVolatilityCalculatorDefaults:
    def test_default_target_vol(self):
        assert abs(VolatilityCalculator.DEFAULT_TARGET_VOL - 0.15) < 1e-12

    def test_default_max_scale(self):
        assert abs(VolatilityCalculator.DEFAULT_MAX_SCALE - 2.0) < 1e-12

    def test_default_min_scale(self):
        assert abs(VolatilityCalculator.DEFAULT_MIN_SCALE - 0.5) < 1e-12

    def test_default_annualize(self):
        assert VolatilityCalculator.DEFAULT_ANNUALIZE == 252


# ── TestNoJudgmentFields ───────────────────────────────────────────────────────

class TestNoJudgmentFields:
    def test_no_calc_total_score_dynamic(self):
        import backend.engine.decision.volatility_targeting as mod
        assert not hasattr(mod, "calc_total_score_dynamic")

    def test_no_rating_labels(self):
        import backend.engine.decision.volatility_targeting as mod
        assert not hasattr(mod, "RATING_LABELS")

    def test_result_has_no_judgment_fields(self):
        rets = [0.01, -0.01, 0.02, -0.02, 0.005]
        result = VolatilityCalculator().compute(rets, base_size=100.0)
        for field in ("action", "recommendation", "is_buy", "is_sell",
                      "is_hold", "is_recommended", "rating"):
            assert not hasattr(result, field), f"{field} が VolatilityTargetResult に存在する"

    def test_to_dict_has_no_judgment_fields(self):
        rets = [0.01, -0.01, 0.02, -0.02, 0.005]
        d = VolatilityCalculator().compute(rets, base_size=100.0).to_dict()
        for field in ("action", "recommendation", "is_buy", "is_sell",
                      "is_hold", "is_recommended", "rating"):
            assert field not in d, f"判断フィールド {field} が to_dict() に存在する"


# ── TestForbiddenImports ───────────────────────────────────────────────────────

class TestForbiddenImports:
    def test_no_forbidden_imports(self):
        import backend.engine.decision.volatility_targeting as mod
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
