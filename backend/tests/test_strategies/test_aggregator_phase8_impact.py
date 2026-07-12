"""
test_aggregator_phase8_impact.py — Card A
StrategyAggregator が FrontierStrategy Phase 8 出力を消費したときの影響検証。

検証目的（P2-8Q / P2-7Q 関連）:
  Phase 8 風 FrontierStrategy 出力（actual w^T μ / √(w^T Σ w)）を直接 fixture
  で構築し、Aggregator に渡したときの集約値・相関構造・diversification score
  の挙動を整理する。Frontier 1 戦略だけが actual metric、他 3 戦略が regime
  reference metric の hybrid 状態が形式互換で壊れないことを確認する。

スコープ（Card A = A1 のみ）:
  - test 追加のみ。aggregator.py / frontier_strategy.py / 他 strategies は変更しない
  - 実 SLSQP / scipy / numpy は呼ばない。StrategyOutput を直接 fixture で構築する
  - hybrid metric の意味整理は P2 として記録のみ

設計原則:
  - stdlib のみ（math / ast / json / pathlib / re）+ pytest
  - import numpy / import scipy / import pandas 禁止
  - 禁止判定語（BUY/SELL/HOLD/WAIT）は absence assertion 用の定数として
    のみ宣言し、出力には現れないことを assert する
  - 禁止フィールド名（action / recommendation / is_buy / is_sell / is_hold /
    is_recommended / verdict / decision / approve / reject / conditional /
    rating / rebalance_order / buy_amount / sell_amount / shares / quantity /
    final_verdict / order / amount / entry_price / stop_loss / take_profit）
    は absence assertion 用の定数として宣言する
  - 具体的株数・金額・注文生成禁止

P1 記録:
  P1-A1: Card A は test 追加 + handover.md 追記のみ。backend 本体コード変更なし。
  P1-A2: fixture は既存 test_aggregator.py のスタイルを流用。
  P1-A3: Phase 8 出力は実 SLSQP を呼ばず StrategyOutput fixture で模倣。
  P1-A4: hybrid metric diagnostic は本 Card では Aggregator に追加しない。
  P1-A5: rationale 文字列による Phase 8 検出ロジックは導入しない。
  P1-A6: test 件数は 60〜90 件目安。

P2 記録（後続 Card 候補）:
  P2-A1: aggregator.py に Phase 8 hybrid metric diagnostic を追加する後続 Card。
  P2-A2: aggregator.py expected_vol を covariance-aware に改良する後続 Card
         （P2-7Q 解消）。
  P2-A3: 他 3 戦略にも actual expected_return / expected_vol を導入する後続 Card。
  P2-A4: StrategyAggregateResult.diagnostics に個別 strategy diagnostics を
         オプション集約する後続 Card。
  P2-A5: HIGH_CORR_THRESHOLD の Phase 8 適合性を継続検証。

Reference:
  handover.md "Phase 8 Cards 8-1〜8-4 Mini Integration Review" セクション
  backend/engine/strategies/aggregator.py
  backend/engine/strategies/frontier_strategy.py
"""
from __future__ import annotations

import ast
import json
import math
import re
from dataclasses import fields
from pathlib import Path

import pytest

from engine.dynamic_weight.regime_strategy_weights import (
    CANONICAL_STRATEGIES,
    get_strategy_weights,
)
from engine.strategies.aggregator import (
    CORRELATION_PAIRS,
    HIGH_CORR_THRESHOLD,
    StrategyAggregateInput,
    StrategyAggregateResult,
    StrategyAggregator,
    _EMPTY_CORRELATIONS,
    PHASE8_FRONTIER_IDENTIFIER,
    PHASE8_OBSERVED_MAX_DD_IDENTIFIER,
)
from engine.strategies.base_strategy import (
    StrategyOutput,
    VALID_STRATEGY_IDS,
)


# ── 定数: Phase 7 既存 regime reference 値（frontier_strategy.py / 他 strategies と一致）──

_REGIME_EXPECTED_RETURN: dict = {
    "bull_calm":     0.090,
    "bull_volatile": 0.070,
    "bear":          0.030,
    "crisis":        0.010,
    "uncertain":     0.060,
}

_REGIME_EXPECTED_VOL: dict = {
    "bull_calm":     0.120,
    "bull_volatile": 0.180,
    "bear":          0.200,
    "crisis":        0.300,
    "uncertain":     0.150,
}

_REGIME_MAX_DD: dict = {
    "bull_calm":     -0.08,
    "bull_volatile": -0.15,
    "bear":          -0.20,
    "crisis":        -0.35,
    "uncertain":     -0.12,
}

VALID_REGIMES: tuple = (
    "bear", "bull_calm", "bull_volatile", "crisis", "uncertain",
)


# ── 定数: 禁止フィールド名 / 禁止判定語（absence assertion 用） ────────────────
#
# 以下の語は「Aggregator / StrategyOutput 出力には現れてはならない」項目を
# 列挙する absence assertion 用の定数である。実装としての判定文字列ではない。
# grep でこれらの語がヒットしても本ファイル内の用途は absence 検証のみ。

_FORBIDDEN_FIELD_NAMES: frozenset = frozenset({
    "action", "recommendation", "is_buy", "is_sell", "is_hold",
    "is_recommended", "verdict", "decision", "approve", "reject",
    "conditional", "rating", "rebalance_order", "buy_amount",
    "sell_amount", "shares", "quantity",
    "final_verdict", "order", "amount", "entry_price",
    "stop_loss", "take_profit",
})

# 禁止判定語（uppercase）。THRESHOLD などへの部分一致は word boundary regex で除外する。
_FORBIDDEN_DECISION_TOKENS_UPPER: tuple = ("BUY", "SELL", "WAIT")
_FORBIDDEN_DECISION_HOLD_PATTERN = re.compile(r"\bHOLD\b")


# ── Phase 8 風 FrontierStrategy output fixture ───────────────────────────────


