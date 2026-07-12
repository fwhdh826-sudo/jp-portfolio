"""
test_aggregator.py — Card 4-5
News Aggregator のテストスイート。

テスト方針:
  - inline XML / JSON / HTML fixture（実 HTTP なし）
  - fetcher_fn は lambda / 簡易関数で DI
  - 全テストが aggregate_news / deduplicate_items / filter_by_tickers の公開 API 経由
  - 禁止 import: requests / feedparser / aiohttp / httpx / urllib.request / bs4
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone

import pytest

from backend.engine.news.aggregator import (
    AggregateResult,
    SourceStatus,
    aggregate_news,
    deduplicate_items,
    filter_by_tickers,
)
from backend.engine.news.rss_fetcher import NewsItem
from backend.engine.news.sources_config import (
    NewsSource,
    SourceCategory,
    SourcePriority,
    SourceType,
)

# ── Inline fixtures ───────────────────────────────────────────────────────────

_RSS_XML_ONE_ITEM = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>Test Article 1</title>
      <link>https://example.com/news/1</link>
      <description>Summary 1</description>
      <pubDate>Thu, 07 May 2026 09:00:00 +0900</pubDate>
    </item>
  </channel>
</rss>"""

_RSS_XML_TWO_ITEMS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Article A</title>
      <link>https://example.com/news/A</link>
    </item>
    <item>
      <title>Article B</title>
      <link>https://example.com/news/B</link>
    </item>
  </channel>
</rss>"""

_RSS_XML_EMPTY = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    "<rss version=\"2.0\"><channel><title>Empty</title></channel></rss>"
)

_EDINET_JSON_ONE_DOC = json.dumps({
    "metadata": {"resultset": {"count": 1}},
    "results": [{
        "docID": "S100TEST1",
        "filerName": "テスト株式会社",
        "docDescription": "有価証券報告書",
        "submitDateTime": "2026-05-07 09:00",
        "edinetCode": "E12345",
        "docTypeCode": "120",
    }],
})

_EDINET_JSON_EMPTY = json.dumps({
    "metadata": {"resultset": {"count": 0}},
    "results": [],
})

_SHIKIHO_HTML_ONE_ARTICLE = """<html><body>
<article class="news-item">
  <h3 class="title"><a href="/news/123456">テスト記事タイトル</a></h3>
  <p class="summary">テスト要約テキスト</p>
  <time class="date" datetime="2026-05-07">2026年5月7日</time>
