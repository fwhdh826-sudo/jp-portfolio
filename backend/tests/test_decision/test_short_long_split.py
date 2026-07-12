"""
test_short_long_split.py — Card 5-9R テスト

ShortLongResult / HorizonSplitter / _clamp_score の全仕様を検証する。

frozen dataclass / to_dict() / present_weight_sum 正規化 / 等重み平均 fallback /
clamp / missing_factors / custom weights DI / extra factor 無視 /
判断フィールドなし / 禁止 import なし を含む。
"""
from __future__ import annotations

import inspect

import pytest

from backend.engine.decision.short_long_split import (
    HorizonSplitter,
    ShortLongResult,
    _clamp_score,
)
from backend.engine.dynamic_weight.time_horizon_weights import (
    HORIZON_FACTORS,
    get_time_horizon_weights,
)

_SHORT_CANONICAL = HORIZON_FACTORS["short_term"]  # 6因子
_LONG_CANONICAL = HORIZON_FACTORS["long_term"]    # 6因子

_SHORT_WEIGHTS = get_time_horizon_weights("short_term")
_LONG_WEIGHTS = get_time_horizon_weights("long_term")


def _all_short(score: float) -> dict[str, float]:
    """short_term の全 canonical 因子を同スコアで返す。"""
    return {f: score for f in _SHORT_CANONICAL}


def _all_long(score: float) -> dict[str, float]:
    """long_term の全 canonical 因子を同スコアで返す。"""
    return {f: score for f in _LONG_CANONICAL}


def _all_both(score: float) -> dict[str, float]:
    """両 horizon の全 canonical 因子を同スコアで返す。"""
    d = _all_short(score)
    d.update(_all_long(score))
    return d


# ── TestClampScore ─────────────────────────────────────────────────────────────

class TestClampScore:
    def test_normal_value(self):
        assert _clamp_score(50.0) == 50.0

    def test_zero(self):
        assert _clamp_score(0.0) == 0.0

    def test_hundred(self):
        assert _clamp_score(100.0) == 100.0

    def test_above_100(self):
        assert _clamp_score(150.0) == 100.0

    def test_below_0(self):
        assert _clamp_score(-10.0) == 0.0

    def test_none_fallback(self):
        assert _clamp_score(None) == 50.0

    def test_string_fallback(self):
        assert _clamp_score("abc") == 50.0

    def test_numeric_string_ok(self):
        assert _clamp_score("75") == 75.0

    def test_returns_float(self):
        assert isinstance(_clamp_score(50), float)


# ── TestShortLongResultFrozen ──────────────────────────────────────────────────

class TestShortLongResultFrozen:
    def _make(self) -> ShortLongResult:
        return ShortLongResult(
            short_term_score=60.0,
            long_term_score=55.0,
            short_term_factor_count=6,
            long_term_factor_count=6,
            short_term_missing_factors=(),
            long_term_missing_factors=(),
        )

    def test_frozen_short_term_score(self):
        r = self._make()
        with pytest.raises(Exception):
            r.short_term_score = 99.0  # type: ignore[misc]

    def test_frozen_long_term_score(self):
        r = self._make()
        with pytest.raises(Exception):
            r.long_term_score = 99.0  # type: ignore[misc]

    def test_frozen_missing_factors(self):
        r = self._make()
        with pytest.raises(Exception):
            r.short_term_missing_factors = ("fundamental",)  # type: ignore[misc]

    def test_types_are_correct(self):
        r = self._make()
        assert isinstance(r.short_term_score, float)
        assert isinstance(r.long_term_score, float)
        assert isinstance(r.short_term_factor_count, int)
        assert isinstance(r.long_term_factor_count, int)
        assert isinstance(r.short_term_missing_factors, tuple)
        assert isinstance(r.long_term_missing_factors, tuple)


# ── TestShortLongResultToDict ──────────────────────────────────────────────────

