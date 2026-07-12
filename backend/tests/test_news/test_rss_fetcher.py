"""
Tests for backend/engine/news/rss_fetcher.py — Card 4-2

テスト方針:
  - 実ネットワークアクセスなし
  - parse_rss_xml / parse_atom_xml: inline XML fixture を直接渡す（mock 不要）
  - fetch_rss_source: fetcher_fn に fixture XML を返す lambda を注入（DI）
  - feedparser / requests / httpx / aiohttp / urllib.request は一切使わない
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from backend.engine.news.rss_fetcher import (
    FetchResult,
    NewsItem,
    fetch_rss_source,
    normalize_entry,
    parse_atom_xml,
    parse_published_at,
    parse_rss_xml,
)
from backend.engine.news.sources_config import DEFAULT_NEWS_SOURCES


# ── Inline XML fixtures ───────────────────────────────────────────────────────

_RSS2_SINGLE = """\
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>Test Article 1</title>
      <link>https://example.com/article1</link>
      <description>Test summary 1</description>
      <pubDate>Mon, 06 May 2026 05:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>"""

_RSS2_THREE = """\
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>Article A</title>
      <link>https://example.com/a</link>
      <description>Summary A</description>
      <pubDate>Mon, 06 May 2026 01:00:00 +0000</pubDate>
    </item>
    <item>
      <title>Article B</title>
      <link>https://example.com/b</link>
      <description>Summary B</description>
      <pubDate>Mon, 06 May 2026 02:00:00 +0000</pubDate>
    </item>
    <item>
      <title>Article C</title>
      <link>https://example.com/c</link>
      <description>Summary C</description>
      <pubDate>Mon, 06 May 2026 03:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>"""

_RSS2_NO_TITLE = """\
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <link>https://example.com/notitle</link>
      <description>No title item</description>
    </item>
  </channel>
</rss>"""

_RSS2_NO_LINK = """\
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>No link item</title>
      <description>No link here</description>
    </item>
  </channel>
</rss>"""

_RSS2_MIXED = """\
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Good Item</title>
      <link>https://example.com/good</link>
      <description>Good summary</description>
    </item>
    <item>
      <link>https://example.com/notitle</link>
    </item>
    <item>
      <title>No Link Item</title>
    </item>
  </channel>
</rss>"""

_RSS2_DC_DATE = """\
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <item>
      <title>DC Date Article</title>
      <link>https://example.com/dc</link>
      <dc:date>2026-05-06T05:00:00+00:00</dc:date>
    </item>
  </channel>
</rss>"""

_RSS2_EMPTY_CHANNEL = """\
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Empty Feed</title>
  </channel>
</rss>"""

_RSS2_MALFORMED = "NOT VALID XML <<<"

_ATOM_SINGLE = """\
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Atom Feed</title>
  <entry>
    <title>Atom Article 1</title>
    <link href="https://example.com/atom1"/>
    <summary>Atom summary 1</summary>
    <published>2026-05-06T05:00:00+00:00</published>
  </entry>
</feed>"""

_ATOM_TWO = """\
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Atom Entry 1</title>
    <link href="https://example.com/atom-a"/>
    <summary>Summary A</summary>
    <published>2026-05-06T01:00:00+00:00</published>
  </entry>
  <entry>
    <title>Atom Entry 2</title>
    <link href="https://example.com/atom-b"/>
    <summary>Summary B</summary>
    <published>2026-05-06T02:00:00+00:00</published>
  </entry>
</feed>"""

_ATOM_UPDATED_FALLBACK = """\
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Updated Article</title>
    <link href="https://example.com/updated"/>
    <updated>2026-05-06T07:00:00+00:00</updated>
  </entry>
</feed>"""

_ATOM_NO_NS = """\
<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <entry>
    <title>No NS Article</title>
    <link href="https://example.com/nons"/>
    <summary>No namespace</summary>
    <published>2026-05-06T05:00:00+00:00</published>
  </entry>
