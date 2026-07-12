"""
Momentum Score — Card 5-5
Phase 5 6軸スコア: モメンタム軸スコアリング。

責務:
  - ScoreComponent     — 1成分（生値・正規化値・説明）を保持する frozen dataclass
  - AxisScore          — 5成分の集計結果を保持する frozen dataclass + to_dict()
  - MISSING_RAW_VALUES — 欠損時に使う成分ごとの中立 raw 値（正規化後 = 50.0）
  - COMPONENT_WEIGHTS  — 5成分の重みテーブル（sum = 1.0）
  - MomentumScorer.calculate(ticker, financial_data, *, normalizer_fn)
                       — AxisScore を返す pure function 相当
  - MomentumScorer._normalize(comp_name, raw) — passthrough clamp(x, 0, 100)
  - MomentumScorer._get_raw(comp_name, data)  — dict lookup + 成分別 fallback
  - MomentumScorer._explain(comp_name, raw, normalized) — rule-based 日本語説明
  - MomentumScorer._build_explanation(components, total) — rule-based 総合説明

正規化仕様（07_spec.md Section 1.1 準拠）:
  全5成分: clamp(x, 0, 100)  — passthrough（呼び出し側が 0〜100 に変換済み）

  07_spec.md の Momentum 軸定義は他軸と異なり "norm" フィールドを持たず
  "source" フィールドのみを持つ。これは正規化が呼び出し側（technical_suite）の
  責務であることを示している。MomentumScorer は変換済みスコアを受け取る。

入力仕様:
  trend_score:       MAアライメントを 0〜100 に変換済みのスコア
  ma_spread:         200MA乖離を 0〜100 に変換済みのスコア
  credit_ratio:      信用倍率を 0〜100 に変換済みのスコア
  volume_z:          出来高 Z-score 60d を 0〜100 に変換済みのスコア
  relative_strength: TOPIX 比相対強度を 0〜100 に変換済みのスコア

欠損値方針:
  全成分の MISSING_RAW_VALUES = 50.0（passthrough のため中立値は 50.0 のみ）。
  0.0 は有効値として扱い fallback しない。

実装しないこと:
  - MA / RSI / MACD / 出来高Z / 信用倍率などの実テクニカル計算
  - technical_suite / technical モジュールの作成・import
  - 実 LLM / HTTP / 外部 API
  - pandas / numpy
  - backend.engine.regime / operation / market_intel / news の import
  - backend.engine.scoring.value_score / quality_score / growth_score / safety_score の import
  - public/data writer / GitHub Actions 変更
  - 売買判断・銘柄推奨・PF 最適化

Reference: docs/v13.3/07_v13.3_spec.md Section 1.1
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 5-5
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

# ── 定数 ─────────────────────────────────────────────────────────────────────

# 全成分 passthrough のため中立 raw 値は全て 50.0。
MISSING_RAW_VALUES: dict[str, float] = {
    "trend_score":       50.0,   # passthrough clamp(50, 0, 100) = 50
    "ma_spread":         50.0,   # passthrough clamp(50, 0, 100) = 50
    "credit_ratio":      50.0,   # passthrough clamp(50, 0, 100) = 50
    "volume_z":          50.0,   # passthrough clamp(50, 0, 100) = 50
    "relative_strength": 50.0,   # passthrough clamp(50, 0, 100) = 50
}


# ── DataClasses ───────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ScoreComponent:
    """1成分のスコア（生値・正規化値・説明）。immutable。"""

    name:        str    # "trend_score" など（COMPONENT_WEIGHTS のキー）
    weight:      float  # COMPONENT_WEIGHTS の値
    raw_value:   float  # 生値（欠損時は MISSING_RAW_VALUES の値）
    normalized:  float  # 0.0〜100.0
    description: str    # 人間向け説明（日本語、rule-based）


@dataclass(frozen=True)
class AxisScore:
    """モメンタム軸の集計スコア。immutable。"""

    axis:        str                         # "momentum"
    name_ja:     str                         # "モメンタム"
    total:       float                       # 0.0〜100.0（加重平均、丸め前 float）
    components:  tuple[ScoreComponent, ...]  # 5成分（COMPONENT_WEIGHTS 定義順）
    explanation: str                         # 総合日本語説明（rule-based）

    def to_dict(self) -> dict:
        """
        Phase 6+ の calc_total_score_dynamic(axes, regime) が期待する形式。
        total は round() で int に丸める（07_spec 準拠）。
        """
        return {
            "axis":        self.axis,
            "name_ja":     self.name_ja,
            "total":       round(self.total),
            "components": [
                {
                    "name":        c.name,
                    "weight":      c.weight,
                    "raw_value":   c.raw_value,
                    "normalized":  c.normalized,
                    "description": c.description,
                }
                for c in self.components
            ],
            "explanation": self.explanation,
        }


# ── MomentumScorer ────────────────────────────────────────────────────────────

class MomentumScorer:
    """
    モメンタム軸スコアを計算する。

    financial_data には呼び出し側（technical_suite 等）が 0〜100 に変換済みの
    スコアを渡す。MomentumScorer 自体はテクニカル指標の計算を行わない。
    normalizer_fn を注入することでデフォルト正規化を差し替え可能（DI フック）。
    """

    AXIS_ID   = "momentum"
    AXIS_NAME = "モメンタム"

    COMPONENT_WEIGHTS: dict[str, float] = {
        "trend_score":       0.30,
        "ma_spread":         0.25,
        "credit_ratio":      0.20,
        "volume_z":          0.15,
        "relative_strength": 0.10,
    }

    def calculate(
        self,
        ticker: str,
        financial_data: dict,
        *,
        normalizer_fn: Callable[[str, float], float] | None = None,
    ) -> AxisScore:
        """
        financial_data から 5 成分を計算し AxisScore を返す。

        Args:
            ticker:         銘柄コード（スコア計算には影響しない）
            financial_data: 成分 raw 値を含む dict。余分なキーは無視する。
                            期待キー: trend_score / ma_spread / credit_ratio /
                                      volume_z / relative_strength
                            全成分は 0〜100 に変換済みの外部スコア。
                            キー欠損時は MISSING_RAW_VALUES（50.0）を使用。
                            0.0 は有効値として扱い fallback しない。
            normalizer_fn:  (comp_name: str, raw: float) -> float の DI フック。
                            None のとき self._normalize() を使用。
        """
        _norm = normalizer_fn if normalizer_fn is not None else self._normalize

        components_list: list[ScoreComponent] = []
        for comp_name, weight in self.COMPONENT_WEIGHTS.items():
            raw        = self._get_raw(comp_name, financial_data)
            normalized = _norm(comp_name, raw)
            desc       = self._explain(comp_name, raw, normalized)
            components_list.append(
                ScoreComponent(
                    name=comp_name,
                    weight=weight,
                    raw_value=raw,
                    normalized=normalized,
                    description=desc,
                )
            )

        components  = tuple(components_list)
        total       = sum(c.normalized * c.weight for c in components)
        explanation = self._build_explanation(components, total)

        return AxisScore(
            axis=self.AXIS_ID,
            name_ja=self.AXIS_NAME,
            total=total,
            components=components,
            explanation=explanation,
        )

    # ── normalize ─────────────────────────────────────────────────────────────

    def _normalize(self, comp_name: str, raw: float) -> float:
        """
        全成分 passthrough clamp(x, 0, 100)。
        呼び出し側が 0〜100 変換済みのスコアを渡す前提のため、
        MomentumScorer はテクニカル計算を行わない。
        """
        return max(0.0, min(100.0, raw))

    # ── get_raw ───────────────────────────────────────────────────────────────

    def _get_raw(self, comp_name: str, data: dict) -> float:
        """
        data からキーを取得。
        キーが存在しない場合は MISSING_RAW_VALUES の中立 raw 値（50.0）を返す。
        値が 0.0 でも有効値として扱い fallback しない。
        """
        if comp_name in data:
            return float(data[comp_name])
        return MISSING_RAW_VALUES.get(comp_name, 50.0)

    # ── explain ───────────────────────────────────────────────────────────────

    _COMP_LABELS: dict[str, str] = {
        "trend_score":       "トレンドスコア",
        "ma_spread":         "MA乖離",
        "credit_ratio":      "信用倍率",
        "volume_z":          "出来高Z",
        "relative_strength": "相対強度",
    }

    _HIGH_LABELS: dict[str, str] = {
        "trend_score":       "上昇トレンド",
        "ma_spread":         "MA上方乖離",
        "credit_ratio":      "需給良好",
        "volume_z":          "出来高増加",
        "relative_strength": "市場アウトパフォーム",
    }

    _LOW_LABELS: dict[str, str] = {
        "trend_score":       "下降トレンド",
        "ma_spread":         "MA下方乖離",
        "credit_ratio":      "需給悪化",
        "volume_z":          "出来高低迷",
        "relative_strength": "市場アンダーパフォーム",
    }

    def _explain(self, comp_name: str, raw: float, normalized: float) -> str:
        label = self._COMP_LABELS.get(comp_name, comp_name)

        if normalized >= 70.0:
            level = self._HIGH_LABELS.get(comp_name, "高水準")
        elif normalized >= 30.0:
            level = "標準水準"
        else:
            level = self._LOW_LABELS.get(comp_name, "低水準")

        return f"{label} {raw:.2f} — {level}（スコア{normalized:.0f}）"

    def _build_explanation(
        self,
        components: tuple[ScoreComponent, ...],
        total: float,
    ) -> str:
        if total >= 70.0:
            rating = "強いモメンタム"
        elif total >= 40.0:
            rating = "標準"
        else:
            rating = "弱いモメンタム"

        sorted_comps = sorted(components, key=lambda c: c.normalized, reverse=True)
        top    = self._COMP_LABELS.get(sorted_comps[0].name,  sorted_comps[0].name)
        bottom = self._COMP_LABELS.get(sorted_comps[-1].name, sorted_comps[-1].name)

        return (
            f"モメンタムスコア {total:.0f} — {top}が高評価、"
            f"{bottom}が相対的に低評価（{rating}水準）"
        )
