#!/usr/bin/env python3
"""
SBI証券 CSVパーサー
使用: python3 data/parse_sbi.py path/to/portfolio.csv
出力: data/holdings.json
"""
import pandas as pd, json, sys, re
from pathlib import Path
from datetime import datetime

OUTPUT_PATH = Path(__file__).parent / 'holdings.json'

# SBI CSVの列名マッピング（CSV構造が変わった場合に更新）
COL_MAP = {
    '銘柄コード': 'code',
    '銘柄名':    'name',
    '評価額':    'eval',
    '損益':      'pnl',
    '損益率':    'pnlPct',
    '取得単価':  'cost_price',
    '現在値':    'price',
    '数量':      'qty',
}


def parse_number(val):
    if pd.isna(val): return None
    return float(re.sub(r'[,+%円]', '', str(val)))


def main(csv_path: str):
    print(f"[{datetime.now():%Y-%m-%d %H:%M}] SBI CSV パース開始: {csv_path}")

    for enc in ('shift_jis', 'cp932', 'utf-8-sig', 'utf-8'):
        try:
            df = pd.read_csv(csv_path, encoding=enc, skiprows=8)
            break
        except UnicodeDecodeError:
            continue
    else:
        print("  ✗ エンコーディング検出失敗。終了。")
        sys.exit(1)

    # 列名自動検出
    found_cols = {}
    for jp_col, eng_col in COL_MAP.items():
        matched = [c for c in df.columns if jp_col in str(c)]
        if matched:
            found_cols[matched[0]] = eng_col

    if 'code' not in found_cols.values():
        print("  ✗ 銘柄コード列が見つかりません。終了。")
        sys.exit(1)

    df = df.rename(columns=found_cols)
    holdings = []
    for _, row in df.iterrows():
        try:
            code = str(row.get('code', '')).strip().replace('.T', '')[:4]
            if not code.isdigit(): continue
            holdings.append({
                "code":   code,
                "name":   str(row.get('name', ''))[:20],
                "eval":   parse_number(row.get('eval')),
                "pnlPct": parse_number(row.get('pnlPct')),
                "price":  parse_number(row.get('price')),
            })
        except Exception as e:
            print(f"  ⚠ スキップ: {e}")

    output = {"last_updated": datetime.now().strftime("%Y-%m-%d"),
               "holdings": [h for h in holdings if h['eval']]}

    with open(OUTPUT_PATH, 'w') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"  ✓ {len(output['holdings'])}件 → {OUTPUT_PATH}")


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'SBI_CSV/portfolio.csv')
