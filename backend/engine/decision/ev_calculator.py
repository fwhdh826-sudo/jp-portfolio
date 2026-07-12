"""
EV Calculator — Card 5-7
Phase 5 意思決定エンジン: 期待値（Expected Value）計算。

責務:
  - EVInput         — 1銘柄のEV計算入力を保持する frozen dataclass
  - EVResult        — EV計算結果（ev_fund / ev_final / α成分内訳）を保持する frozen dataclass
  - ReplaceEVInput  — 乗換比較入力（candidate + incumbent + 乗換コスト）を保持する frozen dataclass
  - ReplaceEVResult — 乗換EV計算結果を保持する frozen dataclass
  - EVCalculator.calc_ev(input)         — EVInput → EVResult
  - EVCalculator.calc_replace_ev(input) — ReplaceEVInput → ReplaceEVResult
  - EVCalculator._calc_alpha_score(...)  — 6軸スコア → α変換
  - EVCalculator._calc_alpha_cross(...)  — クロス軸シグナル → α変換
  - EVCalculator._calc_size_premium(...) — サイズセグメント → プレミアム
  - EVCalculator._calc_alpha_market(...) — market_intel_dict → 市場α
  - EVCalculator._extract_keyword_tags(...) — market_intel_dict → keyword tuple

計算式（07_spec.md Section 6.1 準拠）:
  alpha_score  = sum((score_total - 50) / 50 * 0.001 * weight for each axis)
  alpha_cross  = size_quality / 100 * 0.005 + anti_junk / 100 * 0.003
  size_premium = {small_cap: 0.012, mid_cap: 0.005, large_cap: 0.000}[segment]
  alpha_market = sentiment調整 + keyword調整（market_intel_dict DI）
  ev_fund      = mu_hist + alpha_score + alpha_cross + size_premium
  ev_final     = ev_fund + alpha_market
  replace_ev   = candidate_ev_final - incumbent_ev_final - transaction_cost

入力仕様:
  six_axis_scores  : {"value": {"total": 65}, "quality": {"total": 72}, ...}
  axis_weights     : {"value": 0.20, "quality": 0.20, ...}（レジーム別重み DI）
  cross_axis_signals: {"size_quality": 60, "anti_junk": 40}
  market_intel_dict : {"sentiment": {"score": 55}, "keywords": [...], "active_keywords": [...]}

keyword フォーマット（4形式すべて対応）:
  形式1: {"keywords":        [{"tag": "資源高"}]}
  形式2: {"keywords":        ["資源高", "円安"]}
  形式3: {"active_keywords": [{"tag": "資源高"}]}
  形式4: {"active_keywords": ["資源高", "円安"]}
  "keywords" と "active_keywords" は merge する（重複除外）。

EV値はクランプしない。負になりうる。

売買判断の境界線:
  EV Calculator は数値計算のみを行う補助指標モジュール。
  BUY / SELL / HOLD / WAIT 等の判定は実装しない。
  replace_ev の正負を使った判断フィールドは持たない。
  4段階判定（A5）は Card 5-8 以降の責務。

欠損値方針:
  six_axis_scores の軸欠損 → score_total = 50（中立）
  axis_weights の軸欠損    → alpha_score への貢献 = 0.0
  cross_axis_signals 欠損  → 0（貢献なし）
  market_intel_dict 空 {}  → alpha_market = 0.0
  size_segment 未知        → size_premium = 0.0

実装しないこと:
  - BUY / SELL / HOLD / WAIT / entry / exit / take_profit / stop_loss
  - 推奨順位・銘柄推奨・PF配分・PF最適化
  - CVaR / Confidence / Uncertainty（Card 5-8）
  - Decision Smoothing（Card 5-8+）
  - 実 LLM / HTTP / 外部 API
  - pandas / numpy
  - backend.engine.regime / operation / market_intel / news の import
  - backend.engine.scoring.* の import
  - public/data writer / GitHub Actions 変更

Reference: docs/v13.3/07_v13.3_spec.md Section 6.1
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 5-7
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

# ── 定数 ─────────────────────────────────────────────────────────────────────

SIZE_PREMIUMS: dict[str, float] = {
    "small_cap": 0.012,
    "mid_cap":   0.005,
    "large_cap": 0.000,
}

DEFAULT_AXIS_IDS: tuple[str, ...] = (
    "value",
    "quality",
    "growth",
    "safety",
    "momentum",
    "shareholder_return",
)

CROSS_AXIS_WEIGHTS: dict[str, float] = {
    "size_quality": 0.005,
    "anti_junk":    0.003,
}


# ── DataClasses ───────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class EVInput:
    """1銘柄のEV計算に必要な全入力。immutable。"""

    ticker:             str    # 銘柄コード
    mu_hist:            float  # 3年平均年率リターン（例: 0.08 = 8%）
    six_axis_scores:    dict   # {"value":{"total":65}, "quality":{"total":72}, ...}
    axis_weights:       dict   # {"value":0.20, ...}（レジーム別重み DI）
    size_segment:       str    # "small_cap" | "mid_cap" | "large_cap"
    # ── オプション（DI fallback = False / {}）──────────────────────────
    is_risk_on:          bool = False
    is_defensive:        bool = False
    is_energy:           bool = False
    is_overseas:         bool = False
    cross_axis_signals:  dict = field(default_factory=dict)  # {"size_quality":60, "anti_junk":40}
    market_intel_dict:   dict = field(default_factory=dict)  # {"sentiment":{"score":55},"keywords":[...]}


@dataclass(frozen=True)
class EVResult:
    """EV計算結果。α成分の内訳を保持する。immutable。"""

    ticker:        str    # 銘柄コード
    mu_hist:       float  # 入力をそのまま保持
    alpha_score:   float  # 6軸スコアα成分
    alpha_cross:   float  # クロス軸α成分（cross_axis_signals未入力=0.0）
    size_premium:  float  # サイズプレミアム
    alpha_market:  float  # 市場α成分（market_intel_dict未入力=0.0）
    ev_fund:       float  # mu_hist + alpha_score + alpha_cross + size_premium
    ev_final:      float  # ev_fund + alpha_market


@dataclass(frozen=True)
class ReplaceEVInput:
    """乗換比較入力。candidate + incumbent の EVResult と乗換コストを保持する。immutable。"""

    candidate:        EVResult  # 購入候補銘柄のEV計算結果
    incumbent:        EVResult  # 現在保有銘柄のEV計算結果
    transaction_cost: float     # 乗換コスト合計（例: 0.003 = 0.3%）。>= 0.0 を前提。


@dataclass(frozen=True)
class ReplaceEVResult:
    """乗換EV計算結果。算術結果のみ保持し売買判断は含まない。immutable。"""

    candidate_ticker:   str    # 購入候補銘柄コード
    incumbent_ticker:   str    # 現在保有銘柄コード
    candidate_ev_final: float  # candidate の ev_final
    incumbent_ev_final: float  # incumbent の ev_final
    transaction_cost:   float  # 乗換コスト
    replace_ev:         float  # candidate_ev_final - incumbent_ev_final - transaction_cost
    # is_beneficial フィールドは持たない（売買判断は呼び出し側の責務）


# ── EVCalculator ──────────────────────────────────────────────────────────────

class EVCalculator:
    """
    期待値（EV）を計算する。補助指標モジュール。

    six_axis_scores / axis_weights / cross_axis_signals / market_intel_dict は
    すべて DI dict として受け取る。backend.engine.scoring.* を import しない。
    EV値はクランプしない。売買判断は実装しない。
    """

    def calc_ev(self, ev_input: EVInput) -> EVResult:
        """
        EVInput から EVResult を計算する。

        Args:
            ev_input: EV計算に必要な全入力。
        Returns:
            EVResult: α成分内訳と ev_fund / ev_final を含む計算結果。
        """
        alpha_score  = self._calc_alpha_score(
            ev_input.six_axis_scores, ev_input.axis_weights
        )
        alpha_cross  = self._calc_alpha_cross(ev_input.cross_axis_signals)
        size_premium = self._calc_size_premium(ev_input.size_segment)
        alpha_market = self._calc_alpha_market(
            ev_input.market_intel_dict,
            ev_input.is_risk_on,
            ev_input.is_defensive,
            ev_input.is_energy,
            ev_input.is_overseas,
        )

        ev_fund  = ev_input.mu_hist + alpha_score + alpha_cross + size_premium
        ev_final = ev_fund + alpha_market

        return EVResult(
            ticker=ev_input.ticker,
            mu_hist=ev_input.mu_hist,
            alpha_score=alpha_score,
            alpha_cross=alpha_cross,
            size_premium=size_premium,
            alpha_market=alpha_market,
            ev_fund=ev_fund,
            ev_final=ev_final,
        )

    def calc_replace_ev(self, replace_input: ReplaceEVInput) -> ReplaceEVResult:
        """
        乗換EV を計算する。算術結果のみ返す。売買判断は行わない。

        Args:
            replace_input: candidate / incumbent の EVResult + 乗換コスト。
        Returns:
            ReplaceEVResult: replace_ev = candidate_ev_final - incumbent_ev_final - cost。
        """
        replace_ev = (
            replace_input.candidate.ev_final
            - replace_input.incumbent.ev_final
            - replace_input.transaction_cost
        )
        return ReplaceEVResult(
            candidate_ticker=replace_input.candidate.ticker,
            incumbent_ticker=replace_input.incumbent.ticker,
            candidate_ev_final=replace_input.candidate.ev_final,
            incumbent_ev_final=replace_input.incumbent.ev_final,
            transaction_cost=replace_input.transaction_cost,
            replace_ev=replace_ev,
        )

    # ── alpha_score ───────────────────────────────────────────────────────────

    def _calc_alpha_score(
        self,
        six_axis_scores: dict,
        axis_weights: dict,
    ) -> float:
        """
        6軸スコアからα成分を計算する。

        formula: sum((score_total - 50) / 50 * 0.001 * weight for each axis)
        score_total 欠損時は 50（中立 → 貢献 0.0）。
        """
        alpha = 0.0
        for axis, weight in axis_weights.items():
            score_total = six_axis_scores.get(axis, {}).get("total", 50)
            alpha += (score_total - 50) / 50 * 0.001 * weight
        return alpha

    # ── alpha_cross ───────────────────────────────────────────────────────────

    def _calc_alpha_cross(self, cross_axis_signals: dict) -> float:
        """
        クロス軸シグナルからα成分を計算する。

        formula: size_quality / 100 * 0.005 + anti_junk / 100 * 0.003
        cross_axis_signals 空 {} のとき 0.0。
        """
        size_quality = cross_axis_signals.get("size_quality", 0)
        anti_junk    = cross_axis_signals.get("anti_junk", 0)
        return size_quality / 100 * CROSS_AXIS_WEIGHTS["size_quality"] + \
               anti_junk    / 100 * CROSS_AXIS_WEIGHTS["anti_junk"]

    # ── size_premium ──────────────────────────────────────────────────────────

    def _calc_size_premium(self, size_segment: str) -> float:
        """
        サイズセグメントからプレミアムを返す。
        未知セグメント → 0.0（fallback）。
        """
        return SIZE_PREMIUMS.get(size_segment, 0.0)

    # ── alpha_market ──────────────────────────────────────────────────────────

    def _calc_alpha_market(
        self,
        market_intel_dict: dict,
        is_risk_on:   bool,
        is_defensive: bool,
        is_energy:    bool,
        is_overseas:  bool,
    ) -> float:
        """
        market_intel_dict からα市場調整を計算する。

        market_intel_dict 空 {} のとき 0.0。
        sentiment: {"score": int} キーを期待。欠損時は 50（中立）。
        keywords:  _extract_keyword_tags() で4形式を正規化して処理。
        """
        if not market_intel_dict:
            return 0.0

        sentiment = market_intel_dict.get("sentiment", {}).get("score", 50)
        keywords  = self._extract_keyword_tags(market_intel_dict)

        alpha = 0.0

        if sentiment > 70 and is_risk_on:
            alpha += 0.005
        elif sentiment < 30:
            alpha += 0.003 if is_defensive else -0.003

        if "資源高" in keywords and is_energy:
            alpha += 0.004
        if "円安" in keywords and is_overseas:
            alpha += 0.002

        return alpha

    # ── keyword extraction ────────────────────────────────────────────────────

    def _extract_keyword_tags(self, market_intel_dict: dict) -> tuple[str, ...]:
        """
        market_intel_dict から keyword タグを抽出する。

        "keywords" と "active_keywords" の両方を確認し merge する。
        4形式に対応:
          形式1: {"keywords":        [{"tag": "資源高"}]}
          形式2: {"keywords":        ["資源高", "円安"]}
          形式3: {"active_keywords": [{"tag": "資源高"}]}
          形式4: {"active_keywords": ["資源高", "円安"]}
        - tag キー欠損は無視（KeyError を出さない）
        - 空文字は除外
        - 重複除外（先頭からの順序を維持）
        - 未知型 item は無視
        戻り値: tuple[str, ...]（deterministic）
        """
        tags: list[str] = []
        for key in ("keywords", "active_keywords"):
            items = market_intel_dict.get(key, [])
            if not isinstance(items, list):
                continue
            for item in items:
                if isinstance(item, dict):
                    tag = str(item.get("tag", "")).strip()
                elif isinstance(item, str):
                    tag = item.strip()
                else:
                    tag = ""
                if tag and tag not in tags:
                    tags.append(tag)
        return tuple(tags)
