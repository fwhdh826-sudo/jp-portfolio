"""
P5-B004d: whole_market_universe_provider() の回帰テスト。

JPXUniverseResult → CheapPreScreenResult → UniverseResultWithProvenance
（既存candidates_stocksパイプラインへのwhole-market production接続）が
以下16観点を満たすことを機械的に検証する:

  1. normal JPX→shortlist→enrichmentの正常経路
  2. 1552直接enrichment禁止（pre-screenを経ずに巨大universeがenrichmentへ
     渡ればenforce_enrichment_guardがfail-fastすることの確認）
  3. target shortlist<=200
  4. hard max<=300
  5. enrichment guard<=500（300<500の安全マージン構造）
  6. JPX live failure→cache（fallback_used=Trueだがcacheから復元された
     有効なJPX universeは通常通りpre-screenされる）
  7. shortlist rate-limit→last-good（fallback_used=True・非bypass・
     itemsありのcheap prescreen結果がそのまま採用される）
  8. success ratio<70%→fallback
  9. quality guard failure→fallback
  10. no valid cache→seed41（bypass_seed_list_v1=Trueで41 seedへ）
  11. provenance metadata（_meta.universeProvenanceの内容）
  12. schemaVersion不変
  13. privacy smoke pass
  14. forbidden keyならfail（既存FORBIDDEN_KEYSとの整合）
  15. held exclusionはbatch側に導入しない
  16. officialDecision/UI無変更は別途git diffで確認（Phase 6 verification参照）
"""
import inspect

import pytest

from data.build_candidates_stocks import (
    MAX_ENRICHMENT_UNIVERSE,
    SCHEMA_VERSION,
    UniverseResult,
    build_candidates_stocks,
    default_universe_provider,
    enforce_enrichment_guard,
    whole_market_universe_provider,
)
from data.candidates_stocks_privacy_smoke import check_candidates_stocks_payload
from data.jpx_cheap_prescreen import (
    HARD_MAX_SHORTLIST_SIZE,
    TARGET_SHORTLIST_SIZE,
    CheapPreScreenResult,
)
from data.jpx_universe_provider import JPXUniverseResult

NOW = "2026-07-15T00:00:00+00:00"


def _fake_jpx(
    fallback_used=False,
    eligible_count=1552,
    source="jpx_data_j_xls",
    items=None,
):
    n = eligible_count if items is None else len(items)
    return JPXUniverseResult(
        universe_id="jpx_prime_domestic_v1",
        items=items if items is not None else [(str(i), f"N{i}", "sec") for i in range(n)],
        source=source,
        source_identifier=source,
        fetched_at=NOW,
        source_as_of="2026-07-14",
        row_count=4437,
        eligible_count=eligible_count,
        segment_counts={},
        filters_applied=[],
        fallback_used=fallback_used,
        cache_age_hours=0.0 if not fallback_used else 1.5,
        dropped_rows=[],
    )


def _fake_prescreen_success(shortlist_count=200, sector_cap_relaxed=False):
    items = [(str(i), f"N{i}", "sec") for i in range(shortlist_count)]
    return CheapPreScreenResult(
        shortlist_id="jpx_cheap_prescreen_v1",
        items=items,
        entries=[],
        generated_at=NOW,
        universe_count=1552,
        main_pool_count=max(0, shortlist_count - 10),
        newcomer_pool_count=min(10, shortlist_count),
        shortlist_count=shortlist_count,
        target_shortlist=TARGET_SHORTLIST_SIZE,
        hard_max_shortlist=HARD_MAX_SHORTLIST_SIZE,
        success_ratio=1.0,
        fetch_aborted=False,
        abort_reason=None,
        fallback_used=False,
        fallback_reason=None,
        cache_age_hours=0.0,
        bypass_seed_list_v1=False,
        sector_cap_relaxed=sector_cap_relaxed,
        sector_cap_relaxed_count=3 if sector_cap_relaxed else 0,
        sector_cap_violations={"情報通信": 5} if sector_cap_relaxed else {},
    )


