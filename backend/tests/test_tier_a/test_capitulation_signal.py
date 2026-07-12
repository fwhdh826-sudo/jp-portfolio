"""
Card 1-4 — Capitulation Signal テスト
4条件検出ロジックを担保するテスト群。
"""
from __future__ import annotations

import pytest

from backend.engine.tier_a.capitulation_signal import (
    CAP_VIX_THRESHOLD,
    CAP_NIKKEI_5D_THRESHOLD,
    CAP_RSI_THRESHOLD,
    CAP_VOLUME_MULTIPLIER,
    PARTIAL_CAPITULATION_COUNT,
    CapitulationMarketInput,
    CapitulationResult,
    ConditionStatus,
    check_capitulation,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

def _market(
    vix: float = 22.5,
    nikkei_5d_return: float = 0.01,
    nikkei_rsi_14: float = 52.0,
    nikkei_volume: float = 1.0,
    avg_volume_60d: float = 1.0,
) -> CapitulationMarketInput:
    return CapitulationMarketInput(
        vix=vix,
        nikkei_5d_return=nikkei_5d_return,
        nikkei_rsi_14=nikkei_rsi_14,
        nikkei_volume=nikkei_volume,
        avg_volume_60d=avg_volume_60d,
    )


def _all_4_met() -> CapitulationMarketInput:
    """4条件全成立のマーケット入力"""
    return _market(
        vix=40.0,                  # > 35 ✓
        nikkei_5d_return=-0.10,    # < -0.08 ✓
        nikkei_rsi_14=25.0,        # < 30 ✓
        nikkei_volume=3.0,         # > avg(1.0) × 2 ✓
        avg_volume_60d=1.0,
    )


# ── Constants ─────────────────────────────────────────────────────────────────

def test_constants_match_spec():
    assert CAP_VIX_THRESHOLD == 35.0
    assert CAP_NIKKEI_5D_THRESHOLD == pytest.approx(-0.08)
    assert CAP_RSI_THRESHOLD == 30.0
    assert CAP_VOLUME_MULTIPLIER == 2.0
    assert PARTIAL_CAPITULATION_COUNT == 3


# ── 全条件成立 ────────────────────────────────────────────────────────────────

def test_all_4_conditions_met_is_capitulation():
    result = check_capitulation(_all_4_met())
    assert isinstance(result, CapitulationResult)
    assert result.conditions_met == 4
    assert result.is_capitulation is True
    assert result.is_partial_capitulation is True
    assert result.alert_level == "OPPORTUNITY"


# ── 3条件成立（部分キャピチュレーション） ─────────────────────────────────────

def test_exactly_3_conditions_met_is_partial():
    # volume_spike だけ未成立
    market = _market(
        vix=40.0, nikkei_5d_return=-0.10, nikkei_rsi_14=25.0,
        nikkei_volume=1.5, avg_volume_60d=1.0,   # 1.5 < 2.0 → not met
    )
    result = check_capitulation(market)
    assert result.conditions_met == 3
    assert result.is_capitulation is False
    assert result.is_partial_capitulation is True
    assert result.alert_level == "WATCH"


# ── 2条件成立 ─────────────────────────────────────────────────────────────────

def test_2_conditions_met_not_capitulation():
    market = _market(
        vix=40.0, nikkei_5d_return=-0.10,   # 2条件のみ成立
        nikkei_rsi_14=52.0, nikkei_volume=1.0, avg_volume_60d=1.0,
    )
    result = check_capitulation(market)
    assert result.conditions_met == 2
    assert result.is_capitulation is False
    assert result.is_partial_capitulation is False
    assert result.alert_level == "WATCH"


# ── 0条件成立 ─────────────────────────────────────────────────────────────────

def test_0_conditions_met():
    result = check_capitulation(_market())   # デフォルト → 条件未成立
    assert result.conditions_met == 0
    assert result.is_capitulation is False
    assert result.is_partial_capitulation is False
    assert result.alert_level == "WATCH"


# ── 個別条件テスト ────────────────────────────────────────────────────────────

def test_vix_spike_condition_only():
    market = _market(vix=36.0)   # vix > 35 のみ成立
    result = check_capitulation(market)
    assert result.conditions["vix_spike"].met is True
    assert result.conditions["panic_selling"].met is False
    assert result.conditions["oversold"].met is False
    assert result.conditions["volume_spike"].met is False
    assert result.conditions_met == 1


def test_panic_selling_condition_only():
    market = _market(nikkei_5d_return=-0.09)   # < -0.08 のみ成立
    result = check_capitulation(market)
    assert result.conditions["panic_selling"].met is True
    assert result.conditions["vix_spike"].met is False
    assert result.conditions_met == 1


def test_oversold_condition_only():
    market = _market(nikkei_rsi_14=28.0)   # < 30 のみ成立
    result = check_capitulation(market)
    assert result.conditions["oversold"].met is True
    assert result.conditions["vix_spike"].met is False
    assert result.conditions_met == 1


def test_volume_spike_condition_only():
    market = _market(nikkei_volume=2.5, avg_volume_60d=1.0)  # > avg × 2 のみ成立
    result = check_capitulation(market)
    assert result.conditions["volume_spike"].met is True
    assert result.conditions["vix_spike"].met is False
    assert result.conditions_met == 1


# ── 境界値テスト ──────────────────────────────────────────────────────────────

def test_vix_exactly_at_threshold_not_met():
    # vix = 35.0 → NOT > 35 → not met
    market = _market(vix=35.0)
    result = check_capitulation(market)
    assert result.conditions["vix_spike"].met is False


def test_nikkei_5d_exactly_at_threshold_not_met():
    # nikkei_5d_return = -0.08 → NOT < -0.08 → not met
    market = _market(nikkei_5d_return=-0.08)
    result = check_capitulation(market)
    assert result.conditions["panic_selling"].met is False


# ── conditions_met カウント精度 ───────────────────────────────────────────────

def test_conditions_met_count_is_accurate():
    """met=True の条件数と conditions_met が一致する"""
    result = check_capitulation(_all_4_met())
    manual_count = sum(c.met for c in result.conditions.values())
    assert result.conditions_met == manual_count == 4

    market_1 = _market(vix=36.0)   # 1条件のみ
    result_1 = check_capitulation(market_1)
    manual_1 = sum(c.met for c in result_1.conditions.values())
    assert result_1.conditions_met == manual_1 == 1
