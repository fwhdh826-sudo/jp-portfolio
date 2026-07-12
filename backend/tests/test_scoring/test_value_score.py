"""
test_value_score.py — Card 5-1
ValueScorer のテストスイート。

テスト方針:
  - financial_data は dict fixture。実 DB / HTTP 呼び出しなし。
  - 全テストが公開 API 経由（_normalize / _get_raw は protected だが内部検証用に直接テスト）。
  - MISSING_RAW_VALUES で欠損時に normalized ≈ 50.0 を確認。
  - 0.0 は有効値として扱われること（fallback しない）を確認。
  - 禁止 import: requests / httpx / aiohttp / urllib.request / bs4
  - 禁止: pandas / numpy / backend.engine.regime / operation / market_intel / news
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from backend.engine.scoring.value_score import (
    MISSING_RAW_VALUES,
    AxisScore,
    ScoreComponent,
    ValueScorer,
)

# ── module-level fixtures ─────────────────────────────────────────────────────

_FULL_DATA: dict = {
    "per_score": 15.0,
    "pbr_score": 1.5,
    "peg_score": 1.2,
    "div_yield": 3.0,
    "ev_ebitda": 10.0,
}

_SCORER = ValueScorer()


# ═══════════════════════════════════════════════════════════════════
# TestScoreComponent
# ═══════════════════════════════════════════════════════════════════

class TestScoreComponent:
    def _make(self) -> ScoreComponent:
        return ScoreComponent(
            name="per_score",
            weight=0.30,
            raw_value=15.0,
            normalized=75.0,
            description="PER 15.00 — 割安水準（スコア75）",
        )

    def test_fields_exist(self):
        c = self._make()
        assert c.name == "per_score"
        assert c.weight == 0.30
        assert c.raw_value == 15.0
        assert c.normalized == 75.0
        assert isinstance(c.description, str)

    def test_frozen_immutable(self):
        c = self._make()
        with pytest.raises(Exception):
            c.name = "other"  # type: ignore[misc]

    def test_equality_same_values(self):
        assert self._make() == self._make()

    def test_inequality_different_values(self):
        a = self._make()
        b = ScoreComponent(
            name="pbr_score", weight=0.25,
            raw_value=2.0, normalized=70.0, description="x"
        )
        assert a != b

    def test_description_is_str(self):
        assert isinstance(self._make().description, str)


# ═══════════════════════════════════════════════════════════════════
# TestAxisScore
# ═══════════════════════════════════════════════════════════════════

class TestAxisScore:
    def _make(self) -> AxisScore:
        comps = tuple(
            ScoreComponent(name=n, weight=w, raw_value=20.0, normalized=50.0, description="x")
            for n, w in ValueScorer.COMPONENT_WEIGHTS.items()
        )
        return AxisScore(
            axis="value", name_ja="バリュー",
            total=50.0, components=comps, explanation="テスト"
        )

    def test_fields_exist(self):
        s = self._make()
        assert s.axis == "value"
        assert s.name_ja == "バリュー"
        assert isinstance(s.total, float)
        assert isinstance(s.components, tuple)
        assert isinstance(s.explanation, str)

    def test_frozen_immutable(self):
        s = self._make()
        with pytest.raises(Exception):
            s.total = 99.0  # type: ignore[misc]

    def test_total_in_range(self):
        assert 0.0 <= self._make().total <= 100.0

    def test_components_is_tuple(self):
        assert isinstance(self._make().components, tuple)

    def test_explanation_is_nonempty_str(self):
        s = self._make()
        assert isinstance(s.explanation, str)
        assert len(s.explanation) > 0

    def test_to_dict_has_required_keys(self):
        d = self._make().to_dict()
        for key in ("axis", "name_ja", "total", "components", "explanation"):
            assert key in d, f"to_dict() missing key: {key!r}"


# ═══════════════════════════════════════════════════════════════════
# TestValueScorerConstants
# ═══════════════════════════════════════════════════════════════════

class TestValueScorerConstants:
    def test_axis_id(self):
        assert ValueScorer.AXIS_ID == "value"

    def test_axis_name_ja(self):
        assert ValueScorer.AXIS_NAME == "バリュー"

    def test_component_weights_five_keys(self):
        assert len(ValueScorer.COMPONENT_WEIGHTS) == 5

    def test_component_weights_sum_one(self):
        total = sum(ValueScorer.COMPONENT_WEIGHTS.values())
        assert abs(total - 1.0) < 1e-9


# ═══════════════════════════════════════════════════════════════════
# TestNormalizePerScore
# ═══════════════════════════════════════════════════════════════════

class TestNormalizePerScore:
    def _n(self, raw: float) -> float:
        return _SCORER._normalize("per_score", raw)

    def test_per_10_gives_100(self):
        assert self._n(10.0) == pytest.approx(100.0)

    def test_per_20_gives_50(self):
        assert self._n(20.0) == pytest.approx(50.0)

    def test_per_30_gives_0(self):
        assert self._n(30.0) == pytest.approx(0.0)

    def test_per_0_clamped_to_100(self):
        # 100 - (0-10)*5 = 150 → clamp 100
        assert self._n(0.0) == pytest.approx(100.0)

    def test_per_40_clamped_to_0(self):
        # 100 - (40-10)*5 = -50 → clamp 0
        assert self._n(40.0) == pytest.approx(0.0)

    def test_per_25_gives_25(self):
        # 100 - (25-10)*5 = 25
        assert self._n(25.0) == pytest.approx(25.0)


# ═══════════════════════════════════════════════════════════════════
# TestNormalizePbrScore
# ═══════════════════════════════════════════════════════════════════

class TestNormalizePbrScore:
    def _n(self, raw: float) -> float:
        return _SCORER._normalize("pbr_score", raw)

    def test_pbr_1_gives_100(self):
        assert self._n(1.0) == pytest.approx(100.0)

    def test_pbr_2_gives_70(self):
        # 100 - (2-1)*30 = 70
        assert self._n(2.0) == pytest.approx(70.0)

    def test_pbr_3_gives_40(self):
        # 100 - (3-1)*30 = 40
        assert self._n(3.0) == pytest.approx(40.0)

    def test_pbr_0_clamped_to_100(self):
        # 100 - (0-1)*30 = 130 → clamp 100
        assert self._n(0.0) == pytest.approx(100.0)

    def test_pbr_5_clamped_to_0(self):
        # 100 - (5-1)*30 = -20 → clamp 0
        assert self._n(5.0) == pytest.approx(0.0)


# ═══════════════════════════════════════════════════════════════════
# TestNormalizePegScore
# ═══════════════════════════════════════════════════════════════════

class TestNormalizePegScore:
    def _n(self, raw: float) -> float:
        return _SCORER._normalize("peg_score", raw)

    def test_peg_1_gives_100(self):
        assert self._n(1.0) == pytest.approx(100.0)

    def test_peg_2_gives_50(self):
        # 100 - (2-1)*50 = 50
        assert self._n(2.0) == pytest.approx(50.0)

    def test_peg_3_clamped_to_0(self):
        # 100 - (3-1)*50 = 0
        assert self._n(3.0) == pytest.approx(0.0)

    def test_peg_0_clamped_to_100(self):
        # 100 - (0-1)*50 = 150 → clamp 100
        assert self._n(0.0) == pytest.approx(100.0)

    def test_peg_1_5_gives_75(self):
        # 100 - (1.5-1)*50 = 75
        assert self._n(1.5) == pytest.approx(75.0)


# ═══════════════════════════════════════════════════════════════════
# TestNormalizeDivYield
# ═══════════════════════════════════════════════════════════════════

class TestNormalizeDivYield:
    def _n(self, raw: float) -> float:
        return _SCORER._normalize("div_yield", raw)

    def test_div_4_gives_100(self):
        assert self._n(4.0) == pytest.approx(100.0)

    def test_div_2_gives_50(self):
        assert self._n(2.0) == pytest.approx(50.0)

    def test_div_0_gives_0(self):
        assert self._n(0.0) == pytest.approx(0.0)

    def test_div_5_clamped_to_100(self):
        # 5*25 = 125 → clamp 100
        assert self._n(5.0) == pytest.approx(100.0)

    def test_div_1_gives_25(self):
        assert self._n(1.0) == pytest.approx(25.0)


# ═══════════════════════════════════════════════════════════════════
# TestNormalizeEvEbitda
# ═══════════════════════════════════════════════════════════════════

class TestNormalizeEvEbitda:
    def _n(self, raw: float) -> float:
        return _SCORER._normalize("ev_ebitda", raw)

    def test_ev_8_gives_100(self):
        assert self._n(8.0) == pytest.approx(100.0)

    def test_ev_13_gives_50(self):
        # 100 - (13-8)*10 = 50
        assert self._n(13.0) == pytest.approx(50.0)

    def test_ev_18_gives_0(self):
        # 100 - (18-8)*10 = 0
        assert self._n(18.0) == pytest.approx(0.0)

    def test_ev_3_clamped_to_100(self):
        # 100 - (3-8)*10 = 150 → clamp 100
        assert self._n(3.0) == pytest.approx(100.0)

    def test_ev_28_clamped_to_0(self):
        # 100 - (28-8)*10 = -100 → clamp 0
        assert self._n(28.0) == pytest.approx(0.0)


# ═══════════════════════════════════════════════════════════════════
# TestCalculateBasic
# ═══════════════════════════════════════════════════════════════════

class TestCalculateBasic:
    def test_returns_axis_score(self):
        assert isinstance(_SCORER.calculate("7203", _FULL_DATA), AxisScore)

    def test_axis_value(self):
        assert _SCORER.calculate("7203", _FULL_DATA).axis == "value"

    def test_name_ja(self):
        assert _SCORER.calculate("7203", _FULL_DATA).name_ja == "バリュー"

    def test_components_count_five(self):
        assert len(_SCORER.calculate("7203", _FULL_DATA).components) == 5

    def test_total_weighted_average(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        expected = sum(c.normalized * c.weight for c in result.components)
        assert result.total == pytest.approx(expected, rel=1e-9)

    def test_total_in_0_100(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert 0.0 <= result.total <= 100.0

    def test_explanation_nonempty(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert isinstance(result.explanation, str)
        assert len(result.explanation) > 0

    def test_to_dict_total_is_int(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        d = result.to_dict()
        assert isinstance(d["total"], int)
        assert d["total"] == round(result.total)


# ═══════════════════════════════════════════════════════════════════
# TestCalculateMissingData
# ═══════════════════════════════════════════════════════════════════

class TestCalculateMissingData:
    def test_empty_dict_returns_valid(self):
        assert isinstance(_SCORER.calculate("7203", {}), AxisScore)

    def test_empty_dict_all_normalized_50(self):
        result = _SCORER.calculate("7203", {})
        for comp in result.components:
            assert comp.normalized == pytest.approx(50.0, abs=1e-6), \
                f"{comp.name}: normalized={comp.normalized}, expected≈50.0"

    def test_empty_dict_total_50(self):
        result = _SCORER.calculate("7203", {})
        assert result.total == pytest.approx(50.0, abs=1e-6)

    def test_missing_comp_raw_is_missing_raw_value(self):
        result = _SCORER.calculate("7203", {})
        for comp in result.components:
            expected = MISSING_RAW_VALUES[comp.name]
            assert comp.raw_value == pytest.approx(expected), \
                f"{comp.name}: raw_value={comp.raw_value}, expected={expected}"

    def test_zero_is_not_fallback(self):
        result = _SCORER.calculate("7203", {"per_score": 0.0})
        per_comp = next(c for c in result.components if c.name == "per_score")
        assert per_comp.raw_value == pytest.approx(0.0)
        # PER=0 → 100-(0-10)*5=150 → clamp 100（fallback の 50 ではない）
        assert per_comp.normalized == pytest.approx(100.0)

    def test_extra_keys_ignored(self):
        data = {**_FULL_DATA, "roe": 20.0, "roa": 10.0}
        result = _SCORER.calculate("7203", data)
        assert len(result.components) == 5

    def test_one_key_missing_uses_missing_raw(self):
        data = {k: v for k, v in _FULL_DATA.items() if k != "per_score"}
        result = _SCORER.calculate("7203", data)
        per_comp = next(c for c in result.components if c.name == "per_score")
        assert per_comp.raw_value == pytest.approx(MISSING_RAW_VALUES["per_score"])
        assert per_comp.normalized == pytest.approx(50.0, abs=1e-6)


# ═══════════════════════════════════════════════════════════════════
# TestCalculateDI
# ═══════════════════════════════════════════════════════════════════

class TestCalculateDI:
    def test_normalizer_fn_none_uses_default(self):
        result = _SCORER.calculate("7203", {"per_score": 20.0}, normalizer_fn=None)
        per_comp = next(c for c in result.components if c.name == "per_score")
        assert per_comp.normalized == pytest.approx(50.0)

    def test_normalizer_fn_override_constant(self):
        result = _SCORER.calculate("7203", _FULL_DATA, normalizer_fn=lambda c, v: 75.0)
        assert result.total == pytest.approx(75.0)

    def test_normalizer_fn_called_five_times(self):
        mock_fn = MagicMock(return_value=60.0)
        _SCORER.calculate("7203", _FULL_DATA, normalizer_fn=mock_fn)
        assert mock_fn.call_count == 5

    def test_normalizer_fn_receives_comp_name_and_raw(self):
        calls: list[tuple] = []

        def capture(comp_name: str, raw: float) -> float:
            calls.append((comp_name, raw))
            return 50.0

        _SCORER.calculate("7203", {"per_score": 15.0}, normalizer_fn=capture)
        comp_names = [c[0] for c in calls]
        assert "per_score" in comp_names
        per_call = next(c for c in calls if c[0] == "per_score")
        assert per_call[1] == pytest.approx(15.0)


# ═══════════════════════════════════════════════════════════════════
# TestGetRaw
# ═══════════════════════════════════════════════════════════════════

class TestGetRaw:
    def test_existing_key_returned(self):
        assert _SCORER._get_raw("per_score", {"per_score": 15.0}) == pytest.approx(15.0)

    def test_missing_key_returns_missing_raw(self):
        raw = _SCORER._get_raw("per_score", {})
        assert raw == pytest.approx(MISSING_RAW_VALUES["per_score"])

    def test_zero_value_not_fallback(self):
        assert _SCORER._get_raw("per_score", {"per_score": 0.0}) == pytest.approx(0.0)

    def test_negative_value_returned(self):
        # clamp は _normalize で行う。_get_raw は生値をそのまま返す。
        assert _SCORER._get_raw("per_score", {"per_score": -5.0}) == pytest.approx(-5.0)


# ═══════════════════════════════════════════════════════════════════
# TestEdgeCases
# ═══════════════════════════════════════════════════════════════════

class TestEdgeCases:
    def test_all_perfect_gives_100(self):
        # 各成分の正規化が 100 になる raw 値
        perfect = {
            "per_score": 10.0,  # 100-(10-10)*5 = 100
            "pbr_score":  1.0,  # 100-(1-1)*30  = 100
            "peg_score":  1.0,  # 100-(1-1)*50  = 100
            "div_yield":  4.0,  # 4*25          = 100
            "ev_ebitda":  8.0,  # 100-(8-8)*10  = 100
        }
        assert _SCORER.calculate("0000", perfect).total == pytest.approx(100.0)

    def test_all_worst_gives_0(self):
        # 各成分の正規化が 0 になる raw 値（clamp 下限）
        worst = {
            "per_score": 50.0,  # 100-(50-10)*5  = -100 → 0
            "pbr_score": 10.0,  # 100-(10-1)*30  = -170 → 0
            "peg_score":  5.0,  # 100-(5-1)*50   = -100 → 0
            "div_yield":  0.0,  # 0*25           = 0
            "ev_ebitda": 30.0,  # 100-(30-8)*10  = -120 → 0
        }
        assert _SCORER.calculate("0000", worst).total == pytest.approx(0.0)

    def test_ticker_ignored(self):
        r1 = _SCORER.calculate("7203", _FULL_DATA)
        r2 = _SCORER.calculate("9984", _FULL_DATA)
        assert r1.total == pytest.approx(r2.total)

    def test_to_dict_total_is_rounded_int(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        d = result.to_dict()
        assert d["total"] == round(result.total)
        assert isinstance(d["total"], int)

    def test_missing_raw_values_each_normalize_to_50(self):
        # MISSING_RAW_VALUES の各値が正規化後 ≈ 50.0 であることを直接確認
        for comp_name, raw in MISSING_RAW_VALUES.items():
            normalized = _SCORER._normalize(comp_name, raw)
            assert normalized == pytest.approx(50.0, abs=1e-6), \
                f"{comp_name}: _normalize({raw}) = {normalized}, expected ≈ 50.0"

    def test_components_order_matches_weights_definition(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        weight_keys = list(ValueScorer.COMPONENT_WEIGHTS.keys())
        comp_names  = [c.name for c in result.components]
        assert comp_names == weight_keys
