"""
unified_view.py — Card 7-8
Phase 7 Multi-Strategy Engine: Unified Portfolio View（6口座統合）。

責務:
  - AccountHoldingInfo  — 1 口座の 1 保有情報を保持する frozen dataclass
  - AccountSummary      — 1 口座の集計結果を保持する frozen dataclass
  - UnifiedViewInput    — 計算への入力を保持する frozen dataclass
  - UnifiedViewResult   — 集計結果を保持する frozen dataclass
  - UnifiedViewBuilder  — 6 口座の現在保有を集計して UnifiedViewResult を返すクラス

6 口座統合仕様:
  - account_id は DI（ハードコードなし）。Operation 層が構築して DI する
  - asset_class は DI（"domestic_equity" / "domestic_fund" / "overseas_fund" / "cash"）
    - 分類ロジックは unified_view.py 内に持たない（P2-7V）
    - 未知の asset_class は "unclassified" として集計し diagnostic に記録（クラスごとに 1 回）
  - 同一 account_id + ticker_or_code の重複は合算（複数ロット保有を想定）（P2-7X）

集計仕様:
  - account_summaries: 口座ごとの total_current_weight + asset_class 内訳
                       (account_id 昇順で返す)
  - asset_class_weights: 全口座横断のアセットクラス別合計（weight 降順 + class 昇順）
  - total_equity_weight: domestic_equity の合計（account_holdings から集計）
  - total_fund_weight:   domestic_fund + overseas_fund の合計（account_holdings から集計）
  - total_cash_weight:   cash_weight（DI 値 pass-through）

Ideal PF の扱い:
  - equity_constrained_pf / fund_pf は pass-through のみ
  - combined_ideal_pf は生成しない（P1-7Y）
    → splitter.py が equity / fund 各サブセットを独立に 1.0 再正規化するため
      equity/fund 比率情報が失われており、unified_view 層では再構築不可。
      Operation 層が aggregated_ideal_pf から生成する責務。
  - 差分・delta・rebalance_order は生成しない

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
  - asset_class 分類ロジック（Operation 層の責務）
  - combined_ideal_pf（equity + fund の統合 PF）
  - 差分計算 / delta / rebalance_order
  - 発注・注文生成
  - public / data writer
  - fund_short_term_risk.py との接続

P2 記録:
  P1-7Y: combined_ideal_pf は生成しない。equity/fund 比率情報が splitter で失われているため。
  P2-7V: asset_class 分類は DI。未知の値は "unclassified" として集計し diagnostic 記録。
  P2-7X: 同一 account_id + ticker_or_code の重複は合算（複数ロット保有想定）。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 7-8
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any


# ── 定数 ─────────────────────────────────────────────────────────────────────

KNOWN_ASSET_CLASSES: frozenset[str] = frozenset({
    "domestic_equity",
    "domestic_fund",
    "overseas_fund",
    "cash",
})

FUND_ASSET_CLASSES: frozenset[str] = frozenset({
    "domestic_fund",
    "overseas_fund",
})


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


# ── AccountHoldingInfo ────────────────────────────────────────────────────────

@dataclass(frozen=True)
class AccountHoldingInfo:
    """
    1 口座の 1 保有情報。immutable。

    account_id:      口座識別子（DI。ハードコードなし。例: "sbi_tokutei"）
    ticker_or_code:  個別株 ticker または投信コード
    current_weight:  総資産に対する保有比率（観察値）。safe_float + 0.0以上 clamp。
    asset_class:     "domestic_equity" / "domestic_fund" / "overseas_fund" / "cash"
                     分類は DI（unified_view.py 内では分類しない）— P2-7V

    禁止フィールド:
      action / is_buy / is_sell / is_hold / verdict / decision / order
    """

    account_id:     str
    ticker_or_code: str
    current_weight: float
    asset_class:    str

    def __post_init__(self) -> None:
        cw = max(0.0, _safe_float(self.current_weight, 0.0))
        object.__setattr__(self, "current_weight", cw)


# ── AccountSummary ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class AccountSummary:
    """
    1 口座の集計結果。immutable。

    account_id:            口座識別子
    total_current_weight:  この口座の保有合計（全口座横断の総資産に対する比率・観察値）
    asset_class_breakdown: (asset_class, weight) の tuple（weight 降順 + class 昇順）

    禁止フィールド:
      action / recommendation / verdict / order / delta / diff
    """

    account_id:            str
    total_current_weight:  float
    asset_class_breakdown: tuple[tuple[str, float], ...]


# ── UnifiedViewInput ──────────────────────────────────────────────────────────

@dataclass(frozen=True)
class UnifiedViewInput:
    """
    UnifiedViewBuilder.build() への入力。immutable。

    equity_constrained_pf: JpEquityPfBuilder.EquityPfResult.constrained_ideal_pf を想定。
                           個別株の理想配分比率（calculation-only）。pass-through。
    fund_pf:               FundPfBuilder.FundPfResult.fund_pf を想定。
                           投信の理想配分比率（calculation-only）。pass-through。
    account_holdings:      tuple[AccountHoldingInfo, ...] — 6 口座の現在保有（観察値）。
    cash_weight:           現金比率（観察値・DI）。safe_float + 0.0以上 clamp。
    regime:                市況レジーム文字列（コンテキスト）。
    context:               追加情報（任意）。

    禁止フィールド:
      combined_ideal_pf / action / recommendation / verdict / decision / delta / diff
    """

    equity_constrained_pf: tuple[tuple[str, float], ...]
    fund_pf:               tuple[tuple[str, float], ...]
    account_holdings:      tuple[AccountHoldingInfo, ...]
    cash_weight:           float = 0.0
    regime:                str   = "uncertain"
    context:               dict  = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.equity_constrained_pf, tuple):
            object.__setattr__(
                self, "equity_constrained_pf", tuple(self.equity_constrained_pf)
            )
        if not isinstance(self.fund_pf, tuple):
            object.__setattr__(self, "fund_pf", tuple(self.fund_pf))
        if not isinstance(self.account_holdings, tuple):
            object.__setattr__(self, "account_holdings", tuple(self.account_holdings))
        cw = max(0.0, _safe_float(self.cash_weight, 0.0))
        object.__setattr__(self, "cash_weight", cw)
        if not isinstance(self.context, dict):
            object.__setattr__(self, "context", {})


# ── UnifiedViewResult ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class UnifiedViewResult:
    """
    6 口座統合ビュー計算結果。immutable。

    「口座横断の保有集計観察値」と「ideal PF pass-through」であり、
    売買命令・注文生成ではない。
    combined_ideal_pf（equity + fund の統合 PF）は生成しない（P1-7Y）。
    差分・delta・rebalance_order は持たない。

    equity_constrained_pf: 個別株 ideal PF（pass-through / calculation-only）
    fund_pf:               投信 ideal PF（pass-through / calculation-only）
    account_summaries:     口座ごとの集計結果（account_id 昇順）
    asset_class_weights:   全口座横断のアセットクラス別保有合計（weight 降順 + class 昇順）
    total_equity_weight:   domestic_equity 合計（account_holdings から集計・観察値）
    total_fund_weight:     domestic_fund + overseas_fund 合計（account_holdings から集計・観察値）
    total_cash_weight:     現金比率（cash_weight DI pass-through・観察値）
    diagnostics:           計算上の観察事実（"observation:" prefix 統一）

    禁止フィールド:
      combined_ideal_pf / action / recommendation / is_buy / is_sell / is_hold /
      is_recommended / verdict / decision / rating / approve / reject / conditional /
      delta / diff / rebalance_order / trade_order / buy_amount / sell_amount
    """

    equity_constrained_pf: tuple[tuple[str, float], ...]
    fund_pf:               tuple[tuple[str, float], ...]
    account_summaries:     tuple[AccountSummary, ...]
    asset_class_weights:   tuple[tuple[str, float], ...]
    total_equity_weight:   float
    total_fund_weight:     float
    total_cash_weight:     float
    diagnostics:           tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.equity_constrained_pf, tuple):
            object.__setattr__(self, "equity_constrained_pf", ())
        if not isinstance(self.fund_pf, tuple):
            object.__setattr__(self, "fund_pf", ())
        if not isinstance(self.account_summaries, tuple):
            object.__setattr__(self, "account_summaries", ())
        if not isinstance(self.asset_class_weights, tuple):
            object.__setattr__(self, "asset_class_weights", ())
        if not isinstance(self.diagnostics, tuple):
            object.__setattr__(self, "diagnostics", tuple(self.diagnostics))

    def to_dict(self) -> dict:
        """JSON serializable な dict を返す（str / float / list / dict のみ）。"""
        return {
            "equity_constrained_pf": dict(self.equity_constrained_pf),
            "fund_pf":               dict(self.fund_pf),
            "account_summaries": [
                {
                    "account_id":           s.account_id,
                    "total_current_weight": s.total_current_weight,
                    "asset_class_breakdown": dict(s.asset_class_breakdown),
                }
                for s in self.account_summaries
            ],
            "asset_class_weights": dict(self.asset_class_weights),
            "total_equity_weight": self.total_equity_weight,
            "total_fund_weight":   self.total_fund_weight,
            "total_cash_weight":   self.total_cash_weight,
            "diagnostics":         list(self.diagnostics),
        }


# ── UnifiedViewBuilder ────────────────────────────────────────────────────────

class UnifiedViewBuilder:
    """
    6 口座の現在保有を集計して UnifiedViewResult を返すクラス。

    build() は pure computation:
      - UnifiedViewInput を受け取り UnifiedViewResult を返す
      - 売買判断・注文生成・発注制限は行わない
      - combined_ideal_pf は生成しない（P1-7Y）
      - 差分計算・delta・rebalance_order は生成しない
      - asset_class 分類は実施しない（DI 値を集計するのみ）
      - account_holdings を mutation してはならない
    """

    def build(self, view_input: UnifiedViewInput) -> UnifiedViewResult:
        """
        6 口座の現在保有を集計して UnifiedViewResult を返す。

        計算結果は「口座横断の保有集計観察値」と「ideal PF pass-through」であり、
        売買命令・注文生成ではない。
        (calculation-only / observation / not an order / not a recommendation)

        Args:
            view_input: UnifiedViewInput

        Returns:
            UnifiedViewResult

        制約:
          - account_holdings / context を mutation してはならない
          - BUY / SELL / HOLD / WAIT 判定を行ってはならない
          - 実 HTTP / LLM 接続を行ってはならない
          - scipy / numpy / pandas を使用してはならない
          - combined_ideal_pf を生成してはならない
          - 差分計算・rebalance_order を生成してはならない
        """
        diag: list[str] = []

        # ── Step 1: 口座 × ticker_or_code で保有を集計（重複は合算）──────
        # { account_id: { ticker_or_code: {"weight": float, "asset_class": str} } }
        account_map: dict[str, dict[str, dict]] = {}
        warned_classes: set[str] = set()

        for holding in view_input.account_holdings:
            acct = holding.account_id
            code = holding.ticker_or_code
            wt   = max(0.0, _safe_float(holding.current_weight, 0.0))
            ac   = holding.asset_class

            # 未知の asset_class は "unclassified" として集計（P2-7V）
            if ac not in KNOWN_ASSET_CLASSES:
                if ac != "unclassified" and ac not in warned_classes:
                    warned_classes.add(ac)
                    diag.append(
                        f"observation: unknown asset_class '{ac}' encountered"
                        " — treated as 'unclassified'"
                    )
                ac = "unclassified"

            if acct not in account_map:
                account_map[acct] = {}

            if code in account_map[acct]:
                # 同一 account_id + ticker_or_code: 合算（P2-7X）
                account_map[acct][code]["weight"] += wt
            else:
                account_map[acct][code] = {"weight": wt, "asset_class": ac}

        # ── Step 2: account_summaries を構築（account_id 昇順）──────────
        account_summaries: list[AccountSummary] = []

        for acct_id in sorted(account_map.keys()):
            holdings = account_map[acct_id]
            total_w  = sum(v["weight"] for v in holdings.values())

            # asset_class 内訳（weight 降順 + class 昇順）
            ac_accum: dict[str, float] = {}
            for v in holdings.values():
                ac_key = v["asset_class"]
                ac_accum[ac_key] = ac_accum.get(ac_key, 0.0) + v["weight"]

            ac_breakdown = tuple(
                sorted(ac_accum.items(), key=lambda x: (-x[1], x[0]))
            )

            account_summaries.append(AccountSummary(
                account_id=acct_id,
                total_current_weight=total_w,
                asset_class_breakdown=ac_breakdown,
            ))

        # ── Step 3: asset_class_weights を全口座横断で集計 ───────────────
        global_ac: dict[str, float] = {}
        for holdings in account_map.values():
            for v in holdings.values():
                ac_key = v["asset_class"]
                global_ac[ac_key] = global_ac.get(ac_key, 0.0) + v["weight"]

        asset_class_weights = tuple(
            sorted(global_ac.items(), key=lambda x: (-x[1], x[0]))
        )

        # ── Step 4: total_*_weight を計算 ────────────────────────────────
        total_equity_weight = global_ac.get("domestic_equity", 0.0)
        total_fund_weight   = sum(
            global_ac.get(ac, 0.0) for ac in FUND_ASSET_CLASSES
        )
        total_cash_weight   = max(0.0, _safe_float(view_input.cash_weight, 0.0))

        return UnifiedViewResult(
            equity_constrained_pf=view_input.equity_constrained_pf,
            fund_pf=view_input.fund_pf,
            account_summaries=tuple(account_summaries),
            asset_class_weights=asset_class_weights,
            total_equity_weight=total_equity_weight,
            total_fund_weight=total_fund_weight,
            total_cash_weight=total_cash_weight,
            diagnostics=tuple(diag),
        )
