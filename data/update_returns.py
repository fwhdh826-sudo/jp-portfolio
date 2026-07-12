#!/usr/bin/env python3
"""
JP株OS — per-ticker daily returns 上流生成スクリプト（returns upstream）
使用: python3 data/update_returns.py
出力: data/returns.json

目的:
  Phase 8 hard gap である returns_data / dd10_returns の上流データ源。
  data/update_correlation.py の yfinance 取得処理を mirror し、相関 matrix
  ではなく per-ticker daily return 系列を永続化する
  （update_correlation.py は ret.corr() のみ保存し系列を破棄していた）。

方針（handover.md "returns系列 upstream Card 設計記録" 準拠）:
  - JP equity 16 銘柄限定（update_correlation.py の TICKERS を複製。
    共通化は後続 consolidation）。ticker 形式は NNNN.T（東証）。
  - frequency = daily（daily-as-is）。period = "52wk"。
    monthly resample は後続改善候補（FrontierStrategy docstring の月次
    想定とのズレは本 _meta / handover で透明化）。
  - fund / overseas fund（投信・海外投信）は yfinance ticker が無いため
    **本スクリプトの対象外**。fund returns gap は継続（別経路）。
  - yfinance / pandas / numpy は既に CI 導入済み（update-data.yml）。
    新規外部依存なし。
  - rollback: 既存 data/returns.json があれば再生成前に
    data/returns_backup.json へ backup-copy。取得失敗時は backup を
    復元し、空データで本番値を上書きしない。
  - 欠損銘柄は捏造しない。取得失敗 / 全欠損 / 系列空は missing に記録。
  - not_for_trading: true（観察データ・非売買命令、Phase 8 は
    calculation-only 消費）。

注意:
  本スクリプトは生成専用 CLI。GitHub Actions 接続（update-data.yml への
  step 追加 + cp + bot commit）は P2-D5 系の別 Card。
  backend returns_resolver（returns JSON → Phase 8 producer DI 整形）は
  別 Card。public/data 書き込みは行わない（data/returns.json のみ）。
"""
import yfinance as yf
import pandas as pd
import json, numpy as np, sys, os
from pathlib import Path
from datetime import datetime

# JP株 16銘柄（data/update_correlation.py の TICKERS と一致させること。
# 共通化は後続 consolidation Card。index.html の HOLDINGS とも一致）
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

OUTPUT_PATH = Path(__file__).parent / 'returns.json'
BACKUP_PATH = Path(__file__).parent / 'returns_backup.json'

PERIOD = "52wk"
FREQUENCY = "daily"
LOOKBACK = "52w"
META_VERSION = "v13.3"
META_KIND = "returns_daily"
META_SOURCE = "yfinance"


def main():
    print(f"[{datetime.now():%Y-%m-%d %H:%M}] per-ticker returns 生成開始")

    # 既存ファイルをバックアップ
    if OUTPUT_PATH.exists():
        import shutil
        shutil.copy(OUTPUT_PATH, BACKUP_PATH)

    try:
        # yfinanceで52週データ取得
        print(f"  → {len(TICKERS)}銘柄 取得中...")
        raw = yf.download(TICKERS, period=PERIOD, progress=False)

        if raw.empty:
            raise ValueError("データ取得失敗: yfinanceが空を返しました")

        data = raw['Close'] if 'Close' in raw.columns.get_level_values(0) else raw

        # 全行NaNのカラム（取得失敗銘柄）を除外してからpct_change
        data = data.dropna(axis=1, how='all')
        ret = data.pct_change().dropna(how='all')

        # per-ticker return 系列を構築（NaN は ticker 単位で除外、捏造しない）
        returns: dict[str, list[float]] = {}
        for t in TICKERS:
            if t not in ret.columns:
                continue
            series = [float(x) for x in ret[t].dropna().tolist()]
            if series:
                returns[t] = series

        fetched = list(returns.keys())
        missing = [t for t in TICKERS if t not in returns]
        if missing:
            print(f"  ⚠ 取得失敗 / 系列空 銘柄: {missing}")

        now_iso = datetime.now().isoformat()
        output = {
            "_meta": {
                "version": META_VERSION,
                "kind": META_KIND,
                "source": META_SOURCE,
                "generated_at": now_iso,
                "not_for_trading": True,
            },
            "last_updated": now_iso,
            "frequency": FREQUENCY,
            "lookback": LOOKBACK,
            "tickers": fetched,
            "missing": missing,
            "returns": returns,
            "status": "ok",
        }

        with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
            json.dump(output, f, ensure_ascii=False, indent=2)

        print(f"  ✓ {OUTPUT_PATH} 生成完了")
        print(f"  ✓ 銘柄数: {len(fetched)} / missing: {len(missing)}")
        print(f"  ✓ 期間: 52週 daily / サンプル数: {len(ret)}")
        return True

    except Exception as e:
        print(f"  ✗ エラー: {e}")
        # バックアップを復元（空データで本番値を上書きしない）
        if BACKUP_PATH.exists():
            import shutil
            shutil.copy(BACKUP_PATH, OUTPUT_PATH)
            print("  → バックアップを復元しました")
        else:
            print("  → バックアップなし: 既存returnsなし / 後続は missing-safe")
        return False


if __name__ == '__main__':
    success = main()
    sys.exit(0 if success else 1)
