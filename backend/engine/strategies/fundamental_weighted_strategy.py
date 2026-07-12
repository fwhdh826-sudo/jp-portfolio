"""
fundamental_weighted_strategy.py — Card 7-4
Phase 7 Multi-Strategy Engine: 戦略C — Fundamental Weighted（Arnott 2005）。

責務:
  - FundamentalWeightedStrategy — BaseStrategy を継承した Fundamental Weighted 計算クラス

Fundamental Weighted 計算仕様（stdlib-only、Arnott 2005 近似）:
  1. FUNDAMENTAL_AXIS_MAP の4軸を使って各銘柄の fundamental_score を計算
     - fundamental_score = sum(axis_total * axis_weight) for each axis in FUNDAMENTAL_AXIS_MAP
     - axis_total: scores[ticker][axis]["total"]（欠損・不正 → DEFAULT_SCORE=50.0 fallback）
     - axis_total: 0.0〜100.0 に clamp
     - safety / momentum は参照しない（FUNDAMENTAL_AXIS_MAP に含まれない）
  2. _apply_top_n_cap() で universe > TOP_N_CAP の場合に上位50銘柄に絞込
     - score 降順 + 同点時は ticker 昇順（deterministic）
     - universe <= TOP_N_CAP の場合は絞らない（入力順維持）
  3. _normalize_weights() で合計 1.0 に正規化
  4. _to_ideal_pf_tuple() で tuple 化
  5. expected_return / expected_vol / max_dd は レジーム別参照値テーブルを使用

Arnott 2005 との対応:
  Research Affiliates Fundamental Index (RAFI) は売上・CF・簿価・配当の経済規模で
  株式を加重し、時価総額バイアス（過大評価株の過体重）を排除する手法。
  本実装では growth/quality/value/shareholder_return の axis total を
  それぞれ revenue/CF/book_value/dividend のプロキシとして使用（P2-7J）。
  time-series 平滑化（5年平均）は axis スコア計算層で実施済みとして扱う。

TOP_N_CAP:
  TOP_N_CAP = 50。spec 5.3「上位50銘柄に絞り込み（実装制約）」を近似。
  universe > 50 の場合のみ score 降順＋ticker 昇順 tie-break で絞込（P2-7K）。
  絞込後に全スコア 0.0 の場合: 等加重 fallback（_normalize_weights の既存動作）。
  diagnostics に all-zero fallback を記録。

参照値について:
  expected_return / expected_vol / max_dd_estimate は Phase 8 までの参照値です。
  実際の将来リターン・ボラティリティ・最大損失を保証するものではありません（P2-7L）。
  Fundamental 戦略は frontier より防御的、quality_size とほぼ同等の参照値。

FUNDAMENTAL_AXIS_MAP（固定4軸、合計 1.0）:
  frontier_strategy: regime-adaptive 全6軸
  quality_size_strategy: quality/safety 偏重固定6軸
  fundamental_weighted_strategy: revenue/CF/book/dividend 対応固定4軸（regime 非依存）

empty universe fallback:
  ideal_pf=(), expected_return=0.0, expected_vol=0.0, sharpe_ratio=0.0,
  max_dd_estimate=0.0, diagnostics に "observation: universe is empty"

unknown regime fallback:
  既知 5 レジーム以外 → "uncertain" にフォールバック + diagnostics 記録

設計原則:
  - 実際の売買制限・注文制限はしない（数値化のみ）
  - 実 LLM / HTTP 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / rating / approve / reject / conditional 禁止
  - numpy / scipy / pandas / cvxpy / sklearn 禁止（math stdlib のみ使用）
  - operation / market_intel / news / regime を直接 import しない
  - get_axis_weights を使わない（固定 FUNDAMENTAL_AXIS_MAP を使用）

実装しないこと:
  - numpy / scipy を使う共分散行列計算・SLSQP 最適化
  - 実財務データ（revenue/CF/book_value/dividend）との直接接続（Phase 8 の責務）
  - Tier A ハード制約の実適用（Card 7-7 の責務）
  - 3ヶ月売却不可ルールの実運用判断
  - BUY / SELL / HOLD / WAIT 判定
  - public / data writer

P2 記録:
  P2-7J: FUNDAMENTAL_AXIS_MAP は axis_total を財務指標プロキシとして使用。
         実財務データ（revenue / CF / book value / dividend）との直接接続は Phase 8 以降。
  P2-7K: TOP_N_CAP=50 は固定値。Card 7-6 Aggregator または Phase 8 でパラメータ化余地あり。
  P2-7L: expected_return / expected_vol / max_dd は regime reference values。
         実バックテスト較正は Phase 8 以降。

P1 記録:
  P1-7X: full pytest absolute import issue は Card 7-4 スコープ外。
         Phase 7 レビューまたは別 Card で修正検討。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 7-4
Reference: docs/v13.3/07_v13.3_spec.md §5.3
Reference: Arnott, R. D., Hsu, J., & Moore, P. (2005). Fundamental Indexation.
           Financial Analysts Journal, 61(2), 83-99.
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

# Arnott 2005 の4指標 → axis total マッピング（固定、合計 1.0）
# revenue_5y_avg → growth(0.30), cf_5y_avg → quality(0.30),
# book_value → value(0.20), dividend_5y_avg → shareholder_return(0.20)
# safety / momentum は Arnott 2005 の指標に対応しないため含めない（P2-7J）
FUNDAMENTAL_AXIS_MAP: dict[str, float] = {
    "growth":             0.30,
    "quality":            0.30,
    "value":              0.20,
    "shareholder_return": 0.20,
}

# spec 5.3「上位50銘柄に絞り込み（実装制約）」の近似（P2-7K）
TOP_N_CAP: int = 50

_FALLBACK_REGIME: str = "uncertain"


# ── レジーム別参照値テーブル（Phase 8 で本格計算に差し替え予定、P2-7L）──────
# Fundamental 戦略は frontier より防御的、quality_size と概ね同等

_REGIME_EXPECTED_RETURN: dict[str, float] = {
    "bull_calm":     0.082,
    "bull_volatile": 0.068,
    "bear":          0.035,
    "crisis":        0.015,
    "uncertain":     0.058,
}

_REGIME_EXPECTED_VOL: dict[str, float] = {
    "bull_calm":     0.115,
    "bull_volatile": 0.165,
    "bear":          0.175,
    "crisis":        0.250,
    "uncertain":     0.145,
}

_REGIME_MAX_DD: dict[str, float] = {
    "bull_calm":     -0.075,
    "bull_volatile": -0.140,
    "bear":          -0.175,
    "crisis":        -0.300,
    "uncertain":     -0.115,
}


# ── FundamentalWeightedStrategy ───────────────────────────────────────────────

class FundamentalWeightedStrategy(BaseStrategy):
    """
    Fundamental Weighted 戦略（Arnott 2005 RAFI 近似）。stdlib-only 実装。

    compute() は pure computation: StrategyInput を受け取り StrategyOutput を返す。
    売買判断・注文生成・発注制限は行わない。

    ideal_pf の各重みは「ファンダメンタル規模比率の計算値」であり、
    「この銘柄を買え/売れ」という命令ではない。

    frontier / quality_size との違い:
      - growth / quality / value / shareholder_return の4軸固定（regime 非依存）
      - quality_bonus なし（QMJ 効果は quality_size の責務）
      - TOP_N_CAP=50 で universe > 50 の場合に上位銘柄絞込（Arnott 実装制約の近似）

    実財務データ（revenue / CF / book value / dividend）との接続は Phase 8 以降（P2-7J）。
    """

    STRATEGY_ID:   str = "fundamental"
    STRATEGY_NAME: str = "Fundamental Weighted (Arnott 2005)"

    def compute(self, strategy_input: StrategyInput) -> StrategyOutput:
        """
        StrategyInput を受け取り FundamentalWeightedStrategy の StrategyOutput を返す。

        Args:
            strategy_input: StrategyInput（universe / scores / regime / horizon を DI）
        Returns:
            StrategyOutput

        制約:
          - strategy_input.scores / context を mutation してはならない
          - BUY / SELL / HOLD / WAIT 判定を行ってはならない
          - numpy / scipy を使用してはならない
          - get_axis_weights を使用してはならない
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
                    "Fundamental Weighted (Arnott 2005): revenue/CF/book/dividend "
                    "proportional allocation (empty universe — no allocation computed)"
                ),
                diagnostics=tuple(diagnostics),
            )

        # ── unknown regime 検出 ───────────────────────────────────────────────
        if strategy_input.regime not in _REGIME_EXPECTED_RETURN:
            diagnostics.append(
                f"observation: unknown regime '{strategy_input.regime}' "
                f"— fallback to '{_FALLBACK_REGIME}'"
            )

        # ── fundamental score weights 計算 ────────────────────────────────────
        score_weights, score_diagnostics = self._build_score_weights(
            strategy_input.universe,
            strategy_input.scores,
        )
        diagnostics.extend(score_diagnostics)

        # ── TOP_N_CAP 適用 ────────────────────────────────────────────────────
        score_weights, cap_diagnostics = self._apply_top_n_cap(score_weights)
        diagnostics.extend(cap_diagnostics)

        # ── all-zero after cap チェック ───────────────────────────────────────
        if score_weights and all(v == 0.0 for v in score_weights.values()):
            diagnostics.append(
                "observation: all fundamental scores are zero after filtering; "
                "equal weight fallback used"
            )

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
                f"Fundamental Weighted (Arnott 2005): revenue/CF/book/dividend "
                f"proportional allocation (regime={strategy_input.regime})"
            ),
            diagnostics=tuple(diagnostics),
        )

    # ── private helpers ───────────────────────────────────────────────────────

    def _calc_fundamental_score(
        self,
        ticker_scores: dict,
    ) -> float:
        """
        1銘柄の fundamental_score を計算する。

        fundamental_score = sum(axis_total * axis_weight for axis in FUNDAMENTAL_AXIS_MAP)

        FUNDAMENTAL_AXIS_MAP は固定4軸（growth / quality / value / shareholder_return）。
        safety / momentum は参照しない。
        axis_total は 0.0〜100.0 に clamp。欠損・不正 → DEFAULT_SCORE fallback。

        Args:
            ticker_scores: {axis_name: {"total": float}} の dict

        Returns:
            float: fundamental_score
        """
        score = 0.0
        for axis, axis_weight in FUNDAMENTAL_AXIS_MAP.items():
            axis_data = ticker_scores.get(axis)
            if isinstance(axis_data, dict):
                raw_total = axis_data.get("total", DEFAULT_SCORE)
            else:
                raw_total = DEFAULT_SCORE
            axis_total = _clamp(
                _safe_float(raw_total, DEFAULT_SCORE),
                0.0, 100.0,
            )
            score += axis_total * axis_weight
        return score

    def _build_score_weights(
        self,
        universe: tuple[str, ...],
        scores: dict,
    ) -> tuple[dict[str, float], list[str]]:
        """
        universe の各銘柄の fundamental_score を計算し、{ticker: score} dict を返す。

        入力順を維持する（TOP_N_CAP 適用前の段階では絞込しない）。

        Returns:
            (score_weights, diagnostics_list)
        """
        score_weights: dict[str, float] = {}
        diag: list[str] = []
        missing_tickers: list[str] = []
        bad_score_tickers: list[str] = []

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

            score_weights[ticker] = self._calc_fundamental_score(ticker_scores)

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

        return score_weights, diag

    def _apply_top_n_cap(
        self,
        score_weights: dict[str, float],
    ) -> tuple[dict[str, float], list[str]]:
        """
        universe > TOP_N_CAP の場合、score 降順・ticker 昇順（tie-break）で
        上位 TOP_N_CAP 銘柄に絞込む。

        絞込条件: len(score_weights) > TOP_N_CAP
        絞込なし: len(score_weights) <= TOP_N_CAP（入力順を維持した dict を返す）

        tie-break に ticker 昇順を使用することで同点スコア時の出力順を deterministic にする。

        Returns:
            (filtered_score_weights, diagnostics_list)
        """
        diag: list[str] = []
        total = len(score_weights)

        if total <= TOP_N_CAP:
            return score_weights, diag

        # score 降順 + ticker 昇順（tie-break）
        sorted_items = sorted(
            score_weights.items(),
            key=lambda x: (-x[1], x[0]),
        )
        top_items = sorted_items[:TOP_N_CAP]
        filtered = dict(top_items)

        diag.append(
            f"observation: top-N cap applied — {TOP_N_CAP} of {total} tickers selected "
            f"(score desc, ticker asc tie-break)"
        )

        return filtered, diag

    def _calc_expected_metrics(
        self, regime: str
    ) -> tuple[float, float, float]:
        """
        レジーム別参照値から (expected_return, expected_vol, sharpe_ratio) を返す。

        unknown regime は "uncertain" にフォールバック。
        expected_return / expected_vol は参照値であり保証ではない（P2-7L）。

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
        max_dd_estimate は参照値であり実損失予測保証ではない（P2-7L）。

        Returns:
            float: 0.0 以下の値
        """
        key = regime if regime in _REGIME_MAX_DD else _FALLBACK_REGIME
        return _REGIME_MAX_DD[key]
