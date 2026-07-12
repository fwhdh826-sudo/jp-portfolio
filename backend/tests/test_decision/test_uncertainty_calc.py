"""
test_uncertainty_calc.py — Card 5-8 UncertaintyCalculator テスト（38 tests）

Confidence × Uncertainty 補正（A7）と Decision Smoothing（A4）。
negative EV はマイナス補正しない仕様。判断フィールドなし。
"""
from __future__ import annotations

import inspect
from dataclasses import FrozenInstanceError

import pytest

from backend.engine.decision.uncertainty_calc import (
    UncertaintyCalculator,
    UncertaintyInput,
    UncertaintyResult,
)

_CALC = UncertaintyCalculator()


# ── TestUncertaintyInput ──────────────────────────────────────────────────────

class TestUncertaintyInput:
    def test_frozen(self):
        inp = UncertaintyInput(ticker="7203", ev_final=0.08,
                               confidence=0.8, uncertainty=0.2)
        with pytest.raises((FrozenInstanceError, TypeError)):
            inp.ticker = "9999"  # type: ignore[misc]

    def test_required_fields(self):
        inp = UncertaintyInput(ticker="7203", ev_final=0.08,
                               confidence=0.8, uncertainty=0.2)
        assert inp.ticker == "7203"
        assert inp.ev_final == 0.08
        assert inp.confidence == 0.8
        assert inp.uncertainty == 0.2

    def test_optional_previous_ev_default_none(self):
        inp = UncertaintyInput(ticker="7203", ev_final=0.08,
                               confidence=0.8, uncertainty=0.2)
        assert inp.previous_ev is None

    def test_smooth_alpha_default(self):
        inp = UncertaintyInput(ticker="7203", ev_final=0.08,
                               confidence=0.8, uncertainty=0.2)
        assert abs(inp.smooth_alpha - 0.7) < 1e-9


# ── TestUncertaintyResult ─────────────────────────────────────────────────────

class TestUncertaintyResult:
    def _make(self) -> UncertaintyResult:
        return _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.08, confidence=0.8, uncertainty=0.2,
        ))

    def test_frozen(self):
        r = self._make()
        with pytest.raises((FrozenInstanceError, TypeError)):
            r.risk_adjusted_ev = 0.0  # type: ignore[misc]

    def test_fields_exist(self):
        r = self._make()
        assert hasattr(r, "ticker")
        assert hasattr(r, "ev_final")
        assert hasattr(r, "confidence")
        assert hasattr(r, "uncertainty")
        assert hasattr(r, "risk_adjusted_ev")
        assert hasattr(r, "smoothed_ev")

    def test_no_is_actionable(self):
        r = self._make()
        assert not hasattr(r, "is_actionable"), \
            "is_actionable は判断フィールドのため禁止"

    def test_no_judgment_fields(self):
        r = self._make()
        for field in ("is_buy", "is_sell", "is_hold", "is_recommended",
                      "is_acceptable_risk", "action"):
            assert not hasattr(r, field), f"{field} は判断フィールドのため禁止"


# ── TestConfidenceUncertaintyCorrection ──────────────────────────────────────

class TestConfidenceUncertaintyCorrection:
    def test_conf1_uncert0_no_change(self):
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.08, confidence=1.0, uncertainty=0.0,
        ))
        assert abs(r.risk_adjusted_ev - 0.08) < 1e-12

    def test_conf0_gives_0(self):
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.08, confidence=0.0, uncertainty=0.0,
        ))
        assert abs(r.risk_adjusted_ev) < 1e-12

    def test_uncert1_gives_0(self):
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.08, confidence=1.0, uncertainty=1.0,
        ))
        assert abs(r.risk_adjusted_ev) < 1e-12

    def test_conf_half_uncertainty_0(self):
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.08, confidence=0.5, uncertainty=0.0,
        ))
        assert abs(r.risk_adjusted_ev - 0.04) < 1e-12

    def test_conf1_uncert_half(self):
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.08, confidence=1.0, uncertainty=0.5,
        ))
        assert abs(r.risk_adjusted_ev - 0.04) < 1e-12

    def test_conf_half_uncert_half(self):
        # ev_final=0.08 * 0.5 * 0.5 = 0.02
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.08, confidence=0.5, uncertainty=0.5,
        ))
        assert abs(r.risk_adjusted_ev - 0.02) < 1e-12

    def test_positive_ev_precise(self):
        # 0.10 * 0.5 * (1 - 0.5) = 0.025
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.10, confidence=0.5, uncertainty=0.5,
        ))
        assert abs(r.risk_adjusted_ev - 0.025) < 1e-12

    def test_clamp_confidence_above_1(self):
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.08, confidence=1.5, uncertainty=0.0,
        ))
        # confidence clamped to 1.0 → risk_adjusted_ev = 0.08
        assert abs(r.risk_adjusted_ev - 0.08) < 1e-12
        assert abs(r.confidence - 1.0) < 1e-12

    def test_clamp_uncertainty_below_0(self):
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.08, confidence=1.0, uncertainty=-0.5,
        ))
        # uncertainty clamped to 0.0 → risk_adjusted_ev = 0.08
        assert abs(r.risk_adjusted_ev - 0.08) < 1e-12
        assert abs(r.uncertainty) < 1e-12

    def test_clamp_both_in_result(self):
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.08, confidence=2.0, uncertainty=-1.0,
        ))
        assert abs(r.confidence - 1.0) < 1e-12
        assert abs(r.uncertainty) < 1e-12


# ── TestNegativeEVBehavior ────────────────────────────────────────────────────

