"""
phase8_compute_producer.py — P2-D3-compute-actual-1（Scope C）
Operation 層: 実 compute を回して Phase 8 frontier_index raw を生成する。

責務:
  - produce_frontier_index_raw() — FrontierStrategy.compute_with_frontier_index()
    を real compute で実行し frontier_index_raw（dict | None）を生成

本モジュールの位置付け（重要）:
  **compute import を許される唯一の Operation モジュール**。
  既存 Operation 層（phase8_compute_orchestrator / phase8_public_data_caller /
  phase8_presentation_adapter / phase8_json_writer）は Flat DI 設計で実 compute を
  一切 import しない不変条件を厳守してきた。本モジュールはその明示的例外として
  FrontierStrategy / StrategyInput のみを import し real compute を回す。
  それ以外の実 compute（他戦略・集約・DD-10% KPI・PF builder・機会損失・
  将来分岐）は import も呼び出しもしない（Scope C 範囲外、後続 Card）。

Scope C（本 Card 範囲、P1-D3ca1-1）:
  frontier_index_raw 生成のみ。frontier_cash_pct / frontier_fund_pct は
  DI passthrough（0.0 default、本 Card では計算しない）。public/data には
  一切書かない。orchestrator / caller / adapter / writer は import も変更もしない。

テスト配置（Q1 決定、P1-D3ca1-5）:
  real compute が scipy/SLSQP（EfficientFrontierOptimizer）を経由するため、
  本モジュールのテストは backend/tests/test_frontier/ に置く。
  backend/tests/test_operation/ には置かない（Operation 層 test の
  stdlib / Flat-DI / scipy 非依存原則を汚染しないため、意図的・文書化された
  例外配置）。

入力責務:
  universe / scores / regime / horizon / context は計算入力として
  StrategyInput へ読み取り専用で渡す（context は mutation しない）。
  frontier_cash_pct / frontier_fund_pct は観察/外部 DI の passthrough であり
  本 Card では計算しない（safe float + 0.0 以上 clamp のみ）。

設計原則:
  - import は stdlib（math / typing）+ engine.strategies.base_strategy.StrategyInput
    + engine.strategies.frontier_strategy.FrontierStrategy のみ
  - 実 compute は FrontierStrategy.compute_with_frontier_index() のみ
  - FrontierStrategy / StrategyInput 以外の実 compute モジュール
    （他戦略・集約・DD-10% KPI・PF builder・機会損失・将来分岐）は
    import も呼び出しもしない
  - orchestrator / caller / adapter / writer は import も変更もしない
  - context を mutation しない（読み取り専用で StrategyInput へ）
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
  P1-D3ca1-1: Scope C。frontier_index_raw 生成のみ。4戦略+集約は D、
              機会損失/将来分岐/DD-10% は E（別 Card）。
  P1-D3ca1-2: 実 compute は FrontierStrategy.compute_with_frontier_index()
              のみ。他 compute 非 import。
  P1-D3ca1-3: frontier_cash_pct / frontier_fund_pct は DI passthrough
              （safe float + 0.0 以上 clamp）。本 Card では計算しない。
  P1-D3ca1-4: public/data 非書き込み。hardcoded path / public/data path
              literal なし。datetime.now() / time.time() 不使用。
  P1-D3ca1-5: テストは test_frontier 配置（scipy 隔離）。test_operation 非配置。
  P1-D3ca1-6: orchestrator / caller / adapter / writer 無変更。

P2/P3 記録（後続）:
  D（compute-actual-2）: 4戦略 compute + 集約 raw 生成。
  E（compute-actual-3）: 機会損失 / 将来分岐 / DD-10% KPI raw 生成。
  PF split（別 Card）: frontier_cash_pct / frontier_fund_pct 実計算。
  P2-D2-actual: public/data/phase8 namespace ratify + 実 write。

Reference: backend/engine/strategies/frontier_strategy.py
           （compute_with_frontier_index, P3-Frontier-expose）
Reference: handover.md "P2-D3-compute-actual Readiness Review / サブCard分割方針"
"""
from __future__ import annotations

import math
from typing import Any

from engine.strategies.base_strategy import StrategyInput
from engine.strategies.frontier_strategy import FrontierStrategy

# FrontierIndex.to_dict() の確定 9 キー（観測診断専用。schema の真は
# frontier_strategy.py / FrontierIndex 側にあり、本モジュールは変更しない）。
_FRONTIER_INDEX_KEYS: tuple[str, ...] = (
    "index_name",
    "tickers",
    "weights",
    "expected_return",
    "expected_vol",
    "sharpe_ratio",
    "regime_used",
    "calculation_date",
    "diagnostics",
)


