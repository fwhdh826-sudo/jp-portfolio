"""
Ticker Extractor — Card 4-6
Phase 4 Market Intelligence: ニュース記事テキストから4桁証券コードを抽出し
NewsItem.related_tickers を充足する pure coordination layer。

責務:
  - TickerInfo dataclass（frozen=True）定義
  - extract_ticker_codes: regex 4桁抽出 + ticker_master 照合（pure）
  - extract_ticker_aliases: 社名 / alias 文字列一致抽出（pure）
  - extract_tickers: code + alias 統合、重複排除、ソート済み tuple（pure）
  - enrich_item: NewsItem.related_tickers を充足した新 NewsItem を返す（pure）
  - enrich_items: enrich_item の list 版

ticker_master は必ず引数 DI で受け取る。
モジュールロード時に外部ファイル・API・HTTP へのアクセスは行わない。

抽出対象フィールド:
  - title, summary のみ
  - url は対象外（パス断片での誤検出を避けるため）

false positive 抑制:
  - 正規表現で前後に数字のない 4 桁のみ抽出
  - ticker_master に存在する ticker のみ採用（主要フィルタ）
  - alias は空文字を無視

実装しないこと:
  - TickerMatch（match reason / confidence）— handover.md P2 として記録
  - ticker_master のファイル読み込み（DI のみ）
  - 形態素解析 / NLP / fuzzy match
  - asyncio
  - requests / httpx / aiohttp / urllib.request / feedparser / bs4 / selenium / playwright
  - public/data 書き込み
  - Operation Layer import
  - 実 LLM API 接続
  - 売買判断・銘柄推奨・PF 最適化

Reference: docs/v13.3/07_v13.3_spec.md Section 10.2
Reference: docs/v13.3/05_v13.3_master_plan.md Section 5.2
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 4-6
"""
from __future__ import annotations

import dataclasses
import re
from dataclasses import dataclass

from backend.engine.news.rss_fetcher import NewsItem

# ── 定数 ──────────────────────────────────────────────────────────────────────

# 前後に数字がない 4 桁のみにマッチ（lookbehind / lookahead）
_TICKER_PATTERN = re.compile(r"(?<!\d)(\d{4})(?!\d)")


# ── TickerInfo ────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class TickerInfo:
    """
    1 銘柄のメタ情報。ticker_master の value として使用する。

    Attributes:
        name    : 正式社名（例: "ソニーグループ株式会社"）
        aliases : 通称・略称タプル（例: ("ソニー", "Sony", "SONY")）
                  空 tuple も許容する。
    """
    name: str
    aliases: tuple[str, ...]


# ── extract_ticker_codes ──────────────────────────────────────────────────────

def extract_ticker_codes(
    text: str | None,
    ticker_master: dict[str, TickerInfo],
) -> list[str]:
    """
    テキストから 4 桁証券コードを正規表現で抽出し、ticker_master 照合で実在確認する。

    Args:
        text          : 検索対象テキスト（None / 空 / whitespace → []）
        ticker_master : {ticker: TickerInfo}（DI）

    Returns:
        list[str] — ticker_master に存在する 4 桁コードのリスト（重複排除、順序不定）
    """
    if not text or not text.strip():
        return []
    if not ticker_master:
        return []
    candidates = _TICKER_PATTERN.findall(text)
    return list({c for c in candidates if c in ticker_master})


# ── extract_ticker_aliases ────────────────────────────────────────────────────

def extract_ticker_aliases(
    text: str | None,
    ticker_master: dict[str, TickerInfo],
) -> list[str]:
    """
    テキストに ticker_master の aliases が部分文字列として含まれているかを調べ、
    一致した ticker を返す。

    Args:
        text          : 検索対象テキスト（None / 空 / whitespace → []）
        ticker_master : {ticker: TickerInfo}（DI）

    Returns:
        list[str] — alias が一致した ticker のリスト（重複排除、順序不定）

    - aliases が空 tuple の銘柄はスキップする
    - 空文字の alias はスキップする
    - 1 銘柄で複数 alias が一致しても ticker は 1 件のみ収集する
    """
    if not text or not text.strip():
        return []
    if not ticker_master:
        return []
    matched: set[str] = set()
    for ticker, info in ticker_master.items():
        for alias in info.aliases:
            if alias and alias in text:
                matched.add(ticker)
                break  # 同一 ticker の複数 alias マッチを抑止
    return list(matched)


# ── extract_tickers ───────────────────────────────────────────────────────────

def extract_tickers(
    text: str | None,
    ticker_master: dict[str, TickerInfo],
) -> tuple[str, ...]:
    """
    4 桁コード抽出と alias 抽出を統合し、重複排除・ソート済みの tuple を返す（pure）。

    Args:
        text          : 検索対象テキスト
        ticker_master : {ticker: TickerInfo}（DI）

    Returns:
        tuple[str, ...] — 昇順ソート済みの ticker コード tuple（空の場合は ()）
    """
    codes = extract_ticker_codes(text, ticker_master)
    aliases = extract_ticker_aliases(text, ticker_master)
    combined = set(codes) | set(aliases)
    return tuple(sorted(combined))


# ── enrich_item ───────────────────────────────────────────────────────────────

def enrich_item(
    item: NewsItem,
    ticker_master: dict[str, TickerInfo],
) -> NewsItem:
    """
    NewsItem の title + summary からティッカーを抽出し、
    related_tickers を充足した新しい NewsItem を返す（pure）。

    - 元の NewsItem は変更しない（dataclasses.replace で新オブジェクト生成）
    - 検索対象: title + " " + summary（url は対象外）
    - 既存の related_tickers は今回の抽出結果で上書きする
    - 抽出結果が空の場合は related_tickers = ()

    Args:
        item          : 対象 NewsItem
        ticker_master : {ticker: TickerInfo}（DI）

    Returns:
        NewsItem — related_tickers が充足された新しいインスタンス
    """
    search_text = f"{item.title} {item.summary}"
    tickers = extract_tickers(search_text, ticker_master)
    return dataclasses.replace(item, related_tickers=tickers)


# ── enrich_items ──────────────────────────────────────────────────────────────

def enrich_items(
    items: list[NewsItem],
    ticker_master: dict[str, TickerInfo],
) -> list[NewsItem]:
    """
    enrich_item を list に適用する（pure）。

    Args:
        items         : 対象 NewsItem リスト
        ticker_master : {ticker: TickerInfo}（DI）

    Returns:
        list[NewsItem] — related_tickers が充足された新しいリスト
        元のリストは変更しない。
    """
    return [enrich_item(item, ticker_master) for item in items]
