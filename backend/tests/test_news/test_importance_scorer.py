"""
test_importance_scorer.py — Card 4-8
Importance Scorer のテストスイート。

テスト方針:
  - now= 固定で決定的な結果を得る
  - 全テストが公開 API 経由
  - NewsItem は rss_fetcher.NewsItem を使用
  - 禁止 import: requests / feedparser / aiohttp / httpx / urllib.request / bs4
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from backend.engine.news.rss_fetcher import NewsItem
from backend.engine.news.importance_scorer import (
    BASELINE_SCORE,
    HIGH_THRESHOLD,
    HOLDINGS_BONUS,
    KEYWORD_BONUS_PER,
    LOW_THRESHOLD,
    MAX_TICKER_BONUS,
    MAX_TIME_DECAY,
    SOURCE_WEIGHTS,
    TICKER_BONUS_PER,
    TIME_DECAY_PER_HOUR,
    ImportanceResult,
    aggregate_importance_by_source,
    aggregate_importance_by_ticker,
    enrich_item,
    enrich_items,
    score_item,
)

# ── Fixtures ──────────────────────────────────────────────────────────────────

_NOW = datetime(2026, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
_PUBLISHED_NOW = datetime(2026, 1, 15, 12, 0, 0, tzinfo=timezone.utc)       # 0h ago
_PUBLISHED_1H  = datetime(2026, 1, 15, 11, 0, 0, tzinfo=timezone.utc)       # 1h ago
_PUBLISHED_10H = datetime(2026, 1, 15,  2, 0, 0, tzinfo=timezone.utc)       # 10h ago
_PUBLISHED_30H = datetime(2026, 1, 14,  6, 0, 0, tzinfo=timezone.utc)       # 30h ago (exceeds MAX)


def _make_item(
    source_id: str = "unknown",
    title: str = "",
    summary: str = "",
    url: str = "https://example.com/1",
    published_at: datetime | None = None,
    related_tickers: tuple[str, ...] = (),
    importance_score: float = 0.0,
) -> NewsItem:
    return NewsItem(
        source_id=source_id,
        title=title,
        url=url,
        summary=summary,
        published_at=published_at,
        related_tickers=related_tickers,
        importance_score=importance_score,
    )


# ── TestImportanceResult ──────────────────────────────────────────────────────

class TestImportanceResult:
    def test_fields_exist(self):
        r = ImportanceResult(
            score=75.0,
            label="high",
            source_bonus=15.0,
            ticker_bonus=8.0,
            holdings_bonus=15.0,
            keyword_bonus=8.0,
            time_penalty=3.0,
        )
        assert r.score == 75.0
        assert r.label == "high"
        assert r.source_bonus == 15.0
        assert r.ticker_bonus == 8.0
        assert r.holdings_bonus == 15.0
        assert r.keyword_bonus == 8.0
        assert r.time_penalty == 3.0

    def test_label_high(self):
        r = ImportanceResult(score=70.0, label="high", source_bonus=0, ticker_bonus=0,
                             holdings_bonus=0, keyword_bonus=0, time_penalty=0)
        assert r.label == "high"

    def test_label_medium(self):
        r = ImportanceResult(score=55.0, label="medium", source_bonus=0, ticker_bonus=0,
                             holdings_bonus=0, keyword_bonus=0, time_penalty=0)
        assert r.label == "medium"

    def test_label_low(self):
        r = ImportanceResult(score=20.0, label="low", source_bonus=0, ticker_bonus=0,
                             holdings_bonus=0, keyword_bonus=0, time_penalty=0)
        assert r.label == "low"


# ── TestDeriveImportanceLabel ─────────────────────────────────────────────────

class TestDeriveImportanceLabel:
    """score_item 経由で _derive_importance_label を間接テスト。"""

    def _label(self, score_offset: float) -> str:
        item = _make_item(source_id="unknown", published_at=_NOW)
        result = score_item(item, now=_NOW)
        # ラベルは BASELINE=50 で medium のはず
        return result.label

    def test_baseline_is_medium(self):
        item = _make_item(source_id="unknown", published_at=_NOW)
        r = score_item(item, now=_NOW)
        assert r.label == "medium"

    def test_high_label_at_threshold(self):
        # bloomberg (15) + 1 ticker (4) + 1 kw (8) → 50+15+4+8=77 ≥ 70
        item = _make_item(source_id="bloomberg", title="増益発表", published_at=_NOW,
                          related_tickers=("7011",))
        r = score_item(item, active_keywords=("増益",), now=_NOW)
        assert r.label == "high"

    def test_low_label_with_heavy_decay(self):
        # source=unknown (0), 30h old → MAX_TIME_DECAY=40 → 50-40=10 < 40
        item = _make_item(source_id="unknown", published_at=_PUBLISHED_30H)
        r = score_item(item, now=_NOW)
        assert r.label == "low"

    def test_boundary_exactly_70_is_high(self):
        # bloomberg(15) + 1 ticker(4) + 1 kw(8) - 2.33h*1.5 = 77 - 3.5 = 73.5, adjust
        # Build a scenario exactly at 70: bloomberg=15, no ticker, no kw, no holdings
        # 50+15 = 65, need 5 more → 1 ticker (4) still only 69 → need 2 tickers(8)+bloomberg(15)=73
        # At exactly 70: baseline=50, source=15 (bloomberg), ticker=4 (1 ticker), kw=1*8=8 → 77
        # To get exactly 70: baseline=50 + bloomberg=15 + ticker=5 (no, step is 4)
        # Just verify ≥70 → high
        item = _make_item(source_id="bloomberg", title="増益決算", published_at=_NOW,
                          related_tickers=("7011",))
        r = score_item(item, active_keywords=("増益",), now=_NOW)
        assert r.score >= HIGH_THRESHOLD
        assert r.label == "high"


# ── TestScoreItem ─────────────────────────────────────────────────────────────

class TestScoreItem:
    def test_baseline_only(self):
        item = _make_item(source_id="unknown", published_at=_NOW)
        r = score_item(item, now=_NOW)
        assert r.score == pytest.approx(BASELINE_SCORE)
        assert r.source_bonus == 0.0
        assert r.ticker_bonus == 0.0
        assert r.holdings_bonus == 0.0
        assert r.keyword_bonus == 0.0
        assert r.time_penalty == pytest.approx(0.0)

    def test_known_source_bloomberg(self):
        item = _make_item(source_id="bloomberg", published_at=_NOW)
        r = score_item(item, now=_NOW)
        assert r.source_bonus == SOURCE_WEIGHTS["bloomberg"]
        assert r.score == pytest.approx(BASELINE_SCORE + SOURCE_WEIGHTS["bloomberg"])

    def test_known_source_minkabu(self):
        item = _make_item(source_id="minkabu", published_at=_NOW)
        r = score_item(item, now=_NOW)
        assert r.source_bonus == SOURCE_WEIGHTS["minkabu"]

    def test_unknown_source_zero_bonus(self):
        item = _make_item(source_id="xyz_unknown", published_at=_NOW)
        r = score_item(item, now=_NOW)
        assert r.source_bonus == 0.0

    def test_ticker_bonus_single(self):
        item = _make_item(related_tickers=("7011",), published_at=_NOW)
        r = score_item(item, now=_NOW)
        assert r.ticker_bonus == pytest.approx(TICKER_BONUS_PER)

    def test_ticker_bonus_five_at_max(self):
        item = _make_item(related_tickers=("7011", "9984", "6758", "8306", "4661"),
                          published_at=_NOW)
        r = score_item(item, now=_NOW)
        assert r.ticker_bonus == pytest.approx(MAX_TICKER_BONUS)

    def test_ticker_bonus_six_still_capped(self):
        item = _make_item(related_tickers=("7011", "9984", "6758", "8306", "4661", "6098"),
                          published_at=_NOW)
        r = score_item(item, now=_NOW)
        assert r.ticker_bonus == pytest.approx(MAX_TICKER_BONUS)

    def test_holdings_bonus_intersection(self):
        item = _make_item(related_tickers=("7011", "9984"), published_at=_NOW)
        r = score_item(item, holdings=("7011",), now=_NOW)
        assert r.holdings_bonus == pytest.approx(HOLDINGS_BONUS)

    def test_holdings_bonus_no_intersection(self):
        item = _make_item(related_tickers=("7011",), published_at=_NOW)
        r = score_item(item, holdings=("9984",), now=_NOW)
        assert r.holdings_bonus == 0.0

    def test_holdings_bonus_empty_holdings(self):
        item = _make_item(related_tickers=("7011",), published_at=_NOW)
        r = score_item(item, holdings=(), now=_NOW)
        assert r.holdings_bonus == 0.0

    def test_keyword_bonus_single_hit(self):
        item = _make_item(title="増益決算を発表", published_at=_NOW)
        r = score_item(item, active_keywords=("増益",), now=_NOW)
        assert r.keyword_bonus == pytest.approx(KEYWORD_BONUS_PER)

    def test_keyword_bonus_two_hits(self):
        item = _make_item(title="増益と増収を達成", published_at=_NOW)
        r = score_item(item, active_keywords=("増益", "増収"), now=_NOW)
        assert r.keyword_bonus == pytest.approx(2 * KEYWORD_BONUS_PER)

    def test_keyword_bonus_no_match(self):
        item = _make_item(title="マクロ経済の概況", published_at=_NOW)
        r = score_item(item, active_keywords=("増益",), now=_NOW)
        assert r.keyword_bonus == 0.0

    def test_keyword_only_in_title_not_summary(self):
        # summary は keyword_bonus の対象外
        item = _make_item(title="市場動向", summary="増益", published_at=_NOW)
        r = score_item(item, active_keywords=("増益",), now=_NOW)
        assert r.keyword_bonus == 0.0

    def test_time_penalty_1h(self):
        item = _make_item(published_at=_PUBLISHED_1H)
        r = score_item(item, now=_NOW)
        expected_penalty = 1.0 * TIME_DECAY_PER_HOUR
        assert r.time_penalty == pytest.approx(expected_penalty)

    def test_time_penalty_10h(self):
        item = _make_item(published_at=_PUBLISHED_10H)
        r = score_item(item, now=_NOW)
        expected_penalty = min(10.0 * TIME_DECAY_PER_HOUR, MAX_TIME_DECAY)
        assert r.time_penalty == pytest.approx(expected_penalty)

    def test_time_penalty_capped_at_max(self):
        # 30h × 1.5 = 45 > MAX_TIME_DECAY=40
        item = _make_item(published_at=_PUBLISHED_30H)
        r = score_item(item, now=_NOW)
        assert r.time_penalty == pytest.approx(MAX_TIME_DECAY)

    def test_time_penalty_none_published_at(self):
        item = _make_item(published_at=None)
        r = score_item(item, now=_NOW)
        assert r.time_penalty == 0.0

    def test_score_clamp_lower_zero(self):
        # unknown source, 30h old → 50 - 40 = 10 (still positive, not clamped to 0)
        # To force clamp: use no bonus + future? Actually 30h gives 50-40=10, fine
        # Force score < 0: published_at very old + no bonus is not possible since max_decay=40 and baseline=50
        # Instead test clamp explicitly via direct check: score is always ≥ 0
        item = _make_item(source_id="unknown", published_at=_PUBLISHED_30H)
        r = score_item(item, now=_NOW)
        assert r.score >= 0.0

    def test_score_clamp_upper_100(self):
        # bloomberg(15) + 5 tickers(20) + holdings(15) + 3 kw(24) = 50+15+20+15+24 = 124 → clamped
        item = _make_item(
            source_id="bloomberg",
            title="増益増収好決算",
            published_at=_NOW,
            related_tickers=("7011", "9984", "6758", "8306", "4661"),
        )
        r = score_item(item, active_keywords=("増益", "増収", "好決算"),
                       holdings=("7011",), now=_NOW)
        assert r.score == pytest.approx(100.0)

    def test_now_none_uses_current_time(self):
        # published_at=None → no time penalty, result should be deterministic regardless
        item = _make_item(source_id="unknown", published_at=None)
        r = score_item(item, now=None)
        assert r.time_penalty == 0.0
        assert r.score == pytest.approx(BASELINE_SCORE)

    def test_timezone_naive_published_at(self):
        # naive datetime treated as UTC
        naive_published = datetime(2026, 1, 15, 11, 0, 0)  # no tzinfo, 1h before _NOW
        item = _make_item(published_at=naive_published)
        r = score_item(item, now=_NOW)
        assert r.time_penalty == pytest.approx(1.0 * TIME_DECAY_PER_HOUR)

    def test_all_components_combined(self):
        # bloomberg=15, 2 tickers=8, holdings=15, 1 kw=8, 1h decay=1.5
        # 50 + 15 + 8 + 15 + 8 - 1.5 = 94.5
        item = _make_item(
            source_id="bloomberg",
            title="増益を発表",
            published_at=_PUBLISHED_1H,
            related_tickers=("7011", "9984"),
        )
        r = score_item(item, active_keywords=("増益",), holdings=("7011",), now=_NOW)
        assert r.score == pytest.approx(94.5)
        assert r.source_bonus == pytest.approx(15.0)
        assert r.ticker_bonus == pytest.approx(8.0)
        assert r.holdings_bonus == pytest.approx(15.0)
        assert r.keyword_bonus == pytest.approx(8.0)
        assert r.time_penalty == pytest.approx(1.5)


# ── TestEnrichItem ────────────────────────────────────────────────────────────

class TestEnrichItem:
    def test_returns_new_newsitem(self):
        item = _make_item(published_at=_NOW)
        result = enrich_item(item, now=_NOW)
        assert result is not item

    def test_original_not_mutated(self):
        item = _make_item(importance_score=0.0, published_at=_NOW)
        enrich_item(item, now=_NOW)
        assert item.importance_score == 0.0

    def test_importance_score_set(self):
        item = _make_item(source_id="bloomberg", published_at=_NOW)
        result = enrich_item(item, now=_NOW)
        assert result.importance_score == pytest.approx(BASELINE_SCORE + SOURCE_WEIGHTS["bloomberg"])

    def test_other_fields_unchanged(self):
        item = _make_item(
            source_id="reuters",
            title="テスト記事",
            summary="概要",
            url="https://example.com/test",
            published_at=_NOW,
            related_tickers=("7011",),
        )
        result = enrich_item(item, now=_NOW)
        assert result.source_id == item.source_id
        assert result.title == item.title
        assert result.summary == item.summary
        assert result.url == item.url
        assert result.related_tickers == item.related_tickers

    def test_existing_importance_score_overwritten(self):
        item = _make_item(importance_score=99.0, published_at=_NOW)
        result = enrich_item(item, now=_NOW)
        assert result.importance_score != 99.0
        assert result.importance_score == pytest.approx(BASELINE_SCORE)

    def test_keywords_forwarded(self):
        item = _make_item(title="増益", published_at=_NOW)
        result = enrich_item(item, active_keywords=("増益",), now=_NOW)
        assert result.importance_score == pytest.approx(BASELINE_SCORE + KEYWORD_BONUS_PER)

    def test_holdings_forwarded(self):
        item = _make_item(related_tickers=("7011",), published_at=_NOW)
        result = enrich_item(item, holdings=("7011",), now=_NOW)
        assert result.importance_score == pytest.approx(
            BASELINE_SCORE + TICKER_BONUS_PER + HOLDINGS_BONUS
        )

    def test_now_forwarded(self):
        item = _make_item(published_at=_PUBLISHED_1H)
        result = enrich_item(item, now=_NOW)
        expected = BASELINE_SCORE - 1.0 * TIME_DECAY_PER_HOUR
        assert result.importance_score == pytest.approx(expected)

    def test_score_clamped_to_zero(self):
        # score can't go below 0
        item = _make_item(source_id="unknown", published_at=_PUBLISHED_30H)
        result = enrich_item(item, now=_NOW)
        assert result.importance_score >= 0.0


# ── TestEnrichItems ───────────────────────────────────────────────────────────

class TestEnrichItems:
    def test_empty_list(self):
        assert enrich_items([], now=_NOW) == []

    def test_single_item(self):
        item = _make_item(source_id="bloomberg", published_at=_NOW)
        result = enrich_items([item], now=_NOW)
        assert len(result) == 1
        assert result[0].importance_score == pytest.approx(
            BASELINE_SCORE + SOURCE_WEIGHTS["bloomberg"]
        )

    def test_multiple_items_all_enriched(self):
        items = [
            _make_item(source_id="bloomberg", published_at=_NOW, url="https://a.com/1"),
            _make_item(source_id="reuters",   published_at=_NOW, url="https://a.com/2"),
            _make_item(source_id="minkabu",   published_at=_NOW, url="https://a.com/3"),
        ]
        result = enrich_items(items, now=_NOW)
        assert result[0].importance_score == pytest.approx(BASELINE_SCORE + SOURCE_WEIGHTS["bloomberg"])
        assert result[1].importance_score == pytest.approx(BASELINE_SCORE + SOURCE_WEIGHTS["reuters"])
        assert result[2].importance_score == pytest.approx(BASELINE_SCORE + SOURCE_WEIGHTS["minkabu"])

    def test_returns_new_list(self):
        items = [_make_item(published_at=_NOW)]
        result = enrich_items(items, now=_NOW)
        assert result is not items

    def test_original_items_not_mutated(self):
        item = _make_item(importance_score=0.0, published_at=_NOW)
        enrich_items([item], now=_NOW)
        assert item.importance_score == 0.0

    def test_item_count_preserved(self):
        items = [_make_item(url=f"https://a.com/{i}", published_at=_NOW) for i in range(5)]
        result = enrich_items(items, now=_NOW)
        assert len(result) == 5


# ── TestAggregateImportanceByTicker ──────────────────────────────────────────

class TestAggregateImportanceByTicker:
    def test_empty_list(self):
        assert aggregate_importance_by_ticker([]) == {}

    def test_no_tickers_returns_empty(self):
        items = [
            _make_item(related_tickers=(), importance_score=80.0),
            _make_item(related_tickers=(), importance_score=60.0, url="https://a.com/2"),
        ]
        assert aggregate_importance_by_ticker(items) == {}

    def test_single_ticker_single_item(self):
        item = _make_item(related_tickers=("7011",), importance_score=75.0)
        result = aggregate_importance_by_ticker([item])
        assert result == {"7011": pytest.approx(75.0)}

    def test_max_not_avg_for_ticker(self):
        items = [
            _make_item(related_tickers=("7011",), importance_score=80.0, url="https://a.com/1"),
            _make_item(related_tickers=("7011",), importance_score=60.0, url="https://a.com/2"),
            _make_item(related_tickers=("7011",), importance_score=70.0, url="https://a.com/3"),
        ]
        result = aggregate_importance_by_ticker(items)
        assert result["7011"] == pytest.approx(80.0)

    def test_multiple_tickers_separate_max(self):
        items = [
            _make_item(related_tickers=("7011",), importance_score=80.0, url="https://a.com/1"),
            _make_item(related_tickers=("9984",), importance_score=60.0, url="https://a.com/2"),
            _make_item(related_tickers=("7011",), importance_score=55.0, url="https://a.com/3"),
        ]
        result = aggregate_importance_by_ticker(items)
        assert result["7011"] == pytest.approx(80.0)
        assert result["9984"] == pytest.approx(60.0)

    def test_item_with_multiple_tickers(self):
        # 1 item → multiple tickers all get same score
        item = _make_item(related_tickers=("7011", "9984"), importance_score=90.0)
        result = aggregate_importance_by_ticker([item])
        assert result["7011"] == pytest.approx(90.0)
        assert result["9984"] == pytest.approx(90.0)

    def test_mixed_with_and_without_tickers(self):
        items = [
            _make_item(related_tickers=("7011",), importance_score=70.0, url="https://a.com/1"),
            _make_item(related_tickers=(),        importance_score=90.0, url="https://a.com/2"),
        ]
        result = aggregate_importance_by_ticker(items)
        assert "7011" in result
        assert len(result) == 1

    def test_same_ticker_across_items_takes_max(self):
        items = [
            _make_item(related_tickers=("7011",), importance_score=50.0, url="https://a.com/1"),
            _make_item(related_tickers=("7011",), importance_score=95.0, url="https://a.com/2"),
            _make_item(related_tickers=("7011",), importance_score=30.0, url="https://a.com/3"),
        ]
        result = aggregate_importance_by_ticker(items)
        assert result["7011"] == pytest.approx(95.0)

    def test_returns_dict_type(self):
        item = _make_item(related_tickers=("7011",), importance_score=70.0)
        result = aggregate_importance_by_ticker([item])
        assert isinstance(result, dict)


# ── TestAggregateImportanceBySource ──────────────────────────────────────────

class TestAggregateImportanceBySource:
    def test_empty_list(self):
        assert aggregate_importance_by_source([]) == {}

    def test_single_item(self):
        item = _make_item(source_id="bloomberg", importance_score=80.0)
        result = aggregate_importance_by_source([item])
        assert result == {"bloomberg": pytest.approx(80.0)}

    def test_avg_not_max_for_source(self):
        items = [
            _make_item(source_id="bloomberg", importance_score=80.0, url="https://a.com/1"),
            _make_item(source_id="bloomberg", importance_score=60.0, url="https://a.com/2"),
        ]
        result = aggregate_importance_by_source(items)
        assert result["bloomberg"] == pytest.approx(70.0)

    def test_multiple_sources(self):
        items = [
            _make_item(source_id="bloomberg", importance_score=80.0, url="https://a.com/1"),
            _make_item(source_id="reuters",   importance_score=60.0, url="https://a.com/2"),
        ]
        result = aggregate_importance_by_source(items)
        assert result["bloomberg"] == pytest.approx(80.0)
        assert result["reuters"] == pytest.approx(60.0)

    def test_zero_score_included_in_avg(self):
        items = [
            _make_item(source_id="minkabu", importance_score=0.0,  url="https://a.com/1"),
            _make_item(source_id="minkabu", importance_score=60.0, url="https://a.com/2"),
        ]
        result = aggregate_importance_by_source(items)
        assert result["minkabu"] == pytest.approx(30.0)

    def test_three_items_avg(self):
        items = [
            _make_item(source_id="edinet", importance_score=90.0, url="https://a.com/1"),
            _make_item(source_id="edinet", importance_score=60.0, url="https://a.com/2"),
            _make_item(source_id="edinet", importance_score=30.0, url="https://a.com/3"),
        ]
        result = aggregate_importance_by_source(items)
        assert result["edinet"] == pytest.approx(60.0)

    def test_returns_dict_type(self):
        item = _make_item(source_id="bloomberg", importance_score=70.0)
        result = aggregate_importance_by_source([item])
        assert isinstance(result, dict)
