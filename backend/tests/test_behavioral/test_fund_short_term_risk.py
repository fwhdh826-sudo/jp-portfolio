"""
test_fund_short_term_risk.py — Card 6-8
FundShortTermCalculator のユニットテスト。
"""
import math
import pytest

from engine.behavioral.fund_short_term_risk import (
    FundShortTermInput,
    FundShortTermResult,
    FundShortTermCalculator,
    _safe_float,
    _safe_int,
    _clamp,
    VIX_THRESHOLD,
    PANIC_RETURN_THRESHOLD,
    RSI_OVERSOLD_THRESHOLD,
    VOLUME_RATIO_THRESHOLD,
    PROFIT_THRESHOLD,
    LOSS_THRESHOLD,
    HOLDING_DAYS_THRESHOLD,
    CONFIDENCE_THRESHOLD,
    VOLATILITY_SPREAD_THRESHOLD,
)


# ── helper tests ──────────────────────────────────────────────────────────────

class TestSafeFloat:
    def test_none_returns_fallback(self):
        assert _safe_float(None, 99.0) == pytest.approx(99.0)

    def test_str_returns_fallback(self):
        assert _safe_float("abc", 1.5) == pytest.approx(1.5)

    def test_nan_returns_fallback(self):
        assert _safe_float(float("nan"), 0.5) == pytest.approx(0.5)

    def test_inf_returns_fallback(self):
        assert _safe_float(float("inf"), 0.0) == pytest.approx(0.0)

    def test_default_fallback_zero(self):
        assert _safe_float(None) == pytest.approx(0.0)

    def test_valid_float(self):
        assert _safe_float(3.14) == pytest.approx(3.14)

    def test_valid_int_converts(self):
        assert _safe_float(5) == pytest.approx(5.0)


class TestSafeInt:
    def test_none_returns_fallback(self):
        assert _safe_int(None, -1) == -1

    def test_str_returns_fallback(self):
        assert _safe_int("abc", 0) == 0

    def test_nan_returns_fallback(self):
        assert _safe_int(float("nan"), -1) == -1

    def test_inf_returns_fallback(self):
        assert _safe_int(float("inf"), 0) == 0

    def test_float_truncates(self):
        assert _safe_int(3.9) == 3

    def test_valid_int(self):
        assert _safe_int(7) == 7


class TestClamp:
    def test_below_min(self):
        assert _clamp(-5.0, 0.0, 10.0) == pytest.approx(0.0)

    def test_above_max(self):
        assert _clamp(15.0, 0.0, 10.0) == pytest.approx(10.0)

    def test_in_range(self):
        assert _clamp(5.0, 0.0, 10.0) == pytest.approx(5.0)


# ── FundShortTermInput tests ──────────────────────────────────────────────────

class TestFundShortTermInput:
    def _base(self, **kwargs):
        defaults = dict(
            vix=20.0,
            nikkei_5d_return=0.0,
            nikkei_rsi_14=50.0,
            nikkei_volume_ratio=1.0,
            current_return=0.0,
            days_since_entry=0,
            os_confidence=0.5,
        )
        defaults.update(kwargs)
        return FundShortTermInput(**defaults)

    def test_frozen(self):
        fi = self._base()
        with pytest.raises((AttributeError, TypeError)):
            fi.vix = 99.0  # type: ignore[misc]

    def test_context_default_empty_dict(self):
        fi = self._base()
        assert fi.context == {}

    def test_context_not_shared(self):
        fi1 = self._base()
        fi2 = self._base()
        assert fi1.context is not fi2.context

    def test_sq_proximity_default_minus_one(self):
        fi = self._base()
        assert fi.sq_proximity_days == -1

    def test_nikkei_vi_default_zero(self):
        fi = self._base()
        assert fi.nikkei_vi == pytest.approx(0.0)


# ── FundShortTermResult tests ─────────────────────────────────────────────────