</feed>"""

_ATOM_EMPTY = """\
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
</feed>"""

_ATOM_MALFORMED = "NOT VALID XML >>>"


# ── TestNewsItemDataclass ─────────────────────────────────────────────────────

class TestNewsItemDataclass:
    def test_fields_accessible(self):
        item = NewsItem(source_id="bloomberg", title="T", url="https://example.com")
        assert item.source_id == "bloomberg"
        assert item.title == "T"
        assert item.url == "https://example.com"

    def test_summary_default(self):
        item = NewsItem(source_id="x", title="T", url="https://example.com")
        assert item.summary == ""

    def test_published_at_default_none(self):
        item = NewsItem(source_id="x", title="T", url="https://example.com")
        assert item.published_at is None

    def test_categories_default_empty_tuple(self):
        item = NewsItem(source_id="x", title="T", url="https://example.com")
        assert item.categories == ()
        assert isinstance(item.categories, tuple)

    def test_related_tickers_default_empty_tuple(self):
        item = NewsItem(source_id="x", title="T", url="https://example.com")
        assert item.related_tickers == ()
        assert isinstance(item.related_tickers, tuple)

    def test_scores_default_zero(self):
        item = NewsItem(source_id="x", title="T", url="https://example.com")
        assert item.sentiment_score == 0.0
        assert item.importance_score == 0.0

    def test_mutable_not_frozen(self):
        item = NewsItem(source_id="x", title="T", url="https://example.com")
        item.summary = "updated"
        assert item.summary == "updated"


# ── TestFetchResultDataclass ──────────────────────────────────────────────────

class TestFetchResultDataclass:
    def test_fields_accessible(self):
        r = FetchResult(source_id="bloomberg")
        assert r.source_id == "bloomberg"
        assert r.endpoint_count == 0
        assert r.success_count == 0

    def test_items_is_list(self):
        r = FetchResult(source_id="x")
        assert isinstance(r.items, list)
        assert r.items == []

    def test_errors_is_list(self):
        r = FetchResult(source_id="x")
        assert isinstance(r.errors, list)
        assert r.errors == []

    def test_fetched_at_is_utc(self):
        r = FetchResult(source_id="x")
        assert r.fetched_at.tzinfo is not None
        assert r.fetched_at.tzinfo == timezone.utc

    def test_two_instances_have_independent_lists(self):
        r1 = FetchResult(source_id="a")
        r2 = FetchResult(source_id="b")
        r1.items.append(NewsItem(source_id="a", title="T", url="https://example.com"))
        assert r2.items == []


# ── TestParsePublishedAt ──────────────────────────────────────────────────────

class TestParsePublishedAt:
    def test_rfc2822_valid(self):
        result = parse_published_at("Mon, 06 May 2026 05:00:00 +0000")
        assert isinstance(result, datetime)
        assert result.year == 2026 and result.month == 5 and result.day == 6

    def test_iso_valid_with_tz(self):
        result = parse_published_at("2026-05-06T05:00:00+00:00")
        assert isinstance(result, datetime)
        assert result.year == 2026

    def test_iso_naive_treated_as_utc(self):
        result = parse_published_at("2026-05-06T05:00:00")
        assert result is not None
        assert result.tzinfo == timezone.utc

    def test_none_returns_none(self):
        assert parse_published_at(None) is None

    def test_empty_string_returns_none(self):
        assert parse_published_at("") is None

    def test_whitespace_only_returns_none(self):
        assert parse_published_at("   ") is None

    def test_garbage_returns_none(self):
        assert parse_published_at("not a date at all") is None

    def test_result_is_timezone_aware(self):
        result = parse_published_at("Mon, 06 May 2026 05:00:00 +0000")
        assert result is not None
        assert result.tzinfo is not None

    def test_normalized_to_utc(self):
        result = parse_published_at("Mon, 06 May 2026 14:00:00 +0900")
        assert result is not None
        assert result.tzinfo == timezone.utc
        assert result.hour == 5  # +09:00 → UTC = -9h

    def test_dc_date_iso_format(self):
        result = parse_published_at("2026-05-06T05:00:00+09:00")
        assert result is not None
        assert result.tzinfo == timezone.utc


# ── TestNormalizeEntry ────────────────────────────────────────────────────────

class TestNormalizeEntry:
    def _call(self, **kwargs):
        defaults = dict(
            title="Test Title",
            url="https://example.com/article",
            summary="Test summary",
            date_str="Mon, 06 May 2026 05:00:00 +0000",
            source_id="bloomberg",
            categories=("macro", "international"),
            language="en",
        )
        defaults.update(kwargs)
        return normalize_entry(**defaults)

    def test_valid_returns_news_item(self):
        result = self._call()
        assert isinstance(result, NewsItem)

    def test_missing_title_returns_none(self):
        assert self._call(title=None) is None

    def test_empty_title_returns_none(self):
        assert self._call(title="") is None

    def test_whitespace_title_returns_none(self):
        assert self._call(title="   ") is None

    def test_missing_url_returns_none(self):
        assert self._call(url=None) is None

    def test_empty_url_returns_none(self):
        assert self._call(url="") is None

    def test_source_id_propagated(self):
        result = self._call(source_id="reuters")
        assert result.source_id == "reuters"

    def test_categories_propagated(self):
        cats = ("japan", "markets")
        result = self._call(categories=cats)
        assert result.categories == cats

    def test_published_at_parsed_when_present(self):
        result = self._call(date_str="Mon, 06 May 2026 05:00:00 +0000")
        assert result.published_at is not None
        assert isinstance(result.published_at, datetime)

    def test_published_at_none_when_date_str_none(self):
        result = self._call(date_str=None)
        assert result.published_at is None

    def test_title_stripped(self):
        result = self._call(title="  Spaced Title  ")
        assert result.title == "Spaced Title"

    def test_url_stripped(self):
        result = self._call(url="  https://example.com  ")
        assert result.url == "https://example.com"

    def test_none_summary_becomes_empty_string(self):
        result = self._call(summary=None)
        assert result.summary == ""

    def test_language_propagated(self):
        result = self._call(language="en")
        assert result.language == "en"


# ── TestParseRssXml ───────────────────────────────────────────────────────────

class TestParseRssXml:
    def test_single_item(self):
        items = parse_rss_xml(_RSS2_SINGLE, "bloomberg", ("macro",))
        assert len(items) == 1
        assert items[0].title == "Test Article 1"

    def test_multiple_items(self):
        items = parse_rss_xml(_RSS2_THREE, "reuters", ("japan",))
        assert len(items) == 3

    def test_empty_channel_returns_empty(self):
        items = parse_rss_xml(_RSS2_EMPTY_CHANNEL, "x", ())
        assert items == []

    def test_invalid_xml_returns_empty(self):
        items = parse_rss_xml(_RSS2_MALFORMED, "x", ())
        assert items == []

    def test_max_entries_respected(self):
        items = parse_rss_xml(_RSS2_THREE, "reuters", ("japan",), max_entries=2)
        assert len(items) == 2

    def test_max_entries_zero_returns_empty(self):
        items = parse_rss_xml(_RSS2_THREE, "reuters", ("japan",), max_entries=0)
        assert items == []

    def test_source_id_set_correctly(self):
        items = parse_rss_xml(_RSS2_SINGLE, "bloomberg", ("macro",))
        assert items[0].source_id == "bloomberg"

    def test_categories_set_correctly(self):
        cats = ("macro", "international")
        items = parse_rss_xml(_RSS2_SINGLE, "bloomberg", cats)
        assert items[0].categories == cats

    def test_skips_item_without_title(self):
        items = parse_rss_xml(_RSS2_NO_TITLE, "x", ())
        assert items == []

    def test_skips_item_without_link(self):
        items = parse_rss_xml(_RSS2_NO_LINK, "x", ())
        assert items == []

    def test_mixed_valid_invalid_skips_bad(self):
        items = parse_rss_xml(_RSS2_MIXED, "x", ())
        assert len(items) == 1
        assert items[0].title == "Good Item"

    def test_summary_from_description(self):
        items = parse_rss_xml(_RSS2_SINGLE, "x", ())
        assert items[0].summary == "Test summary 1"

    def test_published_at_from_pubdate(self):
        items = parse_rss_xml(_RSS2_SINGLE, "x", ())
        assert items[0].published_at is not None

    def test_dc_date_parsed_when_no_pubdate(self):
        items = parse_rss_xml(_RSS2_DC_DATE, "x", ())
        assert len(items) == 1
        assert items[0].published_at is not None

    def test_url_set_from_link(self):
        items = parse_rss_xml(_RSS2_SINGLE, "x", ())
        assert items[0].url == "https://example.com/article1"

    def test_returns_list_type(self):
        result = parse_rss_xml(_RSS2_SINGLE, "x", ())
        assert isinstance(result, list)


# ── TestParseAtomXml ──────────────────────────────────────────────────────────

class TestParseAtomXml:
    def test_single_entry(self):
        items = parse_atom_xml(_ATOM_SINGLE, "bloomberg", ("macro",))
        assert len(items) == 1
        assert items[0].title == "Atom Article 1"

    def test_multiple_entries(self):
        items = parse_atom_xml(_ATOM_TWO, "reuters", ("japan",))
        assert len(items) == 2

    def test_link_href_extracted(self):
        items = parse_atom_xml(_ATOM_SINGLE, "x", ())
        assert items[0].url == "https://example.com/atom1"

    def test_published_parsed(self):
        items = parse_atom_xml(_ATOM_SINGLE, "x", ())
        assert items[0].published_at is not None

    def test_updated_fallback_when_no_published(self):
        items = parse_atom_xml(_ATOM_UPDATED_FALLBACK, "x", ())
        assert len(items) == 1
        assert items[0].published_at is not None

    def test_no_namespace_atom_handled(self):
        items = parse_atom_xml(_ATOM_NO_NS, "x", ())
        assert len(items) == 1
        assert items[0].title == "No NS Article"

    def test_empty_feed_returns_empty(self):
        items = parse_atom_xml(_ATOM_EMPTY, "x", ())
        assert items == []

    def test_invalid_xml_returns_empty(self):
        items = parse_atom_xml(_ATOM_MALFORMED, "x", ())
        assert items == []

    def test_max_entries_respected(self):
        items = parse_atom_xml(_ATOM_TWO, "x", (), max_entries=1)
        assert len(items) == 1

    def test_source_id_propagated(self):
        items = parse_atom_xml(_ATOM_SINGLE, "bloomberg", ())
        assert items[0].source_id == "bloomberg"

    def test_summary_extracted(self):
        items = parse_atom_xml(_ATOM_SINGLE, "x", ())
        assert items[0].summary == "Atom summary 1"


# ── TestFetchRssSource ────────────────────────────────────────────────────────

class TestFetchRssSource:
    def test_single_endpoint_success(self):
        source = DEFAULT_NEWS_SOURCES["minkabu"]  # 1 endpoint, RSS
        result = fetch_rss_source(source, lambda url: _RSS2_SINGLE)
        assert isinstance(result, FetchResult)
        assert len(result.items) == 1
        assert result.success_count == 1
        assert result.endpoint_count == 1
        assert result.errors == []

    def test_multiple_endpoints_merged(self):
        source = DEFAULT_NEWS_SOURCES["bloomberg"]  # 3 endpoints
        result = fetch_rss_source(source, lambda url: _RSS2_SINGLE)
        # 3 endpoints × 1 item each = 3 items total
        assert len(result.items) == 3
        assert result.success_count == 3
        assert result.endpoint_count == 3

    def test_max_entries_cap_across_endpoints(self):
        source = DEFAULT_NEWS_SOURCES["bloomberg"]  # 3 endpoints × 3 items
        result = fetch_rss_source(source, lambda url: _RSS2_THREE, max_entries=5)
        assert len(result.items) == 5

    def test_endpoint_exception_recorded_in_errors(self):
        def bad_fetcher(url: str) -> str:
            raise ConnectionError("timeout")

        source = DEFAULT_NEWS_SOURCES["minkabu"]
        result = fetch_rss_source(source, bad_fetcher)
        assert result.items == []
        assert len(result.errors) == 1
        assert "timeout" in result.errors[0]

    def test_continues_after_exception(self):
        calls: list[str] = []

        def partial_fetcher(url: str) -> str:
            calls.append(url)
            if len(calls) == 1:
                raise ConnectionError("first endpoint fails")
            return _RSS2_SINGLE

        source = DEFAULT_NEWS_SOURCES["reuters"]  # 2 endpoints
        result = fetch_rss_source(source, partial_fetcher)
        assert len(result.items) == 1
        assert result.success_count == 1
        assert len(result.errors) == 1

    def test_source_id_in_result(self):
        source = DEFAULT_NEWS_SOURCES["jpx"]
        result = fetch_rss_source(source, lambda url: _RSS2_SINGLE)
        assert result.source_id == "jpx"

    def test_success_count_correct(self):
        calls: list[int] = []

        def counting_fetcher(url: str) -> str:
            calls.append(1)
            if len(calls) < 3:
                return _RSS2_SINGLE
            raise RuntimeError("third fails")

        source = DEFAULT_NEWS_SOURCES["bloomberg"]  # 3 endpoints
        result = fetch_rss_source(source, counting_fetcher)
        assert result.success_count == 2
        assert len(result.errors) == 1

    def test_fetched_at_is_utc(self):
        source = DEFAULT_NEWS_SOURCES["minkabu"]
        result = fetch_rss_source(source, lambda url: _RSS2_SINGLE)
        assert result.fetched_at.tzinfo == timezone.utc

    def test_non_rss_web_source_returns_empty_with_error(self):
        source = DEFAULT_NEWS_SOURCES["shikiho_online"]  # WEB type
        result = fetch_rss_source(source, lambda url: _RSS2_SINGLE)
        assert result.items == []
        assert len(result.errors) == 1
        assert "web" in result.errors[0]

    def test_non_rss_api_source_returns_empty_with_error(self):
        source = DEFAULT_NEWS_SOURCES["edinet"]  # API type
        result = fetch_rss_source(source, lambda url: "")
        assert result.items == []
        assert len(result.errors) == 1
        assert "api" in result.errors[0]

    def test_atom_feed_detected_and_parsed(self):
        source = DEFAULT_NEWS_SOURCES["tdnet"]  # RSS type, but we serve Atom
        result = fetch_rss_source(source, lambda url: _ATOM_SINGLE)
        assert len(result.items) == 1
        assert result.items[0].title == "Atom Article 1"

    def test_malformed_xml_produces_no_items_no_error(self):
        source = DEFAULT_NEWS_SOURCES["jpx"]
        result = fetch_rss_source(source, lambda url: _RSS2_MALFORMED)
        assert result.items == []
        assert result.success_count == 1  # fetcher_fn succeeded; parse returned []
        assert result.errors == []

    def test_categories_from_source_set_on_items(self):
        source = DEFAULT_NEWS_SOURCES["bloomberg"]
        result = fetch_rss_source(source, lambda url: _RSS2_SINGLE, max_entries=1)
        item = result.items[0]
        assert "macro" in item.categories
        assert "international" in item.categories

    def test_language_from_source_set_on_items(self):
        source = DEFAULT_NEWS_SOURCES["bloomberg"]  # language=("en",)
        result = fetch_rss_source(source, lambda url: _RSS2_SINGLE, max_entries=1)
        assert result.items[0].language == "en"

    def test_max_entries_zero_returns_empty(self):
        source = DEFAULT_NEWS_SOURCES["minkabu"]
        result = fetch_rss_source(source, lambda url: _RSS2_THREE, max_entries=0)
        assert result.items == []
