"""
R6 Earnings Routine — Card 2-6
Earnings calendar notification. Runs before earnings announcement periods.

No freshness / watchdog / safe_mode pipeline.
No recovery_log writes.
Notification trigger: upcoming_events >= 1.

Detection-only: no trades, no securities API calls.
Caller is responsible for reading earnings_calendar.json and constructing
the EarningsEvent list. This routine does not read JSON files.

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 2-6
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from backend.engine.operation.discord_notifier import (
    DiscordNotifierConfig,
    DiscordEmbed,
    DiscordEmbedField,
    NotifyResult,
    COLOR_ORANGE,
    send_notification,
)


# ── Earnings event ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class EarningsEvent:
    """A single upcoming earnings announcement.

    Caller reads earnings_calendar.json and populates this dataclass.
    This module does not read JSON files.
    """
    ticker: str
    company_name: str
    earnings_date: datetime
    days_until: int


# ── Result ────────────────────────────────────────────────────────────────────

@dataclass
class EarningsRoutineResult:
    events: list[EarningsEvent]
    upcoming_events: int
    notify_result: Optional[NotifyResult]
    completed_at: datetime


# ── Embed formatter ───────────────────────────────────────────────────────────

def format_earnings_embed(events: list[EarningsEvent]) -> DiscordEmbed:
    """Build a Discord embed for upcoming earnings announcements.

    Capped at 10 events to stay within Discord embed field limits.
    Does not include position sizes, holdings ratios, or personal asset data.
    """
    fields: list[DiscordEmbedField] = []
    for ev in events[:10]:
        fields.append(DiscordEmbedField(
            name=f"{ev.ticker} — {ev.company_name}",
            value=f"{ev.earnings_date.strftime('%Y-%m-%d')} ({ev.days_until}d)",
            inline=True,
        ))

    return DiscordEmbed(
        title="📋 Earnings Calendar Alert",
        description=f"{len(events)} upcoming earnings announcement(s).",
        color=COLOR_ORANGE,
        fields=tuple(fields),
    )


# ── Main routine ──────────────────────────────────────────────────────────────

def run_earnings_routine(
    earnings_events: list[EarningsEvent],
    *,
    notifier_config: Optional[DiscordNotifierConfig] = None,
    now: Optional[datetime] = None,
) -> EarningsRoutineResult:
    """Run R6 Earnings Routine: earnings calendar notification check.

    Detection-only: no trades, no securities API calls, no recovery_log writes.
    Notification triggered when upcoming_events >= 1 and notifier_config is provided.

    Caller is responsible for reading earnings_calendar.json and constructing
    the earnings_events list. This routine does not read JSON files.
    """
    if now is None:
        now = datetime.now(timezone.utc)

    upcoming_events = len(earnings_events)

    notify_result: Optional[NotifyResult] = None
    if notifier_config is not None and upcoming_events >= 1:
        embed = format_earnings_embed(earnings_events)
        notify_result = send_notification(notifier_config, embed)

    return EarningsRoutineResult(
        events=list(earnings_events),
        upcoming_events=upcoming_events,
        notify_result=notify_result,
        completed_at=now,
    )
