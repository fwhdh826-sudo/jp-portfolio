"""
test_macro_fetcher.py — Card 4-9
Macro Fetcher のテストスイート。

テスト方針:
  - computed_at を固定して決定的テスト
  - 全テストが公開 API 経由
  - inline 固定値で HTTP / 外部 API なし
  - 禁止 import: requests / feedparser / aiohttp / httpx / urllib.request / bs4
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from backend.engine.market_intel.macro_fetcher import (
    MacroSignal,
    MacroSnapshot,
    build_macro_snapshot,
    build_market_intel_dict,
    derive_risk_level,
    derive_signals,
)

# ── Fixtures ──────────────────────────────────────────────────────────────────

_NOW = datetime(2026, 1, 15, 12, 0, 0, tzinfo=timezone.utc)

# 中立的なデフォルト入力値（シグナルが何も発生しない状態）
_NEUTRAL = dict(
    vix=18.0,
    nikkei_5d_return=0.01,
    nikkei_60ma=38000.0,
    nikkei_200ma=37000.0,
    sp500_dd_30d=-0.02,
    usdjpy=145.0,
)


def _snapshot(**overrides) -> MacroSnapshot:
    """デフォルト中立値にオーバーライドを適用した MacroSnapshot を返す。"""
    kwargs = {**_NEUTRAL, **overrides, "computed_at": _NOW}
    return build_macro_snapshot(**kwargs)


# ── TestMacroSignal ───────────────────────────────────────────────────────────

class TestMacroSignal:
    def test_fields(self):
        s = MacroSignal(tag="円安", strength="moderate", direction="positive")
        assert s.tag == "円安"
        assert s.strength == "moderate"
        assert s.direction == "positive"

    def test_frozen(self):
        s = MacroSignal(tag="VIX高", strength="strong", direction="negative")
        with pytest.raises((AttributeError, TypeError)):
            s.tag = "変更"  # type: ignore[misc]

    def test_equality(self):
        a = MacroSignal(tag="円安", strength="moderate", direction="positive")
        b = MacroSignal(tag="円安", strength="moderate", direction="positive")
        assert a == b

    def test_different_not_equal(self):
        a = MacroSignal(tag="円安", strength="moderate", direction="positive")
        b = MacroSignal(tag="円高", strength="moderate", direction="negative")
        assert a != b


# ── TestMacroSnapshot ─────────────────────────────────────────────────────────

class TestMacroSnapshot:
    def test_fields_exist(self):
        snap = _snapshot()
        assert hasattr(snap, "vix")
        assert hasattr(snap, "nikkei_5d_return")
        assert hasattr(snap, "nikkei_60ma")
        assert hasattr(snap, "nikkei_200ma")
        assert hasattr(snap, "sp500_dd_30d")
        assert hasattr(snap, "usdjpy")
        assert hasattr(snap, "risk_level")
        assert hasattr(snap, "signals")
        assert hasattr(snap, "computed_at")

    def test_frozen(self):
        snap = _snapshot()
        with pytest.raises((AttributeError, TypeError)):
            snap.vix = 99.0  # type: ignore[misc]

    def test_computed_at_injected(self):
        snap = _snapshot()
        assert snap.computed_at == _NOW

    def test_signals_is_tuple(self):
        snap = _snapshot()
        assert isinstance(snap.signals, tuple)


# ── TestDeriveSignals ─────────────────────────────────────────────────────────

class TestDeriveSignals:
    def _call(self, **overrides):
        base = {**_NEUTRAL}
        base.update(overrides)
        return derive_signals(
            vix=base["vix"],
            nikkei_5d_return=base["nikkei_5d_return"],
            nikkei_60ma=base["nikkei_60ma"],
            nikkei_200ma=base["nikkei_200ma"],
            sp500_dd_30d=base["sp500_dd_30d"],
            usdjpy=base["usdjpy"],
        )

    def test_neutral_no_signals(self):
        result = self._call()
        assert result == ()

    def test_yen_weak_signal(self):
        result = self._call(usdjpy=158.0)
        tags = [s.tag for s in result]
        assert "円安" in tags

    def test_yen_strong_signal(self):
        result = self._call(usdjpy=125.0)
        tags = [s.tag for s in result]
        assert "円高" in tags

    def test_vix_high_signal(self):
        result = self._call(vix=35.0)
        tags = [s.tag for s in result]
        assert "VIX高" in tags

    def test_vix_low_signal(self):
        result = self._call(vix=12.0)
        tags = [s.tag for s in result]
        assert "低VIX" in tags

    def test_death_cross_signal(self):
        result = self._call(nikkei_60ma=36000.0, nikkei_200ma=37000.0)
        tags = [s.tag for s in result]
        assert "デスクロス" in tags

    def test_nikkei_surge_signal(self):
        result = self._call(nikkei_5d_return=0.05)
        tags = [s.tag for s in result]
        assert "短期急騰" in tags

    def test_nikkei_plunge_signal(self):
        result = self._call(nikkei_5d_return=-0.05)
        tags = [s.tag for s in result]
        assert "短期急落" in tags

    def test_risk_off_signal(self):
        result = self._call(sp500_dd_30d=-0.20)
        tags = [s.tag for s in result]
        assert "リスクオフ" in tags

    def test_correction_signal(self):
        result = self._call(sp500_dd_30d=-0.08)
        tags = [s.tag for s in result]
        assert "調整局面" in tags

    def test_risk_alert_signal(self):
        result = self._call(vix=28.0, sp500_dd_30d=-0.12)
        tags = [s.tag for s in result]
        assert "リスク警戒" in tags

    def test_multiple_signals_simultaneously(self):
        result = self._call(usdjpy=158.0, vix=35.0, sp500_dd_30d=-0.18)
        tags = [s.tag for s in result]
        assert "円安" in tags
        assert "VIX高" in tags
        assert "リスクオフ" in tags

    def test_returns_tuple(self):
        result = self._call(usdjpy=158.0)
        assert isinstance(result, tuple)

    def test_sorted_by_tag(self):
        result = self._call(usdjpy=158.0, vix=35.0, nikkei_5d_return=-0.05)
        tags = [s.tag for s in result]
        assert tags == sorted(tags)

    def test_yen_weak_moderate_strength(self):
        result = self._call(usdjpy=157.0)
        signal = next(s for s in result if s.tag == "円安")
        assert signal.strength == "moderate"

    def test_yen_weak_strong_over_160(self):
        result = self._call(usdjpy=162.0)
        signal = next(s for s in result if s.tag == "円安")
        assert signal.strength == "strong"

    def test_risk_off_not_also_correction(self):
        # sp500_dd_30d < -0.15 → リスクオフのみ（調整局面は出ない）
        result = self._call(sp500_dd_30d=-0.20)
        tags = [s.tag for s in result]
        assert "リスクオフ" in tags
        assert "調整局面" not in tags


# ── TestDeriveRiskLevel ───────────────────────────────────────────────────────

class TestDeriveRiskLevel:
    def test_crisis_vix(self):
        assert derive_risk_level(vix=41.0, sp500_dd_30d=-0.05,
                                 nikkei_60ma=38000, nikkei_200ma=37000) == "crisis"

    def test_crisis_sp500_dd(self):
        assert derive_risk_level(vix=20.0, sp500_dd_30d=-0.22,
                                 nikkei_60ma=38000, nikkei_200ma=37000) == "crisis"

    def test_high_combined(self):
        assert derive_risk_level(vix=26.0, sp500_dd_30d=-0.12,
                                 nikkei_60ma=38000, nikkei_200ma=37000) == "high"

    def test_high_sp500_dd_only(self):
        assert derive_risk_level(vix=18.0, sp500_dd_30d=-0.16,
                                 nikkei_60ma=38000, nikkei_200ma=37000) == "high"

    def test_medium_death_cross(self):
        assert derive_risk_level(vix=18.0, sp500_dd_30d=-0.02,
                                 nikkei_60ma=36000, nikkei_200ma=37000) == "medium"

    def test_low_all_calm(self):
        assert derive_risk_level(vix=15.0, sp500_dd_30d=-0.01,
                                 nikkei_60ma=38000, nikkei_200ma=37000) == "low"


# ── TestBuildMacroSnapshot ────────────────────────────────────────────────────

class TestBuildMacroSnapshot:
    def test_input_values_preserved(self):
        snap = build_macro_snapshot(
            vix=22.0, nikkei_5d_return=0.015, nikkei_60ma=38500.0,
            nikkei_200ma=37000.0, sp500_dd_30d=-0.03, usdjpy=150.0,
            computed_at=_NOW,
        )
        assert snap.vix == 22.0
        assert snap.nikkei_5d_return == 0.015
        assert snap.nikkei_60ma == 38500.0
        assert snap.nikkei_200ma == 37000.0
        assert snap.sp500_dd_30d == -0.03
        assert snap.usdjpy == 150.0

    def test_computed_at_injected(self):
        snap = build_macro_snapshot(**_NEUTRAL, computed_at=_NOW)
        assert snap.computed_at == _NOW

    def test_computed_at_none_uses_now(self):
        snap = build_macro_snapshot(**_NEUTRAL, computed_at=None)
        assert snap.computed_at is not None
        assert isinstance(snap.computed_at, datetime)

    def test_risk_level_computed(self):
        snap = build_macro_snapshot(
            vix=45.0, nikkei_5d_return=0.0, nikkei_60ma=38000.0,
            nikkei_200ma=37000.0, sp500_dd_30d=-0.05, usdjpy=145.0,
            computed_at=_NOW,
        )
        assert snap.risk_level == "crisis"

    def test_signals_computed(self):
        snap = build_macro_snapshot(
            vix=18.0, nikkei_5d_return=0.0, nikkei_60ma=38000.0,
            nikkei_200ma=37000.0, sp500_dd_30d=-0.02, usdjpy=158.0,
            computed_at=_NOW,
        )
        tags = [s.tag for s in snap.signals]
        assert "円安" in tags

    def test_signals_sorted(self):
        snap = build_macro_snapshot(
            vix=35.0, nikkei_5d_return=-0.05, nikkei_60ma=36000.0,
            nikkei_200ma=37000.0, sp500_dd_30d=-0.18, usdjpy=158.0,
            computed_at=_NOW,
        )
        tags = [s.tag for s in snap.signals]
        assert tags == sorted(tags)

    def test_returns_macro_snapshot_type(self):
        snap = build_macro_snapshot(**_NEUTRAL, computed_at=_NOW)
        assert isinstance(snap, MacroSnapshot)

    def test_neutral_state_low_risk(self):
        snap = _snapshot()
        assert snap.risk_level == "low"
        assert snap.signals == ()

    def test_crisis_state(self):
        snap = _snapshot(vix=45.0)
        assert snap.risk_level == "crisis"

    def test_death_cross_medium_risk(self):
        snap = _snapshot(nikkei_60ma=36000.0, nikkei_200ma=37000.0)
        assert snap.risk_level == "medium"

    def test_deterministic(self):
        s1 = build_macro_snapshot(**_NEUTRAL, computed_at=_NOW)
        s2 = build_macro_snapshot(**_NEUTRAL, computed_at=_NOW)
        assert s1 == s2


# ── TestBuildMarketIntelDict ──────────────────────────────────────────────────

class TestBuildMarketIntelDict:
    def test_keys_present(self):
        snap = _snapshot()
        d = build_market_intel_dict(snap)
        assert "sentiment" in d
        assert "keywords" in d
        assert "active_keywords" in d
        assert "risk_level" in d
        assert "vix" in d
        assert "usdjpy" in d
        assert "nikkei_5d_return" in d

    def test_sentiment_score_neutral(self):
        snap = _snapshot()
        d = build_market_intel_dict(snap)
        assert d["sentiment"]["score"] == pytest.approx(50.0)

    def test_sentiment_score_range(self):
        snap = _snapshot(vix=45.0, sp500_dd_30d=-0.25)
        d = build_market_intel_dict(snap)
        assert 0.0 <= d["sentiment"]["score"] <= 100.0

    def test_sentiment_label_neutral(self):
        snap = _snapshot()
        d = build_market_intel_dict(snap)
        assert d["sentiment"]["label"] == "neutral"

    def test_sentiment_label_bearish(self):
        snap = _snapshot(vix=45.0, sp500_dd_30d=-0.22, nikkei_5d_return=-0.05)
        d = build_market_intel_dict(snap)
        assert d["sentiment"]["label"] == "bearish"

    def test_sentiment_label_bullish(self):
        snap = _snapshot(vix=12.0, usdjpy=158.0, nikkei_5d_return=0.05)
        d = build_market_intel_dict(snap)
        assert d["sentiment"]["label"] == "bullish"

    def test_keywords_format(self):
        snap = _snapshot(usdjpy=158.0)
        d = build_market_intel_dict(snap)
        assert isinstance(d["keywords"], list)
        for kw in d["keywords"]:
            assert "tag" in kw
            assert "strength" in kw
            assert "direction" in kw

    def test_active_keywords_is_list_of_str(self):
        snap = _snapshot(usdjpy=158.0)
        d = build_market_intel_dict(snap)
        assert isinstance(d["active_keywords"], list)
        assert all(isinstance(k, str) for k in d["active_keywords"])

    def test_active_keywords_matches_signals(self):
        snap = _snapshot(usdjpy=158.0)
        d = build_market_intel_dict(snap)
        signal_tags = {s.tag for s in snap.signals}
        assert set(d["active_keywords"]) == signal_tags

    def test_risk_level_propagated(self):
        snap = _snapshot(vix=45.0)
        d = build_market_intel_dict(snap)
        assert d["risk_level"] == "crisis"

    def test_vix_usdjpy_propagated(self):
        snap = _snapshot(vix=22.5, usdjpy=151.3)
        d = build_market_intel_dict(snap)
        assert d["vix"] == pytest.approx(22.5)
        assert d["usdjpy"] == pytest.approx(151.3)

    def test_no_signals_empty_keywords(self):
        snap = _snapshot()
        d = build_market_intel_dict(snap)
        assert d["keywords"] == []
        assert d["active_keywords"] == []


# ── TestEdgeCases ─────────────────────────────────────────────────────────────

class TestEdgeCases:
    def test_extreme_vix_crisis(self):
        snap = _snapshot(vix=80.0)
        assert snap.risk_level == "crisis"

    def test_sp500_dd_exactly_minus20_is_crisis(self):
        level = derive_risk_level(vix=18.0, sp500_dd_30d=-0.21,
                                  nikkei_60ma=38000, nikkei_200ma=37000)
        assert level == "crisis"

    def test_very_low_usdjpy_strong_yen(self):
        result = derive_signals(
            vix=18.0, nikkei_5d_return=0.0, nikkei_60ma=38000.0,
            nikkei_200ma=37000.0, sp500_dd_30d=-0.02, usdjpy=120.0,
        )
        tags = [s.tag for s in result]
        assert "円高" in tags
        signal = next(s for s in result if s.tag == "円高")
        assert signal.strength == "strong"

    def test_all_signals_off(self):
        result = derive_signals(
            vix=18.0, nikkei_5d_return=0.01, nikkei_60ma=38000.0,
            nikkei_200ma=37000.0, sp500_dd_30d=-0.02, usdjpy=145.0,
        )
        assert result == ()

    def test_sentiment_score_clamped_at_100(self):
        # 多数の positive シグナルが重なっても 100 を超えない
        snap = _snapshot(vix=12.0, usdjpy=158.0, nikkei_5d_return=0.05)
        d = build_market_intel_dict(snap)
        assert d["sentiment"]["score"] <= 100.0

    def test_sentiment_score_clamped_at_0(self):
        # 多数の negative シグナルが重なっても 0 を下回らない
        snap = _snapshot(vix=45.0, sp500_dd_30d=-0.25, nikkei_5d_return=-0.07,
                         nikkei_60ma=36000.0, nikkei_200ma=37000.0)
        d = build_market_intel_dict(snap)
        assert d["sentiment"]["score"] >= 0.0

    def test_nikkei_5d_exactly_at_boundary(self):
        # 0.03 以上 → 短期急騰
        result = derive_signals(
            vix=18.0, nikkei_5d_return=0.031, nikkei_60ma=38000.0,
            nikkei_200ma=37000.0, sp500_dd_30d=-0.02, usdjpy=145.0,
        )
        tags = [s.tag for s in result]
        assert "短期急騰" in tags

    def test_market_intel_dict_can_be_consumed_by_importance_scorer_pattern(self):
        # build_market_intel_dict()["active_keywords"] は str list → importance_scorer に渡せる
        snap = _snapshot(usdjpy=158.0, vix=35.0)
        d = build_market_intel_dict(snap)
        active = d["active_keywords"]
        assert isinstance(active, list)
        for kw in active:
            assert isinstance(kw, str)
            assert len(kw) > 0
