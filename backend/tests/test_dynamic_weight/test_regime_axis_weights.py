"""
test_regime_axis_weights.py — Card 6-1 テスト

REGIME_AXIS_WEIGHTS テーブル / get_axis_weights / validate_axis_weights /
validate_all_regime_axis_weights の全仕様を検証する。

shallow copy 保護 / 未知レジーム fallback / 重み合計 / 軸完全性 /
禁止 import / 判断フィールドなし を含む。
"""
from __future__ import annotations

import inspect

import pytest

from backend.engine.dynamic_weight.regime_axis_weights import (
    CANONICAL_AXES,
    REGIME_AXIS_WEIGHTS,
    VALID_REGIMES,
    get_axis_weights,
    validate_all_regime_axis_weights,
    validate_axis_weights,
)

_ALL_REGIMES = ("bull_calm", "bull_volatile", "bear", "crisis", "uncertain")


# ── TestCanonicalAxes ──────────────────────────────────────────────────────────

class TestCanonicalAxes:
    def test_is_tuple(self):
        assert isinstance(CANONICAL_AXES, tuple)

    def test_six_elements(self):
        assert len(CANONICAL_AXES) == 6

    def test_exact_values(self):
        assert CANONICAL_AXES == (
            "value", "quality", "growth", "safety", "momentum", "shareholder_return"
        )


# ── TestValidRegimes ───────────────────────────────────────────────────────────

class TestValidRegimes:
    def test_is_tuple(self):
        assert isinstance(VALID_REGIMES, tuple)

    def test_five_regimes(self):
        assert len(VALID_REGIMES) == 5

    def test_contains_all_regimes(self):
        for r in _ALL_REGIMES:
            assert r in VALID_REGIMES

    def test_matches_regime_axis_weights_keys(self):
        assert set(VALID_REGIMES) == set(REGIME_AXIS_WEIGHTS.keys())


# ── TestRegimeAxisWeightsTable ─────────────────────────────────────────────────

class TestRegimeAxisWeightsTable:
    def test_all_regimes_present(self):
        for r in _ALL_REGIMES:
            assert r in REGIME_AXIS_WEIGHTS

    def test_all_regimes_have_six_axes(self):
        for regime, weights in REGIME_AXIS_WEIGHTS.items():
            for axis in CANONICAL_AXES:
                assert axis in weights, f"{regime} に {axis} が欠損"

    def test_no_extra_axes(self):
        for regime, weights in REGIME_AXIS_WEIGHTS.items():
            assert set(weights.keys()) == set(CANONICAL_AXES), \
                f"{regime} に余分な軸がある: {set(weights.keys()) - set(CANONICAL_AXES)}"

    @pytest.mark.parametrize("regime", _ALL_REGIMES)
    def test_weights_sum_to_one(self, regime):
        total = sum(REGIME_AXIS_WEIGHTS[regime].values())
        assert abs(total - 1.0) < 1e-9, f"{regime}: sum={total}"

    @pytest.mark.parametrize("regime", _ALL_REGIMES)
    def test_all_weights_positive(self, regime):
        for axis, w in REGIME_AXIS_WEIGHTS[regime].items():
            assert w > 0.0, f"{regime}.{axis} weight={w} は 0 以下"

    @pytest.mark.parametrize("regime", _ALL_REGIMES)
    def test_all_weights_le_one(self, regime):
        for axis, w in REGIME_AXIS_WEIGHTS[regime].items():
            assert w <= 1.0, f"{regime}.{axis} weight={w} が 1.0 超"

    # 各レジームの具体値
    def test_bull_calm_values(self):
        w = REGIME_AXIS_WEIGHTS["bull_calm"]
        assert abs(w["value"]              - 0.20) < 1e-12
        assert abs(w["quality"]            - 0.15) < 1e-12
        assert abs(w["growth"]             - 0.20) < 1e-12
        assert abs(w["safety"]             - 0.10) < 1e-12
        assert abs(w["momentum"]           - 0.20) < 1e-12
        assert abs(w["shareholder_return"] - 0.15) < 1e-12

    def test_bull_volatile_values(self):
        w = REGIME_AXIS_WEIGHTS["bull_volatile"]
        assert abs(w["value"]              - 0.15) < 1e-12
        assert abs(w["quality"]            - 0.20) < 1e-12
        assert abs(w["growth"]             - 0.15) < 1e-12
        assert abs(w["safety"]             - 0.15) < 1e-12
        assert abs(w["momentum"]           - 0.25) < 1e-12
        assert abs(w["shareholder_return"] - 0.10) < 1e-12

    def test_bear_values(self):
        w = REGIME_AXIS_WEIGHTS["bear"]
        assert abs(w["value"]              - 0.20) < 1e-12
        assert abs(w["quality"]            - 0.25) < 1e-12
        assert abs(w["growth"]             - 0.10) < 1e-12
        assert abs(w["safety"]             - 0.25) < 1e-12
        assert abs(w["momentum"]           - 0.05) < 1e-12
        assert abs(w["shareholder_return"] - 0.15) < 1e-12

    def test_crisis_values(self):
        w = REGIME_AXIS_WEIGHTS["crisis"]
        assert abs(w["value"]              - 0.15) < 1e-12
        assert abs(w["quality"]            - 0.25) < 1e-12
        assert abs(w["growth"]             - 0.05) < 1e-12
        assert abs(w["safety"]             - 0.40) < 1e-12
        assert abs(w["momentum"]           - 0.05) < 1e-12
        assert abs(w["shareholder_return"] - 0.10) < 1e-12

    def test_uncertain_values(self):
        w = REGIME_AXIS_WEIGHTS["uncertain"]
        assert abs(w["value"]              - 0.17) < 1e-12
        assert abs(w["quality"]            - 0.17) < 1e-12
        assert abs(w["growth"]             - 0.17) < 1e-12
        assert abs(w["safety"]             - 0.17) < 1e-12
        assert abs(w["momentum"]           - 0.17) < 1e-12
        assert abs(w["shareholder_return"] - 0.15) < 1e-12

    # crisis の safety が最も重い
    def test_crisis_safety_highest(self):
        w = REGIME_AXIS_WEIGHTS["crisis"]
        assert w["safety"] == max(w.values())

    # bull_volatile の momentum が bull_calm より大きい
    def test_bull_volatile_momentum_gt_bull_calm(self):
        assert (REGIME_AXIS_WEIGHTS["bull_volatile"]["momentum"]
                > REGIME_AXIS_WEIGHTS["bull_calm"]["momentum"])

    # bear の growth が bull_calm より小さい
    def test_bear_growth_lt_bull_calm(self):
        assert (REGIME_AXIS_WEIGHTS["bear"]["growth"]
                < REGIME_AXIS_WEIGHTS["bull_calm"]["growth"])


