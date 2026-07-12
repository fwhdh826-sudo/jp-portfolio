"""
RSS Fetcher — Card 4-2
Phase 4 Market Intelligence: RSS / Atom フィード文字列の parse と NewsItem 正規化。

責務:
  - NewsItem / FetchResult dataclass 定義
  - parse_published_at: 日付文字列 → timezone-aware UTC datetime（pure）
  - normalize_entry: 抽出済み文字列 → NewsItem | None（pure）
  - parse_rss_xml: RSS 2.0 XML 文字列 → list[NewsItem]（pure）
  - parse_atom_xml: Atom XML 文字列 → list[NewsItem]（pure）
  - fetch_rss_source: NewsSource + fetcher_fn(DI) → FetchResult

実装しないこと:
  - HTTP アクセス（fetcher_fn DI で分離、本番実装は後続 Card）
  - feedparser / requests / httpx / aiohttp / urllib.request
  - EDINET API（Card 4-3）
  - Shikiho スクレイプ（Card 4-4）
  - ticker 抽出 / sentiment / importance scoring（Card 4-x）
  - asyncio
  - public/data 書き込み
  - Operation Layer import

Reference: docs/v13.3/05_v13.3_master_plan.md Section 5.2
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 4-2
"""
from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Callable

from backend.engine.news.sources_config import NewsSource, SourceType

# XML 名前空間定数
_NS_ATOM = "http://www.w3.org/2005/Atom"
_NS_DC = "http://purl.org/dc/elements/1.1/"
_NS_CONTENT = "http://purl.org/rss/1.0/modules/content/"


# ── NewsItem ──────────────────────────────────────────────────────────────────

@dataclass
class NewsItem:
    """単一ニュース記事の正規化表現。"""
    source_id: str
    title: str
    url: str
    summary: str = ""
    published_at: datetime | None = None
    language: str = "ja"
    categories: tuple[str, ...] = ()
    related_tickers: tuple[str, ...] = ()
    sentiment_score: float = 0.0
    importance_score: float = 0.0


# ── FetchResult ───────────────────────────────────────────────────────────────

@dataclass
class FetchResult:
    """1 ソース取得結果。"""
    source_id: str
    items: list[NewsItem] = field(default_factory=list)
    endpoint_count: int = 0
    success_count: int = 0
    errors: list[str] = field(default_factory=list)
    fetched_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


# ── Date parsing ──────────────────────────────────────────────────────────────

def parse_published_at(date_str: str | None) -> datetime | None:
    """
    RFC-2822 または ISO 8601 の日付文字列を timezone-aware UTC datetime に変換する。
    None / 空文字 / 解析不能な値は None を返す（例外を上げない）。

    優先度:
      1. email.utils.parsedate_to_datetime — RFC-2822（RSS 2.0 pubDate 標準）
      2. datetime.fromisoformat — ISO 8601（Atom published / dc:date）
    """
    if not date_str or not date_str.strip():
        return None
    s = date_str.strip()
    try:
        dt = parsedate_to_datetime(s)
        return dt.astimezone(timezone.utc)
    except Exception:
        pass
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        pass
    return None


# ── Entry normalization ───────────────────────────────────────────────────────

def normalize_entry(
    title: str | None,
    url: str | None,
    summary: str | None,
    date_str: str | None,
    source_id: str,
    categories: tuple[str, ...],
    language: str,
) -> NewsItem | None:
    """
    抽出済み文字列から NewsItem を組み立てる（pure 関数）。
    title または url が欠ける・空の場合は None を返す（caller がスキップ）。
    """
    if not title or not title.strip():
        return None
    if not url or not url.strip():
        return None
    return NewsItem(
        source_id=source_id,
        title=title.strip(),
        url=url.strip(),
        summary=(summary or "").strip(),
        published_at=parse_published_at(date_str),
        language=language,
        categories=categories,
    )


# ── XML helpers ───────────────────────────────────────────────────────────────

def _elem_text(elem: ET.Element, *tags: str) -> str | None:
    """指定タグを順に探し、最初にテキストが見つかったものを返す。"""
    for tag in tags:
        child = elem.find(tag)
        if child is not None and child.text:
            return child.text.strip()
    return None


# ── RSS 2.0 parse ─────────────────────────────────────────────────────────────

