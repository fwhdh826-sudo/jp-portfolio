"""
Safe Mode — Card 2-2
Detection-only. No orders, no writes, no external calls, no notifications.
All results carry read-only semantics: final execution decisions are the user's.

SAFE_MODE trigger conditions (PRINCIPLES.md Section 3 / safe_mode.json contract):
  tier1_data_stale   : Tier 1 data stale (from data_freshness.py) → new_buys_frozen
  tier_a_t3_violated : PF DD ≤ -30% T3 Hard Gate (from tier_a_hard_gate.py) → new_buys_frozen + rebalance_frozen
  crisis_regime      : regime == "crisis" (REGIME.md) → new_buys_frozen + rebalance_frozen
  system_error       : watchdog consecutive-failure threshold reached → new_buys_frozen

T4 (VIX>40 AND 日経3日連続-2%) is NOT a SAFE_MODE active trigger.
It sets force_sell_active=True independently (scale_down_risk_50pct_recommended).
Pass via t4_violated kwarg to evaluate_safe_mode.

Reference: docs/constitution/PRINCIPLES.md Section 3
Reference: public/data/contracts/v13.3/operation/safe_mode.json
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

# ── Restriction rule matrix ──────────────────────────────────────────────────
# active            = tier1_data_stale OR tier_a_t3_violated OR crisis_regime OR system_error
# new_buys_frozen   = active
# rebalance_frozen  = tier_a_t3_violated OR crisis_regime
# force_sell_active = t4_violated kwarg  (independent of active)

TRIGGER_TIER1_STALE: str = "tier1_data_stale"
TRIGGER_T3: str = "tier_a_t3_violated"
TRIGGER_CRISIS: str = "crisis_regime"
TRIGGER_SYSTEM_ERROR: str = "system_error"


# ── Input ────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class SafeModeInput:
    tier1_data_stale: bool      # FreshnessResult.safe_mode_triggered から抽出して渡す
    tier_a_t3_violated: bool    # HardGateResult.safe_mode_recommended (T3のみ)
                                # MUST be False when Capitulation Signal exception is active
    crisis_regime: bool         # regime == "crisis" (REGIME.md)
    system_error: bool          # WatchdogResult.system_error から抽出して渡す


# ── Output ───────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class SafeModeRestrictions:
    new_buys_frozen: bool       # SAFE_MODE active 時に True
    rebalance_frozen: bool      # T3 or crisis_regime のとき True
    force_sell_active: bool     # T4 violated のとき True (active とは独立)


@dataclass(frozen=True)
class SafeModeResult:
    """Immutable result of evaluate_safe_mode.

    triggered_at and estimated_resume_at are NOT stored here;
    they are writer concerns for Card 2-4 (recovery_log + system_status.json).
    """
    active: bool
    trigger_conditions: SafeModeInput
    restrictions: SafeModeRestrictions
    trigger_reason: Optional[str]         # TRIGGER_* constant (machine-readable); None if inactive
    trigger_reason_detail: Optional[str]  # human-readable explanation; None if inactive
    checked_at: datetime


# ── Evaluator ────────────────────────────────────────────────────────────────

def evaluate_safe_mode(
    safe_mode_input: SafeModeInput,
    *,
    t4_violated: bool = False,
    now: Optional[datetime] = None,
) -> SafeModeResult:
    """Evaluate SAFE_MODE trigger conditions and return SafeModeResult.

    Detection-only: no writes, no side effects, no notifications.
    Caller is responsible for extracting bool fields from FreshnessResult /
    HardGateResult / WatchdogResult before passing SafeModeInput.

    t4_violated: pass True when Tier A T4 gate fires (VIX>40 AND 日経3日連続-2%).
                 Sets force_sell_active=True independently of SAFE_MODE active flag.
    """
    if now is None:
        now = datetime.now(timezone.utc)

    active = (
        safe_mode_input.tier1_data_stale
        or safe_mode_input.tier_a_t3_violated
        or safe_mode_input.crisis_regime
        or safe_mode_input.system_error
    )

    new_buys_frozen = active
    rebalance_frozen = safe_mode_input.tier_a_t3_violated or safe_mode_input.crisis_regime
    force_sell_active = t4_violated

    restrictions = SafeModeRestrictions(
        new_buys_frozen=new_buys_frozen,
        rebalance_frozen=rebalance_frozen,
        force_sell_active=force_sell_active,
    )

    trigger_reason: Optional[str] = None
    trigger_reason_detail: Optional[str] = None
    if active:
        if safe_mode_input.tier1_data_stale:
            trigger_reason = TRIGGER_TIER1_STALE
            trigger_reason_detail = "Tier 1 data stale — market/regime/news freshness exceeded max_age"
        elif safe_mode_input.tier_a_t3_violated:
            trigger_reason = TRIGGER_T3
            trigger_reason_detail = "T3 violated — PF drawdown ≤ -30% (freeze_all_buys_recommended)"
        elif safe_mode_input.crisis_regime:
            trigger_reason = TRIGGER_CRISIS
            trigger_reason_detail = "crisis_regime detected — all new buys and rebalance frozen"
        elif safe_mode_input.system_error:
            trigger_reason = TRIGGER_SYSTEM_ERROR
            trigger_reason_detail = "system_error — watchdog consecutive-failure threshold reached"

    return SafeModeResult(
        active=active,
        trigger_conditions=safe_mode_input,
        restrictions=restrictions,
        trigger_reason=trigger_reason,
        trigger_reason_detail=trigger_reason_detail,
        checked_at=now,
    )