class TestNegativeEVBehavior:
    def test_negative_ev_conf1_uncert0_unchanged(self):
        # ev_final < 0 → そのまま返す（confidence=1, uncertainty=0でも）
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=-0.05, confidence=1.0, uncertainty=0.0,
        ))
        assert abs(r.risk_adjusted_ev - (-0.05)) < 1e-12

    def test_negative_ev_conf_half_uncert_half_unchanged(self):
        # ev_final < 0 → confidence/uncertainty を適用しない
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=-0.05, confidence=0.5, uncertainty=0.5,
        ))
        assert abs(r.risk_adjusted_ev - (-0.05)) < 1e-12

    def test_negative_ev_conf0_uncert1_unchanged(self):
        # ev_final < 0 → 0 に近づかない（マイナスEVが軽く見えてはいけない）
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=-0.05, confidence=0.0, uncertainty=1.0,
        ))
        assert abs(r.risk_adjusted_ev - (-0.05)) < 1e-12

    def test_negative_ev_does_not_improve(self):
        # 高不確実性がマイナスEVを改善しないことを確認
        r_certain   = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=-0.05, confidence=1.0, uncertainty=0.0,
        ))
        r_uncertain = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=-0.05, confidence=0.1, uncertainty=0.9,
        ))
        # どちらも ev_final そのまま
        assert abs(r_certain.risk_adjusted_ev   - (-0.05)) < 1e-12
        assert abs(r_uncertain.risk_adjusted_ev - (-0.05)) < 1e-12

    def test_zero_ev_boundary(self):
        # ev_final=0.0 は >= 0 → 通常処理（0 * anything = 0）
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.0, confidence=0.5, uncertainty=0.5,
        ))
        assert abs(r.risk_adjusted_ev) < 1e-12


# ── TestDecisionSmoothing ─────────────────────────────────────────────────────

class TestDecisionSmoothing:
    def test_no_previous_smoothed_equals_risk_adjusted(self):
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.08, confidence=1.0, uncertainty=0.0,
        ))
        assert abs(r.smoothed_ev - r.risk_adjusted_ev) < 1e-12

    def test_alpha_07_default(self):
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.10, confidence=1.0, uncertainty=0.0,
            previous_ev=0.06,
        ))
        expected = 0.7 * 0.10 + 0.3 * 0.06
        assert abs(r.smoothed_ev - expected) < 1e-12

    def test_alpha_1_gives_current_only(self):
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.10, confidence=1.0, uncertainty=0.0,
            previous_ev=0.06, smooth_alpha=1.0,
        ))
        assert abs(r.smoothed_ev - 0.10) < 1e-12

    def test_alpha_0_gives_previous_only(self):
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.10, confidence=1.0, uncertainty=0.0,
            previous_ev=0.06, smooth_alpha=0.0,
        ))
        assert abs(r.smoothed_ev - 0.06) < 1e-12

    def test_negative_risk_adjusted_ev_smoothed(self):
        # マイナス risk_adjusted_ev でも smoothing は正常動作
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=-0.05, confidence=1.0, uncertainty=0.0,
            previous_ev=-0.03, smooth_alpha=0.7,
        ))
        expected = 0.7 * (-0.05) + 0.3 * (-0.03)
        assert abs(r.smoothed_ev - expected) < 1e-12

    def test_previous_ev_is_risk_adjusted_value(self):
        # smoothing は risk_adjusted_ev に対して行われる（ev_final ではない）
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.10, confidence=0.5, uncertainty=0.0,
            previous_ev=0.04, smooth_alpha=0.7,
        ))
        # risk_adjusted_ev = 0.10 * 0.5 * 1.0 = 0.05
        risk_adj = 0.10 * 0.5 * 1.0
        expected = 0.7 * risk_adj + 0.3 * 0.04
        assert abs(r.smoothed_ev - expected) < 1e-12

    def test_custom_alpha(self):
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.10, confidence=1.0, uncertainty=0.0,
            previous_ev=0.08, smooth_alpha=0.5,
        ))
        expected = 0.5 * 0.10 + 0.5 * 0.08
        assert abs(r.smoothed_ev - expected) < 1e-12

    def test_smoothed_ev_not_clamped(self):
        # very negative smoothed_ev はクランプされない
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=-0.50, confidence=1.0, uncertainty=0.0,
            previous_ev=-0.40, smooth_alpha=0.7,
        ))
        expected = 0.7 * (-0.50) + 0.3 * (-0.40)
        assert abs(r.smoothed_ev - expected) < 1e-12


# ── TestEdgeCases ─────────────────────────────────────────────────────────────

class TestUncertaintyEdgeCases:
    def test_ticker_preserved(self):
        r = _CALC.calculate(UncertaintyInput(
            ticker="9984", ev_final=0.08, confidence=0.8, uncertainty=0.2,
        ))
        assert r.ticker == "9984"

    def test_ev_final_preserved(self):
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=0.12, confidence=0.8, uncertainty=0.2,
        ))
        assert abs(r.ev_final - 0.12) < 1e-12

    def test_risk_adjusted_ev_not_clamped(self):
        # 非常に高い positive EV
        r = _CALC.calculate(UncertaintyInput(
            ticker="7203", ev_final=10.0, confidence=1.0, uncertainty=0.0,
        ))
        assert abs(r.risk_adjusted_ev - 10.0) < 1e-12

    def test_no_forbidden_imports(self):
        import backend.engine.decision.uncertainty_calc as mod
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
            "from backend.engine.regime",
            "from backend.engine.operation",
            "from backend.engine.market_intel",
            "from backend.engine.news",
            "from backend.engine.scoring",
            "from backend.engine.decision.ev_calculator",
            "from backend.engine.decision.cvar_estimator",
        ]
        for item in forbidden:
            assert item not in src_imports, f"禁止 import が含まれている: {item}"
