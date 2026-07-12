"""
Universe Size Segmentation — Card 3-6
Layer 4: 時価総額による Large / Mid / Small 分類。
Detection-only. No trades, no scores, no side effects.

Reference: docs/v13.3/07_v13.3_spec.md Section 5.2 (Strategy B threshold)
"""
from __future__ import annotations

import math
from dataclasses import dataclass

# ── Thresholds ────────────────────────────────────────────────────────────────
# Initial definition (v13.3). May be revised in Card 3-8+ if needed.
SMALL_CAP_THRESHOLD: int = 200_000_000_000    # < ¥200B  → small_cap
LARGE_CAP_THRESHOLD: int = 1_000_000_000_000  # >= ¥1T   → large_cap

SIZE_LABELS: tuple[str, ...] = ("large_cap", "mid_cap", "small_cap")


# ── Input / Output dataclasses ────────────────────────────────────────────────

@dataclass
class SizeInput:
    ticker: str
    market_cap: float  # JPY


@dataclass
class SizeResult:
    ticker: str
    size_segment: str  # one of SIZE_LABELS
    market_cap: float  # JPY


# ── Core pure function ────────────────────────────────────────────────────────

def classify_size(market_cap: float) -> str:
    """
    market_cap (JPY) → "large_cap" / "mid_cap" / "small_cap".

    Boundaries:
      small_cap  : market_cap < SMALL_CAP_THRESHOLD  (< ¥200B)
      mid_cap    : SMALL_CAP_THRESHOLD <= market_cap < LARGE_CAP_THRESHOLD
      large_cap  : market_cap >= LARGE_CAP_THRESHOLD (>= ¥1T)

    Raises ValueError for non-positive or non-finite values.
    """
    if not math.isfinite(market_cap):
        raise ValueError(f"market_cap must be finite: {market_cap!r}")
    if market_cap <= 0:
        raise ValueError(f"market_cap must be positive: {market_cap!r}")

    if market_cap >= LARGE_CAP_THRESHOLD:
        return "large_cap"
    if market_cap >= SMALL_CAP_THRESHOLD:
        return "mid_cap"
    return "small_cap"


# ── Batch API ─────────────────────────────────────────────────────────────────

def classify_size_batch(stocks: list[SizeInput]) -> list[SizeResult]:
    """各銘柄の market_cap を classify_size で分類してまとめて返す。"""
    return [
        SizeResult(
            ticker=s.ticker,
            size_segment=classify_size(s.market_cap),
            market_cap=s.market_cap,
        )
        for s in stocks
    ]
