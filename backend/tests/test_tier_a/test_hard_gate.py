"""
Card 1-2 — Tier A Hard Gate テスト
Detection-only であることを担保するテスト群。
"""
from __future__ import annotations

import pytest

from backend.engine.tier_a.tier_a_hard_gate import (
    T1_STOP_LOSS_THRESHOLD,
    T2_SECTOR_MAX_WEIGHT,
    T3_PORTFOLIO_DD_THRESHOLD,
    T4_VIX_THRESHOLD,
    T4_NIKKEI_DAILY_DECLINE,
    T4_CONSECUTIVE_DAYS,
    HardViolation,
    HardGateResult,
    MarketInput,
    PortfolioInput,
    PositionInput,
    check_t1_stop_loss,
    check_t2_sector_cap,
    check_t3_portfolio_dd,
    check_t4_capitulation_l3,
    evaluate_hard_gate,
)


# ── Fixtures ─────────────────────────────────────────────────────────────────

def make_positions(
    unrealized_return: float = -0.10,
    sector: str = "IT",
    weight: float = 0.10,
    ticker: str = "7203",
) -> list[PositionInput]:
    return [PositionInput(
        ticker=ticker,
        sector=sector,
        unrealized_return=unrealized_return,
        weight=weight,
    )]


def make_portfolio(drawdown: float = -0.05) -> PortfolioInput:
    return PortfolioInput(
        positions=make_positions(),
        drawdown=drawdown,
    )


def make_market(
    vix: float = 20.0,
    nikkei_returns: list[float] | None = None,
    is_capitulation: bool = False,
) -> MarketInput:
    if nikkei_returns is None:
        nikkei_returns = [0.01, 0.00, -0.01]
    return MarketInput(
        vix=vix,
        nikkei_daily_returns=nikkei_returns,
        is_capitulation_signal=is_capitulation,
    )


# ── Constants sanity ──────────────────────────────────────────────────────────

def test_constants_match_principles():
    assert T1_STOP_LOSS_THRESHOLD == -0.40
    assert T2_SECTOR_MAX_WEIGHT == 0.35
    assert T3_PORTFOLIO_DD_THRESHOLD == -0.30
    assert T4_VIX_THRESHOLD == 40.0
    assert T4_NIKKEI_DAILY_DECLINE == -0.02
    assert T4_CONSECUTIVE_DAYS == 3


# ── T1 ────────────────────────────────────────────────────────────────────────

def test_t1_no_violation():
    positions = make_positions(unrealized_return=-0.39)
    result = check_t1_stop_loss(positions)
    assert result == []


def test_t1_exactly_at_threshold_triggers():
    positions = make_positions(unrealized_return=-0.40)
    result = check_t1_stop_loss(positions)
    assert len(result) == 1
    assert result[0].triggered is True
    assert result[0].rule_id == "T1"
    assert result[0].action_recommended == "force_sell_recommended"


def test_t1_below_threshold_triggers():
    positions = make_positions(unrealized_return=-0.55)
    result = check_t1_stop_loss(positions)
    assert len(result) == 1
    assert result[0].triggered is True


def test_t1_multiple_positions_only_violated_flagged():
    positions = [
        PositionInput(ticker="A", sector="IT", unrealized_return=-0.45, weight=0.10),
        PositionInput(ticker="B", sector="IT", unrealized_return=-0.10, weight=0.10),
        PositionInput(ticker="C", sector="IT", unrealized_return=-0.80, weight=0.10),
    ]
    result = check_t1_stop_loss(positions)
    assert len(result) == 2
    tickers = [v.detail.split()[0] for v in result]
    assert "A" in tickers
    assert "C" in tickers


# ── T2 ────────────────────────────────────────────────────────────────────────

def test_t2_no_violation():
    positions = [
        PositionInput(ticker="A", sector="IT", unrealized_return=0.0, weight=0.20),
        PositionInput(ticker="B", sector="IT", unrealized_return=0.0, weight=0.14),
    ]
    result = check_t2_sector_cap(positions)
    assert result == []


def test_t2_sector_aggregation_triggers():
    positions = [
        PositionInput(ticker="A", sector="金融", unrealized_return=0.0, weight=0.20),
        PositionInput(ticker="B", sector="金融", unrealized_return=0.0, weight=0.16),
    ]
    result = check_t2_sector_cap(positions)
    assert len(result) == 1
    assert result[0].triggered is True
    assert result[0].rule_id == "T2"
    assert result[0].action_recommended == "compress_to_35pct_recommended"


def test_t2_exactly_35pct_no_violation():
    positions = [
        PositionInput(ticker="A", sector="素材", unrealized_return=0.0, weight=0.35),
    ]
    result = check_t2_sector_cap(positions)
    assert result == []


def test_t2_multiple_sectors_only_offending_flagged():
    positions = [
        PositionInput(ticker="A", sector="IT", unrealized_return=0.0, weight=0.20),
        PositionInput(ticker="B", sector="IT", unrealized_return=0.0, weight=0.20),
        PositionInput(ticker="C", sector="製造", unrealized_return=0.0, weight=0.30),
    ]
    result = check_t2_sector_cap(positions)
    assert len(result) == 1
    assert "IT" in result[0].detail


