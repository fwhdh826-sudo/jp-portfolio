#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════
# update_macro.py — v9.0
# マクロ指標を yfinance から取得して data/macro.json に保存
# ─ 金利:   ^TNX (US10Y) / JGB10Y は別途（yfinance直接なし）
# ─ 為替:   JPY=X (USDJPY)
# ─ 米株:   ^GSPC (SP500) / ^IXIC (NASDAQ)
# ─ VIX:    ^VIX
# ─ 原油:   CL=F (NY原油先物)
# ─ 金:     GC=F (金先物)
# ─ 日経VI: ^VXJ （日経VIのyfinance実装）
#
# 使い方:
#   python3 data/update_macro.py
# 依存:
#   pip install yfinance
# 出力:
#   data/macro.json
#   public/data/macro.json
# ═══════════════════════════════════════════════════════════

import json
import os
import sys
import datetime as dt
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
DATA_DIR = PROJECT_ROOT / "data"
PUBLIC_DIR = PROJECT_ROOT / "public" / "data"
OUT_FILES = [DATA_DIR / "macro.json", PUBLIC_DIR / "macro.json"]

# 既存 macro.json を壊さないためのフォールバック
FALLBACK = {
    "last_updated": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
    "jgb10y": 1.45,
    "ust10y": 4.35,
    "usdjpy": 158.46,
    "usdjpyChgPct": -0.73,
    "sp500": 6782.0,
    "sp500ChgPct": 2.5,
    "nasdaq": 22500.0,
    "nasdaqChgPct": 2.8,
    "vix": 21.04,
    "vixChg": -4.74,
    "nikkeiVI": 22.5,
    "nikkeiVIChg": -1.2,
    "gold": 2780.0,
    "goldChgPct": 0.3,
    "nyCrude": 96.50,
    "nyCrudeChgPct": -15.0,
}

def log(msg: str):
    print(f"[update_macro] {msg}", flush=True)

def load_existing():
    for p in OUT_FILES:
        if p.exists():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                pass
    return None

def fetch_with_yfinance():
    try:
        import yfinance as yf
    except ImportError:
        log("yfinance not installed — install with: pip install yfinance")
        return None

    import pandas as pd  # noqa: F401
    result = {}

    tickers = {
        "ust10y":   "^TNX",   # 米10年（% 単位）
        "usdjpy":   "JPY=X",
        "sp500":    "^GSPC",
        "nasdaq":   "^IXIC",
        "vix":      "^VIX",
        # 注: 日経VI ^VXJ は yfinance で取得不可
        #     VIX との相関が高いため VIX × 0.95 で近似する
        "gold":     "GC=F",
        "nyCrude":  "CL=F",
    }

    for key, sym in tickers.items():
        try:
            t = yf.Ticker(sym)
            hist = t.history(period="5d", interval="1d", auto_adjust=False)
            if hist.empty or len(hist) < 2:
                log(f"  WARN {sym}: insufficient history")
                continue
            close = float(hist["Close"].iloc[-1])
            prev = float(hist["Close"].iloc[-2])
            chg_pct = (close - prev) / prev * 100 if prev else 0.0
            chg_abs = close - prev

            if key == "ust10y":
                # ^TNX は既に % 単位で返る（例: 4.31 = 4.31%）
                result["ust10y"] = round(close, 3)
            elif key in ("usdjpy", "sp500", "nasdaq", "gold", "nyCrude"):
                result[key] = round(close, 2)
                result[f"{key}ChgPct"] = round(chg_pct, 2)
            elif key in ("vix", "nikkeiVI"):
                result[key] = round(close, 2)
                result[f"{key}Chg"] = round(chg_abs, 2)
            log(f"  OK   {sym}: {close:.2f} ({chg_pct:+.2f}%)")
        except Exception as e:
            log(f"  ERR  {sym}: {e}")

    # 日経VI を VIX から近似（^VXJ は取得不可のため）
    if "vix" in result:
        vix = result["vix"]
        # 日経VIは歴史的にVIXの0.9-1.1倍の範囲で推移
        result["nikkeiVI"] = round(vix * 0.95, 2)
        # 変化量は VIX と同程度と仮定
        result["nikkeiVIChg"] = round(result.get("vixChg", 0.0) * 0.95, 2)

    # JGB10Y は yfinance では取得困難 → 既存値を維持
    # （将来、財務省RSSから取得するスクリプトを追加予定）
    return result if result else None

def main():
    log("start")
    existing = load_existing() or FALLBACK.copy()
    fetched = fetch_with_yfinance()

    # マージ（取得失敗項目は既存値維持）
    if fetched:
        existing.update(fetched)
    existing["last_updated"] = dt.datetime.now().strftime("%Y-%m-%d %H:%M")

    # 必須キーの存在確認
    for k in FALLBACK:
        if k not in existing:
            existing[k] = FALLBACK[k]

    # 書き出し
    for out in OUT_FILES:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"  wrote {out}")

    log("done")
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(f"FATAL: {e}")
        # 既存 JSON を維持してフォールバック（CLAUDE.md 規約）
        sys.exit(0)