</article>
</body></html>"""

_SHIKIHO_HTML_EMPTY = "<html><body></body></html>"

# ── Source fixtures ───────────────────────────────────────────────────────────

_RSS_SOURCE = NewsSource(
    source_id="test_rss",
    name="Test RSS",
    source_type=SourceType.RSS,
    endpoints=("https://example.com/feed.rss",),
    language=("en",),
    priority=SourcePriority.HIGH,
    fetch_interval_min=30,
    categories=(SourceCategory.MACRO,),
)

_RSS_SOURCE_2 = NewsSource(
    source_id="test_rss_2",
    name="Test RSS 2",
    source_type=SourceType.RSS,
    endpoints=("https://example2.com/feed.rss",),
    language=("ja",),
    priority=SourcePriority.MEDIUM,
    fetch_interval_min=60,
    categories=(SourceCategory.JAPAN,),
)

_EDINET_SOURCE = NewsSource(
    source_id="edinet",
    name="EDINET Test",
    source_type=SourceType.API,
    endpoints=("https://disclosure.edinet-fsa.go.jp/api/v2/",),
    language=("ja",),
    priority=SourcePriority.HIGH,
    fetch_interval_min=60,
    categories=(SourceCategory.DISCLOSURE,),
)

_SHIKIHO_SOURCE = NewsSource(
    source_id="shikiho_online",
    name="Shikiho Test",
    source_type=SourceType.WEB,
    endpoints=("https://shikiho.toyokeizai.net/news/",),
    language=("ja",),
    priority=SourcePriority.MEDIUM,
    fetch_interval_min=360,
    categories=(SourceCategory.JAPAN,),
)

_UNSUPPORTED_API_SOURCE = NewsSource(
    source_id="unknown_api",
    name="Unknown API",
    source_type=SourceType.API,
    endpoints=("https://api.example.com/",),
    language=("en",),
    priority=SourcePriority.LOW,
    fetch_interval_min=60,
    categories=(SourceCategory.MACRO,),
)

_UNSUPPORTED_WEB_SOURCE = NewsSource(
    source_id="unknown_web",
    name="Unknown Web",
    source_type=SourceType.WEB,
    endpoints=("https://web.example.com/",),
    language=("en",),
    priority=SourcePriority.LOW,
    fetch_interval_min=120,
    categories=(SourceCategory.MACRO,),
)

# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_item(
    url: str,
    source_id: str = "test",
    title: str = "Title",
    related_tickers: tuple[str, ...] = (),
) -> NewsItem:
    return NewsItem(
        source_id=source_id,
        title=title,
        url=url,
        related_tickers=related_tickers,
    )


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── TestSourceStatus ──────────────────────────────────────────────────────────

class TestSourceStatus:
    def test_fields_success(self):
        now = _now()
        s = SourceStatus(
            source_id="bloomberg",
            success=True,
            item_count=5,
            error=None,
            fetched_at=now,
        )
        assert s.source_id == "bloomberg"
        assert s.success is True
        assert s.item_count == 5
        assert s.error is None
        assert s.fetched_at is now

    def test_fields_failure(self):
        now = _now()
        s = SourceStatus(
            source_id="reuters",
            success=False,
            item_count=0,
            error="connection refused",
            fetched_at=now,
        )
        assert s.success is False
        assert s.error == "connection refused"

    def test_error_none_when_success(self):
        s = SourceStatus("x", True, 3, None, _now())
        assert s.error is None

    def test_zero_items_still_valid(self):
        s = SourceStatus("x", True, 0, None, _now())
        assert s.item_count == 0
        assert s.success is True

    def test_fetched_at_is_datetime(self):
        s = SourceStatus("x", True, 1, None, _now())
        assert isinstance(s.fetched_at, datetime)


# ── TestAggregateResult ───────────────────────────────────────────────────────

class TestAggregateResult:
    def test_fields(self):
        now = _now()
        item = _make_item("https://example.com/1")
        status = SourceStatus("src", True, 1, None, now)
        r = AggregateResult(
            items=[item],
            source_statuses=[status],
            fetched_at=now,
            total_fetched=1,
            deduplicated_count=0,
        )
        assert r.items == [item]
        assert r.source_statuses == [status]
        assert r.total_fetched == 1
        assert r.deduplicated_count == 0

    def test_empty_items(self):
        r = AggregateResult(
            items=[],
            source_statuses=[],
            fetched_at=_now(),
            total_fetched=0,
            deduplicated_count=0,
        )
        assert r.items == []
        assert r.source_statuses == []

    def test_counts_reflect_dedup(self):
        items = [_make_item("https://a.com/1"), _make_item("https://a.com/2")]
        r = AggregateResult(
            items=items,
            source_statuses=[],
            fetched_at=_now(),
            total_fetched=3,
            deduplicated_count=1,
        )
        assert r.total_fetched - r.deduplicated_count == len(r.items)

    def test_fetched_at_is_datetime(self):
        r = AggregateResult([], [], _now(), 0, 0)
        assert isinstance(r.fetched_at, datetime)


# ── TestDeduplicateItems ──────────────────────────────────────────────────────

class TestDeduplicateItems:
    def test_empty_list(self):
        assert deduplicate_items([]) == []

    def test_single_item(self):
        item = _make_item("https://a.com/1")
        assert deduplicate_items([item]) == [item]

    def test_all_unique_two(self):
        a = _make_item("https://a.com/1")
        b = _make_item("https://a.com/2")
        result = deduplicate_items([a, b])
        assert result == [a, b]

    def test_all_unique_three(self):
        items = [_make_item(f"https://a.com/{i}") for i in range(3)]
        assert deduplicate_items(items) == items

    def test_exact_duplicate_pair(self):
        a = _make_item("https://a.com/1", title="First")
        b = _make_item("https://a.com/1", title="Second")
        result = deduplicate_items([a, b])
        assert len(result) == 1
        assert result[0] is a

    def test_first_occurrence_preserved(self):
        a = _make_item("https://dup.com/x", title="Original")
        b = _make_item("https://dup.com/x", title="Copy")
        result = deduplicate_items([a, b])
        assert result[0].title == "Original"

    def test_order_preserved(self):
        items = [_make_item(f"https://a.com/{i}") for i in [3, 1, 2]]
        result = deduplicate_items(items)
        assert [item.url for item in result] == [
            "https://a.com/3",
            "https://a.com/1",
            "https://a.com/2",
        ]

    def test_three_same_url(self):
        items = [_make_item("https://same.com/") for _ in range(3)]
        result = deduplicate_items(items)
        assert len(result) == 1

    def test_mixed_some_duplicate(self):
        a = _make_item("https://a.com/1")
        b = _make_item("https://a.com/2")
        c = _make_item("https://a.com/1")  # dup of a
        result = deduplicate_items([a, b, c])
        assert len(result) == 2
        assert result[0] is a
        assert result[1] is b


# ── TestFilterByTickers ───────────────────────────────────────────────────────

class TestFilterByTickers:
    def test_empty_tickers_tuple(self):
        items = [_make_item("https://a.com/1", related_tickers=("7011",))]
        assert filter_by_tickers(items, ()) == []

    def test_empty_tickers_list(self):
        items = [_make_item("https://a.com/1", related_tickers=("7011",))]
        assert filter_by_tickers(items, []) == []

    def test_empty_items(self):
        assert filter_by_tickers([], ("7011",)) == []

    def test_no_match(self):
        items = [_make_item("https://a.com/1", related_tickers=("7011",))]
        assert filter_by_tickers(items, ("9999",)) == []

    def test_single_match(self):
        item = _make_item("https://a.com/1", related_tickers=("7011",))
        result = filter_by_tickers([item], ("7011",))
        assert result == [item]

    def test_multiple_matches(self):
        a = _make_item("https://a.com/1", related_tickers=("7011",))
        b = _make_item("https://a.com/2", related_tickers=("9984",))
        c = _make_item("https://a.com/3", related_tickers=("1234",))
        result = filter_by_tickers([a, b, c], ("7011", "9984"))
        assert result == [a, b]

    def test_empty_related_tickers(self):
        item = _make_item("https://a.com/1", related_tickers=())
        assert filter_by_tickers([item], ("7011",)) == []

    def test_item_with_multiple_tickers(self):
        item = _make_item("https://a.com/1", related_tickers=("7011", "9984", "6758"))
        result = filter_by_tickers([item], ("9984",))
        assert result == [item]

    def test_partial_set_overlap(self):
        a = _make_item("https://a.com/1", related_tickers=("7011", "9984"))
        b = _make_item("https://a.com/2", related_tickers=("1234",))
        result = filter_by_tickers([a, b], ("7011",))
        assert result == [a]


# ── TestAggregateNewsRSS ──────────────────────────────────────────────────────

class TestAggregateNewsRSS:
    def test_single_rss_source_success(self):
        fetchers = {"test_rss": lambda url: _RSS_XML_ONE_ITEM}
        result = aggregate_news([_RSS_SOURCE], fetchers)
        assert len(result.items) == 1
        assert result.items[0].title == "Test Article 1"

    def test_rss_source_status_success_flag(self):
        fetchers = {"test_rss": lambda url: _RSS_XML_ONE_ITEM}
        result = aggregate_news([_RSS_SOURCE], fetchers)
        status = result.source_statuses[0]
        assert status.success is True
        assert status.source_id == "test_rss"

    def test_rss_source_status_item_count(self):
        fetchers = {"test_rss": lambda url: _RSS_XML_TWO_ITEMS}
        result = aggregate_news([_RSS_SOURCE], fetchers)
        assert result.source_statuses[0].item_count == 2

    def test_rss_no_fetcher(self):
        result = aggregate_news([_RSS_SOURCE], {})
        assert len(result.items) == 0
        status = result.source_statuses[0]
        assert status.success is False
        assert status.error == "no fetcher"

    def test_rss_fetcher_raises(self):
        def _bad(url: str) -> str:
            raise RuntimeError("network error")

        fetchers = {"test_rss": _bad}
        result = aggregate_news([_RSS_SOURCE], fetchers)
        status = result.source_statuses[0]
        assert status.success is False
        assert "network error" in (status.error or "")

    def test_rss_empty_feed(self):
        fetchers = {"test_rss": lambda url: _RSS_XML_EMPTY}
        result = aggregate_news([_RSS_SOURCE], fetchers)
        assert result.items == []

    def test_rss_two_items_from_feed(self):
        fetchers = {"test_rss": lambda url: _RSS_XML_TWO_ITEMS}
        result = aggregate_news([_RSS_SOURCE], fetchers)
        assert len(result.items) == 2
        urls = {item.url for item in result.items}
        assert "https://example.com/news/A" in urls
        assert "https://example.com/news/B" in urls


# ── TestAggregateNewsEdinet ───────────────────────────────────────────────────

class TestAggregateNewsEdinet:
    def test_edinet_success(self):
        fetchers = {"edinet": lambda url: _EDINET_JSON_ONE_DOC}
        result = aggregate_news([_EDINET_SOURCE], fetchers)
        assert len(result.items) == 1
        assert result.items[0].source_id == "edinet"

    def test_edinet_source_status(self):
        fetchers = {"edinet": lambda url: _EDINET_JSON_ONE_DOC}
        result = aggregate_news([_EDINET_SOURCE], fetchers)
        status = result.source_statuses[0]
        assert status.success is True
        assert status.source_id == "edinet"
        assert status.item_count == 1

    def test_edinet_no_fetcher(self):
        result = aggregate_news([_EDINET_SOURCE], {})
        status = result.source_statuses[0]
        assert status.success is False
        assert status.error == "no fetcher"

    def test_edinet_fetcher_raises(self):
        def _bad(url: str) -> str:
            raise ValueError("API unavailable")

        fetchers = {"edinet": _bad}
        result = aggregate_news([_EDINET_SOURCE], fetchers)
        status = result.source_statuses[0]
        assert status.success is False
        assert "API unavailable" in (status.error or "")

    def test_edinet_uses_target_date(self):
        captured: list[str] = []

        def _capture(url: str) -> str:
            captured.append(url)
            return _EDINET_JSON_EMPTY

        target = date(2026, 5, 1)
        aggregate_news([_EDINET_SOURCE], {"edinet": _capture}, target_date=target)
        assert len(captured) == 1
        assert "2026-05-01" in captured[0]


# ── TestAggregateNewsShikiho ──────────────────────────────────────────────────

class TestAggregateNewsShikiho:
    def test_shikiho_success(self):
        fetchers = {"shikiho_online": lambda url: _SHIKIHO_HTML_ONE_ARTICLE}
        result = aggregate_news([_SHIKIHO_SOURCE], fetchers)
        assert len(result.items) == 1
        assert result.items[0].source_id == "shikiho_online"

    def test_shikiho_source_status(self):
        fetchers = {"shikiho_online": lambda url: _SHIKIHO_HTML_ONE_ARTICLE}
        result = aggregate_news([_SHIKIHO_SOURCE], fetchers)
        status = result.source_statuses[0]
        assert status.success is True
        assert status.item_count == 1

    def test_shikiho_no_fetcher(self):
        result = aggregate_news([_SHIKIHO_SOURCE], {})
        status = result.source_statuses[0]
        assert status.success is False
        assert status.error == "no fetcher"

    def test_shikiho_fetcher_raises(self):
        def _bad(url: str) -> str:
            raise ConnectionError("timeout")

        fetchers = {"shikiho_online": _bad}
        result = aggregate_news([_SHIKIHO_SOURCE], fetchers)
        status = result.source_statuses[0]
        assert status.success is False
        assert "timeout" in (status.error or "")


# ── TestAggregateNewsErrors ───────────────────────────────────────────────────

class TestAggregateNewsErrors:
    def test_one_fails_others_continue(self):
        def _bad(url: str) -> str:
            raise RuntimeError("fail")

        fetchers = {
            "test_rss": _bad,
            "test_rss_2": lambda url: _RSS_XML_ONE_ITEM,
        }
        result = aggregate_news([_RSS_SOURCE, _RSS_SOURCE_2], fetchers)
        assert len(result.items) == 1
        statuses = {s.source_id: s for s in result.source_statuses}
        assert statuses["test_rss"].success is False
        assert statuses["test_rss_2"].success is True

    def test_all_fail_items_empty(self):
        result = aggregate_news([_RSS_SOURCE, _EDINET_SOURCE, _SHIKIHO_SOURCE], {})
        assert result.items == []
        assert all(not s.success for s in result.source_statuses)

    def test_partial_failure_items_collected(self):
        fetchers = {
            "test_rss": lambda url: _RSS_XML_TWO_ITEMS,
            # edinet and shikiho have no fetcher
        }
        result = aggregate_news(
            [_RSS_SOURCE, _EDINET_SOURCE, _SHIKIHO_SOURCE], fetchers
        )
        assert len(result.items) == 2
        statuses = {s.source_id: s for s in result.source_statuses}
        assert statuses["test_rss"].success is True
        assert statuses["edinet"].success is False
        assert statuses["shikiho_online"].success is False

    def test_unsupported_api_source_not_edinet(self):
        fetchers = {"unknown_api": lambda url: "{}"}
        result = aggregate_news([_UNSUPPORTED_API_SOURCE], fetchers)
        status = result.source_statuses[0]
        assert status.success is False
        assert status.error is not None
        assert "unsupported" in status.error

    def test_unsupported_web_source_not_shikiho(self):
        fetchers = {"unknown_web": lambda url: "<html></html>"}
        result = aggregate_news([_UNSUPPORTED_WEB_SOURCE], fetchers)
        status = result.source_statuses[0]
        assert status.success is False
        assert "unsupported" in (status.error or "")


# ── TestAggregateNewsDedup ────────────────────────────────────────────────────

class TestAggregateNewsDedup:
    def test_no_dedup_needed(self):
        fetchers = {
            "test_rss": lambda url: _RSS_XML_ONE_ITEM,
            "test_rss_2": lambda url: _RSS_XML_TWO_ITEMS,
        }
        result = aggregate_news([_RSS_SOURCE, _RSS_SOURCE_2], fetchers)
        assert result.deduplicated_count == 0
        assert result.total_fetched == 3
        assert len(result.items) == 3

    def test_dedup_across_sources(self):
        # Both sources return an item with the same URL
        shared_xml = """<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item><title>Shared</title><link>https://shared.com/article</link></item>
