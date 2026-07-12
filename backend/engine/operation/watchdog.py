"""
Watchdog — Card 2-2
Detection-only. No orders, no writes, no notifications sent.
Monitors per-source consecutive failure counts and reports health status.

Failure threshold: 3 consecutive failures → "critical" / alert_threshold_reached=True
"3回失敗で Discord 通知" — notification itself is Card 2-4 (recovery_log + Discord).
This module only detects; the caller decides action.

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 2-4 (notification)
Reference: public/data/contracts/v13.3/operation/recovery_log.json
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

# ── Constants ────────────────────────────────────────────────────────────────

CONSECUTIVE_FAILURE_THRESHOLD: int = 3   # 3回連続失敗 → critical

STATUS_HEALTHY: str = "healthy"      # consecutive_failures == 0
STATUS_DEGRADED: str = "degraded"    # 1 <= consecutive_failures < threshold
STATUS_CRITICAL: str = "critical"    # consecutive_failures >= threshold

# Sources whose CRITICAL status raises system_error in WatchdogResult.
# Only Tier 1 intraday sources are in scope; Tier 3 weekly sources (e.g. correlation)
# do not constitute a system error for SAFE_MODE purposes.
DEFAULT_SAFE_MODE_SOURCES: frozenset[str] = frozenset({"market", "regime", "news"})


# ── Input ────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class SourceEvent:
    source: str
    timestamp: datetime
    success: bool
    error_type: Optional[str] = None
    message: Optional[str] = None


# ── Output ───────────────────────────────────────────────────────────────────

@dataclass
class SourceWatchResult:
    source: str
    consecutive_failures: int
    last_success_at: Optional[datetime]
    last_failure_at: Optional[datetime]
    alert_threshold_reached: bool   # consecutive_failures >= CONSECUTIVE_FAILURE_THRESHOLD
    status: str                     # STATUS_HEALTHY | STATUS_DEGRADED | STATUS_CRITICAL


@dataclass
class WatchdogResult:
    checked_at: datetime
    sources: dict[str, SourceWatchResult]
    any_critical: bool
    system_error: bool  # True only when a DEFAULT_SAFE_MODE_SOURCES source is critical


# ── Core functions ────────────────────────────────────────────────────────────

def evaluate_source(
    source_name: str,
    events: list[SourceEvent],
    now: Optional[datetime] = None,
) -> SourceWatchResult:
    """Evaluate consecutive failure state for a single source.

    Events are processed in chronological order (sorted by timestamp).
    A success event resets the consecutive failure counter to 0.
    """
    if now is None:
        now = datetime.now(timezone.utc)

    sorted_events = sorted(events, key=lambda e: e.timestamp)

    consecutive_failures = 0
    last_success_at: Optional[datetime] = None
    last_failure_at: Optional[datetime] = None

    for event in sorted_events:
        if event.success:
            consecutive_failures = 0
            last_success_at = event.timestamp
        else:
            consecutive_failures += 1
            last_failure_at = event.timestamp

    alert_threshold_reached = consecutive_failures >= CONSECUTIVE_FAILURE_THRESHOLD

    if consecutive_failures == 0:
        status = STATUS_HEALTHY
    elif consecutive_failures < CONSECUTIVE_FAILURE_THRESHOLD:
        status = STATUS_DEGRADED
    else:
        status = STATUS_CRITICAL

    return SourceWatchResult(
        source=source_name,
        consecutive_failures=consecutive_failures,
        last_success_at=last_success_at,
        last_failure_at=last_failure_at,
        alert_threshold_reached=alert_threshold_reached,
        status=status,
    )


def evaluate_watchdog(
    events: list[SourceEvent],
    *,
    safe_mode_sources: Optional[frozenset[str]] = None,
    now: Optional[datetime] = None,
) -> WatchdogResult:
    """Evaluate health of all sources present in the event list.

    Groups events by source name, then calls evaluate_source for each.
    Sources with no events are not included in the result.
    Detection-only: no writes, no notifications.

    safe_mode_sources: frozenset of source names whose CRITICAL status triggers
                       system_error=True. Defaults to DEFAULT_SAFE_MODE_SOURCES.
    """
    if now is None:
        now = datetime.now(timezone.utc)
    if safe_mode_sources is None:
        safe_mode_sources = DEFAULT_SAFE_MODE_SOURCES

    source_events: dict[str, list[SourceEvent]] = {}
    for event in events:
        source_events.setdefault(event.source, []).append(event)

    results: dict[str, SourceWatchResult] = {
        name: evaluate_source(name, evs, now)
        for name, evs in source_events.items()
    }

    any_critical = any(r.status == STATUS_CRITICAL for r in results.values())
    system_error = any(
        r.status == STATUS_CRITICAL
        for name, r in results.items()
        if name in safe_mode_sources
    )

    return WatchdogResult(
        checked_at=now,
        sources=results,
        any_critical=any_critical,
        system_error=system_error,
    )