def _fake_prescreen_cache_fallback(reason, shortlist_count=180):
    """rate-limit/success_ratio<70%/quality guard失敗のいずれでも、有効な
    last-good cacheがある場合の共通の戻り値形状。"""
    items = [(str(i), f"N{i}", "sec") for i in range(shortlist_count)]
    return CheapPreScreenResult(
        shortlist_id="jpx_cheap_prescreen_v1",
        items=items,
        entries=[],
        generated_at=NOW,
        universe_count=1552,
        main_pool_count=shortlist_count - 5,
        newcomer_pool_count=5,
        shortlist_count=shortlist_count,
        target_shortlist=TARGET_SHORTLIST_SIZE,
        hard_max_shortlist=HARD_MAX_SHORTLIST_SIZE,
        success_ratio=0.5,
        fetch_aborted="rate_limit" in reason,
        abort_reason=reason if "rate_limit" in reason else None,
        fallback_used=True,
        fallback_reason=reason,
        cache_age_hours=12.0,
        bypass_seed_list_v1=False,
        sector_cap_relaxed=False,
        sector_cap_relaxed_count=0,
        sector_cap_violations={},
    )


def _fake_prescreen_bypass(reason):
    return CheapPreScreenResult(
        shortlist_id="seed_list_v1_bypass",
        items=[],
        entries=[],
        generated_at=NOW,
        universe_count=0,
        main_pool_count=0,
        newcomer_pool_count=0,
        shortlist_count=0,
        target_shortlist=TARGET_SHORTLIST_SIZE,
        hard_max_shortlist=HARD_MAX_SHORTLIST_SIZE,
        success_ratio=0.0,
        fetch_aborted="rate_limit" in reason,
        abort_reason=reason if "rate_limit" in reason else None,
        fallback_used=True,
        fallback_reason=reason,
        cache_age_hours=None,
        bypass_seed_list_v1=True,
        sector_cap_relaxed=False,
        sector_cap_relaxed_count=0,
        sector_cap_violations={},
    )


def _fake_fetch_ok(code, name, sector):
    return {
        "code": code, "name": name, "sector": sector,
        "price": 1000.0, "per": 12.0, "pbr": 1.2, "roe": 11.0,
        "dividendYield": 2.0, "sigma252d": 0.2, "mom3m": 1.5,
        "screenReasons": [], "dataStatus": "ok",
    }


# --- 1. normal JPX→shortlist→enrichment --------------------------------------


def test_normal_success_path_flows_to_enrichment():
    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: _fake_jpx(),
        build_shortlist_fn=lambda u, now=None: _fake_prescreen_success(200),
    )
    assert result.universe_id == "jpx_cheap_prescreen_v1"
    assert len(result.items) == 200

    payload = build_candidates_stocks(
        universe_provider=lambda: result, fetch_fn=_fake_fetch_ok
    )
    assert len(payload["candidates"]) == 200
    assert payload["status"] == "ok"
    assert payload["_meta"]["universe"] == "jpx_cheap_prescreen_v1"
    assert payload["_meta"]["pipelineContract"] == "jpx_whole_market_candidates_v1"
    assert payload["_meta"]["pipelinePath"] == "normal"


# --- 2. 1552直接enrichment禁止 -------------------------------------------------


def test_whole_market_provider_never_skips_prescreen():
    """build_shortlist_fnが必ず呼ばれること（pre-screenを経ずにJPX universeが
    直接返されることはない）。"""
    called = {"n": 0}

    def spy_build_shortlist(u, now=None):
        called["n"] += 1
        return _fake_prescreen_success(200)

    whole_market_universe_provider(
        get_universe_fn=lambda now=None: _fake_jpx(eligible_count=1552),
        build_shortlist_fn=spy_build_shortlist,
    )
    assert called["n"] == 1


def test_raw_1552_universe_without_prescreen_trips_enrichment_guard():
    """(架空の壊れたprovider) pre-screenを経ずに1552件のuniverseを直接
    enrichmentへ渡そうとすればenforce_enrichment_guardがfail-fastすることを
    確認する——whole-market全1552件のdetail enrichment禁止の構造的裏付け。"""
    with pytest.raises(Exception):
        enforce_enrichment_guard([(str(i), f"N{i}", "s") for i in range(1552)])


# --- 3/4. target<=200 / hard max<=300 ----------------------------------------


def test_target_and_hard_max_constants():
    assert TARGET_SHORTLIST_SIZE == 200
    assert HARD_MAX_SHORTLIST_SIZE == 300


def test_success_path_item_count_bounded_by_hard_max():
    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: _fake_jpx(),
        build_shortlist_fn=lambda u, now=None: _fake_prescreen_success(HARD_MAX_SHORTLIST_SIZE),
    )
    assert len(result.items) == HARD_MAX_SHORTLIST_SIZE


# --- 5. enrichment guard<=500 -------------------------------------------------


def test_enrichment_guard_constant_unchanged():
    assert MAX_ENRICHMENT_UNIVERSE == 500


