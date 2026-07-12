"""
P4-A28: safe_mode.json generator

入力: public/data/market.json / public/data/regime_state.json / public/data/news.json
     (fallback: data/ variants)
出力: data/safe_mode.json + public/data/safe_mode.json

kind:   operation_snapshot
schema: v13.3 (safe_mode.json contract)

SAFE_MODE active 条件 (safe_mode.py 参照):
  tier1_data_stale  : market / regime / news が鮮度切れ
  crisis_regime     : regime_state.json で current_regime == "crisis"
  tier_a_t3_violated: T3 (PF DD ≤ -30%) — CLI からは常に False（ポートフォリオデータ不在）
  system_error      : watchdog 連続失敗 — CLI からは常に False（watchdog_events 空）

fail-closed: タイムスタンプ取得失敗 (JSON 未配置) → tier1_data_stale=True → active=True
"""
from __future__ import annotations

import json
import pathlib
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional

_REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from backend.engine.operation.data_freshness import evaluate_freshness
from backend.engine.operation.safe_mode import evaluate_safe_mode
from backend.engine.operation.watchdog import evaluate_watchdog
from backend.engine.operation._routine_common import build_safe_mode_input
from backend.engine.operation.recovery_log_writer import write_safe_mode_snapshot

GENERATOR = "data/update_safe_mode.py"

DEFAULT_DATA_DIRS: list[pathlib.Path] = [
    pathlib.Path("public/data"),
    pathlib.Path("data"),
]

DEFAULT_OUTPUT_PATHS: list[pathlib.Path] = [
    pathlib.Path("data/safe_mode.json"),
    pathlib.Path("public/data/safe_mode.json"),
]


# ---------------------------------------------------------------------------
# JSON / timestamp helpers
# ---------------------------------------------------------------------------

def _read_json(candidates: list[pathlib.Path]) -> Optional[dict]:
    for p in candidates:
        if p.exists():
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    return data
            except Exception:
                continue
    return None


def _parse_dt(value: object) -> Optional[datetime]:
    if not value:
        return None
    try:
        raw = str(value).replace(" ", "T")
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            # naive datetime → assume JST (UTC+9)
            dt = dt.replace(tzinfo=timezone(timedelta(hours=9)))
        return dt
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Input readers
# ---------------------------------------------------------------------------

def load_timestamps(data_dirs: list[pathlib.Path]) -> dict[str, Optional[datetime]]:
    """Read Tier 1 data timestamps for freshness evaluation.

    Keys match evaluate_freshness() source names:
      market : market.json   → last_updated
      regime : regime_state.json → _meta.generatedAt
      news   : news.json     → updatedAt
    """
    market = _read_json([d / "market.json" for d in data_dirs])
    regime = _read_json([d / "regime_state.json" for d in data_dirs])
    news   = _read_json([d / "news.json" for d in data_dirs])
    return {
        "market": _parse_dt(market.get("last_updated") if market else None),
        "regime": _parse_dt((regime or {}).get("_meta", {}).get("generatedAt")),
        "news":   _parse_dt((news or {}).get("updatedAt")),
    }


def load_crisis_regime(data_dirs: list[pathlib.Path]) -> bool:
    """Return True when regime_state.json reports current_regime == "crisis"."""
    regime = _read_json([d / "regime_state.json" for d in data_dirs])
    if regime is None:
        return False
    try:
        return str(regime["regime_state"]["current_regime"]) == "crisis"
    except (KeyError, TypeError):
        return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(
    data_dirs: list[pathlib.Path] | None = None,
    output_paths: list[pathlib.Path] | None = None,
) -> None:
    if data_dirs is None:
        data_dirs = DEFAULT_DATA_DIRS
    if output_paths is None:
        output_paths = DEFAULT_OUTPUT_PATHS

    now = datetime.now(timezone.utc)

    timestamps    = load_timestamps(data_dirs)
    crisis_regime = load_crisis_regime(data_dirs)

    freshness = evaluate_freshness(timestamps, now=now)
    watchdog  = evaluate_watchdog([], now=now)
    sm_input  = build_safe_mode_input(freshness, watchdog, crisis_regime=crisis_regime)
    sm_result = evaluate_safe_mode(sm_input, now=now)

    print(f"[update_safe_mode] generator={GENERATOR}")
    print(f"[update_safe_mode] checked_at={now.isoformat()}")
    print(f"[update_safe_mode] crisis_regime={crisis_regime}")
    print(f"[update_safe_mode] tier1_data_stale={freshness.safe_mode_triggered}")
    print(f"[update_safe_mode] safe_mode.active={sm_result.active}")
    print(f"[update_safe_mode] trigger_reason={sm_result.trigger_reason}")
    for name, ts in timestamps.items():
        age_str = f"{(now - ts).total_seconds() / 60:.1f}min" if ts else "N/A"
        stale = freshness.sources.get(name)
        status_str = stale.status if stale else "?"
        print(f"[update_safe_mode] ts[{name}] age={age_str} status={status_str}")

    for output_path in output_paths:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        write_safe_mode_snapshot(sm_result, output_path)
        print(f"  ✓ {output_path}")


if __name__ == "__main__":
    main()
