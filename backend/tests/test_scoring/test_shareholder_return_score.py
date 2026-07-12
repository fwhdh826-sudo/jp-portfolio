"""
test_shareholder_return_score.py — Card 5-6 ShareholderReturnScorer テスト（70 tests）

全成分正相関。
div_payout は ratio 単位（0〜1）、他成分は % 単位。
正規化仕様: clamp(x * factor, 0, 100)。
MISSING_RAW_VALUES の 4 成分（div_payout/buyback_yield/doe/div_growth_5y）は
float 精度誤差があるため abs < 1e-6 で検証する。
"""
from __future__ import annotations

import inspect
from dataclasses import FrozenInstanceError
from unittest.mock import MagicMock

import pytest

from backend.engine.scoring.shareholder_return_score import (
    MISSING_RAW_VALUES,
    AxisScore,
    ScoreComponent,
    ShareholderReturnScorer,
)

# ── フィクスチャ ──────────────────────────────────────────────────────────────

_FULL_DATA: dict = {
    "div_payout":    0.40,   # 40%配当性向 → normalized=60
    "buyback_yield": 2.00,   # 2.0% → normalized=60
    "doe":           2.00,   # 2.0% → normalized=60
    "div_growth_5y": 4.00,   # 4.0% CAGR → normalized=60
    "total_yield":   2.40,   # 2.4% → normalized=60
}

_SCORER = ShareholderReturnScorer()


# ── TestScoreComponent ────────────────────────────────────────────────────────

