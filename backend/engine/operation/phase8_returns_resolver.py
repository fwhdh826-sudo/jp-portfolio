"""
phase8_returns_resolver.py — D: returns DI resolver
Operation 層: data/update_returns.py が将来出力する returns_doc dict を
Phase 8 producer DI（returns_data / dd10_returns）へ整形する Flat-DI resolver。

責務:
  - resolve_phase8_returns_di() — returns_doc(parsed dict) を受け取り
    returns_data {ticker:[float]} と dd10_returns [float] を整形して返す

本モジュールの位置付け（重要）:
  既存 Operation 厳格 Flat-DI 層（orchestrator / caller / adapter）と同列。
  **path read しない・public/data 読み書きしない・実 compute 呼び出さない**。
  入力は parsed dict（returns_doc）のみ DI 受領。data/returns.json の読込は
  上位（将来の compute-orchestration / GHA 系 Card）の責務であり本 resolver
  には持たせない（Flat-DI 純度維持、orchestrator/caller/adapter と整合）。

Scope（本 Card 範囲）:
  returns_doc → returns_data / dd10_returns 整形のみ。実取得（yfinance）/
  data/returns.json 生成 / public/data 書き込み / GHA 接続 / producer 配線は
  すべて別 Card。本 Card は producer / orchestrator / caller / adapter /
  writer / data/update_returns.py を変更しない（import もしない）。

整形仕様:
  - returns_data = returns_doc["returns"] を universe filter + ticker
    正規化 + finite-float 検証。`ticker_normalize=True` で "NNNN.T" →
    "NNNN"（producer bare-ticker 整合）。bare ticker はそのまま。
  - 非有限 / 非数値 / bool は除外（捏造しない）。空系列 ticker は missing。
  - universe が与えられた場合は universe 内のみ（正規化後）に filter。
    universe にあって returns に無い ticker も missing に記録。
  - dd10_returns = (pf_weights ∩ returns_data) の equity 部分のみで合成。
    各系列を最小共通長へ truncate（returns.json に日付がないため）。
    対象集合内で weight 再正規化し、period i の PF return =
    Σ(正規化 w_t × ret_t[i])。cash / fund / overseas fund は return 系列が
    無いため含めない（observation diagnostic で透明化）。weight が
    <=0 / 非数値 / NaN / inf は除外。合成不能（pf_weights 不在・非 dict・
    usable ticker ゼロ）は dd10_returns=[] + diagnostic。

設計原則:
  - import は stdlib（math / typing）のみ
  - path read / open / Path / read_text 禁止
  - public/data 読み書き禁止 / hardcoded path 禁止 / public/data path
    literal 禁止 / data/returns 等のパス literal 禁止
  - datetime.now() / time.time() 不使用（決定論）
  - pandas / numpy / scipy import 禁止
  - 実 compute（producer / strategy / aggregator / calculator）import 禁止
  - producer / orchestrator / caller / adapter / writer を import しない
  - 入力 dict（returns_doc / pf_weights）を mutation しない
  - 捏造しない（欠損は missing + diagnostic で透明化）
  - missing-safe（非 dict / 欠損入力 → 空出力 + observation diagnostic）
  - 実 HTTP / API / LLM 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / approve / reject / conditional / rating 禁止
  - rebalance_order / buy_amount / sell_amount / shares / quantity 禁止
  - 全 diagnostics は "observation: " 接頭辞

P1 記録:
  P1-RR-1: Flat-DI dict-in。path read / public-data / 実 compute 非依存。
  P1-RR-2: returns_data は universe filter + .T 正規化 + finite 検証。
           欠損は捏造せず missing + diagnostic。
  P1-RR-3: dd10_returns は equity(weight ∩ returns) のみ・min 長 truncate・
           対象内 weight 再正規化。cash/fund 除外を diagnostic 透明化。
  P1-RR-4: missing-safe（非 dict / returns 非 dict → 空出力 + diagnostic）。
  P1-RR-5: 入力非 mutation。datetime.now()/time.time() 不使用。
  P1-RR-6: テストは test_operation（stdlib + Flat-DI + file io なし思想）。
  P1-RR-7: producer/orchestrator/caller/adapter/writer/update_returns.py
           無変更・非 import。

Reference: data/update_returns.py（returns_doc 出力 schema、無変更）
Reference: handover.md "D: backend returns_resolver skeleton Readiness Review"
"""
from __future__ import annotations

