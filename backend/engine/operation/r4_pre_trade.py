"""
R4 Pre-Trade Routine — Card 2-6
Pre-trade Operation Health Check. Runs before market open (~08:45 JST).

Orchestrates: evaluate_freshness → evaluate_watchdog → evaluate_safe_mode
  → (optional) send_notification
  → (optional) write_safe_mode_snapshot / write_recovery_log

pre_trade_ready=True when safe_mode.inactive AND watchdog.system_error=False.
Notification trigger: safe_mode.active OR watchdog.system_error.

Detection-only: no trades, no securities API calls.
All writes and notifications require explicit arguments from the caller.

t4_violated: Phase 4+ will compute this from VIX / Nikkei 3-day data.
             Until then, caller passes False (default).

sq_days_until: days until next SQ date (Tokubetsu Seisan). Informational only.
               Caller reads earnings_calendar.json and extracts sq_days_until.
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
class PreTradeRoutineResult:
    freshness: FreshnessResult
    watchdog: WatchdogResult
    safe_mode: SafeModeResult
    notify_result: Optional[NotifyResult]
    recovery_entry: Optional[RecoveryLogEntry]
    safe_mode_written: bool
    recovery_log_written: bool
    pre_trade_ready: bool       # True when safe_mode.inactive AND no system_error
    completed_at: datetime


# ── Main routine ──────────────────────────────────────────────────────────────

def run_pre_trade_routine(
    data_timestamps: dict[str, Optional[datetime]],
    watchdog_events: list[SourceEvent],
    *,
    sq_days_until: Optional[int] = None,
    notifier_config: Optional[DiscordNotifierConfig] = None,
    safe_mode_output_path: Optional[Path] = None,
    recovery_log_output_path: Optional[Path] = None,
    existing_recovery_entries: Optional[list[RecoveryLogEntry]] = None,
    t4_violated: bool = False,          # Phase 4+: compute from VIX / Nikkei 3-day data
    crisis_regime: bool = False,        # Phase 3+: inject from regime_state.json
    tier_a_t3_violated: bool = False,   # Phase 5+: inject from HardGateResult (T3 only)
    now: Optional[datetime] = None,
) -> PreTradeRoutineResult:
    """Run R4 Pre-Trade Routine: pre-trade Operation Health Check.

    Detection-only: no trades, no securities API calls.
    Notification triggered when safe_mode.active=True or watchdog.system_error=True.
    Files written only if corresponding output_path is provided.

    sq_days_until: days until next SQ date; informational only, does not affect triggers.
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

    # ── 2. pre_trade_ready ────────────────────────────────────────────────────
    pre_trade_ready = not safe_mode.active and not watchdog.system_error

    # ── 3. Discord notification: safe_mode.active OR system_error ─────────────
    notify_result: Optional[NotifyResult] = None
    if notifier_config is not None and (safe_mode.active or watchdog.system_error):
        if safe_mode.active:
            embed = format_safe_mode_embed(safe_mode)
        else:
            embed = format_watchdog_embed(watchdog)
        notify_result = send_notification(notifier_config, embed)

    # ── 4. Recovery log entry ─────────────────────────────────────────────────
    recovery_entry = build_routine_recovery_entry(
        safe_mode, watchdog, existing_recovery_entries, now,
        watchdog_critical=watchdog.any_critical,
        label="Pre-trade",
        action_watchdog="pre_trade_watchdog_alert_raised",
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

    return PreTradeRoutineResult(
        freshness=freshness,
        watchdog=watchdog,
        safe_mode=safe_mode,
        notify_result=notify_result,
        recovery_entry=recovery_entry,
        safe_mode_written=safe_mode_written,
        recovery_log_written=recovery_log_written,
        pre_trade_ready=pre_trade_ready,
        completed_at=now,
    )


# ── CLI entrypoint (P4-A20) ───────────────────────────────────────────────────

def _read_json_timestamp(filepath: Path, *keys: str) -> Optional[datetime]:
    """Read a datetime from a nested key path in a JSON file.

    Returns None on missing file, missing key, parse error, or empty value.
    Naive datetimes (no tz info) are assumed to be JST (UTC+9).
    """
    import json
    from datetime import timedelta
    try:
        data = json.loads(filepath.read_text())
        val: object = data
        for k in keys:
            val = val[k]  # type: ignore[index]
        if not val:
            return None
        raw = str(val).replace(" ", "T")  # "2026-06-11 15:00" → "2026-06-11T15:00"
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone(timedelta(hours=9)))
        return dt
    except Exception:
        return None


