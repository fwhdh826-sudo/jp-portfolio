"""
phase8_analysis_producer.py — F: compute-actual-3
Operation 層: 実 calculator を外部 DI 値で実行し Phase 8 分析 raw を生成する。

責務:
  - produce_phase8_analysis_raw() — OpportunityLossCalculator /
    FutureBranchingCalculator / DD10Calculator を外部 DI 値で実行し
    opportunity_loss_raw（8 キー）/ future_branching_raw（8 キー）/
    dd10_uniform_return（float のみ）を生成

本モジュールの位置付け（重要）:
  **compute-importing producer 群の 3 つ目**。
  1=phase8_compute_producer.py（C、frontier_index_raw）/
  2=phase8_strategy_aggregate_producer.py（D、strategy_aggregate_raw +
  strategy_outputs）。両者は本 Card で**無変更**（AST 不変条件・docstring
  責務を温存）。本モジュールはその姉妹として 3 calculator のみを import し
  外部 DI 値で実行する。既存 Operation 層（orchestrator / caller / adapter /
  writer）は Flat DI で実 compute を一切 import しない不変条件を引き続き
  厳守し、本モジュールはそれらを import も変更もしない。

Scope F（本 Card 範囲、P1-F-1）:
  opportunity_loss_raw / future_branching_raw / dd10_uniform_return 生成のみ。
  PF split / frontier_cash_pct / frontier_fund_pct（別 Card）、
  frontier_index_raw（C）、strategy_aggregate_raw / strategy_outputs（D）、
  public/data write（P2-D2-actual）は本 Card 範囲外。

テスト配置（Q1 決定、P1-F-5）:
  本モジュールのテストは backend/tests/test_frontier/ に置く。
  backend/tests/test_operation/ には置かない。理由:
  F は scipy 非依存だが compute（3 calculator）を**呼ぶ** producer であり、
  test_operation 群の「compute 非呼出 / Flat-DI」思想を維持するため。
  OpportunityLoss / FutureBranching は engine.frontier 側であり、C も
  test_frontier 配置（compute-importing producer 群慣習：
  C→test_frontier / D→test_strategies / F→test_frontier）。

入力責務:
  current_pf / ideal_pf / constrained_ideal_pf / expected_return_by_ticker /
  pf_weights / regime_expected_returns / regime_expected_vols /
  regime_expected_max_dds / regime_probabilities は全て外部/参照 DI。
  dd10_returns は観察系列 DI。本モジュールはこれらを計算も捏造もしない
  （C/D 出力からの自動導出もしない）。missing / 非 dict / 無効入力は
  各 calculator の安全 default に委譲しつつ observation diagnostic で
  透明化する（捏造禁止、C の cash/fund passthrough と同思想）。

設計原則:
  - import は stdlib（typing）+ engine の 3 calculator のみ:
    OpportunityLossCalculator / OpportunityLossInput /
    FutureBranchingCalculator / FutureBranchingInput / DD10Calculator
  - 実 compute は上記 3 calculator のみ。戦略 compute / 集約 / 最適化 /
    PF builder は import も呼び出しもしない
  - phase8_compute_producer.py（C）/ phase8_strategy_aggregate_producer.py
    （D）/ orchestrator / caller / adapter / writer は import も変更もしない
  - context / 入力 dict を mutation しない（読み取り専用）
  - public/data 書き込み禁止 / hardcoded path 禁止 / public/data path literal 禁止
  - datetime.now() / time.time() 不使用
  - pandas / numpy / scipy を直接 import しない
    （3 calculator は pure stdlib、本モジュールも scipy 非依存）
  - 実 HTTP / API / LLM 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / approve / reject / conditional / rating 禁止
  - rebalance_order / buy_amount / sell_amount / shares / quantity 禁止
  - 全 diagnostics は "observation: " 接頭辞

P1 記録:
  P1-F-1: Scope F。opportunity_loss_raw / future_branching_raw /
          dd10_uniform_return 生成のみ。PF split / public/data は範囲外。
  P1-F-2: 実 compute は 3 calculator のみ。戦略 / 集約 / PF builder 非 import。
  P1-F-3: 入力は全て外部/観察/参照 DI。捏造しない。C/D 出力からの自動導出
          もしない。missing → 安全 default + observation diagnostic。
  P1-F-4: public/data 非書き込み。hardcoded path / public/data path literal
          なし。datetime.now() / time.time() 不使用。
  P1-F-5: テストは test_frontier 配置。test_operation 非配置。
  P1-F-6: C/D producer / orchestrator / caller / adapter / writer 無変更。
  P1-F-7: dd10_returns 不足 / 無効 → dd10_uniform_return は 0.0 fallback +
          observation diagnostic。

P2/P3 記録（後続）:
  PF split（別 Card）: frontier_cash_pct / frontier_fund_pct 実計算。
  P2-D2-actual: public/data/phase8 namespace ratify + 実 write。
  E 完了で orchestrator の 9 DI が全て producer 側で揃う
  （C: frontier_index、D: strategy_aggregate / strategy_outputs、
   F: opportunity_loss / future_branching / dd10_uniform_return）。

Reference: backend/engine/frontier/opportunity_loss_calc.py
Reference: backend/engine/frontier/future_branching.py
Reference: backend/engine/decision/dd10_kpi.py
Reference: handover.md "E: compute-actual-3 Readiness Review / 方針記録"
"""
from __future__ import annotations

