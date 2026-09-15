"""OPS-P14-2: data.candidate_funnel_run_evidence のテスト。

candidate_funnel_batchの実運用run（full_batch.yml `update-data` job）が
同一run内で読んだ入力/出力を、P14 PASS/FAILどちらでも保全することを検証する。

data.p14_evidence_capture（手動workflow_dispatch専用の別corpus、gitSha
8cfa5568にpin済み）とは独立のtestであり、あちらのfrozen testは一切
変更しない。P-14のthreshold/metric自体はtest_candidate_funnel_batch.pyの
責務であり、ここではこのticketがそれらを変更していないことのみを確認する。
"""
from __future__ import annotations

import copy
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

import data.candidate_funnel_batch as batch
import data.candidate_funnel_run_evidence as evidence_mod

NOW = datetime(2026, 7, 26, 10, 0, 0, tzinfo=timezone.utc)

RUN_IDENTITY = {
    "runId": "1234567890",
    "runAttempt": "1",
    "workflow": "full_batch.yml",
    "event": "schedule",
    "gitSha": "a" * 40,
    "gitRef": "refs/heads/v13.3-dev",
    "gitRefType": "branch",
    "runnerOs": "Linux",
}


# ---------------------------------------------------------------------------
# Fixtures / helpers（test_candidate_funnel_batch.pyと同じ規律で、この
# test file専用に再定義する。他test fileのprivateヘルパーはimportしない）
# ---------------------------------------------------------------------------


def _write_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _load_calibration_fixture():
    path = Path(__file__).resolve().parent / "fixtures" / "candidate_funnel_calibration_v1.json"
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def _calibration_split():
    """B1 calibration fixture（PASS実データ相当、200銘柄規模）をB2向けに
    分解する。fixture fileそのものは変更しない（読むだけ）。"""
    candidates = copy.deepcopy(_load_calibration_fixture()["candidates"])
    stripped = []
    entries = []
    for index, c in enumerate(candidates):
        score = c.pop("prescreenScore", None)
        c.pop("prescreenRank", None)
        stripped.append(c)
        if score is not None:
            entries.append(
                {"code": c["code"], "prescreenScore": score, "prescreenRank": index + 1, "prescreenPool": None}
            )
    return stripped, entries


def _candidates_stocks_payload(candidates):
    return {
        "schemaVersion": "candidates-stocks-1",
        "updatedAt": "2026-07-25T00:00:00+00:00",
        "sourceUpdatedAt": "2026-07-25T00:00:00+00:00",
        "staleThresholdHours": 48,
        "_meta": {"pipelinePath": "normal", "universeProvenance": {"shortlistFallbackUsed": False}},
        "candidates": candidates,
        "missing": [],
        "status": "ok",
    }


def _prescreen_payload(entries):
    return {
        "schemaVersion": "prescreen-metadata-1",
        "generatedAt": "2026-07-25T00:00:00+00:00",
        "not_for_trading": True,
        "shortlistId": "jpx_cheap_prescreen_v1",
        "pipelinePath": "normal",
        "duplicateCodes": [],
        "entries": entries,
    }


def _write_real_inputs(tmp_path: Path):
    stripped, entries = _calibration_split()
    cs_path = tmp_path / "candidates_stocks.json"
    _write_json(cs_path, _candidates_stocks_payload(stripped))
    prescreen_path = tmp_path / "prescreen_metadata.json"
    _write_json(prescreen_path, _prescreen_payload(entries))
    regime_path = tmp_path / "regime_state.json"
    _write_json(regime_path, {"regime_state": {"current_regime": "bull_calm"}})
    previous_path = tmp_path / "previous-artifact.json"
    _write_json(previous_path, {"status": "not_generated"})
    return cs_path, prescreen_path, regime_path, previous_path


def _build(tmp_path, *, batch_status="batch_passed", smoke_status="smoke_passed"):
    cs_path, prescreen_path, regime_path, previous_path = _write_real_inputs(tmp_path)
    return evidence_mod.build_evidence(
        run_identity=RUN_IDENTITY,
        candidates_path=cs_path,
        prescreen_path=prescreen_path,
        regime_path=regime_path,
        previous_path=previous_path,
        batch_status=batch_status,
        smoke_status=smoke_status,
        now=NOW,
    )


