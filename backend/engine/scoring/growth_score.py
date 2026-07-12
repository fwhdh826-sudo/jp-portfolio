"""
Growth Score — Card 5-3
Phase 5 6軸スコア: グロース軸スコアリング。

責務:
  - ScoreComponent     — 1成分（生値・正規化値・説明）を保持する frozen dataclass
  - AxisScore          — 4成分の集計結果を保持する frozen dataclass + to_dict()
  - MISSING_RAW_VALUES — 欠損時に使う成分ごとの中立 raw 値（正規化後 ≈ 50.0）
  - COMPONENT_WEIGHTS  — 4成分の重みテーブル（sum = 1.0）
  - GrowthScorer.calculate(ticker, financial_data, *, normalizer_fn)
                       — AxisScore を返す pure function 相当
  - GrowthScorer._normalize(comp_name, raw) — 07_spec 準拠の正規化（デフォルト）
  - GrowthScorer._get_raw(comp_name, data)  — dict lookup + 成分別 fallback
  - GrowthScorer._explain(comp_name, raw, normalized) — rule-based 日本語説明（1成分）
  - GrowthScorer._build_explanation(components, total) — rule-based 総合説明

正規化仕様（07_spec.md Section 1.1 準拠）:
  revenue_cagr_3y: clamp(x * 5, 0, 100)   # CAGR=10%→50 / CAGR=20%→100
  eps_growth_3y:   clamp(x * 4, 0, 100)   # EPS成長=12.5%→50 / 25%→100
  guidance:        clamp(x,     0, 100)   # passthrough (0〜100 直接スコア)
  tam_expansion:   clamp(x,     0, 100)   # passthrough (0〜100 直接スコア)

単位:
  revenue_cagr_3y / eps_growth_3y は % 単位（例: 10% → 10.0）
  guidance / tam_expansion は 0〜100 の直接スコア

欠損値方針:
  MISSING_RAW_VALUES に成分ごとの中立 raw 値を定義。
  各値は正規化後 ≈ 50.0 になるよう逆算している:
    revenue_cagr_3y: 10.0 * 5          = 50
    eps_growth_3y:   12.5 * 4          = 50
    guidance:        50.0 passthrough  = 50
    tam_expansion:   50.0 passthrough  = 50
  0.0 は有効値として扱い fallback しない。
  負値も有効値として扱い fallback しない（例: EPS 成長 = -5.0 は減益）。
  raw_value には fallback 時の中立 raw 値を格納する。

実装しないこと:
  - order_backlog 成分（07_spec.md Section 1.1 未定義）
  - 実 LLM / HTTP / 外部 API
  - pandas / numpy
  - backend.engine.regime / operation / market_intel / news の import
  - backend.engine.scoring.value_score / quality_score の import（共通化しない）
  - public/data writer / GitHub Actions 変更
  - 売買判断・銘柄推奨・PF 最適化

Reference: docs/v13.3/07_v13.3_spec.md Section 1.1
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 5-3
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

# ── 定数 ─────────────────────────────────────────────────────────────────────

# 欠損時に使う成分ごとの中立 raw 値。正規化後がそれぞれ ≈ 50.0 になるよう逆算。
MISSING_RAW_VALUES: dict[str, float] = {
    "revenue_cagr_3y": 10.0,   # 10.0 * 5         = 50
    "eps_growth_3y":   12.5,   # 12.5 * 4         = 50
    "guidance":        50.0,   # passthrough = 50
    "tam_expansion":   50.0,   # passthrough = 50
}


# ── DataClasses ───────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ScoreComponent:
    """1成分のスコア（生値・正規化値・説明）。immutable。"""

    name:        str    # "revenue_cagr_3y" など（COMPONENT_WEIGHTS のキー）
    weight:      float  # COMPONENT_WEIGHTS の値
    raw_value:   float  # 生値（欠損時は MISSING_RAW_VALUES の値）
    normalized:  float  # 0.0〜100.0
    description: str    # 人間向け説明（日本語、rule-based）


@dataclass(frozen=True)
class AxisScore:
    """グロース軸の集計スコア。immutable。"""

    axis:        str                         # "growth"
    name_ja:     str                         # "グロース"
    total:       float                       # 0.0〜100.0（加重平均、丸め前 float）
    components:  tuple[ScoreComponent, ...]  # 4成分（COMPONENT_WEIGHTS 定義順）
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


# ── GrowthScorer ──────────────────────────────────────────────────────────────

class GrowthScorer:
    """
    グロース軸スコアを計算する。

    financial_data は外部から注入される dict（実 DB / HTTP 呼び出しは行わない）。
    normalizer_fn を注入することでデフォルト正規化を差し替え可能（DI フック）。
    """

    AXIS_ID   = "growth"
    AXIS_NAME = "グロース"

    COMPONENT_WEIGHTS: dict[str, float] = {
        "revenue_cagr_3y": 0.40,
        "eps_growth_3y":   0.30,
        "guidance":        0.20,
        "tam_expansion":   0.10,
    }

    def calculate(
        self,
        ticker: str,
        financial_data: dict,
        *,
        normalizer_fn: Callable[[str, float], float] | None = None,
    ) -> AxisScore:
        """
        financial_data から 4 成分を計算し AxisScore を返す。

        Args:
            ticker:         銘柄コード（スコア計算には影響しない）
            financial_data: 成分 raw 値を含む dict。余分なキーは無視する。
                            期待キー: revenue_cagr_3y / eps_growth_3y /
                                      guidance / tam_expansion
                            revenue_cagr_3y / eps_growth_3y は % 単位（例: 10.0 = 10%）。
                            guidance / tam_expansion は 0〜100 の直接スコア。
                            キー欠損時は MISSING_RAW_VALUES を使用。
                            0.0 および負値も有効値として扱い fallback しない。
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
        07_spec.md Section 1.1 準拠の正規化。結果は 0.0〜100.0。
        未知の成分名は passthrough clamp。
        """
        if comp_name == "revenue_cagr_3y":
            return max(0.0, min(100.0, raw * 5.0))
        if comp_name == "eps_growth_3y":
            return max(0.0, min(100.0, raw * 4.0))
        if comp_name == "guidance":
            return max(0.0, min(100.0, raw))
        if comp_name == "tam_expansion":
            return max(0.0, min(100.0, raw))
        return max(0.0, min(100.0, raw))  # 未知成分: passthrough clamp

    # ── get_raw ───────────────────────────────────────────────────────────────

    def _get_raw(self, comp_name: str, data: dict) -> float:
        """
        data からキーを取得。
        キーが存在しない場合は MISSING_RAW_VALUES の中立 raw 値を返す。
        値が 0.0 や負値でも有効値として扱い fallback しない。
        """
        if comp_name in data:
            return float(data[comp_name])
        return MISSING_RAW_VALUES.get(comp_name, 50.0)

    # ── explain ───────────────────────────────────────────────────────────────

    _COMP_LABELS: dict[str, str] = {
        "revenue_cagr_3y": "売上CAGR",
        "eps_growth_3y":   "EPS成長率",
        "guidance":        "業績ガイダンス",
        "tam_expansion":   "TAM拡大性",
    }

    _COMP_UNITS: dict[str, str] = {
        "revenue_cagr_3y": "%",
        "eps_growth_3y":   "%",
    }

    _HIGH_LABELS: dict[str, str] = {
        "revenue_cagr_3y": "高成長",
        "eps_growth_3y":   "高EPS成長",
        "guidance":        "上方修正圧力",
        "tam_expansion":   "市場拡大余地大",
    }

    _LOW_LABELS: dict[str, str] = {
        "revenue_cagr_3y": "低成長",
        "eps_growth_3y":   "EPS低成長",
        "guidance":        "下方修正圧力",
        "tam_expansion":   "市場成熟",
    }

    def _explain(self, comp_name: str, raw: float, normalized: float) -> str:
        label = self._COMP_LABELS.get(comp_name, comp_name)
        unit  = self._COMP_UNITS.get(comp_name, "")

        if normalized >= 70.0:
            level = self._HIGH_LABELS.get(comp_name, "高水準")
        elif normalized >= 30.0:
            level = "標準水準"
        else:
            level = self._LOW_LABELS.get(comp_name, "低水準")

        return f"{label} {raw:.2f}{unit} — {level}（スコア{normalized:.0f}）"

    def _build_explanation(
        self,
        components: tuple[ScoreComponent, ...],
        total: float,
    ) -> str:
        if total >= 70.0:
            rating = "高成長"
        elif total >= 40.0:
            rating = "標準"
        else:
            rating = "低成長"

        sorted_comps = sorted(components, key=lambda c: c.normalized, reverse=True)
        top    = self._COMP_LABELS.get(sorted_comps[0].name,  sorted_comps[0].name)
        bottom = self._COMP_LABELS.get(sorted_comps[-1].name, sorted_comps[-1].name)

        return (
            f"グロースコア {total:.0f} — {top}が高評価、"
            f"{bottom}が相対的に低評価（{rating}水準）"
        )
