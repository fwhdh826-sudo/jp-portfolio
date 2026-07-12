"""
frontier_strategy.py — Card 7-2（Phase 7）+ Card 8-4（Phase 8 接続）
Multi-Strategy Engine: 戦略A — Frontier AI Index。

責務:
  - FrontierStrategy — BaseStrategy を継承した Frontier AI Index 計算クラス

公開 API（P3-Frontier-expose）:
  - compute(strategy_input) -> StrategyOutput
        既存契約。戻り値・経路選択・diagnostics は一切不変。
  - compute_with_frontier_index(strategy_input)
        -> tuple[StrategyOutput, dict | None]
        compute() と同一の StrategyOutput に加え、Phase 8 経路で内部構築した
        FrontierIndex を raw .to_dict()（dict）で第 2 要素に返す read-only 拡張。
        Phase 7 / empty universe は第 2 要素 None。FrontierIndex オブジェクトは
        外部に渡さない（raw dict のみ）。内部キャッシュ・public/data 書き込み・
        Operation pipeline 再実行は一切しない。

経路選択（Card 8-4）:
  StrategyInput.context["returns_data"] が dict かつ len > 0:
    → Phase 8 経路: ExpectedReturnModel / CovarianceModel /
      ConstraintBuilder / EfficientFrontierOptimizer / IndexBuilder
      を順に呼び FrontierIndex 経由で StrategyOutput を構築。
  上記以外（キー不在 / 非dict / 空dict）:
    → Phase 7 fallback: stdlib-only の score-proportional 計算。

Phase 8 経路の context キー（フラット名前空間、P1-8P）:
  - returns_data: dict[str, list[float]]                        # 月次リターン系列
  - mean_return_3y_by_ticker: dict[str, float]                  # AssetMetaInput
  - size_segment_by_ticker:   dict[str, str]                    # default "large_cap"
  - risk_flags_by_ticker:     dict[str, dict[str, bool]]        # is_risk_on / is_defensive / is_energy / is_overseas
  - cross_axis_signals:       dict[str, dict[str, float]]
  - market_intel:             dict | None                       # sentiment_score / keywords
  - asset_meta_by_ticker:     dict[str, dict[str, Any]]         # sector / is_core / is_leveraged
  - locked_weights:           dict[str, float]                  # 3ヶ月ロック中
  - risk_free_rate:           float = 0.0
  - shrinkage_alpha:          float = 0.1
  - min_periods:              int   = 3
  - calculation_date:         str   = ""
  未使用キーは無視。context は mutation しない（読み取り専用）。

Phase 8 → Phase 7 戻し fallback はしない（P1-8R）:
  returns_data が dict かつ len > 0 → 必ず Phase 8 経路。
  部分欠損は Phase 8 内部 fallback で処理（CovarianceModel の局所 fallback,
  ExpectedReturnModel の missing → 0.0 fallback, EfficientFrontierOptimizer の
  SLSQP 非収束 fallback など）。

参照値について:
  expected_return / expected_vol / sharpe_ratio は Phase 8 経路では
  最適化計算値。Phase 7 経路では regime reference 値。
  max_dd_estimate は:
    Phase 8 経路: returns_data ベースの観測 max drawdown（Card C / P2-8N）。
                  returns_data 欠損/不足/計算異常時は regime reference fallback。
    Phase 7 経路: regime reference 値（変更なし）。

設計原則:
  - BUY/SELL/HOLD/WAIT 禁止
  - action/recommendation/is_buy/is_sell/is_hold/is_recommended/
    verdict/decision/rating/approve/reject/conditional 禁止
  - pandas 禁止
  - 自コードに `import numpy` / `import scipy` 禁止
    （scipy は efficient_frontier.py に閉じ込め、FrontierStrategy からは
     EfficientFrontierOptimizer インスタンス経由でのみ使用）
  - operation/market_intel/news/regime を直接 import しない
  - public/data writer 禁止
  - context を mutation しない

P1/P2 記録（Card 8-4 時点 / Card C で更新）:
  P1-8N: （Card C で解消）max_dd_estimate は Phase 8 経路では returns_data
         ベースの観測 max drawdown。DrawdownEstimator（frontier sibling）が
         decision.dd10_kpi.calc_max_drawdown を再利用して計算。returns_data
         欠損/不足/計算異常時のみ regime reference へ fallback。Phase 7 は
         regime reference 継続。
  P1-8O: StrategyInput.scores 不在/空時は ExpectedReturnModel の
         DEFAULT_SCORE=50.0 fallback で alpha_score ≈ 0。
  P1-8P: context はフラットなキー名前空間（namespace なし）。
  P1-8Q: ExpectedReturnResult.per_asset[i].diagnostics は集約しない
         （ticker 数が多いと verbose になる、global diagnostics で十分）。
  P1-8R: Phase 8 → Phase 7 戻し fallback なし。
         全 returns_data 不在のみ Phase 7 経路。
  P2-7D: 解決（Card 8-4 で Phase 8 SLSQP 接続）。
  P2-7E: 解決（expected_return / vol / sharpe は Phase 8 計算値、
         max_dd は P1-8N に統合）。
  P2-7F: 解決（market_intel は MarketIntelContext 経由で接続）。
  P2-7Q: 解決（expected_vol は CovarianceResult から計算）。
  P2-8I: 解決（FrontierStrategy 接続完了）。
  P2-8N: 解決（Card C: Phase 8 max_dd_estimate は returns_data ベース観測値。
         DrawdownEstimator 経由。regime reference は fallback として温存）。
  P2-8O: Phase 8 / Phase 7 経路を context flag で明示切替する後続課題。
  P2-8P: horizon を risk_aversion 調整に連動する後続課題。
  P2-8Q: Aggregator が FrontierStrategy Phase 8 出力を消費する影響検証。
  P2-8R: constraint パラメータの context 上書き対応。

P1 記録（P3-Frontier-expose / Scope B）:
  P1-FE-1: compute() の公開契約（StrategyOutput / 経路選択 / diagnostics）は
           一切変更しない。FrontierIndex raw 露出は新規 public method
           compute_with_frontier_index() に限定する。
  P1-FE-2: 内部 _compute_phase8() の戻り値型を (StrategyOutput, FrontierIndex)
           に変更してよい。compute() は [0] のみ返し従来と byte 等価を維持。
  P1-FE-3: compute_with_frontier_index(strategy_input)
           -> tuple[StrategyOutput, dict | None]。
           Phase 8 → (output, frontier_index.to_dict())。
           Phase 7 / empty universe → (output, None)。
  P1-FE-4: 第 2 要素は raw dict のみ。FrontierIndex オブジェクトは外部に
           渡さない（カプセル化維持）。
  P1-FE-5: StrategyOutput へのフィールド追加なし／内部キャッシュなし／
           public/data 書き込みなし／Operation pipeline 再実行なし。
  P1-FE-6: FrontierIndex.to_dict() は 9 キー（index_name / tickers / weights /
           expected_return / expected_vol / sharpe_ratio / regime_used /
           calculation_date / diagnostics）。本 Card は schema を変更しない。
  P1-FE-7: numpy / scipy / pandas 直接 import 禁止を継続
           （scipy は EfficientFrontierOptimizer に閉じ込め）。

P2/P3 記録（後続）:
  P2-D3-compute-actual: 本 Card で解消した FrontierIndex 露出を前提に、
                        Operation 層で実 compute → caller へ DI する多段 Card。
  P2-D2-actual: public/data/phase8 namespace ratify + 実 write。
  P3-PA1-X: FrontierStrategy 側 identifier 公開定数 export（独立・小規模）。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 7-2 / Card 8-4
"""
from __future__ import annotations

