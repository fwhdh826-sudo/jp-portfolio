"""
phase8_strategy_aggregate_producer.py — D: compute-actual-2
Operation 層: 実 compute を回して Phase 8 strategy_aggregate raw +
strategy_outputs 補助 DI を生成する。

責務:
  - produce_strategy_aggregate_raw() — 4 戦略 .compute() と
    StrategyAggregator.aggregate() を real compute で実行し
    strategy_aggregate_raw（10 キー）+ strategy_outputs（4×to_dict()）を生成

本モジュールの位置付け（重要）:
  **compute import を許される Operation producer 群の 2 つ目**。
  1 つ目は phase8_compute_producer.py（C: compute-actual-1、frontier_index_raw
  生成のみ）で、その AST 不変条件（engine import ⊆ {base_strategy,
  frontier_strategy}）と docstring 責務は本 Card で**温存する（無変更）**。
  本モジュールはその姉妹として 4 戦略 + StrategyAggregator を import し
  real compute を回す。既存 Operation 層（orchestrator / caller / adapter /
  writer）は Flat DI で実 compute を一切 import しない不変条件を引き続き厳守し、
  本モジュールはそれらを import も変更もしない。

Scope D（本 Card 範囲、P1-D2-1）:
  strategy_aggregate_raw + strategy_outputs 補助 DI 生成のみ。
  機会損失 / 将来分岐 / DD-10% KPI（E）、frontier_cash_pct /
  frontier_fund_pct / PF split（別 Card）、frontier_index_raw（C）は
  本 Card 範囲外。public/data には一切書かない。

テスト配置（Q1 決定、P1-D2-5）:
  D の主語は 4 戦略 + StrategyAggregator であり、strategy / aggregator 系
  テストの本拠が backend/tests/test_strategies/ であるため、本モジュールの
  テストは test_strategies に置く。real compute は FrontierStrategy Phase 8
  経由で scipy/SLSQP（EfficientFrontierOptimizer）を通過するが、
  backend/tests/test_operation/ には置かない（Operation 層 test の
  stdlib / Flat-DI / scipy 非依存原則を汚染しない、C precedent 継続）。

入力責務:
  universe / scores / regime / horizon / context は計算入力として
  4 戦略の StrategyInput へ読み取り専用で渡す（context / scores は
  mutation しない）。context["returns_data"] が dict かつ len>0 のとき
  frontier は Phase 8 経路（real compute、scipy）。

hybrid diagnostic（P2-A1 / P2-C5）の維持:
  StrategyAggregator.aggregate() は real frontier StrategyOutput の
  diagnostics に Phase 8 identifier が含まれる場合のみ hybrid metric /
  observed max_dd の観察 diagnostic を aggregate diagnostics に追加する
  （集約アルゴリズム・schema は無変更、aggregator.py 側の既存挙動）。
  本モジュールは 4 戦略を real compute するため、Phase 8 経路では
  当該 hybrid diagnostic が自動的に維持される。

設計原則:
  - import は stdlib（typing）+ engine.strategies の
    StrategyInput / StrategyAggregator / FrontierStrategy /
    QualitySizeStrategy / FundamentalWeightedStrategy /
    CrossFactorStrategy のみ
  - 実 compute は 4 戦略 .compute() と StrategyAggregator.aggregate() のみ
  - StrategyAggregator.aggregate() には dict[str, StrategyOutput] の
    **インスタンス**を渡す（dict 化前の StrategyOutput を保持）
  - 機会損失 / 将来分岐 / DD-10% KPI / PF builder の compute は
    import も呼び出しもしない（Scope D 範囲外）
  - phase8_compute_producer.py / orchestrator / caller / adapter / writer は
    import も変更もしない
  - context / scores を mutation しない（読み取り専用）
  - public/data 書き込み禁止 / hardcoded path 禁止 / public/data path literal 禁止
  - datetime.now() / time.time() 不使用
  - pandas / numpy / scipy を直接 import しない
    （scipy は FrontierStrategy 経由で EfficientFrontierOptimizer に閉じ込め）
  - 実 HTTP / API / LLM 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / approve / reject / conditional / rating 禁止
  - rebalance_order / buy_amount / sell_amount / shares / quantity 禁止
  - 全 diagnostics は "observation: " 接頭辞

P1 記録:
  P1-D2-1: Scope D。strategy_aggregate_raw + strategy_outputs 生成のみ。
  P1-D2-2: 実 compute は 4 戦略 .compute() + aggregate() のみ。機会損失 /
           将来分岐 / DD-10% / PF builder 非 import。
  P1-D2-3: aggregate() には StrategyOutput インスタンスを渡す
           （dict 化前保持）。strategy_outputs は {sid: .to_dict()} で返す。
  P1-D2-4: public/data 非書き込み。hardcoded path / public/data path literal
           なし。datetime.now() / time.time() 不使用。
  P1-D2-5: テストは test_strategies 配置。test_operation 非配置。
  P1-D2-6: phase8_compute_producer.py（C）/ orchestrator / caller / adapter /
           writer 無変更。
  P1-D2-7: P2-A1 / P2-C5 hybrid diagnostic は real frontier output 経由で
           維持（aggregator.py 側既存挙動、本モジュールは関与しない）。

P2/P3 記録（後続）:
  E（compute-actual-3）: 機会損失 / 将来分岐 / DD-10% KPI raw 生成（scipy なし）。
  PF split（別 Card）: frontier_cash_pct / frontier_fund_pct 実計算。
  P2-D2-actual: public/data/phase8 namespace ratify + 実 write。

Reference: backend/engine/strategies/aggregator.py（StrategyAggregator.aggregate /
           P2-A1 / P2-C5 hybrid diagnostic）
Reference: backend/engine/operation/phase8_compute_producer.py（C、無変更）
Reference: handover.md "D: compute-actual-2 Readiness Review / 方針記録"
"""
from __future__ import annotations

