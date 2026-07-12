"""
cross_factor_strategy.py — Card 7-5
Phase 7 Multi-Strategy Engine: 戦略D — Cross-Factor（Alquist 2018）。

責務:
  - CrossFactorStrategy — BaseStrategy を継承した Cross-Factor 計算クラス

Cross-Factor 計算仕様（stdlib-only、Alquist 2018 近似）:
  1. 各銘柄の cross-axis signals を内部計算（spec 2.1 準拠）
     - quality_total / value_total / momentum_total を 0.0〜100.0 clamp
     - size_signal を scores[ticker]["size_segment"] または context DI で解決
     - size_quality  = size_signal * quality_total  / 100.0
     - size_value    = size_signal * value_total    / 100.0
     - size_momentum = size_signal * momentum_total / 100.0
     - quality_value = quality_total * value_total  / 100.0
  2. cross_factor_score = weighted sum（CROSS_SIGNAL_WEIGHTS を使用）
  3. _select_top_n(): score 降順 + ticker 昇順 tie-break で上位 TOP_N_CAP_CF を抽出
     - universe > TOP_N_CAP_CF の場合のみ絞込
     - universe <= TOP_N_CAP_CF の場合は入力順維持
  4. 抽出対象を等加重（1/N）にして _to_ideal_pf_tuple() で tuple 化
  5. expected_return / expected_vol / max_dd は レジーム別参照値テーブルを使用

等加重設計（他3戦略との最大の違い）:
  score は「どの銘柄を計算対象に含めるか」の抽出基準にのみ使用する。
  抽出された銘柄の weight は常に 1/N（score-proportional ではない）。
  これは「計算対象抽出後の等分配分」であり、銘柄推奨・買付指示ではない。

Alquist 2018 との対応:
  Size × Quality / Value / Momentum の cross 効果（size 触媒）を計算し、
  全レジームで安定した配分を目指す multi-factor 戦略の近似実装。
  size_signal は scores / context の DI または DEFAULT=50（mid_cap 相当）で近似（P2-7M）。
  quality_growth / anti_junk は spec 2.1 に定義されるが、
  spec 5.4 の weight formula に含まれないため今回の score 計算から除外（P2-7N）。

TOP_N_CAP_CF:
  TOP_N_CAP_CF = 25。spec 5.4「上位25銘柄を等加重」を近似（P2-7O）。
  universe > 25 の場合のみ score 降順＋ticker 昇順 tie-break で絞込。
  universe <= 25 の場合は全銘柄を等加重（入力順維持）。
  「抽出」は計算上の操作であり、推奨・買付候補の選定ではない。

参照値について:
  expected_return / expected_vol / max_dd_estimate は Phase 8 までの参照値です。
  Cross-Factor は「全レジーム安定」設計のため、vol/max_dd のレジーム間ばらつきが
  4戦略中最小の想定（P2-7O）。保証値ではありません。

設計原則:
  - 実際の売買制限・注文制限はしない（数値化のみ）
  - 実 LLM / HTTP 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / rating / approve / reject / conditional 禁止
  - numpy / scipy / pandas / cvxpy / sklearn 禁止（math stdlib のみ使用）
  - operation / market_intel / news / regime を直接 import しない
  - get_axis_weights を使わない（固定 CROSS_SIGNAL_WEIGHTS を使用）
  - growth / safety / shareholder_return は今回の score formula に使わない

実装しないこと:
  - numpy / scipy を使う共分散行列計算・SLSQP 最適化
  - 実市場時価総額 Size factor の直接接続（Phase 8 の責務）
  - quality_growth / anti_junk の weight formula への組み込み（Phase 8 拡張余地）
  - Tier A ハード制約の実適用（Card 7-7 の責務）
  - 3ヶ月売却不可ルールの実運用判断
  - BUY / SELL / HOLD / WAIT 判定
  - public / data writer

P2 記録:
  P2-7M: size_signal は scores/context の size_segment DI または DEFAULT=50（mid_cap）で近似。
         実市場時価総額データとの接続は Phase 8 以降。
  P2-7N: quality_growth / anti_junk は spec 2.1 に定義されるが spec 5.4 の weight formula に含めない。
         Phase 8 で拡張余地あり。
  P2-7O: TOP_N_CAP_CF=25 は固定値。Card 7-6 Aggregator または Phase 8 でパラメータ化余地あり。

P1 記録:
  P1-7X: full pytest absolute import issue は Card 7-5 スコープ外（継続）。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 7-5
Reference: docs/v13.3/07_v13.3_spec.md §2.1, §5.4
Reference: Alquist, R., Israel, R., & Moskowitz, T. (2018).
           Fact, Fiction, and the Size Effect. Journal of Portfolio Management, 45(1).
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
DEFAULT_SIZE_SIGNAL: float = 50.0  # mid_cap 相当

# spec 5.4 の4シグナル weight（合計 1.0）
CROSS_SIGNAL_WEIGHTS: dict[str, float] = {
    "size_quality":  0.30,
    "size_value":    0.25,
    "size_momentum": 0.25,
    "quality_value": 0.20,
}

# size_segment → size_signal 変換テーブル（spec 2.1 準拠）
SIZE_SIGNAL_MAP: dict[str, float] = {
    "small_cap": 80.0,
    "mid_cap":   50.0,
    "large_cap": 30.0,
}

# spec 5.4「上位25銘柄を等加重」を近似（P2-7O）
TOP_N_CAP_CF: int = 25

_FALLBACK_REGIME: str = "uncertain"


# ── レジーム別参照値テーブル（Phase 8 で本格計算に差し替え予定）────────────────
# Cross-Factor は「全レジーム安定」設計 → vol/max_dd のレジーム間ばらつきが4戦略中最小

_REGIME_EXPECTED_RETURN: dict[str, float] = {
    "bull_calm":     0.072,
    "bull_volatile": 0.060,
    "bear":          0.035,
    "crisis":        0.020,
    "uncertain":     0.055,
}

_REGIME_EXPECTED_VOL: dict[str, float] = {
    "bull_calm":     0.095,
    "bull_volatile": 0.130,
    "bear":          0.140,
    "crisis":        0.200,
    "uncertain":     0.115,
}

_REGIME_MAX_DD: dict[str, float] = {
    "bull_calm":     -0.065,
    "bull_volatile": -0.100,
    "bear":          -0.130,
    "crisis":        -0.220,
    "uncertain":     -0.090,
}


# ── CrossFactorStrategy ───────────────────────────────────────────────────────

class CrossFactorStrategy(BaseStrategy):
    """
    Cross-Factor 戦略（Alquist 2018 size 触媒近似）。stdlib-only 実装。

    compute() は pure computation: StrategyInput を受け取り StrategyOutput を返す。
    売買判断・注文生成・発注制限は行わない。

    ideal_pf の各重みは「cross-factor score による計算対象抽出後の等分配分比率」であり、
    「この銘柄を買え/売れ」という命令ではない。

    他3戦略との最大の違い:
      score は抽出基準にのみ使用。配分は常に等加重（score-proportional ではない）。
      TOP_N_CAP_CF=25 で絞込（universe > 25 の場合のみ）。

    実市場時価総額データは未接続（DEFAULT_SIZE_SIGNAL=50 で近似、P2-7M）。
    quality_growth / anti_junk は weight formula に含めない（P2-7N）。
    """

    STRATEGY_ID:   str = "cross_factor"
    STRATEGY_NAME: str = "Cross-Factor (Alquist 2018)"

    def compute(self, strategy_input: StrategyInput) -> StrategyOutput:
        """
        StrategyInput を受け取り CrossFactorStrategy の StrategyOutput を返す。

        Args:
            strategy_input: StrategyInput（universe / scores / regime / horizon / context を DI）
        Returns:
            StrategyOutput

        制約:
          - strategy_input.scores / context を mutation してはならない
          - BUY / SELL / HOLD / WAIT 判定を行ってはならない
          - numpy / scipy を使用してはならない
          - get_axis_weights を使用してはならない
          - 銘柄推奨・buy/sell候補の選定を行ってはならない
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
                    "Cross-Factor (Alquist 2018): size×quality/value/momentum cross signals, "
                    "equal-weight top-N extraction (calculation-only, not a recommendation) "
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

        # ── cross-factor score weights 計算 ───────────────────────────────────
        score_weights, score_diagnostics = self._build_cross_scores(
            strategy_input.universe,
            strategy_input.scores,
            strategy_input.context,
        )
        diagnostics.extend(score_diagnostics)

        # ── all-zero チェック ─────────────────────────────────────────────────
        if score_weights and all(v == 0.0 for v in score_weights.values()):
            diagnostics.append(
                "observation: all cross-factor scores are zero; "
                "equal-weight fallback used (calculation-only, not a recommendation)"
            )

        # ── top-N 抽出 + 等加重 ───────────────────────────────────────────────
        selected_weights, select_diagnostics = self._select_top_n(score_weights)
        diagnostics.extend(select_diagnostics)

        # ── ideal_pf tuple 化 ─────────────────────────────────────────────────
        ideal_pf = self._to_ideal_pf_tuple(selected_weights)

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
                f"Cross-Factor (Alquist 2018): size×quality/value/momentum cross signals, "
                f"equal-weight top-N extraction (calculation-only, not a recommendation) "
                f"(regime={strategy_input.regime})"
            ),
            diagnostics=tuple(diagnostics),
        )

    # ── private helpers ───────────────────────────────────────────────────────

    def _resolve_size_signal(
        self,
        ticker: str,
        scores: dict,
        context: dict,
    ) -> float:
        """
        size_signal を解決する。

        解決優先順位:
          1. scores[ticker]["size_segment"] が既知 str → SIZE_SIGNAL_MAP で変換
          2. context["size_segments"][ticker] が既知 str → SIZE_SIGNAL_MAP で変換
          3. DEFAULT_SIZE_SIGNAL（= 50.0、mid_cap 相当）

        安全性:
          - context が dict でない場合でも crash しない
          - context["size_segments"] が dict でない場合も crash しない
          - 未知 str / 非 str は DEFAULT_SIZE_SIGNAL にフォールバック

        Args:
            ticker:  銘柄 ticker
            scores:  strategy_input.scores（mutation 禁止）
            context: strategy_input.context（mutation 禁止）

        Returns:
            float: size_signal（0.0 以上）
        """
        # 優先順位1: scores[ticker]["size_segment"]
        ticker_scores = scores.get(ticker)
        if isinstance(ticker_scores, dict):
            seg = ticker_scores.get("size_segment")
            if isinstance(seg, str) and seg in SIZE_SIGNAL_MAP:
                return SIZE_SIGNAL_MAP[seg]

        # 優先順位2: context["size_segments"][ticker]
        if isinstance(context, dict):
            size_segments = context.get("size_segments")
            if isinstance(size_segments, dict):
                seg = size_segments.get(ticker)
                if isinstance(seg, str) and seg in SIZE_SIGNAL_MAP:
                    return SIZE_SIGNAL_MAP[seg]

        return DEFAULT_SIZE_SIGNAL

    def _calc_cross_factor_score(
        self,
        ticker_scores: dict,
        size_signal: float,
    ) -> float:
        """
        1銘柄の cross_factor_score を計算する。

        cross_factor_score = weighted sum of 4 signals（CROSS_SIGNAL_WEIGHTS）:
          size_quality  = size_signal * quality_total  / 100.0
          size_value    = size_signal * value_total    / 100.0
          size_momentum = size_signal * momentum_total / 100.0
          quality_value = quality_total * value_total  / 100.0

        各 axis_total は 0.0〜100.0 clamp。欠損・不正 → DEFAULT_SCORE=50.0 fallback。
        growth / safety / shareholder_return は今回の weight formula に含めない（spec 5.4）。
        quality_growth / anti_junk も weight formula から除外（P2-7N）。

        Args:
            ticker_scores: {axis_name: {"total": float}} の dict
            size_signal:   解決済みの size_signal 値

        Returns:
            float: cross_factor_score（0.0 以上）
        """
        def _axis_total(axis: str) -> float:
            data = ticker_scores.get(axis)
            if isinstance(data, dict):
                raw = data.get("total", DEFAULT_SCORE)
            else:
                raw = DEFAULT_SCORE
            return _clamp(_safe_float(raw, DEFAULT_SCORE), 0.0, 100.0)

        quality_total  = _axis_total("quality")
        value_total    = _axis_total("value")
        momentum_total = _axis_total("momentum")

        size_quality  = size_signal * quality_total  / 100.0
        size_value    = size_signal * value_total    / 100.0
        size_momentum = size_signal * momentum_total / 100.0
        quality_value = quality_total * value_total  / 100.0

        score = (
            size_quality  * CROSS_SIGNAL_WEIGHTS["size_quality"]  +
            size_value    * CROSS_SIGNAL_WEIGHTS["size_value"]    +
            size_momentum * CROSS_SIGNAL_WEIGHTS["size_momentum"] +
            quality_value * CROSS_SIGNAL_WEIGHTS["quality_value"]
        )
        return score

    def _build_cross_scores(
        self,
        universe: tuple[str, ...],
        scores: dict,
        context: dict,
    ) -> tuple[dict[str, float], list[str]]:
        """
        universe の各銘柄の cross_factor_score を計算し、{ticker: score} dict を返す。

        Returns:
            (score_weights, diagnostics_list)
        """
        score_weights: dict[str, float] = {}
        diag: list[str] = []
        missing_tickers: list[str] = []
        bad_score_tickers: list[str] = []
        invalid_size_tickers: list[str] = []

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

            # size_signal 解決（invalid size_segment の記録）
            size_signal = self._resolve_size_signal(ticker, scores, context)
            if size_signal == DEFAULT_SIZE_SIGNAL:
                # 有効な size_segment が見つからなかった場合（scores / context に存在しない場合も含む）
                # ただし scores[ticker] 自体が missing でもここに来るため、
                # ticker_scores が空の場合は size_segment 欠損扱いはしない
                if ticker_scores:
                    seg = ticker_scores.get("size_segment")
                    if seg is not None and not (isinstance(seg, str) and seg in SIZE_SIGNAL_MAP):
                        invalid_size_tickers.append(ticker)

            score_weights[ticker] = self._calc_cross_factor_score(ticker_scores, size_signal)

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
        if invalid_size_tickers:
            diag.append(
                f"observation: {len(invalid_size_tickers)} ticker(s) had invalid size_segment "
                f"— used DEFAULT_SIZE_SIGNAL={DEFAULT_SIZE_SIGNAL} fallback"
            )

        return score_weights, diag

    def _select_top_n(
        self,
        score_weights: dict[str, float],
    ) -> tuple[dict[str, float], list[str]]:
        """
        計算対象の抽出と等加重化を行う。

        universe > TOP_N_CAP_CF の場合:
          score 降順 + ticker 昇順（tie-break）で上位 TOP_N_CAP_CF を抽出
          抽出対象を等加重（1 / TOP_N_CAP_CF）
          「抽出」は計算上の操作であり銘柄推奨・buy候補選定ではない

        universe <= TOP_N_CAP_CF の場合:
          全銘柄を等加重（1 / N）
          入力順維持

        Returns:
            (equal_weight_dict, diagnostics_list)
        """
        diag: list[str] = []
        n = len(score_weights)

        if n == 0:
            return {}, diag

        if n <= TOP_N_CAP_CF:
            eq_w = 1.0 / n
            return {t: eq_w for t in score_weights}, diag

        # score 降順 + ticker 昇順（tie-break）で deterministic に抽出
        sorted_items = sorted(
            score_weights.items(),
            key=lambda x: (-x[1], x[0]),
        )
        top_items = sorted_items[:TOP_N_CAP_CF]
        eq_w = 1.0 / TOP_N_CAP_CF
        result = {t: eq_w for t, _ in top_items}

        diag.append(
            f"observation: top-{TOP_N_CAP_CF} of {n} tickers extracted by cross-factor score "
            f"(score desc, ticker asc tie-break); equal-weighted "
            f"(calculation-only extraction, not a recommendation)"
        )

        return result, diag

    def _calc_expected_metrics(
        self, regime: str
    ) -> tuple[float, float, float]:
        """
        レジーム別参照値から (expected_return, expected_vol, sharpe_ratio) を返す。

        unknown regime は "uncertain" にフォールバック。
        expected_return / expected_vol は参照値であり保証ではない。

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
        max_dd_estimate は参照値であり実損失予測保証ではない。

        Returns:
            float: 0.0 以下の値
        """
        key = regime if regime in _REGIME_MAX_DD else _FALLBACK_REGIME
        return _REGIME_MAX_DD[key]
