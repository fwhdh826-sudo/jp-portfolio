"""
test_regime_strategy_weights.py — Card 6-2 テスト

REGIME_STRATEGY_WEIGHTS テーブル / get_strategy_weights /
validate_strategy_weights / validate_all_regime_strategy_weights の全仕様を検証する。

shallow copy 保護 / 未知レジーム fallback / 余分キー許容 /
canonical 4戦略のみで sum 判定 / 禁止 import / 判断フィールドなし を含む。
"""
from __future__ import annotations

import inspect

import pytest

from backend.engine.dynamic_weight.regime_strategy_weights import (
    CANONICAL_STRATEGIES,
    REGIME_STRATEGY_WEIGHTS,
    VALID_REGIMES,
    get_strategy_weights,
    validate_all_regime_strategy_weights,
    validate_strategy_weights,
)

_ALL_REGIMES = ("bull_calm", "bull_volatile", "bear", "crisis", "uncertain")


# ── TestCanonicalStrategies ────────────────────────────────────────────────────

class TestCanonicalStrategies:
    def test_is_tuple(self):
        assert isinstance(CANONICAL_STRATEGIES, tuple)

    def test_four_elements(self):
        assert len(CANONICAL_STRATEGIES) == 4

    def test_exact_values(self):
        assert CANONICAL_STRATEGIES == (
            "frontier", "quality_size", "fundamental", "cross_factor"
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

    def test_matches_regime_strategy_weights_keys(self):
        assert set(VALID_REGIMES) == set(REGIME_STRATEGY_WEIGHTS.keys())


# ── TestRegimeStrategyWeightsTable ─────────────────────────────────────────────

class TestRegimeStrategyWeightsTable:
    def test_all_regimes_present(self):
        for r in _ALL_REGIMES:
            assert r in REGIME_STRATEGY_WEIGHTS

    def test_all_regimes_have_four_strategies(self):
        for regime, weights in REGIME_STRATEGY_WEIGHTS.items():
            for strategy in CANONICAL_STRATEGIES:
                assert strategy in weights, f"{regime} に {strategy} が欠損"

    def test_no_extra_strategies(self):
        for regime, weights in REGIME_STRATEGY_WEIGHTS.items():
            assert set(weights.keys()) == set(CANONICAL_STRATEGIES), \
                f"{regime} に余分な戦略がある: {set(weights.keys()) - set(CANONICAL_STRATEGIES)}"

    @pytest.mark.parametrize("regime", _ALL_REGIMES)
    def test_canonical_weights_sum_to_one(self, regime):
        w = REGIME_STRATEGY_WEIGHTS[regime]
        total = sum(w[s] for s in CANONICAL_STRATEGIES)
        assert abs(total - 1.0) < 1e-9, f"{regime}: canonical sum={total}"

    @pytest.mark.parametrize("regime", _ALL_REGIMES)
    def test_all_weights_positive(self, regime):
        for strat, w in REGIME_STRATEGY_WEIGHTS[regime].items():
            assert w > 0.0, f"{regime}.{strat} weight={w} は 0 以下"

    @pytest.mark.parametrize("regime", _ALL_REGIMES)
    def test_all_weights_le_one(self, regime):
        for strat, w in REGIME_STRATEGY_WEIGHTS[regime].items():
            assert w <= 1.0, f"{regime}.{strat} weight={w} が 1.0 超"

    # 各レジームの具体値
    def test_bull_calm_values(self):
        w = REGIME_STRATEGY_WEIGHTS["bull_calm"]
        assert abs(w["frontier"]     - 0.40) < 1e-12
        assert abs(w["quality_size"] - 0.25) < 1e-12
        assert abs(w["fundamental"]  - 0.20) < 1e-12
        assert abs(w["cross_factor"] - 0.15) < 1e-12

    def test_bull_volatile_values(self):
        w = REGIME_STRATEGY_WEIGHTS["bull_volatile"]
        assert abs(w["frontier"]     - 0.30) < 1e-12
        assert abs(w["quality_size"] - 0.20) < 1e-12
        assert abs(w["fundamental"]  - 0.30) < 1e-12
        assert abs(w["cross_factor"] - 0.20) < 1e-12

    def test_bear_values(self):
        w = REGIME_STRATEGY_WEIGHTS["bear"]
        assert abs(w["frontier"]     - 0.50) < 1e-12
        assert abs(w["quality_size"] - 0.10) < 1e-12
        assert abs(w["fundamental"]  - 0.15) < 1e-12
        assert abs(w["cross_factor"] - 0.25) < 1e-12

    def test_crisis_values(self):
        w = REGIME_STRATEGY_WEIGHTS["crisis"]
        assert abs(w["frontier"]     - 0.70) < 1e-12
        assert abs(w["quality_size"] - 0.05) < 1e-12
        assert abs(w["fundamental"]  - 0.05) < 1e-12
        assert abs(w["cross_factor"] - 0.20) < 1e-12

    def test_uncertain_values(self):
        w = REGIME_STRATEGY_WEIGHTS["uncertain"]
        assert abs(w["frontier"]     - 0.40) < 1e-12
        assert abs(w["quality_size"] - 0.20) < 1e-12
        assert abs(w["fundamental"]  - 0.20) < 1e-12
        assert abs(w["cross_factor"] - 0.20) < 1e-12

    # 経済的整合性テスト
    def test_crisis_frontier_highest(self):
        # crisis: リスクオフ → Frontier（最適化戦略）に集中
        w = REGIME_STRATEGY_WEIGHTS["crisis"]
        assert w["frontier"] == max(w.values())

    def test_bear_frontier_gt_bull_calm(self):
        # bear の frontier 比率 > bull_calm の frontier 比率
        assert (REGIME_STRATEGY_WEIGHTS["bear"]["frontier"]
                > REGIME_STRATEGY_WEIGHTS["bull_calm"]["frontier"])

    def test_crisis_quality_size_lowest(self):
        # crisis: quality_size と fundamental が最小（0.05）
        w = REGIME_STRATEGY_WEIGHTS["crisis"]
        assert w["quality_size"] <= min(w.values()) + 1e-12

    def test_bull_volatile_fundamental_equals_frontier(self):
        # bull_volatile: fundamental と frontier が同率（0.30）でリスク分散
        w = REGIME_STRATEGY_WEIGHTS["bull_volatile"]
        assert abs(w["fundamental"] - w["frontier"]) < 1e-12


# ── TestGetStrategyWeights ─────────────────────────────────────────────────────

class TestGetStrategyWeights:
    @pytest.mark.parametrize("regime", _ALL_REGIMES)
    def test_known_regime_returns_correct_dict(self, regime):
        result = get_strategy_weights(regime)
        for strategy in CANONICAL_STRATEGIES:
            assert strategy in result
            expected = REGIME_STRATEGY_WEIGHTS[regime][strategy]
            assert abs(result[strategy] - expected) < 1e-12

    def test_unknown_regime_fallback_to_uncertain(self):
        result = get_strategy_weights("nonexistent_regime")
        uncertain = REGIME_STRATEGY_WEIGHTS["uncertain"]
        for strategy in CANONICAL_STRATEGIES:
            assert abs(result[strategy] - uncertain[strategy]) < 1e-12

    def test_empty_string_fallback_to_uncertain(self):
        result = get_strategy_weights("")
        uncertain = REGIME_STRATEGY_WEIGHTS["uncertain"]
        for strategy in CANONICAL_STRATEGIES:
            assert abs(result[strategy] - uncertain[strategy]) < 1e-12

    def test_returns_dict(self):
        assert isinstance(get_strategy_weights("bull_calm"), dict)

    # shallow copy 保護テスト
    def test_shallow_copy_mutation_does_not_affect_table(self):
        result = get_strategy_weights("bull_calm")
        original_value = REGIME_STRATEGY_WEIGHTS["bull_calm"]["frontier"]
        result["frontier"] = 9999.0
        assert REGIME_STRATEGY_WEIGHTS["bull_calm"]["frontier"] == original_value

    def test_shallow_copy_add_key_does_not_affect_table(self):
        result = get_strategy_weights("bear")
        original_keys = set(REGIME_STRATEGY_WEIGHTS["bear"].keys())
        result["new_fake_strategy"] = 0.99
        assert set(REGIME_STRATEGY_WEIGHTS["bear"].keys()) == original_keys

    def test_each_call_returns_independent_copy(self):
        r1 = get_strategy_weights("crisis")
        r2 = get_strategy_weights("crisis")
        assert r1 is not r2

    def test_mutation_of_one_copy_does_not_affect_another(self):
        r1 = get_strategy_weights("uncertain")
        r2 = get_strategy_weights("uncertain")
        r1["frontier"] = 0.0
        assert r2["frontier"] != 0.0

    @pytest.mark.parametrize("regime", _ALL_REGIMES)
    def test_returned_canonical_weights_sum_to_one(self, regime):
        result = get_strategy_weights(regime)
        total = sum(result[s] for s in CANONICAL_STRATEGIES)
        assert abs(total - 1.0) < 1e-9

    def test_unknown_regime_copy_is_independent(self):
        result = get_strategy_weights("ghost_regime")
        original = REGIME_STRATEGY_WEIGHTS["uncertain"]["frontier"]
        result["frontier"] = 9999.0
        assert REGIME_STRATEGY_WEIGHTS["uncertain"]["frontier"] == original


# ── TestValidateStrategyWeights ────────────────────────────────────────────────

class TestValidateStrategyWeights:
    def _valid(self) -> dict[str, float]:
        return {
            "frontier":     0.40,
            "quality_size": 0.25,
            "fundamental":  0.20,
            "cross_factor": 0.15,
        }

    def test_valid_dict_returns_true(self):
        assert validate_strategy_weights(self._valid()) is True

    def test_missing_strategy_returns_false(self):
        d = self._valid()
        del d["quality_size"]
        assert validate_strategy_weights(d) is False

    def test_missing_frontier_returns_false(self):
        d = self._valid()
        del d["frontier"]
        assert validate_strategy_weights(d) is False

    def test_zero_weight_returns_false(self):
        d = self._valid()
        d["fundamental"] = 0.0
        assert validate_strategy_weights(d) is False

    def test_negative_weight_returns_false(self):
        d = self._valid()
        d["cross_factor"] = -0.01
        assert validate_strategy_weights(d) is False

    def test_weight_above_one_returns_false(self):
        d = self._valid()
        d["frontier"] = 1.01
        assert validate_strategy_weights(d) is False

    def test_canonical_sum_not_one_returns_false(self):
        d = self._valid()
        d["frontier"] = 0.50  # sum = 1.10
        assert validate_strategy_weights(d) is False

    def test_non_dict_returns_false(self):
        assert validate_strategy_weights("not_a_dict") is False  # type: ignore[arg-type]

    def test_none_returns_false(self):
        assert validate_strategy_weights(None) is False  # type: ignore[arg-type]

    def test_uncertain_weights_valid(self):
        uncertain = dict(REGIME_STRATEGY_WEIGHTS["uncertain"])
        assert validate_strategy_weights(uncertain) is True

    def test_crisis_weights_valid(self):
        crisis = dict(REGIME_STRATEGY_WEIGHTS["crisis"])
        assert validate_strategy_weights(crisis) is True

    # 余分キー許容テスト
    def test_extra_key_allowed_if_canonical_sum_is_one(self):
        # canonical 4戦略が揃い canonical sum == 1.0 なら、余分キーがあっても True
        d = self._valid()
        d["future_strategy"] = 0.99  # canonical sum はそのまま 1.0
        assert validate_strategy_weights(d) is True

    def test_extra_key_not_counted_in_sum(self):
        # 余分キーを追加しても canonical sum が 1.0 のまま → True
        d = self._valid()
        d["extra"] = 0.50  # これを含めると sum > 1.0 だが除外される
        assert validate_strategy_weights(d) is True

    def test_extra_key_with_canonical_sum_wrong_returns_false(self):
        # 余分キーがあっても canonical sum が 1.0 でなければ False
        d = self._valid()
        d["future_strategy"] = 0.99
        d["frontier"] = 0.10  # canonical sum = 0.70 → False
        assert validate_strategy_weights(d) is False


# ── TestValidateAllRegimeStrategyWeights ──────────────────────────────────────

class TestValidateAllRegimeStrategyWeights:
    def test_returns_true(self):
        assert validate_all_regime_strategy_weights() is True

    def test_returns_bool(self):
        result = validate_all_regime_strategy_weights()
        assert isinstance(result, bool)


# ── TestNoJudgmentFields ───────────────────────────────────────────────────────

class TestNoJudgmentFields:
    def test_no_calc_total_score_dynamic(self):
        import backend.engine.dynamic_weight.regime_strategy_weights as mod
        assert not hasattr(mod, "calc_total_score_dynamic"), \
            "calc_total_score_dynamic は rating フィールドを持つため実装禁止"

    def test_no_rating_constant(self):
        import backend.engine.dynamic_weight.regime_strategy_weights as mod
        assert not hasattr(mod, "RATING_LABELS"), \
            "RATING_LABELS は判断フィールド相当のため禁止"

    def test_result_has_no_judgment_fields(self):
        result = get_strategy_weights("bull_calm")
        for field in ("action", "recommendation", "is_buy", "is_sell",
                      "is_hold", "is_recommended", "rating"):
            assert field not in result, f"{field} は判断フィールドのため禁止"


# ── TestForbiddenImports ───────────────────────────────────────────────────────

class TestForbiddenImports:
    def test_no_forbidden_imports(self):
        import backend.engine.dynamic_weight.regime_strategy_weights as mod
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