from typing import Any

from engine.dynamic_weight.regime_axis_weights import get_axis_weights
from engine.strategies.base_strategy import (
    BaseStrategy,
    StrategyInput,
    StrategyOutput,
    _clamp,
    _safe_float,
)

# Phase 8 接続（Card 8-4）
from engine.frontier.covariance_model import (
    CovarianceInput,
    CovarianceModel,
)
from engine.frontier.efficient_frontier import (
    EfficientFrontierInput,
    EfficientFrontierOptimizer,
)
from engine.frontier.expected_return_model import (
    AssetMetaInput,
    ExpectedReturnInput,
    ExpectedReturnModel,
    MarketIntelContext,
)
from engine.frontier.index_builder import (
    IndexBuilder,
    IndexBuilderInput,
)
from engine.frontier.optimizer_constraints import (
    ConstraintBuilder,
    ConstraintInput,
)
# Card C（P2-8N）: returns_data ベース観測 max drawdown。
# frontier sibling のみ import。decision.dd10_kpi は drawdown_estimator に閉じ込め。
from engine.frontier.drawdown_estimator import (
    DrawdownEstimator,
    DrawdownEstimatorInput,
)

DEFAULT_SCORE: float = 50.0


# ── レジーム別参照値テーブル（Phase 7 fallback / Phase 8 の max_dd 用）────────

