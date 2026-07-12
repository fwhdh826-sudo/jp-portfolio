"""
test_time_horizon_weights.py — Card 6-3 テスト

SHORT_TERM_FACTORS / LONG_TERM_FACTORS / HORIZON_FACTORS / VALID_HORIZONS /
TIME_HORIZON_WEIGHTS テーブル / get_time_horizon_weights /
validate_time_horizon_weights / validate_all_time_horizon_weights の全仕様を検証する。

shallow copy 保護 / 未知 horizon fallback / 余分キー許容 /
horizon 別 canonical 因子のみで sum 判定 / 禁止 import / 判断フィールドなし を含む。
"""
from __future__ import annotations

import inspect

import pytest

from backend.engine.dynamic_weight.time_horizon_weights import (
    HORIZON_FACTORS,
    LONG_TERM_FACTORS,
    SHORT_TERM_FACTORS,
    TIME_HORIZON_WEIGHTS,
    VALID_HORIZONS,
    get_time_horizon_weights,
    validate_all_time_horizon_weights,
    validate_time_horizon_weights,
)

_ALL_HORIZONS = ("short_term", "long_term")

_SHORT_TERM_CANONICAL = (
    "technical_momentum", "flow_microstructure", "sentiment",
    "fundamental", "factor_cross", "regime",
)
_LONG_TERM_CANONICAL = (
    "fundamental", "factor_cross", "quality_value",
    "growth", "shareholder_return", "regime",
)


# ── TestShortTermFactors ───────────────────────────────────────────────────────

class TestShortTermFactors:
    def test_is_tuple(self):
        assert isinstance(SHORT_TERM_FACTORS, tuple)

    def test_six_elements(self):
        assert len(SHORT_TERM_FACTORS) == 6

    def test_exact_values(self):
        assert SHORT_TERM_FACTORS == _SHORT_TERM_CANONICAL


# ── TestLongTermFactors ────────────────────────────────────────────────────────

class TestLongTermFactors:
    def test_is_tuple(self):
        assert isinstance(LONG_TERM_FACTORS, tuple)

    def test_six_elements(self):
        assert len(LONG_TERM_FACTORS) == 6

    def test_exact_values(self):
        assert LONG_TERM_FACTORS == _LONG_TERM_CANONICAL


# ── TestHorizonFactors ─────────────────────────────────────────────────────────

class TestHorizonFactors:
    def test_is_dict(self):
        assert isinstance(HORIZON_FACTORS, dict)

    def test_two_horizons(self):
        assert set(HORIZON_FACTORS.keys()) == {"short_term", "long_term"}

    def test_maps_to_correct_tuples(self):
        assert HORIZON_FACTORS["short_term"] == SHORT_TERM_FACTORS
        assert HORIZON_FACTORS["long_term"] == LONG_TERM_FACTORS


# ── TestValidHorizons ──────────────────────────────────────────────────────────

class TestValidHorizons:
    def test_is_tuple(self):
        assert isinstance(VALID_HORIZONS, tuple)

    def test_two_horizons(self):
        assert len(VALID_HORIZONS) == 2

    def test_contains_all_horizons(self):
        for h in _ALL_HORIZONS:
            assert h in VALID_HORIZONS

    def test_matches_time_horizon_weights_keys(self):
        assert set(VALID_HORIZONS) == set(TIME_HORIZON_WEIGHTS.keys())


# ── TestTimeHorizonWeightsTable ────────────────────────────────────────────────

