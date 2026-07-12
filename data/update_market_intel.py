#!/usr/bin/env python3
"""
JP株OS — market_intel.json 生成スクリプト
使用: python3 data/update_market_intel.py
出力: data/market_intel.json
      public/data/market_intel.json

yfinance から rule_based 用の 5 フィールド + usdjpy を取得し、
backend/engine/market_intel/macro_fetcher を呼んで market_intel.json を更新する。

取得元:
  ^N225   → nikkei_5d_return / nikkei_60ma / nikkei_200ma
             (period="1y" — 200MA に 200 取引日必要)
  ^GSPC   → sp500_dd_30d (30日間の peak → current 比)
  ^VIX    → vix
  JPY=X   → usdjpy

Source: yfinance_hybrid（実市場データ / rule_based signals / LLM 不使用）
"""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SCRIPT_DIR.parent
_BACKEND_ROOT = _REPO_ROOT / "backend"
for _p in (str(_REPO_ROOT), str(_BACKEND_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from backend.engine.market_intel.macro_fetcher import (
    MacroSnapshot,
    build_macro_snapshot,
)

OUTPUT_PATHS: list[Path] = [
    _SCRIPT_DIR / "market_intel.json",
    _REPO_ROOT / "public" / "data" / "market_intel.json",
]

# フォールバック値（前回値が読めない場合の保守的デフォルト）
_FALLBACK: dict = {
    "vix": 20.0,
    "nikkei_5d_return": 0.0,
    "nikkei_60ma": 0.0,
    "nikkei_200ma": 0.0,
    "sp500_dd_30d": 0.0,
    "usdjpy": 150.0,
}

_SENTIMENT_STEP: dict = {"weak": 5.0, "moderate": 8.0, "strong": 12.0}


def log(msg: str) -> None:
    print(f"[update_market_intel] {msg}", flush=True)


def _read_existing() -> dict:
    """既存 JSON を読み込む（フォールバックの base として使用）。"""
    for p in OUTPUT_PATHS:
        if p.exists():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
    return {}


def fetch_market_data() -> tuple[dict, dict]:
    """
    yfinance から 5 フィールド + usdjpy を取得する。

    Returns:
        (data_dict, fetch_ok_dict)
        fetch_ok_dict: {"n225": bool, "gspc": bool, "vix": bool, "jpy": bool}
    """
    try:
        import yfinance as yf
    except ImportError:
        log("yfinance not installed — pip install yfinance")
        existing = _read_existing()
        return {k: existing.get(k, v) for k, v in _FALLBACK.items()}, {
            "n225": False, "gspc": False, "vix": False, "jpy": False,
        }

    existing = _read_existing()
    result: dict = {}
    ok: dict = {"n225": False, "gspc": False, "vix": False, "jpy": False}

    # ── ^N225: nikkei_5d_return / 60MA / 200MA ──────────────────────────────
    # 200MA に 200 取引日必要 → period="1y"（≈252 取引日）
    try:
        hist = yf.Ticker("^N225").history(period="1y")
        if len(hist) < 60:
            raise ValueError(f"^N225 insufficient history: {len(hist)}")
        close = hist["Close"].dropna()
        # 5 取引日リターン（tail(6): 5日前→今日）
        tail6 = close.tail(6)
        if len(tail6) >= 6:
            n5 = float((tail6.iloc[-1] - tail6.iloc[0]) / tail6.iloc[0])
        else:
            n5 = 0.0
        ma60 = float(close.rolling(60).mean().iloc[-1])
        # 200MA: データ不足なら 75MA で代替（フォールバック）
        if len(close) >= 200:
            ma200 = float(close.rolling(200).mean().iloc[-1])
        else:
            log("  ⚠ ^N225: <200d available, using 75-day proxy for 200MA")
            ma200 = float(close.rolling(min(75, len(close))).mean().iloc[-1])
        if not (math.isfinite(n5) and math.isfinite(ma60) and math.isfinite(ma200)):
            raise ValueError("NaN in N225 results")
        result["nikkei_5d_return"] = round(n5, 6)
        result["nikkei_60ma"] = round(ma60, 1)
        result["nikkei_200ma"] = round(ma200, 1)
        ok["n225"] = True
        log(f"  ✓ ^N225: 5d_ret={n5:.4f}  60ma={ma60:.0f}  200ma={ma200:.0f}")
    except Exception as e:
        log(f"  ⚠ ^N225 failed: {e} → fallback")
        result["nikkei_5d_return"] = existing.get("nikkei_5d_return", _FALLBACK["nikkei_5d_return"])
        result["nikkei_60ma"]      = existing.get("nikkei_60ma", _FALLBACK["nikkei_60ma"])
        result["nikkei_200ma"]     = existing.get("nikkei_200ma", _FALLBACK["nikkei_200ma"])

    # ── ^GSPC: sp500_dd_30d ─────────────────────────────────────────────────
    try:
        g_hist = yf.Ticker("^GSPC").history(period="3mo")
        if len(g_hist) < 30:
            raise ValueError(f"^GSPC insufficient history: {len(g_hist)}")
        g_close = g_hist["Close"].dropna().tail(30)
        peak = float(g_close.max())
        current = float(g_close.iloc[-1])
        dd30 = (current - peak) / peak if peak > 0 else 0.0
        if not math.isfinite(dd30):
            raise ValueError("NaN in GSPC dd30")
        result["sp500_dd_30d"] = round(dd30, 6)
        ok["gspc"] = True
        log(f"  ✓ ^GSPC: sp500_dd_30d={dd30:.4f}")
    except Exception as e:
        log(f"  ⚠ ^GSPC failed: {e} → fallback")
        result["sp500_dd_30d"] = existing.get("sp500_dd_30d", _FALLBACK["sp500_dd_30d"])

    # ── ^VIX ────────────────────────────────────────────────────────────────
    try:
        v_hist = yf.Ticker("^VIX").history(period="5d")
        if v_hist.empty:
            raise ValueError("^VIX history empty")
        vix_val = round(float(v_hist["Close"].dropna().iloc[-1]), 2)
        if not math.isfinite(vix_val):
            raise ValueError("NaN in VIX")
        result["vix"] = vix_val
        ok["vix"] = True
        log(f"  ✓ ^VIX: {vix_val}")
    except Exception as e:
        log(f"  ⚠ ^VIX failed: {e} → fallback")
        result["vix"] = existing.get("vix", _FALLBACK["vix"])

    # ── JPY=X (USDJPY) ──────────────────────────────────────────────────────
    try:
        j_hist = yf.Ticker("JPY=X").history(period="5d")
        if j_hist.empty:
            raise ValueError("JPY=X history empty")
        jpy_val = round(float(j_hist["Close"].dropna().iloc[-1]), 2)
        if not math.isfinite(jpy_val):
            raise ValueError("NaN in USDJPY")
        result["usdjpy"] = jpy_val
        ok["jpy"] = True
        log(f"  ✓ JPY=X: {jpy_val}")
    except Exception as e:
        log(f"  ⚠ JPY=X failed: {e} → fallback")
        result["usdjpy"] = existing.get("usdjpy", _FALLBACK["usdjpy"])

    return result, ok


def _build_narrative(snapshot: MacroSnapshot, usdjpy: float) -> dict:
    """
    MacroSnapshot からルールベースで narrative を生成する（LLM 不使用）。
    method = "rule_based"。
    """
    risk_labels = {
        "low": "低リスク", "medium": "中程度リスク",
        "high": "高リスク", "crisis": "危機水準",
    }
    risk_jp = risk_labels.get(snapshot.risk_level, snapshot.risk_level)
    vix_str = f"{snapshot.vix:.1f}"
    ret_str = f"{snapshot.nikkei_5d_return * 100:+.1f}%"
    jpy_str = f"{usdjpy:.1f}"

    signal_tags = [s.tag for s in snapshot.signals]
    headline = f"リスクレベル: {risk_jp} — VIX {vix_str} / USD/JPY {jpy_str}円"
    body_lines: list[str] = [
        f"VIX {vix_str} / 日経5日 {ret_str} / USD/JPY {jpy_str}",
        f"リスクレベル: {risk_jp}",
    ]
    for s in snapshot.signals:
        sym = "↑" if s.direction == "positive" else "↓" if s.direction == "negative" else "→"
        body_lines.append(f"{sym} {s.tag}（{s.strength}）")

    score = 50.0
    for s in snapshot.signals:
        step = _SENTIMENT_STEP.get(s.strength, 5.0)
        if s.direction == "positive":
            score += step
        elif s.direction == "negative":
            score -= step
    score = max(0.0, min(100.0, score))
    sentiment_label = "bullish" if score > 60.0 else "bearish" if score < 40.0 else "neutral"

    return {
        "headline": headline,
        "body_lines": body_lines,
        "keywords_summary": signal_tags,
        "sentiment_label": sentiment_label,
        "sentiment_score": round(score, 1),
        "method": "rule_based",
    }


def main() -> bool:
    log(f"market_intel 更新開始 {datetime.now(timezone.utc).isoformat()}")

    data, fetch_ok = fetch_market_data()

    vix              = data["vix"]
    nikkei_5d_return = data["nikkei_5d_return"]
    nikkei_60ma      = data["nikkei_60ma"]
    nikkei_200ma     = data["nikkei_200ma"]
    sp500_dd_30d     = data["sp500_dd_30d"]
    usdjpy           = data["usdjpy"]

    snapshot = build_macro_snapshot(
        vix=vix,
        nikkei_5d_return=nikkei_5d_return,
        nikkei_60ma=nikkei_60ma,
        nikkei_200ma=nikkei_200ma,
        sp500_dd_30d=sp500_dd_30d,
        usdjpy=usdjpy,
    )

    fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    output = {
        "fetched_at": fetched_at,
        "source": "yfinance_hybrid",
        "vix": vix,
        "nikkei_5d_return": nikkei_5d_return,
        "nikkei_60ma": nikkei_60ma,
        "nikkei_200ma": nikkei_200ma,
        "sp500_dd_30d": sp500_dd_30d,
        "usdjpy": usdjpy,
        "risk_level": snapshot.risk_level,
        "signals": [
            {"tag": s.tag, "strength": s.strength, "direction": s.direction}
            for s in snapshot.signals
        ],
        "narrative": _build_narrative(snapshot, usdjpy),
        "sources_status": {
            "yfinance_n225": "ok" if fetch_ok["n225"] else "fallback",
            "yfinance_gspc": "ok" if fetch_ok["gspc"] else "fallback",
            "yfinance_vix":  "ok" if fetch_ok["vix"]  else "fallback",
            "yfinance_jpy":  "ok" if fetch_ok["jpy"]  else "fallback",
        },
    }

    wrote_ok = True
    for out_path in OUTPUT_PATHS:
        try:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            with open(out_path, "w", encoding="utf-8") as fh:
                json.dump(output, fh, ensure_ascii=False, indent=2)
            log(f"  ✓ {out_path} 生成完了")
        except OSError as e:
            log(f"  ✗ 書き込み失敗: {out_path}: {e}")
            wrote_ok = False

    log(
        f"  risk_level={snapshot.risk_level}"
        f"  signals={[s.tag for s in snapshot.signals]}"
        f"  fetch_ok={fetch_ok}"
    )
    return wrote_ok


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
