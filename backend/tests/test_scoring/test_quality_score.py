"""
test_quality_score.py — Card 5-2 QualityScorer テスト（70 tests）
"""
from __future__ import annotations

from dataclasses import FrozenInstanceError
from unittest.mock import MagicMock

import pytest

from backend.engine.scoring.quality_score import (
    MISSING_RAW_VALUES,
    AxisScore,
    QualityScorer,
    ScoreComponent,
)

# ── フィクスチャ ──────────────────────────────────────────────────────────────

_FULL_DATA: dict = {
    "roe_3y_avg":    15.0,   # 15*5=75 (高評価)
    "roa":            8.0,   # 8*10=80 (高評価)
    "fcf_yield":      4.0,   # 4*15=60 (標準〜高)
    "moat_score":    70.0,   # passthrough=70 (高評価)
    "earnings_stab": 60.0,   # passthrough=60 (標準〜高)
}

_SCORER = QualityScorer()


# ── TestScoreComponent ────────────────────────────────────────────────────────

class TestScoreComponent:
    def test_frozen(self):
        comp = ScoreComponent(
            name="roe_3y_avg", weight=0.30, raw_value=15.0,
            normalized=75.0, description="test",
        )
        with pytest.raises((FrozenInstanceError, TypeError)):
            comp.name = "roa"  # type: ignore[misc]

    def test_fields(self):
        comp = ScoreComponent(
            name="roa", weight=0.20, raw_value=5.0,
            normalized=50.0, description="desc",
        )
        assert comp.name == "roa"
        assert comp.weight == 0.20
        assert comp.raw_value == 5.0
        assert comp.normalized == 50.0
        assert comp.description == "desc"

    def test_name_type(self):
        comp = ScoreComponent(
            name="fcf_yield", weight=0.20, raw_value=3.0,
            normalized=45.0, description="d",
        )
        assert isinstance(comp.name, str)

    def test_normalized_float(self):
        comp = ScoreComponent(
            name="moat_score", weight=0.20, raw_value=50.0,
            normalized=50.0, description="d",
        )
        assert isinstance(comp.normalized, float)

    def test_description_str(self):
        comp = ScoreComponent(
            name="earnings_stab", weight=0.10, raw_value=50.0,
            normalized=50.0, description="テスト説明",
        )
        assert isinstance(comp.description, str)


# ── TestAxisScore ─────────────────────────────────────────────────────────────

class TestAxisScore:
    def _make(self) -> AxisScore:
        return _SCORER.calculate("7203", _FULL_DATA)

    def test_frozen(self):
        ax = self._make()
        with pytest.raises((FrozenInstanceError, TypeError)):
            ax.axis = "other"  # type: ignore[misc]

    def test_axis_is_quality(self):
        ax = self._make()
        assert ax.axis == "quality"

    def test_name_ja(self):
        ax = self._make()
        assert ax.name_ja == "クオリティ"

    def test_to_dict_keys(self):
        d = self._make().to_dict()
        assert set(d.keys()) == {"axis", "name_ja", "total", "components", "explanation"}

    def test_to_dict_total_rounded(self):
        ax = self._make()
        d = ax.to_dict()
        assert d["total"] == round(ax.total)
        assert isinstance(d["total"], int)

    def test_to_dict_components_list(self):
        d = self._make().to_dict()
        assert isinstance(d["components"], list)
        assert len(d["components"]) == 5


# ── TestQualityScorerConstants ────────────────────────────────────────────────

class TestQualityScorerConstants:
    def test_weights_sum(self):
        total = sum(_SCORER.COMPONENT_WEIGHTS.values())
        assert abs(total - 1.0) < 1e-9

    def test_weights_count(self):
        assert len(_SCORER.COMPONENT_WEIGHTS) == 5

    def test_axis_id(self):
        assert QualityScorer.AXIS_ID == "quality"

    def test_axis_name(self):
        assert QualityScorer.AXIS_NAME == "クオリティ"


# ── TestNormalizeRoe ──────────────────────────────────────────────────────────

class TestNormalizeRoe:
    def test_roe_zero(self):
        assert _SCORER._normalize("roe_3y_avg", 0.0) == 0.0

    def test_roe_10_is_50(self):
        assert abs(_SCORER._normalize("roe_3y_avg", 10.0) - 50.0) < 1e-9

    def test_roe_20_is_100(self):
        assert abs(_SCORER._normalize("roe_3y_avg", 20.0) - 100.0) < 1e-9

    def test_roe_above_20_clamp(self):
        assert _SCORER._normalize("roe_3y_avg", 25.0) == 100.0

    def test_roe_negative_clamp(self):
        assert _SCORER._normalize("roe_3y_avg", -5.0) == 0.0

    def test_roe_5_is_25(self):
        assert abs(_SCORER._normalize("roe_3y_avg", 5.0) - 25.0) < 1e-9


# ── TestNormalizeRoa ──────────────────────────────────────────────────────────

