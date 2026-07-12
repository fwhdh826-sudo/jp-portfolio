"""
Safety Score — Card 5-4
Phase 5 6軸スコア: 安全性軸スコアリング。

責務:
  - ScoreComponent     — 1成分（生値・正規化値・説明）を保持する frozen dataclass
  - AxisScore          — 5成分の集計結果を保持する frozen dataclass + to_dict()
  - MISSING_RAW_VALUES — 欠損時に使う成分ごとの中立 raw 値（正規化後 ≈ 50.0）
  - COMPONENT_WEIGHTS  — 5成分の重みテーブル（sum = 1.0）
  - SafetyScorer.calculate(ticker, financial_data, *, normalizer_fn)
                       — AxisScore を返す pure function 相当
  - SafetyScorer._normalize(comp_name, raw) — 07_spec 準拠の正規化（デフォルト）
  - SafetyScorer._get_raw(comp_name, data)  — dict lookup + 成分別 fallback
  - SafetyScorer._explain(comp_name, raw, normalized) — rule-based 日本語説明（1成分）
  - SafetyScorer._build_explanation(components, total) — rule-based 総合説明

正規化仕様（07_spec.md Section 1.1 準拠）:
  equity_ratio:    clamp(x * 1.5,           0, 100)  # 33.3%→50 / 66.7%→100
  de_ratio:        clamp(100 - x * 40,      0, 100)  # D/E=1.25→50 / D/E=0→100 / D/E=2.5→0
  interest_cover:  clamp(x * 8,             0, 100)  # 6.25倍→50 / 12.5倍→100
  volatility_252d: clamp(100 - x * 200,     0, 100)  # 0.25→50 / 0.0→100 / 0.5→0
  beta_inverse:    clamp((1-x)*100 + 50,    0, 100)  # β=1.0→50 / β≤0.5→100 / β=1.5→0

単位:
  equity_ratio    は % 単位（例: 50% → 50.0）
  de_ratio        は倍率（例: D/E=1.25 → 1.25）
  interest_cover  は倍率（例: 6.25倍 → 6.25）
  volatility_252d は年率ボラティリティ小数単位（例: 25% → 0.25）
  beta_inverse    はβ値（例: β=1.0 → 1.0）

注意: de_ratio / volatility_252d / beta_inverse は低いほど高スコア（逆相関）。
      0.0 は fallback しない有効値（de_ratio=0→100点、volatility=0→100点）。

欠損値方針:
  MISSING_RAW_VALUES に成分ごとの中立 raw 値を定義。
  各値は正規化後 ≈ 50.0 になるよう逆算している:
    equity_ratio:    (100/3) * 1.5          ≈ 50  (float 精度で ≈50.0 ± 1e-6)
    de_ratio:        100 - 1.25*40          = 50
    interest_cover:  6.25 * 8               = 50
    volatility_252d: 100 - 0.25*200         = 50
    beta_inverse:    (1-1.0)*100+50         = 50
  0.0 は有効値として扱い fallback しない。
  raw_value には fallback 時の中立 raw 値を格納する。

実装しないこと:
  - 実 LLM / HTTP / 外部 API
  - pandas / numpy
  - backend.engine.regime / operation / market_intel / news の import
  - backend.engine.scoring.value_score / quality_score / growth_score の import（共通化しない）
  - public/data writer / GitHub Actions 変更
  - 売買判断・銘柄推奨・PF 最適化

Reference: docs/v13.3/07_v13.3_spec.md Section 1.1
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 5-4
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

# ── 定数 ─────────────────────────────────────────────────────────────────────

# 欠損時に使う成分ごとの中立 raw 値。正規化後がそれぞれ ≈ 50.0 になるよう逆算。
MISSING_RAW_VALUES: dict[str, float] = {
    "equity_ratio":    100.0 / 3.0,  # ≈33.3333 — (100/3)*1.5 ≈ 50.0 (float 誤差 ±1e-6)
    "de_ratio":        1.25,          # 100 - 1.25*40       = 50.0
    "interest_cover":  6.25,          # 6.25*8              = 50.0
    "volatility_252d": 0.25,          # 100 - 0.25*200      = 50.0
    "beta_inverse":    1.0,           # (1-1.0)*100+50      = 50.0
}


# ── DataClasses ───────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ScoreComponent:
    """1成分のスコア（生値・正規化値・説明）。immutable。"""

    name:        str    # "equity_ratio" など（COMPONENT_WEIGHTS のキー）
    weight:      float  # COMPONENT_WEIGHTS の値
    raw_value:   float  # 生値（欠損時は MISSING_RAW_VALUES の値）
    normalized:  float  # 0.0〜100.0
    description: str    # 人間向け説明（日本語、rule-based）


@dataclass(frozen=True)
class AxisScore:
    """安全性軸の集計スコア。immutable。"""

    axis:        str                         # "safety"
    name_ja:     str                         # "安全性"
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


# ── SafetyScorer ──────────────────────────────────────────────────────────────

class SafetyScorer:
    """
    安全性軸スコアを計算する。

    financial_data は外部から注入される dict（実 DB / HTTP 呼び出しは行わない）。
    normalizer_fn を注入することでデフォルト正規化を差し替え可能（DI フック）。

    注意: de_ratio / volatility_252d / beta_inverse は低いほど高スコア（逆相関）。
    0.0 は有効値として扱い fallback しない。
    """

    AXIS_ID   = "safety"
    AXIS_NAME = "安全性"

    COMPONENT_WEIGHTS: dict[str, float] = {
        "equity_ratio":    0.30,
        "de_ratio":        0.25,
        "interest_cover":  0.20,
        "volatility_252d": 0.15,
        "beta_inverse":    0.10,
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
                            期待キー: equity_ratio / de_ratio / interest_cover /
                                      volatility_252d / beta_inverse
                            equity_ratio    は % 単位（例: 50.0 = 50%）。
                            de_ratio        は倍率（例: 1.25）。
                            interest_cover  は倍率（例: 6.25）。
                            volatility_252d は年率ボラ小数（例: 0.25 = 25%年率）。
                            beta_inverse    はβ値（例: 1.0）。
                            キー欠損時は MISSING_RAW_VALUES を使用。
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
        07_spec.md Section 1.1 準拠の正規化。結果は 0.0〜100.0。
        未知の成分名は passthrough clamp。
        """
        if comp_name == "equity_ratio":
            return max(0.0, min(100.0, raw * 1.5))
        if comp_name == "de_ratio":
            return max(0.0, min(100.0, 100.0 - raw * 40.0))
        if comp_name == "interest_cover":
            return max(0.0, min(100.0, raw * 8.0))
        if comp_name == "volatility_252d":
            return max(0.0, min(100.0, 100.0 - raw * 200.0))
        if comp_name == "beta_inverse":
            return max(0.0, min(100.0, (1.0 - raw) * 100.0 + 50.0))
        return max(0.0, min(100.0, raw))  # 未知成分: passthrough clamp

    # ── get_raw ───────────────────────────────────────────────────────────────

    def _get_raw(self, comp_name: str, data: dict) -> float:
        """
        data からキーを取得。
        キーが存在しない場合は MISSING_RAW_VALUES の中立 raw 値を返す。
        値が 0.0 でも有効値として扱い fallback しない。
        """
        if comp_name in data:
            return float(data[comp_name])
        return MISSING_RAW_VALUES.get(comp_name, 50.0)

    # ── explain ───────────────────────────────────────────────────────────────

    _COMP_LABELS: dict[str, str] = {
        "equity_ratio":    "自己資本比率",
        "de_ratio":        "D/Eレシオ",
        "interest_cover":  "インタレストカバレッジ",
        "volatility_252d": "ボラティリティ",
        "beta_inverse":    "ベータ逆数",
    }

    _COMP_UNITS: dict[str, str] = {
        "equity_ratio": "%",
    }

    _HIGH_LABELS: dict[str, str] = {
        "equity_ratio":    "財務健全",
        "de_ratio":        "低レバレッジ",
        "interest_cover":  "高カバレッジ",
        "volatility_252d": "低ボラ",
        "beta_inverse":    "低ベータ",
    }

    _LOW_LABELS: dict[str, str] = {
        "equity_ratio":    "財務脆弱",
        "de_ratio":        "高レバレッジ",
        "interest_cover":  "低カバレッジ",
        "volatility_252d": "高ボラ",
        "beta_inverse":    "高ベータ",
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
            rating = "安全"
        elif total >= 40.0:
            rating = "標準"
        else:
            rating = "要注意"

        sorted_comps = sorted(components, key=lambda c: c.normalized, reverse=True)
        top    = self._COMP_LABELS.get(sorted_comps[0].name,  sorted_comps[0].name)
        bottom = self._COMP_LABELS.get(sorted_comps[-1].name, sorted_comps[-1].name)

        return (
            f"安全性スコア {total:.0f} — {top}が高評価、"
            f"{bottom}が相対的に低評価（{rating}水準）"
        )
