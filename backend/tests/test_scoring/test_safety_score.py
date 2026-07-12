"""
test_safety_score.py — Card 5-4 SafetyScorer テスト（70 tests）

注意: de_ratio / volatility_252d / beta_inverse は低いほど高スコア（逆相関）。
0.0 は fallback しない有効値（de_ratio=0→100点、volatility=0→100点）。
test_all_min_values_zero → total=0 は誤りのため実装しない。
代わりに test_all_worst_values / test_all_best_values を使用する。
"""
from __future__ import annotations

from dataclasses import FrozenInstanceError
from unittest.mock import MagicMock

import pytest

from backend.engine.scoring.safety_score import (
    MISSING_RAW_VALUES,
    AxisScore,
    SafetyScorer,
    ScoreComponent,
)

# ── フィクスチャ ──────────────────────────────────────────────────────────────

_FULL_DATA: dict = {
    "equity_ratio":    50.0,   # 50*1.5=75 (高評価)
    "de_ratio":        0.5,    # 100-0.5*40=80 (高評価)
    "interest_cover":  10.0,   # 10*8=80 (高評価)
    "volatility_252d": 0.15,   # 100-0.15*200=70 (標準〜高)
    "beta_inverse":    0.8,    # (1-0.8)*100+50=70 (標準〜高)
}

_SCORER = SafetyScorer()


# ── TestScoreComponent ────────────────────────────────────────────────────────

