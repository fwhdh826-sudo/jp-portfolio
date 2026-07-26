"""P5-B005-B2: data.candidate_funnel_privacy_smoke のテスト。

exact-key検査（substring一致ではない）・recursive forbidden key検査・
not_for_trading検査・data/public byte一致検査をfail-closedで確認する。
"""
from __future__ import annotations

import copy
import json

import data.candidate_funnel_batch as batch
import data.candidate_funnel_privacy_smoke as smoke


def _valid_payload():
    stripped_candidates, prescreen_entries = _calibration_split()
    cs_payload = {
        "schemaVersion": "candidates-stocks-1",
        "updatedAt": "2026-07-25T00:00:00+00:00",
        "sourceUpdatedAt": "2026-07-25T00:00:00+00:00",
        "staleThresholdHours": 48,
        "_meta": {"pipelinePath": "normal", "universeProvenance": {"shortlistFallbackUsed": False}},
        "candidates": stripped_candidates,
        "missing": [],
        "status": "ok",
    }
    prescreen_payload = {
        "schemaVersion": "prescreen-metadata-1", "generatedAt": "2026-07-25T00:00:00+00:00",
        "not_for_trading": True, "shortlistId": "jpx_cheap_prescreen_v1", "pipelinePath": "normal",
        "duplicateCodes": [], "entries": prescreen_entries,
    }
    index, dup = batch.build_prescreen_index(prescreen_payload)
    assert dup == []
    joined, join_stats = batch.join_candidates_with_prescreen(stripped_candidates, index)
    from datetime import datetime, timezone

    context = batch.build_context(cs_payload, "bull_calm", datetime(2026, 7, 26, 10, 0, 0, tzinfo=timezone.utc))
    engine_result = batch.build_candidate_funnel(joined, context)
    quality_report = batch.compute_quality_report(
        candidates_stocks_payload=cs_payload, joined_candidates=joined, join_stats=join_stats,
        prescreen_duplicate_codes=dup, engine_result=engine_result, context=context, previous_artifact=None,
    )
    return batch.build_artifact_payload(
        engine_result=engine_result, join_stats=join_stats, context=context,
        quality_report=quality_report, now=datetime(2026, 7, 26, 10, 0, 0, tzinfo=timezone.utc),
    )


def _calibration_split():
    from pathlib import Path

    path = Path(__file__).resolve().parent / "fixtures" / "candidate_funnel_calibration_v1.json"
    with path.open(encoding="utf-8") as f:
        candidates = copy.deepcopy(json.load(f)["candidates"])
    stripped = []
    entries = []
    for c in candidates:
        score = c.pop("prescreenScore", None)
        rank = c.pop("prescreenRank", None)
        stripped.append(c)
        if score is not None:
            entries.append({"code": c["code"], "prescreenScore": score, "prescreenRank": rank, "prescreenPool": None})
    return stripped, entries


def test_valid_payload_has_no_violations():
    payload = _valid_payload()
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert violations == []


def test_unexpected_root_key_detected():
    payload = _valid_payload()
    payload["extraTopLevelKey"] = 1
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("unexpected root keys" in v for v in violations)


def test_forbidden_key_in_candidate_detected():
    payload = _valid_payload()
    payload["candidates"][0]["portfolio"] = {"cash": 1000}
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("portfolio" in v for v in violations)


def test_forbidden_key_deeply_nested_detected():
    payload = _valid_payload()
    payload["_meta"]["join"]["nested"] = {"holdings": [1, 2, 3]}
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("holdings" in v for v in violations)


def test_substring_match_does_not_false_positive():
    """値の文字列に禁止語を含むだけでは誤検出しない（exact-key検査）。"""
    payload = _valid_payload()
    payload["candidates"][0]["name"] = "My Portfolio Holdings Cash Co."
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert violations == []


def test_not_for_trading_false_detected():
    payload = _valid_payload()
    payload["not_for_trading"] = False
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("not_for_trading" in v for v in violations)


