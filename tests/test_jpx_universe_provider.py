"""
P5-B004b-1: data/jpx_universe_provider.py の回帰テスト（P5-B004b-1
PROVIDER-HARDENINGでcache/dependency/eligibility guard関連を追加）。

確認項目（goal記載の最低16項目 + row-count guard + hardening追加分）:
  1. valid xls parse
  2. required columns
  3. code string preservation
  4. 4桁数字code
  5. 英字混在code
  6. duplicate reject
  7. malformed row handling
  8. exact eligibility filter
  9. 1559 vs 1560差の説明
  10. provenance metadata
  11. fetch failure→cache fallback
  12. corrupt cache reject
  13. no cache→seed fallback
  14. oversized JPX universeをexisting enrichmentへ直結しない
  15. personal holdings/trust/cash/account非参照
  16. public/dataへcache非配信
  (+) row count急減guard
  hardening追加: .jpx_cacheのgit ignore契約 / missing requests・xlrd正規化 /
  eligible=0・急減guard / first-run truncated保護 / malformed cache items深層reject /
  1552件相当のguard通過
"""
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from data.build_candidates_stocks import (
    MAX_ENRICHMENT_UNIVERSE,
    SEED_LIST,
    EnrichmentGuardExceeded,
    enforce_enrichment_guard,
)
from data.jpx_universe_provider import (
    APPROVED_WORKBOOK_BASENAMES,
    CACHE_PATH,
    ELIGIBLE_COUNT_MIN_RATIO,
    FALLBACK_UNIVERSE_ID,
    JPX_ALLOWED_HOST,
    JPX_LISTING_PAGE_URL,
    MARKET_SEGMENT_PRIME_DOMESTIC,
    MIN_ELIGIBLE_COUNT,
    MIN_RAW_ROW_COUNT,
    REQUIRED_COLUMNS,
    UNIVERSE_ID,
    JPXEligibleCountGuardError,
    JPXFetchError,
    JPXParseError,
    JPXRowCountGuardError,
    JPXSchemaError,
    apply_eligibility,
    detect_duplicate_codes,
    detect_workbook_format,
    discover_workbook_url,
    fetch_jpx_xls,
    get_jpx_universe,
    is_preferred_or_class_share,
    load_cache,
    parse_jpx_workbook_bytes,
    parse_jpx_xls_bytes,
    parse_jpx_xlsx_bytes,
    parse_rows_from_sheet,
    save_cache,
    seed_list_v1_fallback,
)

JST = timezone(timedelta(hours=9))
_NOW = datetime(2026, 7, 14, 12, 0, 0, tzinfo=JST)

FORBIDDEN_KEYS = {
    'eval', 'pnlPct', 'purchase_date', 'acquiredAt', 'account',
    'accountType', 'holdings', 'cash', 'reserve', 'amount',
    'maxAmount', 'sizing', 'headroom', 'score', 'action',
    'trust', 'nisa',
}

FULL_HEADER = [
    '日付', 'コード', '銘柄名', '市場・商品区分',
    '33業種コード', '33業種区分', '17業種コード', '17業種区分',
    '規模コード', '規模区分',
]


class _FakeCell:
    def __init__(self, value):
        self.value = value


class _FakeSheet:
    """xlrd sheet互換の軽量fake。ネットワーク/xlrd不要でparse_rows_from_sheetを
    テストするために使う（xlrd自体の動作検証は
    test_valid_xls_parse_end_to_end で行う）。"""

    def __init__(self, header, data_rows):
        self._header = header
        self._data = data_rows
        self.nrows = 1 + len(data_rows)
        self.ncols = len(header)

    def cell(self, r, c):
        if r == 0:
            return _FakeCell(self._header[c])
        return _FakeCell(self._data[r - 1][c])


def _row(date=20260630.0, code=1301.0, name='極洋', market='プライム（内国株式）', sector='水産・農林業'):
    return [date, code, name, market, 50.0, sector, 1.0, '食品', 6.0, 'TOPIX Small 1']


def _sheet(rows):
    return _FakeSheet(FULL_HEADER, rows)


def _bulk_rows(n, market='プライム（内国株式）', start_code=1300):
    """MIN_RAW_ROW_COUNT/MIN_ELIGIBLE_COUNT絶対floorを満たす件数のrowを
    合成するためのhelper。get_jpx_universe()をfake fetch/parse経由で通す
    テストは、floor未満だと(意図せず)fallbackへ落ちてしまうため使う。"""
    return [_row(code=float(start_code + i), name=f'銘柄{i}', market=market) for i in range(n)]


# ---------------------------------------------------------------------------
# 1. valid xls parse / 3-4. code string preservation, 4桁数字code
# ---------------------------------------------------------------------------

class TestValidParse:
    def test_valid_rows_parsed(self):
        rows, dropped = parse_rows_from_sheet(_sheet([
            _row(code=1301.0, name='極洋'),
            _row(code=7203.0, name='トヨタ自動車'),
        ]))
        assert len(rows) == 2
        assert dropped == []

    def test_code_is_always_str(self):
        rows, _ = parse_rows_from_sheet(_sheet([_row(code=1301.0)]))
        assert isinstance(rows[0]['code'], str)

    def test_four_digit_numeric_code_preserved_without_decimal(self):
        rows, _ = parse_rows_from_sheet(_sheet([_row(code=1301.0)]))
        assert rows[0]['code'] == '1301'

    def test_valid_xls_parse_end_to_end_real_file(self):
        # xlrdでOLE2/xls bytesを実際に開けることを確認する統合テスト。
        # 手書きの最小xlsをxlrd APIだけで作るのは非現実的なため、
        # xlrd自体のOLE2読み込み経路の実データ検証はP5-B004b-1 dry-run
        # （2026-07-14実施、handover/memory記録済み・本リポジトリには
        # 常設テストとして同梱しない、network必須のため）で担保している。
        # ここではparse_jpx_xls_bytesが不正bytesに対し正しくJPXParseErrorを
        # 送出すること（xlrd経路が呼ばれていること）を確認する。
        with pytest.raises(JPXParseError):
            parse_jpx_xls_bytes(b"not an xls file at all")


# ---------------------------------------------------------------------------
# 2. required columns
# ---------------------------------------------------------------------------

