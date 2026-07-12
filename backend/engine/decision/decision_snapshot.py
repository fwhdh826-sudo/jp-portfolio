"""
DecisionSnapshot — Card 5-9
Phase 5 意思決定エンジン: 6軸スコア / EV / CVaR / リスク調整値を束ねる中間層。

責務:
  - AxisScoreEntry    — 1軸スコアを保持する frozen dataclass
  - AxisScoreBundle   — 6軸分のスコアをまとめ composite_score / missing_axes を提供
  - DecisionSnapshot  — ticker 単位の全情報を束ねる frozen dataclass + to_dict()
  - SnapshotBuilder   — dict 群から DecisionSnapshot を組み立てるファクトリ
  - CANONICAL_AXES    — 6軸の正規 ID タプル（定義順）

入力仕様:
  axis_scores_list の各要素（AxisScore.to_dict() の出力をそのまま渡せる）:
    {"axis": str, "name_ja": str, "total": int|float, "explanation": str}
    "components" キーは無視する。

composite_score 計算仕様:
  axis_weights あり:
    present_weight_sum = sum(weight for axis, weight in axis_weights.items()
                             if axis in entry_map)
    present_weight_sum > 0:
      composite_score = weighted_sum / present_weight_sum  ← 存在軸で正規化
    present_weight_sum == 0:
      等重み平均にフォールバック（entries 空なら 50.0）
  axis_weights なし（{}）:
    等重み平均（entries 空なら 50.0）

  設計理由: 欠損軸を composite_score で暗黙ペナルティ化しない。
  欠損状態は missing_axes / axis_count で後続エンジンが判断する。

total 変換仕様:
  round(float(total)) で int 化。変換失敗時は 50（中立値）に fallback。
  変換後は clamp(0, 100) を適用。

DecisionSnapshot は判断前の中間表現:
  action / recommendation / is_buy / is_sell / is_hold / is_recommended / rating
  等の判断フィールドは意図的に持たない。

実装しないこと:
  - BUY / SELL / HOLD / WAIT 等の判定
  - action / recommendation 等の判断フィールド
  - short_long_split（後続 Card）
  - 銘柄推奨・PF最適化
  - 実 LLM / HTTP / 外部 API
  - pandas / numpy
  - backend.engine.scoring / regime / market_intel / news の import
  - backend.engine.decision.ev_calculator / cvar_estimator / uncertainty_calc の import

Reference: docs/v13.3/07_v13.3_spec.md Section 1.2（calc_total_score_dynamic 入力形式）
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 5-9
"""
from __future__ import annotations

from dataclasses import dataclass

# ── 定数 ─────────────────────────────────────────────────────────────────────

CANONICAL_AXES: tuple[str, ...] = (
    "value",
    "quality",
    "growth",
    "safety",
    "momentum",
    "shareholder_return",
)


# ── ヘルパー ──────────────────────────────────────────────────────────────────

def _safe_total(raw) -> int:
    """
    任意の型の total 値を安全に int に変換する。
    - float → round(float(raw))
    - 変換失敗 → 50（中立値 fallback）
    - 変換後 clamp(0, 100)
    """
    try:
        val = round(float(raw))
    except (TypeError, ValueError):
        val = 50
    return max(0, min(100, val))


# ── DataClasses ───────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class AxisScoreEntry:
    """1軸のスコアを保持する。immutable。"""

    axis:        str  # "value" | "quality" | "growth" | "safety" | "momentum" | "shareholder_return"
    name_ja:     str  # "バリュー" など
    total:       int  # 0〜100（round済み整数、clamp済み）
    explanation: str  # 軸の日本語説明


@dataclass(frozen=True)
class AxisScoreBundle:
    """6軸スコアの集合体。composite_score / missing_axes / axis_count を提供する。immutable。"""

    ticker:          str                         # 銘柄コード
    entries:         tuple[AxisScoreEntry, ...]  # 取得済み軸（0〜6件）
    missing_axes:    tuple[str, ...]             # CANONICAL_AXES のうち欠損軸（canonical 順）
    axis_count:      int                         # len(entries)
    composite_score: float                       # 取得済み軸の加重 or 等重み平均（欠損ペナルティなし）