# ===========================================================================
# PASS run evidence
# ===========================================================================


def test_pass_run_evidence_is_captured_with_full_p14_detail(tmp_path):
    """OPS_P14_D2_RELEASE_METRIC_IMPLEMENTATION_R2: calibration fixtureは
    ±2% perturbationの下でdeep-review tierから1件exitする(A250)。旧binary
    policyはjaccard(=1.0)しか見ないため気づけなかったこのchurnを、新
    decision-aware policyはWARNとして非blockingに表面化する — overallPass/
    hardFailIdsは引き続きnon-blocking(publish可能)のまま。"""
    ev = _build(tmp_path)
    assert ev["schemaVersion"] == "candidate-funnel-run-evidence-2"
    assert ev["captureStatus"] == "captured"
    assert ev["publish"]["overallPass"] is True
    assert ev["publish"]["hardFailIds"] == []
    assert ev["p14"]["verdict"] == "WARN"
    assert ev["p14"]["release"]["policyVersion"] == "p14-decision-aware-v1"
    assert ev["p14"]["release"]["final"]["status"] == "WARN"
    assert ev["p14"]["release"]["final"]["hardReasons"] == []
    assert "DEEP_REVIEW_EXIT_WARN" in ev["p14"]["release"]["final"]["warnReasons"]
    assert len(ev["p14"]["baseTop40"]) == 40
    assert len(ev["p14"]["perturbedTop40"]) == 40
    assert len(ev["replay"]["baseFullOrderedRankVector"]) > 40
    assert len(ev["replay"]["perturbedFullOrderedRankVector"]) > 40


def test_pass_run_evidence_swap_count_matches_top40_set_difference(tmp_path):
    ev = _build(tmp_path)
    base_codes = {row["code"] for row in ev["p14"]["baseTop40"]}
    perturbed_codes = {row["code"] for row in ev["p14"]["perturbedTop40"]}
    assert ev["p14"]["swapCount"] == len(base_codes - perturbed_codes)


# ===========================================================================
# FAIL run evidence — mutation coverage target: gating evidence writing on
# overallPass (removing FAIL-path capture) must turn this RED.
# ===========================================================================


def test_fail_run_evidence_still_captures_full_p14_detail(tmp_path, monkeypatch):
    # OPS_P14_D2_RELEASE_METRIC_IMPLEMENTATION_R2: severity(status)は
    # compute_p14_release_evidence()がengine_result/perturbed_resultから
    # 独立に再計算するため、compute_p14_release_evidence自体をFAILへ
    # 直接monkeypatchしてgate配線（"FAILでもevidenceが空/欠落にならない"
    # というこのtestの本来の regression target）だけを検証する。
    monkeypatch.setattr(
        batch,
        "compute_p14_release_evidence",
        lambda engine_result, perturbed_result: {
            "policyVersion": batch.P14_RELEASE_POLICY_VERSION,
            "final": {
                "status": "FAIL",
                "hardReasons": ["TOP40_JACCARD_BELOW_HARD_MIN"],
                "warnReasons": [],
            },
        },
    )
    ev = _build(tmp_path, batch_status="batch_failed", smoke_status="")
    assert ev["captureStatus"] == "captured"
    assert ev["publish"]["overallPass"] is False
    assert "P-14" in ev["publish"]["hardFailIds"]
    assert ev["p14"]["verdict"] == "FAIL"
    assert ev["p14"]["release"]["final"]["status"] == "FAIL"
    # regression target: evidenceがoverallPass依存で書かれると、ここが
    # 空配列/欠落になりREDになる。
    assert len(ev["p14"]["baseTop40"]) == 40
    assert len(ev["p14"]["perturbedTop40"]) == 40


def test_fail_run_evidence_records_batch_and_smoke_status_verbatim(tmp_path, monkeypatch):
    monkeypatch.setattr(
        batch,
        "compute_rank_stability",
        lambda joined_candidates, context, engine_result: (0.80, engine_result),
    )
    ev = _build(tmp_path, batch_status="batch_failed", smoke_status="")
    assert ev["publish"]["batchStatus"] == "batch_failed"
    assert ev["publish"]["smokeStatus"] is None


