"""
size_segments.json Schema Generator — Card 3-8
Layer 4 → JSON: list[SizeResult] を size_segments.json 相当の dict に変換する。
Detection-only. No file writes. No Operation Routines connection.

Reference: docs/v13.3/07_v13.3_spec.md Section 5.2 / 13 (Layer 4)
"""
from __future__ import annotations

from datetime import datetime, timezone

from backend.engine.universe.size_segments import SizeResult

SCHEMA_VERSION = "3.8"


def build_size_segments_dict(
    results: list[SizeResult],
    generated_at: datetime | None = None,
) -> dict:
    """
    list[SizeResult] から size_segments.json 相当の dict を生成する。

    Returns:
        {
            "size_segments": {
                "schema_version": "3.8",
                "generated_at": "...",
                "count": int,
                "segments": [
                    {"ticker": str, "size_segment": str, "market_cap": float},
                    ...
                ]
            }
        }
    """
    if generated_at is None:
        generated_at = datetime.now(timezone.utc)

    return {
        "size_segments": {
            "schema_version": SCHEMA_VERSION,
            "generated_at": generated_at.isoformat(),
            "count": len(results),
            "segments": [
                {
                    "ticker": r.ticker,
                    "size_segment": r.size_segment,
                    "market_cap": r.market_cap,
                }
                for r in results
            ],
        }
    }
