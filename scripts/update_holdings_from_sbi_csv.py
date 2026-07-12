#!/usr/bin/env python3
"""
SBI一括CSV → public/data/holdings.json 更新スクリプト

使用例:
  python3 scripts/update_holdings_from_sbi_csv.py \\
    --input data/private/sbi/trust_holdings.csv \\
    --output public/data/holdings.json \\
    --dry-run

  python3 scripts/update_holdings_from_sbi_csv.py \\
    --input data/private/sbi/trust_holdings.csv \\
    --output public/data/holdings.json

注意:
  - raw CSVはGit管理しない (data/private/ は .gitignore 済み)
  - 株式（現物/特定預り）セクションのみを対象とする
  - 株式（現物/NISA預り）セクションも対応（見つかれば読み取る）
  - 株式（信用）は読み飛ばす
  - 投資信託セクションは一切触らない
  - 全マスター銘柄がCSVに存在する場合のみ source: sbi_csv と last_updated を更新する
  - 未マッチ（master-only）がある場合は exit(1)
  - CSV-only銘柄があってもエラーにしない（新規取得銘柄の可能性があるため）
"""

import argparse
import csv
import json
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

JST = timezone(timedelta(hours=9))


def parse_number(val) -> float | None:
    """数値文字列をfloatに変換。カンマ・円・%・+・▲・全角マイナスを除去。"""
    if val is None:
        return None
    s = str(val).strip()
    if s in ('', '-', '−', '▲', 'N/A', 'ー', '—', '―'):
        return None
    cleaned = re.sub(r'[,，¥\\+%円\s]', '', s)
    cleaned = cleaned.replace('−', '-').replace('▲', '-')
    try:
        return float(cleaned)
    except ValueError:
        return None


def is_stock_section_hdr(cells: list[str]) -> bool:
    """
    株式（現物）セクションヘッダー行を判定する。
    条件: sparse行(non_empty==1) かつ '株式' と '現物' を含み '信用' と '合計' を含まない。
    """
    non_empty = sum(1 for c in cells if c)
    if non_empty != 1:
        return False
    first = cells[0]
    return '株式' in first and '現物' in first and '信用' not in first and '合計' not in first


def is_credit_section_hdr(cells: list[str]) -> bool:
    """株式（信用）セクションヘッダー行を判定する。"""
    non_empty = sum(1 for c in cells if c)
    if non_empty != 1:
        return False
    first = cells[0]
    return '株式' in first and '信用' in first


def load_csv(path: Path) -> tuple[list[dict], list[str]]:
    """
    SBI一括CSVから株式（現物）セクションのデータ行を読み込む。

    Returns:
        (data_rows, fieldnames)
        data_rows: 各行を dict (fieldnames をキー) にしたリスト。
                   '_section' キーに口座区分を付与する。
        fieldnames: 検出したフィールド名リスト
    """
    # エンコーディング: SBI証券のCSVはcp932
    encodings_to_try = ['cp932', 'utf-8-sig', 'utf-8']
    raw_rows: list[list[str]] = []
    for enc in encodings_to_try:
        try:
            with open(path, encoding=enc, newline='') as f:
                reader = csv.reader(f)
                raw_rows = [[str(c).strip() for c in row] for row in reader]
            break
        except UnicodeDecodeError:
            continue

    if not raw_rows:
        print(f'[ERROR] CSVを読み込めませんでした: {path}', file=sys.stderr)
        sys.exit(1)

    # プリアンブル行（非スパース、かつ「ポートフォリオ」等の管理行）をスキップして
    # セクション分割方式で株式行を収集する
    data_rows: list[dict] = []
    all_fieldnames: list[str] = []

    current_stock_account: str | None = None  # 現在の株式口座区分
    section_fields: list[str] | None = None    # 現在セクションのフィールド名
    credit_skip = False                         # 信用セクション中はスキップ

    credit_sections_found: list[str] = []

    for row in raw_rows:
        cells = [str(c).strip() for c in row]
        if not any(cells):
            continue

        non_empty = sum(1 for c in cells if c)
        first = cells[0]

        if non_empty == 1:
            # 合計行・総合計行 → セクション終了
            if '合計' in first or '総合計' in first:
                current_stock_account = None
                section_fields = None
                credit_skip = False
                continue

            # 信用セクション → スキップ対象
            if is_credit_section_hdr(cells):
                credit_skip = True
                current_stock_account = None
                section_fields = None
                credit_sections_found.append(first)
                continue

            # 株式（現物）セクション → 口座区分を特定
            if is_stock_section_hdr(cells):
                credit_skip = False
                section_fields = None
                # 口座区分を判定
                if 'NISA' in first and 'つみたて' in first:
                    current_stock_account = '積立NISA'
                elif 'NISA' in first:
                    current_stock_account = 'NISA'
                else:
                    current_stock_account = '特定'
                continue

            # 投資信託セクション・その他 → 株式モード終了
            current_stock_account = None
            section_fields = None
            continue

        # データ/ヘッダー行
        if credit_skip:
            continue
        if current_stock_account is None:
            continue

        # フィールド行（最初の dense 行）
        if section_fields is None:
            section_fields = cells
            if not all_fieldnames:
                all_fieldnames = section_fields
            continue

        # データ行
        row_dict = dict(zip(section_fields, cells))
        row_dict['_section'] = current_stock_account
        data_rows.append(row_dict)

    return data_rows, all_fieldnames, credit_sections_found


