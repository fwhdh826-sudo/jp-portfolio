#!/usr/bin/env python3
"""
SBI投資信託CSV → trust_master.json 更新スクリプト

使用例:
  python3 scripts/update_trust_from_sbi_csv.py \\
    --input data/private/sbi/trust_holdings.csv \\
    --output public/data/trust_master.json

  python3 scripts/update_trust_from_sbi_csv.py \\
    --input data/private/sbi/trust_holdings.csv \\
    --output public/data/trust_master.json \\
    --dry-run

  python3 scripts/update_trust_from_sbi_csv.py \\
    --input data/private/sbi/trust_holdings.csv \\
    --output public/data/trust_master.json \\
    --allow-partial

注意:
  - raw CSVはGit管理しない (data/private/ は .gitignore 済み)
  - 全ファンドがマッチした場合のみ source: sbi_csv と last_updated を更新する
  - 未マッチ or 曖昧マッチ or skipped_active がある場合、--allow-partial なし non-dry-run は exit(1)
  - csv_name が空かつ eval > 0 のファンドは skipped_active として検出 (古い評価額が残る恐れあり)
  - csv_name が空かつ eval == 0 のファンドは安全スキップ（評価なし/解約済み）
  - SBI CSVには口座列がなく「特定預り」「成長投資枠」「つみたて投資枠」のセクションヘッダーで
    口座区分を特定する。load_csv() が各行に _section_account を付与する。
"""

import argparse
import csv
import json
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

JST = timezone(timedelta(hours=9))

# SBI CSV 列名マッピング（部分一致で検出）
# 注意: day_pct / pnl_pct は「%列」を優先し絶対値列と区別する
COL_PATTERNS: dict[str, list[str]] = {
    'fund_name': ['ファンド名', '銘柄名', '銘柄', 'ファンド', '商品名'],
    'account':   ['口座', '預り区分', '取引区分', 'アカウント'],
    'eval':      ['評価額'],
    'pnl':       ['評価損益', '損益額', '損益'],   # '損益' は最後（最も非限定的）
    'pnl_pct':   ['損益率', '評価損益率', '損益(%)'],
    'day_pct':   ['前日比(%', '前日騰落率', '前日変化率', '前日比'],  # %列を優先、絶対値列にフォールバック
}


def normalize_str(s: str) -> str:
    """全角英数字・記号→半角、前後空白除去。"""
    result = []
    for c in s:
        code = ord(c)
        if 0xFF01 <= code <= 0xFF5E:
            result.append(chr(code - 0xFEE0))
        else:
            result.append(c)
    return ''.join(result).strip()


def parse_number(val) -> float | None:
    """数値文字列をfloatに変換。カンマ・円・%・+・▲・全角マイナスを除去。"""
    if val is None:
        return None
    s = str(val).strip()
    if s in ('', '-', '−', '▲', 'N/A', 'ー', '—', '―', 'ﾊｲﾌﾝ'):
        return None
    cleaned = re.sub(r'[,，¥\\+%円\s]', '', s)
    cleaned = cleaned.replace('−', '-').replace('▲', '-')
    try:
        return float(cleaned)
    except ValueError:
        return None


def detect_column(columns: list[str], patterns: list[str]) -> str | None:
    """
    列名リストからパターンにマッチした列名を返す。
    パターンリストの先頭ほど優先度が高い（パターン優先ループ）。
    これにより '前日比(%' を '前日比' より優先できる。
    """
    normalized = [normalize_str(c) for c in columns]
    for pat in patterns:           # outer: pattern priority order
        for i, col_n in enumerate(normalized):   # inner: columns
            if pat in col_n:
                return columns[i]
    return None


# ヘッダー行検出用キーワードグループ（2グループ以上マッチ → ヘッダー行と判定）
_HEADER_KEYWORD_GROUPS: list[list[str]] = [
    ['ファンド名', '銘柄名', '銘柄', '商品名', '名称'],
    ['口座', '預り区分', '取引区分'],
    ['評価額', '評価金額', '時価評価額'],
    ['評価損益', '損益額', '損益'],
    ['損益率', '評価損益率'],
    ['前日比', '騰落率', '前日比率'],
]


def detect_header_row(raw_rows: list[list[str]]) -> int:
    """
    先頭からスキャンして「本当のヘッダー行」のインデックスを返す。
    キーワードグループへの一致数が 2 以上の最初の行をヘッダーとみなす。
    見つからなければ -1 を返す。
    """
    for i, row in enumerate(raw_rows):
        normalized = [normalize_str(str(cell)) for cell in row]
        match_count = sum(
            1 for kw_group in _HEADER_KEYWORD_GROUPS
            if any(any(kw in cell for kw in kw_group) for cell in normalized)
        )
        if match_count >= 2:
            return i
    return -1


