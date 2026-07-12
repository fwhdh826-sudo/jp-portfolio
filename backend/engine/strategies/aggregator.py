"""
aggregator.py — Card 7-6
Phase 7 Multi-Strategy Engine: Regime-Aware Strategy Aggregator。

責務:
  - StrategyAggregateInput  — 集約計算への入力を保持する frozen dataclass
  - StrategyAggregateResult — 集約計算結果を保持する frozen dataclass
  - StrategyAggregator      — 4戦略の StrategyOutput を regime 別重みで加重合成するクラス

集約仕様:
  1. strategy_outputs（dict[str, StrategyOutput]）を受け取る
  2. get_strategy_weights(regime) でレジーム別戦略重みを取得
     （REGIME_STRATEGY_WEIGHTS を直接参照しない）
  3. 提供された戦略のみの重みを再正規化（_normalize_strategy_weights）
  4. ideal_pf を _ideal_pf_as_dict() 経由で加重合成（_aggregate_ideal_pf）
  5. aggregated_ideal_pf を weight 降順 + ticker 昇順で tuple 化
  6. expected_return / expected_vol / max_dd_estimate を線形加重和で集約
  7. sharpe_ratio = expected_return / expected_vol（vol=0 → 0.0）
  8. 全6ペアの戦略間 Pearson r を計算（_calc_correlations）
  9. diversification_score = clamp(1.0 - max_positive_corr, 0.0, 1.0)
  10. StrategyAggregateResult を返す

不変設計（frozen dataclass）:
  - StrategyAggregateInput / StrategyAggregateResult ともに frozen=True
  - StrategyAggregateResult の weights_used / strategy_correlations / aggregated_ideal_pf は
    tuple[tuple[str, float], ...] で保持（内部 mutable dict を持たない）
  - to_dict() で必要な場合に dict 変換して返す

correlation 計算（stdlib-only）:
  - 全6ペア固定（CORRELATION_PAIRS）
  - 両方の StrategyOutput が存在する場合のみ Pearson r を計算
  - 片方または両方 missing のペアは 0.0
  - union tickers で両戦略の重みベクトルを構築（欠損 ticker → 0.0）
  - n < 2 または標準偏差ゼロ → 0.0
  - Pearson r は -1.0〜1.0 に clamp

diversification_score 仕様:
  - max_positive_corr = clamp(max(correlations.values()), 0.0, 1.0)
  - diversification_score = clamp(1.0 - max_positive_corr, 0.0, 1.0)
  - correlations が空（0戦略）の場合は 1.0
  - 負相関でも > 1.0 にならないよう二重 clamp

invalid / missing / non-dict 入力の扱い:
  - strategy_outputs が dict 以外 → 空扱い + diagnostics に記録
  - invalid strategy_id → validate_strategy_id() でスキップ + diagnostics に記録
  - missing canonical strategy → 残り戦略で重みを再正規化 + diagnostics に記録
  - 有効戦略が 0 件 → 全フィールドゼロの空 StrategyAggregateResult を返す

設計原則:
  - 実際の売買制限・注文制限はしない（数値化のみ）
  - 実 LLM / HTTP 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / rating / approve / reject / conditional 禁止
  - scipy / pandas / numpy 禁止（math stdlib のみ使用）
  - operation / market_intel / news / regime を直接 import しない

実装しないこと:
  - 3ヶ月売却不可ルールの実運用判断（Card 7-7 jp_equity_pf_builder の責務）
  - 現在PFとの差分算出（Card 7-8 unified_view の責務）
  - 発注・注文生成（Operation 層の責務）
  - 共分散行列を使った厳密な vol 集約（Phase 8 の責務）
  - scipy / numpy 最適化
  - public / data writer
  - BUY / SELL / HOLD / WAIT 判定

P2 記録:
  P2-7P: StrategyAggregateInput.strategy_outputs は dict のまま保持。
         mutation 禁止で運用。immutable 化は後続配線時（Phase 8 以降）に再確認。
  P2-7Q: expected_vol は線形加重和近似。厳密には共分散行列が必要（Phase 8 で差し替え予定）。
  P2-7R: Pearson r はポートフォリオ重みベクトルの観察値。
         universe が小さい場合（< 5 銘柄）は安定性低下の可能性あり。

P2-A1 記録（hybrid metric diagnostic、本ファイルに実装）:
  P1-PA1-1: 検出方法は valid_outputs["frontier"].diagnostics 内の
            _PHASE8_FRONTIER_IDENTIFIER 文字列マッチ（rationale 不使用）。
  P1-PA1-2: identifier は本ファイル module-level 定数として宣言、
            frontier_strategy.py 側 Phase 8 経路の出力との合意文字列。
  P1-PA1-3: 検出時に hybrid diagnostic を 3 件追加（hybrid sources /
            linear vol / hybrid sharpe）。
  P1-PA1-4: 旧 placeholder テストは置換削除済。
  P1-PA1-5: StrategyAggregateResult schema / to_dict schema は無変更。
  P1-PA1-6: aggregator.py 以外の backend コードは変更なし。
  P1-PA1-7: hybrid 検出は frontier のみ（他 3 戦略の actual metric 導入は
            P2-A3 まで待つ）。

P2-C5 記録（observed/reference max_dd hybrid diagnostic、本ファイルに実装）:
  P1-C5-1: 検出は新規 _PHASE8_OBSERVED_MAX_DD_IDENTIFIER。
           _detect_phase8_frontier は再利用しない（Phase 8 SLSQP 経路でも
           max_dd が regime reference fallback し得るため誤検出回避）。
  P1-C5-2: identifier は本ファイル module 定数。frontier_strategy.py Card C
           出力との合意文字列。
  P1-C5-3: diagnostics-only 検出。rationale 不使用。
  P1-C5-4: 検出時に max_dd 専用 diagnostic を 2 件追加（hybrid drawdown
           sources / linear weighted aggregation）。P2-A1（Step 10.5）とは
           独立ブロック・別文言。
  P1-C5-5: aggregate() max_dd 計算式 / schema / to_dict 無変更。
  P1-C5-6: 既存 _phase8_frontier_output は opt-in param 追加のみ
           （test 側、default 挙動不変、P2-A1 テスト無影響）。
  P1-C5-7: aggregator.py 以外の backend 本体コードは変更なし。

P2/P3 残置（本 P2-A1 / P2-C5 範囲外）:
  P2-C5-a: test 側 _phase8_frontier_output 旧 P1-8N 文言の Card C 整合
           cleanup（P2-A1 テスト影響精査の上、別途）。
  P2-A2: aggregator.py expected_vol を共分散ベースに改良。
  P2-A3: 他 3 戦略にも actual expected_return / expected_vol を導入。
  P2-A4: StrategyAggregateResult.diagnostics に個別 strategy diagnostics を
         オプション集約。
  P2-A5: HIGH_CORR_THRESHOLD の Phase 8 適合性継続検証。
  P3-PA1-X: FrontierStrategy 側で PHASE8_DIAGNOSTIC_IDENTIFIER を公開定数
           export し、aggregator がそれを import する設計。
  P3-PA1-Y: StrategyOutput に computation_method フィールド追加で文字列
           マッチ依存を解消（破壊的変更のため大規模）。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 7-6
Reference: docs/v13.3/07_v13.3_spec.md Section 5 / 11.2
Reference: backend/engine/dynamic_weight/regime_strategy_weights.py
Reference: backend/engine/strategies/frontier_strategy.py（Phase 8 identifier 出力元）
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from engine.dynamic_weight.regime_strategy_weights import (
    CANONICAL_STRATEGIES,
    VALID_REGIMES,
    get_strategy_weights,
)
from engine.strategies.base_strategy import (
    StrategyOutput,
    validate_strategy_id,
)


# ── 定数 ─────────────────────────────────────────────────────────────────────

HIGH_CORR_THRESHOLD: float = 0.70

# 4戦略の全6ペア（固定順序）
# キー形式: "{sid_a}_vs_{sid_b}"
CORRELATION_PAIRS: tuple[tuple[str, str], ...] = (
    ("frontier",     "quality_size"),
    ("frontier",     "fundamental"),
    ("frontier",     "cross_factor"),
    ("quality_size", "fundamental"),
    ("quality_size", "cross_factor"),
    ("fundamental",  "cross_factor"),
)

# 全ペアが 0.0 の空 correlations（0戦略 / 片方 missing の場合に使用）
_EMPTY_CORRELATIONS: tuple[tuple[str, float], ...] = tuple(
    (f"{a}_vs_{b}", 0.0) for a, b in CORRELATION_PAIRS
)


# ── Phase 8 frontier identifier（P2-A1）───────────────────────────────────────
#
# `_compute_phase8()`（backend/engine/strategies/frontier_strategy.py の Phase 8
# 経路）が StrategyOutput.diagnostics の先頭に追加する identifier 文字列。
# Aggregator は本 substring を valid_outputs["frontier"].diagnostics 内で
# マッチして hybrid metric 状態（frontier だけが Phase 8 actual metric、他 3
# 戦略は regime reference）を検出する。
#
# 両モジュール間で合意した「Phase 8 経路の標識文字列」として運用。
# 将来 P3-PA1-X（FrontierStrategy 側で公開定数 export）または P3-PA1-Y
# （StrategyOutput に computation_method フィールド追加）で文字列マッチ依存を
# 解消する余地あり。本 P2-A1 では文字列マッチで最小侵襲に実装する。
#
# 検出は diagnostics のみ（rationale 不使用、P1-PA1-1）。rationale は表示文言
# のため将来変わりやすく、検出 source としては不適。
# 公開定数（P3-PA1-X）。Phase 8 経路の標識文字列の正準定義。
# frontier_strategy.py emit 側は無変更（意図的 decoupling 保持、P1-PA1-1）。
PHASE8_FRONTIER_IDENTIFIER: str = "Phase 8 SLSQP optimization used"
# private 後方互換 alias（内部参照・既存 importer 温存。値・検出不変）。
_PHASE8_FRONTIER_IDENTIFIER: str = PHASE8_FRONTIER_IDENTIFIER


# ── Phase 8 observed max_dd identifier（P2-C5）────────────────────────────────
#
# Card C（backend/engine/strategies/frontier_strategy.py の Phase 8 経路）が
# returns_data ベースの観測 max drawdown を採用したときに StrategyOutput.
# diagnostics に追加する識別文字列との合意文字列。
#
# 重要: P2-A1 の _PHASE8_FRONTIER_IDENTIFIER（"Phase 8 SLSQP optimization
# used"）は「最適化経路が Phase 8 SLSQP」を示すだけで、max_dd が observed か
# regime reference fallback かは判別できない。Phase 8 SLSQP 経路でも
# returns_data 不足時は max_dd が regime reference へ fallback し得る
# （Card C）。したがって max_dd の observed/reference hybrid 検出には
# _PHASE8_FRONTIER_IDENTIFIER を再利用せず、本 observed 専用 identifier を
# 使う（P1-C5-1）。
#
# 検出は diagnostics のみ（rationale 不使用、P1-C5-3）。
# 公開定数（P3-PA1-X）。observed max_dd 標識文字列の正準定義。
PHASE8_OBSERVED_MAX_DD_IDENTIFIER: str = (
    "max_dd_estimate is observed max drawdown from returns_data"
)
# private 後方互換 alias（内部参照・既存 importer 温存。値・検出不変）。
_PHASE8_OBSERVED_MAX_DD_IDENTIFIER: str = PHASE8_OBSERVED_MAX_DD_IDENTIFIER


# ── safe helpers ──────────────────────────────────────────────────────────────

def _safe_float(raw: Any, fallback: float = 0.0) -> float:
    """None / str / NaN / inf → fallback。それ以外は float 変換。"""
    if raw is None:
        return fallback
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return fallback
    if math.isnan(val) or math.isinf(val):
        return fallback
    return val


def _clamp(val: float, lo: float, hi: float) -> float:
    """val を [lo, hi] に clamp する。"""
    return max(lo, min(hi, val))


# ── StrategyAggregateInput ────────────────────────────────────────────────────

@dataclass(frozen=True)
class StrategyAggregateInput:
    """
    StrategyAggregator.aggregate() への入力。immutable（フィールド自体は書き換え不可）。

    strategy_outputs: {strategy_id: StrategyOutput} の dict。
                      dict でない場合は __post_init__ で {} に fallback。
                      frozen=True でも内部 dict は mutable のため mutation 禁止（P2-7P）。
    regime:           市況レジーム文字列。
    context:          追加情報（任意）。default_factory=dict で各インスタンス独立。
                      dict でない場合は __post_init__ で {} に fallback。mutation 禁止。

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / rating / approve / reject / conditional
    """

    strategy_outputs: dict[str, StrategyOutput]
    regime: str
    context: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.strategy_outputs, dict):
            object.__setattr__(self, "strategy_outputs", {})
        if not isinstance(self.context, dict):
            object.__setattr__(self, "context", {})


# ── StrategyAggregateResult ───────────────────────────────────────────────────

@dataclass(frozen=True)
class StrategyAggregateResult:
    """
    4戦略の加重合成計算結果。immutable。

    「ポートフォリオ構成の数値計算結果」であり売買命令ではない。
    aggregated_ideal_pf の各重みは「4戦略の計算値をレジーム重みで合成した比率」であり、
    「この銘柄を買え/売れ」ではない。実際の発注・注文生成は Operation 層の責務。

    aggregated_ideal_pf:   tuple[tuple[str, float], ...] — 合成ポートフォリオ（weight降順 + ticker昇順）
    expected_return:       float — 期待リターン（年率）戦略重み加重和
    expected_vol:          float — 期待ボラティリティ（年率）戦略重み加重和 + 0.0以上 clamp（P2-7Q）
    sharpe_ratio:          float — expected_return / expected_vol（vol=0 → 0.0）
    max_dd_estimate:       float — 最大ドローダウン推定。戦略重み加重和 + 0.0以下 clamp
    weights_used:          tuple[tuple[str, float], ...] — 実際に使用した正規化済み戦略重み
    regime:                str   — 使用したレジーム文字列
    strategy_correlations: tuple[tuple[str, float], ...] — 6ペア Pearson r（固定 schema）
    diversification_score: float — clamp(1.0 - max_positive_corr, 0.0, 1.0)
    diagnostics:           tuple[str, ...] — 計算上の観察事実（"observation:" prefix 統一）

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / rating / approve / reject / conditional /
      final_verdict / order / amount / entry_price / stop_loss / take_profit
    """

    aggregated_ideal_pf:   tuple[tuple[str, float], ...]
    expected_return:       float
    expected_vol:          float
    sharpe_ratio:          float
    max_dd_estimate:       float
    weights_used:          tuple[tuple[str, float], ...]
    regime:                str
    strategy_correlations: tuple[tuple[str, float], ...]
    diversification_score: float
    diagnostics:           tuple[str, ...] = ()

    def __post_init__(self) -> None:
        # aggregated_ideal_pf: ensure tuple
        if not isinstance(self.aggregated_ideal_pf, tuple):
            object.__setattr__(self, "aggregated_ideal_pf", ())

        # expected_return: safe float
        object.__setattr__(self, "expected_return", _safe_float(self.expected_return))

        # expected_vol: safe float + 0.0以上 clamp
        object.__setattr__(
            self, "expected_vol",
            max(0.0, _safe_float(self.expected_vol)),
        )

        # sharpe_ratio: safe float
        object.__setattr__(self, "sharpe_ratio", _safe_float(self.sharpe_ratio))

        # max_dd_estimate: safe float + 0.0以下 clamp
        object.__setattr__(
            self, "max_dd_estimate",
            min(0.0, _safe_float(self.max_dd_estimate)),
        )

        # weights_used: ensure tuple
        if not isinstance(self.weights_used, tuple):
            object.__setattr__(self, "weights_used", ())

        # strategy_correlations: ensure tuple（欠如時は _EMPTY_CORRELATIONS で補完）
        if not isinstance(self.strategy_correlations, tuple):
            object.__setattr__(self, "strategy_correlations", _EMPTY_CORRELATIONS)

        # diversification_score: safe float + [0.0, 1.0] clamp
        object.__setattr__(
            self, "diversification_score",
            _clamp(_safe_float(self.diversification_score, 1.0), 0.0, 1.0),
        )

        # diagnostics: ensure tuple
        if not isinstance(self.diagnostics, tuple):
            object.__setattr__(self, "diagnostics", tuple(self.diagnostics))

    def to_dict(self) -> dict:
        """JSON serializable な dict を返す（str / float / list / dict のみ）。"""
        return {
            "aggregated_ideal_pf":   dict(self.aggregated_ideal_pf),
            "expected_return":       self.expected_return,
            "expected_vol":          self.expected_vol,
            "sharpe_ratio":          self.sharpe_ratio,
            "max_dd_estimate":       self.max_dd_estimate,
            "weights_used":          dict(self.weights_used),
            "regime":                self.regime,
            "strategy_correlations": dict(self.strategy_correlations),
            "diversification_score": self.diversification_score,
            "diagnostics":           list(self.diagnostics),
        }


# ── StrategyAggregator ────────────────────────────────────────────────────────

class StrategyAggregator:
    """
    4戦略の StrategyOutput を regime 別重みで加重合成する集約クラス。

    aggregate() は pure computation:
      - strategy_outputs dict を受け取り StrategyAggregateResult を返す
      - 売買判断・注文生成・発注制限は行わない
      - 3ヶ月売却不可ルールは適用しない（Card 7-7 の責務）
      - 現在PFとの差分算出は行わない（Card 7-8 の責務）

    strategy_outputs / context を mutation してはならない（P2-7P）。
    """

    def aggregate(
        self,
        strategy_outputs: dict[str, StrategyOutput],
        regime: str,
        context: dict | None = None,
    ) -> StrategyAggregateResult:
        """
        4戦略の StrategyOutput を regime 別重みで加重合成して StrategyAggregateResult を返す。

        Args:
            strategy_outputs: {strategy_id: StrategyOutput}
                              dict 以外の場合は空扱い（diagnostics に記録）
            regime:           市況レジーム文字列
            context:          追加情報（省略可）。dict でない場合は {} 扱い

        Returns:
            StrategyAggregateResult

        制約:
          - strategy_outputs / context を mutation してはならない
          - BUY / SELL / HOLD / WAIT 判定を行ってはならない
          - 実 HTTP / LLM 接続を行ってはならない
          - scipy / numpy / pandas を使用してはならない
        """
        if context is None:
            context = {}
        if not isinstance(context, dict):
            context = {}

        diag: list[str] = []

        # ── Step 1: strategy_outputs 型バリデーション ─────────────────────────
        if not isinstance(strategy_outputs, dict):
            diag.append(
                "observation: strategy_outputs is not a dict"
                " — empty aggregate fallback used"
            )
            return self._build_empty_result(regime, diag)

        # ── Step 2: 有効 strategy_id / StrategyOutput のみ抽出 ───────────────
        valid_outputs: dict[str, StrategyOutput] = {}
        for sid, output in strategy_outputs.items():
            if not validate_strategy_id(str(sid) if sid is not None else ""):
                diag.append(
                    f"observation: invalid strategy_id '{sid}'"
                    " — skipped (not in VALID_STRATEGY_IDS)"
                )
                continue
            if not isinstance(output, StrategyOutput):
                diag.append(
                    f"observation: strategy_id '{sid}' output is not a StrategyOutput — skipped"
                )
                continue
            valid_outputs[sid] = output

        # ── Step 3: missing canonical strategy を diagnostics に記録 ──────────
        for canonical_sid in CANONICAL_STRATEGIES:
            if canonical_sid not in valid_outputs:
                diag.append(
                    f"observation: strategy '{canonical_sid}' not provided"
                    " — weight redistributed among available strategies"
                )

        # ── Step 4: unknown regime を diagnostics に記録 ──────────────────────
        if regime not in VALID_REGIMES:
            diag.append(
                f"observation: unknown regime '{regime}'"
                " — strategy weight lookup fell back to 'uncertain'"
            )

        # ── Step 5: レジーム別重みを取得して再正規化 ──────────────────────────
        raw_weights = get_strategy_weights(regime)
        normalized_weights = self._normalize_strategy_weights(
            raw_weights, set(valid_outputs.keys())
        )

        # ── Step 6: 有効戦略が 0 件 → 空結果 ────────────────────────────────
        if not valid_outputs:
            return self._build_empty_result(regime, diag)

        # ── Step 7: 戦略間相関を計算（6ペア固定）────────────────────────────
        correlations_dict = self._calc_correlations(valid_outputs)

        # ── Step 8: ideal_pf 加重合成 ─────────────────────────────────────────
        agg_pf_dict = self._aggregate_ideal_pf(valid_outputs, normalized_weights)
        sorted_pf = sorted(agg_pf_dict.items(), key=lambda x: (-x[1], x[0]))
        aggregated_ideal_pf = tuple(sorted_pf)

        # ── Step 9: 期待メトリクス加重和 ─────────────────────────────────────
        expected_return = sum(
            normalized_weights.get(sid, 0.0) * out.expected_return
            for sid, out in valid_outputs.items()
        )
        expected_vol_raw = sum(
            normalized_weights.get(sid, 0.0) * out.expected_vol
            for sid, out in valid_outputs.items()
        )
        max_dd_raw = sum(
            normalized_weights.get(sid, 0.0) * out.max_dd_estimate
            for sid, out in valid_outputs.items()
        )

        expected_vol = max(0.0, _safe_float(expected_vol_raw))
        sharpe_ratio = expected_return / expected_vol if expected_vol > 0.0 else 0.0
        max_dd_estimate = min(0.0, _safe_float(max_dd_raw))

        # ── Step 10: diversification_score ───────────────────────────────────
        if correlations_dict:
            max_positive_corr = _clamp(max(correlations_dict.values()), 0.0, 1.0)
        else:
            max_positive_corr = 0.0
        diversification_score = _clamp(1.0 - max_positive_corr, 0.0, 1.0)

        # 高相関 diagnostic
        if correlations_dict and max(correlations_dict.values()) > HIGH_CORR_THRESHOLD:
            max_corr_val = max(correlations_dict.values())
            diag.append(
                f"observation: max strategy correlation {max_corr_val:.3f}"
                f" > {HIGH_CORR_THRESHOLD:.2f}"
                " — reduced diversification effect (calculation-only)"
            )

        # ── Step 10.5: Phase 8 hybrid metric diagnostic（P2-A1）──────────────
        # frontier StrategyOutput.diagnostics 内に _PHASE8_FRONTIER_IDENTIFIER
        # が含まれる場合のみ hybrid metric 観察値を追加する。
        # スキーマ変更なし。集約アルゴリズム変更なし。diagnostics への追加のみ。
        if (
            "frontier" in valid_outputs
            and self._detect_phase8_frontier(valid_outputs["frontier"])
        ):
            diag.append(
                "observation: aggregated metrics include hybrid metric sources"
                " — 'frontier' uses Phase 8 actual portfolio metrics"
                " (w^T mu / sqrt(w^T Sigma w)) while other strategies use"
                " regime reference values"
            )
            diag.append(
                "observation: aggregate expected_vol is linear weighted"
                " aggregation, not covariance-aware (P2-7Q / P2-A2)"
            )
            diag.append(
                "observation: aggregate sharpe_ratio is based on hybrid"
                " aggregate metrics — calculation-only, not a recommendation"
            )

        # ── Step 10.6: Phase 8 observed/reference max_dd hybrid diagnostic（P2-C5）─
        # frontier StrategyOutput.diagnostics 内に _PHASE8_OBSERVED_MAX_DD_
        # IDENTIFIER が含まれる場合のみ max_dd 専用 hybrid 観察値を追加する。
        # P2-A1（Step 10.5）とは独立した条件ブロック・別文言。
        # Phase 8 SLSQP 経路でも max_dd が regime reference fallback した場合は
        # observed identifier が出ないため、ここは発火しない（誤検出回避、P1-C5-1）。
        # max_dd 計算式・schema・to_dict は変更しない（diagnostics 追加のみ）。
        if (
            "frontier" in valid_outputs
            and self._detect_observed_max_dd_frontier(valid_outputs["frontier"])
        ):
            diag.append(
                "observation: aggregate max_dd_estimate may include hybrid"
                " drawdown sources — frontier may use observed returns_data"
                " drawdown while other strategies use regime reference values"
            )
            diag.append(
                "observation: aggregate max_dd_estimate is linear weighted"
                " aggregation; calculation-only, not a prediction"
            )

        # ── Step 11: tuple 化して StrategyAggregateResult を構築 ─────────────
        weights_used = tuple(sorted(normalized_weights.items(), key=lambda x: x[0]))
        strategy_correlations = tuple(
            sorted(correlations_dict.items(), key=lambda x: x[0])
        )

        return StrategyAggregateResult(
            aggregated_ideal_pf=aggregated_ideal_pf,
            expected_return=_safe_float(expected_return),
            expected_vol=expected_vol,
            sharpe_ratio=_safe_float(sharpe_ratio),
            max_dd_estimate=max_dd_estimate,
            weights_used=weights_used,
            regime=regime,
            strategy_correlations=strategy_correlations,
            diversification_score=diversification_score,
            diagnostics=tuple(diag),
        )

    # ── private helpers ───────────────────────────────────────────────────────

    def _normalize_strategy_weights(
        self,
        raw_weights: dict[str, float],
        available_ids: set[str],
    ) -> dict[str, float]:
        """
        raw_weights から available_ids のみ抽出して合計 1.0 に再正規化する。

        - weight は safe float + 0.0以上 clamp
        - sum > 0 なら合計 1.0 に正規化
        - sum == 0 なら available_ids 内で等加重（1/N）
        - available_ids 空なら {}
        """
        if not available_ids:
            return {}

        subset: dict[str, float] = {}
        for sid in available_ids:
            w = _safe_float(raw_weights.get(sid, 0.0), 0.0)
            subset[sid] = max(0.0, w)

        total = sum(subset.values())
        if total > 0.0:
            return {sid: w / total for sid, w in subset.items()}

        # 全ゼロ fallback → 等加重
        n = len(subset)
        return {sid: 1.0 / n for sid in subset}

    def _aggregate_ideal_pf(
        self,
        valid_outputs: dict[str, StrategyOutput],
        normalized_weights: dict[str, float],
    ) -> dict[str, float]:
        """
        各戦略の ideal_pf を戦略重みで加重合成する。

        _ideal_pf_as_dict() を使用して ticker → weight の dict を取得し、
        strategy_weight * ticker_weight を ticker ごとに加算する。
        最終正規化は行わない（各 StrategyOutput の ideal_pf が合計 ~1.0 のため、
        加重和も ~1.0 になる）。
        """
        final_pf: dict[str, float] = {}
        for sid, output in valid_outputs.items():
            strat_weight = normalized_weights.get(sid, 0.0)
            if strat_weight == 0.0:
                continue
            for ticker, w in output._ideal_pf_as_dict().items():
                final_pf[ticker] = final_pf.get(ticker, 0.0) + strat_weight * w
        return final_pf

    def _calc_correlations(
        self,
        valid_outputs: dict[str, StrategyOutput],
    ) -> dict[str, float]:
        """
        CORRELATION_PAIRS の全6ペアについて Pearson r を計算する。

        - 両方の StrategyOutput が存在する場合のみ Pearson r を計算
        - 片方または両方 missing のペアは 0.0
        - union tickers で両戦略の重みベクトルを構築（欠損 ticker → 0.0）
        - n < 2 → 0.0
        - 標準偏差ゼロ → 0.0
        - Pearson r は -1.0〜1.0 に clamp
        """
        result: dict[str, float] = {}
        for sid_a, sid_b in CORRELATION_PAIRS:
            key = f"{sid_a}_vs_{sid_b}"
            if sid_a not in valid_outputs or sid_b not in valid_outputs:
                result[key] = 0.0
                continue

            pf_a = valid_outputs[sid_a]._ideal_pf_as_dict()
            pf_b = valid_outputs[sid_b]._ideal_pf_as_dict()
            tickers = sorted(set(pf_a.keys()) | set(pf_b.keys()))

            if len(tickers) < 2:
                result[key] = 0.0
                continue

            xs = [pf_a.get(t, 0.0) for t in tickers]
            ys = [pf_b.get(t, 0.0) for t in tickers]
            result[key] = self._pearson_r(xs, ys)

        return result

    def _pearson_r(
        self,
        xs: list[float],
        ys: list[float],
    ) -> float:
        """
        stdlib-only Pearson 相関係数。

        - n < 2 → 0.0
        - std_x == 0 または std_y == 0 → 0.0
        - 結果は -1.0〜1.0 に clamp
        """
        n = len(xs)
        if n < 2:
            return 0.0
        mean_x = sum(xs) / n
        mean_y = sum(ys) / n
        cov = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
        var_x = sum((x - mean_x) ** 2 for x in xs)
        var_y = sum((y - mean_y) ** 2 for y in ys)
        if var_x == 0.0 or var_y == 0.0:
            return 0.0
        r = cov / math.sqrt(var_x * var_y)
        return _clamp(r, -1.0, 1.0)

    def _detect_phase8_frontier(self, output: StrategyOutput) -> bool:
        """
        StrategyOutput.diagnostics に Phase 8 経路 identifier が含まれるか検出する。

        判定ロジック（P2-A1, P1-PA1-1）:
          output.diagnostics 内のいずれかの文字列に _PHASE8_FRONTIER_IDENTIFIER が
          substring として含まれていれば True。
          diagnostics が空 / 非 tuple でも例外なしに False を返す。
          rationale は検査しない（P1-PA1-1、表示文言のため将来変わりやすい）。

        Args:
            output: StrategyOutput（通常 frontier）
        Returns:
            True  — Phase 8 経路 identifier 検出
            False — identifier なし / diagnostics 空 / 非 tuple
        """
        diagnostics = getattr(output, "diagnostics", None)
        if not isinstance(diagnostics, tuple):
            return False
        for diag in diagnostics:
            if isinstance(diag, str) and _PHASE8_FRONTIER_IDENTIFIER in diag:
                return True
        return False

    def _detect_observed_max_dd_frontier(self, output: StrategyOutput) -> bool:
        """
        StrategyOutput.diagnostics に Card C observed max_dd identifier が
        含まれるか検出する（P2-C5）。

        判定ロジック（P1-C5-1 / P1-C5-3）:
          output.diagnostics 内のいずれかの文字列に
          _PHASE8_OBSERVED_MAX_DD_IDENTIFIER が substring として含まれていれば
          True。diagnostics が空 / 非 tuple でも例外なしに False を返す。
          rationale は検査しない（P1-C5-3、表示文言のため将来変わりやすい）。

        _detect_phase8_frontier との違い:
          _detect_phase8_frontier は「Phase 8 SLSQP 最適化経路」を検出する。
          本メソッドは「max_dd が returns_data ベース観測値」を検出する。
          Phase 8 SLSQP 経路でも max_dd が regime reference へ fallback した
          場合、本メソッドは False を返す（誤検出回避、P1-C5-1）。

        Args:
            output: StrategyOutput（通常 frontier）
        Returns:
            True  — Card C observed max_dd identifier 検出
            False — identifier なし / diagnostics 空 / 非 tuple
        """
        diagnostics = getattr(output, "diagnostics", None)
        if not isinstance(diagnostics, tuple):
            return False
        for diag in diagnostics:
            if (
                isinstance(diag, str)
                and _PHASE8_OBSERVED_MAX_DD_IDENTIFIER in diag
            ):
                return True
        return False

    def _build_empty_result(
        self,
        regime: str,
        diag: list[str],
    ) -> StrategyAggregateResult:
        """空の StrategyAggregateResult を返す（0戦略 / 非 dict 入力 の場合）。"""
        return StrategyAggregateResult(
            aggregated_ideal_pf=(),
            expected_return=0.0,
            expected_vol=0.0,
            sharpe_ratio=0.0,
            max_dd_estimate=0.0,
            weights_used=(),
            regime=regime,
            strategy_correlations=_EMPTY_CORRELATIONS,
            diversification_score=1.0,
            diagnostics=tuple(diag),
        )
