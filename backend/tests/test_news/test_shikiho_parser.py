"""
tests for shikiho_parser — Card 4-4
All fixtures are inline HTML strings; no HTTP access.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from backend.engine.news.shikiho_parser import (
    SHIKIHO_BASE,
    SHIKIHO_NEWS_URL,
    ShikihoArticle,
    ShikihoFetchResult,
    _ShikihoHTMLParser,
    fetch_shikiho,
    normalize_article,
    parse_article_date,
    parse_shikiho_html,
    resolve_url,
    shikiho_article_to_news_item,
)
from backend.engine.news.rss_fetcher import NewsItem

_JST = timezone(timedelta(hours=9))
_UTC = timezone.utc

# ── inline HTML fixtures ──────────────────────────────────────────────────────

_HTML_SINGLE = """<html><body>
<article class="news-item">
  <h3 class="title"><a href="/news/123456">テスト記事タイトル</a></h3>
  <p class="summary">テスト記事の概要テキスト</p>
  <time class="date" datetime="2026-05-07">2026年5月7日</time>
</article>
</body></html>"""

_HTML_TWO = """<html><body>
<article class="news-item">
  <h3 class="title"><a href="/news/111">記事A</a></h3>
  <p class="summary">概要A</p>
  <time datetime="2026-05-06">2026年5月6日</time>
</article>
<article class="news-item">
  <h3 class="title"><a href="/news/222">記事B</a></h3>
  <p class="summary">概要B</p>
  <time datetime="2026-05-05">2026年5月5日</time>
</article>
</body></html>"""

_HTML_NO_SUMMARY = """<html><body>
<article class="news-item">
  <h3 class="title"><a href="/news/999">サマリーなし記事</a></h3>
  <time datetime="2026-05-07">2026年5月7日</time>
</article>
</body></html>"""

_HTML_NO_DATE = """<html><body>
<article class="news-item">
  <h3 class="title"><a href="/news/888">日付なし記事</a></h3>
  <p class="summary">概要テキスト</p>
</article>
</body></html>"""

_HTML_MISSING_TITLE = """<html><body>
<article class="news-item">
  <p class="summary">タイトルなし</p>
  <time datetime="2026-05-07">日付</time>
</article>
</body></html>"""

_HTML_MISSING_URL = """<html><body>
<article class="news-item">
  <h3 class="title">URLなし記事</h3>
  <p class="summary">概要</p>
</article>
</body></html>"""

_HTML_ABSOLUTE_URL = """<html><body>
<article class="news-item">
  <h3 class="title"><a href="https://shikiho.toyokeizai.net/news/777">絶対URL記事</a></h3>
  <p class="summary">概要</p>
  <time datetime="2026-05-07">日付</time>
</article>
</body></html>"""

_HTML_EMPTY = ""
_HTML_NO_ARTICLES = "<html><body><p>記事なし</p></body></html>"
_HTML_MALFORMED = "<article class='news-item'><h3 class='title'><a href='/news/bad'>"

_HTML_H4_TITLE = """<html><body>
<article class="news-item">
  <h4 class="title"><a href="/news/h4">h4タイトル記事</a></h4>
  <p class="summary">h4概要</p>
  <time datetime="2026-04-01">日付</time>
