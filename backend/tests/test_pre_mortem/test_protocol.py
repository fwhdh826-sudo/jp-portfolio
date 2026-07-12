"""
test_protocol.py — Card 7-9
PreMortemInput / PreMortemResult / PreMortemProtocol のテスト。
"""
from __future__ import annotations

import json

import pytest

import engine.pre_mortem.protocol as _mod
from engine.pre_mortem.protocol import (
    _CAP_MIN,
    _CAP_TABLE,
    _BEHAVIORAL_CAUTION_COUNT_THRESHOLD,
    _BEHAVIORAL_SCORE_THRESHOLD,
    _CVAR_DEEP_THRESHOLD,
    _DD10_NEGATIVE_THRESHOLD,
    _EXPOSURE_MULTIPLIER_HIGH_THRESHOLD,
    PreMortemInput,
    PreMortemProtocol,
    PreMortemResult,
)


# ── helpers ───────────────────────────────────────────────────────────────────

def _make_input(**kwargs) -> PreMortemInput:
    defaults = dict(
        ticker="7203",
        base_size=0.05,
        behavioral_score=30.0,
        is_elevated_behavioral_risk=False,
        behavioral_caution_count=0,
        committee_risk_level="low",
        committee_is_high_risk=False,
        committee_confidence=0.7,
        exposure_multiplier=1.0,
        is_vol_defined=True,
    )
    defaults.update(kwargs)
    return PreMortemInput(**defaults)


def _conduct(**kwargs) -> PreMortemResult:
    return PreMortemProtocol().conduct(_make_input(**kwargs))


# ── stdlib only ───────────────────────────────────────────────────────────────

class TestStdlibOnly:
    def test_no_numpy_import(self):
        src = open(_mod.__file__).read()
        assert "import numpy" not in src

    def test_no_pandas_import(self):
        src = open(_mod.__file__).read()
        assert "import pandas" not in src

    def test_no_scipy_import(self):
        src = open(_mod.__file__).read()
        assert "import scipy" not in src

    def test_no_llm_call(self):
        src = open(_mod.__file__).read()
        assert "call_llm_json(" not in src

    def test_no_http_import(self):
        src = open(_mod.__file__).read()
        assert "import requests" not in src
        assert "import httpx" not in src

    def test_no_behavioral_import(self):
        src = open(_mod.__file__).read()
        assert "from engine.behavioral" not in src

    def test_no_agents_import(self):
        src = open(_mod.__file__).read()
        assert "from engine.agents" not in src

    def test_no_decision_import(self):
        src = open(_mod.__file__).read()
        assert "from engine.decision" not in src


# ── 禁止フィールド ────────────────────────────────────────────────────────────

class TestForbiddenFields:
    def test_no_approve_field(self):
        assert not hasattr(_conduct(), "approve")

    def test_no_reject_field(self):
        assert not hasattr(_conduct(), "reject")

    def test_no_verdict_field(self):
        assert not hasattr(_conduct(), "verdict")

    def test_no_decision_field(self):
        assert not hasattr(_conduct(), "decision")

    def test_no_action_field(self):
        assert not hasattr(_conduct(), "action")

    def test_no_recommendation_field(self):
        assert not hasattr(_conduct(), "recommendation")

    def test_no_is_buy_field(self):
        assert not hasattr(_conduct(), "is_buy")

    def test_no_is_sell_field(self):
        assert not hasattr(_conduct(), "is_sell")

    def test_no_go_field(self):
        assert not hasattr(_conduct(), "go")

    def test_no_no_go_field(self):
        assert not hasattr(_conduct(), "no_go")

    def test_no_order_field(self):
        assert not hasattr(_conduct(), "order")

    def test_no_pass_fail_field(self):
        assert not hasattr(_conduct(), "pass_fail")


# ── PreMortemInput ────────────────────────────────────────────────────────────