import math
from typing import Any


def _obs(msg: str) -> str:
    """observation 接頭辞付き diagnostic を返す。"""
    return f"observation: {msg}"


def _norm_ticker(raw: Any, normalize: bool) -> str:
    """ticker を str 化。normalize かつ ".T" 終端なら suffix を除去。"""
    s = str(raw)
    if normalize and s.endswith(".T"):
        return s[:-2]
    return s


def _finite_floats(seq: Any) -> list[float]:
    """
    list/tuple の有限数値のみ float 化した新規 list。

    bool は数値扱いしない（True/False を 1.0/0.0 と誤認しない）。
    NaN / inf / 非数値は除外（捏造しない）。非 list/tuple → []。
    """
    if not isinstance(seq, (list, tuple)):
        return []
    out: list[float] = []
    for x in seq:
        if isinstance(x, bool):
            continue
        if isinstance(x, (int, float)):
            v = float(x)
            if math.isnan(v) or math.isinf(v):
                continue
            out.append(v)
    return out


def _safe_weight(raw: Any) -> float | None:
    """weight を safe float 化。bool/非数値/NaN/inf/<=0 → None。"""
    if isinstance(raw, bool):
        return None
    if not isinstance(raw, (int, float)):
        return None
    v = float(raw)
    if math.isnan(v) or math.isinf(v) or v <= 0.0:
        return None
    return v


def _empty_result(diagnostics: list[str]) -> dict:
    return {
        "returns_data": {},
        "dd10_returns": [],
        "missing": [],
        "diagnostics": diagnostics,
    }


