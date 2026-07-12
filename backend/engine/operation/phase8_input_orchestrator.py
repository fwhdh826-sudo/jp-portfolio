"""
phase8_input_orchestrator.py — compute-orchestration（実入力源配線の中核）
Operation 層: returns_doc を phase8_returns_resolver に通し、
returns_data / dd10_returns を Phase 8 producer 群へ DI して、
orchestrate_phase8_public_data が消費できる 9 DI package を
**assemble-only** で生成する。

責務:
  - assemble_phase8_public_data_inputs() — resolver + 4 producer を配線し
    producer raw + 補助 DI を集約して返す（write しない）

本モジュールの位置付け（重要）:
  既存 phase8_compute_orchestrator.py（thin batch、strict Flat-DI／
  imported ⊆ {__future__,pathlib,typing,backend}／compute 非 import を
  AST 自己 assert）は**変更しない**。本モジュールはその上流の
  「入力配線（producer-running）層」であり、resolver + 4 producer を
  import reuse する（producer 群と同様 compute import を持つ層）。

assemble-only（本 Card 範囲）:
  resolver → C/D/F/PF split producer を実行し、producer raw + 補助 DI を
  返すのみ。**orchestrate_phase8_public_data / caller / adapter / writer は
  呼ばない**。public/data には一切書かない（実 write は別 No-Go Card、
  P2-D2-actual で確定済）。実 write 連結は後続の public/data/phase8
  実 write Card。

Flat-DI dict-in:
  returns_doc は parsed dict を DI 受領（path read しない。data/returns.json
  の読込は将来の GHA / 上位 Card 責務）。各 producer DI（scores / pf_weights
  / current_pf / account_holdings 等）も DI 値 pass-through（捏造しない）。
  base_context は mutation しない（returns_data は新 merged context へ）。

missing-safe:
  returns_doc が None / 非 dict / returns 欠損 → resolver が missing-safe で
  returns_data={} を返し、C/D producer は Phase 7 fallback 方向へ degrade
  （frontier_index_raw=None）、dd10_returns=[] → F producer 側で DD10
  0.0 fallback。本層は捏造せず pass-through + diagnostic 透明化。

設計原則:
  - import は stdlib（typing）+ engine.operation の resolver + 4 producer のみ
  - 既存 phase8_compute_orchestrator.py / resolver / producer / caller /
    adapter / writer を import 改変しない（producer/resolver は import
    reuse のみ）
  - orchestrate_phase8_public_data / write_json_atomic / adapt_* を呼ばない
  - path read / open / Path / read_text 禁止
  - public/data 読み書き禁止 / public/data path literal 禁止 /
    data/returns 等のパス literal 禁止
  - datetime.now() / time.time() 不使用（決定論）
  - base_context / 入力 dict / list を mutation しない
  - 捏造しない（欠損は missing-safe degrade + diagnostic 透明化）
  - pandas / numpy / scipy を直接 import しない
    （scipy は producer 内部の FrontierStrategy 経由のみ）
  - 実 HTTP / API / LLM 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / approve / reject / conditional / rating 禁止
  - rebalance_order / buy_amount / sell_amount / shares / quantity 禁止
  - 全 diagnostics は "observation: " 接頭辞

P1 記録:
  P1-IO-1: assemble-only。resolver+4 producer 配線、write/orchestrate/
           caller/adapter/writer 非呼出。public/data 無変更。
  P1-IO-2: Flat-DI dict-in。returns_doc parsed dict、path read なし。
  P1-IO-3: returns_data は新 merged context へ（base_context 非 mutation）。
           C/D は context["returns_data"]、F は dd10_returns を受領。
  P1-IO-4: missing-safe（returns_doc 欠損 → resolver 経由で C/D Phase7 /
           F DD10 0.0 へ degrade）。捏造しない。
  P1-IO-5: 既存 phase8_compute_orchestrator.py / resolver / producer /
           caller / adapter / writer 無変更（import reuse のみ）。
  P1-IO-6: テストは test_integration（resolver+4 producer 横断、
           FrontierStrategy 経由 scipy。test_operation 非配置）。
  P1-IO-7: datetime.now()/time.time() 不使用。入力非 mutation。

P2/P3 記録（後続）:
  public/data/phase8 実 write Card: 本層出力 + orchestrate_phase8_public_data
    連結 + namespace/_meta.kind/rollback。
  P2-D5 系: update-data.yml に update_returns step + 実取得 CI。
  P2-D4: React UI 本配線。

Reference: backend/engine/operation/phase8_returns_resolver.py（resolver、無変更）
Reference: backend/engine/operation/phase8_compute_orchestrator.py（thin batch、無変更）
Reference: handover.md "compute-orchestration Card Readiness Review"
"""
from __future__ import annotations

from typing import Any

from engine.operation.phase8_analysis_producer import (
    produce_phase8_analysis_raw,
)
from engine.operation.phase8_compute_producer import (
    produce_frontier_index_raw,
)
from engine.operation.phase8_pf_split_producer import (
    produce_pf_split_raw,
)
from engine.operation.phase8_returns_resolver import (
    resolve_phase8_returns_di,
)
from engine.operation.phase8_strategy_aggregate_producer import (
    produce_strategy_aggregate_raw,
)


def _obs(msg: str) -> str:
    """observation 接頭辞付き diagnostic を返す。"""
    return f"observation: {msg}"