# ── T3 ────────────────────────────────────────────────────────────────────────

def test_t3_no_violation():
    pf = PortfolioInput(positions=[], drawdown=-0.20)
    result = check_t3_portfolio_dd(pf, is_capitulation=False)
    assert result.triggered is False
    assert result.action_recommended == "none"


def test_t3_exactly_at_threshold_triggers():
    pf = PortfolioInput(positions=[], drawdown=-0.30)
    result = check_t3_portfolio_dd(pf, is_capitulation=False)
    assert result.triggered is True
    assert result.rule_id == "T3"
    assert result.action_recommended == "freeze_all_buys_recommended"


def test_t3_capitulation_exception():
    pf = PortfolioInput(positions=[], drawdown=-0.35)
    result = check_t3_portfolio_dd(pf, is_capitulation=True)
    assert result.triggered is False
    assert result.action_recommended == "capitulation_exception_applied"


def test_t3_below_threshold_no_capitulation():
    pf = PortfolioInput(positions=[], drawdown=-0.45)
    result = check_t3_portfolio_dd(pf, is_capitulation=False)
    assert result.triggered is True
    assert result.action_recommended == "freeze_all_buys_recommended"


# ── T4 ────────────────────────────────────────────────────────────────────────

def _nikkei_3down() -> list[float]:
    return [-0.025, -0.030, -0.020]


def test_t4_no_violation_low_vix():
    market = make_market(vix=35.0, nikkei_returns=_nikkei_3down())
    result = check_t4_capitulation_l3(market)
    assert result.triggered is False


def test_t4_no_violation_not_consecutive():
    market = make_market(vix=45.0, nikkei_returns=[-0.025, 0.010, -0.020])
    result = check_t4_capitulation_l3(market)
    assert result.triggered is False


def test_t4_triggers_both_conditions():
    market = make_market(vix=41.0, nikkei_returns=_nikkei_3down())
    result = check_t4_capitulation_l3(market)
    assert result.triggered is True
    assert result.rule_id == "T4"
    assert result.action_recommended == "scale_down_risk_50pct_recommended"


def test_t4_exactly_at_vix_threshold_does_not_trigger():
    market = make_market(vix=40.0, nikkei_returns=_nikkei_3down())
    result = check_t4_capitulation_l3(market)
    assert result.triggered is False


def test_t4_uses_last_3_days_only():
    # 最初の3日は大幅下落だが、直近3日はフラット → 未トリガー
    returns = [-0.03, -0.03, -0.03, 0.01, 0.01, 0.00]
    market = make_market(vix=45.0, nikkei_returns=returns)
    result = check_t4_capitulation_l3(market)
    assert result.triggered is False


# ── evaluate_hard_gate ────────────────────────────────────────────────────────

def test_evaluate_no_violations():
    pf = make_portfolio(drawdown=-0.05)
    market = make_market()
    result = evaluate_hard_gate(pf, market)
    assert isinstance(result, HardGateResult)
    assert result.any_triggered is False
    assert result.safe_mode_recommended is False
    assert len(result.violations) == 4  # T1-T4 全て評価される


def test_evaluate_t3_sets_safe_mode():
    pf = PortfolioInput(positions=make_positions(), drawdown=-0.31)
    market = make_market(is_capitulation=False)
    result = evaluate_hard_gate(pf, market)
    assert result.any_triggered is True
    assert result.safe_mode_recommended is True


def test_evaluate_t3_capitulation_no_safe_mode():
    pf = PortfolioInput(positions=make_positions(), drawdown=-0.31)
    market = make_market(is_capitulation=True)
    result = evaluate_hard_gate(pf, market)
    assert result.safe_mode_recommended is False


def test_evaluate_all_rules_checked_always():
    """evaluate_hard_gate は常に T1-T4 全てを評価する"""
    pf = make_portfolio()
    market = make_market()
    result = evaluate_hard_gate(pf, market)
    rule_ids = [v.rule_id for v in result.violations]
    assert "T1" in rule_ids
    assert "T2" in rule_ids
    assert "T3" in rule_ids
    assert "T4" in rule_ids


def test_action_recommended_suffix_pattern():
    """detection-only: _recommended または _exception_applied のみ許可"""
    pf = PortfolioInput(
        positions=[
            PositionInput(ticker="X", sector="IT", unrealized_return=-0.50, weight=0.40),
        ],
        drawdown=-0.32,
    )
    market = make_market(vix=45.0, nikkei_returns=_nikkei_3down(), is_capitulation=False)
    result = evaluate_hard_gate(pf, market)

    allowed_suffixes = ("_recommended", "_exception_applied", "none")
    for v in result.violations:
        assert any(v.action_recommended.endswith(s) or v.action_recommended == s
                   for s in allowed_suffixes), (
            f"action_recommended '{v.action_recommended}' は detection-only パターン外"
        )