from typing import Any

from engine.decision.dd10_kpi import DD10Calculator
from engine.frontier.future_branching import (
    FutureBranchingCalculator,
    FutureBranchingInput,
)
from engine.frontier.opportunity_loss_calc import (
    OpportunityLossCalculator,
    OpportunityLossInput,
)

# OpportunityLossResult.to_dict() / FutureBranchingResult.to_dict() の確定キー
# （観測診断専用。schema の真は各 calculator 側にあり、本モジュールは変更しない）。
_OPPORTUNITY_LOSS_KEYS: tuple[str, ...] = (
    "weight_drift_per_ticker",
    "total_drift_l1",
    "total_drift_l2",
    "constraint_return_gap",
    "drift_return_gap",
    "estimated_opportunity_return_gap",
    "regime_used",
    "diagnostics",
)
_FUTURE_BRANCHING_KEYS: tuple[str, ...] = (
    "branches",
    "base_regime",
    "weighted_expected_return",
    "weighted_expected_vol",
    "worst_case_dd",
    "worst_case_downside",
    "best_case_upside",
    "diagnostics",
)


def _obs(msg: str) -> str:
    """observation 接頭辞付き diagnostic を返す。"""
    return f"observation: {msg}"


def _coerce_returns(raw: Any) -> tuple[list[float], bool]:
    """
    dd10_returns を float 系列へ coerce する。

    Returns:
        (returns, was_invalid)
          - 非 list/tuple / 数値要素ゼロ → ([], True)
          - 数値要素あり                 → ([float, ...], False)
        bool は数値扱いしない（True/False を 1.0/0.0 と誤認しない）。
    """
    if not isinstance(raw, (list, tuple)):
        return [], True
    out: list[float] = []
    for x in raw:
        if isinstance(x, bool):
            continue
        if isinstance(x, (int, float)):
            out.append(float(x))
    if not out:
        return [], True
    return out, False