from typing import Any

from engine.strategies.aggregator import StrategyAggregator
from engine.strategies.base_strategy import StrategyInput
from engine.strategies.cross_factor_strategy import CrossFactorStrategy
from engine.strategies.frontier_strategy import FrontierStrategy
from engine.strategies.fundamental_weighted_strategy import (
    FundamentalWeightedStrategy,
)
from engine.strategies.quality_size_strategy import QualitySizeStrategy

# StrategyAggregateResult.to_dict() の確定 10 キー（観測診断専用。schema の
# 真は aggregator.py 側にあり、本モジュールは aggregator を変更しない）。
_STRATEGY_AGGREGATE_KEYS: tuple[str, ...] = (
    "aggregated_ideal_pf",
    "expected_return",
    "expected_vol",
    "sharpe_ratio",
    "max_dd_estimate",
    "weights_used",
    "regime",
    "strategy_correlations",
    "diversification_score",
    "diagnostics",
)

# 4 戦略 strategy_id（VALID_STRATEGY_IDS / CANONICAL_STRATEGIES と整合。
# aggregate() は strategy_id を検証するため固定キーで構築する）。
_STRATEGY_ID_FRONTIER:     str = "frontier"
_STRATEGY_ID_QUALITY_SIZE: str = "quality_size"
_STRATEGY_ID_FUNDAMENTAL:  str = "fundamental"
_STRATEGY_ID_CROSS_FACTOR: str = "cross_factor"


def _obs(msg: str) -> str:
    """observation 接頭辞付き diagnostic を返す。"""
    return f"observation: {msg}"


