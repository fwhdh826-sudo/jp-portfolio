"""
TierA Snapshot Writer — P4-A21
Serializes HardGateResult → tier_a_violations.json
and AlertsResult → tier_a_alerts.json.

Detection-only: no trades, no securities API calls.
fail-safe: result=None → status="unavailable" (no silent false-clear).

JSON kind values:
  tier_a_violations.json: kind="live_tier_a_violations"
  tier_a_alerts.json:     kind="live_tier_a_alerts"

T3 is the only rule with safe_mode_related=True (SAFE_MODE connection candidate).
T1 / T2 / T4 are existing-holdings / SELL / rebalance concerns, not BUY candidate gates.

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md P4-A21
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from backend.engine.tier_a.tier_a_hard_gate import HardGateResult
from backend.engine.tier_a.alerts_emitter import AlertsResult

# Only T3 feeds into SAFE_MODE
_SAFE_MODE_RELATED_RULES: frozenset[str] = frozenset({"T3"})

# target_type by rule (T1=holding, T2/T3=portfolio, T4=system)
_TARGET_TYPE: dict[str, str] = {
    "T1": "holding",
    "T2": "portfolio",
    "T3": "portfolio",
    "T4": "system",
}

# recommended_action_type for alert levels (OS internal classification, not investment advice)
_ALERT_ACTION: dict[str, str] = {
    "L1": "MONITOR",
    "L2": "REVIEW",
    "L3": "BLOCK_NEW_BUY",
    "OPPORTUNITY": "REVIEW",
}


def _violation_severity(rule_id: str, triggered: bool) -> str:
    if not triggered:
        return "ok"
    if rule_id in ("T1", "T3", "T4"):
        return "critical"
    return "warn"  # T2


def _alert_severity(level: str, triggered: bool) -> str:
    if not triggered:
        return "ok"
    if level == "L3":
        return "critical"
    return "warn"


def _atomic_write_json(output_path: Path, data: dict) -> None:
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


# ── Snapshot builders ─────────────────────────────────────────────────────────

def build_violations_snapshot(
    result: Optional[HardGateResult],
    now: datetime,
) -> dict:
    """Build tier_a_violations.json payload.

    result=None → status="unavailable" (fail-safe: no silent false-clear).
    T3 triggered → safe_mode_related=True (only rule connected to SAFE_MODE).
    T1 / T2 / T4 → safe_mode_related=False (holding / portfolio / system concerns).
    """
    meta = {
        "_meta": {
            "version": "v13.3",
            "kind": "live_tier_a_violations",
            "not_for_trading": True,
        },
        "generated_at": now.isoformat(),
        "source": "backend_tier_a_hard_gate",
    }

    if result is None:
        return {
            **meta,
            "status": "unavailable",
            "violations": [],
            "summary": {
                "total_violations": 0,
                "t3_count": 0,
                "safe_mode_related_count": 0,
            },
        }

    violations = [
        {
            "code": v.rule_id,
            "triggered": v.triggered,
            "severity": _violation_severity(v.rule_id, v.triggered),
            "target_type": _TARGET_TYPE.get(v.rule_id, "system"),
            "message": v.detail,
            "safe_mode_related": v.rule_id in _SAFE_MODE_RELATED_RULES,
        }
        for v in result.violations
    ]

    triggered = [v for v in violations if v["triggered"]]
    t3_count = sum(1 for v in triggered if v["code"] == "T3")
    sm_count = sum(1 for v in triggered if v["safe_mode_related"])

    return {
        **meta,
        "status": "ok" if not result.any_triggered else "degraded",
        "violations": violations,
        "summary": {
            "total_violations": len(triggered),
            "t3_count": t3_count,
            "safe_mode_related_count": sm_count,
        },
    }


def build_alerts_snapshot(
    result: Optional[AlertsResult],
    now: datetime,
) -> dict:
    """Build tier_a_alerts.json payload.

    result=None → status="unavailable" (fail-safe: no silent false-clear).
    recommended_action_type is an OS-internal classification, not investment advice.
    """
    meta = {
        "_meta": {
            "version": "v13.3",
            "kind": "live_tier_a_alerts",
            "not_for_trading": True,
        },
        "generated_at": now.isoformat(),
        "source": "backend_tier_a_alerts_emitter",
    }

    if result is None:
        return {
            **meta,
            "status": "unavailable",
            "alerts": [],
            "summary": {
                "total_triggered": 0,
                "highest_level": "NONE",
            },
        }

    alerts = [
        {
            "code": event.level,
            "triggered": event.triggered,
            "severity": _alert_severity(event.level, event.triggered),
            "message": event.detail,
            "recommended_action_type": _ALERT_ACTION.get(event.level, "MONITOR"),
        }
        for event in [result.l1, result.l2, result.l3, result.opportunity]
    ]

    total_triggered = sum(1 for a in alerts if a["triggered"])

    return {
        **meta,
        "status": "ok" if result.highest_level == "NONE" else "degraded",
        "alerts": alerts,
        "summary": {
            "total_triggered": total_triggered,
            "highest_level": result.highest_level,
        },
    }


# ── Writers ───────────────────────────────────────────────────────────────────

def write_tier_a_violations_snapshot(
    result: Optional[HardGateResult],
    output_path: Path,
    now: datetime,
) -> None:
    """Write tier_a_violations.json to output_path (atomic).

    result=None → status="unavailable" written (fail-safe: no silent false-clear).
    output_path is a required explicit argument; no default path exists.
    """
    _atomic_write_json(output_path, build_violations_snapshot(result, now))


def write_tier_a_alerts_snapshot(
    result: Optional[AlertsResult],
    output_path: Path,
    now: datetime,
) -> None:
    """Write tier_a_alerts.json to output_path (atomic).

    result=None → status="unavailable" written (fail-safe: no silent false-clear).
    output_path is a required explicit argument; no default path exists.
    """
    _atomic_write_json(output_path, build_alerts_snapshot(result, now))


# ── CLI entrypoint ────────────────────────────────────────────────────────────

def _cli_main(argv: Optional[list[str]] = None) -> None:
    """CLI entrypoint for TierA snapshot writer (detection-only, no trades).

    Portfolio data is not available from CLI in Phase A (P4-A21).
    Both snapshots are written with status="unavailable" — fail-safe:
    no silent false-clear when portfolio data is absent.

    Exit codes:
      0  completed (dry-run, or files written successfully)
      1  file write failure
    """
    import argparse
    import sys

    parser = argparse.ArgumentParser(
        prog="python -m backend.engine.tier_a.tier_a_snapshot_writer",
        description=(
            "TierA Snapshot Writer — writes tier_a_violations.json "
            "and tier_a_alerts.json (detection-only, no trades)"
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        dest="dry_run",
        help="Print summary without writing any files",
    )
    parser.add_argument(
        "--output-dir",
        metavar="DIR",
        default=None,
        dest="output_dir",
        help="Directory to write tier_a_violations.json and tier_a_alerts.json",
    )
    parsed = parser.parse_args(argv)

    now = datetime.now(timezone.utc)

    # Portfolio data unavailable from CLI — fail-safe: status="unavailable"
    v_data = build_violations_snapshot(None, now)
    a_data = build_alerts_snapshot(None, now)

    v_summary = v_data["summary"]
    a_summary = a_data["summary"]

    print(f"[tier_a_writer] checked_at={now.isoformat()}")
    print(f"[tier_a_writer] violations.status={v_data['status']}")
    print(f"[tier_a_writer] violations.total_violations={v_summary['total_violations']}")
    print(f"[tier_a_writer] violations.t3_count={v_summary['t3_count']}")
    print(f"[tier_a_writer] violations.safe_mode_related_count={v_summary['safe_mode_related_count']}")
    print(f"[tier_a_writer] alerts.status={a_data['status']}")
    print(f"[tier_a_writer] alerts.highest_level={a_summary['highest_level']}")
    print(f"[tier_a_writer] alerts.total_triggered={a_summary['total_triggered']}")

    if parsed.dry_run:
        print("[tier_a_writer] dry-run mode: no files written")
        sys.exit(0)

    if parsed.output_dir is not None:
        output_dir = Path(parsed.output_dir)
        try:
            write_tier_a_violations_snapshot(None, output_dir / "tier_a_violations.json", now)
            write_tier_a_alerts_snapshot(None, output_dir / "tier_a_alerts.json", now)
            print(f"[tier_a_writer] tier_a_violations.json written to {output_dir}")
            print(f"[tier_a_writer] tier_a_alerts.json written to {output_dir}")
        except Exception as exc:
            print(f"[tier_a_writer] ERROR: {exc}")
            sys.exit(1)
    else:
        print("[tier_a_writer] --output-dir not specified: JSON not written")

    sys.exit(0)


if __name__ == "__main__":
    _cli_main()
