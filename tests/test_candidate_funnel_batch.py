"""P5-B005-B2: candidate funnel batch / join / artifact / production-distribution
quality gate のテスト。

data.candidate_funnel_batch は data/candidates_stocks.json + data/prescreen_metadata.json
を code join し、data.candidate_funnel_engine.build_candidate_funnel() （frozen、
このテストでは一切変更しない）を呼び出して data/candidate_funnel.json /
public/data/candidate_funnel.json を生成する。

このテストファイルはjoin/artifact/P-01..P-15 gateを検証する。閾値は
A2-S §22.2/§25.20 のリテラル値をテスト側にも直接書く（production定数の
import一致検査ではなく、独立した期待値として固定する）。
"""
from __future__ import annotations

import copy
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

import data.candidate_funnel_batch as batch


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

NOW = datetime(2026, 7, 26, 10, 0, 0, tzinfo=timezone.utc)


def _candidate(code, sector="SecA", per=10.0, pbr=1.0, roe=10.0, div=2.0, sigma=0.2, mom=5.0, status="ok"):
    return {
        "code": code, "name": f"n{code}", "sector": sector, "price": 1000.0,
        "per": per, "pbr": pbr, "roe": roe, "dividendYield": div,
        "sigma252d": sigma, "mom3m": mom, "dataStatus": status,
    }


def _candidates_stocks_payload(
    candidates,
    *,
    pipeline_path="normal",
    stale_threshold_hours=48,
    source_updated_at="2026-07-25T00:00:00+00:00",
    shortlist_fallback_used=False,
    include_meta_pipeline_path=True,
):
    meta = {"universeProvenance": {"shortlistFallbackUsed": shortlist_fallback_used}}
    if include_meta_pipeline_path:
        meta["pipelinePath"] = pipeline_path
    return {
        "schemaVersion": "candidates-stocks-1",
        "updatedAt": source_updated_at,
        "sourceUpdatedAt": source_updated_at,
        "staleThresholdHours": stale_threshold_hours,
        "_meta": meta,
        "candidates": candidates,
        "missing": [],
        "status": "ok",
    }


def _prescreen_entry(code, score=0.5, rank=1, pool="main"):
    return {"code": code, "prescreenScore": score, "prescreenRank": rank, "prescreenPool": pool}


def _prescreen_payload(entries, pipeline_path="normal", duplicate_codes=None):
    return {
        "schemaVersion": "prescreen-metadata-1",
        "generatedAt": "2026-07-25T00:00:00+00:00",
        "not_for_trading": True,
        "shortlistId": "jpx_cheap_prescreen_v1",
        "pipelinePath": pipeline_path,
        "duplicateCodes": duplicate_codes or [],
        "entries": entries,
    }


def _write_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _load_calibration_fixture():
    path = Path(__file__).resolve().parent / "fixtures" / "candidate_funnel_calibration_v1.json"
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def _calibration_split():
    """B1 calibration fixtureをB2向けに分解する: candidates_stocks側
    （prescreenScore/prescreenRankを持たない生candidate）と、それを
    再現するprescreen entries。B1 fixtureは変更しない（読むだけ）。"""
    candidates = copy.deepcopy(_load_calibration_fixture()["candidates"])
    stripped = []
    entries = []
    for c in candidates:
        score = c.pop("prescreenScore", None)
        rank = c.pop("prescreenRank", None)
        stripped.append(c)
        if score is not None:
            entries.append({"code": c["code"], "prescreenScore": score, "prescreenRank": rank, "prescreenPool": None})
    return stripped, entries


# ===========================================================================
# Join tests
# ===========================================================================


def test_join_complete_all_candidates_matched():
    candidates = [_candidate("1001"), _candidate("1002"), _candidate("1003")]
    index, dup = batch.build_prescreen_index(_prescreen_payload([
        _prescreen_entry("1001", 0.9, 1), _prescreen_entry("1002", 0.5, 2), _prescreen_entry("1003", 0.1, 3),
    ]))
    assert dup == []
    joined, stats = batch.join_candidates_with_prescreen(candidates, index)
    assert stats["joinRate"] == 1.0
    assert stats["unmatchedCandidateCount"] == 0
    for c in joined:
        assert c["prescreenScore"] is not None
        assert c["prescreenRank"] is not None