class TestFundShortTermResult:
    def _result(self, **kwargs):
        defaults = dict(
            conditions_met_count=0,
            vix_condition=False,
            panic_condition=False,
            oversold_condition=False,
            volume_condition=False,
            is_four_condition_environment=False,
            is_three_condition_environment=False,
            profit_threshold_met=False,
            loss_threshold_met=False,
            holding_days_threshold=False,
            bull_bear_threshold_observed=False,
            os_confidence_score=0.5,
            is_confidence_sufficient=False,
            volatility_spread=0.0,
            sq_proximity_days=-1,
            fund_short_term_environment_score=5.0,
            caution_flags=(),
        )
        defaults.update(kwargs)
        return FundShortTermResult(**defaults)

    def test_frozen(self):
        result = self._result()
        with pytest.raises((AttributeError, TypeError)):
            result.conditions_met_count = 99  # type: ignore[misc]

    def test_to_dict_keys(self):
        result = self._result()
        d = result.to_dict()
        expected = {
            "conditions_met_count", "vix_condition", "panic_condition",
            "oversold_condition", "volume_condition",
            "is_four_condition_environment", "is_three_condition_environment",
            "profit_threshold_met", "loss_threshold_met", "holding_days_threshold",
            "bull_bear_threshold_observed", "os_confidence_score",
            "is_confidence_sufficient", "volatility_spread", "sq_proximity_days",
            "fund_short_term_environment_score", "caution_flags",
        }
        assert set(d.keys()) == expected

    def test_to_dict_caution_flags_is_list(self):
        result = self._result(caution_flags=("a", "b"))
        assert isinstance(result.to_dict()["caution_flags"], list)

    def test_no_forbidden_fields(self):
        forbidden = {
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "verdict", "decision", "rating",
            "approve", "reject", "conditional", "final_verdict",
            "order", "amount", "entry_price", "stop_loss", "take_profit",
        }
        result = self._result()
        for f in forbidden:
            assert not hasattr(result, f), f"Forbidden field found: {f}"


# ── FundShortTermCalculator tests ─────────────────────────────────────────────

