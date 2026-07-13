"""
P5-B004a/B004b: build_candidates_stocks.py の責務分離 scaffold 回帰テスト

テスト対象:
  data/build_candidates_stocks.py の
  default_universe_provider(), enrich_universe(), apply_publish_cap(),
  enforce_enrichment_guard(), build_candidates_stocks(),
  is_valid_candidates_stocks_schema(), is_stale_payload(), decide_write()

確認項目:
  1. default providerがSEED_LIST 41件をそのまま返す
  2. universe=seed_list_v1維持
  3. schemaVersion維持
  4. provider差替え可能（B002b-1/B003は無改修で維持できる形）
  5. publish cap動作（cap未満/cap超過）
  6. fresh existing + new empty → overwrite防止
  7. stale existing + new empty → 通常empty出力
  8. corrupt/schema不正existingはfallback不可
  9. per-symbol fail-soft維持（1銘柄の例外が全体を止めない）
  10. personal holdings/trust/cashを参照しない（forbidden keys不在）

P5-B004b追加確認項目（Fable adversarial review P1×4対応）:
  11. status semantics: published candidatesの品質のみで判定する
      （STATUS-1/STATUS-2/TQ-04: universe > cap で全published成功なら
      status=ok。cap外の失敗・truncationはstatusに混ぜない）
  12. _meta.counts（universeCount/publishedCount/truncatedCount/
      failedTotalCount）が正しい
  13. provider provenance: _meta.universeはprovider自身が返す
      universe_idに追随する（SCALE-02: 固定UNIVERSE定数に張り付かない）
  14. enrichment safety guard: MAX_ENRICHMENT_UNIVERSE超過universeは
      silent truncationせずfail-fastする（SCALE-01）
"""

from datetime import datetime, timezone, timedelta

import pytest

from data.build_candidates_stocks import (
    MAX_ENRICHMENT_UNIVERSE,
    PUBLISH_CAP,
    SCHEMA_VERSION,
    SEED_LIST,
    UNIVERSE,
    EnrichmentGuardExceeded,
    UniverseResult,
    apply_publish_cap,
    build_candidates_stocks,
    decide_write,
    default_universe_provider,
    enforce_enrichment_guard,
    enrich_universe,
    is_stale_payload,
    is_valid_candidates_stocks_schema,
)

JST = timezone(timedelta(hours=9))
_NOW = datetime(2026, 7, 13, 12, 0, 0, tzinfo=JST)

FORBIDDEN_KEYS = {
    'eval', 'pnlPct', 'purchase_date', 'acquiredAt', 'account',
    'accountType', 'holdings', 'cash', 'reserve', 'amount',
    'maxAmount', 'sizing', 'headroom', 'score', 'action',
    'trust', 'nisa',
}


def _ok_item(code: str, name: str = "Dummy", sector: str = "セクター") -> dict:
    return {
        'code': code, 'name': name, 'sector': sector,
        'price': 100.0, 'per': 10.0, 'pbr': 1.0, 'roe': 12.0,
        'dividendYield': 2.0, 'sigma252d': 0.2, 'mom3m': 1.0,
        'screenReasons': [], 'dataStatus': 'ok',
    }


def _partial_item(code: str, name: str = "Dummy", sector: str = "セクター") -> dict:
    return {
        'code': code, 'name': name, 'sector': sector,
        'price': None, 'per': None, 'pbr': None, 'roe': None,
        'dividendYield': None, 'sigma252d': None, 'mom3m': None,
        'screenReasons': [], 'dataStatus': 'partial',
    }


def _fake_fetch_ok(code: str, name: str, sector: str) -> dict:
    return _ok_item(code, name, sector)


def _valid_existing_payload(status: str = 'ok', updated_at: str | None = None) -> dict:
    ts = updated_at or _NOW.isoformat()
    return {
        "schemaVersion": SCHEMA_VERSION,
        "updatedAt": ts,
        "sourceUpdatedAt": ts,
        "staleThresholdHours": 48,
        "_meta": {
            "kind": "candidates_stocks",
            "source": "data/build_candidates_stocks.py + yfinance",
            "not_for_trading": True,
            "universe": UNIVERSE,
            "note": "note",
        },
        "candidates": [_ok_item('7203', 'トヨタ自動車', '自動車')],
        "missing": [],
        "status": status,
    }