def produce_phase8_analysis_raw(
    *,
    current_pf: dict | None = None,
    ideal_pf: dict | None = None,
    constrained_ideal_pf: dict | None = None,
    expected_return_by_ticker: dict | None = None,
    expected_vol: float = 0.0,
    sharpe_ratio: float = 0.0,
    pf_weights: dict | None = None,
    regime_expected_returns: dict | None = None,
    regime_expected_vols: dict | None = None,
    regime_expected_max_dds: dict | None = None,
    regime_probabilities: dict | None = None,
    downside_z_score: float | None = None,
    dd10_returns: list | None = None,
    regime: str,
    base_regime: str | None = None,
    horizon: str = "long_term",
    context: dict | None = None,
) -> dict:
    """
    3 calculator を外部 DI 値で実行し Phase 8 分析 raw を生成する。

    OpportunityLossCalculator / FutureBranchingCalculator を各 Input dataclass
    経由で呼び .to_dict()（各 8 キー）を返す。DD10Calculator.compute() からは
    .dd10_uniform_return（float）のみ取り出す（to_dict 全体は返さない）。

    入力は全て外部/観察/参照 DI。本モジュールは計算も捏造もしない
    （C/D 出力からの自動導出もしない）。missing / 非 dict / 無効入力は
    各 calculator の安全 default に委譲しつつ observation diagnostic で
    透明化する。context / 入力 dict は mutation しない。

    Args:
        current_pf / ideal_pf / constrained_ideal_pf /
        expected_return_by_ticker:        opportunity_loss 用 外部 DI（dict）
        expected_vol / sharpe_ratio:      opportunity_loss 用 外部 DI（float）
        pf_weights:                       future_branching 用 外部 DI（dict）
        regime_expected_returns /
        regime_expected_vols /
        regime_expected_max_dds /
        regime_probabilities:             future_branching 用 参照テーブル DI
                                          （regime_expected_max_dds は
                                          FutureBranchingInput.regime_max_dds
                                          へマップ）
        downside_z_score:                 future_branching 用 DI（None →
                                          calculator default）
        dd10_returns:                     DD10 用 観察系列 DI（list[float]）
        regime:                           市況レジーム文字列（必須）
        base_regime:                      future_branching 用（None → regime）
        horizon:                          投資時間軸（default "long_term"）
        context:                          追加情報。None / 非 dict は {} 扱い。
                                          mutation しない

    Returns:
        {
          "opportunity_loss_raw": OpportunityLossResult.to_dict()（8 キー）,
          "future_branching_raw": FutureBranchingResult.to_dict()（8 キー）,
          "dd10_uniform_return":  float,
          "regime":               str,
          "diagnostics":          list[str]（"observation: " 接頭辞）,
        }

    制約:
      - context / 入力 dict を mutation しない
      - BUY / SELL / HOLD / WAIT 判定を行わない
      - public/data へ書き込まない
      - 実 HTTP / API / LLM 接続を行わない
    """
    diagnostics: list[str] = []

    safe_regime = regime if isinstance(regime, str) and regime else ""
    safe_base_regime = (
        base_regime
        if isinstance(base_regime, str) and base_regime
        else safe_regime
    )
    safe_horizon = (
        horizon if isinstance(horizon, str) and horizon else "long_term"
    )
    safe_context = context if isinstance(context, dict) else {}

    # ── missing input 透明化（捏造せず safe default + observation diag）─────
    _di_dicts = (
        ("current_pf", current_pf),
        ("ideal_pf", ideal_pf),
        ("constrained_ideal_pf", constrained_ideal_pf),
        ("expected_return_by_ticker", expected_return_by_ticker),
        ("pf_weights", pf_weights),
        ("regime_expected_returns", regime_expected_returns),
        ("regime_expected_vols", regime_expected_vols),
        ("regime_expected_max_dds", regime_expected_max_dds),
        ("regime_probabilities", regime_probabilities),
    )
    for name, value in _di_dicts:
        if not isinstance(value, dict):
            diagnostics.append(_obs(
                f"{name} not provided as dict; treated as empty "
                "(external/observed DI absent, not fabricated)"
            ))

    # ── OpportunityLoss（外部 DI、捏造しない）──────────────────────────────
    ol_input = OpportunityLossInput(
        current_pf=current_pf if isinstance(current_pf, dict) else {},
        ideal_pf=ideal_pf if isinstance(ideal_pf, dict) else {},
        constrained_ideal_pf=(
            constrained_ideal_pf
            if isinstance(constrained_ideal_pf, dict)
            else {}
        ),
        expected_return_by_ticker=(
            expected_return_by_ticker
            if isinstance(expected_return_by_ticker, dict)
            else {}
        ),
        expected_vol=expected_vol,
        sharpe_ratio=sharpe_ratio,
        regime=safe_regime,
        context=safe_context,
    )
    opportunity_loss_raw = (
        OpportunityLossCalculator().calculate(ol_input).to_dict()
    )

    # ── FutureBranching（regime_expected_max_dds → regime_max_dds マップ）──
    fb_kwargs: dict[str, Any] = dict(
        pf_weights=pf_weights if isinstance(pf_weights, dict) else {},
        base_regime=safe_base_regime,
        regime_expected_returns=(
            regime_expected_returns
            if isinstance(regime_expected_returns, dict)
            else {}
        ),
        regime_expected_vols=(
            regime_expected_vols
            if isinstance(regime_expected_vols, dict)
            else {}
        ),
        regime_max_dds=(
            regime_expected_max_dds
            if isinstance(regime_expected_max_dds, dict)
            else {}
        ),
        regime_probabilities=(
            regime_probabilities
            if isinstance(regime_probabilities, dict)
            else {}
        ),
        horizon=safe_horizon,
        context=safe_context,
    )
    if downside_z_score is not None:
        fb_kwargs["downside_z_score"] = downside_z_score
    fb_input = FutureBranchingInput(**fb_kwargs)
    future_branching_raw = (
        FutureBranchingCalculator().calculate(fb_input).to_dict()
    )

    # ── DD10（.dd10_uniform_return float のみ抽出）──────────────────────────
    returns_list, dd10_invalid = _coerce_returns(dd10_returns)
    dd10_result = DD10Calculator().compute(returns_list)
    dd10_uniform_return = float(dd10_result.dd10_uniform_return)
    if dd10_invalid:
        diagnostics.append(_obs(
            "dd10_returns missing/invalid/empty; "
            "dd10_uniform_return is 0.0 fallback"
        ))
    elif not dd10_result.is_drawdown_defined:
        diagnostics.append(_obs(
            "dd10_returns has no valid samples after filtering; "
            "dd10_uniform_return is 0.0 fallback"
        ))

    diagnostics.append(_obs(
        "phase8 analysis produced via real calculators "
        "(OpportunityLoss / FutureBranching / DD10); DI inputs only, "
        "no strategy/aggregate/optimizer compute"
    ))
    ol_missing = [
        k for k in _OPPORTUNITY_LOSS_KEYS if k not in opportunity_loss_raw
    ]
    if ol_missing:
        diagnostics.append(_obs(
            f"opportunity_loss_raw missing expected keys: {sorted(ol_missing)}"
        ))
    fb_missing = [
        k for k in _FUTURE_BRANCHING_KEYS if k not in future_branching_raw
    ]
    if fb_missing:
        diagnostics.append(_obs(
            f"future_branching_raw missing expected keys: {sorted(fb_missing)}"
        ))

    return {
        "opportunity_loss_raw": opportunity_loss_raw,
        "future_branching_raw": future_branching_raw,
        "dd10_uniform_return":  dd10_uniform_return,
        "regime":               safe_regime,
        "diagnostics":          diagnostics,
    }
