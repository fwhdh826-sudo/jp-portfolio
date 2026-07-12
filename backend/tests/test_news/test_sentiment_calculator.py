"""
test_sentiment_calculator.py — Card 4-7
Sentiment Calculator のテストスイート。

テスト方針:
  - inline テキスト fixture（実 HTTP / API アクセスなし）
  - scorer_fn は lambda で DI
  - 全テストが公開 API 経由
  - NewsItem は rss_fetcher.NewsItem を使用
  - 禁止 import: openai / anthropic / litellm / ollama / requests / ...
"""
from __future__ import annotations

import pytest

from backend.engine.news.rss_fetcher import NewsItem
from backend.engine.news.sentiment_calculator import (
    KEYWORD_STEP,
    NEGATIVE_KEYWORDS,
    NEGATIVE_THRESHOLD,
    POSITIVE_KEYWORDS,
    POSITIVE_THRESHOLD,
    SentimentResult,
    aggregate_sentiment_by_source,
    aggregate_sentiment_by_ticker,
    calculate_sentiment,
    enrich_item,
    enrich_items,
    score_text,
)

# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_item(
    title: str = "",
    summary: str = "",
    url: str = "https://example.com/1",
    source_id: str = "test",
    related_tickers: tuple[str, ...] = (),
    sentiment_score: float = 0.0,
) -> NewsItem:
    return NewsItem(
        source_id=source_id,
        title=title,
        url=url,
        summary=summary,
        related_tickers=related_tickers,
        sentiment_score=sentiment_score,
    )


# ── TestSentimentResult ───────────────────────────────────────────────────────

class TestSentimentResult:
    def test_fields(self):
        r = SentimentResult(
            score=0.4,
            label="positive",
            method="keyword_stub",
            positive_hits=("増益",),
            negative_hits=(),
        )
        assert r.score == 0.4
        assert r.label == "positive"
        assert r.method == "keyword_stub"
        assert r.positive_hits == ("増益",)
        assert r.negative_hits == ()

    def test_score_range_example(self):
        r = SentimentResult(
            score=-0.6,
            label="negative",
            method="keyword_stub",
            positive_hits=(),
            negative_hits=("減益", "下落", "懸念"),
        )
        assert -1.0 <= r.score <= 1.0

    def test_label_values(self):
        labels = {"positive", "neutral", "negative"}
        r = SentimentResult(0.0, "neutral", "keyword_stub", (), ())
        assert r.label in labels

    def test_empty_hits(self):
        r = SentimentResult(0.0, "neutral", "keyword_stub", (), ())
        assert r.positive_hits == ()
        assert r.negative_hits == ()


# ── TestScoreText ─────────────────────────────────────────────────────────────

class TestScoreText:
    def test_empty_string(self):
        r = score_text("")
        assert r.score == 0.0
        assert r.label == "neutral"
        assert r.method == "keyword_stub"

    def test_none_text(self):
        r = score_text(None)
        assert r.score == 0.0
        assert r.label == "neutral"

    def test_whitespace_only(self):
        r = score_text("   \t\n  ")
        assert r.score == 0.0
        assert r.label == "neutral"

    def test_no_keyword_match_score_zero(self):
        r = score_text("一般的なマクロ経済情報です")
        assert r.score == 0.0
        assert r.label == "neutral"

    def test_single_positive_keyword(self):
        r = score_text("増益を達成しました")
        assert r.score == pytest.approx(KEYWORD_STEP)
        assert r.label == "positive"

    def test_single_negative_keyword(self):
        r = score_text("業績が悪化しています")
        assert r.score == pytest.approx(-KEYWORD_STEP)
        assert r.label == "negative"

    def test_multiple_positive_keywords(self):
        r = score_text("増益 増収 上昇 好調")
        expected = min(4 * KEYWORD_STEP, 1.0)
        assert r.score == pytest.approx(expected)
        assert r.label == "positive"

    def test_multiple_negative_keywords(self):
        r = score_text("減益 減収 下落 悪化")
        expected = max(-4 * KEYWORD_STEP, -1.0)
        assert r.score == pytest.approx(expected)
        assert r.label == "negative"

    def test_positive_and_negative_cancel(self):
        # 増益（+0.2）と減益（-0.2）→ 0.0（他の kw を含まないテキスト）
        r = score_text("増益の一方で減益傾向も見られる")
        assert r.score == pytest.approx(0.0)
        assert r.label == "neutral"

    def test_clamp_at_positive_1(self):
        # 6 個の positive kw → 6 × 0.2 = 1.2 → clamp 1.0
        r = score_text("増益 増収 上昇 好調 最高益 回復")
        assert r.score == pytest.approx(1.0)

    def test_clamp_at_negative_1(self):
        # 6 個の negative kw → -1.2 → clamp -1.0
        r = score_text("減益 減収 下落 悪化 損失 危機")
        assert r.score == pytest.approx(-1.0)

    def test_positive_hits_recorded(self):
        r = score_text("増益と上昇が続く")
        assert "増益" in r.positive_hits
        assert "上昇" in r.positive_hits

    def test_negative_hits_recorded(self):
        r = score_text("減益と下落が懸念される")
        assert "減益" in r.negative_hits
        assert "下落" in r.negative_hits
        assert "懸念" in r.negative_hits

    def test_custom_keywords(self):
        pos = ("爆上げ",)
        neg = ("暴落",)
        r = score_text("爆上げが期待", pos_keywords=pos, neg_keywords=neg)
        assert r.score == pytest.approx(KEYWORD_STEP)
        assert "爆上げ" in r.positive_hits

    def test_custom_step(self):
        r = score_text("増益", step=0.5)
        assert r.score == pytest.approx(0.5)

    def test_method_is_keyword_stub(self):
        r = score_text("増益")
        assert r.method == "keyword_stub"