</channel></rss>"""
        fetchers = {
            "test_rss": lambda url: shared_xml,
            "test_rss_2": lambda url: shared_xml,
        }
        result = aggregate_news([_RSS_SOURCE, _RSS_SOURCE_2], fetchers)
        assert result.deduplicated_count == 1
        assert result.total_fetched == 2
        assert len(result.items) == 1

    def test_total_fetched_is_pre_dedup(self):
        xml_2 = _RSS_XML_TWO_ITEMS
        fetchers = {
            "test_rss": lambda url: xml_2,
            "test_rss_2": lambda url: xml_2,
        }
        result = aggregate_news([_RSS_SOURCE, _RSS_SOURCE_2], fetchers)
        # 2 items from each source = 4 total, 2 unique
        assert result.total_fetched == 4
        assert result.deduplicated_count == 2
        assert len(result.items) == 2

    def test_deduplicated_count_invariant(self):
        fetchers = {"test_rss": lambda url: _RSS_XML_TWO_ITEMS}
        result = aggregate_news([_RSS_SOURCE], fetchers)
        assert result.total_fetched - result.deduplicated_count == len(result.items)

    def test_deduped_items_are_first_occurrence(self):
        # RSS source has item with URL https://example.com/news/A
        # RSS source 2 also returns same item
        xml_with_a = """<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item><title>Source1 Title</title><link>https://example.com/news/A</link></item>