@dataclass(frozen=True)
class DecisionSnapshot:
    """
    ticker 単位の中間意思決定情報。判断前の中間表現。immutable。

    action / recommendation / is_buy / is_sell 等の判断フィールドは持たない。
    """

    # ── 識別 ────────────────────────────────────────────────────────────────
    ticker:      str   # 銘柄コード
    snapshot_id: str   # "{ticker}_{timestamp}" など呼び出し側が生成

    # ── 6軸スコア ────────────────────────────────────────────────────────────
    axis_bundle: AxisScoreBundle

    # ── EV ─────────────────────────────────────────────────────────────────
    ev_fund:  float   # EVResult.ev_fund 相当
    ev_final: float   # EVResult.ev_final 相当

    # ── リスク調整 ──────────────────────────────────────────────────────────
    cvar:             float  # CVaRResult.cvar 相当（負になりうる）
    cvar_mode:        str    # "scenario" | "parametric"
    confidence:       float  # UncertaintyResult.confidence（clamp済み）
    uncertainty:      float  # UncertaintyResult.uncertainty（clamp済み）
    risk_adjusted_ev: float  # UncertaintyResult.risk_adjusted_ev 相当
    smoothed_ev:      float  # UncertaintyResult.smoothed_ev 相当

    # ── メタ ────────────────────────────────────────────────────────────────
    regime: str  # DI（例: "bull_calm"）。空文字可。
    notes:  str  # 任意の日本語メモ。処理には使わない。デフォルト ""

    # action / recommendation / is_buy / is_sell / is_hold /
    # is_recommended / rating 等の判断フィールドは意図的に持たない。

    def to_dict(self) -> dict:
        """
        UI / 後続 Decision Engine への渡し形式。
        全値が json.dumps 可能（float / int / str / list / dict のみ）。
        """
        return {
            "ticker":          self.ticker,
            "snapshot_id":     self.snapshot_id,
            "regime":          self.regime,
            "composite_score": round(self.axis_bundle.composite_score),
            "axis_count":      self.axis_bundle.axis_count,
            "missing_axes":    list(self.axis_bundle.missing_axes),
            "axes": [
                {
                    "axis":        e.axis,
                    "name_ja":     e.name_ja,
                    "total":       e.total,
                    "explanation": e.explanation,
                }
                for e in self.axis_bundle.entries
            ],
            "ev": {
                "ev_fund":          self.ev_fund,
                "ev_final":         self.ev_final,
                "cvar":             self.cvar,
                "cvar_mode":        self.cvar_mode,
                "confidence":       self.confidence,
                "uncertainty":      self.uncertainty,
                "risk_adjusted_ev": self.risk_adjusted_ev,
                "smoothed_ev":      self.smoothed_ev,
            },
            "notes": self.notes,
        }


# ── SnapshotBuilder ───────────────────────────────────────────────────────────

