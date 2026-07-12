#!/usr/bin/env python3
"""
JP株OS — stock_scores_6axis 上流生成スクリプト skeleton（D: 接続入口）
使用（将来 / 本 D では実行しない）: python3 data/update_scores.py
出力（将来）: data/stock_scores_6axis.json

目的:
  data/fundamentals.json と public/data/returns.json を読み込み、
  volatility_252d を returns 系列から年率化（stddev * sqrt(252)）
  して financial_data に inject、scoring_orchestrator の
  compute_axis_scores を 16 ticker 各々で呼び phase8 互換の
  stock_scores_6axis doc を組み立てる入口。**本 D では skeleton +
  pure helper のみ。main 実行 / data/stock_scores_6axis.json 生成 /
  public/data 出力 / update_phase8 migration / public/data/phase8
  実 write は行わない**（実行は後続 Card）。

honesty / 非範囲:
  - scores は **partial-real / hybrid**。**full real / full
    generated と呼ばない**。fundamentals 19 + returns 由来
    volatility_252d + 9 passthrough（moat_score / earnings_stab /
    guidance / tam_expansion / momentum 5）は scorer MISSING 中立
    50 で hybrid 恒久要因継続。
  - volatility_252d は returns.json 由来・decimal 単位
    （0.25=25% 年率）。scorer 期待単位と整合。
  - 金融 / leasing セクターでは de_ratio / fcf_yield /
    equity_ratio が bounded だが意味的に低スコア化しやすい
    （documented hybrid limitation）。
  - data/fundamentals.json は yfinance 1.2.0 単発 snapshot
    （generated_at 時点・lower bound）。
  - 投資判断・銘柄推奨・PF 最適化・売買指示ではない。
    BUY / SELL / HOLD / WAIT 禁止、action / 推奨 / 判定ラベル
    禁止、rebalance_order / 具体株数金額 禁止。

設計原則:
  - imports: stdlib（json / math / shutil / statistics / sys /
    datetime / pathlib / typing）+ backend.engine.scoring.
    scoring_orchestrator のみ。pandas / numpy / yfinance / requests
    / urllib 禁止。
  - sys.path: repo root を冪等追加（scoring_orchestrator は
    backend.engine.* prefix import のみ＝単一 root で充分。
    update_phase8.py の dual-root より単純）。
  - pure helper と main の分離。実 HTTP / 外部 API は呼ばない
    （compute は orchestrator・読込は parsed dict）。
  - update_fundamentals.py / update_returns.py mirror の backup-copy
    → try → build → write → except restore。status != ok / 空では
    本番上書きしない。

phase8 互換:
  - output schema は update_phase8.build_scores_from_contract が
    読む形：stock_scores_6axis は list、各 row に
    {ticker, six_axis:{axis:{total, ...}}} を持つ。
  - rating S/A/B/C/D は生成しない（scorer 非伝播の継続）。
  - AxisScore.to_dict() の total（round int）をそのまま採用。

Reference: backend/engine/scoring/scoring_orchestrator.py
Reference: data/update_fundamentals.py / update_returns.py（mirror 元）
Reference: handover.md「6軸 scorer orchestrator 完了サマリ」
"""
from __future__ import annotations

import json
import math
import shutil
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# sys.path: repo root を冪等追加（scoring_orchestrator は
# backend.engine.scoring.X prefix import のみ＝単一 root で充分）。
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from backend.engine.scoring.scoring_orchestrator import compute_axis_scores

OUTPUT_PATH = _REPO_ROOT / "data" / "stock_scores_6axis.json"
BACKUP_PATH = _REPO_ROOT / "data" / "stock_scores_6axis_backup.json"
FUNDAMENTALS_PATH = _REPO_ROOT / "data" / "fundamentals.json"
RETURNS_PATH = _REPO_ROOT / "public" / "data" / "returns.json"

META_VERSION = "v13.3"
META_KIND = "stock_scores_6axis"
META_SOURCE = (
    "scoring_orchestrator + data/fundamentals.json + "
    "public/data/returns.json"
)
META_NOTE = (
    "partial-real hybrid / not full real / not full generated"
    " / volatility_252d derived from returns.json / momentum and"
    " passthrough technical-deferred neutral / financial-sector"
    " bounded distortion documented"
)