class TestPreMortemInput:
    def test_basic_construction(self):
        inp = _make_input()
        assert inp.ticker == "7203"
        assert inp.base_size == pytest.approx(0.05)
        assert inp.behavioral_score == pytest.approx(30.0)

    def test_base_size_clamped_low(self):
        assert _make_input(base_size=-0.1).base_size == 0.0

    def test_base_size_clamped_high(self):
        assert _make_input(base_size=1.5).base_size == pytest.approx(1.0)

    def test_behavioral_score_clamped_low(self):
        assert _make_input(behavioral_score=-10.0).behavioral_score == 0.0

    def test_behavioral_score_clamped_high(self):
        assert _make_input(behavioral_score=150.0).behavioral_score == pytest.approx(100.0)

    def test_behavioral_caution_count_clamped(self):
        assert _make_input(behavioral_caution_count=-5).behavioral_caution_count == 0

    def test_committee_confidence_clamped_low(self):
        assert _make_input(committee_confidence=-0.5).committee_confidence == 0.0

    def test_committee_confidence_clamped_high(self):
        assert _make_input(committee_confidence=2.0).committee_confidence == pytest.approx(1.0)

    def test_exposure_multiplier_clamped_low(self):
        assert _make_input(exposure_multiplier=-1.0).exposure_multiplier == 0.0

    def test_dd10_none_stays_none(self):
        assert _make_input(dd10_uniform_return=None).dd10_uniform_return is None

    def test_dd10_value_preserved(self):
        assert _make_input(dd10_uniform_return=-0.05).dd10_uniform_return == pytest.approx(-0.05)

    def test_cvar_none_stays_none(self):
        assert _make_input(cvar_value=None).cvar_value is None

    def test_cvar_value_preserved(self):
        assert _make_input(cvar_value=-0.2).cvar_value == pytest.approx(-0.2)

    def test_nan_base_size_becomes_zero(self):
        assert _make_input(base_size=float("nan")).base_size == 0.0

    def test_inf_behavioral_score_safe_float_fallback(self):
        # inf → _safe_float fallback → 0.0 (not 100.0)
        assert _make_input(behavioral_score=float("inf")).behavioral_score == pytest.approx(0.0)

    def test_context_default_empty(self):
        assert _make_input().context == {}

    def test_context_invalid_becomes_empty(self):
        assert _make_input(context="bad").context == {}  # type: ignore

    def test_frozen(self):
        inp = _make_input()
        with pytest.raises((AttributeError, TypeError)):
            inp.ticker = "other"  # type: ignore


# ── _CAP_TABLE ────────────────────────────────────────────────────────────────

class TestCapTable:
    def test_cap_table_zero_cautions(self):
        assert _CAP_TABLE[0] == pytest.approx(1.0)

    def test_cap_table_one_caution(self):
        assert _CAP_TABLE[1] == pytest.approx(0.8)

    def test_cap_table_two_cautions(self):
        assert _CAP_TABLE[2] == pytest.approx(0.6)

    def test_cap_table_three_cautions(self):
        assert _CAP_TABLE[3] == pytest.approx(0.4)

    def test_cap_min_value(self):
        assert _CAP_MIN == pytest.approx(0.2)

    def test_calc_cap_four_cautions_returns_min(self):
        assert PreMortemProtocol()._calc_sizing_multiplier_cap(4) == pytest.approx(_CAP_MIN)

    def test_calc_cap_ten_cautions_returns_min(self):
        assert PreMortemProtocol()._calc_sizing_multiplier_cap(10) == pytest.approx(_CAP_MIN)

    def test_calc_cap_zero(self):
        assert PreMortemProtocol()._calc_sizing_multiplier_cap(0) == pytest.approx(1.0)


# ── PreMortemResult ───────────────────────────────────────────────────────────

class TestPreMortemResult:
    def test_result_is_frozen(self):
        result = _conduct()
        with pytest.raises((AttributeError, TypeError)):
            result.ticker = "other"  # type: ignore

    def test_to_dict_keys(self):
        d = _conduct().to_dict()
        assert set(d.keys()) == {
            "ticker", "sizing_multiplier_cap", "caution_count",
            "is_high_behavioral_risk", "is_high_committee_risk",
            "risk_observation_flags", "diagnostics",
        }

    def test_to_dict_json_serializable(self):
        json.dumps(_conduct().to_dict())  # must not raise

    def test_risk_observation_flags_is_tuple(self):
        assert isinstance(_conduct().risk_observation_flags, tuple)

    def test_diagnostics_is_tuple(self):
        assert isinstance(_conduct().diagnostics, tuple)

    def test_ticker_in_to_dict(self):
        assert _conduct(ticker="9984").to_dict()["ticker"] == "9984"