# ===========================================================================
# P-13 / P-15 pass-through
# ===========================================================================


def test_p13_and_p15_gate_rows_are_passed_through_unmodified(tmp_path):
    ev = _build(tmp_path)
    assert ev["p13"]["id"] == "P-13"
    assert ev["p15"]["id"] == "P-15"


# ===========================================================================
# P-14 constants — this ticket changes zero thresholds/metrics.
# ===========================================================================


def test_p14_constants_are_frozen_production_values(tmp_path):
    ev = _build(tmp_path)
    assert ev["p14Parameters"] == {
        "threshold": 0.95,
        "topK": 40,
        "perturbationPct": 0.02,
        "assignmentContract": "p14-prescreen-rank-code-v1",
        "policyVersion": "p14-decision-aware-v1",
    }
    # module定数からの読み取りであること（literal copyではない）も確認する。
    assert ev["p14Parameters"]["threshold"] == batch.RANK_STABILITY_JACCARD_MIN
    assert ev["p14Parameters"]["topK"] == batch.TOP_N_STABILITY
    assert ev["p14Parameters"]["perturbationPct"] == batch.PERTURBATION_PCT
    assert ev["p14Parameters"]["policyVersion"] == batch.P14_RELEASE_POLICY_VERSION


def test_p14_engine_ranking_blob_is_unchanged_from_dev_base():
    """B1 engine（scoring/tier/marketRank authority, frozen）はこのticketで
    一切変更しない — data/candidate_funnel_engine.pyはbyte-identical。
    data/candidate_funnel_batch.pyはOPS_P14_D2_RELEASE_METRIC_IMPLEMENTATION_R2
    でrelease evidence/gate評価（join/gate/publish層、scoring/rankingでは
    ない）を追加するため意図的に変更されており、この関数のfrozen対象から
    除外する（旧: test_p14_scoring_and_ranking_blobs_are_unchanged_from_dev_base
    — batch.pyの変更を許可する決定に伴い改名・範囲縮小）。"""
    repo = Path(__file__).resolve().parents[1]
    expected = {
        "data/candidate_funnel_engine.py": "25e12a4217ace5d807963b54fe2e9918d8613c834b06b730fff8701a4b45d710",
    }
    assert {
        relative: hashlib.sha256((repo / relative).read_bytes()).hexdigest()
        for relative in expected
    } == expected


# ===========================================================================
# Input hashes
# ===========================================================================


def test_input_hashes_match_actual_file_bytes(tmp_path):
    cs_path, prescreen_path, regime_path, previous_path = _write_real_inputs(tmp_path)
    ev = evidence_mod.build_evidence(
        run_identity=RUN_IDENTITY,
        candidates_path=cs_path,
        prescreen_path=prescreen_path,
        regime_path=regime_path,
        previous_path=previous_path,
        batch_status="batch_passed",
        smoke_status="smoke_passed",
        now=NOW,
    )
    assert ev["inputHashes"]["candidatesStocks"]["sha256"] == evidence_mod._sha256_bytes(cs_path.read_bytes())
    assert ev["inputHashes"]["prescreenMetadata"]["sha256"] == evidence_mod._sha256_bytes(prescreen_path.read_bytes())
    assert ev["inputHashes"]["regimeState"]["sha256"] == evidence_mod._sha256_bytes(regime_path.read_bytes())
    assert ev["inputHashes"]["previousArtifact"]["present"] is True


def test_missing_previous_artifact_is_recorded_as_absent_not_a_crash(tmp_path):
    cs_path, prescreen_path, regime_path, _previous_path = _write_real_inputs(tmp_path)
    missing_previous = tmp_path / "does-not-exist.json"
    ev = evidence_mod.build_evidence(
        run_identity=RUN_IDENTITY,
        candidates_path=cs_path,
        prescreen_path=prescreen_path,
        regime_path=regime_path,
        previous_path=missing_previous,
        batch_status="batch_passed",
        smoke_status="smoke_passed",
        now=NOW,
    )
    assert ev["inputHashes"]["previousArtifact"] == {"present": False, "sha256": None, "bytes": None}
    assert ev["captureStatus"] == "captured"


