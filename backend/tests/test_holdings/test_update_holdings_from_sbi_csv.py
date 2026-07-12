"""
Tests for scripts/update_holdings_from_sbi_csv.py
"""
import csv
import io
import json
import sys
import textwrap
from contextlib import redirect_stdout
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[3] / 'scripts'))
from update_holdings_from_sbi_csv import (
    extract_code_name,
    is_stock_section_hdr,
    is_credit_section_hdr,
    load_csv,
    parse_number,
)


# ── ユーティリティ ──────────────────────────────────────────────

def make_csv(rows: list[list[str]], tmp_path: Path, name: str = 'test.csv') -> Path:
    p = tmp_path / name
    with p.open('w', encoding='utf-8', newline='') as f:
        writer = csv.writer(f)
        writer.writerows(rows)
    return p


def make_holdings_json(holdings: list[dict], tmp_path: Path) -> Path:
    p = tmp_path / 'holdings.json'
    data = {'last_updated': '2026-01-01', 'holdings': holdings}
    p.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    return p


# ── parse_number ────────────────────────────────────────────────

class TestParseNumber:
    def test_comma_integer(self):
        assert parse_number('1,234,567') == 1234567.0

    def test_decimal(self):
        assert parse_number('100082.5') == 100082.5

    def test_negative_with_minus(self):
        result = parse_number('-5.2')
        assert result is not None and result < 0

    def test_empty_returns_none(self):
        assert parse_number('') is None

    def test_dash_returns_none(self):
        assert parse_number('-') is None

    def test_already_unquoted_value(self):
        # csv.reader strips quotes before parse_number is called
        assert parse_number('1,500,000') == 1500000.0


# ── extract_code_name ───────────────────────────────────────────

class TestExtractCodeName:
    def test_standard_format(self):
        code, name = extract_code_name('7203 トヨタ自動車')
        assert code == '7203'
        assert 'トヨタ' in name

    def test_fullwidth_name(self):
        code, name = extract_code_name('8306 三菱ＵＦＪ')
        assert code == '8306'

    def test_no_code(self):
        code, name = extract_code_name('銘柄名のみ')
        assert code == ''

    def test_5digit_code(self):
        code, name = extract_code_name('12345 テスト銘柄')
        assert code == '12345'


# ── is_stock_section_hdr ────────────────────────────────────────

class TestIsStockSectionHdr:
    def test_tokutei_stock(self):
        assert is_stock_section_hdr(['株式（現物/特定預り）', '', '', '']) is True

    def test_nisa_stock(self):
        assert is_stock_section_hdr(['株式（現物/NISA預り）', '', '']) is True

    def test_credit_stock_not_matched(self):
        assert is_stock_section_hdr(['株式（信用/特定預り）', '', '']) is False

    def test_trust_not_matched(self):
        assert is_stock_section_hdr(['投資信託（金額/特定預り）', '', '']) is False

    def test_non_sparse_not_matched(self):
        assert is_stock_section_hdr(['7203 トヨタ', '2024-01-01', '100']) is False

    def test_total_row_not_matched(self):
        assert is_stock_section_hdr(['株式(現物/特定預り)合計', '', '']) is False


# ── is_credit_section_hdr ───────────────────────────────────────

class TestIsCreditSectionHdr:
    def test_credit_stock(self):
        assert is_credit_section_hdr(['株式（信用/特定預り）', '', '']) is True

    def test_tokutei_not_matched(self):
        assert is_credit_section_hdr(['株式（現物/特定預り）', '', '']) is False


# ── load_csv (synthetic CSV) ────────────────────────────────────

