"""
splitter.py — Card 7-7
Phase 7 Multi-Strategy Engine: Portfolio Universe Splitter。

責務:
  - SplitInput       — 分割計算への入力を保持する frozen dataclass
  - SplitResult      — 分割計算結果を保持する frozen dataclass
  - PortfolioSplitter — aggregated_ideal_pf を個別株 / 投信に分割するクラス

分割仕様:
  1. aggregated_ideal_pf の各 ticker を equity_universe / fund_universe に分類
  2. equity_universe と fund_universe の両方に存在する ticker は equity 優先
  3. どちらにも属さない ticker は unclassified_tickers に記録
  4. 各サブセット内で独立に重みを再正規化（合計 ~1.0）
  5. 空サブセットは ()
  6. 全ゼロ weight のサブセットは等加重 fallback（計算 fallback、推奨ではない）
  7. 出力順: weight 降順 + ticker 昇順

この層の役割:
  個別株 PF ビルダー（jp_equity_pf_builder.py / Card 7-7）と
  投信 PF ビルダー（fund_pf_builder.py / Card 7-8）が
  それぞれの専用ドメインのみを受け取れるようにする分離層。
  投信ロジックと個別株ロジックを混在させない。

設計原則:
  - 実際の売買制限・注文制限はしない（数値化のみ）
  - 実 LLM / HTTP 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / rating / approve / reject / conditional 禁止
  - scipy / pandas / numpy 禁止（math stdlib のみ使用）
  - operation / market_intel / news / regime を直接 import しない
  - public / data writer 禁止

実装しないこと:
  - 投信ロジック（fund_pf_builder / Card 7-8 の責務）
  - 個別株ロック制約（jp_equity_pf_builder / Card 7-7 の責務）
  - 株数・金額計算
  - 差分売買
  - 注文生成
  - public / data writer

P2 記録:
  P2-7U: equity_universe と fund_universe が重複 ticker を持つ場合は equity 優先。
         データ定義側での重複排除は将来検討。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 7-7
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any


# ── safe helpers ──────────────────────────────────────────────────────────────

def _safe_float(raw: Any, fallback: float = 0.0) -> float:
    """None / str / NaN / inf → fallback。それ以外は float 変換。"""
    if raw is None:
        return fallback
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return fallback
    if math.isnan(val) or math.isinf(val):
        return fallback
    return val


# ── 内部 helper ───────────────────────────────────────────────────────────────

def _renormalize(
    items: list[tuple[str, float]],
) -> tuple[tuple[str, float], ...]:
    """
    (ticker, weight) リストを合計 1.0 に正規化し、weight降順 + ticker昇順で返す。

    - 全ゼロ weight → 等加重 fallback（計算 fallback、推奨ではない）
    - 空リスト → ()
    """
    if not items:
        return ()
    total = sum(w for _, w in items)
    if total > 0.0:
        normalized = [(t, w / total) for t, w in items]
    else:
        n = len(items)
        normalized = [(t, 1.0 / n) for t, _ in items]
    sorted_items = sorted(normalized, key=lambda x: (-x[1], x[0]))
    return tuple(sorted_items)


# ── SplitInput ────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class SplitInput:
    """
    PortfolioSplitter.split() への入力。immutable。

    aggregated_ideal_pf: StrategyAggregateResult.aggregated_ideal_pf を想定。
    equity_universe:     個別株 ticker の frozenset。__post_init__ で変換。
    fund_universe:       投信コードの frozenset。__post_init__ で変換。

    禁止フィールド:
      action / recommendation / is_buy / is_sell / verdict / decision / rating
    """

    aggregated_ideal_pf: tuple[tuple[str, float], ...]
    equity_universe:     frozenset[str]
    fund_universe:       frozenset[str]

    def __post_init__(self) -> None:
        # aggregated_ideal_pf: ensure tuple
        if not isinstance(self.aggregated_ideal_pf, tuple):
            object.__setattr__(self, "aggregated_ideal_pf", tuple(self.aggregated_ideal_pf))
        # equity_universe: ensure frozenset
        if not isinstance(self.equity_universe, frozenset):
            object.__setattr__(self, "equity_universe", frozenset(self.equity_universe))
        # fund_universe: ensure frozenset
        if not isinstance(self.fund_universe, frozenset):
            object.__setattr__(self, "fund_universe", frozenset(self.fund_universe))


# ── SplitResult ───────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class SplitResult:
    """
    分割計算結果。immutable。

    「ポートフォリオ構成の分類計算結果」であり売買命令ではない。
    equity_ideal_pf / fund_ideal_pf の各重みは
    「サブセット内での計算上の理想配分比率」であり、発注指示ではない。

    equity_ideal_pf:      個別株サブセット（再正規化済み・weight降順 + ticker昇順）
    fund_ideal_pf:        投信サブセット（再正規化済み・weight降順 + ticker昇順）
    unclassified_tickers: equity_universe にも fund_universe にも属さなかった ticker
    diagnostics:          計算上の観察事実（"observation:" prefix 統一）

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / rating / approve / reject / conditional /
      order / trade_order / rebalance_order
    """

    equity_ideal_pf:      tuple[tuple[str, float], ...]
    fund_ideal_pf:        tuple[tuple[str, float], ...]
    unclassified_tickers: tuple[str, ...]
    diagnostics:          tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.equity_ideal_pf, tuple):
            object.__setattr__(self, "equity_ideal_pf", ())
        if not isinstance(self.fund_ideal_pf, tuple):
            object.__setattr__(self, "fund_ideal_pf", ())
        if not isinstance(self.unclassified_tickers, tuple):
            object.__setattr__(self, "unclassified_tickers", tuple(self.unclassified_tickers))
        if not isinstance(self.diagnostics, tuple):
            object.__setattr__(self, "diagnostics", tuple(self.diagnostics))

    def to_dict(self) -> dict:
        """JSON serializable な dict を返す（str / float / list のみ）。"""
        return {
            "equity_ideal_pf":      dict(self.equity_ideal_pf),
            "fund_ideal_pf":        dict(self.fund_ideal_pf),
            "unclassified_tickers": list(self.unclassified_tickers),
            "diagnostics":          list(self.diagnostics),
        }


# ── PortfolioSplitter ─────────────────────────────────────────────────────────

class PortfolioSplitter:
    """
    aggregated_ideal_pf を equity / fund に分割する計算クラス。

    split() は pure computation:
      - SplitInput を受け取り SplitResult を返す
      - 売買判断・注文生成・発注制限は行わない
      - 投信ロジックと個別株ロジックを混在させない
      - 3ヶ月ロック制約は適用しない（jp_equity_pf_builder の責務）
    """

    def split(self, split_input: SplitInput) -> SplitResult:
        """
        aggregated_ideal_pf を equity / fund サブセットに分割する。

        Args:
            split_input: SplitInput

        Returns:
            SplitResult（equity_ideal_pf / fund_ideal_pf / unclassified_tickers / diagnostics）

        制約:
          - BUY / SELL / HOLD / WAIT 判定を行ってはならない
          - 実 HTTP / LLM 接続を行ってはならない
          - scipy / numpy / pandas を使用してはならない
          - 投信ロジックと個別株ロジックを混在させてはならない
        """
        diag: list[str] = []
        equity_items: list[tuple[str, float]] = []
        fund_items:   list[tuple[str, float]] = []
        unclassified: list[str] = []

        equity_universe = split_input.equity_universe
        fund_universe   = split_input.fund_universe

        for ticker, raw_weight in split_input.aggregated_ideal_pf:
            weight = max(0.0, _safe_float(raw_weight, 0.0))

            in_equity = ticker in equity_universe
            in_fund   = ticker in fund_universe

            if in_equity and in_fund:
                # 重複: equity 優先（P2-7U）
                diag.append(
                    f"observation: ticker '{ticker}' found in both equity_universe and fund_universe"
                    " — equity priority applied (P2-7U)"
                )
                equity_items.append((ticker, weight))
            elif in_equity:
                equity_items.append((ticker, weight))
            elif in_fund:
                fund_items.append((ticker, weight))
            else:
                unclassified.append(ticker)
                diag.append(
                    f"observation: ticker '{ticker}' not in equity_universe or fund_universe"
                    " — recorded as unclassified"
                )

        return SplitResult(
            equity_ideal_pf=_renormalize(equity_items),
            fund_ideal_pf=_renormalize(fund_items),
            unclassified_tickers=tuple(unclassified),
            diagnostics=tuple(diag),
        )