def test_hard_max_shortlist_always_below_enrichment_guard():
    # 構造的な安全マージン: pre-screenのhard maxが常にenrichment guardを
    # 下回るため、正常経路でenforce_enrichment_guardが発火することはない。
    assert HARD_MAX_SHORTLIST_SIZE < MAX_ENRICHMENT_UNIVERSE


# --- 6. JPX live failure→cache -------------------------------------------------


def test_jpx_cache_fallback_with_valid_sized_universe_still_prescreened():
    """JPX liveが失敗しcacheへfallbackした場合でも、cache由来のuniverseが
    十分な件数を持つ限り、通常通りpre-screenが実行される。"""
    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: _fake_jpx(fallback_used=True, eligible_count=1500),
        build_shortlist_fn=lambda u, now=None: _fake_prescreen_success(200),
    )
    assert result.universe_id == "jpx_cheap_prescreen_v1"
    assert len(result.items) == 200
    assert result.provenance["jpxFallbackUsed"] is True
    assert result.provenance["pipelinePath"] == "cache_fallback"


# --- 7. shortlist rate-limit→last-good ----------------------------------------


def test_prescreen_rate_limit_uses_last_good_cache():
    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: _fake_jpx(),
        build_shortlist_fn=lambda u, now=None: _fake_prescreen_cache_fallback(
            "rate_limit_abort: yfinance rate limit", shortlist_count=180
        ),
    )
    assert result.universe_id == "jpx_cheap_prescreen_v1"
    assert len(result.items) == 180
    assert result.provenance["shortlistFallbackUsed"] is True
    assert "rate_limit" in result.provenance["shortlistFallbackReason"]
    assert result.provenance["pipelinePath"] == "cache_fallback"


# --- 8. success ratio<70%→fallback --------------------------------------------


def test_low_success_ratio_uses_last_good_cache_when_available():
    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: _fake_jpx(),
        build_shortlist_fn=lambda u, now=None: _fake_prescreen_cache_fallback(
            "success_ratio 0.5000 below floor 0.7", shortlist_count=150
        ),
    )
    assert len(result.items) == 150
    assert "success_ratio" in result.provenance["shortlistFallbackReason"]


def test_low_success_ratio_bypasses_to_seed_when_no_cache():
    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: _fake_jpx(),
        build_shortlist_fn=lambda u, now=None: _fake_prescreen_bypass(
            "success_ratio 0.0000 below floor 0.7"
        ),
    )
    assert result.universe_id == "seed_list_v1"
    assert len(result.items) == 41


# --- 9. quality guard failure→fallback ----------------------------------------


def test_quality_guard_failure_uses_last_good_cache_when_available():
    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: _fake_jpx(),
        build_shortlist_fn=lambda u, now=None: _fake_prescreen_cache_fallback(
            "shortlist_quality_guard: entries count 30 below absolute floor",
            shortlist_count=190,
        ),
    )
    assert len(result.items) == 190
    assert "shortlist_quality_guard" in result.provenance["shortlistFallbackReason"]


def test_quality_guard_failure_bypasses_to_seed_when_no_cache():
    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: _fake_jpx(),
        build_shortlist_fn=lambda u, now=None: _fake_prescreen_bypass(
            "shortlist_quality_guard: entries collapsed to empty (0 entries)"
        ),
    )
    assert result.universe_id == "seed_list_v1"
    assert len(result.items) == 41


# --- 10. no valid cache→seed41 ------------------------------------------------


def test_no_valid_cache_bypasses_to_seed_41():
    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: _fake_jpx(),
        build_shortlist_fn=lambda u, now=None: _fake_prescreen_bypass("rate_limit_abort: x"),
    )
    assert result.universe_id == default_universe_provider().universe_id == "seed_list_v1"
    assert result.items == default_universe_provider().items
    assert len(result.items) == 41
    assert result.provenance["pipelinePath"] == "seed_fallback"


def test_unexpected_exception_bypasses_to_seed_41():
    def raising_get_universe(now=None):
        raise RuntimeError("network exploded")

    result = whole_market_universe_provider(
        get_universe_fn=raising_get_universe,
        build_shortlist_fn=lambda u, now=None: _fake_prescreen_success(200),
    )
    assert result.universe_id == "seed_list_v1"
    assert len(result.items) == 41
    assert result.provenance["shortlistBypassSeedListV1"] is True
    assert result.provenance["pipelinePath"] == "seed_fallback"