# ── TestCalculateSentiment ────────────────────────────────────────────────────

class TestCalculateSentiment:
    def test_no_scorer_fn_uses_keyword_stub(self):
        r = calculate_sentiment("増益決算", "業績が好調")
        assert r.method == "keyword_stub"
        assert r.score > 0.0

    def test_scorer_fn_overrides_keyword(self):
        # keyword では positive になるはずのテキストも scorer_fn が -0.5 を返す
        r = calculate_sentiment("増益", "好調", scorer_fn=lambda t, s: -0.5)
        assert r.score == pytest.approx(-0.5)
        assert r.label == "negative"

    def test_scorer_fn_receives_title_and_summary(self):
        received: list[tuple[str, str]] = []

        def _capture(title: str, summary: str) -> float:
            received.append((title, summary))
            return 0.3

        calculate_sentiment("タイトル", "要約", scorer_fn=_capture)
        assert received == [("タイトル", "要約")]

    def test_positive_title_positive_result(self):
        r = calculate_sentiment("三菱重工が増益達成", "")
        assert r.score > 0.0
        assert r.label == "positive"

    def test_negative_title_negative_result(self):
        r = calculate_sentiment("業績が大幅減益", "")
        assert r.score < 0.0
        assert r.label == "negative"

    def test_neutral_text_neutral_result(self):
        r = calculate_sentiment("本日の市場概況", "特段の材料なし")
        assert r.label == "neutral"
        assert r.score == 0.0

    def test_scorer_fn_score_clamped_positive(self):
        r = calculate_sentiment("", "", scorer_fn=lambda t, s: 99.0)
        assert r.score == pytest.approx(1.0)

    def test_scorer_fn_score_clamped_negative(self):
        r = calculate_sentiment("", "", scorer_fn=lambda t, s: -99.0)
        assert r.score == pytest.approx(-1.0)

    def test_method_is_keyword_stub_when_no_fn(self):
        r = calculate_sentiment("増益", "好調")
        assert r.method == "keyword_stub"

    def test_method_is_scorer_fn_when_fn_provided(self):
        r = calculate_sentiment("増益", "好調", scorer_fn=lambda t, s: 0.5)
        assert r.method == "scorer_fn"

    def test_empty_title_empty_summary(self):
        r = calculate_sentiment("", "")
        assert r.score == 0.0
        assert r.label == "neutral"

    def test_scorer_fn_hits_are_empty(self):
        r = calculate_sentiment("増益", "好調", scorer_fn=lambda t, s: 0.7)
        assert r.positive_hits == ()
        assert r.negative_hits == ()


# ── TestEnrichItem ────────────────────────────────────────────────────────────