def _phase8_frontier_output(
    ideal_pf=None,
    expected_return: float = 0.05,
    expected_vol: float = 0.18,
    sharpe_ratio=None,
    max_dd_estimate: float = -0.08,
    regime: str = "bull_calm",
    extra_diagnostics: tuple = (),
    observed_max_dd: bool = False,
    fallback_max_dd: bool = False,
) -> StrategyOutput:
    """
    Phase 8 SLSQP 経路の FrontierStrategy 出力 fixture。

    expected_return / expected_vol は actual portfolio metric（w^T μ / √w^T Σ w）の
    値域を模した値。実 EfficientFrontierOptimizer / scipy / numpy は呼ばない。

    rationale には Phase 8 経路の文言を含めるが、本 Card では Aggregator 側で
    rationale を解釈しないため副作用なし（P1-A5）。

    max_dd diagnostic（P2-C5、opt-in、default は従来の旧 P1-8N 文言で
    P2-A1 テスト無影響）:
      observed_max_dd=True  → Card C 観測 max_dd identifier を含める
      fallback_max_dd=True  → Card C fallback identifier を含める
      両 False（default）   → 旧 P1-8N regime reference 文言（従来挙動）
    """
    if ideal_pf is None:
        ideal_pf = (("A", 0.4), ("B", 0.3), ("C", 0.2), ("D", 0.1))
    if sharpe_ratio is None:
        sharpe_ratio = expected_return / expected_vol if expected_vol > 0.0 else 0.0
    if observed_max_dd:
        _max_dd_diag = (
            "observation: max_dd_estimate is observed max drawdown from "
            "returns_data (calculation-only, not a prediction)"
        )
    elif fallback_max_dd:
        _max_dd_diag = (
            "observation: max_dd_estimate fell back to regime reference "
            "(returns_data unavailable or insufficient)"
        )
    else:
        _max_dd_diag = (
            "observation: max_dd_estimate is regime reference value, "
            "not optimized output (P1-8N)"
        )
    diagnostics = (
        "observation: Phase 8 SLSQP optimization used (returns_data provided)",
        *extra_diagnostics,
        _max_dd_diag,
    )
    return StrategyOutput(
        strategy_id="frontier",
        strategy_name="Frontier AI Index",
        ideal_pf=ideal_pf,
        expected_return=expected_return,
        expected_vol=expected_vol,
        sharpe_ratio=sharpe_ratio,
        max_dd_estimate=max_dd_estimate,
        rationale=(
            f"Frontier AI Index: Phase 8 SLSQP optimization "
            f"(regime={regime}, n={len(ideal_pf)})"
        ),
        diagnostics=diagnostics,
    )


def _reference_strategy_output(
    strategy_id: str,
    ideal_pf=None,
    regime: str = "bull_calm",
    er_override=None,
    vol_override=None,
    max_dd_override=None,
) -> StrategyOutput:
    """
    他 3 戦略 (quality_size / fundamental / cross_factor) 用の
    regime reference metric を持つ StrategyOutput fixture。
    frontier に対しても Phase 7 比較用として使用可能。
    """
    if ideal_pf is None:
        ideal_pf = (("A", 0.25), ("B", 0.25), ("C", 0.25), ("D", 0.25))
    er = er_override if er_override is not None else _REGIME_EXPECTED_RETURN.get(
        regime, _REGIME_EXPECTED_RETURN["uncertain"]
    )
    vol = vol_override if vol_override is not None else _REGIME_EXPECTED_VOL.get(
        regime, _REGIME_EXPECTED_VOL["uncertain"]
    )
    sharpe = er / vol if vol > 0.0 else 0.0
    max_dd = max_dd_override if max_dd_override is not None else _REGIME_MAX_DD.get(
        regime, _REGIME_MAX_DD["uncertain"]
    )
    names = {
        "quality_size": "Quality-Size Strategy",
        "fundamental":  "Fundamental Weighted Strategy",
        "cross_factor": "Cross-Factor Strategy",
        "frontier":     "Frontier AI Index",
    }
    return StrategyOutput(
        strategy_id=strategy_id,
        strategy_name=names.get(strategy_id, strategy_id),
        ideal_pf=ideal_pf,
        expected_return=er,
        expected_vol=vol,
        sharpe_ratio=sharpe,
        max_dd_estimate=max_dd,
        rationale=(
            f"{strategy_id}: regime-weighted 6-axis score allocation "
            f"(regime={regime})"
        ),
        diagnostics=(
            "observation: regime expected metrics are reference values, not guarantees",
        ),
    )


def _hybrid_outputs(
    frontier_pf=None,
    other_pf=None,
    frontier_actual_return: float = 0.05,
    frontier_actual_vol: float = 0.18,
    regime: str = "bull_calm",
) -> dict:
    """
    Phase 8 hybrid 状態の 4 戦略出力。
    frontier だけが Phase 8 actual portfolio metric、他 3 戦略は regime reference。
    """
    return {
        "frontier": _phase8_frontier_output(
            ideal_pf=frontier_pf,
            expected_return=frontier_actual_return,
            expected_vol=frontier_actual_vol,
            regime=regime,
        ),
        "quality_size": _reference_strategy_output("quality_size", other_pf, regime),
        "fundamental":  _reference_strategy_output("fundamental",  other_pf, regime),
        "cross_factor": _reference_strategy_output("cross_factor", other_pf, regime),
    }


def _all_reference_outputs(
    ideal_pf=None,
    regime: str = "bull_calm",
) -> dict:
    """4 戦略すべて regime reference metric（Phase 7 時代の状態）。"""
    return {
        sid: _reference_strategy_output(sid, ideal_pf, regime)
        for sid in CANONICAL_STRATEGIES
    }


def _agg() -> StrategyAggregator:
    return StrategyAggregator()


# ── CLASS 1: TestPhase8FrontierOutputCompatibility ───────────────────────────


