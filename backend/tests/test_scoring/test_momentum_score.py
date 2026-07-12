"""
test_momentum_score.py — Card 5-5 MomentumScorer テスト（70 tests）

全成分 passthrough clamp(x, 0, 100)。
呼び出し側が 0〜100 に変換済みのスコアを渡す前提。
technical_suite / technical モジュールは import しない。
"""
from __future__ import annotations

import inspect
from dataclasses import FrozenInstanceError
from unittest.mock import MagicMock

import pytest

from backend.engine.scoring.momentum_score import (
    MISSING_RAW_VALUES,
    AxisScore,
    MomentumScorer,
    ScoreComponent,
)

# ── フィクスチャ ──────────────────────────────────────────────────────────────

_FULL_DATA: dict = {
    "trend_score":       75.0,   # passthrough=75 (高評価)
    "ma_spread":         65.0,   # passthrough=65 (標準〜高)
    "credit_ratio":      55.0,   # passthrough=55 (標準〜高)
    "volume_z":          70.0,   # passthrough=70 (標準〜高)
    "relative_strength": 60.0,   # passthrough=60 (標準〜高)
}

_SCORER = MomentumScorer()


# ── TestScoreComponent ────────────────────────────────────────────────────────

class TestScoreComponent:
    def test_frozen(self):
        comp = ScoreComponent(
            name="trend_score", weight=0.30, raw_value=75.0,
            normalized=75.0, description="test",
        )
        with pytest.raises((FrozenInstanceError, TypeError)):
            comp.name = "ma_spread"  # type: ignore[misc]

    def test_fields(self):
        comp = ScoreComponent(
            name="ma_spread", weight=0.25, raw_value=50.0,
            normalized=50.0, description="desc",
        )
        assert comp.name == "ma_spread"
        assert comp.weight == 0.25
        assert comp.raw_value == 50.0
        assert comp.normalized == 50.0
        assert comp.description == "desc"

    def test_name_type(self):
        comp = ScoreComponent(
            name="credit_ratio", weight=0.20, raw_value=50.0,
            normalized=50.0, description="d",
        )
        assert isinstance(comp.name, str)

    def test_normalized_float(self):
        comp = ScoreComponent(
            name="volume_z", weight=0.15, raw_value=50.0,
            normalized=50.0, description="d",
        )
        assert isinstance(comp.normalized, float)

    def test_description_str(self):
        comp = ScoreComponent(
            name="relative_strength", weight=0.10, raw_value=50.0,
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

    def test_axis_is_momentum(self):
        ax = self._make()
        assert ax.axis == "momentum"

    def test_name_ja(self):
        ax = self._make()
        assert ax.name_ja == "モメンタム"

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


# ── TestMomentumScorerConstants ───────────────────────────────────────────────

class TestMomentumScorerConstants:
    def test_weights_sum(self):
        total = sum(_SCORER.COMPONENT_WEIGHTS.values())
        assert abs(total - 1.0) < 1e-9

    def test_weights_count(self):
        assert len(_SCORER.COMPONENT_WEIGHTS) == 5

    def test_axis_id(self):
        assert MomentumScorer.AXIS_ID == "momentum"

    def test_axis_name(self):
        assert MomentumScorer.AXIS_NAME == "モメンタム"


# ── TestNormalizeTrendScore ───────────────────────────────────────────────────

class TestNormalizeTrendScore:
    def test_zero_is_0(self):
        assert _SCORER._normalize("trend_score", 0.0) == 0.0

    def test_50_is_50(self):
        assert abs(_SCORER._normalize("trend_score", 50.0) - 50.0) < 1e-9

    def test_100_is_100(self):
        assert abs(_SCORER._normalize("trend_score", 100.0) - 100.0) < 1e-9

    def test_above_clamp(self):
        assert _SCORER._normalize("trend_score", 150.0) == 100.0

    def test_negative_clamp(self):
        assert _SCORER._normalize("trend_score", -10.0) == 0.0


# ── TestNormalizeMaSpread ─────────────────────────────────────────────────────

class TestNormalizeMaSpread:
    def test_zero_is_0(self):
        assert _SCORER._normalize("ma_spread", 0.0) == 0.0

    def test_50_is_50(self):
        assert abs(_SCORER._normalize("ma_spread", 50.0) - 50.0) < 1e-9

    def test_100_is_100(self):
        assert abs(_SCORER._normalize("ma_spread", 100.0) - 100.0) < 1e-9

    def test_above_clamp(self):
        assert _SCORER._normalize("ma_spread", 200.0) == 100.0

    def test_negative_clamp(self):
        assert _SCORER._normalize("ma_spread", -5.0) == 0.0


# ── TestNormalizeCreditRatio ──────────────────────────────────────────────────

class TestNormalizeCreditRatio:
    def test_zero_is_0(self):
        assert _SCORER._normalize("credit_ratio", 0.0) == 0.0

    def test_50_is_50(self):
        assert abs(_SCORER._normalize("credit_ratio", 50.0) - 50.0) < 1e-9

    def test_100_is_100(self):
        assert abs(_SCORER._normalize("credit_ratio", 100.0) - 100.0) < 1e-9

    def test_above_clamp(self):
        assert _SCORER._normalize("credit_ratio", 120.0) == 100.0

    def test_negative_clamp(self):
        assert _SCORER._normalize("credit_ratio", -1.0) == 0.0


# ── TestNormalizeVolumeZ ──────────────────────────────────────────────────────

class TestNormalizeVolumeZ:
    def test_zero_is_0(self):
        assert _SCORER._normalize("volume_z", 0.0) == 0.0

    def test_50_is_50(self):
        assert abs(_SCORER._normalize("volume_z", 50.0) - 50.0) < 1e-9

    def test_100_is_100(self):
        assert abs(_SCORER._normalize("volume_z", 100.0) - 100.0) < 1e-9

    def test_above_clamp(self):
        assert _SCORER._normalize("volume_z", 110.0) == 100.0

    def test_negative_clamp(self):
        assert _SCORER._normalize("volume_z", -3.0) == 0.0


# ── TestNormalizeRelativeStrength ─────────────────────────────────────────────

class TestNormalizeRelativeStrength:
    def test_zero_is_0(self):
        assert _SCORER._normalize("relative_strength", 0.0) == 0.0

    def test_50_is_50(self):
        assert abs(_SCORER._normalize("relative_strength", 50.0) - 50.0) < 1e-9

    def test_100_is_100(self):
        assert abs(_SCORER._normalize("relative_strength", 100.0) - 100.0) < 1e-9

    def test_above_clamp(self):
        assert _SCORER._normalize("relative_strength", 130.0) == 100.0

    def test_negative_clamp(self):
        assert _SCORER._normalize("relative_strength", -20.0) == 0.0


# ── TestCalculateBasic ────────────────────────────────────────────────────────

class TestCalculateBasic:
    def test_returns_axis_score(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert isinstance(result, AxisScore)

    def test_axis_is_momentum(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert result.axis == "momentum"

    def test_total_range(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert 0.0 <= result.total <= 100.0

    def test_components_count(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert len(result.components) == 5

    def test_component_names(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        names = {c.name for c in result.components}
        assert names == {
            "trend_score", "ma_spread", "credit_ratio",
            "volume_z", "relative_strength",
        }

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
        assert d["axis"] == "momentum"
        assert d["name_ja"] == "モメンタム"
        assert isinstance(d["total"], int)
        assert len(d["components"]) == 5
        assert isinstance(d["explanation"], str)


# ── TestCalculateMissingData ──────────────────────────────────────────────────

class TestCalculateMissingData:
    def test_empty_dict_all_normalized_50(self):
        result = _SCORER.calculate("7203", {})
        for comp in result.components:
            assert abs(comp.normalized - 50.0) < 1e-9, (
                f"{comp.name}: normalized={comp.normalized}, expected=50.0"
            )

    def test_empty_dict_total_50(self):
        result = _SCORER.calculate("7203", {})
        assert abs(result.total - 50.0) < 1e-9

    def test_missing_comp_raw_is_missing_raw_value(self):
        result = _SCORER.calculate("7203", {})
        for comp in result.components:
            assert abs(comp.raw_value - MISSING_RAW_VALUES[comp.name]) < 1e-9, (
                f"{comp.name}: raw={comp.raw_value}, expected={MISSING_RAW_VALUES[comp.name]}"
            )

    def test_zero_is_not_fallback_trend(self):
        result = _SCORER.calculate("7203", {"trend_score": 0.0})
        ts = next(c for c in result.components if c.name == "trend_score")
        assert ts.raw_value == 0.0
        assert ts.normalized == 0.0

    def test_zero_trend_gives_0(self):
        # trend_score=0.0 は下降トレンド → normalized=0（有効値）
        result = _SCORER.calculate("7203", {"trend_score": 0.0})
        ts = next(c for c in result.components if c.name == "trend_score")
        assert ts.normalized == 0.0

    def test_partial_missing(self):
        data = {"trend_score": 80.0, "ma_spread": 70.0}
        result = _SCORER.calculate("7203", data)
        ts  = next(c for c in result.components if c.name == "trend_score")
        ma  = next(c for c in result.components if c.name == "ma_spread")
        cr  = next(c for c in result.components if c.name == "credit_ratio")
        assert ts.raw_value == 80.0
        assert ma.raw_value == 70.0
        assert abs(cr.raw_value - MISSING_RAW_VALUES["credit_ratio"]) < 1e-9

    def test_missing_raw_values_each_normalize_to_50(self):
        for comp_name, raw in MISSING_RAW_VALUES.items():
            normalized = _SCORER._normalize(comp_name, raw)
            assert abs(normalized - 50.0) < 1e-9, (
                f"{comp_name}: _normalize({raw}) = {normalized}, expected=50.0"
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
        assert _SCORER._get_raw("trend_score", {"trend_score": 75.0}) == 75.0

    def test_missing_key(self):
        raw = _SCORER._get_raw("ma_spread", {})
        assert abs(raw - MISSING_RAW_VALUES["ma_spread"]) < 1e-9

    def test_zero_value(self):
        assert _SCORER._get_raw("trend_score", {"trend_score": 0.0}) == 0.0

    def test_unknown_key_fallback(self):
        raw = _SCORER._get_raw("unknown_comp", {})
        assert raw == 50.0


# ── TestEdgeCases ─────────────────────────────────────────────────────────────

class TestEdgeCases:
    def test_all_max_100(self):
        data = {k: 100.0 for k in _SCORER.COMPONENT_WEIGHTS}
        result = _SCORER.calculate("7203", data)
        assert abs(result.total - 100.0) < 1e-9

    def test_all_min_0(self):
        # 全成分0 → モメンタム最低スコア（down-trend）
        data = {k: 0.0 for k in _SCORER.COMPONENT_WEIGHTS}
        result = _SCORER.calculate("7203", data)
        assert abs(result.total - 0.0) < 1e-9

    def test_negative_raw_clamps_to_0(self):
        result = _SCORER.calculate("7203", {"trend_score": -50.0})
        ts = next(c for c in result.components if c.name == "trend_score")
        assert ts.normalized == 0.0

    def test_above_100_raw_clamps_to_100(self):
        result = _SCORER.calculate("7203", {"volume_z": 999.0})
        vz = next(c for c in result.components if c.name == "volume_z")
        assert vz.normalized == 100.0

    def test_extra_keys_ignored(self):
        data = {**_FULL_DATA, "rsi14": 65.0, "macd": 0.5, "bollinger": 55.0}
        result = _SCORER.calculate("7203", data)
        assert len(result.components) == 5

    def test_description_format(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        for comp in result.components:
            assert "スコア" in comp.description

    def test_passthrough_no_formula(self):
        # _normalize() のソースコードに formula 計算が含まれないことを確認
        src = inspect.getsource(_SCORER._normalize)
        for formula_keyword in ["* 5", "* 10", "* 15", "* 40", "* 200", "* 1.5", "* 8"]:
            assert formula_keyword not in src, (
                f"_normalize() に formula '{formula_keyword}' が含まれている"
            )
