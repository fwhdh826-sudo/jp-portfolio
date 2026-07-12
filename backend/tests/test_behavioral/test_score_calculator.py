"""
test_score_calculator.py — Card 6-7
BehavioralScoreCalculator のユニットテスト。
"""
import math
import pytest

from engine.behavioral.score_calculator import (
    BehavioralInput,
    BehavioralScoreResult,
    BehavioralScoreCalculator,
    _safe_int,
    _safe_float,
    _clamp,
)


# ── helper tests ──────────────────────────────────────────────────────────────

class TestSafeInt:
    def test_none_returns_zero(self):
        assert _safe_int(None) == 0

    def test_str_returns_zero(self):
        assert _safe_int("abc") == 0

    def test_nan_returns_zero(self):
        assert _safe_int(float("nan")) == 0

    def test_inf_returns_zero(self):
        assert _safe_int(float("inf")) == 0

    def test_float_truncates(self):
        assert _safe_int(3.9) == 3

    def test_int_passthrough(self):
        assert _safe_int(5) == 5

    def test_negative(self):
        assert _safe_int(-2) == -2


class TestSafeFloat:
    def test_none_returns_zero(self):
        assert _safe_float(None) == 0.0

    def test_str_returns_zero(self):
        assert _safe_float("abc") == 0.0

    def test_nan_returns_zero(self):
        assert _safe_float(float("nan")) == 0.0

    def test_inf_returns_zero(self):
        assert _safe_float(float("inf")) == 0.0

    def test_float_passthrough(self):
        assert _safe_float(0.25) == pytest.approx(0.25)

    def test_int_converts(self):
        assert _safe_float(3) == pytest.approx(3.0)


class TestClamp:
    def test_below_min(self):
        assert _clamp(-1.0, 0.0, 10.0) == pytest.approx(0.0)

    def test_above_max(self):
        assert _clamp(15.0, 0.0, 10.0) == pytest.approx(10.0)

    def test_within_range(self):
        assert _clamp(5.0, 0.0, 10.0) == pytest.approx(5.0)

    def test_boundary_min(self):
        assert _clamp(0.0, 0.0, 10.0) == pytest.approx(0.0)

    def test_boundary_max(self):
        assert _clamp(10.0, 0.0, 10.0) == pytest.approx(10.0)


# ── BehavioralInput tests ─────────────────────────────────────────────────────

class TestBehavioralInput:
    def test_frozen(self):
        bi = BehavioralInput(
            loss_streak=1,
            recent_trade_count=2,
            average_volatility=0.1,
            committee_risk_level="low",
            regime="bull_calm",
        )
        with pytest.raises((AttributeError, TypeError)):
            bi.loss_streak = 99  # type: ignore[misc]

    def test_context_default_empty_dict(self):
        bi = BehavioralInput(
            loss_streak=0,
            recent_trade_count=0,
            average_volatility=0.0,
            committee_risk_level="low",
            regime="bull_calm",
        )
        assert bi.context == {}

    def test_context_not_shared(self):
        bi1 = BehavioralInput(0, 0, 0.0, "low", "bull_calm")
        bi2 = BehavioralInput(0, 0, 0.0, "low", "bull_calm")
        assert bi1.context is not bi2.context


# ── BehavioralScoreResult tests ───────────────────────────────────────────────

class TestBehavioralScoreResult:
    def test_to_dict_keys(self):
        result = BehavioralScoreResult(
            behavioral_score=50.0,
            overtrade_risk=0.3,
            loss_aversion_risk=0.2,
            caution_flags=("flag1",),
            is_elevated_risk=False,
        )
        d = result.to_dict()
        assert set(d.keys()) == {
            "behavioral_score", "overtrade_risk", "loss_aversion_risk",
            "caution_flags", "is_elevated_risk",
        }

    def test_to_dict_caution_flags_is_list(self):
        result = BehavioralScoreResult(50.0, 0.3, 0.2, ("a", "b"), False)
        assert isinstance(result.to_dict()["caution_flags"], list)

    def test_no_forbidden_fields(self):
        forbidden = {
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "verdict", "decision", "rating",
            "approve", "reject", "conditional",
        }
        result = BehavioralScoreResult(50.0, 0.3, 0.2, (), False)
        for f in forbidden:
            assert not hasattr(result, f), f"Forbidden field found: {f}"


# ── BehavioralScoreCalculator tests ──────────────────────────────────────────