def now_iso_tz() -> str:
    """timezone 付き ISO8601（UTC）。"""
    return datetime.now(timezone.utc).isoformat()


def is_usable(x: Any) -> bool:
    """有効数値か（bool 除外 / NaN・inf 除外 / None 除外）。"""
    if isinstance(x, bool):
        return False
    try:
        f = float(x)
    except (TypeError, ValueError):
        return False
    return math.isfinite(f)


def compute_volatility_252d(returns: Any) -> float | None:
    """
    日次 returns 系列 → 年率化ボラ（decimal 単位、0.25=25%）。

    statistics.stdev(valid) * sqrt(252)。有効値（is_usable）が
    2 件未満なら None（捏造しない・missing-safe）。例外時も None。
    """
    try:
        seq = list(returns) if returns is not None else []
    except TypeError:
        return None
    valid = [float(v) for v in seq if is_usable(v)]
    if len(valid) < 2:
        return None
    try:
        return statistics.stdev(valid) * math.sqrt(252.0)
    except Exception:
        return None


def read_fundamentals_doc(path: Any) -> dict:
    """data/fundamentals.json を parsed dict 化。欠損/不正は {}。"""
    p = Path(path)
    if not p.exists():
        return {}
    try:
        with open(p, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (ValueError, OSError):
        return {}
    return doc if isinstance(doc, dict) else {}


def read_returns_doc(path: Any) -> dict:
    """public/data/returns.json を parsed dict 化。欠損/不正は {}。"""
    p = Path(path)
    if not p.exists():
        return {}
    try:
        with open(p, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (ValueError, OSError):
        return {}
    return doc if isinstance(doc, dict) else {}


def build_financial_data(
    fund_row: Any,
    returns_series: Any,
) -> dict:
    """
    {component_key: raw} + 算出可なら volatility_252d を inject。

    元 fund_row を mutate しない（copy）。volatility 算出不能なら
    key を追加せず scorer MISSING 中立委譲。fund_row が dict で
    なければ空 dict から開始（防御）。
    """
    fd: dict = dict(fund_row) if isinstance(fund_row, dict) else {}
    vol = compute_volatility_252d(returns_series)
    if vol is not None:
        fd["volatility_252d"] = vol
    return fd


def build_scores_doc(
    fundamentals_doc: Any,
    returns_doc: Any,
    *,
    generated_at: str | None = None,
) -> dict:
    """
    fundamentals + returns → stock_scores_6axis envelope（phase8 互換）。

    fundamentals_doc["fundamentals"] のキーを正準 ticker 集合とし、
    returns_doc["returns"][ticker] から volatility_252d を算出して
    inject、compute_axis_scores を呼んで stock_scores_6axis list を
    構築。空 / usable ゼロは status="inconclusive"（caller は本番
    非上書き）。元 doc を mutate しない。
    """
    ga = generated_at if generated_at else now_iso_tz()
    f_doc = fundamentals_doc if isinstance(fundamentals_doc, dict) else {}
    r_doc = returns_doc if isinstance(returns_doc, dict) else {}
    fund_map = (
        f_doc.get("fundamentals")
        if isinstance(f_doc.get("fundamentals"), dict) else {}
    )
    ret_map = (
        r_doc.get("returns")
        if isinstance(r_doc.get("returns"), dict) else {}
    )

    rows: list[dict] = []
    tickers: list[str] = []
    missing: list[dict] = []

    for ticker, fund_row in fund_map.items():
        series = ret_map.get(ticker)
        fd = build_financial_data(fund_row, series)
        if "volatility_252d" not in fd:
            missing.append({
                "ticker": str(ticker),
                "component": "volatility_252d",
                "reason": "absent_or_insufficient_returns",
            })
        per_ticker_extra = [
            f"observation: {ticker} fundamentals snapshot from "
            "data/fundamentals.json",
        ]
        if "volatility_252d" not in fd:
            per_ticker_extra.append(
                f"observation: {ticker} volatility_252d unavailable "
                "(returns missing or insufficient) → scorer MISSING "
                "neutral fallback"
            )
        result = compute_axis_scores(
            ticker=str(ticker),
            financial_data=fd,
            diagnostics_extra=per_ticker_extra,
        )
        rows.append({
            "ticker": str(ticker),
            "six_axis": result["axes"],
            "diagnostics": result["diagnostics"],
        })
        tickers.append(str(ticker))

    status = "ok" if rows else "inconclusive"
    doc_diagnostics = [
        "observation: scores are partial-real / hybrid "
        "(not full real / not full generated)",
        "observation: volatility_252d derived from "
        "public/data/returns.json (caller-supplied)",
        "observation: momentum components and 4 passthrough "
        "(moat_score / earnings_stab / guidance / tam_expansion) "
        "are technical-deferred → scorer MISSING_RAW_VALUES neutral",
        "observation: financial-sector tickers may show bounded "
        "de_ratio/fcf_yield/equity_ratio distortion (documented "
        "hybrid limitation)",
        "observation: fundamentals snapshot generated_at="
        + str(f_doc.get("_meta", {}).get("generated_at", "unknown")),
        "observation: returns snapshot generated_at="
        + str(r_doc.get("_meta", {}).get("generated_at", "unknown")),
    ]
    return {
        "_meta": {
            "version": META_VERSION,
            "kind": META_KIND,
            "source": META_SOURCE,
            "generated_at": ga,
            "not_for_trading": True,
            "note": META_NOTE,
        },
        "last_updated": ga,
        "tickers": tickers,
        "missing": missing,
        "stock_scores_6axis": rows,
        "diagnostics": doc_diagnostics,
        "status": status,
    }


def write_doc(path: Any, doc: dict) -> Path:
    """doc を JSON へ atomic 書込（tmp→replace）。"""
    p = Path(path)
    tmp = p.with_name(p.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
    tmp.replace(p)
    return p


def backup_existing(output_path: Any, backup_path: Any) -> bool:
    """既存 OUTPUT があれば backup-copy。コピーしたら True。"""
    o, b = Path(output_path), Path(backup_path)
    if o.exists():
        shutil.copy(o, b)
        return True
    return False


def restore_backup(output_path: Any, backup_path: Any) -> bool:
    """backup があれば OUTPUT へ restore。復元したら True。"""
    o, b = Path(output_path), Path(backup_path)
    if b.exists():
        shutil.copy(b, o)
        return True
    return False


def main(
    output_path: Any = OUTPUT_PATH,
    backup_path: Any = BACKUP_PATH,
    fundamentals_path: Any = FUNDAMENTALS_PATH,
    returns_path: Any = RETURNS_PATH,
) -> bool:
    """
    将来 / 後続 Card 用 entry。**本 D では実行しない**
    （main 実行 / data/stock_scores_6axis.json 生成 / public/data
    出力 / update_phase8 migration は後続 Card）。

    backup → read → build → (status ok のみ) write → 失敗時 restore。
    空 / inconclusive では本番を上書きしない。
    """
    had_backup = backup_existing(output_path, backup_path)
    try:
        f_doc = read_fundamentals_doc(fundamentals_path)
        r_doc = read_returns_doc(returns_path)
        doc = build_scores_doc(f_doc, r_doc)
        if doc["status"] != "ok" or not doc["stock_scores_6axis"]:
            print("  ! stock_scores_6axis 空 / inconclusive: "
                  "本番を上書きしません")
            return False
        write_doc(output_path, doc)
        print(f"  OK {Path(output_path)} 生成 / tickers="
              f"{len(doc['tickers'])} missing={len(doc['missing'])}")
        return True
    except Exception as e:
        print(f"  ERROR: {e}")
        if restore_backup(output_path, backup_path):
            print("  -> backup を restore しました")
        elif not had_backup:
            print("  -> backup なし: 既存なし / 後続は missing-safe")
        return False


if __name__ == "__main__":
    # D ではこの経路は使わない。main 実行 / data/stock_scores_6axis.json
    # 生成 / public/data 出力 / update_phase8 migration は後続 Card。
    sys.exit(0 if main() else 1)