def test_join_partial_some_candidates_unmatched():
    candidates = [_candidate("1001"), _candidate("1002"), _candidate("1003")]
    index, _dup = batch.build_prescreen_index(_prescreen_payload([_prescreen_entry("1001", 0.9, 1)]))
    joined, stats = batch.join_candidates_with_prescreen(candidates, index)
    assert stats["joinedCount"] == 1
    assert stats["unmatchedCandidateCount"] == 2
    joined_by_code = {c["code"]: c for c in joined}
    assert "prescreenScore" in joined_by_code["1001"]
    assert "prescreenScore" not in joined_by_code["1002"]
    assert "prescreenScore" not in joined_by_code["1003"]


def test_join_threshold_boundary_exactly_095_passes():
    candidates = [_candidate(f"{i:04d}") for i in range(200)]
    entries = [_prescreen_entry(f"{i:04d}", score=0.5, rank=i + 1) for i in range(190)]  # 190/200 = 0.95
    index, _dup = batch.build_prescreen_index(_prescreen_payload(entries))
    _joined, stats = batch.join_candidates_with_prescreen(candidates, index)
    assert stats["joinRate"] == pytest.approx(0.95)
    assert stats["joinRate"] >= 0.95


def test_join_below_threshold_fails():
    candidates = [_candidate(f"{i:04d}") for i in range(200)]
    entries = [_prescreen_entry(f"{i:04d}", score=0.5, rank=i + 1) for i in range(189)]  # 189/200 = 0.945
    index, _dup = batch.build_prescreen_index(_prescreen_payload(entries))
    _joined, stats = batch.join_candidates_with_prescreen(candidates, index)
    assert stats["joinRate"] < 0.95


def test_join_candidate_side_duplicate_code_passed_through_to_engine():
    """candidate側duplicateはjoin側でdedupeしない — 両方に等しくjoinし、
    engine（B1 frozen）へそのまま渡す。engineが自律的にHARD_CONTRACT_VIOLATION
    + DUPLICATE_CANDIDATE_CODEで除外する。"""
    candidates = [_candidate("9999"), _candidate("9999"), _candidate("1000")]
    index, _dup = batch.build_prescreen_index(_prescreen_payload([
        _prescreen_entry("9999", 0.9, 1), _prescreen_entry("1000", 0.5, 2),
    ]))
    joined, stats = batch.join_candidates_with_prescreen(candidates, index)
    assert stats["joinedCount"] == 3  # 両方の9999 + 1000
    assert joined[0]["prescreenScore"] == 0.9
    assert joined[1]["prescreenScore"] == 0.9
    result = batch.build_candidate_funnel(joined, {"pipelinePath": "normal"})
    dup_candidates = [c for c in result["candidates"] if c["code"] == "9999"]
    assert len(dup_candidates) == 2
    for c in dup_candidates:
        assert c["tier"] == "excluded"
        assert "HARD_CONTRACT_VIOLATION" in c["hardExclusionReasons"]


def test_join_prescreen_side_duplicate_excluded_from_index_and_fails_gate():
    payload = _prescreen_payload([
        _prescreen_entry("2000", 0.9, 1), _prescreen_entry("2000", 0.1, 2), _prescreen_entry("3000", 0.5, 3),
    ])
    index, dup = batch.build_prescreen_index(payload)
    assert dup == ["2000"]
    assert "2000" not in index  # 重複codeはdedupe/先勝ち/後勝ちせず一切joinしない
    assert "3000" in index

    candidates = [_candidate("2000"), _candidate("3000")]
    joined, _stats = batch.join_candidates_with_prescreen(candidates, index)
    joined_by_code = {c["code"]: c for c in joined}
    assert "prescreenScore" not in joined_by_code["2000"]
    assert joined_by_code["3000"]["prescreenScore"] == 0.5


def test_join_numeric_string_code_collision_no_coercion():
    """codeは文字列identityとして扱う。数値codeがprescreen entryに
    紛れ込んでいても、str()変換等のcoercionでcandidate側の文字列codeと
    一致させてはならない。"""
    payload = _prescreen_payload([{"code": 7777, "prescreenScore": 0.9, "prescreenRank": 1, "prescreenPool": "main"}])
    index, _dup = batch.build_prescreen_index(payload)
    assert index == {}  # int codeは文字列でないため一切indexへ入らない

    candidates = [_candidate("7777")]
    joined, stats = batch.join_candidates_with_prescreen(candidates, index)
    assert stats["joinedCount"] == 0
    assert "prescreenScore" not in joined[0]


