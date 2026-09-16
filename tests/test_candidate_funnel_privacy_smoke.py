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
    for index, c in enumerate(candidates):
        score = c.pop("prescreenScore", None)
        rank = c.pop("prescreenRank", None)
        stripped.append(c)
        if score is not None:
            entries.append({"code": c["code"], "prescreenScore": score, "prescreenRank": index + 1, "prescreenPool": None})
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


def test_all_paths_missing_is_a_violation_by_default(tmp_path):
    """P5-B005-B2-R1: defaultはfail-closed。data/public両方不在は
    「今回のrunでartifactがpublishされなかった」ことを意味し、これは
    workflow上のcommit直前の最終防衛線としてはFAILにしなければならない
    （batch側のhard gate FAILが `|| true` で握り潰され、artifact不在のまま
    このsmokeがexit 0を返してcommit stepへ到達していた旧fail-open経路の
    再発防止）。"""
    p = tmp_path / "does_not_exist.json"
    violations = smoke.check_candidate_funnel_files((str(p),))
    assert any("all candidate_funnel.json paths missing" in v for v in violations)


def test_all_paths_missing_allowed_with_explicit_flag(tmp_path):
    """--allow-missing相当（allow_missing=True）はローカルの導入前検査専用の
    明示的opt-inであり、missing-bothをviolationにしない。"""
    p = tmp_path / "does_not_exist.json"
    violations = smoke.check_candidate_funnel_files((str(p),), allow_missing=True)
    assert violations == []


def test_main_exits_nonzero_on_missing_both_without_flag(tmp_path):
    p = tmp_path / "does_not_exist.json"
    rc = smoke.main(["--paths", str(p)])
    assert rc == 1


def test_main_exits_zero_on_missing_both_with_allow_missing_flag(tmp_path):
    p = tmp_path / "does_not_exist.json"
    rc = smoke.main(["--paths", str(p), "--allow-missing"])
    assert rc == 0


def test_partial_missing_paths_is_a_violation(tmp_path):
    """data/publicの一方だけ存在する状態は、atomic publish_artifact()の
    ペア保証が破られていることを意味するため常にviolationとする。"""
    payload = _valid_payload()
    present = tmp_path / "a.json"
    present.write_text(json.dumps(payload), encoding="utf-8")
    missing = tmp_path / "does_not_exist.json"
    violations = smoke.check_candidate_funnel_files((str(present), str(missing)))
    assert any("partial publish detected" in v for v in violations)


def test_partial_missing_paths_is_a_violation_even_with_allow_missing(tmp_path):
    """--allow-missingはmissing-bothのみのopt-outであり、partial pair(片方だけ
    存在)違反はallow_missing=Trueでも常にviolationのままとする。"""
    payload = _valid_payload()
    present = tmp_path / "a.json"
    present.write_text(json.dumps(payload), encoding="utf-8")
    missing = tmp_path / "does_not_exist.json"
    violations = smoke.check_candidate_funnel_files((str(present), str(missing)), allow_missing=True)
    assert any("partial publish detected" in v for v in violations)


def test_invalid_generated_at_detected():
    payload = _valid_payload()
    payload["_meta"]["generatedAt"] = "not-a-timestamp"
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("_meta.generatedAt is not a valid timestamp" in v for v in violations)


def test_quality_gate_overall_pass_false_detected():
    payload = _valid_payload()
    payload["_meta"]["qualityGate"]["overallPass"] = False
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("_meta.qualityGate.overallPass is not True" in v for v in violations)


def test_quality_gate_nonempty_hard_fail_ids_detected():
    payload = _valid_payload()
    payload["_meta"]["qualityGate"]["hardFailIds"] = ["P-02"]
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("_meta.qualityGate.hardFailIds is not empty" in v for v in violations)


def test_quality_gate_missing_p_ids_detected():
    """P-01..P-15のいずれかがqualityGate.gatesに存在しない場合、今回のrunで
    そのgateが実際に評価されたことを保証できないためviolationとする。"""
    payload = _valid_payload()
    payload["_meta"]["qualityGate"]["gates"] = [
        g for g in payload["_meta"]["qualityGate"]["gates"] if g.get("id") != "P-14"
    ]
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("missing required ids" in v and "P-14" in v for v in violations)


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


# ---------------------------------------------------------------------------
# FCA-1-P1-01 (R2): qualityGate aggregate / gate-level status parity
# producer authority = data/candidate_funnel_batch.py compute_quality_report._gate:
#   hardFailIds == [g.id for g in gates if g.status == "FAIL"]（gate順）
#   overallPass == (len(FAIL_GATE_IDS) == 0)
# ---------------------------------------------------------------------------

