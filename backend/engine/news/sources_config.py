"""
News Sources Config — Card 4-1
Phase 4 Market Intelligence: 8 ニュースソースの静的定義層。

責務:
  - SourceType / SourcePriority / SourceCategory Enum 定義
  - NewsSource dataclass 定義（frozen=True）
  - DEFAULT_NEWS_SOURCES: dict[str, NewsSource]（8ソース）
  - get_sources_by_priority / get_sources_by_category / get_sources_by_type / get_enabled_sources
  - validate_sources（明示的呼び出し時のみ実行）

実装しないこと:
  - RSS 取得（feedparser / requests / aiohttp / httpx）
  - HTML スクレイプ
  - API 接続・認証
  - public/data への書き込み
  - Operation Layer の import
  - モジュールロード時の自動バリデーション

Reference: docs/v13.3/05_v13.3_master_plan.md Section 5.1
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional


# ── Enums ─────────────────────────────────────────────────────────────────────

class SourceType(str, Enum):
    RSS = "rss"
    WEB = "web"
    API = "api"


class SourcePriority(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class SourceCategory(str, Enum):
    MACRO = "macro"
    INTERNATIONAL = "international"
    JAPAN = "japan"
    MARKETS = "markets"
    INDIVIDUAL_STOCKS = "individual_stocks"
    EARNINGS = "earnings"
    DISCLOSURE = "disclosure"
    REGULATORY = "regulatory"
    MARKET_STRUCTURE = "market_structure"


# ── NewsSource dataclass ───────────────────────────────────────────────────────

@dataclass(frozen=True)
class NewsSource:
    source_id: str
    name: str
    source_type: SourceType
    endpoints: tuple[str, ...]
    language: tuple[str, ...]
    priority: SourcePriority
    fetch_interval_min: int
    categories: tuple[SourceCategory, ...]
    enabled: bool = True
    auth_required: bool = False
    note: str = ""


# ── DEFAULT_NEWS_SOURCES ───────────────────────────────────────────────────────

DEFAULT_NEWS_SOURCES: dict[str, NewsSource] = {
    "bloomberg": NewsSource(
        source_id="bloomberg",
        name="Bloomberg",
        source_type=SourceType.RSS,
        endpoints=(
            "https://feeds.bloomberg.com/markets/news.rss",
            "https://feeds.bloomberg.com/economics/news.rss",
            "https://feeds.bloomberg.com/technology/news.rss",
        ),
        language=("en",),
        priority=SourcePriority.HIGH,
        fetch_interval_min=30,
        categories=(SourceCategory.MACRO, SourceCategory.INTERNATIONAL),
        auth_required=False,
    ),
    "reuters": NewsSource(
        source_id="reuters",
        name="Reuters",
        source_type=SourceType.RSS,
        endpoints=(
            "https://feeds.reuters.com/reuters/businessNews",
            "https://feeds.reuters.com/reuters/JPbusinessNews",
        ),
        language=("en", "ja"),
        priority=SourcePriority.HIGH,
        fetch_interval_min=30,
        categories=(
            SourceCategory.MACRO,
            SourceCategory.INTERNATIONAL,
            SourceCategory.JAPAN,
        ),
    ),
    "yahoo_finance_jp": NewsSource(
        source_id="yahoo_finance_jp",
        name="Yahoo!ファイナンス",
        source_type=SourceType.RSS,
        endpoints=(
            "https://news.yahoo.co.jp/rss/topics/business.xml",
            "https://news.yahoo.co.jp/rss/categories/markets.xml",
        ),
        language=("ja",),
        priority=SourcePriority.HIGH,
        fetch_interval_min=30,
        categories=(SourceCategory.JAPAN, SourceCategory.MARKETS),
    ),
    "minkabu": NewsSource(
        source_id="minkabu",
        name="MINKABU",
        source_type=SourceType.RSS,
        endpoints=("https://minkabu.jp/news/index.rss",),
        language=("ja",),
        priority=SourcePriority.MEDIUM,
        fetch_interval_min=60,
        categories=(SourceCategory.JAPAN, SourceCategory.INDIVIDUAL_STOCKS),
    ),
    "shikiho_online": NewsSource(
        source_id="shikiho_online",
        name="会社四季報オンライン",
        source_type=SourceType.WEB,
        endpoints=("https://shikiho.toyokeizai.net/news/",),
        language=("ja",),
        priority=SourcePriority.MEDIUM,
        fetch_interval_min=360,
        categories=(
            SourceCategory.JAPAN,
            SourceCategory.EARNINGS,
            SourceCategory.INDIVIDUAL_STOCKS,
        ),
        note="Web スクレイプは利用規約遵守、頻度低め",
    ),
    "tdnet": NewsSource(
        source_id="tdnet",
        name="TDnet",
        source_type=SourceType.RSS,
        endpoints=("https://www.release.tdnet.info/inbs/I_list_001_xxxxxxxx.html",),
        language=("ja",),
        priority=SourcePriority.HIGH,
        fetch_interval_min=60,
        categories=(SourceCategory.EARNINGS, SourceCategory.DISCLOSURE),
    ),
    "edinet": NewsSource(
        source_id="edinet",
        name="EDINET",
        source_type=SourceType.API,
        endpoints=("https://disclosure.edinet-fsa.go.jp/api/v2/",),
        language=("ja",),
        priority=SourcePriority.HIGH,
        fetch_interval_min=60,
        categories=(SourceCategory.DISCLOSURE, SourceCategory.REGULATORY),
    ),
    "jpx": NewsSource(
        source_id="jpx",
        name="JPX",
        source_type=SourceType.RSS,
        endpoints=("https://www.jpx.co.jp/news/rss/news.xml",),
        language=("ja",),
        priority=SourcePriority.MEDIUM,
        fetch_interval_min=60,
        categories=(SourceCategory.REGULATORY, SourceCategory.MARKET_STRUCTURE),
    ),
}


# ── Filtering API ──────────────────────────────────────────────────────────────

def get_sources_by_priority(
    priority: SourcePriority,
    sources: dict[str, NewsSource] | None = None,
) -> dict[str, NewsSource]:
    """指定 priority のソースを返す。"""
    if sources is None:
        sources = DEFAULT_NEWS_SOURCES
    return {k: v for k, v in sources.items() if v.priority == priority}


def get_sources_by_category(
    category: SourceCategory,
    sources: dict[str, NewsSource] | None = None,
) -> dict[str, NewsSource]:
    """指定 category を含むソースを返す。"""
    if sources is None:
        sources = DEFAULT_NEWS_SOURCES
    return {k: v for k, v in sources.items() if category in v.categories}


def get_sources_by_type(
    source_type: SourceType,
    sources: dict[str, NewsSource] | None = None,
) -> dict[str, NewsSource]:
    """指定 source_type のソースを返す。"""
    if sources is None:
        sources = DEFAULT_NEWS_SOURCES
    return {k: v for k, v in sources.items() if v.source_type == source_type}


def get_enabled_sources(
    sources: dict[str, NewsSource] | None = None,
) -> dict[str, NewsSource]:
    """enabled=True のソースのみ返す。"""
    if sources is None:
        sources = DEFAULT_NEWS_SOURCES
    return {k: v for k, v in sources.items() if v.enabled}


# ── Validation ────────────────────────────────────────────────────────────────

class NewsSourceValidationError(ValueError):
    """NewsSource 定義の整合性エラー。"""


def validate_sources(sources: dict[str, NewsSource]) -> None:
    """
    ソース定義の整合性を検査する。問題があれば NewsSourceValidationError を上げる。

    検査項目:
      1. source_id が空でない
      2. dict キーと source_id が一致する
      3. endpoints が 1 件以上
      4. categories が 1 件以上
      5. fetch_interval_min >= 1
      6. enabled が bool 型

    モジュールロード時には自動実行しない。明示的に呼び出すこと。
    """
    for key, src in sources.items():
        if not src.source_id:
            raise NewsSourceValidationError(
                f"source_id is empty for key {key!r}"
            )
        if src.source_id != key:
            raise NewsSourceValidationError(
                f"source_id {src.source_id!r} does not match dict key {key!r}"
            )
        if len(src.endpoints) == 0:
            raise NewsSourceValidationError(
                f"{key!r}: endpoints must have at least one entry"
            )
        if len(src.categories) == 0:
            raise NewsSourceValidationError(
                f"{key!r}: categories must have at least one entry"
            )
        if src.fetch_interval_min < 1:
            raise NewsSourceValidationError(
                f"{key!r}: fetch_interval_min must be >= 1, got {src.fetch_interval_min}"
            )
        if not isinstance(src.enabled, bool):
            raise NewsSourceValidationError(
                f"{key!r}: enabled must be bool, got {type(src.enabled)}"
            )
