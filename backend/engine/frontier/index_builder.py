"""
index_builder.py — Card 8-3
Phase 8 Frontier Engine: Frontier AI Index ビルダー。

責務:
  - IndexBuilderInput — index 構築入力（frozen dataclass）
  - FrontierIndex     — Frontier AI Index 結果（frozen dataclass）
  - IndexBuilder      — EfficientFrontierResult を FrontierIndex に変換するクラス

設計原則:
  - EfficientFrontierResult.optimal を薄くラップする
  - weights は浮動小数誤差のみ正規化（sum ≠ 0 の場合）
  - calculation_date は DI 文字列（ISO 8601 形式想定）
  - index_name は DI 可能（default = "Frontier AI Index"）
  - 必ず "calculation-only, not an order, not a recommendation" 免責 diagnostic を含める
  - 全 diagnostics は "observation: " プレフィックス

禁止事項:
  - BUY/SELL/HOLD/WAIT
  - action/recommendation/verdict/decision/approve/reject
  - 株数・金額・注文 生成
  - 実 HTTP / API / LLM 接続
  - public/data writer

このクラスは数値計算観察値の表現層であり、注文・推奨・PF 変更を行わない。

P2 記録:
  P2-8I: FrontierStrategy への接続（FrontierIndex を消費する側）は Card 8-4 以降。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 8-3
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from engine.frontier.efficient_frontier import EfficientFrontierResult


# ── データクラス ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class IndexBuilderInput:
    """index 構築入力。frozen=True で不変。"""
    frontier_result: EfficientFrontierResult
    index_name: str = "Frontier AI Index"
    calculation_date: str = ""
    context: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.context, dict):
            object.__setattr__(self, "context", {})
        if not isinstance(self.index_name, str) or not self.index_name:
            object.__setattr__(self, "index_name", "Frontier AI Index")
        if not isinstance(self.calculation_date, str):
            object.__setattr__(self, "calculation_date", "")


@dataclass(frozen=True)
class FrontierIndex:
    """Frontier AI Index 結果。frozen=True で不変。"""
    index_name: str
    tickers: tuple[str, ...]
    weights: tuple[float, ...]
    expected_return: float
    expected_vol: float
    sharpe_ratio: float
    regime_used: str
    calculation_date: str
    diagnostics: tuple[str, ...]

    def get_weight(self, ticker: str) -> float:
        for t, w in zip(self.tickers, self.weights):
            if t == ticker:
                return float(w)
        return 0.0

    def as_weight_dict(self) -> dict[str, float]:
        return {t: float(w) for t, w in zip(self.tickers, self.weights)}

    def to_dict(self) -> dict:
        return {
            "index_name":       self.index_name,
            "tickers":          list(self.tickers),
            "weights":          list(self.weights),
            "expected_return":  self.expected_return,
            "expected_vol":     self.expected_vol,
            "sharpe_ratio":     self.sharpe_ratio,
            "regime_used":      self.regime_used,
            "calculation_date": self.calculation_date,
            "diagnostics":      list(self.diagnostics),
        }


# ── ビルダー ──────────────────────────────────────────────────────────────────

class IndexBuilder:
    """
    EfficientFrontierResult から FrontierIndex を構築する。

    薄いラッパー: 最適化内部を知らない呼び出し元（Card 8-4 以降の
    FrontierStrategy 接続層 など）に stable interface を提供する。
    """

    NORMALIZATION_EPS: float = 1e-9

    def build(self, inp: IndexBuilderInput) -> FrontierIndex:
        diag: list[str] = []
        opt = inp.frontier_result.optimal

        # ── ウェイト正規化（浮動小数誤差のみ） ────────────────────────────────
        weights = [float(w) for w in opt.weights]
        weights = [max(0.0, w) for w in weights]  # 数値誤差で僅かに負になる可能性を clip
        total = sum(weights)
        if total > self.NORMALIZATION_EPS:
            if abs(total - 1.0) > self.NORMALIZATION_EPS:
                diag.append(
                    f"observation: weights sum={total:.6f} normalized to 1.0 "
                    "(floating-point drift correction)"
                )
                weights = [w / total for w in weights]
        else:
            diag.append("observation: weights sum is ~0; normalization skipped")

        # ── 標準 disclaimer diagnostic ────────────────────────────────────────
        diag.append(
            "observation: index weights are calculation-only estimates; "
            "not an order, not a recommendation"
        )

        # ── solver 状態の伝播 ─────────────────────────────────────────────────
        if not opt.solver_converged:
            diag.append(
                f"observation: underlying optimizer did not converge "
                f"(solver_message={opt.solver_message!r}); index reflects fallback weights"
            )

        return FrontierIndex(
            index_name=inp.index_name,
            tickers=opt.tickers,
            weights=tuple(weights),
            expected_return=float(opt.expected_return),
            expected_vol=float(opt.expected_vol),
            sharpe_ratio=float(opt.sharpe_ratio),
            regime_used=inp.frontier_result.regime_used,
            calculation_date=inp.calculation_date,
            diagnostics=tuple(diag),
        )