def test_jpx_provider_seed_fallback_skips_prescreen():
    """JPX live/cacheとも利用不能でproviderがseedを返した場合は、quality
    floor未満と分かっている41件へbulk pre-screenを実行しない。"""
    seed_result = _fake_jpx(
        fallback_used=True,
        eligible_count=41,
        source="data/build_candidates_stocks.py::SEED_LIST",
        items=default_universe_provider().items,
    )._replace(universe_id="seed_list_v1")

    def must_not_run(*args, **kwargs):
        raise AssertionError("pre-screen must not run for JPX seed fallback")

    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: seed_result,
        build_shortlist_fn=must_not_run,
    )
    assert result.universe_id == "seed_list_v1"
    assert len(result.items) == 41
    assert result.provenance["pipelinePath"] == "seed_fallback"
    assert result.provenance["shortlistBypassSeedListV1"] is True


# --- 11. provenance metadata ---------------------------------------------------


def test_provenance_contains_required_keys_on_success():
    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: _fake_jpx(),
        build_shortlist_fn=lambda u, now=None: _fake_prescreen_success(200, sector_cap_relaxed=True),
    )
    expected_keys = {
        "jpxSource", "jpxFallbackUsed", "jpxEligibleCount",
        "shortlistId", "shortlistCount", "shortlistSuccessRatio",
        "shortlistFallbackUsed", "shortlistFallbackReason",
        "shortlistBypassSeedListV1", "sectorCapRelaxed", "sectorCapRelaxedCount",
    }
    assert expected_keys <= set(result.provenance.keys())
    assert result.provenance["sectorCapRelaxed"] is True
    assert result.provenance["sectorCapRelaxedCount"] == 3


def test_provenance_propagates_into_meta_json():
    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: _fake_jpx(),
        build_shortlist_fn=lambda u, now=None: _fake_prescreen_success(50),
    )
    payload = build_candidates_stocks(
        universe_provider=lambda: result, fetch_fn=_fake_fetch_ok
    )
    assert "universeProvenance" in payload["_meta"]
    assert payload["_meta"]["universeProvenance"]["shortlistCount"] == 50


def test_default_provider_payload_has_no_universe_provenance():
    payload = build_candidates_stocks(fetch_fn=_fake_fetch_ok)
    assert "universeProvenance" not in payload["_meta"]


# --- 12. schemaVersion不変 -----------------------------------------------------


def test_schema_version_unchanged_with_whole_market_provider():
    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: _fake_jpx(),
        build_shortlist_fn=lambda u, now=None: _fake_prescreen_success(200),
    )
    payload = build_candidates_stocks(
        universe_provider=lambda: result, fetch_fn=_fake_fetch_ok
    )
    assert payload["schemaVersion"] == SCHEMA_VERSION == "candidates-stocks-1"


# --- 13. privacy smoke pass ----------------------------------------------------


def test_whole_market_payload_passes_privacy_smoke():
    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: _fake_jpx(),
        build_shortlist_fn=lambda u, now=None: _fake_prescreen_success(200),
    )
    payload = build_candidates_stocks(
        universe_provider=lambda: result, fetch_fn=_fake_fetch_ok
    )
    violations = check_candidates_stocks_payload(payload, "data/candidates_stocks.json")
    assert violations == []


def test_seed_fallback_payload_passes_privacy_smoke():
    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: _fake_jpx(),
        build_shortlist_fn=lambda u, now=None: _fake_prescreen_bypass("no valid cache"),
    )
    payload = build_candidates_stocks(
        universe_provider=lambda: result, fetch_fn=_fake_fetch_ok
    )
    violations = check_candidates_stocks_payload(payload, "data/candidates_stocks.json")
    assert violations == []


# --- 14. forbidden keyならfail -------------------------------------------------


def test_whole_market_candidate_items_never_contain_forbidden_keys():
    from data.candidates_stocks_privacy_smoke import FORBIDDEN_KEYS

    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: _fake_jpx(),
        build_shortlist_fn=lambda u, now=None: _fake_prescreen_success(30),
    )
    payload = build_candidates_stocks(
        universe_provider=lambda: result, fetch_fn=_fake_fetch_ok
    )
    for c in payload["candidates"]:
        assert not (FORBIDDEN_KEYS & set(c.keys()))


# --- 15. held exclusionはbatch側に導入しない ----------------------------------


def test_whole_market_provider_has_no_holdings_parameter():
    sig = inspect.signature(whole_market_universe_provider)
    assert "holdings" not in sig.parameters
    assert "held" not in sig.parameters


def test_whole_market_provider_source_has_no_holdings_reference():
    import data.build_candidates_stocks as module

    src = inspect.getsource(module.whole_market_universe_provider)
    for forbidden_term in ("holdings", "trust_master", "cash_balance", "account_type"):
        assert forbidden_term not in src.lower()