# SBIポートフォリオCSVのセクションヘッダー → 内部口座区分マッピング
# つみたて投資枠を成長投資枠より先に置く（サブストリング衝突回避）
_SECTION_ACCOUNT_PATTERNS: list[tuple[str, str]] = [
    ('つみたて投資枠', '積立NISA'),
    ('成長投資枠',    'NISA成長'),
    ('旧NISA',       'NISA'),
    ('一般NISA',     'NISA'),
    ('特定預り',      '特定'),
]


def detect_section_account(cell: str) -> str | None:
    """SBIポートフォリオCSVのセクションヘッダー第1セルから内部口座区分を返す。非セクション行はNone。"""
    normalized = normalize_str(cell)
    for pattern, account in _SECTION_ACCOUNT_PATTERNS:
        if pattern in normalized:
            return account
    return None


def load_csv(path: Path) -> tuple[list[dict[str, str]], list[str]]:
    """
    CSVを読み込む。エンコーディングを自動判定し、投資信託セクション専用で処理する。

    2つのフォーマットに対応:
    1. セクションヘッダー形式 (SBI一括CSV):
       「投資信託」を含むセクションヘッダー行が存在する。
       - 株式等の非投信セクションは完全に除外
       - 各投信セクションの直後のヘッダー行をそのセクション専用 fieldnames として使用
       - 合計行・総合計行・空行・ヘッダー行自体はデータ行に含めない
       - 各投信行に _section_account を付与する
    2. レガシー形式 (口座列あり、単一ヘッダー):
       セクションヘッダーがない場合にフォールバック (既存動作を維持)。

    セクション区分:
      「投資信託」を含む → 投信セクション (特定/NISA成長/積立NISA)
      それ以外 (株式・現物等) → 非投信セクション (除外)
      合計行 (「合計」を含む、non_empty==1) → セクション終端マーカー
    """
    for enc in ('utf-8-sig', 'cp932', 'shift_jis', 'utf-8'):
        try:
            with open(path, encoding=enc, newline='') as f:
                content = f.read()
            raw_rows = list(csv.reader(content.splitlines()))
            if not raw_rows:
                return [], []

            # ── フォーマット判定: 投信セクションヘッダーの有無 ────────────────
            def _is_trust_section_hdr(row: list) -> bool:
                cells = [str(c).strip() for c in row]
                non_empty = sum(1 for c in cells if c)
                if non_empty != 1:
                    return False
                first = cells[0]
                return (
                    '合計' not in first
                    and '投資信託' in normalize_str(first)
                    and detect_section_account(first) is not None
                )

            has_trust_sections = any(_is_trust_section_hdr(r) for r in raw_rows)

            if has_trust_sections:
                # ── 新: 投信セクション専用パース ─────────────────────────────
                # 株式等の非投信セクションは完全に除外する。
                # 各投信セクションの直後のヘッダー行をそのセクション専用
                # fieldnames として使用し、データ行に _section_account を付与する。
                data_rows: list[dict[str, str]] = []
                all_fieldnames: list[str] = []
                trust_account: str | None = None    # None = 投信セクション外
                section_fields: list[str] | None = None  # セクション別 fieldnames

                for row in raw_rows:
                    cells = [str(c).strip() for c in row]
                    if not any(cells):
                        continue  # 空行スキップ

                    first = cells[0]
                    non_empty = sum(1 for c in cells if c)

                    # スパース行 (non_empty == 1) = セクションヘッダー候補
                    if non_empty == 1:
                        if '合計' in first or '総合計' in first:
                            # 合計行: 現在の投信セクションを終了
                            trust_account = None
                            section_fields = None
                        else:
                            sa = detect_section_account(first)
                            if sa is not None:
                                if '投資信託' in normalize_str(first):
                                    # 投信セクションヘッダー
                                    trust_account = sa
                                    section_fields = None
                                else:
                                    # 株式等の非投信セクション → 除外
                                    trust_account = None
                                    section_fields = None
                            # else: プリアンブル等、状態変更なし
                        continue  # スパース行はデータ行にならない

                    # 非スパース行: 投信セクション外はスキップ
                    if trust_account is None:
                        continue

                    if section_fields is None:
                        # セクション最初の非スパース行 = セクション専用ヘッダー行
                        section_fields = cells
                        if not all_fieldnames:
                            all_fieldnames = section_fields
                        continue  # ヘッダー行自体はデータ行に含めない

                    # データ行
                    row_dict = dict(zip(section_fields, cells))
                    row_dict['_section_account'] = trust_account
                    data_rows.append(row_dict)

                if not all_fieldnames:
                    print('✗ 投資信託セクションが見つかりません。', file=sys.stderr)
                    print('  CSVに「投資信託」セクションヘッダーが含まれているか確認してください。',
                          file=sys.stderr)
                    sys.exit(1)

                return data_rows, all_fieldnames

            else:
                # ── レガシー: プリアンブル + 単一ヘッダー形式 (既存動作) ─────
                header_idx = detect_header_row(raw_rows)
                if header_idx == -1:
                    preview = [len(r) for r in raw_rows[:10]]
                    print('✗ ヘッダー行が見つかりません。', file=sys.stderr)
                    print(f'  先頭{len(preview)}行の列数: {preview}', file=sys.stderr)
                    print('  CSVにファンド名・評価額等の列が含まれているか確認してください。',
                          file=sys.stderr)
                    sys.exit(1)

                current_section = ''
                section_map: dict[int, str] = {}
                for i, row in enumerate(raw_rows):
                    if not any(str(c).strip() for c in row):
                        continue
                    first_cell = str(row[0]).strip() if row else ''
                    sa = detect_section_account(first_cell)
                    if sa is not None:
                        current_section = sa
                    else:
                        section_map[i] = current_section

                fieldnames = [str(c).strip() for c in raw_rows[header_idx]]
                data_rows_legacy: list[dict[str, str]] = []
                for i, row in enumerate(raw_rows[header_idx + 1:], start=header_idx + 1):
                    if not any(str(c).strip() for c in row):
                        continue
                    if i not in section_map:
                        continue
                    row_dict = dict(zip(fieldnames, (str(c) for c in row)))
                    row_dict['_section_account'] = section_map[i]
                    data_rows_legacy.append(row_dict)

                return data_rows_legacy, fieldnames

        except (UnicodeDecodeError, LookupError):
            continue
        except SystemExit:
            raise
        except Exception as exc:
            print(f'  ✗ CSV読み込みエラー ({enc}): {exc}', file=sys.stderr)
    print(f'✗ エンコーディング検出失敗: {path}', file=sys.stderr)
    sys.exit(1)