# ── No-risk baseline ──────────────────────────────────────────────────────────

class TestNoRiskBaseline:
    def test_no_risk_cap_is_one(self):
        assert _conduct().sizing_multiplier_cap == pytest.approx(1.0)

    def test_no_risk_caution_count_zero(self):
        assert _conduct().caution_count == 0

    def test_no_risk_flags_empty(self):
        assert len(_conduct().risk_observation_flags) == 0

    def test_no_risk_is_high_behavioral_false(self):
        assert _conduct(is_elevated_behavioral_risk=False).is_high_behavioral_risk is False

    def test_no_risk_is_high_committee_false(self):
        assert _conduct(committee_is_high_risk=False).is_high_committee_risk is False

    def test_ticker_passthrough(self):
        assert _conduct(ticker="9984").ticker == "9984"


# ── Behavioral risk ───────────────────────────────────────────────────────────

class TestBehavioralRisk:
    def test_behavioral_score_60_exact_triggers(self):
        result = _conduct(behavioral_score=60.0)
        text = " ".join(result.risk_observation_flags)
        assert "behavioral_score=60.0" in text

    def test_behavioral_score_59_9_no_trigger(self):
        result = _conduct(behavioral_score=59.9)
        text = " ".join(result.risk_observation_flags)
        assert "behavioral_score" not in text

    def test_behavioral_score_100_triggers(self):
        result = _conduct(behavioral_score=100.0)
        assert any("behavioral_score" in f for f in result.risk_observation_flags)

    def test_behavioral_caution_count_2_triggers(self):
        result = _conduct(behavioral_caution_count=2)
        assert any(f"behavioral_caution_count=2" in f for f in result.risk_observation_flags)

    def test_behavioral_caution_count_1_no_trigger(self):
        result = _conduct(behavioral_caution_count=1)
        assert not any("behavioral_caution_count" in f for f in result.risk_observation_flags)

    def test_elevated_behavioral_passthrough_true(self):
        assert _conduct(is_elevated_behavioral_risk=True).is_high_behavioral_risk is True

    def test_elevated_behavioral_passthrough_false(self):
        assert _conduct(is_elevated_behavioral_risk=False).is_high_behavioral_risk is False


# ── Committee risk ────────────────────────────────────────────────────────────

class TestCommitteeRisk:
    def test_committee_is_high_risk_triggers(self):
        result = _conduct(committee_is_high_risk=True)
        assert any("committee_is_high_risk=True" in f for f in result.risk_observation_flags)

    def test_committee_low_no_trigger(self):
        result = _conduct(committee_is_high_risk=False, committee_risk_level="low")
        assert not any("committee" in f for f in result.risk_observation_flags)

    def test_committee_risk_level_high_no_is_high_risk(self):
        result = _conduct(committee_is_high_risk=False, committee_risk_level="high")
        assert any("committee_risk_level=high" in f for f in result.risk_observation_flags)

    def test_committee_is_high_risk_passthrough_true(self):
        assert _conduct(committee_is_high_risk=True).is_high_committee_risk is True

    def test_committee_is_high_risk_passthrough_false(self):
        assert _conduct(committee_is_high_risk=False).is_high_committee_risk is False


# ── Vol risk ──────────────────────────────────────────────────────────────────

class TestVolRisk:
    def test_vol_not_defined_triggers(self):
        result = _conduct(is_vol_defined=False)
        assert any("is_vol_defined=False" in f for f in result.risk_observation_flags)

    def test_vol_defined_no_trigger(self):
        result = _conduct(is_vol_defined=True, exposure_multiplier=1.0)
        assert not any("is_vol_defined=False" in f for f in result.risk_observation_flags)

    def test_exposure_multiplier_1_8_exact_triggers(self):
        result = _conduct(exposure_multiplier=1.8)
        assert any("exposure_multiplier=1.800" in f for f in result.risk_observation_flags)

    def test_exposure_multiplier_1_79_no_trigger(self):
        result = _conduct(exposure_multiplier=1.79)
        assert not any("exposure_multiplier" in f for f in result.risk_observation_flags)

    def test_exposure_multiplier_2_0_triggers(self):
        result = _conduct(exposure_multiplier=2.0)
        assert any("exposure_multiplier" in f for f in result.risk_observation_flags)


