"""
Data Freshness — Card 2-1
Detection-only. No orders, no writes, no external calls.
All results carry read-only semantics: final execution decisions are the user's.

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 2-1
Reference: public/data/contracts/v13.3/operation/data_freshness.json
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

# ── Tier definitions ─────────────────────────────────────────────────────────
# Tier 1: intraday critical — stale → safe_mode_triggered
# Tier 2: daily update — stale is degraded but not blocking
# Tier 3: weekly/low-frequency — stale is informational only

TIER_1: int = 1
TIER_2: int = 2
TIER_3: int = 3

STATUS_LOADED: str = "loaded"
STATUS_STALE: str = "stale"
STATUS_MISSING: str = "missing"


# ── Source configuration ─────────────────────────────────────────────────────

@dataclass(frozen=True)
class SourceConfig:
    name: str
    tier: int
    max_age_minutes: int


DEFAULT_SOURCE_CONFIGS: list[SourceConfig] = [
    SourceConfig("market",      TIER_1, 30),
    SourceConfig("regime",      TIER_1, 60),
    SourceConfig("news",        TIER_1, 30),
    SourceConfig("scoring",     TIER_2, 240),
    SourceConfig("strategy",    TIER_2, 240),
    SourceConfig("macro",       TIER_2, 480),
    SourceConfig("correlation", TIER_3, 1440),
    SourceConfig("trust",       TIER_3, 1440),
]


# ── Output dataclasses ───────────────────────────────────────────────────────

@dataclass
class SourceFreshnessResult:
    name: str
    tier: int
    max_age_minutes: int
    last_updated_at: Optional[datetime]
    is_stale: bool
    status: str             # STATUS_LOADED | STATUS_STALE | STATUS_MISSING
    age_minutes: Optional[float]


@dataclass
class FreshnessResult:
    checked_at: datetime
    sources: dict[str, SourceFreshnessResult]
    any_tier1_stale: bool
    any_tier2_stale: bool
    safe_mode_triggered: bool   # True when any Tier 1 source is stale


# ── Core functions ────────────────────────────────────────────────────────────

def check_source_freshness(
    config: SourceConfig,
    last_updated_at: Optional[datetime],
    now: datetime,
) -> SourceFreshnessResult:
    """Return freshness result for a single source.

    Boundary rule: age == max_age_minutes is NOT stale (≤ is fresh).
    """
    if last_updated_at is None:
        return SourceFreshnessResult(
            name=config.name,
            tier=config.tier,
            max_age_minutes=config.max_age_minutes,
            last_updated_at=None,
            is_stale=True,
            status=STATUS_MISSING,
            age_minutes=None,
        )

    age_seconds = (now - last_updated_at).total_seconds()
    age_minutes = age_seconds / 60.0
    is_stale = age_minutes > config.max_age_minutes
    status = STATUS_STALE if is_stale else STATUS_LOADED

    return SourceFreshnessResult(
        name=config.name,
        tier=config.tier,
        max_age_minutes=config.max_age_minutes,
        last_updated_at=last_updated_at,
        is_stale=is_stale,
        status=status,
        age_minutes=age_minutes,
    )


def evaluate_freshness(
    timestamps: dict[str, Optional[datetime]],
    now: Optional[datetime] = None,
    source_configs: Optional[list[SourceConfig]] = None,
) -> FreshnessResult:
    """Evaluate freshness for all configured sources.

    Args:
        timestamps: mapping of source name → last_updated_at (None = missing).
        now: reference time for age calculation; defaults to UTC now.
        source_configs: override DEFAULT_SOURCE_CONFIGS for testing.

    Returns:
        FreshnessResult with per-source results and aggregate flags.
        Detection-only: no writes, no side effects.
    """
    if now is None:
        now = datetime.now(timezone.utc)
    if source_configs is None:
        source_configs = DEFAULT_SOURCE_CONFIGS

    config_map: dict[str, SourceConfig] = {c.name: c for c in source_configs}

    # Evaluate each known source; unknown keys in timestamps are ignored.
    results: dict[str, SourceFreshnessResult] = {}
    for cfg in source_configs:
        ts = timestamps.get(cfg.name)  # None if key absent
        results[cfg.name] = check_source_freshness(cfg, ts, now)

    any_tier1_stale = any(
        r.is_stale for r in results.values() if r.tier == TIER_1
    )
    any_tier2_stale = any(
        r.is_stale for r in results.values() if r.tier == TIER_2
    )

    return FreshnessResult(
        checked_at=now,
        sources=results,
        any_tier1_stale=any_tier1_stale,
        any_tier2_stale=any_tier2_stale,
        safe_mode_triggered=any_tier1_stale,
    )