def test_join_unmatched_candidate_gets_no_prescreen_keys():
    candidates = [_candidate("5000")]
    index = {}
    joined, stats = batch.join_candidates_with_prescreen(candidates, index)
    assert stats["unmatchedCandidateCount"] == 1
    assert "prescreenScore" not in joined[0]
    assert "prescreenRank" not in joined[0]
    assert "prescreenPool" not in joined[0]


def test_join_unmatched_prescreen_recorded_not_erroring():
    candidates = [_candidate("6000")]
    payload = _prescreen_payload([_prescreen_entry("6000", 0.9, 1), _prescreen_entry("6001", 0.5, 2)])
    index, _dup = batch.build_prescreen_index(payload)
    _joined, stats = batch.join_candidates_with_prescreen(candidates, index)
    assert stats["unmatchedPrescreenCount"] == 1


def test_join_input_order_invariance():
    candidates = [_candidate("A1"), _candidate("A2"), _candidate("A3")]
    payload = _prescreen_payload([_prescreen_entry("A1", 0.1, 3), _prescreen_entry("A2", 0.5, 2), _prescreen_entry("A3", 0.9, 1)])
    index, _dup = batch.build_prescreen_index(payload)

    joined_forward, stats_forward = batch.join_candidates_with_prescreen(candidates, index)
    joined_reversed, stats_reversed = batch.join_candidates_with_prescreen(list(reversed(candidates)), index)

    by_code_forward = {c["code"]: (c.get("prescreenScore"), c.get("prescreenRank")) for c in joined_forward}
    by_code_reversed = {c["code"]: (c.get("prescreenScore"), c.get("prescreenRank")) for c in joined_reversed}
    assert by_code_forward == by_code_reversed
    assert stats_forward["joinRate"] == stats_reversed["joinRate"]


def test_join_fallback_path_missing_prescreen_metadata_file(tmp_path):
    index, dup = batch.build_prescreen_index(None)
    assert index == {}
    assert dup == []
    candidates = [_candidate("7000")]
    joined, stats = batch.join_candidates_with_prescreen(candidates, index)
    assert stats["joinRate"] == 0.0
    assert "prescreenScore" not in joined[0]


def test_join_reproduces_b1_engine_output_for_calibration_fixture():
    """B2のjoinがB1 fixtureの直接投入と同一のengine結果を再現することを
    確認する（joinがscoreの値そのものを変えていないことのintegration test）。"""
    original_candidates = _load_calibration_fixture()["candidates"]
    stripped_candidates, prescreen_entries = _calibration_split()

    direct_result = batch.build_candidate_funnel(copy.deepcopy(original_candidates), {"pipelinePath": "normal"})

    index, dup = batch.build_prescreen_index(_prescreen_payload(prescreen_entries))
    assert dup == []
    joined, _stats = batch.join_candidates_with_prescreen(stripped_candidates, index)
    joined_result = batch.build_candidate_funnel(joined, {"pipelinePath": "normal"})

    assert direct_result == joined_result


# ===========================================================================
# Context contract
# ===========================================================================


def test_context_pipeline_path_not_coerced_to_normal_when_missing():
    payload = _candidates_stocks_payload([], include_meta_pipeline_path=False)
    ctx = batch.build_context(payload, None, NOW)
    assert ctx["pipelinePath"] is None  # "normal"へのsilent coercion禁止


def test_context_echoes_stale_threshold_and_source_updated_at():
    payload = _candidates_stocks_payload([], stale_threshold_hours=72, source_updated_at="2026-01-01T00:00:00+00:00")
    ctx = batch.build_context(payload, "bull_calm", NOW)
    assert ctx["staleThresholdHours"] == 72
    assert ctx["sourceUpdatedAt"] == "2026-01-01T00:00:00+00:00"
    assert ctx["regime"] == "bull_calm"
    assert ctx["asOf"] == NOW.isoformat()


def test_context_prescreen_fallback_used_reflects_provenance():
    payload = _candidates_stocks_payload([], shortlist_fallback_used=True)
    ctx = batch.build_context(payload, None, NOW)
    assert ctx["prescreenFallbackUsed"] is True


