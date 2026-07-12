"""
short_long_split.py — Card 5-9R
Phase 5/6 Decision Engine: 短期 / 中長期 因子スコア並行分離層。

責務:
  - ShortLongResult  — short_term / long_term のスコアを保持する frozen dataclass
  - HorizonSplitter  — factor_scores dict を受け取り両 horizon のスコアを計算するクラス
  - _clamp_score()   — スコア値を [0, 100] に clamp するヘルパー

HorizonSplitter.split() 仕様:
  - factor_scores: dict[str, float] — 因子名 → スコア（0–100 期待値）
  - short_term_weights: dict[str, float] | None — None なら get_time_horizon_weights("short_term")
  - long_term_weights:  dict[str, float] | None — None なら get_time_horizon_weights("long_term")
  - weights.get(factor, 0.0) で安全アクセス（custom weights に canonical 因子欠損でも KeyError なし）
  - present_weight_sum > 0: weighted_sum / present_weight_sum（存在因子で正規化）
  - present_weight_sum == 0:
      存在因子 >= 1: 等重み平均
      存在因子 == 0: 50.0（中立値 fallback）
  - 欠損因子はスコアに暗黙ペナルティを与えない
  - 余分なキー（両 horizon に属さない因子）は無視

_clamp_score() 仕様:
  - float(value) に変換し max(0.0, min(100.0, val)) を返す
  - 変換失敗（None / str 等）は 50.0 fallback

ShortLongResult 仕様:
  - frozen=True（immutable）
  - short_term_score / long_term_score: float（0–100）
  - short_term_factor_count / long_term_factor_count: int（存在因子数）
  - short_term_missing_factors / long_term_missing_factors: tuple[str, ...]（canonical 順）
  - to_dict(): JSON serializable（float / int / str / list のみ）

実装しないこと:
  - BUY / SELL / HOLD / WAIT 等の判定
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended / rating
  - 3ヶ月売却不可ルールの実運用判断（Operation 層の責務）
  - short_long_blend（upper Decision layer の責務）
  - SnapshotBuilder / DecisionSnapshot への変更
  - 銘柄推奨・PF最適化
  - 実 LLM / HTTP / 外部 API
  - pandas / numpy
  - backend.engine.scoring / regime / operation / market_intel / news の import

[P2-SL1] factor_scores のキー（因子名）は caller が正しく供給する前提。
         typo（例: "technicalmomentum"）は無視され missing 扱いになる。
         Operation 層配線時に因子名マッピングを要確認。
[P2-SL2] short_term_score と long_term_score の blend 比率（何対何か）は
         上位 Decision Engine（Phase 6 agents/committee）が決定する。
         今回は 2値を独立して返すのみ。blend は行わない。
[P2-SL3] "regime" 因子のスコア供給元は未確定（regime detection layer の出力を
         calling layer が変換して渡す想定）。today は factor_scores["regime"] として
         呼び出し側に一任。Operation 層配線時に要確認。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 5-9
Reference: docs/v13.3/07_v13.3_spec.md Section 4.3
Reference: docs/constitution/REGIME.md Section 7
"""
from __future__ import annotations

from dataclasses import dataclass

from backend.engine.dynamic_weight.time_horizon_weights import (
    HORIZON_FACTORS,
    get_time_horizon_weights,
)

# ── ヘルパー ──────────────────────────────────────────────────────────────────

def _clamp_score(value) -> float:
    """
    任意の値を float に変換し [0, 100] に clamp して返す。
    変換失敗（None / str 等）は 50.0（中立値）に fallback。
    """
    try:
        val = float(value)
    except (TypeError, ValueError):
        return 50.0
    return max(0.0, min(100.0, val))