class TestShortLongResultToDict:
    def _result(self) -> ShortLongResult:
        return ShortLongResult(
            short_term_score=70.0,
            long_term_score=65.0,
            short_term_factor_count=5,
            long_term_factor_count=4,
            short_term_missing_factors=("sentiment",),
            long_term_missing_factors=("growth", "shareholder_return"),
        )

    def test_returns_dict(self):
        assert isinstance(self._result().to_dict(), dict)

    def test_all_keys_present(self):
        d = self._result().to_dict()
        expected_keys = {
            "short_term_score", "long_term_score",
            "short_term_factor_count", "long_term_factor_count",
            "short_term_missing_factors", "long_term_missing_factors",
        }
        assert set(d.keys()) == expected_keys

    def test_score_values_correct(self):
        d = self._result().to_dict()
        assert d["short_term_score"] == 70.0
        assert d["long_term_score"] == 65.0

    def test_count_values_correct(self):
        d = self._result().to_dict()
        assert d["short_term_factor_count"] == 5
        assert d["long_term_factor_count"] == 4

    def test_missing_factors_are_list(self):
        d = self._result().to_dict()
        assert isinstance(d["short_term_missing_factors"], list)
        assert isinstance(d["long_term_missing_factors"], list)

    def test_missing_factors_values(self):
        d = self._result().to_dict()
        assert d["short_term_missing_factors"] == ["sentiment"]
        assert d["long_term_missing_factors"] == ["growth", "shareholder_return"]

    def test_json_serializable_types(self):
        import json
        d = self._result().to_dict()
        json.dumps(d)  # raises if not serializable

    def test_no_judgment_fields(self):
        d = self._result().to_dict()
        for field in ("action", "recommendation", "is_buy", "is_sell",
                      "is_hold", "is_recommended", "rating"):
            assert field not in d, f"判断フィールド {field} が to_dict() に存在する"


# ── TestHorizonSplitterDefaultWeights ─────────────────────────────────────────

class TestHorizonSplitterDefaultWeights:
    def setup_method(self):
        self.splitter = HorizonSplitter()

    def test_all_short_factors_score_50(self):
        result = self.splitter.split(_all_both(50.0))
        assert abs(result.short_term_score - 50.0) < 1e-9

    def test_all_long_factors_score_50(self):
        result = self.splitter.split(_all_both(50.0))
        assert abs(result.long_term_score - 50.0) < 1e-9

    def test_all_factors_0(self):
        result = self.splitter.split(_all_both(0.0))
        assert result.short_term_score == 0.0
        assert result.long_term_score == 0.0

    def test_all_factors_100(self):
        result = self.splitter.split(_all_both(100.0))
        assert result.short_term_score == 100.0
        assert result.long_term_score == 100.0

    def test_returns_short_long_result(self):
        result = self.splitter.split(_all_both(50.0))
        assert isinstance(result, ShortLongResult)

    def test_short_term_factor_count_full(self):
        result = self.splitter.split(_all_both(50.0))
        assert result.short_term_factor_count == len(_SHORT_CANONICAL)

    def test_long_term_factor_count_full(self):
        result = self.splitter.split(_all_both(50.0))
        assert result.long_term_factor_count == len(_LONG_CANONICAL)

    def test_no_missing_factors_when_all_present(self):
        result = self.splitter.split(_all_both(50.0))
        assert result.short_term_missing_factors == ()
        assert result.long_term_missing_factors == ()

    def test_score_in_range(self):
        result = self.splitter.split(_all_both(75.0))
        assert 0.0 <= result.short_term_score <= 100.0
        assert 0.0 <= result.long_term_score <= 100.0


# ── TestHorizonSplitterWeightedAverage ────────────────────────────────────────

class TestHorizonSplitterWeightedAverage:
    """全因子揃い時の加重平均が正しいことを検証する。"""

    def setup_method(self):
        self.splitter = HorizonSplitter()

    def test_short_term_weighted_average(self):
        # technical_momentum=80, 他=50 のとき
        # expected = (0.40*80 + 0.20*50 + 0.15*50 + 0.10*50 + 0.10*50 + 0.05*50) / 1.0
        scores = _all_both(50.0)
        scores["technical_momentum"] = 80.0
        result = self.splitter.split(scores)
        w = _SHORT_WEIGHTS
        expected = (
            w["technical_momentum"]  * 80.0 +
            w["flow_microstructure"] * 50.0 +
            w["sentiment"]           * 50.0 +
            w["fundamental"]         * 50.0 +
            w["factor_cross"]        * 50.0 +
            w["regime"]              * 50.0
        )  # total weight = 1.0
        assert abs(result.short_term_score - expected) < 1e-9

    def test_long_term_weighted_average(self):
        # fundamental=90, 他=50 のとき
        scores = _all_both(50.0)
        scores["fundamental"] = 90.0
        result = self.splitter.split(scores)
        w = _LONG_WEIGHTS
        expected = (
            w["fundamental"]        * 90.0 +
            w["factor_cross"]       * 50.0 +
            w["quality_value"]      * 50.0 +
            w["growth"]             * 50.0 +
            w["shareholder_return"] * 50.0 +
            w["regime"]             * 50.0
        )
        assert abs(result.long_term_score - expected) < 1e-9