class TestRequiredColumns:
    def test_missing_required_column_raises_schema_error(self):
        header = ['日付', 'コード', '銘柄名']  # 市場・商品区分が欠損
        sheet = _FakeSheet(header, [[20260630.0, 1301.0, '極洋']])
        with pytest.raises(JPXSchemaError):
            parse_rows_from_sheet(sheet)

    def test_all_required_columns_present_succeeds(self):
        rows, _ = parse_rows_from_sheet(_sheet([_row()]))
        assert len(rows) == 1

    def test_required_columns_constant(self):
        assert set(REQUIRED_COLUMNS) == {'コード', '銘柄名', '市場・商品区分'}


# ---------------------------------------------------------------------------
# 5. 英字混在code
# ---------------------------------------------------------------------------

class TestAlphaMixedCode:
    def test_alpha_mixed_code_preserved_as_str(self):
        rows, _ = parse_rows_from_sheet(_sheet([_row(code='166A', name='タスキHD')]))
        assert rows[0]['code'] == '166A'
        assert isinstance(rows[0]['code'], str)

    def test_alpha_mixed_four_digit_code_is_not_excluded_by_eligibility(self):
        rows, _ = parse_rows_from_sheet(_sheet([
            _row(code='166A', name='タスキHD'),
            _row(code=1301.0, name='極洋'),
        ]))
        eligible, _, _ = apply_eligibility(rows)
        codes = {r['code'] for r in eligible}
        assert '166A' in codes

    def test_is_preferred_or_class_share_uses_digit_count_not_char_type(self):
        assert is_preferred_or_class_share('166A') is False  # 4桁 → 保持
        assert is_preferred_or_class_share('1301') is False  # 4桁 → 保持
        assert is_preferred_or_class_share('25935') is True  # 5桁 → 除外


# ---------------------------------------------------------------------------
# 6. duplicate reject
# ---------------------------------------------------------------------------