STOCK_CSV_ROWS = [
    ['株式（現物/特定預り）', '', '', '', '', '', '', '', '', ''],
    ['銘柄（コード）', '買付日', '数量', '取得単価', '現在値', '前日比', '前日比（％）', '損益', '損益（％）', '評価額'],
    ['7203 トヨタ自動車', '2024-01-01', '100', '3000', '3500', '50', '1.45', '50000', '16.67', '350000'],
    ['8306 三菱ＵＦＪ', '2024-02-01', '200', '1200', '1400', '10', '0.72', '40000', '16.67', '280000'],
    ['株式(現物/特定預り)合計', '', '', '', '', '', '', '', '', ''],
    ['投資信託（金額/特定預り）', '', '', '', '', '', '', '', '', ''],
    ['ファンド名', '買付日', '数量', '取得単価', '現在値', '前日比', '前日比（％）', '損益', '損益（％）', '評価額'],
    ['iFreeNEXT FANG+インデックス', '2024-01-01', '1000', '4000', '4500', '-100', '-2.17', '500000', '12.5', '4500000'],
    ['投資信託(金額/特定預り)合計', '', '', '', '', '', '', '', '', ''],
    ['総合計', '', '', '', '', '', '', '', '', ''],
]

CREDIT_CSV_ROWS = [
    ['株式（現物/特定預り）', '', '', '', '', '', '', '', '', ''],
    ['銘柄（コード）', '買付日', '数量', '取得単価', '現在値', '前日比', '前日比（％）', '損益', '損益（％）', '評価額'],
    ['7203 トヨタ自動車', '2024-01-01', '100', '3000', '3500', '50', '1.45', '50000', '16.67', '350000'],
    ['株式(現物/特定預り)合計', '', '', '', '', '', '', '', '', ''],
    ['株式（信用/特定預り）', '', '', '', '', '', '', '', '', ''],
    ['銘柄（コード）', '買付日', '数量', '取得単価', '現在値', '前日比', '前日比（％）', '損益', '損益（％）', '評価額'],
    ['7203 トヨタ自動車信用', '2024-01-01', '50', '3100', '3500', '50', '1.45', '20000', '12.9', '175000'],
    ['株式(現物/特定預り)合計', '', '', '', '', '', '', '', '', ''],
    ['総合計', '', '', '', '', '', '', '', '', ''],
]


class TestLoadCsvStockOnly:
    def test_returns_only_stock_rows(self, tmp_path):
        p = make_csv(STOCK_CSV_ROWS, tmp_path)
        rows, fields, _ = load_csv(p)
        assert len(rows) == 2

    def test_no_trust_rows(self, tmp_path):
        p = make_csv(STOCK_CSV_ROWS, tmp_path)
        rows, _, _ = load_csv(p)
        for r in rows:
            name = r.get(fields[0] if (fields := list(r.keys())) else '', '')
            assert 'FANG' not in name

    def test_codes_extracted(self, tmp_path):
        from update_holdings_from_sbi_csv import extract_code_name
        p = make_csv(STOCK_CSV_ROWS, tmp_path)
        rows, fields, _ = load_csv(p)
        name_col = fields[0]
        codes = [extract_code_name(r[name_col])[0] for r in rows]
        assert '7203' in codes
        assert '8306' in codes

    def test_section_account_assigned(self, tmp_path):
        p = make_csv(STOCK_CSV_ROWS, tmp_path)
        rows, _, _ = load_csv(p)
        for r in rows:
            assert r['_section'] == '特定'

    def test_no_total_rows(self, tmp_path):
        p = make_csv(STOCK_CSV_ROWS, tmp_path)
        rows, _, _ = load_csv(p)
        for r in rows:
            first_val = list(r.values())[0]
            assert '合計' not in str(first_val)

    def test_eval_field_present(self, tmp_path):
        p = make_csv(STOCK_CSV_ROWS, tmp_path)
        rows, fields, _ = load_csv(p)
        assert any('評価額' in f for f in fields)