def test_missing_candidates_stocks_reports_input_unavailable_without_raising(tmp_path):
    missing_candidates = tmp_path / "does-not-exist.json"
    prescreen_path = tmp_path / "prescreen_metadata.json"
    _write_json(prescreen_path, _prescreen_payload([]))
    regime_path = tmp_path / "regime_state.json"
    _write_json(regime_path, {"regime_state": {"current_regime": "bull_calm"}})
    ev = evidence_mod.build_evidence(
        run_identity=RUN_IDENTITY,
        candidates_path=missing_candidates,
        prescreen_path=prescreen_path,
        regime_path=regime_path,
        previous_path=tmp_path / "previous.json",
        batch_status="",
        smoke_status="",
        now=NOW,
    )
    assert ev["captureStatus"] == "input_unavailable"
    assert "captureError" in ev
    assert "p14" not in ev


def test_missing_prescreen_metadata_does_not_crash_capture(tmp_path):
    """prescreen_metadata.jsonはgitignore対象で、この評価stepが走る時点では
    通常存在する（build_candidates_stocksが同一runで先に書く）が、上流が
    途中で失敗した異常系でも本stepはcrashしてはならない。"""
    cs_path, _prescreen_path, regime_path, previous_path = _write_real_inputs(tmp_path)
    missing_prescreen = tmp_path / "does-not-exist.json"
    ev = evidence_mod.build_evidence(
        run_identity=RUN_IDENTITY,
        candidates_path=cs_path,
        prescreen_path=missing_prescreen,
        regime_path=regime_path,
        previous_path=previous_path,
        batch_status="batch_failed",
        smoke_status="",
        now=NOW,
    )
    assert ev["captureStatus"] == "captured"


# ===========================================================================
# Determinism
# ===========================================================================


def test_evidence_is_byte_deterministic_across_two_calls(tmp_path):
    cs_path, prescreen_path, regime_path, previous_path = _write_real_inputs(tmp_path)
    kwargs = dict(
        run_identity=RUN_IDENTITY,
        candidates_path=cs_path,
        prescreen_path=prescreen_path,
        regime_path=regime_path,
        previous_path=previous_path,
        batch_status="batch_passed",
        smoke_status="smoke_passed",
        now=NOW,
    )
    first = evidence_mod.build_evidence(**kwargs)
    second = evidence_mod.build_evidence(**kwargs)
    assert evidence_mod._canonical_bytes(first) == evidence_mod._canonical_bytes(second)


# ===========================================================================
# OPS-P14-3 replay contract / mutation coverage
# ===========================================================================


def _install_deterministic_fail_fixture(monkeypatch):
    """Produce exactly five Top40 boundary swaps (Jaccard=35/45 < 0.80).

    OPS_P14_D2_RELEASE_METRIC_IMPLEMENTATION_R2: 旧policyはswap=2
    (Jaccard=38/42=0.9047... < 0.95)だけでFAILだったが、新decision-aware
    policyではswap=2はWARN止まり(§6.1の例と一致)。このfixtureは「FAILでも
    evidence captureが完全なままである」ことを検証する専用fixtureであり、
    引き続き真のFAIL(HARD backstop, jaccard<0.80)を再現する必要があるため
    swap数を5へ拡張する(35/45=0.7777... < 0.80 → HARD)。marketRankのみを
    入れ替え、tier割り当ては一切変更しないため、deep-review/actionable
    churnとP14_MARKET_REFERENCE_SHORTLIST(rank上位3件)はこのfixtureの下
    では不変のまま — FAILの原因はtop40 Jaccardのみに厳密に isolate される。
    """

    def fail_rank_stability(joined_candidates, context, engine_result):
        del joined_candidates, context
        perturbed = copy.deepcopy(engine_result)
        ranked = sorted(
            (
                row
                for row in perturbed["candidates"]
                if isinstance(row, dict) and row.get("marketRank") is not None
            ),
            key=lambda row: row["marketRank"],
        )
        for inside, outside in ((35, 40), (36, 41), (37, 42), (38, 43), (39, 44)):
            ranked[inside]["marketRank"], ranked[outside]["marketRank"] = (
                ranked[outside]["marketRank"],
                ranked[inside]["marketRank"],
            )
        base_vector = evidence_mod._full_rank_vector(engine_result)
        perturbed_vector = evidence_mod._full_rank_vector(perturbed)
        jaccard, _swap_count = evidence_mod._jaccard_from_vectors(
            base_vector, perturbed_vector, batch.TOP_N_STABILITY
        )
        return jaccard, perturbed

    monkeypatch.setattr(batch, "compute_rank_stability", fail_rank_stability)