# "NISA" (generic) にマッチする口座区分の集合。NISA成長・積立NISAは含まない。
_NISA_GENERIC_ACCOUNTS: frozenset[str] = frozenset({'NISA', '旧NISA', '一般NISA'})


def account_matches(csv_account: str, row_account: str) -> bool:
    """
    csv_account (trust_master) と row_account (CSV行) の口座区分を正規化マッチで比較する。

    ルール:
    - csv_account が空なら True (口座条件なし)
    - 完全一致なら True
    - csv_account == "NISA" かつ row_account が旧NISA / 一般NISA なら True
    - "NISA" が "NISA成長" に部分一致する挙動は禁止 (strict)
    - その他は False
    """
    if not csv_account:
        return True
    if csv_account == row_account:
        return True
    if csv_account == 'NISA' and row_account in _NISA_GENERIC_ACCOUNTS:
        return True
    return False


def _find_match_idx(
    csv_name: str,
    csv_account: str,
    csv_rows: list[dict],
) -> int:
    """csv_name/csv_account でマッチする最初の行インデックスを返す。なければ -1。"""
    if not csv_name:
        return -1
    for i, row in enumerate(csv_rows):
        row_name = normalize_str(row['name'])
        name_match = csv_name in row_name or row_name in csv_name
        if not name_match:
            continue
        row_acct = normalize_str(row['account'])
        if not account_matches(csv_account, row_acct):
            continue
        return i
    return -1


def match_csv_row(
    csv_name: str,
    csv_account: str,
    csv_rows: list[dict],
) -> dict | None:
    """
    csv_name (部分一致) + csv_account (部分一致、空欄なら無視) で CSV行を検索。
    最初にマッチした行を返す。
    """
    idx = _find_match_idx(csv_name, csv_account, csv_rows)
    return csv_rows[idx] if idx >= 0 else None


