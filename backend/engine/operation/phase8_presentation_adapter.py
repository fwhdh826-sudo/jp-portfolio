"""
phase8_presentation_adapter.py — P2-D1-b
Operation 層: Phase 8 raw .to_dict() → src/types/phase8.ts presentation 変換。

責務:
  - adapt_frontier_index()        — FrontierIndex raw → FrontierIndexPresentation 相当
  - adapt_strategy_aggregate()    — StrategyAggregateResult raw → StrategyAggregated 相当
  - adapt_opportunity_loss()      — OpportunityLossResult raw → OpportunityLossPresentation 相当
  - adapt_future_branching()      — FutureBranchingResult raw → FutureBranchingPresentation 相当
  - build_presentation_document() — presentation payload を {_meta, payload} で包む
  - assert_json_serializable()    — JSON serializable 検証（失敗時 TypeError）

方式1 Adapter 層（P2-D1 確定 / P2-D1-a presentation 型定義済）:
  Phase 8 backend の raw .to_dict() 出力は computation snapshot。本 adapter が
  src/types/phase8.ts の presentation schema 相当 dict へ変換する。
  raw schema と presentation schema を混同しない。

Flat DI 設計（P1-D1b-2）:
  Phase 8 dataclass（FrontierIndex / StrategyAggregateResult /
  OpportunityLossResult / FutureBranchingResult）を **直接 import しない**。
  caller が各 result の .to_dict() 出力（dict）+ 補助 DI 値を渡す。
  入力 dict は mutation しない（deepcopy で snapshot 化）。

合成ギャップの扱い（P1-D1b-4/5/6）:
  raw .to_dict() 単体では完成しない presentation フィールドは補助 DI で
  受け取る。不在時は安全 default + observation diagnostic（捏造せず透明化）。
    - frontier_index: cash_pct / fund_pct（補助 DI、0.0 default + diag）
    - strategy_aggregate: strategy_outputs（補助 DI、{} default + diag）/
      dd10_uniform_return（補助 DI、0.0 default + diag）/ timestamp（caller 供給）/
      high_correlation_warning（strategy_correlations max > 0.70 から adapter 内導出）
  DD10 計算・PF builder 計算は本 adapter では行わない（P1-D1b-9、値は DI）。

generated_at / source は caller 供給（P1-D1b-7）:
  本 adapter は datetime.now() / time.time() を呼ばない（テスト決定論性）。

設計原則:
  - stdlib-only（copy / json / math）
  - pandas / numpy / scipy 禁止
  - Phase 8 dataclass / Card D writer の直接 import 禁止（Flat DI）
  - public/data 書き込み禁止 / writer 呼び出し禁止 / hardcoded path 禁止
  - src/types 変更・React UI 配線・GitHub Actions 変更は範囲外
  - DD10 / PF builder の実計算禁止（値は DI）
  - 実 HTTP / API / LLM 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / approve / reject / conditional / rating 禁止
  - rebalance_order / buy_amount / sell_amount / shares / quantity 禁止
  - not_for_trading は true 固定
  - 全 diagnostics は "observation: " 接頭辞

P1 記録:
  P1-D1b-1: Scope B。operation/phase8_presentation_adapter.py 新設。
  P1-D1b-2: Flat DI。dict in/out、dataclass 非 import。
  P1-D1b-3: opportunity_loss / future_branching はクリーン 1:1 変換。
  P1-D1b-4: frontier_index の cash_pct/fund_pct は補助 DI。不在時 0.0 + diag。
  P1-D1b-5: strategy_aggregate の strategy_outputs/dd10_uniform_return は補助 DI。
            high_correlation_warning は adapter 内導出。timestamp は caller 供給。
  P1-D1b-6: missing field = default + observation diagnostic。
  P1-D1b-7: Phase8Document helper。_meta 5 固定、not_for_trading true、
            generated_at/source caller 供給。
  P1-D1b-8: public/data 非書き込み、src/types 非変更、UI 非配線、
            GHA 非変更、Card D writer 非変更。
  P1-D1b-9: DD10 / PF builder の実計算はしない。値は DI で受け取る。

P2/P3 記録（後続）:
  P2-D2: 実 public/data 配線（adapter 出力 + writer/helper で出力）。
  P2-D3: Operation 層 caller（4 戦略 compute / DD10 / PF builder を呼び DI）。
  P2-D4: React UI を phase8.ts presentation に fetch 配線。
  P3-PA1-X: FrontierStrategy 側 Phase 8 / Card C identifier 公開定数 export。

Reference: src/types/phase8.ts（presentation schema、P2-D1-a）
Reference: backend/engine/operation/recovery_log_writer.py（Operation 層 writer 前例）
Reference: handover.md "P2-D1 schema reconcile 決定" / "P2-D1-b Readiness Review"
"""
from __future__ import annotations