class TestTimeHorizonWeightsTable:
    def test_all_horizons_present(self):
        for h in _ALL_HORIZONS:
            assert h in TIME_HORIZON_WEIGHTS

    def test_short_term_has_six_factors(self):
        for factor in SHORT_TERM_FACTORS:
            assert factor in TIME_HORIZON_WEIGHTS["short_term"], \
                f"short_term に {factor} が欠損"

    def test_long_term_has_six_factors(self):
        for factor in LONG_TERM_FACTORS:
            assert factor in TIME_HORIZON_WEIGHTS["long_term"], \
                f"long_term に {factor} が欠損"

    def test_no_extra_factors_short_term(self):
        assert set(TIME_HORIZON_WEIGHTS["short_term"].keys()) == set(SHORT_TERM_FACTORS)

    def test_no_extra_factors_long_term(self):
        assert set(TIME_HORIZON_WEIGHTS["long_term"].keys()) == set(LONG_TERM_FACTORS)

    @pytest.mark.parametrize("horizon", _ALL_HORIZONS)
    def test_canonical_weights_sum_to_one(self, horizon):
        w = TIME_HORIZON_WEIGHTS[horizon]
        factors = HORIZON_FACTORS[horizon]
        total = sum(w[f] for f in factors)
        assert abs(total - 1.0) < 1e-9, f"{horizon}: canonical sum={total}"

    @pytest.mark.parametrize("horizon", _ALL_HORIZONS)
    def test_all_weights_positive(self, horizon):
        for factor, w in TIME_HORIZON_WEIGHTS[horizon].items():
            assert w > 0.0, f"{horizon}.{factor} weight={w} は 0 以下"

    @pytest.mark.parametrize("horizon", _ALL_HORIZONS)
    def test_all_weights_le_one(self, horizon):
        for factor, w in TIME_HORIZON_WEIGHTS[horizon].items():
            assert w <= 1.0, f"{horizon}.{factor} weight={w} が 1.0 超"

    # 各 horizon の具体値
    def test_short_term_values(self):
        w = TIME_HORIZON_WEIGHTS["short_term"]
        assert abs(w["technical_momentum"]  - 0.40) < 1e-12
        assert abs(w["flow_microstructure"] - 0.20) < 1e-12
        assert abs(w["sentiment"]           - 0.15) < 1e-12
        assert abs(w["fundamental"]         - 0.10) < 1e-12
        assert abs(w["factor_cross"]        - 0.10) < 1e-12
        assert abs(w["regime"]              - 0.05) < 1e-12

    def test_long_term_values(self):
        w = TIME_HORIZON_WEIGHTS["long_term"]
        assert abs(w["fundamental"]        - 0.30) < 1e-12
        assert abs(w["factor_cross"]       - 0.20) < 1e-12
        assert abs(w["quality_value"]      - 0.20) < 1e-12
        assert abs(w["growth"]             - 0.15) < 1e-12
        assert abs(w["shareholder_return"] - 0.10) < 1e-12
        assert abs(w["regime"]             - 0.05) < 1e-12

    # 経済的整合性テスト
    def test_short_term_technical_momentum_highest(self):
        w = TIME_HORIZON_WEIGHTS["short_term"]
        assert w["technical_momentum"] == max(w.values())

    def test_long_term_fundamental_highest(self):
        w = TIME_HORIZON_WEIGHTS["long_term"]
        assert w["fundamental"] == max(w.values())

    def test_regime_lowest_in_both_horizons(self):
        for horizon in _ALL_HORIZONS:
            w = TIME_HORIZON_WEIGHTS[horizon]
            assert w["regime"] <= min(w.values()) + 1e-12, \
                f"{horizon}: regime should be lowest"

    def test_short_term_regime_equals_long_term_regime(self):
        assert abs(
            TIME_HORIZON_WEIGHTS["short_term"]["regime"]
            - TIME_HORIZON_WEIGHTS["long_term"]["regime"]
        ) < 1e-12

    def test_short_term_factor_cross_equals_fundamental(self):
        w = TIME_HORIZON_WEIGHTS["short_term"]
        assert abs(w["factor_cross"] - w["fundamental"]) < 1e-12

    def test_long_term_factor_cross_equals_quality_value(self):
        w = TIME_HORIZON_WEIGHTS["long_term"]
        assert abs(w["factor_cross"] - w["quality_value"]) < 1e-12

    def test_different_factor_sets(self):
        short_keys = set(TIME_HORIZON_WEIGHTS["short_term"].keys())
        long_keys = set(TIME_HORIZON_WEIGHTS["long_term"].keys())
        assert short_keys != long_keys

    def test_shared_factors_exist_in_both(self):
        shared = {"fundamental", "factor_cross", "regime"}
        for f in shared:
            assert f in TIME_HORIZON_WEIGHTS["short_term"]
            assert f in TIME_HORIZON_WEIGHTS["long_term"]


# ── TestGetTimeHorizonWeights ──────────────────────────────────────────────────

