"""
fund_pf_builder.py — Card 7-8
Phase 7 Multi-Strategy Engine: Japanese Fund (投信) Portfolio Builder。

責務:
  - FundHoldingInfo        — 投信保有情報を保持する frozen dataclass（入力）
  - FundHoldingObservation — 各保有投信の観察値を保持する frozen dataclass
  - FundPfInput            — 計算への入力を保持する frozen dataclass
  - FundPfResult           — 計算結果を保持する frozen dataclass
  - FundPfBuilder          — 投信 PF 計算値 fund_pf を生成するクラス

ロック制約:
  投信は 3ヶ月ロック制約の対象外。
  jp_equity_pf_builder.py（LOCK_DAYS=91）とは異なる設計。
  fund_pf は fund_ideal_pf の入力正規化結果であり、ロック床制約は適用しない。
  FundHoldingObservation は is_lock_period_active / lock_floor_weight を持たない。

fund_pf 計算アルゴリズム:
  1. fund_ideal_pf を (fund_code, weight) リスト化（negative clamp）
  2. current_holdings から FundHoldingObservation を作成
     （重複 fund_code は最初の occurrence を使用・diagnostic 記録）
  3. 入力品質観察（current_weight sum > 1.0 → diagnostic）
  4. fund_ideal_pf を再正規化 → fund_pf（weight 降順 + code 昇順）

個別株との分離:
  この計算層は投信 PF 専用。
  individual equity ロジック（jp_equity_pf_builder.py）と混在しない。
  分離は splitter.py（同 Card 7-7）が担保する。

設計原則:
  - 実際の売買制限・注文制限はしない（数値化のみ）
  - 実 LLM / HTTP 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / rating / approve / reject / conditional 禁止
  - scipy / pandas / numpy 禁止（math stdlib のみ使用）
  - operation / market_intel / news / regime を直接 import しない
  - public / data writer 禁止
  - fund_short_term_risk.py との接続禁止（別ドメイン・Operation 層の責務）

実装しないこと:
  - 3ヶ月ロック制約（個別株の責務）
  - fund_short_term_risk.py との接続（Operation 層の責務）
  - 売買命令・注文生成・差分売買
  - 株数・口数・金額計算
  - public / data writer

P2 記録:
  P2-7W: fund_pf はロック制約なしのため fund_ideal_pf ≈ fund_pf。
         FundPfBuilder の責務は重複除去・入力正規化・観察記録・JP equity との対称 API 維持。
  P2-7S: days_since_purchase は整数 DI。purchase_date からの計算は Operation 層の責務。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 7-8
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


def _safe_int(raw: Any, fallback: int = 0) -> int:
    """None / str / NaN / inf → fallback。それ以外は int 変換（小数点切り捨て）。"""
    if raw is None:
        return fallback
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return fallback
    if math.isnan(val) or math.isinf(val):
        return fallback
    return int(val)


# ── 内部 helper ───────────────────────────────────────────────────────────────

def _renormalize(
    items: list[tuple[str, float]],
) -> tuple[tuple[str, float], ...]:
    """
    (fund_code, weight) リストを合計 1.0 に正規化し、weight 降順 + code 昇順で返す。

    - 全ゼロ weight → 等加重 fallback（計算 fallback、推奨ではない）
    - 空リスト → ()
    """
    if not items:
        return ()
    total = sum(w for _, w in items)
    if total > 0.0:
        normalized = [(c, w / total) for c, w in items]
    else:
        n = len(items)
        normalized = [(c, 1.0 / n) for c, _ in items]
    return tuple(sorted(normalized, key=lambda x: (-x[1], x[0])))


# ── FundHoldingInfo ───────────────────────────────────────────────────────────

@dataclass(frozen=True)
class FundHoldingInfo:
    """
    投信保有情報。immutable。

    fund_code:           投信コード（例: "253710"）
    current_weight:      現在の保有比率（観察値）。safe float + 0.0以上 clamp。
    days_since_purchase: 購入からの経過日数（観察値）。safe int + 0以上 clamp。
                         ロック計算には使用しない（投信はロック制約なし）。
                         purchase_date からの計算は Operation 層の責務（P2-7S）。

    禁止フィールド:
      action / is_buy / is_sell / buy_amount / sell_amount / order / verdict /
      is_lock_period_active / lock_floor_weight
    """

    fund_code:           str
    current_weight:      float
    days_since_purchase: int

    def __post_init__(self) -> None:
        cw  = max(0.0, _safe_float(self.current_weight, 0.0))
        dsp = max(0, _safe_int(self.days_since_purchase, 0))
        object.__setattr__(self, "current_weight", cw)
        object.__setattr__(self, "days_since_purchase", dsp)


# ── FundHoldingObservation ────────────────────────────────────────────────────

@dataclass(frozen=True)
class FundHoldingObservation:
    """
    個別投信保有情報の観察値。immutable。

    投信はロック制約なし。
    is_lock_period_active / lock_floor_weight は持たない
    （jp_equity_pf_builder.LockObservation との設計的差異）。

    全フィールドは「数値的に観察された事実」であり、
    「保有し続けよ」「売却するな」という命令ではない。

    fund_code:           投信コード
    current_weight:      現在の保有比率（観察値）
    days_since_purchase: 購入からの経過日数（観察値）

    禁止フィールド:
      action / is_buy / is_sell / is_hold / is_lock_period_active /
      lock_floor_weight / sell_locked / can_sell / order / verdict / decision
    """

    fund_code:           str
    current_weight:      float
    days_since_purchase: int

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "current_weight",
            max(0.0, _safe_float(self.current_weight, 0.0)),
        )
        object.__setattr__(
            self, "days_since_purchase",
            max(0, _safe_int(self.days_since_purchase, 0)),
        )


# ── FundPfInput ───────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class FundPfInput:
    """
    FundPfBuilder.build() への入力。immutable。

    fund_ideal_pf:    SplitResult.fund_ideal_pf を想定。
                      投信サブセットの理想配分比率（再正規化済み）。
    current_holdings: tuple[FundHoldingInfo, ...] — 現在の投信保有情報。
    regime:           市況レジーム文字列（コンテキスト）。
    context:          追加情報（任意）。default_factory=dict。mutation 禁止。

    禁止フィールド:
      action / recommendation / is_buy / is_sell / verdict / decision
    """

    fund_ideal_pf:    tuple[tuple[str, float], ...]
    current_holdings: tuple[FundHoldingInfo, ...]
    regime:           str
    context:          dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.fund_ideal_pf, tuple):
            object.__setattr__(self, "fund_ideal_pf", tuple(self.fund_ideal_pf))
        if not isinstance(self.current_holdings, tuple):
            object.__setattr__(self, "current_holdings", tuple(self.current_holdings))
        if not isinstance(self.context, dict):
            object.__setattr__(self, "context", {})


# ── FundPfResult ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class FundPfResult:
    """
    投信 PF 計算結果。immutable。

    「投信ポートフォリオ構成の数値計算結果」であり売買命令ではない。
    fund_pf の各重みは「入力正規化後の投信理想配分比率の計算値」であり、
    「この投信を取得せよ / 保持せよ」ではない。
    3ヶ月ロック制約は適用されていない（投信はロック制約対象外）。
    実際の発注・注文生成は Operation 層の責務。
    (calculation-only, no lock constraint applied, not an order, not a recommendation)

    fund_pf:                   ロック制約なしの投信理想配分比率（weight 降順 + code 昇順）
    fund_holding_observations: 各保有投信の観察値（FundHoldingObservation）
    diagnostics:               計算上の観察事実（"observation:" prefix 統一）

    禁止フィールド:
      fund_constrained_pf（"constrained" は制約適用を示唆するため不使用） /
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / rating / approve / reject / conditional /
      buy_amount / sell_amount / order / trade_order / rebalance_order
    """

    fund_pf:                   tuple[tuple[str, float], ...]
    fund_holding_observations: tuple[FundHoldingObservation, ...]
    diagnostics:               tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.fund_pf, tuple):
            object.__setattr__(self, "fund_pf", ())
        if not isinstance(self.fund_holding_observations, tuple):
            object.__setattr__(self, "fund_holding_observations", ())
        if not isinstance(self.diagnostics, tuple):
            object.__setattr__(self, "diagnostics", tuple(self.diagnostics))

    def to_dict(self) -> dict:
        """JSON serializable な dict を返す（str / float / int / list / dict のみ）。"""
        return {
            "fund_pf": dict(self.fund_pf),
            "fund_holding_observations": [
                {
                    "fund_code":           obs.fund_code,
                    "current_weight":      obs.current_weight,
                    "days_since_purchase": obs.days_since_purchase,
                }
                for obs in self.fund_holding_observations
            ],
            "diagnostics": list(self.diagnostics),
        }


# ── FundPfBuilder ─────────────────────────────────────────────────────────────

class FundPfBuilder:
    """
    投信 PF の計算値 fund_pf を生成するクラス。

    build() は pure computation:
      - FundPfInput を受け取り FundPfResult を返す
      - 売買判断・注文生成・発注制限は行わない
      - 3ヶ月ロック制約は適用しない（投信はロック制約対象外）
      - 個別株ロジックと混在しない
      - fund_short_term_risk.py との接続は行わない（別ドメイン）

    current_holdings / context を mutation してはならない。
    """

    def build(self, pf_input: FundPfInput) -> FundPfResult:
        """
        fund_ideal_pf を入力正規化して fund_pf を生成する。

        計算結果（fund_pf）は「入力正規化後の投信理想配分比率の計算値」であり、
        発注指示・推奨・売買命令ではない。3ヶ月ロック制約は適用しない。
        (calculation-only, no lock constraint applied, not an order)

        Args:
            pf_input: FundPfInput（fund_ideal_pf / current_holdings / regime を DI）

        Returns:
            FundPfResult

        制約:
          - current_holdings / context を mutation してはならない
          - BUY / SELL / HOLD / WAIT 判定を行ってはならない
          - 実 HTTP / LLM 接続を行ってはならない
          - scipy / numpy / pandas を使用してはならない
          - 3ヶ月ロック制約を適用してはならない
          - fund_short_term_risk.py を import / 接続してはならない
        """
        diag: list[str] = []

        # ── Step 1: fund_ideal_pf を (fund_code, weight) リスト化 ────────
        ideal_items: list[tuple[str, float]] = [
            (fc, max(0.0, _safe_float(w, 0.0)))
            for fc, w in pf_input.fund_ideal_pf
        ]

        # ── Step 2: FundHoldingObservation を構築（重複 fund_code は最初のみ）
        seen: set[str] = set()
        obs_list: list[FundHoldingObservation] = []

        for holding in pf_input.current_holdings:
            fc = holding.fund_code
            if fc in seen:
                diag.append(
                    f"observation: duplicate fund_code '{fc}' in current_holdings"
                    " — first occurrence used"
                )
                continue
            seen.add(fc)

            obs_list.append(FundHoldingObservation(
                fund_code=fc,
                current_weight=max(0.0, _safe_float(holding.current_weight, 0.0)),
                days_since_purchase=max(0, _safe_int(holding.days_since_purchase, 0)),
            ))

        # ── Step 3: 入力データ品質観察 ────────────────────────────────────
        total_cw = sum(obs.current_weight for obs in obs_list)
        if total_cw > 1.0 + 1e-6:
            diag.append(
                f"observation: current_holdings current_weight sum {total_cw:.4f} > 1.0"
                " — input data quality observation"
            )

        # ── Step 4: fund_pf を生成（再正規化・ordering）─────────────────
        # 投信はロック制約なし: fund_ideal_pf を正規化して fund_pf とする
        # (calculation-only, no lock constraint applied)
        fund_pf = _renormalize(ideal_items)

        return FundPfResult(
            fund_pf=fund_pf,
            fund_holding_observations=tuple(obs_list),
            diagnostics=tuple(diag),
        )
