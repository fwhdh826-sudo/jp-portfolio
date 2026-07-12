"""
edge_weighted_sizing.py — Card 7-9
Phase 7 Multi-Strategy Engine: エッジ加重ポジションサイジング計算。

責務:
  - EDGE_FACTOR_MIN   — edge_factor の最小 floor 定数（0.1）
  - EdgeSizingInput   — 計算への入力を保持する frozen dataclass
  - EdgeSizingResult  — 計算結果を保持する frozen dataclass
  - EdgeWeightedSizer — calculate() で EdgeSizingResult を返すクラス

計算アルゴリズム:
  1. 入力値の safe_float clamp
  2. edge_factor      = clamp(committee_confidence, EDGE_FACTOR_MIN, 1.0)
  3. behavioral_damping = clamp(1.0 - behavioral_score / 100.0, 0.0, 1.0)
  4. raw_multiplier   = exposure_multiplier * edge_factor * behavioral_damping
  5. sizing_multiplier = clamp(raw_multiplier, 0.0, sizing_multiplier_cap)
  6. adjusted_size    = clamp(base_size * sizing_multiplier, 0.0, 1.0)
  7. is_size_capped   = raw_multiplier > sizing_multiplier_cap

volatility_targeting.py（Card 5-10A）との分担:
  - decision/volatility_targeting.py: returns 系列 → exposure_multiplier を計算
  - pre_mortem/edge_weighted_sizing.py: exposure_multiplier を DI で受け取り、
    edge 品質・行動バイアス補正を乗算 → sizing_multiplier / adjusted_size を計算
  - edge_weighted_sizing は volatility_targeting の計算を再実装しない

EDGE_FACTOR_MIN = 0.1 の設計根拠（P1-7Z）:
  committee_confidence=0.0 だけで adjusted_size が完全に 0.0 になると
  「取得しない判断」に見えやすい。完全停止・実行可否判断は Operation 層に残す。
  ここでは calculation-only の sizing multiplier に限定する。
  edge_factor floor 使用時は diagnostics に observation を記録する。

adjusted_size の意味（P2-7AC）:
  adjusted_size は weight（0.0–1.0）であり、JPY 金額・株数・口数ではない。
  注文金額への変換は Operation 層の責務。
  adjusted_size は「計算値」であり「買付命令」ではない。

設計原則:
  - 実際の売買制限・注文制限はしない（数値化のみ）
  - 実 LLM / HTTP 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / rating / approve / reject / conditional 禁止
  - scipy / pandas / numpy 禁止（math stdlib のみ使用）
  - behavioral / agents / decision モジュールを直接 import しない

実装しないこと:
  - volatility_targeting.py の再実装（DI で exposure_multiplier を受け取るのみ）
  - 発注指示・注文生成・差分売買
  - 銘柄推奨・売買命令
  - public / data writer

P1/P2 記録:
  P1-7Z: edge_factor に EDGE_FACTOR_MIN=0.1 を設定。完全停止判断は Operation 層に残す。
  P2-7AA: _CAP_TABLE（protocol.py）は caution_count ベースの暫定表。
  P2-7AB: behavioral / committee / vol は flat DI。Result 型直接 import なし。
  P2-7AC: adjusted_size は weight。金額・株数変換は Operation 層。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 7-9
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any


# ── 定数 ─────────────────────────────────────────────────────────────────────

EDGE_FACTOR_MIN: float = 0.1
"""
edge_factor の最小 floor。（P1-7Z）
committee_confidence=0.0 でも adjusted_size が完全に 0.0 にならないよう保護する。
完全停止・実行可否判断は Operation 層の責務。
"""

_EXPOSURE_MULTIPLIER_MAX: float = 2.0
_SIZING_MULTIPLIER_CAP_MAX: float = 1.0


# ── safe helper ───────────────────────────────────────────────────────────────

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


# ── EdgeSizingInput ───────────────────────────────────────────────────────────

@dataclass(frozen=True)
class EdgeSizingInput:
    """
    EdgeWeightedSizer.calculate() への入力。immutable。Flat DI 設計。

    base_size:             戦略層配分比率（weight, 0.0–1.0）
    exposure_multiplier:   vol ターゲットスケール係数（VolatilityTargetResult.exposure_multiplier）
    committee_confidence:  分析信頼度（0.0–1.0）（CommitteeReport.aggregate_confidence）
    behavioral_score:      行動バイアスリスクスコア（0.0–100.0）
                           BehavioralScoreResult.behavioral_score から DI
    sizing_multiplier_cap: 観察的上限係数（PreMortemResult.sizing_multiplier_cap）
    regime:                市況レジーム
    context:               追加情報（任意）

    禁止フィールド:
      action / recommendation / is_buy / is_sell / verdict / decision /
      approve / reject / conditional / go / no_go / pass_fail /
      shares / quantity / buy_amount / sell_amount
    """

    base_size:             float
    exposure_multiplier:   float
    committee_confidence:  float
    behavioral_score:      float
    sizing_multiplier_cap: float
    regime:                str  = "uncertain"
    context:               dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "base_size",
            max(0.0, min(1.0, _safe_float(self.base_size, 0.0))),
        )
        object.__setattr__(
            self, "exposure_multiplier",
            max(0.0, min(_EXPOSURE_MULTIPLIER_MAX, _safe_float(self.exposure_multiplier, 1.0))),
        )
        object.__setattr__(
            self, "committee_confidence",
            max(0.0, min(1.0, _safe_float(self.committee_confidence, 0.0))),
        )
        object.__setattr__(
            self, "behavioral_score",
            max(0.0, min(100.0, _safe_float(self.behavioral_score, 0.0))),
        )
        object.__setattr__(
            self, "sizing_multiplier_cap",
            max(0.0, min(_SIZING_MULTIPLIER_CAP_MAX, _safe_float(self.sizing_multiplier_cap, 1.0))),
        )
        if not isinstance(self.context, dict):
            object.__setattr__(self, "context", {})


# ── EdgeSizingResult ──────────────────────────────────────────────────────────

@dataclass(frozen=True)
class EdgeSizingResult:
    """
    エッジ加重サイジング計算結果。immutable。

    「ポジションサイジングの数値計算結果」であり売買命令ではない。
    adjusted_size は weight（0.0–1.0）であり、JPY 金額・株数・口数ではない。（P2-7AC）
    実際の注文金額への変換・発注は Operation 層の責務。
    (calculation-only, not an order, not a recommendation)

    sizing_multiplier:  総合乗数（raw_multiplier を sizing_multiplier_cap で clamp）
    adjusted_size:      base_size × sizing_multiplier（weight, 0.0–1.0）
    is_size_capped:     sizing_multiplier_cap が binding だったか（観察値フラグ）
    edge_factor:        edge 品質係数（clamp 後の観察値）
    behavioral_damping: 行動バイアス補正係数（clamp 後の観察値）
    diagnostics:        計算過程の観察事実（"observation:" prefix 統一）

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / rating / approve / reject / conditional /
      go / no_go / pass_fail / order / trade_order / rebalance_order /
      buy_amount / sell_amount / shares / quantity
    """

    sizing_multiplier:  float
    adjusted_size:      float
    is_size_capped:     bool
    edge_factor:        float
    behavioral_damping: float
    diagnostics:        tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.diagnostics, tuple):
            object.__setattr__(self, "diagnostics", tuple(self.diagnostics))

    def to_dict(self) -> dict:
        """JSON serializable な dict を返す（float / bool / list のみ）。"""
        return {
            "sizing_multiplier":  self.sizing_multiplier,
            "adjusted_size":      self.adjusted_size,
            "is_size_capped":     self.is_size_capped,
            "edge_factor":        self.edge_factor,
            "behavioral_damping": self.behavioral_damping,
            "diagnostics":        list(self.diagnostics),
        }


# ── EdgeWeightedSizer ─────────────────────────────────────────────────────────

class EdgeWeightedSizer:
    """
    エッジ加重ポジションサイジングを計算するクラス。

    calculate() は pure computation:
      - EdgeSizingInput を受け取り EdgeSizingResult を返す
      - 売買判断・注文生成・発注制限は行わない
      - volatility_targeting.py の計算を再実装しない（exposure_multiplier を DI で受け取る）
      - behavioral / agents / decision モジュールを直接 import しない（flat DI）
      - scipy / numpy / pandas を使用しない

    計算式:
      edge_factor      = clamp(committee_confidence, EDGE_FACTOR_MIN, 1.0)
      behavioral_damping = clamp(1.0 - behavioral_score / 100.0, 0.0, 1.0)
      raw_multiplier   = exposure_multiplier * edge_factor * behavioral_damping
      sizing_multiplier = clamp(raw_multiplier, 0.0, sizing_multiplier_cap)
      adjusted_size    = clamp(base_size * sizing_multiplier, 0.0, 1.0)
      is_size_capped   = raw_multiplier > sizing_multiplier_cap
    """

    def calculate(self, sizing_input: EdgeSizingInput) -> EdgeSizingResult:
        """
        エッジ加重サイジング乗数と調整後サイズを計算する。

        adjusted_size は weight（0.0–1.0）であり、JPY 金額・株数ではない。（P2-7AC）
        発注指示・推奨・売買命令ではない。（calculation-only）

        Args:
            sizing_input: EdgeSizingInput

        Returns:
            EdgeSizingResult

        制約:
          - EdgeSizingInput を mutation してはならない
          - BUY / SELL / HOLD / WAIT 判定を行ってはならない
          - 実 HTTP / LLM 接続を行ってはならない
          - scipy / numpy / pandas を使用してはならない
        """
        diag: list[str] = []

        # ── Step 1: edge_factor（EDGE_FACTOR_MIN floor 適用）─────────────────
        raw_confidence = sizing_input.committee_confidence
        edge_factor = max(EDGE_FACTOR_MIN, min(1.0, raw_confidence))

        if raw_confidence < EDGE_FACTOR_MIN:
            diag.append(
                f"observation: edge_factor uses minimum floor={EDGE_FACTOR_MIN}"
                f" (committee_confidence={raw_confidence:.4f} < {EDGE_FACTOR_MIN});"
                " not an execution decision"
            )
        else:
            diag.append(
                f"observation: edge_factor={edge_factor:.4f}"
                f" (committee_confidence={raw_confidence:.4f}, floor not applied)"
            )

        # ── Step 2: behavioral_damping ────────────────────────────────────────
        behavioral_damping = max(0.0, min(1.0, 1.0 - sizing_input.behavioral_score / 100.0))

        # ── Step 3: raw_multiplier ────────────────────────────────────────────
        raw_multiplier = sizing_input.exposure_multiplier * edge_factor * behavioral_damping

        # ── Step 4: sizing_multiplier（cap 適用）─────────────────────────────
        cap = sizing_input.sizing_multiplier_cap
        sizing_multiplier = max(0.0, min(cap, raw_multiplier))
        is_size_capped = raw_multiplier > cap

        if is_size_capped:
            diag.append(
                f"observation: sizing_multiplier capped at {cap:.4f}"
                f" (raw_multiplier={raw_multiplier:.4f})"
                " — sizing_multiplier_cap from PreMortemResult is binding"
            )

        # ── Step 5: adjusted_size（weight, 0.0–1.0, not JPY / shares）─────────
        adjusted_size = max(0.0, min(1.0, sizing_input.base_size * sizing_multiplier))

        diag.append(
            "observation: adjusted_size is a weight (0.0–1.0),"
            " not a JPY amount or share count;"
            " calculation-only, not an order, not a recommendation"
        )

        return EdgeSizingResult(
            sizing_multiplier=sizing_multiplier,
            adjusted_size=adjusted_size,
            is_size_capped=is_size_capped,
            edge_factor=edge_factor,
            behavioral_damping=behavioral_damping,
            diagnostics=tuple(diag),
        )
