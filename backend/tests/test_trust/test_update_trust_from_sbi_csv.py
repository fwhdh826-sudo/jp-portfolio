"""
test_update_trust_from_sbi_csv.py — SBI投資信託CSV取込スクリプト テスト

テスト対象: scripts/update_trust_from_sbi_csv.py
フィクスチャ: backend/tests/test_trust/fixtures/
- sbi_trust_sample_utf8bom.csv        (UTF-8 BOM, 3行, 全角数値あり)
- sbi_trust_sample_with_preamble.csv  (タイトル行・空行付き、ヘッダー検出テスト用)
- trust_master_fixture.json           (4ファンド: 3マッチ + 1未マッチ想定)

すべて synthetic fixture のみ使用 (実データ不使用)。
"""
from __future__ import annotations

import csv
import io
import json
import sys
import textwrap
from pathlib import Path

import pytest

# scripts/ を import 可能にする
REPO_ROOT = Path(__file__).parents[3]
sys.path.insert(0, str(REPO_ROOT / 'scripts'))

from update_trust_from_sbi_csv import (
    account_matches,
    detect_column,
    detect_header_row,
    detect_section_account,
    load_csv,
    match_csv_row,
    normalize_str,
    parse_number,
)

FIXTURES = Path(__file__).parent / 'fixtures'


# ── parse_number ─────────────────────────────────────────────────────────────

class TestParseNumber:
    def test_comma_integer(self):
        assert parse_number('512,345') == 512345.0

    def test_percent(self):
        assert parse_number('3.82%') == pytest.approx(3.82)

    def test_negative_percent(self):
        assert parse_number('-0.15%') == pytest.approx(-0.15)

    def test_fullwidth_minus(self):
        assert parse_number('−1.31') == pytest.approx(-1.31)

    def test_triangle_minus(self):
        assert parse_number('▲2.50') == pytest.approx(-2.50)

    def test_empty_string(self):
        assert parse_number('') is None

    def test_hyphen(self):
        assert parse_number('-') is None

    def test_na(self):
        assert parse_number('N/A') is None

    def test_none_input(self):
        assert parse_number(None) is None

    def test_yen_suffix(self):
        assert parse_number('100円') == 100.0

    def test_plus_prefix(self):
        assert parse_number('+50') == 50.0

    def test_comma_with_yen(self):
        assert parse_number('4,890,000') == 4890000.0


# ── normalize_str ─────────────────────────────────────────────────────────────

class TestNormalizeStr:
    def test_fullwidth_ampersand(self):
        assert normalize_str('Ｓ＆Ｐ５００') == 'S&P500'

    def test_strips_spaces(self):
        assert normalize_str('  FANG+  ') == 'FANG+'

    def test_normal_string(self):
        assert normalize_str('日経225') == '日経225'


# ── detect_column ─────────────────────────────────────────────────────────────

class TestDetectColumn:
    def test_finds_fund_name(self):
        cols = ['ファンド名', '評価額', '口座']
        assert detect_column(cols, ['ファンド名', '銘柄名']) == 'ファンド名'

    def test_finds_eval(self):
        cols = ['銘柄', '評価額(円)', '損益率']
        assert detect_column(cols, ['評価額']) == '評価額(円)'

    def test_returns_none_when_missing(self):
        assert detect_column(['銘柄コード', '名称'], ['ファンド名']) is None

    def test_fullwidth_column_name(self):
        cols = ['ファンド名', '評価額']
        assert detect_column(cols, ['ファンド名']) == 'ファンド名'

    def test_finds_mkk_code_column_as_fund_name(self):
        """SBI実CSV形式 '銘柄（コード）' が銘柄パターンで検出できる。"""
        cols = ['銘柄（コード）', '評価額', '損益']
        assert detect_column(cols, ['ファンド名', '銘柄名', '銘柄', 'ファンド']) == '銘柄（コード）'

    def test_prefers_pct_column_over_absolute_for_day_pct(self):
        """'前日比（％）' が plain '前日比' より優先される（パターン優先ループ）。"""
        cols = ['前日比', '前日比（％）']
        # patterns: '前日比(%' が先、'前日比' がフォールバック
        from update_trust_from_sbi_csv import COL_PATTERNS
        result = detect_column(cols, COL_PATTERNS['day_pct'])
        assert result == '前日比（％）'

    def test_fallback_to_absolute_day_pct_when_no_pct_column(self):
        """'前日比（％）' が無い場合は plain '前日比' にフォールバックする。"""
        cols = ['銘柄（コード）', '前日比', '評価額']
        from update_trust_from_sbi_csv import COL_PATTERNS
        result = detect_column(cols, COL_PATTERNS['day_pct'])
        assert result == '前日比'

    def test_prefers_pct_column_for_pnl_pct(self):
        """'損益（％）' が plain '損益' より優先される。"""
        cols = ['損益', '損益（％）', '評価額']
        from update_trust_from_sbi_csv import COL_PATTERNS
        result = detect_column(cols, COL_PATTERNS['pnl_pct'])
        assert result == '損益（％）'


# ── load_csv ─────────────────────────────────────────────────────────────────