# ── TestHorizonSplitterMissingFactors ─────────────────────────────────────────

class TestHorizonSplitterMissingFactors:
    def setup_method(self):
        self.splitter = HorizonSplitter()

    def test_missing_one_short_factor(self):
        scores = _all_both(50.0)
        del scores["sentiment"]
        result = self.splitter.split(scores)
        assert "sentiment" in result.short_term_missing_factors
        assert result.short_term_factor_count == len(_SHORT_CANONICAL) - 1

    def test_missing_one_long_factor(self):
        scores = _all_both(50.0)
        del scores["quality_value"]
        result = self.splitter.split(scores)
        assert "quality_value" in result.long_term_missing_factors
        assert result.long_term_factor_count == len(_LONG_CANONICAL) - 1

    def test_missing_factors_canonical_order(self):
        # 複数欠損でも canonical 順になること
        scores = _all_both(50.0)
        del scores["flow_microstructure"]
        del scores["regime"]
        result = self.splitter.split(scores)
        # canonical 順: flow_microstructure が regime より前
        idx_flow = list(_SHORT_CANONICAL).index("flow_microstructure")
        idx_regime = list(_SHORT_CANONICAL).index("regime")
        missing = list(result.short_term_missing_factors)
        assert missing.index("flow_microstructure") < missing.index("regime")
        assert idx_flow < idx_regime  # sanity

    def test_present_weight_sum_normalization(self):
        # sentiment を除くと short_term の present_weight_sum < 1.0
        # 正規化されるのでスコアは欠損なし時と同じ（全因子 50 なら）
        scores = _all_both(50.0)
        del scores["sentiment"]
        result = self.splitter.split(scores)
        # 全残因子スコア = 50.0 → normalized score = 50.0
        assert abs(result.short_term_score - 50.0) < 1e-9

    def test_all_short_factors_missing(self):
        # short_term canonical 因子ゼロ → 50.0 fallback
        # 共有因子(fundamental/factor_cross/regime)は除いて long_term 専用因子のみ
        long_only = {f: 50.0 for f in ("quality_value", "growth", "shareholder_return")}
        result = self.splitter.split(long_only)
        assert result.short_term_score == 50.0
        assert result.short_term_factor_count == 0
        assert len(result.short_term_missing_factors) == len(_SHORT_CANONICAL)

    def test_all_long_factors_missing(self):
        # long_term canonical 因子ゼロ → 50.0 fallback
        # 共有因子(fundamental/factor_cross/regime)は除いて short_term 専用因子のみ
        short_only = {f: 50.0 for f in ("technical_momentum", "flow_microstructure", "sentiment")}
        result = self.splitter.split(short_only)
        assert result.long_term_score == 50.0
        assert result.long_term_factor_count == 0

    def test_empty_factor_scores(self):
        result = self.splitter.split({})
        assert result.short_term_score == 50.0
        assert result.long_term_score == 50.0
        assert result.short_term_factor_count == 0
        assert result.long_term_factor_count == 0


# ── TestHorizonSplitterClamp ───────────────────────────────────────────────────

class TestHorizonSplitterClamp:
    def setup_method(self):
        self.splitter = HorizonSplitter()

    def test_input_above_100_clamped(self):
        scores = _all_both(50.0)
        scores["technical_momentum"] = 200.0
        result = self.splitter.split(scores)
        assert result.short_term_score <= 100.0

    def test_input_below_0_clamped(self):
        scores = _all_both(50.0)
        scores["technical_momentum"] = -50.0
        result = self.splitter.split(scores)
        assert result.short_term_score >= 0.0

    def test_none_value_fallback_to_50(self):
        scores = _all_both(50.0)
        scores["technical_momentum"] = None  # type: ignore[assignment]
        result = self.splitter.split(scores)
        # None は 50.0 に fallback → 全因子 50 なのでスコアも 50
        assert abs(result.short_term_score - 50.0) < 1e-9

    def test_string_value_fallback_to_50(self):
        scores = _all_both(50.0)
        scores["fundamental"] = "invalid"  # type: ignore[assignment]
        result = self.splitter.split(scores)
        assert abs(result.short_term_score - 50.0) < 1e-9
        assert abs(result.long_term_score - 50.0) < 1e-9

    def test_output_always_in_range(self):
        # 極端な値でも出力が [0, 100]
        scores = {f: 999.0 for f in list(_SHORT_CANONICAL) + list(_LONG_CANONICAL)}
        result = self.splitter.split(scores)
        assert 0.0 <= result.short_term_score <= 100.0
        assert 0.0 <= result.long_term_score <= 100.0


