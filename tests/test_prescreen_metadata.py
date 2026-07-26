"""P5-B005-B2: prescreen metadataの永続化（data/prescreen_metadata.json）の
テスト。

data.build_candidates_stocks.whole_market_universe_provider() が
CheapPreScreenResult.entries（score/pool_type）を UniverseResultWithProvenance
へ引き継ぎ、build_prescreen_metadata_payload()/write_prescreen_metadata()が
それをcode joinの唯一の永続化先へ書き出すことを確認する。

このmoduleはprescreen scoreの計算を一切行わない（既存の
jpx_cheap_prescreen.build_cheap_prescreen_shortlist()が算出した値を
そのまま引き継ぐだけ）。re-fetch/再計算が発生しないことも確認する。
"""
from __future__ import annotations

import json

from data.build_candidates_stocks import (
    PRESCREEN_METADATA_SCHEMA_VERSION,
    UniverseResult,
    UniverseResultWithProvenance,
    build_prescreen_metadata_payload,
    whole_market_universe_provider,
    write_prescreen_metadata,
)
from data.jpx_cheap_prescreen import (
    HARD_MAX_SHORTLIST_SIZE,
    TARGET_SHORTLIST_SIZE,
    CheapPreScreenResult,
    ShortlistItem,
)
from data.jpx_universe_provider import JPXUniverseResult

NOW = "2026-07-26T00:00:00+00:00"


def _fake_jpx(eligible_count=1552):
    return JPXUniverseResult(
        universe_id="jpx_prime_domestic_v1",
        items=[(str(i), f"N{i}", "sec") for i in range(eligible_count)],
        source="jpx_data_j_xls", source_identifier="jpx_data_j_xls",
        fetched_at=NOW, source_as_of="2026-07-25", row_count=4437,
        eligible_count=eligible_count, segment_counts={}, filters_applied=[],
        fallback_used=False, cache_age_hours=0.0, dropped_rows=[],
    )


def _fake_prescreen_with_entries(shortlist_count=3, fallback_used=False, fallback_reason=None):
    entries = [
        ShortlistItem(code=str(1000 + i), name=f"N{i}", sector=f"Sec{i % 2}", pool_type="main" if i < 2 else "newcomer", score=0.9 - i * 0.1)
        for i in range(shortlist_count)
    ]
    items = [(e.code, e.name, e.sector) for e in entries]
    return CheapPreScreenResult(
        shortlist_id="jpx_cheap_prescreen_v1", items=items, entries=entries, generated_at=NOW,
        universe_count=1552, main_pool_count=2, newcomer_pool_count=1, shortlist_count=shortlist_count,
        target_shortlist=TARGET_SHORTLIST_SIZE, hard_max_shortlist=HARD_MAX_SHORTLIST_SIZE, success_ratio=1.0,
        fetch_aborted=False, abort_reason=None, fallback_used=fallback_used, fallback_reason=fallback_reason,
        cache_age_hours=0.0, bypass_seed_list_v1=False, sector_cap_relaxed=False, sector_cap_relaxed_count=0,
        sector_cap_violations={},
    )


def _fake_prescreen_bypass():
    return CheapPreScreenResult(
        shortlist_id="seed_list_v1_bypass", items=[], entries=[], generated_at=NOW,
        universe_count=0, main_pool_count=0, newcomer_pool_count=0, shortlist_count=0,
        target_shortlist=TARGET_SHORTLIST_SIZE, hard_max_shortlist=HARD_MAX_SHORTLIST_SIZE, success_ratio=0.0,
        fetch_aborted=False, abort_reason=None, fallback_used=True, fallback_reason="no_valid_cache",
        cache_age_hours=None, bypass_seed_list_v1=True, sector_cap_relaxed=False, sector_cap_relaxed_count=0,
        sector_cap_violations={},
    )


def test_default_prescreen_entries_is_empty_tuple():
    """UniverseResultWithProvenanceは既存呼び出し（prescreenEntries省略）と
    後方互換であること。"""
    r = UniverseResultWithProvenance(universe_id="x", items=[], provenance={})
    assert r.prescreenEntries == ()


def test_whole_market_provider_carries_prescreen_entries_through_normal_path():
    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: _fake_jpx(),
        build_shortlist_fn=lambda u, now=None: _fake_prescreen_with_entries(3),
    )
    assert result.prescreenEntries == (
        ("1000", "N0", "Sec0", "main", 0.9),
        ("1001", "N1", "Sec1", "main", 0.8),
        ("1002", "N2", "Sec0", "newcomer", 0.7),
    )


def test_whole_market_provider_prescreen_entries_empty_on_seed_bypass():
    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: _fake_jpx(),
        build_shortlist_fn=lambda u, now=None: _fake_prescreen_bypass(),
    )
    assert result.universe_id == "seed_list_v1"
    assert result.prescreenEntries == ()