def test_meta_not_for_trading_false_detected():
    payload = _valid_payload()
    payload["_meta"]["not_for_trading"] = False
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("_meta.not_for_trading" in v for v in violations)


def test_invalid_tier_detected():
    payload = _valid_payload()
    payload["candidates"][0]["tier"] = "BUY_NEW"
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("invalid tier" in v for v in violations)


def test_invalid_schema_version_detected():
    payload = _valid_payload()
    payload["schemaVersion"] = "wrong-version"
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("schemaVersion" in v for v in violations)


def test_non_dict_payload_reported():
    violations = smoke.check_candidate_funnel_payload(["not", "a", "dict"], "test")
    assert violations == ["test: payload is not a dict"]


def test_data_public_byte_mismatch_detected(tmp_path):
    payload = _valid_payload()
    data_path = tmp_path / "data" / "candidate_funnel.json"
    public_path = tmp_path / "public" / "candidate_funnel.json"
    data_path.parent.mkdir(parents=True)
    public_path.parent.mkdir(parents=True)
    data_path.write_text(json.dumps(payload), encoding="utf-8")
    tampered = copy.deepcopy(payload)
    tampered["counts"]["total"] = 999999
    public_path.write_text(json.dumps(tampered), encoding="utf-8")

    violations = smoke.check_candidate_funnel_files((str(data_path), str(public_path)))
    assert any("not byte-identical" in v for v in violations)


def test_data_public_byte_equal_passes(tmp_path):
    payload = _valid_payload()
    data_path = tmp_path / "data" / "candidate_funnel.json"
    public_path = tmp_path / "public" / "candidate_funnel.json"
    data_path.parent.mkdir(parents=True)
    public_path.parent.mkdir(parents=True)
    text = json.dumps(payload)
    data_path.write_text(text, encoding="utf-8")
    public_path.write_text(text, encoding="utf-8")

    violations = smoke.check_candidate_funnel_files((str(data_path), str(public_path)))
    assert violations == []


def test_malformed_json_file_reported(tmp_path):
    p = tmp_path / "candidate_funnel.json"
    p.write_text("{not valid json", encoding="utf-8")
    violations = smoke.check_candidate_funnel_files((str(p),))
    assert any("failed to parse" in v for v in violations)


def test_all_paths_missing_is_not_a_violation(tmp_path):
    """candidate_funnel_batchがまだ一度もpublishしていない状態
    （導入直後・join率不足でgate FAILが続いている等）は「不正publish」ではなく
    「まだpublishされていない」であり、commit直前の最終防衛線としては
    violationにしない。"""
    p = tmp_path / "does_not_exist.json"
    violations = smoke.check_candidate_funnel_files((str(p),))
    assert violations == []


def test_partial_missing_paths_is_a_violation(tmp_path):
    """data/publicの一方だけ存在する状態は、atomic publish_artifact()の
    ペア保証が破られていることを意味するため常にviolationとする。"""
    payload = _valid_payload()
    present = tmp_path / "a.json"
    present.write_text(json.dumps(payload), encoding="utf-8")
    missing = tmp_path / "does_not_exist.json"
    violations = smoke.check_candidate_funnel_files((str(present), str(missing)))
    assert any("partial publish detected" in v for v in violations)


def test_main_exits_nonzero_on_violation(tmp_path, capsys):
    p1 = tmp_path / "a.json"
    p1.write_text("{}", encoding="utf-8")
    rc = smoke.main(["--paths", str(p1)])
    assert rc == 1


def test_main_exits_zero_on_valid_payload(tmp_path):
    payload = _valid_payload()
    p1 = tmp_path / "a.json"
    p2 = tmp_path / "b.json"
    text = json.dumps(payload)
    p1.write_text(text, encoding="utf-8")
    p2.write_text(text, encoding="utf-8")
    rc = smoke.main(["--paths", str(p1), str(p2)])
    assert rc == 0