</channel></rss>"""
        xml_with_a_dup = """<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item><title>Source2 Title</title><link>https://example.com/news/A</link></item>
</channel></rss>"""
        fetchers = {
            "test_rss": lambda url: xml_with_a,
            "test_rss_2": lambda url: xml_with_a_dup,
        }
        result = aggregate_news([_RSS_SOURCE, _RSS_SOURCE_2], fetchers)
        assert len(result.items) == 1
        assert result.items[0].title == "Source1 Title"


# ── TestAggregateNewsMultipleSources ──────────────────────────────────────────

class TestAggregateNewsMultipleSources:
    def test_empty_sources(self):
        result = aggregate_news([], {})
        assert result.items == []
        assert result.source_statuses == []
        assert result.total_fetched == 0
        assert result.deduplicated_count == 0

    def test_two_rss_sources(self):
        fetchers = {
            "test_rss": lambda url: _RSS_XML_ONE_ITEM,
            "test_rss_2": lambda url: _RSS_XML_TWO_ITEMS,
        }
        result = aggregate_news([_RSS_SOURCE, _RSS_SOURCE_2], fetchers)
        assert len(result.items) == 3
        assert len(result.source_statuses) == 2

    def test_rss_and_edinet(self):
        fetchers = {
            "test_rss": lambda url: _RSS_XML_ONE_ITEM,
            "edinet": lambda url: _EDINET_JSON_ONE_DOC,
        }
        result = aggregate_news([_RSS_SOURCE, _EDINET_SOURCE], fetchers)
        assert len(result.items) == 2
        source_ids = {item.source_id for item in result.items}
        assert "test_rss" in source_ids
        assert "edinet" in source_ids

    def test_rss_and_shikiho(self):
        fetchers = {
            "test_rss": lambda url: _RSS_XML_ONE_ITEM,
            "shikiho_online": lambda url: _SHIKIHO_HTML_ONE_ARTICLE,
        }
        result = aggregate_news([_RSS_SOURCE, _SHIKIHO_SOURCE], fetchers)
        assert len(result.items) == 2
        source_ids = {item.source_id for item in result.items}
        assert "test_rss" in source_ids
        assert "shikiho_online" in source_ids

    def test_three_source_types(self):
        fetchers = {
            "test_rss": lambda url: _RSS_XML_ONE_ITEM,
            "edinet": lambda url: _EDINET_JSON_ONE_DOC,
            "shikiho_online": lambda url: _SHIKIHO_HTML_ONE_ARTICLE,
        }
        result = aggregate_news(
            [_RSS_SOURCE, _EDINET_SOURCE, _SHIKIHO_SOURCE], fetchers
        )
        assert len(result.items) == 3
        assert len(result.source_statuses) == 3

    def test_source_statuses_count_matches_sources(self):
        sources = [_RSS_SOURCE, _EDINET_SOURCE, _SHIKIHO_SOURCE]
        result = aggregate_news(sources, {})
        assert len(result.source_statuses) == len(sources)

    def test_source_statuses_ids_match_sources(self):
        sources = [_RSS_SOURCE, _EDINET_SOURCE, _SHIKIHO_SOURCE]
        result = aggregate_news(sources, {})
        ids = [s.source_id for s in result.source_statuses]
        assert ids == ["test_rss", "edinet", "shikiho_online"]


# ── TestAggregateNewsSourceIds ────────────────────────────────────────────────

class TestAggregateNewsSourceIds:
    def test_rss_items_have_correct_source_id(self):
        fetchers = {"test_rss": lambda url: _RSS_XML_ONE_ITEM}
        result = aggregate_news([_RSS_SOURCE], fetchers)
        assert all(item.source_id == "test_rss" for item in result.items)

    def test_edinet_items_have_correct_source_id(self):
        fetchers = {"edinet": lambda url: _EDINET_JSON_ONE_DOC}
        result = aggregate_news([_EDINET_SOURCE], fetchers)
        assert all(item.source_id == "edinet" for item in result.items)

    def test_shikiho_items_have_correct_source_id(self):
        fetchers = {"shikiho_online": lambda url: _SHIKIHO_HTML_ONE_ARTICLE}
        result = aggregate_news([_SHIKIHO_SOURCE], fetchers)
        assert all(item.source_id == "shikiho_online" for item in result.items)

    def test_aggregate_result_items_list_is_mutable(self):
        result = aggregate_news([], {})
        result.items.append(_make_item("https://added.com/1"))
        assert len(result.items) == 1

    def test_aggregate_fetched_at_is_utc_aware(self):
        result = aggregate_news([], {})
        assert result.fetched_at.tzinfo is not None
        assert result.fetched_at.tzinfo == timezone.utc
