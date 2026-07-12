"""
Importance Scorer — Card 4-8
Phase 4 Market Intelligence: ニュース記事の importance_score（0〜100）を算出する
rule-based scoring layer。

責務:
  - ImportanceResult dataclass 定義
  - スコアリング定数（BASELINE / SOURCE_WEIGHTS / ボーナス・ペナルティ各種）
  - _derive_importance_label: score → "high" | "medium" | "low"（内部）
  - score_item: 5 要素スコアリング + clamp（pure）
  - enrich_item: NewsItem.importance_score を充足した新 NewsItem（pure）
  - enrich_items: enrich_item の list 版
  - aggregate_importance_by_ticker: ticker → max importance_score
  - aggregate_importance_by_source: source_id → avg importance_score

スコア構成:
  score = clamp(
      BASELINE
      + source_bonus       (SOURCE_WEIGHTS[source_id], 未知=0)
      + ticker_bonus       (min(len(related_tickers) * TICKER_BONUS_PER, MAX_TICKER_BONUS))
      + holdings_bonus     (HOLDINGS_BONUS if holdings ∩ related_tickers else 0)
      + keyword_bonus      (matches_in_title * KEYWORD_BONUS_PER)
      - time_penalty       (min(hours_old * TIME_DECAY_PER_HOUR, MAX_TIME_DECAY))
  , 0, 100)

now DI:
  score_item / enrich_item / enrich_items に now: datetime | None を受け取る。
  None の場合は datetime.now(timezone.utc) を使用（本番）。
  テストでは now= を固定することで決定的な結果を得る。

実装しないこと:
  - 実 LLM API 接続
  - HTTP アクセス / 外部 API
  - asyncio
  - requests / httpx / aiohttp / urllib.request / feedparser / bs4 / selenium / playwright
  - public/data 書き込み
  - Operation Layer import
  - 売買判断・銘柄推奨・PF 最適化

Reference: docs/v13.3/07_v13.3_spec.md Section 10.3
Reference: docs/v13.3/05_v13.3_master_plan.md Section 5.2
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 4-8
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from datetime import datetime, timezone

from backend.engine.news.rss_fetcher import NewsItem

# ── スコアリング定数 ───────────────────────────────────────────────────────────

BASELINE_SCORE: float = 50.0

SOURCE_WEIGHTS: dict[str, float] = {
    "bloomberg":       15.0,
    "reuters":         15.0,
    "edinet":          12.0,
    "tdnet":           10.0,
    "jpx":              8.0,
    "shikiho_online":   8.0,
    "yahoo_finance_jp": 7.0,
    "minkabu":          5.0,
}

TICKER_BONUS_PER: float    = 4.0    # 関連銘柄 1 件あたりのボーナス
MAX_TICKER_BONUS: float    = 20.0   # 関連銘柄ボーナス上限（5 件で上限）
HOLDINGS_BONUS: float      = 15.0   # 保有銘柄一致ボーナス
KEYWORD_BONUS_PER: float   = 8.0    # アクティブキーワード 1 件あたりのボーナス
TIME_DECAY_PER_HOUR: float = 1.5    # 時間あたり減衰
MAX_TIME_DECAY: float      = 40.0   # 時間減衰上限（~26.7h で上限）

# ── 重要度ラベル閾値 ──────────────────────────────────────────────────────────

HIGH_THRESHOLD: float = 70.0
LOW_THRESHOLD: float  = 40.0


# ── ImportanceResult ──────────────────────────────────────────────────────────

@dataclass
class ImportanceResult:
    """
    importance 算出結果。各ボーナス成分を分解して保持する。

    Attributes:
        score          : 0.0〜100.0（clamp 済み）
        label          : "high" | "medium" | "low"
        source_bonus   : SOURCE_WEIGHTS[source_id]（未知は 0.0）
        ticker_bonus   : min(len(related_tickers) × TICKER_BONUS_PER, MAX_TICKER_BONUS)
        holdings_bonus : HOLDINGS_BONUS（一致）または 0.0
        keyword_bonus  : 一致 kw 数 × KEYWORD_BONUS_PER
        time_penalty   : min(hours_old × TIME_DECAY_PER_HOUR, MAX_TIME_DECAY)（非負）
    """
    score: float
    label: str
    source_bonus: float
    ticker_bonus: float
    holdings_bonus: float
    keyword_bonus: float
    time_penalty: float


# ── Internal helpers ──────────────────────────────────────────────────────────

def _derive_importance_label(score: float) -> str:
    """
    score から重要度ラベルを決定する（内部関数）。

    score >= HIGH_THRESHOLD → "high"
    score >= LOW_THRESHOLD  → "medium"
    それ以外                 → "low"
    """
    if score >= HIGH_THRESHOLD:
        return "high"
    if score >= LOW_THRESHOLD:
        return "medium"
    return "low"


def _normalize_dt(dt: datetime) -> datetime:
    """timezone-naive datetime を UTC として扱う。"""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


# ── score_item ────────────────────────────────────────────────────────────────

def score_item(
    item: NewsItem,
    active_keywords: tuple[str, ...] | list[str] = (),
    holdings: tuple[str, ...] | list[str] = (),
    now: datetime | None = None,
) -> ImportanceResult:
    """
    NewsItem の importance を 5 要素スコアリングで算出する（pure）。

    Args:
        item            : 対象 NewsItem
        active_keywords : タイトルと照合するキーワードリスト（DI）
        holdings        : 保有銘柄コードリスト（DI）
        now             : 現在時刻（None なら datetime.now(timezone.utc)）
                          テストでは固定値を渡して決定的な結果を得ること

    Returns:
        ImportanceResult（score は 0.0〜100.0 に clamp 済み）
    """
    effective_now = _normalize_dt(now) if now is not None else datetime.now(timezone.utc)

    # ① source bonus
    source_bonus = SOURCE_WEIGHTS.get(item.source_id, 0.0)

    # ② ticker bonus
    ticker_bonus = min(len(item.related_tickers) * TICKER_BONUS_PER, MAX_TICKER_BONUS)

    # ③ holdings bonus
    holdings_set = set(holdings)
    holdings_bonus = HOLDINGS_BONUS if (holdings_set & set(item.related_tickers)) else 0.0

    # ④ keyword bonus（item.title のみ照合）
    keyword_hits = sum(1 for kw in active_keywords if kw in item.title)
    keyword_bonus = keyword_hits * KEYWORD_BONUS_PER

    # ⑤ time penalty
    if item.published_at is None:
        time_penalty = 0.0
    else:
        published = _normalize_dt(item.published_at)
        hours_old = (effective_now - published).total_seconds() / 3600
        time_penalty = min(max(hours_old * TIME_DECAY_PER_HOUR, 0.0), MAX_TIME_DECAY)

    raw = (
        BASELINE_SCORE
        + source_bonus
        + ticker_bonus
        + holdings_bonus
        + keyword_bonus
        - time_penalty
    )
    score = max(0.0, min(100.0, raw))

    return ImportanceResult(
        score=score,
        label=_derive_importance_label(score),
        source_bonus=source_bonus,
        ticker_bonus=ticker_bonus,
        holdings_bonus=holdings_bonus,
        keyword_bonus=keyword_bonus,
        time_penalty=time_penalty,
    )


# ── enrich_item ───────────────────────────────────────────────────────────────

def enrich_item(
    item: NewsItem,
    active_keywords: tuple[str, ...] | list[str] = (),
    holdings: tuple[str, ...] | list[str] = (),
    now: datetime | None = None,
) -> NewsItem:
    """
    NewsItem の importance_score を充足した新しい NewsItem を返す（pure）。

    - 元の NewsItem は変更しない（dataclasses.replace で新オブジェクト生成）
    - 既存の importance_score は今回の計算結果で上書きする

    Args:
        item            : 対象 NewsItem
        active_keywords : score_item に渡すキーワードリスト
        holdings        : score_item に渡す保有銘柄リスト
        now             : score_item に渡す現在時刻

    Returns:
        NewsItem — importance_score が充足された新しいインスタンス
    """
    result = score_item(item, active_keywords, holdings, now)
    return dataclasses.replace(item, importance_score=result.score)


# ── enrich_items ──────────────────────────────────────────────────────────────

def enrich_items(
    items: list[NewsItem],
    active_keywords: tuple[str, ...] | list[str] = (),
    holdings: tuple[str, ...] | list[str] = (),
    now: datetime | None = None,
) -> list[NewsItem]:
    """
    enrich_item を list に適用する（pure）。

    Args:
        items           : 対象 NewsItem リスト
        active_keywords : enrich_item に渡すキーワードリスト
        holdings        : enrich_item に渡す保有銘柄リスト
        now             : enrich_item に渡す現在時刻

    Returns:
        list[NewsItem] — importance_score が充足された新しいリスト
        元のリストは変更しない。
    """
    return [enrich_item(item, active_keywords, holdings, now) for item in items]


# ── aggregate_importance_by_ticker ────────────────────────────────────────────

def aggregate_importance_by_ticker(items: list[NewsItem]) -> dict[str, float]:
    """
    ticker → max importance_score を集計して返す（pure）。

    related_tickers が空の item は除外する。
    1 件の item が複数 ticker を持つ場合、各 ticker に importance_score を反映する。

    Args:
        items : importance_score が充足済みの NewsItem リスト

    Returns:
        dict[str, float] — {ticker: max_importance_score}
        空リスト / 全 item に related_tickers なし → {}
    """
    result: dict[str, float] = {}
    for item in items:
        if not item.related_tickers:
            continue
        for ticker in item.related_tickers:
            if ticker not in result or item.importance_score > result[ticker]:
                result[ticker] = item.importance_score
    return result


# ── aggregate_importance_by_source ────────────────────────────────────────────

def aggregate_importance_by_source(items: list[NewsItem]) -> dict[str, float]:
    """
    source_id → avg importance_score を集計して返す（pure）。

    importance_score = 0.0 の item も平均に含める。

    Args:
        items : importance_score が充足済みの NewsItem リスト

    Returns:
        dict[str, float] — {source_id: avg_importance_score}
        空リスト → {}
    """
    totals: dict[str, float] = {}
    counts: dict[str, int] = {}

    for item in items:
        src = item.source_id
        totals[src] = totals.get(src, 0.0) + item.importance_score
        counts[src] = counts.get(src, 0) + 1

    return {src: totals[src] / counts[src] for src in totals}