def test_read_current_regime_missing_file_returns_none(tmp_path):
    assert batch.read_current_regime(tmp_path / "does_not_exist.json") is None


def test_read_current_regime_unknown_value_returns_none(tmp_path):
    p = tmp_path / "regime_state.json"
    _write_json(p, {"regime_state": {"current_regime": "not_a_real_regime"}})
    assert batch.read_current_regime(p) is None


def test_read_current_regime_valid_value(tmp_path):
    p = tmp_path / "regime_state.json"
    _write_json(p, {"regime_state": {"current_regime": "bear"}})
    assert batch.read_current_regime(p) == "bear"


# ===========================================================================
# Artifact tests
# ===========================================================================

_EXPECTED_CANDIDATE_KEYS = {
    "code", "name", "sector", "prescreenScore", "prescreenRank", "prescreenPool",
    "scoreBreakdown", "rawCompositeScore", "dataConfidence", "marketScore",
    "marketRank", "tier", "selectedReasons", "riskReasons", "hardExclusionReasons",
    "themes", "themeStatus", "dataStatus",
}
_EXPECTED_ROOT_KEYS = {
    "schemaVersion", "funnelVersion", "scoreVersion", "not_for_trading", "status",
    "degradationReasons", "counts", "candidates", "excludedSummary",
    "sectorDistribution", "scoreDistribution", "selectionObservability", "_meta",
}


def _run_calibration_batch(tmp_path):
    stripped_candidates, prescreen_entries = _calibration_split()
    cs_payload = _candidates_stocks_payload(stripped_candidates)
    cs_path = tmp_path / "candidates_stocks.json"
    _write_json(cs_path, cs_payload)
    prescreen_path = tmp_path / "prescreen_metadata.json"
    _write_json(prescreen_path, _prescreen_payload(prescreen_entries))
    regime_path = tmp_path / "regime_state.json"
    _write_json(regime_path, {"regime_state": {"current_regime": "bull_calm"}})
    return batch.run_batch(
        candidates_stocks_path=cs_path,
        prescreen_metadata_path=prescreen_path,
        regime_state_path=regime_path,
        previous_artifact_path=tmp_path / "candidate_funnel.json",
        now=NOW,
    )


def test_artifact_exact_root_shape(tmp_path):
    artifact, report = _run_calibration_batch(tmp_path)
    assert report["qualityGate"]["overallPass"] is True
    assert artifact is not None
    assert set(artifact.keys()) == _EXPECTED_ROOT_KEYS


def test_artifact_exact_candidate_shape(tmp_path):
    artifact, _report = _run_calibration_batch(tmp_path)
    assert len(artifact["candidates"]) > 0
    for c in artifact["candidates"]:
        assert set(c.keys()) == _EXPECTED_CANDIDATE_KEYS


def test_artifact_not_for_trading_true():
    engine_result = batch.build_candidate_funnel([], {"pipelinePath": "seed_fallback"})
    artifact = batch.build_artifact_payload(
        engine_result=engine_result, join_stats={"candidateCount": 0}, context={"asOf": NOW.isoformat()},
        quality_report={"gates": [], "overallPass": True}, now=NOW,
    )
    assert artifact["not_for_trading"] is True
    assert artifact["status"] == "not_generated"


def test_artifact_atomic_write_no_tmp_file_left(tmp_path):
    artifact, _report = _run_calibration_batch(tmp_path)
    data_path = tmp_path / "out" / "candidate_funnel.json"
    public_path = tmp_path / "public_out" / "candidate_funnel.json"
    batch.publish_artifact(artifact, data_path=data_path, public_path=public_path)
    assert data_path.exists()
    assert public_path.exists()
    assert not data_path.with_name(data_path.name + ".tmp").exists()
    assert not public_path.with_name(public_path.name + ".tmp").exists()


def test_artifact_data_public_byte_equality(tmp_path):
    artifact, _report = _run_calibration_batch(tmp_path)
    data_path = tmp_path / "out" / "candidate_funnel.json"
    public_path = tmp_path / "public_out" / "candidate_funnel.json"
    batch.publish_artifact(artifact, data_path=data_path, public_path=public_path)
    assert data_path.read_bytes() == public_path.read_bytes()


