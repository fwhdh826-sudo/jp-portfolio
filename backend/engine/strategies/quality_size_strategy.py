"""
quality_size_strategy.py — Card 7-3
Phase 7 Multi-Strategy Engine: 戦略B — Quality-Size（Asness 2018）。

責務:
  - QualitySizeStrategy — BaseStrategy を継承した Quality-Size 計算クラス

Quality-Size 計算仕様（stdlib-only、Asness 2018 QMJ 近似）:
  1. QUALITY_AXIS_WEIGHTS を使って各銘柄の base_score を計算
     - base_score = sum(axis_total * axis_weight) for each axis in QUALITY_AXIS_WEIGHTS
     - axis_total: scores[ticker][axis]["total"]（欠損・不正 → DEFAULT_SCORE=50.0 fallback）
     - axis_total: 0.0〜100.0 に clamp
  2. quality_premium を計算（QMJ 効果の近似）
     - quality_raw = scores[ticker]["quality"]["total"]（欠損 → DEFAULT_SCORE）
     - quality_excess = max(0.0, quality_raw - QUALITY_THRESHOLD)
     - quality_bonus = quality_excess * QUALITY_PREMIUM_FACTOR
     - quality_size_score = base_score + quality_bonus
  3. score_weights = {ticker: quality_size_score}
  4. _normalize_weights() で合計 1.0 に正規化
  5. _to_ideal_pf_tuple() で tuple 化
  6. expected_return / expected_vol / max_dd は レジーム別参照値テーブルを使用

Asness 2018 QMJ との対応:
  Quality Minus Junk (QMJ) は質の高い株（高利益率・安全性・成長・高配当）が
  低質株（ジャンク株）をアウトパフォームするという実証研究。
  本実装では quality/safety 軸に偏重した固定軸重みと、
  quality 軸スコアが閾値を超えた銘柄に quality_bonus を付与することで QMJ 効果を近似する。
  Size factor（小型株バイアス）は本フェーズでは市場時価総額データ未接続のため、
  quality premium 集中として近似実装（P2-7G 参照）。

参照値について:
  expected_return / expected_vol / max_dd_estimate は Phase 8 までの参照値です。
  実際の将来リターン・ボラティリティ・最大損失を保証するものではありません。
  Quality 戦略は bear/crisis 時に frontier より防御的なリターン特性を想定（P2-7H）。

QUALITY_AXIS_WEIGHTS（固定軸重み）:
  frontier_strategy が regime-adaptive な軸重みを使うのに対し、
  QualitySize は quality/safety に偏重した固定軸重みを使う。
  これにより「どのレジームでも quality を重視する」という戦略特性を表現する。

empty universe fallback:
  universe が空の場合:
    ideal_pf=(), expected_return=0.0, expected_vol=0.0, sharpe_ratio=0.0,
    max_dd_estimate=0.0, diagnostics に "observation: universe is empty" を追加

unknown regime fallback:
  既知の 5 レジーム（bull_calm/bull_volatile/bear/crisis/uncertain）以外は "uncertain" にフォールバック。

設計原則:
  - 実際の売買制限・注文制限はしない（数値化のみ）
  - 実 LLM / HTTP 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / rating / approve / reject / conditional 禁止
  - numpy / scipy / pandas / cvxpy / sklearn 禁止（math stdlib のみ使用）
  - operation / market_intel / news / regime を直接 import しない

実装しないこと:
  - numpy / scipy を使う共分散行列計算・SLSQP 最適化
  - 実際の市場時価総額 Size factor（Phase 8 で接続予定）
  - Tier A ハード制約の実適用（Card 7-7 の責務）
  - 3ヶ月売却不可ルールの実運用判断
  - BUY / SELL / HOLD / WAIT 判定
  - public / data writer

P2 記録:
  P2-7G: Size factor（市場時価総額）は未接続。quality premium 集中で近似。
         Phase 8 で market_intel との接続時に本格 size tilt を実装予定。
  P2-7H: expected_return / expected_vol / max_dd は regime reference values。
         Quality 戦略の防御的特性（bear/crisis 時の相対優位）は観察値。保証ではない。
  P2-7I: QUALITY_AXIS_WEIGHTS の固定重み設計。
         frontier が regime-adaptive なのに対し quality_size は固定。
         Card 7-6 Aggregator で regime 重み × strategy 重みとして統合される。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 7-3
Reference: Asness, C., Frazzini, A., Pedersen, L. H. (2019). Quality Minus Junk. Review of Accounting Studies.
"""
from __future__ import annotations