class TestLoadCsvCreditSkip:
    def test_credit_rows_excluded(self, tmp_path):
        p = make_csv(CREDIT_CSV_ROWS, tmp_path)
        rows, _, credit_sections = load_csv(p)
        # 現物 1行のみ（信用行は除外）
        assert len(rows) == 1

    def test_credit_sections_reported(self, tmp_path):
        p = make_csv(CREDIT_CSV_ROWS, tmp_path)
        _, _, credit_sections = load_csv(p)
        assert len(credit_sections) == 1
        assert '信用' in credit_sections[0]


# ── integration: dry-run ────────────────────────────────────────

class TestDryRun:
    def _run_script(self, args_list: list[str]) -> str:
        import argparse
        from update_holdings_from_sbi_csv import run
        parser = argparse.ArgumentParser()
        parser.add_argument('--input')
        parser.add_argument('--output')
        parser.add_argument('--dry-run', action='store_true')
        args = parser.parse_args(args_list)
        buf = io.StringIO()
        with redirect_stdout(buf):
            run(args)
        return buf.getvalue()

    def test_dry_run_does_not_write(self, tmp_path):
        csv_p = make_csv(STOCK_CSV_ROWS, tmp_path)
        holdings_p = make_holdings_json(
            [{'code': '7203', 'name': 'トヨタ', 'eval': 300000, 'pnlPct': 10.0},
             {'code': '8306', 'name': '三菱UFJ', 'eval': 250000, 'pnlPct': 5.0}],
            tmp_path,
        )
        original_content = holdings_p.read_text()
        self._run_script(['--input', str(csv_p), '--output', str(holdings_p), '--dry-run'])
        assert holdings_p.read_text() == original_content

    def test_dry_run_reports_can_update(self, tmp_path):
        csv_p = make_csv(STOCK_CSV_ROWS, tmp_path)
        holdings_p = make_holdings_json(
            [{'code': '7203', 'name': 'トヨタ', 'eval': 300000, 'pnlPct': 10.0},
             {'code': '8306', 'name': '三菱UFJ', 'eval': 250000, 'pnlPct': 5.0}],
            tmp_path,
        )
        out = self._run_script(['--input', str(csv_p), '--output', str(holdings_p), '--dry-run'])
        assert '本番更新可能か: はい' in out

    def test_dry_run_shows_matched_count(self, tmp_path):
        csv_p = make_csv(STOCK_CSV_ROWS, tmp_path)
        holdings_p = make_holdings_json(
            [{'code': '7203', 'name': 'トヨタ', 'eval': 300000, 'pnlPct': 10.0},
             {'code': '8306', 'name': '三菱UFJ', 'eval': 250000, 'pnlPct': 5.0}],
            tmp_path,
        )
        out = self._run_script(['--input', str(csv_p), '--output', str(holdings_p), '--dry-run'])
        assert 'マッチ:' in out
        assert '2 / 2' in out

    def test_dry_run_detects_csv_only(self, tmp_path):
        csv_p = make_csv(STOCK_CSV_ROWS, tmp_path)
        # masterには7203のみ → 8306はCSV-only
        holdings_p = make_holdings_json(
            [{'code': '7203', 'name': 'トヨタ', 'eval': 300000, 'pnlPct': 10.0}],
            tmp_path,
        )
        out = self._run_script(['--input', str(csv_p), '--output', str(holdings_p), '--dry-run'])
        assert 'CSV-only' in out
        assert '8306' in out

    def test_dry_run_detects_master_only(self, tmp_path):
        csv_p = make_csv(STOCK_CSV_ROWS, tmp_path)
        # masterに9999（CSVに存在しない）→ master-only
        holdings_p = make_holdings_json(
            [{'code': '7203', 'name': 'トヨタ', 'eval': 300000, 'pnlPct': 10.0},
             {'code': '8306', 'name': '三菱UFJ', 'eval': 250000, 'pnlPct': 5.0},
             {'code': '9999', 'name': '存在しない', 'eval': 100000, 'pnlPct': 0.0}],
            tmp_path,
        )
        out = self._run_script(['--input', str(csv_p), '--output', str(holdings_p), '--dry-run'])
        assert 'master-only' in out
        assert '9999' in out

    def test_master_only_blocks_live_update(self, tmp_path):
        csv_p = make_csv(STOCK_CSV_ROWS, tmp_path)
        holdings_p = make_holdings_json(
            [{'code': '7203', 'name': 'トヨタ', 'eval': 300000, 'pnlPct': 10.0},
             {'code': '9999', 'name': '存在しない', 'eval': 100000, 'pnlPct': 0.0}],
            tmp_path,
        )
        with pytest.raises(SystemExit) as exc:
            from update_holdings_from_sbi_csv import run
            import argparse
            parser = argparse.ArgumentParser()
            parser.add_argument('--input')
            parser.add_argument('--output')
            parser.add_argument('--dry-run', action='store_true')
            args = parser.parse_args(['--input', str(csv_p), '--output', str(holdings_p)])
            buf = io.StringIO()
            with redirect_stdout(buf):
                run(args)
        assert exc.value.code == 1


