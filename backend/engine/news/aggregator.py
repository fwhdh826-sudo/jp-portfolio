"""
News Aggregator — Card 4-5
Phase 4 Market Intelligence: 8ソース統合・デデュプ・フィルタ。

責務:
  - SourceStatus dataclass（per-source 取得結果サマリー）
  - AggregateResult dataclass（全体集約結果）
  - deduplicate_items: URL 完全一致で重複除去（pure）
  - filter_by_tickers: related_tickers によるフィルタ（pure）
  - _dispatch_source: 1ソースを適切なフェッチャーに dispatch（内部）
  - aggregate_news: 全ソース dispatch → 統合 → dedup

dispatch 方針（source_id 優先、SourceType は RSS のみ汎用）:
  - source_id == "edinet"          → fetch_edinet_documents（DI）
  - source_id == "shikiho_online"  → fetch_shikiho（DI）
  - source.source_type == RSS      → fetch_rss_source（DI）
  - それ以外                       → error status（全体停止しない）
  - fetchers dict にキーなし       → error="no fetcher"（全体停止しない）

実装しないこと:
  - asyncio
  - requests / httpx / aiohttp / urllib.request / feedparser / bs4 / selenium / playwright
  - public/data 書き込み
  - Operation Layer import
  - 実 HTTP アクセス（fetcher_fn DI のみ）
  - ticker 抽出 / sentiment / importance scoring（Card 4-x）
  - 実 LLM API 接続
  - 売買判断・銘柄推奨・PF 最適化

Reference: docs/v13.3/05_v13.3_master_plan.md Section 5.2
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 4-5
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Callable

from backend.engine.news.edinet_api import fetch_edinet_documents
from backend.engine.news.rss_fetcher import NewsItem, fetch_rss_source
from backend.engine.news.shikiho_parser import fetch_shikiho
from backend.engine.news.sources_config import NewsSource, SourceType


# ── SourceStatus ──────────────────────────────────────────────────────────────

@dataclass
class SourceStatus:
    """1 ソースの取得結果サマリー。"""
    source_id: str
    success: bool
    item_count: int
    error: str | None
    fetched_at: datetime


# ── AggregateResult ───────────────────────────────────────────────────────────

@dataclass
class AggregateResult:
    """
    aggregate_news の返却値。
    dedup 済み NewsItem リストと全ソースの SourceStatus を保持する。
    """
    items: list[NewsItem]
    source_statuses: list[SourceStatus]
    fetched_at: datetime
    total_fetched: int       # dedup 前の合計件数
    deduplicated_count: int  # 除去した重複件数（= total_fetched - len(items)）


# ── deduplicate_items ─────────────────────────────────────────────────────────

def deduplicate_items(items: list[NewsItem]) -> list[NewsItem]:
    """
    URL 完全一致で重複を除去する（pure）。先着優先（最初の出現を保持）。
    空リストは [] を返す。元のリストは変更しない。
    """
    seen: set[str] = set()
    result: list[NewsItem] = []
    for item in items:
        if item.url not in seen:
            seen.add(item.url)
            result.append(item)
    return result


# ── filter_by_tickers ─────────────────────────────────────────────────────────

def filter_by_tickers(
    items: list[NewsItem],
    tickers: tuple[str, ...] | list[str],
) -> list[NewsItem]:
    """
    related_tickers に tickers のいずれかを含む NewsItem のみ返す（pure）。

    tickers が空の場合は [] を返す。
    related_tickers が空のアイテム（Card 4-x 以前の通常状態）は常に除外される。
    """
    if not tickers:
        return []
    ticker_set = set(tickers)
    return [item for item in items if ticker_set & set(item.related_tickers)]


# ── _dispatch_source ──────────────────────────────────────────────────────────

def _dispatch_source(
    source: NewsSource,
    fetchers: dict[str, Callable[[str], str]],
    target_date: date | None,
    max_shikiho_articles: int,
) -> tuple[SourceStatus, list[NewsItem]]:
    """
    1 ソースを適切なフェッチャーに dispatch して (SourceStatus, items) を返す。

    source_id 優先でマッチングし、"edinet" / "shikiho_online" は SourceType に
    関わらず専用 fetcher を呼ぶ。それ以外は SourceType.RSS のみ汎用対応。
    fetcher が存在しない / 例外が発生しても呼び出し元は継続する。
    """
    source_id = source.source_id
    fetcher_fn = fetchers.get(source_id)
    now = datetime.now(timezone.utc)

    if fetcher_fn is None:
        return (
            SourceStatus(
                source_id=source_id,
                success=False,
                item_count=0,
                error="no fetcher",
                fetched_at=now,
            ),
            [],
        )

    try:
        if source_id == "edinet":
            effective_date = target_date if target_date is not None else date.today()
            result = fetch_edinet_documents(effective_date, fetcher_fn)
            return (
                SourceStatus(
                    source_id=source_id,
                    success=result.success,
                    item_count=len(result.items),
                    error=result.error,
                    fetched_at=result.fetched_at,
                ),
                result.items,
            )

        if source_id == "shikiho_online":
            result = fetch_shikiho(fetcher_fn, max_shikiho_articles)
            return (
                SourceStatus(
                    source_id=source_id,
                    success=result.success,
                    item_count=len(result.items),
                    error=result.error,
                    fetched_at=result.fetched_at,
                ),
                result.items,
            )

        if source.source_type == SourceType.RSS:
            result = fetch_rss_source(source, fetcher_fn)
            errors_str = "; ".join(result.errors) if result.errors else None
            return (
                SourceStatus(
                    source_id=source_id,
                    success=result.success_count > 0,
                    item_count=len(result.items),
                    error=errors_str,
                    fetched_at=result.fetched_at,
                ),
                result.items,
            )

        # unsupported: non-edinet, non-shikiho_online, non-RSS
        return (
            SourceStatus(
                source_id=source_id,
                success=False,
                item_count=0,
                error=f"unsupported source type: {source.source_type.value!r}",
                fetched_at=now,
            ),
            [],
        )

    except Exception as exc:
        return (
            SourceStatus(
                source_id=source_id,
                success=False,
                item_count=0,
                error=str(exc),
                fetched_at=datetime.now(timezone.utc),
            ),
            [],
        )


# ── aggregate_news ────────────────────────────────────────────────────────────

def aggregate_news(
    sources: list[NewsSource],
    fetchers: dict[str, Callable[[str], str]],
    target_date: date | None = None,
    max_shikiho_articles: int = 30,
) -> AggregateResult:
    """
    sources リスト内の全ソースを fetchers dict 経由で取得・統合して返す。

    Args:
        sources              : 取得対象の NewsSource リスト
        fetchers             : {source_id: fetcher_fn} — URL → 文字列（DI）
        target_date          : EDINET 取得対象日（None の場合 date.today() を使用）
        max_shikiho_articles : Shikiho の最大記事数（デフォルト 30）

    Returns:
        AggregateResult — dedup 済み items + per-source SourceStatus リスト

    1 ソースが失敗しても他ソースの取得は継続する。
    fetchers に存在しない source_id はスキップ（error status を記録）する。
    """
    all_items: list[NewsItem] = []
    statuses: list[SourceStatus] = []

    for source in sources:
        status, items = _dispatch_source(
            source, fetchers, target_date, max_shikiho_articles
        )
        statuses.append(status)
        all_items.extend(items)

    total_fetched = len(all_items)
    deduped = deduplicate_items(all_items)
    deduplicated_count = total_fetched - len(deduped)

    return AggregateResult(
        items=deduped,
        source_statuses=statuses,
        fetched_at=datetime.now(timezone.utc),
        total_fetched=total_fetched,
        deduplicated_count=deduplicated_count,
    )