_REGIME_EXPECTED_RETURN: dict[str, float] = {
    "bull_calm":     0.090,
    "bull_volatile": 0.070,
    "bear":          0.030,
    "crisis":        0.010,
    "uncertain":     0.060,
}

_REGIME_EXPECTED_VOL: dict[str, float] = {
    "bull_calm":     0.120,
    "bull_volatile": 0.180,
    "bear":          0.200,
    "crisis":        0.300,
    "uncertain":     0.150,
}

_REGIME_MAX_DD: dict[str, float] = {
    "bull_calm":     -0.08,
    "bull_volatile": -0.15,
    "bear":          -0.20,
    "crisis":        -0.35,
    "uncertain":     -0.12,
}

_FALLBACK_REGIME: str = "uncertain"


# ── FrontierStrategy ──────────────────────────────────────────────────────────

class FrontierStrategy(BaseStrategy):
    """
    Frontier AI Index 戦略。

    compute() は pure computation: StrategyInput を受け取り StrategyOutput を返す。
    売買判断・注文生成・発注制限は行わない。

    ideal_pf の各重みは
      Phase 8 経路: SLSQP 最適化による Sharpe 最大化計算結果としての理想配分比率
      Phase 7 経路: レジーム別6軸スコアに比例した score-proportional 配分
    であり、いずれも「この銘柄を買え/売れ」という命令ではない。

    Phase 8 経路は context["returns_data"] が dict かつ len > 0 のときに選択される。
    """

    STRATEGY_ID:   str = "frontier"
    STRATEGY_NAME: str = "Frontier AI Index"

    def compute(self, strategy_input: StrategyInput) -> StrategyOutput:
        """
        StrategyInput を受け取り FrontierStrategy の StrategyOutput を返す。

        Args:
            strategy_input: StrategyInput（universe / scores / regime / horizon / context を DI）
        Returns:
            StrategyOutput

        制約:
          - strategy_input.scores / context を mutation してはならない
          - BUY/SELL/HOLD/WAIT 判定を行ってはならない
          - numpy / scipy / pandas を直接 import してはならない
        """
        # ── empty universe（早期返却・経路を問わず同一挙動） ─────────────────
        if not strategy_input.universe:
            return StrategyOutput(
                strategy_id=self.STRATEGY_ID,
                strategy_name=self.STRATEGY_NAME,
                ideal_pf=(),
                expected_return=0.0,
                expected_vol=0.0,
                sharpe_ratio=0.0,
                max_dd_estimate=0.0,
                rationale=(
                    "Frontier AI Index: regime-weighted 6-axis score allocation "
                    "(empty universe — no allocation computed)"
                ),
                diagnostics=(
                    "observation: universe is empty",
                    "observation: regime expected metrics are reference values, not guarantees",
                ),
            )

        # ── context 安全取得（mutation せず） ────────────────────────────────
        ctx: dict = (
            strategy_input.context
            if isinstance(strategy_input.context, dict)
            else {}
        )

        # ── 経路選択 ─────────────────────────────────────────────────────────
        returns_data = ctx.get("returns_data")
        if isinstance(returns_data, dict) and len(returns_data) > 0:
            output, _frontier_index = self._compute_phase8(strategy_input, ctx)
            return output

        return self._compute_phase7(strategy_input)

    # ── 公開拡張 API（P3-Frontier-expose / Scope B）─────────────────────────

    def compute_with_frontier_index(
        self, strategy_input: StrategyInput
    ) -> tuple[StrategyOutput, dict | None]:
        """
        compute() と同一の StrategyOutput に加え、Phase 8 経路で内部構築した
        FrontierIndex を raw .to_dict()（dict）で返す read-only 拡張 API。

        compute() の公開契約は一切変更しない（本メソッドは独立した追加経路）。
          - Phase 8 経路:            (StrategyOutput, frontier_index.to_dict())
          - Phase 7 経路 / empty:    (StrategyOutput, None)

        第 2 要素は raw dict のみで、FrontierIndex オブジェクトは外部に渡さない。
        内部キャッシュ・public/data 書き込み・Operation pipeline 再実行は
        一切行わない（P1-FE-3 / P1-FE-4 / P1-FE-5）。

        Args:
            strategy_input: StrategyInput（compute() と同一 DI）
        Returns:
            tuple[StrategyOutput, dict | None]
              - [0]: compute(strategy_input) と等価な StrategyOutput
              - [1]: Phase 8 → FrontierIndex.to_dict()（9 キー）/
                     Phase 7・empty universe → None

        制約:
          - compute() と同一（scores / context を mutation しない、
            BUY/SELL/HOLD/WAIT 判定なし、numpy/scipy/pandas 直接 import なし）
        """
        # ── empty universe: compute() の早期返却と同一 StrategyOutput ─────────
        if not strategy_input.universe:
            return self.compute(strategy_input), None

        # ── context 安全取得（mutation せず、compute() と同一ロジック） ───────
        ctx: dict = (
            strategy_input.context
            if isinstance(strategy_input.context, dict)
            else {}
        )

        # ── 経路選択（compute() と同一判定） ─────────────────────────────────
        returns_data = ctx.get("returns_data")
        if isinstance(returns_data, dict) and len(returns_data) > 0:
            output, frontier_index = self._compute_phase8(strategy_input, ctx)
            return output, frontier_index.to_dict()

        return self._compute_phase7(strategy_input), None

    # ── Phase 7 fallback（score-proportional, stdlib-only） ──────────────────

    def _compute_phase7(self, strategy_input: StrategyInput) -> StrategyOutput:
        """Phase 7 score-proportional 配分（returns_data 不在時の fallback）。"""
        diagnostics: list[str] = []

        # axis_weights（DI 経由）
        axis_weights = self._get_axis_weights(strategy_input.regime)

        # unknown regime 検出
        if strategy_input.regime not in _REGIME_EXPECTED_RETURN:
            diagnostics.append(
                f"observation: unknown regime '{strategy_input.regime}' "
                f"— fallback to '{_FALLBACK_REGIME}'"
            )

        # score weights 計算
        score_weights, score_diagnostics = self._build_score_weights(
            strategy_input.universe,
            strategy_input.scores,
            axis_weights,
        )
        diagnostics.extend(score_diagnostics)

        # 正規化 → ideal_pf
        normalized = self._normalize_weights(score_weights)
        ideal_pf = self._to_ideal_pf_tuple(normalized)

        # expected metrics（regime reference）
        expected_return, expected_vol, sharpe_ratio = self._calc_expected_metrics(
            strategy_input.regime
        )
        max_dd_estimate = self._calc_max_dd_estimate(strategy_input.regime)

        # 参照値の観察文言（既存挙動を保持）
        diagnostics.append(
            "observation: regime expected metrics are reference values, not guarantees"
        )
        # Phase 7 経路の identifier（Card 8-4 で追加、末尾に配置して既存テスト互換）
        diagnostics.append(
            "observation: Phase 8 returns_data not provided; "
            "using Phase 7 score-proportional allocation"
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
                f"Frontier AI Index: regime-weighted 6-axis score allocation "
                f"(regime={strategy_input.regime})"
            ),
            diagnostics=tuple(diagnostics),
        )

    # ── Phase 8 接続（SLSQP via EfficientFrontierOptimizer） ─────────────────

    def _compute_phase8(
        self,
        strategy_input: StrategyInput,
        ctx: dict,
    ) -> tuple[StrategyOutput, Any]:
        """
        Phase 8 SLSQP 最適化経路。

        Returns:
            (StrategyOutput, FrontierIndex)。
            StrategyOutput は compute() が返す値と完全に同一。
            FrontierIndex は内部構築物で、compute() は第 1 要素のみ返し
            外部露出しない。compute_with_frontier_index() のみが第 2 要素を
            .to_dict() で raw 公開する（P1-FE-2）。
        """
        diagnostics: list[str] = []
        regime = strategy_input.regime
        universe = strategy_input.universe
        scores = strategy_input.scores if isinstance(strategy_input.scores, dict) else {}

        # 1. 経路選択 diagnostic
        diagnostics.append(
            "observation: Phase 8 SLSQP optimization used (returns_data provided)"
        )

        # 2. unknown regime fallback diagnostic
        if regime not in _REGIME_EXPECTED_RETURN:
            diagnostics.append(
                f"observation: unknown regime '{regime}' "
                f"— regime reference fallback to '{_FALLBACK_REGIME}' for max_dd_estimate"
            )

        # ── AssetMetaInput / MarketIntelContext を構築 ────────────────────────
        assets = self._build_asset_meta_inputs(universe, ctx)
        market_intel_ctx = self._build_market_intel_context(ctx)

        # ── ExpectedReturnModel ───────────────────────────────────────────────
        cross_axis_signals = ctx.get("cross_axis_signals", {})
        if not isinstance(cross_axis_signals, dict):
            cross_axis_signals = {}

        er_input = ExpectedReturnInput(
            assets=tuple(assets),
            six_axis_scores=scores,
            cross_axis_signals=cross_axis_signals,
            regime=regime,
            market_intel=market_intel_ctx,
        )
        er_result = ExpectedReturnModel().calculate(er_input)

        # ── CovarianceModel ───────────────────────────────────────────────────
        returns_data_dict = ctx.get("returns_data", {})
        if not isinstance(returns_data_dict, dict):
            returns_data_dict = {}

        cov_input = CovarianceInput(
            tickers=universe,
            returns_data=returns_data_dict,
            shrinkage_alpha=_safe_float(ctx.get("shrinkage_alpha", 0.1), 0.1),
            min_periods=int(_safe_float(ctx.get("min_periods", 3), 3)),
            regime=regime,
        )
        cov_result = CovarianceModel().calculate(cov_input)

        # ── ConstraintBuilder ─────────────────────────────────────────────────
        asset_meta_map = ctx.get("asset_meta_by_ticker", {})
        if not isinstance(asset_meta_map, dict):
            asset_meta_map = {}

        locked_weights = ctx.get("locked_weights", {})
        if not isinstance(locked_weights, dict):
            locked_weights = {}

        constraint_input = ConstraintInput(
            tickers=universe,
            asset_meta=asset_meta_map,
            locked_weights=locked_weights,
            regime=regime,
        )
        constraints = ConstraintBuilder().build(constraint_input)

        # ── EfficientFrontierOptimizer ────────────────────────────────────────
        expected_returns_dict: dict[str, float] = {}
        for t in universe:
            er_val = er_result.get_expected_return(t)
            expected_returns_dict[t] = er_val if er_val is not None else 0.0

        ef_input = EfficientFrontierInput(
            tickers=universe,
            expected_returns=expected_returns_dict,
            cov_result=cov_result,
            constraints=constraints,
            risk_free_rate=_safe_float(ctx.get("risk_free_rate", 0.0), 0.0),
            n_frontier_points=0,
        )
        ef_result = EfficientFrontierOptimizer().optimize(ef_input)

        # ── IndexBuilder ──────────────────────────────────────────────────────
        calc_date = ctx.get("calculation_date", "")
        if not isinstance(calc_date, str):
            calc_date = ""

        ib_input = IndexBuilderInput(
            frontier_result=ef_result,
            index_name=self.STRATEGY_NAME,
            calculation_date=calc_date,
        )
        frontier_index = IndexBuilder().build(ib_input)

        # ── diagnostics 集約（Card 8-4 指定の順序） ──────────────────────────
        # 3. ExpectedReturnResult.diagnostics（global のみ。per_asset は P1-8Q で除外）
        diagnostics.extend(er_result.diagnostics)
        # 4. CovarianceResult.diagnostics
        diagnostics.extend(cov_result.diagnostics)
        # 5. OptimizerConstraints.diagnostics
        diagnostics.extend(constraints.diagnostics)
        # 6. EfficientFrontierResult.diagnostics
        diagnostics.extend(ef_result.diagnostics)
        # 7. FrontierIndex.diagnostics
        diagnostics.extend(frontier_index.diagnostics)
        # 8. max_dd_estimate: Phase 8 returns_data ベース観測値（Card C / P2-8N）
        max_dd, dd_diags = self._estimate_phase8_max_dd(
            frontier_index, regime, ctx
        )
        diagnostics.extend(dd_diags)

        output = self._build_phase8_output(
            frontier_index, regime, diagnostics, max_dd_estimate=max_dd
        )
        return output, frontier_index

    # ── Phase 8 max_dd 推定（Card C / P2-8N）─────────────────────────────────

    def _estimate_phase8_max_dd(
        self,
        frontier_index: Any,
        regime: str,
        ctx: dict,
    ) -> tuple[float, list[str]]:
        """
        Phase 8 経路の max_dd_estimate を returns_data から観測値で計算する。

        returns_data 利用可かつ DrawdownEstimator が定義可能 → 観測 max drawdown。
        欠損 / 非 dict / 重複ゼロ / 期間不足 / 計算異常 → regime reference fallback。

        Returns:
            (max_dd_estimate, diagnostics)
        """
        diags: list[str] = []
        returns_data = ctx.get("returns_data")

        if not isinstance(returns_data, dict) or not returns_data:
            diags.append(
                "observation: max_dd_estimate fell back to regime reference "
                "(returns_data unavailable or insufficient)"
            )
            return self._calc_max_dd_estimate(regime), diags

        dd_input = DrawdownEstimatorInput(
            tickers=tuple(frontier_index.tickers),
            weights=tuple(float(w) for w in frontier_index.weights),
            returns_data=returns_data,
        )
        dd_result = DrawdownEstimator().estimate(dd_input)
        diags.extend(dd_result.diagnostics)

        if dd_result.is_drawdown_defined:
            diags.append(
                "observation: max_dd_estimate is observed max drawdown from "
                "returns_data (calculation-only, not a prediction)"
            )
            return dd_result.max_drawdown, diags

        diags.append(
            "observation: max_dd_estimate fell back to regime reference "
            "(returns_data unavailable or insufficient)"
        )
        return self._calc_max_dd_estimate(regime), diags

    # ── Phase 8 結果変換 ─────────────────────────────────────────────────────

    def _build_phase8_output(
        self,
        frontier_index: Any,
        regime: str,
        diagnostics: list[str],
        max_dd_estimate: float | None = None,
    ) -> StrategyOutput:
        """
        FrontierIndex を StrategyOutput に変換する。

        max_dd_estimate が None の場合のみ regime reference を使う
        （後方互換）。Card C 以降の Phase 8 経路は観測値を渡す。
        """
        ideal_pf_tuple: tuple[tuple[str, float], ...] = tuple(
            (t, float(w))
            for t, w in zip(frontier_index.tickers, frontier_index.weights)
        )
        max_dd = (
            max_dd_estimate
            if max_dd_estimate is not None
            else self._calc_max_dd_estimate(regime)
        )

        return StrategyOutput(
            strategy_id=self.STRATEGY_ID,
            strategy_name=self.STRATEGY_NAME,
            ideal_pf=ideal_pf_tuple,
            expected_return=float(frontier_index.expected_return),
            expected_vol=float(frontier_index.expected_vol),
            sharpe_ratio=float(frontier_index.sharpe_ratio),
            max_dd_estimate=max_dd,
            rationale=(
                f"Frontier AI Index: Phase 8 SLSQP optimization "
                f"(regime={regime}, n={len(frontier_index.tickers)})"
            ),
            diagnostics=tuple(diagnostics),
        )

    # ── Phase 8 ヘルパー: AssetMetaInput / MarketIntelContext 構築 ───────────

    def _build_asset_meta_inputs(
        self,
        universe: tuple[str, ...],
        ctx: dict,
    ) -> list[AssetMetaInput]:
        """
        universe の各 ticker について AssetMetaInput を構築する。

        ctx から:
          mean_return_3y_by_ticker → mean_return_3y（不在 → 0.0）
          size_segment_by_ticker   → size_segment（不在 → "large_cap"）
          risk_flags_by_ticker     → is_risk_on/is_defensive/is_energy/is_overseas
                                     （不在 → 全 False）
        """
        mean_returns_map = ctx.get("mean_return_3y_by_ticker", {})
        if not isinstance(mean_returns_map, dict):
            mean_returns_map = {}

        size_seg_map = ctx.get("size_segment_by_ticker", {})
        if not isinstance(size_seg_map, dict):
            size_seg_map = {}

        flags_map = ctx.get("risk_flags_by_ticker", {})
        if not isinstance(flags_map, dict):
            flags_map = {}

        result: list[AssetMetaInput] = []
        for t in universe:
            flags = flags_map.get(t, {})
            if not isinstance(flags, dict):
                flags = {}

            seg = size_seg_map.get(t, "large_cap")
            if not isinstance(seg, str) or not seg:
                seg = "large_cap"

            result.append(AssetMetaInput(
                ticker=t,
                mean_return_3y=_safe_float(mean_returns_map.get(t, 0.0), 0.0),
                size_segment=seg,
                is_risk_on=  bool(flags.get("is_risk_on",   False)),
                is_defensive=bool(flags.get("is_defensive", False)),
                is_energy=   bool(flags.get("is_energy",    False)),
                is_overseas= bool(flags.get("is_overseas",  False)),
            ))
        return result

    def _build_market_intel_context(
        self,
        ctx: dict,
    ) -> MarketIntelContext | None:
        """
        ctx["market_intel"] から MarketIntelContext を構築する。

        不在 / 非dict → None（ExpectedReturnModel が "market_intel not provided" diag を出す）
        """
        mi = ctx.get("market_intel")
        if not isinstance(mi, dict):
            return None

        sentiment = _safe_float(mi.get("sentiment_score", 50.0), 50.0)
        kw_raw = mi.get("keywords", ())
        if isinstance(kw_raw, (list, tuple)):
            keywords = tuple(str(k) for k in kw_raw)
        else:
            keywords = ()
        return MarketIntelContext(
            sentiment_score=sentiment,
            keywords=keywords,
        )

    # ── Phase 7 private helpers（既存ロジック、変更なし） ─────────────────────

    def _get_axis_weights(self, regime: str) -> dict[str, float]:
        """
        dynamic_weight.regime_axis_weights.get_axis_weights() の薄いラッパー。
        未知 regime は get_axis_weights 内で "uncertain" にフォールバックされる。
        """
        return get_axis_weights(regime)

    def _calc_frontier_score(
        self,
        ticker_scores: dict,
        axis_weights: dict[str, float],
    ) -> float:
        """
        1銘柄の frontier_score を計算する（Phase 7 score-proportional）。

        frontier_score = sum(axis_total * axis_weight) for each axis in axis_weights
        """
        score = 0.0
        for axis, axis_weight in axis_weights.items():
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
        axis_weights: dict[str, float],
    ) -> tuple[dict[str, float], list[str]]:
        """universe の各銘柄の frontier_score を計算（Phase 7）。"""
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

            score_weights[ticker] = self._calc_frontier_score(ticker_scores, axis_weights)

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

    def _calc_expected_metrics(
        self, regime: str
    ) -> tuple[float, float, float]:
        """レジーム別参照値から (expected_return, expected_vol, sharpe_ratio) を返す（Phase 7）。"""
        key = regime if regime in _REGIME_EXPECTED_RETURN else _FALLBACK_REGIME
        expected_return = _REGIME_EXPECTED_RETURN[key]
        expected_vol    = _REGIME_EXPECTED_VOL[key]
        if expected_vol > 0.0:
            sharpe_ratio = expected_return / expected_vol
        else:
            sharpe_ratio = 0.0
        return expected_return, expected_vol, sharpe_ratio

    def _calc_max_dd_estimate(self, regime: str) -> float:
        """レジーム別最大ドローダウン参照値を返す（Phase 7 / Phase 8 共通、P1-8N）。"""
        key = regime if regime in _REGIME_MAX_DD else _FALLBACK_REGIME
        return _REGIME_MAX_DD[key]
