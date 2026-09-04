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
import hashlib
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
    ATTESTATION_PATH,
    CACHE_PATH,
    ELIGIBLE_COUNT_MIN_RATIO,
    FALLBACK_UNIVERSE_ID,
    JPX_ALLOWED_HOST,
    JPX_LISTING_PAGE_URL,
    MARKET_SEGMENT_PRIME_DOMESTIC,
    MAX_CACHE_AGE_HOURS,
    MAX_REDIRECTS,
    MIN_ELIGIBLE_COUNT,
    MIN_RAW_ROW_COUNT,
    REQUIRED_COLUMNS,
    SOURCE_IDENTIFIER,
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
    download_workbook,
    fetch_jpx_workbook_bytes,
    fetch_jpx_xls,
    fetch_listing_page,
    get_jpx_universe,
    is_preferred_or_class_share,
    jpx_cache_save_eligible,
    load_attestation,
    load_cache,
    parse_jpx_workbook_bytes,
    parse_jpx_xls_bytes,
    parse_jpx_xlsx_bytes,
    parse_rows_from_sheet,
    save_cache,
    seed_list_v1_fallback,
)
from data.jpx_universe_provider import _is_canonical_jpx_code  # noqa: PLC2701 - 単一canonical実装への直接単体テスト

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


def _cache_items(n, start_code=1300):
    """last-good cache用の(code, name, sector)itemsをn件合成する。4桁数字
    codeはis_preferred_or_class_share()に該当しない（authority validatorの
    eligibility再チェックを通る）。"""
    return [[str(start_code + i), f'銘柄{i}', 'sector'] for i in range(n)]


def _valid_cache_payload(
    *,
    items=None,
    row_count=None,
    fetched_at=None,
    universe_id=UNIVERSE_ID,
    source='jpx_data_j_xls',
    segment_counts=None,
    filters_applied=None,
    source_as_of='2026-06-30',
    workbook_format='xlsx',
):
    """RESTORED_CACHE_REVALIDATED配下のtestで共有する、_cache_authority_valid()
    を通る最小限に整合したcache payload builder。個々のtestは差分だけ上書きし、
    重複コードで整合性を崩さないようにする。"""
    if items is None:
        items = _cache_items(MIN_ELIGIBLE_COUNT)
    if row_count is None:
        # rawのMIN_RAW_ROW_COUNT floorとeligible(items)件数の両方を満たす。
        row_count = max(len(items), MIN_RAW_ROW_COUNT)
    if fetched_at is None:
        fetched_at = _NOW.isoformat()
    if segment_counts is None:
        segment_counts = {MARKET_SEGMENT_PRIME_DOMESTIC: len(items)}
        other = row_count - len(items)
        if other > 0:
            segment_counts['スタンダード（内国株式）'] = other
    if filters_applied is None:
        filters_applied = [
            {'stage': 'source_rows', 'count': row_count},
            {'stage': 'market_segment_prime_domestic_common_strict_match', 'count': len(items)},
            {'stage': 'exclude_preferred_or_class_shares_5digit_code', 'count': len(items)},
        ]
    return {
        'schemaKind': 'jpx_universe_cache_v1',
        'universe_id': universe_id,
        'items': items,
        'source': source,
        'fetched_at': fetched_at,
        'source_as_of': source_as_of,
        'row_count': row_count,
        'segment_counts': segment_counts,
        'filters_applied': filters_applied,
        'workbook_format': workbook_format,
    }


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
# P5-B005-R4 Blocker A: official specific-name code position/letter rule
# (§6-§10/§13). Unit-level tests against the single canonical implementation
# (_is_canonical_jpx_code) — the cache-authority-level acceptance/rejection
# behavior is covered end-to-end in TestCacheAdversarialMatrix.
# ---------------------------------------------------------------------------

