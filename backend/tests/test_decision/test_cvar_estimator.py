"""
test_cvar_estimator.py — Card 5-8 CVaREstimator テスト（37 tests）

シナリオベース / パラメトリックの2モード。
CVaR値はクランプしない。判断フィールドなし。
"""
from __future__ import annotations

import inspect
from dataclasses import FrozenInstanceError

import pytest

from backend.engine.decision.cvar_estimator import (
    _FACTORS,
    CVaREstimator,
    CVaRInput,
    CVaRResult,
)

_ESTIMATOR = CVaREstimator()


# ── TestCVaRInput ─────────────────────────────────────────────────────────────

class TestCVaRInput:
    def test_frozen(self):
        inp = CVaRInput(ticker="7203", ev_final=0.08, volatility=0.20)
        with pytest.raises((FrozenInstanceError, TypeError)):
            inp.ticker = "9999"  # type: ignore[misc]

    def test_required_fields(self):
        inp = CVaRInput(ticker="7203", ev_final=0.08, volatility=0.20)
        assert inp.ticker == "7203"
        assert inp.ev_final == 0.08
        assert inp.volatility == 0.20

    def test_optional_defaults(self):
        inp = CVaRInput(ticker="7203", ev_final=0.08, volatility=0.20)
        assert inp.scenarios == ()
        assert inp.percentile == 0.05

    def test_custom_scenarios(self):
        inp = CVaRInput(
            ticker="7203", ev_final=0.08, volatility=0.20,
            scenarios=(-0.05, -0.03, 0.02), percentile=0.10,
        )
        assert len(inp.scenarios) == 3
        assert inp.percentile == 0.10


# ── TestCVaRResult ────────────────────────────────────────────────────────────

class TestCVaRResult:
    def _make(self) -> CVaRResult:
        return _ESTIMATOR.estimate(CVaRInput(ticker="7203", ev_final=0.08, volatility=0.20))

    def test_frozen(self):
        r = self._make()
        with pytest.raises((FrozenInstanceError, TypeError)):
            r.cvar = 0.0  # type: ignore[misc]

    def test_fields_exist(self):
        r = self._make()
        assert hasattr(r, "ticker")
        assert hasattr(r, "ev_final")
        assert hasattr(r, "cvar")
        assert hasattr(r, "cvar_mode")
        assert hasattr(r, "scenario_count")
        assert hasattr(r, "tail_cutoff")

    def test_no_is_acceptable_risk(self):
        r = self._make()
        assert not hasattr(r, "is_acceptable_risk"), \
            "is_acceptable_risk は判断フィールドのため禁止"

    def test_no_judgment_fields(self):
        r = self._make()
        for field in ("is_buy", "is_sell", "is_hold", "is_recommended", "action"):
            assert not hasattr(r, field), f"{field} は判断フィールドのため禁止"


# ── TestCVaREstimatorConstants ────────────────────────────────────────────────

class TestCVaREstimatorConstants:
    def test_factors_keys(self):
        assert set(_FACTORS.keys()) == {0.01, 0.05, 0.10}

    def test_factor_005(self):
        assert abs(_FACTORS[0.05] - 2.063) < 1e-9

    def test_factor_001(self):
        assert abs(_FACTORS[0.01] - 2.665) < 1e-9

    def test_factor_010(self):
        assert abs(_FACTORS[0.10] - 1.755) < 1e-9


# ── TestScenarioCVaR ──────────────────────────────────────────────────────────

class TestScenarioCVaR:
    def test_basic_lower_tail_mean(self):
        # 20シナリオ, percentile=0.05 → cutoff=max(1, int(20*0.05))=1
        scenarios = tuple(float(i) for i in range(-10, 10))  # -10 〜 9
        inp = CVaRInput(ticker="7203", ev_final=0.0, volatility=0.0, scenarios=scenarios)
        r = _ESTIMATOR.estimate(inp)
        # sorted: -10, -9, ..., 9 → tail[0] = -10 → mean = -10.0
        assert abs(r.cvar - (-10.0)) < 1e-9

    def test_cvar_mode_is_scenario(self):
        inp = CVaRInput(ticker="7203", ev_final=0.0, volatility=0.0,
                        scenarios=(-0.05, -0.03, 0.02))
        r = _ESTIMATOR.estimate(inp)
        assert r.cvar_mode == "scenario"

    def test_scenario_count(self):
        scenarios = (-0.10, -0.05, -0.02, 0.01, 0.03)
        inp = CVaRInput(ticker="7203", ev_final=0.0, volatility=0.0, scenarios=scenarios)
        r = _ESTIMATOR.estimate(inp)
        assert r.scenario_count == 5

    def test_tail_cutoff_min_1(self):
        # len=3, percentile=0.05 → int(3*0.05)=0 → max(1, 0)=1
        inp = CVaRInput(ticker="7203", ev_final=0.0, volatility=0.0,
                        scenarios=(-0.10, -0.05, 0.01), percentile=0.05)
        r = _ESTIMATOR.estimate(inp)
        assert r.tail_cutoff == 1

    def test_percentile_10_uses_larger_tail(self):
        scenarios = tuple(float(i) for i in range(-10, 10))  # 20 items
        inp_5  = CVaRInput(ticker="7203", ev_final=0.0, volatility=0.0,
                           scenarios=scenarios, percentile=0.05)
        inp_10 = CVaRInput(ticker="7203", ev_final=0.0, volatility=0.0,
                           scenarios=scenarios, percentile=0.10)
        r_5  = _ESTIMATOR.estimate(inp_5)
        r_10 = _ESTIMATOR.estimate(inp_10)
        assert r_10.tail_cutoff > r_5.tail_cutoff

    def test_all_negative_scenarios(self):
        scenarios = (-0.30, -0.20, -0.10, -0.05)
        inp = CVaRInput(ticker="7203", ev_final=0.0, volatility=0.0,
                        scenarios=scenarios, percentile=0.50)
        r = _ESTIMATOR.estimate(inp)
        assert r.cvar < 0.0

    def test_int_scenarios_converted_to_float(self):
        # scenarios に int が混じっても float 変換で処理
        inp = CVaRInput(ticker="7203", ev_final=0.0, volatility=0.0,
                        scenarios=(-10, -5, 0, 5, 10))  # type: ignore[arg-type]
        r = _ESTIMATOR.estimate(inp)
        assert isinstance(r.cvar, float)

    def test_single_scenario(self):
        inp = CVaRInput(ticker="7203", ev_final=0.0, volatility=0.0,
                        scenarios=(-0.15,))
        r = _ESTIMATOR.estimate(inp)
        assert abs(r.cvar - (-0.15)) < 1e-9
        assert r.tail_cutoff == 1

    def test_sorted_before_tail(self):
        # 降順で渡してもソートされた lower-tail になること
        scenarios = (0.10, 0.05, -0.05, -0.10)
        inp = CVaRInput(ticker="7203", ev_final=0.0, volatility=0.0,
                        scenarios=scenarios, percentile=0.25)
        r = _ESTIMATOR.estimate(inp)
        # sorted: -0.10, -0.05, 0.05, 0.10 → cutoff=max(1,1)=1 → tail=[-0.10]
        assert abs(r.cvar - (-0.10)) < 1e-9

    def test_cvar_not_clamped(self):
        # 非常に悪いシナリオでも cvar はクランプされない
        scenarios = (-1.0, -0.9, -0.8)
        inp = CVaRInput(ticker="7203", ev_final=0.0, volatility=0.0,
                        scenarios=scenarios, percentile=0.05)
        r = _ESTIMATOR.estimate(inp)
        assert r.cvar <= -0.8