def test_artifact_deterministic_repeat(tmp_path):
    artifact1, _r1 = _run_calibration_batch(tmp_path)
    artifact2, _r2 = _run_calibration_batch(tmp_path)
    assert artifact1 == artifact2


def test_no_publish_on_gate_failure_leaves_existing_artifact_untouched(tmp_path):
    data_path = tmp_path / "candidate_funnel.json"
    public_path = tmp_path / "candidate_funnel_public.json"
    data_path.write_text('{"sentinel": true}', encoding="utf-8")
    public_path.write_text('{"sentinel": true}', encoding="utf-8")

    # join率0（prescreen不在）で必ずgate失敗するcandidates_stocks
    cs_path = tmp_path / "candidates_stocks.json"
    _write_json(cs_path, _candidates_stocks_payload([_candidate("1")]))
    artifact, report = batch.run_batch(
        candidates_stocks_path=cs_path,
        prescreen_metadata_path=tmp_path / "does_not_exist.json",
        regime_state_path=tmp_path / "does_not_exist_regime.json",
        previous_artifact_path=data_path,
        now=NOW,
    )
    assert artifact is None
    assert report["qualityGate"]["overallPass"] is False
    # 呼び出し元（main相当）はartifact is Noneのためpublish_artifactを呼ばない。
    assert data_path.read_text(encoding="utf-8") == '{"sentinel": true}'
    assert public_path.read_text(encoding="utf-8") == '{"sentinel": true}'


def test_malformed_json_candidates_stocks_raises_fail_closed(tmp_path):
    cs_path = tmp_path / "candidates_stocks.json"
    cs_path.write_text("{not valid json", encoding="utf-8")
    with pytest.raises(batch.CandidateFunnelBatchError):
        batch.load_candidates_stocks(cs_path)


def test_malformed_json_prescreen_metadata_raises_fail_closed(tmp_path):
    p = tmp_path / "prescreen_metadata.json"
    p.write_text("{not valid json", encoding="utf-8")
    with pytest.raises(batch.CandidateFunnelBatchError):
        batch.load_prescreen_metadata(p)


# ===========================================================================
# P-01..P-15 quality gate tests
# ===========================================================================


def _build_report_for(candidates_stocks_candidates, prescreen_entries, context_overrides=None, previous_artifact=None):
    cs_payload = _candidates_stocks_payload(candidates_stocks_candidates)
    index, dup = batch.build_prescreen_index(_prescreen_payload(prescreen_entries))
    joined, join_stats = batch.join_candidates_with_prescreen(candidates_stocks_candidates, index)
    context = batch.build_context(cs_payload, None, NOW)
    if context_overrides:
        context.update(context_overrides)
    engine_result = batch.build_candidate_funnel(joined, context)
    report = batch.compute_quality_report(
        candidates_stocks_payload=cs_payload,
        joined_candidates=joined,
        join_stats=join_stats,
        prescreen_duplicate_codes=dup,
        engine_result=engine_result,
        context=context,
        previous_artifact=previous_artifact,
    )
    return report, engine_result


def _gate(report, gate_id):
    return next(g for g in report["gates"] if g["id"] == gate_id)


def test_p02_join_rate_exact_boundary_pass():
    candidates = [_candidate(f"{i:04d}") for i in range(200)]
    entries = [_prescreen_entry(f"{i:04d}") for i in range(190)]
    report, _ = _build_report_for(candidates, entries)
    assert _gate(report, "P-02")["status"] == "PASS"


def test_p02_join_rate_just_below_fails():
    candidates = [_candidate(f"{i:04d}") for i in range(200)]
    entries = [_prescreen_entry(f"{i:04d}") for i in range(189)]
    report, _ = _build_report_for(candidates, entries)
    assert _gate(report, "P-02")["status"] == "FAIL"


def test_p04_no_duplicate_passes():
    candidates = [_candidate("1"), _candidate("2")]
    report, _ = _build_report_for(candidates, [])
    assert _gate(report, "P-04")["status"] == "PASS"


def test_p04_candidate_duplicate_fails():
    candidates = [_candidate("1"), _candidate("1"), _candidate("2")]
    report, _ = _build_report_for(candidates, [])
    assert _gate(report, "P-04")["status"] == "FAIL"