class TestScoreComponent:
    def test_frozen(self):
        comp = ScoreComponent(
            name="div_payout", weight=0.30, raw_value=0.40,
            normalized=60.0, description="test",
        )
        with pytest.raises((FrozenInstanceError, TypeError)):
            comp.name = "doe"  # type: ignore[misc]

    def test_fields(self):
        comp = ScoreComponent(
            name="buyback_yield", weight=0.25, raw_value=2.0,
            normalized=60.0, description="desc",
        )
        assert comp.name == "buyback_yield"
        assert comp.weight == 0.25
        assert comp.raw_value == 2.0
        assert comp.normalized == 60.0
        assert comp.description == "desc"

    def test_name_type(self):
        comp = ScoreComponent(
            name="doe", weight=0.20, raw_value=2.0,
            normalized=60.0, description="d",
        )
        assert isinstance(comp.name, str)

    def test_normalized_float(self):
        comp = ScoreComponent(
            name="div_growth_5y", weight=0.15, raw_value=4.0,
            normalized=60.0, description="d",
        )
        assert isinstance(comp.normalized, float)

    def test_description_str(self):
        comp = ScoreComponent(
            name="total_yield", weight=0.10, raw_value=2.4,
            normalized=60.0, description="テスト説明",
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

    def test_axis_is_shareholder_return(self):
        ax = self._make()
        assert ax.axis == "shareholder_return"

    def test_name_ja(self):
        ax = self._make()
        assert ax.name_ja == "還元力"

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


# ── TestShareholderReturnScorerConstants ──────────────────────────────────────

class TestShareholderReturnScorerConstants:
    def test_weights_sum(self):
        total = sum(_SCORER.COMPONENT_WEIGHTS.values())
        assert abs(total - 1.0) < 1e-9

    def test_weights_count(self):
        assert len(_SCORER.COMPONENT_WEIGHTS) == 5

    def test_axis_id(self):
        assert ShareholderReturnScorer.AXIS_ID == "shareholder_return"

    def test_axis_name(self):
        assert ShareholderReturnScorer.AXIS_NAME == "還元力"


# ── TestNormalizeDivPayout ────────────────────────────────────────────────────

class TestNormalizeDivPayout:
    def test_zero_is_0(self):
        assert _SCORER._normalize("div_payout", 0.0) == 0.0

    def test_one_third_is_50(self):
        # (1/3)*150 ≈ 50.0（float誤差あり）
        assert abs(_SCORER._normalize("div_payout", 1.0 / 3.0) - 50.0) < 1e-6

    def test_two_thirds_is_100(self):
        assert abs(_SCORER._normalize("div_payout", 2.0 / 3.0) - 100.0) < 1e-6

    def test_above_clamp(self):
        assert _SCORER._normalize("div_payout", 1.0) == 100.0

    def test_negative_clamp(self):
        assert _SCORER._normalize("div_payout", -0.1) == 0.0


# ── TestNormalizeBuybackYield ─────────────────────────────────────────────────

class TestNormalizeBuybackYield:
    def test_zero_is_0(self):
        assert _SCORER._normalize("buyback_yield", 0.0) == 0.0

    def test_five_thirds_is_50(self):
        # (5/3)*30 ≈ 50.0（float誤差あり）
        assert abs(_SCORER._normalize("buyback_yield", 5.0 / 3.0) - 50.0) < 1e-6

    def test_ten_thirds_is_100(self):
        assert abs(_SCORER._normalize("buyback_yield", 10.0 / 3.0) - 100.0) < 1e-6

    def test_above_clamp(self):
        assert _SCORER._normalize("buyback_yield", 10.0) == 100.0

    def test_negative_clamp(self):
        assert _SCORER._normalize("buyback_yield", -1.0) == 0.0


# ── TestNormalizeDoe ──────────────────────────────────────────────────────────

class TestNormalizeDoe:
    def test_zero_is_0(self):
        assert _SCORER._normalize("doe", 0.0) == 0.0

    def test_five_thirds_is_50(self):
        assert abs(_SCORER._normalize("doe", 5.0 / 3.0) - 50.0) < 1e-6

    def test_ten_thirds_is_100(self):
        assert abs(_SCORER._normalize("doe", 10.0 / 3.0) - 100.0) < 1e-6

    def test_above_clamp(self):
        assert _SCORER._normalize("doe", 10.0) == 100.0

    def test_negative_clamp(self):
        assert _SCORER._normalize("doe", -0.5) == 0.0


# ── TestNormalizeDivGrowth5y ──────────────────────────────────────────────────

class TestNormalizeDivGrowth5y:
    def test_zero_is_0(self):
        assert _SCORER._normalize("div_growth_5y", 0.0) == 0.0

    def test_ten_thirds_is_50(self):
        # (10/3)*15 ≈ 50.0（float誤差あり）
        assert abs(_SCORER._normalize("div_growth_5y", 10.0 / 3.0) - 50.0) < 1e-6

    def test_twenty_thirds_is_100(self):
        assert abs(_SCORER._normalize("div_growth_5y", 20.0 / 3.0) - 100.0) < 1e-6

    def test_above_clamp(self):
        assert _SCORER._normalize("div_growth_5y", 20.0) == 100.0

    def test_negative_clamp(self):
        assert _SCORER._normalize("div_growth_5y", -1.0) == 0.0


# ── TestNormalizeTotalYield ───────────────────────────────────────────────────

class TestNormalizeTotalYield:
    def test_zero_is_0(self):
        assert _SCORER._normalize("total_yield", 0.0) == 0.0

    def test_2_is_50(self):
        assert abs(_SCORER._normalize("total_yield", 2.0) - 50.0) < 1e-9

    def test_4_is_100(self):
        assert abs(_SCORER._normalize("total_yield", 4.0) - 100.0) < 1e-9

    def test_above_clamp(self):
        assert _SCORER._normalize("total_yield", 10.0) == 100.0

    def test_negative_clamp(self):
        assert _SCORER._normalize("total_yield", -1.0) == 0.0


# ── TestCalculateBasic ────────────────────────────────────────────────────────

class TestCalculateBasic:
    def test_returns_axis_score(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert isinstance(result, AxisScore)

    def test_axis_is_shareholder_return(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        assert result.axis == "shareholder_return"

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
            "div_payout", "buyback_yield", "doe",
            "div_growth_5y", "total_yield",
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
        assert d["axis"] == "shareholder_return"
        assert d["name_ja"] == "還元力"
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

    def test_zero_is_not_fallback_div_payout(self):
        result = _SCORER.calculate("7203", {"div_payout": 0.0})
        dp = next(c for c in result.components if c.name == "div_payout")
        assert dp.raw_value == 0.0
        assert dp.normalized == 0.0

    def test_zero_div_payout_gives_0(self):
        # div_payout=0.0 は無配 → normalized=0（有効値）
        result = _SCORER.calculate("7203", {"div_payout": 0.0})
        dp = next(c for c in result.components if c.name == "div_payout")
        assert dp.normalized == 0.0

    def test_partial_missing(self):
        data = {"div_payout": 0.50, "buyback_yield": 3.0}
        result = _SCORER.calculate("7203", data)
        dp  = next(c for c in result.components if c.name == "div_payout")
        bb  = next(c for c in result.components if c.name == "buyback_yield")
        doe = next(c for c in result.components if c.name == "doe")
        assert dp.raw_value == 0.50
        assert bb.raw_value == 3.0
        assert abs(doe.raw_value - MISSING_RAW_VALUES["doe"]) < 1e-9

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
        assert _SCORER._get_raw("div_payout", {"div_payout": 0.50}) == 0.50

    def test_missing_key(self):
        raw = _SCORER._get_raw("buyback_yield", {})
        assert abs(raw - MISSING_RAW_VALUES["buyback_yield"]) < 1e-9

    def test_zero_value(self):
        assert _SCORER._get_raw("div_payout", {"div_payout": 0.0}) == 0.0

    def test_unknown_key_fallback(self):
        raw = _SCORER._get_raw("unknown_comp", {})
        assert raw == 50.0


# ── TestEdgeCases ─────────────────────────────────────────────────────────────

class TestEdgeCases:
    def test_all_zero_gives_0(self):
        # 全成分正相関のため 0.0 → total=0
        data = {k: 0.0 for k in _SCORER.COMPONENT_WEIGHTS}
        result = _SCORER.calculate("7203", data)
        assert abs(result.total - 0.0) < 1e-9

    def test_all_max_100(self):
        # div_payout=2/3→100, buyback_yield=10/3→100, doe=10/3→100,
        # div_growth_5y=20/3→100, total_yield=4→100
        data = {
            "div_payout":    2.0 / 3.0,
            "buyback_yield": 10.0 / 3.0,
            "doe":           10.0 / 3.0,
            "div_growth_5y": 20.0 / 3.0,
            "total_yield":   4.0,
        }
        result = _SCORER.calculate("7203", data)
        assert abs(result.total - 100.0) < 1e-6

    def test_negative_raw_clamps_to_0(self):
        result = _SCORER.calculate("7203", {"div_payout": -0.5})
        dp = next(c for c in result.components if c.name == "div_payout")
        assert dp.normalized == 0.0

    def test_above_max_raw_clamps_to_100(self):
        result = _SCORER.calculate("7203", {"total_yield": 999.0})
        ty = next(c for c in result.components if c.name == "total_yield")
        assert ty.normalized == 100.0

    def test_extra_keys_ignored(self):
        data = {**_FULL_DATA, "rsi14": 65.0, "pe_ratio": 15.0, "dividend": 30.0}
        result = _SCORER.calculate("7203", data)
        assert len(result.components) == 5

    def test_description_contains_score(self):
        result = _SCORER.calculate("7203", _FULL_DATA)
        for comp in result.components:
            assert "スコア" in comp.description

    def test_div_payout_ratio_unit_not_percent(self):
        # div_payout=0.50（50%配当性向）→ normalized=75.0
        result = _SCORER.calculate("7203", {"div_payout": 0.50})
        dp = next(c for c in result.components if c.name == "div_payout")
        assert abs(dp.normalized - 75.0) < 1e-9

    def test_div_payout_1_clamps_to_100(self):
        # div_payout=1.0（100%配当性向）→ 1.0*150=150 → clamp=100
        result = _SCORER.calculate("7203", {"div_payout": 1.0})
        dp = next(c for c in result.components if c.name == "div_payout")
        assert dp.normalized == 100.0

    def test_no_forbidden_imports(self):
        import backend.engine.scoring.shareholder_return_score as mod
        # import 文のみ検証（docstring の参照コメントは除外）
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
            "from backend.engine.regime", "from backend.engine.operation",
            "from backend.engine.market_intel", "from backend.engine.news",
            "from backend.engine.scoring.value_score",
            "from backend.engine.scoring.quality_score",
            "from backend.engine.scoring.growth_score",
            "from backend.engine.scoring.safety_score",
            "from backend.engine.scoring.momentum_score",
        ]
        for item in forbidden:
            assert item not in src_imports, f"禁止 import が含まれている: {item}"