# ── TestParametricCVaR ────────────────────────────────────────────────────────

class TestParametricCVaR:
    def test_basic(self):
        inp = CVaRInput(ticker="7203", ev_final=0.08, volatility=0.20)
        r = _ESTIMATOR.estimate(inp)
        expected = 0.08 - 0.20 * 2.063
        assert abs(r.cvar - expected) < 1e-9

    def test_cvar_mode_is_parametric(self):
        inp = CVaRInput(ticker="7203", ev_final=0.08, volatility=0.20)
        r = _ESTIMATOR.estimate(inp)
        assert r.cvar_mode == "parametric"

    def test_scenario_count_zero(self):
        inp = CVaRInput(ticker="7203", ev_final=0.08, volatility=0.20)
        r = _ESTIMATOR.estimate(inp)
        assert r.scenario_count == 0
        assert r.tail_cutoff == 0

    def test_volatility_zero_cvar_equals_ev_final(self):
        inp = CVaRInput(ticker="7203", ev_final=0.08, volatility=0.0)
        r = _ESTIMATOR.estimate(inp)
        assert abs(r.cvar - 0.08) < 1e-9

    def test_high_volatility_gives_more_negative_cvar(self):
        inp_low  = CVaRInput(ticker="7203", ev_final=0.08, volatility=0.10)
        inp_high = CVaRInput(ticker="7203", ev_final=0.08, volatility=0.40)
        r_low  = _ESTIMATOR.estimate(inp_low)
        r_high = _ESTIMATOR.estimate(inp_high)
        assert r_high.cvar < r_low.cvar

    def test_negative_ev_still_computes(self):
        inp = CVaRInput(ticker="7203", ev_final=-0.05, volatility=0.20)
        r = _ESTIMATOR.estimate(inp)
        expected = -0.05 - 0.20 * 2.063
        assert abs(r.cvar - expected) < 1e-9

    def test_unknown_percentile_fallback_to_005(self):
        inp_known   = CVaRInput(ticker="7203", ev_final=0.08, volatility=0.20,
                                percentile=0.05)
        inp_unknown = CVaRInput(ticker="7203", ev_final=0.08, volatility=0.20,
                                percentile=0.07)  # not in _FACTORS
        r_known   = _ESTIMATOR.estimate(inp_known)
        r_unknown = _ESTIMATOR.estimate(inp_unknown)
        assert abs(r_known.cvar - r_unknown.cvar) < 1e-9

    def test_percentile_01_uses_larger_factor(self):
        inp_01 = CVaRInput(ticker="7203", ev_final=0.08, volatility=0.20, percentile=0.01)
        inp_05 = CVaRInput(ticker="7203", ev_final=0.08, volatility=0.20, percentile=0.05)
        r_01 = _ESTIMATOR.estimate(inp_01)
        r_05 = _ESTIMATOR.estimate(inp_05)
        assert r_01.cvar < r_05.cvar


# ── TestEdgeCases ─────────────────────────────────────────────────────────────

class TestCVaREdgeCases:
    def test_ticker_preserved(self):
        inp = CVaRInput(ticker="9984", ev_final=0.08, volatility=0.20)
        r = _ESTIMATOR.estimate(inp)
        assert r.ticker == "9984"

    def test_ev_final_preserved(self):
        inp = CVaRInput(ticker="7203", ev_final=0.12, volatility=0.20)
        r = _ESTIMATOR.estimate(inp)
        assert abs(r.ev_final - 0.12) < 1e-9

    def test_no_forbidden_imports(self):
        import backend.engine.decision.cvar_estimator as mod
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
        ]
        for item in forbidden:
            assert item not in src_imports, f"禁止 import が含まれている: {item}"
