"""
R8 Audit Routine — Card 2-7
Comprehensive cross-layer audit: Operation Health + optional Tier A results.

Orchestrates: evaluate_freshness → evaluate_watchdog → evaluate_safe_mode
  → aggregate Tier A results (if provided by caller)
  → (optional) send_notification
  → (optional) write_safe_mode_snapshot / write_recovery_log

Tier A checks (hard_gate, soft_penalty) are computed externally by the caller
and passed as Optional arguments. This routine does not call tier_a modules
directly; it aggregates pre-computed results.

any_issue: True when any stale source, critical watchdog, safe_mode active,
           hard gate violation, or soft penalty severe violation is found.

Detection-only: no trades, no securities API calls.
All writes and notifications require explicit arguments from the caller.

t4_violated: Phase 4+ will compute this from VIX / Nikkei 3-day data.
             Until then, caller passes False (default).

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 2-7
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
    STATUS_CRITICAL,
    evaluate_watchdog,
)
from backend.engine.operation.safe_mode import (
    SafeModeResult,
    evaluate_safe_mode,
)
from backend.engine.operation._routine_common import build_safe_mode_input
from backend.engine.operation.discord_notifier import (
    DiscordNotifierConfig,
    DiscordEmbed,
    DiscordEmbedField,
    NotifyResult,
    COLOR_RED,
    COLOR_ORANGE,
    COLOR_GREEN,
    send_notification,
    format_safe_mode_embed,
    format_watchdog_embed,
)
from backend.engine.operation.recovery_log_writer import (
    RecoveryLogEntry,
    append_recovery_entry,
    build_recovery_entry,
    write_recovery_log,
    write_safe_mode_snapshot,
)
from backend.engine.tier_a.tier_a_hard_gate import HardGateResult
from backend.engine.tier_a.tier_a_soft_penalty import SoftPenaltyResult


# ── Result ────────────────────────────────────────────────────────────────────

@dataclass
class AuditRoutineResult:
    freshness: FreshnessResult
    watchdog: WatchdogResult
    safe_mode: SafeModeResult
    hard_gate: Optional[HardGateResult]         # None if not provided by caller
    soft_penalty: Optional[SoftPenaltyResult]   # None if not provided by caller
    audit_issues: list[str]                     # human-readable issue summary
    any_issue: bool
    notify_result: Optional[NotifyResult]
    recovery_entry: Optional[RecoveryLogEntry]
    safe_mode_written: bool
    recovery_log_written: bool
    completed_at: datetime


# ── Helpers ───────────────────────────────────────────────────────────────────

def _collect_audit_issues(
    freshness: FreshnessResult,
    watchdog: WatchdogResult,
    safe_mode: SafeModeResult,
    hard_gate: Optional[HardGateResult],
    soft_penalty: Optional[SoftPenaltyResult],
) -> list[str]:
    issues: list[str] = []

    stale = [n for n, r in freshness.sources.items() if r.is_stale]
    if stale:
        issues.append(f"Stale sources: {stale}")

    critical = [n for n, r in watchdog.sources.items() if r.status == STATUS_CRITICAL]
    if critical:
        issues.append(f"Watchdog critical: {critical}")

    if safe_mode.active:
        issues.append(f"SAFE_MODE active: trigger={safe_mode.trigger_reason}")

    if hard_gate is not None and hard_gate.any_triggered:
        violated = [v.rule_id for v in hard_gate.violations if v.triggered]
        issues.append(f"Tier A hard gate: {violated}")

    if soft_penalty is not None and soft_penalty.any_severe:
        severe = [v.rule_id for v in soft_penalty.violations if v.severity == "severe"]
        issues.append(f"Tier A soft penalty severe: {severe}")

    return issues


def format_audit_embed(
    freshness: FreshnessResult,
    watchdog: WatchdogResult,
    safe_mode: SafeModeResult,
    hard_gate: Optional[HardGateResult],
    audit_issues: list[str],
    any_issue: bool,
) -> DiscordEmbed:
    """Build a Discord embed for R8 Audit Routine.

    Delegates to format_safe_mode_embed when safe_mode active.
    Does not include individual positions, holdings, or personal asset data.
    """
    if safe_mode.active:
        return format_safe_mode_embed(safe_mode)
    if watchdog.system_error:
        return format_watchdog_embed(watchdog)

    color = COLOR_ORANGE if any_issue else COLOR_GREEN
    title = "⚠️ Audit: Issues Found" if any_issue else "✅ Audit: All Clear"

    fields: list[DiscordEmbedField] = []
    for issue in audit_issues[:5]:
        fields.append(DiscordEmbedField(name="Issue", value=issue, inline=False))
    if hard_gate is not None:
        hard_status = "violations" if hard_gate.any_triggered else "clear"
        fields.append(DiscordEmbedField(name="Tier A Hard Gate", value=hard_status, inline=True))
    fields.append(DiscordEmbedField(
        name="checked_at",
        value=freshness.checked_at.isoformat(),
        inline=False,
    ))

    return DiscordEmbed(
        title=title,
        description="Comprehensive Operation + Tier A audit.",
        color=color,
        fields=tuple(fields),
    )


def _build_recovery_entry(
    safe_mode: SafeModeResult,
    watchdog: WatchdogResult,
    hard_gate: Optional[HardGateResult],
    audit_issues: list[str],
    existing: list[RecoveryLogEntry],
    now: datetime,
) -> Optional[RecoveryLogEntry]:
    if not audit_issues:
        return None

    # Priority: watchdog > safe_mode > hard_gate > other
    if watchdog.any_critical:
        critical_sources = [n for n, r in watchdog.sources.items() if r.status == STATUS_CRITICAL]
        source = critical_sources[0] if critical_sources else "operation"
        error_type = "watchdog_critical"
        message = f"Audit watchdog critical sources: {critical_sources}"
        action_taken = "audit_watchdog_alert_raised"
    elif safe_mode.active:
        source = "operation"
        error_type = "safe_mode_activated"
        message = f"Audit SAFE_MODE active: trigger={safe_mode.trigger_reason}"
        action_taken = (
            f"restrictions: new_buys_frozen={safe_mode.restrictions.new_buys_frozen}, "
            f"rebalance_frozen={safe_mode.restrictions.rebalance_frozen}"
        )
    elif hard_gate is not None and hard_gate.any_triggered:
        violated = [v.rule_id for v in hard_gate.violations if v.triggered]
        source = "tier_a"
        error_type = "hard_gate_violation"
        message = f"Audit Tier A hard gate violations: {violated}"
        action_taken = "audit_tier_a_hard_gate_raised"
    else:
        source = "operation"
        error_type = "audit_issue"
        message = f"Audit issues: {audit_issues}"
        action_taken = "audit_alert_raised"

    return build_recovery_entry(
        source=source,
        error_type=error_type,
        message=message,
        action_taken=action_taken,
        occurred_at=now,
        resolved_at=None,
        safe_mode_triggered=safe_mode.active,
        existing_entries=existing,
    )


# ── Main routine ──────────────────────────────────────────────────────────────

def run_audit_routine(
    data_timestamps: dict[str, Optional[datetime]],
    watchdog_events: list[SourceEvent],
    *,
    hard_gate_result: Optional[HardGateResult] = None,
    soft_penalty_result: Optional[SoftPenaltyResult] = None,
    notifier_config: Optional[DiscordNotifierConfig] = None,
    safe_mode_output_path: Optional[Path] = None,
    recovery_log_output_path: Optional[Path] = None,
    existing_recovery_entries: Optional[list[RecoveryLogEntry]] = None,
    t4_violated: bool = False,          # Phase 4+: compute from VIX / Nikkei 3-day data
    crisis_regime: bool = False,        # Phase 3+: inject from regime_state.json
    tier_a_t3_violated: bool = False,   # Phase 5+: inject from HardGateResult (T3 only)
    now: Optional[datetime] = None,
) -> AuditRoutineResult:
    """Run R8 Audit Routine: comprehensive Operation + Tier A cross-layer audit.

    Detection-only: no trades, no securities API calls.
    Tier A results are pre-computed by the caller and passed as Optional arguments.
    Notification triggered when any_issue=True.
    Files written only if corresponding output_path is provided.
    """
    if now is None:
        now = datetime.now(timezone.utc)
    if existing_recovery_entries is None:
        existing_recovery_entries = []

    # ── 1. Operation detection pipeline ──────────────────────────────────────
    freshness = evaluate_freshness(data_timestamps, now=now)
    watchdog = evaluate_watchdog(watchdog_events, now=now)
    safe_mode_input = build_safe_mode_input(
        freshness, watchdog,
        crisis_regime=crisis_regime,
        tier_a_t3_violated=tier_a_t3_violated,
    )
    safe_mode = evaluate_safe_mode(safe_mode_input, t4_violated=t4_violated, now=now)

    # ── 2. Aggregate all issues ───────────────────────────────────────────────
    audit_issues = _collect_audit_issues(
        freshness, watchdog, safe_mode, hard_gate_result, soft_penalty_result
    )
    any_issue = len(audit_issues) > 0

    # ── 3. Discord notification ───────────────────────────────────────────────
    notify_result: Optional[NotifyResult] = None
    if notifier_config is not None and any_issue:
        embed = format_audit_embed(
            freshness, watchdog, safe_mode, hard_gate_result, audit_issues, any_issue
        )
        notify_result = send_notification(notifier_config, embed)

    # ── 4. Recovery log entry ─────────────────────────────────────────────────
    recovery_entry = _build_recovery_entry(
        safe_mode, watchdog, hard_gate_result, audit_issues, existing_recovery_entries, now
    )

    # ── 5. Write safe_mode snapshot ───────────────────────────────────────────
    safe_mode_written = False
    if safe_mode_output_path is not None:
        write_safe_mode_snapshot(safe_mode, safe_mode_output_path)
        safe_mode_written = True

    # ── 6. Write recovery log ─────────────────────────────────────────────────
    recovery_log_written = False
    if recovery_log_output_path is not None and recovery_entry is not None:
        updated_entries = append_recovery_entry(existing_recovery_entries, recovery_entry)
        write_recovery_log(updated_entries, recovery_log_output_path)
        recovery_log_written = True

    return AuditRoutineResult(
        freshness=freshness,
        watchdog=watchdog,
        safe_mode=safe_mode,
        hard_gate=hard_gate_result,
        soft_penalty=soft_penalty_result,
        audit_issues=audit_issues,
        any_issue=any_issue,
        notify_result=notify_result,
        recovery_entry=recovery_entry,
        safe_mode_written=safe_mode_written,
        recovery_log_written=recovery_log_written,
        completed_at=now,
    )