class TestScoreComponent:
    def test_frozen(self):
        comp = ScoreComponent(
            name="equity_ratio", weight=0.30, raw_value=50.0,
            normalized=75.0, description="test",
        )
        with pytest.raises((FrozenInstanceError, TypeError)):
            comp.name = "de_ratio"  # type: ignore[misc]

    def test_fields(self):
        comp = ScoreComponent(
            name="de_ratio", weight=0.25, raw_value=1.25,
            normalized=50.0, description="desc",
        )
        assert comp.name == "de_ratio"
        assert comp.weight == 0.25
        assert comp.raw_value == 1.25
        assert comp.normalized == 50.0
        assert comp.description == "desc"

    def test_name_type(self):
        comp = ScoreComponent(
            name="interest_cover", weight=0.20, raw_value=6.25,
            normalized=50.0, description="d",
        )
        assert isinstance(comp.name, str)

    def test_normalized_float(self):
        comp = ScoreComponent(
            name="volatility_252d", weight=0.15, raw_value=0.25,
            normalized=50.0, description="d",
        )
        assert isinstance(comp.normalized, float)

    def test_description_str(self):
        comp = ScoreComponent(
            name="beta_inverse", weight=0.10, raw_value=1.0,
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

    def test_axis_is_safety(self):
        ax = self._make()
        assert ax.axis == "safety"

    def test_name_ja(self):
        ax = self._make()
        assert ax.name_ja == "安全性"

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


# ── TestSafetyScorerConstants ─────────────────────────────────────────────────

class TestSafetyScorerConstants:
    def test_weights_sum(self):
        total = sum(_SCORER.COMPONENT_WEIGHTS.values())
        assert abs(total - 1.0) < 1e-9

    def test_weights_count(self):
        assert len(_SCORER.COMPONENT_WEIGHTS) == 5

    def test_axis_id(self):
        assert SafetyScorer.AXIS_ID == "safety"

    def test_axis_name(self):
        assert SafetyScorer.AXIS_NAME == "安全性"


# ── TestNormalizeEquityRatio ──────────────────────────────────────────────────

class TestNormalizeEquityRatio:
    def test_zero_is_0(self):
        assert _SCORER._normalize("equity_ratio", 0.0) == 0.0

    def test_333_is_50(self):
        # (100/3)*1.5 ≈ 50.0 (float 誤差あり → abs 1e-6)
        assert abs(_SCORER._normalize("equity_ratio", 100.0 / 3.0) - 50.0) < 1e-6

    def test_667_is_100(self):
        assert abs(_SCORER._normalize("equity_ratio", 200.0 / 3.0) - 100.0) < 1e-6

    def test_above_clamp(self):
        assert _SCORER._normalize("equity_ratio", 100.0) == 100.0

    def test_negative_clamp(self):
        assert _SCORER._normalize("equity_ratio", -10.0) == 0.0

    def test_50_is_75(self):
        assert abs(_SCORER._normalize("equity_ratio", 50.0) - 75.0) < 1e-9


# ── TestNormalizeDeRatio ──────────────────────────────────────────────────────

class TestNormalizeDeRatio:
    def test_zero_is_100(self):
        # de_ratio=0 は無借金 → 最高スコア
        assert abs(_SCORER._normalize("de_ratio", 0.0) - 100.0) < 1e-9

    def test_125_is_50(self):
        assert abs(_SCORER._normalize("de_ratio", 1.25) - 50.0) < 1e-9

    def test_25_is_0(self):
        assert abs(_SCORER._normalize("de_ratio", 2.5) - 0.0) < 1e-9

    def test_above_25_clamp(self):
        assert _SCORER._normalize("de_ratio", 5.0) == 0.0

    def test_negative_clamp_100(self):
        # 負の D/E → 100 超え → clamp 100
        assert _SCORER._normalize("de_ratio", -1.0) == 100.0


# ── TestNormalizeInterestCover ────────────────────────────────────────────────

class TestNormalizeInterestCover:
    def test_zero_is_0(self):
        assert _SCORER._normalize("interest_cover", 0.0) == 0.0

    def test_625_is_50(self):
        assert abs(_SCORER._normalize("interest_cover", 6.25) - 50.0) < 1e-9

    def test_125_is_100(self):
        assert abs(_SCORER._normalize("interest_cover", 12.5) - 100.0) < 1e-9

    def test_above_clamp(self):
        assert _SCORER._normalize("interest_cover", 20.0) == 100.0

    def test_negative_clamp(self):
        assert _SCORER._normalize("interest_cover", -1.0) == 0.0


# ── TestNormalizeVolatility ───────────────────────────────────────────────────

class TestNormalizeVolatility:
    def test_zero_is_100(self):
        # volatility=0 は最低ボラ → 最高スコア
        assert abs(_SCORER._normalize("volatility_252d", 0.0) - 100.0) < 1e-9

    def test_025_is_50(self):
        assert abs(_SCORER._normalize("volatility_252d", 0.25) - 50.0) < 1e-9

    def test_05_is_0(self):
        assert abs(_SCORER._normalize("volatility_252d", 0.5) - 0.0) < 1e-9

    def test_above_05_clamp(self):
        assert _SCORER._normalize("volatility_252d", 1.0) == 0.0

    def test_negative_clamp(self):
        # 負ボラ → 100 超え → clamp 100
        assert _SCORER._normalize("volatility_252d", -0.1) == 100.0


# ── TestNormalizeBetaInverse ──────────────────────────────────────────────────

class TestNormalizeBetaInverse:
    def test_beta_0_clamp_100(self):
        # β=0 → (1-0)*100+50=150 → clamp 100
        assert _SCORER._normalize("beta_inverse", 0.0) == 100.0

    def test_beta_05_is_100(self):
        # β=0.5 → (1-0.5)*100+50=100 → ちょうど上限（clamp不要）
        assert abs(_SCORER._normalize("beta_inverse", 0.5) - 100.0) < 1e-9

    def test_beta_1_is_50(self):
        assert abs(_SCORER._normalize("beta_inverse", 1.0) - 50.0) < 1e-9

    def test_beta_15_is_0(self):
        # β=1.5 → (1-1.5)*100+50=0 → ちょうど下限
        assert abs(_SCORER._normalize("beta_inverse", 1.5) - 0.0) < 1e-9

    def test_beta_2_clamp_0(self):
        # β=2.0 → (1-2.0)*100+50=-50 → clamp 0
        assert _SCORER._normalize("beta_inverse", 2.0) == 0.0


# ── TestCalculateBasic ────────────────────────────────────────────────────────

class TestCalculateBasic:
    def test_returns_axis_score(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert isinstance(result, AxisScore)

    def test_axis_is_safety(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert result.axis == "safety"

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
            "equity_ratio", "de_ratio", "interest_cover",
            "volatility_252d", "beta_inverse",
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
        assert d["axis"] == "safety"
        assert d["name_ja"] == "安全性"
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

    def test_zero_is_not_fallback_equity(self):
        result = _SCORER.calculate("7203", {"equity_ratio": 0.0})
        eq = next(c for c in result.components if c.name == "equity_ratio")
        assert eq.raw_value == 0.0
        assert eq.normalized == 0.0

    def test_zero_de_ratio_gives_100(self):
        # de_ratio=0.0 は fallback しない有効値 → 逆相関のため normalized=100
        result = _SCORER.calculate("7203", {"de_ratio": 0.0})
        de = next(c for c in result.components if c.name == "de_ratio")
        assert de.raw_value == 0.0
        assert abs(de.normalized - 100.0) < 1e-9

    def test_zero_volatility_gives_100(self):
        # volatility=0.0 は fallback しない有効値 → 逆相関のため normalized=100
        result = _SCORER.calculate("7203", {"volatility_252d": 0.0})
        vol = next(c for c in result.components if c.name == "volatility_252d")
        assert vol.raw_value == 0.0
        assert abs(vol.normalized - 100.0) < 1e-9

    def test_partial_missing(self):
        data = {"equity_ratio": 50.0, "de_ratio": 0.5}
        result = _SCORER.calculate("7203", data)
        eq = next(c for c in result.components if c.name == "equity_ratio")
        de = next(c for c in result.components if c.name == "de_ratio")
        ic = next(c for c in result.components if c.name == "interest_cover")
        assert eq.raw_value == 50.0
        assert de.raw_value == 0.5
        assert abs(ic.raw_value - MISSING_RAW_VALUES["interest_cover"]) < 1e-9

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
        assert _SCORER._get_raw("equity_ratio", {"equity_ratio": 50.0}) == 50.0

    def test_missing_key(self):
        raw = _SCORER._get_raw("de_ratio", {})
        assert abs(raw - MISSING_RAW_VALUES["de_ratio"]) < 1e-9

    def test_zero_value(self):
        # de_ratio=0.0 は有効値として返す（fallback しない）
        assert _SCORER._get_raw("de_ratio", {"de_ratio": 0.0}) == 0.0

    def test_unknown_key_fallback(self):
        raw = _SCORER._get_raw("unknown_comp", {})
        assert raw == 50.0


# ── TestEdgeCases ─────────────────────────────────────────────────────────────

class TestEdgeCases:
    def test_all_worst_values_gives_0(self):
        # 各成分の worst raw 値 → 全 normalized=0 → total=0
        worst = {
            "equity_ratio":    0.0,   # 0*1.5=0
            "de_ratio":        2.5,   # 100-2.5*40=0
            "interest_cover":  0.0,   # 0*8=0
            "volatility_252d": 0.5,   # 100-0.5*200=0
            "beta_inverse":    1.5,   # (1-1.5)*100+50=0
        }
        result = _SCORER.calculate("7203", worst)
        assert abs(result.total - 0.0) < 1e-9

    def test_all_best_values_gives_100(self):
        # 各成分の best raw 値 → 全 normalized=100 → total=100
        best = {
            "equity_ratio":    100.0,  # 100*1.5=150→clamp100
            "de_ratio":        0.0,    # 100-0*40=100
            "interest_cover":  12.5,   # 12.5*8=100
            "volatility_252d": 0.0,    # 100-0*200=100
            "beta_inverse":    0.5,    # (1-0.5)*100+50=100
        }
        result = _SCORER.calculate("7203", best)
        assert abs(result.total - 100.0) < 1e-9

    def test_high_equity_clamp(self):
        result = _SCORER.calculate("7203", {"equity_ratio": 100.0})
        eq = next(c for c in result.components if c.name == "equity_ratio")
        assert eq.normalized == 100.0

    def test_de_ratio_zero_is_100(self):
        result = _SCORER.calculate("7203", {"de_ratio": 0.0})
        de = next(c for c in result.components if c.name == "de_ratio")
        assert abs(de.normalized - 100.0) < 1e-9

    def test_extra_keys_ignored(self):
        data = {**_FULL_DATA, "unknown_key": 999.0, "order_backlog": 80.0}
        result = _SCORER.calculate("7203", data)
        assert len(result.components) == 5

    def test_description_format(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        for comp in result.components:
            assert "スコア" in comp.description