class TestLoadCsv:
    def test_utf8bom_fixture(self, tmp_path):
        """UTF-8 BOM のフィクスチャCSVを正しく読み込む。"""
        src = FIXTURES / 'sbi_trust_sample_utf8bom.csv'
        rows, cols = load_csv(src)
        assert len(rows) == 3
        assert 'ファンド名' in cols
        assert '評価額' in cols

    def test_cp932_encoding(self, tmp_path):
        """CP932エンコードのCSVを正しく読み込む。"""
        content = 'ファンド名,評価額,損益率\nテストファンド,"100,000","1.00%"\n'
        csv_path = tmp_path / 'cp932.csv'
        csv_path.write_bytes(content.encode('cp932'))
        rows, cols = load_csv(csv_path)
        assert len(rows) == 1
        assert rows[0]['ファンド名'] == 'テストファンド'

    def test_utf8_no_bom(self, tmp_path):
        """BOMなしUTF-8も読み込める。"""
        content = 'ファンド名,評価額\n全世界株式,"250,000"\n'
        csv_path = tmp_path / 'utf8.csv'
        csv_path.write_text(content, encoding='utf-8')
        rows, cols = load_csv(csv_path)
        assert len(rows) == 1

    def test_preamble_fixture_loads_3_rows(self):
        """タイトル行・空行・説明行付きフィクスチャで3データ行を取得できる。"""
        src = FIXTURES / 'sbi_trust_sample_with_preamble.csv'
        rows, cols = load_csv(src)
        assert len(rows) == 3
        assert 'ファンド名' in cols
        assert '評価額' in cols

    def test_preamble_fixture_skips_title_rows(self):
        """プリアンブル行(ポートフォリオ一覧等)がデータ行に混入しない。"""
        src = FIXTURES / 'sbi_trust_sample_with_preamble.csv'
        rows, _ = load_csv(src)
        fund_names = [r.get('ファンド名', '') for r in rows]
        assert not any('ポートフォリオ' in n for n in fund_names)
        assert not any('保有投資信託' in n for n in fund_names)


# ── detect_header_row ─────────────────────────────────────────────────────────

class TestDetectHeaderRow:
    def test_header_on_first_row(self):
        """1行目がヘッダーの場合にインデックス0を返す。"""
        raw = [
            ['ファンド名', '口座', '評価額', '損益率'],
            ['テストA',    '特定', '100000', '1.0'],
        ]
        assert detect_header_row(raw) == 0

    def test_header_after_preamble(self):
        """タイトル行・空行・説明行をスキップして実ヘッダーを検出する。"""
        raw = [
            ['ポートフォリオ一覧', ''],
            ['', ''],
            ['保有投資信託一覧', ''],
            ['ファンド名', '口座', '評価額', '評価損益', '損益率', '前日比'],
            ['テストA', '特定', '100000', '500', '0.5', '-0.1'],
        ]
        assert detect_header_row(raw) == 3

    def test_returns_minus1_when_not_found(self):
        """ヘッダーが存在しない場合は -1 を返す。"""
        raw = [
            ['COL_A', 'COL_B'],
            ['foo', 'bar'],
        ]
        assert detect_header_row(raw) == -1

    def test_matches_minimum_two_groups(self):
        """2グループ以上マッチした行をヘッダーとみなす。"""
        # ファンド名 + 評価額 の2グループ → ヘッダー
        raw = [['ファンド名', '評価額']]
        assert detect_header_row(raw) == 0

    def test_single_keyword_group_not_header(self):
        """1グループのみでは検出しない。"""
        raw = [['ファンド名', '商品コード']]
        assert detect_header_row(raw) == -1

    def test_preamble_fixture_header_at_row3(self):
        """プリアンブルフィクスチャではヘッダーが4行目(index=3)にある。"""
        import csv as csv_mod
        src = FIXTURES / 'sbi_trust_sample_with_preamble.csv'
        with open(src, encoding='utf-8', newline='') as f:
            raw = list(csv_mod.reader(f))
        assert detect_header_row(raw) == 3


# ── match_csv_row ─────────────────────────────────────────────────────────────

class TestMatchCsvRow:
    _ROWS = [
        {'name': 'SBI 日経225インデックスファンド', 'account': '特定',    'eval': 512345, 'pnlPct': 3.82, 'dayPct': -0.15},
        {'name': 'iFreeNEXT FANG+インデックス',    'account': '特定',    'eval': 4890000,'pnlPct': 8.62, 'dayPct': -2.50},
        {'name': 'SBI V S&P500',                  'account': 'NISA成長','eval': 720000, 'pnlPct': -4.00,'dayPct': -1.80},
        {'name': 'SBI V S&P500',                  'account': '特定',    'eval': 4400000,'pnlPct':100.00,'dayPct': -1.80},
    ]

    def test_matches_by_name(self):
        row = match_csv_row('日経225', '', self._ROWS)
        assert row is not None
        assert row['eval'] == 512345

    def test_matches_fang(self):
        row = match_csv_row('FANG+', '特定', self._ROWS)
        assert row is not None
        assert row['eval'] == 4890000

    def test_account_disambiguation_nisa(self):
        row = match_csv_row('SBI V S&P500', 'NISA成長', self._ROWS)
        assert row is not None
        assert row['eval'] == 720000

    def test_account_disambiguation_tokutei(self):
        row = match_csv_row('SBI V S&P500', '特定', self._ROWS)
        assert row is not None
        assert row['eval'] == 4400000

    def test_no_match(self):
        row = match_csv_row('存在しないファンド', '', self._ROWS)
        assert row is None

    def test_empty_csv_name_returns_none(self):
        row = match_csv_row('', '', self._ROWS)
        assert row is None


# ── integration: full script run ─────────────────────────────────────────────