def resolve_phase8_returns_di(
    returns_doc: dict,
    *,
    universe: Any = None,
    pf_weights: Any = None,
    ticker_normalize: bool = True,
) -> dict:
    """
    returns_doc(parsed dict) を Phase 8 producer DI へ整形する Flat-DI resolver。

    path read しない・public/data 読み書きしない・実 compute 呼ばない。
    入力 dict は mutation しない。欠損は捏造せず missing + diagnostic。

    Args:
        returns_doc:      data/update_returns.py 相当の parsed dict
                          （`returns` {ticker:[float]} 必須、`tickers` /
                          `missing` / `_meta` は diagnostic に利用）
        universe:         filter 対象 ticker（list/tuple/set、正規化後で突合）。
                          None で filter なし
        pf_weights:       {ticker: weight} dict。dd10_returns 合成に使用。
                          None / 非 dict なら dd10_returns=[]
        ticker_normalize: True で "NNNN.T" → "NNNN"（producer 整合）

    Returns:
        {
          "returns_data": { ticker: [float, ...] },
          "dd10_returns": [float, ...],
          "missing":      [ticker, ...],
          "diagnostics":  list[str]（"observation: " 接頭辞）,
        }

    制約:
      - returns_doc / pf_weights を mutation しない
      - BUY / SELL / HOLD / WAIT 判定を行わない
      - path read / public/data 読み書きをしない
      - 実 HTTP / API / LLM 接続を行わない
    """
    diagnostics: list[str] = []

    if not isinstance(returns_doc, dict):
        diagnostics.append(_obs(
            "returns_doc is not a dict; empty returns_data "
            "(missing-safe, no fabrication)"
        ))
        return _empty_result(diagnostics)

    raw_returns = returns_doc.get("returns")
    if not isinstance(raw_returns, dict):
        diagnostics.append(_obs(
            "returns_doc['returns'] is not a dict; empty returns_data "
            "(missing-safe, no fabrication)"
        ))
        return _empty_result(diagnostics)

    # provenance / upstream-missing は diagnostic 利用のみ（捏造しない）
    meta = returns_doc.get("_meta")
    if isinstance(meta, dict):
        src = meta.get("source")
        kind = meta.get("kind")
        if src is not None or kind is not None:
            diagnostics.append(_obs(
                f"returns_doc provenance: source={src!r} kind={kind!r}"
            ))
    doc_missing = returns_doc.get("missing")
    if isinstance(doc_missing, (list, tuple)) and doc_missing:
        diagnostics.append(_obs(
            f"returns_doc reports {len(doc_missing)} upstream missing ticker(s)"
        ))

    uni_set: set | None = None
    if universe is not None:
        if isinstance(universe, (list, tuple, set)):
            uni_set = {_norm_ticker(u, ticker_normalize) for u in universe}
        else:
            diagnostics.append(_obs(
                "universe is not a list/tuple/set; ignored (no filter)"
            ))

    returns_data: dict[str, list[float]] = {}
    missing: list[str] = []

    for raw_t, raw_seq in raw_returns.items():
        tk = _norm_ticker(raw_t, ticker_normalize)
        if uni_set is not None and tk not in uni_set:
            continue
        if not isinstance(raw_seq, (list, tuple)):
            diagnostics.append(_obs(
                f"ticker {tk!r} series is not a list; treated as empty"
            ))
            if tk not in missing:
                missing.append(tk)
            continue
        series = _finite_floats(raw_seq)
        dropped = len(raw_seq) - len(series)
        if dropped > 0:
            diagnostics.append(_obs(
                f"ticker {tk!r}: {dropped} non-finite/non-number sample(s) "
                "dropped (no fabrication)"
            ))
        if series:
            returns_data[tk] = series
        elif tk not in missing:
            missing.append(tk)

    # universe にあって returns に無い ticker も missing（要求済・未供給）
    if uni_set is not None:
        for u in sorted(uni_set):
            if u not in returns_data and u not in missing:
                missing.append(u)

    if missing:
        diagnostics.append(_obs(
            f"{len(missing)} ticker(s) unresolved (empty/absent); excluded "
            f"from returns_data (no fabrication): {sorted(missing)}"
        ))

    # ── dd10_returns 合成（equity: pf_weights ∩ returns_data のみ）──────────
    dd10_returns: list[float] = []
    if pf_weights is None:
        diagnostics.append(_obs(
            "pf_weights not provided; dd10_returns is [] "
            "(PF synthesis skipped)"
        ))
    elif not isinstance(pf_weights, dict):
        diagnostics.append(_obs(
            "pf_weights is not a dict; dd10_returns is []"
        ))
    else:
        norm_w: dict[str, float] = {}
        for raw_t, raw_w in pf_weights.items():
            tk = _norm_ticker(raw_t, ticker_normalize)
            w = _safe_weight(raw_w)
            if w is None:
                diagnostics.append(_obs(
                    f"pf_weights ticker {tk!r} weight invalid/<=0; excluded"
                ))
                continue
            if tk not in returns_data:
                diagnostics.append(_obs(
                    f"pf_weights ticker {tk!r} has no returns series "
                    "(cash/fund/missing); excluded from dd10"
                ))
                continue
            norm_w[tk] = norm_w.get(tk, 0.0) + w

        if not norm_w:
            diagnostics.append(_obs(
                "no usable (weight ∩ returns) ticker; dd10_returns is []"
            ))
        else:
            total_w = sum(norm_w.values())
            if total_w <= 0.0:
                diagnostics.append(_obs(
                    "total usable weight <= 0; dd10_returns is []"
                ))
            else:
                lengths = {len(returns_data[t]) for t in norm_w}
                min_len = min(lengths)
                if len(lengths) > 1:
                    diagnostics.append(_obs(
                        "series length mismatch among PF tickers; "
                        f"truncated to min common length {min_len}"
                    ))
                for i in range(min_len):
                    period = 0.0
                    for t, w in norm_w.items():
                        period += (w / total_w) * returns_data[t][i]
                    dd10_returns.append(period)
                diagnostics.append(_obs(
                    f"dd10_returns synthesized from {len(norm_w)} equity "
                    f"ticker(s) over {min_len} period(s); cash/fund excluded "
                    "(no return series); calculation-only, not an order"
                ))

    return {
        "returns_data": returns_data,
        "dd10_returns": dd10_returns,
        "missing": missing,
        "diagnostics": diagnostics,
    }