def _gate_by_id(payload, gate_id):
    for g in payload["_meta"]["qualityGate"]["gates"]:
        if g["id"] == gate_id:
            return g
    raise AssertionError(f"gate {gate_id} missing from fixture")


def _write_twin(tmp_path, payload):
    data_path = tmp_path / "data" / "candidate_funnel.json"
    public_path = tmp_path / "public" / "candidate_funnel.json"
    data_path.parent.mkdir(parents=True)
    public_path.parent.mkdir(parents=True)
    text = json.dumps(payload)
    data_path.write_text(text, encoding="utf-8")
    public_path.write_text(text, encoding="utf-8")
    return (str(data_path), str(public_path))


def test_fca1_p1_01_producer_aggregate_matches_gate_statuses_in_fixture():
    """fixture 自体が producer parity を満たしている（テストの前提確認）。"""
    payload = _valid_payload()
    qg = payload["_meta"]["qualityGate"]
    assert qg["hardFailIds"] == [g["id"] for g in qg["gates"] if g["status"] == "FAIL"]
    assert qg["overallPass"] is (len(qg["hardFailIds"]) == 0)


def test_fca1_p1_01_case_a_gate_fail_with_green_aggregates_is_violation():
    """A. gate FAIL + overallPass=True + hardFailIds=[] => 矛盾として reject。"""
    payload = _valid_payload()
    _gate_by_id(payload, "P-02")["status"] = "FAIL"
    assert payload["_meta"]["qualityGate"]["overallPass"] is True
    assert payload["_meta"]["qualityGate"]["hardFailIds"] == []
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("does not equal FAIL gate ids ['P-02']" in v for v in violations)
    assert any("overallPass True contradicts gate-level statuses" in v for v in violations)


def test_fca1_p1_01_case_a_p14_fail_with_green_aggregates_is_violation():
    """A'. P-14 FAIL は hard。aggregate が green でも通さない。"""
    payload = _valid_payload()
    _gate_by_id(payload, "P-14")["status"] = "FAIL"
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("FAIL gate ids ['P-14']" in v for v in violations)


def test_fca1_p1_01_case_b_fail_gate_absent_from_hard_fail_ids_is_violation():
    """B. 複数 FAIL のうち一部だけ hardFailIds に載っている => 欠落として reject。"""
    payload = _valid_payload()
    _gate_by_id(payload, "P-02")["status"] = "FAIL"
    _gate_by_id(payload, "P-08")["status"] = "FAIL"
    payload["_meta"]["qualityGate"]["overallPass"] = False
    payload["_meta"]["qualityGate"]["hardFailIds"] = ["P-02"]
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("hardFailIds ['P-02'] does not equal FAIL gate ids ['P-02', 'P-08']" in v for v in violations)


def test_fca1_p1_01_case_b_wrong_order_is_violation():
    """B'. producer は gate 順で append する。順序違いは producer が emit し得ない。"""
    payload = _valid_payload()
    _gate_by_id(payload, "P-02")["status"] = "FAIL"
    _gate_by_id(payload, "P-08")["status"] = "FAIL"
    payload["_meta"]["qualityGate"]["overallPass"] = False
    payload["_meta"]["qualityGate"]["hardFailIds"] = ["P-08", "P-02"]
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("does not equal FAIL gate ids ['P-02', 'P-08']" in v for v in violations)


def test_fca1_p1_01_case_b_duplicate_id_is_violation():
    """B''. 同一 id の重複は producer が emit し得ない。"""
    payload = _valid_payload()
    _gate_by_id(payload, "P-02")["status"] = "FAIL"
    payload["_meta"]["qualityGate"]["overallPass"] = False
    payload["_meta"]["qualityGate"]["hardFailIds"] = ["P-02", "P-02"]
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("does not equal FAIL gate ids ['P-02']" in v for v in violations)


def test_fca1_p1_01_case_c_hard_fail_ids_naming_pass_gate_is_violation():
    """C. hardFailIds が PASS gate を指す => 矛盾。"""
    payload = _valid_payload()
    assert _gate_by_id(payload, "P-02")["status"] == "PASS"
    payload["_meta"]["qualityGate"]["hardFailIds"] = ["P-02"]
    payload["_meta"]["qualityGate"]["overallPass"] = False
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("hardFailIds ['P-02'] does not equal FAIL gate ids []" in v for v in violations)
    assert any("overallPass False contradicts gate-level statuses" in v for v in violations)