from engine.strategies.base_strategy import (
    BaseStrategy,
    StrategyInput,
    StrategyOutput,
    _clamp,
    _safe_float,
)

# ── 定数 ─────────────────────────────────────────────────────────────────────

DEFAULT_SCORE: float = 50.0

# Quality-Size 固定軸重み（QMJ: quality/safety 偏重）
# frontier とは異なり regime に関係なく固定。Card 7-6 Aggregator でレジーム戦略重みと合成。
QUALITY_AXIS_WEIGHTS: dict[str, float] = {
    "quality":            0.40,
    "safety":             0.25,
    "value":              0.15,
    "shareholder_return": 0.10,
    "growth":             0.07,
    "momentum":           0.03,
}

# Quality Premium（QMJ 効果の近似）
# quality 軸スコアが閾値を超えた分に QUALITY_PREMIUM_FACTOR を乗じて base_score に加算する。
QUALITY_THRESHOLD: float = 65.0
QUALITY_PREMIUM_FACTOR: float = 0.10

_FALLBACK_REGIME: str = "uncertain"


# ── レジーム別参照値テーブル（Phase 8 で本格計算に差し替え予定）────────────────
# Quality 戦略は bear/crisis 時に frontier より防御的（P2-7H）

_REGIME_EXPECTED_RETURN: dict[str, float] = {
    "bull_calm":     0.080,
    "bull_volatile": 0.065,
    "bear":          0.040,
    "crisis":        0.020,
    "uncertain":     0.060,
}

_REGIME_EXPECTED_VOL: dict[str, float] = {
    "bull_calm":     0.110,
    "bull_volatile": 0.160,
    "bear":          0.170,
    "crisis":        0.240,
    "uncertain":     0.140,
}

_REGIME_MAX_DD: dict[str, float] = {
    "bull_calm":     -0.07,
    "bull_volatile": -0.13,
    "bear":          -0.16,
    "crisis":        -0.28,
    "uncertain":     -0.11,
}


# ── QualitySizeStrategy ───────────────────────────────────────────────────────