def produce_strategy_aggregate_raw(
    *,
    universe: tuple[str, ...],
    scores: dict,
    regime: str,
    horizon: str = "long_term",
    context: dict | None = None,
) -> dict:
    """
    4 戦略 .compute() と StrategyAggregator.aggregate() を real compute で
    実行し、strategy_aggregate_raw（10 キー）と strategy_outputs 補助 DI
    （4 戦略の .to_dict()）を生成する。

    aggregate() には dict 化前の StrategyOutput **インスタンス**を渡す
    （aggregate() が isinstance 検証するため）。strategy_outputs は別途
    .to_dict() して JSON serializable な補助 DI として返す。

    context / scores は mutation しない（読み取り専用で StrategyInput /
    aggregate() へ）。context["returns_data"] が dict かつ len>0 のとき
    frontier は Phase 8 経路（real compute、scipy/SLSQP 通過）。
    Phase 8 経路では P2-A1 / P2-C5 hybrid diagnostic が aggregate
    diagnostics に自動的に維持される（aggregator.py 側の既存挙動）。

    Args:
        universe:  対象 ticker（StrategyInput が tuple 化・空除外）
        scores:    {ticker: {axis: {"total": float}}}（dict 以外は {} 扱い）
        regime:    市況レジーム文字列
        horizon:   投資時間軸（default "long_term"）
        context:   追加情報。returns_data 等のフラット名前空間。
                   None / 非 dict は {} 扱い。mutation しない

    Returns:
        {
          "strategy_aggregate_raw": StrategyAggregateResult.to_dict()（10 キー）,
          "strategy_outputs": {
              "frontier":     StrategyOutput.to_dict(),
              "quality_size": StrategyOutput.to_dict(),
              "fundamental":  StrategyOutput.to_dict(),
              "cross_factor": StrategyOutput.to_dict(),
          },
          "regime":      str,
          "diagnostics": list[str]（"observation: " 接頭辞、本層の観察）,
        }

    制約:
      - context / scores を mutation しない
      - BUY / SELL / HOLD / WAIT 判定を行わない
      - public/data へ書き込まない
      - 実 HTTP / API / LLM 接続を行わない
    """
    diagnostics: list[str] = []

    safe_universe = (
        tuple(universe) if isinstance(universe, (tuple, list)) else ()
    )
    safe_scores = scores if isinstance(scores, dict) else {}
    safe_regime = regime if isinstance(regime, str) and regime else ""
    safe_horizon = (
        horizon if isinstance(horizon, str) and horizon else "long_term"
    )
    safe_context = context if isinstance(context, dict) else {}

    strategy_input = StrategyInput(
        universe=safe_universe,
        scores=safe_scores,
        regime=safe_regime,
        horizon=safe_horizon,
        context=safe_context,
    )

    # ── 4 戦略 real compute（StrategyOutput インスタンスを保持）──────────────
    strategies: tuple[tuple[str, Any], ...] = (
        (_STRATEGY_ID_FRONTIER,     FrontierStrategy()),
        (_STRATEGY_ID_QUALITY_SIZE, QualitySizeStrategy()),
        (_STRATEGY_ID_FUNDAMENTAL,  FundamentalWeightedStrategy()),
        (_STRATEGY_ID_CROSS_FACTOR, CrossFactorStrategy()),
    )
    output_instances: dict[str, Any] = {}
    for sid, strat in strategies:
        output_instances[sid] = strat.compute(strategy_input)

    # ── 経路 diagnostic（観測のみ）──────────────────────────────────────────
    returns_data = safe_context.get("returns_data")
    if not safe_universe:
        diagnostics.append(_obs(
            "empty universe; strategies computed with empty allocation"
        ))
    elif isinstance(returns_data, dict) and len(returns_data) > 0:
        diagnostics.append(_obs(
            "frontier on Phase 8 path (returns_data provided); "
            "real compute — hybrid diagnostic maintained by aggregator"
        ))
    else:
        diagnostics.append(_obs(
            "frontier on Phase 7 fallback (no valid returns_data)"
        ))

    # ── StrategyAggregator.aggregate()（インスタンスを渡す）─────────────────
    aggregate_result = StrategyAggregator().aggregate(
        output_instances, safe_regime, safe_context
    )
    strategy_aggregate_raw = aggregate_result.to_dict()

    # ── strategy_outputs 補助 DI（dict 化、JSON serializable）───────────────
    strategy_outputs = {
        sid: out.to_dict() for sid, out in output_instances.items()
    }

    diagnostics.append(_obs(
        "strategy_aggregate produced via real compute "
        "(4 strategies + StrategyAggregator.aggregate)"
    ))
    missing = [
        k for k in _STRATEGY_AGGREGATE_KEYS if k not in strategy_aggregate_raw
    ]
    if missing:
        diagnostics.append(_obs(
            f"strategy_aggregate_raw missing expected keys: {sorted(missing)}"
        ))

    return {
        "strategy_aggregate_raw": strategy_aggregate_raw,
        "strategy_outputs":       strategy_outputs,
        "regime":                 safe_regime,
        "diagnostics":            diagnostics,
    }
