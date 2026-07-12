"""
Recovery Log Writer — Card 2-4
Builds RecoveryLogEntry objects and writes operation-layer JSON snapshots.

All writes require an explicit output_path argument.
No default output paths exist in this module.
Caller is responsible for reading existing JSON before calling write functions.

Atomic write: tmp file → os.replace (no partial writes on failure).

Detection-only contract: this module writes JSON, it does NOT:
  - execute trades, call securities APIs, or modify SAFE_MODE state
  - read or write any hardcoded file paths

Reference: contracts/v13.3/operation/recovery_log.json
Reference: contracts/v13.3/operation/safe_mode.json
"""
from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from backend.engine.operation.safe_mode import SafeModeResult

# ── Entry dataclass ───────────────────────────────────────────────────────────

@dataclass(frozen=True)
class RecoveryLogEntry:
    id: str                         # "rec-YYYYMMDD-NNN" (zero-padded 3-digit counter)
    occurred_at: datetime
    resolved_at: Optional[datetime]
    source: str
    error_type: str
    message: str
    action_taken: str
    safe_mode_triggered: bool


# ── ID generation ─────────────────────────────────────────────────────────────

def generate_entry_id(
    date: datetime,
    existing_entries: list[RecoveryLogEntry],
) -> str:
    """Generate the next rec-YYYYMMDD-NNN id for the given date.

    Scans existing_entries for entries on the same calendar date (local date
    of the datetime argument), then increments the highest counter found.
    Counter starts at 1.
    """
    date_str = date.strftime("%Y%m%d")
    prefix = f"rec-{date_str}-"
    counters = [
        int(e.id[len(prefix):])
        for e in existing_entries
        if e.id.startswith(prefix) and e.id[len(prefix):].isdigit()
    ]
    next_n = (max(counters) + 1) if counters else 1
    return f"{prefix}{next_n:03d}"


# ── Entry builder ─────────────────────────────────────────────────────────────

def build_recovery_entry(
    source: str,
    error_type: str,
    message: str,
    action_taken: str,
    occurred_at: datetime,
    resolved_at: Optional[datetime],
    safe_mode_triggered: bool,
    existing_entries: Optional[list[RecoveryLogEntry]] = None,
    entry_id: Optional[str] = None,
) -> RecoveryLogEntry:
    """Build a RecoveryLogEntry.

    entry_id: if None, generate_entry_id is called with occurred_at and
              existing_entries (defaulting to empty list if also None).
    """
    if entry_id is None:
        entry_id = generate_entry_id(occurred_at, existing_entries or [])

    return RecoveryLogEntry(
        id=entry_id,
        occurred_at=occurred_at,
        resolved_at=resolved_at,
        source=source,
        error_type=error_type,
        message=message,
        action_taken=action_taken,
        safe_mode_triggered=safe_mode_triggered,
    )


# ── List manipulation (pure) ──────────────────────────────────────────────────

def append_recovery_entry(
    existing: list[RecoveryLogEntry],
    new_entry: RecoveryLogEntry,
) -> list[RecoveryLogEntry]:
    """Return a new list with new_entry appended. Does not mutate existing."""
    return list(existing) + [new_entry]


# ── Serialization helpers ─────────────────────────────────────────────────────

def _dt_to_iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt is not None else None


def _entry_to_dict(entry: RecoveryLogEntry) -> dict:
    return {
        "id": entry.id,
        "occurred_at": _dt_to_iso(entry.occurred_at),
        "resolved_at": _dt_to_iso(entry.resolved_at),
        "source": entry.source,
        "error_type": entry.error_type,
        "message": entry.message,
        "action_taken": entry.action_taken,
        "safe_mode_triggered": entry.safe_mode_triggered,
    }


# ── Atomic write helper ───────────────────────────────────────────────────────

def _atomic_write_json(output_path: Path, data: dict) -> None:
    """Write data as JSON to output_path atomically via a temp file."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        dir=output_path.parent,
        prefix=".tmp_",
        suffix=".json",
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, output_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ── Writers ───────────────────────────────────────────────────────────────────

def write_recovery_log(
    entries: list[RecoveryLogEntry],
    output_path: Path,
) -> None:
    """Write entries as recovery_log.json to output_path (atomic).

    output_path is a required explicit argument. No default path exists.
    Caller is responsible for supplying the correct destination.
    """
    data = {
        "_meta": {
            "version": "v13.3",
            "kind": "operation_log",
            "not_for_trading": True,
        },
        "recovery_log": [_entry_to_dict(e) for e in entries],
    }
    _atomic_write_json(output_path, data)


def write_safe_mode_snapshot(
    result: SafeModeResult,
    output_path: Path,
    *,
    triggered_at: Optional[datetime] = None,
    estimated_resume_at: Optional[datetime] = None,
) -> None:
    """Write SafeModeResult as safe_mode.json to output_path (atomic).

    triggered_at / estimated_resume_at are Card 2-4 writer concerns (P1-5).
    They are accepted as explicit kwargs and written to JSON if provided.

    output_path is a required explicit argument. No default path exists.
    Caller is responsible for supplying the correct destination.
    """
    tc = result.trigger_conditions
    data = {
        "_meta": {
            "version": "v13.3",
            "kind": "operation_snapshot",
            "not_for_trading": True,
        },
        "safe_mode": {
            "active": result.active,
            "triggered_at": _dt_to_iso(triggered_at),
            "trigger_reason": result.trigger_reason,
            "trigger_reason_detail": result.trigger_reason_detail,
            "trigger_conditions": {
                "tier1_data_stale": tc.tier1_data_stale,
                "tier_a_t3_violated": tc.tier_a_t3_violated,
                "crisis_regime": tc.crisis_regime,
                "system_error": tc.system_error,
            },
            "restrictions": {
                "new_buys_frozen": result.restrictions.new_buys_frozen,
                "rebalance_frozen": result.restrictions.rebalance_frozen,
                "force_sell_active": result.restrictions.force_sell_active,
            },
            "estimated_resume_at": _dt_to_iso(estimated_resume_at),
            "last_checked": _dt_to_iso(result.checked_at),
        },
    }
    _atomic_write_json(output_path, data)