# ── TestHorizonSplitterExtraFactors ───────────────────────────────────────────

class TestHorizonSplitterExtraFactors:
    def setup_method(self):
        self.splitter = HorizonSplitter()

    def test_extra_key_ignored(self):
        scores = _all_both(50.0)
        scores["nonexistent_factor"] = 99.0
        result = self.splitter.split(scores)
        assert abs(result.short_term_score - 50.0) < 1e-9
        assert abs(result.long_term_score - 50.0) < 1e-9

    def test_extra_key_not_in_factor_count(self):
        scores = _all_both(50.0)
        scores["fake_factor_1"] = 80.0
        scores["fake_factor_2"] = 80.0
        result = self.splitter.split(scores)
        assert result.short_term_factor_count == len(_SHORT_CANONICAL)
        assert result.long_term_factor_count == len(_LONG_CANONICAL)

    def test_extra_key_not_in_missing_factors(self):
        scores = _all_both(50.0)
        scores["phantom"] = 100.0
        result = self.splitter.split(scores)
        assert "phantom" not in result.short_term_missing_factors
        assert "phantom" not in result.long_term_missing_factors


# ── TestHorizonSplitterCustomWeights ──────────────────────────────────────────

class TestHorizonSplitterCustomWeights:
    def setup_method(self):
        self.splitter = HorizonSplitter()

    def test_custom_short_weights_used(self):
        # technical_momentum に全重みを集中させると、そのスコアがそのまま返る
        custom = {f: 0.0 for f in _SHORT_CANONICAL}
        custom["technical_momentum"] = 1.0
        scores = _all_both(50.0)
        scores["technical_momentum"] = 80.0
        result = self.splitter.split(scores, short_term_weights=custom)
        assert abs(result.short_term_score - 80.0) < 1e-9

    def test_custom_long_weights_used(self):
        custom = {f: 0.0 for f in _LONG_CANONICAL}
        custom["fundamental"] = 1.0
        scores = _all_both(50.0)
        scores["fundamental"] = 90.0
        result = self.splitter.split(scores, long_term_weights=custom)
        assert abs(result.long_term_score - 90.0) < 1e-9

    def test_custom_weights_missing_canonical_factor_no_keyerror(self):
        # canonical 因子を全く含まない custom weights でも KeyError にならない
        custom = {"unknown_factor": 1.0}
        scores = _all_both(50.0)
        # present_weight_sum == 0 → 等重み平均 fallback
        result = self.splitter.split(scores, short_term_weights=custom)
        assert isinstance(result, ShortLongResult)
        # 等重み平均 fallback: 全因子 50 なので 50.0
        assert abs(result.short_term_score - 50.0) < 1e-9

    def test_custom_weights_partial_canonical_no_keyerror(self):
        # canonical 因子の一部しかない custom weights
        custom = {"technical_momentum": 0.6, "sentiment": 0.4}
        scores = _all_both(50.0)
        scores["technical_momentum"] = 80.0
        scores["sentiment"] = 60.0
        result = self.splitter.split(scores, short_term_weights=custom)
        # present_weight_sum = 0.6 + 0.4 = 1.0
        expected = (0.6 * 80.0 + 0.4 * 60.0) / 1.0
        assert abs(result.short_term_score - expected) < 1e-9

    def test_none_short_uses_default(self):
        scores = _all_both(50.0)
        result_none = self.splitter.split(scores, short_term_weights=None)
        result_explicit = self.splitter.split(
            scores, short_term_weights=get_time_horizon_weights("short_term")
        )
        assert abs(result_none.short_term_score - result_explicit.short_term_score) < 1e-9

    def test_none_long_uses_default(self):
        scores = _all_both(50.0)
        result_none = self.splitter.split(scores, long_term_weights=None)
        result_explicit = self.splitter.split(
            scores, long_term_weights=get_time_horizon_weights("long_term")
        )
        assert abs(result_none.long_term_score - result_explicit.long_term_score) < 1e-9

    def test_custom_weights_present_weight_sum_zero_fallback(self):
        # 全ての custom weights = 0.0 → present_weight_sum = 0 → 等重み平均 fallback
        custom = {f: 0.0 for f in _SHORT_CANONICAL}
        scores = _all_both(50.0)
        result = self.splitter.split(scores, short_term_weights=custom)
        # 等重み平均 fallback: 全因子 50 → 50.0
        assert abs(result.short_term_score - 50.0) < 1e-9


