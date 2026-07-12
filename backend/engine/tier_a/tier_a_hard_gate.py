"""
Tier A Hard Gate — Card 1-2
Detection-only. No orders are placed, no positions are modified.
All actions carry _recommended suffix: final execution is the user's decision.

Reference: docs/constitution/PRINCIPLES.md Section 3
Reference: docs/v13.3/07_v13.3_spec.md Section 9
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

# ── Constants (PRINCIPLES.md Section 3) ─────────────────────────────────────
T1_STOP_LOSS_THRESHOLD: float = -0.40       # 個別ポジション含み損 ≤ -40%
T2_SECTOR_MAX_WEIGHT: float = 0.35          # セクター比率 > 35%
T3_PORTFOLIO_DD_THRESHOLD: float = -0.30    # PF ドローダウン ≤ -30%
T4_VIX_THRESHOLD: float = 40.0             # VIX > 40
T4_NIKKEI_DAILY_DECLINE: float = -0.02     # 日経3日連続 ≤ -2%
T4_CONSECUTIVE_DAYS: int = 3


# ── Input dataclasses ────────────────────────────────────────────────────────

@dataclass
class PositionInput:
    ticker: str
    sector: str
    unrealized_return: float   # e.g. -0.45 means -45%
    weight: float              # portfolio weight 0.0 ~ 1.0


@dataclass
class PortfolioInput:
    positions: list[PositionInput]
    drawdown: float            # current PF drawdown from peak, e.g. -0.32


@dataclass
class MarketInput:
    vix: float
    nikkei_daily_returns: list[float]   # last N days, newest last
    is_capitulation_signal: bool        # from capitulation_signal.py (Card 1-4)


# ── Output dataclasses ───────────────────────────────────────────────────────

@dataclass
class HardViolation:
    rule_id: str               # "T1" | "T2" | "T3" | "T4"
    triggered: bool
    detail: str
    action_recommended: str    # detection only — user decides execution


@dataclass
class HardGateResult:
    violations: list[HardViolation] = field(default_factory=list)
    any_triggered: bool = False
    safe_mode_recommended: bool = False    # True when T3 triggers


# ── Tier A Hard checks ───────────────────────────────────────────────────────

def check_t1_stop_loss(positions: list[PositionInput]) -> list[HardViolation]:
    """T1: 個別ポジション含み損 ≤ -40% → 強制売却推奨"""
    violations: list[HardViolation] = []
    for pos in positions:
        if pos.unrealized_return <= T1_STOP_LOSS_THRESHOLD:
            violations.append(HardViolation(
                rule_id="T1",
                triggered=True,
                detail=(
                    f"{pos.ticker} 含み損 {pos.unrealized_return:.1%} "
                    f"≤ {T1_STOP_LOSS_THRESHOLD:.0%}"
                ),
                action_recommended="force_sell_recommended",
            ))
    return violations


def check_t2_sector_cap(positions: list[PositionInput]) -> list[HardViolation]:
    """T2: セクター比率 > 35% → 35%への圧縮推奨"""
    sector_weights: dict[str, float] = {}
    for pos in positions:
        sector_weights[pos.sector] = sector_weights.get(pos.sector, 0.0) + pos.weight

    violations: list[HardViolation] = []
    for sector, weight in sector_weights.items():
        if weight > T2_SECTOR_MAX_WEIGHT:
            violations.append(HardViolation(
                rule_id="T2",
                triggered=True,
                detail=(
                    f"セクター '{sector}' 比率 {weight:.1%} "
                    f"> {T2_SECTOR_MAX_WEIGHT:.0%}"
                ),
                action_recommended="compress_to_35pct_recommended",
            ))
    return violations


def check_t3_portfolio_dd(
    portfolio: PortfolioInput,
    is_capitulation: bool,
) -> HardViolation:
    """T3: PF DD ≤ -30% → 全新規買い凍結推奨（Capitulation Signal 時のみ例外）"""
    if portfolio.drawdown <= T3_PORTFOLIO_DD_THRESHOLD:
        if is_capitulation:
            return HardViolation(
                rule_id="T3",
                triggered=False,
                detail=(
                    f"PF DD {portfolio.drawdown:.1%} ≤ {T3_PORTFOLIO_DD_THRESHOLD:.0%} "
                    "だが Capitulation Signal により例外適用"
                ),
                action_recommended="capitulation_exception_applied",
            )
        return HardViolation(
            rule_id="T3",
            triggered=True,
            detail=(
                f"PF DD {portfolio.drawdown:.1%} ≤ {T3_PORTFOLIO_DD_THRESHOLD:.0%}"
            ),
            action_recommended="freeze_all_buys_recommended",
        )
    return HardViolation(
        rule_id="T3",
        triggered=False,
        detail=f"PF DD {portfolio.drawdown:.1%} — T3 未トリガー",
        action_recommended="none",
    )


def check_t4_capitulation_l3(market: MarketInput) -> HardViolation:
    """T4: VIX>40 AND 日経3日連続 -2%以上 → リスク資産50%縮小推奨"""
    vix_breach = market.vix > T4_VIX_THRESHOLD

    recent = market.nikkei_daily_returns[-T4_CONSECUTIVE_DAYS:]
    consecutive_decline = (
        len(recent) >= T4_CONSECUTIVE_DAYS
        and all(r <= T4_NIKKEI_DAILY_DECLINE for r in recent)
    )

    triggered = vix_breach and consecutive_decline

    if triggered:
        return HardViolation(
            rule_id="T4",
            triggered=True,
            detail=(
                f"VIX {market.vix:.1f} > {T4_VIX_THRESHOLD:.0f} AND "
                f"日経{T4_CONSECUTIVE_DAYS}日連続 ≤ {T4_NIKKEI_DAILY_DECLINE:.0%} "
                f"({[f'{r:.2%}' for r in recent]})"
            ),
            action_recommended="scale_down_risk_50pct_recommended",
        )
    return HardViolation(
        rule_id="T4",
        triggered=False,
        detail=(
            f"VIX {market.vix:.1f}, "
            f"連続下落={consecutive_decline} — T4 未トリガー"
        ),
        action_recommended="none",
    )


# ── Aggregator ───────────────────────────────────────────────────────────────

def evaluate_hard_gate(
    portfolio: PortfolioInput,
    market: MarketInput,
) -> HardGateResult:
    """
    T1-T4 を評価し HardGateResult を返す。
    Detection-only: 実行判断はユーザーに委ねる。
    """
    violations: list[HardViolation] = []

    t1 = check_t1_stop_loss(portfolio.positions)
    if t1:
        violations.extend(t1)
    else:
        violations.append(HardViolation(
            rule_id="T1", triggered=False,
            detail="全ポジション T1 クリア", action_recommended="none",
        ))

    t2 = check_t2_sector_cap(portfolio.positions)
    if t2:
        violations.extend(t2)
    else:
        violations.append(HardViolation(
            rule_id="T2", triggered=False,
            detail="全セクター T2 クリア", action_recommended="none",
        ))

    violations.append(check_t3_portfolio_dd(portfolio, market.is_capitulation_signal))
    violations.append(check_t4_capitulation_l3(market))

    any_triggered = any(v.triggered for v in violations)
    safe_mode = any(
        v.triggered and v.rule_id == "T3" for v in violations
    )

    return HardGateResult(
        violations=violations,
        any_triggered=any_triggered,
        safe_mode_recommended=safe_mode,
    )
