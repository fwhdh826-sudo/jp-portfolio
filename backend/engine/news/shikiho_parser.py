"""
Shikiho Parser — Card 4-4
Phase 4 Market Intelligence: 会社四季報オンライン HTML の parse と NewsItem 正規化。

責務:
  - ShikihoArticle / ShikihoFetchResult dataclass 定義
  - _ShikihoHTMLParser: stdlib HTMLParser によるイベント駆動 parse（内部クラス）
  - parse_shikiho_html: HTML 文字列 → list[ShikihoArticle]（pure）
  - normalize_article: 抽出 dict → ShikihoArticle | None（pure）
  - resolve_url: 相対 URL → 絶対 URL（pure, urllib.parse.urljoin）
  - parse_article_date: "YYYY-MM-DD" JST → UTC datetime（pure）
  - shikiho_article_to_news_item: ShikihoArticle → NewsItem（pure）
  - fetch_shikiho: fetcher_fn(DI) → ShikihoFetchResult

実装しないこと:
  - 実 HTTP アクセス（fetcher_fn DI で分離、本番実装は後続 Card）
  - requests / httpx / aiohttp / urllib.request
  - bs4 / selenium / playwright
  - ログイン / Cookie / CAPTCHA 対応
  - robots.txt チェック
  - asyncio
  - ticker 抽出 / sentiment / importance scoring（Card 4-x）
  - public/data 書き込み
  - Operation Layer import

⚠️  HTML 構造について:
    本モジュールが期待する HTML 構造は assumed fixture structure であり、
    実際の shikiho.toyokeizai.net のサイト構造は未確認。
    実サイト確認後に後続 Card で修正予定。

    想定構造:
      <article class="news-item">
        <h3 class="title"><a href="/news/123456">記事タイトル</a></h3>
        <p class="summary">記事の概要テキスト</p>
        <time class="date" datetime="2026-05-07">2026年5月7日</time>
      </article>

Reference: docs/v13.3/05_v13.3_master_plan.md Section 5.1
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 4-4
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Callable
from urllib.parse import urljoin

from backend.engine.news.rss_fetcher import NewsItem

# ── 定数 ──────────────────────────────────────────────────────────────────────

SHIKIHO_BASE = "https://shikiho.toyokeizai.net"
SHIKIHO_NEWS_URL = "https://shikiho.toyokeizai.net/news/"

_JST = timezone(timedelta(hours=9))


# ── ShikihoArticle ────────────────────────────────────────────────────────────

@dataclass
class ShikihoArticle:
    """
    四季報オンライン HTML から抽出した 1 記事の中間表現。
    NewsItem への変換前に保持する。
    """
    title: str
    url: str                        # 絶対 URL（resolve 済み）
    summary: str = ""
    date_str: str | None = None     # raw "2026-05-07"（<time datetime="...">）
    raw_url: str = ""               # 元の href（デバッグ用）


# ── ShikihoFetchResult ────────────────────────────────────────────────────────

@dataclass
class ShikihoFetchResult:
    """fetch_shikiho の取得結果。"""
    items: list[NewsItem] = field(default_factory=list)
    success: bool = False
    error: str | None = None
    fetched_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


# ── Internal HTML parser ──────────────────────────────────────────────────────

class _ShikihoHTMLParser(HTMLParser):
    """
    内部クラス。HTML をイベント駆動で parse し raw article dict を収集する。

    想定 HTML 構造（assumed, 実サイト未確認）:
      <article class="news-item">
        <h3 class="title"><a href="...">title text</a></h3>
        <p class="summary">summary text</p>
        <time datetime="YYYY-MM-DD">...</time>
      </article>
    """

    def __init__(self, max_articles: int = 30) -> None:
        super().__init__()
        self._max = max_articles
        self._raw_articles: list[dict] = []

        # 状態
        self._in_article: bool = False
        self._current: dict | None = None
        self._in_title: bool = False
        self._title_tag: str | None = None  # タイトルを含む見出しタグ名
        self._in_summary: bool = False

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if len(self._raw_articles) >= self._max:
            return

        attrs_dict = dict(attrs)
        classes = attrs_dict.get("class", "").split()

        # article.news-item 開始
        if tag == "article" and "news-item" in classes:
            self._in_article = True
            self._current = {"title": "", "url": "", "summary": "", "date_str": None}
            return

        if not self._in_article or self._current is None:
            return

        # 見出しタグ（タイトルコンテキスト開始）
        if tag in ("h1", "h2", "h3", "h4") and "title" in classes:
            self._in_title = True
            self._title_tag = tag
            return

        # タイトルコンテキスト内の <a href> → URL 取得
        if self._in_title and tag == "a":
            href = attrs_dict.get("href", "").strip()
            if href and not self._current["url"]:
                self._current["url"] = href
            return

        # サマリー段落（サマリーコンテキスト開始）
        if tag == "p" and "summary" in classes:
            self._in_summary = True
            return

        # <time datetime="YYYY-MM-DD">
        if tag == "time":
            dt_attr = attrs_dict.get("datetime", "").strip()
            if dt_attr:
                self._current["date_str"] = dt_attr

    def handle_endtag(self, tag: str) -> None:
        if not self._in_article:
            return

        # article 終了 → 収集した raw_dict を確定
        if tag == "article":
            if self._current is not None:
                self._raw_articles.append(self._current)
            self._current = None
            self._in_article = False
            self._in_title = False
            self._title_tag = None
            self._in_summary = False
            return

        # タイトルコンテキスト終了
        if self._in_title and self._title_tag is not None and tag == self._title_tag:
            self._in_title = False
            self._title_tag = None
            return

        # サマリーコンテキスト終了
        if self._in_summary and tag == "p":
            self._in_summary = False

    def handle_data(self, data: str) -> None:
        if not self._in_article or self._current is None:
            return

        text = data.strip()
        if not text:
            return

        if self._in_title:
            self._current["title"] += text
        elif self._in_summary:
            self._current["summary"] += text


# ── URL resolution ────────────────────────────────────────────────────────────

def resolve_url(href: str, base_url: str = SHIKIHO_BASE) -> str:
    """
    相対 URL を絶対 URL に変換する（stdlib urllib.parse.urljoin 使用）。
    href が空の場合は "" を返す。
    urljoin は HTTP 通信を行わない。
    """
    if not href or not href.strip():
        return ""
    return urljoin(base_url, href.strip())


# ── Date parsing ──────────────────────────────────────────────────────────────

def parse_article_date(s: str | None) -> datetime | None:
    """
    <time datetime="YYYY-MM-DD"> の値を timezone-aware UTC datetime に変換する。

    Shikiho の datetime 属性は "YYYY-MM-DD" 形式・JST 日付。
    JST 当日 00:00:00 として UTC に変換する（JST 00:00 = UTC 前日 15:00）。
    None / 空 / 解析不能な値は None を返す（例外を上げない）。
    """
    if not s or not s.strip():
        return None
    try:
        d = date.fromisoformat(s.strip())
        dt_jst = datetime(d.year, d.month, d.day, 0, 0, 0, tzinfo=_JST)
        return dt_jst.astimezone(timezone.utc)
    except (ValueError, AttributeError):
        return None


# ── Article normalization ─────────────────────────────────────────────────────

def normalize_article(
    raw_dict: dict,
    base_url: str = SHIKIHO_BASE,
) -> ShikihoArticle | None:
    """
    _ShikihoHTMLParser が収集した raw dict を ShikihoArticle に変換する（pure）。
    title または url が欠けている / 空の場合は None を返す（caller がスキップ）。
    相対 URL は resolve_url で絶対 URL に変換する。
    """
    title = (raw_dict.get("title") or "").strip()
    raw_url = (raw_dict.get("url") or "").strip()

    if not title or not raw_url:
        return None

    resolved = resolve_url(raw_url, base_url)
    if not resolved:
        return None

    return ShikihoArticle(
        title=title,
        url=resolved,
        summary=(raw_dict.get("summary") or "").strip(),
        date_str=raw_dict.get("date_str"),
        raw_url=raw_url,
    )


# ── HTML parse ────────────────────────────────────────────────────────────────

def parse_shikiho_html(
    html_text: str,
    max_articles: int = 30,
) -> list[ShikihoArticle]:
    """
    四季報オンライン ニュース一覧ページの HTML 文字列を parse して
    list[ShikihoArticle] を返す（pure）。

    malformed HTML は [] を返す（例外を外に出さない）。
    title または url が欠けた記事はスキップする。
    max_articles: 返却するアイテムの上限。
    """
    try:
        parser = _ShikihoHTMLParser(max_articles=max_articles)
        parser.feed(html_text)
    except Exception:
        return []

    articles: list[ShikihoArticle] = []
    for raw in parser._raw_articles:
        article = normalize_article(raw)
        if article is not None:
            articles.append(article)
    return articles


# ── ShikihoArticle → NewsItem ─────────────────────────────────────────────────

def shikiho_article_to_news_item(article: ShikihoArticle) -> NewsItem:
    """
    ShikihoArticle を NewsItem に変換する（pure）。

    source_id : "shikiho_online"
    language  : "ja"
    categories: ("japan", "earnings", "individual_stocks")
    """
    return NewsItem(
        source_id="shikiho_online",
        title=article.title,
        url=article.url,
        summary=article.summary,
        published_at=parse_article_date(article.date_str),
        language="ja",
        categories=("japan", "earnings", "individual_stocks"),
    )


# ── fetch_shikiho ─────────────────────────────────────────────────────────────

def fetch_shikiho(
    fetcher_fn: Callable[[str], str],
    max_articles: int = 30,
) -> ShikihoFetchResult:
    """
    SHIKIHO_NEWS_URL を fetcher_fn 経由で取得し、parse して
    ShikihoFetchResult を返す。

    Args:
        fetcher_fn  : URL → HTML 文字列 を返す callable（必須; DI）
                      本番 HTTP fetcher は後続 Card で実装する
        max_articles: 返却する最大アイテム数（デフォルト 30）

    fetcher_fn の例外は success=False / error に記録して返す。
    空ページ（記事 0 件）は success=True / items=[] で返す。
    """
    result = ShikihoFetchResult(fetched_at=datetime.now(timezone.utc))
    try:
        html_text = fetcher_fn(SHIKIHO_NEWS_URL)
        articles = parse_shikiho_html(html_text, max_articles)
        result.items = [shikiho_article_to_news_item(a) for a in articles]
        result.success = True
    except Exception as exc:
        result.error = str(exc)
        result.success = False
    return result