import copy
import json
import math
from typing import Any


# ── 定数 ─────────────────────────────────────────────────────────────────────

_META_VERSION: str = "v13.3"
_META_NOT_FOR_TRADING: bool = True

# strategy_correlations から high_correlation_warning を導出する閾値。
# backend/engine/strategies/aggregator.py の HIGH_CORR_THRESHOLD と整合。
_HIGH_CORR_THRESHOLD: float = 0.70


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


def _obs(msg: str) -> str:
    """observation 接頭辞付き diagnostic を返す。"""
    return f"observation: {msg}"


def _require_dict(raw: Any, name: str) -> dict:
    """raw が dict でなければ TypeError。dict ならそのまま返す（mutation しない）。"""
    if not isinstance(raw, dict):
        raise TypeError(f"{name} must be dict, got {type(raw).__name__}")
    return raw


def _str_list(raw: Any) -> list:
    """list/tuple の各要素を str 化した新規 list。非 list/tuple → []。"""
    if not isinstance(raw, (list, tuple)):
        return []
    return [str(x) for x in raw]


def _require_non_empty_str(value: Any, name: str) -> str:
    """value が non-empty str でなければ ValueError。"""
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty str")
    return value


# ── frontier_index ────────────────────────────────────────────────────────────


def adapt_frontier_index(
    raw: dict,
    *,
    generated_at: str,
    cash_pct: float = 0.0,
    fund_pct: float = 0.0,
) -> dict:
    """
    FrontierIndex.to_dict() → FrontierIndexPresentation 相当 dict。

    変換:
      constituents = dict(zip(tickers, weights))（長さ不一致は短い方で truncate）
      total_weight = sum(weights)
      regime       = raw["regime_used"]
      generated_at = caller 供給（P1-D1b-7）
      cash_pct / fund_pct = 補助 DI（0.0 のとき不在扱い + diagnostic、P1-D1b-4）
      expected_return / expected_vol / sharpe_ratio = 直接
      diagnostics  = raw diagnostics pass-through + adapter diag

    raw が dict でなければ TypeError。
    """
    src = _require_dict(raw, "raw")

    tickers = src.get("tickers", [])
    weights = src.get("weights", [])
    tickers = list(tickers) if isinstance(tickers, (list, tuple)) else []
    weights = list(weights) if isinstance(weights, (list, tuple)) else []

    diagnostics = _str_list(src.get("diagnostics", []))

    constituents: dict = {}
    if len(tickers) != len(weights):
        diagnostics.append(_obs(
            f"tickers/weights length mismatch ({len(tickers)} vs "
            f"{len(weights)}); constituents truncated to min length"
        ))
    for t, w in zip(tickers, weights):
        constituents[str(t)] = _safe_float(w, 0.0)

    total_weight = sum(constituents.values())

    regime = src.get("regime_used", "")
    if not isinstance(regime, str):
        regime = ""

    cash = _safe_float(cash_pct, 0.0)
    fund = _safe_float(fund_pct, 0.0)
    if cash == 0.0:
        diagnostics.append(_obs(
            "cash_pct treated as 0.0 (adapter-supplied PF aggregate; "
            "caller must provide explicit value if non-zero)"
        ))
    if fund == 0.0:
        diagnostics.append(_obs(
            "fund_pct treated as 0.0 (adapter-supplied PF aggregate; "
            "caller must provide explicit value if non-zero)"
        ))

    return {
        "generated_at":    generated_at,
        "regime":          regime,
        "constituents":    constituents,
        "total_weight":    total_weight,
        "cash_pct":        cash,
        "fund_pct":        fund,
        "expected_return": _safe_float(src.get("expected_return"), 0.0),
        "expected_vol":    max(0.0, _safe_float(src.get("expected_vol"), 0.0)),
        "sharpe_ratio":    _safe_float(src.get("sharpe_ratio"), 0.0),
        "diagnostics":     diagnostics,
    }


# ── strategy_aggregate ────────────────────────────────────────────────────────


