"""
Sentiment Calculator — Card 4-7
Phase 4 Market Intelligence: ニュース記事テキストから sentiment score（-1.0〜+1.0）を
算出する keyword/rule-based stub。

責務:
  - SentimentResult dataclass 定義
  - POSITIVE_KEYWORDS / NEGATIVE_KEYWORDS 定数（日本語金融キーワード）
  - score_text: キーワードカウント → SentimentResult（pure）
  - _derive_label: score → "positive" | "neutral" | "negative"（内部）
  - calculate_sentiment: LLM 差し替えポイント付き統合関数
  - enrich_item: NewsItem.sentiment_score を充足した新 NewsItem（pure）
  - enrich_items: enrich_item の list 版
  - aggregate_sentiment_by_ticker: ticker → avg sentiment_score
  - aggregate_sentiment_by_source: source_id → avg sentiment_score

LLM 差し替えポイント:
  scorer_fn: Callable[[str, str], float] | None
  - None の場合 keyword stub を使用（method = "keyword_stub"）
  - 提供された場合はそれを使用（method = "scorer_fn"）
  - 将来の Claude API 接続は scorer_fn 引数に渡す形で実装する

実装しないこと:
  - 実 LLM API 接続（OpenAI / Anthropic / LiteLLM / Ollama）
  - HTTP アクセス / 外部 API 呼び出し
  - scorer_fn 例外時の fallback（呼び出し側の責務）
  - 形態素解析 / NLP / word boundary 判定
  - 英語キーワード（P2 として記録）
  - asyncio
  - requests / httpx / aiohttp / urllib.request / feedparser / bs4 / selenium / playwright
  - public/data 書き込み
  - Operation Layer import
  - 売買判断・銘柄推奨・PF 最適化

P2 記録（将来対応）:
  - 英語キーワード追加（bloomberg / reuters 英語記事対応）
  - word boundary 改善（"買い" が "買い物" にヒットする問題）
  - scorer_fn 例外時の keyword fallback
  - Claude API 実接続（scorer_fn として注入）

Reference: docs/v13.3/05_v13.3_master_plan.md Section 5.2
Reference: docs/v13.3/07_v13.3_spec.md Section 10.2
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 4-7
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from typing import Callable

from backend.engine.news.rss_fetcher import NewsItem

# ── Keyword constants ─────────────────────────────────────────────────────────

POSITIVE_KEYWORDS: tuple[str, ...] = (
    "増益",
    "増収",
    "上昇",
    "上方修正",
    "好調",
    "黒字",
    "最高益",
    "最高値",
    "増配",
    "自社株買い",
    "拡大",
    "改善",
    "回復",
    "好決算",
    "急騰",
    "強気",
    "買い",
)

NEGATIVE_KEYWORDS: tuple[str, ...] = (
    "減益",
    "減収",
    "下落",
    "下方修正",
    "赤字",
    "最終赤字",
    "減配",
    "悪化",
    "懸念",
    "リスク",
    "損失",
    "急落",
    "弱気",
    "売り",
    "危機",
    "破綻",
    "警戒",
)

# ── Score constants ───────────────────────────────────────────────────────────

KEYWORD_STEP: float = 0.2       # キーワード 1 件あたりの加減点
POSITIVE_THRESHOLD: float = 0.1  # positive 判定閾値
NEGATIVE_THRESHOLD: float = -0.1 # negative 判定閾値


# ── SentimentResult ───────────────────────────────────────────────────────────

@dataclass
class SentimentResult:
    """
    sentiment 算出結果。

    Attributes:
        score         : -1.0（最悲観）〜 +1.0（最楽観）
        label         : "positive" | "neutral" | "negative"
        method        : "keyword_stub"（stub）| "scorer_fn"（DI 関数使用時）
        positive_hits : 一致したポジティブキーワードの tuple
        negative_hits : 一致したネガティブキーワードの tuple
    """
    score: float
    label: str
    method: str
    positive_hits: tuple[str, ...]
    negative_hits: tuple[str, ...]


# ── Internal helpers ──────────────────────────────────────────────────────────

def _derive_label(score: float) -> str:
    """
    score から sentiment ラベルを決定する（内部関数）。

    score > POSITIVE_THRESHOLD  → "positive"
    score < NEGATIVE_THRESHOLD  → "negative"
    それ以外                     → "neutral"
    """
    if score > POSITIVE_THRESHOLD:
        return "positive"
    if score < NEGATIVE_THRESHOLD:
        return "negative"
    return "neutral"


def _clamp(value: float) -> float:
    """float を [-1.0, +1.0] に clamp する。"""
    return max(-1.0, min(1.0, value))


# ── score_text ────────────────────────────────────────────────────────────────

def score_text(
    text: str | None,
    pos_keywords: tuple[str, ...] = POSITIVE_KEYWORDS,
    neg_keywords: tuple[str, ...] = NEGATIVE_KEYWORDS,
    step: float = KEYWORD_STEP,
) -> SentimentResult:
    """
    テキストに含まれるキーワードをカウントして SentimentResult を返す（pure）。

    Args:
        text         : 検索対象テキスト（None / 空 / whitespace → neutral 0.0）
        pos_keywords : ポジティブキーワード tuple（デフォルト POSITIVE_KEYWORDS）
        neg_keywords : ネガティブキーワード tuple（デフォルト NEGATIVE_KEYWORDS）
        step         : キーワード 1 件あたりの加減点（デフォルト KEYWORD_STEP）

    Returns:
        SentimentResult（method = "keyword_stub"）
    """
    if not text or not text.strip():
        return SentimentResult(
            score=0.0,
            label="neutral",
            method="keyword_stub",
            positive_hits=(),
            negative_hits=(),
        )

    pos_hits = tuple(kw for kw in pos_keywords if kw in text)
    neg_hits = tuple(kw for kw in neg_keywords if kw in text)

    raw_score = len(pos_hits) * step - len(neg_hits) * step
    score = _clamp(raw_score)

    return SentimentResult(
        score=score,
        label=_derive_label(score),
        method="keyword_stub",
        positive_hits=pos_hits,
        negative_hits=neg_hits,
    )


# ── calculate_sentiment ───────────────────────────────────────────────────────

def calculate_sentiment(
    title: str,
    summary: str,
    scorer_fn: Callable[[str, str], float] | None = None,
) -> SentimentResult:
    """
    title + summary のセンチメントを計算して SentimentResult を返す。

    Args:
        title      : 記事タイトル
        summary    : 記事要約
        scorer_fn  : (title, summary) -> float を返す callable（DI）
                     None の場合 keyword stub を使用
                     提供された場合はその戻り値を clamp して使用

    Returns:
        SentimentResult
        - scorer_fn=None  : method = "keyword_stub"、hits 記録あり
        - scorer_fn 提供時 : method = "scorer_fn"、hits = ()（scorer_fn は内訳を返さない）

    scorer_fn が例外を投げた場合は上位に伝播する（fallback なし）。
    scorer_fn の戻り値は必ず [-1.0, +1.0] に clamp する。
    """
    if scorer_fn is not None:
        raw = scorer_fn(title, summary)
        score = _clamp(raw)
        return SentimentResult(
            score=score,
            label=_derive_label(score),
            method="scorer_fn",
            positive_hits=(),
            negative_hits=(),
        )

    combined = f"{title} {summary}"
    return score_text(combined)


# ── enrich_item ───────────────────────────────────────────────────────────────

def enrich_item(
    item: NewsItem,
    scorer_fn: Callable[[str, str], float] | None = None,
) -> NewsItem:
    """
    NewsItem の title + summary から sentiment_score を計算し、
    sentiment_score を充足した新しい NewsItem を返す（pure）。

    - 元の NewsItem は変更しない（dataclasses.replace で新オブジェクト生成）
    - 既存の sentiment_score は今回の計算結果で上書きする

    Args:
        item       : 対象 NewsItem
        scorer_fn  : calculate_sentiment に渡す scorer_fn（None で keyword stub）

    Returns:
        NewsItem — sentiment_score が充足された新しいインスタンス
    """
    result = calculate_sentiment(item.title, item.summary, scorer_fn)
    return dataclasses.replace(item, sentiment_score=result.score)


# ── enrich_items ──────────────────────────────────────────────────────────────

def enrich_items(
    items: list[NewsItem],
    scorer_fn: Callable[[str, str], float] | None = None,
) -> list[NewsItem]:
    """
    enrich_item を list に適用する（pure）。

    Args:
        items      : 対象 NewsItem リスト
        scorer_fn  : calculate_sentiment に渡す scorer_fn

    Returns:
        list[NewsItem] — sentiment_score が充足された新しいリスト
        元のリストは変更しない。
    """
    return [enrich_item(item, scorer_fn) for item in items]


# ── aggregate_sentiment_by_ticker ─────────────────────────────────────────────

def aggregate_sentiment_by_ticker(items: list[NewsItem]) -> dict[str, float]:
    """
    ticker → avg sentiment_score を集計して返す（pure）。

    related_tickers が空の item は除外する。
    1 件の item が複数 ticker を持つ場合、各 ticker にカウントする。

    Args:
        items : sentiment_score が充足済みの NewsItem リスト

    Returns:
        dict[str, float] — {ticker: avg_sentiment_score}
        空リスト / 全 item に related_tickers なし → {}
    """
    totals: dict[str, float] = {}
    counts: dict[str, int] = {}

    for item in items:
        if not item.related_tickers:
            continue
        for ticker in item.related_tickers:
            totals[ticker] = totals.get(ticker, 0.0) + item.sentiment_score
            counts[ticker] = counts.get(ticker, 0) + 1

    return {
        ticker: totals[ticker] / counts[ticker]
        for ticker in totals
    }


# ── aggregate_sentiment_by_source ─────────────────────────────────────────────

def aggregate_sentiment_by_source(items: list[NewsItem]) -> dict[str, float]:
    """
    source_id → avg sentiment_score を集計して返す（pure）。

    sentiment_score = 0.0 の item も平均に含める。

    Args:
        items : sentiment_score が充足済みの NewsItem リスト

    Returns:
        dict[str, float] — {source_id: avg_sentiment_score}
        空リスト → {}
    """
    totals: dict[str, float] = {}
    counts: dict[str, int] = {}

    for item in items:
        src = item.source_id
        totals[src] = totals.get(src, 0.0) + item.sentiment_score
        counts[src] = counts.get(src, 0) + 1

    return {
        src: totals[src] / counts[src]
        for src in totals
    }