</article>
</body></html>"""

_HTML_MANY = "".join(
    f'<article class="news-item">'
    f'<h3 class="title"><a href="/news/{i}">記事{i}</a></h3>'
    f'<p class="summary">概要{i}</p>'
    f'<time datetime="2026-05-01">日付</time>'
    f'</article>'
    for i in range(50)
)


# ── resolve_url ───────────────────────────────────────────────────────────────

class TestResolveUrl:
    def test_relative_path(self):
        result = resolve_url("/news/123456")
        assert result == "https://shikiho.toyokeizai.net/news/123456"

    def test_absolute_url_unchanged(self):
        url = "https://shikiho.toyokeizai.net/news/777"
        assert resolve_url(url) == url

    def test_empty_string_returns_empty(self):
        assert resolve_url("") == ""

    def test_whitespace_only_returns_empty(self):
        assert resolve_url("   ") == ""

    def test_custom_base(self):
        result = resolve_url("/path/here", "https://example.com")
        assert result == "https://example.com/path/here"

    def test_relative_no_leading_slash(self):
        result = resolve_url("news/123")
        assert "shikiho.toyokeizai.net" in result

    def test_strips_whitespace_in_href(self):
        result = resolve_url("  /news/999  ")
        assert result == "https://shikiho.toyokeizai.net/news/999"


# ── parse_article_date ────────────────────────────────────────────────────────

class TestParseArticleDate:
    def test_valid_date_returns_utc(self):
        result = parse_article_date("2026-05-07")
        assert result is not None
        assert result.tzinfo == _UTC

    def test_jst_midnight_converts_correctly(self):
        # JST 2026-05-07 00:00 = UTC 2026-05-06 15:00
        result = parse_article_date("2026-05-07")
        assert result == datetime(2026, 5, 6, 15, 0, 0, tzinfo=_UTC)

    def test_another_date(self):
        result = parse_article_date("2026-01-01")
        expected = datetime(2025, 12, 31, 15, 0, 0, tzinfo=_UTC)
        assert result == expected

    def test_none_returns_none(self):
        assert parse_article_date(None) is None

    def test_empty_string_returns_none(self):
        assert parse_article_date("") is None

    def test_whitespace_returns_none(self):
        assert parse_article_date("   ") is None

    def test_invalid_format_returns_none(self):
        assert parse_article_date("not-a-date") is None

    def test_partial_date_returns_none(self):
        assert parse_article_date("2026-05") is None

    def test_strips_whitespace(self):
        result = parse_article_date("  2026-05-07  ")
        assert result == datetime(2026, 5, 6, 15, 0, 0, tzinfo=_UTC)


# ── normalize_article ─────────────────────────────────────────────────────────

class TestNormalizeArticle:
    def test_basic(self):
        raw = {"title": "テスト", "url": "/news/1", "summary": "概要", "date_str": "2026-05-07"}
        article = normalize_article(raw)
        assert article is not None
        assert article.title == "テスト"
        assert article.url == "https://shikiho.toyokeizai.net/news/1"
        assert article.summary == "概要"
        assert article.date_str == "2026-05-07"
        assert article.raw_url == "/news/1"

    def test_missing_title_returns_none(self):
        assert normalize_article({"title": "", "url": "/news/1"}) is None

    def test_missing_url_returns_none(self):
        assert normalize_article({"title": "タイトル", "url": ""}) is None

    def test_none_title_returns_none(self):
        assert normalize_article({"title": None, "url": "/news/1"}) is None

    def test_none_url_returns_none(self):
        assert normalize_article({"title": "タイトル", "url": None}) is None

    def test_absolute_url_preserved(self):
        url = "https://shikiho.toyokeizai.net/news/999"
        article = normalize_article({"title": "T", "url": url})
        assert article is not None
        assert article.url == url

    def test_summary_optional(self):
        article = normalize_article({"title": "T", "url": "/news/1"})
        assert article is not None
        assert article.summary == ""

    def test_date_str_none_allowed(self):
        article = normalize_article({"title": "T", "url": "/news/1", "date_str": None})
        assert article is not None
        assert article.date_str is None

    def test_whitespace_title_returns_none(self):
        assert normalize_article({"title": "   ", "url": "/news/1"}) is None

    def test_custom_base_url(self):
        article = normalize_article(
            {"title": "T", "url": "/news/1"},
            base_url="https://example.com",
        )
        assert article is not None
        assert article.url == "https://example.com/news/1"


# ── _ShikihoHTMLParser (via parse_shikiho_html) ───────────────────────────────

class TestParseShikihoHtml:
    def test_single_article(self):
        articles = parse_shikiho_html(_HTML_SINGLE)
        assert len(articles) == 1
        a = articles[0]
        assert a.title == "テスト記事タイトル"
        assert a.url == "https://shikiho.toyokeizai.net/news/123456"
        assert a.summary == "テスト記事の概要テキスト"
        assert a.date_str == "2026-05-07"

    def test_two_articles_order_preserved(self):
        articles = parse_shikiho_html(_HTML_TWO)
        assert len(articles) == 2
        assert articles[0].title == "記事A"
        assert articles[1].title == "記事B"

    def test_no_summary_is_empty_string(self):
        articles = parse_shikiho_html(_HTML_NO_SUMMARY)
        assert len(articles) == 1
        assert articles[0].summary == ""

    def test_no_date_is_none(self):
        articles = parse_shikiho_html(_HTML_NO_DATE)
        assert len(articles) == 1
        assert articles[0].date_str is None

    def test_missing_title_skipped(self):
        articles = parse_shikiho_html(_HTML_MISSING_TITLE)
        assert len(articles) == 0

    def test_missing_url_skipped(self):
        articles = parse_shikiho_html(_HTML_MISSING_URL)
        assert len(articles) == 0

    def test_empty_html_returns_empty(self):
        assert parse_shikiho_html(_HTML_EMPTY) == []

    def test_no_articles_returns_empty(self):
        assert parse_shikiho_html(_HTML_NO_ARTICLES) == []

    def test_malformed_html_returns_empty_or_partial(self):
        # malformed HTML must not raise
        result = parse_shikiho_html(_HTML_MALFORMED)
        assert isinstance(result, list)

    def test_h4_title_tag_supported(self):
        articles = parse_shikiho_html(_HTML_H4_TITLE)
        assert len(articles) == 1
        assert articles[0].title == "h4タイトル記事"

    def test_max_articles_respected(self):
        articles = parse_shikiho_html(_HTML_MANY, max_articles=5)
        assert len(articles) == 5

    def test_default_max_30(self):
        articles = parse_shikiho_html(_HTML_MANY)
        assert len(articles) == 30

    def test_url_resolved_to_absolute(self):
        articles = parse_shikiho_html(_HTML_SINGLE)
        assert articles[0].url.startswith("https://")

    def test_absolute_url_in_html(self):
        articles = parse_shikiho_html(_HTML_ABSOLUTE_URL)
        assert len(articles) == 1
        assert articles[0].url == "https://shikiho.toyokeizai.net/news/777"

    def test_raw_url_preserved(self):
        articles = parse_shikiho_html(_HTML_SINGLE)
        assert articles[0].raw_url == "/news/123456"


# ── shikiho_article_to_news_item ──────────────────────────────────────────────

class TestShikihoArticleToNewsItem:
    def _make_article(self, **kwargs) -> ShikihoArticle:
        defaults = {
            "title": "テスト記事",
            "url": "https://shikiho.toyokeizai.net/news/123",
            "summary": "概要",
            "date_str": "2026-05-07",
        }
        defaults.update(kwargs)
        return ShikihoArticle(**defaults)

    def test_source_id(self):
        item = shikiho_article_to_news_item(self._make_article())
        assert item.source_id == "shikiho_online"

    def test_language(self):
        item = shikiho_article_to_news_item(self._make_article())
        assert item.language == "ja"

    def test_categories(self):
        item = shikiho_article_to_news_item(self._make_article())
        assert "japan" in item.categories
        assert "earnings" in item.categories
        assert "individual_stocks" in item.categories

    def test_title_and_url_preserved(self):
        item = shikiho_article_to_news_item(self._make_article())
        assert item.title == "テスト記事"
        assert item.url == "https://shikiho.toyokeizai.net/news/123"

    def test_summary_preserved(self):
        item = shikiho_article_to_news_item(self._make_article())
        assert item.summary == "概要"

    def test_published_at_converted_to_utc(self):
        item = shikiho_article_to_news_item(self._make_article(date_str="2026-05-07"))
        assert item.published_at == datetime(2026, 5, 6, 15, 0, 0, tzinfo=_UTC)

    def test_published_at_none_when_no_date(self):
        item = shikiho_article_to_news_item(self._make_article(date_str=None))
        assert item.published_at is None

    def test_returns_news_item_instance(self):
        item = shikiho_article_to_news_item(self._make_article())
        assert isinstance(item, NewsItem)


# ── fetch_shikiho ─────────────────────────────────────────────────────────────

class TestFetchShikiho:
    def test_success_returns_items(self):
        result = fetch_shikiho(fetcher_fn=lambda url: _HTML_TWO)
        assert result.success is True
        assert len(result.items) == 2
        assert result.error is None

    def test_correct_url_passed_to_fetcher(self):
        captured = []
        fetch_shikiho(fetcher_fn=lambda url: (captured.append(url), _HTML_EMPTY)[1])
        assert captured == [SHIKIHO_NEWS_URL]

    def test_empty_page_success_empty_items(self):
        result = fetch_shikiho(fetcher_fn=lambda url: _HTML_NO_ARTICLES)
        assert result.success is True
        assert result.items == []

    def test_fetcher_exception_returns_failure(self):
        def boom(url: str) -> str:
            raise RuntimeError("network error")
        result = fetch_shikiho(fetcher_fn=boom)
        assert result.success is False
        assert result.error == "network error"
        assert result.items == []

    def test_items_are_news_items(self):
        result = fetch_shikiho(fetcher_fn=lambda url: _HTML_SINGLE)
        assert all(isinstance(i, NewsItem) for i in result.items)

    def test_fetched_at_is_utc(self):
        result = fetch_shikiho(fetcher_fn=lambda url: _HTML_EMPTY)
        assert result.fetched_at.tzinfo == _UTC

    def test_max_articles_forwarded(self):
        result = fetch_shikiho(fetcher_fn=lambda url: _HTML_MANY, max_articles=3)
        assert len(result.items) == 3

    def test_returns_shikiho_fetch_result(self):
        result = fetch_shikiho(fetcher_fn=lambda url: _HTML_EMPTY)
        assert isinstance(result, ShikihoFetchResult)

    def test_news_item_source_id(self):
        result = fetch_shikiho(fetcher_fn=lambda url: _HTML_SINGLE)
        assert result.items[0].source_id == "shikiho_online"

    def test_news_item_categories(self):
        result = fetch_shikiho(fetcher_fn=lambda url: _HTML_SINGLE)
        cats = result.items[0].categories
        assert "earnings" in cats


# ── no forbidden imports ──────────────────────────────────────────────────────

class TestNoForbiddenImports:
    def _import_lines(self) -> list[str]:
        import backend.engine.news.shikiho_parser as mod
        import inspect
        return [
            ln for ln in inspect.getsource(mod).splitlines()
            if ln.strip().startswith("import ") or ln.strip().startswith("from ")
        ]

    def test_no_bs4(self):
        for ln in self._import_lines():
            assert "bs4" not in ln
            assert "BeautifulSoup" not in ln

    def test_no_requests(self):
        for ln in self._import_lines():
            assert "requests" not in ln

    def test_no_urllib_request(self):
        for ln in self._import_lines():
            assert "urllib.request" not in ln

    def test_no_asyncio(self):
        for ln in self._import_lines():
            assert "asyncio" not in ln