def adapt_strategy_aggregate(
    raw: dict,
    *,
    timestamp: str,
    strategy_outputs: dict | None = None,
    dd10_uniform_return: float | None = None,
) -> dict:
    """
    StrategyAggregateResult.to_dict() → StrategyAggregated 相当 dict。

    変換:
      ideal_pf                 = raw["aggregated_ideal_pf"]（rename）
      timestamp                = caller 供給（P1-D1b-7）
      strategy_outputs         = 補助 DI（None → {} + diagnostic、P1-D1b-5）
      dd10_uniform_return      = 補助 DI（None → 0.0 + diagnostic、P1-D1b-5）
      high_correlation_warning = strategy_correlations max > 0.70（adapter 内導出）
      regime / weights_used / strategy_correlations / diversification_score /
      expected_return          = 直接

    実際の DD10 計算は本 adapter では行わない（P1-D1b-9）。
    raw が dict でなければ TypeError。
    """
    src = _require_dict(raw, "raw")

    diagnostics = _str_list(src.get("diagnostics", []))

    aggregated = src.get("aggregated_ideal_pf", {})
    ideal_pf = dict(aggregated) if isinstance(aggregated, dict) else {}

    weights_used = src.get("weights_used", {})
    weights_used = dict(weights_used) if isinstance(weights_used, dict) else {}

    correlations = src.get("strategy_correlations", {})
    correlations = dict(correlations) if isinstance(correlations, dict) else {}

    if strategy_outputs is None:
        so: dict = {}
        diagnostics.append(_obs(
            "strategy_outputs not provided to adapter; defaulted to {} "
            "(Aggregator does not retain individual outputs; caller must "
            "supply 4 strategy outputs)"
        ))
    elif not isinstance(strategy_outputs, dict):
        so = {}
        diagnostics.append(_obs(
            "strategy_outputs is not a dict; defaulted to {}"
        ))
    else:
        so = copy.deepcopy(strategy_outputs)

    if dd10_uniform_return is None:
        dd10 = 0.0
        diagnostics.append(_obs(
            "dd10_uniform_return not provided to adapter; defaulted to 0.0 "
            "(DD-10% KPI is caller responsibility; adapter does not compute it)"
        ))
    else:
        dd10 = _safe_float(dd10_uniform_return, 0.0)

    # high_correlation_warning は strategy_correlations から adapter 内導出
    corr_values = [
        _safe_float(v, 0.0) for v in correlations.values()
    ]
    high_correlation_warning = bool(
        corr_values and max(corr_values) > _HIGH_CORR_THRESHOLD
    )

    regime = src.get("regime", "")
    if not isinstance(regime, str):
        regime = ""

    return {
        "timestamp":                timestamp,
        "regime":                   regime,
        "weights_used":             weights_used,
        "strategy_outputs":         so,
        "strategy_correlations":    correlations,
        "diversification_score":    _safe_float(src.get("diversification_score"), 0.0),
        "ideal_pf":                 ideal_pf,
        "expected_return":          _safe_float(src.get("expected_return"), 0.0),
        "dd10_uniform_return":      dd10,
        "high_correlation_warning": high_correlation_warning,
        "diagnostics":              diagnostics,
    }


# ── opportunity_loss（クリーン 1:1）───────────────────────────────────────────


def adapt_opportunity_loss(raw: dict) -> dict:
    """
    OpportunityLossResult.to_dict() → OpportunityLossPresentation 相当 dict。

    変換:
      weight_drift = dict(weight_drift_per_ticker)（[[ticker, drift], ...] → {}）
      regime       = raw["regime_used"]（rename）
      他            = 直接（total_drift_l1/l2、3 gap、diagnostics）

    raw が dict でなければ TypeError。
    """
    src = _require_dict(raw, "raw")

    diagnostics = _str_list(src.get("diagnostics", []))

    wdpt = src.get("weight_drift_per_ticker", [])
    weight_drift: dict = {}
    if isinstance(wdpt, (list, tuple)):
        for pair in wdpt:
            if isinstance(pair, (list, tuple)) and len(pair) == 2:
                weight_drift[str(pair[0])] = _safe_float(pair[1], 0.0)

    regime = src.get("regime_used", "")
    if not isinstance(regime, str):
        regime = ""

    return {
        "weight_drift":                     weight_drift,
        "total_drift_l1":                   _safe_float(src.get("total_drift_l1"), 0.0),
        "total_drift_l2":                   _safe_float(src.get("total_drift_l2"), 0.0),
        "constraint_return_gap":            _safe_float(src.get("constraint_return_gap"), 0.0),
        "drift_return_gap":                 _safe_float(src.get("drift_return_gap"), 0.0),
        "estimated_opportunity_return_gap": _safe_float(src.get("estimated_opportunity_return_gap"), 0.0),
        "regime":                           regime,
        "diagnostics":                      diagnostics,
    }