class TestNormalizeRoa:
    def test_roa_zero(self):
        assert _SCORER._normalize("roa", 0.0) == 0.0

    def test_roa_5_is_50(self):
        assert abs(_SCORER._normalize("roa", 5.0) - 50.0) < 1e-9

    def test_roa_10_is_100(self):
        assert abs(_SCORER._normalize("roa", 10.0) - 100.0) < 1e-9

    def test_roa_above_10_clamp(self):
        assert _SCORER._normalize("roa", 15.0) == 100.0

    def test_roa_negative_clamp(self):
        assert _SCORER._normalize("roa", -1.0) == 0.0


# ── TestNormalizeFcfYield ─────────────────────────────────────────────────────

class TestNormalizeFcfYield:
    def test_fcf_zero(self):
        assert _SCORER._normalize("fcf_yield", 0.0) == 0.0

    def test_fcf_333_is_50(self):
        raw = 50.0 / 15.0
        assert abs(_SCORER._normalize("fcf_yield", raw) - 50.0) < 1e-6

    def test_fcf_667_is_100(self):
        raw = 100.0 / 15.0
        assert abs(_SCORER._normalize("fcf_yield", raw) - 100.0) < 1e-6

    def test_fcf_above_clamp(self):
        assert _SCORER._normalize("fcf_yield", 10.0) == 100.0

    def test_fcf_negative_clamp(self):
        assert _SCORER._normalize("fcf_yield", -1.0) == 0.0


# ── TestNormalizeMoatScore ────────────────────────────────────────────────────

class TestNormalizeMoatScore:
    def test_moat_passthrough_50(self):
        assert abs(_SCORER._normalize("moat_score", 50.0) - 50.0) < 1e-9

    def test_moat_passthrough_0(self):
        assert _SCORER._normalize("moat_score", 0.0) == 0.0

    def test_moat_passthrough_100(self):
        assert abs(_SCORER._normalize("moat_score", 100.0) - 100.0) < 1e-9

    def test_moat_above_100_clamp(self):
        assert _SCORER._normalize("moat_score", 120.0) == 100.0

    def test_moat_negative_clamp(self):
        assert _SCORER._normalize("moat_score", -10.0) == 0.0


# ── TestNormalizeEarningsStab ─────────────────────────────────────────────────

class TestNormalizeEarningsStab:
    def test_earn_passthrough_50(self):
        assert abs(_SCORER._normalize("earnings_stab", 50.0) - 50.0) < 1e-9

    def test_earn_passthrough_0(self):
        assert _SCORER._normalize("earnings_stab", 0.0) == 0.0

    def test_earn_passthrough_100(self):
        assert abs(_SCORER._normalize("earnings_stab", 100.0) - 100.0) < 1e-9

    def test_earn_above_clamp(self):
        assert _SCORER._normalize("earnings_stab", 110.0) == 100.0

    def test_earn_negative_clamp(self):
        assert _SCORER._normalize("earnings_stab", -5.0) == 0.0


# ── TestCalculateBasic ────────────────────────────────────────────────────────