class TestFundShortTermCalculator:

    @pytest.fixture
    def calc(self):
        return FundShortTermCalculator()

    def _base_input(self, **kwargs):
        defaults = dict(
            vix=20.0,
            nikkei_5d_return=0.0,
            nikkei_rsi_14=50.0,
            nikkei_volume_ratio=1.0,
            current_return=0.0,
            days_since_entry=0,
            os_confidence=0.5,
            nikkei_vi=0.0,
            sq_proximity_days=-1,
        )
        defaults.update(kwargs)
        return FundShortTermInput(**defaults)

    # ── 4条件: vix_condition ──────────────────────────────────────────────────

    def test_vix_condition_true_above_35(self, calc):
        result = calc.calculate(self._base_input(vix=36.0))
        assert result.vix_condition is True

    def test_vix_condition_false_at_35(self, calc):
        result = calc.calculate(self._base_input(vix=35.0))
        assert result.vix_condition is False

    def test_vix_condition_false_below_35(self, calc):
        result = calc.calculate(self._base_input(vix=20.0))
        assert result.vix_condition is False

    # ── 4条件: panic_condition ────────────────────────────────────────────────

    def test_panic_condition_true_below_minus_0_08(self, calc):
        result = calc.calculate(self._base_input(nikkei_5d_return=-0.09))
        assert result.panic_condition is True

    def test_panic_condition_false_at_minus_0_08(self, calc):
        result = calc.calculate(self._base_input(nikkei_5d_return=-0.08))
        assert result.panic_condition is False

    def test_panic_condition_false_above(self, calc):
        result = calc.calculate(self._base_input(nikkei_5d_return=-0.05))
        assert result.panic_condition is False

    # ── 4条件: oversold_condition ─────────────────────────────────────────────

    def test_oversold_condition_true_below_30(self, calc):
        result = calc.calculate(self._base_input(nikkei_rsi_14=29.9))
        assert result.oversold_condition is True

    def test_oversold_condition_false_at_30(self, calc):
        result = calc.calculate(self._base_input(nikkei_rsi_14=30.0))
        assert result.oversold_condition is False

    def test_oversold_condition_false_above(self, calc):
        result = calc.calculate(self._base_input(nikkei_rsi_14=50.0))
        assert result.oversold_condition is False

    # ── 4条件: volume_condition ───────────────────────────────────────────────

    def test_volume_condition_true_above_2(self, calc):
        result = calc.calculate(self._base_input(nikkei_volume_ratio=2.1))
        assert result.volume_condition is True

    def test_volume_condition_false_at_2(self, calc):
        result = calc.calculate(self._base_input(nikkei_volume_ratio=2.0))
        assert result.volume_condition is False

    def test_volume_condition_false_below(self, calc):
        result = calc.calculate(self._base_input(nikkei_volume_ratio=1.5))
        assert result.volume_condition is False

    # ── conditions_met_count ──────────────────────────────────────────────────

    def test_zero_conditions_met(self, calc):
        result = calc.calculate(self._base_input())
        assert result.conditions_met_count == 0

    def test_two_conditions_met(self, calc):
        result = calc.calculate(self._base_input(vix=40.0, nikkei_5d_return=-0.10))
        assert result.conditions_met_count == 2

    def test_four_conditions_met(self, calc):
        result = calc.calculate(self._base_input(
            vix=40.0,
            nikkei_5d_return=-0.10,
            nikkei_rsi_14=25.0,
            nikkei_volume_ratio=3.0,
        ))
        assert result.conditions_met_count == 4

    # ── is_four_condition_environment ─────────────────────────────────────────

    def test_four_condition_environment_true_when_all_met(self, calc):
        result = calc.calculate(self._base_input(
            vix=40.0, nikkei_5d_return=-0.10,
            nikkei_rsi_14=25.0, nikkei_volume_ratio=3.0,
        ))
        assert result.is_four_condition_environment is True

    def test_four_condition_environment_false_when_three(self, calc):
        result = calc.calculate(self._base_input(
            vix=40.0, nikkei_5d_return=-0.10, nikkei_rsi_14=25.0,
        ))
        assert result.is_four_condition_environment is False

    def test_four_condition_not_an_action_field(self, calc):
        result = calc.calculate(self._base_input(
            vix=40.0, nikkei_5d_return=-0.10,
            nikkei_rsi_14=25.0, nikkei_volume_ratio=3.0,
        ))
        # is_four_condition_environment は観察値フラグ。is_buy / is_sell ではない。
        assert not hasattr(result, "is_buy")
        assert not hasattr(result, "is_sell")
        assert not hasattr(result, "action")

    # ── is_three_condition_environment ────────────────────────────────────────

    def test_three_condition_environment_true_when_three_met(self, calc):
        result = calc.calculate(self._base_input(
            vix=40.0, nikkei_5d_return=-0.10, nikkei_rsi_14=25.0,
        ))
        assert result.is_three_condition_environment is True

    def test_three_condition_environment_true_when_four_met(self, calc):
        result = calc.calculate(self._base_input(
            vix=40.0, nikkei_5d_return=-0.10,
            nikkei_rsi_14=25.0, nikkei_volume_ratio=3.0,
        ))
        assert result.is_three_condition_environment is True

    def test_three_condition_environment_false_when_two(self, calc):
        result = calc.calculate(self._base_input(vix=40.0, nikkei_5d_return=-0.10))
        assert result.is_three_condition_environment is False

    # ── profit_threshold_met ──────────────────────────────────────────────────

    def test_profit_threshold_true_at_0_05(self, calc):
        result = calc.calculate(self._base_input(current_return=0.05))
        assert result.profit_threshold_met is True

    def test_profit_threshold_true_above_0_05(self, calc):
        result = calc.calculate(self._base_input(current_return=0.10))
        assert result.profit_threshold_met is True

    def test_profit_threshold_false_below_0_05(self, calc):
        result = calc.calculate(self._base_input(current_return=0.04))
        assert result.profit_threshold_met is False

    # ── loss_threshold_met ────────────────────────────────────────────────────

    def test_loss_threshold_true_at_minus_0_028(self, calc):
        result = calc.calculate(self._base_input(current_return=-0.028))
        assert result.loss_threshold_met is True

    def test_loss_threshold_true_below_minus_0_028(self, calc):
        result = calc.calculate(self._base_input(current_return=-0.05))
        assert result.loss_threshold_met is True

    def test_loss_threshold_false_above_minus_0_028(self, calc):
        result = calc.calculate(self._base_input(current_return=-0.02))
        assert result.loss_threshold_met is False

    # ── holding_days_threshold ────────────────────────────────────────────────

    def test_holding_days_threshold_true_at_2(self, calc):
        result = calc.calculate(self._base_input(days_since_entry=2))
        assert result.holding_days_threshold is True

    def test_holding_days_threshold_true_above_2(self, calc):
        result = calc.calculate(self._base_input(days_since_entry=5))
        assert result.holding_days_threshold is True

    def test_holding_days_threshold_false_below_2(self, calc):
        result = calc.calculate(self._base_input(days_since_entry=1))
        assert result.holding_days_threshold is False

    # ── bull_bear_threshold_observed ──────────────────────────────────────────

    def test_bull_bear_observed_when_holding_and_profit(self, calc):
        result = calc.calculate(self._base_input(days_since_entry=3, current_return=0.06))
        assert result.bull_bear_threshold_observed is True

    def test_bull_bear_observed_when_holding_and_loss(self, calc):
        result = calc.calculate(self._base_input(days_since_entry=3, current_return=-0.03))
        assert result.bull_bear_threshold_observed is True

    def test_bull_bear_not_observed_when_not_holding(self, calc):
        result = calc.calculate(self._base_input(days_since_entry=1, current_return=0.06))
        assert result.bull_bear_threshold_observed is False

    def test_bull_bear_not_observed_when_no_threshold_met(self, calc):
        result = calc.calculate(self._base_input(days_since_entry=3, current_return=0.01))
        assert result.bull_bear_threshold_observed is False

    def test_bull_bear_observed_is_observation_not_sell(self, calc):
        # bull_bear_threshold_observed は観察値フラグ。売却命令ではない。
        result = calc.calculate(self._base_input(days_since_entry=3, current_return=0.06))
        assert result.bull_bear_threshold_observed is True
        assert not hasattr(result, "is_sell")
        assert not hasattr(result, "action")
        assert not hasattr(result, "verdict")

    # ── os_confidence_score / is_confidence_sufficient ───────────────────────

    def test_os_confidence_score_clamped_above_1(self, calc):
        result = calc.calculate(self._base_input(os_confidence=1.5))
        assert result.os_confidence_score == pytest.approx(1.0)

    def test_os_confidence_score_clamped_below_0(self, calc):
        result = calc.calculate(self._base_input(os_confidence=-0.5))
        assert result.os_confidence_score == pytest.approx(0.0)

    def test_os_confidence_score_passthrough(self, calc):
        result = calc.calculate(self._base_input(os_confidence=0.75))
        assert result.os_confidence_score == pytest.approx(0.75)

    def test_is_confidence_sufficient_true_at_0_9(self, calc):
        result = calc.calculate(self._base_input(os_confidence=0.9))
        assert result.is_confidence_sufficient is True

    def test_is_confidence_sufficient_true_above_0_9(self, calc):
        result = calc.calculate(self._base_input(os_confidence=0.95))
        assert result.is_confidence_sufficient is True

    def test_is_confidence_sufficient_false_below_0_9(self, calc):
        result = calc.calculate(self._base_input(os_confidence=0.89))
        assert result.is_confidence_sufficient is False

    def test_is_confidence_sufficient_is_observation_not_execution(self, calc):
        # is_confidence_sufficient は観察値フラグ。実行判定ではない。
        result = calc.calculate(self._base_input(os_confidence=0.95))
        assert result.is_confidence_sufficient is True
        assert not hasattr(result, "is_recommended")
        assert not hasattr(result, "approve")

    # ── volatility_spread ─────────────────────────────────────────────────────

    def test_volatility_spread_calculation(self, calc):
        result = calc.calculate(self._base_input(nikkei_vi=25.0, vix=18.0))
        assert result.volatility_spread == pytest.approx(7.0)

    def test_volatility_spread_negative(self, calc):
        result = calc.calculate(self._base_input(nikkei_vi=15.0, vix=20.0))
        assert result.volatility_spread == pytest.approx(-5.0)

    def test_volatility_spread_zero_default(self, calc):
        result = calc.calculate(self._base_input(vix=20.0))
        assert result.volatility_spread == pytest.approx(-20.0)

    # ── sq_proximity_days ─────────────────────────────────────────────────────

    def test_sq_proximity_days_passthrough(self, calc):
        result = calc.calculate(self._base_input(sq_proximity_days=3))
        assert result.sq_proximity_days == 3

    def test_sq_proximity_days_minus_one_unknown(self, calc):
        result = calc.calculate(self._base_input(sq_proximity_days=-1))
        assert result.sq_proximity_days == -1

    # ── fund_short_term_environment_score ─────────────────────────────────────

    def test_score_zero_baseline(self, calc):
        # vix=nikkei_vi=0 で spread=0、os_confidence=0、条件なし → 0.0
        result = calc.calculate(self._base_input(vix=0.0, nikkei_vi=0.0, os_confidence=0.0))
        assert result.fund_short_term_environment_score == pytest.approx(0.0)

    def test_score_from_conditions_only(self, calc):
        # 2 conditions * 20.0 = 40.0; nikkei_vi=vix で spread=0
        result = calc.calculate(self._base_input(
            vix=40.0, nikkei_5d_return=-0.10, os_confidence=0.0, nikkei_vi=40.0,
        ))
        assert result.fund_short_term_environment_score == pytest.approx(40.0)

    def test_score_from_confidence_only(self, calc):
        # os_confidence=0.6 → 0.6 * 10.0 = 6.0; vix=nikkei_vi で spread=0
        result = calc.calculate(self._base_input(vix=20.0, nikkei_vi=20.0, os_confidence=0.6))
        assert result.fund_short_term_environment_score == pytest.approx(6.0)

    def test_score_increases_with_more_conditions(self, calc):
        r1 = calc.calculate(self._base_input(
            vix=40.0, os_confidence=0.0,
        ))
        r2 = calc.calculate(self._base_input(
            vix=40.0, nikkei_5d_return=-0.10, os_confidence=0.0,
        ))
        assert r2.fund_short_term_environment_score > r1.fund_short_term_environment_score

    def test_score_increases_with_higher_confidence(self, calc):
        r_low  = calc.calculate(self._base_input(os_confidence=0.3))
        r_high = calc.calculate(self._base_input(os_confidence=0.8))
        assert r_high.fund_short_term_environment_score > r_low.fund_short_term_environment_score

    def test_sq_very_near_adds_5(self, calc):
        r_far  = calc.calculate(self._base_input(sq_proximity_days=-1, os_confidence=0.0))
        r_near = calc.calculate(self._base_input(sq_proximity_days=1,  os_confidence=0.0))
        assert r_near.fund_short_term_environment_score == pytest.approx(
            r_far.fund_short_term_environment_score + 5.0
        )

    def test_sq_near_adds_3(self, calc):
        r_far  = calc.calculate(self._base_input(sq_proximity_days=-1, os_confidence=0.0))
        r_near = calc.calculate(self._base_input(sq_proximity_days=4,  os_confidence=0.0))
        assert r_near.fund_short_term_environment_score == pytest.approx(
            r_far.fund_short_term_environment_score + 3.0
        )

    def test_sq_zero_adds_5(self, calc):
        r_far  = calc.calculate(self._base_input(sq_proximity_days=-1, os_confidence=0.0))
        r_near = calc.calculate(self._base_input(sq_proximity_days=0,  os_confidence=0.0))
        assert r_near.fund_short_term_environment_score == pytest.approx(
            r_far.fund_short_term_environment_score + 5.0
        )

    def test_sq_day_6_adds_0(self, calc):
        r_far  = calc.calculate(self._base_input(sq_proximity_days=-1, os_confidence=0.0))
        r_sq6  = calc.calculate(self._base_input(sq_proximity_days=6,  os_confidence=0.0))
        assert r_sq6.fund_short_term_environment_score == pytest.approx(
            r_far.fund_short_term_environment_score
        )

    def test_volatility_spread_adds_5(self, calc):
        r_low  = calc.calculate(self._base_input(nikkei_vi=0.0, vix=0.0, os_confidence=0.0))
        r_high = calc.calculate(self._base_input(nikkei_vi=10.0, vix=0.0, os_confidence=0.0))
        assert r_high.fund_short_term_environment_score == pytest.approx(
            r_low.fund_short_term_environment_score + 5.0
        )

    def test_volatility_spread_abs_negative_adds_5(self, calc):
        # abs(-8) = 8 >= 5.0 → add 5
        r_low  = calc.calculate(self._base_input(nikkei_vi=0.0, vix=0.0, os_confidence=0.0))
        r_high = calc.calculate(self._base_input(nikkei_vi=0.0, vix=8.0, os_confidence=0.0))
        assert r_high.fund_short_term_environment_score == pytest.approx(
            r_low.fund_short_term_environment_score + 5.0
        )

    def test_score_capped_at_100(self, calc):
        result = calc.calculate(self._base_input(
            vix=40.0,
            nikkei_5d_return=-0.10,
            nikkei_rsi_14=25.0,
            nikkei_volume_ratio=3.0,
            os_confidence=1.0,
            nikkei_vi=30.0,
            sq_proximity_days=1,
        ))
        assert result.fund_short_term_environment_score == pytest.approx(100.0)

    def test_score_never_negative(self, calc):
        result = calc.calculate(self._base_input(os_confidence=0.0))
        assert result.fund_short_term_environment_score >= 0.0

    def test_score_is_observation_not_action(self, calc):
        result = calc.calculate(self._base_input(os_confidence=0.5))
        assert not hasattr(result, "action")
        assert not hasattr(result, "is_buy")
        assert not hasattr(result, "is_sell")

    # ── caution_flags ─────────────────────────────────────────────────────────

    def test_no_flags_baseline(self, calc):
        # vix=nikkei_vi で spread=0 にして全フラグを消す
        result = calc.calculate(self._base_input(vix=20.0, nikkei_vi=20.0))
        assert result.caution_flags == ()

    def test_four_condition_flag(self, calc):
        result = calc.calculate(self._base_input(
            vix=40.0, nikkei_5d_return=-0.10,
            nikkei_rsi_14=25.0, nikkei_volume_ratio=3.0,
        ))
        assert any("four short-term conditions" in f for f in result.caution_flags)

    def test_three_condition_flag(self, calc):
        result = calc.calculate(self._base_input(
            vix=40.0, nikkei_5d_return=-0.10, nikkei_rsi_14=25.0,
        ))
        assert any("three or more" in f for f in result.caution_flags)

    def test_four_condition_flag_overrides_three(self, calc):
        result = calc.calculate(self._base_input(
            vix=40.0, nikkei_5d_return=-0.10,
            nikkei_rsi_14=25.0, nikkei_volume_ratio=3.0,
        ))
        # 4条件成立時は four フラグのみ（three フラグは出ない）
        assert any("four short-term conditions" in f for f in result.caution_flags)
        assert not any("three or more" in f for f in result.caution_flags)

    def test_bull_bear_flag(self, calc):
        result = calc.calculate(self._base_input(days_since_entry=3, current_return=0.06))
        assert any("bull/bear threshold" in f for f in result.caution_flags)

    def test_bull_bear_flag_says_not_exit_instruction(self, calc):
        result = calc.calculate(self._base_input(days_since_entry=3, current_return=0.06))
        assert any("not an exit instruction" in f for f in result.caution_flags)

    def test_confidence_flag(self, calc):
        result = calc.calculate(self._base_input(os_confidence=0.95))
        assert any("confidence threshold" in f for f in result.caution_flags)

    def test_sq_very_near_flag(self, calc):
        result = calc.calculate(self._base_input(sq_proximity_days=1))
        assert any("SQ proximity" in f for f in result.caution_flags)

    def test_sq_minus_one_no_sq_flag(self, calc):
        result = calc.calculate(self._base_input(sq_proximity_days=-1))
        assert not any("SQ proximity" in f for f in result.caution_flags)

    def test_volatility_spread_flag(self, calc):
        result = calc.calculate(self._base_input(nikkei_vi=30.0, vix=20.0))
        assert any("volatility spread" in f for f in result.caution_flags)

    def test_caution_flags_is_tuple(self, calc):
        result = calc.calculate(self._base_input(
            vix=40.0, nikkei_5d_return=-0.10,
            nikkei_rsi_14=25.0, nikkei_volume_ratio=3.0,
        ))
        assert isinstance(result.caution_flags, tuple)

    # ── safe fallback: invalid inputs ─────────────────────────────────────────

    def test_none_vix_falls_back_to_zero(self, calc):
        fi = FundShortTermInput(
            vix=None,  # type: ignore[arg-type]
            nikkei_5d_return=0.0, nikkei_rsi_14=50.0,
            nikkei_volume_ratio=1.0, current_return=0.0,
            days_since_entry=0, os_confidence=0.0,
        )
        result = calc.calculate(fi)
        assert result.vix_condition is False

    def test_nan_rsi_falls_back_to_50(self, calc):
        fi = FundShortTermInput(
            vix=20.0, nikkei_5d_return=0.0,
            nikkei_rsi_14=float("nan"),
            nikkei_volume_ratio=1.0, current_return=0.0,
            days_since_entry=0, os_confidence=0.0,
        )
        result = calc.calculate(fi)
        assert result.oversold_condition is False

    def test_invalid_volume_ratio_falls_back_to_1(self, calc):
        fi = FundShortTermInput(
            vix=20.0, nikkei_5d_return=0.0, nikkei_rsi_14=50.0,
            nikkei_volume_ratio="invalid",  # type: ignore[arg-type]
            current_return=0.0, days_since_entry=0, os_confidence=0.0,
        )
        result = calc.calculate(fi)
        assert result.volume_condition is False

    def test_nan_os_confidence_falls_back_to_zero(self, calc):
        fi = FundShortTermInput(
            vix=20.0, nikkei_5d_return=0.0, nikkei_rsi_14=50.0,
            nikkei_volume_ratio=1.0, current_return=0.0,
            days_since_entry=0, os_confidence=float("nan"),
        )
        result = calc.calculate(fi)
        assert result.os_confidence_score == pytest.approx(0.0)

    def test_invalid_days_since_entry_falls_back_to_zero(self, calc):
        fi = FundShortTermInput(
            vix=20.0, nikkei_5d_return=0.0, nikkei_rsi_14=50.0,
            nikkei_volume_ratio=1.0, current_return=0.0,
            days_since_entry=None,  # type: ignore[arg-type]
            os_confidence=0.5,
        )
        result = calc.calculate(fi)
        assert result.holding_days_threshold is False

    def test_invalid_sq_proximity_falls_back_to_minus_one(self, calc):
        fi = FundShortTermInput(
            vix=20.0, nikkei_5d_return=0.0, nikkei_rsi_14=50.0,
            nikkei_volume_ratio=1.0, current_return=0.0,
            days_since_entry=0, os_confidence=0.5,
            sq_proximity_days=float("nan"),  # type: ignore[arg-type]
        )
        result = calc.calculate(fi)
        assert result.sq_proximity_days == -1

    def test_all_invalid_inputs_no_crash(self, calc):
        fi = FundShortTermInput(
            vix=None,  # type: ignore[arg-type]
            nikkei_5d_return=float("nan"),
            nikkei_rsi_14=float("inf"),
            nikkei_volume_ratio="bad",  # type: ignore[arg-type]
            current_return=None,  # type: ignore[arg-type]
            days_since_entry=None,  # type: ignore[arg-type]
            os_confidence=float("nan"),
            nikkei_vi=float("inf"),
            sq_proximity_days=float("nan"),  # type: ignore[arg-type]
        )
        result = calc.calculate(fi)
        assert isinstance(result, FundShortTermResult)
        assert 0.0 <= result.fund_short_term_environment_score <= 100.0

    # ── return type ───────────────────────────────────────────────────────────

    def test_return_type(self, calc):
        result = calc.calculate(self._base_input())
        assert isinstance(result, FundShortTermResult)

    # ── constants ─────────────────────────────────────────────────────────────

    def test_constants(self):
        assert VIX_THRESHOLD == pytest.approx(35.0)
        assert PANIC_RETURN_THRESHOLD == pytest.approx(-0.08)
        assert RSI_OVERSOLD_THRESHOLD == pytest.approx(30.0)
        assert VOLUME_RATIO_THRESHOLD == pytest.approx(2.0)
        assert PROFIT_THRESHOLD == pytest.approx(0.05)
        assert LOSS_THRESHOLD == pytest.approx(-0.028)
        assert HOLDING_DAYS_THRESHOLD == 2
        assert CONFIDENCE_THRESHOLD == pytest.approx(0.9)
        assert VOLATILITY_SPREAD_THRESHOLD == pytest.approx(5.0)

    # ── no forbidden imports ──────────────────────────────────────────────────

    def test_no_forbidden_imports(self):
        import engine.behavioral.fund_short_term_risk as mod
        import sys
        loaded = set(sys.modules.keys())
        forbidden = {
            "pandas", "numpy", "requests", "httpx", "aiohttp",
            "openai", "anthropic", "litellm", "ollama",
        }
        for f in forbidden:
            assert f not in loaded or f not in str(mod.__file__), \
                f"Forbidden module {f} may be imported"
        # operation / market_intel / news / regime は直接 import しない
        source = open(mod.__file__).read()
        for forbidden_mod in ("operation", "market_intel", "news", "regime"):
            assert f"import engine.{forbidden_mod}" not in source
            assert f"from engine.{forbidden_mod}" not in source

    # ── combined scenario ─────────────────────────────────────────────────────

    def test_full_scenario_all_conditions_met(self, calc):
        # 4条件 + 高確信度 + SQ接近 + volatility spread
        result = calc.calculate(FundShortTermInput(
            vix=42.0,
            nikkei_5d_return=-0.12,
            nikkei_rsi_14=22.0,
            nikkei_volume_ratio=3.5,
            current_return=0.06,
            days_since_entry=3,
            os_confidence=0.92,
            nikkei_vi=50.0,
            sq_proximity_days=1,
        ))
        # conditions: 4*20 = 80
        # confidence: 0.92*10 = 9.2
        # sq: 5.0 (day 1, very near)
        # volatility_spread: 50-42=8 >= 5 → 5.0
        # total: 99.2
        assert result.conditions_met_count == 4
        assert result.is_four_condition_environment is True
        assert result.is_three_condition_environment is True
        assert result.bull_bear_threshold_observed is True
        assert result.is_confidence_sufficient is True
        assert result.fund_short_term_environment_score == pytest.approx(99.2)
        assert len(result.caution_flags) >= 4