class SnapshotBuilder:
    """
    dict 群から DecisionSnapshot を組み立てるファクトリ。

    axis_scores_list は AxisScore.to_dict() の出力をそのまま渡せる:
      [{"axis":"value","name_ja":"バリュー","total":65,"explanation":"..."}, ...]
    "components" キーは無視する。

    composite_score 計算:
      axis_weights あり → present_weight_sum で正規化（欠損軸ペナルティなし）
      axis_weights なし → 等重み平均
      entries 空       → 50.0 fallback
    """

    def build(
        self,
        ticker:           str,
        snapshot_id:      str,
        axis_scores_list: list[dict],
        axis_weights:     dict,
        ev_fund:          float,
        ev_final:         float,
        cvar:             float,
        cvar_mode:        str,
        confidence:       float,
        uncertainty:      float,
        risk_adjusted_ev: float,
        smoothed_ev:      float,
        regime:           str = "",
        notes:            str = "",
    ) -> DecisionSnapshot:
        """
        DecisionSnapshot を組み立てる。

        Args:
            ticker:           銘柄コード
            snapshot_id:      スナップショット識別子（呼び出し側が生成）
            axis_scores_list: 軸スコア dict のリスト（AxisScore.to_dict() 互換）
            axis_weights:     軸重みテーブル（空 {} → 等重み平均）
            ev_fund:          EV（fund）
            ev_final:         EV（final）
            cvar:             CVaR
            cvar_mode:        "scenario" | "parametric"
            confidence:       確信度（clamp済みでなくてもよい。Snapshot にはそのまま格納）
            uncertainty:      不確実性（同上）
            risk_adjusted_ev: リスク調整後 EV
            smoothed_ev:      Smoothing 後 EV
            regime:           レジーム文字列（空文字可）
            notes:            任意メモ
        """
        axis_bundle = self._build_bundle(ticker, axis_scores_list, axis_weights)

        return DecisionSnapshot(
            ticker=ticker,
            snapshot_id=snapshot_id,
            axis_bundle=axis_bundle,
            ev_fund=ev_fund,
            ev_final=ev_final,
            cvar=cvar,
            cvar_mode=cvar_mode,
            confidence=confidence,
            uncertainty=uncertainty,
            risk_adjusted_ev=risk_adjusted_ev,
            smoothed_ev=smoothed_ev,
            regime=regime,
            notes=notes,
        )

    def _build_bundle(
        self,
        ticker:           str,
        axis_scores_list: list[dict],
        axis_weights:     dict,
    ) -> AxisScoreBundle:
        entries = self._parse_entries(axis_scores_list)
        entry_map = {e.axis: e for e in entries}

        missing_axes = tuple(
            a for a in CANONICAL_AXES if a not in entry_map
        )
        axis_count = len(entries)
        composite_score = self._calc_composite(entries, entry_map, axis_weights)

        return AxisScoreBundle(
            ticker=ticker,
            entries=entries,
            missing_axes=missing_axes,
            axis_count=axis_count,
            composite_score=composite_score,
        )

    def _parse_entries(
        self,
        axis_scores_list: list[dict],
    ) -> tuple[AxisScoreEntry, ...]:
        """
        axis_scores_list を AxisScoreEntry タプルに変換する。
        - "components" キーは無視
        - total は _safe_total() で変換（float → round, 失敗 → 50, clamp 0-100）
        - "axis" / "name_ja" / "explanation" が欠損の場合は "" で補完
        """
        entries = []
        for item in axis_scores_list:
            if not isinstance(item, dict):
                continue
            axis        = str(item.get("axis", ""))
            name_ja     = str(item.get("name_ja", ""))
            total       = _safe_total(item.get("total", 50))
            explanation = str(item.get("explanation", ""))
            entries.append(
                AxisScoreEntry(
                    axis=axis,
                    name_ja=name_ja,
                    total=total,
                    explanation=explanation,
                )
            )
        return tuple(entries)

    def _calc_composite(
        self,
        entries:     tuple[AxisScoreEntry, ...],
        entry_map:   dict[str, AxisScoreEntry],
        axis_weights: dict,
    ) -> float:
        """
        composite_score を計算する。

        axis_weights あり:
          present_weight_sum = sum(w for axis, w in axis_weights.items() if axis in entry_map)
          > 0 → weighted_sum / present_weight_sum
          == 0 → 等重み平均にフォールバック

        axis_weights なし ({}):
          等重み平均にフォールバック

        entries 空:
          50.0 (中立値)
        """
        if not entries:
            return 50.0

        if axis_weights:
            weighted_sum       = sum(
                entry_map[axis].total * weight
                for axis, weight in axis_weights.items()
                if axis in entry_map
            )
            present_weight_sum = sum(
                weight
                for axis, weight in axis_weights.items()
                if axis in entry_map
            )
            if present_weight_sum > 0:
                return weighted_sum / present_weight_sum

        # 等重み平均（axis_weights なし、または present_weight_sum == 0）
        return sum(e.total for e in entries) / len(entries)