class TestEnrichItem:
    def test_positive_title_score_positive(self):
        item = _make_item(title="三菱重工が増益達成")
        result = enrich_item(item)
        assert result.sentiment_score > 0.0

    def test_negative_summary_score_negative(self):
        item = _make_item(title="本日の概況", summary="株価が下落し懸念広がる")
        result = enrich_item(item)
        assert result.sentiment_score < 0.0

    def test_returns_new_newsitem(self):
        item = _make_item(title="増益")
        result = enrich_item(item)
        assert result is not item

    def test_original_not_mutated(self):
        item = _make_item(title="増益")
        original_score = item.sentiment_score
        enrich_item(item)
        assert item.sentiment_score == original_score

    def test_scorer_fn_di(self):
        item = _make_item(title="増益")
        result = enrich_item(item, scorer_fn=lambda t, s: -0.8)
        assert result.sentiment_score == pytest.approx(-0.8)

    def test_other_fields_unchanged(self):
        item = _make_item(
            title="増益",
            summary="好調",
            url="https://example.com/42",
            source_id="bloomberg",
        )
        result = enrich_item(item)
        assert result.title == item.title
        assert result.summary == item.summary
        assert result.url == item.url
        assert result.source_id == item.source_id

    def test_neutral_article(self):
        item = _make_item(title="本日の市場概況", summary="特に材料なし")
        result = enrich_item(item)
        assert result.sentiment_score == 0.0

    def test_sentiment_score_in_range(self):
        item = _make_item(title="増益 増収 上昇 好調 最高益 回復 改善")
        result = enrich_item(item)
        assert -1.0 <= result.sentiment_score <= 1.0

    def test_existing_score_overwritten(self):
        item = _make_item(title="増益", sentiment_score=0.9)
        result = enrich_item(item)
        # keyword stub の結果で上書き（0.9 から変化する）
        assert result.sentiment_score != 0.9 or result.sentiment_score == pytest.approx(KEYWORD_STEP)

    def test_no_keywords_score_zero(self):
        item = _make_item(title="東証の株式市場", summary="一般的な情報")
        result = enrich_item(item)
        assert result.sentiment_score == 0.0


# ── TestEnrichItems ───────────────────────────────────────────────────────────

class TestEnrichItems:
    def test_empty_list(self):
        assert enrich_items([]) == []

    def test_single_item(self):
        item = _make_item(title="増益")
        result = enrich_items([item])
        assert len(result) == 1
        assert result[0].sentiment_score > 0.0

    def test_multiple_items_all_scored(self):
        items = [
            _make_item(title="増益", url="https://example.com/1"),
            _make_item(title="減益", url="https://example.com/2"),
            _make_item(title="一般情報", url="https://example.com/3"),
        ]
        result = enrich_items(items)
        assert len(result) == 3
        assert result[0].sentiment_score > 0.0
        assert result[1].sentiment_score < 0.0
        assert result[2].sentiment_score == 0.0

    def test_returns_new_list(self):
        items = [_make_item(title="増益")]
        result = enrich_items(items)
        assert result is not items

    def test_original_list_not_mutated(self):
        item = _make_item(title="増益")
        original_score = item.sentiment_score
        enrich_items([item])
        assert item.sentiment_score == original_score

    def test_item_count_preserved(self):
        items = [_make_item(url=f"https://example.com/{i}") for i in range(5)]
        result = enrich_items(items)
        assert len(result) == 5


# ── TestAggregateSentimentByTicker ────────────────────────────────────────────