class TestCalculateBasic:
    def test_returns_axis_score(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert isinstance(result, AxisScore)

    def test_axis_is_quality(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert result.axis == "quality"

    def test_total_range(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert 0.0 <= result.total <= 100.0

    def test_components_count(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert len(result.components) == 5

    def test_component_names(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        names = {c.name for c in result.components}
        assert names == {"roe_3y_avg", "roa", "fcf_yield", "moat_score", "earnings_stab"}

    def test_weights_in_components(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        for comp in result.components:
            assert comp.weight == _SCORER.COMPONENT_WEIGHTS[comp.name]

    def test_total_is_weighted_sum(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        expected = sum(c.normalized * c.weight for c in result.components)
        assert abs(result.total - expected) < 1e-9

    def test_to_dict_output(self):
        d = _SCORER.calculate("7203", _FULL_DATA).to_dict()
        assert d["axis"] == "quality"
        assert d["name_ja"] == "クオリティ"
        assert isinstance(d["total"], int)
        assert len(d["components"]) == 5
        assert isinstance(d["explanation"], str)


# ── TestCalculateMissingData ──────────────────────────────────────────────────

class TestCalculateMissingData:
    def test_empty_dict_all_normalized_50(self):
        result = _SCORER.calculate("7203", {})
        for comp in result.components:
            assert abs(comp.normalized - 50.0) < 1e-6, (
                f"{comp.name}: normalized={comp.normalized}, expected≈50.0"
            )

    def test_empty_dict_total_50(self):
        result = _SCORER.calculate("7203", {})
        assert abs(result.total - 50.0) < 1e-6

    def test_missing_comp_raw_is_missing_raw_value(self):
        result = _SCORER.calculate("7203", {})
        for comp in result.components:
            assert abs(comp.raw_value - MISSING_RAW_VALUES[comp.name]) < 1e-9, (
                f"{comp.name}: raw={comp.raw_value}, expected={MISSING_RAW_VALUES[comp.name]}"
            )

    def test_zero_is_not_fallback_roe(self):
        result = _SCORER.calculate("7203", {"roe_3y_avg": 0.0})
        roe = next(c for c in result.components if c.name == "roe_3y_avg")
        assert roe.raw_value == 0.0
        assert roe.normalized == 0.0

    def test_zero_is_not_fallback_moat(self):
        result = _SCORER.calculate("7203", {"moat_score": 0.0})
        moat = next(c for c in result.components if c.name == "moat_score")
        assert moat.raw_value == 0.0
        assert moat.normalized == 0.0

    def test_partial_missing(self):
        data = {"roe_3y_avg": 20.0, "roa": 10.0}
        result = _SCORER.calculate("7203", data)
        roe = next(c for c in result.components if c.name == "roe_3y_avg")
        roa = next(c for c in result.components if c.name == "roa")
        fcf = next(c for c in result.components if c.name == "fcf_yield")
        assert roe.raw_value == 20.0
        assert roa.raw_value == 10.0
        assert abs(fcf.raw_value - MISSING_RAW_VALUES["fcf_yield"]) < 1e-9

    def test_missing_raw_values_each_normalize_to_50(self):
        for comp_name, raw in MISSING_RAW_VALUES.items():
            normalized = _SCORER._normalize(comp_name, raw)
            assert abs(normalized - 50.0) < 1e-6, (
                f"{comp_name}: _normalize({raw}) = {normalized}, expected≈50.0"
            )


# ── TestCalculateDI ───────────────────────────────────────────────────────────

class TestCalculateDI:
    def test_normalizer_fn_called_five_times(self):
        mock_fn = MagicMock(return_value=60.0)
        _SCORER.calculate("7203", _FULL_DATA, normalizer_fn=mock_fn)
        assert mock_fn.call_count == 5

    def test_normalizer_fn_overrides_default(self):
        result = _SCORER.calculate("7203", _FULL_DATA, normalizer_fn=lambda _n, _r: 80.0)
        assert abs(result.total - 80.0) < 1e-9

    def test_ticker_ignored(self):
        r1 = _SCORER.calculate("7203", _FULL_DATA)
        r2 = _SCORER.calculate("9999", _FULL_DATA)
        assert abs(r1.total - r2.total) < 1e-9

    def test_normalizer_fn_none_uses_default(self):
        r_none    = _SCORER.calculate("7203", _FULL_DATA, normalizer_fn=None)
        r_default = _SCORER.calculate("7203", _FULL_DATA)
        assert abs(r_none.total - r_default.total) < 1e-9


# ── TestGetRaw ────────────────────────────────────────────────────────────────

class TestGetRaw:
    def test_present_key(self):
        assert _SCORER._get_raw("roe_3y_avg", {"roe_3y_avg": 15.0}) == 15.0

    def test_missing_key(self):
        raw = _SCORER._get_raw("roa", {})
        assert abs(raw - MISSING_RAW_VALUES["roa"]) < 1e-9

    def test_zero_value(self):
        assert _SCORER._get_raw("moat_score", {"moat_score": 0.0}) == 0.0

    def test_unknown_key_fallback(self):
        raw = _SCORER._get_raw("unknown_comp", {})
        assert raw == 50.0


# ── TestEdgeCases ─────────────────────────────────────────────────────────────

class TestEdgeCases:
    def test_high_roe_clamp(self):
        result = _SCORER.calculate("7203", {"roe_3y_avg": 100.0})
        roe = next(c for c in result.components if c.name == "roe_3y_avg")
        assert roe.normalized == 100.0

    def test_negative_roa_clamp(self):
        result = _SCORER.calculate("7203", {"roa": -5.0})
        roa = next(c for c in result.components if c.name == "roa")
        assert roa.normalized == 0.0

    def test_all_max_values(self):
        data = {
            "roe_3y_avg": 100.0, "roa": 100.0, "fcf_yield": 100.0,
            "moat_score": 100.0, "earnings_stab": 100.0,
        }
        result = _SCORER.calculate("7203", data)
        assert abs(result.total - 100.0) < 1e-9

    def test_all_min_values(self):
        data = {
            "roe_3y_avg": 0.0, "roa": 0.0, "fcf_yield": 0.0,
            "moat_score": 0.0, "earnings_stab": 0.0,
        }
        result = _SCORER.calculate("7203", data)
        assert abs(result.total - 0.0) < 1e-9

    def test_extra_keys_ignored(self):
        data = {**_FULL_DATA, "unknown_key": 999.0, "per_score": 15.0}
        result = _SCORER.calculate("7203", data)
        assert len(result.components) == 5

    def test_description_format(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        for comp in result.components:
            assert "スコア" in comp.description
            assert comp.name in comp.description or any(
                label in comp.description
                for label in ("ROE", "ROA", "FCF", "競争", "利益")
            )
