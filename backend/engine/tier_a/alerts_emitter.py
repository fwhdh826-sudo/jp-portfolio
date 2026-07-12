"""
Alerts Emitter — Card 1-4
L1/L2/L3/OPPORTUNITY アラートイベントを生成する。Detection only — 売買・実行なし。
SAFE_MODE のファイル書き込みは行わない。

Reference: docs/constitution/PRINCIPLES.md Section 6
Reference: docs/v13.3/07_v13.3_spec.md Section 7.3
"""
from __future__ import annotations

from dataclasses import dataclass, field

from backend.engine.tier_a.capitulation_signal import CapitulationResult

# ── Constants (PRINCIPLES.md Section 6) ──────────────────────────────────────
L1_DD_THRESHOLD: float = -0.10    # portfolio_dd ≤ -10%
L1_VIX_THRESHOLD: float = 30.0   # vix > 30
L2_DD_THRESHOLD: float = -0.20   # portfolio_dd ≤ -20%
L3_DD_THRESHOLD: float = -0.30   # portfolio_dd ≤ -30%

# Alert level priority order (ascending)
_LEVEL_ORDER = {"NONE": 0, "L1": 1, "L2": 2, "L3": 3, "OPPORTUNITY": 4}


# ── Input dataclass ───────────────────────────────────────────────────────────

@dataclass
class AlertsPortfolioInput:
    portfolio_drawdown: float  # 現在のPFドローダウン e.g. -0.15
    vix: float                 # L1 VIXチェック用


# ── Output dataclasses ────────────────────────────────────────────────────────

@dataclass
class AlertEvent:
    level: str                        # "L1" | "L2" | "L3" | "OPPORTUNITY"
    triggered: bool
    trigger_reasons: list[str]
    action_recommended: str           # detection only — _recommended suffix
    detail: str


@dataclass
class AlertsResult:
    l1: AlertEvent
    l2: AlertEvent
    l3: AlertEvent
    opportunity: AlertEvent
    highest_level: str                # "NONE" | "L1" | "L2" | "L3" | "OPPORTUNITY"
    has_opportunity: bool             # OPPORTUNITY アクティブか


# ── Individual alert checks ───────────────────────────────────────────────────

def _check_l1(portfolio: AlertsPortfolioInput) -> AlertEvent:
    """L1: PF DD ≤ -10% または VIX > 30 → 新規ポジションサイズ 50% 縮小推奨"""
    reasons: list[str] = []
    if portfolio.portfolio_drawdown <= L1_DD_THRESHOLD:
        reasons.append(f"PF DD {portfolio.portfolio_drawdown:.1%} ≤ {L1_DD_THRESHOLD:.0%}")
    if portfolio.vix > L1_VIX_THRESHOLD:
        reasons.append(f"VIX {portfolio.vix:.1f} > {L1_VIX_THRESHOLD:.0f}")

    triggered = len(reasons) > 0
    return AlertEvent(
        level="L1",
        triggered=triggered,
        trigger_reasons=reasons,
        action_recommended="reduce_new_position_size_50pct_recommended" if triggered else "none",
        detail=(
            f"L1 アクティブ: {', '.join(reasons)}"
            if triggered else
            f"L1 未トリガー (DD={portfolio.portfolio_drawdown:.1%}, VIX={portfolio.vix:.1f})"
        ),
    )


def _check_l2(portfolio: AlertsPortfolioInput) -> AlertEvent:
    """L2: PF DD ≤ -20% → Tactical 50% 縮小、現金15%確保推奨"""
    triggered = portfolio.portfolio_drawdown <= L2_DD_THRESHOLD
    reason = f"PF DD {portfolio.portfolio_drawdown:.1%} ≤ {L2_DD_THRESHOLD:.0%}"
    return AlertEvent(
        level="L2",
        triggered=triggered,
        trigger_reasons=[reason] if triggered else [],
        action_recommended="reduce_tactical_50pct_ensure_cash_15pct_recommended" if triggered else "none",
        detail=(
            f"L2 アクティブ: {reason}"
            if triggered else
            f"L2 未トリガー (DD={portfolio.portfolio_drawdown:.1%})"
        ),
    )


def _check_l3(portfolio: AlertsPortfolioInput) -> AlertEvent:
    """L3: PF DD ≤ -30% → 全リスク資産 50% 縮小、新規買い48時間凍結推奨"""
    triggered = portfolio.portfolio_drawdown <= L3_DD_THRESHOLD
    reason = f"PF DD {portfolio.portfolio_drawdown:.1%} ≤ {L3_DD_THRESHOLD:.0%}"
    return AlertEvent(
        level="L3",
        triggered=triggered,
        trigger_reasons=[reason] if triggered else [],
        action_recommended="reduce_all_risk_50pct_freeze_buys_48h_recommended" if triggered else "none",
        detail=(
            f"L3 アクティブ: {reason}"
            if triggered else
            f"L3 未トリガー (DD={portfolio.portfolio_drawdown:.1%})"
        ),
    )


def _check_opportunity(cap: CapitulationResult) -> AlertEvent:
    """OPPORTUNITY: Capitulation Signal 4条件成立 → 戦略的現金400万円投入推奨"""
    triggered = cap.is_capitulation
    return AlertEvent(
        level="OPPORTUNITY",
        triggered=triggered,
        trigger_reasons=(
            [f"Capitulation Signal {cap.conditions_met}/4 条件成立"]
            if triggered else []
        ),
        action_recommended="deploy_strategic_cash_4m_jpy_recommended" if triggered else "none",
        detail=(
            f"OPPORTUNITY アクティブ: {cap.conditions_met}/4 条件成立"
            if triggered else
            f"OPPORTUNITY 未トリガー ({cap.conditions_met}/4 条件成立)"
        ),
    )


# ── Aggregator ────────────────────────────────────────────────────────────────

def evaluate_alerts(
    portfolio: AlertsPortfolioInput,
    capitulation: CapitulationResult,
) -> AlertsResult:
    """
    L1/L2/L3/OPPORTUNITY を評価し AlertsResult を返す。
    Detection only — 売買・リバランス・SAFE_MODEファイル書き込みなし。
    OPPORTUNITY は L3 買い凍結の例外として最高優先度で報告する（実行はユーザー判断）。
    """
    l1 = _check_l1(portfolio)
    l2 = _check_l2(portfolio)
    l3 = _check_l3(portfolio)
    opportunity = _check_opportunity(capitulation)

    active_levels = [
        ev.level for ev in [l1, l2, l3, opportunity] if ev.triggered
    ]
    highest = max(
        active_levels,
        key=lambda lv: _LEVEL_ORDER[lv],
        default="NONE",
    )

    return AlertsResult(
        l1=l1,
        l2=l2,
        l3=l3,
        opportunity=opportunity,
        highest_level=highest,
        has_opportunity=opportunity.triggered,
    )
