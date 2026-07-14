"""
P5-B004c-CHEAP-PRESCREEN: data/jpx_cheap_prescreen.py の回帰テスト。

確認項目（goal記載の最低19項目）:
  1. 1552→<=200 target
  2. hard max<=300
  3. batch<=400
  4. rate-limit abort
  5. success ratio<70%でcache非更新
  6. partial failure
  7. alpha-mixed code
  8. NaN/no-history/IPO
  9. main floors
  10. newcomer 63-251d/<=10
  11. sector top-1
  12. sector cap12%
  13. deterministic tie-break
  14. cache TTL 7/14日
  15. future timestamp reject
  16. malformed cache reject
  17. atomic write
  18. seed 41 production不変
  19. holdings/trust/cash/account非参照
"""
import inspect
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import data.jpx_cheap_prescreen as prescreen
from data.build_candidates_stocks import SEED_LIST, default_universe_provider
from data.jpx_cheap_prescreen import (
    CACHE_SCHEMA_KIND,
    HARD_MAX_SHORTLIST_SIZE,
    MAIN_MAX_SIGMA252,
    MAIN_MIN_ADV20_JPY,
    MAIN_MIN_HISTORY_DAYS,
    MAIN_MIN_PRICE_JPY,
    MAX_BATCH_SIZE,
    MIN_SHORTLIST_COUNT,
    NEWCOMER_MAX_COUNT,
    NEWCOMER_MAX_HISTORY_DAYS,
    NEWCOMER_MIN_HISTORY_DAYS,
    PREVIOUS_SHORTLIST_MIN_RATIO,
    SECTOR_CAP,
    SEED_BYPASS_ID,
    SHORTLIST_CACHE_HARD_EXPIRY_HOURS,
    SHORTLIST_CACHE_TARGET_TTL_HOURS,
    SHORTLIST_ID,
    SUCCESS_RATIO_MIN,
    TARGET_SHORTLIST_SIZE,
    PreScreenRateLimitError,
    ScoredCandidate,
    ShortlistItem,
    TickerSeries,
    build_candidate_pool,
    build_cheap_prescreen_shortlist,
    bulk_fetch_ohlcv,
    classify_pool,
    compute_raw_metrics,
    jpx_items_to_tickers,
    load_shortlist_cache,
    save_shortlist_cache,
    select_diversity_shortlist,
    shortlist_quality_guard_reason,
)
from data.jpx_universe_provider import JPXUniverseResult

UTC = timezone.utc
NOW = datetime(2026, 7, 14, 12, 0, 0, tzinfo=UTC)