class TestBehavioralScoreCalculator:

    @pytest.fixture
    def calc(self):
        return BehavioralScoreCalculator()

    def _base_input(self, **kwargs):
        defaults = dict(
            loss_streak=0,
            recent_trade_count=0,
            average_volatility=0.0,
            committee_risk_level="low",
            regime="bull_calm",
        )
        defaults.update(kwargs)
        return BehavioralInput(**defaults)

    # ── zero baseline ─────────────────────────────────────────────────────────

    def test_all_zero_baseline(self, calc):
        result = calc.calculate(self._base_input())
        assert result.behavioral_score == pytest.approx(0.0)
        assert result.overtrade_risk == pytest.approx(0.0)
        assert result.loss_aversion_risk == pytest.approx(0.0)
        assert result.is_elevated_risk is False
        assert result.caution_flags == ()

    # ── loss_aversion_component ───────────────────────────────────────────────

    def test_loss_streak_3_gives_45(self, calc):
        result = calc.calculate(self._base_input(loss_streak=3))
        assert result.behavioral_score == pytest.approx(45.0)

    def test_loss_streak_capped_at_3(self, calc):
        r3 = calc.calculate(self._base_input(loss_streak=3))
        r9 = calc.calculate(self._base_input(loss_streak=9))
        assert r3.behavioral_score == pytest.approx(r9.behavioral_score)

    def test_loss_streak_1_adds_15(self, calc):
        result = calc.calculate(self._base_input(loss_streak=1))
        assert result.behavioral_score == pytest.approx(15.0)

    def test_loss_aversion_risk_formula(self, calc):
        result = calc.calculate(self._base_input(loss_streak=5))
        assert result.loss_aversion_risk == pytest.approx(1.0)

    def test_loss_aversion_risk_partial(self, calc):
        result = calc.calculate(self._base_input(loss_streak=2))
        assert result.loss_aversion_risk == pytest.approx(0.4)

    # ── overtrade_component ───────────────────────────────────────────────────

    def test_recent_trade_count_5_adds_40(self, calc):
        result = calc.calculate(self._base_input(recent_trade_count=5))
        assert result.behavioral_score == pytest.approx(40.0)

    def test_overtrade_capped_at_5(self, calc):
        r5 = calc.calculate(self._base_input(recent_trade_count=5))
        r9 = calc.calculate(self._base_input(recent_trade_count=9))
        assert r5.behavioral_score == pytest.approx(r9.behavioral_score)

    def test_overtrade_risk_formula(self, calc):
        result = calc.calculate(self._base_input(recent_trade_count=10))
        assert result.overtrade_risk == pytest.approx(1.0)

    def test_overtrade_risk_partial(self, calc):
        result = calc.calculate(self._base_input(recent_trade_count=3))
        assert result.overtrade_risk == pytest.approx(0.3)

    # ── volatility_component ──────────────────────────────────────────────────

    def test_volatility_adds_to_score(self, calc):
        result = calc.calculate(self._base_input(average_volatility=0.25))
        assert result.behavioral_score == pytest.approx(5.0)

    def test_volatility_capped_at_0_5(self, calc):
        r_half = calc.calculate(self._base_input(average_volatility=0.5))
        r_high = calc.calculate(self._base_input(average_volatility=2.0))
        assert r_half.behavioral_score == pytest.approx(r_high.behavioral_score)

    def test_volatility_max_component_10(self, calc):
        result = calc.calculate(self._base_input(average_volatility=1.0))
        assert result.behavioral_score == pytest.approx(10.0)

    # ── regime_component ──────────────────────────────────────────────────────

    def test_regime_crisis_adds_15(self, calc):
        result = calc.calculate(self._base_input(regime="crisis"))
        assert result.behavioral_score == pytest.approx(15.0)

    def test_regime_bear_adds_10(self, calc):
        result = calc.calculate(self._base_input(regime="bear"))
        assert result.behavioral_score == pytest.approx(10.0)

    def test_regime_bull_volatile_adds_5(self, calc):
        result = calc.calculate(self._base_input(regime="bull_volatile"))
        assert result.behavioral_score == pytest.approx(5.0)

    def test_regime_bull_calm_adds_0(self, calc):
        result = calc.calculate(self._base_input(regime="bull_calm"))
        assert result.behavioral_score == pytest.approx(0.0)

    def test_regime_uncertain_adds_0(self, calc):
        result = calc.calculate(self._base_input(regime="uncertain"))
        assert result.behavioral_score == pytest.approx(0.0)

    # ── committee_component ───────────────────────────────────────────────────

    def test_committee_high_adds_10(self, calc):
        result = calc.calculate(self._base_input(committee_risk_level="high"))
        assert result.behavioral_score == pytest.approx(10.0)

    def test_committee_moderate_adds_5(self, calc):
        result = calc.calculate(self._base_input(committee_risk_level="moderate"))
        assert result.behavioral_score == pytest.approx(5.0)

    def test_committee_low_adds_0(self, calc):
        result = calc.calculate(self._base_input(committee_risk_level="low"))
        assert result.behavioral_score == pytest.approx(0.0)

    def test_committee_invalid_falls_back_to_low(self, calc):
        result = calc.calculate(self._base_input(committee_risk_level="unknown"))
        assert result.behavioral_score == pytest.approx(0.0)

    # ── behavioral_score clamp ────────────────────────────────────────────────

    def test_max_score_capped_at_100(self, calc):
        result = calc.calculate(
            self._base_input(
                loss_streak=9,
                recent_trade_count=9,
                average_volatility=2.0,
                committee_risk_level="high",
                regime="crisis",
            )
        )
        assert result.behavioral_score == pytest.approx(100.0)

    def test_score_never_negative(self, calc):
        result = calc.calculate(self._base_input(loss_streak=-5, recent_trade_count=-3))
        assert result.behavioral_score >= 0.0

    # ── is_elevated_risk ─────────────────────────────────────────────────────

    def test_is_elevated_risk_false_below_60(self, calc):
        result = calc.calculate(self._base_input(loss_streak=1))
        assert result.behavioral_score < 60.0
        assert result.is_elevated_risk is False

    def test_is_elevated_risk_true_at_60(self, calc):
        # loss_streak=3→45, recent_trade_count=2→16 → sum=61 > 60
        result = calc.calculate(self._base_input(loss_streak=3, recent_trade_count=2))
        assert result.behavioral_score >= 60.0
        assert result.is_elevated_risk is True

    def test_is_elevated_risk_at_exact_60(self, calc):
        # crisis(15) + bear is excluded; use: loss_streak=3(45) + recent(2*8=16) - 1?
        # loss_streak=4 → capped 45, recent_trade_count=0 + regime=crisis(15) = 60
        result = calc.calculate(self._base_input(loss_streak=3, regime="crisis"))
        assert result.behavioral_score == pytest.approx(60.0)
        assert result.is_elevated_risk is True

    # ── caution_flags ─────────────────────────────────────────────────────────

    def test_no_flags_when_zero(self, calc):
        result = calc.calculate(self._base_input())
        assert result.caution_flags == ()

    def test_loss_streak_1_flag(self, calc):
        result = calc.calculate(self._base_input(loss_streak=1))
        assert any("loss_streak=1" in f for f in result.caution_flags)

    def test_loss_streak_3_elevated_flag(self, calc):
        result = calc.calculate(self._base_input(loss_streak=3))
        assert any("elevated" in f for f in result.caution_flags)

    def test_trade_count_3_flag(self, calc):
        result = calc.calculate(self._base_input(recent_trade_count=3))
        assert any("recent_trade_count=3" in f for f in result.caution_flags)

    def test_trade_count_5_elevated_flag(self, calc):
        result = calc.calculate(self._base_input(recent_trade_count=5))
        assert any("elevated" in f for f in result.caution_flags)

    def test_high_volatility_flag(self, calc):
        result = calc.calculate(self._base_input(average_volatility=0.35))
        assert any("volatility" in f for f in result.caution_flags)

    def test_crisis_regime_flag(self, calc):
        result = calc.calculate(self._base_input(regime="crisis"))
        assert any("regime=crisis" in f for f in result.caution_flags)

    def test_bear_regime_flag(self, calc):
        result = calc.calculate(self._base_input(regime="bear"))
        assert any("regime=bear" in f for f in result.caution_flags)

    def test_committee_high_flag(self, calc):
        result = calc.calculate(self._base_input(committee_risk_level="high"))
        assert any("committee_risk_level=high" in f for f in result.caution_flags)

    # ── safe input conversion ─────────────────────────────────────────────────

    def test_none_loss_streak_treated_as_zero(self, calc):
        bi = BehavioralInput(
            loss_streak=None,  # type: ignore[arg-type]
            recent_trade_count=0,
            average_volatility=0.0,
            committee_risk_level="low",
            regime="bull_calm",
        )
        result = calc.calculate(bi)
        assert result.behavioral_score == pytest.approx(0.0)

    def test_nan_recent_trade_count_treated_as_zero(self, calc):
        bi = BehavioralInput(
            loss_streak=0,
            recent_trade_count=float("nan"),  # type: ignore[arg-type]
            average_volatility=0.0,
            committee_risk_level="low",
            regime="bull_calm",
        )
        result = calc.calculate(bi)
        assert result.overtrade_risk == pytest.approx(0.0)

    def test_negative_inputs_clamped(self, calc):
        bi = BehavioralInput(
            loss_streak=-3,
            recent_trade_count=-5,
            average_volatility=-0.5,
            committee_risk_level="low",
            regime="bull_calm",
        )
        result = calc.calculate(bi)
        assert result.behavioral_score == pytest.approx(0.0)

    # ── combined component test ───────────────────────────────────────────────

    def test_combined_components(self, calc):
        # loss_streak=2 → 30.0
        # recent_trade_count=3 → 24.0
        # average_volatility=0.25 → 5.0
        # regime=bear → 10.0
        # committee=moderate → 5.0
        # total = 74.0
        result = calc.calculate(BehavioralInput(
            loss_streak=2,
            recent_trade_count=3,
            average_volatility=0.25,
            committee_risk_level="moderate",
            regime="bear",
        ))
        assert result.behavioral_score == pytest.approx(74.0)
        assert result.is_elevated_risk is True

    def test_return_type(self, calc):
        result = calc.calculate(self._base_input())
        assert isinstance(result, BehavioralScoreResult)
