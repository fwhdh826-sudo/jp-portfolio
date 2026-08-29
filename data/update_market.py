#!/usr/bin/env python3
"""
JP株OS — 市場データ自動生成スクリプト
使用: python3 data/update_market.py
出力: data/market.json (日経225・VIX・テクニカル指標)
"""
import json
import math
import os
import sys
import tempfile
from pathlib import Path
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import yfinance as yf

OUTPUT_PATH = Path(__file__).parent / 'market.json'

def fetch_price_pack(symbol, period='6mo'):
    ticker = yf.Ticker(symbol)
    hist = ticker.history(period=period)
    if hist.empty or len(hist) < 2:
        raise ValueError(f"{symbol} history is empty")
    close = hist['Close']
    price = float(close.iloc[-1])
    prev = float(close.iloc[-2])
    chg = price - prev
    chg_pct = (chg / prev) * 100 if prev else 0.0
    values = {"price": price, "prev": prev, "chg": chg, "chg_pct": chg_pct}
    non_finite = [name for name, value in values.items() if not math.isfinite(value)]
    if non_finite:
        raise ValueError(
            f"{symbol} returned non-finite price data: {', '.join(non_finite)}"
        )
    return price, chg, chg_pct, hist


def write_market_json(output, output_path=None):
    """Strictly serialize and atomically replace the market snapshot."""
    output_path = Path(OUTPUT_PATH if output_path is None else output_path)
    serialized = json.dumps(
        output,
        ensure_ascii=False,
        indent=2,
        allow_nan=False,
    )

    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode='w',
            encoding='utf-8',
            dir=output_path.parent,
            prefix=f'.{output_path.name}.',
            suffix='.tmp',
            delete=False,
        ) as temp_file:
            temp_path = Path(temp_file.name)
            temp_file.write(serialized)
            temp_file.flush()
            os.fsync(temp_file.fileno())
        os.replace(temp_path, output_path)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)

def calc_rsi(series, period=14):
    delta = series.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).iloc[-1]

def calc_macd(series):
    ema12 = series.ewm(span=12).mean()
    ema26 = series.ewm(span=26).mean()
    macd_line = ema12 - ema26
    signal = macd_line.ewm(span=9).mean()
    return 'golden' if macd_line.iloc[-1] > signal.iloc[-1] else 'dead'

def calc_bollinger(series, period=25):
    ma = series.rolling(period).mean()
    std = series.rolling(period).std()
    return {
        'mid':   round(float(ma.iloc[-1]), 0),
        'upper': round(float(ma.iloc[-1] + 2 * std.iloc[-1]), 0),
        'lower': round(float(ma.iloc[-1] - 2 * std.iloc[-1]), 0),
    }

def main():
    print(f"[{datetime.now():%Y-%m-%d %H:%M}] 市場データ取得開始")

    try:
        # 日経225
        price_raw, chg_raw, chg_pct_raw, hist = fetch_price_pack('^N225')
        close = hist['Close']
        volume_today = hist['Volume'].iloc[-1]
        vol_avg = hist['Volume'].rolling(20).mean().iloc[-1]

        price = round(price_raw, 0)
        chg = round(chg_raw, 0)
        chg_pct = round(chg_pct_raw, 2)

        ma5  = round(float(close.rolling(5).mean().iloc[-1]), 0)
        ma25 = round(float(close.rolling(25).mean().iloc[-1]), 0)
        ma75 = round(float(close.rolling(75).mean().iloc[-1]), 0)

        rsi14 = round(float(calc_rsi(close, 14)), 1)
        macd  = calc_macd(close)
        boll  = calc_bollinger(close)

        if volume_today > vol_avg * 1.3:
            volume = 'high'
        elif volume_today < vol_avg * 0.7:
            volume = 'low'
        else:
            volume = 'normal'

        # レジーム判定
        if price > ma25 and ma25 > ma75:
            regime = 'bull'
        elif price < ma25 and ma25 < ma75:
            regime = 'bear'
        else:
            regime = 'neutral'

        print(f"  ✓ 日経225: {price:,.0f}円 ({chg:+.0f} / {chg_pct:+.2f}%)")

        # 日経先物（利用可能なティッカーから順に取得）
        futures_price = price
        futures_chg = chg
        futures_chg_pct = chg_pct
        futures_symbols = ['NIY=F', 'NKD=F', 'N225M.CME']
        for symbol in futures_symbols:
            try:
                f_price, f_chg, f_chg_pct, _ = fetch_price_pack(symbol, period='2mo')
                futures_price = round(f_price, 0)
                futures_chg = round(f_chg, 0)
                futures_chg_pct = round(f_chg_pct, 2)
                print(f"  ✓ 日経先物({symbol}): {futures_price:,.0f}円 ({futures_chg:+.0f} / {futures_chg_pct:+.2f}%)")
                break
            except Exception:
                continue

        # VIX
        vix_val = 20.0
        try:
            vix = yf.Ticker('^VIX')
            vix_hist = vix.history(period='5d')
            if not vix_hist.empty:
                vix_candidate = float(vix_hist['Close'].iloc[-1])
                if not math.isfinite(vix_candidate):
                    raise ValueError("^VIX returned non-finite price data")
                vix_val = round(vix_candidate, 1)
            print(f"  ✓ VIX: {vix_val}")
        except Exception as e:
            print(f"  ⚠ VIX取得失敗: {e} → {vix_val} を使用")

        output = {
            "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M+00:00"),
            "nikkei":       price,
            "nikkeiChg":    chg,
            "nikkeiChgPct": chg_pct,
            "nikkeiFutures": futures_price,
            "nikkeiFuturesChg": futures_chg,
            "nikkeiFuturesChgPct": futures_chg_pct,
            "ma5":          ma5,
            "ma25":         ma25,
            "ma75":         ma75,
            "rsi14":        rsi14,
            "macd":         macd,
            "volume":       volume,
            "bollUpper":    boll['upper'],
            "bollMid":      boll['mid'],
            "bollLower":    boll['lower'],
            "regime":       regime,
            "boj":          "0.50%",
            "bojNext":      "0.75%観測",
            "vix":          vix_val
        }

        write_market_json(output)

        print(f"  ✓ {OUTPUT_PATH} 生成完了")
        return True

    except Exception as e:
        print(f"  ✗ エラー: {e}")
        if OUTPUT_PATH.exists():
            print("  → 既存 market.json を維持")
        else:
            print("  → HTMLは静的JP_MARKETで動作継続")
        return False

if __name__ == '__main__':
    success = main()
    sys.exit(0 if success else 1)
