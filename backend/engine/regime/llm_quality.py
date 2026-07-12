"""
LLM Quality Detection — Card 3-3
Layer 3.3: LLM 質的レジーム判定（Stub 実装）。
Detection-only. No trades, no orders, no side effects.

Stub 実装: 実 LLM API 未接続。is_stub=True を常に返す。
LLM 出力の品質評価・構造化・fallback 判定ロジックを提供。

Reference: docs/v13.3/07_v13.3_spec.md Section 3.3
Reference: docs/constitution/REGIME.md Section 2.3
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

# ── Constants ─────────────────────────────────────────────────────────────────

REGIME_LABELS: tuple[str, ...] = (
    "bull_calm",
    "bull_volatile",
    "bear",
    "crisis",
    "uncertain",
)

VALID_STRUCTURAL_CHANGES: frozenset[str] = frozenset({
    "financial_crisis_signs",   # 金融危機の兆候
    "geopolitical_risk",        # 地政学的変動
    "major_policy_change",      # 重大な政策変更
})

VALID_PRIMARY_SIGNALS: frozenset[str] = frozenset({
    "structural_change",   # structural_changes が空でない
    "news",                # ニュースサマリーが主因（デフォルト）
    "macro",               # macro_state が主因
})

LOW_CONFIDENCE_THRESHOLD: float = 0.50

_DEFAULT_STUB_RAW: dict = {
    "regime": "uncertain",
    "confidence": 0.0,
    "structural_changes": [],
}


# ── Input / Output dataclasses ────────────────────────────────────────────────

@dataclass
class LLMQualityInput:
    news_summary: str        # ニュースサマリーテキスト（LLM の主入力）
    vix: float               # VIX 現在値
    nikkei_5d_return: float  # 日経 5日リターン（例: 0.02 = +2%）
    usdjpy: float            # USD/JPY 現在値


@dataclass
class LLMQualityResult:
    regime: str
    confidence: float
    structural_changes: list[str]
    is_llm: bool               # 常に True（レイヤー識別用）
    is_stub: bool              # Stub 実行時 True（実 LLM 接続後は False）
    is_low_confidence: bool    # confidence < LOW_CONFIDENCE_THRESHOLD
    primary_signal: str        # "structural_change" | "news" | "macro"
    has_structural_change: bool  # Orchestrator structural_change_override 便宜用
    checked_at: datetime       # datetime 型（dict API では .isoformat() に変換）

    def __post_init__(self) -> None:
        if self.regime not in REGIME_LABELS:
            raise ValueError(f"Invalid regime: {self.regime!r}")


# ── LLMQualityDetector（Stub ラッパー） ──────────────────────────────────────

class LLMQualityDetector:
    """
    LLM Quality Detector（Stub 実装）。
    stub_response: テスト用カスタム raw dict。None のとき default stub を使用。
    """

    def __init__(self, stub_response: dict | None = None) -> None:
        self._stub_response = stub_response

    def detect(self, inp: LLMQualityInput) -> LLMQualityResult:
        raw = (
            self._stub_response
            if self._stub_response is not None
            else dict(_DEFAULT_STUB_RAW)
        )
        checked_at = datetime.now(timezone.utc)
        if not _validate_llm_response(raw):
            return _fallback_result(checked_at)
        return _parse_response(raw, checked_at)


# ── Public typed APIs ─────────────────────────────────────────────────────────

def evaluate_llm_quality(inp: LLMQualityInput) -> LLMQualityResult:
    """Typed interface: LLMQualityInput → LLMQualityResult（default stub 使用）。"""
    return LLMQualityDetector().detect(inp)


def evaluate_llm_response(raw: dict, *, is_stub: bool = True) -> LLMQualityResult:
    """
    純粋関数: raw LLM JSON dict → LLMQualityResult。
    バリデーション失敗時は fallback を返す。
    is_stub: Card 3-3 では True 固定。実 LLM 接続後（Card 3-7）は False で呼ぶ。
    """
    checked_at = datetime.now(timezone.utc)
    if not _validate_llm_response(raw):
        return _fallback_result(checked_at)
    return _parse_response(raw, checked_at, is_stub=is_stub)


# ── Public dict API ───────────────────────────────────────────────────────────

def detect_regime_llm(news_summary: str, macro_state: dict) -> dict:
    """
    Layer 3.3 LLM Quality レジーム判定（dict インターフェース）。
    checked_at は isoformat 文字列として返す。
    """
    inp = LLMQualityInput(
        news_summary=news_summary,
        vix=macro_state["vix"],
        nikkei_5d_return=macro_state["nikkei_5d_return"],
        usdjpy=macro_state["usdjpy"],
    )
    result = LLMQualityDetector().detect(inp)
    return {
        "regime": result.regime,
        "confidence": result.confidence,
        "structural_changes": result.structural_changes,
        "is_llm": result.is_llm,
        "is_stub": result.is_stub,
        "is_low_confidence": result.is_low_confidence,
        "primary_signal": result.primary_signal,
        "has_structural_change": result.has_structural_change,
        "checked_at": result.checked_at.isoformat(),
    }


# ── Internals ─────────────────────────────────────────────────────────────────

def _validate_llm_response(raw: dict) -> bool:
    """LLM raw JSON のスキーマ検証（構造のみ。structural_changes の内容は _parse でフィルタ）。"""
    if not isinstance(raw.get("regime"), str):
        return False
    if raw["regime"] not in REGIME_LABELS:
        return False
    conf = raw.get("confidence")
    if not isinstance(conf, (int, float)) or isinstance(conf, bool):
        return False
    if not (0.0 <= float(conf) <= 1.0):
        return False
    if not isinstance(raw.get("structural_changes"), list):
        return False
    return True


def _parse_structural_changes(raw_list: list) -> list[str]:
    """structural_changes の無効要素を silently filter して有効なものだけ返す。"""
    return [x for x in raw_list if isinstance(x, str) and x in VALID_STRUCTURAL_CHANGES]


def _derive_primary_signal(structural_changes: list[str]) -> str:
    """structural_changes が空でなければ 'structural_change'、そうでなければ 'news'。"""
    return "structural_change" if structural_changes else "news"


def _parse_response(
    raw: dict,
    checked_at: datetime,
    is_stub: bool = True,
) -> LLMQualityResult:
    structural_changes = _parse_structural_changes(raw["structural_changes"])
    confidence = float(raw["confidence"])
    primary_signal = _derive_primary_signal(structural_changes)
    return LLMQualityResult(
        regime=raw["regime"],
        confidence=confidence,
        structural_changes=structural_changes,
        is_llm=True,
        is_stub=is_stub,
        is_low_confidence=confidence < LOW_CONFIDENCE_THRESHOLD,
        primary_signal=primary_signal,
        has_structural_change=bool(structural_changes),
        checked_at=checked_at,
    )


def _fallback_result(checked_at: datetime) -> LLMQualityResult:
    """LLM 不到達・バリデーション失敗時の fallback。"""
    return LLMQualityResult(
        regime="uncertain",
        confidence=0.0,
        structural_changes=[],
        is_llm=True,
        is_stub=True,
        is_low_confidence=True,
        primary_signal="news",
        has_structural_change=False,
        checked_at=checked_at,
    )
