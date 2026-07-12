"""
phase8_pf_split_producer.py — PF split（compute-actual 系の最終 DI ギャップ）
Operation 層: 既存 UnifiedViewBuilder を外部 DI 値で実行し
frontier_cash_pct / frontier_fund_pct / total_equity_weight を実値化する。

責務:
  - produce_pf_split_raw() — account_holdings + cash_weight 外部 DI を
    UnifiedViewBuilder に渡し、UnifiedViewResult.total_cash_weight /
    total_fund_weight / total_equity_weight を抽出して返す

本モジュールの位置付け（重要）:
  **compute-importing producer 群の 4 つ目**。
  1=phase8_compute_producer.py（C、frontier_index_raw）/
  2=phase8_strategy_aggregate_producer.py（D、strategy_aggregate_raw +
  strategy_outputs）/ 3=phase8_analysis_producer.py（F、opportunity_loss_raw /
  future_branching_raw / dd10_uniform_return）。3 者は本 Card で**無変更**
  （AST 不変条件・docstring 責務を温存）。本モジュールはその姉妹として
  UnifiedViewBuilder のみを import reuse する。既存 Operation 層
  （orchestrator / caller / adapter / writer）は Flat DI で実 compute を
  一切 import しない不変条件を引き続き厳守し、本モジュールはそれらを
  import も変更もしない。

Scope（本 Card 範囲、P1-PFS-1）:
  frontier_cash_pct / frontier_fund_pct / total_equity_weight 生成のみ。
  これは P2-D2-actual（public/data 実 write）前に C producer が現在
  0.0 passthrough で空けている最後の主要 DI ギャップを埋める作業。
  public/data には一切書かない。

UnifiedViewBuilder のみ（P1-PFS-2）:
  JpEquityPfBuilder / FundPfBuilder は使わない。cash/fund split は
  account_holdings + cash_weight DI のみから UnifiedViewBuilder が算出し、
  equity_constrained_pf / fund_pf は pass-through で cash/fund に影響しない。
  Strategy / Aggregator / Frontier / Decision / C/D/F producer は
  import も呼び出しもしない。

テスト配置（Q1 決定、P1-PFS-5）:
  本モジュールのテストは backend/tests/test_portfolio/ に置く。
  UnifiedViewBuilder は engine.portfolio 配下であり PF split の主語が
  portfolio であるため。backend/tests/test_operation/ には置かない
  （compute-importing producer 群を test_operation 外に保つ慣習：
  C→test_frontier / D→test_strategies / F→test_frontier /
  PF split→test_portfolio）。

入力責務（P1-PFS-3）:
  account_holdings / cash_weight は外部/観察 DI。本モジュールは計算も
  捏造もしない。asset_class 分類は producer が行わない（P2-7V、DI 側が
  付与）。未知 asset_class は UnifiedView 側の "unclassified" 集計 +
  diagnostic に委譲。missing account_holdings → 空 tuple + observation
  diagnostic。missing / invalid / 負 cash_weight → 0.0 + observation
  diagnostic（0.0 default 温存、捏造禁止）。

semantics（P1-PFS-4）:
  frontier_cash_pct / frontier_fund_pct は **frontier_index 由来ではない**。
  観察 PF（6 口座 holdings）基準の現金 / 投信配分であり
  calculation-only / observation-only、注文・推奨ではない
  （frontier equity index と併記される観察上の配分）。
  なお total_cash_weight は cash_weight DI の pass-through であり、
  account_holdings 内の asset_class="cash" 保有は asset_class 集計には
  入るが total_cash_weight には合算されない（UnifiedView 既存仕様）。

設計原則:
  - import は stdlib（math / typing）+ engine.portfolio.unified_view の
    UnifiedViewBuilder / UnifiedViewInput / AccountHoldingInfo のみ
  - JpEquityPfBuilder / FundPfBuilder / Strategy / Aggregator / Frontier /
    Decision / C/D/F producer を import も呼び出しもしない
  - orchestrator / caller / adapter / writer は import も変更もしない
  - context / 入力 dict / list を mutation しない（読み取り専用）
  - public/data 書き込み禁止 / hardcoded path 禁止 / public/data path literal 禁止
  - datetime.now() / time.time() 不使用
  - pandas / numpy / scipy を直接 import しない
    （UnifiedView は math stdlib のみ、本モジュールも非依存）
  - 実 HTTP / API / LLM 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / approve / reject / conditional / rating 禁止
  - rebalance_order / buy_amount / sell_amount / shares / quantity 禁止
  - 全 diagnostics は "observation: " 接頭辞

P1 記録:
  P1-PFS-1: Scope。cash/fund/equity weight 生成のみ。public/data 範囲外。
  P1-PFS-2: UnifiedViewBuilder のみ。JpEquity/Fund builder・戦略・集約・
            frontier・decision・C/D/F producer 非 import。
  P1-PFS-3: 入力は外部/観察 DI。捏造しない。asset_class 分類しない（P2-7V）。
            missing → 0.0 / 空 + observation diagnostic。
  P1-PFS-4: semantics — 観察 PF 基準、frontier_index 由来でない、
            calculation/observation-only、注文でない。
  P1-PFS-5: テストは test_portfolio 配置。test_operation 非配置。
  P1-PFS-6: UnifiedView / C/D/F producer / orchestrator / caller / adapter /
            writer 無変更。
  P1-PFS-7: public/data 非書き込み。datetime.now()/time.time() 不使用。

P2/P3 記録（後続）:
  P2-D2-actual: 本 Card 完了で orchestrator の 9 DI が全て実値化。
                public/data/phase8 namespace ratify + rollback / stale /
                schema-version / UI-consumer 整備 + 実 write。

Reference: backend/engine/portfolio/unified_view.py（UnifiedViewBuilder、無変更）
Reference: handover.md "PF split 別Card Readiness Review / 方針記録"
"""
from __future__ import annotations