def main() -> None:
    parser = argparse.ArgumentParser(
        description='SBI投資信託CSV → trust_master.json 更新',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用例:
  python3 scripts/update_trust_from_sbi_csv.py \\
    --input data/private/sbi/trust_holdings.csv \\
    --output public/data/trust_master.json

raw CSVはGit管理しない。data/private/ は .gitignore 対象。
        """,
    )
    parser.add_argument('--input',         required=True, help='SBI投資信託CSV ファイルパス')
    parser.add_argument('--output',        required=True, help='出力先 trust_master.json パス')
    parser.add_argument('--dry-run',       action='store_true', help='変更を書き込まず結果のみ表示')
    parser.add_argument('--allow-partial', action='store_true',
                        help='未マッチ・曖昧マッチがあっても部分更新を実行 (last_updated は partial 扱い)')
    args = parser.parse_args()

    input_path  = Path(args.input)
    output_path = Path(args.output)

    if not input_path.exists():
        print(f"✗ 入力ファイルが見つかりません: {input_path}", file=sys.stderr)
        sys.exit(1)
    if not output_path.exists():
        print(f"✗ 出力ファイルが見つかりません: {output_path}", file=sys.stderr)
        sys.exit(1)

    # 既存 trust_master.json 読み込み
    with open(output_path, encoding='utf-8') as f:
        master: dict = json.load(f)

    if 'funds' not in master:
        print("✗ trust_master.json に funds フィールドがありません。", file=sys.stderr)
        sys.exit(1)

    funds_before = {fund['id']: dict(fund) for fund in master['funds']}
    eval_before  = sum(f.get('eval', 0) for f in master['funds'])

    print(f"[{datetime.now(JST):%Y-%m-%d %H:%M}] SBI投資信託CSV取込 開始")
    print(f"  入力: {input_path}")
    print(f"  出力: {output_path}")
    print(f"  既存ファンド数: {len(funds_before)}")
    print(f"  既存評価額合計: {eval_before:,.0f} 円")
    print()

    # CSV読み込み
    raw_rows, columns = load_csv(input_path)
    if not raw_rows:
        print("✗ CSVが空です。", file=sys.stderr)
        sys.exit(1)

    print(f"  CSV行数 (全体): {len(raw_rows)}")
    print(f"  CSV列: {columns}")
    print()

    # 列検出
    col_fund   = detect_column(columns, COL_PATTERNS['fund_name'])
    col_acct   = detect_column(columns, COL_PATTERNS['account'])
    col_eval   = detect_column(columns, COL_PATTERNS['eval'])
    col_pnl    = detect_column(columns, COL_PATTERNS['pnl'])
    col_pnlpct = detect_column(columns, COL_PATTERNS['pnl_pct'])
    col_daypct = detect_column(columns, COL_PATTERNS['day_pct'])

    if not col_fund:
        print(f"✗ ファンド名列が見つかりません。\n  検出列: {columns}", file=sys.stderr)
        sys.exit(1)
    if not col_eval:
        print(f"✗ 評価額列が見つかりません。\n  検出列: {columns}", file=sys.stderr)
        sys.exit(1)

    print(f"  列マッピング:")
    print(f"    ファンド名 → {col_fund}")
    print(f"    口座       → {col_acct or '(なし → セクションヘッダーから検出)'}")
    print(f"    評価額     → {col_eval}")
    print(f"    損益率     → {col_pnlpct or '(なし)'}")
    print(f"    前日比     → {col_daypct or '(なし)'}")
    print()

    # CSV行を正規化
    csv_rows: list[dict] = []
    for row in raw_rows:
        name     = normalize_str(str(row.get(col_fund, '') or ''))
        eval_val = parse_number(row.get(col_eval))
        if not name or eval_val is None:
            continue
        explicit_acct = normalize_str(str(row.get(col_acct, '') or '')) if col_acct else ''
        section_acct  = normalize_str(row.get('_section_account', ''))
        csv_rows.append({
            'name':    name,
            'account': explicit_acct or section_acct,
            'eval':    eval_val,
            'pnl':     parse_number(row.get(col_pnl))    if col_pnl    else None,
            'pnlPct':  parse_number(row.get(col_pnlpct)) if col_pnlpct else None,
            'dayPct':  parse_number(row.get(col_daypct)) if col_daypct else None,
        })

    if not csv_rows:
        print("✗ 有効なデータ行がありません（評価額が空または0の行を除外）。", file=sys.stderr)
        sys.exit(1)

    print(f"  有効CSV行数: {len(csv_rows)}")
    print()

    # ── フェーズ1: 全ファンドのマッチインデックスを収集し曖昧を検出 ──────────
    row_to_fund_ids: dict[int, list[str]] = {}  # csv行インデックス → ファンドIDリスト
    fund_match_idx:  dict[str, int]       = {}  # ファンドID → csv行インデックス

    for fund in master['funds']:
        fid         = fund['id']
        csv_name    = normalize_str(fund.get('csv_name',    ''))
        csv_account = normalize_str(fund.get('csv_account', ''))
        if not csv_name:
            continue
        idx = _find_match_idx(csv_name, csv_account, csv_rows)
        if idx >= 0:
            fund_match_idx[fid] = idx
            row_to_fund_ids.setdefault(idx, []).append(fid)

    # 同一CSV行に2件以上マッチしたファンドID群
    ambiguous_ids: set[str] = {
        fid
        for ids in row_to_fund_ids.values()
        if len(ids) > 1
        for fid in ids
    }

    # ── CSV-only投信検出 ──────────────────────────────────────────────────────
    # trust_master に登録されていない CSV 投信行を検出する。
    matched_csv_indices: set[int] = set(fund_match_idx.values())
    csv_only_rows: list[dict] = [
        row for i, row in enumerate(csv_rows) if i not in matched_csv_indices
    ]

    # ── フェーズ2: 更新適用 ────────────────────────────────────────────────────
    updated_funds: list[dict] = []
    matched_count      = 0
    unmatched_ids:      list[str] = []
    ambiguous_list:     list[str] = sorted(ambiguous_ids)
    no_csvname_ids:     list[str] = []
    skipped_active_ids: list[str] = []  # csv_name="" かつ eval>0: 古い値が残る恐れあり

    for fund in master['funds']:
        fid         = fund['id']
        csv_name    = normalize_str(fund.get('csv_name',    ''))
        updated_fund = dict(fund)

        if not csv_name:
            no_csvname_ids.append(fid)
            if fund.get('eval', 0) > 0:
                skipped_active_ids.append(fid)
            updated_funds.append(updated_fund)
            continue

        if fid in ambiguous_ids:
            clash = row_to_fund_ids.get(fund_match_idx.get(fid, -1), [])
            print(f"  ✗ [{fid:<14}] 曖昧マッチ (同一CSV行に複数一致: {clash})")
            updated_funds.append(updated_fund)
            continue

        if fid in fund_match_idx:
            matched_row = csv_rows[fund_match_idx[fid]]
            old_eval    = funds_before[fid].get('eval', '?')
            updated_fund['eval'] = int(matched_row['eval'])
            if matched_row['pnlPct'] is not None:
                updated_fund['pnlPct'] = round(matched_row['pnlPct'], 2)
            if matched_row['dayPct'] is not None:
                updated_fund['dayPct'] = round(matched_row['dayPct'], 2)
            matched_count += 1
            old_str = f"{old_eval:>10,.0f}" if isinstance(old_eval, (int, float)) else f"{'?':>10}"
            print(f"  ✓ [{fid:<14}] 評価額: {old_str} → {updated_fund['eval']:>10,}")
        else:
            unmatched_ids.append(fid)
            csv_account = normalize_str(fund.get('csv_account', ''))
            print(f"  ⚠ [{fid:<14}] 未マッチ (csv_name='{csv_name}', csv_account='{csv_account}')")

        updated_funds.append(updated_fund)

    eval_after = sum(f.get('eval', 0) for f in updated_funds)

    print()
    print(f"  ─── 結果サマリー ───────────────────────────────")
    print(f"  マッチ:         {matched_count} / {len(master['funds'])} ファンド")
    print(f"  未マッチ:       {len(unmatched_ids)} 件")
    print(f"  曖昧マッチ:     {len(ambiguous_list)} 件")
    print(f"  csv_name未設定: {len(no_csvname_ids)} 件 (うちeval>0: {len(skipped_active_ids)} 件)")
    print(f"  評価額合計: {eval_before:>15,.0f} 円 (更新前)")
    print(f"             {eval_after:>15,.0f} 円 (更新後)")
    print(f"  ────────────────────────────────────────────────")

    if unmatched_ids:
        print(f"\n  ⚠ 未マッチID: {unmatched_ids}")
        print("    → trust_master.json の csv_name / csv_account を確認してください。")

    if ambiguous_list:
        print(f"\n  ✗ 曖昧マッチID: {ambiguous_list}")
        print("    → 同一CSV行に複数のファンドが一致しています。csv_name を一意にしてください。")

    if no_csvname_ids:
        print(f"\n  ℹ csv_name未設定 (スキップ): {no_csvname_ids}")

    if skipped_active_ids:
        print(f"\n  ✗ skipped_active_ids: {skipped_active_ids}")
        print("    (csv_name未設定かつ eval > 0 — 古い評価額のまま残る恐れあり)")
        print("    → csv_nameを設定するか --allow-partial を指定してください。")

    if csv_only_rows:
        print(f"\n  ℹ CSV-only投信 (trust_master未登録): {len(csv_only_rows)} 件")
        for row in csv_only_rows:
            print(f"    - [{row['account']}] {row['name']}")
        print("    → trust_master.json に csv_name / csv_account を追加してください。")
    else:
        print(f"\n  ✓ CSV-only投信: 0 件")

    if matched_count == 0:
        print("\n✗ マッチしたファンドが0件です。", file=sys.stderr)
        print("  CSV列名またはtrust_master.jsonのcsvNameフィールドを確認してください。", file=sys.stderr)
        sys.exit(1)

    has_problem = (
        len(unmatched_ids) > 0
        or len(ambiguous_list) > 0
        or len(skipped_active_ids) > 0
    )

    # ── 出力JSON組み立て ────────────────────────────────────────────────────────
    update_time  = datetime.now(JST).strftime('%Y-%m-%dT%H:%M:%S+09:00')
    output_data  = dict(master)
    output_data['funds'] = updated_funds

    if not has_problem:
        # 全件安全: 正式更新 (未マッチ0 / 曖昧0 / skipped_active0)
        output_data['last_updated'] = update_time
        output_data['source']       = 'sbi_csv'
        output_data['note']         = 'SBI CSVから手動更新。raw CSVはGit管理しない。'
    elif args.allow_partial:
        # 部分更新モード: 未マッチ/曖昧/skipped_activeのいずれかあり
        problems = []
        if unmatched_ids:      problems.append(f'未マッチ{len(unmatched_ids)}件')
        if ambiguous_list:     problems.append(f'曖昧{len(ambiguous_list)}件')
        if skipped_active_ids: problems.append(f'skipped_active{len(skipped_active_ids)}件')
        output_data['last_updated'] = update_time
        output_data['source']       = 'sbi_csv_partial'
        output_data['note']         = 'SBI CSVから部分更新 (--allow-partial)。' + '・'.join(problems) + 'あり。'

    if args.dry_run:
        print(f"\n[dry-run] csv_name未設定:          {len(no_csvname_ids)} 件")
        print(f"[dry-run] csv_name未設定かつeval>0: {len(skipped_active_ids)} 件")
        print(f"[dry-run] CSV-only投信:             {len(csv_only_rows)} 件")
        if skipped_active_ids:
            print(f"[dry-run] skipped_active_ids:       {skipped_active_ids}")
        if csv_only_rows:
            for row in csv_only_rows:
                print(f"[dry-run]   CSV-only: [{row['account']}] {row['name']}")
        if not has_problem:
            print(f"[dry-run] 本番更新可能か: はい")
            print(f"[dry-run] last_updated: {update_time}")
        else:
            reasons = []
            if unmatched_ids:      reasons.append(f'未マッチ{len(unmatched_ids)}件')
            if ambiguous_list:     reasons.append(f'曖昧{len(ambiguous_list)}件')
            if skipped_active_ids: reasons.append(f'skipped_active{len(skipped_active_ids)}件')
            print(f"[dry-run] 本番更新可能か: いいえ ({' / '.join(reasons)})")
            print("[dry-run]   --allow-partial を指定すると部分更新できます。")
        print("[dry-run] 書き込みをスキップしました。")
        return

    if has_problem and not args.allow_partial:
        print(f"\n✗ 未マッチ {len(unmatched_ids)} 件・曖昧マッチ {len(ambiguous_list)} 件・skipped_active {len(skipped_active_ids)} 件があるため更新を中断しました。", file=sys.stderr)
        print("  trust_master.json の csv_name を設定するか、--allow-partial を指定してください。", file=sys.stderr)
        sys.exit(1)

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, ensure_ascii=False, indent=2)
        f.write('\n')

    print(f"\n  ✓ {output_path} を更新しました。")
    if not has_problem:
        print(f"  last_updated: {update_time}")
        print(f"  source: sbi_csv")
    else:
        print(f"  last_updated: {update_time} (partial)")
        print(f"  source: sbi_csv_partial")


if __name__ == '__main__':
    main()