class TestScriptIntegration:
    def _run(self, input_csv: Path, master_json: Path, extra_args: list[str] | None = None) -> int:
        """scripts/update_trust_from_sbi_csv.py を subprocess ではなく直接呼び出す。"""
        import importlib.util
        import types

        spec = importlib.util.spec_from_file_location(
            'update_trust_from_sbi_csv',
            REPO_ROOT / 'scripts' / 'update_trust_from_sbi_csv.py',
        )
        mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        spec.loader.exec_module(mod)  # type: ignore[union-attr]

        args_list = ['--input', str(input_csv), '--output', str(master_json)]
        if extra_args:
            args_list += extra_args

        old_argv = sys.argv
        sys.argv = ['update_trust_from_sbi_csv.py'] + args_list
        try:
            mod.main()
            return 0
        except SystemExit as e:
            return int(e.code) if e.code is not None else 0
        finally:
            sys.argv = old_argv

    def test_updates_eval_from_fixture_csv(self, tmp_path):
        """フィクスチャCSVを使い、評価額が正しく更新されることを確認。"""
        import shutil
        master_copy = tmp_path / 'trust_master.json'
        shutil.copy(FIXTURES / 'trust_master_fixture.json', master_copy)

        ret = self._run(FIXTURES / 'sbi_trust_sample_utf8bom.csv', master_copy)
        assert ret == 0

        result = json.loads(master_copy.read_text(encoding='utf-8'))
        funds_by_id = {f['id']: f for f in result['funds']}

        assert funds_by_id['nk225_sbi']['eval'] == 512345
        assert funds_by_id['fang_toku']['eval'] == 4890000
        assert funds_by_id['acwi']['eval'] == 265000

    def test_pnlpct_and_daypct_updated(self, tmp_path):
        """損益率・前日比も更新されることを確認。"""
        import shutil
        master_copy = tmp_path / 'trust_master.json'
        shutil.copy(FIXTURES / 'trust_master_fixture.json', master_copy)
        self._run(FIXTURES / 'sbi_trust_sample_utf8bom.csv', master_copy)

        result = json.loads(master_copy.read_text(encoding='utf-8'))
        funds_by_id = {f['id']: f for f in result['funds']}

        assert funds_by_id['nk225_sbi']['pnlPct'] == pytest.approx(3.82)
        assert funds_by_id['nk225_sbi']['dayPct'] == pytest.approx(-0.15)

    def test_last_updated_and_source_set(self, tmp_path):
        """last_updated と source が sbi_csv にセットされることを確認。"""
        import shutil
        master_copy = tmp_path / 'trust_master.json'
        shutil.copy(FIXTURES / 'trust_master_fixture.json', master_copy)
        self._run(FIXTURES / 'sbi_trust_sample_utf8bom.csv', master_copy)

        result = json.loads(master_copy.read_text(encoding='utf-8'))
        assert result['source'] == 'sbi_csv'
        assert result['last_updated'] != '2000-01-01'

    def test_unmatched_fund_preserved(self, tmp_path):
        """csv_name未設定・eval=0のファンドは元の値を維持することを確認。"""
        import shutil
        master_copy = tmp_path / 'trust_master.json'
        shutil.copy(FIXTURES / 'trust_master_fixture.json', master_copy)
        self._run(FIXTURES / 'sbi_trust_sample_utf8bom.csv', master_copy)

        result = json.loads(master_copy.read_text(encoding='utf-8'))
        funds_by_id = {f['id']: f for f in result['funds']}

        assert funds_by_id['orphan']['eval'] == 0

    def test_dry_run_does_not_write(self, tmp_path):
        """--dry-run は出力ファイルを変更しないことを確認。"""
        import shutil
        master_copy = tmp_path / 'trust_master.json'
        shutil.copy(FIXTURES / 'trust_master_fixture.json', master_copy)
        original_content = master_copy.read_text(encoding='utf-8')

        self._run(FIXTURES / 'sbi_trust_sample_utf8bom.csv', master_copy, ['--dry-run'])

        assert master_copy.read_text(encoding='utf-8') == original_content

    def test_missing_input_file_exits_nonzero(self, tmp_path):
        """存在しない入力ファイルで終了コード非ゼロ。"""
        master_copy = tmp_path / 'trust_master.json'
        master_copy.write_text('{"funds":[]}', encoding='utf-8')
        ret = self._run(tmp_path / 'nonexistent.csv', master_copy)
        assert ret != 0

    def test_unknown_column_exits_nonzero(self, tmp_path):
        """想定外のヘッダー行の場合に明確に失敗する。"""
        bad_csv = tmp_path / 'bad.csv'
        bad_csv.write_text('COL_A,COL_B\nfoo,123\n', encoding='utf-8')

        import shutil
        master_copy = tmp_path / 'trust_master.json'
        shutil.copy(FIXTURES / 'trust_master_fixture.json', master_copy)

        ret = self._run(bad_csv, master_copy)
        assert ret != 0

    def test_preamble_csv_updates_eval(self, tmp_path):
        """タイトル行付きCSV(SBIポートフォリオ形式)でも評価額が更新される。"""
        import shutil
        master_copy = tmp_path / 'trust_master.json'
        shutil.copy(FIXTURES / 'trust_master_fixture.json', master_copy)

        ret = self._run(FIXTURES / 'sbi_trust_sample_with_preamble.csv', master_copy)
        assert ret == 0

        result = json.loads(master_copy.read_text(encoding='utf-8'))
        funds_by_id = {f['id']: f for f in result['funds']}

        assert funds_by_id['nk225_sbi']['eval'] == 512345
        assert funds_by_id['fang_toku']['eval'] == 4890000
        assert funds_by_id['acwi']['eval'] == 265000

    def test_preamble_csv_source_set_to_sbi_csv(self, tmp_path):
        """プリアンブル付きCSV取込後も source=sbi_csv がセットされる。"""
        import shutil
        master_copy = tmp_path / 'trust_master.json'
        shutil.copy(FIXTURES / 'trust_master_fixture.json', master_copy)
        self._run(FIXTURES / 'sbi_trust_sample_with_preamble.csv', master_copy)

        result = json.loads(master_copy.read_text(encoding='utf-8'))
        assert result['source'] == 'sbi_csv'

    def _make_master(self, tmp_path, funds: list[dict]) -> "Path":
        p = tmp_path / 'master.json'
        p.write_text(
            json.dumps({"last_updated": "2026-01-01", "source": "manual", "funds": funds}),
            encoding='utf-8',
        )
        return p

    def test_unmatched_without_allow_partial_exits_nonzero(self, tmp_path):
        """未マッチあり・--allow-partial なしは exit(1)。"""
        master = self._make_master(tmp_path, [
            {"id": "nk225_sbi", "csv_name": "日経225", "csv_account": "特定", "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "bad_fund", "csv_name": "存在しないファンド", "csv_account": "", "eval": 99999, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        ret = self._run(FIXTURES / 'sbi_trust_sample_utf8bom.csv', master)
        assert ret != 0

    def test_unmatched_with_allow_partial_exits_zero_and_updates(self, tmp_path):
        """未マッチあり・--allow-partial はexit(0)でマッチ分のみ更新。"""
        master = self._make_master(tmp_path, [
            {"id": "nk225_sbi", "csv_name": "日経225", "csv_account": "特定", "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "bad_fund", "csv_name": "存在しないファンド", "csv_account": "", "eval": 99999, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        ret = self._run(FIXTURES / 'sbi_trust_sample_utf8bom.csv', master, ['--allow-partial'])
        assert ret == 0
        result = json.loads(master.read_text(encoding='utf-8'))
        funds_by_id = {f['id']: f for f in result['funds']}
        assert funds_by_id['nk225_sbi']['eval'] == 512345
        assert funds_by_id['bad_fund']['eval'] == 99999  # 未マッチ: 元の値を維持

    def test_partial_update_sets_sbi_csv_partial_source(self, tmp_path):
        """--allow-partial 部分更新時は source が sbi_csv_partial。"""
        master = self._make_master(tmp_path, [
            {"id": "nk225_sbi", "csv_name": "日経225", "csv_account": "特定", "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "bad_fund", "csv_name": "存在しないファンド", "csv_account": "", "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        self._run(FIXTURES / 'sbi_trust_sample_utf8bom.csv', master, ['--allow-partial'])
        result = json.loads(master.read_text(encoding='utf-8'))
        assert result['source'] == 'sbi_csv_partial'

    def test_ambiguous_match_exits_nonzero(self, tmp_path):
        """同一CSV行に複数ファンドがマッチ → exit(1)。"""
        master = self._make_master(tmp_path, [
            {"id": "fund_a", "csv_name": "日経225", "csv_account": "", "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "fund_b", "csv_name": "日経225", "csv_account": "", "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        ret = self._run(FIXTURES / 'sbi_trust_sample_utf8bom.csv', master)
        assert ret != 0

    def test_ambiguous_with_allow_partial_exits_zero(self, tmp_path):
        """曖昧マッチあり・--allow-partial はexit(0)で曖昧ファンドをスキップ。"""
        master = self._make_master(tmp_path, [
            {"id": "fund_a", "csv_name": "日経225", "csv_account": "", "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "fund_b", "csv_name": "日経225", "csv_account": "", "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "fang_toku", "csv_name": "FANG+", "csv_account": "特定", "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        ret = self._run(FIXTURES / 'sbi_trust_sample_utf8bom.csv', master, ['--allow-partial'])
        assert ret == 0
        result = json.loads(master.read_text(encoding='utf-8'))
        funds_by_id = {f['id']: f for f in result['funds']}
        assert funds_by_id['fang_toku']['eval'] == 4890000  # 非曖昧: 更新される
        assert funds_by_id['fund_a']['eval'] == 0           # 曖昧: 元の値を維持
        assert funds_by_id['fund_b']['eval'] == 0

    # ── skipped_active_ids ガード ─────────────────────────────────────────────

    def test_skipped_active_nonzero_fails_without_allow_partial(self, tmp_path):
        """csv_name="" かつ eval>0 があり --allow-partial なし → exit(1)。"""
        master = self._make_master(tmp_path, [
            {"id": "nk225_sbi",    "csv_name": "日経225", "csv_account": "特定", "eval": 0,      "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "skipped_fund", "csv_name": "",        "csv_account": "",     "eval": 100000, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        ret = self._run(FIXTURES / 'sbi_trust_sample_utf8bom.csv', master)
        assert ret != 0

    def test_skipped_active_zero_eval_is_safe_skip(self, tmp_path):
        """csv_name="" かつ eval=0 → 安全スキップ、exit(0)。"""
        master = self._make_master(tmp_path, [
            {"id": "nk225_sbi",    "csv_name": "日経225", "csv_account": "特定", "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "skipped_fund", "csv_name": "",        "csv_account": "",     "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        ret = self._run(FIXTURES / 'sbi_trust_sample_utf8bom.csv', master)
        assert ret == 0

    def test_allow_partial_with_skipped_active_exits_zero(self, tmp_path):
        """csv_name="" かつ eval>0 があっても --allow-partial なら exit(0)。"""
        master = self._make_master(tmp_path, [
            {"id": "nk225_sbi",    "csv_name": "日経225", "csv_account": "特定", "eval": 0,      "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "skipped_fund", "csv_name": "",        "csv_account": "",     "eval": 100000, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        ret = self._run(FIXTURES / 'sbi_trust_sample_utf8bom.csv', master, ['--allow-partial'])
        assert ret == 0
        result = json.loads(master.read_text(encoding='utf-8'))
        funds_by_id = {f['id']: f for f in result['funds']}
        assert funds_by_id['nk225_sbi']['eval'] == 512345    # マッチ: 更新
        assert funds_by_id['skipped_fund']['eval'] == 100000  # スキップ: 元の値を維持

    def test_allow_partial_with_skipped_active_sets_sbi_csv_partial(self, tmp_path):
        """skipped_active あり --allow-partial → source: sbi_csv_partial。"""
        master = self._make_master(tmp_path, [
            {"id": "nk225_sbi",    "csv_name": "日経225", "csv_account": "特定", "eval": 0,      "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "skipped_fund", "csv_name": "",        "csv_account": "",     "eval": 100000, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        self._run(FIXTURES / 'sbi_trust_sample_utf8bom.csv', master, ['--allow-partial'])
        result = json.loads(master.read_text(encoding='utf-8'))
        assert result['source'] == 'sbi_csv_partial'
        assert 'skipped_active' in result['note']

    def test_full_match_no_skipped_active_sets_sbi_csv(self, tmp_path):
        """全対象マッチ + skipped_active=0 → source: sbi_csv (正式更新)。"""
        master = self._make_master(tmp_path, [
            {"id": "nk225_sbi", "csv_name": "日経225", "csv_account": "特定", "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "safe_skip", "csv_name": "",        "csv_account": "",     "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        self._run(FIXTURES / 'sbi_trust_sample_utf8bom.csv', master)
        result = json.loads(master.read_text(encoding='utf-8'))
        assert result['source'] == 'sbi_csv'

    def test_dry_run_no_write_with_skipped_active(self, tmp_path):
        """skipped_active あり dry-run → trust_master.json は変更されない。"""
        master = self._make_master(tmp_path, [
            {"id": "nk225_sbi",    "csv_name": "日経225", "csv_account": "特定", "eval": 0,      "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "skipped_fund", "csv_name": "",        "csv_account": "",     "eval": 100000, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        original = master.read_text(encoding='utf-8')
        self._run(FIXTURES / 'sbi_trust_sample_utf8bom.csv', master, ['--dry-run'])
        assert master.read_text(encoding='utf-8') == original


# ── account_matches ───────────────────────────────────────────────────────────

class TestAccountMatches:
    def test_exact_tokutei(self):
        """「特定」は「特定」のみにマッチする。"""
        assert account_matches('特定', '特定') is True

    def test_exact_nisa_growth(self):
        """「NISA成長」は「NISA成長」のみにマッチする。"""
        assert account_matches('NISA成長', 'NISA成長') is True

    def test_exact_tsumitate(self):
        """「積立NISA」は「積立NISA」のみにマッチする。"""
        assert account_matches('積立NISA', '積立NISA') is True

    def test_nisa_matches_nisa(self):
        """「NISA」は「NISA」にマッチする。"""
        assert account_matches('NISA', 'NISA') is True

    def test_nisa_matches_old_nisa(self):
        """「NISA」は「旧NISA」にマッチする。"""
        assert account_matches('NISA', '旧NISA') is True

    def test_nisa_matches_general_nisa(self):
        """「NISA」は「一般NISA」にマッチする。"""
        assert account_matches('NISA', '一般NISA') is True

    def test_nisa_does_not_match_nisa_growth(self):
        """「NISA」は「NISA成長」にマッチしない（strict）。"""
        assert account_matches('NISA', 'NISA成長') is False

    def test_nisa_does_not_match_tsumitate(self):
        """「NISA」は「積立NISA」にマッチしない。"""
        assert account_matches('NISA', '積立NISA') is False

    def test_nisa_growth_does_not_match_nisa(self):
        """「NISA成長」は「NISA」にマッチしない。"""
        assert account_matches('NISA成長', 'NISA') is False

    def test_empty_csv_account_matches_any(self):
        """csv_accountが空なら口座条件なし（何にでもマッチ）。"""
        assert account_matches('', '特定') is True
        assert account_matches('', 'NISA成長') is True
        assert account_matches('', '') is True

    def test_tokutei_does_not_match_nisa(self):
        """「特定」は「NISA」にマッチしない。"""
        assert account_matches('特定', 'NISA') is False


# ── detect_section_account ────────────────────────────────────────────────────

class TestDetectSectionAccount:
    def test_tokutei_section(self):
        """「特定預り」セクションヘッダーを "特定" に変換する。"""
        assert detect_section_account('投資信託（金額/特定預り）') == '特定'

    def test_nisa_growth_section(self):
        """「成長投資枠」セクションヘッダーを "NISA成長" に変換する。"""
        assert detect_section_account('投資信託（金額/NISA預り（成長投資枠））') == 'NISA成長'

    def test_tsumitate_section(self):
        """「つみたて投資枠」セクションヘッダーを "積立NISA" に変換する。"""
        assert detect_section_account('投資信託（金額/NISA預り（つみたて投資枠））') == '積立NISA'

    def test_tsumitate_before_growth_no_collision(self):
        """「つみたて投資枠」が「成長投資枠」より先にマッチすること（サブストリング衝突なし）。"""
        result = detect_section_account('NISA預り（つみたて投資枠）')
        assert result == '積立NISA'

    def test_fund_name_returns_none(self):
        """ファンド名行はNoneを返す。"""
        assert detect_section_account('iFreeNEXT FANG+インデックス') is None

    def test_header_row_returns_none(self):
        """「ファンド名」列ヘッダー行はNoneを返す。"""
        assert detect_section_account('ファンド名') is None

    def test_tokutei_total_row(self):
        """「特定預り)合計」形式のセクション行も "特定" に変換する。"""
        assert detect_section_account('投資信託(金額/特定預り)合計') == '特定'

    def test_empty_cell_returns_none(self):
        """空文字はNoneを返す。"""
        assert detect_section_account('') is None


# ── load_csv: セクション対応 ──────────────────────────────────────────────────

class TestLoadCsvSection:
    def test_multisection_tokutei_rows_have_correct_section_account(self):
        """特定預りセクションのデータ行に _section_account='特定' が付与される。"""
        rows, _ = load_csv(FIXTURES / 'sbi_trust_sample_multisection.csv')
        fang_toku = next(
            (r for r in rows if 'FANG' in r.get('ファンド名', '') and r.get('_section_account') == '特定'),
            None,
        )
        assert fang_toku is not None

    def test_multisection_nisa_rows_have_correct_section_account(self):
        """NISA成長セクションのデータ行に _section_account='NISA成長' が付与される。"""
        rows, _ = load_csv(FIXTURES / 'sbi_trust_sample_multisection.csv')
        nisa_data = [r for r in rows if r.get('_section_account') == 'NISA成長' and r.get('ファンド名') != 'ファンド名']
        assert len(nisa_data) >= 2  # FANG+ と SBI V S&P500

    def test_multisection_tsumitate_rows_have_correct_section_account(self):
        """つみたて投資枠セクションのデータ行に _section_account='積立NISA' が付与される。"""
        rows, _ = load_csv(FIXTURES / 'sbi_trust_sample_multisection.csv')
        tsumi_data = [r for r in rows if r.get('_section_account') == '積立NISA' and r.get('ファンド名') != 'ファンド名']
        assert len(tsumi_data) >= 1  # SBI V S&P500

    def test_existing_fixture_section_account_is_empty(self):
        """セクションなしのフィクスチャ（口座列付き）は _section_account が空。"""
        rows, _ = load_csv(FIXTURES / 'sbi_trust_sample_utf8bom.csv')
        assert all(r.get('_section_account', '') == '' for r in rows)


# ── integration: multi-section disambiguation ─────────────────────────────────

class TestMultiSectionIntegration:
    """マルチセクションCSVを使った統合テスト。"""

    def _run(self, input_csv: Path, master_json: Path, extra_args: list[str] | None = None) -> int:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            'update_trust_from_sbi_csv',
            REPO_ROOT / 'scripts' / 'update_trust_from_sbi_csv.py',
        )
        mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        args_list = ['--input', str(input_csv), '--output', str(master_json)]
        if extra_args:
            args_list += extra_args
        old_argv = sys.argv
        sys.argv = ['update_trust_from_sbi_csv.py'] + args_list
        try:
            mod.main()
            return 0
        except SystemExit as e:
            return int(e.code) if e.code is not None else 0
        finally:
            sys.argv = old_argv

    def _make_master(self, tmp_path, funds: list[dict]) -> Path:
        p = tmp_path / 'master.json'
        p.write_text(
            json.dumps({"last_updated": "2026-01-01", "source": "manual", "funds": funds}),
            encoding='utf-8',
        )
        return p

    def test_disambiguates_fang_by_section(self, tmp_path):
        """同名FANG+を特定/NISA成長セクションで別々にマッチできる。"""
        master = self._make_master(tmp_path, [
            {"id": "fang_toku",   "csv_name": "FANG+", "csv_account": "特定",    "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "fang_nisa_g", "csv_name": "FANG+", "csv_account": "NISA成長","eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        ret = self._run(FIXTURES / 'sbi_trust_sample_multisection.csv', master)
        assert ret == 0
        result = json.loads(master.read_text(encoding='utf-8'))
        funds_by_id = {f['id']: f for f in result['funds']}
        assert funds_by_id['fang_toku']['eval']   == 4890000
        assert funds_by_id['fang_nisa_g']['eval'] == 1750000

    def test_disambiguates_sp500_three_sections(self, tmp_path):
        """SBI V S&P500 が特定/NISA成長/積立NISA の3口座で別々にマッチできる。"""
        master = self._make_master(tmp_path, [
            {"id": "sp500_toku",  "csv_name": "SBI・V・S&P500", "csv_account": "特定",    "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "sp500_nisa",  "csv_name": "SBI・V・S&P500", "csv_account": "NISA成長","eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "sp500_tsumi", "csv_name": "SBI・V・S&P500", "csv_account": "積立NISA","eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        ret = self._run(FIXTURES / 'sbi_trust_sample_multisection.csv', master)
        assert ret == 0
        result = json.loads(master.read_text(encoding='utf-8'))
        funds_by_id = {f['id']: f for f in result['funds']}
        assert funds_by_id['sp500_toku']['eval']  == 4400000
        assert funds_by_id['sp500_nisa']['eval']  == 720000
        assert funds_by_id['sp500_tsumi']['eval'] == 700000

    def test_no_ambiguous_when_section_accounts_differ(self, tmp_path):
        """セクション区分が異なれば同名ファンドは曖昧マッチにならない → exit(0)。"""
        master = self._make_master(tmp_path, [
            {"id": "fang_toku",   "csv_name": "FANG+", "csv_account": "特定",    "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "fang_nisa_g", "csv_name": "FANG+", "csv_account": "NISA成長","eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "sp500_toku",  "csv_name": "SBI・V・S&P500", "csv_account": "特定",    "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "sp500_nisa",  "csv_name": "SBI・V・S&P500", "csv_account": "NISA成長","eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "sp500_tsumi", "csv_name": "SBI・V・S&P500", "csv_account": "積立NISA","eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        ret = self._run(FIXTURES / 'sbi_trust_sample_multisection.csv', master)
        assert ret == 0

    def test_ambiguous_still_detected_within_same_section(self, tmp_path):
        """同じ口座区分で同名ファンドが2つ → 曖昧マッチとして検出される。"""
        master = self._make_master(tmp_path, [
            {"id": "fund_a", "csv_name": "FANG+", "csv_account": "特定", "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "fund_b", "csv_name": "FANG+", "csv_account": "特定", "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        ret = self._run(FIXTURES / 'sbi_trust_sample_multisection.csv', master)
        assert ret != 0

    def test_dry_run_no_write_multisection(self, tmp_path):
        """マルチセクションCSVの dry-run はファイルを変更しない。"""
        master = self._make_master(tmp_path, [
            {"id": "fang_toku", "csv_name": "FANG+", "csv_account": "特定", "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        original = master.read_text(encoding='utf-8')
        self._run(FIXTURES / 'sbi_trust_sample_multisection.csv', master, ['--dry-run'])
        assert master.read_text(encoding='utf-8') == original

    def test_nisa_growth_account_matches_nisa_growth_section(self, tmp_path):
        """csv_account="NISA成長" は NISA成長セクション行にマッチする（strict）。"""
        master = self._make_master(tmp_path, [
            {"id": "fang_g", "csv_name": "FANG+", "csv_account": "NISA成長", "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        ret = self._run(FIXTURES / 'sbi_trust_sample_multisection.csv', master)
        assert ret == 0
        result = json.loads(master.read_text(encoding='utf-8'))
        assert {f['id']: f for f in result['funds']}['fang_g']['eval'] == 1750000

    def test_nisa_account_does_not_match_nisa_growth_section(self, tmp_path):
        """csv_account="NISA" は NISA成長セクション行にマッチしない（strict）。"""
        master = self._make_master(tmp_path, [
            {"id": "fang_toku",  "csv_name": "FANG+", "csv_account": "特定",    "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "fang_wrong", "csv_name": "FANG+", "csv_account": "NISA",    "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        # fang_toku は 特定 FANG+ にマッチ; fang_wrong は NISA=NISA成長 にならず未マッチ
        ret = self._run(FIXTURES / 'sbi_trust_sample_multisection.csv', master, ['--allow-partial'])
        assert ret == 0
        result = json.loads(master.read_text(encoding='utf-8'))
        funds_by_id = {f['id']: f for f in result['funds']}
        assert funds_by_id['fang_toku']['eval']  == 4890000  # 特定 マッチ
        assert funds_by_id['fang_wrong']['eval'] == 0        # NISA は NISA成長 にマッチせず

    def test_all_section_accounts_no_ambiguous(self, tmp_path):
        """正しい csv_account で5ファンドを登録 → 曖昧マッチ0・未マッチ0。"""
        master = self._make_master(tmp_path, [
            {"id": "fang_toku",   "csv_name": "FANG+",          "csv_account": "特定",    "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "fang_nisa_g", "csv_name": "FANG+",          "csv_account": "NISA成長","eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "sp500_toku",  "csv_name": "SBI・V・S&P500", "csv_account": "特定",    "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "sp500_nisa",  "csv_name": "SBI・V・S&P500", "csv_account": "NISA成長","eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "sp500_tsumi", "csv_name": "SBI・V・S&P500", "csv_account": "積立NISA","eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        ret = self._run(FIXTURES / 'sbi_trust_sample_multisection.csv', master)
        assert ret == 0  # 曖昧0 / 未マッチ0 / skipped_active0 → exit(0)


# ── load_csv: 株式+投信 一括CSV ───────────────────────────────────────────────

class TestLoadCsvFullPortfolio:
    """SBI一括CSV（株式セクション + 投信3セクション）の load_csv テスト。"""

    FULL_CSV = FIXTURES / 'sbi_trust_sample_full_portfolio.csv'

    def test_stock_rows_excluded(self):
        """株式セクションの行は返されない。"""
        rows, _ = load_csv(self.FULL_CSV)
        fund_names = [r.get('ファンド名', '') for r in rows]
        assert not any('7203' in n or 'トヨタ' in n for n in fund_names)

    def test_only_trust_rows_returned(self):
        """返される全行が投信セクション（特定/NISA成長/積立NISA）に属する。"""
        rows, _ = load_csv(self.FULL_CSV)
        for r in rows:
            assert r.get('_section_account') in {'特定', 'NISA成長', '積立NISA'}

    def test_trust_row_count(self):
        """投信行数が正しい（特定2 + NISA成長2 + 積立NISA2 = 6件）。"""
        rows, _ = load_csv(self.FULL_CSV)
        assert len(rows) == 6

    def test_tokutei_section_account(self):
        """特定預り投信行に _section_account='特定' が付与される。"""
        rows, _ = load_csv(self.FULL_CSV)
        tokutei = [r for r in rows if r.get('_section_account') == '特定']
        assert len(tokutei) == 2
        names = [r.get('ファンド名', '') for r in tokutei]
        assert any('FANG' in n for n in names)
        assert any('半導体' in n for n in names)

    def test_nisa_growth_section_account(self):
        """NISA成長投信行に _section_account='NISA成長' が付与される。"""
        rows, _ = load_csv(self.FULL_CSV)
        nisa = [r for r in rows if r.get('_section_account') == 'NISA成長']
        assert len(nisa) == 2
        names = [r.get('ファンド名', '') for r in nisa]
        assert any('FANG' in n for n in names)
        assert any('NASDAQ100' in n for n in names)

    def test_tsumitate_section_account(self):
        """積立NISA投信行に _section_account='積立NISA' が付与される。"""
        rows, _ = load_csv(self.FULL_CSV)
        tsumi = [r for r in rows if r.get('_section_account') == '積立NISA']
        assert len(tsumi) == 2
        names = [r.get('ファンド名', '') for r in tsumi]
        assert any('全世界株式' in n for n in names)
        assert any('S&P500' in n or 'S＆P500' in n for n in names)

    def test_no_total_rows_in_data(self):
        """合計行・総合計行がデータ行に含まれない。"""
        rows, _ = load_csv(self.FULL_CSV)
        fund_names = [r.get('ファンド名', '') for r in rows]
        assert not any('合計' in n for n in fund_names)

    def test_per_section_header_fields(self):
        """各セクションの 'ファンド名' フィールドが使える（セクション専用ヘッダー）。"""
        rows, fieldnames = load_csv(self.FULL_CSV)
        assert 'ファンド名' in fieldnames
        assert all('ファンド名' in r for r in rows)

    def test_fund_names_accessible(self):
        """各セクションのファンド名が正しく取得できる。"""
        rows, _ = load_csv(self.FULL_CSV)
        names = [r['ファンド名'] for r in rows]
        assert any('FANG' in n for n in names)
        assert any('半導体' in n for n in names)
        assert any('NASDAQ100' in n for n in names)
        assert any('全世界株式' in n for n in names)


# ── integration: CSV-only投信検出 ─────────────────────────────────────────────

class TestCsvOnlyDetection:
    """CSV-only投信検出（trust_master未登録ファンドを報告）のテスト。"""

    FULL_CSV = FIXTURES / 'sbi_trust_sample_full_portfolio.csv'

    def _run(self, input_csv: Path, master_json: Path,
             extra_args: list[str] | None = None) -> tuple[int, str]:
        """スクリプトを実行し (exit_code, stdout) を返す。"""
        import importlib.util
        import io
        from contextlib import redirect_stdout

        spec = importlib.util.spec_from_file_location(
            'update_trust_from_sbi_csv',
            REPO_ROOT / 'scripts' / 'update_trust_from_sbi_csv.py',
        )
        mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        spec.loader.exec_module(mod)  # type: ignore[union-attr]

        args_list = ['--input', str(input_csv), '--output', str(master_json)]
        if extra_args:
            args_list += extra_args

        old_argv = sys.argv
        sys.argv = ['update_trust_from_sbi_csv.py'] + args_list
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                mod.main()
            return 0, buf.getvalue()
        except SystemExit as e:
            return int(e.code) if e.code is not None else 0, buf.getvalue()
        finally:
            sys.argv = old_argv

    def _make_master(self, tmp_path, funds: list[dict]) -> Path:
        p = tmp_path / 'master.json'
        p.write_text(
            json.dumps({"last_updated": "2026-01-01", "source": "manual", "funds": funds}),
            encoding='utf-8',
        )
        return p

    def test_csv_only_detected_when_unregistered_fund_in_csv(self, tmp_path):
        """trust_masterにないCSV投信がCSV-onlyとして出力に表示される。"""
        master = self._make_master(tmp_path, [
            {"id": "fang_toku", "csv_name": "FANG+", "csv_account": "特定",
             "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        # CSV: FANG+ (マッチ) + 日経半導体 (CSV-only) in 特定
        ret, output = self._run(self.FULL_CSV, master, ['--dry-run'])
        assert ret == 0
        assert 'CSV-only' in output

    def test_nikkei_semi_detected_as_csv_only(self, tmp_path):
        """日経半導体 / 特定 が CSV-only として検出される。"""
        master = self._make_master(tmp_path, [
            {"id": "fang_toku", "csv_name": "FANG+", "csv_account": "特定",
             "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        _, output = self._run(self.FULL_CSV, master, ['--dry-run'])
        assert '半導体' in output

    def test_acwi_tsumi_detected_as_csv_only(self, tmp_path):
        """全世界株式 / 積立NISA が CSV-only として検出される。"""
        master = self._make_master(tmp_path, [
            {"id": "fang_tsumi", "csv_name": "FANG+", "csv_account": "積立NISA",
             "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "sp500_tsumi", "csv_name": "SBI・V・S&P500", "csv_account": "積立NISA",
             "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        _, output = self._run(self.FULL_CSV, master, ['--dry-run'])
        assert '全世界株式' in output
        assert 'CSV-only' in output

    def test_nq100_nisa_detected_as_csv_only(self, tmp_path):
        """SBI NASDAQ100 / NISA成長 が CSV-only として検出される。"""
        master = self._make_master(tmp_path, [
            {"id": "fang_nisa_g", "csv_name": "FANG+", "csv_account": "NISA成長",
             "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        _, output = self._run(self.FULL_CSV, master, ['--dry-run'])
        assert 'NASDAQ100' in output
        assert 'CSV-only' in output

    def test_no_stock_rows_in_csv_only(self, tmp_path):
        """CSV-only 検出に株式行が混入しない。"""
        master = self._make_master(tmp_path, [
            {"id": "fang_toku", "csv_name": "FANG+", "csv_account": "特定",
             "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        _, output = self._run(self.FULL_CSV, master, ['--dry-run'])
        assert 'トヨタ' not in output
        assert '7203' not in output

    def test_csv_only_zero_when_all_registered(self, tmp_path):
        """全CSVファンドが登録済みなら CSV-only: 0 件。"""
        master = self._make_master(tmp_path, [
            {"id": "fang_toku",   "csv_name": "FANG+",               "csv_account": "特定",
             "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "nikkei_semi", "csv_name": "日経半導体",           "csv_account": "特定",
             "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "fang_nisa_g", "csv_name": "FANG+",               "csv_account": "NISA成長",
             "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "nq100_nisa",  "csv_name": "NASDAQ100インデックス","csv_account": "NISA成長",
             "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "acwi_tsumi",  "csv_name": "全世界株式",           "csv_account": "積立NISA",
             "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
            {"id": "sp500_tsumi", "csv_name": "SBI・V・S&P500",       "csv_account": "積立NISA",
             "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        ret, output = self._run(self.FULL_CSV, master)
        assert ret == 0
        assert 'CSV-only投信: 0 件' in output

    def test_usdiv_covers_sp500_dividends_tokutei(self, tmp_path):
        """既存 usdiv (csv_name='S&P500配当貴族'/特定) が Tracers S&P500配当貴族インデックス/特定 にマッチする。
        CSV に Tracers S&P500配当貴族が存在しても usdiv_toku を追加する必要はない。"""
        csv_path = tmp_path / 'sp500div.csv'
        csv_path.write_text(
            '投資信託（金額/特定預り）,,,,,,,,,,\n'
            'ファンド名,買付日,数量,参考単価,取得単価,現在値,前日比,前日比（％）,損益,損益（％）,評価額\n'
            'Tracers S&P500配当貴族インデックス（米国株式）,2024-01-01,1000,300,280,300,-5,-1.63,"20000",7.14,"300,000"\n'
            '投資信託(金額/特定預り)合計,,,,,,,,,,\n',
            encoding='utf-8',
        )
        master = self._make_master(tmp_path, [
            {"id": "usdiv", "csv_name": "S&P500配当貴族", "csv_account": "特定",
             "eval": 0, "pnlPct": 0.0, "dayPct": 0.0},
        ])
        ret, output = self._run(csv_path, master)
        assert ret == 0
        result = json.loads(master.read_text(encoding='utf-8'))
        funds_by_id = {f['id']: f for f in result['funds']}
        assert funds_by_id['usdiv']['eval'] == 300000  # usdiv が Tracers S&P500配当貴族 にマッチして更新
        assert 'CSV-only投信: 0 件' in output          # CSV-only ゼロ: usdiv が全カバー