class TestGetTimeHorizonWeights:
    @pytest.mark.parametrize("horizon", _ALL_HORIZONS)
    def test_known_horizon_returns_correct_dict(self, horizon):
        result = get_time_horizon_weights(horizon)
        for factor in HORIZON_FACTORS[horizon]:
            assert factor in result
            expected = TIME_HORIZON_WEIGHTS[horizon][factor]
            assert abs(result[factor] - expected) < 1e-12

    def test_unknown_horizon_fallback_to_long_term(self):
        result = get_time_horizon_weights("nonexistent_horizon")
        long_term = TIME_HORIZON_WEIGHTS["long_term"]
        for factor in LONG_TERM_FACTORS:
            assert abs(result[factor] - long_term[factor]) < 1e-12

    def test_empty_string_fallback_to_long_term(self):
        result = get_time_horizon_weights("")
        long_term = TIME_HORIZON_WEIGHTS["long_term"]
        for factor in LONG_TERM_FACTORS:
            assert abs(result[factor] - long_term[factor]) < 1e-12

    def test_returns_dict(self):
        assert isinstance(get_time_horizon_weights("short_term"), dict)

    # shallow copy 保護テスト
    def test_shallow_copy_mutation_does_not_affect_table(self):
        result = get_time_horizon_weights("short_term")
        original = TIME_HORIZON_WEIGHTS["short_term"]["technical_momentum"]
        result["technical_momentum"] = 9999.0
        assert TIME_HORIZON_WEIGHTS["short_term"]["technical_momentum"] == original

    def test_shallow_copy_add_key_does_not_affect_table(self):
        result = get_time_horizon_weights("long_term")
        original_keys = set(TIME_HORIZON_WEIGHTS["long_term"].keys())
        result["new_fake_factor"] = 0.99
        assert set(TIME_HORIZON_WEIGHTS["long_term"].keys()) == original_keys

    def test_each_call_returns_independent_copy(self):
        r1 = get_time_horizon_weights("short_term")
        r2 = get_time_horizon_weights("short_term")
        assert r1 is not r2

    def test_mutation_of_one_copy_does_not_affect_another(self):
        r1 = get_time_horizon_weights("long_term")
        r2 = get_time_horizon_weights("long_term")
        r1["fundamental"] = 0.0
        assert r2["fundamental"] != 0.0

    @pytest.mark.parametrize("horizon", _ALL_HORIZONS)
    def test_returned_canonical_weights_sum_to_one(self, horizon):
        result = get_time_horizon_weights(horizon)
        factors = HORIZON_FACTORS[horizon]
        total = sum(result[f] for f in factors)
        assert abs(total - 1.0) < 1e-9

    def test_unknown_horizon_copy_is_independent(self):
        result = get_time_horizon_weights("ghost_horizon")
        original = TIME_HORIZON_WEIGHTS["long_term"]["fundamental"]
        result["fundamental"] = 9999.0
        assert TIME_HORIZON_WEIGHTS["long_term"]["fundamental"] == original


# ── TestValidateTimeHorizonWeights ─────────────────────────────────────────────