# ── DD10 / CVaR risk ──────────────────────────────────────────────────────────

class TestDD10CvarRisk:
    def test_dd10_none_no_trigger(self):
        result = _conduct(dd10_uniform_return=None)
        assert not any("dd10" in f for f in result.risk_observation_flags)

    def test_dd10_negative_triggers(self):
        result = _conduct(dd10_uniform_return=-0.03)
        assert any("dd10_uniform_return" in f for f in result.risk_observation_flags)

    def test_dd10_positive_no_trigger(self):
        result = _conduct(dd10_uniform_return=0.05)
        assert not any("dd10_uniform_return" in f for f in result.risk_observation_flags)

    def test_dd10_zero_no_trigger(self):
        result = _conduct(dd10_uniform_return=0.0)
        assert not any("dd10_uniform_return" in f for f in result.risk_observation_flags)

    def test_cvar_none_no_trigger(self):
        result = _conduct(cvar_value=None)
        assert not any("cvar=" in f for f in result.risk_observation_flags)

    def test_cvar_below_threshold_triggers(self):
        result = _conduct(cvar_value=-0.2)
        assert any("cvar=" in f for f in result.risk_observation_flags)

    def test_cvar_above_threshold_no_trigger(self):
        result = _conduct(cvar_value=-0.1)
        assert not any("cvar=" in f for f in result.risk_observation_flags)

    def test_cvar_exactly_threshold_no_trigger(self):
        # -0.15 is not < -0.15
        result = _conduct(cvar_value=-0.15)
        assert not any("cvar=" in f for f in result.risk_observation_flags)


# ── caution_count → cap ───────────────────────────────────────────────────────

class TestCautionCountToCap:
    def test_one_caution_cap_08(self):
        # behavioral_score=80 >= 60 → 1 caution
        result = _conduct(behavioral_score=80.0)
        assert result.caution_count == 1
        assert result.sizing_multiplier_cap == pytest.approx(0.8)

    def test_two_cautions_cap_06(self):
        result = _conduct(behavioral_score=80.0, committee_is_high_risk=True)
        assert result.caution_count == 2
        assert result.sizing_multiplier_cap == pytest.approx(0.6)

    def test_three_cautions_cap_04(self):
        result = _conduct(
            behavioral_score=80.0,
            committee_is_high_risk=True,
            is_vol_defined=False,
        )
        assert result.caution_count == 3
        assert result.sizing_multiplier_cap == pytest.approx(0.4)

    def test_four_cautions_cap_02(self):
        result = _conduct(
            behavioral_score=80.0,
            committee_is_high_risk=True,
            is_vol_defined=False,
            dd10_uniform_return=-0.05,
        )
        assert result.caution_count == 4
        assert result.sizing_multiplier_cap == pytest.approx(0.2)

    def test_many_cautions_still_cap_02(self):
        result = _conduct(
            behavioral_score=80.0,
            behavioral_caution_count=3,
            committee_is_high_risk=True,
            is_vol_defined=False,
            exposure_multiplier=2.0,
            dd10_uniform_return=-0.05,
            cvar_value=-0.3,
        )
        assert result.caution_count >= 4
        assert result.sizing_multiplier_cap == pytest.approx(0.2)


# ── observation: prefix ───────────────────────────────────────────────────────

class TestObservationPrefixes:
    def test_all_risk_flags_have_observation_prefix(self):
        result = _conduct(behavioral_score=80.0, committee_is_high_risk=True)
        for flag in result.risk_observation_flags:
            assert flag.startswith("observation:"), f"Missing prefix: {flag}"

    def test_all_diagnostics_have_observation_prefix(self):
        result = _conduct()
        for d in result.diagnostics:
            assert d.startswith("observation:"), f"Missing prefix: {d}"

    def test_diagnostics_not_empty(self):
        assert len(_conduct().diagnostics) > 0

    def test_diagnostics_contain_calculation_only(self):
        result = _conduct()
        assert any("calculation-only" in d for d in result.diagnostics)
