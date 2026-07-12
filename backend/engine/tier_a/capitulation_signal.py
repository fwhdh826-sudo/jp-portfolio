"""
Capitulation Signal — Card 1-4
4条件の成立判定を行い検出結果を返す。Detection only — 売買・実行なし。

Reference: docs/constitution/PRINCIPLES.md Section 5
Reference: docs/v13.3/07_v13.3_spec.md Section 7.3
"""
from __future__ import annotations

from dataclasses import dataclass, field

# ── Constants (PRINCIPLES.md Section 5 / 07_spec.md Section 7.3) ─────────────
CAP_VIX_THRESHOLD: float = 35.0        # vix > 35
CAP_NIKKEI_5D_THRESHOLD: float = -0.08 # nikkei_5d_return < -0.08
CAP_RSI_THRESHOLD: float = 30.0        # nikkei_rsi_14 < 30
CAP_VOLUME_MULTIPLIER: float = 2.0     # nikkei_volume > avg_60d * 2

PARTIAL_CAPITULATION_COUNT: int = 3    # 3条件成立 → is_partial_capitulation


# ── Input dataclass ───────────────────────────────────────────────────────────

@dataclass
class CapitulationMarketInput:
    vix: float
    nikkei_5d_return: float   # 5日間リターン e.g. -0.09 (-9%)
    nikkei_rsi_14: float      # RSI(14) 0-100
    nikkei_volume: float      # 当日出来高（任意単位、avg_60d と同単位）
    avg_volume_60d: float     # 60日平均出来高


# ── Output dataclasses ────────────────────────────────────────────────────────

@dataclass
class ConditionStatus:
    name: str
    condition_str: str      # 人間可読な条件式
    current_value: float    # 現在値
    met: bool


@dataclass
class CapitulationResult:
    conditions: dict[str, ConditionStatus]
    conditions_met: int              # 0-4
    is_capitulation: bool            # 4条件全て成立
    is_partial_capitulation: bool    # 3条件以上成立
    alert_level: str                 # "OPPORTUNITY" | "WATCH"


# ── Detection function ────────────────────────────────────────────────────────

def check_capitulation(market: CapitulationMarketInput) -> CapitulationResult:
    """
    Capitulation Signal 4条件を評価し CapitulationResult を返す。
    Detection only — 売買・ファイル書き込みなし。

    4条件全成立 → is_capitulation=True, alert_level="OPPORTUNITY"
    3条件成立   → is_partial_capitulation=True, alert_level="WATCH"
    2条件以下   → 両方 False, alert_level="WATCH"
    """
    vix_spike = ConditionStatus(
        name="vix_spike",
        condition_str=f"vix > {CAP_VIX_THRESHOLD:.0f}",
        current_value=market.vix,
        met=market.vix > CAP_VIX_THRESHOLD,
    )
    panic_selling = ConditionStatus(
        name="panic_selling",
        condition_str=f"nikkei_5d_return < {CAP_NIKKEI_5D_THRESHOLD:.0%}",
        current_value=market.nikkei_5d_return,
        met=market.nikkei_5d_return < CAP_NIKKEI_5D_THRESHOLD,
    )
    oversold = ConditionStatus(
        name="oversold",
        condition_str=f"nikkei_rsi_14 < {CAP_RSI_THRESHOLD:.0f}",
        current_value=market.nikkei_rsi_14,
        met=market.nikkei_rsi_14 < CAP_RSI_THRESHOLD,
    )
    volume_spike = ConditionStatus(
        name="volume_spike",
        condition_str=f"nikkei_volume > avg_60d * {CAP_VOLUME_MULTIPLIER:.0f}",
        current_value=market.nikkei_volume / market.avg_volume_60d if market.avg_volume_60d > 0 else 0.0,
        met=market.nikkei_volume > market.avg_volume_60d * CAP_VOLUME_MULTIPLIER,
    )

    conditions = {
        "vix_spike": vix_spike,
        "panic_selling": panic_selling,
        "oversold": oversold,
        "volume_spike": volume_spike,
    }
    conditions_met = sum(c.met for c in conditions.values())
    is_capitulation = conditions_met >= 4
    is_partial = conditions_met >= PARTIAL_CAPITULATION_COUNT

    return CapitulationResult(
        conditions=conditions,
        conditions_met=conditions_met,
        is_capitulation=is_capitulation,
        is_partial_capitulation=is_partial,
        alert_level="OPPORTUNITY" if is_capitulation else "WATCH",
    )
