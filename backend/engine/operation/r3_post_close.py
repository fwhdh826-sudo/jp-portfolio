"""
R3 Post-Close Routine — Card 2-5
End-of-day Operation Health Check. Runs after market close (~15:30 JST).

Orchestrates: evaluate_freshness → evaluate_watchdog → evaluate_safe_mode
  → (optional) send_notification
  → (optional) write_safe_mode_snapshot / write_recovery_log

Scope: all sources (Tier 1/2/3). Notification trigger: any_critical OR safe_mode.active.
This is broader than R2 — Tier 3 issues (correlation / trust) are also flagged at close.

Note: No GitHub Actions schedule exists for R3 yet.
      This module is ready for future YAML wiring.

Detection-only: no trades, no securities API calls.
All writes and notifications require explicit arguments from the caller.

t4_violated: Phase 4+ will compute this from VIX / Nikkei 3-day data.
             Until then, caller passes False (default).

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 2-5
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from backend.engine.operation.data_freshness import (
    FreshnessResult,
    evaluate_freshness,
)
from backend.engine.operation.watchdog import (
    SourceEvent,
    WatchdogResult,
    evaluate_watchdog,
)
from backend.engine.operation.safe_mode import (
    SafeModeResult,
    evaluate_safe_mode,
)
from backend.engine.operation._routine_common import (
    build_safe_mode_input,
    build_routine_recovery_entry,
)
from backend.engine.operation.discord_notifier import (
    DiscordNotifierConfig,
    NotifyResult,
    format_safe_mode_embed,
    format_watchdog_embed,
    send_notification,
)
from backend.engine.operation.recovery_log_writer import (
    RecoveryLogEntry,
    append_recovery_entry,
    write_recovery_log,
    write_safe_mode_snapshot,
)


# ── Result ────────────────────────────────────────────────────────────────────

@dataclass
class PostCloseRoutineResult:
    freshness: FreshnessResult
    watchdog: WatchdogResult
    safe_mode: SafeModeResult
    notify_result: Optional[NotifyResult]        # None when notifier_config is None
    recovery_entry: Optional[RecoveryLogEntry]   # None when no issues detected
    safe_mode_written: bool
    recovery_log_written: bool
    completed_at: datetime


# ── Main routine ──────────────────────────────────────────────────────────────

def run_post_close_routine(
    data_timestamps: dict[str, Optional[datetime]],
    watchdog_events: list[SourceEvent],
    *,
    notifier_config: Optional[DiscordNotifierConfig] = None,
    safe_mode_output_path: Optional[Path] = None,
    recovery_log_output_path: Optional[Path] = None,
    existing_recovery_entries: Optional[list[RecoveryLogEntry]] = None,
    t4_violated: bool = False,          # Phase 4+: compute from VIX / Nikkei 3-day data
    crisis_regime: bool = False,        # Phase 3+: inject from regime_state.json
    tier_a_t3_violated: bool = False,   # Phase 5+: inject from HardGateResult (T3 only)
    now: Optional[datetime] = None,
) -> PostCloseRoutineResult:
    """Run R3 Post-Close Routine: end-of-day full Operation Health Check.

    Detection-only: no trades, no securities API calls.
    Notification triggered when any_critical=True or safe_mode.active=True.
    Files written only if corresponding output_path is provided.
    """
    if now is None:
        now = datetime.now(timezone.utc)
    if existing_recovery_entries is None:
        existing_recovery_entries = []

    # ── 1. Detection pipeline ─────────────────────────────────────────────────
    freshness = evaluate_freshness(data_timestamps, now=now)
    watchdog = evaluate_watchdog(watchdog_events, now=now)
    safe_mode_input = build_safe_mode_input(
        freshness, watchdog,
        crisis_regime=crisis_regime,
        tier_a_t3_violated=tier_a_t3_violated,
    )
    safe_mode = evaluate_safe_mode(safe_mode_input, t4_violated=t4_violated, now=now)

    # ── 2. Discord notification: trigger = any_critical OR safe_mode.active ───
    # R3 uses any_critical (broader than system_error) for end-of-day reporting.
    notify_result: Optional[NotifyResult] = None
    if notifier_config is not None and (watchdog.any_critical or safe_mode.active):
        if safe_mode.active:
            embed = format_safe_mode_embed(safe_mode)
        else:
            embed = format_watchdog_embed(watchdog)
        notify_result = send_notification(notifier_config, embed)

    # ── 3. Recovery log entry ─────────────────────────────────────────────────
    recovery_entry = build_routine_recovery_entry(
        safe_mode, watchdog, existing_recovery_entries, now,
        watchdog_critical=watchdog.any_critical,
        label="Post-close",
        action_watchdog="post_close_watchdog_alert_raised",
        action_safe_mode=(
            f"restrictions: new_buys_frozen={safe_mode.restrictions.new_buys_frozen}, "
            f"rebalance_frozen={safe_mode.restrictions.rebalance_frozen}, "
            f"force_sell_active={safe_mode.restrictions.force_sell_active}"
        ),
    )

    # ── 4. Write safe_mode snapshot ───────────────────────────────────────────
    safe_mode_written = False
    if safe_mode_output_path is not None:
        write_safe_mode_snapshot(safe_mode, safe_mode_output_path)
        safe_mode_written = True

    # ── 5. Write recovery log ─────────────────────────────────────────────────
    recovery_log_written = False
    if recovery_log_output_path is not None and recovery_entry is not None:
        updated_entries = append_recovery_entry(existing_recovery_entries, recovery_entry)
        write_recovery_log(updated_entries, recovery_log_output_path)
        recovery_log_written = True

    return PostCloseRoutineResult(
        freshness=freshness,
        watchdog=watchdog,
        safe_mode=safe_mode,
        notify_result=notify_result,
        recovery_entry=recovery_entry,
        safe_mode_written=safe_mode_written,
        recovery_log_written=recovery_log_written,
        completed_at=now,
    )
