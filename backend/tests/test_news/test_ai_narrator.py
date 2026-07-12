"""
test_ai_narrator.py — Card 4-9
AI Narrator のテストスイート。

テスト方針:
  - generated_at を固定して決定的テスト
  - MacroSnapshot は build_macro_snapshot で生成（inline 値）
  - NewsItem は rss_fetcher.NewsItem を使用
  - narrator_fn は lambda で stub
  - 禁止 import: requests / feedparser / aiohttp / httpx / urllib.request / bs4
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from backend.engine.market_intel.ai_narrator import (
    MarketNarrative,
    _build_body,
    _build_headline,
    _build_keywords_summary,
    narrate,
)
from backend.engine.market_intel.macro_fetcher import build_macro_snapshot
from backend.engine.news.rss_fetcher import NewsItem

# ── Fixtures ──────────────────────────────────────────────────────────────────

_NOW = datetime(2026, 1, 15, 12, 0, 0, tzinfo=timezone.utc)

_NEUTRAL = dict(
    vix=18.0,
    nikkei_5d_return=0.01,
    nikkei_60ma=38000.0,
    nikkei_200ma=37000.0,
    sp500_dd_30d=-0.02,
    usdjpy=145.0,
    computed_at=_NOW,
)

_CRISIS = dict(
    vix=45.0,
    nikkei_5d_return=-0.06,
    nikkei_60ma=36000.0,
    nikkei_200ma=37000.0,
    sp500_dd_30d=-0.22,
    usdjpy=148.0,
    computed_at=_NOW,
)

_HIGH_RISK = dict(
    vix=28.0,
    nikkei_5d_return=-0.04,
    nikkei_60ma=38000.0,
    nikkei_200ma=37000.0,
    sp500_dd_30d=-0.12,
    usdjpy=148.0,
    computed_at=_NOW,
)

_MEDIUM_RISK = dict(
    vix=18.0,
    nikkei_5d_return=0.01,
    nikkei_60ma=36000.0,   # デスクロス
    nikkei_200ma=37000.0,
    sp500_dd_30d=-0.02,
    usdjpy=145.0,
    computed_at=_NOW,
)

_LOW_RISK = dict(
    vix=13.0,
    nikkei_5d_return=0.02,
    nikkei_60ma=38000.0,
    nikkei_200ma=37000.0,
    sp500_dd_30d=-0.01,
    usdjpy=150.5,
    computed_at=_NOW,
)


def _snap(**overrides):
    kwargs = {**_NEUTRAL, **overrides}
    return build_macro_snapshot(**kwargs)


def _item(title: str, importance_score: float = 50.0, url: str = "https://example.com/1") -> NewsItem:
    return NewsItem(
        source_id="bloomberg",
        title=title,
        url=url,
        summary="",
        importance_score=importance_score,
    )


# ── TestMarketNarrative ───────────────────────────────────────────────────────

class TestMarketNarrative:
    def test_fields(self):
        snap = _snap(**_NEUTRAL)
        r = narrate(snap, generated_at=_NOW)
        assert isinstance(r.headline, str)
        assert isinstance(r.body_lines, tuple)
        assert isinstance(r.keywords_summary, tuple)
        assert r.sentiment_label in ("bullish", "neutral", "bearish")
        assert r.risk_level in ("low", "medium", "high", "crisis")
        assert r.method in ("rule_stub", "narrator_fn")
        assert isinstance(r.generated_at, datetime)

    def test_frozen(self):
        snap = _snap(**_NEUTRAL)
        r = narrate(snap, generated_at=_NOW)
        with pytest.raises((AttributeError, TypeError)):
            r.headline = "変更"  # type: ignore[misc]

    def test_generated_at_injected(self):
        snap = _snap(**_NEUTRAL)
        r = narrate(snap, generated_at=_NOW)
        assert r.generated_at == _NOW

    def test_generated_at_none_uses_now(self):
        snap = _snap(**_NEUTRAL)
        r = narrate(snap, generated_at=None)
        assert r.generated_at is not None
        assert isinstance(r.generated_at, datetime)


# ── TestNarrateRuleStub ───────────────────────────────────────────────────────

class TestNarrateRuleStub:
    def test_method_is_rule_stub(self):
        snap = _snap(**_NEUTRAL)
        r = narrate(snap, generated_at=_NOW)
        assert r.method == "rule_stub"

    def test_crisis_headline(self):
        snap = _snap(**_CRISIS)
        r = narrate(snap, generated_at=_NOW)
        assert "危機" in r.headline or "SAFE_MODE" in r.headline

    def test_high_risk_headline_contains_risk(self):
        snap = _snap(**_HIGH_RISK)
        r = narrate(snap, generated_at=_NOW)
        assert "リスク" in r.headline or "警戒" in r.headline

    def test_medium_risk_headline_contains_adjustment(self):
        snap = _snap(**_MEDIUM_RISK)
        r = narrate(snap, generated_at=_NOW)
        assert "調整" in r.headline

    def test_low_risk_headline_contains_calm(self):
        snap = _snap(**_LOW_RISK)
        r = narrate(snap, generated_at=_NOW)
        assert "落ち着いた" in r.headline or "150" in r.headline

    def test_body_lines_nonempty(self):
        snap = _snap(**_NEUTRAL)
        r = narrate(snap, generated_at=_NOW)
        assert len(r.body_lines) > 0

    def test_body_contains_vix(self):
        snap = _snap(**_NEUTRAL)
        r = narrate(snap, generated_at=_NOW)
        body = " ".join(r.body_lines)
        assert "VIX" in body

    def test_body_contains_risk_level(self):
        snap = _snap(**_NEUTRAL)
        r = narrate(snap, generated_at=_NOW)
        body = " ".join(r.body_lines)
        assert "リスクレベル" in body

    def test_body_contains_news_titles(self):
        snap = _snap(**_NEUTRAL)
        items = [
            _item("三菱重工が増益", importance_score=80.0, url="https://a.com/1"),
            _item("ソニーが好決算", importance_score=70.0, url="https://a.com/2"),
        ]
        r = narrate(snap, items=items, generated_at=_NOW)
        body = " ".join(r.body_lines)
        assert "三菱重工が増益" in body
        assert "ソニーが好決算" in body

    def test_body_items_max_5(self):
        snap = _snap(**_NEUTRAL)
        items = [
            _item(f"記事{i}", importance_score=float(50 + i), url=f"https://a.com/{i}")
            for i in range(10)
        ]
        r = narrate(snap, items=items, generated_at=_NOW)
        news_lines = [l for l in r.body_lines if l.startswith("・")]
        assert len(news_lines) <= 5

    def test_body_items_sorted_by_importance(self):
        snap = _snap(**_NEUTRAL)
        items = [
            _item("低重要度", importance_score=30.0, url="https://a.com/1"),
            _item("高重要度", importance_score=90.0, url="https://a.com/2"),
        ]
        r = narrate(snap, items=items, generated_at=_NOW)
        news_lines = [l for l in r.body_lines if l.startswith("・")]
        assert news_lines[0] == "・高重要度"

    def test_risk_level_propagated(self):
        snap = _snap(**_CRISIS)
        r = narrate(snap, generated_at=_NOW)
        assert r.risk_level == "crisis"

    def test_sentiment_label_bearish_for_crisis(self):
        snap = _snap(**_CRISIS)
        r = narrate(snap, generated_at=_NOW)
        assert r.sentiment_label == "bearish"


# ── TestNarrateNarratorFn ─────────────────────────────────────────────────────

class TestNarrateNarratorFn:
    def test_method_is_narrator_fn(self):
        snap = _snap(**_NEUTRAL)
        r = narrate(snap, narrator_fn=lambda s: "カスタム見出し", generated_at=_NOW)
        assert r.method == "narrator_fn"

    def test_headline_from_narrator_fn(self):
        snap = _snap(**_NEUTRAL)
        r = narrate(snap, narrator_fn=lambda s: "カスタム見出し", generated_at=_NOW)
        assert r.headline == "カスタム見出し"

    def test_body_still_rule_based(self):
        snap = _snap(**_NEUTRAL)
        r = narrate(snap, narrator_fn=lambda s: "見出し", generated_at=_NOW)
        body = " ".join(r.body_lines)
        assert "VIX" in body

    def test_keywords_still_rule_based(self):
        snap = _snap(usdjpy=158.0, vix=35.0, nikkei_5d_return=0.0,
                     nikkei_60ma=38000.0, nikkei_200ma=37000.0,
                     sp500_dd_30d=-0.02, computed_at=_NOW)
        r = narrate(snap, narrator_fn=lambda s: "見出し", generated_at=_NOW)
        assert len(r.keywords_summary) > 0

    def test_narrator_fn_receives_snapshot(self):
        snap = _snap(**_NEUTRAL)
        received = []
        def fn(s):
            received.append(s)
            return "受信確認"
        narrate(snap, narrator_fn=fn, generated_at=_NOW)
        assert received[0] is snap

    def test_narrator_fn_exception_propagates(self):
        snap = _snap(**_NEUTRAL)
        def bad_fn(s):
            raise ValueError("LLM error")
        with pytest.raises(ValueError, match="LLM error"):
            narrate(snap, narrator_fn=bad_fn, generated_at=_NOW)

    def test_narrator_fn_return_cast_to_str(self):
        snap = _snap(**_NEUTRAL)
        r = narrate(snap, narrator_fn=lambda s: "数値っぽい見出し123", generated_at=_NOW)
        assert isinstance(r.headline, str)

    def test_narrator_fn_none_uses_rule_stub(self):
        snap = _snap(**_NEUTRAL)
        r = narrate(snap, narrator_fn=None, generated_at=_NOW)
        assert r.method == "rule_stub"


# ── TestBuildHeadline ─────────────────────────────────────────────────────────

class TestBuildHeadline:
    def test_crisis(self):
        snap = _snap(**_CRISIS)
        h = _build_headline(snap)
        assert "危機" in h or "SAFE_MODE" in h

    def test_high_risk_with_signals(self):
        snap = _snap(**_HIGH_RISK)
        h = _build_headline(snap)
        assert "リスク" in h or "警戒" in h or "急落" in h

    def test_medium_risk(self):
        snap = _snap(**_MEDIUM_RISK)
        h = _build_headline(snap)
        assert "調整" in h

    def test_low_risk_no_signals(self):
        snap = _snap(**_NEUTRAL)
        h = _build_headline(snap)
        assert "落ち着いた" in h

    def test_low_risk_contains_usdjpy(self):
        snap = _snap(**_LOW_RISK)
        h = _build_headline(snap)
        assert "150" in h or "落ち着いた" in h

    def test_returns_string(self):
        snap = _snap(**_NEUTRAL)
        assert isinstance(_build_headline(snap), str)

    def test_nonempty(self):
        snap = _snap(**_CRISIS)
        assert len(_build_headline(snap)) > 0

    def test_medium_with_positive_signal(self):
        # medium risk + positive signal (円安)
        snap = _snap(
            vix=18.0, nikkei_5d_return=0.01, nikkei_60ma=36000.0,
            nikkei_200ma=37000.0, sp500_dd_30d=-0.02, usdjpy=158.0,
            computed_at=_NOW,
        )
        h = _build_headline(snap)
        assert isinstance(h, str)
        assert len(h) > 0


# ── TestBuildBody ─────────────────────────────────────────────────────────────

class TestBuildBody:
    def test_always_contains_vix_line(self):
        snap = _snap(**_NEUTRAL)
        body = _build_body(snap, [])
        assert any("VIX" in l for l in body)

    def test_always_contains_risk_level_line(self):
        snap = _snap(**_NEUTRAL)
        body = _build_body(snap, [])
        assert any("リスクレベル" in l for l in body)

    def test_signal_lines_appear(self):
        snap = _snap(usdjpy=158.0, vix=18.0, nikkei_5d_return=0.01,
                     nikkei_60ma=38000.0, nikkei_200ma=37000.0,
                     sp500_dd_30d=-0.02, computed_at=_NOW)
        body = _build_body(snap, [])
        assert any("円安" in l for l in body)

    def test_items_appear_as_bullet(self):
        snap = _snap(**_NEUTRAL)
        items = [_item("三菱重工が増益", importance_score=80.0)]
        body = _build_body(snap, items)
        assert any(l.startswith("・") and "三菱重工" in l for l in body)

    def test_empty_items(self):
        snap = _snap(**_NEUTRAL)
        body = _build_body(snap, [])
        assert isinstance(body, tuple)
        assert len(body) >= 2  # VIX行 + リスクレベル行は常にある

    def test_items_capped_at_5(self):
        snap = _snap(**_NEUTRAL)
        items = [_item(f"記事{i}", url=f"https://a.com/{i}") for i in range(10)]
        body = _build_body(snap, items)
        bullet_lines = [l for l in body if l.startswith("・")]
        assert len(bullet_lines) <= 5

    def test_returns_tuple(self):
        snap = _snap(**_NEUTRAL)
        body = _build_body(snap, [])
        assert isinstance(body, tuple)

    def test_items_sorted_by_importance_in_body(self):
        snap = _snap(**_NEUTRAL)
        items = [
            _item("低重要度", importance_score=20.0, url="https://a.com/1"),
            _item("高重要度", importance_score=90.0, url="https://a.com/2"),
        ]
        body = _build_body(snap, items)
        bullet_lines = [l for l in body if l.startswith("・")]
        assert bullet_lines[0] == "・高重要度"


# ── TestKeywordsSummary ───────────────────────────────────────────────────────

class TestKeywordsSummary:
    def test_no_signals_empty(self):
        snap = _snap(**_NEUTRAL)
        result = _build_keywords_summary(snap)
        assert result == ()

    def test_positive_signals_included(self):
        snap = _snap(usdjpy=158.0, vix=18.0, nikkei_5d_return=0.01,
                     nikkei_60ma=38000.0, nikkei_200ma=37000.0,
                     sp500_dd_30d=-0.02, computed_at=_NOW)
        result = _build_keywords_summary(snap)
        assert "円安" in result

    def test_negative_weak_excluded(self):
        # 調整局面 (sp500_dd_30d in [-0.15, -0.05)) → weak → 除外
        snap = _snap(sp500_dd_30d=-0.08)
        result = _build_keywords_summary(snap)
        assert "調整局面" not in result

    def test_negative_moderate_included(self):
        snap = _snap(vix=35.0)
        result = _build_keywords_summary(snap)
        assert "VIX高" in result

    def test_sorted_result(self):
        snap = _snap(usdjpy=158.0, vix=35.0, nikkei_5d_return=0.0,
                     nikkei_60ma=38000.0, nikkei_200ma=37000.0,
                     sp500_dd_30d=-0.02, computed_at=_NOW)
        result = _build_keywords_summary(snap)
        assert result == tuple(sorted(result))

    def test_returns_tuple(self):
        snap = _snap(**_NEUTRAL)
        result = _build_keywords_summary(snap)
        assert isinstance(result, tuple)
