"""
AI Narrator — Card 4-9
Phase 4 Market Intelligence: MacroSnapshot + NewsItem リストから
市場サマリーナレーション（MarketNarrative）を生成する rule-based stub。

責務:
  - MarketNarrative dataclass（frozen=True）定義
  - _build_headline: MacroSnapshot → 1行見出し文字列（内部 / pure）
  - _build_body: MacroSnapshot × list[NewsItem] → 本文箇条書き tuple（内部 / pure）
  - _build_keywords_summary: MacroSnapshot → キーワードサマリー tuple（内部 / pure）
  - narrate: 統合関数（pure）
    - narrator_fn: Callable[[MacroSnapshot], str] | None = None
    - None の場合 rule-based stub（method="rule_stub"）
    - 提供された場合はその戻り値を headline に使用（method="narrator_fn"）
    - 例外は上位へ伝播（fallback なし）

rule-based stub ヘッドライン生成ルール:
  risk_level == "crisis"  → "市場危機 — SAFE_MODE 発動水準"
  risk_level == "high"    → "{主要 negative tag} — リスク警戒モード"
  risk_level == "medium"  → "調整局面 — {主要 negative or positive tag}"
  risk_level == "low"     → "落ち着いた相場 — USD/JPY {usdjpy:.1f}円水準"
  signals が空の場合は risk_level のみ反映した汎用文言

実装しないこと:
  - 実 LLM API 接続（OpenAI / Anthropic / LiteLLM / Ollama）
  - HTTP アクセス / 外部 API 呼び出し
  - asyncio
  - requests / httpx / aiohttp / urllib.request / feedparser / bs4 / selenium / playwright
  - public/data 書き込み
  - Operation Layer import
  - regime module import
  - macro_fetcher からの逆 import
  - narrator_fn 例外時の fallback
  - 売買判断・銘柄推奨・PF 最適化

LLM 差し替えポイント（P2）:
  narrator_fn: Callable[[MacroSnapshot], str] を外部から注入する。
  将来の Claude API 接続は narrator_fn 引数経由で実装する。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 4-9
Reference: docs/v13.3/05_v13.3_master_plan.md Section 5.3
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

from backend.engine.market_intel.macro_fetcher import MacroSnapshot, MacroSignal
from backend.engine.news.rss_fetcher import NewsItem

# ── MarketNarrative ───────────────────────────────────────────────────────────

@dataclass(frozen=True)
class MarketNarrative:
    """
    市場ナレーション結果。

    Attributes:
        headline          : 1 行見出し
        body_lines        : 本文箇条書き（tuple）
        keywords_summary  : 強調キーワード tuple（UI バッジ用）
        sentiment_label   : "bullish" | "neutral" | "bearish"
        risk_level        : "low" | "medium" | "high" | "crisis"
        method            : "rule_stub" | "narrator_fn"
        generated_at      : 生成時刻（UTC）
    """
    headline: str
    body_lines: tuple[str, ...]
    keywords_summary: tuple[str, ...]
    sentiment_label: str
    risk_level: str
    method: str
    generated_at: datetime


# ── Internal helpers ──────────────────────────────────────────────────────────

_RISK_LABEL_JA: dict[str, str] = {
    "crisis": "危機",
    "high":   "高リスク",
    "medium": "中リスク",
    "low":    "低リスク",
}


def _dominant_signal(signals: tuple[MacroSignal, ...], direction: str) -> MacroSignal | None:
    """指定 direction でもっとも strong なシグナルを返す（同強度は tag 昇順先頭）。"""
    _strength_order = {"strong": 0, "moderate": 1, "weak": 2}
    candidates = [s for s in signals if s.direction == direction]
    if not candidates:
        return None
    return min(candidates, key=lambda s: (_strength_order.get(s.strength, 99), s.tag))


def _build_headline(snapshot: MacroSnapshot) -> str:
    """
    MacroSnapshot から 1 行見出しを生成する（rule-based / pure）。

    risk_level 優先で文言を決定し、主要シグナル tag を埋め込む。
    """
    risk = snapshot.risk_level
    signals = snapshot.signals

    if risk == "crisis":
        return "市場危機 — SAFE_MODE 発動水準"

    if risk == "high":
        neg = _dominant_signal(signals, "negative")
        tag = neg.tag if neg else "リスク指標悪化"
        return f"{tag} — リスク警戒モード"

    if risk == "medium":
        neg = _dominant_signal(signals, "negative")
        pos = _dominant_signal(signals, "positive")
        if neg:
            return f"調整局面 — {neg.tag}"
        if pos:
            return f"調整局面 — {pos.tag}"
        return "調整局面 — マクロ注視"

    # low
    if signals:
        pos = _dominant_signal(signals, "positive")
        if pos:
            return f"落ち着いた相場 — {pos.tag} / USD/JPY {snapshot.usdjpy:.1f}円水準"
    return f"落ち着いた相場 — USD/JPY {snapshot.usdjpy:.1f}円水準"


def _build_body(
    snapshot: MacroSnapshot,
    items: list[NewsItem] | tuple[NewsItem, ...],
) -> tuple[str, ...]:
    """
    MacroSnapshot + NewsItem リストから本文箇条書きを生成する（rule-based / pure）。

    構成:
      - VIX / 日経 / USD/JPY のマクロサマリー行（常時）
      - 各シグナルの説明行
      - 重要度上位 NewsItem の title（最大 5 件、importance_score 降順）
    """
    lines: list[str] = []

    # マクロサマリー行
    lines.append(
        f"VIX {snapshot.vix:.1f} / "
        f"日経5日 {snapshot.nikkei_5d_return * 100:+.1f}% / "
        f"USD/JPY {snapshot.usdjpy:.1f}"
    )
    lines.append(f"リスクレベル: {_RISK_LABEL_JA.get(snapshot.risk_level, snapshot.risk_level)}")

    # シグナル行
    for sig in snapshot.signals:
        direction_icon = "↑" if sig.direction == "positive" else (
            "↓" if sig.direction == "negative" else "→"
        )
        lines.append(f"{direction_icon} {sig.tag}（{sig.strength}）")

    # 重要ニュース行（importance_score 降順、最大 5 件）
    sorted_items = sorted(items, key=lambda x: x.importance_score, reverse=True)
    for item in sorted_items[:5]:
        lines.append(f"・{item.title}")

    return tuple(lines)


def _build_keywords_summary(snapshot: MacroSnapshot) -> tuple[str, ...]:
    """
    MacroSnapshot のシグナル tag からキーワードサマリーを生成する（pure）。

    negative direction → strong / moderate のみ採用
    positive direction → すべて採用
    結果は tag 昇順でソート
    """
    tags: list[str] = []
    for sig in snapshot.signals:
        if sig.direction == "negative" and sig.strength == "weak":
            continue
        tags.append(sig.tag)
    return tuple(sorted(tags))


# ── narrate ───────────────────────────────────────────────────────────────────

def narrate(
    snapshot: MacroSnapshot,
    items: list[NewsItem] | tuple[NewsItem, ...] = (),
    narrator_fn: Callable[[MacroSnapshot], str] | None = None,
    generated_at: datetime | None = None,
) -> MarketNarrative:
    """
    MarketNarrative を生成して返す（pure）。

    Args:
        snapshot      : MacroSnapshot（build_macro_snapshot で生成）
        items         : importance_score 充足済みの NewsItem リスト（任意）
        narrator_fn   : (MacroSnapshot) -> str を返す callable（LLM 差し替えポイント）
                        None の場合 rule-based stub を使用
        generated_at  : 生成時刻（None → datetime.now(timezone.utc)）

    Returns:
        MarketNarrative
        - narrator_fn=None  : method = "rule_stub"
        - narrator_fn 提供時 : method = "narrator_fn"、headline のみ差し替え

    narrator_fn が例外を投げた場合は上位に伝播する（fallback なし）。
    """
    effective_now = generated_at if generated_at is not None else datetime.now(timezone.utc)

    body_lines = _build_body(snapshot, list(items))
    keywords_summary = _build_keywords_summary(snapshot)

    # sentiment_label は snapshot.signals から再導出
    from backend.engine.market_intel.macro_fetcher import (
        _calc_sentiment_score,
        _sentiment_label,
    )
    sentiment_score = _calc_sentiment_score(snapshot.signals)
    sentiment_label = _sentiment_label(sentiment_score)

    if narrator_fn is not None:
        headline = str(narrator_fn(snapshot))
        method = "narrator_fn"
    else:
        headline = _build_headline(snapshot)
        method = "rule_stub"

    return MarketNarrative(
        headline=headline,
        body_lines=body_lines,
        keywords_summary=keywords_summary,
        sentiment_label=sentiment_label,
        risk_level=snapshot.risk_level,
        method=method,
        generated_at=effective_now,
    )