# ── TestHorizonSplitterSharedFactors ──────────────────────────────────────────

class TestHorizonSplitterSharedFactors:
    """fundamental / factor_cross / regime は両 horizon に独立して寄与する。"""

    def setup_method(self):
        self.splitter = HorizonSplitter()

    def test_fundamental_contributes_to_both(self):
        scores = _all_both(50.0)
        scores["fundamental"] = 90.0
        result = self.splitter.split(scores)
        # fundamental が 90 なので、どちらも 50.0 より高くなるはず
        assert result.short_term_score > 50.0
        assert result.long_term_score > 50.0

    def test_factor_cross_contributes_to_both(self):
        scores = _all_both(50.0)
        scores["factor_cross"] = 10.0
        result = self.splitter.split(scores)
        assert result.short_term_score < 50.0
        assert result.long_term_score < 50.0

    def test_regime_contributes_to_both(self):
        scores = _all_both(50.0)
        scores["regime"] = 100.0
        result = self.splitter.split(scores)
        assert result.short_term_score > 50.0
        assert result.long_term_score > 50.0

    def test_short_only_factor_does_not_affect_long(self):
        # technical_momentum は short_term 専用
        scores = _all_both(50.0)
        scores["technical_momentum"] = 100.0
        result_base = self.splitter.split(_all_both(50.0))
        result_tm = self.splitter.split(scores)
        # short_term_score は上がるが long_term_score は変わらない
        assert result_tm.short_term_score > result_base.short_term_score
        assert abs(result_tm.long_term_score - result_base.long_term_score) < 1e-9

    def test_long_only_factor_does_not_affect_short(self):
        # quality_value は long_term 専用
        scores = _all_both(50.0)
        scores["quality_value"] = 100.0
        result_base = self.splitter.split(_all_both(50.0))
        result_qv = self.splitter.split(scores)
        assert result_qv.long_term_score > result_base.long_term_score
        assert abs(result_qv.short_term_score - result_base.short_term_score) < 1e-9

    def test_independent_score_objects(self):
        result1 = self.splitter.split(_all_both(50.0))
        result2 = self.splitter.split(_all_both(70.0))
        assert result1 is not result2
        assert result1.short_term_score != result2.short_term_score


# ── TestNoJudgmentFields ───────────────────────────────────────────────────────

class TestNoJudgmentFields:
    def test_no_calc_total_score_dynamic(self):
        import backend.engine.decision.short_long_split as mod
        assert not hasattr(mod, "calc_total_score_dynamic")

    def test_no_rating_labels(self):
        import backend.engine.decision.short_long_split as mod
        assert not hasattr(mod, "RATING_LABELS")

    def test_result_has_no_judgment_fields(self):
        splitter = HorizonSplitter()
        result = splitter.split(_all_both(50.0))
        for field in ("action", "recommendation", "is_buy", "is_sell",
                      "is_hold", "is_recommended", "rating"):
            assert not hasattr(result, field), f"{field} が ShortLongResult に存在する"

    def test_to_dict_has_no_judgment_fields(self):
        splitter = HorizonSplitter()
        d = splitter.split(_all_both(50.0)).to_dict()
        for field in ("action", "recommendation", "is_buy", "is_sell",
                      "is_hold", "is_recommended", "rating"):
            assert field not in d, f"{field} が to_dict() に存在する"


# ── TestForbiddenImports ───────────────────────────────────────────────────────

class TestForbiddenImports:
    def test_no_forbidden_imports(self):
        import backend.engine.decision.short_long_split as mod
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