import math
from typing import Any

from engine.portfolio.unified_view import (
    AccountHoldingInfo,
    UnifiedViewBuilder,
    UnifiedViewInput,
)


def _obs(msg: str) -> str:
    """observation 接頭辞付き diagnostic を返す。"""
    return f"observation: {msg}"


def _safe_cash(raw: Any) -> tuple[float, bool]:
    """
    cash_weight を safe float + 0.0 以上 clamp で正規化する。

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


def _coerce_pf_pairs(raw: Any) -> tuple[tuple[str, float], ...]:
    """
    equity_constrained_pf / fund_pf を (str, float) ペア tuple へ coerce する
    （pass-through 専用、cash/fund 算出には影響しない）。

    None / 非対応型 → ()。dict → items。list/tuple → 各ペア。
    """
    if isinstance(raw, dict):
        items = raw.items()
    elif isinstance(raw, (list, tuple)):
        items = raw
    else:
        return ()
    out: list[tuple[str, float]] = []
    for pair in items:
        if isinstance(pair, (list, tuple)) and len(pair) == 2:
            ticker, weight = pair
            try:
                out.append((str(ticker), float(weight)))
            except (TypeError, ValueError):
                continue
    return tuple(out)


def produce_pf_split_raw(
    *,
    account_holdings: list | None = None,
    cash_weight: float = 0.0,
    equity_constrained_pf: Any = None,
    fund_pf: Any = None,
    regime: str,
    context: dict | None = None,
) -> dict:
    """
    UnifiedViewBuilder を外部 DI 値で実行し PF split 観察値を生成する。

    frontier_cash_pct = UnifiedViewResult.total_cash_weight
    frontier_fund_pct = UnifiedViewResult.total_fund_weight
    total_equity_weight = UnifiedViewResult.total_equity_weight

    入力は全て外部/観察 DI。本モジュールは計算も捏造もしない。
    asset_class 分類は行わない（DI、P2-7V）。missing / invalid は
    safe default + observation diagnostic で透明化。
    context / 入力 dict / list は mutation しない。

    Args:
        account_holdings:       list[dict]。各 dict は account_id /
                                ticker_or_code / current_weight /
                                asset_class を DI で持つ前提（観察値）。
                                None / 非 list → 空 + observation diagnostic
        cash_weight:            観察現金比率 DI。safe float + 0.0 以上 clamp
        equity_constrained_pf:  pass-through（cash/fund に不影響、任意）
        fund_pf:                pass-through（同上）
        regime:                 市況レジーム文字列（必須）
        context:                追加情報。None / 非 dict は {} 扱い。
                                mutation しない

    Returns:
        {
          "frontier_cash_pct":   float（= total_cash_weight）,
          "frontier_fund_pct":   float（= total_fund_weight）,
          "total_equity_weight": float（参考・観察）,
          "regime":              str,
          "diagnostics":         list[str]（"observation: " 接頭辞）,
        }

    制約:
      - context / 入力 dict / list を mutation しない
      - BUY / SELL / HOLD / WAIT 判定を行わない
      - public/data へ書き込まない
      - 実 HTTP / API / LLM 接続を行わない
    """
    diagnostics: list[str] = []

    safe_regime = regime if isinstance(regime, str) and regime else ""
    safe_context = context if isinstance(context, dict) else {}

    # ── semantics（常時、観察 PF 基準であることを明示）──────────────────────
    diagnostics.append(_obs(
        "frontier_cash_pct/frontier_fund_pct are observed portfolio split "
        "(6-account holdings basis), not frontier index output; "
        "calculation-only/observation-only, not an order"
    ))

    # ── cash_weight（safe + 0.0 clamp、捏造しない）─────────────────────────
    safe_cw, cw_fallback = _safe_cash(cash_weight)
    if cw_fallback:
        diagnostics.append(_obs(
            "cash_weight missing/invalid/negative; treated as 0.0 "
            "(observed input, not fabricated)"
        ))

    # ── account_holdings → AccountHoldingInfo tuple（分類しない）───────────
    holdings: list[AccountHoldingInfo] = []
    if not isinstance(account_holdings, (list, tuple)):
        diagnostics.append(_obs(
            "account_holdings not provided as list; treated as empty "
            "(observed holdings absent, not fabricated)"
        ))
    else:
        skipped = 0
        for entry in account_holdings:
            if not isinstance(entry, dict):
                skipped += 1
                continue
            holdings.append(AccountHoldingInfo(
                account_id=str(entry.get("account_id", "")),
                ticker_or_code=str(entry.get("ticker_or_code", "")),
                current_weight=entry.get("current_weight", 0.0),
                asset_class=str(entry.get("asset_class", "")),
            ))
        if skipped:
            diagnostics.append(_obs(
                f"{skipped} account_holdings entr"
                f"{'y' if skipped == 1 else 'ies'} not a dict; skipped"
            ))
        if not holdings:
            diagnostics.append(_obs(
                "account_holdings has no valid dict entries; "
                "treated as empty (observed holdings absent, not fabricated)"
            ))

    # ── UnifiedViewBuilder（既存計算を import reuse、無変更）───────────────
    view_input = UnifiedViewInput(
        equity_constrained_pf=_coerce_pf_pairs(equity_constrained_pf),
        fund_pf=_coerce_pf_pairs(fund_pf),
        account_holdings=tuple(holdings),
        cash_weight=safe_cw,
        regime=safe_regime if safe_regime else "uncertain",
        context=safe_context,
    )
    result = UnifiedViewBuilder().build(view_input)

    # UnifiedView 側 diagnostics（unclassified 等）は既に "observation: "
    # 接頭辞。pass-through で透明化する。
    for d in result.diagnostics:
        diagnostics.append(d)

    diagnostics.append(_obs(
        "pf split produced via UnifiedViewBuilder (observed holdings + "
        "cash_weight DI); asset_class classification is DI, not performed here"
    ))

    return {
        "frontier_cash_pct":   float(result.total_cash_weight),
        "frontier_fund_pct":   float(result.total_fund_weight),
        "total_equity_weight": float(result.total_equity_weight),
        "regime":              safe_regime,
        "diagnostics":         diagnostics,
    }