def extract_code_name(raw_cell: str) -> tuple[str, str]:
    """
    '7203 トヨタ自動車' → ('7203', 'トヨタ自動車')
    コードが見つからなければ ('', raw_cell) を返す。
    """
    m = re.match(r'^(\d{4,5})\s+(.+)$', raw_cell.strip())
    if m:
        return m.group(1), m.group(2).strip()
    return '', raw_cell.strip()


def run(args: argparse.Namespace) -> None:
    input_path  = Path(args.input)
    output_path = Path(args.output)

    now_str = datetime.now(JST).isoformat(timespec='seconds')
    print(f'[{now_str[:16]}] SBI個別株CSV取込 開始')
    print(f'  入力: {input_path}')
    print(f'  出力: {output_path}')

    # ── 1. CSV読み込み ─────────────────────────────────────────
    csv_rows, fieldnames, credit_sections = load_csv(input_path)

    if credit_sections:
        print(f'  ℹ 信用セクション（読み飛ばし）: {credit_sections}')

    # フィールド名から列インデックスを特定
    def find_col(header: list[str], keywords: list[str]) -> str | None:
        for kw in keywords:
            for h in header:
                if kw in h:
                    return h
        return None

    eval_col    = find_col(fieldnames, ['評価額'])
    pnl_pct_col = find_col(fieldnames, ['損益（％）', '損益(%)', '損益率'])
    price_col   = find_col(fieldnames, ['現在値'])
    name_col    = find_col(fieldnames, ['銘柄（コード）', '銘柄(コード)', '銘柄'])

    print(f'  CSV行数: {len(csv_rows)}')

    # コード別に集約（同一コードが複数セクションにある場合は評価額を合算）
    code_data: dict[str, dict] = {}
    for row in csv_rows:
        raw_name = row.get(name_col or '', '') if name_col else row.get(fieldnames[0], '')
        code, name = extract_code_name(raw_name)
        if not code:
            continue

        eval_val    = parse_number(row.get(eval_col, ''))    if eval_col    else None
        pnl_pct_val = parse_number(row.get(pnl_pct_col, '')) if pnl_pct_col else None
        price_val   = parse_number(row.get(price_col, ''))   if price_col   else None

        if code in code_data:
            # 同一コード: evalを合算、pnlPct/priceは最後の値を採用
            if eval_val is not None:
                code_data[code]['eval'] = (code_data[code]['eval'] or 0) + eval_val
        else:
            code_data[code] = {
                'code':    code,
                'name':    name,
                'eval':    eval_val,
                'pnlPct':  pnl_pct_val,
                'price':   price_val,
                'account': row.get('_section', '特定'),
            }

    csv_eval_total = sum(v['eval'] or 0 for v in code_data.values())

    # ── 2. holdings.json 読み込み ──────────────────────────────
    existing = json.loads(output_path.read_text(encoding='utf-8'))
    master_holdings: list[dict] = existing.get('holdings', [])
    master_codes = {h['code'] for h in master_holdings}
    csv_codes    = set(code_data.keys())

    master_eval_total = sum(h.get('eval', 0) for h in master_holdings)

    print(f'  既存銘柄数: {len(master_holdings)}')
    print(f'  既存評価額合計: {master_eval_total:,.0f} 円')
    print()

    # ── 3. マッチング ──────────────────────────────────────────
    matched_codes   = master_codes & csv_codes
    csv_only_codes  = csv_codes    - master_codes
    master_only_codes = master_codes - csv_codes

    # ── 4. サマリー表示 ────────────────────────────────────────
    print(f'  CSV銘柄数: {len(code_data)}')
    print(f'  CSV株式評価額合計: {csv_eval_total:,} 円')
    print()

    for code in sorted(matched_codes):
        m = existing['holdings']
        old_eval = next((h['eval'] for h in m if h['code'] == code), 0)
        new_eval = code_data[code]['eval'] or 0
        print(f'  ✓ [{code:6s}] 評価額: {old_eval:>12,.0f} → {new_eval:>12,}')

    print()
    print(f'  ─── 結果サマリー ───────────────────────────────────')
    print(f'  マッチ:       {len(matched_codes)} / {len(master_holdings)} 銘柄')
    print(f'  未マッチ:     {len(master_only_codes)} 件')
    print(f'  CSV-only:     {len(csv_only_codes)} 件')
    print(f'  評価額合計:   {master_eval_total:>15,.0f} 円 (更新前)')
    print(f'               {csv_eval_total:>15,} 円 (更新後)')
    print(f'  差分:         {csv_eval_total - master_eval_total:>+15,.0f} 円')
    print(f'  ────────────────────────────────────────────────────')
    print()

    if master_only_codes:
        print(f'  ✗ master-only（CSVに存在しない）: {sorted(master_only_codes)}')
        for code in sorted(master_only_codes):
            h = next(h for h in master_holdings if h['code'] == code)
            print(f'    {code}: {h.get("name", "?")}')

    if csv_only_codes:
        print(f'  ℹ CSV-only（holdings.jsonに未登録）: {sorted(csv_only_codes)}')
        for code in sorted(csv_only_codes):
            d = code_data[code]
            print(f'    {code}: {d["name"]} — 候補ID: stock_{code}')

    has_problem = len(master_only_codes) > 0
    can_update = not has_problem

    print()
    if args.dry_run:
        print(f'[dry-run] 未マッチ (master-only): {len(master_only_codes)} 件')
        print(f'[dry-run] CSV-only:                {len(csv_only_codes)} 件')
        print(f'[dry-run] 本番更新可能か: {"はい" if can_update else "いいえ"}')
        print(f'[dry-run] last_updated: {now_str}')
        print(f'[dry-run] 書き込みをスキップしました。')
        return

    if has_problem:
        print(f'[ERROR] master-only銘柄があるため更新できません: {sorted(master_only_codes)}')
        print('  holdings.jsonから銘柄を削除するか、CSVを確認してください。')
        sys.exit(1)

    # ── 5. holdings.json 更新 ──────────────────────────────────
    updated_holdings = []
    for h in master_holdings:
        code = h['code']
        if code in code_data:
            d = code_data[code]
            updated = dict(h)
            if d['eval'] is not None:
                updated['eval'] = d['eval']
            if d['pnlPct'] is not None:
                updated['pnlPct'] = round(d['pnlPct'], 2)
            if d['price'] is not None:
                updated['price'] = d['price']
            updated_holdings.append(updated)
        else:
            updated_holdings.append(h)

    output_data = {
        'last_updated': now_str,
        'source': 'sbi_csv',
        'holdings': updated_holdings,
    }

    output_path.write_text(
        json.dumps(output_data, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8',
    )
    print(f'  ✓ {output_path} を更新しました。')
    print(f'  last_updated: {now_str}')
    print(f'  source: sbi_csv')


def main() -> None:
    parser = argparse.ArgumentParser(description='SBI一括CSV → holdings.json 更新')
    parser.add_argument('--input',   required=True, help='SBI一括CSVファイルパス')
    parser.add_argument('--output',  required=True, help='holdings.jsonファイルパス')
    parser.add_argument('--dry-run', action='store_true', help='書き込みなし（確認のみ）')
    args = parser.parse_args()
    run(args)


if __name__ == '__main__':
    main()
