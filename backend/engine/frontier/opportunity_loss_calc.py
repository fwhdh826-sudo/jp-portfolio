"""
opportunity_loss_calc.py — Card B
Phase 8 Frontier Engine: Opportunity Loss 観察値計算。

責務:
  - OpportunityLossInput      — 計算入力（frozen dataclass、Flat DI）
  - OpportunityLossResult     — 結果コンテナ（frozen dataclass）
  - OpportunityLossCalculator — calculate() で OpportunityLossResult を返すクラス

機会損失 (opportunity cost) の観察値:
  current_pf（現在保有）と constrained_ideal_pf（3ヶ月ロック / sector cap 等
  適用後の理想配分）の乖離を pure computation で観察する。

  さらに ideal_pf（無制約）と constrained_ideal_pf の差から、制約による
  期待 return 低下も観察する。

  本モジュールは「買え／売え／リバランス すべき」とは一切言わない。
  全 diagnostics に `not an order, not a recommendation` の趣旨を含める。
  return gaps は「失った利益」ではなく「比較値としての推定差」である。

計算アルゴリズム:
  1. current / ideal / constrained 各 PF の weights を safe float + 0.0 以上 clamp
  2. union_tickers = sorted(current ∪ ideal ∪ constrained)
  3. weight_drift[t] = current[t] - constrained[t]（欠損 → 0.0）
  4. total_drift_l1 = Σ |drift|
  5. total_drift_l2 = √Σ drift²
  6. expected_return_by_ticker から 3 PF の期待 return を計算
     - constraint_return_gap = return(ideal_pf) - return(constrained_ideal_pf)
     - drift_return_gap      = return(constrained_ideal_pf) - return(current_pf)
     - estimated_opportunity_return_gap = drift_return_gap（符号保持）
  7. expected_return_by_ticker が空 → return-based gap は全て 0.0 + diagnostic
  8. 出力 weight_drift_per_ticker は abs(drift) 降順 + ticker 昇順
  9. diagnostics は必ず以下 3 つの趣旨を含める
     - "observation: opportunity metrics are calculation-only estimates"
     - "observation: not an order, not a recommendation"
     - "observation: return gaps are comparative estimates, not realized losses"

設計原則:
  - stdlib-only（math のみ）
  - pandas / numpy / scipy 禁止
  - 実 HTTP / LLM 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / approve / reject / conditional / rating 禁止
  - rebalance_order / buy_amount / sell_amount / shares / quantity 禁止
  - operation / market_intel / news / regime / aggregator 等の Result 型を
    直接 import しない（Flat DI、P1-B2）
  - context / 各 dict 入力を mutation しない
  - public/data writer 禁止

P1 記録:
  P1-B1: 配置は backend/engine/frontier/。
  P1-B2: Flat DI。StrategyAggregateResult / JpEquityPfResult 等を import しない。
  P1-B3: opportunity_loss_calc は dict 差分のみ。Aggregator 等のインスタンス保持なし。
  P1-B6: 税効果は含めない（Operation 層責務）。
  P1-B9: to_dict() は JSON serializable。

P2 記録（後続 Card 候補）:
  P2-B3: Path-dependent opportunity_loss（Phase 11 rebalance 連携）。
  P2-B4: 税効果を含む opportunity cost（Operation 層）。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card B（元 Card 8-4）
           handover.md "Phase 8 Cards 8-1〜8-4 Mini Integration Review" 以降
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


def _normalize_weight_dict(raw: Any) -> dict:
    """
    weight dict を safe float + 0.0 以上 clamp して新規 dict として返す。

    raw が dict 以外 → {}（呼び出し元 dict は mutation しない）。
    """
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    for k, v in raw.items():
        ticker = str(k)
        if ticker == "":
            continue
        weight = max(0.0, _safe_float(v, 0.0))
        out[ticker] = weight
    return out


def _normalize_return_dict(raw: Any) -> dict:
    """
    expected_return_by_ticker を safe float（clamp なし）して新規 dict として返す。
    """
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    for k, v in raw.items():
        ticker = str(k)
        if ticker == "":
            continue
        out[ticker] = _safe_float(v, 0.0)
    return out


def _portfolio_expected_return(
    weights: dict,
    expected_return_by_ticker: dict,
) -> float:
    """
    Σ expected_return_by_ticker[t] * weights[t] を計算する。
    weights / expected_return_by_ticker のいずれかが空 → 0.0。
    欠損 ticker は 0.0 寄与。
    """
    if not weights or not expected_return_by_ticker:
        return 0.0
    total = 0.0
    for ticker, weight in weights.items():
        er = expected_return_by_ticker.get(ticker, 0.0)
        total += er * weight
    return total


# ── 定数 ─────────────────────────────────────────────────────────────────────


_FALLBACK_REGIME: str = "uncertain"

# 必須 disclaimer 文言（OpportunityLossResult.diagnostics に必ず含める）
_DISCLAIMER_CALCULATION_ONLY: str = (
    "observation: opportunity metrics are calculation-only estimates"
)
_DISCLAIMER_NOT_ORDER: str = (
    "observation: not an order, not a recommendation"
)
_DISCLAIMER_COMPARATIVE_GAPS: str = (
    "observation: return gaps are comparative estimates, not realized losses"
)


# ── OpportunityLossInput ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class OpportunityLossInput:
    """
    OpportunityLossCalculator.calculate() への入力。immutable。

    Flat DI 設計（P1-B2）:
      Aggregator / FrontierStrategy / JpEquityPfBuilder / UnifiedViewBuilder 等の
      Result 型は直接 import しない。Operation 層が各 Result から数値を解体して
      dict[str, float] / float / str を DI する。

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / approve / reject / conditional / rating /
      rebalance_order / buy_amount / sell_amount / shares / quantity
    """

    current_pf:                dict
    ideal_pf:                  dict
    constrained_ideal_pf:      dict
    expected_return_by_ticker: dict
    expected_vol:              float = 0.0
    sharpe_ratio:              float = 0.0
    regime:                    str   = _FALLBACK_REGIME
    context:                   dict  = field(default_factory=dict)

    def __post_init__(self) -> None:
        # dict fields: 非 dict → {} fallback（mutation しない）
        if not isinstance(self.current_pf, dict):
            object.__setattr__(self, "current_pf", {})
        if not isinstance(self.ideal_pf, dict):
            object.__setattr__(self, "ideal_pf", {})
        if not isinstance(self.constrained_ideal_pf, dict):
            object.__setattr__(self, "constrained_ideal_pf", {})
        if not isinstance(self.expected_return_by_ticker, dict):
            object.__setattr__(self, "expected_return_by_ticker", {})
        if not isinstance(self.context, dict):
            object.__setattr__(self, "context", {})

        # float fields: safe + clamp
        object.__setattr__(self, "expected_vol",
                           max(0.0, _safe_float(self.expected_vol, 0.0)))
        object.__setattr__(self, "sharpe_ratio", _safe_float(self.sharpe_ratio, 0.0))

        # regime: str / 非空
        regime = self.regime if isinstance(self.regime, str) and self.regime else _FALLBACK_REGIME
        object.__setattr__(self, "regime", regime)


# ── OpportunityLossResult ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class OpportunityLossResult:
    """
    OpportunityLossCalculator.calculate() の結果。immutable。

    weight_drift_per_ticker:
      tuple[tuple[str, float], ...]
      各エントリは (ticker, current_pf[t] - constrained_ideal_pf[t])。
      abs(drift) 降順 + ticker 昇順でソート。

    total_drift_l1: Σ |drift| ≥ 0
    total_drift_l2: √Σ drift² ≥ 0

    constraint_return_gap:
      Σ ER[t] * ideal_pf[t]  -  Σ ER[t] * constrained_ideal_pf[t]
      無制約 ideal と制約後 ideal の期待 return 差。
      正値: 制約により期待 return が下がっている観察値。
      ER（expected_return_by_ticker）が空なら 0.0。

    drift_return_gap:
      Σ ER[t] * constrained_ideal_pf[t]  -  Σ ER[t] * current_pf[t]
      制約後 ideal と現在 PF の期待 return 差。
      正値: 現在 PF が制約後 ideal よりも期待 return が低い観察値。
      ER が空なら 0.0。

    estimated_opportunity_return_gap:
      drift_return_gap の符号保持コピー。
      符号を保持する理由: 負値（現在 PF の方が ideal より期待 return 高い）も
      観察値として意味があるため。max(0, ...) クランプ等は行わない。

    regime_used: 入力 regime（"uncertain" fallback 含む）

    diagnostics: "observation: " プレフィックスの観察文字列 tuple。
                 必ず以下 3 つの趣旨を含む:
                 - calculation-only estimates
                 - not an order, not a recommendation
                 - return gaps are comparative estimates, not realized losses

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / approve / reject / conditional / rating /
      rebalance_order / buy_amount / sell_amount / shares / quantity /
      final_verdict / order / amount / entry_price / stop_loss / take_profit
    """

    weight_drift_per_ticker:          tuple
    total_drift_l1:                   float
    total_drift_l2:                   float
    constraint_return_gap:            float
    drift_return_gap:                 float
    estimated_opportunity_return_gap: float
    regime_used:                      str
    diagnostics:                      tuple = ()

    def __post_init__(self) -> None:
        # weight_drift_per_ticker: tuple of (str, float)
        if not isinstance(self.weight_drift_per_ticker, tuple):
            object.__setattr__(
                self, "weight_drift_per_ticker",
                tuple(self.weight_drift_per_ticker),
            )

        # L1 / L2 は 0.0 以上 clamp
        object.__setattr__(self, "total_drift_l1",
                           max(0.0, _safe_float(self.total_drift_l1, 0.0)))
        object.__setattr__(self, "total_drift_l2",
                           max(0.0, _safe_float(self.total_drift_l2, 0.0)))

        # return gaps: safe float、符号保持（clamp しない）
        object.__setattr__(self, "constraint_return_gap",
                           _safe_float(self.constraint_return_gap, 0.0))
        object.__setattr__(self, "drift_return_gap",
                           _safe_float(self.drift_return_gap, 0.0))
        object.__setattr__(self, "estimated_opportunity_return_gap",
                           _safe_float(self.estimated_opportunity_return_gap, 0.0))

        # regime_used: str / 非空
        regime = (
            self.regime_used
            if isinstance(self.regime_used, str) and self.regime_used
            else _FALLBACK_REGIME
        )
        object.__setattr__(self, "regime_used", regime)

        # diagnostics: tuple
        if not isinstance(self.diagnostics, tuple):
            object.__setattr__(self, "diagnostics", tuple(self.diagnostics))

    def to_dict(self) -> dict:
        """JSON serializable な dict（str / float / list / dict のみ）。"""
        return {
            "weight_drift_per_ticker": [
                [ticker, float(drift)]
                for ticker, drift in self.weight_drift_per_ticker
            ],
            "total_drift_l1":                   self.total_drift_l1,
            "total_drift_l2":                   self.total_drift_l2,
            "constraint_return_gap":            self.constraint_return_gap,
            "drift_return_gap":                 self.drift_return_gap,
            "estimated_opportunity_return_gap": self.estimated_opportunity_return_gap,
            "regime_used":                      self.regime_used,
            "diagnostics":                      list(self.diagnostics),
        }


# ── OpportunityLossCalculator ─────────────────────────────────────────────────


class OpportunityLossCalculator:
    """
    OpportunityLossInput を受け取り OpportunityLossResult を返す pure computation。

    売買判断・注文生成・発注制限は一切行わない。
    入力 dict / context は mutation しない。
    """

    def calculate(self, input: OpportunityLossInput) -> OpportunityLossResult:
        """
        opportunity loss 観察値を計算する。

        Args:
            input: OpportunityLossInput（current_pf / ideal_pf / constrained_ideal_pf /
                   expected_return_by_ticker / regime 等を DI）
        Returns:
            OpportunityLossResult
        """
        diagnostics: list = []

        # ── Step 1: 各 PF の weights を safe float + 0.0 以上 clamp（新規 dict）─
        current = _normalize_weight_dict(input.current_pf)
        ideal = _normalize_weight_dict(input.ideal_pf)
        constrained = _normalize_weight_dict(input.constrained_ideal_pf)

        # 空 PF の diagnostic（観察情報）
        if not current:
            diagnostics.append("observation: current_pf is empty")
        if not ideal:
            diagnostics.append("observation: ideal_pf is empty")
        if not constrained:
            diagnostics.append("observation: constrained_ideal_pf is empty")

        # ── Step 2: union tickers ────────────────────────────────────────────
        union_tickers = sorted(set(current) | set(ideal) | set(constrained))

        # ── Step 3: weight_drift = current - constrained ─────────────────────
        drift_list: list = []
        for ticker in union_tickers:
            drift = current.get(ticker, 0.0) - constrained.get(ticker, 0.0)
            drift_list.append((ticker, drift))

        # ── Step 4: L1 / L2 ──────────────────────────────────────────────────
        l1 = sum(abs(d) for _, d in drift_list)
        l2 = math.sqrt(sum(d * d for _, d in drift_list))

        # ── Step 5: 出力ソート（abs(drift) 降順 + ticker 昇順）───────────────
        drift_sorted = sorted(drift_list, key=lambda x: (-abs(x[1]), x[0]))

        # ── Step 6: portfolio expected returns（ER 由来）─────────────────────
        er_map = _normalize_return_dict(input.expected_return_by_ticker)

        if not er_map:
            constraint_gap = 0.0
            drift_gap = 0.0
            opp_gap = 0.0
            diagnostics.append(
                "observation: expected_return_by_ticker is empty — "
                "return gaps set to 0.0"
            )
        else:
            return_ideal = _portfolio_expected_return(ideal, er_map)
            return_constrained = _portfolio_expected_return(constrained, er_map)
            return_current = _portfolio_expected_return(current, er_map)

            constraint_gap = return_ideal - return_constrained
            drift_gap = return_constrained - return_current
            opp_gap = drift_gap  # 符号保持

            # missing ticker observation（任意）
            er_tickers = set(er_map.keys())
            pf_tickers = set(union_tickers)
            missing_in_er = pf_tickers - er_tickers
            if missing_in_er:
                diagnostics.append(
                    f"observation: {len(missing_in_er)} ticker(s) missing from "
                    f"expected_return_by_ticker — contribution counted as 0.0"
                )

        # ── Step 7: regime fallback diagnostic（未知 regime も値はそのまま保持）─
        regime_used = input.regime
        # Input.__post_init__ で空文字 → "uncertain" 済み

        # ── Step 8: 必須 disclaimer ──────────────────────────────────────────
        diagnostics.append(_DISCLAIMER_CALCULATION_ONLY)
        diagnostics.append(_DISCLAIMER_NOT_ORDER)
        diagnostics.append(_DISCLAIMER_COMPARATIVE_GAPS)

        return OpportunityLossResult(
            weight_drift_per_ticker=tuple(drift_sorted),
            total_drift_l1=l1,
            total_drift_l2=l2,
            constraint_return_gap=constraint_gap,
            drift_return_gap=drift_gap,
            estimated_opportunity_return_gap=opp_gap,
            regime_used=regime_used,
            diagnostics=tuple(diagnostics),
        )