class TestAggregateSentimentByTicker:
    def test_empty_items(self):
        assert aggregate_sentiment_by_ticker([]) == {}

    def test_no_related_tickers(self):
        items = [
            _make_item(sentiment_score=0.5, url="https://example.com/1"),
            _make_item(sentiment_score=-0.3, url="https://example.com/2"),
        ]
        assert aggregate_sentiment_by_ticker(items) == {}

    def test_single_ticker_single_item(self):
        item = _make_item(
            related_tickers=("7011",),
            sentiment_score=0.4,
        )
        result = aggregate_sentiment_by_ticker([item])
        assert "7011" in result
        assert result["7011"] == pytest.approx(0.4)

    def test_single_ticker_multiple_items_avg(self):
        items = [
            _make_item(related_tickers=("7011",), sentiment_score=0.4, url="https://example.com/1"),
            _make_item(related_tickers=("7011",), sentiment_score=0.6, url="https://example.com/2"),
        ]
        result = aggregate_sentiment_by_ticker(items)
        assert result["7011"] == pytest.approx(0.5)

    def test_item_counted_for_each_ticker(self):
        # 1 件が 2 ticker を持つ → 両方にカウント
        item = _make_item(
            related_tickers=("7011", "9984"),
            sentiment_score=0.3,
        )
        result = aggregate_sentiment_by_ticker([item])
        assert "7011" in result
        assert "9984" in result
        assert result["7011"] == pytest.approx(0.3)
        assert result["9984"] == pytest.approx(0.3)

    def test_multiple_tickers(self):
        items = [
            _make_item(related_tickers=("7011",), sentiment_score=0.5, url="https://example.com/1"),
            _make_item(related_tickers=("9984",), sentiment_score=-0.2, url="https://example.com/2"),
        ]
        result = aggregate_sentiment_by_ticker(items)
        assert result["7011"] == pytest.approx(0.5)
        assert result["9984"] == pytest.approx(-0.2)

    def test_only_items_with_tickers_counted(self):
        items = [
            _make_item(related_tickers=("7011",), sentiment_score=0.6, url="https://example.com/1"),
            _make_item(related_tickers=(), sentiment_score=0.9, url="https://example.com/2"),
        ]
        result = aggregate_sentiment_by_ticker(items)
        assert "7011" in result
        assert len(result) == 1

    def test_avg_calculation_correct(self):
        items = [
            _make_item(related_tickers=("7011",), sentiment_score=0.2, url="https://example.com/1"),
            _make_item(related_tickers=("7011",), sentiment_score=0.4, url="https://example.com/2"),
            _make_item(related_tickers=("7011",), sentiment_score=0.6, url="https://example.com/3"),
        ]
        result = aggregate_sentiment_by_ticker(items)
        assert result["7011"] == pytest.approx(0.4)


# ── TestAggregateSentimentBySource ────────────────────────────────────────────

class TestAggregateSentimentBySource:
    def test_empty_items(self):
        assert aggregate_sentiment_by_source([]) == {}

    def test_single_source_single_item(self):
        item = _make_item(source_id="bloomberg", sentiment_score=0.5)
        result = aggregate_sentiment_by_source([item])
        assert "bloomberg" in result
        assert result["bloomberg"] == pytest.approx(0.5)

    def test_single_source_multiple_items_avg(self):
        items = [
            _make_item(source_id="bloomberg", sentiment_score=0.4, url="https://example.com/1"),
            _make_item(source_id="bloomberg", sentiment_score=0.8, url="https://example.com/2"),
        ]
        result = aggregate_sentiment_by_source(items)
        assert result["bloomberg"] == pytest.approx(0.6)

    def test_multiple_sources(self):
        items = [
            _make_item(source_id="bloomberg", sentiment_score=0.6, url="https://example.com/1"),
            _make_item(source_id="reuters", sentiment_score=-0.4, url="https://example.com/2"),
            _make_item(source_id="edinet", sentiment_score=0.0, url="https://example.com/3"),
        ]
        result = aggregate_sentiment_by_source(items)
        assert result["bloomberg"] == pytest.approx(0.6)
        assert result["reuters"] == pytest.approx(-0.4)
        assert result["edinet"] == pytest.approx(0.0)

    def test_returns_dict(self):
        result = aggregate_sentiment_by_source([_make_item(source_id="test")])
        assert isinstance(result, dict)

    def test_zero_score_included_in_avg(self):
        items = [
            _make_item(source_id="minkabu", sentiment_score=0.0, url="https://example.com/1"),
            _make_item(source_id="minkabu", sentiment_score=0.6, url="https://example.com/2"),
        ]
        result = aggregate_sentiment_by_source(items)
        # (0.0 + 0.6) / 2 = 0.3
        assert result["minkabu"] == pytest.approx(0.3)

    def test_avg_per_source_correct(self):
        items = [
            _make_item(source_id="yahoo_finance_jp", sentiment_score=0.2, url="https://example.com/1"),
            _make_item(source_id="yahoo_finance_jp", sentiment_score=0.4, url="https://example.com/2"),
            _make_item(source_id="yahoo_finance_jp", sentiment_score=0.6, url="https://example.com/3"),
        ]
        result = aggregate_sentiment_by_source(items)
        assert result["yahoo_finance_jp"] == pytest.approx(0.4)