class TestDuplicateReject:
    def test_detect_duplicate_codes(self):
        rows, _ = parse_rows_from_sheet(_sheet([
            _row(code=1301.0, name='極洋'),
            _row(code=1301.0, name='極洋(dup)'),
        ]))
        dupes = detect_duplicate_codes(rows)
        assert dupes == ['1301']

    def test_no_duplicates_returns_empty(self):
        rows, _ = parse_rows_from_sheet(_sheet([
            _row(code=1301.0), _row(code=7203.0, name='トヨタ'),
        ]))
        assert detect_duplicate_codes(rows) == []

    def test_get_jpx_universe_rejects_duplicates_and_falls_back(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        rows = [_row(code=1301.0), _row(code=1301.0, name='dup')]

        def fake_fetch():
            return b"irrelevant"

        def fake_parse(_content):
            return parse_rows_from_sheet(_sheet(rows))

        result = get_jpx_universe(
            now=_NOW, fetch_fn=fake_fetch, parse_fn=fake_parse, cache_path=cache_path
        )
        # cacheなしなのでseed fallbackへ
        assert result.fallback_used is True
        assert result.universe_id == FALLBACK_UNIVERSE_ID


# ---------------------------------------------------------------------------
# 7. malformed row handling
# ---------------------------------------------------------------------------

class TestMalformedRow:
    def test_missing_code_row_dropped(self):
        rows, dropped = parse_rows_from_sheet(_sheet([
            _row(code=1301.0),
            _row(code='', name='欠損コード銘柄'),
        ]))
        assert len(rows) == 1
        assert len(dropped) == 1
        assert dropped[0]['reason'] == 'missing_code'

    def test_missing_name_row_dropped(self):
        rows, dropped = parse_rows_from_sheet(_sheet([
            _row(code=1301.0, name=''),
        ]))
        assert len(rows) == 0
        assert len(dropped) == 1
        assert dropped[0]['reason'] == 'missing_required_field'

    def test_dropped_rows_do_not_stop_parsing_of_others(self):
        rows, dropped = parse_rows_from_sheet(_sheet([
            _row(code='', name='欠損'),
            _row(code=1301.0, name='極洋'),
        ]))
        assert len(rows) == 1
        assert rows[0]['code'] == '1301'
        assert len(dropped) == 1


# ---------------------------------------------------------------------------
# 8. exact eligibility filter / 9. 1559 vs 1560差
# ---------------------------------------------------------------------------

class TestEligibility:
    def _build_realistic_rows(self):
        rows = []
        rows.append(_row(code=1301.0, market='プライム（内国株式）'))       # eligible
        rows.append(_row(code='166A', market='プライム（内国株式）'))       # eligible (alpha-mixed)
        rows.append(_row(code=25935.0, market='プライム（内国株式）', name='伊藤園第１種優先株式'))  # excluded: 5桁
        rows.append(_row(code=1305.0, market='ETF・ETN'))                    # excluded: ETF
        rows.append(_row(code=8697.0, market='PRO Market'))                  # excluded: PRO Market
        rows.append(_row(code=2971.0, market='REIT・ベンチャーファンド・カントリーファンド・インフラファンド'))  # excluded: REIT
        rows.append(_row(code=1305.0, market='スタンダード（内国株式）'))    # excluded: Standard
        rows.append(_row(code=9999.0, market='グロース（内国株式）'))       # excluded: Growth
        rows.append(_row(code=1234.0, market='出資証券'))                   # excluded: 出資証券
        rows.append(_row(code=8697.0, market='プライム（外国株式）'))       # excluded: 外国株
        return rows

    def test_eligibility_stage_counts(self):
        raw_rows = self._build_realistic_rows()
        parsed, _ = parse_rows_from_sheet(_sheet(raw_rows))
        eligible, segment_counts, filters_applied = apply_eligibility(parsed)

        assert filters_applied[0] == {"stage": "source_rows", "count": 10}
        assert filters_applied[1]["stage"] == "market_segment_prime_domestic_common_strict_match"
        assert filters_applied[1]["count"] == 3  # 1301, 166A, 25935 の3件がプライム内国株式
        assert filters_applied[2]["stage"] == "exclude_preferred_or_class_shares_5digit_code"
        assert filters_applied[2]["count"] == 2  # 25935を除外して2件
        assert filters_applied[2]["excluded_count"] == 1
        assert filters_applied[2]["excluded_codes"] == ["25935"]

        eligible_codes = {r['code'] for r in eligible}
        assert eligible_codes == {'1301', '166A'}

    def test_1559_vs_1560_difference_is_foreign_prime_row(self):
        """dry-runのstr.contains('プライム')は「プライム（外国株式）」も含めて
        しまうため+1件になっていた。厳密一致eligibilityは含めない。"""
        rows_strict_only = [_row(code=1301.0, market='プライム（内国株式）')]
        rows_with_foreign = rows_strict_only + [_row(code=9999.0, market='プライム（外国株式）', name='外国株')]

        parsed_strict, _ = parse_rows_from_sheet(_sheet(rows_strict_only))
        parsed_with_foreign, _ = parse_rows_from_sheet(_sheet(rows_with_foreign))

        eligible_strict, _, _ = apply_eligibility(parsed_strict)
        eligible_with_foreign, _, _ = apply_eligibility(parsed_with_foreign)

        # 厳密一致(本provider契約)ではプライム外国株式を含めないため件数は変わらない
        assert len(eligible_strict) == 1
        assert len(eligible_with_foreign) == 1  # 外国株式は除外されるまま

        # str.containsのような緩い判定を模した場合のみ+1件になることを示す
        loose_match_count = sum(
            1 for r in parsed_with_foreign if 'プライム' in r['market_segment']
        )
        assert loose_match_count == 2  # プライム内国株式1 + プライム外国株式1 = dry-runの1560相当の差分要因

    def test_real_data_eligible_count_matches_expected_1552(self):
        """2026-07-14実データ検証（JPX公式data_j.xls, 4437行, Prime内国株式1559件,
        うち5桁優先株/種類株式7件除外）で確認したeligibleCount=1552をロジック単体で
        再現する（実ファイルは同梱せず、実データから確認した market_segment分布と
        5桁優先株codeのみをfixtureとして再構成する）。"""
        rows = []
        for i in range(1552):
            rows.append(_row(code=float(1300 + i), name=f'銘柄{i}', market='プライム（内国株式）'))
        preferred_codes = [25935.0, 50765.0, 75505.0, 92015.0, 92025.0, 94345.0, 94346.0]
        for c in preferred_codes:
            rows.append(_row(code=c, name='優先株式', market='プライム（内国株式）'))
        for i in range(1563):
            rows.append(_row(code=float(30000 + i), name=f'standard{i}', market='スタンダード（内国株式）'))

        parsed, _ = parse_rows_from_sheet(_sheet(rows))
        eligible, _, filters_applied = apply_eligibility(parsed)
        assert filters_applied[1]["count"] == 1559
        assert len(eligible) == 1552


# ---------------------------------------------------------------------------
# 10. provenance metadata
# ---------------------------------------------------------------------------

class TestProvenance:
    def test_result_has_full_provenance_fields(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        rows = _bulk_rows(1200) + [_row(code='166A')]

        def fake_fetch():
            return b"irrelevant"

        def fake_parse(_content):
            return parse_rows_from_sheet(_sheet(rows))

        result = get_jpx_universe(
            now=_NOW, fetch_fn=fake_fetch, parse_fn=fake_parse, cache_path=cache_path
        )

        assert result.universe_id == UNIVERSE_ID
        assert result.source == "jpx_data_j_xls"
        assert result.source_identifier == "jpx_data_j_xls"
        assert result.fetched_at == _NOW.isoformat()
        assert result.source_as_of == "2026-06-30"
        assert result.row_count == 1201
        assert result.eligible_count == 1201
        assert result.fallback_used is False
        assert result.cache_age_hours == 0.0
        assert isinstance(result.segment_counts, dict)
        assert isinstance(result.filters_applied, list) and len(result.filters_applied) == 3
        assert result.dropped_rows == []


# ---------------------------------------------------------------------------
# 11-13. fetch failure / corrupt cache / no cache fallback chain
# ---------------------------------------------------------------------------

class TestFallbackChain:
    def _seed_valid_cache(self, cache_path, row_count=2):
        save_cache({
            "schemaKind": "jpx_universe_cache_v1",
            "universe_id": UNIVERSE_ID,
            "items": [["1301", "極洋", "水産・農林業"], ["166A", "タスキHD", "建設業"]][:row_count],
            "source": "jpx_data_j_xls",
            "fetched_at": (_NOW - timedelta(hours=5)).isoformat(),
            "source_as_of": "2026-06-30",
            "row_count": row_count,
            "segment_counts": {"プライム（内国株式）": row_count},
            "filters_applied": [],
        }, cache_path)

    def test_fetch_failure_falls_back_to_valid_cache(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        self._seed_valid_cache(cache_path)

        def failing_fetch():
            raise JPXFetchError("boom")

        result = get_jpx_universe(now=_NOW, fetch_fn=failing_fetch, cache_path=cache_path)
        assert result.fallback_used is True
        assert result.universe_id == UNIVERSE_ID
        assert result.cache_age_hours == pytest.approx(5.0, abs=0.01)
        assert len(result.items) == 2

    def test_corrupt_cache_is_not_used_as_fallback(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text("{not valid json", encoding="utf-8")

        assert load_cache(cache_path) is None

        def failing_fetch():
            raise JPXFetchError("boom")

        result = get_jpx_universe(now=_NOW, fetch_fn=failing_fetch, cache_path=cache_path)
        # corrupt cacheは使えないのでseed_list_v1へ
        assert result.fallback_used is True
        assert result.universe_id == FALLBACK_UNIVERSE_ID

    def test_schema_invalid_cache_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache({"schemaKind": "wrong_kind", "items": []}, cache_path)
        assert load_cache(cache_path) is None

    def test_no_cache_falls_back_to_seed_list_v1(self, tmp_path):
        cache_path = tmp_path / "does_not_exist.json"

        def failing_fetch():
            raise JPXFetchError("boom")

        result = get_jpx_universe(now=_NOW, fetch_fn=failing_fetch, cache_path=cache_path)
        assert result.fallback_used is True
        assert result.universe_id == FALLBACK_UNIVERSE_ID
        assert result.cache_age_hours is None
        assert len(result.items) == len(SEED_LIST)

    def test_seed_list_v1_fallback_matches_existing_seed_list(self):
        result = seed_list_v1_fallback(_NOW)
        assert result.items == list(SEED_LIST)
        assert result.universe_id == "seed_list_v1"

    def test_live_fetch_success_updates_cache(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        rows = _bulk_rows(1200)

        def fake_fetch():
            return b"irrelevant"

        def fake_parse(_content):
            return parse_rows_from_sheet(_sheet(rows))

        get_jpx_universe(now=_NOW, fetch_fn=fake_fetch, parse_fn=fake_parse, cache_path=cache_path)
        cached = load_cache(cache_path)
        assert cached is not None
        assert cached["row_count"] == 1200


# ---------------------------------------------------------------------------
# row count急減guard
# ---------------------------------------------------------------------------

class TestRowCountGuard:
    def test_row_count_below_70_percent_triggers_cache_fallback(self, tmp_path):
        # baselineを2000にすることで、60%(=1200)がMIN_RAW_ROW_COUNT(1000)の
        # 絶対floorではなくratio guard自体で弾かれることを検証する。
        cache_path = tmp_path / "cache.json"
        save_cache({
            "schemaKind": "jpx_universe_cache_v1",
            "universe_id": UNIVERSE_ID,
            "items": [["1301", "極洋", "水産・農林業"]],
            "source": "jpx_data_j_xls",
            "fetched_at": (_NOW - timedelta(hours=2)).isoformat(),
            "row_count": 2000,
            "segment_counts": {},
            "filters_applied": [],
        }, cache_path)

        small_rows = _bulk_rows(1200)  # 2000の60% < 70%閾値（絶対floor1000は超える）

        def fake_fetch():
            return b"irrelevant"

        def fake_parse(_content):
            return parse_rows_from_sheet(_sheet(small_rows))

        result = get_jpx_universe(
            now=_NOW, fetch_fn=fake_fetch, parse_fn=fake_parse, cache_path=cache_path
        )
        assert result.fallback_used is True
        assert result.universe_id == UNIVERSE_ID  # cacheの中身のuniverse_id

    def test_row_count_above_70_percent_does_not_trigger_guard(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache({
            "schemaKind": "jpx_universe_cache_v1",
            "universe_id": UNIVERSE_ID,
            "items": [["1301", "極洋", "水産・農林業"]],
            "source": "jpx_data_j_xls",
            "fetched_at": (_NOW - timedelta(hours=2)).isoformat(),
            "row_count": 2000,
            "segment_counts": {},
            "filters_applied": [],
        }, cache_path)

        ok_rows = _bulk_rows(1600)  # 2000の80% >= 70%閾値

        def fake_fetch():
            return b"irrelevant"

        def fake_parse(_content):
            return parse_rows_from_sheet(_sheet(ok_rows))

        result = get_jpx_universe(
            now=_NOW, fetch_fn=fake_fetch, parse_fn=fake_parse, cache_path=cache_path
        )
        assert result.fallback_used is False
        assert result.row_count == 1600


# ---------------------------------------------------------------------------
# 14. oversized JPX universeをexisting enrichmentへ直結しない
# ---------------------------------------------------------------------------

class TestProductionCompatibility:
    def test_jpx_scale_eligible_universe_exceeds_enrichment_guard(self):
        assert 1552 > MAX_ENRICHMENT_UNIVERSE

    def test_enforce_enrichment_guard_rejects_jpx_scale_universe(self):
        jpx_scale_universe = [(str(i), f"n{i}", "s") for i in range(1552)]
        with pytest.raises(EnrichmentGuardExceeded):
            enforce_enrichment_guard(jpx_scale_universe)

    def test_build_candidates_stocks_module_unmodified_default_provider(self):
        # このticketではJPXUniverseResultをdefault_universe_providerとして
        # 接続しない。既存41 seed動作が変わっていないことを確認する。
        from data.build_candidates_stocks import default_universe_provider
        universe_id, items = default_universe_provider()
        assert universe_id == "seed_list_v1"
        assert len(items) == 41


# ---------------------------------------------------------------------------
# 15. personal holdings/trust/cash/account非参照
# ---------------------------------------------------------------------------

class TestNoPersonalData:
    def test_result_dict_has_no_forbidden_keys(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        rows = [_row(code=1301.0)]

        def fake_fetch():
            return b"irrelevant"

        def fake_parse(_content):
            return parse_rows_from_sheet(_sheet(rows))

        result = get_jpx_universe(
            now=_NOW, fetch_fn=fake_fetch, parse_fn=fake_parse, cache_path=cache_path
        )
        result_keys = set(result._asdict().keys())
        assert not (FORBIDDEN_KEYS & result_keys)

    def test_source_module_does_not_import_holdings_or_portfolio(self):
        import data.jpx_universe_provider as mod
        src = open(mod.__file__, encoding='utf-8').read()
        for forbidden in ('holdings', 'portfolio_state', 'account_type', 'nisa'):
            assert forbidden not in src.lower()


# ---------------------------------------------------------------------------
# 16. public/dataへcache非配信
# ---------------------------------------------------------------------------

class TestCacheNotPublic:
    def test_cache_path_is_not_under_public_data(self):
        assert "public/data" not in str(CACHE_PATH).replace("\\", "/")
        assert "public" not in CACHE_PATH.parts

    def test_full_batch_workflow_does_not_copy_jpx_cache_to_public(self):
        # P5-B005-JPX-UNIVERSE-PRODUCTION-RECOVERY: the internal JPX cache is now
        # referenced by an actions/cache step (cross-run persistence). It must
        # still never be copied into public/data, staged, or published — assert
        # the *intent* (no cache path on any copy/publish line), not string
        # absence.
        import pathlib
        workflow_path = pathlib.Path(__file__).parent.parent / ".github" / "workflows" / "full_batch.yml"
        content = workflow_path.read_text(encoding="utf-8")

        for line in content.splitlines():
            if ".jpx_cache" not in line and "jpx_universe_cache" not in line:
                continue
            lowered = line.lower()
            assert "public/data" not in lowered, line
            assert "cp " not in lowered, line
            assert "upload-artifact" not in lowered, line
            assert "git add" not in lowered, line

        # The "Copy JSON to public/data" loop must only carry the fixed public
        # basenames, never the internal cache.
        copy_step = content.split("Copy JSON to public/data", 1)[1].split("- name:", 1)[0]
        assert "jpx_cache" not in copy_step
        assert "jpx_universe_cache" not in copy_step


# ---------------------------------------------------------------------------
# P5-B004b-1 hardening: F2 — .jpx_cache/の実際のgit ignore契約
# 単なる文字列testではなく、実repoに対しgit check-ignore / git addを実行し
# 実際の契約を確認する。
# ---------------------------------------------------------------------------

class TestCacheGitIgnored:
    def test_cache_path_is_git_ignored(self):
        repo_root = Path(__file__).resolve().parent.parent
        result = subprocess.run(
            ["git", "check-ignore", "-q", str(CACHE_PATH)],
            cwd=repo_root,
        )
        assert result.returncode == 0

    def test_broad_data_staging_does_not_stage_cache(self):
        # full_batch.ymlの`git add data/ public/data/`と同じ広いstagingを
        # --dry-runで再現し、実在するcacheファイルがstageされないことを検証する。
        repo_root = Path(__file__).resolve().parent.parent
        cache_dir = repo_root / "data" / ".jpx_cache"
        cache_dir_existed = cache_dir.exists()
        probe_path = cache_dir / "jpx_universe_cache.json"
        probe_existed = probe_path.exists()
        cache_dir.mkdir(parents=True, exist_ok=True)
        if not probe_existed:
            probe_path.write_text("{}", encoding="utf-8")
        try:
            result = subprocess.run(
                ["git", "add", "--dry-run", "data/", "public/data/"],
                cwd=repo_root,
                capture_output=True,
                text=True,
            )
            assert ".jpx_cache" not in result.stdout
        finally:
            if not probe_existed:
                probe_path.unlink(missing_ok=True)
            if not cache_dir_existed:
                try:
                    cache_dir.rmdir()
                except OSError:
                    pass


# ---------------------------------------------------------------------------
# P5-B004b-1 hardening: F5/T1 — requests/xlrd未導入時の正規化
# ---------------------------------------------------------------------------

class TestDependencyFailureNormalization:
    def test_missing_requests_raises_jpx_fetch_error(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "requests", None)
        with pytest.raises(JPXFetchError):
            fetch_jpx_xls()

    def test_missing_xlrd_raises_jpx_parse_error(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "xlrd", None)
        with pytest.raises(JPXParseError):
            parse_jpx_xls_bytes(b"irrelevant")

    def test_missing_requests_flows_into_fallback_chain(self, monkeypatch, tmp_path):
        # xlrd未導入環境でも(このtestはrequestsのみ欠如させるため)redにならない。
        monkeypatch.setitem(sys.modules, "requests", None)
        cache_path = tmp_path / "cache.json"
        result = get_jpx_universe(now=_NOW, fetch_fn=fetch_jpx_xls, cache_path=cache_path)
        assert result.fallback_used is True
        assert result.universe_id == FALLBACK_UNIVERSE_ID
        assert not cache_path.exists()

    def test_missing_xlrd_flows_into_fallback_chain(self, monkeypatch, tmp_path):
        # sys.modulesを直接偽装するため、実行環境に実際のxlrdが入っているか
        # どうかに関わらずこのtestは決定的にpassする（xlrd未導入環境でもred化しない）。
        monkeypatch.setitem(sys.modules, "xlrd", None)
        cache_path = tmp_path / "cache.json"

        def fake_fetch():
            return b"irrelevant"

        result = get_jpx_universe(
            now=_NOW, fetch_fn=fake_fetch, parse_fn=parse_jpx_xls_bytes, cache_path=cache_path
        )
        assert result.fallback_used is True
        assert result.universe_id == FALLBACK_UNIVERSE_ID
        assert not cache_path.exists()


# ---------------------------------------------------------------------------
# P5-B004b-1 hardening: F1/F7 — raw/eligible absolute floor・eligible ratio guard
# ---------------------------------------------------------------------------

class TestEligibilityIntegrityGuard:
    def test_eligible_zero_with_normal_raw_rows_falls_back_without_cache_pollution(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        # raw row countはMIN_RAW_ROW_COUNTを超えるが、market segmentが
        # ズレておりeligible=0（market label drift相当、F1が捕捉すべき事象）。
        drifted_rows = _bulk_rows(1200, market='スタンダード（内国株式）')

        def fake_fetch():
            return b"irrelevant"

        def fake_parse(_content):
            return parse_rows_from_sheet(_sheet(drifted_rows))

        result = get_jpx_universe(
            now=_NOW, fetch_fn=fake_fetch, parse_fn=fake_parse, cache_path=cache_path
        )
        assert result.fallback_used is True
        assert result.universe_id == FALLBACK_UNIVERSE_ID
        assert load_cache(cache_path) is None  # cache非汚染（生成もされない）
        assert not cache_path.exists()

    def test_eligible_extreme_drop_falls_back_without_overwriting_last_good_cache(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        previous_items = [[str(2000 + i), f'既存銘柄{i}', 'sector'] for i in range(1000)]
        save_cache({
            "schemaKind": "jpx_universe_cache_v1",
            "universe_id": UNIVERSE_ID,
            "items": previous_items,
            "source": "jpx_data_j_xls",
            "fetched_at": (_NOW - timedelta(hours=3)).isoformat(),
            "row_count": 1000,
            "segment_counts": {},
            "filters_applied": [],
        }, cache_path)
        before = cache_path.read_text(encoding="utf-8")

        # raw row_countは絶対floor・前回比ratioとも正常だが、eligibleだけ
        # 前回1000件の70%(700件)を大きく下回る500件に急減する。
        eligible_rows = _bulk_rows(500, market='プライム（内国株式）', start_code=1300)
        excluded_rows = _bulk_rows(700, market='スタンダード（内国株式）', start_code=9000)

        def fake_fetch():
            return b"irrelevant"

        def fake_parse(_content):
            return parse_rows_from_sheet(_sheet(eligible_rows + excluded_rows))

        result = get_jpx_universe(
            now=_NOW, fetch_fn=fake_fetch, parse_fn=fake_parse, cache_path=cache_path
        )
        assert result.fallback_used is True
        assert result.universe_id == UNIVERSE_ID  # last-good cacheのuniverse_id
        assert len(result.items) == 1000  # last-good cacheの中身がそのまま返る
        assert cache_path.read_text(encoding="utf-8") == before  # cache非汚染

    def test_first_run_truncated_raw_source_falls_back_to_seed_without_creating_cache(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        assert not cache_path.exists()

        truncated_rows = _bulk_rows(10)  # MIN_RAW_ROW_COUNT(1000)を大きく下回る

        def fake_fetch():
            return b"irrelevant"

        def fake_parse(_content):
            return parse_rows_from_sheet(_sheet(truncated_rows))

        result = get_jpx_universe(
            now=_NOW, fetch_fn=fake_fetch, parse_fn=fake_parse, cache_path=cache_path
        )
        assert result.fallback_used is True
        assert result.universe_id == FALLBACK_UNIVERSE_ID
        assert len(result.items) == len(SEED_LIST)
        assert not cache_path.exists()  # cache非生成

    def test_guard_constants_are_well_below_real_2026_07_14_contract(self):
        # 2026-07-14実データ: raw row_count=4437, eligible_count=1552。
        # floorはこれを過剰に拒否しないよう十分小さい値であること。
        assert MIN_RAW_ROW_COUNT < 4437
        assert MIN_ELIGIBLE_COUNT < 1552
        assert 0 < ELIGIBLE_COUNT_MIN_RATIO < 1


# ---------------------------------------------------------------------------
# P5-B004b-1 hardening: F3 — malformed cache itemsの深層reject
# ---------------------------------------------------------------------------

class TestMalformedCacheItemsRejected:
    def _base_payload(self, items):
        return {
            "schemaKind": "jpx_universe_cache_v1",
            "universe_id": UNIVERSE_ID,
            "items": items,
            "source": "jpx_data_j_xls",
            "fetched_at": _NOW.isoformat(),
            "row_count": len(items),
            "segment_counts": {},
            "filters_applied": [],
        }

    def test_int_item_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache(self._base_payload([123]), cache_path)
        assert load_cache(cache_path) is None

    def test_string_item_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache(self._base_payload(["garbage-item"]), cache_path)
        assert load_cache(cache_path) is None

    def test_wrong_length_item_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache(self._base_payload([["1301", "極洋"]]), cache_path)
        assert load_cache(cache_path) is None

    def test_empty_code_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache(self._base_payload([["", "極洋", "sector"]]), cache_path)
        assert load_cache(cache_path) is None

    def test_empty_name_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache(self._base_payload([["1301", "", "sector"]]), cache_path)
        assert load_cache(cache_path) is None

    def test_non_string_sector_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache(self._base_payload([["1301", "極洋", 123]]), cache_path)
        assert load_cache(cache_path) is None

    def test_valid_items_still_accepted(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache(
            self._base_payload([["1301", "極洋", "水産・農林業"], ["166A", "タスキHD", ""]]),
            cache_path,
        )
        assert load_cache(cache_path) is not None

    def test_malformed_cache_falls_back_to_seed_without_crashing(self, tmp_path):
        # F3: malformed cacheはload_cache()でNoneとなり、fallback自身が
        # tuple(123)のTypeErrorやgarbage tuple化のような新たな例外源にならない。
        cache_path = tmp_path / "cache.json"
        save_cache(self._base_payload([123]), cache_path)

        def failing_fetch():
            raise JPXFetchError("boom")

        result = get_jpx_universe(now=_NOW, fetch_fn=failing_fetch, cache_path=cache_path)
        assert result.fallback_used is True
        assert result.universe_id == FALLBACK_UNIVERSE_ID  # malformed cacheは使えずseedへ


# ---------------------------------------------------------------------------
# P5-B004b-1 hardening: 2026-07-14実データ相当（eligible=1552）が
# guardに拒否されないことをget_jpx_universe経由で確認
# ---------------------------------------------------------------------------

class TestRealisticScaleGuardPassthrough:
    def test_jpx_scale_1552_eligible_passes_all_guards(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        rows = []
        for i in range(1552):
            rows.append(_row(code=float(1300 + i), name=f'銘柄{i}', market='プライム（内国株式）'))
        preferred_codes = [25935.0, 50765.0, 75505.0, 92015.0, 92025.0, 94345.0, 94346.0]
        for c in preferred_codes:
            rows.append(_row(code=c, name='優先株式', market='プライム（内国株式）'))
        for i in range(1563):
            rows.append(_row(code=float(30000 + i), name=f'standard{i}', market='スタンダード（内国株式）'))

        def fake_fetch():
            return b"irrelevant"

        def fake_parse(_content):
            return parse_rows_from_sheet(_sheet(rows))

        result = get_jpx_universe(
            now=_NOW, fetch_fn=fake_fetch, parse_fn=fake_parse, cache_path=cache_path
        )
        assert result.fallback_used is False
        assert result.eligible_count == 1552
        assert result.row_count == len(rows)
        cached = load_cache(cache_path)
        assert cached is not None
        assert len(cached["items"]) == 1552


# ---------------------------------------------------------------------------
# P5-B004b-1 hardening: F10 — atomic cache write
# ---------------------------------------------------------------------------

class TestAtomicCacheWrite:
    def test_save_cache_leaves_no_temp_file_on_success(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache(
            {"schemaKind": "jpx_universe_cache_v1", "items": [], "row_count": 0,
             "fetched_at": _NOW.isoformat()},
            cache_path,
        )
        assert cache_path.exists()
        assert not (tmp_path / "cache.json.tmp").exists()

    def test_save_cache_preserves_existing_file_on_serialization_failure(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache(
            {"schemaKind": "jpx_universe_cache_v1", "items": [], "row_count": 1,
             "fetched_at": _NOW.isoformat()},
            cache_path,
        )
        original = cache_path.read_text(encoding="utf-8")

        class _Unserializable:
            pass

        with pytest.raises(TypeError):
            save_cache(
                {"schemaKind": "jpx_universe_cache_v1", "items": [], "row_count": 2,
                 "fetched_at": _NOW.isoformat(), "bad": _Unserializable()},
                cache_path,
            )

        assert cache_path.read_text(encoding="utf-8") == original
        assert not (tmp_path / "cache.json.tmp").exists()


# ===========================================================================
# P5-B005-JPX-UNIVERSE-PRODUCTION-RECOVERY
# ===========================================================================

_OLE2_SIG = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
_ZIP_SIG = b"PK\x03\x04"


def _listing_html(hrefs):
    """approved workbookリンクを含む最小のlisting page HTMLを合成する。"""
    anchors = "".join(f'<td><a href="{h}" rel="external">x</a></td>' for h in hrefs)
    return f"<!DOCTYPE html><html><body><table>{anchors}</table></body></html>"


def _make_xlsx_bytes(header, data_rows):
    """openpyxlで実xlsx bytesを生成する（PK/OOXML）。"""
    openpyxl = pytest.importorskip("openpyxl")
    import io

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(list(header))
    for row in data_rows:
        ws.append(list(row))
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# §23 — official listing-page discovery
# ---------------------------------------------------------------------------

class TestWorkbookDiscovery:
    def test_relative_xlsx_link_is_discovered(self):
        url = discover_workbook_url(_listing_html(
            ["/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx"]
        ))
        assert url == (
            "https://www.jpx.co.jp/markets/statistics-equities/misc/"
            "tvdivq0000001vg2-att/data_j.xlsx"
        )

    def test_legacy_relative_xls_link_is_discovered(self):
        url = discover_workbook_url(_listing_html(
            ["/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls"]
        ))
        assert url.endswith("/tvdivq0000001vg2-att/data_j.xls")

    def test_absolute_same_origin_approved_link_is_discovered(self):
        url = discover_workbook_url(_listing_html([
            "https://www.jpx.co.jp/markets/statistics-equities/misc/"
            "abc123-att/data_j.xlsx"
        ]))
        assert url.endswith("/abc123-att/data_j.xlsx")

    def test_missing_link_fails_live(self):
        with pytest.raises(JPXFetchError):
            discover_workbook_url("<html><body>no workbook here</body></html>")

    def test_malformed_html_fails_live(self):
        with pytest.raises(JPXFetchError):
            discover_workbook_url("")
        with pytest.raises(JPXFetchError):
            discover_workbook_url("<<<not really html>>>")

    def test_foreign_host_is_rejected(self):
        with pytest.raises(JPXFetchError):
            discover_workbook_url(_listing_html(["https://evil.example/data_j.xlsx"]))

    def test_protocol_relative_foreign_origin_is_rejected(self):
        with pytest.raises(JPXFetchError):
            discover_workbook_url(_listing_html(["//evil.example/a-att/data_j.xlsx"]))

    def test_http_scheme_is_rejected(self):
        with pytest.raises(JPXFetchError):
            discover_workbook_url(_listing_html([
                "http://www.jpx.co.jp/markets/statistics-equities/misc/"
                "x-att/data_j.xlsx"
            ]))

    def test_wrong_basename_is_rejected(self):
        with pytest.raises(JPXFetchError):
            discover_workbook_url(_listing_html([
                "/markets/statistics-equities/misc/x-att/all_issues.xlsx"
            ]))

    def test_wrong_path_namespace_is_rejected(self):
        with pytest.raises(JPXFetchError):
            discover_workbook_url(_listing_html([
                "https://www.jpx.co.jp/markets/other-section/x-att/data_j.xlsx"
            ]))

    def test_path_traversal_is_rejected(self):
        with pytest.raises(JPXFetchError):
            discover_workbook_url(_listing_html([
                "https://www.jpx.co.jp/markets/statistics-equities/misc/"
                "x-att/../../../data_j.xlsx"
            ]))

    def test_absolute_host_relative_traversal_is_rejected(self):
        with pytest.raises(JPXFetchError):
            discover_workbook_url(_listing_html([
                "https://www.jpx.co.jp/../../data_j.xlsx"
            ]))

    def test_javascript_and_data_uri_hrefs_are_rejected(self):
        for bad in ("javascript:alert('data_j.xlsx')", "data:text/html,data_j.xlsx"):
            with pytest.raises(JPXFetchError):
                discover_workbook_url(_listing_html([bad]))

    def test_non_attachment_container_is_rejected(self):
        with pytest.raises(JPXFetchError):
            discover_workbook_url(_listing_html([
                "/markets/statistics-equities/misc/plain-dir/data_j.xlsx"
            ]))

    def test_query_string_authority_trick_is_rejected(self):
        with pytest.raises(JPXFetchError):
            discover_workbook_url(_listing_html([
                "/markets/statistics-equities/misc/x-att/data_j.xlsx?../../x"
            ]))

    def test_multiple_conflicting_approved_links_fail_closed(self):
        with pytest.raises(JPXFetchError):
            discover_workbook_url(_listing_html([
                "/markets/statistics-equities/misc/aaa-att/data_j.xlsx",
                "/markets/statistics-equities/misc/bbb-att/data_j.xls",
            ]))

    def test_same_url_listed_twice_is_not_ambiguous(self):
        href = "/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx"
        url = discover_workbook_url(_listing_html([href, href]))
        assert url.endswith("/data_j.xlsx")

    def test_constants_are_sane(self):
        assert JPX_ALLOWED_HOST == "www.jpx.co.jp"
        assert JPX_LISTING_PAGE_URL.startswith("https://www.jpx.co.jp/")
        assert set(APPROVED_WORKBOOK_BASENAMES) == {"data_j.xls", "data_j.xlsx"}


# ---------------------------------------------------------------------------
# §24 — signature-based format detection
# ---------------------------------------------------------------------------

class TestWorkbookFormatDetection:
    def test_valid_ole2_is_xls(self):
        assert detect_workbook_format(_OLE2_SIG + b"\x00" * 512) == "xls"

    def test_valid_zip_ooxml_is_xlsx(self):
        assert detect_workbook_format(_ZIP_SIG + b"\x00" * 512) == "xlsx"

    def test_real_openpyxl_xlsx_is_xlsx(self):
        content = _make_xlsx_bytes(FULL_HEADER, [_row()])
        assert detect_workbook_format(content) == "xlsx"

    def test_html_bytes_rejected(self):
        with pytest.raises(JPXFetchError):
            detect_workbook_format(b"<!DOCTYPE html><html><head>404</head></html>" + b" " * 40)
        with pytest.raises(JPXFetchError):
            detect_workbook_format(b"   <html>error</html>" + b" " * 40)

    def test_truncated_garbage_rejected(self):
        with pytest.raises(JPXFetchError):
            detect_workbook_format(b"PK")
        with pytest.raises(JPXFetchError):
            detect_workbook_format(b"\x01\x02\x03\x04\x05\x06\x07\x08garbage")

    def test_empty_or_spanned_zip_rejected(self):
        with pytest.raises(JPXFetchError):
            detect_workbook_format(b"PK\x05\x06" + b"\x00" * 40)
        with pytest.raises(JPXFetchError):
            detect_workbook_format(b"PK\x07\x08" + b"\x00" * 40)

    def test_parse_workbook_bytes_dispatches_and_fails_closed(self):
        # HTML disguised → JPXParseError（fallback chainへ）
        with pytest.raises(JPXParseError):
            parse_jpx_workbook_bytes(b"<!DOCTYPE html><html>err</html>" + b" " * 40)
        with pytest.raises(JPXParseError):
            parse_jpx_workbook_bytes(b"not-a-workbook-at-all-xxxxxxxx")

    def test_parse_workbook_bytes_routes_xlsx_to_openpyxl(self):
        pytest.importorskip("openpyxl")
        content = _make_xlsx_bytes(FULL_HEADER, [_row(code=1301.0), _row(code=7203.0, name='トヨタ')])
        rows, dropped = parse_jpx_workbook_bytes(content)
        assert {r["code"] for r in rows} == {"1301", "7203"}
        assert dropped == []

    def test_invalid_zip_that_is_not_xlsx_workbook_is_rejected(self):
        import io, zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("hello.txt", "not a workbook")
        with pytest.raises(JPXParseError):
            parse_jpx_workbook_bytes(buf.getvalue())


# ---------------------------------------------------------------------------
# §25 — XLS / XLSX canonical parity
# ---------------------------------------------------------------------------

class TestXlsXlsxCanonicalParity:
    def _logical_rows(self):
        # (date, code, name, market, sector)。同一の論理listed-issue集合を
        # xls風(xlrd=float)とxlsx(openpyxl=int/native)の双方で表現する。
        return [
            (20260831, 1301, "極洋", "プライム（内国株式）", "水産・農林業"),
            (20260831, 7203, "トヨタ自動車", "プライム（内国株式）", "輸送用機器"),
            (20260831, "166A", "タスキHD", "プライム（内国株式）", "建設業"),
            (20260831, 25935, "伊藤園優先", "プライム（内国株式）", "食料品"),
            (20260831, 1305, "ETF", "ETF・ETN", "-"),
            (20260831, 9999, "グロース銘柄", "グロース（内国株式）", "情報・通信業"),
            (20260831, 8697, "外国株", "プライム（外国株式）", "その他"),
        ]

    def _xls_side_sheet(self):
        rows = []
        for d, code, name, market, sector in self._logical_rows():
            xls_code = float(code) if isinstance(code, int) else code
            rows.append([float(d), xls_code, name, market, 50.0, sector, 1.0, "食品", 6.0, "x"])
        return _FakeSheet(FULL_HEADER, rows)

    def _xlsx_side_bytes(self):
        rows = []
        for d, code, name, market, sector in self._logical_rows():
            rows.append([d, code, name, market, 50, sector, 1, "食品", 6, "x"])
        return _make_xlsx_bytes(FULL_HEADER, rows)

    def test_parsed_rows_are_equivalent(self):
        pytest.importorskip("openpyxl")
        xls_rows, xls_dropped = parse_rows_from_sheet(self._xls_side_sheet())
        xlsx_rows, xlsx_dropped = parse_jpx_xlsx_bytes(self._xlsx_side_bytes())

        def norm(rows):
            return [
                (r["code"], r["name"], r["market_segment"], r["sector"])
                for r in rows
            ]

        assert norm(xls_rows) == norm(xlsx_rows)
        assert len(xls_dropped) == len(xlsx_dropped)

    def test_eligibility_output_is_equivalent(self):
        pytest.importorskip("openpyxl")
        xls_rows, _ = parse_rows_from_sheet(self._xls_side_sheet())
        xlsx_rows, _ = parse_jpx_xlsx_bytes(self._xlsx_side_bytes())

        xls_elig, xls_seg, xls_filters = apply_eligibility(xls_rows)
        xlsx_elig, xlsx_seg, xlsx_filters = apply_eligibility(xlsx_rows)

        assert [r["code"] for r in xls_elig] == [r["code"] for r in xlsx_elig]
        assert {r["code"] for r in xls_elig} == {"1301", "7203", "166A"}
        assert xls_seg == xlsx_seg
        assert xls_filters == xlsx_filters

    def test_full_provider_parity_via_get_jpx_universe(self, tmp_path):
        pytest.importorskip("openpyxl")
        # 絶対floorを満たすため、eligible行を1200件へ増やした等価な合成workbook。
        base = [
            (20260831, 1300 + i, f"銘柄{i}", "プライム（内国株式）", "sector")
            for i in range(1200)
        ]
        xls_rows = [[float(d), float(c), n, m, 50.0, s, 1.0, "食品", 6.0, "x"] for d, c, n, m, s in base]
        xlsx_rows = [[d, c, n, m, 50, s, 1, "食品", 6, "x"] for d, c, n, m, s in base]

        xls_result = get_jpx_universe(
            now=_NOW,
            fetch_fn=lambda: b"irrelevant",
            parse_fn=lambda _c: parse_rows_from_sheet(_FakeSheet(FULL_HEADER, xls_rows)),
            cache_path=tmp_path / "xls_cache.json",
        )
        xlsx_bytes = _make_xlsx_bytes(FULL_HEADER, xlsx_rows)
        xlsx_result = get_jpx_universe(
            now=_NOW,
            fetch_fn=lambda: xlsx_bytes,
            parse_fn=parse_jpx_workbook_bytes,
            cache_path=tmp_path / "xlsx_cache.json",
        )

        assert xls_result.fallback_used is False
        assert xlsx_result.fallback_used is False
        assert xls_result.items == xlsx_result.items
        assert xls_result.eligible_count == xlsx_result.eligible_count == 1200
        assert xls_result.row_count == xlsx_result.row_count
        assert xls_result.source_as_of == xlsx_result.source_as_of == "2026-08-31"
        assert xlsx_result.workbook_format == "xlsx"
        assert xls_result.segment_counts == xlsx_result.segment_counts


# ---------------------------------------------------------------------------
# §27 — fallback matrix (live discovery path)
# ---------------------------------------------------------------------------

class TestDiscoveryFallbackMatrix:
    def _valid_cache(self, cache_path):
        save_cache({
            "schemaKind": "jpx_universe_cache_v1",
            "universe_id": UNIVERSE_ID,
            "items": [["1301", "極洋", "水産・農林業"], ["7203", "トヨタ", "輸送用機器"]],
            "source": "jpx_data_j_xls",
            "fetched_at": (_NOW - timedelta(hours=6)).isoformat(),
            "source_as_of": "2026-08-31",
            "row_count": 4400,
            "segment_counts": {},
            "filters_applied": [],
            "workbook_format": "xlsx",
        }, cache_path)

    def test_page_fetch_failure_with_cache_uses_cache(self, tmp_path):
        cache_path = tmp_path / "c.json"
        self._valid_cache(cache_path)

        def boom():
            raise JPXFetchError("listing page 500")

        result = get_jpx_universe(now=_NOW, fetch_fn=boom, cache_path=cache_path)
        assert result.fallback_used is True
        assert result.universe_id == UNIVERSE_ID
        assert len(result.items) == 2

    def test_workbook_parse_failure_with_cache_uses_cache(self, tmp_path):
        cache_path = tmp_path / "c.json"
        self._valid_cache(cache_path)

        result = get_jpx_universe(
            now=_NOW,
            fetch_fn=lambda: b"<!DOCTYPE html><html>err</html>" + b" " * 40,
            parse_fn=parse_jpx_workbook_bytes,
            cache_path=cache_path,
        )
        assert result.fallback_used is True
        assert result.universe_id == UNIVERSE_ID

    def test_live_fail_no_cache_uses_seed(self, tmp_path):
        result = get_jpx_universe(
            now=_NOW,
            fetch_fn=lambda: (_ for _ in ()).throw(JPXFetchError("no page")),
            cache_path=tmp_path / "missing.json",
        )
        assert result.fallback_used is True
        assert result.universe_id == FALLBACK_UNIVERSE_ID