def test_replay_recomputes_original_p14_exactly_from_bundle(tmp_path):
    ev = _build(tmp_path)
    bundle_root = tmp_path / "bundle" / "candidate-funnel-evidence-123-1"
    evidence_mod.write_bundle(bundle_root, ev)
    stored = json.loads((bundle_root / "evidence.json").read_text(encoding="utf-8"))
    replay = evidence_mod.replay_p14(stored)
    assert replay["passed"] is True
    assert replay["replayable"] is True
    assert replay["jaccard"] == stored["p14"]["jaccard"]
    assert replay["swapCount"] == stored["p14"]["swapCount"]
    assert replay["verdict"] == stored["p14"]["verdict"]


def test_pass_fixture_replay_matches_original(tmp_path):
    """calibration fixtureはdeep-review 1件exit(A250)によりWARNを報告する
    (§ test_pass_run_evidence_is_captured_with_full_p14_detail)。replay_p14
    はp14Parameters.policyVersion経由でdecision-aware pathを選び、同じWARN
    を独立に再現する。"""
    ev = _build(tmp_path)
    assert ev["p14"]["verdict"] == "WARN"
    assert evidence_mod.replay_p14(ev) == {
        "passed": True,
        "compatible": True,
        "replayable": True,
        "schemaVersion": evidence_mod.SCHEMA_VERSION,
        "errors": [],
        "jaccard": ev["p14"]["jaccard"],
        "swapCount": ev["p14"]["swapCount"],
        "verdict": "WARN",
    }


def test_fail_fixture_replay_matches_original(tmp_path, monkeypatch):
    _install_deterministic_fail_fixture(monkeypatch)
    ev = _build(tmp_path, batch_status="batch_failed", smoke_status="")
    replay = evidence_mod.replay_p14(ev)
    assert ev["p14"]["jaccard"] == 35 / 45
    assert ev["p14"]["swapCount"] == 5
    assert ev["p14"]["verdict"] == "FAIL"
    assert ev["p14"]["release"]["final"]["status"] == "FAIL"
    assert "TOP40_JACCARD_BELOW_HARD_MIN" in ev["p14"]["release"]["final"]["hardReasons"]
    assert replay["passed"] is True
    assert replay["jaccard"] == ev["p14"]["jaccard"]
    assert replay["verdict"] == "FAIL"


def test_boundary_outside_band_is_present_and_metric_is_reconstructable(tmp_path):
    ev = _build(tmp_path)
    replay = ev["replay"]
    boundary = replay["boundaryOutsideBand"]
    assert boundary["topK"] == 40
    assert boundary["size"] == evidence_mod.BOUNDARY_OUTSIDE_BAND_SIZE
    assert boundary["base"] == replay["baseFullOrderedRankVector"][40:50]
    assert boundary["perturbed"] == replay["perturbedFullOrderedRankVector"][40:50]
    assert boundary["base"]  # K外bandが実在するfixture
    jaccard, swaps = evidence_mod._jaccard_from_vectors(
        replay["baseFullOrderedRankVector"],
        replay["perturbedFullOrderedRankVector"],
        boundary["topK"],
    )
    assert (jaccard, swaps) == (ev["p14"]["jaccard"], ev["p14"]["swapCount"])


def test_replay_input_hash_tamper_is_red(tmp_path):
    ev = _build(tmp_path)
    ev["inputHashes"]["joinedCandidateInput"]["sha256"] = "0" * 64
    result = evidence_mod.replay_p14(ev)
    assert result["passed"] is False
    assert "joined candidate input hash mismatch" in result["errors"]