def test_prescreen_duplicate_gate_fails_when_prescreen_has_duplicate_code():
    candidates = [_candidate("1"), _candidate("2")]
    entries = [_prescreen_entry("1", 0.9, 1), _prescreen_entry("1", 0.1, 2)]
    report, _ = _build_report_for(candidates, entries)
    assert _gate(report, "PRESCREEN_DUPLICATE")["status"] == "FAIL"


def test_p07_iqr_and_range_pass_with_calibration_fixture(tmp_path):
    _artifact, report = _run_calibration_batch(tmp_path)
    gate = _gate(report["qualityGate"], "P-07")
    assert gate["status"] == "PASS"
    assert gate["value"]["iqr"] >= 10.0
    assert gate["value"]["range"] >= 40.0


def test_p07_degenerate_population_fails():
    # 全候補が同一のper/pbr/roe/dividendYield/sigma/mom -> marketScoreが縮退
    candidates = [_candidate(f"{i:04d}", per=10.0, pbr=1.0, roe=10.0, div=2.0, sigma=0.2, mom=5.0) for i in range(20)]
    entries = [_prescreen_entry(f"{i:04d}", score=0.5, rank=i + 1) for i in range(20)]
    report, _ = _build_report_for(candidates, entries)
    gate = _gate(report, "P-07")
    assert gate["status"] == "FAIL"


def test_p08_deep_review_zero_fails():
    # 極端に低いscoreのみ -> deep_review到達候補ゼロ
    candidates = [_candidate(f"{i:04d}", per=1000.0, pbr=100.0, roe=-90.0, div=0.0, sigma=0.6, mom=-90.0) for i in range(20)]
    entries = [_prescreen_entry(f"{i:04d}", score=0.01, rank=i + 1) for i in range(20)]
    report, _ = _build_report_for(candidates, entries)
    assert _gate(report, "P-08")["status"] == "FAIL"


def test_p08_deep_review_positive_passes_with_calibration_fixture(tmp_path):
    _artifact, report = _run_calibration_batch(tmp_path)
    assert _gate(report["qualityGate"], "P-08")["status"] == "PASS"


def test_p10_sector_breadth_fails_with_single_sector():
    candidates = [_candidate(f"{i:04d}", sector="OnlySector", per=3.0, pbr=0.3, roe=40.0, div=6.0, sigma=0.1, mom=30.0) for i in range(30)]
    entries = [_prescreen_entry(f"{i:04d}", score=0.9, rank=i + 1) for i in range(30)]
    report, _ = _build_report_for(candidates, entries)
    assert _gate(report, "P-10")["status"] == "FAIL"


def test_p10_sector_breadth_passes_with_calibration_fixture(tmp_path):
    _artifact, report = _run_calibration_batch(tmp_path)
    gate = _gate(report["qualityGate"], "P-10")
    assert gate["status"] == "PASS"
    assert gate["value"]["deepReview"] >= 7
    assert gate["value"]["actionable"] >= 4


def test_p12_inactive_v1_soft_reasons_are_zero_and_gate_passes(tmp_path):
    _artifact, report = _run_calibration_batch(tmp_path)
    gate = _gate(report["qualityGate"], "P-12")
    assert gate["status"] == "PASS"
    for code in batch.INACTIVE_V1_SOFT_REASONS:
        assert gate["value"]["soft"][code] == 0


def test_p13_degraded_path_actionable_zero_structurally_via_engine():
    """engineのfrozen仕様（pipeline_path=='normal'以外はactionable不可）
    により、degraded path（cache_fallback）ではactionable==0が構造的に
    保証される。P-13はこの不変条件を検出する。"""
    candidates = [_candidate(f"{i:04d}", per=3.0, pbr=0.3, roe=40.0, div=6.0, sigma=0.1, mom=30.0, status="ok") for i in range(20)]
    entries = [_prescreen_entry(f"{i:04d}", score=0.9, rank=i + 1) for i in range(20)]
    report, engine_result = _build_report_for(candidates, entries, context_overrides={"pipelinePath": "cache_fallback"})
    assert engine_result["counts"]["actionable"] == 0
    assert _gate(report, "P-13")["status"] == "PASS"