# ── DataClass ─────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ShortLongResult:
    """
    短期 / 中長期 の因子加重スコアを保持する。immutable。

    action / recommendation / is_buy / is_sell / is_hold /
    is_recommended / rating 等の判断フィールドは意図的に持たない。
    """

    short_term_score:           float          # 0–100、present-weight 正規化済み
    long_term_score:            float          # 0–100、present-weight 正規化済み
    short_term_factor_count:    int            # 入力に存在した short_term canonical 因子数
    long_term_factor_count:     int            # 入力に存在した long_term canonical 因子数
    short_term_missing_factors: tuple[str, ...]  # 欠損 canonical 因子（canonical 順）
    long_term_missing_factors:  tuple[str, ...]  # 欠損 canonical 因子（canonical 順）

    def to_dict(self) -> dict:
        """
        JSON serializable な dict を返す（float / int / str / list のみ）。
        """
        return {
            "short_term_score":           self.short_term_score,
            "long_term_score":            self.long_term_score,
            "short_term_factor_count":    self.short_term_factor_count,
            "long_term_factor_count":     self.long_term_factor_count,
            "short_term_missing_factors": list(self.short_term_missing_factors),
            "long_term_missing_factors":  list(self.long_term_missing_factors),
        }


# ── HorizonSplitter ───────────────────────────────────────────────────────────

class HorizonSplitter:
    """
    factor_scores dict を受け取り short_term / long_term の加重スコアを並行計算する。

    weights の DI:
      split() の short_term_weights / long_term_weights に dict を渡せば
      TIME_HORIZON_WEIGHTS の代わりにそちらを使用する。
      None の場合は get_time_horizon_weights() で取得したデフォルト重みを使用。

    weights に canonical 因子が欠けていても KeyError は発生しない（weights.get(f, 0.0)）。
    """

    def split(
        self,
        factor_scores:      dict[str, float],
        short_term_weights: dict[str, float] | None = None,
        long_term_weights:  dict[str, float] | None = None,
    ) -> ShortLongResult:
        """
        factor_scores を short_term / long_term に分離してスコアを計算する。

        Args:
            factor_scores:      因子名 → スコア（0–100 期待値。clamp 適用）
            short_term_weights: short_term 重み dict（None → get_time_horizon_weights 使用）
            long_term_weights:  long_term 重み dict（None → get_time_horizon_weights 使用）
        Returns:
            ShortLongResult
        """
        st_weights = (
            short_term_weights
            if short_term_weights is not None
            else get_time_horizon_weights("short_term")
        )
        lt_weights = (
            long_term_weights
            if long_term_weights is not None
            else get_time_horizon_weights("long_term")
        )

        # clamp 済みの factor_scores を作成
        clamped: dict[str, float] = {
            k: _clamp_score(v) for k, v in factor_scores.items()
        }

        short_term_score, st_count, st_missing = self._calc_horizon_score(
            clamped, HORIZON_FACTORS["short_term"], st_weights
        )
        long_term_score, lt_count, lt_missing = self._calc_horizon_score(
            clamped, HORIZON_FACTORS["long_term"], lt_weights
        )

        return ShortLongResult(
            short_term_score=short_term_score,
            long_term_score=long_term_score,
            short_term_factor_count=st_count,
            long_term_factor_count=lt_count,
            short_term_missing_factors=st_missing,
            long_term_missing_factors=lt_missing,
        )

    def _calc_horizon_score(
        self,
        clamped_scores:   dict[str, float],
        canonical_factors: tuple[str, ...],
        weights:           dict[str, float],
    ) -> tuple[float, int, tuple[str, ...]]:
        """
        1 horizon のスコア / 因子数 / 欠損因子を計算する。

        Returns:
            (score, factor_count, missing_factors)
        """
        present_factors = [f for f in canonical_factors if f in clamped_scores]
        missing_factors = tuple(f for f in canonical_factors if f not in clamped_scores)
        factor_count = len(present_factors)

        # present_weight_sum: 存在因子の重みの合計
        present_weight_sum = sum(
            weights.get(f, 0.0) for f in present_factors
        )

        if present_weight_sum > 0:
            weighted_sum = sum(
                weights.get(f, 0.0) * clamped_scores[f] for f in present_factors
            )
            score = weighted_sum / present_weight_sum
        elif factor_count > 0:
            # 等重み平均 fallback
            score = sum(clamped_scores[f] for f in present_factors) / factor_count
        else:
            # 存在因子ゼロ → 中立値 fallback
            score = 50.0

        # 浮動小数点誤差吸収のため出力もクランプ
        score = max(0.0, min(100.0, score))

        return score, factor_count, missing_factors
