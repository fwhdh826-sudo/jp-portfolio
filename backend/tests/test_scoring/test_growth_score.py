"""
test_growth_score.py — Card 5-3 GrowthScorer テスト（70 tests）
"""
from __future__ import annotations

from dataclasses import FrozenInstanceError
from unittest.mock import MagicMock

import pytest

from backend.engine.scoring.growth_score import (
    MISSING_RAW_VALUES,
    AxisScore,
    GrowthScorer,
    ScoreComponent,
)

# ── フィクスチャ ──────────────────────────────────────────────────────────────

_FULL_DATA: dict = {
    "revenue_cagr_3y": 15.0,   # 15*5=75 (高評価)
    "eps_growth_3y":   20.0,   # 20*4=80 (高評価)
    "guidance":        65.0,   # passthrough=65 (標準〜高)
    "tam_expansion":   55.0,   # passthrough=55 (標準〜高)
}

_SCORER = GrowthScorer()


# ── TestScoreComponent ────────────────────────────────────────────────────────

class TestScoreComponent:
    def test_frozen(self):
        comp = ScoreComponent(
            name="revenue_cagr_3y", weight=0.40, raw_value=15.0,
            normalized=75.0, description="test",
        )
        with pytest.raises((FrozenInstanceError, TypeError)):
            comp.name = "eps_growth_3y"  # type: ignore[misc]

    def test_fields(self):
        comp = ScoreComponent(
            name="eps_growth_3y", weight=0.30, raw_value=12.5,
            normalized=50.0, description="desc",
        )
        assert comp.name == "eps_growth_3y"
        assert comp.weight == 0.30
        assert comp.raw_value == 12.5
        assert comp.normalized == 50.0
        assert comp.description == "desc"

    def test_name_type(self):
        comp = ScoreComponent(
            name="guidance", weight=0.20, raw_value=50.0,
            normalized=50.0, description="d",
        )
        assert isinstance(comp.name, str)

    def test_normalized_float(self):
        comp = ScoreComponent(
            name="tam_expansion", weight=0.10, raw_value=50.0,
            normalized=50.0, description="d",
        )
        assert isinstance(comp.normalized, float)

    def test_description_str(self):
        comp = ScoreComponent(
            name="revenue_cagr_3y", weight=0.40, raw_value=10.0,
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

    def test_axis_is_growth(self):
        ax = self._make()
        assert ax.axis == "growth"

    def test_name_ja(self):
        ax = self._make()
        assert ax.name_ja == "グロース"

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
        assert len(d["components"]) == 4


# ── TestGrowthScorerConstants ─────────────────────────────────────────────────

class TestGrowthScorerConstants:
    def test_weights_sum(self):
        total = sum(_SCORER.COMPONENT_WEIGHTS.values())
        assert abs(total - 1.0) < 1e-9

    def test_weights_count(self):
        assert len(_SCORER.COMPONENT_WEIGHTS) == 4

    def test_axis_id(self):
        assert GrowthScorer.AXIS_ID == "growth"

    def test_axis_name(self):
        assert GrowthScorer.AXIS_NAME == "グロース"


# ── TestNormalizeRevenueCagr ──────────────────────────────────────────────────

class TestNormalizeRevenueCagr:
    def test_cagr_zero(self):
        assert _SCORER._normalize("revenue_cagr_3y", 0.0) == 0.0

    def test_cagr_10_is_50(self):
        assert abs(_SCORER._normalize("revenue_cagr_3y", 10.0) - 50.0) < 1e-9

    def test_cagr_20_is_100(self):
        assert abs(_SCORER._normalize("revenue_cagr_3y", 20.0) - 100.0) < 1e-9

    def test_cagr_above_20_clamp(self):
        assert _SCORER._normalize("revenue_cagr_3y", 25.0) == 100.0

    def test_cagr_negative_clamp(self):
        assert _SCORER._normalize("revenue_cagr_3y", -5.0) == 0.0

    def test_cagr_5_is_25(self):
        assert abs(_SCORER._normalize("revenue_cagr_3y", 5.0) - 25.0) < 1e-9


# ── TestNormalizeEpsGrowth ────────────────────────────────────────────────────

class TestNormalizeEpsGrowth:
    def test_eps_zero(self):
        assert _SCORER._normalize("eps_growth_3y", 0.0) == 0.0

    def test_eps_125_is_50(self):
        assert abs(_SCORER._normalize("eps_growth_3y", 12.5) - 50.0) < 1e-9

    def test_eps_25_is_100(self):
        assert abs(_SCORER._normalize("eps_growth_3y", 25.0) - 100.0) < 1e-9

    def test_eps_above_25_clamp(self):
        assert _SCORER._normalize("eps_growth_3y", 30.0) == 100.0

    def test_eps_negative_clamp(self):
        assert _SCORER._normalize("eps_growth_3y", -5.0) == 0.0

    def test_eps_5_is_20(self):
        assert abs(_SCORER._normalize("eps_growth_3y", 5.0) - 20.0) < 1e-9


# ── TestNormalizeGuidance ─────────────────────────────────────────────────────

class TestNormalizeGuidance:
    def test_guidance_passthrough_50(self):
        assert abs(_SCORER._normalize("guidance", 50.0) - 50.0) < 1e-9

    def test_guidance_passthrough_0(self):
        assert _SCORER._normalize("guidance", 0.0) == 0.0

    def test_guidance_passthrough_100(self):
        assert abs(_SCORER._normalize("guidance", 100.0) - 100.0) < 1e-9

    def test_guidance_above_100_clamp(self):
        assert _SCORER._normalize("guidance", 120.0) == 100.0

    def test_guidance_negative_clamp(self):
        assert _SCORER._normalize("guidance", -10.0) == 0.0


# ── TestNormalizeTamExpansion ─────────────────────────────────────────────────

class TestNormalizeTamExpansion:
    def test_tam_passthrough_50(self):
        assert abs(_SCORER._normalize("tam_expansion", 50.0) - 50.0) < 1e-9

    def test_tam_passthrough_0(self):
        assert _SCORER._normalize("tam_expansion", 0.0) == 0.0

    def test_tam_passthrough_100(self):
        assert abs(_SCORER._normalize("tam_expansion", 100.0) - 100.0) < 1e-9

    def test_tam_above_100_clamp(self):
        assert _SCORER._normalize("tam_expansion", 110.0) == 100.0

    def test_tam_negative_clamp(self):
        assert _SCORER._normalize("tam_expansion", -5.0) == 0.0


# ── TestCalculateBasic ────────────────────────────────────────────────────────

class TestCalculateBasic:
    def test_returns_axis_score(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert isinstance(result, AxisScore)

    def test_axis_is_growth(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert result.axis == "growth"

    def test_total_range(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert 0.0 <= result.total <= 100.0

    def test_components_count(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert len(result.components) == 4

    def test_component_names(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        names = {c.name for c in result.components}
        assert names == {"revenue_cagr_3y", "eps_growth_3y", "guidance", "tam_expansion"}

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
        assert d["axis"] == "growth"
        assert d["name_ja"] == "グロース"
        assert isinstance(d["total"], int)
        assert len(d["components"]) == 4
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

    def test_zero_is_not_fallback_revenue(self):
        result = _SCORER.calculate("7203", {"revenue_cagr_3y": 0.0})
        rev = next(c for c in result.components if c.name == "revenue_cagr_3y")
        assert rev.raw_value == 0.0
        assert rev.normalized == 0.0

    def test_zero_is_not_fallback_guidance(self):
        result = _SCORER.calculate("7203", {"guidance": 0.0})
        g = next(c for c in result.components if c.name == "guidance")
        assert g.raw_value == 0.0
        assert g.normalized == 0.0

    def test_partial_missing(self):
        data = {"revenue_cagr_3y": 20.0, "eps_growth_3y": 25.0}
        result = _SCORER.calculate("7203", data)
        rev = next(c for c in result.components if c.name == "revenue_cagr_3y")
        eps = next(c for c in result.components if c.name == "eps_growth_3y")
        gui = next(c for c in result.components if c.name == "guidance")
        assert rev.raw_value == 20.0
        assert eps.raw_value == 25.0
        assert abs(gui.raw_value - MISSING_RAW_VALUES["guidance"]) < 1e-9

    def test_missing_raw_values_each_normalize_to_50(self):
        for comp_name, raw in MISSING_RAW_VALUES.items():
            normalized = _SCORER._normalize(comp_name, raw)
            assert abs(normalized - 50.0) < 1e-6, (
                f"{comp_name}: _normalize({raw}) = {normalized}, expected≈50.0"
            )

    def test_negative_eps_valid_not_fallback(self):
        result = _SCORER.calculate("7203", {"eps_growth_3y": -5.0})
        eps = next(c for c in result.components if c.name == "eps_growth_3y")
        assert eps.raw_value == -5.0
        assert eps.normalized == 0.0  # clamp で 0 に変換されるが fallback ではない


# ── TestCalculateDI ───────────────────────────────────────────────────────────

class TestCalculateDI:
    def test_normalizer_fn_called_four_times(self):
        mock_fn = MagicMock(return_value=60.0)
        _SCORER.calculate("7203", _FULL_DATA, normalizer_fn=mock_fn)
        assert mock_fn.call_count == 4

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
        assert _SCORER._get_raw("revenue_cagr_3y", {"revenue_cagr_3y": 15.0}) == 15.0

    def test_missing_key(self):
        raw = _SCORER._get_raw("eps_growth_3y", {})
        assert abs(raw - MISSING_RAW_VALUES["eps_growth_3y"]) < 1e-9

    def test_zero_value(self):
        assert _SCORER._get_raw("guidance", {"guidance": 0.0}) == 0.0

    def test_unknown_key_fallback(self):
        raw = _SCORER._get_raw("unknown_comp", {})
        assert raw == 50.0

    def test_negative_value_valid(self):
        assert _SCORER._get_raw("eps_growth_3y", {"eps_growth_3y": -5.0}) == -5.0


# ── TestEdgeCases ─────────────────────────────────────────────────────────────

class TestEdgeCases:
    def test_high_revenue_cagr_clamp(self):
        result = _SCORER.calculate("7203", {"revenue_cagr_3y": 100.0})
        rev = next(c for c in result.components if c.name == "revenue_cagr_3y")
        assert rev.normalized == 100.0

    def test_negative_eps_growth_clamp(self):
        result = _SCORER.calculate("7203", {"eps_growth_3y": -10.0})
        eps = next(c for c in result.components if c.name == "eps_growth_3y")
        assert eps.normalized == 0.0

    def test_all_max_values(self):
        data = {
            "revenue_cagr_3y": 100.0, "eps_growth_3y": 100.0,
            "guidance": 100.0, "tam_expansion": 100.0,
        }
        result = _SCORER.calculate("7203", data)
        assert abs(result.total - 100.0) < 1e-9

    def test_all_min_values(self):
        data = {
            "revenue_cagr_3y": 0.0, "eps_growth_3y": 0.0,
            "guidance": 0.0, "tam_expansion": 0.0,
        }
        result = _SCORER.calculate("7203", data)
        assert abs(result.total - 0.0) < 1e-9

    def test_extra_keys_ignored(self):
        data = {**_FULL_DATA, "unknown_key": 999.0, "order_backlog": 80.0}
        result = _SCORER.calculate("7203", data)
        assert len(result.components) == 4

    def test_order_backlog_not_a_component(self):
        result = _SCORER.calculate("7203", {"order_backlog": 80.0})
        names = {c.name for c in result.components}
        assert "order_backlog" not in names

    def test_description_format(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        for comp in result.components:
            assert "スコア" in comp.description

    def test_explanation_contains_growth_score(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert "グロース" in result.explanation

    def test_all_components_have_description(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        for comp in result.components:
            assert len(comp.description) > 0