def parse_rss_xml(
    xml_text: str,
    source_id: str,
    categories: tuple[str, ...],
    language: str = "ja",
    max_entries: int = 50,
) -> list[NewsItem]:
    """
    RSS 2.0 XML 文字列を parse して list[NewsItem] を返す。
    破損 XML は [] を返す（例外を上げない）。
    max_entries: このリスト内でのアイテム上限。
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []

    items: list[NewsItem] = []
    for item_elem in root.iter("item"):
        if len(items) >= max_entries:
            break
        title = _elem_text(item_elem, "title")
        link = _elem_text(item_elem, "link")
        summary = _elem_text(
            item_elem, "description", f"{{{_NS_CONTENT}}}encoded"
        ) or ""
        date_str = _elem_text(item_elem, "pubDate", f"{{{_NS_DC}}}date")
        entry = normalize_entry(
            title, link, summary, date_str, source_id, categories, language
        )
        if entry:
            items.append(entry)
    return items


# ── Atom parse ────────────────────────────────────────────────────────────────

def parse_atom_xml(
    xml_text: str,
    source_id: str,
    categories: tuple[str, ...],
    language: str = "ja",
    max_entries: int = 50,
) -> list[NewsItem]:
    """
    Atom 1.0 XML 文字列を parse して list[NewsItem] を返す。
    破損 XML は [] を返す（例外を上げない）。
    名前空間あり（{http://www.w3.org/2005/Atom}）となし（裸タグ）の両方に対応。
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []

    ns = _NS_ATOM
    entries = root.findall(f"{{{ns}}}entry") or root.findall("entry")

    items: list[NewsItem] = []
    for entry_elem in entries:
        if len(items) >= max_entries:
            break

        # NOTE: ElementTree の Element は子を持たない場合 falsy になるため
        #       "or" による連鎖ではなく "is not None" チェックで候補を選ぶ。
        def _first_elem(*tags: str) -> ET.Element | None:
            for tag in tags:
                found = entry_elem.find(tag)
                if found is not None:
                    return found
            return None

        title_elem = _first_elem(f"{{{ns}}}title", "title")
        title = title_elem.text.strip() if title_elem is not None and title_elem.text else None

        link_elem = _first_elem(f"{{{ns}}}link", "link")
        link: str | None = None
        if link_elem is not None:
            link = link_elem.get("href") or (
                link_elem.text.strip() if link_elem.text else None
            )

        summary_elem = _first_elem(
            f"{{{ns}}}summary", f"{{{ns}}}content", "summary", "content"
        )
        summary = summary_elem.text.strip() if summary_elem is not None and summary_elem.text else ""

        date_elem = _first_elem(
            f"{{{ns}}}published", f"{{{ns}}}updated", "published", "updated"
        )
        date_str = date_elem.text.strip() if date_elem is not None and date_elem.text else None

        entry = normalize_entry(
            title, link, summary, date_str, source_id, categories, language
        )
        if entry:
            items.append(entry)
    return items


# ── Feed format detection ─────────────────────────────────────────────────────

def _is_atom(xml_text: str) -> bool:
    """XML ルートタグが Atom feed かどうかを判定する。"""
    try:
        root = ET.fromstring(xml_text)
        tag = root.tag
        return tag in (f"{{{_NS_ATOM}}}feed", "feed") or (
            "}" in tag and tag.endswith("}feed")
        )
    except ET.ParseError:
        return False


# ── fetch_rss_source ──────────────────────────────────────────────────────────

def fetch_rss_source(
    source: NewsSource,
    fetcher_fn: Callable[[str], str],
    max_entries: int = 50,
) -> FetchResult:
    """
    NewsSource の全 endpoint を fetcher_fn 経由で取得し、RSS/Atom を parse して
    FetchResult を返す。

    Args:
        source     : NewsSource（source_type == RSS のみ items を返す）
        fetcher_fn : URL → XML 文字列 を返す callable（必須; DI）
                     本番 HTTP fetcher は後続 Card で実装する
        max_entries: 全 endpoint 合算での最大 NewsItem 数

    non-RSS source（WEB / API）は items=[] / errors にメッセージを記録して返す。
    endpoint ごとの例外は errors に記録し、次の endpoint を試行する。
    max_entries は全 endpoint 合算で制限する。
    """
    result = FetchResult(
        source_id=source.source_id,
        fetched_at=datetime.now(timezone.utc),
    )

    if source.source_type != SourceType.RSS:
        result.errors.append(
            f"{source.source_id}: source_type={source.source_type.value!r} is not RSS; skipped"
        )
        return result

    categories = tuple(c.value for c in source.categories)
    language = source.language[0] if source.language else "ja"
    result.endpoint_count = len(source.endpoints)

    for endpoint in source.endpoints:
        if len(result.items) >= max_entries:
            break
        try:
            xml_text = fetcher_fn(endpoint)
            remaining = max_entries - len(result.items)
            if _is_atom(xml_text):
                new_items = parse_atom_xml(
                    xml_text, source.source_id, categories, language, remaining
                )
            else:
                new_items = parse_rss_xml(
                    xml_text, source.source_id, categories, language, remaining
                )
            result.items.extend(new_items)
            result.success_count += 1
        except Exception as exc:
            result.errors.append(f"{source.source_id} {endpoint}: {exc}")

    return result