def _cli_main(argv: Optional[list[str]] = None) -> None:
    """CLI entrypoint for R4 Pre-Trade Routine (detection-only, no trades).

    Reads data timestamps from JSON files in --data-dir, evaluates SAFE_MODE,
    and optionally writes safe_mode.json to --output.

    Exit codes:
      0  pre_trade_ready=True  (healthy — safe_mode inactive, no system_error)
      1  pre_trade_ready=False (safe_mode active or system_error)
    """
    import argparse
    import sys

    parser = argparse.ArgumentParser(
        prog="python -m backend.engine.operation.r4_pre_trade",
        description="R4 Pre-Trade Routine — SAFE_MODE evaluation (detection-only, no trades)",
    )
    parser.add_argument(
        "--output",
        metavar="PATH",
        default=None,
        help="Write safe_mode.json to PATH (ignored when --dry-run is set)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        dest="dry_run",
        help="Evaluate and print summary without writing any files",
    )
    parser.add_argument(
        "--data-dir",
        metavar="DIR",
        default="public/data",
        help=(
            "Directory containing market.json / regime_state.json / news.json "
            "(default: public/data)"
        ),
    )
    parsed = parser.parse_args(argv)

    data_dir = Path(parsed.data_dir)

    # Build data_timestamps from live JSON files in data_dir.
    # A missing or unreadable file → None → evaluate_freshness treats as
    # missing (tier1 stale) → safe_mode.active=True (fail-closed by design).
    data_timestamps: dict[str, Optional[datetime]] = {
        "market": _read_json_timestamp(data_dir / "market.json", "last_updated"),
        "regime": _read_json_timestamp(data_dir / "regime_state.json", "_meta", "generatedAt"),
        "news":   _read_json_timestamp(data_dir / "news.json", "updatedAt"),
    }

    safe_mode_output_path: Optional[Path] = None
    if parsed.output and not parsed.dry_run:
        safe_mode_output_path = Path(parsed.output)

    now = datetime.now(timezone.utc)
    result = run_pre_trade_routine(
        data_timestamps,
        watchdog_events=[],
        safe_mode_output_path=safe_mode_output_path,
        now=now,
    )

    sm = result.safe_mode
    print(f"[r4_pre_trade] checked_at={now.isoformat()}")
    print(f"[r4_pre_trade] safe_mode.active={sm.active}")
    print(f"[r4_pre_trade] trigger_reason={sm.trigger_reason}")
    print(f"[r4_pre_trade] trigger_reason_detail={sm.trigger_reason_detail}")
    print(f"[r4_pre_trade] new_buys_frozen={sm.restrictions.new_buys_frozen}")
    print(f"[r4_pre_trade] rebalance_frozen={sm.restrictions.rebalance_frozen}")
    print(f"[r4_pre_trade] force_sell_active={sm.restrictions.force_sell_active}")
    print(f"[r4_pre_trade] pre_trade_ready={result.pre_trade_ready}")

    for name, src in result.freshness.sources.items():
        if src.tier == 1:
            age_str = f"{src.age_minutes:.1f}min" if src.age_minutes is not None else "N/A"
            print(
                f"[r4_pre_trade] freshness[{name}] tier1"
                f" status={src.status} age={age_str}"
            )

    if parsed.dry_run:
        print("[r4_pre_trade] dry-run mode: no files written")
    elif safe_mode_output_path is not None:
        print(f"[r4_pre_trade] safe_mode.json written to {safe_mode_output_path}")
    else:
        print("[r4_pre_trade] --output not specified: JSON not written")

    sys.exit(0 if result.pre_trade_ready else 1)


if __name__ == "__main__":
    _cli_main()