# ---------------------------------------------------------------------------
# 1-3. default provider / universe / schemaVersion
# ---------------------------------------------------------------------------

class TestDefaultProvider:
    def test_default_provider_returns_41_items(self):
        universe_id, items = default_universe_provider()
        assert len(items) == 41
        assert len(SEED_LIST) == 41
        assert universe_id == "seed_list_v1"

    def test_default_provider_returns_copy_not_reference(self):
        _, items = default_universe_provider()
        items.append(('9999', 'ダミー', 'test'))
        assert len(SEED_LIST) == 41

    def test_universe_meta_is_seed_list_v1(self):
        payload = build_candidates_stocks(fetch_fn=_fake_fetch_ok, now=_NOW)
        assert payload["_meta"]["universe"] == "seed_list_v1"

    def test_schema_version_preserved(self):
        payload = build_candidates_stocks(fetch_fn=_fake_fetch_ok, now=_NOW)
        assert payload["schemaVersion"] == "candidates-stocks-1"

    def test_default_build_returns_41_candidates_ok_status(self):
        payload = build_candidates_stocks(fetch_fn=_fake_fetch_ok, now=_NOW)
        assert len(payload["candidates"]) == 41
        assert payload["status"] == "ok"
        assert payload["missing"] == []


# ---------------------------------------------------------------------------
# 4. provider差替え可能 / provider provenance（P5-B004b SCALE-02）
# ---------------------------------------------------------------------------

class TestProviderSwap:
    def test_custom_provider_is_used(self):
        def custom_provider():
            return UniverseResult("custom_v1", [('1111', 'カスタム銘柄', 'テスト')])

        payload = build_candidates_stocks(
            universe_provider=custom_provider, fetch_fn=_fake_fetch_ok, now=_NOW
        )
        assert len(payload["candidates"]) == 1
        assert payload["candidates"][0]["code"] == "1111"

    def test_custom_provider_universe_id_propagates_to_meta(self):
        # P5-B004b SCALE-02: _meta.universeは固定UNIVERSE定数ではなく、
        # provider自身が返すuniverse_idに追随する
        def custom_provider():
            return UniverseResult("custom_v1", [('1111', 'カスタム銘柄', 'テスト')])

        payload = build_candidates_stocks(
            universe_provider=custom_provider, fetch_fn=_fake_fetch_ok, now=_NOW
        )
        assert payload["_meta"]["universe"] == "custom_v1"

    def test_default_provider_universe_id_is_seed_list_v1(self):
        payload = build_candidates_stocks(fetch_fn=_fake_fetch_ok, now=_NOW)
        assert payload["_meta"]["universe"] == "seed_list_v1"


# ---------------------------------------------------------------------------
# 5. publish cap
# ---------------------------------------------------------------------------