# ── future_branching（クリーン 1:1）───────────────────────────────────────────


def _adapt_branch(raw_branch: Any) -> dict:
    """1 branch を FutureBranchPresentation 相当 dict へ。"""
    b = raw_branch if isinstance(raw_branch, dict) else {}
    regime = b.get("regime", "")
    if not isinstance(regime, str):
        regime = ""
    return {
        "regime":          regime,
        "expected_return": _safe_float(b.get("expected_return"), 0.0),
        "expected_vol":    max(0.0, _safe_float(b.get("expected_vol"), 0.0)),
        "sharpe_ratio":    _safe_float(b.get("sharpe_ratio"), 0.0),
        "max_dd_estimate": min(0.0, _safe_float(b.get("max_dd_estimate"), 0.0)),
        "downside_case":   _safe_float(b.get("downside_case"), 0.0),
        "upside_case":     _safe_float(b.get("upside_case"), 0.0),
        "probability":     _safe_float(b.get("probability"), 0.0),
        "is_base_regime":  bool(b.get("is_base_regime", False)),
    }


def adapt_future_branching(raw: dict) -> dict:
    """
    FutureBranchingResult.to_dict() → FutureBranchingPresentation 相当 dict。

    変換:
      branches = 各 raw branch を FutureBranchPresentation 相当へ（同一フィールド）
      base_regime / weighted_* / worst_* / best_* / diagnostics = 直接

    raw が dict でなければ TypeError。
    """
    src = _require_dict(raw, "raw")

    diagnostics = _str_list(src.get("diagnostics", []))

    raw_branches = src.get("branches", [])
    if not isinstance(raw_branches, (list, tuple)):
        raw_branches = []
    branches = [_adapt_branch(b) for b in raw_branches]

    base_regime = src.get("base_regime", "")
    if not isinstance(base_regime, str):
        base_regime = ""

    return {
        "branches":                 branches,
        "base_regime":              base_regime,
        "weighted_expected_return": _safe_float(src.get("weighted_expected_return"), 0.0),
        "weighted_expected_vol":    max(0.0, _safe_float(src.get("weighted_expected_vol"), 0.0)),
        "worst_case_dd":            min(0.0, _safe_float(src.get("worst_case_dd"), 0.0)),
        "worst_case_downside":      _safe_float(src.get("worst_case_downside"), 0.0),
        "best_case_upside":         _safe_float(src.get("best_case_upside"), 0.0),
        "diagnostics":              diagnostics,
    }


# ── Phase8Document envelope helper ────────────────────────────────────────────


def build_presentation_document(
    payload: dict,
    *,
    kind: str,
    source: str,
    generated_at: str,
) -> dict:
    """
    presentation payload を {_meta, payload} で包む（src/types/phase8.ts
    Phase8Document<T> 相当）。Card D raw envelope とは別系統。

    _meta 5 フィールド固定（P1-D1b-7）:
      version（"v13.3" 固定）/ kind / source / generated_at / not_for_trading（true 固定）

    kind / source / generated_at は caller 供給（datetime.now() 不使用）。
    payload は deepcopy snapshot（入力 mutation しない）。

    Raises:
        TypeError:  payload が dict でない
        ValueError: kind / source / generated_at が non-empty str でない
    """
    if not isinstance(payload, dict):
        raise TypeError(
            f"payload must be dict, got {type(payload).__name__}"
        )
    _require_non_empty_str(kind, "kind")
    _require_non_empty_str(source, "source")
    _require_non_empty_str(generated_at, "generated_at")

    return {
        "_meta": {
            "version":         _META_VERSION,
            "kind":            kind,
            "source":          source,
            "generated_at":    generated_at,
            "not_for_trading": _META_NOT_FOR_TRADING,
        },
        "payload": copy.deepcopy(payload),
    }


# ── JSON serializable 検証 ────────────────────────────────────────────────────


def assert_json_serializable(data: Any) -> None:
    """
    data が JSON serializable か検証する。失敗時 TypeError。

    dict / list / str / int / float / bool / None: OK
    tuple: JSON 上 list（例外なし）
    set / 任意オブジェクト: TypeError
    """
    try:
        json.dumps(data, ensure_ascii=False)
    except (TypeError, ValueError) as exc:
        raise TypeError(f"data is not JSON serializable: {exc}") from exc