def test_p13_detects_violation_via_direct_gate_call():
    """compute_quality_reportのP-13ロジック自体が、万一engineがdegraded pathで
    actionable>0を返す regression を起こした場合に検出できることを、
    手組みのengine_resultで直接確認する（engine自体は変更しない）。"""
    fake_engine_result = {
        "status": "generated",
        "counts": {"deepReview": 1, "actionable": 3},
        "candidates": [],
        "sectorDistribution": {"deepReview": {"a": 1}, "actionable": {"a": 1}},
        "selectionObservability": {"sourceStale": False, "deepReviewSectorCapOverflow": {}, "actionableSectorCapOverflow": {}, "deepReviewEligibleCount": 1, "deepReviewSelectedCount": 1, "actionableEligibleCount": 3, "actionableSelectedCount": 3},
        "degradationReasons": [],
    }
    report = batch.compute_quality_report(
        candidates_stocks_payload={"candidates": []},
        joined_candidates=[],
        join_stats={"candidateCount": 0, "joinedCount": 0, "unmatchedCandidateCount": 0, "unmatchedPrescreenCount": 0, "joinRate": 0.0, "unmatchedCandidateRate": 0.0},
        prescreen_duplicate_codes=[],
        engine_result=fake_engine_result,
        context={"pipelinePath": "cache_fallback", "prescreenFallbackUsed": False},
        previous_artifact=None,
    )
    assert _gate(report, "P-13")["status"] == "FAIL"


def test_p14_rank_stability_passes_with_calibration_fixture(tmp_path):
    _artifact, report = _run_calibration_batch(tmp_path)
    gate = _gate(report["qualityGate"], "P-14")
    assert gate["status"] == "PASS"
    assert gate["value"] >= 0.95


def test_p15_no_baseline_records_none(tmp_path):
    _artifact, report = _run_calibration_batch(tmp_path)
    gate = _gate(report["qualityGate"], "P-15")
    assert gate["status"] == "RECORD"
    assert gate["value"] is None


def test_p15_rank_drift_vs_previous_recorded(tmp_path):
    stripped_candidates, prescreen_entries = _calibration_split()
    cs_payload = _candidates_stocks_payload(stripped_candidates)
    cs_path = tmp_path / "candidates_stocks.json"
    _write_json(cs_path, cs_payload)
    prescreen_path = tmp_path / "prescreen_metadata.json"
    _write_json(prescreen_path, _prescreen_payload(prescreen_entries))
    regime_path = tmp_path / "regime_state.json"
    _write_json(regime_path, {"regime_state": {"current_regime": "bull_calm"}})
    previous_path = tmp_path / "candidate_funnel.json"

    artifact1, _report1 = batch.run_batch(
        candidates_stocks_path=cs_path, prescreen_metadata_path=prescreen_path,
        regime_state_path=regime_path, previous_artifact_path=previous_path, now=NOW,
    )
    assert artifact1 is not None
    previous_path.write_text(json.dumps(artifact1), encoding="utf-8")

    artifact2, report2 = batch.run_batch(
        candidates_stocks_path=cs_path, prescreen_metadata_path=prescreen_path,
        regime_state_path=regime_path, previous_artifact_path=previous_path, now=NOW,
    )
    # engineの決定的計算結果（candidates/counts等）は前回artifactの有無に
    # 依存せず同一。_meta.qualityGate.gates（P-15）だけがbaseline有無で変わる。
    assert artifact2["candidates"] == artifact1["candidates"]
    assert artifact2["counts"] == artifact1["counts"]
    gate = _gate(report2["qualityGate"], "P-15")
    assert gate["value"] == 1.0  # 同一artifact同士なのでdrift無し


def test_not_generated_status_skips_p02_through_p15():
    candidates = [_candidate("1")]
    cs_payload = _candidates_stocks_payload(candidates, pipeline_path="seed_fallback")
    index, dup = batch.build_prescreen_index(None)
    joined, join_stats = batch.join_candidates_with_prescreen(candidates, index)
    context = batch.build_context(cs_payload, None, NOW)
    engine_result = batch.build_candidate_funnel(joined, context)
    assert engine_result["status"] == "not_generated"
    report = batch.compute_quality_report(
        candidates_stocks_payload=cs_payload, joined_candidates=joined, join_stats=join_stats,
        prescreen_duplicate_codes=dup, engine_result=engine_result, context=context, previous_artifact=None,
    )
    assert report["overallPass"] is True
    for gate_id in ["P-02", "P-07", "P-10", "P-14"]:
        assert _gate(report, gate_id)["status"] == "N/A"