class TestPublishCap:
    def test_cap_below_count_no_truncation(self):
        candidates = [_ok_item(str(i)) for i in range(5)]
        missing = []
        published, published_missing, truncated = apply_publish_cap(candidates, missing, cap=10)
        assert len(published) == 5
        assert truncated == 0

    def test_cap_above_count_truncates_deterministically(self):
        candidates = [_ok_item(str(i)) for i in range(10)]
        missing = []
        published, published_missing, truncated = apply_publish_cap(candidates, missing, cap=3)
        assert len(published) == 3
        assert truncated == 7
        assert [c['code'] for c in published] == ['0', '1', '2']

    def test_cap_is_deterministic_across_calls(self):
        candidates = [_ok_item(str(i)) for i in range(20)]
        r1 = apply_publish_cap(candidates, [], cap=5)
        r2 = apply_publish_cap(candidates, [], cap=5)
        assert [c['code'] for c in r1[0]] == [c['code'] for c in r2[0]]

    def test_cap_filters_missing_to_published_only(self):
        candidates = [_ok_item('0'), _partial_item('1'), _partial_item('2')]
        missing = ['1', '2']
        published, published_missing, truncated = apply_publish_cap(candidates, missing, cap=2)
        assert published_missing == ['1']

    def test_default_publish_cap_does_not_change_41_seed_result(self):
        payload = build_candidates_stocks(fetch_fn=_fake_fetch_ok, now=_NOW)
        assert len(payload["candidates"]) == 41
        assert PUBLISH_CAP >= 41

    def test_publish_cap_truncation_alone_does_not_force_partial_status(self):
        # P5-B004b STATUS-1: universe(300) > cap(50)でもpublished 50件が
        # 全件okなら、cap外のtruncationはstatusに混ぜずstatus=okとする
        # （旧誤契約: cap前len(universe)とok_countを比較しpartialに固定していた）
        def big_provider():
            return UniverseResult("big_v1", [(str(i), f"銘柄{i}", "セクター") for i in range(300)])

        payload = build_candidates_stocks(
            universe_provider=big_provider, fetch_fn=_fake_fetch_ok,
            publish_cap=50, now=_NOW,
        )
        assert len(payload["candidates"]) == 50
        assert payload["status"] == "ok"
        assert payload["_meta"]["counts"] == {
            "universeCount": 300,
            "publishedCount": 50,
            "truncatedCount": 250,
            "failedTotalCount": 0,
        }


# ---------------------------------------------------------------------------
# P5-B004b: status semantics（published candidatesの品質のみで判定）
# ---------------------------------------------------------------------------

class TestStatusSemantics:
    def test_all_published_ok_is_status_ok(self):
        payload = build_candidates_stocks(
            universe_provider=lambda: UniverseResult("seed_list_v1", [('1', 'A', 'S'), ('2', 'B', 'S')]),
            fetch_fn=_fake_fetch_ok, now=_NOW,
        )
        assert payload["status"] == "ok"

    def test_mixed_ok_and_partial_within_published_is_status_partial(self):
        def mixed_fetch(code, name, sector):
            return _ok_item(code, name, sector) if code == '1' else _partial_item(code, name, sector)

        payload = build_candidates_stocks(
            universe_provider=lambda: UniverseResult("seed_list_v1", [('1', 'A', 'S'), ('2', 'B', 'S')]),
            fetch_fn=mixed_fetch, now=_NOW,
        )
        assert payload["status"] == "partial"

    def test_all_published_partial_is_status_empty(self):
        payload = build_candidates_stocks(
            universe_provider=lambda: UniverseResult("seed_list_v1", [('1', 'A', 'S'), ('2', 'B', 'S')]),
            fetch_fn=lambda code, name, sector: _partial_item(code, name, sector), now=_NOW,
        )
        assert payload["status"] == "empty"

    def test_zero_candidates_is_status_empty(self):
        payload = build_candidates_stocks(
            universe_provider=lambda: UniverseResult("seed_list_v1", []),
            fetch_fn=_fake_fetch_ok, now=_NOW,
        )
        assert payload["status"] == "empty"
        assert payload["candidates"] == []

    def test_metadata_counts_reflect_universe_publish_and_failures(self):
        def mostly_fail_fetch(code, name, sector):
            return _ok_item(code, name, sector) if code == '0' else _partial_item(code, name, sector)

        payload = build_candidates_stocks(
            universe_provider=lambda: UniverseResult(
                "seed_list_v1", [(str(i), f"n{i}", "s") for i in range(10)]
            ),
            fetch_fn=mostly_fail_fetch, publish_cap=5, now=_NOW,
        )
        assert payload["_meta"]["counts"] == {
            "universeCount": 10,
            "publishedCount": 5,
            "truncatedCount": 5,
            "failedTotalCount": 9,
        }


# ---------------------------------------------------------------------------
# P5-B004b: enrichment safety guard（SCALE-01）
# ---------------------------------------------------------------------------

