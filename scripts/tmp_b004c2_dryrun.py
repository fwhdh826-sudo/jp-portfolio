#!/usr/bin/env python3
"""TEMPORARY — P5-B004c-2-ACTIONS-DRY-RUN dry-run entrypoint.

Read-only measurement script for GitHub Actions runners. Calls
get_jpx_universe() -> build_cheap_prescreen_shortlist() using temporary
cache paths (never data/.jpx_cache/), never writes to public/data, never
touches candidates_stocks.json, and does not connect to
default_universe_provider. This file is removed after the dry-run
session; it is not part of the production pipeline.

Usage: DRYRUN_BATCH_SIZE=400 python3 scripts/tmp_b004c2_dryrun.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data.jpx_cheap_prescreen import (  # noqa: E402
    build_cheap_prescreen_shortlist,
    jpx_items_to_tickers,
)
from data.jpx_universe_provider import get_jpx_universe  # noqa: E402


def main() -> int:
    batch_size = int(os.environ.get("DRYRUN_BATCH_SIZE", "400"))

    tmp_root = Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir()))
    run_dir = Path(tempfile.mkdtemp(prefix=f"b004c2-dryrun-{batch_size}-", dir=tmp_root))
    universe_cache_path = run_dir / "jpx_universe_cache.json"
    shortlist_cache_path = run_dir / "cheap_prescreen_cache.json"

    observations: dict = {"batch_size": batch_size}

    try:
        t0 = time.perf_counter()
        universe = get_jpx_universe(cache_path=universe_cache_path)
        t1 = time.perf_counter()

        tickers = jpx_items_to_tickers(universe.items)

        observations.update(
            {
                "universe_raw_row_count": universe.row_count,
                "universe_eligible_count": universe.eligible_count,
                "universe_fallback_used": universe.fallback_used,
                "universe_source": universe.source,
                "universe_source_identifier": universe.source_identifier,
                "universe_cache_age_hours": universe.cache_age_hours,
                "universe_fetch_seconds": round(t1 - t0, 2),
                "requested_ticker_count": len(tickers),
            }
        )

        if universe.fallback_used and len(universe.items) < 1000:
            observations["prescreen_skipped_reason"] = (
                "universe fallback produced < 1000 eligible items "
                "(likely seed_list_v1 fallback); pre-screen would bypass "
                "at this size, so it was not executed"
            )
            print(json.dumps(observations, ensure_ascii=False, indent=2))
            return 0

        t2 = time.perf_counter()
        result = build_cheap_prescreen_shortlist(
            universe,
            batch_size=batch_size,
            cache_path=shortlist_cache_path,
        )
        t3 = time.perf_counter()

        sector_counts = Counter(e.sector for e in result.entries)
        sector_count = len(sector_counts)
        if sector_counts:
            max_sector_n = sector_counts.most_common(1)[0][1]
            max_sector_share = max_sector_n / len(result.entries)
        else:
            max_sector_n, max_sector_share = 0, 0.0

        batch_count_planned = -(-len(tickers) // batch_size)
        success_ticker_count = round(result.success_ratio * len(tickers))

        observations.update(
            {
                "prescreen_runtime_seconds": round(t3 - t2, 2),
                "total_runtime_seconds": round(t3 - t0, 2),
                "batch_count_planned": batch_count_planned,
                "success_ticker_count": success_ticker_count,
                "success_ratio": round(result.success_ratio, 4),
                "rate_limit_detected": result.fetch_aborted,
                "abort_reason": result.abort_reason,
                "main_pool_count": result.main_pool_count,
                "newcomer_pool_count": result.newcomer_pool_count,
                "shortlist_count": result.shortlist_count,
                "target_shortlist": result.target_shortlist,
                "hard_max_shortlist": result.hard_max_shortlist,
                # sector name is a public 33-sector classification (not personal
                # data); only the count/share is reported, no per-ticker list.
                "sector_count": sector_count,
                "max_sector_count": max_sector_n,
                "max_sector_share": round(max_sector_share, 4),
                "sector_cap_relaxed": result.sector_cap_relaxed,
                "sector_cap_relaxed_count": result.sector_cap_relaxed_count,
                "fallback_used": result.fallback_used,
                "fallback_reason": result.fallback_reason,
                "bypass_seed_list_v1": result.bypass_seed_list_v1,
                "prescreen_cache_age_hours": result.cache_age_hours,
            }
        )
    except Exception as e:  # noqa: BLE001 - dry-run should report, not crash silently
        observations["unexpected_error"] = f"{type(e).__name__}: {e}"
        print(json.dumps(observations, ensure_ascii=False, indent=2))
        raise

    print(json.dumps(observations, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