class TestCanonicalCodeShape:
    @pytest.mark.parametrize(
        "code",
        [
            "1301", "7203",   # 数字のみ（実データ）
            "166A", "285A",   # 位置4が許可英字（実データ）
            "130A",           # 位置4が許可英字（既存authorityと整合する将来例）
            "1A00",           # 位置2が許可英字（公式に定義された将来有効例）
        ],
    )
    def test_valid_codes_are_accepted(self, code):
        assert _is_canonical_jpx_code(code) is True

    @pytest.mark.parametrize(
        "code",
        [
            "BAD!",   # 記号
            "1ABC",   # 位置3が英字（数字のみのはず）
            "12A4",   # 位置3が英字（数字のみのはず）
            "123B",   # 位置4が除外英字 B
            "999Z",   # 位置4が除外英字 Z
            "123E",   # 位置4が除外英字 E
            "123I",   # 位置4が除外英字 I
            "123O",   # 位置4が除外英字 O
            "123Q",   # 位置4が除外英字 Q
            "123V",   # 位置4が除外英字 V
            "B123",   # 位置1が英字（数字のみのはず）
            "1B23",   # 位置2が除外英字
            "166a",   # 小文字
            " 1301",  # 前方空白
            "1301 ",  # 後方空白
            "１３０１",  # 全角数字  # noqa: RUF001 - 意図的な全角
            "130",    # 3桁（短すぎ）
            "13011",  # 5桁（specific-name codeとしては長すぎ——
                      # 5桁優先株/種類株式はis_preferred_or_class_share()で
                      # 別途扱う、§12。本regexの対象は4桁specific-name codeのみ）
            "0301",   # 位置1が0始まり
            "",       # 空文字
        ],
    )
    def test_invalid_codes_are_rejected(self, code):
        assert _is_canonical_jpx_code(code) is False

    def test_non_string_input_is_rejected(self):
        assert _is_canonical_jpx_code(1301) is False
        assert _is_canonical_jpx_code(None) is False


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
    def _seed_valid_cache(self, cache_path, n=MIN_ELIGIBLE_COUNT):
        save_cache(
            _valid_cache_payload(
                items=_cache_items(n),
                fetched_at=(_NOW - timedelta(hours=5)).isoformat(),
            ),
            cache_path,
        )

    def test_fetch_failure_falls_back_to_valid_cache(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        self._seed_valid_cache(cache_path)

        def failing_fetch():
            raise JPXFetchError("boom")

        result = get_jpx_universe(now=_NOW, fetch_fn=failing_fetch, cache_path=cache_path)
        assert result.fallback_used is True
        assert result.universe_id == UNIVERSE_ID
        assert result.cache_age_hours == pytest.approx(5.0, abs=0.01)
        assert len(result.items) == MIN_ELIGIBLE_COUNT

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
    def _row_count_guard_cache(self, cache_path):
        # baselineを2000にすることで、60%(=1200)がMIN_RAW_ROW_COUNT(1000)の
        # 絶対floorではなくratio guard自体で弾かれることを検証する。items
        # 側もfloor(MIN_ELIGIBLE_COUNT=300)を満たす件数にし、authority
        # validatorのeligible floor/row_count整合性checkを通す。
        items = _cache_items(1400)
        save_cache(
            _valid_cache_payload(
                items=items,
                row_count=2000,
                fetched_at=(_NOW - timedelta(hours=2)).isoformat(),
                segment_counts={
                    MARKET_SEGMENT_PRIME_DOMESTIC: 1400,
                    "スタンダード（内国株式）": 600,
                },
            ),
            cache_path,
        )

    def test_row_count_below_70_percent_triggers_cache_fallback(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        self._row_count_guard_cache(cache_path)

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
        self._row_count_guard_cache(cache_path)

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

    def test_attestation_path_is_not_under_public_data(self):
        # P5-B005-R4 §21: the current-run attestation sidecar must never be
        # public — same directory contract as the persistent cache.
        assert "public/data" not in str(ATTESTATION_PATH).replace("\\", "/")
        assert "public" not in ATTESTATION_PATH.parts
        assert ATTESTATION_PATH.parent == CACHE_PATH.parent
        assert ATTESTATION_PATH != CACHE_PATH

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

    def test_attestation_path_is_git_ignored(self):
        # P5-B005-R4 §21: the ephemeral attestation sidecar must never be
        # committed — it lives under the same gitignored directory as the
        # persistent cache (data/.jpx_cache/), so no additional gitignore
        # rule is required, but the contract itself must hold.
        repo_root = Path(__file__).resolve().parent.parent
        result = subprocess.run(
            ["git", "check-ignore", "-q", str(ATTESTATION_PATH)],
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
        # P5-B005-R3: cache authority validatorがwriter由来のsegment_counts/
        # filters_applied契約を厳密検証するようになったため、この
        # last-good cache fixtureも_valid_cache_payload()で生成した
        # canonical shapeを使う（空segment_counts/空filters_appliedは
        # もはやvalid authorityではない）。
        save_cache(
            _valid_cache_payload(
                items=previous_items,
                fetched_at=(_NOW - timedelta(hours=3)).isoformat(),
            ),
            cache_path,
        )
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

    def test_userinfo_trick_is_rejected(self):
        with pytest.raises(JPXFetchError):
            discover_workbook_url(_listing_html([
                "https://evil.example@www.jpx.co.jp/markets/statistics-equities/misc/"
                "x-att/data_j.xlsx"
            ]))
        with pytest.raises(JPXFetchError):
            discover_workbook_url(_listing_html([
                "https://www.jpx.co.jp@evil.example/markets/statistics-equities/misc/"
                "x-att/data_j.xlsx"
            ]))


# ---------------------------------------------------------------------------
# P5-B005-R2 §5-8/§12-13 — real anchor-only discovery / encoded traversal
# ---------------------------------------------------------------------------

class TestHTMLDiscoveryRobustness:
    """DISCOVERY_HTML_ROBUSTNESS: 実際の<a href="...">属性値のみが
    discoveryの候補になり、data-href属性・HTMLコメント・script内テキスト・
    地の文はいずれも構造的に候補へ混入しないことを証明する。"""

    _REAL_HREF = "/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx"

    def test_data_href_attribute_is_ignored(self):
        html_src = (
            f'<div data-href="{self._REAL_HREF}">not a real link</div>'
        )
        with pytest.raises(JPXFetchError):
            discover_workbook_url(html_src)

    def test_html_comment_link_is_ignored(self):
        html_src = f'<!-- <a href="{self._REAL_HREF}"> -->'
        with pytest.raises(JPXFetchError):
            discover_workbook_url(html_src)

    def test_script_contained_link_is_ignored(self):
        html_src = (
            "<script>const x = '<a href=\""
            + self._REAL_HREF
            + "\">'</script>"
        )
        with pytest.raises(JPXFetchError):
            discover_workbook_url(html_src)

    def test_plain_text_href_string_is_ignored(self):
        html_src = f'plain text: href="{self._REAL_HREF}"'
        with pytest.raises(JPXFetchError):
            discover_workbook_url(html_src)

    def test_real_anchor_among_all_the_above_is_still_discovered(self):
        html_src = (
            f'<div data-href="{self._REAL_HREF}">nope</div>'
            f'<!-- <a href="{self._REAL_HREF}"> -->'
            "<script>const x = '<a href=\""
            + self._REAL_HREF
            + '\">\'</script>'
            f'plain text: href="{self._REAL_HREF}"'
            f'<a href="{self._REAL_HREF}">本物</a>'
        )
        url = discover_workbook_url(html_src)
        assert url.endswith("/data_j.xlsx")

    def test_single_quoted_href_is_discovered(self):
        html_src = f"<a href='{self._REAL_HREF}'>x</a>"
        url = discover_workbook_url(html_src)
        assert url.endswith("/data_j.xlsx")

    def test_arbitrary_attribute_order_is_discovered(self):
        html_src = f'<a rel="external" target="_blank" href="{self._REAL_HREF}" class="x">x</a>'
        url = discover_workbook_url(html_src)
        assert url.endswith("/data_j.xlsx")

    def test_uppercase_tag_and_attribute_are_discovered(self):
        html_src = f'<A HREF="{self._REAL_HREF}">x</A>'
        url = discover_workbook_url(html_src)
        assert url.endswith("/data_j.xlsx")

    def test_whitespace_and_newlines_around_href_are_discovered(self):
        html_src = f'<a\n  href\n  =\n  "{self._REAL_HREF}"\n>x</a>'
        url = discover_workbook_url(html_src)
        assert url.endswith("/data_j.xlsx")

    def test_html_entity_in_href_is_decoded_exactly_once(self):
        # &amp; -> & 。HTMLParserがattrs decodeを担うため、ここで
        # 二重decodeされていないことを実際のcontainer名で確認する
        # （&amp;がそのまま"&"1文字へ、"&amp;amp;"のような残骸が
        # 残らないことを検証する）。
        href = (
            "/markets/statistics-equities/misc/tvdivq0000001vg2-att/"
            "data_j.xlsx"
        )
        html_src = f'<a href="{href}?x=1&amp;y=2#ignored">x</a>'
        # クエリ/フラグメントは許可されないため、このリンク自体はrejectされる
        # ——ただしdecode段でraiseされる例外ではなく、authority検証（query
        # 拒否）でrejectされることを確認する（つまりURL自体は正しく1回だけ
        # decodeされ、"&amp;y=2"のような残骸文字列として素通りしていない）。
        with pytest.raises(JPXFetchError):
            discover_workbook_url(html_src)


class TestEncodedTraversalRejected:
    """§12/§13: 単一/二重encodeされたtraversalも含め、workbook pathに
    "%"を1文字でも含むhrefはdecodeせずfail closedで拒否する。"""

    _CASES = [
        "/markets/statistics-equities/misc/x-att/%2e%2e/data_j.xlsx",
        "/markets/statistics-equities/misc/x-att/%2E%2E/data_j.xlsx",
        "/markets/statistics-equities/misc/%2e%2e%2fx-att/data_j.xlsx",
        "/markets/statistics-equities/misc/%2E%2E%5Cx-att/data_j.xlsx",
        "/markets/statistics-equities/misc/%252e%252e%252fx-att/data_j.xlsx",
        "/markets/statistics-equities/misc/x-att/..%2fdata_j.xlsx",
        "/markets%2f..%2f..%2fdata_j.xlsx",
    ]

    @pytest.mark.parametrize("href", _CASES)
    def test_encoded_traversal_variant_is_rejected(self, href):
        with pytest.raises(JPXFetchError):
            discover_workbook_url(_listing_html([href]))

    def test_literal_backslash_traversal_is_rejected(self):
        with pytest.raises(JPXFetchError):
            discover_workbook_url(_listing_html([
                "/markets/statistics-equities/misc/x-att\\..\\data_j.xlsx"
            ]))


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
        items = _cache_items(400)
        save_cache(
            _valid_cache_payload(
                items=items,
                row_count=4400,
                fetched_at=(_NOW - timedelta(hours=6)).isoformat(),
                source_as_of="2026-08-31",
                segment_counts={
                    MARKET_SEGMENT_PRIME_DOMESTIC: 400,
                    "スタンダード（内国株式）": 4000,
                },
                workbook_format="xlsx",
            ),
            cache_path,
        )

    def test_page_fetch_failure_with_cache_uses_cache(self, tmp_path):
        cache_path = tmp_path / "c.json"
        self._valid_cache(cache_path)

        def boom():
            raise JPXFetchError("listing page 500")

        result = get_jpx_universe(now=_NOW, fetch_fn=boom, cache_path=cache_path)
        assert result.fallback_used is True
        assert result.universe_id == UNIVERSE_ID
        assert len(result.items) == 400

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


# ---------------------------------------------------------------------------
# P5-B005-R2 §9-11 — bounded redirect handling / final-URL revalidation
# ---------------------------------------------------------------------------

class _FakeResponse:
    def __init__(self, status_code, headers=None, content=b"", text="", url=""):
        self.status_code = status_code
        self.headers = headers or {}
        self.content = content
        self.text = text
        self.url = url or ""


class _FakeRequests:
    """requests moduleのGET部分だけを置き換えるfake。allow_redirects=Falseを
    強制し、未登録URLへのGETはAssertionErrorにする——foreign redirect先の
    bodyを実際にconsumeしていないことを、この例外の非発生で証明する。"""

    def __init__(self, responses):
        self._responses = responses
        self.calls: list[str] = []

    def get(self, url, timeout=None, allow_redirects=None):
        assert allow_redirects is False, "provider must use allow_redirects=False"
        self.calls.append(url)
        if url not in self._responses:
            raise AssertionError(f"unexpected request to unregistered URL: {url!r}")
        return self._responses[url]


_VALID_WORKBOOK_URL = (
    "https://www.jpx.co.jp/markets/statistics-equities/misc/"
    "tvdivq0000001vg2-att/data_j.xlsx"
)


class TestListingPageRedirectSecurity:
    """P5-B005-R3 Blocker A: listing pageのauthorityは
    www.jpx.co.jp配下の任意pathではなく、JPX_LISTING_PAGE_PATH
    （/markets/statistics-equities/misc/01.html）へのexact一致のみを
    許可する。§9で要求される拒否matrix（corporate/english/別markets
    page/query/fragment/foreign/downgrade）を直接probeとして証明する。"""

    def test_no_redirect_returns_body(self, monkeypatch):
        resp = _FakeResponse(
            200, headers={"content-type": "text/html; charset=utf-8"},
            text="<html>ok</html>", url=JPX_LISTING_PAGE_URL,
        )
        fake = _FakeRequests({JPX_LISTING_PAGE_URL: resp})
        monkeypatch.setitem(sys.modules, "requests", fake)
        assert fetch_listing_page() == "<html>ok</html>"

    def test_out_of_namespace_same_host_redirect_rejected(self, monkeypatch):
        # R2はwww.jpx.co.jp配下の任意pathへのredirectをfetchしてしまう
        # 広すぎるauthorityだった（audit実証: 01-new.html等の別
        # /markets/statistics-equities/misc/ page）。同一host内でも
        # exact path外はfetch前に拒否する。
        moved = "https://www.jpx.co.jp/markets/statistics-equities/misc/01-new.html"
        r1 = _FakeResponse(302, headers={"Location": moved})
        fake = _FakeRequests({JPX_LISTING_PAGE_URL: r1, moved: _FakeResponse(200, text="<html>moved</html>", url=moved)})
        monkeypatch.setitem(sys.modules, "requests", fake)
        with pytest.raises(JPXFetchError):
            fetch_listing_page()
        assert moved not in fake.calls  # out-of-namespace先は一度もrequestされていない

    def test_corporate_path_redirect_rejected(self, monkeypatch):
        corporate = "https://www.jpx.co.jp/corporate/about-jpx/index.html"
        r1 = _FakeResponse(302, headers={"Location": corporate})
        fake = _FakeRequests({
            JPX_LISTING_PAGE_URL: r1,
            corporate: _FakeResponse(200, text="<html>corporate</html>", url=corporate),
        })
        monkeypatch.setitem(sys.modules, "requests", fake)
        with pytest.raises(JPXFetchError):
            fetch_listing_page()
        assert corporate not in fake.calls

    def test_english_path_redirect_rejected(self, monkeypatch):
        english = "https://www.jpx.co.jp/english/"
        r1 = _FakeResponse(302, headers={"Location": english})
        fake = _FakeRequests({
            JPX_LISTING_PAGE_URL: r1,
            english: _FakeResponse(200, text="<html>english</html>", url=english),
        })
        monkeypatch.setitem(sys.modules, "requests", fake)
        with pytest.raises(JPXFetchError):
            fetch_listing_page()
        assert english not in fake.calls

    def test_query_bearing_redirect_rejected(self, monkeypatch):
        with_query = JPX_LISTING_PAGE_URL + "?lang=en"
        r1 = _FakeResponse(302, headers={"Location": with_query})
        fake = _FakeRequests({
            JPX_LISTING_PAGE_URL: r1,
            with_query: _FakeResponse(200, text="<html>q</html>", url=with_query),
        })
        monkeypatch.setitem(sys.modules, "requests", fake)
        with pytest.raises(JPXFetchError):
            fetch_listing_page()
        assert with_query not in fake.calls

    def test_fragment_bearing_redirect_rejected(self, monkeypatch):
        with_fragment = JPX_LISTING_PAGE_URL + "#section"
        r1 = _FakeResponse(302, headers={"Location": with_fragment})
        fake = _FakeRequests({JPX_LISTING_PAGE_URL: r1})
        monkeypatch.setitem(sys.modules, "requests", fake)
        with pytest.raises(JPXFetchError):
            fetch_listing_page()

    def test_foreign_redirect_rejected_before_body_consumed(self, monkeypatch):
        evil = "https://evil.example/phish.html"
        r1 = _FakeResponse(302, headers={"Location": evil})
        fake = _FakeRequests({JPX_LISTING_PAGE_URL: r1})
        monkeypatch.setitem(sys.modules, "requests", fake)
        with pytest.raises(JPXFetchError):
            fetch_listing_page()
        assert evil not in fake.calls  # evilのbodyは一度もrequestされていない

    def test_http_downgrade_redirect_rejected(self, monkeypatch):
        downgraded = "http://www.jpx.co.jp/markets/statistics-equities/misc/01.html"
        r1 = _FakeResponse(302, headers={"Location": downgraded})
        fake = _FakeRequests({JPX_LISTING_PAGE_URL: r1})
        monkeypatch.setitem(sys.modules, "requests", fake)
        with pytest.raises(JPXFetchError):
            fetch_listing_page()

    def test_initial_url_out_of_namespace_rejected_before_any_request(self, monkeypatch):
        # §37: fetch_listing_page()自体に承認外URLを渡した場合も、
        # requestを一切出さずfail closedする。
        bad = "https://www.jpx.co.jp/corporate/about-jpx/index.html"
        fake = _FakeRequests({})
        monkeypatch.setitem(sys.modules, "requests", fake)
        with pytest.raises(JPXFetchError):
            fetch_listing_page(url=bad)
        assert fake.calls == []

    def test_redirect_without_location_rejected(self, monkeypatch):
        r1 = _FakeResponse(302, headers={})
        fake = _FakeRequests({JPX_LISTING_PAGE_URL: r1})
        monkeypatch.setitem(sys.modules, "requests", fake)
        with pytest.raises(JPXFetchError):
            fetch_listing_page()

    def test_redirect_loop_rejected(self, monkeypatch):
        # 承認path単一化後は、承認済みURL同士でしかloopを構成できない
        # （非承認先へのredirectはloop判定に到達する前にauthority違反で
        # 拒否される）。canonical URLがそれ自身へredirectする自己loopで
        # loop検出そのものを証明する。
        ra = _FakeResponse(302, headers={"Location": JPX_LISTING_PAGE_URL})
        fake = _FakeRequests({JPX_LISTING_PAGE_URL: ra})
        monkeypatch.setitem(sys.modules, "requests", fake)
        with pytest.raises(JPXFetchError):
            fetch_listing_page()

    def test_content_type_checked_on_direct_response(self, monkeypatch):
        # redirect先は承認path外だと即座に拒否されるため、
        # content-type gateはredirect後ではなくdirect responseで検証する。
        resp = _FakeResponse(
            200, headers={"content-type": "application/pdf"}, text="", url=JPX_LISTING_PAGE_URL,
        )
        fake = _FakeRequests({JPX_LISTING_PAGE_URL: resp})
        monkeypatch.setitem(sys.modules, "requests", fake)
        with pytest.raises(JPXFetchError):
            fetch_listing_page()


class TestWorkbookRedirectSecurity:
    def test_no_redirect_downloads_body(self, monkeypatch):
        body = _make_xlsx_bytes(FULL_HEADER, [_row()])
        resp = _FakeResponse(200, content=body, url=_VALID_WORKBOOK_URL)
        fake = _FakeRequests({_VALID_WORKBOOK_URL: resp})
        monkeypatch.setitem(sys.modules, "requests", fake)
        content, fmt = download_workbook(_VALID_WORKBOOK_URL)
        assert fmt == "xlsx"
        assert content == body

    def test_follows_same_origin_redirect_to_another_valid_workbook_url(self, monkeypatch):
        new_url = (
            "https://www.jpx.co.jp/markets/statistics-equities/misc/"
            "newatt-att/data_j.xlsx"
        )
        body = _make_xlsx_bytes(FULL_HEADER, [_row()])
        r1 = _FakeResponse(302, headers={"Location": new_url})
        r2 = _FakeResponse(200, content=body, url=new_url)
        fake = _FakeRequests({_VALID_WORKBOOK_URL: r1, new_url: r2})
        monkeypatch.setitem(sys.modules, "requests", fake)
        content, fmt = download_workbook(_VALID_WORKBOOK_URL)
        assert fmt == "xlsx"
        assert content == body

    def test_foreign_redirect_rejected_before_body_consumed(self, monkeypatch):
        evil = "https://evil.example/data_j.xlsx"
        r1 = _FakeResponse(302, headers={"Location": evil})
        fake = _FakeRequests({_VALID_WORKBOOK_URL: r1})
        monkeypatch.setitem(sys.modules, "requests", fake)
        with pytest.raises(JPXFetchError):
            download_workbook(_VALID_WORKBOOK_URL)
        assert evil not in fake.calls

    def test_encoded_traversal_redirect_rejected(self, monkeypatch):
        evil = (
            "https://www.jpx.co.jp/markets/statistics-equities/misc/"
            "%2e%2e%2fdata_j.xlsx"
        )
        r1 = _FakeResponse(302, headers={"Location": evil})
        fake = _FakeRequests({_VALID_WORKBOOK_URL: r1})
        monkeypatch.setitem(sys.modules, "requests", fake)
        with pytest.raises(JPXFetchError):
            download_workbook(_VALID_WORKBOOK_URL)

    def test_excessive_workbook_redirects_rejected(self, monkeypatch):
        # workbook authorityは複数の相異なるattachment containerを許容する
        # ため（各hopは承認済みだが異なるURL）、listing pageと異なり
        # MAX_REDIRECTS超過そのものを承認済みURL同士のchainで実際に
        # 構成・検証できる。
        base = "https://www.jpx.co.jp/markets/statistics-equities/misc/"
        hops = [_VALID_WORKBOOK_URL] + [
            f"{base}hop{i}-att/data_j.xlsx" for i in range(MAX_REDIRECTS + 3)
        ]
        responses = {
            hops[i]: _FakeResponse(302, headers={"Location": hops[i + 1]})
            for i in range(len(hops) - 1)
        }
        fake = _FakeRequests(responses)
        monkeypatch.setitem(sys.modules, "requests", fake)
        with pytest.raises(JPXFetchError):
            download_workbook(_VALID_WORKBOOK_URL)

    def test_wrong_basename_redirect_rejected(self, monkeypatch):
        wrong = (
            "https://www.jpx.co.jp/markets/statistics-equities/misc/"
            "tvdivq0000001vg2-att/all_issues.xlsx"
        )
        r1 = _FakeResponse(302, headers={"Location": wrong})
        fake = _FakeRequests({_VALID_WORKBOOK_URL: r1})
        monkeypatch.setitem(sys.modules, "requests", fake)
        with pytest.raises(JPXFetchError):
            download_workbook(_VALID_WORKBOOK_URL)

    def test_final_response_url_is_revalidated_even_without_3xx(self, monkeypatch):
        # transportがtransparentにredirectしてしまった（allow_redirects=Falseの
        # 想定に反する）場合でも、resp.urlを再検証することでforeign originの
        # bodyをそのまま採用しない（REDIRECT_AUTHORITY_REVALIDATED）。
        resp = _FakeResponse(200, content=b"whatever", url="https://evil.example/data_j.xlsx")
        fake = _FakeRequests({_VALID_WORKBOOK_URL: resp})
        monkeypatch.setitem(sys.modules, "requests", fake)
        with pytest.raises(JPXFetchError):
            download_workbook(_VALID_WORKBOOK_URL)

    def test_missing_requests_raises_jpx_fetch_error(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "requests", None)
        with pytest.raises(JPXFetchError):
            download_workbook(_VALID_WORKBOOK_URL)

    def test_full_default_path_discovers_and_downloads_through_redirect(self, monkeypatch):
        # fetch_jpx_workbook_bytes() end-to-end: listing page → discover →
        # workbook download（same-origin 1-hop redirect込み）。
        listing_html = _listing_html([_VALID_WORKBOOK_URL])
        listing_resp = _FakeResponse(
            200, headers={"content-type": "text/html"}, text=listing_html,
            url=JPX_LISTING_PAGE_URL,
        )
        moved = (
            "https://www.jpx.co.jp/markets/statistics-equities/misc/"
            "tvdivq0000001vg2v2-att/data_j.xlsx"
        )
        body = _make_xlsx_bytes(FULL_HEADER, [_row()])
        redirect_resp = _FakeResponse(302, headers={"Location": moved})
        workbook_resp = _FakeResponse(200, content=body, url=moved)
        fake = _FakeRequests({
            JPX_LISTING_PAGE_URL: listing_resp,
            _VALID_WORKBOOK_URL: redirect_resp,
            moved: workbook_resp,
        })
        monkeypatch.setitem(sys.modules, "requests", fake)
        content = fetch_jpx_workbook_bytes()
        assert content == body


# ---------------------------------------------------------------------------
# P5-B005-R2 §14-22 — restored cache authority revalidation
# ---------------------------------------------------------------------------

class TestRestoredCacheAuthority:
    """RESTORED_CACHE_REVALIDATED: 構造的にparse可能でも last-good authority
    契約から外れるcacheはget_jpx_universe()のfallback候補として使わない。
    いずれのケースもlive fetchを故意に失敗させ、cacheが使われるか
    seed_list_v1へ縮退するかで authority validation の可否を観測する。"""

    def _boom(self):
        raise JPXFetchError("live fetch unavailable")

    def _get(self, cache_path):
        return get_jpx_universe(now=_NOW, fetch_fn=self._boom, cache_path=cache_path)

    def test_valid_current_cache_is_accepted(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache(_valid_cache_payload(fetched_at=(_NOW - timedelta(hours=3)).isoformat()), cache_path)
        result = self._get(cache_path)
        assert result.fallback_used is True
        assert result.universe_id == UNIVERSE_ID
        assert len(result.items) == MIN_ELIGIBLE_COUNT

    def test_very_old_cache_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        ten_years = _NOW - timedelta(days=365 * 10)
        save_cache(_valid_cache_payload(fetched_at=ten_years.isoformat()), cache_path)
        result = self._get(cache_path)
        assert result.universe_id == FALLBACK_UNIVERSE_ID

    def test_cache_older_than_max_age_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        too_old = _NOW - timedelta(hours=MAX_CACHE_AGE_HOURS + 1)
        save_cache(_valid_cache_payload(fetched_at=too_old.isoformat()), cache_path)
        result = self._get(cache_path)
        assert result.universe_id == FALLBACK_UNIVERSE_ID

    def test_future_dated_cache_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        future = _NOW + timedelta(days=30)
        save_cache(_valid_cache_payload(fetched_at=future.isoformat()), cache_path)
        result = self._get(cache_path)
        assert result.universe_id == FALLBACK_UNIVERSE_ID

    def test_slightly_future_cache_within_clock_skew_is_accepted(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        barely_future = _NOW + timedelta(minutes=1)
        save_cache(_valid_cache_payload(fetched_at=barely_future.isoformat()), cache_path)
        result = self._get(cache_path)
        assert result.fallback_used is True
        assert result.universe_id == UNIVERSE_ID

    def test_wrong_source_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache(_valid_cache_payload(source="some_other_source"), cache_path)
        result = self._get(cache_path)
        assert result.universe_id == FALLBACK_UNIVERSE_ID

    def test_wrong_universe_id_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache(_valid_cache_payload(universe_id="some_other_universe"), cache_path)
        result = self._get(cache_path)
        assert result.universe_id == FALLBACK_UNIVERSE_ID

    def test_duplicate_code_in_items_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        items = _cache_items(MIN_ELIGIBLE_COUNT)
        items[-1] = list(items[0])  # 末尾codeを先頭codeと重複させる
        save_cache(_valid_cache_payload(items=items), cache_path)
        result = self._get(cache_path)
        assert result.universe_id == FALLBACK_UNIVERSE_ID

    def test_below_floor_universe_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        items = _cache_items(MIN_ELIGIBLE_COUNT - 1)
        save_cache(_valid_cache_payload(items=items, row_count=MIN_RAW_ROW_COUNT), cache_path)
        result = self._get(cache_path)
        assert result.universe_id == FALLBACK_UNIVERSE_ID

    def test_one_item_universe_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        items = _cache_items(1)
        save_cache(_valid_cache_payload(items=items, row_count=MIN_RAW_ROW_COUNT), cache_path)
        result = self._get(cache_path)
        assert result.universe_id == FALLBACK_UNIVERSE_ID

    def test_negative_row_count_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache(_valid_cache_payload(row_count=-1), cache_path)
        result = self._get(cache_path)
        assert result.universe_id == FALLBACK_UNIVERSE_ID

    def test_row_count_smaller_than_items_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        items = _cache_items(MIN_ELIGIBLE_COUNT)
        save_cache(_valid_cache_payload(items=items, row_count=len(items) - 1), cache_path)
        result = self._get(cache_path)
        assert result.universe_id == FALLBACK_UNIVERSE_ID

    def test_malformed_segment_counts_sum_mismatch_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        items = _cache_items(MIN_ELIGIBLE_COUNT)
        save_cache(
            _valid_cache_payload(
                items=items,
                row_count=MIN_RAW_ROW_COUNT,
                segment_counts={MARKET_SEGMENT_PRIME_DOMESTIC: 1},  # row_countと合計不一致
            ),
            cache_path,
        )
        result = self._get(cache_path)
        assert result.universe_id == FALLBACK_UNIVERSE_ID

    def test_negative_segment_counts_value_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        items = _cache_items(MIN_ELIGIBLE_COUNT)
        save_cache(
            _valid_cache_payload(
                items=items,
                row_count=MIN_RAW_ROW_COUNT,
                segment_counts={MARKET_SEGMENT_PRIME_DOMESTIC: -5, "x": MIN_RAW_ROW_COUNT + 5},
            ),
            cache_path,
        )
        result = self._get(cache_path)
        assert result.universe_id == FALLBACK_UNIVERSE_ID

    def test_non_dict_segment_counts_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        payload = _valid_cache_payload()
        payload["segment_counts"] = ["not", "a", "dict"]
        save_cache(payload, cache_path)
        result = self._get(cache_path)
        assert result.universe_id == FALLBACK_UNIVERSE_ID

    def test_malformed_filters_applied_shape_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        payload = _valid_cache_payload()
        payload["filters_applied"] = [{"stage": "x"}]  # countキー欠如
        save_cache(payload, cache_path)
        result = self._get(cache_path)
        assert result.universe_id == FALLBACK_UNIVERSE_ID

    def test_non_list_filters_applied_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        payload = _valid_cache_payload()
        payload["filters_applied"] = "not-a-list"
        save_cache(payload, cache_path)
        result = self._get(cache_path)
        assert result.universe_id == FALLBACK_UNIVERSE_ID

    def test_invalid_preferred_share_code_is_rejected(self, tmp_path):
        # 5桁code（優先株/種類株式相当）はeligibility上除外されるべきなので、
        # last-good cacheに混入していればauthority違反として拒否する。
        cache_path = tmp_path / "cache.json"
        items = _cache_items(MIN_ELIGIBLE_COUNT - 1)
        items.append(["25935", "伊藤園優先", "食料品"])
        save_cache(_valid_cache_payload(items=items), cache_path)
        result = self._get(cache_path)
        assert result.universe_id == FALLBACK_UNIVERSE_ID

    def test_live_fail_with_invalid_cache_falls_back_to_seed(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache(_valid_cache_payload(source="tampered"), cache_path)
        result = self._get(cache_path)
        assert result.fallback_used is True
        assert result.universe_id == FALLBACK_UNIVERSE_ID
        assert result.items == list(SEED_LIST)

    def test_live_fail_with_valid_cache_uses_cache_not_seed(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache(_valid_cache_payload(), cache_path)
        result = self._get(cache_path)
        assert result.fallback_used is True
        assert result.universe_id == UNIVERSE_ID
        assert result.items != list(SEED_LIST)


# ---------------------------------------------------------------------------
# P5-B005-R3 §20 — cache adversarial matrix: _valid_cache_payload()（実際に
# save_cache()が書きうるcanonical shape）を1 field ずつmutateし、rejectを
# 証明する。ハンドクラフトした無関係payloadではなく、canonical baselineを
# 崩すことで実際のwriter/validator契約の境界を検証する。
# ---------------------------------------------------------------------------

class TestCacheAdversarialMatrix:
    def _boom(self):
        raise JPXFetchError("live fetch unavailable")

    def _get(self, cache_path):
        return get_jpx_universe(now=_NOW, fetch_fn=self._boom, cache_path=cache_path)

    def _assert_rejected(self, payload, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache(payload, cache_path)
        result = self._get(cache_path)
        assert result.universe_id == FALLBACK_UNIVERSE_ID

    def _assert_accepted(self, payload, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_cache(payload, cache_path)
        result = self._get(cache_path)
        assert result.fallback_used is True
        assert result.universe_id == UNIVERSE_ID
        return result

    # --- baseline sanity -----------------------------------------------

    def test_baseline_valid_payload_is_accepted(self, tmp_path):
        self._assert_accepted(_valid_cache_payload(), tmp_path)

    def test_alpha_mixed_code_is_accepted(self, tmp_path):
        items = _cache_items(MIN_ELIGIBLE_COUNT - 1)
        items.append(["166A", "タスキHD", "建設業"])
        self._assert_accepted(_valid_cache_payload(items=items), tmp_path)

    # --- codes -----------------------------------------------------------

    def test_malformed_code_bad_bang_is_rejected(self, tmp_path):
        items = _cache_items(MIN_ELIGIBLE_COUNT - 1)
        items.append(["BAD!", "不正銘柄", "sector"])
        self._assert_rejected(_valid_cache_payload(items=items), tmp_path)

    def test_lowercase_code_is_rejected(self, tmp_path):
        items = _cache_items(MIN_ELIGIBLE_COUNT - 1)
        items.append(["166a", "小文字code", "sector"])
        self._assert_rejected(_valid_cache_payload(items=items), tmp_path)

    def test_whitespace_padded_code_is_rejected(self, tmp_path):
        items = _cache_items(MIN_ELIGIBLE_COUNT - 1)
        items.append([" 1301", "空白付きcode", "sector"])
        self._assert_rejected(_valid_cache_payload(items=items), tmp_path)

    def test_code_starting_with_zero_is_rejected(self, tmp_path):
        items = _cache_items(MIN_ELIGIBLE_COUNT - 1)
        items.append(["0301", "ゼロ始まりcode", "sector"])
        self._assert_rejected(_valid_cache_payload(items=items), tmp_path)

    # --- P5-B005-R4 Blocker A: official specific-name code position/letter
    #     rule (§6-§10/§13). The R3 shape `[1-9][0-9A-Z]{3,4}` only checked
    #     digit count and accepted letters in any of positions 2-4 —
    #     including positions that must be numeric-only (3) and excluded
    #     letters (B/E/I/O/Q/V/Z) in the alphabet-capable positions (2/4).

    @pytest.mark.parametrize("valid_code", ["166A", "285A", "130A", "1A00"])
    def test_official_alphanumeric_specific_name_codes_are_accepted(self, tmp_path, valid_code):
        items = _cache_items(MIN_ELIGIBLE_COUNT - 1)
        items.append([valid_code, "銘柄", "sector"])
        self._assert_accepted(_valid_cache_payload(items=items), tmp_path)

    @pytest.mark.parametrize(
        "bad_code",
        [
            "1ABC",  # position 3 must be numeric-only, "B" is alphabetic
            "12A4",  # position 3 must be numeric-only, "A" is alphabetic
            "123B",  # position 4: "B" is an excluded letter
            "999Z",  # position 4: "Z" is an excluded letter
            "123E",  # position 4: "E" is an excluded letter
            "123I",  # position 4: "I" is an excluded letter
            "123O",  # position 4: "O" is an excluded letter
            "123Q",  # position 4: "Q" is an excluded letter
            "123V",  # position 4: "V" is an excluded letter
        ],
    )
    def test_non_canonical_specific_name_codes_are_rejected(self, tmp_path, bad_code):
        items = _cache_items(MIN_ELIGIBLE_COUNT - 1)
        items.append([bad_code, "不正銘柄", "sector"])
        self._assert_rejected(_valid_cache_payload(items=items), tmp_path)

    def test_full_width_digit_code_is_rejected(self, tmp_path):
        items = _cache_items(MIN_ELIGIBLE_COUNT - 1)
        items.append(["１３０１", "全角code", "sector"])  # noqa: RUF001 - 意図的な全角
        self._assert_rejected(_valid_cache_payload(items=items), tmp_path)

    def test_duplicate_canonical_code_is_rejected(self, tmp_path):
        items = _cache_items(MIN_ELIGIBLE_COUNT)
        items[-1] = list(items[0])
        self._assert_rejected(_valid_cache_payload(items=items), tmp_path)

    # --- segment_counts ----------------------------------------------------

    def test_empty_segment_counts_is_rejected(self, tmp_path):
        payload = _valid_cache_payload()
        payload["segment_counts"] = {}
        self._assert_rejected(payload, tmp_path)

    def test_segment_counts_missing_prime_domestic_key_is_rejected(self, tmp_path):
        row_count = _valid_cache_payload()["row_count"]
        payload = _valid_cache_payload(segment_counts={"スタンダード（内国株式）": row_count})
        self._assert_rejected(payload, tmp_path)

    def test_segment_counts_unapproved_key_is_rejected(self, tmp_path):
        items = _cache_items(MIN_ELIGIBLE_COUNT)
        row_count = MIN_RAW_ROW_COUNT
        payload = _valid_cache_payload(
            items=items,
            row_count=row_count,
            segment_counts={
                MARKET_SEGMENT_PRIME_DOMESTIC: len(items),
                "未知区分（架空）": row_count - len(items),
            },
        )
        self._assert_rejected(payload, tmp_path)

    def test_segment_counts_boolean_value_is_rejected(self, tmp_path):
        # bool は int の subclass なので sum() は数値上一致しうる
        # （True + 999 == 1000）——isinstance(value, bool)の明示排除が
        # なければこのpayloadはsum一致check単体では素通りしてしまう。
        items = _cache_items(MIN_ELIGIBLE_COUNT)
        payload = _valid_cache_payload(
            items=items,
            row_count=MIN_RAW_ROW_COUNT,
            segment_counts={
                MARKET_SEGMENT_PRIME_DOMESTIC: True,
                "スタンダード（内国株式）": MIN_RAW_ROW_COUNT - 1,
            },
        )
        self._assert_rejected(payload, tmp_path)

    def test_segment_counts_wrong_sum_is_rejected(self, tmp_path):
        items = _cache_items(MIN_ELIGIBLE_COUNT)
        payload = _valid_cache_payload(
            items=items,
            row_count=MIN_RAW_ROW_COUNT,
            segment_counts={MARKET_SEGMENT_PRIME_DOMESTIC: len(items)},  # row_countと不一致
        )
        self._assert_rejected(payload, tmp_path)

    # --- filters_applied -----------------------------------------------

    def test_empty_filters_applied_is_rejected(self, tmp_path):
        payload = _valid_cache_payload()
        payload["filters_applied"] = []
        self._assert_rejected(payload, tmp_path)

    def test_filters_applied_missing_stage_is_rejected(self, tmp_path):
        payload = _valid_cache_payload()
        payload["filters_applied"] = payload["filters_applied"][:2]
        self._assert_rejected(payload, tmp_path)

    def test_filters_applied_extra_stage_is_rejected(self, tmp_path):
        payload = _valid_cache_payload()
        payload["filters_applied"] = payload["filters_applied"] + [
            {"stage": "extra_bogus_stage", "count": 0}
        ]
        self._assert_rejected(payload, tmp_path)

    def test_filters_applied_wrong_stage_name_is_rejected(self, tmp_path):
        payload = _valid_cache_payload()
        payload["filters_applied"][0]["stage"] = "not_source_rows"
        self._assert_rejected(payload, tmp_path)

    def test_filters_applied_wrong_order_is_rejected(self, tmp_path):
        payload = _valid_cache_payload()
        stages = payload["filters_applied"]
        payload["filters_applied"] = [stages[1], stages[0], stages[2]]
        self._assert_rejected(payload, tmp_path)

    def test_filters_applied_negative_count_is_rejected(self, tmp_path):
        payload = _valid_cache_payload()
        payload["filters_applied"][-1]["count"] = -1
        self._assert_rejected(payload, tmp_path)

    def test_filters_applied_boolean_count_is_rejected(self, tmp_path):
        payload = _valid_cache_payload()
        payload["filters_applied"][-1]["count"] = True
        self._assert_rejected(payload, tmp_path)

    def test_filters_applied_increasing_progression_is_rejected(self, tmp_path):
        payload = _valid_cache_payload()
        payload["filters_applied"][-1]["count"] = payload["filters_applied"][0]["count"] + 1
        self._assert_rejected(payload, tmp_path)

    def test_filters_applied_wrong_final_eligible_count_is_rejected(self, tmp_path):
        payload = _valid_cache_payload()
        payload["filters_applied"][-1]["count"] = len(payload["items"]) - 1
        self._assert_rejected(payload, tmp_path)

    def test_filters_applied_wrong_initial_raw_count_is_rejected(self, tmp_path):
        payload = _valid_cache_payload()
        payload["filters_applied"][0]["count"] = payload["row_count"] - 1
        self._assert_rejected(payload, tmp_path)


# ---------------------------------------------------------------------------
# P5-B005-R2 §22 — cache round-trip contract
# ---------------------------------------------------------------------------

class TestCacheRoundTrip:
    def test_live_success_save_reload_validate_yields_same_canonical_universe(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        rows = _bulk_rows(1200)

        def fake_fetch():
            return b"irrelevant"

        def fake_parse(_content):
            return parse_rows_from_sheet(_sheet(rows))

        live_result = get_jpx_universe(
            now=_NOW, fetch_fn=fake_fetch, parse_fn=fake_parse, cache_path=cache_path
        )
        assert live_result.fallback_used is False

        reloaded = load_cache(cache_path)
        assert reloaded is not None

        # 再度live fetchを失敗させ、直前にsaveされたcacheがauthority
        # revalidationを通って last-good として使われることを証明する。
        later = _NOW + timedelta(hours=1)
        fallback_result = get_jpx_universe(
            now=later,
            fetch_fn=lambda: (_ for _ in ()).throw(JPXFetchError("down")),
            cache_path=cache_path,
        )
        assert fallback_result.fallback_used is True
        assert fallback_result.universe_id == live_result.universe_id
        assert sorted(fallback_result.items) == sorted(live_result.items)
        assert fallback_result.row_count == live_result.row_count


# ---------------------------------------------------------------------------
# P5-B005-R4 §17-21 — current-run cache attestation lifecycle
# ---------------------------------------------------------------------------

class TestCurrentRunAttestationLifecycle:
    def _live(self, cache_path, attestation_path, run_token="run-token-1", now=_NOW):
        rows = _bulk_rows(1200)
        return get_jpx_universe(
            now=now,
            fetch_fn=lambda: b"irrelevant",
            parse_fn=lambda _content: parse_rows_from_sheet(_sheet(rows)),
            cache_path=cache_path,
            run_token=run_token,
            attestation_path=attestation_path,
        )

    def test_attestation_written_on_live_success_with_run_token(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        attestation_path = tmp_path / "cache.attestation.json"
        result = self._live(cache_path, attestation_path)
        assert result.fallback_used is False

        attestation = load_attestation(attestation_path)
        assert attestation is not None
        assert attestation["run_token"] == "run-token-1"
        assert attestation["cache_sha256"] == hashlib.sha256(cache_path.read_bytes()).hexdigest()
        assert attestation["source"] == result.source
        assert attestation["fetched_at"] == result.fetched_at
        assert attestation["eligible_count"] == result.eligible_count

    def test_attestation_not_written_without_run_token(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        attestation_path = tmp_path / "cache.attestation.json"
        rows = _bulk_rows(1200)
        result = get_jpx_universe(
            now=_NOW,
            fetch_fn=lambda: b"irrelevant",
            parse_fn=lambda _content: parse_rows_from_sheet(_sheet(rows)),
            cache_path=cache_path,
            attestation_path=attestation_path,
        )
        assert result.fallback_used is False
        assert not attestation_path.exists()

    def test_attestation_not_written_on_cache_fallback(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        attestation_path = tmp_path / "cache.attestation.json"
        self._live(cache_path, attestation_path, run_token="run-1", now=_NOW)
        assert attestation_path.exists()

        result = get_jpx_universe(
            now=_NOW + timedelta(hours=1),
            fetch_fn=lambda: (_ for _ in ()).throw(JPXFetchError("down")),
            cache_path=cache_path,
            run_token="run-2",
            attestation_path=attestation_path,
        )
        assert result.fallback_used is True
        # stale attestation (run-1由来) はrun開始時に削除済みで、
        # cache fallback経路では新規attestationも書かれない。
        assert not attestation_path.exists()

    def test_attestation_not_written_on_seed_fallback(self, tmp_path):
        cache_path = tmp_path / "cache.json"  # 存在しない = no valid cache
        attestation_path = tmp_path / "cache.attestation.json"
        result = get_jpx_universe(
            now=_NOW,
            fetch_fn=lambda: (_ for _ in ()).throw(JPXFetchError("down")),
            cache_path=cache_path,
            run_token="run-1",
            attestation_path=attestation_path,
        )
        assert result.universe_id == FALLBACK_UNIVERSE_ID
        assert not attestation_path.exists()

    def test_stale_attestation_from_previous_run_is_removed_before_new_acquisition(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        attestation_path = tmp_path / "cache.attestation.json"
        self._live(cache_path, attestation_path, run_token="run-1", now=_NOW)
        assert load_attestation(attestation_path)["run_token"] == "run-1"

        get_jpx_universe(
            now=_NOW + timedelta(hours=1),
            fetch_fn=lambda: (_ for _ in ()).throw(JPXFetchError("down")),
            cache_path=cache_path,
            run_token="run-2",
            attestation_path=attestation_path,
        )
        # run-1のattestationが「run-2のattestation」として誤って
        # 生き残ってはならない——このrunはcache fallbackへ回るため
        # 一切のattestationが存在しない状態が正しい。
        assert not attestation_path.exists()

    def test_restore_then_live_refresh_writes_new_attestation_for_new_run_token(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        attestation_path = tmp_path / "cache.attestation.json"
        self._live(cache_path, attestation_path, run_token="run-1", now=_NOW)

        second = self._live(
            cache_path, attestation_path, run_token="run-2", now=_NOW + timedelta(hours=1)
        )
        attestation = load_attestation(attestation_path)
        assert attestation["run_token"] == "run-2"
        assert attestation["fetched_at"] == second.fetched_at
        assert attestation["cache_sha256"] == hashlib.sha256(cache_path.read_bytes()).hexdigest()


class TestLoadAttestation:
    def test_missing_file_returns_none(self, tmp_path):
        assert load_attestation(tmp_path / "missing.json") is None

    def test_malformed_json_returns_none(self, tmp_path):
        path = tmp_path / "attestation.json"
        path.write_text("{not valid json", encoding="utf-8")
        assert load_attestation(path) is None

    def test_wrong_schema_kind_returns_none(self, tmp_path):
        path = tmp_path / "attestation.json"
        path.write_text(json.dumps({"schemaKind": "wrong"}), encoding="utf-8")
        assert load_attestation(path) is None

    def test_missing_required_field_returns_none(self, tmp_path):
        path = tmp_path / "attestation.json"
        path.write_text(
            json.dumps({
                "schemaKind": "jpx_universe_cache_attestation_v1",
                "run_token": "abc",
                # cache_sha256欠損
                "source": SOURCE_IDENTIFIER,
                "fetched_at": _NOW.isoformat(),
                "eligible_count": 10,
            }),
            encoding="utf-8",
        )
        assert load_attestation(path) is None

    def test_non_hex_sha256_returns_none(self, tmp_path):
        path = tmp_path / "attestation.json"
        path.write_text(
            json.dumps({
                "schemaKind": "jpx_universe_cache_attestation_v1",
                "run_token": "abc",
                "cache_sha256": "z" * 64,
                "source": SOURCE_IDENTIFIER,
                "fetched_at": _NOW.isoformat(),
                "eligible_count": 10,
            }),
            encoding="utf-8",
        )
        assert load_attestation(path) is None

    def test_valid_attestation_is_loaded(self, tmp_path):
        path = tmp_path / "attestation.json"
        payload = {
            "schemaKind": "jpx_universe_cache_attestation_v1",
            "run_token": "abc",
            "cache_sha256": "0" * 64,
            "source": SOURCE_IDENTIFIER,
            "fetched_at": _NOW.isoformat(),
            "eligible_count": 10,
        }
        path.write_text(json.dumps(payload), encoding="utf-8")
        assert load_attestation(path) == payload


# ---------------------------------------------------------------------------
# P5-B005-R4 §22/§36 — jpx_cache_save_eligible() canonical save-authority
# matrix. This is the exact function the Full Batch workflow's
# "Validate JPX cache save eligibility" step imports and calls — testing it
# directly exercises the real save-authority contract without needing to
# execute the embedded workflow script.
# ---------------------------------------------------------------------------

class TestJpxCacheSaveEligible:
    _RUN_TOKEN = "run-token-abc"

    def _valid_scenario(self):
        cache_payload = _valid_cache_payload()
        cache_bytes = json.dumps(cache_payload, ensure_ascii=False, indent=2).encode("utf-8")
        attestation = {
            "schemaKind": "jpx_universe_cache_attestation_v1",
            "run_token": self._RUN_TOKEN,
            "cache_sha256": hashlib.sha256(cache_bytes).hexdigest(),
            "source": cache_payload["source"],
            "fetched_at": cache_payload["fetched_at"],
            "eligible_count": len(cache_payload["items"]),
        }
        candidates_meta = {
            "runToken": self._RUN_TOKEN,
            "universeProvenance": {
                "jpxFallbackUsed": False,
                "jpxSource": SOURCE_IDENTIFIER,
                "jpxEligibleCount": len(cache_payload["items"]),
            },
        }
        return candidates_meta, cache_payload, cache_bytes, attestation

    def _eval(self, meta, cache, cache_bytes, attestation):
        return jpx_cache_save_eligible(
            candidates_meta=meta,
            expected_run_token=self._RUN_TOKEN,
            cache_payload=cache,
            cache_bytes=cache_bytes,
            attestation=attestation,
            now=_NOW,
        )

    # --- §36 direct save-authority scenarios A-H ---------------------------

    def test_a_live_jpx_no_restored_cache_is_eligible(self):
        meta, cache, cache_bytes, attestation = self._valid_scenario()
        ok, _ = self._eval(meta, cache, cache_bytes, attestation)
        assert ok is True

    def test_b_restored_valid_cache_live_fail_is_not_eligible(self):
        meta, cache, cache_bytes, _attestation = self._valid_scenario()
        meta["universeProvenance"]["jpxFallbackUsed"] = True
        ok, _ = self._eval(meta, cache, cache_bytes, None)
        assert ok is False

    def test_c_invalid_cache_seed_fallback_is_not_eligible(self):
        meta, _cache, _cache_bytes, _attestation = self._valid_scenario()
        meta["universeProvenance"]["jpxFallbackUsed"] = True
        meta["universeProvenance"]["jpxSource"] = "data/build_candidates_stocks.py::SEED_LIST"
        ok, _ = self._eval(meta, None, None, None)
        assert ok is False

    def test_d_restored_cache_live_refresh_is_eligible(self):
        meta, cache, cache_bytes, attestation = self._valid_scenario()
        ok, _ = self._eval(meta, cache, cache_bytes, attestation)
        assert ok is True

    def test_e_live_refresh_with_prescreen_fallback_is_still_eligible(self):
        # aggregate _meta.pipelinePath would be "cache_fallback" here (only
        # the prescreen stage fell back), but jpxFallbackUsed stays False —
        # the gate must not depend on pipelinePath at all (§16/§27).
        meta, cache, cache_bytes, attestation = self._valid_scenario()
        ok, _ = self._eval(meta, cache, cache_bytes, attestation)
        assert ok is True

    def test_f_fresh_cache_replaced_by_another_valid_cache_is_not_eligible(self):
        meta, _cache, _cache_bytes, attestation = self._valid_scenario()
        other_cache = _valid_cache_payload(
            items=_cache_items(MIN_ELIGIBLE_COUNT, start_code=5000)
        )
        other_bytes = json.dumps(other_cache, ensure_ascii=False, indent=2).encode("utf-8")
        ok, reason = self._eval(meta, other_cache, other_bytes, attestation)
        assert ok is False
        assert "cache_sha256" in reason

    def test_g_wrong_attestation_run_token_is_not_eligible(self):
        meta, cache, cache_bytes, attestation = self._valid_scenario()
        attestation = dict(attestation, run_token="different-token")
        ok, reason = self._eval(meta, cache, cache_bytes, attestation)
        assert ok is False
        assert "run_token" in reason

    def test_h_wrong_attestation_hash_is_not_eligible(self):
        meta, cache, cache_bytes, attestation = self._valid_scenario()
        attestation = dict(attestation, cache_sha256="0" * 64)
        ok, reason = self._eval(meta, cache, cache_bytes, attestation)
        assert ok is False
        assert "cache_sha256" in reason

    # --- §28 additional tamper matrix ---------------------------------------

    def test_missing_attestation_is_not_eligible(self):
        meta, cache, cache_bytes, _attestation = self._valid_scenario()
        ok, reason = self._eval(meta, cache, cache_bytes, None)
        assert ok is False
        assert "attestation" in reason

    def test_wrong_attestation_source_is_not_eligible(self):
        meta, cache, cache_bytes, attestation = self._valid_scenario()
        attestation = dict(attestation, source="some_other_source")
        ok, _ = self._eval(meta, cache, cache_bytes, attestation)
        assert ok is False

    def test_wrong_attestation_eligible_count_is_not_eligible(self):
        meta, cache, cache_bytes, attestation = self._valid_scenario()
        attestation = dict(attestation, eligible_count=attestation["eligible_count"] + 1)
        ok, _ = self._eval(meta, cache, cache_bytes, attestation)
        assert ok is False

    def test_wrong_attestation_timestamp_is_not_eligible(self):
        meta, cache, cache_bytes, attestation = self._valid_scenario()
        attestation = dict(attestation, fetched_at="2020-01-01T00:00:00+00:00")
        ok, _ = self._eval(meta, cache, cache_bytes, attestation)
        assert ok is False

    def test_wrong_universe_provenance_source_is_not_eligible(self):
        meta, cache, cache_bytes, attestation = self._valid_scenario()
        meta["universeProvenance"]["jpxSource"] = "not_the_jpx_source"
        ok, _ = self._eval(meta, cache, cache_bytes, attestation)
        assert ok is False

    def test_wrong_universe_provenance_eligible_count_is_not_eligible(self):
        meta, cache, cache_bytes, attestation = self._valid_scenario()
        meta["universeProvenance"]["jpxEligibleCount"] += 1
        ok, _ = self._eval(meta, cache, cache_bytes, attestation)
        assert ok is False

    def test_wrong_run_token_in_candidates_meta_is_not_eligible(self):
        meta, cache, cache_bytes, attestation = self._valid_scenario()
        meta["runToken"] = "different-run-token"
        ok, _ = self._eval(meta, cache, cache_bytes, attestation)
        assert ok is False

    def test_missing_universe_provenance_is_not_eligible(self):
        meta, cache, cache_bytes, attestation = self._valid_scenario()
        del meta["universeProvenance"]
        ok, _ = self._eval(meta, cache, cache_bytes, attestation)
        assert ok is False

    def test_cache_authority_invalid_is_not_eligible(self):
        meta, cache, cache_bytes, attestation = self._valid_scenario()
        cache = dict(cache, source="wrong_source")
        ok, _ = self._eval(meta, cache, cache_bytes, attestation)
        assert ok is False

    def test_missing_cache_file_is_not_eligible(self):
        meta, _cache, _cache_bytes, attestation = self._valid_scenario()
        ok, reason = self._eval(meta, None, None, attestation)
        assert ok is False
        assert "cache" in reason