class QualitySizeStrategy(BaseStrategy):
    """
    Quality-Size 戦略（Asness 2018 QMJ 近似）。stdlib-only 実装。

    compute() は pure computation: StrategyInput を受け取り StrategyOutput を返す。
    売買判断・注文生成・発注制限は行わない。

    ideal_pf の各重みは「Quality-Size スコアに比例した計算結果の理想比率」であり、
    「この銘柄を買え/売れ」という命令ではない。

    frontier_strategy との違い:
      - 軸重みを regime-adaptive ではなく QUALITY_AXIS_WEIGHTS で固定する（P2-7I）
      - quality 軸スコアが閾値超えの銘柄に quality_bonus を付与する（QMJ 効果近似）
      - bear/crisis 時の参照値が frontier より防御的（P2-7H）

    市場時価総額 Size factor は Phase 8 で接続予定（P2-7G）。
    """

    STRATEGY_ID:   str = "quality_size"
    STRATEGY_NAME: str = "Quality-Size (Asness 2018)"

    def compute(self, strategy_input: StrategyInput) -> StrategyOutput:
        """
        StrategyInput を受け取り QualitySizeStrategy の StrategyOutput を返す。

        Args:
            strategy_input: StrategyInput（universe / scores / regime / horizon を DI）
        Returns:
            StrategyOutput

        制約:
          - strategy_input.scores / context を mutation してはならない
          - BUY / SELL / HOLD / WAIT 判定を行ってはならない
          - numpy / scipy を使用してはならない
        """
        diagnostics: list[str] = []

        # ── empty universe ────────────────────────────────────────────────────
        if not strategy_input.universe:
            diagnostics.append("observation: universe is empty")
            diagnostics.append(
                "observation: regime expected metrics are reference values, not guarantees"
            )
            return StrategyOutput(
                strategy_id=self.STRATEGY_ID,
                strategy_name=self.STRATEGY_NAME,
                ideal_pf=(),
                expected_return=0.0,
                expected_vol=0.0,
                sharpe_ratio=0.0,
                max_dd_estimate=0.0,
                rationale=(
                    "Quality-Size (Asness 2018): quality/safety-biased fixed-weight allocation "
                    "(empty universe — no allocation computed)"
                ),
                diagnostics=tuple(diagnostics),
            )

        # ── unknown regime 検出 ───────────────────────────────────────────────
        if strategy_input.regime not in _REGIME_EXPECTED_RETURN:
            diagnostics.append(
                f"observation: unknown regime '{strategy_input.regime}' "
                f"— fallback to '{_FALLBACK_REGIME}'"
            )

        # ── score weights 計算 ────────────────────────────────────────────────
        score_weights, score_diagnostics = self._build_score_weights(
            strategy_input.universe,
            strategy_input.scores,
        )
        diagnostics.extend(score_diagnostics)

        # ── 正規化 → ideal_pf ─────────────────────────────────────────────────
        normalized = self._normalize_weights(score_weights)
        ideal_pf = self._to_ideal_pf_tuple(normalized)

        # ── expected metrics ──────────────────────────────────────────────────
        expected_return, expected_vol, sharpe_ratio = self._calc_expected_metrics(
            strategy_input.regime
        )
        max_dd_estimate = self._calc_max_dd_estimate(strategy_input.regime)

        diagnostics.append(
            "observation: regime expected metrics are reference values, not guarantees"
        )

        return StrategyOutput(
            strategy_id=self.STRATEGY_ID,
            strategy_name=self.STRATEGY_NAME,
            ideal_pf=ideal_pf,
            expected_return=expected_return,
            expected_vol=expected_vol,
            sharpe_ratio=sharpe_ratio,
            max_dd_estimate=max_dd_estimate,
            rationale=(
                f"Quality-Size (Asness 2018): quality/safety-biased fixed-weight allocation "
                f"with QMJ quality premium (regime={strategy_input.regime})"
            ),
            diagnostics=tuple(diagnostics),
        )

    # ── private helpers ───────────────────────────────────────────────────────

    def _calc_quality_size_score(
        self,
        ticker_scores: dict,
    ) -> tuple[float, bool]:
        """
        1銘柄の quality_size_score を計算する。

        quality_size_score = base_score + quality_bonus

        base_score:
          sum(axis_total * axis_weight) for each axis in QUALITY_AXIS_WEIGHTS
          axis_total は 0.0〜100.0 に clamp。欠損・不正 → DEFAULT_SCORE fallback。

        quality_bonus（QMJ 効果の近似）:
          quality_raw  = scores["quality"]["total"]（欠損 → DEFAULT_SCORE）
          quality_excess = max(0.0, quality_raw - QUALITY_THRESHOLD)
          quality_bonus  = quality_excess * QUALITY_PREMIUM_FACTOR

        QUALITY_AXIS_WEIGHTS は固定（regime に依存しない）。
        axis_weights は呼び出し元から明示的に渡さない（固定定数を使用）。

        Args:
            ticker_scores: {axis_name: {"total": float}} の dict

        Returns:
            (quality_size_score, has_quality_premium)
            has_quality_premium: quality_excess > 0.0 だった場合 True
        """
        # base_score（QUALITY_AXIS_WEIGHTS による加重和）
        base_score = 0.0
        for axis, axis_weight in QUALITY_AXIS_WEIGHTS.items():
            axis_data = ticker_scores.get(axis)
            if isinstance(axis_data, dict):
                raw_total = axis_data.get("total", DEFAULT_SCORE)
            else:
                raw_total = DEFAULT_SCORE
            axis_total = _clamp(
                _safe_float(raw_total, DEFAULT_SCORE),
                0.0, 100.0,
            )
            base_score += axis_total * axis_weight

        # quality_bonus（QMJ: quality 軸超過分にプレミアム付与）
        quality_axis_data = ticker_scores.get("quality")
        if isinstance(quality_axis_data, dict):
            raw_quality = quality_axis_data.get("total", DEFAULT_SCORE)
        else:
            raw_quality = DEFAULT_SCORE
        quality_raw = _clamp(
            _safe_float(raw_quality, DEFAULT_SCORE),
            0.0, 100.0,
        )
        quality_excess = max(0.0, quality_raw - QUALITY_THRESHOLD)
        quality_bonus = quality_excess * QUALITY_PREMIUM_FACTOR
        has_quality_premium = quality_excess > 0.0

        quality_size_score = base_score + quality_bonus
        return quality_size_score, has_quality_premium

    def _build_score_weights(
        self,
        universe: tuple[str, ...],
        scores: dict,
    ) -> tuple[dict[str, float], list[str]]:
        """
        universe の各銘柄の quality_size_score を計算し、{ticker: score} dict を返す。

        Returns:
            (score_weights, diagnostics_list)
        """
        score_weights: dict[str, float] = {}
        diag: list[str] = []
        missing_tickers: list[str] = []
        bad_score_tickers: list[str] = []
        premium_tickers: list[str] = []

        for ticker in universe:
            raw = scores.get(ticker)

            if raw is None:
                missing_tickers.append(ticker)
                ticker_scores: dict = {}
            elif not isinstance(raw, dict):
                bad_score_tickers.append(ticker)
                ticker_scores = {}
            else:
                ticker_scores = raw

            quality_size_score, has_premium = self._calc_quality_size_score(ticker_scores)
            score_weights[ticker] = quality_size_score
            if has_premium:
                premium_tickers.append(ticker)

        if missing_tickers:
            diag.append(
                f"observation: {len(missing_tickers)} ticker(s) missing from scores "
                f"— used DEFAULT_SCORE={DEFAULT_SCORE} fallback"
            )
        if bad_score_tickers:
            diag.append(
                f"observation: {len(bad_score_tickers)} ticker(s) had non-dict scores "
                f"— used DEFAULT_SCORE={DEFAULT_SCORE} fallback"
            )
        if premium_tickers:
            diag.append(
                f"observation: {len(premium_tickers)} ticker(s) received quality premium "
                f"(quality > {QUALITY_THRESHOLD})"
            )

        return score_weights, diag

    def _calc_expected_metrics(
        self, regime: str
    ) -> tuple[float, float, float]:
        """
        レジーム別参照値から (expected_return, expected_vol, sharpe_ratio) を返す。

        unknown regime は "uncertain" にフォールバック。
        expected_return / expected_vol は参照値であり保証ではない（P2-7H）。

        Returns:
            (expected_return, expected_vol, sharpe_ratio)
        """
        key = regime if regime in _REGIME_EXPECTED_RETURN else _FALLBACK_REGIME
        expected_return = _REGIME_EXPECTED_RETURN[key]
        expected_vol    = _REGIME_EXPECTED_VOL[key]
        if expected_vol > 0.0:
            sharpe_ratio = expected_return / expected_vol
        else:
            sharpe_ratio = 0.0
        return expected_return, expected_vol, sharpe_ratio

    def _calc_max_dd_estimate(self, regime: str) -> float:
        """
        レジーム別最大ドローダウン参照値を返す。

        unknown regime は "uncertain" にフォールバック。
        max_dd_estimate は参照値であり実損失予測保証ではない（P2-7H）。

        Returns:
            float: 0.0 以下の値
        """
        key = regime if regime in _REGIME_MAX_DD else _FALLBACK_REGIME
        return _REGIME_MAX_DD[key]