class TestLiveUpdate:
    def test_live_update_writes_file(self, tmp_path):
        csv_p = make_csv(STOCK_CSV_ROWS, tmp_path)
        holdings_p = make_holdings_json(
            [{'code': '7203', 'name': 'トヨタ', 'eval': 300000, 'pnlPct': 10.0},
             {'code': '8306', 'name': '三菱UFJ', 'eval': 250000, 'pnlPct': 5.0}],
            tmp_path,
        )
        from update_holdings_from_sbi_csv import run
        import argparse
        parser = argparse.ArgumentParser()
        parser.add_argument('--input')
        parser.add_argument('--output')
        parser.add_argument('--dry-run', action='store_true')
        args = parser.parse_args(['--input', str(csv_p), '--output', str(holdings_p)])
        buf = io.StringIO()
        with redirect_stdout(buf):
            run(args)
        result = json.loads(holdings_p.read_text())
        assert result['source'] == 'sbi_csv'
        assert 'last_updated' in result

    def test_live_update_eval_updated(self, tmp_path):
        csv_p = make_csv(STOCK_CSV_ROWS, tmp_path)
        holdings_p = make_holdings_json(
            [{'code': '7203', 'name': 'トヨタ', 'eval': 300000, 'pnlPct': 10.0},
             {'code': '8306', 'name': '三菱UFJ', 'eval': 250000, 'pnlPct': 5.0}],
            tmp_path,
        )
        from update_holdings_from_sbi_csv import run
        import argparse
        parser = argparse.ArgumentParser()
        parser.add_argument('--input')
        parser.add_argument('--output')
        parser.add_argument('--dry-run', action='store_true')
        args = parser.parse_args(['--input', str(csv_p), '--output', str(holdings_p)])
        buf = io.StringIO()
        with redirect_stdout(buf):
            run(args)
        result = json.loads(holdings_p.read_text())
        toyota = next(h for h in result['holdings'] if h['code'] == '7203')
        assert toyota['eval'] == 350000

    def test_csv_only_does_not_block_update(self, tmp_path):
        csv_p = make_csv(STOCK_CSV_ROWS, tmp_path)
        # masterには7203のみ、CSVには8306も → CSV-only 8306だが更新は成功
        holdings_p = make_holdings_json(
            [{'code': '7203', 'name': 'トヨタ', 'eval': 300000, 'pnlPct': 10.0}],
            tmp_path,
        )
        from update_holdings_from_sbi_csv import run
        import argparse
        parser = argparse.ArgumentParser()
        parser.add_argument('--input')
        parser.add_argument('--output')
        parser.add_argument('--dry-run', action='store_true')
        args = parser.parse_args(['--input', str(csv_p), '--output', str(holdings_p)])
        buf = io.StringIO()
        with redirect_stdout(buf):
            run(args)
        result = json.loads(holdings_p.read_text())
        assert result['source'] == 'sbi_csv'
        assert len(result['holdings']) == 1  # 8306 は追加されない