def test_whole_market_provider_prescreen_entries_empty_when_jpx_itself_seed_fallback():
    """jpx_universe自体がseed_list_v1へ縮退した場合、build_shortlist_fnは
    一切呼ばれずprescreenEntriesは既定の()のまま。"""
    called = {"n": 0}

    def spy_build_shortlist(u, now=None):
        called["n"] += 1
        return _fake_prescreen_with_entries(3)

    seed_jpx = JPXUniverseResult(
        universe_id="seed_list_v1", items=[(str(i), f"N{i}", "sec") for i in range(41)],
        source="seed_list_v1_fallback", source_identifier="seed_list_v1_fallback",
        fetched_at=NOW, source_as_of="2026-07-25", row_count=0,
        eligible_count=41, segment_counts={}, filters_applied=[],
        fallback_used=True, cache_age_hours=None, dropped_rows=[],
    )
    result = whole_market_universe_provider(
        get_universe_fn=lambda now=None: seed_jpx,
        build_shortlist_fn=spy_build_shortlist,
    )
    assert called["n"] == 0
    assert result.prescreenEntries == ()


def test_build_prescreen_metadata_payload_ranks_by_existing_sort_order():
    """entriesは既にjpx_cheap_prescreen.select_diversity_shortlistのscore
    降順・code昇順ソート済みのため、re-sortせずその1-indexed位置をrankとする。"""
    provider_result = UniverseResultWithProvenance(
        universe_id="jpx_cheap_prescreen_v1",
        items=[("1000", "N0", "Sec0"), ("1001", "N1", "Sec1")],
        provenance={"shortlistId": "jpx_cheap_prescreen_v1", "pipelinePath": "normal"},
        prescreenEntries=(("1000", "N0", "Sec0", "main", 0.9), ("1001", "N1", "Sec1", "newcomer", 0.5)),
    )
    from datetime import datetime, timezone

    payload = build_prescreen_metadata_payload(provider_result, datetime(2026, 7, 26, tzinfo=timezone.utc))
    assert payload["schemaVersion"] == PRESCREEN_METADATA_SCHEMA_VERSION
    assert payload["shortlistId"] == "jpx_cheap_prescreen_v1"
    assert payload["pipelinePath"] == "normal"
    assert payload["duplicateCodes"] == []
    assert payload["entries"] == [
        {"code": "1000", "prescreenScore": 0.9, "prescreenRank": 1, "prescreenPool": "main"},
        {"code": "1001", "prescreenScore": 0.5, "prescreenRank": 2, "prescreenPool": "newcomer"},
    ]


def test_build_prescreen_metadata_payload_detects_duplicate_codes():
    provider_result = UniverseResultWithProvenance(
        universe_id="jpx_cheap_prescreen_v1", items=[], provenance={},
        prescreenEntries=(("A", "n", "s", "main", 0.9), ("A", "n", "s", "main", 0.1)),
    )
    from datetime import datetime, timezone

    payload = build_prescreen_metadata_payload(provider_result, datetime(2026, 7, 26, tzinfo=timezone.utc))
    assert payload["duplicateCodes"] == ["A"]


def test_build_prescreen_metadata_payload_handles_bare_universe_result():
    """default_universe_provider()（SEED_LIST）が返す素のUniverseResultにも
    getattrで安全に対応する（属性が無ければ空扱い）。"""
    from datetime import datetime, timezone

    bare = UniverseResult(universe_id="seed_list_v1", items=[("1", "n", "s")])
    payload = build_prescreen_metadata_payload(bare, datetime(2026, 7, 26, tzinfo=timezone.utc))
    assert payload["entries"] == []
    assert payload["duplicateCodes"] == []
    assert payload["shortlistId"] is None
    assert payload["pipelinePath"] is None


def test_write_prescreen_metadata_writes_valid_json(tmp_path):
    provider_result = UniverseResultWithProvenance(
        universe_id="jpx_cheap_prescreen_v1", items=[("1000", "N0", "Sec0")],
        provenance={"shortlistId": "jpx_cheap_prescreen_v1", "pipelinePath": "normal"},
        prescreenEntries=(("1000", "N0", "Sec0", "main", 0.9),),
    )
    from datetime import datetime, timezone

    out_path = tmp_path / "prescreen_metadata.json"
    write_prescreen_metadata(provider_result, datetime(2026, 7, 26, tzinfo=timezone.utc), path=out_path)
    loaded = json.loads(out_path.read_text(encoding="utf-8"))
    assert loaded["entries"][0]["code"] == "1000"
    assert loaded["not_for_trading"] is True