class TestValidateTimeHorizonWeights:
    def _valid_short(self) -> dict[str, float]:
        return {
            "technical_momentum":  0.40,
            "flow_microstructure": 0.20,
            "sentiment":           0.15,
            "fundamental":         0.10,
            "factor_cross":        0.10,
            "regime":              0.05,
        }

    def _valid_long(self) -> dict[str, float]:
        return {
            "fundamental":        0.30,
            "factor_cross":       0.20,
            "quality_value":      0.20,
            "growth":             0.15,
            "shareholder_return": 0.10,
            "regime":             0.05,
        }

    def test_valid_short_term_returns_true(self):
        assert validate_time_horizon_weights(self._valid_short(), "short_term") is True

    def test_valid_long_term_returns_true(self):
        assert validate_time_horizon_weights(self._valid_long(), "long_term") is True

    def test_unknown_horizon_returns_false(self):
        assert validate_time_horizon_weights(self._valid_long(), "medium_term") is False

    def test_empty_horizon_returns_false(self):
        assert validate_time_horizon_weights(self._valid_short(), "") is False

    def test_missing_factor_short_term_returns_false(self):
        d = self._valid_short()
        del d["sentiment"]
        assert validate_time_horizon_weights(d, "short_term") is False

    def test_missing_factor_long_term_returns_false(self):
        d = self._valid_long()
        del d["quality_value"]
        assert validate_time_horizon_weights(d, "long_term") is False

    def test_zero_weight_returns_false(self):
        d = self._valid_short()
        d["fundamental"] = 0.0
        assert validate_time_horizon_weights(d, "short_term") is False

    def test_negative_weight_returns_false(self):
        d = self._valid_long()
        d["growth"] = -0.01
        assert validate_time_horizon_weights(d, "long_term") is False

    def test_weight_above_one_returns_false(self):
        d = self._valid_short()
        d["technical_momentum"] = 1.01
        assert validate_time_horizon_weights(d, "short_term") is False

    def test_canonical_sum_not_one_returns_false(self):
        d = self._valid_short()
        d["technical_momentum"] = 0.50  # sum = 1.10
        assert validate_time_horizon_weights(d, "short_term") is False

    def test_non_dict_returns_false(self):
        assert validate_time_horizon_weights("not_a_dict", "short_term") is False  # type: ignore[arg-type]

    def test_none_returns_false(self):
        assert validate_time_horizon_weights(None, "long_term") is False  # type: ignore[arg-type]

    def test_short_term_table_weights_valid(self):
        assert validate_time_horizon_weights(
            dict(TIME_HORIZON_WEIGHTS["short_term"]), "short_term"
        ) is True

    def test_long_term_table_weights_valid(self):
        assert validate_time_horizon_weights(
            dict(TIME_HORIZON_WEIGHTS["long_term"]), "long_term"
        ) is True

    # 余分キー許容テスト
    def test_extra_key_allowed_if_canonical_sum_is_one(self):
        d = self._valid_short()
        d["future_factor"] = 0.99  # canonical sum はそのまま 1.0
        assert validate_time_horizon_weights(d, "short_term") is True

    def test_extra_key_not_counted_in_sum(self):
        d = self._valid_long()
        d["extra"] = 0.50  # canonical sum は 1.0 のまま
        assert validate_time_horizon_weights(d, "long_term") is True

    def test_extra_key_with_canonical_sum_wrong_returns_false(self):
        d = self._valid_short()
        d["future_factor"] = 0.99
        d["technical_momentum"] = 0.10  # canonical sum が 1.0 でない
        assert validate_time_horizon_weights(d, "short_term") is False

    # long_term のキーを short_term horizon で検証するとカノニカル因子欠損で失敗
    def test_long_term_weights_with_short_term_horizon_returns_false(self):
        long_weights = dict(TIME_HORIZON_WEIGHTS["long_term"])
        assert validate_time_horizon_weights(long_weights, "short_term") is False

    # short_term のキーを long_term horizon で検証するとカノニカル因子欠損で失敗
    def test_short_term_weights_with_long_term_horizon_returns_false(self):
        short_weights = dict(TIME_HORIZON_WEIGHTS["short_term"])
        assert validate_time_horizon_weights(short_weights, "long_term") is False


# ── TestValidateAllTimeHorizonWeights ──────────────────────────────────────────

class TestValidateAllTimeHorizonWeights:
    def test_returns_true(self):
        assert validate_all_time_horizon_weights() is True

    def test_returns_bool(self):
        result = validate_all_time_horizon_weights()
        assert isinstance(result, bool)


# ── TestNoJudgmentFields ───────────────────────────────────────────────────────

class TestNoJudgmentFields:
    def test_no_calc_total_score_dynamic(self):
        import backend.engine.dynamic_weight.time_horizon_weights as mod
        assert not hasattr(mod, "calc_total_score_dynamic"), \
            "calc_total_score_dynamic は rating フィールドを持つため実装禁止"

    def test_no_rating_constant(self):
        import backend.engine.dynamic_weight.time_horizon_weights as mod
        assert not hasattr(mod, "RATING_LABELS"), \
            "RATING_LABELS は判断フィールド相当のため禁止"

    def test_result_has_no_judgment_fields(self):
        result = get_time_horizon_weights("short_term")
        for field in ("action", "recommendation", "is_buy", "is_sell",
                      "is_hold", "is_recommended", "rating"):
            assert field not in result, f"{field} は判断フィールドのため禁止"


# ── TestForbiddenImports ───────────────────────────────────────────────────────

class TestForbiddenImports:
    def test_no_forbidden_imports(self):
        import backend.engine.dynamic_weight.time_horizon_weights as mod
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