def _obs(msg: str) -> str:
    """observation 接頭辞付き diagnostic を返す。"""
    return f"observation: {msg}"


def _safe_pct(raw: Any) -> tuple[float, bool]:
    """
    pct 値を safe float + 0.0 以上 clamp で正規化する。

    Returns:
        (value, was_fallback)
          - None / 非数値 / NaN / inf / 負値 → (0.0, True)
          - 0.0 以上の有限 float            → (value, False)
    """
    if raw is None:
        return 0.0, True
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return 0.0, True
    if math.isnan(val) or math.isinf(val):
        return 0.0, True
    if val < 0.0:
        return 0.0, True
    return val, False


def produce_frontier_index_raw(
    *,
    universe: tuple[str, ...],
    scores: dict,
    regime: str,
    horizon: str = "long_term",
    context: dict | None = None,
    frontier_cash_pct: float = 0.0,
    frontier_fund_pct: float = 0.0,
) -> dict:
    """
    FrontierStrategy.compute_with_frontier_index() を real compute で実行し、
    Phase 8 経路の frontier_index_raw（dict | None）を生成する。

    context は mutation しない（StrategyInput へ読み取り専用で渡す。
    compute_with_frontier_index() は context を読み取り専用で扱う、
    P3-Frontier-expose / 既存 context-safety テストで担保）。

    経路:
      - context["returns_data"] が dict かつ len > 0（Phase 8）成功時:
        frontier_index_raw は確定 9 キー dict
      - returns_data 不在 / 非 dict / 空（Phase 7）: frontier_index_raw は None
      - empty universe: frontier_index_raw は None

    frontier_cash_pct / frontier_fund_pct は本 Card では計算せず、safe float +
    0.0 以上 clamp の上で passthrough する（PF split は別 Card）。

    Args:
        universe:           対象 ticker（StrategyInput が tuple 化・空除外）
        scores:             {ticker: {axis: {"total": float}}}（dict 以外は {} 扱い）
        regime:             市況レジーム文字列
        horizon:            投資時間軸（default "long_term"）
        context:            追加情報。returns_data 等のフラット名前空間。
                            None / 非 dict は {} 扱い。mutation しない
        frontier_cash_pct:  DI passthrough（safe + 0.0 clamp、計算しない）
        frontier_fund_pct:  DI passthrough（safe + 0.0 clamp、計算しない）

    Returns:
        {
          "strategy_output":    StrategyOutput.to_dict()（9 キー、JSON serializable）,
          "frontier_index_raw": dict（確定 9 キー）| None,
          "frontier_cash_pct":  float（safe + 0.0 clamp、passthrough）,
          "frontier_fund_pct":  float（同上）,
          "diagnostics":        list[str]（"observation: " 接頭辞、本層の観察）,
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

    cash_pct, cash_fallback = _safe_pct(frontier_cash_pct)
    fund_pct, fund_fallback = _safe_pct(frontier_fund_pct)
    diagnostics.append(_obs(
        "frontier_cash_pct/frontier_fund_pct are DI passthrough; "
        "PF split not computed in compute-actual-1 (Scope C)"
    ))
    if cash_fallback:
        diagnostics.append(_obs(
            "frontier_cash_pct invalid or negative; clamped to 0.0"
        ))
    if fund_fallback:
        diagnostics.append(_obs(
            "frontier_fund_pct invalid or negative; clamped to 0.0"
        ))

    strategy_input = StrategyInput(
        universe=safe_universe,
        scores=safe_scores,
        regime=safe_regime,
        horizon=safe_horizon,
        context=safe_context,
    )

    strategy_output, frontier_index_raw = (
        FrontierStrategy().compute_with_frontier_index(strategy_input)
    )

    if frontier_index_raw is None:
        if not safe_universe:
            diagnostics.append(_obs(
                "empty universe; frontier_index_raw is None "
                "(no Phase 8 index produced)"
            ))
        else:
            diagnostics.append(_obs(
                "Phase 7 path (no valid returns_data); "
                "frontier_index_raw is None"
            ))
    else:
        diagnostics.append(_obs(
            "Phase 8 path; frontier_index_raw produced via real compute "
            "(FrontierStrategy.compute_with_frontier_index)"
        ))
        missing = [
            k for k in _FRONTIER_INDEX_KEYS if k not in frontier_index_raw
        ]
        if missing:
            diagnostics.append(_obs(
                f"frontier_index_raw missing expected keys: {sorted(missing)}"
            ))

    return {
        "strategy_output":    strategy_output.to_dict(),
        "frontier_index_raw": frontier_index_raw,
        "frontier_cash_pct":  cash_pct,
        "frontier_fund_pct":  fund_pct,
        "diagnostics":        diagnostics,
    }