def test_fca1_p1_01_case_c_hard_fail_ids_naming_warn_gate_is_violation():
    """C'. WARN は non-hard。hardFailIds が WARN gate を指すのは矛盾。"""
    payload = _valid_payload()
    _gate_by_id(payload, "P-14")["status"] = "WARN"
    payload["_meta"]["qualityGate"]["hardFailIds"] = ["P-14"]
    payload["_meta"]["qualityGate"]["overallPass"] = False
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("hardFailIds ['P-14'] does not equal FAIL gate ids []" in v for v in violations)


def test_fca1_p1_01_overall_pass_false_without_fail_gate_is_violation():
    """overallPass=False で FAIL gate が無い（generated path では producer が
    emit し得ない）=> 矛盾。not_generated path はそもそも publish されないため
    smoke 上は同様に reject で正しい。"""
    payload = _valid_payload()
    payload["_meta"]["qualityGate"]["overallPass"] = False
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("overallPass False contradicts gate-level statuses (FAIL gate ids []" in v for v in violations)


def test_fca1_p1_01_non_bool_overall_pass_is_violation():
    payload = _valid_payload()
    payload["_meta"]["qualityGate"]["overallPass"] = "true"
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("overallPass 'true' contradicts gate-level statuses" in v for v in violations)


def test_fca1_p1_01_non_list_hard_fail_ids_is_violation():
    payload = _valid_payload()
    payload["_meta"]["qualityGate"]["hardFailIds"] = None
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert any("hardFailIds is not a list" in v for v in violations)


def test_fca1_p1_01_case_d_producer_valid_pass_aggregate_accepted():
    """D. producer が生成した PASS aggregate はそのまま accepted。"""
    payload = _valid_payload()
    assert smoke.check_candidate_funnel_payload(payload, "test") == []


def test_fca1_p1_01_case_e_producer_valid_warn_aggregate_with_p14_warn_accepted():
    """E. P-14 WARN（+ P-15 WARN）を含む producer-valid WARN aggregate は
    non-hard として accepted。"""
    payload = _valid_payload()
    _gate_by_id(payload, "P-14")["status"] = "WARN"
    _gate_by_id(payload, "P-15")["status"] = "WARN"
    assert payload["_meta"]["qualityGate"]["overallPass"] is True
    assert payload["_meta"]["qualityGate"]["hardFailIds"] == []
    assert smoke.check_candidate_funnel_payload(payload, "test") == []


def test_fca1_p1_01_case_f_producer_valid_fail_aggregate_rejected():
    """F. producer-valid な FAIL aggregate（gate FAIL / hardFailIds 一致 /
    overallPass=False）は parity は満たすが publish 適格ではない => reject。"""
    payload = _valid_payload()
    _gate_by_id(payload, "P-02")["status"] = "FAIL"
    payload["_meta"]["qualityGate"]["overallPass"] = False
    payload["_meta"]["qualityGate"]["hardFailIds"] = ["P-02"]
    violations = smoke.check_candidate_funnel_payload(payload, "test")
    assert violations
    assert any("overallPass is not True" in v for v in violations)
    assert any("hardFailIds is not empty" in v for v in violations)
    # parity 自体は満たしているので parity violation は出ない
    assert not any("producer parity violated" in v for v in violations)
    assert not any("contradicts gate-level statuses" in v for v in violations)


def test_fca1_p1_01_case_g_twin_paths_fail_closed_on_contradiction(tmp_path):
    """G. data/public twin path 経由でも矛盾 artifact は両 file で fail-closed。"""
    payload = _valid_payload()
    _gate_by_id(payload, "P-02")["status"] = "FAIL"
    paths = _write_twin(tmp_path, payload)
    violations = smoke.check_candidate_funnel_files(paths)
    parity = [v for v in violations if "does not equal FAIL gate ids ['P-02']" in v]
    assert len(parity) == 2
    assert any(v.startswith(paths[0]) for v in parity)
    assert any(v.startswith(paths[1]) for v in parity)
    assert not any("not byte-identical" in v for v in violations)
    assert smoke.main(["--paths", *paths]) == 1


def test_fca1_p1_01_case_g_twin_paths_accept_coherent_warn(tmp_path):
    payload = _valid_payload()
    _gate_by_id(payload, "P-14")["status"] = "WARN"
    paths = _write_twin(tmp_path, payload)
    assert smoke.check_candidate_funnel_files(paths) == []
    assert smoke.main(["--paths", *paths]) == 0