FORBIDDEN_KEYS = {
    'eval', 'pnlPct', 'purchase_date', 'acquiredAt', 'account',
    'accountType', 'holdings', 'cash', 'reserve', 'amount',
    'maxAmount', 'sizing', 'headroom', 'action',
    'trust', 'nisa',
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def flat_series(n, price=1000.0, volume=1_000_000.0):
    """一定価格・一定出来高（変化なし=sigma≈0）のTickerSeries。floor境界
    テスト用にprice/volumeを独立に制御できる。"""
    prices = [price] * n
    return TickerSeries(raw_close=list(prices), adj_close=list(prices), volume=[volume] * n)


def alternating_series(n, price=1000.0, swing=0.005, volume=1_000_000.0):
    """price*(1+-swing)を交互適用し、annualized volatilityを制御可能にした
    series。swing=0.005 → sigma252≈0.08（main floor通過）、
    swing=0.05 → sigma252≈0.79（main floor超過で除外）。"""
    prices = []
    p = price
    for i in range(n):
        prices.append(p)
        p *= (1 + swing) if i % 2 == 0 else (1 - swing)
    return TickerSeries(raw_close=list(prices), adj_close=list(prices), volume=[volume] * n)


def make_universe(items):
    return JPXUniverseResult(
        universe_id="jpx_prime_domestic_v1",
        items=items,
        source="test",
        source_identifier="test",
        fetched_at=NOW.isoformat(),
        source_as_of=None,
        row_count=len(items),
        eligible_count=len(items),
        segment_counts={},
        filters_applied=[],
        fallback_used=False,
        cache_age_hours=0.0,
        dropped_rows=[],
    )


def main_candidate(code, sector, score):
    return ScoredCandidate(code=code, name=f"N{code}", sector=sector, pool_type="main", score=score, adv20_jpy=1e8)


def newcomer_candidate(code, sector, score, adv=1e7):
    return ScoredCandidate(code=code, name=f"N{code}", sector=sector, pool_type="newcomer", score=score, adv20_jpy=adv)


def valid_cache_payload(now=NOW, n=3):
    items = [[f"{1000+i}", f"Name{i}", f"sector{i}", "main", 0.5 + i * 0.01] for i in range(n)]
    return {
        "schemaKind": CACHE_SCHEMA_KIND,
        "shortlist_id": SHORTLIST_ID,
        "generated_at": now.isoformat(),
        "items": items,
        "universe_count": 100,
        "main_pool_count": n,
        "newcomer_pool_count": 0,
        "success_ratio": 1.0,
        "target_shortlist": TARGET_SHORTLIST_SIZE,
        "hard_max_shortlist": HARD_MAX_SHORTLIST_SIZE,
        "sector_counts": {},
    }


# ---------------------------------------------------------------------------
# 1. 1552 -> <=200 target / 2. hard max <=300
# ---------------------------------------------------------------------------


class TestTargetAndHardMax:
    def test_1552_scale_universe_shortlist_at_most_200(self):
        sectors = [f"sector{i}" for i in range(33)]
        candidates = [
            main_candidate(f"{1000+i}", sectors[i % 33], score=float(i % 997) / 997)
            for i in range(1552)
        ]
        selection = select_diversity_shortlist(candidates)
        assert len(selection.entries) == TARGET_SHORTLIST_SIZE
        assert len(selection.entries) <= HARD_MAX_SHORTLIST_SIZE

    def test_small_pool_returns_fewer_than_target_without_fabrication(self):
        candidates = [main_candidate(f"{2000+i}", f"sector{i}", score=1.0 - i * 0.01) for i in range(5)]
        selection = select_diversity_shortlist(candidates)
        assert len(selection.entries) == 5

    def test_hard_max_wins_when_target_exceeds_it(self):
        sectors = [f"sector{i}" for i in range(33)]
        candidates = [
            main_candidate(f"{3000+i}", sectors[i % 33], score=float(1000 - i))
            for i in range(1000)
        ]
        selection = select_diversity_shortlist(candidates, target_size=350, hard_max_size=300)
        assert len(selection.entries) == 300


# ---------------------------------------------------------------------------
# 3. batch <= 400
# ---------------------------------------------------------------------------


class TestBatchContract:
    def test_batch_size_over_max_rejected(self):
        with pytest.raises(ValueError):
            bulk_fetch_ohlcv(["1000.T"], batch_size=MAX_BATCH_SIZE + 1, fetch_fn=lambda ts: {}, pacing_fn=lambda: None)

    def test_default_batch_size_within_max(self):
        assert prescreen.DEFAULT_BATCH_SIZE <= MAX_BATCH_SIZE

    def test_batches_never_exceed_configured_size(self):
        tickers = [f"{1000+i}.T" for i in range(950)]
        seen_batch_sizes = []

        def fetch_fn(batch):
            seen_batch_sizes.append(len(batch))
            return {t: flat_series(300) for t in batch}

        outcome = bulk_fetch_ohlcv(tickers, batch_size=400, fetch_fn=fetch_fn, pacing_fn=lambda: None)
        assert all(size <= 400 for size in seen_batch_sizes)
        assert seen_batch_sizes == [400, 400, 150]
        assert outcome.batches_count == 3

    def test_pacing_called_between_batches_not_before_first(self):
        tickers = [f"{1000+i}.T" for i in range(850)]
        calls = []

        def fetch_fn(batch):
            return {t: flat_series(300) for t in batch}

        outcome = bulk_fetch_ohlcv(
            tickers, batch_size=400, fetch_fn=fetch_fn, pacing_fn=lambda: calls.append(1)
        )
        assert len(calls) == outcome.batches_count - 1


# ---------------------------------------------------------------------------
# 4. rate-limit abort
# ---------------------------------------------------------------------------


class TestRateLimitAbort:
    def test_rate_limit_aborts_run_without_processing_remaining_batches(self):
        tickers = [f"{1000+i}.T" for i in range(1200)]
        call_count = {"n": 0}

        def fetch_fn(batch):
            call_count["n"] += 1
            if call_count["n"] == 2:
                raise PreScreenRateLimitError("rate limited")
            return {t: flat_series(300) for t in batch}

        outcome = bulk_fetch_ohlcv(tickers, batch_size=400, fetch_fn=fetch_fn, pacing_fn=lambda: None)
        assert outcome.aborted is True
        assert call_count["n"] == 2  # 3rd batch never attempted
        assert outcome.abort_reason is not None

    def test_pipeline_rate_limit_falls_back_to_last_good_cache(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_shortlist_cache(valid_cache_payload(now=NOW - timedelta(hours=1)), cache_path)

        universe = make_universe([(f"{4000+i}", f"N{i}", "sectorA") for i in range(5)])

        def fetch_fn(batch):
            raise PreScreenRateLimitError("boom")

        result = build_cheap_prescreen_shortlist(
            universe, now=NOW, fetch_fn=fetch_fn, pacing_fn=lambda: None, cache_path=cache_path
        )
        assert result.fallback_used is True
        assert result.bypass_seed_list_v1 is False
        assert result.fetch_aborted is False  # 集約結果には未反映——cacheから復元
        assert result.shortlist_count == 3

    def test_pipeline_rate_limit_no_cache_bypasses_to_seed(self, tmp_path):
        cache_path = tmp_path / "no_cache.json"
        universe = make_universe([(f"{5000+i}", f"N{i}", "sectorA") for i in range(5)])

        def fetch_fn(batch):
            raise PreScreenRateLimitError("boom")

        result = build_cheap_prescreen_shortlist(
            universe, now=NOW, fetch_fn=fetch_fn, pacing_fn=lambda: None, cache_path=cache_path
        )
        assert result.bypass_seed_list_v1 is True
        assert result.shortlist_id == SEED_BYPASS_ID
        assert result.items == []
        assert not cache_path.exists()


# ---------------------------------------------------------------------------
# 5. success ratio < 70% -> cache非更新 / 6. partial failure
# ---------------------------------------------------------------------------


class TestSuccessRatioGuard:
    def test_low_success_ratio_does_not_write_cache(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        universe = make_universe([(f"{6000+i}", f"N{i}", "sectorA") for i in range(10)])

        def fetch_fn(batch):
            # 30%だけ成功（<70%）
            return {t: (flat_series(300) if i < 3 else None) for i, t in enumerate(batch)}

        result = build_cheap_prescreen_shortlist(
            universe, now=NOW, fetch_fn=fetch_fn, pacing_fn=lambda: None, cache_path=cache_path
        )
        assert not cache_path.exists()
        assert result.bypass_seed_list_v1 is True  # 有効cacheなし

    def test_success_ratio_exactly_at_floor_updates_cache(self, tmp_path):
        # n=80・sector分散多めでMIN_SHORTLIST_COUNT(50)の絶対floorを
        # 上回りつつ、success_ratioちょうど70%を再現する。
        cache_path = tmp_path / "cache.json"
        n = 80
        universe = make_universe([(f"{7000+i}", f"N{i}", f"sector{i%10}") for i in range(n)])

        def fetch_fn(batch):
            threshold = int(n * SUCCESS_RATIO_MIN)  # 70% = 56
            return {
                t: (flat_series(300, price=1000, volume=100_000) if i < threshold else None)
                for i, t in enumerate(batch)
            }

        result = build_cheap_prescreen_shortlist(
            universe, now=NOW, fetch_fn=fetch_fn, pacing_fn=lambda: None, cache_path=cache_path
        )
        assert result.success_ratio == pytest.approx(0.7)
        assert cache_path.exists()
        assert result.fallback_used is False

    def test_partial_failure_excludes_failed_tickers_but_continues(self, tmp_path):
        # n=60・sector分散ありでMIN_SHORTLIST_COUNT(50)を上回りつつ
        # partial failure（10%失敗・90%成功）を再現する。
        cache_path = tmp_path / "cache.json"
        n = 60
        universe = make_universe([(f"{8000+i}", f"N{i}", f"sector{i%6}") for i in range(n)])

        def fetch_fn(batch):
            # 10件に1件のみ失敗（90%成功）——partial failure自体の許容を見るテスト
            return {t: (flat_series(300, price=1000, volume=1_000_000) if i % 10 != 0 else None) for i, t in enumerate(batch)}

        result = build_cheap_prescreen_shortlist(
            universe, now=NOW, fetch_fn=fetch_fn, pacing_fn=lambda: None, cache_path=cache_path
        )
        assert result.success_ratio == pytest.approx(0.9)
        assert result.fallback_used is False
        assert result.universe_count == n
        assert result.main_pool_count <= 54  # 6件は取得失敗のため対象外


# ---------------------------------------------------------------------------
# 7. alpha-mixed code
# ---------------------------------------------------------------------------


class TestAlphaMixedCode:
    def test_ticker_conversion_preserves_alpha_mixed_code(self):
        tickers = jpx_items_to_tickers([("166A", "Foo", "sectorA"), ("285A", "Bar", "sectorB")])
        assert tickers == ["166A.T", "285A.T"]

    def test_pipeline_handles_alpha_mixed_code_end_to_end(self, tmp_path):
        # MIN_SHORTLIST_COUNT(50)の絶対floorを上回るようalpha-mixed 1件+
        # 通常code多数を混在させる。
        cache_path = tmp_path / "cache.json"
        items = [("166A", "Foo", "sectorA")] + [
            (f"{1000+i}", f"Bar{i}", f"sector{i%10}") for i in range(59)
        ]
        universe = make_universe(items)

        def fetch_fn(batch):
            return {t: flat_series(300, price=1000, volume=1_000_000) for t in batch}

        result = build_cheap_prescreen_shortlist(
            universe, now=NOW, fetch_fn=fetch_fn, pacing_fn=lambda: None, cache_path=cache_path
        )
        codes = {e.code for e in result.entries}
        assert "166A" in codes


# ---------------------------------------------------------------------------
# 8. NaN / no-history / IPO
# ---------------------------------------------------------------------------


class TestNaNAndMissingHistory:
    def test_extract_ticker_series_drops_nan_and_inf_rows(self):
        series = prescreen._extract_ticker_series(
            raw_close=[100.0, float("nan"), 102.0, float("inf")],
            adj_close=[100.0, 101.0, 102.0, 103.0],
            volume=[1000.0, 1000.0, float("nan"), 1000.0],
        )
        assert series is not None
        assert series.raw_close == [100.0]  # index0のみ全系列finite

    def test_all_nan_series_returns_none(self):
        series = prescreen._extract_ticker_series(
            raw_close=[float("nan")] * 5,
            adj_close=[float("nan")] * 5,
            volume=[float("nan")] * 5,
        )
        assert series is None

    def test_ipo_short_history_excluded_from_both_pools(self):
        metrics = compute_raw_metrics(flat_series(10))
        assert classify_pool(metrics) is None

    def test_negative_volume_row_dropped(self):
        series = prescreen._extract_ticker_series(
            raw_close=[100.0, 100.0],
            adj_close=[100.0, 100.0],
            volume=[1000.0, -5.0],
        )
        assert series is not None
        assert len(series.raw_close) == 1


# ---------------------------------------------------------------------------
# 9. main floors
# ---------------------------------------------------------------------------


class TestMainFloors:
    def test_passes_all_floors_is_main(self):
        series = alternating_series(MAIN_MIN_HISTORY_DAYS, price=1000.0, swing=0.005, volume=100_000.0)
        metrics = compute_raw_metrics(series)
        assert metrics.history_days >= MAIN_MIN_HISTORY_DAYS
        assert metrics.adv20_jpy >= MAIN_MIN_ADV20_JPY
        assert metrics.price >= MAIN_MIN_PRICE_JPY
        assert metrics.sigma252 <= MAIN_MAX_SIGMA252
        assert classify_pool(metrics) == "main"

    def test_below_history_floor_not_main(self):
        series = alternating_series(MAIN_MIN_HISTORY_DAYS - 1, swing=0.005, volume=100_000.0)
        metrics = compute_raw_metrics(series)
        assert classify_pool(metrics) != "main"

    def test_below_adv_floor_excluded_not_downgraded_to_newcomer(self):
        series = alternating_series(MAIN_MIN_HISTORY_DAYS, price=1000.0, swing=0.005, volume=1.0)
        metrics = compute_raw_metrics(series)
        assert metrics.adv20_jpy < MAIN_MIN_ADV20_JPY
        assert classify_pool(metrics) is None

    def test_below_price_floor_excluded(self):
        series = alternating_series(MAIN_MIN_HISTORY_DAYS, price=50.0, swing=0.005, volume=10_000_000.0)
        metrics = compute_raw_metrics(series)
        assert metrics.price < MAIN_MIN_PRICE_JPY
        assert classify_pool(metrics) is None

    def test_sigma_above_floor_excluded(self):
        series = alternating_series(MAIN_MIN_HISTORY_DAYS, price=1000.0, swing=0.05, volume=10_000_000.0)
        metrics = compute_raw_metrics(series)
        assert metrics.sigma252 > MAIN_MAX_SIGMA252
        assert classify_pool(metrics) is None


# ---------------------------------------------------------------------------
# 10. newcomer 63-251d / <=10
# ---------------------------------------------------------------------------


class TestNewcomerPool:
    def test_history_63_is_newcomer(self):
        metrics = compute_raw_metrics(flat_series(NEWCOMER_MIN_HISTORY_DAYS, volume=1_000_000.0))
        assert classify_pool(metrics) == "newcomer"

    def test_history_251_is_newcomer(self):
        metrics = compute_raw_metrics(flat_series(NEWCOMER_MAX_HISTORY_DAYS, volume=1_000_000.0))
        assert classify_pool(metrics) == "newcomer"

    def test_history_62_excluded(self):
        metrics = compute_raw_metrics(flat_series(NEWCOMER_MIN_HISTORY_DAYS - 1, volume=1_000_000.0))
        assert classify_pool(metrics) is None

    def test_history_252_is_main_track_not_newcomer(self):
        series = alternating_series(NEWCOMER_MAX_HISTORY_DAYS + 1, swing=0.005, volume=100_000.0)
        metrics = compute_raw_metrics(series)
        assert classify_pool(metrics) in ("main", None)
        assert classify_pool(metrics) != "newcomer"

    def test_newcomer_cap_enforced_at_10(self):
        newcomers = [newcomer_candidate(f"{9000+i}", "sectorA", score=0.5, adv=1e7 + i) for i in range(20)]
        selection = select_diversity_shortlist(newcomers, target_size=200, hard_max_size=300)
        assert selection.newcomer_count <= NEWCOMER_MAX_COUNT
        assert selection.reserved_newcomer_count == NEWCOMER_MAX_COUNT

    def test_newcomer_selection_prioritizes_adv_over_score(self):
        newcomers = [
            newcomer_candidate("A", "sectorA", score=0.9, adv=1.0),
            newcomer_candidate("B", "sectorA", score=0.1, adv=100.0),
        ]
        selection = select_diversity_shortlist(newcomers, target_size=1, hard_max_size=1, newcomer_max=1)
        assert selection.entries[0].code == "B"  # ADVが高いBが優先


# ---------------------------------------------------------------------------
# 11. sector top-1 / 12. sector cap 12%
# ---------------------------------------------------------------------------


class TestDiversity:
    def test_sector_top1_guaranteed_even_with_low_score(self):
        candidates = [main_candidate(f"{i}", "richsector", score=0.9) for i in range(50)]
        candidates.append(main_candidate("lonely", "poorsector", score=0.01))
        selection = select_diversity_shortlist(candidates, target_size=10, hard_max_size=20, sector_cap=5)
        codes = {c.code for c in selection.entries}
        assert "lonely" in codes

    def test_sector_cap_enforced(self):
        # bigsectorは高scoreな候補を大量(100件)持つが、他8sectorにも
        # target到達に十分な供給(各5件)があるため、backfill(cap緩和)を
        # 発動させずにprimary fill段階だけでcapの効きを検証できる。
        candidates = [main_candidate(f"big{i}", "bigsector", score=1.0 - i * 0.001) for i in range(100)]
        for s in range(8):
            candidates += [
                main_candidate(f"other{s}_{j}", f"sector{s}", score=0.5 - j * 0.001) for j in range(5)
            ]
        selection = select_diversity_shortlist(candidates, target_size=30, hard_max_size=100, sector_cap=5)
        assert len(selection.entries) == 30
        assert selection.sector_counts["bigsector"] == 5

    def test_sector_cap_matches_12_percent_of_target(self):
        assert SECTOR_CAP == int(TARGET_SHORTLIST_SIZE * 0.12)
        assert SECTOR_CAP == 24

    def test_backfill_relaxes_sector_cap_when_quota_unmet(self):
        # 1 sectorにしか候補が無い場合、sector capが働くとtarget未達になるが
        # backfillでcapを緩め、poolが尽きるまで埋める。
        candidates = [main_candidate(f"s{i}", "onlysector", score=1.0 - i * 0.001) for i in range(30)]
        selection = select_diversity_shortlist(candidates, target_size=20, hard_max_size=50, sector_cap=5)
        assert len(selection.entries) == 20
        assert selection.sector_counts["onlysector"] == 20


# ---------------------------------------------------------------------------
# 13. deterministic tie-break
# ---------------------------------------------------------------------------


class TestDeterminism:
    def test_equal_score_ties_broken_by_code_ascending(self):
        candidates = [
            main_candidate("2000", "sectorA", score=0.5),
            main_candidate("1000", "sectorA", score=0.5),
            main_candidate("1500", "sectorB", score=0.5),
        ]
        selection = select_diversity_shortlist(candidates, target_size=3, hard_max_size=3, sector_cap=3)
        codes = [c.code for c in selection.entries]
        assert codes == sorted(codes)

    def test_same_input_same_output_repeated_runs(self):
        sectors = [f"sector{i}" for i in range(10)]
        candidates = [main_candidate(f"{1000+i}", sectors[i % 10], score=float((i * 37) % 101) / 101) for i in range(200)]
        r1 = select_diversity_shortlist(candidates)
        r2 = select_diversity_shortlist(candidates)
        assert [c.code for c in r1.entries] == [c.code for c in r2.entries]

    def test_percentile_rank_tie_break_deterministic_for_nan(self):
        ranks = prescreen.percentile_rank([1.0, None, 2.0, None])
        assert ranks[1] == 0.0
        assert ranks[3] == 0.0


# ---------------------------------------------------------------------------
# 14. cache TTL 7/14日 / 15. future timestamp reject / 16. malformed cache reject
# ---------------------------------------------------------------------------


class TestCacheTTLAndValidation:
    def test_fresh_cache_within_target_ttl_is_usable(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_shortlist_cache(valid_cache_payload(now=NOW - timedelta(hours=1)), cache_path)
        loaded = load_shortlist_cache(cache_path, now=NOW)
        assert loaded is not None

    def test_stale_beyond_target_ttl_but_within_hard_expiry_still_usable(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        age = timedelta(hours=SHORTLIST_CACHE_TARGET_TTL_HOURS + 24)
        save_shortlist_cache(valid_cache_payload(now=NOW - age), cache_path)
        loaded = load_shortlist_cache(cache_path, now=NOW)
        assert loaded is not None

    def test_hard_expired_cache_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        age = timedelta(hours=SHORTLIST_CACHE_HARD_EXPIRY_HOURS + 1)
        save_shortlist_cache(valid_cache_payload(now=NOW - age), cache_path)
        loaded = load_shortlist_cache(cache_path, now=NOW)
        assert loaded is None

    def test_future_timestamp_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_shortlist_cache(valid_cache_payload(now=NOW + timedelta(hours=1)), cache_path)
        loaded = load_shortlist_cache(cache_path, now=NOW)
        assert loaded is None

    def test_malformed_cache_wrong_length_item_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        payload = valid_cache_payload()
        payload["items"] = [["1000", "Name"]]  # 長さ不足
        save_shortlist_cache(payload, cache_path)
        assert load_shortlist_cache(cache_path, now=NOW) is None

    def test_malformed_cache_invalid_pool_type_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        payload = valid_cache_payload()
        payload["items"] = [["1000", "Name", "sectorA", "garbage", 0.5]]
        save_shortlist_cache(payload, cache_path)
        assert load_shortlist_cache(cache_path, now=NOW) is None

    def test_malformed_cache_non_finite_score_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        payload = valid_cache_payload()
        payload["items"] = [["1000", "Name", "sectorA", "main", float("nan")]]
        save_shortlist_cache(payload, cache_path)
        assert load_shortlist_cache(cache_path, now=NOW) is None

    def test_missing_schema_kind_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        payload = valid_cache_payload()
        payload["schemaKind"] = "wrong_kind"
        save_shortlist_cache(payload, cache_path)
        assert load_shortlist_cache(cache_path, now=NOW) is None

    def test_corrupt_json_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        cache_path.write_text("{not valid json", encoding="utf-8")
        assert load_shortlist_cache(cache_path, now=NOW) is None

    def test_missing_cache_file_returns_none(self, tmp_path):
        assert load_shortlist_cache(tmp_path / "does_not_exist.json", now=NOW) is None


# ---------------------------------------------------------------------------
# 17. atomic write
# ---------------------------------------------------------------------------


class TestAtomicWrite:
    def test_save_creates_no_leftover_tmp_file(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_shortlist_cache(valid_cache_payload(), cache_path)
        assert cache_path.exists()
        assert not cache_path.with_name(cache_path.name + ".tmp").exists()

    def test_failed_write_preserves_existing_last_good_cache(self, tmp_path, monkeypatch):
        cache_path = tmp_path / "cache.json"
        good_payload = valid_cache_payload()
        save_shortlist_cache(good_payload, cache_path)
        original_bytes = cache_path.read_bytes()

        def boom(*a, **kw):
            raise OSError("disk full simulation")

        monkeypatch.setattr(Path, "replace", boom)
        with pytest.raises(OSError):
            save_shortlist_cache(valid_cache_payload(now=NOW + timedelta(days=1)), cache_path)

        assert cache_path.read_bytes() == original_bytes
        assert not cache_path.with_name(cache_path.name + ".tmp").exists()

    def test_write_uses_tmp_then_replace(self, tmp_path):
        cache_path = tmp_path / "sub" / "cache.json"
        save_shortlist_cache(valid_cache_payload(), cache_path)
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
        assert payload["schemaKind"] == CACHE_SCHEMA_KIND


# ---------------------------------------------------------------------------
# P5-B004c-1-PRESCREEN-HARDENING Phase 1: shortlist quality guard
# ---------------------------------------------------------------------------


def _all_pass_main_floor_fetch_fn(batch):
    return {t: flat_series(300, price=1000, volume=1_000_000) for t in batch}


def _floor_failing_series_fetch_fn(batch):
    # history=10日はmain(>=252日)/newcomer(63-251日)いずれのfloorも満たさない
    return {t: flat_series(10, price=1000, volume=1_000_000) for t in batch}


class TestShortlistQualityGuard:
    # --- 1. entries=[] -> cache非更新 --------------------------------------

    def test_unit_empty_entries_rejected(self):
        assert shortlist_quality_guard_reason(0, None) is not None

    def test_pipeline_all_floors_rejected_entries_empty_no_cache_write(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        universe = make_universe([(f"{20000+i}", f"N{i}", f"sector{i%5}") for i in range(60)])

        result = build_cheap_prescreen_shortlist(
            universe, now=NOW, fetch_fn=_floor_failing_series_fetch_fn,
            pacing_fn=lambda: None, cache_path=cache_path,
        )
        assert not cache_path.exists()
        assert result.fallback_used is True
        assert result.bypass_seed_list_v1 is True  # 有効last-goodなし

    # --- 2. absolute floor未満 -> cache非更新 -------------------------------

    def test_unit_below_absolute_floor_rejected(self):
        assert shortlist_quality_guard_reason(MIN_SHORTLIST_COUNT - 1, None) is not None

    def test_pipeline_below_absolute_floor_does_not_write_cache(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        passing = [(f"21{i:03d}", f"P{i}", f"sector{i%3}") for i in range(10)]
        failing = [(f"22{i:03d}", f"F{i}", f"sector{i%3}") for i in range(15)]
        universe = make_universe(passing + failing)

        def fetch_fn(batch):
            out = {}
            for t in batch:
                code = t[:-2]  # ".T"を除去
                if code.startswith("21"):
                    out[t] = flat_series(300, price=1000, volume=1_000_000)
                else:
                    out[t] = flat_series(10, price=1000, volume=1_000_000)
            return out

        result = build_cheap_prescreen_shortlist(
            universe, now=NOW, fetch_fn=fetch_fn, pacing_fn=lambda: None, cache_path=cache_path,
        )
        assert not cache_path.exists()
        assert result.bypass_seed_list_v1 is True

    # --- 3. previous last-good比50%未満 -> 既存cache維持 ---------------------

    def test_unit_relative_collapse_rejected(self):
        previous = valid_cache_payload(n=120)
        assert shortlist_quality_guard_reason(55, previous) is not None  # 55/120 < 50%

    def test_pipeline_relative_collapse_keeps_existing_cache_unchanged(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_shortlist_cache(valid_cache_payload(now=NOW - timedelta(hours=1), n=120), cache_path)

        universe = make_universe([(f"{23000+i}", f"N{i}", f"sector{i%6}") for i in range(55)])

        build_cheap_prescreen_shortlist(
            universe, now=NOW, fetch_fn=_all_pass_main_floor_fetch_fn,
            pacing_fn=lambda: None, cache_path=cache_path,
        )
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
        assert len(payload["items"]) == 120  # 上書きされていない

    # --- 4. guard失敗+valid cache -> fallback -------------------------------

    def test_pipeline_guard_failure_with_valid_cache_returns_fallback(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        save_shortlist_cache(valid_cache_payload(now=NOW - timedelta(hours=1), n=120), cache_path)

        universe = make_universe([(f"{23500+i}", f"N{i}", f"sector{i%6}") for i in range(55)])

        result = build_cheap_prescreen_shortlist(
            universe, now=NOW, fetch_fn=_all_pass_main_floor_fetch_fn,
            pacing_fn=lambda: None, cache_path=cache_path,
        )
        assert result.fallback_used is True
        assert result.bypass_seed_list_v1 is False
        assert result.shortlist_count == 120

    # --- 5. guard失敗+cacheなし -> seed bypass ------------------------------

    def test_pipeline_guard_failure_with_no_cache_bypasses_to_seed(self, tmp_path):
        cache_path = tmp_path / "no_cache.json"
        universe = make_universe([(f"{24000+i}", f"N{i}", f"sector{i%5}") for i in range(60)])

        result = build_cheap_prescreen_shortlist(
            universe, now=NOW, fetch_fn=_floor_failing_series_fetch_fn,
            pacing_fn=lambda: None, cache_path=cache_path,
        )
        assert result.bypass_seed_list_v1 is True
        assert result.shortlist_id == SEED_BYPASS_ID
        assert not cache_path.exists()

    # --- 6. 正常target相当 -> cache更新 --------------------------------------

    def test_unit_normal_target_scale_accepted(self):
        assert shortlist_quality_guard_reason(TARGET_SHORTLIST_SIZE, None) is None

    def test_pipeline_normal_target_scale_updates_cache(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        universe = make_universe([(f"{25000+i}", f"N{i}", f"sector{i%20}") for i in range(300)])

        result = build_cheap_prescreen_shortlist(
            universe, now=NOW, fetch_fn=_all_pass_main_floor_fetch_fn,
            pacing_fn=lambda: None, cache_path=cache_path,
        )
        assert result.fallback_used is False
        assert cache_path.exists()
        assert result.shortlist_count == TARGET_SHORTLIST_SIZE


# ---------------------------------------------------------------------------
# P5-B004c-1-PRESCREEN-HARDENING Phase 2: sector soft-cap semantics
# ---------------------------------------------------------------------------


class TestSectorCapSoftCap:
    # --- 1. cap非緩和 -> relaxed=false/count=0 ------------------------------

    def test_primary_fill_no_relaxation(self):
        candidates = [main_candidate(f"big{i}", "bigsector", score=1.0 - i * 0.001) for i in range(100)]
        for s in range(8):
            candidates += [
                main_candidate(f"other{s}_{j}", f"sector{s}", score=0.5 - j * 0.001) for j in range(5)
            ]
        selection = select_diversity_shortlist(candidates, target_size=30, hard_max_size=100, sector_cap=5)
        assert selection.sector_cap_relaxed is False
        assert selection.sector_cap_relaxed_count == 0
        assert selection.sector_cap_violations == {}

    # --- 2. backfill緩和 -> relaxed=true/count>0 -----------------------------

    def test_backfill_relaxation_tracked(self):
        candidates = [main_candidate(f"s{i}", "onlysector", score=1.0 - i * 0.001) for i in range(30)]
        selection = select_diversity_shortlist(candidates, target_size=20, hard_max_size=50, sector_cap=5)
        assert selection.sector_cap_relaxed is True
        assert selection.sector_cap_relaxed_count == 15
        assert selection.sector_cap_violations == {"onlysector": 15}

    # --- 3. fallback cacheでもmetadata維持 ------------------------------------

    def test_fallback_cache_preserves_sector_cap_metadata(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        payload = valid_cache_payload(now=NOW - timedelta(hours=1), n=5)
        payload["sector_cap_relaxed"] = True
        payload["sector_cap_relaxed_count"] = 7
        payload["sector_cap_violations"] = {"sectorX": 7}
        save_shortlist_cache(payload, cache_path)

        universe = make_universe([(f"{30000+i}", f"N{i}", "sectorA") for i in range(5)])

        def fetch_fn(batch):
            raise PreScreenRateLimitError("boom")

        result = build_cheap_prescreen_shortlist(
            universe, now=NOW, fetch_fn=fetch_fn, pacing_fn=lambda: None, cache_path=cache_path
        )
        assert result.fallback_used is True
        assert result.sector_cap_relaxed is True
        assert result.sector_cap_relaxed_count == 7
        assert result.sector_cap_violations == {"sectorX": 7}

    # --- 4. malformed metadata reject または安全default ----------------------

    def test_malformed_sector_cap_metadata_rejects_whole_cache(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        payload = valid_cache_payload()
        payload["sector_cap_relaxed"] = "not-a-bool"
        save_shortlist_cache(payload, cache_path)
        assert load_shortlist_cache(cache_path, now=NOW) is None

    def test_missing_sector_cap_metadata_old_schema_gets_safe_defaults(self, tmp_path):
        cache_path = tmp_path / "cache.json"
        payload = valid_cache_payload(now=NOW - timedelta(hours=1), n=5)  # 旧schema: キー自体が無い
        save_shortlist_cache(payload, cache_path)

        universe = make_universe([(f"{31000+i}", f"N{i}", "sectorA") for i in range(5)])

        def fetch_fn(batch):
            raise PreScreenRateLimitError("boom")

        result = build_cheap_prescreen_shortlist(
            universe, now=NOW, fetch_fn=fetch_fn, pacing_fn=lambda: None, cache_path=cache_path
        )
        assert result.fallback_used is True
        assert result.sector_cap_relaxed is False
        assert result.sector_cap_relaxed_count == 0
        assert result.sector_cap_violations == {}

    # --- 5. newcomer<=10維持 --------------------------------------------------

    def test_newcomer_cap_respected_even_when_sector_cap_relaxed(self):
        mains = [main_candidate(f"m{i}", "onlysector", score=1.0 - i * 0.001) for i in range(30)]
        newcomers = [newcomer_candidate(f"n{i}", "newsector", score=0.5, adv=1e7 + i) for i in range(20)]
        selection = select_diversity_shortlist(mains + newcomers, target_size=20, hard_max_size=50, sector_cap=5)
        assert selection.newcomer_count <= NEWCOMER_MAX_COUNT
        assert selection.sector_cap_relaxed is True

    # --- 6. hard max<=300維持 --------------------------------------------------

    def test_hard_max_respected_even_when_sector_cap_relaxed(self):
        candidates = [main_candidate(f"h{i}", "onlysector", score=1.0 - i * 0.001) for i in range(500)]
        selection = select_diversity_shortlist(candidates, target_size=350, hard_max_size=300, sector_cap=5)
        assert len(selection.entries) == 300
        assert selection.sector_cap_relaxed is True


# ---------------------------------------------------------------------------
# 18. seed 41 production不変
# ---------------------------------------------------------------------------


class TestProductionUnaffected:
    def test_seed_list_still_41_items(self):
        assert len(SEED_LIST) == 41

    def test_default_universe_provider_still_seed_list_v1(self):
        result = default_universe_provider()
        assert result.universe_id == "seed_list_v1"
        assert len(result.items) == 41

    def test_module_does_not_import_build_candidates_stocks(self):
        source = inspect.getsource(prescreen)
        import_lines = [ln.strip() for ln in source.splitlines() if ln.strip().startswith(("import ", "from "))]
        assert not any("build_candidates_stocks" in ln for ln in import_lines)

    def test_module_does_not_define_universe_provider_wiring(self):
        assert not hasattr(prescreen, "default_universe_provider")


# ---------------------------------------------------------------------------
# 19. holdings/trust/cash/account 非参照
# ---------------------------------------------------------------------------


class TestPrivacyNonReference:
    def test_source_file_has_no_forbidden_terms(self):
        import re

        source = inspect.getsource(prescreen).lower()
        for key in FORBIDDEN_KEYS:
            pattern = r"\b" + re.escape(key.lower()) + r"\b"
            assert not re.search(pattern, source), f"forbidden term {key!r} found in module source"

    def test_result_namedtuple_fields_have_no_forbidden_keys(self):
        fields = set(prescreen.CheapPreScreenResult._fields) | set(ShortlistItem._fields)
        assert not (fields & FORBIDDEN_KEYS)

    def test_cache_payload_has_no_forbidden_keys(self, tmp_path):
        # MIN_SHORTLIST_COUNT(50)の絶対floorを上回るuniverseにする。
        cache_path = tmp_path / "cache.json"
        universe = make_universe([(f"{9500+i}", f"N{i}", f"sector{i%5}") for i in range(60)])

        def fetch_fn(batch):
            return {t: flat_series(300, price=1000, volume=1_000_000) for t in batch}

        build_cheap_prescreen_shortlist(
            universe, now=NOW, fetch_fn=fetch_fn, pacing_fn=lambda: None, cache_path=cache_path
        )
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
        assert not (set(payload.keys()) & FORBIDDEN_KEYS)

    def test_cache_path_is_under_internal_jpx_cache_dir(self):
        assert ".jpx_cache" in prescreen.CACHE_PATH.parts
        assert "public" not in prescreen.CACHE_PATH.parts
