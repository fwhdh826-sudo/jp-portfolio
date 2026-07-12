"""
Shareholder Return Score — Card 5-6
Phase 5 6軸スコア: 還元力軸スコアリング。

責務:
  - ScoreComponent           — 1成分（生値・正規化値・説明）を保持する frozen dataclass
  - AxisScore                — 5成分の集計結果を保持する frozen dataclass + to_dict()
  - MISSING_RAW_VALUES       — 欠損時に使う成分ごとの中立 raw 値（正規化後 ≈ 50.0）
  - COMPONENT_WEIGHTS        — 5成分の重みテーブル（sum = 1.0）
  - ShareholderReturnScorer.calculate(ticker, financial_data, *, normalizer_fn)
                             — AxisScore を返す pure function 相当
  - ShareholderReturnScorer._normalize(comp_name, raw) — 07_spec 準拠の正規化（デフォルト）
  - ShareholderReturnScorer._get_raw(comp_name, data)  — dict lookup + 成分別 fallback
  - ShareholderReturnScorer._explain(comp_name, raw, normalized) — rule-based 日本語説明（1成分）
  - ShareholderReturnScorer._build_explanation(components, total) — rule-based 総合説明

正規化仕様（07_spec.md Section 1.1 準拠）:
  div_payout:    clamp(x * 150,  0, 100)  # ratio単位 — 0.333→50 / 0.667→100
  buyback_yield: clamp(x * 30,   0, 100)  # %単位     — 1.667→50 / 3.333→100
  doe:           clamp(x * 30,   0, 100)  # %単位     — 1.667→50 / 3.333→100
  div_growth_5y: clamp(x * 15,   0, 100)  # %単位     — 3.333→50 / 6.667→100
  total_yield:   clamp(x * 25,   0, 100)  # %単位     — 2.0→50 / 4.0→100

単位:
  div_payout    は ratio（0〜1）— 例: 50%配当性向 → 0.50（NOT 50.0）
  buyback_yield は %（0〜）     — 例: 1.67%自社株買い → 1.67
  doe           は %（0〜）     — DOE (Dividend On Equity) %
  div_growth_5y は %（0〜）     — 5年増配 CAGR %
  total_yield   は %（0〜）     — 総還元利回り（配当+自社株買い）%

注意: 全5成分は正相関（高いほど高スコア）。Safety 軸と異なり逆相関成分なし。
      0.0 は有効値として扱い fallback しない。

欠損値方針:
  MISSING_RAW_VALUES に成分ごとの中立 raw 値を定義。
  各値は正規化後 ≈ 50.0 になるよう逆算している:
    div_payout:    1/3 * 150  ≈ 50.0   (float 精度誤差 ±1e-6)
    buyback_yield: 5/3 * 30   ≈ 50.0   (float 精度誤差 ±1e-6)
    doe:           5/3 * 30   ≈ 50.0   (float 精度誤差 ±1e-6)
    div_growth_5y: 10/3 * 15  ≈ 50.0   (float 精度誤差 ±1e-6)
    total_yield:   2.0 * 25   = 50.0   (exact)
  0.0 は有効値として扱い fallback しない。
  raw_value には fallback 時の中立 raw 値を格納する。

P2: div_payout は現行 spec では高いほど高スコアだが、将来は「過大配当性向を減点する
    レンジ型評価（例: 30〜60%→高評価、>100%→減点）」への見直し余地あり。

実装しないこと:
  - 実 LLM / HTTP / 外部 API
  - pandas / numpy
  - backend.engine.regime / operation / market_intel / news の import
  - backend.engine.scoring.value_score / quality_score / growth_score /
    safety_score / momentum_score の import（共通化しない）
  - public/data writer / GitHub Actions 変更
  - 売買判断・銘柄推奨・PF 最適化

Reference: docs/v13.3/07_v13.3_spec.md Section 1.1
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 5-6
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

# ── 定数 ─────────────────────────────────────────────────────────────────────

# 欠損時に使う成分ごとの中立 raw 値。正規化後がそれぞれ ≈ 50.0 になるよう逆算。
MISSING_RAW_VALUES: dict[str, float] = {
    "div_payout":    1.0 / 3.0,   # (1/3)*150 ≈ 50.0  (float 誤差 ±1e-6)
    "buyback_yield": 5.0 / 3.0,   # (5/3)*30  ≈ 50.0  (float 誤差 ±1e-6)
    "doe":           5.0 / 3.0,   # (5/3)*30  ≈ 50.0  (float 誤差 ±1e-6)
    "div_growth_5y": 10.0 / 3.0,  # (10/3)*15 ≈ 50.0  (float 誤差 ±1e-6)
    "total_yield":   2.0,          # 2.0*25   = 50.0   (exact)
}


# ── DataClasses ───────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ScoreComponent:
    """1成分のスコア（生値・正規化値・説明）。immutable。"""

    name:        str    # "div_payout" など（COMPONENT_WEIGHTS のキー）
    weight:      float  # COMPONENT_WEIGHTS の値
    raw_value:   float  # 生値（欠損時は MISSING_RAW_VALUES の値）
    normalized:  float  # 0.0〜100.0
    description: str    # 人間向け説明（日本語、rule-based）


@dataclass(frozen=True)
class AxisScore:
    """還元力軸の集計スコア。immutable。"""

    axis:        str                         # "shareholder_return"
    name_ja:     str                         # "還元力"
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


# ── ShareholderReturnScorer ───────────────────────────────────────────────────

class ShareholderReturnScorer:
    """
    還元力軸スコアを計算する。

    financial_data は外部から注入される dict（実 DB / HTTP 呼び出しは行わない）。
    normalizer_fn を注入することでデフォルト正規化を差し替え可能（DI フック）。

    注意: 全5成分は正相関（高いほど高スコア）。
    div_payout は ratio 単位（0〜1）。他成分は %単位。
    0.0 は有効値として扱い fallback しない。
    """

    AXIS_ID   = "shareholder_return"
    AXIS_NAME = "還元力"

    COMPONENT_WEIGHTS: dict[str, float] = {
        "div_payout":    0.30,
        "buyback_yield": 0.25,
        "doe":           0.20,
        "div_growth_5y": 0.15,
        "total_yield":   0.10,
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
                            期待キー: div_payout / buyback_yield / doe /
                                      div_growth_5y / total_yield
                            div_payout    は ratio（例: 0.50 = 50%配当性向）。
                            buyback_yield は %（例: 1.67 = 1.67%）。
                            doe           は %（例: 1.67 = 1.67%）。
                            div_growth_5y は %（例: 3.33 = 3.33% CAGR）。
                            total_yield   は %（例: 2.0 = 2.0%）。
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
        if comp_name == "div_payout":
            return max(0.0, min(100.0, raw * 150.0))
        if comp_name == "buyback_yield":
            return max(0.0, min(100.0, raw * 30.0))
        if comp_name == "doe":
            return max(0.0, min(100.0, raw * 30.0))
        if comp_name == "div_growth_5y":
            return max(0.0, min(100.0, raw * 15.0))
        if comp_name == "total_yield":
            return max(0.0, min(100.0, raw * 25.0))
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
        "div_payout":    "配当性向",
        "buyback_yield": "自社株買い利回り",
        "doe":           "DOE",
        "div_growth_5y": "5年増配率",
        "total_yield":   "総還元利回り",
    }

    _HIGH_LABELS: dict[str, str] = {
        "div_payout":    "高配当性向",
        "buyback_yield": "積極自社株買い",
        "doe":           "高DOE",
        "div_growth_5y": "高増配",
        "total_yield":   "高還元",
    }

    _LOW_LABELS: dict[str, str] = {
        "div_payout":    "低配当性向",
        "buyback_yield": "自社株買い少",
        "doe":           "低DOE",
        "div_growth_5y": "増配少",
        "total_yield":   "低還元",
    }

    def _explain(self, comp_name: str, raw: float, normalized: float) -> str:
        label = self._COMP_LABELS.get(comp_name, comp_name)

        if normalized >= 70.0:
            level = self._HIGH_LABELS.get(comp_name, "高水準")
        elif normalized >= 30.0:
            level = "標準水準"
        else:
            level = self._LOW_LABELS.get(comp_name, "低水準")

        return f"{label} {raw:.4f} — {level}（スコア{normalized:.0f}）"

    def _build_explanation(
        self,
        components: tuple[ScoreComponent, ...],
        total: float,
    ) -> str:
        if total >= 70.0:
            rating = "高還元"
        elif total >= 40.0:
            rating = "標準"
        else:
            rating = "低還元"

        sorted_comps = sorted(components, key=lambda c: c.normalized, reverse=True)
        top    = self._COMP_LABELS.get(sorted_comps[0].name,  sorted_comps[0].name)
        bottom = self._COMP_LABELS.get(sorted_comps[-1].name, sorted_comps[-1].name)

        return (
            f"還元力スコア {total:.0f} — {top}が高評価、"
            f"{bottom}が相対的に低評価（{rating}水準）"
        )
