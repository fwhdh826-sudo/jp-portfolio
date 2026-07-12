"""
Shared helpers for Routine modules (R1-R10) — Card 2-7.5

Consolidates _build_safe_mode_input and _build_recovery_entry patterns
duplicated across R1/R2/R3/R4/R5.

Phase 3 connection point: pass crisis_regime from regime_state.json and
tier_a_t3_violated from HardGateResult into build_safe_mode_input kwargs.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from backend.engine.operation.data_freshness import FreshnessResult
from backend.engine.operation.watchdog import WatchdogResult
from backend.engine.operation.safe_mode import SafeModeInput, SafeModeResult
from backend.engine.operation.recovery_log_writer import RecoveryLogEntry, build_recovery_entry


def build_safe_mode_input(
    freshness: FreshnessResult,
    watchdog: WatchdogResult,
    *,
    crisis_regime: bool = False,
    tier_a_t3_violated: bool = False,
) -> SafeModeInput:
    """Build SafeModeInput from freshness and watchdog results.

    crisis_regime: Phase 3+ — set True when regime_state.json reports regime == "crisis".
    tier_a_t3_violated: Phase 5+ — set True from HardGateResult.safe_mode_recommended (T3 only).
    """
    return SafeModeInput(
        tier1_data_stale=freshness.safe_mode_triggered,
        tier_a_t3_violated=tier_a_t3_violated,
        crisis_regime=crisis_regime,
        system_error=watchdog.system_error,
    )


def build_routine_recovery_entry(
    safe_mode: SafeModeResult,
    watchdog: WatchdogResult,
    existing: list[RecoveryLogEntry],
    now: datetime,
    *,
    watchdog_critical: bool,
    label: str,
    action_watchdog: str,
    action_safe_mode: str,
) -> Optional[RecoveryLogEntry]:
    """Build a RecoveryLogEntry for routines with a watchdog/safe_mode issue pattern.

    Returns None when neither safe_mode.active nor watchdog_critical is True.
    Watchdog root cause takes priority: when watchdog triggers safe_mode, the entry
    reflects the actual failing source.

    watchdog_critical: caller supplies watchdog.any_critical or watchdog.system_error
                       depending on the routine's monitoring scope.
    label: routine display label for message strings (e.g. "Morning", "Intraday").
    action_watchdog: action_taken string for the watchdog branch.
    action_safe_mode: action_taken string for the safe_mode branch (pre-formatted by caller).
    """
    if not (safe_mode.active or watchdog_critical):
        return None

    if watchdog_critical:
        critical_sources = [n for n, r in watchdog.sources.items() if r.status == "critical"]
        source = critical_sources[0] if critical_sources else "operation"
        return build_recovery_entry(
            source=source,
            error_type="watchdog_critical",
            message=f"{label} watchdog critical sources: {critical_sources}",
            action_taken=action_watchdog,
            occurred_at=now,
            resolved_at=None,
            safe_mode_triggered=safe_mode.active,
            existing_entries=existing,
        )

    return build_recovery_entry(
        source="operation",
        error_type="safe_mode_activated",
        message=f"{label} SAFE_MODE active: trigger={safe_mode.trigger_reason}",
        action_taken=action_safe_mode,
        occurred_at=now,
        resolved_at=None,
        safe_mode_triggered=safe_mode.active,
        existing_entries=existing,
    )
