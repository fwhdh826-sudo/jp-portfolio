"""
Card 2-2 — Safe Mode テスト
Detection-only であることを担保するテスト群。
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta

from backend.engine.operation.safe_mode import (
    TRIGGER_TIER1_STALE,
    TRIGGER_T3,
    TRIGGER_CRISIS,
    TRIGGER_SYSTEM_ERROR,
    SafeModeInput,
    SafeModeRestrictions,
    SafeModeResult,
    evaluate_safe_mode,
)

# ── Helpers ──────────────────────────────────────────────────────────────────

TZ_JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 4, 28, 7, 0, 0, tzinfo=TZ_JST)


def _input(
    tier1_stale: bool = False,
    t3: bool = False,
    crisis: bool = False,
    sys_err: bool = False,
) -> SafeModeInput:
    return SafeModeInput(
        tier1_data_stale=tier1_stale,
        tier_a_t3_violated=t3,
        crisis_regime=crisis,
        system_error=sys_err,
    )


# ── TestSafeModeInactive ─────────────────────────────────────────────────────

class TestSafeModeInactive:

    def test_all_false_active_is_false(self):
        result = evaluate_safe_mode(_input(), now=NOW)
        assert result.active is False

    def test_all_false_restrictions_all_false(self):
        result = evaluate_safe_mode(_input(), now=NOW)
        assert result.restrictions.new_buys_frozen is False
        assert result.restrictions.rebalance_frozen is False
        assert result.restrictions.force_sell_active is False

    def test_all_false_trigger_reason_is_none(self):
        result = evaluate_safe_mode(_input(), now=NOW)
        assert result.trigger_reason is None

    def test_all_false_trigger_reason_detail_is_none(self):
        result = evaluate_safe_mode(_input(), now=NOW)
        assert result.trigger_reason_detail is None


# ── TestTier1Stale ────────────────────────────────────────────────────────────

class TestTier1Stale:

    def test_tier1_stale_activates_safe_mode(self):
        result = evaluate_safe_mode(_input(tier1_stale=True), now=NOW)
        assert result.active is True

    def test_tier1_stale_freezes_new_buys(self):
        result = evaluate_safe_mode(_input(tier1_stale=True), now=NOW)
        assert result.restrictions.new_buys_frozen is True

    def test_tier1_stale_does_not_freeze_rebalance(self):
        result = evaluate_safe_mode(_input(tier1_stale=True), now=NOW)
        assert result.restrictions.rebalance_frozen is False

    def test_tier1_stale_does_not_set_force_sell(self):
        result = evaluate_safe_mode(_input(tier1_stale=True), now=NOW)
        assert result.restrictions.force_sell_active is False

    def test_tier1_stale_trigger_reason_constant(self):
        result = evaluate_safe_mode(_input(tier1_stale=True), now=NOW)
        assert result.trigger_reason == TRIGGER_TIER1_STALE


# ── TestT3Violated ────────────────────────────────────────────────────────────

class TestT3Violated:

    def test_t3_activates_safe_mode(self):
        result = evaluate_safe_mode(_input(t3=True), now=NOW)
        assert result.active is True

    def test_t3_freezes_new_buys(self):
        result = evaluate_safe_mode(_input(t3=True), now=NOW)
        assert result.restrictions.new_buys_frozen is True

    def test_t3_freezes_rebalance(self):
        result = evaluate_safe_mode(_input(t3=True), now=NOW)
        assert result.restrictions.rebalance_frozen is True

    def test_t3_does_not_set_force_sell(self):
        result = evaluate_safe_mode(_input(t3=True), now=NOW)
        assert result.restrictions.force_sell_active is False

    def test_t3_trigger_reason_constant(self):
        result = evaluate_safe_mode(_input(t3=True), now=NOW)
        assert result.trigger_reason == TRIGGER_T3


# ── TestCrisisRegime ──────────────────────────────────────────────────────────

class TestCrisisRegime:

    def test_crisis_activates_safe_mode(self):
        result = evaluate_safe_mode(_input(crisis=True), now=NOW)
        assert result.active is True

    def test_crisis_freezes_new_buys(self):
        result = evaluate_safe_mode(_input(crisis=True), now=NOW)
        assert result.restrictions.new_buys_frozen is True

    def test_crisis_freezes_rebalance(self):
        result = evaluate_safe_mode(_input(crisis=True), now=NOW)
        assert result.restrictions.rebalance_frozen is True

    def test_crisis_does_not_set_force_sell(self):
        result = evaluate_safe_mode(_input(crisis=True), now=NOW)
        assert result.restrictions.force_sell_active is False

    def test_crisis_trigger_reason_constant(self):
        result = evaluate_safe_mode(_input(crisis=True), now=NOW)
        assert result.trigger_reason == TRIGGER_CRISIS


# ── TestSystemError ───────────────────────────────────────────────────────────

class TestSystemError:

    def test_system_error_activates_safe_mode(self):
        result = evaluate_safe_mode(_input(sys_err=True), now=NOW)
        assert result.active is True

    def test_system_error_freezes_new_buys(self):
        result = evaluate_safe_mode(_input(sys_err=True), now=NOW)
        assert result.restrictions.new_buys_frozen is True

    def test_system_error_does_not_freeze_rebalance(self):
        result = evaluate_safe_mode(_input(sys_err=True), now=NOW)
        assert result.restrictions.rebalance_frozen is False

    def test_system_error_trigger_reason_constant(self):
        result = evaluate_safe_mode(_input(sys_err=True), now=NOW)
        assert result.trigger_reason == TRIGGER_SYSTEM_ERROR


# ── TestT4Violated ────────────────────────────────────────────────────────────

class TestT4Violated:

    def test_t4_alone_does_not_activate_safe_mode(self):
        """T4は SAFE_MODE active のトリガーではない（force_sell のみ）"""
        result = evaluate_safe_mode(_input(), t4_violated=True, now=NOW)
        assert result.active is False

    def test_t4_alone_sets_force_sell(self):
        result = evaluate_safe_mode(_input(), t4_violated=True, now=NOW)
        assert result.restrictions.force_sell_active is True

    def test_t4_alone_does_not_freeze_new_buys(self):
        result = evaluate_safe_mode(_input(), t4_violated=True, now=NOW)
        assert result.restrictions.new_buys_frozen is False

    def test_t4_alone_does_not_freeze_rebalance(self):
        result = evaluate_safe_mode(_input(), t4_violated=True, now=NOW)
        assert result.restrictions.rebalance_frozen is False

    def test_t4_with_t3_active_and_force_sell(self):
        result = evaluate_safe_mode(_input(t3=True), t4_violated=True, now=NOW)
        assert result.active is True
        assert result.restrictions.force_sell_active is True
        assert result.restrictions.rebalance_frozen is True

    def test_t4_with_crisis_force_sell_active(self):
        result = evaluate_safe_mode(_input(crisis=True), t4_violated=True, now=NOW)
        assert result.active is True
        assert result.restrictions.force_sell_active is True

    def test_t4_with_tier1_stale_force_sell_active(self):
        result = evaluate_safe_mode(_input(tier1_stale=True), t4_violated=True, now=NOW)
        assert result.active is True
        assert result.restrictions.force_sell_active is True


# ── TestMultipleConditions ────────────────────────────────────────────────────

class TestMultipleConditions:

    def test_all_active_triggers(self):
        result = evaluate_safe_mode(
            _input(tier1_stale=True, t3=True, crisis=True, sys_err=True), now=NOW
        )
        assert result.active is True
        assert result.restrictions.new_buys_frozen is True
        assert result.restrictions.rebalance_frozen is True

    def test_tier1_and_system_error_rebalance_not_frozen(self):
        """tier1_stale + system_error のみ → rebalance_frozen=False（T3/crisis なし）"""
        result = evaluate_safe_mode(_input(tier1_stale=True, sys_err=True), now=NOW)
        assert result.active is True
        assert result.restrictions.rebalance_frozen is False

    def test_trigger_reason_priority_tier1_over_t3(self):
        """tier1_stale が T3 より優先して trigger_reason に記載される"""
        result = evaluate_safe_mode(_input(tier1_stale=True, t3=True), now=NOW)
        assert result.trigger_reason == TRIGGER_TIER1_STALE


# ── TestTriggerReasonDetail ───────────────────────────────────────────────────

class TestTriggerReasonDetail:

    def test_tier1_stale_detail_mentions_tier1(self):
        result = evaluate_safe_mode(_input(tier1_stale=True), now=NOW)
        assert result.trigger_reason_detail is not None
        assert "Tier 1" in result.trigger_reason_detail

    def test_t3_detail_mentions_t3(self):
        result = evaluate_safe_mode(_input(t3=True), now=NOW)
        assert result.trigger_reason_detail is not None
        assert "T3" in result.trigger_reason_detail

    def test_crisis_detail_mentions_crisis(self):
        result = evaluate_safe_mode(_input(crisis=True), now=NOW)
        assert result.trigger_reason_detail is not None
        assert "crisis" in result.trigger_reason_detail.lower()

    def test_system_error_detail_not_none(self):
        result = evaluate_safe_mode(_input(sys_err=True), now=NOW)
        assert result.trigger_reason_detail is not None


# ── TestCheckedAt ─────────────────────────────────────────────────────────────

class TestCheckedAt:

    def test_checked_at_equals_now(self):
        result = evaluate_safe_mode(_input(), now=NOW)
        assert result.checked_at == NOW

    def test_trigger_conditions_preserved(self):
        inp = _input(tier1_stale=True, t3=False)
        result = evaluate_safe_mode(inp, now=NOW)
        assert result.trigger_conditions.tier1_data_stale is True
        assert result.trigger_conditions.tier_a_t3_violated is False


# ── TestP15Stateless ──────────────────────────────────────────────────────────

class TestP15Stateless:
    """SafeModeResult は triggered_at / estimated_resume_at を持たない (Card 2-4 の責務)"""

    def test_result_has_no_triggered_at(self):
        result = evaluate_safe_mode(_input(), now=NOW)
        assert not hasattr(result, "triggered_at")

    def test_result_has_no_estimated_resume_at(self):
        result = evaluate_safe_mode(_input(), now=NOW)
        assert not hasattr(result, "estimated_resume_at")


# ── TestDetectionOnly ─────────────────────────────────────────────────────────

class TestDetectionOnly:

    def test_result_has_no_order_field(self):
        result = evaluate_safe_mode(_input(), now=NOW)
        assert not hasattr(result, "order")
        assert not hasattr(result, "action")
        assert not hasattr(result, "trade")

    def test_restrictions_has_no_execute_field(self):
        result = evaluate_safe_mode(_input(), now=NOW)
        assert not hasattr(result.restrictions, "execute")
        assert not hasattr(result.restrictions, "send_notification")
