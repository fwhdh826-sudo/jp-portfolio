"""
score_calculator.py — Card 6-7
Phase 6 Behavioral: 行動バイアススコア計算層。

責務:
  - BehavioralInput       — 計算への入力を保持する frozen dataclass
  - BehavioralScoreResult — 計算結果を保持する frozen dataclass
  - BehavioralScoreCalculator — calculate() で BehavioralScoreResult を返すクラス

behavioral_score 計算:
  loss_aversion_component  = clamp(loss_streak * 15.0, 0.0, 45.0)
  overtrade_component      = clamp(recent_trade_count * 8.0, 0.0, 40.0)
  volatility_component     = clamp(average_volatility * 20.0, 0.0, 10.0)
  regime_component         = crisis:15.0 / bear:10.0 / bull_volatile:5.0 / others:0.0
  committee_component      = high:10.0 / moderate:5.0 / low:0.0
  behavioral_score         = clamp(sum, 0.0, 100.0)

観察値フラグについて:
  is_elevated_risk: behavioral_score >= 60.0 の観察値フラグ。
    「高い行動バイアスリスクが数値的に観察された」という計算上の事実。
    is_buy / is_sell / is_hold / is_recommended のような売買命令ではない。
    Operation 層が実際の対応を決める。

設計原則:
  - 実際の売買制限・注文制限はしない（数値化のみ）
  - 実LLM/HTTP接続禁止
  - BUY/SELL/HOLD/WAIT 禁止
  - action/recommendation/is_buy/is_sell/is_hold/is_recommended/
    verdict/decision/rating/approve/reject/conditional 禁止
  - pandas/numpy 禁止
  - operation/market_intel/news/regime を直接 import しない

safe helpers:
  _safe_int():   None/str/NaN/inf → 0、それ以外は int 変換
  _safe_float(): None/str/NaN/inf → 0.0、それ以外は float 変換
  _clamp():      min/max クランプ

実装しないこと:
  - 実LLM/HTTP接続
  - BUY/SELL/HOLD/WAIT 判定
  - 3ヶ月売却不可ルールの実運用判断
  - 発注制限・注文ブロック
  - public/data writer

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 6-7
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field


# ── safe helpers ──────────────────────────────────────────────────────────────

def _safe_int(raw) -> int:
    """None / str / NaN / inf → 0。それ以外は int 変換（小数点は切り捨て）。"""
    if raw is None:
        return 0
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return 0
    if math.isnan(val) or math.isinf(val):
        return 0
    return int(val)


def _safe_float(raw) -> float:
    """None / str / NaN / inf → 0.0。それ以外は float 変換。"""
    if raw is None:
        return 0.0
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return 0.0
    if math.isnan(val) or math.isinf(val):
        return 0.0
    return val


def _clamp(val: float, lo: float, hi: float) -> float:
    """val を [lo, hi] に clamp する。"""
    return max(lo, min(hi, val))


# ── 定数 ─────────────────────────────────────────────────────────────────────

_VALID_COMMITTEE_RISK = frozenset({"low", "moderate", "high"})
_ELEVATED_RISK_THRESHOLD: float = 60.0


# ── BehavioralInput ───────────────────────────────────────────────────────────

@dataclass(frozen=True)
class BehavioralInput:
    """
    BehavioralScoreCalculator への入力。immutable。

    loss_streak:          連続損失回数（0 以上）
    recent_trade_count:   直近ウィンドウ内の取引件数（0 以上）
    average_volatility:   市況ボラティリティ（年率換算、0.0 以上）
    committee_risk_level: "low" / "moderate" / "high"（CommitteeReport から）
    regime:               "bull_calm" / "bull_volatile" / "bear" / "crisis" / "uncertain"
    context:              追加情報（任意）。mutable default 禁止のため default_factory。

    action/recommendation 等の判断フィールドは持たない。
    """

    loss_streak:          int
    recent_trade_count:   int
    average_volatility:   float
    committee_risk_level: str
    regime:               str
    context:              dict = field(default_factory=dict)


# ── BehavioralScoreResult ─────────────────────────────────────────────────────

@dataclass(frozen=True)
class BehavioralScoreResult:
    """
    行動バイアススコア計算結果。immutable。

    「行動バイアスリスクの数値化」であり売買命令ではない。

    behavioral_score: 0.0〜100.0（高いほど行動バイアスリスクが大きい）
    overtrade_risk:   0.0〜1.0（過剰売買リスク）
    loss_aversion_risk: 0.0〜1.0（損失回避バイアスリスク）
    caution_flags:    観察された懸念パターン（文字列 tuple）

    is_elevated_risk: 観察値フラグ。behavioral_score >= 60.0 のとき True。
      「高い行動バイアスリスクが数値的に観察された」という計算上の事実。
      is_buy / is_sell / is_hold / is_recommended のような売買命令ではない。
      Operation 層が実際の対応を決める。

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / rating / approve / reject / conditional
    """

    behavioral_score:   float           # 0.0〜100.0
    overtrade_risk:     float           # 0.0〜1.0
    loss_aversion_risk: float           # 0.0〜1.0
    caution_flags:      tuple[str, ...] # 観察された懸念パターン
    is_elevated_risk:   bool            # 観察値フラグ: behavioral_score >= 60.0

    def to_dict(self) -> dict:
        """JSON serializable な dict を返す（float / bool / list のみ）。"""
        return {
            "behavioral_score":   self.behavioral_score,
            "overtrade_risk":     self.overtrade_risk,
            "loss_aversion_risk": self.loss_aversion_risk,
            "caution_flags":      list(self.caution_flags),
            "is_elevated_risk":   self.is_elevated_risk,
        }


# ── BehavioralScoreCalculator ─────────────────────────────────────────────────

class BehavioralScoreCalculator:
    """
    行動バイアススコアを計算する。

    calculate() は pure computation: 入力値を受け取り BehavioralScoreResult を返す。
    売買判断・注文生成・発注制限は行わない。

    behavioral_score 計算:
      loss_aversion_component  = clamp(loss_streak * 15.0, 0.0, 45.0)
      overtrade_component      = clamp(recent_trade_count * 8.0, 0.0, 40.0)
      volatility_component     = clamp(average_volatility * 20.0, 0.0, 10.0)
      regime_component         = crisis:15.0 / bear:10.0 / bull_volatile:5.0 / others:0.0
      committee_component      = high:10.0 / moderate:5.0 / low:0.0
      behavioral_score         = clamp(sum, 0.0, 100.0)
    """

    ELEVATED_RISK_THRESHOLD: float = _ELEVATED_RISK_THRESHOLD

    def calculate(self, behavioral_input: BehavioralInput) -> BehavioralScoreResult:
        """
        行動バイアススコアを計算して BehavioralScoreResult を返す。

        Args:
            behavioral_input: BehavioralInput（全 DI）
        Returns:
            BehavioralScoreResult
        """
        # ── safe 変換 ─────────────────────────────────────────────────────────
        loss_streak        = max(0, _safe_int(behavioral_input.loss_streak))
        recent_trade_count = max(0, _safe_int(behavioral_input.recent_trade_count))
        average_volatility = max(0.0, _safe_float(behavioral_input.average_volatility))

        committee_risk = (
            behavioral_input.committee_risk_level
            if behavioral_input.committee_risk_level in _VALID_COMMITTEE_RISK
            else "low"
        )
        regime = behavioral_input.regime

        # ── 各コンポーネント計算 ──────────────────────────────────────────────
        loss_aversion_component = _clamp(loss_streak * 15.0, 0.0, 45.0)
        overtrade_component     = _clamp(recent_trade_count * 8.0, 0.0, 40.0)
        volatility_component    = _clamp(average_volatility * 20.0, 0.0, 10.0)

        regime_component_map = {
            "crisis":        15.0,
            "bear":          10.0,
            "bull_volatile":  5.0,
        }
        regime_component = regime_component_map.get(regime, 0.0)

        committee_component_map = {
            "high":     10.0,
            "moderate":  5.0,
            "low":       0.0,
        }
        committee_component = committee_component_map.get(committee_risk, 0.0)

        # ── behavioral_score ──────────────────────────────────────────────────
        behavioral_score = _clamp(
            loss_aversion_component
            + overtrade_component
            + volatility_component
            + regime_component
            + committee_component,
            0.0,
            100.0,
        )

        # ── サブリスク指標 ────────────────────────────────────────────────────
        overtrade_risk     = _clamp(recent_trade_count / 10.0, 0.0, 1.0)
        loss_aversion_risk = _clamp(loss_streak / 5.0, 0.0, 1.0)

        # ── caution_flags ─────────────────────────────────────────────────────
        flags: list[str] = []

        if loss_streak >= 3:
            flags.append(
                f"caution: loss_streak={loss_streak} — loss-aversion bias risk is elevated"
            )
        elif loss_streak >= 1:
            flags.append(
                f"caution: loss_streak={loss_streak} — monitor for loss-aversion bias"
            )

        if recent_trade_count >= 5:
            flags.append(
                f"caution: recent_trade_count={recent_trade_count} — overtrading risk is elevated"
            )
        elif recent_trade_count >= 3:
            flags.append(
                f"caution: recent_trade_count={recent_trade_count} — trading frequency is increasing"
            )

        if average_volatility >= 0.3:
            flags.append(
                f"caution: average_volatility={average_volatility:.3f} — high volatility may amplify behavioral biases"
            )

        if regime in ("crisis", "bear"):
            flags.append(
                f"caution: regime={regime} — adverse market conditions heighten emotional decision-making risk"
            )

        if committee_risk == "high":
            flags.append(
                "caution: committee_risk_level=high — committee analysis indicates elevated risk environment"
            )

        return BehavioralScoreResult(
            behavioral_score=behavioral_score,
            overtrade_risk=overtrade_risk,
            loss_aversion_risk=loss_aversion_risk,
            caution_flags=tuple(flags),
            is_elevated_risk=behavioral_score >= self.ELEVATED_RISK_THRESHOLD,
        )