def test_replay_rank_vector_tamper_is_red(tmp_path):
    ev = _build(tmp_path)
    ev["replay"]["baseFullOrderedRankVector"][0]["marketRank"] = 999
    result = evidence_mod.replay_p14(ev)
    assert result["passed"] is False
    assert "base rank vector mismatch" in result["errors"]


def test_ops_p14_2_v1_evidence_remains_compatible(tmp_path):
    legacy = _build(tmp_path)
    legacy["schemaVersion"] = evidence_mod.LEGACY_SCHEMA_VERSION
    legacy.pop("replay")
    result = evidence_mod.replay_p14(legacy)
    assert result == {
        "passed": True,
        "compatible": True,
        "replayable": False,
        "schemaVersion": evidence_mod.LEGACY_SCHEMA_VERSION,
        "errors": [],
    }
    bundle_root = tmp_path / "legacy" / "candidate-funnel-evidence-123-1"
    evidence_mod.write_bundle(bundle_root, legacy)
    manifest = json.loads((bundle_root / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["schemaVersion"] == evidence_mod.LEGACY_SCHEMA_VERSION


# ===========================================================================
# Bundle / privacy
# ===========================================================================


def test_write_bundle_produces_self_consistent_manifest(tmp_path):
    ev = _build(tmp_path)
    bundle_root = tmp_path / "bundle" / "candidate-funnel-evidence-123-1"
    evidence_mod.write_bundle(bundle_root, ev)
    manifest = json.loads((bundle_root / "manifest.json").read_text(encoding="utf-8"))
    for entry in manifest["files"]:
        raw = (bundle_root / entry["path"]).read_bytes()
        assert evidence_mod._sha256_bytes(raw) == entry["sha256"]
    digest_line = (bundle_root / "manifest.sha256").read_text(encoding="utf-8").strip()
    assert digest_line.split()[0] == evidence_mod._sha256_bytes((bundle_root / "manifest.json").read_bytes())


def test_write_bundle_privacy_report_passes_for_public_market_data_only(tmp_path):
    ev = _build(tmp_path)
    bundle_root = tmp_path / "bundle" / "candidate-funnel-evidence-123-1"
    evidence_mod.write_bundle(bundle_root, ev)
    report = json.loads((bundle_root / "validation" / "privacy-report.json").read_text(encoding="utf-8"))
    assert report["passed"] is True
    assert report["violations"] == []


def test_write_bundle_wipes_bundle_on_forbidden_key_injection(tmp_path):
    ev = _build(tmp_path)
    ev["holdings"] = {"code": "1234", "quantity": 100}  # 意図的にforbidden keyを混入
    bundle_root = tmp_path / "bundle" / "candidate-funnel-evidence-123-1"
    with pytest.raises(evidence_mod.EvidenceCaptureError):
        evidence_mod.write_bundle(bundle_root, ev)
    remaining = sorted(p.relative_to(bundle_root).as_posix() for p in bundle_root.rglob("*") if p.is_file())
    assert remaining == ["validation/privacy-report.json"]
    report = json.loads((bundle_root / "validation" / "privacy-report.json").read_text(encoding="utf-8"))
    assert report["passed"] is False
    assert report["dataFilesUploaded"] is False


def test_write_bundle_normalizes_runner_absolute_path_before_privacy_scan(tmp_path):
    ev = _build(tmp_path)
    ev["runIdentity"]["runnerWorkspace"] = "/home/runner/work/jp-portfolio/jp-portfolio"
    bundle_root = tmp_path / "bundle" / "candidate-funnel-evidence-123-1"
    evidence_mod.write_bundle(bundle_root, ev)
    stored = json.loads((bundle_root / "evidence.json").read_text(encoding="utf-8"))
    report = json.loads(
        (bundle_root / "validation" / "privacy-report.json").read_text(encoding="utf-8")
    )
    assert stored["runIdentity"]["runnerWorkspace"] == "<HOME>"
    assert report["passed"] is True


def test_capture_failure_returns_nonzero_without_changing_publication_inputs(
    tmp_path, monkeypatch
):
    sentinel = tmp_path / "candidate_funnel.json"
    sentinel.write_text("committed-publication-sentinel\n", encoding="utf-8")
    before = sentinel.read_bytes()
    for name, value in {
        "GITHUB_RUN_ID": "123",
        "GITHUB_RUN_ATTEMPT": "1",
        "GITHUB_SHA": "a" * 40,
        "GITHUB_REF": "refs/heads/v13.3-dev",
        "GITHUB_REF_TYPE": "branch",
        "GITHUB_EVENT_NAME": "schedule",
    }.items():
        monkeypatch.setenv(name, value)

    def capture_failure(**_kwargs):
        raise evidence_mod.EvidenceCaptureError("synthetic capture failure")

    monkeypatch.setattr(evidence_mod, "build_evidence", capture_failure)
    status = evidence_mod.main(
        ["--out", str(tmp_path / "out"), "--previous", str(tmp_path / "previous.json")]
    )
    assert status == 1
    assert sentinel.read_bytes() == before


# ===========================================================================
# OPS_P14_D2_RELEASE_METRIC_IMPLEMENTATION_R2 §16/§17: reclassify_p14 —
# new-policy reclassification path, independent of replay_p14's legacy
# verdict. Must never mutate the historical bundle or its stored verdict.
# ===========================================================================


def test_reclassify_p14_independent_of_replay_p14_legacy_verdict(tmp_path):
    """§16 LEGACY_REPLAY_COMPAT: build_evidence()が現行(policyVersion付き)
    bundleを生成した通常経路では、replay_p14はdecision-aware pathを使い
    reclassify_p14と同じ最終statusへ収束する(両方とも新policyで評価する
    ため一致するのが正しい — reclassify_p14の役割は"新policyを持たない
    (policyVersion欠落の)historical bundleへ後から新policyを当てる"こと
    であり、既にpolicyVersion付きのbundleではreplay_p14自身が既に新
    policyを使っている)。"""
    ev = _build(tmp_path)
    reclassified = evidence_mod.reclassify_p14(ev)
    assert reclassified["reclassificationPolicyVersion"] == "p14-decision-aware-v1"
    assert reclassified["historicalVerdict"] == ev["p14"]["verdict"]
    assert reclassified["release"]["final"]["status"] == ev["p14"]["verdict"]
    # reclassify_p14はbundleを一切書き換えない(戻り値のみ)。
    assert ev["p14"]["verdict"] == "WARN"


def test_reclassify_p14_does_not_mutate_input_bundle(tmp_path):
    ev = _build(tmp_path)
    before = copy.deepcopy(ev)
    evidence_mod.reclassify_p14(ev)
    assert ev == before


def test_reclassify_p14_legacy_v1_schema_without_replay_fails_closed():
    """schemaVersion=candidate-funnel-run-evidence-1(replay payload無し)は
    reconstruct不能なのでfail-closedで例外を送出する — silentに空/誤った
    evidenceを返さない。"""
    with pytest.raises(evidence_mod.ReclassificationError):
        evidence_mod.reclassify_p14({"schemaVersion": evidence_mod.LEGACY_SCHEMA_VERSION})


def test_reclassify_p14_rejects_unsupported_schema():
    with pytest.raises(evidence_mod.ReclassificationError):
        evidence_mod.reclassify_p14({"schemaVersion": "unknown-schema"})


def test_reclassify_p14_reproduces_legacy_binary_verdict_as_historical_baseline(
    tmp_path, monkeypatch
):
    """§18相当の縮小版: HARD backstop未満(swap=5, jaccard<0.80)の
    deterministic fixtureをreclassifyすると、旧binary policy下の
    historicalVerdict(FAIL)と新policyのrelease.final.status(FAIL、jaccard
    <0.80のHARD経由)が一致することを確認する — 新旧どちらのpolicyでも
    明確にFAILとなる境界外のケースで両者が整合することの健全性チェック。"""
    _install_deterministic_fail_fixture(monkeypatch)
    ev = _build(tmp_path, batch_status="batch_failed", smoke_status="")
    reclassified = evidence_mod.reclassify_p14(ev)
    assert reclassified["historicalVerdict"] == "FAIL"
    assert reclassified["release"]["final"]["status"] == "FAIL"
    assert reclassified["release"]["top40"]["jaccard"] == pytest.approx(35 / 45)