# ── TestGetAxisWeights ─────────────────────────────────────────────────────────

class TestGetAxisWeights:
    @pytest.mark.parametrize("regime", _ALL_REGIMES)
    def test_known_regime_returns_correct_dict(self, regime):
        result = get_axis_weights(regime)
        for axis in CANONICAL_AXES:
            assert axis in result
            expected = REGIME_AXIS_WEIGHTS[regime][axis]
            assert abs(result[axis] - expected) < 1e-12

    def test_unknown_regime_fallback_to_uncertain(self):
        result = get_axis_weights("nonexistent_regime")
        uncertain = REGIME_AXIS_WEIGHTS["uncertain"]
        for axis in CANONICAL_AXES:
            assert abs(result[axis] - uncertain[axis]) < 1e-12

    def test_empty_string_fallback_to_uncertain(self):
        result = get_axis_weights("")
        uncertain = REGIME_AXIS_WEIGHTS["uncertain"]
        for axis in CANONICAL_AXES:
            assert abs(result[axis] - uncertain[axis]) < 1e-12

    def test_returns_dict(self):
        assert isinstance(get_axis_weights("bull_calm"), dict)

    # shallow copy 保護テスト
    def test_shallow_copy_mutation_does_not_affect_table(self):
        result = get_axis_weights("bull_calm")
        original_value = REGIME_AXIS_WEIGHTS["bull_calm"]["value"]
        result["value"] = 9999.0  # 破壊的変更
        assert REGIME_AXIS_WEIGHTS["bull_calm"]["value"] == original_value

    def test_shallow_copy_add_key_does_not_affect_table(self):
        result = get_axis_weights("bear")
        original_keys = set(REGIME_AXIS_WEIGHTS["bear"].keys())
        result["new_fake_axis"] = 0.99
        assert set(REGIME_AXIS_WEIGHTS["bear"].keys()) == original_keys

    def test_each_call_returns_independent_copy(self):
        r1 = get_axis_weights("crisis")
        r2 = get_axis_weights("crisis")
        assert r1 is not r2  # 別オブジェクト

    def test_mutation_of_one_copy_does_not_affect_another(self):
        r1 = get_axis_weights("uncertain")
        r2 = get_axis_weights("uncertain")
        r1["value"] = 0.0
        assert r2["value"] != 0.0

    @pytest.mark.parametrize("regime", _ALL_REGIMES)
    def test_returned_weights_sum_to_one(self, regime):
        result = get_axis_weights(regime)
        assert abs(sum(result.values()) - 1.0) < 1e-9

    def test_unknown_regime_copy_is_independent(self):
        result = get_axis_weights("ghost_regime")
        original = REGIME_AXIS_WEIGHTS["uncertain"]["safety"]
        result["safety"] = 9999.0
        assert REGIME_AXIS_WEIGHTS["uncertain"]["safety"] == original


