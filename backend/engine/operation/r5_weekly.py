"""
R5 Weekly Routine — Card 2-6
Weekly full-scope Operation Health Check. Runs every Monday morning (~07:00 JST).

Orchestrates: evaluate_freshness → evaluate_watchdog → evaluate_safe_mode
  → (optional) send_notification
  → (optional) write_safe_mode_snapshot / write_recovery_log

Scope: all tiers (Tier 1/2/3). Broader than R2/R4.
Notification trigger: safe_mode.active OR watchdog.any_critical OR tier2/3 data stale.
sq_alert: True when SQ (Tokubetsu Seisan) is within SQ_ALERT_DAYS days.

Detection-only: no trades, no securities API calls.
All writes and notifications require explicit arguments from the caller.

t4_violated: Phase 4+ will compute this from VIX / Nikkei 3-day data.
             Until then, caller passes False (default).

sq_event: caller reads earnings_calendar.json and extracts days_until.
          This routine does not read JSON files.

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 2-6
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from backend.engine.operation.data_freshness import (
    FreshnessResult,
    TIER_2,
    TIER_3,
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
    DiscordEmbed,
    DiscordEmbedField,
    NotifyResult,
    COLOR_ORANGE,
    COLOR_GREEN,
    send_notification,
    format_safe_mode_embed,
    format_watchdog_embed,
)
from backend.engine.operation.recovery_log_writer import (
    RecoveryLogEntry,
    append_recovery_entry,
    write_recovery_log,
    write_safe_mode_snapshot,
)

SQ_ALERT_DAYS: int = 7


# ── SQ event input ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class SQEventInput:
    """SQ (Tokubetsu Seisan) calendar input from caller.

    Caller reads earnings_calendar.json and computes days_until.
    This dataclass is passed to run_weekly_routine; the routine does not read JSON.
    """
    days_until: int


# ── Result ────────────────────────────────────────────────────────────────────

@dataclass
class WeeklyRoutineResult:
    freshness: FreshnessResult
    watchdog: WatchdogResult
    safe_mode: SafeModeResult
    notify_result: Optional[NotifyResult]
    recovery_entry: Optional[RecoveryLogEntry]
    safe_mode_written: bool
    recovery_log_written: bool
    sq_alert: bool          # True when sq_event.days_until <= SQ_ALERT_DAYS
    completed_at: datetime


# ── Embed formatter ───────────────────────────────────────────────────────────

def format_weekly_embed(
    freshness: FreshnessResult,
    watchdog: WatchdogResult,
    safe_mode: SafeModeResult,
    sq_alert: bool,
    sq_days_until: Optional[int],
) -> DiscordEmbed:
    """Build a Discord embed for R5 Weekly Routine.

    Delegates to format_safe_mode_embed / format_watchdog_embed for critical triggers.
    Does not include individual positions, holdings, or personal asset data.
    """
    if safe_mode.active:
        return format_safe_mode_embed(safe_mode)
    if watchdog.system_error:
        return format_watchdog_embed(watchdog)

    stale_tier23 = [
        name for name, r in freshness.sources.items()
        if r.is_stale and r.tier in (TIER_2, TIER_3)
    ]
    critical_sources = [
        name for name, r in watchdog.sources.items()
        if r.status == "critical"
    ]

    color = COLOR_ORANGE if (stale_tier23 or critical_sources or sq_alert) else COLOR_GREEN
    title = "⚠️ Weekly Check: Attention Required" if (stale_tier23 or critical_sources) else "📅 Weekly Check"

    fields: list[DiscordEmbedField] = []
    if sq_alert and sq_days_until is not None:
        fields.append(DiscordEmbedField(
            name="SQ Alert",
            value=f"SQ in {sq_days_until} days",
            inline=True,
        ))
    if stale_tier23:
        fields.append(DiscordEmbedField(
            name="Stale Sources (Tier 2/3)",
            value=", ".join(stale_tier23),
            inline=False,
        ))
    if critical_sources:
        fields.append(DiscordEmbedField(
            name="Critical Sources",
            value=", ".join(critical_sources),
            inline=False,
        ))
    fields.append(DiscordEmbedField(
        name="checked_at",
        value=freshness.checked_at.isoformat(),
        inline=False,
    ))

    return DiscordEmbed(
        title=title,
        description="End-of-week Operation Health summary.",
        color=color,
        fields=tuple(fields),
    )


def _any_tier23_stale(freshness: FreshnessResult) -> bool:
    return any(
        r.is_stale for r in freshness.sources.values()
        if r.tier in (TIER_2, TIER_3)
    )


# ── Main routine ──────────────────────────────────────────────────────────────

def run_weekly_routine(
    data_timestamps: dict[str, Optional[datetime]],
    watchdog_events: list[SourceEvent],
    *,
    sq_event: Optional[SQEventInput] = None,
    notifier_config: Optional[DiscordNotifierConfig] = None,
    safe_mode_output_path: Optional[Path] = None,
    recovery_log_output_path: Optional[Path] = None,
    existing_recovery_entries: Optional[list[RecoveryLogEntry]] = None,
    t4_violated: bool = False,          # Phase 4+: compute from VIX / Nikkei 3-day data
    crisis_regime: bool = False,        # Phase 3+: inject from regime_state.json
    tier_a_t3_violated: bool = False,   # Phase 5+: inject from HardGateResult (T3 only)
    now: Optional[datetime] = None,
) -> WeeklyRoutineResult:
    """Run R5 Weekly Routine: full-scope weekly Operation Health Check.

    Detection-only: no trades, no securities API calls.
    Notification triggered when safe_mode.active, any_critical, or tier2/3 data stale.
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

    # ── 2. sq_alert ───────────────────────────────────────────────────────────
    sq_alert = sq_event is not None and sq_event.days_until <= SQ_ALERT_DAYS

    # ── 3. Discord notification: broader trigger ──────────────────────────────
    notify_result: Optional[NotifyResult] = None
    tier23_stale = _any_tier23_stale(freshness)
    if notifier_config is not None and (
        safe_mode.active or watchdog.any_critical or tier23_stale
    ):
        embed = format_weekly_embed(
            freshness, watchdog, safe_mode, sq_alert,
            sq_event.days_until if sq_event else None,
        )
        notify_result = send_notification(notifier_config, embed)

    # ── 4. Recovery log entry ─────────────────────────────────────────────────
    recovery_entry = build_routine_recovery_entry(
        safe_mode, watchdog, existing_recovery_entries, now,
        watchdog_critical=watchdog.any_critical,
        label="Weekly",
        action_watchdog="weekly_watchdog_alert_raised",
        action_safe_mode=(
            f"restrictions: new_buys_frozen={safe_mode.restrictions.new_buys_frozen}, "
            f"rebalance_frozen={safe_mode.restrictions.rebalance_frozen}"
        ),
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

    return WeeklyRoutineResult(
        freshness=freshness,
        watchdog=watchdog,
        safe_mode=safe_mode,
        notify_result=notify_result,
        recovery_entry=recovery_entry,
        safe_mode_written=safe_mode_written,
        recovery_log_written=recovery_log_written,
        sq_alert=sq_alert,
        completed_at=now,
    )