class TestPhase8FrontierOutputCompatibility:
    """Aggregator が Phase 8 風 FrontierStrategy 出力を形式互換で消費できる。"""

    def test_aggregate_returns_result_instance(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        assert isinstance(result, StrategyAggregateResult)

    def test_aggregate_does_not_raise(self):
        outputs = _hybrid_outputs(regime="bear")
        # 例外送出なしで完走
        _agg().aggregate(outputs, "bear")

    def test_aggregated_ideal_pf_is_tuple(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        assert isinstance(result.aggregated_ideal_pf, tuple)

    def test_aggregated_ideal_pf_each_entry_is_2tuple(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        for entry in result.aggregated_ideal_pf:
            assert isinstance(entry, tuple)
            assert len(entry) == 2

    def test_aggregated_weights_sum_approx_one(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        total = sum(w for _, w in result.aggregated_ideal_pf)
        assert abs(total - 1.0) < 1e-9

    def test_expected_return_is_float(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        assert isinstance(result.expected_return, float)

    def test_expected_vol_is_float_and_nonnegative(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        assert isinstance(result.expected_vol, float)
        assert result.expected_vol >= 0.0

    def test_sharpe_ratio_is_float(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        assert isinstance(result.sharpe_ratio, float)

    def test_max_dd_estimate_is_nonpositive(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        assert result.max_dd_estimate <= 0.0

    def test_diversification_score_in_range(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        assert 0.0 <= result.diversification_score <= 1.0

    def test_regime_preserved(self):
        outputs = _hybrid_outputs(regime="bear")
        result = _agg().aggregate(outputs, "bear")
        assert result.regime == "bear"

    def test_weights_used_returns_all_canonical(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        used_ids = {sid for sid, _ in result.weights_used}
        assert used_ids == set(CANONICAL_STRATEGIES)


# ── CLASS 2: TestHybridMetricSemantics ───────────────────────────────────────


class TestHybridMetricSemantics:
    """
    hybrid metric (Frontier=actual + 他 3 戦略=regime reference) の集約値は
    線形加重和で計算される。本 Card では数値の一貫性のみ確認し、解釈の妥当性は
    P2 課題として残す。
    """

    def test_expected_return_is_weighted_sum(self):
        regime = "bull_calm"
        frontier_er = 0.040  # actual w^T μ（regime reference 0.090 とずらす）
        outputs = _hybrid_outputs(
            frontier_actual_return=frontier_er,
            frontier_actual_vol=0.18,
            regime=regime,
        )
        result = _agg().aggregate(outputs, regime)

        weights = get_strategy_weights(regime)
        expected = (
            weights["frontier"]     * frontier_er
            + weights["quality_size"] * _REGIME_EXPECTED_RETURN[regime]
            + weights["fundamental"]  * _REGIME_EXPECTED_RETURN[regime]
            + weights["cross_factor"] * _REGIME_EXPECTED_RETURN[regime]
        )
        assert abs(result.expected_return - expected) < 1e-9

    def test_expected_vol_is_weighted_sum(self):
        regime = "bull_calm"
        frontier_vol = 0.220
        outputs = _hybrid_outputs(
            frontier_actual_return=0.05,
            frontier_actual_vol=frontier_vol,
            regime=regime,
        )
        result = _agg().aggregate(outputs, regime)

        weights = get_strategy_weights(regime)
        expected = (
            weights["frontier"]     * frontier_vol
            + weights["quality_size"] * _REGIME_EXPECTED_VOL[regime]
            + weights["fundamental"]  * _REGIME_EXPECTED_VOL[regime]
            + weights["cross_factor"] * _REGIME_EXPECTED_VOL[regime]
        )
        assert abs(result.expected_vol - expected) < 1e-9

    def test_sharpe_ratio_is_agg_return_over_agg_vol(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        if result.expected_vol > 0.0:
            assert abs(
                result.sharpe_ratio - result.expected_return / result.expected_vol
            ) < 1e-9
        else:
            assert result.sharpe_ratio == 0.0

    def test_crisis_frontier_weight_is_max(self):
        weights = get_strategy_weights("crisis")
        assert weights["frontier"] > weights["quality_size"]
        assert weights["frontier"] > weights["fundamental"]
        assert weights["frontier"] > weights["cross_factor"]

    def test_crisis_high_frontier_actual_lifts_aggregate_return(self):
        regime = "crisis"
        high_outputs = _hybrid_outputs(
            frontier_actual_return=0.20,
            frontier_actual_vol=0.30,
            regime=regime,
        )
        ref_outputs = _all_reference_outputs(regime=regime)
        high_result = _agg().aggregate(high_outputs, regime)
        ref_result = _agg().aggregate(ref_outputs, regime)
        assert high_result.expected_return > ref_result.expected_return

    def test_phase7_vs_phase8_aggregate_return_differs_when_frontier_actual_differs(self):
        regime = "bull_calm"
        phase7_outs = _all_reference_outputs(regime=regime)
        phase8_outs = _hybrid_outputs(
            frontier_actual_return=0.150,  # regime reference 0.090 から意図的にずらす
            frontier_actual_vol=0.18,
            regime=regime,
        )
        r7 = _agg().aggregate(phase7_outs, regime)
        r8 = _agg().aggregate(phase8_outs, regime)
        assert r7.expected_return != r8.expected_return

    def test_phase7_vs_phase8_aggregate_vol_differs_when_frontier_actual_vol_differs(self):
        regime = "bull_calm"
        phase7_outs = _all_reference_outputs(regime=regime)
        phase8_outs = _hybrid_outputs(
            frontier_actual_return=0.05,
            frontier_actual_vol=0.250,  # regime reference 0.120 から意図的にずらす
            regime=regime,
        )
        r7 = _agg().aggregate(phase7_outs, regime)
        r8 = _agg().aggregate(phase8_outs, regime)
        assert r7.expected_vol != r8.expected_vol

    def test_aggregate_max_dd_is_nonpositive_under_hybrid(self):
        outputs = _hybrid_outputs(regime="crisis")
        result = _agg().aggregate(outputs, "crisis")
        assert result.max_dd_estimate <= 0.0

    def test_aggregate_max_dd_is_weighted_sum(self):
        regime = "bear"
        outputs = _hybrid_outputs(regime=regime)
        result = _agg().aggregate(outputs, regime)
        weights = get_strategy_weights(regime)
        raw = (
            weights["frontier"]     * outputs["frontier"].max_dd_estimate
            + weights["quality_size"] * outputs["quality_size"].max_dd_estimate
            + weights["fundamental"]  * outputs["fundamental"].max_dd_estimate
            + weights["cross_factor"] * outputs["cross_factor"].max_dd_estimate
        )
        expected = min(0.0, raw)
        assert abs(result.max_dd_estimate - expected) < 1e-9

    def test_hybrid_state_keeps_sharpe_finite(self):
        for er, vol in [(0.05, 0.18), (0.01, 0.30), (0.10, 0.12), (0.0, 0.0)]:
            outputs = _hybrid_outputs(
                frontier_actual_return=er,
                frontier_actual_vol=vol,
                regime="bull_calm",
            )
            result = _agg().aggregate(outputs, "bull_calm")
            assert isinstance(result.sharpe_ratio, float)
            assert not math.isnan(result.sharpe_ratio)
            assert not math.isinf(result.sharpe_ratio)

    def test_aggregate_return_finite_with_negative_frontier_actual(self):
        outputs = _hybrid_outputs(
            frontier_actual_return=-0.05,
            frontier_actual_vol=0.30,
            regime="crisis",
        )
        result = _agg().aggregate(outputs, "crisis")
        assert isinstance(result.expected_return, float)
        assert not math.isnan(result.expected_return)
        assert not math.isinf(result.expected_return)

    def test_aggregate_vol_clamped_nonnegative_when_frontier_zero(self):
        outputs = _hybrid_outputs(
            frontier_actual_return=0.05,
            frontier_actual_vol=0.0,
            regime="bull_calm",
        )
        result = _agg().aggregate(outputs, "bull_calm")
        assert result.expected_vol >= 0.0

    def test_sharpe_zero_when_aggregate_vol_zero(self):
        outputs = {
            sid: _reference_strategy_output(
                sid, regime="bull_calm",
                er_override=0.05, vol_override=0.0, max_dd_override=0.0,
            )
            for sid in CANONICAL_STRATEGIES
        }
        outputs["frontier"] = _phase8_frontier_output(
            expected_return=0.05, expected_vol=0.0, regime="bull_calm",
        )
        result = _agg().aggregate(outputs, "bull_calm")
        assert result.expected_vol == 0.0
        assert result.sharpe_ratio == 0.0

    # 旧 test_aggregator_does_not_surface_phase8_identifier は P2-A1 実装で削除。
    # 新規 hybrid metric diagnostic 検証は TestHybridMetricDiagnostic クラスに移動。


# ── CLASS 2b: TestHybridMetricDiagnostic（P2-A1 で追加）──────────────────────


class TestHybridMetricDiagnostic:
    """
    P2-A1: aggregator.py に追加された hybrid metric diagnostic の検証。

    Phase 8 frontier 出力が検出された場合、Aggregator は以下 3 件の diagnostic
    を追加する:
      1. "aggregated metrics include hybrid metric sources" 趣旨
      2. "aggregate expected_vol is linear weighted aggregation" 趣旨
      3. "aggregate sharpe_ratio is based on hybrid aggregate metrics" 趣旨
    """

    def test_phase8_frontier_triggers_hybrid_diagnostic(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        joined = " ".join(result.diagnostics)
        assert "hybrid metric sources" in joined

    def test_phase8_frontier_triggers_linear_vol_diagnostic(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        joined = " ".join(result.diagnostics)
        assert "linear weighted aggregation" in joined
        assert "not covariance-aware" in joined

    def test_phase8_frontier_triggers_hybrid_sharpe_diagnostic(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        joined = " ".join(result.diagnostics)
        assert "hybrid aggregate metrics" in joined
        assert "calculation-only, not a recommendation" in joined

    def test_phase7_frontier_no_hybrid_diagnostic(self):
        """
        Phase 7 経路風（identifier なし）の frontier 出力では hybrid diagnostic
        が追加されない。
        """
        # 全 4 戦略を regime reference 出力（Phase 7 風）で構成
        outputs = _all_reference_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        joined = " ".join(result.diagnostics)
        assert "hybrid metric sources" not in joined
        assert "linear weighted aggregation" not in joined
        assert "hybrid aggregate metrics" not in joined

    def test_no_frontier_no_hybrid_diagnostic(self):
        """
        frontier が valid_outputs に存在しない場合は hybrid diagnostic 不在。
        """
        outputs = {
            "quality_size": _reference_strategy_output("quality_size", regime="bull_calm"),
            "fundamental":  _reference_strategy_output("fundamental",  regime="bull_calm"),
            "cross_factor": _reference_strategy_output("cross_factor", regime="bull_calm"),
        }
        result = _agg().aggregate(outputs, "bull_calm")
        joined = " ".join(result.diagnostics)
        assert "hybrid metric sources" not in joined
        assert "linear weighted aggregation" not in joined

    def test_invalid_frontier_no_hybrid_diagnostic(self):
        """
        frontier の strategy_id を持つが diagnostics に Phase 8 identifier が
        含まれない場合は hybrid diagnostic 不在。
        """
        # frontier strategy_id を regime reference 出力に差し替え
        outputs = _hybrid_outputs(regime="bull_calm")
        outputs["frontier"] = _reference_strategy_output("frontier", regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        joined = " ".join(result.diagnostics)
        assert "hybrid metric sources" not in joined
        assert "linear weighted aggregation" not in joined

    def test_hybrid_diagnostic_uses_observation_prefix(self):
        """追加される 3 件すべてが 'observation: ' 接頭辞を持つ。"""
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        hybrid_diags = [
            d for d in result.diagnostics
            if "hybrid metric sources" in d
            or "linear weighted aggregation" in d
            or "hybrid aggregate metrics" in d
        ]
        assert len(hybrid_diags) == 3
        for d in hybrid_diags:
            assert d.startswith("observation: "), (
                f"hybrid diagnostic lacks 'observation: ' prefix: {d!r}"
            )

    def test_hybrid_diagnostic_count_three_when_detected(self):
        """Phase 8 検出時に hybrid diagnostic は 3 件追加される。"""
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        hybrid_count = sum(
            1 for d in result.diagnostics
            if "hybrid metric sources" in d
            or "linear weighted aggregation" in d
            or "hybrid aggregate metrics" in d
        )
        assert hybrid_count == 3

    def test_phase8_identifier_constant_value(self):
        assert PHASE8_FRONTIER_IDENTIFIER == "Phase 8 SLSQP optimization used"

    def test_phase8_detection_via_diagnostics_only(self):
        """
        rationale に identifier を含めても、diagnostics に含まれていなければ
        hybrid diagnostic は追加されない（rationale 検出は使わない仕様）。
        """
        # frontier output を手動構築: rationale に Phase 8 marker を入れるが
        # diagnostics には入れない
        rationale_only_frontier = StrategyOutput(
            strategy_id="frontier",
            strategy_name="Frontier AI Index",
            ideal_pf=(("A", 0.5), ("B", 0.5)),
            expected_return=0.05,
            expected_vol=0.18,
            sharpe_ratio=0.28,
            max_dd_estimate=-0.08,
            rationale="Frontier AI Index: Phase 8 SLSQP optimization (regime=bull_calm, n=2)",
            diagnostics=(
                "observation: some unrelated note",
            ),
        )
        outputs = _all_reference_outputs(regime="bull_calm")
        outputs["frontier"] = rationale_only_frontier
        result = _agg().aggregate(outputs, "bull_calm")
        joined = " ".join(result.diagnostics)
        # rationale-only では検出されない仕様
        assert "hybrid metric sources" not in joined
        assert "linear weighted aggregation" not in joined

    def test_phase8_identifier_substring_match(self):
        """identifier は substring マッチ。任意の前後文脈で検出される。"""
        outputs = _all_reference_outputs(regime="bull_calm")
        # frontier の diagnostics に identifier を任意位置に含める
        custom_frontier = StrategyOutput(
            strategy_id="frontier",
            strategy_name="Frontier AI Index",
            ideal_pf=(("A", 0.5), ("B", 0.5)),
            expected_return=0.05,
            expected_vol=0.18,
            sharpe_ratio=0.28,
            max_dd_estimate=-0.08,
            rationale="frontier: regime reference",
            diagnostics=(
                "observation: some prefix Phase 8 SLSQP optimization used "
                "(returns_data provided) some suffix",
            ),
        )
        outputs["frontier"] = custom_frontier
        result = _agg().aggregate(outputs, "bull_calm")
        joined = " ".join(result.diagnostics)
        assert "hybrid metric sources" in joined


# ── CLASS 2c: TestMaxDdHybridDiagnostic（P2-C5 で追加）──────────────────────


class TestMaxDdHybridDiagnostic:
    """
    P2-C5: aggregator.py の observed/reference max_dd hybrid diagnostic 検証。

    Card C 観測 max_dd identifier が frontier diagnostics に含まれる場合のみ、
    Aggregator は max_dd 専用 hybrid diagnostic を 2 件追加する:
      1. "aggregate max_dd_estimate may include hybrid drawdown sources" 趣旨
      2. "aggregate max_dd_estimate is linear weighted aggregation" 趣旨

    P2-A1（Phase 8 SLSQP identifier）とは独立した検出・別文言。
    Phase 8 SLSQP 経路でも max_dd が regime reference fallback した場合は
    発火しない（精度検証）。
    """

    _D1 = "hybrid drawdown sources"
    _D2 = "aggregate max_dd_estimate is linear weighted aggregation"

    def _max_dd_diags(self, result) -> list:
        return [
            d for d in result.diagnostics
            if self._D1 in d or self._D2 in d
        ]

    def test_observed_max_dd_triggers_two_diagnostics(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        outputs["frontier"] = _phase8_frontier_output(
            regime="bull_calm", observed_max_dd=True
        )
        result = _agg().aggregate(outputs, "bull_calm")
        assert len(self._max_dd_diags(result)) == 2

    def test_observed_max_dd_has_hybrid_drawdown_sources(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        outputs["frontier"] = _phase8_frontier_output(
            regime="bull_calm", observed_max_dd=True
        )
        result = _agg().aggregate(outputs, "bull_calm")
        joined = " ".join(result.diagnostics)
        assert "hybrid drawdown sources" in joined
        assert "observed returns_data drawdown" in joined

    def test_observed_max_dd_has_linear_weighted_aggregation(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        outputs["frontier"] = _phase8_frontier_output(
            regime="bull_calm", observed_max_dd=True
        )
        result = _agg().aggregate(outputs, "bull_calm")
        joined = " ".join(result.diagnostics)
        assert "aggregate max_dd_estimate is linear weighted aggregation" in joined
        assert "not a prediction" in joined

    def test_default_fixture_no_max_dd_hybrid_diagnostic(self):
        # default fixture（旧 P1-8N 文言）では発火しない
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        assert self._max_dd_diags(result) == []

    def test_fallback_max_dd_no_hybrid_diagnostic(self):
        # 精度検証: Phase 8 SLSQP でも max_dd fallback 時は発火しない（P1-C5-1）
        outputs = _hybrid_outputs(regime="bull_calm")
        outputs["frontier"] = _phase8_frontier_output(
            regime="bull_calm", fallback_max_dd=True
        )
        result = _agg().aggregate(outputs, "bull_calm")
        assert self._max_dd_diags(result) == []
        joined = " ".join(result.diagnostics)
        assert "hybrid drawdown sources" not in joined

    def test_no_frontier_no_max_dd_hybrid_diagnostic(self):
        outputs = {
            "quality_size": _reference_strategy_output("quality_size", regime="bull_calm"),
            "fundamental":  _reference_strategy_output("fundamental",  regime="bull_calm"),
            "cross_factor": _reference_strategy_output("cross_factor", regime="bull_calm"),
        }
        result = _agg().aggregate(outputs, "bull_calm")
        assert self._max_dd_diags(result) == []

    def test_max_dd_hybrid_diagnostics_use_observation_prefix(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        outputs["frontier"] = _phase8_frontier_output(
            regime="bull_calm", observed_max_dd=True
        )
        result = _agg().aggregate(outputs, "bull_calm")
        for d in self._max_dd_diags(result):
            assert d.startswith("observation: ")

    def test_observed_identifier_constant_value(self):
        assert PHASE8_OBSERVED_MAX_DD_IDENTIFIER == (
            "max_dd_estimate is observed max drawdown from returns_data"
        )

    def test_rationale_only_observed_not_detected(self):
        # rationale だけに observed 文言を入れても検出されない（diagnostics-only）
        rationale_only = StrategyOutput(
            strategy_id="frontier",
            strategy_name="Frontier AI Index",
            ideal_pf=(("A", 0.5), ("B", 0.5)),
            expected_return=0.05,
            expected_vol=0.18,
            sharpe_ratio=0.28,
            max_dd_estimate=-0.08,
            rationale=(
                "Frontier AI Index: max_dd_estimate is observed max drawdown "
                "from returns_data"
            ),
            diagnostics=(
                "observation: Phase 8 SLSQP optimization used (returns_data provided)",
                "observation: some unrelated note",
            ),
        )
        outputs = _all_reference_outputs(regime="bull_calm")
        outputs["frontier"] = rationale_only
        result = _agg().aggregate(outputs, "bull_calm")
        assert self._max_dd_diags(result) == []

    def test_observed_identifier_substring_match(self):
        outputs = _all_reference_outputs(regime="bull_calm")
        custom = StrategyOutput(
            strategy_id="frontier",
            strategy_name="Frontier AI Index",
            ideal_pf=(("A", 0.5), ("B", 0.5)),
            expected_return=0.05,
            expected_vol=0.18,
            sharpe_ratio=0.28,
            max_dd_estimate=-0.08,
            rationale="frontier: regime reference",
            diagnostics=(
                "observation: prefix max_dd_estimate is observed max drawdown "
                "from returns_data (calculation-only, not a prediction) suffix",
            ),
        )
        outputs["frontier"] = custom
        result = _agg().aggregate(outputs, "bull_calm")
        joined = " ".join(result.diagnostics)
        assert "hybrid drawdown sources" in joined

    def test_p2a1_count_three_unaffected_by_default_fixture(self):
        # 既存 P2-A1 テスト相当: default fixture で P2-A1 は 3 件のまま、
        # P2-C5 は 0 件（P2-C5 が P2-A1 に干渉しないことを確認）
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        p2a1 = [
            d for d in result.diagnostics
            if "hybrid metric sources" in d
            or "linear weighted aggregation, not covariance-aware" in d
            or "hybrid aggregate metrics" in d
        ]
        assert len(p2a1) == 3
        assert self._max_dd_diags(result) == []

    def test_observed_and_p2a1_coexist_when_both_identifiers_present(self):
        # frontier に SLSQP identifier + observed max_dd identifier 両方 →
        # P2-A1 3 件 + P2-C5 2 件 が共存
        outputs = _hybrid_outputs(regime="bull_calm")
        outputs["frontier"] = _phase8_frontier_output(
            regime="bull_calm", observed_max_dd=True
        )
        result = _agg().aggregate(outputs, "bull_calm")
        joined = " ".join(result.diagnostics)
        assert "hybrid metric sources" in joined          # P2-A1
        assert "hybrid drawdown sources" in joined         # P2-C5
        assert len(self._max_dd_diags(result)) == 2


# ── CLASS 3: TestCorrelationStructureChange ──────────────────────────────────


class TestCorrelationStructureChange:
    """Phase 7 proportional weights vs Phase 8 concentrated weights の相関構造変化。"""

    def test_strategy_correlations_have_6_pairs(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        assert len(result.strategy_correlations) == 6

    def test_each_correlation_is_2tuple(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        for entry in result.strategy_correlations:
            assert isinstance(entry, tuple)
            assert len(entry) == 2

    def test_each_correlation_key_uses_vs_separator(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        for key, _ in result.strategy_correlations:
            assert "_vs_" in key

    def test_each_correlation_in_range(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        for _, val in result.strategy_correlations:
            assert -1.0 <= val <= 1.0

    def test_missing_strategy_pair_returns_zero(self):
        outputs = {
            "frontier":     _phase8_frontier_output(regime="bull_calm"),
            "fundamental":  _reference_strategy_output("fundamental",  regime="bull_calm"),
            "cross_factor": _reference_strategy_output("cross_factor", regime="bull_calm"),
        }
        result = _agg().aggregate(outputs, "bull_calm")
        corrs = dict(result.strategy_correlations)
        assert corrs["frontier_vs_quality_size"] == 0.0
        assert corrs["quality_size_vs_fundamental"] == 0.0
        assert corrs["quality_size_vs_cross_factor"] == 0.0

    def test_identical_weights_yield_perfect_positive_correlation(self):
        ideal_pf = (("A", 0.6), ("B", 0.3), ("C", 0.1))
        outputs = {
            sid: _reference_strategy_output(sid, ideal_pf=ideal_pf, regime="bull_calm")
            for sid in CANONICAL_STRATEGIES
        }
        outputs["frontier"] = _phase8_frontier_output(
            ideal_pf=ideal_pf, regime="bull_calm",
        )
        result = _agg().aggregate(outputs, "bull_calm")
        for _, val in result.strategy_correlations:
            assert val > 0.999

    def test_opposite_weights_yield_perfect_negative_correlation(self):
        normal_pf = (("A", 1.0), ("B", 0.0))
        reversed_pf = (("A", 0.0), ("B", 1.0))
        outputs = {
            "frontier":     _phase8_frontier_output(
                ideal_pf=reversed_pf, regime="bull_calm",
            ),
            "quality_size": _reference_strategy_output(
                "quality_size", ideal_pf=normal_pf, regime="bull_calm",
            ),
        }
        result = _agg().aggregate(outputs, "bull_calm")
        corrs = dict(result.strategy_correlations)
        assert corrs["frontier_vs_quality_size"] < -0.999

    def test_phase8_concentrated_weights_change_correlations(self):
        """Phase 7 風 (4 戦略同一 weights) と Phase 8 風 (frontier 集中 + 他 even) の
        相関構造が異なる。"""
        regime = "bull_calm"
        proportional_pf = (("A", 0.4), ("B", 0.3), ("C", 0.2), ("D", 0.1))
        concentrated_pf = (("A", 0.70), ("B", 0.15), ("C", 0.10), ("D", 0.05))

        phase7_outs = {
            sid: _reference_strategy_output(sid, ideal_pf=proportional_pf, regime=regime)
            for sid in CANONICAL_STRATEGIES
        }
        phase8_outs = {
            "frontier":     _phase8_frontier_output(
                ideal_pf=concentrated_pf, regime=regime,
            ),
            "quality_size": _reference_strategy_output(
                "quality_size", ideal_pf=proportional_pf, regime=regime,
            ),
            "fundamental":  _reference_strategy_output(
                "fundamental",  ideal_pf=proportional_pf, regime=regime,
            ),
            "cross_factor": _reference_strategy_output(
                "cross_factor", ideal_pf=proportional_pf, regime=regime,
            ),
        }
        r7 = _agg().aggregate(phase7_outs, regime)
        r8 = _agg().aggregate(phase8_outs, regime)
        assert dict(r7.strategy_correlations) != dict(r8.strategy_correlations)

    def test_correlations_keys_match_canonical_pairs(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        expected_keys = {f"{a}_vs_{b}" for a, b in CORRELATION_PAIRS}
        actual_keys = {k for k, _ in result.strategy_correlations}
        assert actual_keys == expected_keys

    def test_correlations_sorted_by_key(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        keys = [k for k, _ in result.strategy_correlations]
        assert keys == sorted(keys)


# ── CLASS 4: TestDiversificationScoreImpact ──────────────────────────────────


class TestDiversificationScoreImpact:
    """HIGH_CORR_THRESHOLD=0.70 跨ぎ条件と diversification_score 挙動。"""

    def test_high_correlation_triggers_diagnostic(self):
        ideal_pf = (("A", 0.5), ("B", 0.3), ("C", 0.2))
        outputs = {
            sid: _reference_strategy_output(sid, ideal_pf=ideal_pf, regime="bull_calm")
            for sid in CANONICAL_STRATEGIES
        }
        outputs["frontier"] = _phase8_frontier_output(
            ideal_pf=ideal_pf, regime="bull_calm",
        )
        result = _agg().aggregate(outputs, "bull_calm")
        joined = " ".join(result.diagnostics)
        assert "max strategy correlation" in joined

    def test_low_correlation_no_high_corr_diagnostic(self):
        outputs = {
            "frontier": _phase8_frontier_output(
                ideal_pf=(("A", 0.7), ("B", 0.1), ("C", 0.1), ("D", 0.1)),
                regime="bull_calm",
            ),
            "quality_size": _reference_strategy_output(
                "quality_size",
                ideal_pf=(("A", 0.1), ("B", 0.7), ("C", 0.1), ("D", 0.1)),
                regime="bull_calm",
            ),
            "fundamental": _reference_strategy_output(
                "fundamental",
                ideal_pf=(("A", 0.1), ("B", 0.1), ("C", 0.7), ("D", 0.1)),
                regime="bull_calm",
            ),
            "cross_factor": _reference_strategy_output(
                "cross_factor",
                ideal_pf=(("A", 0.1), ("B", 0.1), ("C", 0.1), ("D", 0.7)),
                regime="bull_calm",
            ),
        }
        result = _agg().aggregate(outputs, "bull_calm")
        joined = " ".join(result.diagnostics)
        assert "max strategy correlation" not in joined

    def test_high_corr_threshold_value(self):
        assert HIGH_CORR_THRESHOLD == 0.70

    def test_diversification_score_clamped_in_range(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        assert 0.0 <= result.diversification_score <= 1.0

    def test_diversification_score_high_when_pairs_are_decorrelated(self):
        """各戦略を異なる ticker に集中 → 全ペア負相関 → max_positive_corr=0
        → diversification = 1.0"""
        outputs = {
            "frontier": _phase8_frontier_output(
                ideal_pf=(("A", 0.7), ("B", 0.1), ("C", 0.1), ("D", 0.1)),
                regime="bull_calm",
            ),
            "quality_size": _reference_strategy_output(
                "quality_size",
                ideal_pf=(("A", 0.1), ("B", 0.7), ("C", 0.1), ("D", 0.1)),
                regime="bull_calm",
            ),
            "fundamental": _reference_strategy_output(
                "fundamental",
                ideal_pf=(("A", 0.1), ("B", 0.1), ("C", 0.7), ("D", 0.1)),
                regime="bull_calm",
            ),
            "cross_factor": _reference_strategy_output(
                "cross_factor",
                ideal_pf=(("A", 0.1), ("B", 0.1), ("C", 0.1), ("D", 0.7)),
                regime="bull_calm",
            ),
        }
        result = _agg().aggregate(outputs, "bull_calm")
        assert result.diversification_score >= 0.9

    def test_diversification_score_low_when_all_identical(self):
        ideal_pf = (("A", 0.6), ("B", 0.3), ("C", 0.1))
        outputs = {
            sid: _reference_strategy_output(sid, ideal_pf=ideal_pf, regime="bull_calm")
            for sid in CANONICAL_STRATEGIES
        }
        outputs["frontier"] = _phase8_frontier_output(
            ideal_pf=ideal_pf, regime="bull_calm",
        )
        result = _agg().aggregate(outputs, "bull_calm")
        assert result.diversification_score < 0.05

    def test_low_correlation_below_threshold_no_diagnostic(self):
        outputs = {
            "frontier": _phase8_frontier_output(
                ideal_pf=(("A", 0.4), ("B", 0.3), ("C", 0.2), ("D", 0.1)),
                regime="bull_calm",
            ),
            "quality_size": _reference_strategy_output(
                "quality_size",
                ideal_pf=(("A", 0.1), ("B", 0.2), ("C", 0.3), ("D", 0.4)),
                regime="bull_calm",
            ),
            "fundamental": _reference_strategy_output(
                "fundamental",
                ideal_pf=(("A", 0.3), ("B", 0.4), ("C", 0.1), ("D", 0.2)),
                regime="bull_calm",
            ),
            "cross_factor": _reference_strategy_output(
                "cross_factor",
                ideal_pf=(("A", 0.2), ("B", 0.1), ("C", 0.4), ("D", 0.3)),
                regime="bull_calm",
            ),
        }
        result = _agg().aggregate(outputs, "bull_calm")
        max_corr = max(v for _, v in result.strategy_correlations)
        if max_corr < HIGH_CORR_THRESHOLD:
            joined = " ".join(result.diagnostics)
            assert "max strategy correlation" not in joined

    def test_zero_strategies_diversification_score_is_one(self):
        result = _agg().aggregate({}, "bull_calm")
        assert result.diversification_score == 1.0

    def test_only_negative_correlations_yields_diversification_one(self):
        """frontier vs quality_size = -1.0、他 5 ペアは missing → 0.0
        → max_positive_corr = 0 → diversification = 1.0"""
        outputs = {
            "frontier": _phase8_frontier_output(
                ideal_pf=(("A", 0.0), ("B", 1.0)),
                regime="bull_calm",
            ),
            "quality_size": _reference_strategy_output(
                "quality_size",
                ideal_pf=(("A", 1.0), ("B", 0.0)),
                regime="bull_calm",
            ),
        }
        result = _agg().aggregate(outputs, "bull_calm")
        assert result.diversification_score == 1.0

    def test_diversification_score_decreases_when_correlation_increases(self):
        regime = "bull_calm"
        ident_pf = (("A", 0.5), ("B", 0.3), ("C", 0.2))
        identical = {
            sid: _reference_strategy_output(sid, ideal_pf=ident_pf, regime=regime)
            for sid in CANONICAL_STRATEGIES
        }
        identical["frontier"] = _phase8_frontier_output(
            ideal_pf=ident_pf, regime=regime,
        )

        decorr = {
            "frontier": _phase8_frontier_output(
                ideal_pf=(("A", 0.7), ("B", 0.1), ("C", 0.1), ("D", 0.1)),
                regime=regime,
            ),
            "quality_size": _reference_strategy_output(
                "quality_size",
                ideal_pf=(("A", 0.1), ("B", 0.7), ("C", 0.1), ("D", 0.1)),
                regime=regime,
            ),
            "fundamental": _reference_strategy_output(
                "fundamental",
                ideal_pf=(("A", 0.1), ("B", 0.1), ("C", 0.7), ("D", 0.1)),
                regime=regime,
            ),
            "cross_factor": _reference_strategy_output(
                "cross_factor",
                ideal_pf=(("A", 0.1), ("B", 0.1), ("C", 0.1), ("D", 0.7)),
                regime=regime,
            ),
        }
        r_ident = _agg().aggregate(identical, regime)
        r_decorr = _agg().aggregate(decorr, regime)
        assert r_ident.diversification_score < r_decorr.diversification_score


# ── CLASS 5: TestRegimeWeightSensitivity ─────────────────────────────────────


class TestRegimeWeightSensitivity:
    """5 regime での frontier weight 0.3〜0.7 範囲と Phase 8 影響度。"""

    @pytest.mark.parametrize("regime", VALID_REGIMES)
    def test_each_regime_produces_valid_result(self, regime):
        outputs = _hybrid_outputs(regime=regime)
        result = _agg().aggregate(outputs, regime)
        assert isinstance(result, StrategyAggregateResult)
        assert result.regime == regime

    @pytest.mark.parametrize("regime", VALID_REGIMES)
    def test_each_regime_weights_used_sum_approx_one(self, regime):
        outputs = _hybrid_outputs(regime=regime)
        result = _agg().aggregate(outputs, regime)
        total = sum(w for _, w in result.weights_used)
        assert abs(total - 1.0) < 1e-9

    @pytest.mark.parametrize("regime", VALID_REGIMES)
    def test_each_regime_frontier_weight_in_documented_range(self, regime):
        """handover.md に記録された frontier weight 範囲 [0.3, 0.7] の確認。"""
        weights = get_strategy_weights(regime)
        assert 0.3 <= weights["frontier"] <= 0.7

    @pytest.mark.parametrize("regime", VALID_REGIMES)
    def test_each_regime_returns_canonical_strategies_only(self, regime):
        weights = get_strategy_weights(regime)
        assert set(weights.keys()) == set(CANONICAL_STRATEGIES)

    def test_crisis_frontier_weight_is_highest(self):
        weights = get_strategy_weights("crisis")
        assert weights["frontier"] == max(weights.values())

    def test_crisis_frontier_weight_exceeds_other_regimes(self):
        crisis_w = get_strategy_weights("crisis")["frontier"]
        for regime in VALID_REGIMES:
            if regime != "crisis":
                other_w = get_strategy_weights(regime)["frontier"]
                assert crisis_w > other_w

    def test_bull_volatile_frontier_weight_lowest(self):
        bull_vol_w = get_strategy_weights("bull_volatile")["frontier"]
        for regime in VALID_REGIMES:
            if regime != "bull_volatile":
                other_w = get_strategy_weights(regime)["frontier"]
                assert bull_vol_w <= other_w

    def test_crisis_phase8_impact_larger_than_bull_volatile(self):
        """frontier weight 0.7 (crisis) > 0.3 (bull_volatile) なので
        Phase 8 actual の集約への影響は crisis 側が大きい。"""
        frontier_er = 0.20

        crisis_hybrid = _hybrid_outputs(
            frontier_actual_return=frontier_er,
            frontier_actual_vol=0.30,
            regime="crisis",
        )
        crisis_ref = _all_reference_outputs(regime="crisis")
        crisis_delta = abs(
            _agg().aggregate(crisis_hybrid, "crisis").expected_return
            - _agg().aggregate(crisis_ref, "crisis").expected_return
        )

        bv_hybrid = _hybrid_outputs(
            frontier_actual_return=frontier_er,
            frontier_actual_vol=0.30,
            regime="bull_volatile",
        )
        bv_ref = _all_reference_outputs(regime="bull_volatile")
        bv_delta = abs(
            _agg().aggregate(bv_hybrid, "bull_volatile").expected_return
            - _agg().aggregate(bv_ref, "bull_volatile").expected_return
        )

        assert crisis_delta > bv_delta

    def test_unknown_regime_falls_back_with_diagnostic(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "unknown_regime_xyz")
        joined = " ".join(result.diagnostics)
        assert "unknown regime" in joined

    def test_unknown_regime_still_produces_valid_result(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "no_such_regime")
        assert isinstance(result, StrategyAggregateResult)
        assert len(result.weights_used) == 4

    def test_regime_weights_used_sorted_by_strategy_id(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        sids = [sid for sid, _ in result.weights_used]
        assert sids == sorted(sids)


# ── CLASS 6: TestStrategyOutputContractPreserved ─────────────────────────────


class TestStrategyOutputContractPreserved:
    """Aggregator 出力が StrategyAggregateResult 不変条件を満たす。"""

    def test_no_forbidden_fields_on_result_dataclass(self):
        field_names = {f.name for f in fields(StrategyAggregateResult)}
        for forbidden in _FORBIDDEN_FIELD_NAMES:
            assert forbidden not in field_names

    def test_no_forbidden_fields_on_input_dataclass(self):
        field_names = {f.name for f in fields(StrategyAggregateInput)}
        for forbidden in _FORBIDDEN_FIELD_NAMES:
            assert forbidden not in field_names

    def test_to_dict_is_json_serializable(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        as_dict = result.to_dict()
        s = json.dumps(as_dict)
        assert isinstance(s, str)

    def test_to_dict_aggregated_ideal_pf_is_dict(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        as_dict = result.to_dict()
        assert isinstance(as_dict["aggregated_ideal_pf"], dict)

    def test_to_dict_weights_used_is_dict(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        as_dict = result.to_dict()
        assert isinstance(as_dict["weights_used"], dict)

    def test_to_dict_strategy_correlations_is_dict(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        as_dict = result.to_dict()
        assert isinstance(as_dict["strategy_correlations"], dict)

    def test_expected_vol_clamped_nonneg(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        assert result.expected_vol >= 0.0

    def test_max_dd_clamped_nonpos(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        assert result.max_dd_estimate <= 0.0

    def test_diversification_score_in_unit_interval(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        assert 0.0 <= result.diversification_score <= 1.0

    def test_result_is_frozen(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        with pytest.raises(Exception):
            result.regime = "bear"  # type: ignore


# ── CLASS 7: TestForbiddenFieldsAbsent ───────────────────────────────────────


class TestForbiddenFieldsAbsent:
    """禁止フィールド名・禁止判定語が Aggregator 出力に含まれないことを確認。"""

    def test_result_dict_keys_have_no_forbidden_names(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        as_dict = result.to_dict()
        for key in as_dict.keys():
            for forbidden in _FORBIDDEN_FIELD_NAMES:
                assert key != forbidden, (
                    f"Forbidden field '{forbidden}' found in output keys: {list(as_dict.keys())}"
                )

    def test_diagnostics_have_no_decision_tokens_upper(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        for diag in result.diagnostics:
            for tok in _FORBIDDEN_DECISION_TOKENS_UPPER:
                assert tok not in diag, (
                    f"Forbidden token '{tok}' found in diagnostic: {diag!r}"
                )

    def test_diagnostics_have_no_HOLD_as_word(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        for diag in result.diagnostics:
            assert not _FORBIDDEN_DECISION_HOLD_PATTERN.search(diag), (
                f"Found HOLD as word in: {diag!r}"
            )

    def test_rationale_from_strategies_have_no_decision_tokens(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        for sid, out in outputs.items():
            for tok in _FORBIDDEN_DECISION_TOKENS_UPPER:
                assert tok not in out.rationale, (
                    f"Forbidden token '{tok}' in {sid}.rationale: {out.rationale!r}"
                )

    def test_rationale_from_strategies_have_no_HOLD_as_word(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        for sid, out in outputs.items():
            assert not _FORBIDDEN_DECISION_HOLD_PATTERN.search(out.rationale), (
                f"Found HOLD as word in {sid}.rationale: {out.rationale!r}"
            )

    def test_result_repr_has_no_forbidden_field_names(self):
        outputs = _hybrid_outputs(regime="bull_calm")
        result = _agg().aggregate(outputs, "bull_calm")
        repr_str = repr(result)
        # 完全一致のみ。"return" は "expected_return" の一部だが forbidden には含めない
        for forbidden in _FORBIDDEN_FIELD_NAMES:
            assert f"{forbidden}=" not in repr_str, (
                f"Forbidden field '{forbidden}=' found in repr: {repr_str[:200]}"
            )


# ── CLASS 8: TestStaticImportConstraints ─────────────────────────────────────


class TestStaticImportConstraints:
    """本 test ファイル自体に numpy / scipy / pandas import がないことを AST 検証。"""

    @staticmethod
    def _top_level_imports() -> set:
        source = Path(__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        names: set = set()
        for node in tree.body:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    names.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                if node.module is not None:
                    names.add(node.module.split(".")[0])
        return names

    def test_no_numpy_import(self):
        assert "numpy" not in self._top_level_imports()

    def test_no_scipy_import(self):
        assert "scipy" not in self._top_level_imports()

    def test_no_pandas_import(self):
        assert "pandas" not in self._top_level_imports()

    def test_only_stdlib_pytest_engine_top_level_imports(self):
        allowed = {
            "__future__", "ast", "json", "math", "pathlib", "re",
            "dataclasses",
            "pytest",
            "engine",
        }
        imports = self._top_level_imports()
        unexpected = imports - allowed
        assert not unexpected, f"Unexpected top-level imports: {unexpected}"
