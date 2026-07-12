"""
future_branching.py — Card B
Phase 8 Frontier Engine: 将来分岐（regime branch）観察値計算。

責務:
  - CANONICAL_REGIMES         — Phase 6/8 で使う 5 regime の固定順序
  - FutureBranch              — 1 regime の試算結果（frozen dataclass）
  - FutureBranchingInput      — 計算入力（frozen dataclass、Flat DI）
  - FutureBranchingResult     — 結果コンテナ（frozen dataclass）
  - FutureBranchingCalculator — calculate() で FutureBranchingResult を返すクラス

将来分岐の観察値（pure computation）:
  5 regime（bull_calm / bull_volatile / bear / crisis / uncertain）それぞれの
  期待 return / vol / max_dd を DI で受け取り、portfolio 指標を試算する。

  「もし regime が X だったら」という観察値であり、「regime が X になる」
  という予測ではない。downside_case / upside_case は ±z * vol の統計的観察値。

  本モジュールは「これから XX 相場になる」「タイミング」「予測」「予想」
  「次に買う」等の予言・判定文言は一切出力しない。
  全 diagnostics に `not a prediction, not a recommendation` の趣旨を含める。

CANONICAL_REGIMES（固定順）:
  ("bull_calm", "bull_volatile", "bear", "crisis", "uncertain")
  単純昇順だと "bear" が先頭になり意味順として不自然。
  Phase 6/8 の意味順（上方 → 下方 → 不確定）を採用（P1-B10）。

計算アルゴリズム:
  1. base_regime が CANONICAL_REGIMES 外 → "uncertain" fallback + diagnostic
  2. downside_z_score を safe float、z <= 0 → 2.0 fallback + diagnostic
  3. regime_probabilities 処理（P1-B11）:
     - 非 dict / 空 / 全有効値ゼロ → uniform 1/5 + diagnostic
     - 一部有効 → [0, 1] clamp + 正規化 + diagnostic
     - 負値 / NaN / inf / str → 0.0 fallback
  4. 各 regime について:
     - er = regime_expected_returns[regime] or base_regime 値 or 0.0
     - vol = max(0.0, regime_expected_vols[regime] or base or 0.0)
     - dd = min(0.0, regime_max_dds[regime] or base or 0.0)
     - sharpe = er / vol if vol > 0 else 0.0
     - downside_case = er - z * vol
     - upside_case = er + z * vol
     - is_base_regime = (regime == base_regime_resolved)
  5. branches を CANONICAL_REGIMES 順で tuple 化
  6. 集約:
     - weighted_expected_return = Σ prob * branch.expected_return
     - weighted_expected_vol    = Σ prob * branch.expected_vol（線形和、P1-B5）
     - worst_case_dd            = min(branch.max_dd_estimate)
     - worst_case_downside      = min(branch.downside_case)
     - best_case_upside         = max(branch.upside_case)
  7. diagnostics に必ず以下 3 つの趣旨を含める
     - "observation: future branches are scenario calculations, not predictions"
     - "observation: not an order, not a recommendation"
     - "observation: weighted_expected_vol is linear aggregation, not covariance-aware"

設計原則:
  - stdlib-only（math のみ）
  - pandas / numpy / scipy 禁止
  - 実 HTTP / LLM 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / approve / reject / conditional / rating 禁止
  - rebalance_order / buy_amount / sell_amount / shares / quantity 禁止
  - "予測" "予想" "タイミング" "次に買う" "今すぐ" 等の予言・タイミング文言禁止
  - LLM narrative 禁止
  - operation / market_intel / news / regime / aggregator 等の Result 型を
    直接 import しない（Flat DI、P1-B2）
  - context / 各 dict 入力を mutation しない
  - public/data writer 禁止

P1 記録:
  P1-B1: 配置は backend/engine/frontier/。
  P1-B2: Flat DI。既存 Result 型を直接 import しない。
  P1-B4: regime は CANONICAL_REGIMES 5 値固定。
  P1-B5: weighted_expected_vol は線形和（covariance 対応は別 Card、P2-B8）。
  P1-B7: Monte Carlo は含めない（P2-B2 別 Card）。
  P1-B8: downside_z_score は input field、default 2.0、z <= 0 → 2.0 fallback。
  P1-B9: to_dict() は JSON serializable。
  P1-B10: output regime 順序は CANONICAL_REGIMES 固定。
  P1-B11: probability は一部有効なら正規化、全無効なら uniform。

P2 記録（後続 Card 候補）:
  P2-B1: 確率重み付き CVaR / 5%下側分位。
  P2-B2: Monte Carlo / 多期間シミュレーション。
  P2-B5: LLM branch narrative は当面禁止。
  P2-B7: Phase 8 hybrid metric 観点での出力意味精査（P2-A1 と連動）。
  P2-B8: covariance-aware weighted_expected_vol。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card B（元 Card 8-4）
           handover.md "Phase 8 Cards 8-1〜8-4 Mini Integration Review" 以降
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any


# ── 定数 ─────────────────────────────────────────────────────────────────────


# 5 regime の固定順（P1-B10）。Phase 6/8 で使う意味順。
CANONICAL_REGIMES: tuple = (
    "bull_calm",
    "bull_volatile",
    "bear",
    "crisis",
    "uncertain",
)

_FALLBACK_REGIME: str = "uncertain"
_DEFAULT_Z_SCORE: float = 2.0

# 必須 disclaimer 文言（FutureBranchingResult.diagnostics に必ず含める）
_DISCLAIMER_SCENARIO: str = (
    "observation: future branches are scenario calculations, not predictions"
)
_DISCLAIMER_NOT_ORDER: str = (
    "observation: not an order, not a recommendation"
)
_DISCLAIMER_LINEAR_AGG: str = (
    "observation: weighted_expected_vol is linear aggregation, not covariance-aware"
)


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


def _clamp(val: float, lo: float, hi: float) -> float:
    """val を [lo, hi] に clamp する。"""
    return max(lo, min(hi, val))


# ── FutureBranch ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class FutureBranch:
    """
    1 regime の試算結果（観察値）。immutable。

    expected_vol は 0.0 以上、max_dd_estimate は 0.0 以下、probability は
    [0.0, 1.0] に __post_init__ で clamp する。

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / approve / reject / conditional / rating /
      rebalance_order / buy_amount / sell_amount / shares / quantity /
      timing / signal / forecast / prediction
    """

    regime:          str
    expected_return: float
    expected_vol:    float
    sharpe_ratio:    float
    max_dd_estimate: float
    downside_case:   float
    upside_case:     float
    probability:     float
    is_base_regime:  bool = False

    def __post_init__(self) -> None:
        # regime: str / 非空
        regime = self.regime if isinstance(self.regime, str) and self.regime else _FALLBACK_REGIME
        object.__setattr__(self, "regime", regime)

        # expected_return: safe float
        object.__setattr__(self, "expected_return",
                           _safe_float(self.expected_return, 0.0))

        # expected_vol: safe float + 0.0 以上 clamp
        object.__setattr__(self, "expected_vol",
                           max(0.0, _safe_float(self.expected_vol, 0.0)))

        # sharpe_ratio: safe float
        object.__setattr__(self, "sharpe_ratio",
                           _safe_float(self.sharpe_ratio, 0.0))

        # max_dd_estimate: safe float + 0.0 以下 clamp
        object.__setattr__(self, "max_dd_estimate",
                           min(0.0, _safe_float(self.max_dd_estimate, 0.0)))

        # downside_case / upside_case: safe float（clamp なし、符号保持）
        object.__setattr__(self, "downside_case",
                           _safe_float(self.downside_case, 0.0))
        object.__setattr__(self, "upside_case",
                           _safe_float(self.upside_case, 0.0))

        # probability: safe float + [0.0, 1.0] clamp
        object.__setattr__(self, "probability",
                           _clamp(_safe_float(self.probability, 0.0), 0.0, 1.0))

        # is_base_regime: bool
        object.__setattr__(self, "is_base_regime", bool(self.is_base_regime))

    def to_dict(self) -> dict:
        """JSON serializable な dict。"""
        return {
            "regime":          self.regime,
            "expected_return": self.expected_return,
            "expected_vol":    self.expected_vol,
            "sharpe_ratio":    self.sharpe_ratio,
            "max_dd_estimate": self.max_dd_estimate,
            "downside_case":   self.downside_case,
            "upside_case":     self.upside_case,
            "probability":     self.probability,
            "is_base_regime":  self.is_base_regime,
        }


# ── FutureBranchingInput ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class FutureBranchingInput:
    """
    FutureBranchingCalculator.calculate() への入力。immutable。

    Flat DI 設計（P1-B2）:
      Aggregator / FrontierStrategy 等の Result 型を直接 import しない。
      Operation 層が解体して dict / float / str を DI する。

    pf_weights: 対象 portfolio の weights（観察対象の identity 情報として保持。
                計算には直接使わない、P2-B1〜P2-B2 で per-ticker 拡張する可能性あり）

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / approve / reject / conditional / rating /
      rebalance_order / buy_amount / sell_amount / shares / quantity /
      timing / prediction
    """

    pf_weights:              dict
    base_regime:             str   = _FALLBACK_REGIME
    regime_expected_returns: dict  = field(default_factory=dict)
    regime_expected_vols:    dict  = field(default_factory=dict)
    regime_max_dds:          dict  = field(default_factory=dict)
    regime_probabilities:    dict  = field(default_factory=dict)
    downside_z_score:        float = _DEFAULT_Z_SCORE
    horizon:                 str   = "long_term"
    context:                 dict  = field(default_factory=dict)

    def __post_init__(self) -> None:
        # dict fields: 非 dict → {} fallback（mutation しない）
        if not isinstance(self.pf_weights, dict):
            object.__setattr__(self, "pf_weights", {})
        if not isinstance(self.regime_expected_returns, dict):
            object.__setattr__(self, "regime_expected_returns", {})
        if not isinstance(self.regime_expected_vols, dict):
            object.__setattr__(self, "regime_expected_vols", {})
        if not isinstance(self.regime_max_dds, dict):
            object.__setattr__(self, "regime_max_dds", {})
        if not isinstance(self.regime_probabilities, dict):
            object.__setattr__(self, "regime_probabilities", {})
        if not isinstance(self.context, dict):
            object.__setattr__(self, "context", {})

        # base_regime: str / 非空
        base = (
            self.base_regime
            if isinstance(self.base_regime, str) and self.base_regime
            else _FALLBACK_REGIME
        )
        object.__setattr__(self, "base_regime", base)

        # horizon: str / 非空
        horizon = self.horizon if isinstance(self.horizon, str) and self.horizon else "long_term"
        object.__setattr__(self, "horizon", horizon)

        # downside_z_score: safe float（z <= 0 の fallback は calculate() で実施）
        object.__setattr__(self, "downside_z_score",
                           _safe_float(self.downside_z_score, _DEFAULT_Z_SCORE))


# ── FutureBranchingResult ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class FutureBranchingResult:
    """
    FutureBranchingCalculator.calculate() の結果。immutable。

    branches: tuple[FutureBranch, ...]
              CANONICAL_REGIMES 固定順（P1-B10）。長さは常に 5。

    base_regime: 入力 base_regime（"uncertain" fallback 含む）

    weighted_expected_return: Σ prob * branch.expected_return
    weighted_expected_vol:    Σ prob * branch.expected_vol（線形和、P1-B5）
                              0.0 以上 clamp
    worst_case_dd:           min(branch.max_dd_estimate)、0.0 以下
    worst_case_downside:     min(branch.downside_case)
    best_case_upside:        max(branch.upside_case)

    diagnostics: "observation: " プレフィックスの観察文字列 tuple。
                 必ず以下 3 つの趣旨を含む:
                 - future branches are scenario calculations, not predictions
                 - not an order, not a recommendation
                 - weighted_expected_vol is linear aggregation, not covariance-aware

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / approve / reject / conditional / rating /
      rebalance_order / buy_amount / sell_amount / shares / quantity /
      final_verdict / order / amount / entry_price / stop_loss / take_profit /
      timing / prediction / forecast
    """

    branches:                 tuple
    base_regime:              str
    weighted_expected_return: float
    weighted_expected_vol:    float
    worst_case_dd:            float
    worst_case_downside:      float
    best_case_upside:         float
    diagnostics:              tuple = ()

    def __post_init__(self) -> None:
        # branches: tuple
        if not isinstance(self.branches, tuple):
            object.__setattr__(self, "branches", tuple(self.branches))

        # base_regime: str / 非空
        base = (
            self.base_regime
            if isinstance(self.base_regime, str) and self.base_regime
            else _FALLBACK_REGIME
        )
        object.__setattr__(self, "base_regime", base)

        # weighted_expected_return: safe float（符号保持）
        object.__setattr__(self, "weighted_expected_return",
                           _safe_float(self.weighted_expected_return, 0.0))

        # weighted_expected_vol: safe float + 0.0 以上 clamp
        object.__setattr__(self, "weighted_expected_vol",
                           max(0.0, _safe_float(self.weighted_expected_vol, 0.0)))

        # worst_case_dd: safe float + 0.0 以下 clamp
        object.__setattr__(self, "worst_case_dd",
                           min(0.0, _safe_float(self.worst_case_dd, 0.0)))

        # worst_case_downside / best_case_upside: safe float（符号保持）
        object.__setattr__(self, "worst_case_downside",
                           _safe_float(self.worst_case_downside, 0.0))
        object.__setattr__(self, "best_case_upside",
                           _safe_float(self.best_case_upside, 0.0))

        # diagnostics: tuple
        if not isinstance(self.diagnostics, tuple):
            object.__setattr__(self, "diagnostics", tuple(self.diagnostics))

    def to_dict(self) -> dict:
        """JSON serializable な dict。"""
        return {
            "branches":                 [b.to_dict() for b in self.branches],
            "base_regime":              self.base_regime,
            "weighted_expected_return": self.weighted_expected_return,
            "weighted_expected_vol":    self.weighted_expected_vol,
            "worst_case_dd":            self.worst_case_dd,
            "worst_case_downside":      self.worst_case_downside,
            "best_case_upside":         self.best_case_upside,
            "diagnostics":              list(self.diagnostics),
        }


# ── FutureBranchingCalculator ─────────────────────────────────────────────────


class FutureBranchingCalculator:
    """
    FutureBranchingInput を受け取り FutureBranchingResult を返す pure computation。

    売買判断・注文生成・予測言語・タイミング言語は一切行わない。
    入力 dict / context は mutation しない。
    """

    def calculate(self, input: FutureBranchingInput) -> FutureBranchingResult:
        """
        5 regime の future branching 観察値を計算する。

        Args:
            input: FutureBranchingInput（pf_weights / regime metrics / probability 等を DI）
        Returns:
            FutureBranchingResult（branches は CANONICAL_REGIMES 順）
        """
        diagnostics: list = []

        # ── Step 1: base_regime fallback ──────────────────────────────────────
        base_regime = input.base_regime
        if base_regime not in CANONICAL_REGIMES:
            diagnostics.append(
                f"observation: base_regime '{base_regime}' not in CANONICAL_REGIMES — "
                f"fallback to '{_FALLBACK_REGIME}'"
            )
            base_regime = _FALLBACK_REGIME

        # ── Step 2: downside_z_score fallback ─────────────────────────────────
        z_score = input.downside_z_score
        if z_score <= 0.0:
            diagnostics.append(
                f"observation: downside_z_score {z_score} <= 0 — "
                f"fallback to {_DEFAULT_Z_SCORE}"
            )
            z_score = _DEFAULT_Z_SCORE

        # ── Step 3: regime_probabilities 処理（P1-B11）───────────────────────
        probs = self._resolve_probabilities(input.regime_probabilities, diagnostics)

        # ── Step 4: regime metrics extraction ─────────────────────────────────
        er_map = input.regime_expected_returns
        vol_map = input.regime_expected_vols
        dd_map = input.regime_max_dds

        # base_regime 値（fallback 用）
        base_er = _safe_float(er_map.get(base_regime, 0.0), 0.0) if er_map else 0.0
        base_vol = max(0.0, _safe_float(vol_map.get(base_regime, 0.0), 0.0)) if vol_map else 0.0
        base_dd = min(0.0, _safe_float(dd_map.get(base_regime, 0.0), 0.0)) if dd_map else 0.0

        # base_regime が各 map に欠損している diagnostic
        if er_map and base_regime not in er_map:
            diagnostics.append(
                f"observation: regime_expected_returns missing base_regime "
                f"'{base_regime}' — base value treated as 0.0"
            )
        if vol_map and base_regime not in vol_map:
            diagnostics.append(
                f"observation: regime_expected_vols missing base_regime "
                f"'{base_regime}' — base value treated as 0.0"
            )
        if dd_map and base_regime not in dd_map:
            diagnostics.append(
                f"observation: regime_max_dds missing base_regime "
                f"'{base_regime}' — base value treated as 0.0"
            )

        # 全 map 空 diagnostic
        if not er_map:
            diagnostics.append("observation: regime_expected_returns is empty — all branches use 0.0")
        if not vol_map:
            diagnostics.append("observation: regime_expected_vols is empty — all branches use 0.0")
        if not dd_map:
            diagnostics.append("observation: regime_max_dds is empty — all branches use 0.0")

        # ── Step 5: branches を CANONICAL_REGIMES 順で構築 ───────────────────
        branches: list = []
        er_missing: list = []
        vol_missing: list = []
        dd_missing: list = []

        for regime in CANONICAL_REGIMES:
            if regime in er_map:
                er = _safe_float(er_map[regime], base_er)
            else:
                er = base_er
                if er_map:
                    er_missing.append(regime)

            if regime in vol_map:
                vol_raw = _safe_float(vol_map[regime], base_vol)
                vol = max(0.0, vol_raw)
            else:
                vol = base_vol
                if vol_map:
                    vol_missing.append(regime)

            if regime in dd_map:
                dd_raw = _safe_float(dd_map[regime], base_dd)
                dd = min(0.0, dd_raw)
            else:
                dd = base_dd
                if dd_map:
                    dd_missing.append(regime)

            sharpe = er / vol if vol > 0.0 else 0.0
            downside = er - z_score * vol
            upside = er + z_score * vol
            is_base = (regime == base_regime)

            branches.append(FutureBranch(
                regime=regime,
                expected_return=er,
                expected_vol=vol,
                sharpe_ratio=sharpe,
                max_dd_estimate=dd,
                downside_case=downside,
                upside_case=upside,
                probability=probs[regime],
                is_base_regime=is_base,
            ))

        if er_missing:
            diagnostics.append(
                f"observation: regime_expected_returns missing for "
                f"{er_missing} — fallback to base_regime value"
            )
        if vol_missing:
            diagnostics.append(
                f"observation: regime_expected_vols missing for "
                f"{vol_missing} — fallback to base_regime value"
            )
        if dd_missing:
            diagnostics.append(
                f"observation: regime_max_dds missing for "
                f"{dd_missing} — fallback to base_regime value"
            )

        # ── Step 6: 集約 ─────────────────────────────────────────────────────
        weighted_er = sum(b.probability * b.expected_return for b in branches)
        weighted_vol = sum(b.probability * b.expected_vol for b in branches)
        worst_dd = min(b.max_dd_estimate for b in branches) if branches else 0.0
        worst_downside = min(b.downside_case for b in branches) if branches else 0.0
        best_upside = max(b.upside_case for b in branches) if branches else 0.0

        # ── Step 7: 必須 disclaimer ──────────────────────────────────────────
        diagnostics.append(_DISCLAIMER_SCENARIO)
        diagnostics.append(_DISCLAIMER_NOT_ORDER)
        diagnostics.append(_DISCLAIMER_LINEAR_AGG)

        return FutureBranchingResult(
            branches=tuple(branches),
            base_regime=base_regime,
            weighted_expected_return=weighted_er,
            weighted_expected_vol=weighted_vol,
            worst_case_dd=worst_dd,
            worst_case_downside=worst_downside,
            best_case_upside=best_upside,
            diagnostics=tuple(diagnostics),
        )

    # ── private helpers ───────────────────────────────────────────────────────

    def _resolve_probabilities(
        self,
        raw: Any,
        diagnostics: list,
    ) -> dict:
        """
        regime_probabilities を CANONICAL_REGIMES の 5 値 dict に正規化する。

        - 非 dict / 空 / 全有効値ゼロ → uniform 1/5 + diagnostic
        - 一部有効 → [0.0, 1.0] clamp + 合計が 1.0 でなければ正規化 + diagnostic
        - 負値 / NaN / inf / str → 0.0 fallback
        - 不足 regime は 0.0
        """
        if not isinstance(raw, dict) or not raw:
            diagnostics.append(
                "observation: regime_probabilities missing or non-dict — "
                "uniform 1/5 used"
            )
            return {r: 1.0 / len(CANONICAL_REGIMES) for r in CANONICAL_REGIMES}

        # Step A: 各 canonical regime について safe float + [0, 1] clamp
        clamped: dict = {}
        for regime in CANONICAL_REGIMES:
            p = _safe_float(raw.get(regime, 0.0), 0.0)
            clamped[regime] = max(0.0, min(1.0, p))

        total = sum(clamped.values())

        if total <= 0.0:
            diagnostics.append(
                "observation: regime_probabilities sum <= 0 after clamp — "
                "uniform 1/5 used"
            )
            return {r: 1.0 / len(CANONICAL_REGIMES) for r in CANONICAL_REGIMES}

        if abs(total - 1.0) > 1e-9:
            diagnostics.append(
                f"observation: regime_probabilities sum {total:.6f} != 1.0 — "
                f"normalized to sum = 1.0"
            )
            return {r: clamped[r] / total for r in CANONICAL_REGIMES}

        return clamped
