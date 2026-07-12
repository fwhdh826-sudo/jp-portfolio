"""
fund_short_term_risk.py — Card 6-8
Phase 6 Behavioral: 投信用短期環境リスク観察スコア計算層。

責務:
  - FundShortTermInput      — 計算への入力を保持する frozen dataclass
  - FundShortTermResult     — 計算結果を保持する frozen dataclass
  - FundShortTermCalculator — calculate() で FundShortTermResult を返すクラス

4条件仕様（観察値）:
  vix_condition     = vix > 35.0
  panic_condition   = nikkei_5d_return < -0.08
  oversold_condition = nikkei_rsi_14 < 30.0
  volume_condition  = nikkei_volume_ratio > 2.0
  conditions_met_count = 上記 True 数
  is_four_condition_environment = conditions_met_count >= 4
  is_three_condition_environment = conditions_met_count >= 3

ブルベアルール閾値（観察値）:
  profit_threshold_met      = current_return >= 0.05
  loss_threshold_met        = current_return <= -0.028
  holding_days_threshold    = days_since_entry >= 2
  bull_bear_threshold_observed =
      holding_days_threshold and (profit_threshold_met or loss_threshold_met)
  「ブルベアルール系の閾値が数値的に観察された」という事実のみ。
  売却指示・利確指示・損切り指示ではない。

確信度（観察値）:
  os_confidence_score      = clamp(os_confidence, 0.0, 1.0)
  is_confidence_sufficient = os_confidence_score >= 0.9
  「確信度が90%以上だった」という観察値。実行判定ではない。

fund_short_term_environment_score 計算:
  condition_component          = conditions_met_count * 20.0
  confidence_component         = os_confidence_score * 10.0
  sq_component:
    0 <= sq_proximity_days <= 2 → 5.0
    3 <= sq_proximity_days <= 5 → 3.0
    otherwise                   → 0.0
  volatility_spread_component:
    abs(volatility_spread) >= 5.0 → 5.0
    otherwise                      → 0.0
  fund_short_term_environment_score = clamp(sum, 0.0, 100.0)

  このスコアは観察スコアであり、BUY / SELL / HOLD / WAIT ではない。

safe fallback:
  vix:                 invalid → 0.0
  nikkei_5d_return:    invalid → 0.0
  nikkei_rsi_14:       invalid → 50.0
  nikkei_volume_ratio: invalid → 1.0
  current_return:      invalid → 0.0
  days_since_entry:    invalid → 0
  os_confidence:       invalid → 0.0 (clamp 0.0〜1.0)
  nikkei_vi:           invalid → 0.0
  sq_proximity_days:   invalid → -1

観察値フラグについて:
  is_four_condition_environment:  「4条件が数値的に観察された」という事実フラグ。
  is_three_condition_environment: 「3条件以上が数値的に観察された」という事実フラグ。
  bull_bear_threshold_observed:   「ブルベアルール閾値が数値的に観察された」という事実フラグ。
  is_confidence_sufficient:       「確信度が0.9以上だった」という観察事実フラグ。
  いずれも is_buy / is_sell / is_hold / is_recommended のような売買命令ではない。
  実際の発注・売却・保有継続の判断は Operation 層の責務。

設計原則:
  - 実際の売買制限・注文制限はしない（数値化のみ）
  - 実LLM/HTTP接続禁止
  - BUY/SELL/HOLD/WAIT 禁止
  - action/recommendation/is_buy/is_sell/is_hold/is_recommended/
    verdict/decision/rating/approve/reject/conditional 禁止
  - pandas/numpy 禁止（math / datetime stdlib のみ使用）
  - operation/market_intel/news/regime を直接 import しない

実装しないこと:
  - 実LLM/HTTP接続
  - 実注文生成・発注制限
  - BUY/SELL/HOLD/WAIT 判定
  - 3ヶ月売却不可ルールの実運用判断
  - コア/サテライト分離（PF配分変更）
  - 待機後続勝率トラッキング（Phase 9）
  - public/data writer

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 6-8
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field


# ── safe helpers ──────────────────────────────────────────────────────────────

def _safe_float(raw, fallback: float = 0.0) -> float:
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


def _safe_int(raw, fallback: int = 0) -> int:
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


def _clamp(val: float, lo: float, hi: float) -> float:
    """val を [lo, hi] に clamp する。"""
    return max(lo, min(hi, val))


# ── 定数 ─────────────────────────────────────────────────────────────────────

VIX_THRESHOLD:              float = 35.0
PANIC_RETURN_THRESHOLD:     float = -0.08
RSI_OVERSOLD_THRESHOLD:     float = 30.0
VOLUME_RATIO_THRESHOLD:     float = 2.0

PROFIT_THRESHOLD:           float = 0.05
LOSS_THRESHOLD:             float = -0.028
HOLDING_DAYS_THRESHOLD:     int   = 2

CONFIDENCE_THRESHOLD:       float = 0.9
VOLATILITY_SPREAD_THRESHOLD: float = 5.0

SQ_VERY_NEAR_MAX:           int   = 2
SQ_NEAR_MAX:                int   = 5


# ── FundShortTermInput ────────────────────────────────────────────────────────

@dataclass(frozen=True)
class FundShortTermInput:
    """
    FundShortTermCalculator への入力。immutable。

    vix:                 VIX 指数
    nikkei_5d_return:    日経225 5日リターン（例: -0.08 = -8%）
    nikkei_rsi_14:       日経225 RSI(14)
    nikkei_volume_ratio: 出来高 / 60日平均（例: 2.1 = 2.1倍）
    current_return:      保有投信の含み損益率（例: 0.06 = +6%）
    days_since_entry:    保有日数
    os_confidence:       CommitteeReport.aggregate_confidence (0.0〜1.0)
    nikkei_vi:           日経VI（オプション。0.0 = 不明扱い）
    sq_proximity_days:   SQ まで何日（-1 = 不明）
    context:             追加情報（任意）

    action/recommendation 等の判断フィールドは持たない。
    """

    vix:                 float
    nikkei_5d_return:    float
    nikkei_rsi_14:       float
    nikkei_volume_ratio: float
    current_return:      float
    days_since_entry:    int
    os_confidence:       float
    nikkei_vi:           float = 0.0
    sq_proximity_days:   int   = -1
    context:             dict  = field(default_factory=dict)


# ── FundShortTermResult ───────────────────────────────────────────────────────

@dataclass(frozen=True)
class FundShortTermResult:
    """
    投信用短期環境リスク観察スコア計算結果。immutable。

    「投信短期環境の数値化」であり売買命令ではない。

    ── 4条件観察値 ──
    conditions_met_count:          成立条件数（0〜4）
    vix_condition:                 vix > 35.0 の観察値
    panic_condition:               nikkei_5d_return < -0.08 の観察値
    oversold_condition:            nikkei_rsi_14 < 30.0 の観察値
    volume_condition:              nikkei_volume_ratio > 2.0 の観察値
    is_four_condition_environment: 観察値フラグ: conditions_met_count >= 4
    is_three_condition_environment: 観察値フラグ: conditions_met_count >= 3

    ── ブルベアルール閾値観察値 ──
    profit_threshold_met:      current_return >= 0.05 の観察値
    loss_threshold_met:        current_return <= -0.028 の観察値
    holding_days_threshold:    days_since_entry >= 2 の観察値
    bull_bear_threshold_observed: 観察値フラグ（閾値複合）。売却命令ではない。

    ── 確信度観察値 ──
    os_confidence_score:      0.0〜1.0（clamp）
    is_confidence_sufficient: 観察値フラグ: os_confidence_score >= 0.9

    ── 補助指標 ──
    volatility_spread:   nikkei_vi - vix（safe float）
    sq_proximity_days:   SQ まで日数（-1 = 不明）

    ── 総合スコア ──
    fund_short_term_environment_score: 0.0〜100.0
      投信用短期環境観察スコア。高いほど「条件が多く観察された」。
      BUY / SELL / HOLD / WAIT ではない。

    caution_flags: 観察された状態パターン（文字列 tuple）

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / rating / approve / reject / conditional /
      final_verdict / order / amount / entry_price / stop_loss / take_profit
    """

    # 4条件
    conditions_met_count:           int
    vix_condition:                   bool
    panic_condition:                 bool
    oversold_condition:              bool
    volume_condition:                bool
    is_four_condition_environment:   bool  # 観察値フラグ: conditions_met_count >= 4
    is_three_condition_environment:  bool  # 観察値フラグ: conditions_met_count >= 3

    # ブルベアルール閾値
    profit_threshold_met:            bool  # 観察値: current_return >= 0.05
    loss_threshold_met:              bool  # 観察値: current_return <= -0.028
    holding_days_threshold:          bool  # 観察値: days_since_entry >= 2
    bull_bear_threshold_observed:    bool  # 観察値フラグ（閾値複合）。売却命令ではない。

    # 確信度
    os_confidence_score:             float  # 0.0〜1.0
    is_confidence_sufficient:        bool   # 観察値フラグ: score >= 0.9

    # 補助指標
    volatility_spread:               float
    sq_proximity_days:               int

    # 総合スコア
    fund_short_term_environment_score: float  # 0.0〜100.0

    caution_flags:                   tuple[str, ...]

    def to_dict(self) -> dict:
        """JSON serializable な dict を返す（int / float / bool / list のみ）。"""
        return {
            "conditions_met_count":            self.conditions_met_count,
            "vix_condition":                   self.vix_condition,
            "panic_condition":                 self.panic_condition,
            "oversold_condition":              self.oversold_condition,
            "volume_condition":                self.volume_condition,
            "is_four_condition_environment":   self.is_four_condition_environment,
            "is_three_condition_environment":  self.is_three_condition_environment,
            "profit_threshold_met":            self.profit_threshold_met,
            "loss_threshold_met":              self.loss_threshold_met,
            "holding_days_threshold":          self.holding_days_threshold,
            "bull_bear_threshold_observed":    self.bull_bear_threshold_observed,
            "os_confidence_score":             self.os_confidence_score,
            "is_confidence_sufficient":        self.is_confidence_sufficient,
            "volatility_spread":               self.volatility_spread,
            "sq_proximity_days":               self.sq_proximity_days,
            "fund_short_term_environment_score": self.fund_short_term_environment_score,
            "caution_flags":                   list(self.caution_flags),
        }


# ── FundShortTermCalculator ───────────────────────────────────────────────────

class FundShortTermCalculator:
    """
    投信用短期環境リスク観察スコアを計算する。

    calculate() は pure computation: 入力値を受け取り FundShortTermResult を返す。
    売買判断・注文生成・発注制限は行わない。

    fund_short_term_environment_score 計算:
      condition_component  = conditions_met_count * 20.0
      confidence_component = os_confidence_score * 10.0
      sq_component:
        0 <= sq_proximity_days <= 2 → 5.0
        3 <= sq_proximity_days <= 5 → 3.0
        otherwise                   → 0.0
      volatility_spread_component:
        abs(volatility_spread) >= 5.0 → 5.0
        otherwise                      → 0.0
      fund_short_term_environment_score = clamp(sum, 0.0, 100.0)
    """

    VIX_THRESHOLD:               float = VIX_THRESHOLD
    PANIC_RETURN_THRESHOLD:      float = PANIC_RETURN_THRESHOLD
    RSI_OVERSOLD_THRESHOLD:      float = RSI_OVERSOLD_THRESHOLD
    VOLUME_RATIO_THRESHOLD:      float = VOLUME_RATIO_THRESHOLD
    PROFIT_THRESHOLD:            float = PROFIT_THRESHOLD
    LOSS_THRESHOLD:              float = LOSS_THRESHOLD
    HOLDING_DAYS_THRESHOLD:      int   = HOLDING_DAYS_THRESHOLD
    CONFIDENCE_THRESHOLD:        float = CONFIDENCE_THRESHOLD
    VOLATILITY_SPREAD_THRESHOLD: float = VOLATILITY_SPREAD_THRESHOLD

    def calculate(self, fund_input: FundShortTermInput) -> FundShortTermResult:
        """
        投信用短期環境リスク観察スコアを計算して FundShortTermResult を返す。

        Args:
            fund_input: FundShortTermInput（全 DI）
        Returns:
            FundShortTermResult
        """
        # ── safe 変換 ─────────────────────────────────────────────────────────
        vix                 = _safe_float(fund_input.vix,                 0.0)
        nikkei_5d_return    = _safe_float(fund_input.nikkei_5d_return,    0.0)
        nikkei_rsi_14       = _safe_float(fund_input.nikkei_rsi_14,       50.0)
        nikkei_volume_ratio = _safe_float(fund_input.nikkei_volume_ratio, 1.0)
        current_return      = _safe_float(fund_input.current_return,      0.0)
        days_since_entry    = _safe_int(fund_input.days_since_entry,      0)
        os_confidence       = _clamp(_safe_float(fund_input.os_confidence, 0.0), 0.0, 1.0)
        nikkei_vi           = _safe_float(fund_input.nikkei_vi,           0.0)
        sq_proximity_days   = _safe_int(fund_input.sq_proximity_days,     -1)

        # ── 4条件 ─────────────────────────────────────────────────────────────
        vix_condition      = vix > self.VIX_THRESHOLD
        panic_condition    = nikkei_5d_return < self.PANIC_RETURN_THRESHOLD
        oversold_condition = nikkei_rsi_14 < self.RSI_OVERSOLD_THRESHOLD
        volume_condition   = nikkei_volume_ratio > self.VOLUME_RATIO_THRESHOLD

        conditions_met_count = sum([
            vix_condition,
            panic_condition,
            oversold_condition,
            volume_condition,
        ])

        is_four_condition_environment  = conditions_met_count >= 4
        is_three_condition_environment = conditions_met_count >= 3

        # ── ブルベアルール閾値（観察値）────────────────────────────────────────
        profit_threshold_met   = current_return >= self.PROFIT_THRESHOLD
        loss_threshold_met     = current_return <= self.LOSS_THRESHOLD
        holding_days_threshold = days_since_entry >= self.HOLDING_DAYS_THRESHOLD
        bull_bear_threshold_observed = holding_days_threshold and (
            profit_threshold_met or loss_threshold_met
        )

        # ── 確信度（観察値）───────────────────────────────────────────────────
        os_confidence_score      = os_confidence
        is_confidence_sufficient = os_confidence_score >= self.CONFIDENCE_THRESHOLD

        # ── 補助指標 ──────────────────────────────────────────────────────────
        volatility_spread = nikkei_vi - vix

        # ── fund_short_term_environment_score ─────────────────────────────────
        condition_component  = conditions_met_count * 20.0
        confidence_component = os_confidence_score * 10.0

        if 0 <= sq_proximity_days <= SQ_VERY_NEAR_MAX:
            sq_component = 5.0
        elif SQ_VERY_NEAR_MAX < sq_proximity_days <= SQ_NEAR_MAX:
            sq_component = 3.0
        else:
            sq_component = 0.0

        volatility_spread_component = (
            5.0 if abs(volatility_spread) >= self.VOLATILITY_SPREAD_THRESHOLD else 0.0
        )

        fund_short_term_environment_score = _clamp(
            condition_component
            + confidence_component
            + sq_component
            + volatility_spread_component,
            0.0,
            100.0,
        )

        # ── caution_flags ─────────────────────────────────────────────────────
        flags: list[str] = []

        if is_four_condition_environment:
            flags.append(
                "observation: four short-term conditions present"
            )
        elif is_three_condition_environment:
            flags.append(
                "observation: three or more short-term conditions present"
            )

        if bull_bear_threshold_observed:
            flags.append(
                "observation: bull/bear threshold observed; not an exit instruction"
            )

        if is_confidence_sufficient:
            flags.append(
                "observation: confidence threshold observed"
            )

        if 0 <= sq_proximity_days <= SQ_VERY_NEAR_MAX:
            flags.append(
                "observation: SQ proximity is very near"
            )

        if abs(volatility_spread) >= self.VOLATILITY_SPREAD_THRESHOLD:
            flags.append(
                "observation: volatility spread is elevated"
            )

        return FundShortTermResult(
            conditions_met_count=conditions_met_count,
            vix_condition=vix_condition,
            panic_condition=panic_condition,
            oversold_condition=oversold_condition,
            volume_condition=volume_condition,
            is_four_condition_environment=is_four_condition_environment,
            is_three_condition_environment=is_three_condition_environment,
            profit_threshold_met=profit_threshold_met,
            loss_threshold_met=loss_threshold_met,
            holding_days_threshold=holding_days_threshold,
            bull_bear_threshold_observed=bull_bear_threshold_observed,
            os_confidence_score=os_confidence_score,
            is_confidence_sufficient=is_confidence_sufficient,
            volatility_spread=volatility_spread,
            sq_proximity_days=sq_proximity_days,
            fund_short_term_environment_score=fund_short_term_environment_score,
            caution_flags=tuple(flags),
        )