def assemble_phase8_public_data_inputs(
    *,
    returns_doc: Any = None,
    universe: Any,
    scores: Any,
    regime: str,
    horizon: str = "long_term",
    base_context: Any = None,
    pf_weights: Any = None,
    current_pf: Any = None,
    ideal_pf: Any = None,
    constrained_ideal_pf: Any = None,
    expected_return_by_ticker: Any = None,
    expected_vol: float = 0.0,
    sharpe_ratio: float = 0.0,
    account_holdings: Any = None,
    cash_weight: float = 0.0,
    equity_constrained_pf: Any = None,
    fund_pf: Any = None,
    regime_expected_returns: Any = None,
    regime_expected_vols: Any = None,
    regime_expected_max_dds: Any = None,
    regime_probabilities: Any = None,
    downside_z_score: Any = None,
    ticker_normalize: bool = True,
) -> dict:
    """
    returns_doc を resolver に通し returns_data / dd10_returns を
    Phase 8 producer 群へ DI して、orchestrate_phase8_public_data が
    消費できる 9 DI package を assemble-only で生成する。

    write / orchestrate_phase8_public_data / caller / adapter / writer は
    呼ばない（public/data 無変更）。base_context / 入力 dict は mutation
    しない。returns_doc 欠損は missing-safe degrade（捏造しない）。

    Returns:
        {
          "frontier_index_raw":     dict | None,
          "strategy_aggregate_raw": dict,
          "strategy_outputs":       dict,
          "opportunity_loss_raw":   dict,
          "future_branching_raw":   dict,
          "dd10_uniform_return":    float,
          "frontier_cash_pct":      float,
          "frontier_fund_pct":      float,
          "resolver_diagnostics":   list[str],
          "diagnostics":            list[str]（"observation: " 接頭辞）,
        }

    制約:
      - base_context / 入力 dict / list を mutation しない
      - BUY / SELL / HOLD / WAIT 判定を行わない
      - path read / public/data 読み書き / write しない
      - 実 HTTP / API / LLM 接続を行わない
    """
    diagnostics: list[str] = []

    # ── 1. resolver（Flat-DI、returns_doc parsed dict）────────────────────────
    resolver_output = resolve_phase8_returns_di(
        returns_doc,
        universe=universe,
        pf_weights=pf_weights,
        ticker_normalize=ticker_normalize,
    )
    returns_data = resolver_output.get("returns_data", {})
    dd10_returns = resolver_output.get("dd10_returns", [])
    resolver_diagnostics = list(resolver_output.get("diagnostics", []))

    if isinstance(returns_data, dict) and len(returns_data) > 0:
        diagnostics.append(_obs(
            f"resolver supplied returns_data for {len(returns_data)} ticker(s); "
            "frontier Phase 8 path expected"
        ))
    else:
        diagnostics.append(_obs(
            "resolver returns_data empty; C/D producers degrade to "
            "Phase 7 fallback (frontier_index_raw=None), missing-safe"
        ))
    if not (isinstance(dd10_returns, list) and len(dd10_returns) > 0):
        diagnostics.append(_obs(
            "resolver dd10_returns empty; F producer DD10 0.0 fallback, "
            "missing-safe"
        ))

    # ── 2. base_context へ returns_data を merge（base_context 非 mutation）──
    safe_base = base_context if isinstance(base_context, dict) else {}
    merged_context: dict = dict(safe_base)
    merged_context["returns_data"] = returns_data

    # ── 3. C producer（frontier_index_raw、cash/fund は PF split 供給）───────
    c_out = produce_frontier_index_raw(
        universe=universe,
        scores=scores,
        regime=regime,
        horizon=horizon,
        context=merged_context,
        frontier_cash_pct=0.0,
        frontier_fund_pct=0.0,
    )

    # ── 4. D producer（strategy_aggregate_raw / strategy_outputs）────────────
    d_out = produce_strategy_aggregate_raw(
        universe=universe,
        scores=scores,
        regime=regime,
        horizon=horizon,
        context=merged_context,
    )

    # ── 5. F producer（opportunity_loss / future_branching / dd10）──────────
    f_out = produce_phase8_analysis_raw(
        current_pf=current_pf,
        ideal_pf=ideal_pf,
        constrained_ideal_pf=constrained_ideal_pf,
        expected_return_by_ticker=expected_return_by_ticker,
        expected_vol=expected_vol,
        sharpe_ratio=sharpe_ratio,
        pf_weights=pf_weights,
        regime_expected_returns=regime_expected_returns,
        regime_expected_vols=regime_expected_vols,
        regime_expected_max_dds=regime_expected_max_dds,
        regime_probabilities=regime_probabilities,
        downside_z_score=downside_z_score,
        dd10_returns=dd10_returns,
        regime=regime,
        base_regime=regime,
        horizon=horizon,
        context=merged_context,
    )

    # ── 6. PF split producer（frontier_cash_pct / frontier_fund_pct）────────
    p_out = produce_pf_split_raw(
        account_holdings=account_holdings,
        cash_weight=cash_weight,
        equity_constrained_pf=equity_constrained_pf,
        fund_pf=fund_pf,
        regime=regime,
        context=merged_context,
    )

    diagnostics.append(_obs(
        "phase8 inputs assembled (resolver → C/D/F/PF split producers); "
        "assemble-only, producers run, nothing written, calculation-only"
    ))

    # ── 7. 9 DI package を返す（write/orchestrate は呼ばない）────────────────
    return {
        "frontier_index_raw":     c_out.get("frontier_index_raw"),
        "strategy_aggregate_raw": d_out.get("strategy_aggregate_raw"),
        "strategy_outputs":       d_out.get("strategy_outputs"),
        "opportunity_loss_raw":   f_out.get("opportunity_loss_raw"),
        "future_branching_raw":   f_out.get("future_branching_raw"),
        "dd10_uniform_return":    f_out.get("dd10_uniform_return"),
        "frontier_cash_pct":      p_out.get("frontier_cash_pct"),
        "frontier_fund_pct":      p_out.get("frontier_fund_pct"),
        "resolver_diagnostics":   resolver_diagnostics,
        "diagnostics":            diagnostics,
    }
