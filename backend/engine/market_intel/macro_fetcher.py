"""
Macro Fetcher — Card 4-9
Phase 4 Market Intelligence: マクロ市場データから MacroSnapshot を生成し、
market_intel dict（Phase 5 scoring が消費する形式）を返す pure layer。

責務:
  - MacroSignal dataclass（frozen=True）定義
  - MacroSnapshot dataclass（frozen=True）定義
  - derive_signals: 入力値 → MacroSignal tuple（pure）
  - derive_risk_level: 入力値 → "low" | "medium" | "high" | "crisis"（pure）
  - build_macro_snapshot: 全入力値 → MacroSnapshot（pure）
  - build_market_intel_dict: MacroSnapshot → market_intel dict（pure）
    - market_intel["sentiment"]["score"]: 0〜100 スケール
    - market_intel["active_keywords"]: importance_scorer に渡せる tag list

MacroSignal tag 一覧:
  "円安", "円高", "VIX高", "低VIX", "デスクロス", "短期急騰", "短期急落",
  "リスクオフ", "調整局面", "リスク警戒"

risk_level 算出ルール（regime rule_based と同等の閾値を独立定義）:
  "crisis"  : vix > 40 or sp500_dd_30d < -0.20
  "high"    : (vix > 25 and sp500_dd_30d < -0.10) or sp500_dd_30d < -0.15
  "medium"  : vix > 20 or sp500_dd_30d < -0.05 or (nikkei_60ma < nikkei_200ma)
  "low"     : それ以外

sentiment score 算出（0〜100）:
  ベース 50 に各シグナルの direction × strength 係数を加算して clamp。
  positive: weak=+5, moderate=+8, strong=+12
  negative: weak=-5, moderate=-8, strong=-12

now DI:
  build_macro_snapshot(…, computed_at: datetime | None)
  None の場合は datetime.now(timezone.utc)。テストでは固定値を渡す。

実装しないこと:
  - 実 HTTP アクセス / 外部 API 接続
  - 実 LLM API 接続
  - asyncio
  - requests / httpx / aiohttp / urllib.request / feedparser / bs4 / selenium / playwright
  - public/data 書き込み
  - Operation Layer import
  - regime module import
  - ai_narrator import
  - 売買判断・銘柄推奨・PF 最適化

Reference: docs/v13.3/07_v13.3_spec.md Section 6.1
Reference: docs/v13.3/05_v13.3_master_plan.md Section 5.3
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 4-9
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

# ── シグナル判定定数（regime/rule_based.py と同等の閾値を独立定義） ───────────

_CRISIS_VIX: float          = 40.0
_CRISIS_SP500_DD: float     = -0.20
_HIGH_SP500_DD: float       = -0.15
_HIGH_VIX_AND_DD_VIX: float = 25.0
_HIGH_VIX_AND_DD_DD: float  = -0.10
_MEDIUM_VIX: float          = 20.0
_MEDIUM_SP500_DD: float     = -0.05

_VIX_HIGH_SIGNAL: float     = 30.0    # "VIX高" シグナル閾値
_VIX_LOW_SIGNAL: float      = 15.0    # "低VIX" シグナル閾値
_USDJPY_WEAK: float         = 155.0   # "円安" シグナル閾値
_USDJPY_STRONG: float       = 130.0   # "円高" シグナル閾値
_NIKKEI_SURGE: float        = 0.03    # "短期急騰" シグナル閾値
_NIKKEI_PLUNGE: float       = -0.03   # "短期急落" シグナル閾値
_RISK_OFF_DD: float         = -0.15   # "リスクオフ" シグナル閾値
_CORRECTION_DD: float       = -0.05   # "調整局面" シグナル閾値
_ALERT_VIX: float           = 25.0    # "リスク警戒" VIX 閾値
_ALERT_DD: float            = -0.10   # "リスク警戒" SP500 閾値

# sentiment スコア加点（positive / negative を共通強度マップで管理）
_SENTIMENT_STEP: dict[str, float] = {
    "weak":     5.0,
    "moderate": 8.0,
    "strong":   12.0,
}


# ── MacroSignal ───────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class MacroSignal:
    """
    マクロシグナル 1 件。

    Attributes:
        tag       : シグナル識別タグ（例: "円安", "VIX高"）
        strength  : "weak" | "moderate" | "strong"
        direction : "positive" | "negative" | "neutral"
    """
    tag: str
    strength: str
    direction: str


# ── MacroSnapshot ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class MacroSnapshot:
    """
    マクロ市場状態のスナップショット。

    Attributes:
        vix               : VIX 現在値
        nikkei_5d_return  : 日経 5 日リターン（例: 0.02 = +2%）
        nikkei_60ma       : 日経 60 日移動平均
        nikkei_200ma      : 日経 200 日移動平均
        sp500_dd_30d      : S&P500 30 日ドローダウン（例: -0.15 = -15%）
        usdjpy            : USD/JPY レート
        risk_level        : "low" | "medium" | "high" | "crisis"
        signals           : MacroSignal tuple（tag 昇順ソート済み）
        computed_at       : 算出時刻（UTC）
    """
    vix: float
    nikkei_5d_return: float
    nikkei_60ma: float
    nikkei_200ma: float
    sp500_dd_30d: float
    usdjpy: float
    risk_level: str
    signals: tuple[MacroSignal, ...]
    computed_at: datetime


# ── derive_signals ────────────────────────────────────────────────────────────

def derive_signals(
    vix: float,
    nikkei_5d_return: float,
    nikkei_60ma: float,
    nikkei_200ma: float,
    sp500_dd_30d: float,
    usdjpy: float,
) -> tuple[MacroSignal, ...]:
    """
    入力値からマクロシグナルを生成して tag 昇順の tuple で返す（pure）。

    複数条件が同時成立した場合、それぞれ独立したシグナルとして返す。
    相互排他的な条件（円安/円高、VIX高/低VIX など）は同時成立しない設計。

    Returns:
        tuple[MacroSignal, ...] — tag 昇順ソート済み（空の場合は ()）
    """
    result: list[MacroSignal] = []

    # 円安 / 円高（排他的）
    if usdjpy > _USDJPY_WEAK:
        strength = "strong" if usdjpy > 160.0 else "moderate"
        result.append(MacroSignal(tag="円安", strength=strength, direction="positive"))
    elif usdjpy < _USDJPY_STRONG:
        strength = "strong" if usdjpy < 125.0 else "moderate"
        result.append(MacroSignal(tag="円高", strength=strength, direction="negative"))

    # VIX 高 / 低VIX（排他的）
    if vix > _VIX_HIGH_SIGNAL:
        strength = "strong" if vix > 40.0 else "moderate"
        result.append(MacroSignal(tag="VIX高", strength=strength, direction="negative"))
    elif vix < _VIX_LOW_SIGNAL:
        result.append(MacroSignal(tag="低VIX", strength="weak", direction="positive"))

    # デスクロス（60MA < 200MA）
    if nikkei_60ma < nikkei_200ma:
        result.append(MacroSignal(tag="デスクロス", strength="moderate", direction="negative"))

    # 短期急騰 / 短期急落（排他的）
    if nikkei_5d_return > _NIKKEI_SURGE:
        strength = "strong" if nikkei_5d_return > 0.06 else "moderate"
        result.append(MacroSignal(tag="短期急騰", strength=strength, direction="positive"))
    elif nikkei_5d_return < _NIKKEI_PLUNGE:
        strength = "strong" if nikkei_5d_return < -0.06 else "moderate"
        result.append(MacroSignal(tag="短期急落", strength=strength, direction="negative"))

    # リスクオフ（sp500_dd_30d < -0.15）
    if sp500_dd_30d < _RISK_OFF_DD:
        strength = "strong" if sp500_dd_30d < -0.25 else "moderate"
        result.append(MacroSignal(tag="リスクオフ", strength=strength, direction="negative"))
    elif sp500_dd_30d < _CORRECTION_DD:
        # 調整局面（-0.15 〜 -0.05、リスクオフと排他）
        result.append(MacroSignal(tag="調整局面", strength="weak", direction="negative"))

    # リスク警戒（VIX > 25 AND sp500_dd_30d < -0.10）
    if vix > _ALERT_VIX and sp500_dd_30d < _ALERT_DD:
        result.append(MacroSignal(tag="リスク警戒", strength="strong", direction="negative"))

    return tuple(sorted(result, key=lambda s: s.tag))


# ── derive_risk_level ─────────────────────────────────────────────────────────

def derive_risk_level(
    vix: float,
    sp500_dd_30d: float,
    nikkei_60ma: float,
    nikkei_200ma: float,
) -> str:
    """
    マクロ指標から総合リスクレベルを算出する（pure）。

    優先順位: crisis > high > medium > low

    Returns:
        "crisis" | "high" | "medium" | "low"
    """
    if vix > _CRISIS_VIX or sp500_dd_30d < _CRISIS_SP500_DD:
        return "crisis"
    if (vix > _HIGH_VIX_AND_DD_VIX and sp500_dd_30d < _HIGH_VIX_AND_DD_DD) \
            or sp500_dd_30d < _HIGH_SP500_DD:
        return "high"
    if vix > _MEDIUM_VIX or sp500_dd_30d < _MEDIUM_SP500_DD \
            or nikkei_60ma < nikkei_200ma:
        return "medium"
    return "low"


# ── build_macro_snapshot ──────────────────────────────────────────────────────

def build_macro_snapshot(
    vix: float,
    nikkei_5d_return: float,
    nikkei_60ma: float,
    nikkei_200ma: float,
    sp500_dd_30d: float,
    usdjpy: float,
    computed_at: datetime | None = None,
) -> MacroSnapshot:
    """
    マクロ入力値から MacroSnapshot を生成する（pure）。

    Args:
        vix              : VIX 現在値
        nikkei_5d_return : 日経 5 日リターン（0.02 = +2%）
        nikkei_60ma      : 日経 60 日移動平均
        nikkei_200ma     : 日経 200 日移動平均
        sp500_dd_30d     : S&P500 30 日ドローダウン（-0.15 = -15%）
        usdjpy           : USD/JPY レート
        computed_at      : 算出時刻（None → datetime.now(timezone.utc)）

    Returns:
        MacroSnapshot — 全フィールド充足済み
    """
    effective_now = computed_at if computed_at is not None else datetime.now(timezone.utc)
    signals = derive_signals(vix, nikkei_5d_return, nikkei_60ma, nikkei_200ma,
                              sp500_dd_30d, usdjpy)
    risk_level = derive_risk_level(vix, sp500_dd_30d, nikkei_60ma, nikkei_200ma)
    return MacroSnapshot(
        vix=vix,
        nikkei_5d_return=nikkei_5d_return,
        nikkei_60ma=nikkei_60ma,
        nikkei_200ma=nikkei_200ma,
        sp500_dd_30d=sp500_dd_30d,
        usdjpy=usdjpy,
        risk_level=risk_level,
        signals=signals,
        computed_at=effective_now,
    )


# ── _calc_sentiment_score ─────────────────────────────────────────────────────

def _calc_sentiment_score(signals: tuple[MacroSignal, ...]) -> float:
    """signals から sentiment score（0〜100）を算出する（内部）。"""
    score = 50.0
    for sig in signals:
        step = _SENTIMENT_STEP.get(sig.strength, 5.0)
        if sig.direction == "positive":
            score += step
        elif sig.direction == "negative":
            score -= step
    return max(0.0, min(100.0, score))


def _sentiment_label(score: float) -> str:
    """sentiment score（0〜100）からラベルを返す（内部）。"""
    if score > 60.0:
        return "bullish"
    if score < 40.0:
        return "bearish"
    return "neutral"


# ── build_market_intel_dict ───────────────────────────────────────────────────

def build_market_intel_dict(snapshot: MacroSnapshot) -> dict:
    """
    MacroSnapshot から market_intel dict を生成する（pure）。

    Returns:
        dict 形式:
        {
            "sentiment": {"score": float(0-100), "label": str},
            "keywords":  [{"tag": str, "strength": str, "direction": str}, ...],
            "active_keywords": [str, ...],   # importance_scorer に渡せる tag list
            "risk_level": str,
            "vix": float,
            "usdjpy": float,
            "nikkei_5d_return": float,
        }
    """
    sentiment_score = _calc_sentiment_score(snapshot.signals)
    keywords = [
        {"tag": s.tag, "strength": s.strength, "direction": s.direction}
        for s in snapshot.signals
    ]
    active_keywords = [s.tag for s in snapshot.signals]
    return {
        "sentiment": {
            "score": sentiment_score,
            "label": _sentiment_label(sentiment_score),
        },
        "keywords": keywords,
        "active_keywords": active_keywords,
        "risk_level": snapshot.risk_level,
        "vix": snapshot.vix,
        "usdjpy": snapshot.usdjpy,
        "nikkei_5d_return": snapshot.nikkei_5d_return,
    }