class TestEnrichmentGuard:
    def test_universe_within_guard_passes(self):
        universe = [(str(i), f"n{i}", "s") for i in range(MAX_ENRICHMENT_UNIVERSE)]
        enforce_enrichment_guard(universe)  # raises nothing

    def test_universe_exceeding_guard_raises(self):
        universe = [(str(i), f"n{i}", "s") for i in range(MAX_ENRICHMENT_UNIVERSE + 1)]
        with pytest.raises(EnrichmentGuardExceeded):
            enforce_enrichment_guard(universe)

    def test_oversized_provider_fails_fast_without_enriching(self):
        calls: list[str] = []

        def counting_fetch(code, name, sector):
            calls.append(code)
            return _ok_item(code, name, sector)

        def whole_market_provider():
            return UniverseResult(
                "whole_market_v1",
                [(str(i), f"n{i}", "s") for i in range(MAX_ENRICHMENT_UNIVERSE + 1)],
            )

        with pytest.raises(EnrichmentGuardExceeded):
            build_candidates_stocks(
                universe_provider=whole_market_provider, fetch_fn=counting_fetch, now=_NOW,
            )
        assert calls == []  # guardはenrichment着手前にfail-fastする（silent truncationなし）

    def test_current_41_seed_universe_is_within_guard(self):
        _, items = default_universe_provider()
        assert len(items) <= MAX_ENRICHMENT_UNIVERSE


# ---------------------------------------------------------------------------
# 6-8. stale-fallback guard
# ---------------------------------------------------------------------------

class TestStaleFallbackGuard:
    def test_fresh_existing_blocks_empty_overwrite(self):
        new_payload = {"status": "empty", "candidates": [], "missing": []}
        existing = _valid_existing_payload(status="ok", updated_at=_NOW.isoformat())
        should_write, reason = decide_write(new_payload, existing, _NOW)
        assert should_write is False
        assert reason == "existing-fresh-fallback-guard"

    def test_stale_existing_allows_empty_overwrite(self):
        old_ts = (_NOW - timedelta(hours=100)).isoformat()
        new_payload = {"status": "empty", "candidates": [], "missing": []}
        existing = _valid_existing_payload(status="ok", updated_at=old_ts)
        should_write, reason = decide_write(new_payload, existing, _NOW)
        assert should_write is True
        assert reason == "existing-stale"

    def test_no_existing_allows_empty_write(self):
        new_payload = {"status": "empty", "candidates": [], "missing": []}
        should_write, reason = decide_write(new_payload, None, _NOW)
        assert should_write is True
        assert reason == "no-valid-existing"

    def test_corrupt_existing_cannot_be_used_as_fallback(self):
        # is_valid_candidates_stocks_schema()でNone判定済みのものを渡す想定
        new_payload = {"status": "empty", "candidates": [], "missing": []}
        should_write, reason = decide_write(new_payload, None, _NOW)
        assert should_write is True
        assert reason == "no-valid-existing"

    def test_schema_invalid_payload_rejected(self):
        assert is_valid_candidates_stocks_schema({"schemaVersion": "wrong"}) is False
        assert is_valid_candidates_stocks_schema({"schemaVersion": SCHEMA_VERSION, "candidates": "not-a-list"}) is False
        assert is_valid_candidates_stocks_schema("not-a-dict") is False
        assert is_valid_candidates_stocks_schema({
            "schemaVersion": SCHEMA_VERSION, "candidates": [], "missing": [], "status": "bogus",
        }) is False

    def test_schema_valid_payload_accepted(self):
        assert is_valid_candidates_stocks_schema(_valid_existing_payload()) is True

    def test_nonempty_new_result_always_writes_regardless_of_existing(self):
        new_payload = {"status": "ok", "candidates": [_ok_item('7203')], "missing": []}
        existing = _valid_existing_payload(status="ok", updated_at=_NOW.isoformat())
        should_write, reason = decide_write(new_payload, existing, _NOW)
        assert should_write is True
        assert reason == "new-nonempty"

    def test_is_stale_payload_true_when_old(self):
        old_ts = (_NOW - timedelta(hours=49)).isoformat()
        payload = _valid_existing_payload(updated_at=old_ts)
        assert is_stale_payload(payload, _NOW) is True

    def test_is_stale_payload_false_when_fresh(self):
        payload = _valid_existing_payload(updated_at=_NOW.isoformat())
        assert is_stale_payload(payload, _NOW) is False

    def test_is_stale_payload_true_when_missing_timestamps(self):
        payload = _valid_existing_payload()
        payload["updatedAt"] = None
        payload["sourceUpdatedAt"] = None
        assert is_stale_payload(payload, _NOW) is True

    def test_stale_fallback_does_not_mutate_existing_timestamps(self):
        # decide_write自体はexisting_payloadを書き換えない（副作用なし）ことを確認
        existing = _valid_existing_payload(status="ok", updated_at=_NOW.isoformat())
        original = dict(existing)
        new_payload = {"status": "empty", "candidates": [], "missing": []}
        decide_write(new_payload, existing, _NOW)
        assert existing == original


