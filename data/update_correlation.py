#!/usr/bin/env python3
"""
JP株OS — 相関行列自動生成スクリプト
使用: python3 data/update_correlation.py
出力: data/correlation.json
"""
import yfinance as yf
import pandas as pd
import json, numpy as np, sys, os
from pathlib import Path
from datetime import datetime

# 保有銘柄 16銘柄（index.html の HOLDINGS と一致させること）
TICKERS = [
    '6098.T',  # リクルートHD
    '8306.T',  # 三菱UFJ
    '9697.T',  # カプコン
    '4661.T',  # OLC
    '8593.T',  # 三菱HC
    '4755.T',  # 楽天G
    '5711.T',  # 三菱マテリアル
    '1605.T',  # INPEX
    '5016.T',  # JX金属
    '8058.T',  # 三菱商事
    '9418.T',  # U-NEXT
    '1928.T',  # 積水ハウス
    '7011.T',  # 三菱重工
    '7974.T',  # 任天堂
    '9433.T',  # KDDI
    '7012.T',  # 川崎重工
]

OUTPUT_PATH = Path(__file__).parent / 'correlation.json'
BACKUP_PATH = Path(__file__).parent / 'correlation_backup.json'


def main():
    print(f"[{datetime.now():%Y-%m-%d %H:%M}] 相関行列生成開始")

    # 既存ファイルをバックアップ
    if OUTPUT_PATH.exists():
        import shutil
        shutil.copy(OUTPUT_PATH, BACKUP_PATH)

    try:
        # yfinanceで52週データ取得
        print(f"  → {len(TICKERS)}銘柄 取得中...")
        raw = yf.download(TICKERS, period="52wk", progress=False)

        if raw.empty:
            raise ValueError("データ取得失敗: yfinanceが空を返しました")

        data = raw['Close'] if 'Close' in raw.columns.get_level_values(0) else raw

        # 全行NaNのカラム（取得失敗銘柄）を除外してからpct_change
        data = data.dropna(axis=1, how='all')
        ret  = data.pct_change().dropna(how='all')

        # 欠損銘柄の確認（取得できた銘柄のみで相関計算）
        missing = [t for t in TICKERS if t not in data.columns]
        if missing:
            print(f"  ⚠ 取得失敗銘柄: {missing}")

        corr_matrix = ret.corr(min_periods=20)
        vols        = (ret.std() * np.sqrt(252)).to_dict()

        output = {
            "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "period": "52w",
            "tickers": [t for t in TICKERS if t not in missing],
            "matrix": corr_matrix.to_dict(),
            "volatilities": vols,
            "status": "ok"
        }

        with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
            json.dump(output, f, ensure_ascii=False, indent=2)

        print(f"  ✓ {OUTPUT_PATH} 生成完了")
        print(f"  ✓ 銘柄数: {len(corr_matrix)}")
        print(f"  ✓ 期間: 52週 / サンプル数: {len(ret)}")
        return True

    except Exception as e:
        print(f"  ✗ エラー: {e}")
        # バックアップを復元
        if BACKUP_PATH.exists():
            import shutil
            shutil.copy(BACKUP_PATH, OUTPUT_PATH)
            print("  → バックアップを復元しました")
        else:
            print("  → バックアップなし: HTMLは静的相関行列で動作継続")
        return False


if __name__ == '__main__':
    success = main()
    sys.exit(0 if success else 1)
