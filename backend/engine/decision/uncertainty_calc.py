"""
Uncertainty Calculator — Card 5-8
Phase 5 意思決定エンジン: Confidence × Uncertainty 補正 + Decision Smoothing。

責務:
  - UncertaintyInput      — 計算入力を保持する frozen dataclass
  - UncertaintyResult     — 計算結果を保持する frozen dataclass
  - UncertaintyCalculator — risk_adjusted_ev / smoothed_ev を計算
  - UncertaintyCalculator.calculate(input) → UncertaintyResult

risk_adjusted_ev 仕様（A7 準拠）:
  ev_final >= 0 の場合:
    risk_adjusted_ev = ev_final * confidence * (1.0 - uncertainty)
  ev_final < 0 の場合:
    risk_adjusted_ev = ev_final  ← マイナスEVは改善方向に補正しない

  理由: ev_final が負のとき confidence/(1-uncertainty) を乗算すると
       不確実性が高いほどマイナスEVが軽く見えてしまうため。
       プラスEVは保守的に減額し、マイナスEVはそのまま保持する。

Decision Smoothing 仕様（A4 準拠）:
  previous_ev is None:
    smoothed_ev = risk_adjusted_ev（初回：履歴なし）
  previous_ev がある場合:
    smoothed_ev = smooth_alpha * risk_adjusted_ev + (1.0 - smooth_alpha) * previous_ev

  smooth_alpha はクランプしない（呼び出し側が [0,1] を保証する前提）。
  smooth_alpha を 0.0 や 1.0 にすることで前回値のみ / 今回値のみの動作をテストで確認できる。

confidence / uncertainty の clamp:
  入力値は [0.0, 1.0] にクランプする。数値的に不正な値をサイレントに補正する。

risk_adjusted_ev / smoothed_ev はクランプしない。

売買判断の境界線:
  UncertaintyCalculator は数値計算のみを行う補助指標モジュール。
  is_actionable などの判断フィールドは持たない。

実装しないこと:
  - BUY / SELL / HOLD / WAIT 等の判定
  - is_actionable / is_recommended 等の判断フィールド
  - 4段階判定（A5: 別モジュール）
  - 銘柄推奨・PF最適化
  - 実 LLM / HTTP / 外部 API
  - pandas / numpy
  - backend.engine.scoring / regime / market_intel / news の import
  - backend.engine.decision.ev_calculator の import
  - backend.engine.decision.cvar_estimator の import（独立性維持）

Reference: docs/v13.3/05_v13.3_master_plan.md A4, A7
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 5-8
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


# ── DataClasses ───────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class UncertaintyInput:
    """Confidence × Uncertainty 補正と Decision Smoothing の入力。immutable。"""

    ticker:       str            # 銘柄コード
    ev_final:     float          # 期待リターン（EVResult.ev_final を平 float で受け取る）
    confidence:   float          # [0.0, 1.0] — regime consensus / データ品質（clamp 済みでなくてよい）
    uncertainty:  float          # [0.0, 1.0] — 市場不確実性（clamp 済みでなくてよい）
    previous_ev:  Optional[float] = None  # Decision Smoothing 用前回 ev（None=初回）
    smooth_alpha: float = 0.7    # Smoothing 今回値の重み（0.7×今回 + 0.3×前回）


@dataclass(frozen=True)
class UncertaintyResult:
    """Confidence × Uncertainty 補正結果。算術結果のみ保持し判断フィールドは持たない。immutable。"""

    ticker:           str    # 銘柄コード
    ev_final:         float  # 入力をそのまま保持
    confidence:       float  # clamp 後の値
    uncertainty:      float  # clamp 後の値
    risk_adjusted_ev: float  # Confidence × Uncertainty 補正後（negative EV はそのまま）
    smoothed_ev:      float  # Decision Smoothing 適用後（クランプしない）
    # is_actionable / is_recommended などの判断フィールドは意図的に持たない


# ── UncertaintyCalculator ─────────────────────────────────────────────────────

class UncertaintyCalculator:
    """
    Confidence × Uncertainty 補正（A7）と Decision Smoothing（A4）を計算する。

    ev_final が負の場合は risk_adjusted_ev = ev_final のまま保持する（マイナスEV改善禁止）。
    confidence / uncertainty は [0.0, 1.0] にクランプしてから計算に使用する。
    risk_adjusted_ev / smoothed_ev はクランプしない。
    backend.engine.decision.ev_calculator を import しない。
    """

    def calculate(self, unc_input: UncertaintyInput) -> UncertaintyResult:
        """
        UncertaintyInput から UncertaintyResult を計算する。

        Args:
            unc_input: Confidence × Uncertainty 補正と Smoothing の入力。
        Returns:
            UncertaintyResult: risk_adjusted_ev / smoothed_ev を含む計算結果。
        """
        confidence  = max(0.0, min(1.0, unc_input.confidence))
        uncertainty = max(0.0, min(1.0, unc_input.uncertainty))

        risk_adjusted_ev = self._calc_risk_adjusted_ev(
            unc_input.ev_final, confidence, uncertainty
        )
        smoothed_ev = self._calc_smoothed_ev(
            risk_adjusted_ev, unc_input.previous_ev, unc_input.smooth_alpha
        )

        return UncertaintyResult(
            ticker=unc_input.ticker,
            ev_final=unc_input.ev_final,
            confidence=confidence,
            uncertainty=uncertainty,
            risk_adjusted_ev=risk_adjusted_ev,
            smoothed_ev=smoothed_ev,
        )

    # ── risk_adjusted_ev ──────────────────────────────────────────────────────

    def _calc_risk_adjusted_ev(
        self,
        ev_final:    float,
        confidence:  float,
        uncertainty: float,
    ) -> float:
        """
        ev_final >= 0 → ev_final * confidence * (1.0 - uncertainty)
        ev_final < 0  → ev_final（マイナスEVは改善方向に補正しない）

        NOTE: confidence / uncertainty は呼び出し元で clamp 済みであること。
        """
        if ev_final >= 0.0:
            return ev_final * confidence * (1.0 - uncertainty)
        return ev_final

    # ── decision smoothing ────────────────────────────────────────────────────

    def _calc_smoothed_ev(
        self,
        risk_adjusted_ev: float,
        previous_ev:      Optional[float],
        smooth_alpha:     float,
    ) -> float:
        """
        Decision Smoothing（A4）。
        previous_ev is None → smoothed_ev = risk_adjusted_ev（初回）
        previous_ev あり    → smooth_alpha * current + (1 - smooth_alpha) * previous

        smooth_alpha はクランプしない（呼び出し側が [0,1] を保証する前提）。
        """
        if previous_ev is None:
            return risk_adjusted_ev
        return smooth_alpha * risk_adjusted_ev + (1.0 - smooth_alpha) * previous_ev