# ── TestValidateAxisWeights ────────────────────────────────────────────────────

class TestValidateAxisWeights:
    def _valid(self) -> dict[str, float]:
        return {
            "value": 0.20, "quality": 0.15, "growth": 0.20,
            "safety": 0.10, "momentum": 0.20, "shareholder_return": 0.15,
        }

    def test_valid_dict_returns_true(self):
        assert validate_axis_weights(self._valid()) is True

    def test_missing_axis_returns_false(self):
        d = self._valid()
        del d["safety"]
        assert validate_axis_weights(d) is False

    def test_zero_weight_returns_false(self):
        d = self._valid()
        d["growth"] = 0.0
        assert validate_axis_weights(d) is False

    def test_negative_weight_returns_false(self):
        d = self._valid()
        d["momentum"] = -0.01
        assert validate_axis_weights(d) is False

    def test_weight_above_one_returns_false(self):
        d = self._valid()
        d["value"] = 1.01
        assert validate_axis_weights(d) is False

    def test_weight_exactly_one_is_valid(self):
        d = {axis: 0.0 for axis in CANONICAL_AXES}
        d["value"] = 1.0
        # sum = 1.0 だが他が 0.0 → 0.0 < w の条件で失敗
        assert validate_axis_weights(d) is False

    def test_sum_not_one_returns_false(self):
        d = self._valid()
        d["value"] = 0.30  # sum != 1.0
        assert validate_axis_weights(d) is False

    def test_non_dict_returns_false(self):
        assert validate_axis_weights("not_a_dict") is False  # type: ignore[arg-type]

    def test_none_returns_false(self):
        assert validate_axis_weights(None) is False  # type: ignore[arg-type]

    def test_uncertain_weights_valid(self):
        uncertain = dict(REGIME_AXIS_WEIGHTS["uncertain"])
        assert validate_axis_weights(uncertain) is True

    def test_crisis_weights_valid(self):
        crisis = dict(REGIME_AXIS_WEIGHTS["crisis"])
        assert validate_axis_weights(crisis) is True


# ── TestValidateAllRegimeAxisWeights ──────────────────────────────────────────

class TestValidateAllRegimeAxisWeights:
    def test_returns_true(self):
        assert validate_all_regime_axis_weights() is True

    def test_returns_bool(self):
        result = validate_all_regime_axis_weights()
        assert isinstance(result, bool)


# ── TestNoJudgmentFields ───────────────────────────────────────────────────────

class TestNoJudgmentFields:
    def test_no_calc_total_score_dynamic(self):
        import backend.engine.dynamic_weight.regime_axis_weights as mod
        assert not hasattr(mod, "calc_total_score_dynamic"), \
            "calc_total_score_dynamic は rating フィールドを持つため実装禁止"

    def test_no_rating_constant(self):
        import backend.engine.dynamic_weight.regime_axis_weights as mod
        assert not hasattr(mod, "RATING_LABELS"), \
            "RATING_LABELS は判断フィールド相当のため禁止"

    def test_result_has_no_judgment_fields(self):
        result = get_axis_weights("bull_calm")
        for field in ("action", "recommendation", "is_buy", "is_sell",
                      "is_hold", "is_recommended", "rating"):
            assert field not in result, f"{field} は判断フィールドのため禁止"


# ── TestForbiddenImports ───────────────────────────────────────────────────────

class TestForbiddenImports:
    def test_no_forbidden_imports(self):
        import backend.engine.dynamic_weight.regime_axis_weights as mod
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
            "from backend.engine.decision",
            "from backend.engine.regime",
            "from backend.engine.operation",
            "from backend.engine.market_intel",
            "from backend.engine.news",
        ]
        for item in forbidden:
            assert item not in src_imports, f"禁止 import が含まれている: {item}"