# ---------------------------------------------------------------------------
# 9. per-symbol fail-soft維持
# ---------------------------------------------------------------------------

class TestFailSoft:
    def test_one_symbol_exception_does_not_stop_others(self):
        def flaky_fetch(code, name, sector):
            if code == '2':
                raise RuntimeError("boom")
            return _ok_item(code, name, sector)

        universe = [('1', 'A', 'S'), ('2', 'B', 'S'), ('3', 'C', 'S')]
        candidates, missing = enrich_universe(universe, fetch_fn=flaky_fetch)
        assert len(candidates) == 3
        assert candidates[1]['dataStatus'] == 'partial'
        assert missing == ['2']

    def test_failed_symbol_included_with_null_fields(self):
        def flaky_fetch(code, name, sector):
            raise RuntimeError("boom")

        universe = [('1', 'A', 'S')]
        candidates, missing = enrich_universe(universe, fetch_fn=flaky_fetch)
        assert candidates[0]['price'] is None
        assert candidates[0]['dataStatus'] == 'partial'

    def test_all_fail_yields_empty_status(self):
        def flaky_fetch(code, name, sector):
            raise RuntimeError("boom")

        payload = build_candidates_stocks(
            universe_provider=lambda: UniverseResult("seed_list_v1", [('1', 'A', 'S'), ('2', 'B', 'S')]),
            fetch_fn=flaky_fetch, now=_NOW,
        )
        assert payload["status"] == "empty"
        assert payload["sourceUpdatedAt"] is None


# ---------------------------------------------------------------------------
# 10. personal holdings/trust/cashを参照しない
# ---------------------------------------------------------------------------

class TestNoPersonalData:
    def test_candidate_items_have_no_forbidden_keys(self):
        payload = build_candidates_stocks(fetch_fn=_fake_fetch_ok, now=_NOW)
        for c in payload["candidates"]:
            leaked = FORBIDDEN_KEYS & set(c.keys())
            assert not leaked, f"forbidden keys {leaked} in candidate {c.get('code')}"

    def test_top_level_payload_has_no_forbidden_keys(self):
        payload = build_candidates_stocks(fetch_fn=_fake_fetch_ok, now=_NOW)
        leaked = FORBIDDEN_KEYS & set(payload.keys())
        assert not leaked

    def test_not_for_trading_flag_present(self):
        payload = build_candidates_stocks(fetch_fn=_fake_fetch_ok, now=_NOW)
        assert payload["_meta"]["not_for_trading"] is True

    def test_seed_list_not_filtered_by_holdings(self):
        # SEED_LISTは固定であり、保有有無に基づくフィルタ機構自体が存在しない
        payload = build_candidates_stocks(fetch_fn=_fake_fetch_ok, now=_NOW)
        codes = {c['code'] for c in payload['candidates']}
        seed_codes = {code for code, _, _ in SEED_LIST}
        assert codes == seed_codes
