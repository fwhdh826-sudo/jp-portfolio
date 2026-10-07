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


# Phase III-C candidate tests. Gate A adds these tests without executing them.
# All new evidence material is synthetic and lives in this test file.
import ast
import inspect
import os
import shutil
import subprocess
import sys
import types
from dataclasses import replace

from data import candidate_funnel_engine as engine
from data import p14_handoff as handoff
from data import p14_observation as observation_mod
from data import p14_run_evidence_bundle as bundle

S3_REPO = Path(__file__).resolve().parents[1]
S3_BASELINE = "01b9448cbea017634e25a45b57e5cd418e84e5f7"
S3_POLICY = "p14-decision-aware-v1"
S3_EXECUTED_SHA = "2" * 40
S3_RUN = {
    "repository": "synthetic/schema3", "workflow": "full_batch.yml", "job": "update-data",
    "runId": "900000031", "runAttempt": "1", "event": "schedule",
    "gitRef": "refs/heads/main", "gitRefType": "branch", "gitSha": "1" * 40,
}
S3_VERSIONS = (
    engine.CANDIDATE_FUNNEL_SCHEMA_VERSION, engine.CANDIDATE_FUNNEL_SCORE_VERSION,
    engine.CANDIDATE_FUNNEL_VERSION,
)


def _s3_context() -> dict[str, object]:
    return {
        "pipelinePath": "normal",
        "regime": "bull_calm",
        "sourceUpdatedAt": "2026-09-20T00:00:00.000Z",
        "asOf": "2026-09-20T00:30:00.000Z",
        "staleThresholdHours": 24,
        "prescreenFallbackUsed": False,
    }


def _s3_join_stats() -> dict[str, object]:
    return {
        "candidateCount": 6,
        "prescreenCount": 6,
        "joinedCount": 6,
        "unmatchedCandidateCount": 0,
        "unmatchedPrescreenCount": 0,
        "joinRate": 1.0,
        "unmatchedCandidateRate": 0.0,
    }


def _s3_joined_input() -> list[dict[str, object]]:
    return [
        {
            "code": f"SYN-{index}",
            "name": f"SYN-{index}",
            "sector": "Synthetic",
            "price": 100.0 + index,
            "per": 10.0,
            "pbr": 1.0,
            "roe": 0.1,
            "dividendYield": 0.01,
            "sigma252d": 0.2,
            "mom3m": 0.05,
            "dataStatus": "synthetic",
            "prescreenScore": 100.0 - index,
            "prescreenRank": index,
            "prescreenPool": "synthetic",
        }
        for index in range(1, 7)
    ]


def _s3_candidates(*, dropped: int) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for index in range(1, 7):
        rank: int | None = index if index <= 6 - dropped else None
        rows.append(
            {
                "artifactIndex": index - 1,
                "code": f"SYN-{index}",
                "tier": "actionable" if index <= 2 else "deep_review",
                "marketRank": rank,
                "prescreenScore": 100.0 - index,
                "prescreenRank": index,
                "prescreenPool": "synthetic",
                "marketScore": 90.0 - index,
                "rawCompositeScore": 0.9 - index / 100,
                "sector": "Synthetic",
                "dataStatus": "synthetic",
                "dataConfidence": 0.9,
            }
        )
    return rows


def _s3_selection() -> dict[str, object]:
    return {
        "regimeApplied": "bull_calm",
        "actionableHardMaxApplied": 12,
        "actionableSectorCapApplied": 2,
        "deepReviewHardMaxApplied": 40,
        "deepReviewSectorCapApplied": 6,
        "deepReviewSectorCapRelaxed": False,
        "actionableSectorCapRelaxed": False,
        "deepReviewEligibleCount": 4,
        "deepReviewSelectedCount": 4,
        "actionableEligibleCount": 2,
        "actionableSelectedCount": 2,
        "sourceStale": False,
        "fallbackProvenance": False,
    }


def _s3_side(*, dropped: int = 0) -> dict[str, object]:
    return {
        "engineStatus": "generated",
        "candidates": _s3_candidates(dropped=dropped),
        "selectionObservability": _s3_selection(),
    }


def _s3_source_identity(executed_sha: str = S3_EXECUTED_SHA, digests=None) -> dict[str, object]:
    return {
        "executedGitSha": executed_sha,
        "modules": [
            {
                "path": path,
                "sha256": digests[path] if digests is not None else f"{index + 1:064x}",
            }
            for index, path in enumerate(handoff.FIXED_MODULE_PATHS)
        ],
        "engineSchemaVersion": "candidate-funnel-1",
        "engineScoreVersion": "market-score-v1",
        "engineFunnelVersion": "candidate-funnel-v1",
    }


def _s3_release(*, dropped: int, status: str) -> dict[str, object]:
    base_codes = [f"SYN-{index}" for index in range(1, 7)]
    perturbed_codes = [f"SYN-{index}" for index in range(1, 7 - dropped)]
    intersection = sorted(set(base_codes) & set(perturbed_codes))
    union = sorted(set(base_codes) | set(perturbed_codes))
    jaccard = len(intersection) / len(union)
    reasons = {
        "PASS": ([], []),
        "WARN": ([], ["P14_TOP40_JACCARD_WARN"]),
        "FAIL": (["P14_TOP40_JACCARD_HARD_FAIL"], []),
    }
    hard, warn = reasons[status]
    shortlist = [
        {"code": f"SYN-{index}", "tier": "actionable" if index <= 2 else "deep_review", "marketRank": index, "artifactIndex": index - 1}
        for index in range(1, 4)
    ]
    return {
        "policyVersion": S3_POLICY,
        "top40": {
            "intersection": intersection,
            "union": union,
            "retention": len(intersection) / len(base_codes),
            "swapCount": dropped,
            "jaccard": jaccard,
            "warnThreshold": 0.95,
            "hardThreshold": 0.8,
        },
        "deepReview": {
            "baseCodes": ["SYN-3", "SYN-4", "SYN-5", "SYN-6"],
            "perturbedCodes": [code for code in ["SYN-3", "SYN-4", "SYN-5", "SYN-6"] if code in perturbed_codes],
            "entered": [],
            "exited": [code for code in ["SYN-3", "SYN-4", "SYN-5", "SYN-6"] if code not in perturbed_codes],
            "exitCount": len([code for code in ["SYN-3", "SYN-4", "SYN-5", "SYN-6"] if code not in perturbed_codes]),
        },
        "actionable": {
            "baseCodes": ["SYN-1", "SYN-2"],
            "perturbedCodes": ["SYN-1", "SYN-2"],
            "entered": [],
            "exited": [],
            "exitCount": 0,
            "warnThreshold": 2,
            "hardThreshold": 3,
        },
        "marketReferenceShortlist": {
            "name": "P14_MARKET_REFERENCE_SHORTLIST",
            "holdingsDependent": False,
            "n": 3,
            "base": shortlist,
            "perturbed": shortlist,
            "membershipChanged": False,
            "tierChanged": False,
            "orderChanged": False,
        },
        "final": {"status": status, "hardReasons": hard, "warnReasons": warn},
        "p14ProvesOfficialDecisionStability": False,
    }


def _s3_gates(*, dropped: int, status: str, fail_id: str | None = None) -> list[dict[str, object]]:
    jaccard = (6 - dropped) / 6
    values: dict[str, object] = {
        "P-01": 6,
        "P-02": 1.0,
        "P-03": 0.0,
        "P-04": 0.0,
        "PRESCREEN_DUPLICATE": 0,
        "P-05": 0.0,
        "P-06": {"count": 6, "min": 4, "p25": 4, "median": 5, "p75": 6, "max": 6, "atOrBelow4AxesCount": 1},
        "P-07": {"count": 6, "min": 20.0, "max": 80.0, "range": 60.0, "p25": 30.0, "p75": 50.0, "iqr": 20.0, "median": 40.0},
        "P-08": 4,
        "P-09": 2,
        "P-10": {"deepReview": 7, "actionable": 4},
        "P-11": {"deepReviewSectorCapOverflow": {"Synthetic": 0}, "actionableSectorCapOverflow": {"Synthetic": 0}, "deepReviewEligibleMinusSelected": 0, "actionableEligibleMinusSelected": 0},
        "P-12": {"soft": {}, "hard": {}},
        "P-13": {"currentRunActionable": 2, "cacheFallbackMirrorActionable": 0},
        "P-14": jaccard,
        "P-15": None,
    }
    result: list[dict[str, object]] = []
    ids = ["P-01", "P-02", "P-03", "P-04", "PRESCREEN_DUPLICATE", *[f"P-{index:02d}" for index in range(5, 16)]]
    for gate_id in ids:
        gate_status = "RECORD" if gate_id in {"P-01", "P-03", "P-05", "P-06", "P-09", "P-11", "P-15"} else "PASS"
        if gate_id == "P-14":
            gate_status = status
        if gate_id == fail_id:
            gate_status = "FAIL"
        result.append(
            {
                "id": gate_id,
                "metric": f"synthetic {gate_id}",
                "value": values[gate_id],
                "threshold": "synthetic",
                "status": gate_status,
                "note": "is_degraded=False" if gate_id == "P-13" else "[]" if gate_id in {"P-04", "PRESCREEN_DUPLICATE"} else "",
            }
        )
    return result


def _s3_quality(*, dropped: int, status: str, fail_id: str | None = None) -> dict[str, object]:
    hard_ids = [fail_id] if fail_id is not None else (["P-14"] if status == "FAIL" else [])
    return {
        "gates": _s3_gates(dropped=dropped, status=status, fail_id=fail_id),
        "overallPass": not hard_ids,
        "hardFailIds": hard_ids,
        "notes": [],
        "p14ReleaseEvidence": _s3_release(dropped=dropped, status=status),
    }


def _s3_fixture(tmp_path, *, terminal="BATCH_READY", status="PASS", dropped=0, fail_id=None):
    """Independent synthetic producer; construction finishes before tripwires."""
    raw_paths = {}
    for name in handoff.RAW_FILE_NAMES:
        path = tmp_path / f"{name}.json"
        path.write_bytes(observation_mod.canonical_json_bytes({"synthetic": name}))
        raw_paths[name] = path
    digests = {
        path: hashlib.sha256((S3_REPO / path).read_bytes()).hexdigest()
        for path in handoff.FIXED_MODULE_PATHS
    }
    consumer = bundle.ConsumerIdentity(
        S3_EXECUTED_SHA,
        tuple((path, hashlib.sha256((S3_REPO / path).read_bytes()).hexdigest()) for path in bundle.CONSUMER_MODULE_PATHS),
    )
    capture = handoff.build_capture_input_bytes(
        joined_candidate_input=_s3_joined_input(), context=_s3_context(), join_stats=_s3_join_stats(),
        source_updated_at="2026-09-20T00:00:00.000Z", candidates_updated_at="2026-09-20T00:01:00.000Z",
    )
    joined, context = handoff.expected_input_digests_from_capture(capture)
    def record(payload):
        return {"sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload)}
    input_identity = {
        "rawFiles": {name: {"present": True, **record(path.read_bytes())} for name, path in raw_paths.items()},
        "joinedCandidateInput": {"sha256": joined.sha256, "bytes": joined.bytes},
        "replayContext": {"sha256": context.sha256, "bytes": context.bytes},
        "captureInput": record(capture),
    }
    observation = handoff.build_observation_bytes(
        policy_version=S3_POLICY, run_identity=S3_RUN,
        source_identity=_s3_source_identity(digests=digests), input_identity=input_identity,
        base=_s3_side(), perturbed=_s3_side(dropped=dropped),
    )
    report = {
        "context": _s3_context(), "joinStats": _s3_join_stats(), "prescreenDuplicateCodes": [],
        "qualityGate": _s3_quality(dropped=dropped, status=status, fail_id=fail_id), "engineStatus": "generated",
    }
    if terminal == "SCHEMA_VIOLATIONS":
        report["schemaViolations"] = ["synthetic reviewed schema violation"]
    receipt = handoff.build_batch_receipt_bytes({
        "schemaVersion": handoff.RECEIPT_SCHEMA_VERSION, "runIdentity": S3_RUN,
        "policyVersion": S3_POLICY, "executedGitSha": S3_EXECUTED_SHA,
        "observationDigest": record(observation)["sha256"], "captureInputDigest": record(capture)["sha256"],
        "terminalStatus": terminal, "artifactAvailable": terminal == "BATCH_READY",
        "transportStatus": "READY", "failureCode": None, "reportState": "COMPLETE", "report": report,
    }, observation_bytes=observation, capture_input_bytes=capture)
    parts, reference = handoff.build_handoff_parts(
        observation_bytes=observation, capture_input_bytes=capture, receipt_bytes=receipt,
    )
    root = tmp_path / "handoff"
    claim = handoff.claim_attempt(root, S3_RUN["runId"], S3_RUN["runAttempt"])
    handoff.write_handoff_parts(claim, parts)
    kwargs = dict(
        handoff_root=root, producer_reference=reference, run_identity=dict(S3_RUN),
        expected_policy_version=S3_POLICY, consumer=consumer, engine_versions=S3_VERSIONS,
        raw_paths=raw_paths,
        workflow=bundle.WorkflowStatus("batch_passed", "smoke_passed") if terminal == "BATCH_READY"
        else bundle.WorkflowStatus("batch_failed", None),
    )
    return kwargs, parts, reference


def _s3_evidence(files):
    return json.loads(files[bundle.EVIDENCE_FILE])


def _s3_invalid(files, code, stage=None, detail=None):
    value = _s3_evidence(files)
    assert value["captureStatus"] == "invalid"
    assert value["failure"]["code"] == code
    if stage is not None:
        assert value["failure"]["stage"] == stage
    assert value["failure"]["detail"] == detail
    assert set(files) == {bundle.EVIDENCE_FILE, bundle.PRIVACY_REPORT_FILE, bundle.MANIFEST_FILE, bundle.MANIFEST_DIGEST_FILE}
    assert not {"terminal", "attachments", "p14", "replay", "publish", "diagnostics"} & set(value)
    report = bundle.verify_bundle_files(files)
    assert report.bundle_integrity == "PASS"
    assert report.capture_validity == "INVALID"
    assert report.terminal_status is None and report.artifact_available is None
    return value


S3_TERMINALS = [
    ("BATCH_READY", "PASS", 0, None),
    ("QUALITY_GATE_FAILED", "FAIL", 2, None),
    ("QUALITY_GATE_FAILED", "PASS", 0, "P-10"),
    ("QUALITY_GATE_FAILED", "WARN", 1, "P-10"),
    ("SCHEMA_VIOLATIONS", "PASS", 0, None),
]


def _s3_tripwires(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("schema-3 computation forbidden")
    for name in (
        "_perturb_candidates", "compute_rank_stability", "compute_p14_release_evidence", "compute_quality_report",
        "build_candidate_funnel", "build_context", "build_prescreen_index", "join_candidates_with_prescreen",
        "load_candidates_stocks", "load_prescreen_metadata", "load_previous_artifact", "read_current_regime",
    ):
        monkeypatch.setattr(batch, name, forbidden)
    monkeypatch.setattr(engine, "build_candidate_funnel", forbidden)
    monkeypatch.setattr(evidence_mod, "build_candidate_funnel", forbidden)
    monkeypatch.setattr(evidence_mod, "build_evidence", forbidden)
    monkeypatch.setattr(evidence_mod, "replay_p14", forbidden)
    monkeypatch.setattr(evidence_mod, "reclassify_p14", forbidden)


@pytest.mark.parametrize("terminal,status,dropped,fail_id", S3_TERMINALS)
def test_schema3_layer_b_ah2_captured_truthful_terminals(tmp_path, monkeypatch, terminal, status, dropped, fail_id):
    kwargs, parts, reference = _s3_fixture(tmp_path, terminal=terminal, status=status, dropped=dropped, fail_id=fail_id)
    _s3_tripwires(monkeypatch)
    files = evidence_mod.build_evidence_from_handoff(**kwargs)
    report = bundle.verify_bundle_files(files)
    value = _s3_evidence(files)
    assert report.bundle_integrity == "PASS" and report.capture_validity == "VALID"
    assert report.terminal_status == terminal
    assert report.artifact_available is (terminal == "BATCH_READY")
    assert value["captureStatus"] == "captured"
    assert value["p14"]["verdict"] == status
    receipt = parts.receipt_value()
    assert value["p14"]["release"] == receipt["report"]["qualityGate"]["p14ReleaseEvidence"]
    assert value["p14"]["release"]["final"]["status"] == status
    assert value["terminal"]["transportStatus"] == "READY"
    assert value["terminal"]["terminalStatus"] == terminal
    assert value["terminal"]["artifactAvailable"] is (terminal == "BATCH_READY")
    assert value["producerReference"] == reference.to_value()
    assert files[value["attachments"]["observation"]["file"]] == parts.observation_bytes
    assert files[bundle.CAPTURE_ATTACHMENT_FILE] == parts.capture_input_bytes
    assert files[bundle.RECEIPT_ATTACHMENT_FILE] == parts.receipt_bytes
    assert files[bundle.ENVELOPE_ATTACHMENT_FILE] == parts.envelope_bytes
    assert set(value["runIdentity"]) == set(S3_RUN)
    assert not {"publish", "releaseSuccess", "publicationSuccess", "pages", "remotePush"} & set(value)
    if fail_id:
        assert receipt["report"]["qualityGate"]["hardFailIds"] == [fail_id]
        assert "P-14" not in receipt["report"]["qualityGate"]["hardFailIds"]
    if terminal == "SCHEMA_VIOLATIONS":
        assert receipt["report"]["qualityGate"]["overallPass"] is True
        assert receipt["report"]["schemaViolations"] == ["synthetic reviewed schema violation"]


def _s3_environment(monkeypatch, mode="enabled"):
    monkeypatch.setenv("P14_HANDOFF_MODE", mode)
    for field, name in {
        "repository": "GITHUB_REPOSITORY", "job": "GITHUB_JOB", "runId": "GITHUB_RUN_ID",
        "runAttempt": "GITHUB_RUN_ATTEMPT", "event": "GITHUB_EVENT_NAME", "gitRef": "GITHUB_REF",
        "gitRefType": "GITHUB_REF_TYPE", "gitSha": "GITHUB_SHA",
    }.items():
        monkeypatch.setenv(name, S3_RUN[field])
    monkeypatch.setenv("RUNNER_OS", "Linux")
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)


def _s3_cli_args(tmp_path, kwargs, *, reference=True):
    raw = kwargs["raw_paths"]
    args = ["--out", str(tmp_path / "output"), "--previous", str(raw["previousArtifact"]),
            "--candidates", str(raw["candidatesStocks"]), "--prescreen", str(raw["prescreenMetadata"]),
            "--regime", str(raw["regimeState"]), "--batch-status", kwargs["workflow"].batch_status]
    if kwargs["workflow"].smoke_status:
        args += ["--smoke-status", kwargs["workflow"].smoke_status]
    if reference:
        args += ["--p14-handoff-dir", str(kwargs["handoff_root"]), "--p14-expected-policy-version", S3_POLICY]
        names = {
            "status": "transport-status", "transportDigest": "handoff-digest", "observationDigest": "observation-digest",
            "receiptDigest": "receipt-digest", "captureInputDigest": "capture-input-digest",
            "executedGitSha": "executed-git-sha", "observationSchemaVersion": "observation-schema",
            "handoffSchemaVersion": "handoff-schema", "policyVersion": "policy-version", "runId": "run-id",
            "runAttempt": "run-attempt",
        }
        for key, name in names.items():
            args += [f"--p14-{name}", kwargs["producer_reference"].to_value()[key]]
    return args


@pytest.mark.parametrize("terminal,status,dropped,fail_id", S3_TERMINALS)
def test_schema3_cli_installs_captured_evidence_only(tmp_path, monkeypatch, capsys, terminal, status, dropped, fail_id):
    kwargs, _, _ = _s3_fixture(tmp_path, terminal=terminal, status=status, dropped=dropped, fail_id=fail_id)
    _s3_environment(monkeypatch)
    monkeypatch.setattr(evidence_mod, "_consumer_identity", lambda root: kwargs["consumer"])
    output = tmp_path / "github-output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    _s3_tripwires(monkeypatch)
    assert evidence_mod.main(_s3_cli_args(tmp_path, kwargs)) == 0
    captured = capsys.readouterr()
    assert captured.err == ""
    path = tmp_path / "output" / f"candidate-funnel-evidence-{S3_RUN['runId']}-1"
    assert captured.out == f"bundle_path={path}\n"
    assert output.read_text() == f"bundle_path={path}\n"
    files = bundle.read_bundle_directory(path)
    assert _s3_evidence(files)["terminal"]["terminalStatus"] == terminal
    assert _s3_evidence(files)["terminal"]["artifactAvailable"] is (terminal == "BATCH_READY")


def test_schema3_workflow_inconsistency_keeps_truthful_gate_status(tmp_path):
    kwargs, _, _ = _s3_fixture(tmp_path, terminal="QUALITY_GATE_FAILED", status="FAIL", dropped=2)
    kwargs["workflow"] = bundle.WorkflowStatus("batch_passed", None)
    value = _s3_invalid(evidence_mod.build_evidence_from_handoff(**kwargs), "WORKFLOW_STATUS_INCONSISTENT", "SELF_VERIFY")
    assert value["workflowStatus"] == {"batchStatus": "batch_passed", "smokeStatus": None}


@pytest.mark.parametrize("mode", ["Enabled", "1", "true", "yes", "", "DISABLED"])
def test_schema3_invalid_mode_is_configuration_invalid_without_fallback(tmp_path, monkeypatch, capsys, mode):
    kwargs, _, _ = _s3_fixture(tmp_path)
    _s3_environment(monkeypatch, mode)
    _s3_tripwires(monkeypatch)
    assert evidence_mod.main(_s3_cli_args(tmp_path, kwargs)) == 1
    path = tmp_path / "output" / "candidate-funnel-evidence-unknown-unknown"
    _s3_invalid(bundle.read_bundle_directory(path), "CONSUMER_CONFIGURATION_INVALID", "CONFIGURATION", "MODE")
    assert capsys.readouterr().out == f"bundle_path={path}\n"


def test_schema3_enabled_missing_evidence_installs_minimal_invalid(tmp_path, monkeypatch, capsys):
    kwargs, _, _ = _s3_fixture(tmp_path)
    _s3_environment(monkeypatch)
    monkeypatch.setattr(evidence_mod, "_consumer_identity", lambda root: kwargs["consumer"])
    _s3_tripwires(monkeypatch)
    assert evidence_mod.main(_s3_cli_args(tmp_path, kwargs, reference=False)) == 1
    path = tmp_path / "output" / f"candidate-funnel-evidence-{S3_RUN['runId']}-1"
    _s3_invalid(bundle.read_bundle_directory(path), "HANDOFF_MISSING", "REFERENCE", "PRODUCER_REFERENCE_MISSING")
    assert capsys.readouterr().out == f"bundle_path={path}\n"


@pytest.mark.parametrize("root_kind,reference_kind,code,detail", [
    ("absent", "none", "HANDOFF_MISSING", "PRODUCER_REFERENCE_MISSING"),
    ("present", "none", "PRODUCER_REFERENCE_MISSING", None),
    ("present", "partial", "PRODUCER_REFERENCE_MISSING", None),
    ("present", "nonready", "PRODUCER_REFERENCE_MISSING", None),
])
def test_schema3_missing_reference_precedence(tmp_path, root_kind, reference_kind, code, detail):
    kwargs, _, reference = _s3_fixture(tmp_path)
    if root_kind == "absent":
        kwargs["handoff_root"] = tmp_path / "absent"
    kwargs["producer_reference"] = None if reference_kind == "none" else reference.to_value()
    if reference_kind == "partial":
        kwargs["producer_reference"].pop("receiptDigest")
    if reference_kind == "nonready":
        kwargs["producer_reference"]["status"] = "P14_NOT_EVALUATED"
    _s3_invalid(evidence_mod.build_evidence_from_handoff(**kwargs), code, "REFERENCE", detail)


def test_schema3_binding_authorities_event_sha_raw_files_and_capture(tmp_path):
    kwargs, parts, _ = _s3_fixture(tmp_path)
    files = evidence_mod.build_evidence_from_handoff(**kwargs)
    value = _s3_evidence(files)
    expected = value["expectedBinding"]
    assert expected["eventGitSha"] == S3_RUN["gitSha"] != S3_EXECUTED_SHA
    assert expected["executedGitSha"] == value["consumerIdentity"]["executedGitSha"] == S3_EXECUTED_SHA
    assert tuple(item["path"] for item in expected["modules"]) == handoff.FIXED_MODULE_PATHS
    assert tuple(item["path"] for item in value["consumerIdentity"]["modules"]) == bundle.CONSUMER_MODULE_PATHS
    assert handoff.FIXED_MODULE_PATHS != bundle.CONSUMER_MODULE_PATHS
    for item in expected["modules"]:
        assert item["sha256"] == hashlib.sha256((S3_REPO / item["path"]).read_bytes()).hexdigest()
    for item in expected["rawFiles"]:
        raw = kwargs["raw_paths"][item["name"]].read_bytes()
        assert item == {"name": item["name"], "present": True, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
    capture = parts.capture_input_value()
    for field, captured in (("joinedCandidateInput", capture["joinedCandidateInput"]), ("replayContext", capture["context"])):
        raw = observation_mod.canonical_json_bytes(captured)
        assert expected[field] == {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
    assert expected["captureInput"] == {"sha256": hashlib.sha256(parts.capture_input_bytes).hexdigest(), "bytes": len(parts.capture_input_bytes)}


@pytest.mark.parametrize("fault,code,stage", [
    ("run", "RUN_ID_MISMATCH", "REFERENCE"), ("attempt", "RUN_ATTEMPT_MISMATCH", "REFERENCE"),
    ("policy", "POLICY_BINDING_MISMATCH", "REFERENCE"),
    ("observation_schema", "UNSUPPORTED_OBSERVATION_SCHEMA", "REFERENCE"),
    ("handoff_schema", "UNSUPPORTED_HANDOFF_SCHEMA", "REFERENCE"),
    ("executed", "SOURCE_IDENTITY_MISMATCH", "REFERENCE"),
    ("transport", "TRANSPORT_DIGEST_MISMATCH", "STORAGE"),
    ("observation", "OBSERVATION_DIGEST_MISMATCH", "STORAGE"),
    ("receipt", "BATCH_RECEIPT_INVALID", "STORAGE"),
    ("capture", "INPUT_IDENTITY_MISMATCH", "STORAGE"),
    ("raw", "INPUT_IDENTITY_MISMATCH", "ADMISSION"),
    ("event", "RUN_IDENTITY_MISMATCH", "ADMISSION"),
    ("version", "SOURCE_IDENTITY_MISMATCH", "ADMISSION"),
])
def test_schema3_provenance_negative_faults(tmp_path, fault, code, stage):
    kwargs, parts, ref = _s3_fixture(tmp_path)
    reference_changes = {
        "run": {"run_id": "900000099"}, "attempt": {"run_attempt": "2"},
        "policy": {"policy_version": "unknown-v2"}, "observation_schema": {"observation_schema_version": "unknown-2"},
        "handoff_schema": {"handoff_schema_version": "unknown-2"}, "executed": {"executed_git_sha": "3" * 40},
    }
    if fault in reference_changes:
        kwargs["producer_reference"] = replace(ref, **reference_changes[fault])
    elif fault in {"transport", "observation", "receipt", "capture"}:
        directory = kwargs["handoff_root"] / f"run-{S3_RUN['runId']}" / "attempt-1"
        filename = {"transport": handoff.HANDOFF_FILE, "observation": f"observation-{ref.observation_digest}.json",
                    "receipt": handoff.RECEIPT_FILE, "capture": handoff.CAPTURE_INPUT_FILE}[fault]
        path = directory / filename
        path.write_bytes(path.read_bytes() + b" ")
    elif fault == "raw":
        kwargs["raw_paths"]["candidatesStocks"].write_bytes(b"synthetic changed raw")
    elif fault == "event":
        kwargs["run_identity"]["gitSha"] = "4" * 40
    else:
        kwargs["engine_versions"] = ("unknown-2", *S3_VERSIONS[1:])
    _s3_invalid(evidence_mod.build_evidence_from_handoff(**kwargs), code, stage, "DIGEST_MISMATCH" if fault == "receipt" else None)


@pytest.mark.parametrize("kind", ["joined", "context", "module"])
def test_schema3_binding_mismatch_uses_admission_authority(tmp_path, monkeypatch, kind):
    kwargs, parts, _ = _s3_fixture(tmp_path)
    if kind == "module":
        # A valid profile with a coherent digest chain but wrong producer provenance.
        observed = parts.observation_value()
        observed["sourceIdentity"]["modules"][0]["sha256"] = "f" * 64
        observation = observation_mod.canonical_json_bytes(observed)
        receipt = parts.receipt_value()
        receipt["observationDigest"] = hashlib.sha256(observation).hexdigest()
        receipt_bytes = handoff.build_batch_receipt_bytes(receipt, observation_bytes=observation, capture_input_bytes=parts.capture_input_bytes)
        changed, reference = handoff.build_handoff_parts(
            observation_bytes=observation, capture_input_bytes=parts.capture_input_bytes, receipt_bytes=receipt_bytes,
        )
        root = tmp_path / "wrong-module"
        handoff.write_handoff_parts(handoff.claim_attempt(root, S3_RUN["runId"], "1"), changed)
        kwargs.update(handoff_root=root, producer_reference=reference)
    else:
        # A faulty composition binding must be rejected by the unchanged validator.
        derive = handoff.expected_input_digests_from_capture
        def wrong(payload):
            joined, context = derive(payload)
            bad = handoff.DigestBinding("f" * 64, 7)
            return (bad, context) if kind == "joined" else (joined, bad)
        monkeypatch.setattr(handoff, "expected_input_digests_from_capture", wrong)
    _s3_invalid(evidence_mod.build_evidence_from_handoff(**kwargs), "SOURCE_IDENTITY_MISMATCH" if kind == "module" else "INPUT_IDENTITY_MISMATCH", "ADMISSION")


def test_schema3_first_fault_configuration_reference_storage_admission(tmp_path):
    kwargs, _, ref = _s3_fixture(tmp_path)
    kwargs["producer_reference"] = replace(ref, run_id="900000099", run_attempt="2", policy_version="unknown", executed_git_sha="3" * 40)
    kwargs["expected_policy_version"] = "unknown"
    _s3_invalid(evidence_mod.build_evidence_from_handoff(**kwargs), "POLICY_BINDING_MISMATCH", "CONFIGURATION")
    kwargs["expected_policy_version"] = S3_POLICY
    _s3_invalid(evidence_mod.build_evidence_from_handoff(**kwargs), "RUN_ID_MISMATCH", "REFERENCE")
    kwargs["producer_reference"] = replace(kwargs["producer_reference"], run_id=S3_RUN["runId"])
    _s3_invalid(evidence_mod.build_evidence_from_handoff(**kwargs), "RUN_ATTEMPT_MISMATCH", "REFERENCE")
    kwargs["producer_reference"] = replace(kwargs["producer_reference"], run_attempt="1")
    _s3_invalid(evidence_mod.build_evidence_from_handoff(**kwargs), "POLICY_BINDING_MISMATCH", "REFERENCE")
    kwargs["producer_reference"] = ref
    directory = kwargs["handoff_root"] / f"run-{S3_RUN['runId']}" / "attempt-1"
    (directory / handoff.HANDOFF_FILE).write_bytes(b"malformed envelope")
    (directory / handoff.CAPTURE_INPUT_FILE).write_bytes(b"malformed capture")
    kwargs["raw_paths"]["previousArtifact"].write_bytes(b"wrong raw")
    _s3_invalid(evidence_mod.build_evidence_from_handoff(**kwargs), "TRANSPORT_DIGEST_MISMATCH", "STORAGE")


def test_schema3_composition_order_is_reference_anchored(tmp_path, monkeypatch):
    kwargs, _, _ = _s3_fixture(tmp_path)
    events = []
    for owner, name in (
        (handoff, "read_handoff_part_bytes"), (handoff, "expected_input_digests_from_capture"),
        (handoff, "ExpectedBinding"), (handoff, "validate_handoff_parts"),
        (evidence_mod, "build_captured_bundle"), (evidence_mod, "verify_bundle_files"),
    ):
        original = getattr(owner, name)
        def wrap(*args, _name=name, _original=original, **kw):
            events.append(_name)
            return _original(*args, **kw)
        monkeypatch.setattr(owner, name, wrap)
    for name in ("observation_value", "capture_input_value", "receipt_value"):
        original = getattr(handoff.HandoffParts, name)
        def decode(self, _name=name, _original=original):
            events.append(_name)
            return _original(self)
        monkeypatch.setattr(handoff.HandoffParts, name, decode)
    assert _s3_evidence(evidence_mod.build_evidence_from_handoff(**kwargs))["captureStatus"] == "captured"
    before_build = events[:events.index("build_captured_bundle") + 1]
    assert before_build[:4] == ["read_handoff_part_bytes", "expected_input_digests_from_capture", "ExpectedBinding", "validate_handoff_parts"]
    assert before_build[-4:] == ["observation_value", "capture_input_value", "receipt_value", "build_captured_bundle"]
    assert events.index("verify_bundle_files") > events.index("build_captured_bundle")


def _s3_baseline_source():
    # Read the exact pinned implementation, never rewrite or adjust the baseline.
    return subprocess.run(
        ["git", "-C", str(S3_REPO), "show", f"{S3_BASELINE}:data/candidate_funnel_run_evidence.py"],
        check=True, capture_output=True, text=True,
    ).stdout


def _s3_baseline_module():
    module = types.ModuleType("_phase3c_pinned_legacy")
    module.__file__ = str(S3_REPO / "data/candidate_funnel_run_evidence.py")
    exec(compile(_s3_baseline_source(), module.__file__, "exec"), module.__dict__)
    return module


def _s3_legacy_inputs(tmp_path):
    rows = _s3_joined_input()
    entries = [
        {"code": row["code"], "prescreenScore": row["prescreenScore"], "prescreenRank": row["prescreenRank"], "prescreenPool": row["prescreenPool"]}
        for row in rows
    ]
    stripped = [{key: value for key, value in row.items() if key not in {"prescreenScore", "prescreenRank", "prescreenPool"}} for row in rows]
    paths = [tmp_path / name for name in ("candidates.json", "prescreen.json", "regime.json", "previous.json")]
    payloads = [_candidates_stocks_payload(stripped), _prescreen_payload(entries),
                {"regime_state": {"current_regime": "bull_calm"}}, {"status": "not_generated"}]
    for path, payload in zip(paths, payloads):
        _write_json(path, payload)
    return paths


@pytest.mark.parametrize("mode", [None, "disabled"])
def test_schema3_layer_f_legacy_cli_bytes_equal_pinned_baseline(tmp_path, monkeypatch, capsys, mode):
    baseline = _s3_baseline_module()
    _s3_environment(monkeypatch)
    if mode is None:
        monkeypatch.delenv("P14_HANDOFF_MODE")
    else:
        monkeypatch.setenv("P14_HANDOFF_MODE", mode)
    def frozen_builder(original):
        def build(**kwargs):
            return original(**kwargs, now=NOW)
        return build
    monkeypatch.setattr(baseline, "build_evidence", frozen_builder(baseline.build_evidence))
    monkeypatch.setattr(evidence_mod, "build_evidence", frozen_builder(evidence_mod.build_evidence))
    def no_schema3(*args, **kwargs):
        raise AssertionError("legacy route entered schema-3")
    monkeypatch.setattr(evidence_mod, "build_evidence_from_handoff", no_schema3)
    monkeypatch.setattr(evidence_mod, "_consumer_identity", no_schema3)
    candidates, prescreen, regime, previous = _s3_legacy_inputs(tmp_path)
    args = ["--out", str(tmp_path / "legacy"), "--previous", str(previous), "--candidates", str(candidates),
            "--prescreen", str(prescreen), "--regime", str(regime), "--batch-status", "batch_failed"]
    assert baseline.main(args) == 0
    baseline_output = capsys.readouterr()
    root = tmp_path / "legacy" / f"candidate-funnel-evidence-{S3_RUN['runId']}-1"
    expected = {path.relative_to(root).as_posix(): path.read_bytes() for path in root.rglob("*") if path.is_file()}
    shutil.rmtree(root)
    assert evidence_mod.main(args) == 0
    assert capsys.readouterr() == baseline_output
    actual = {path.relative_to(root).as_posix(): path.read_bytes() for path in root.rglob("*") if path.is_file()}
    assert actual == expected
    assert json.loads(actual["evidence.json"])["schemaVersion"] == "candidate-funnel-run-evidence-2"


def test_schema3_protected_legacy_ast_and_exact_batch_contract():
    before = ast.parse(_s3_baseline_source())
    after = ast.parse(inspect.getsource(evidence_mod))
    names = {
        "build_evidence", "replay_p14", "reclassify_p14", "write_bundle", "_replay_payload", "_full_rank_vector",
        "_jaccard_from_vectors", "_replay_candidate_input", "_file_hash", "_canonical_bytes", "_write_json",
        "_find_gate", "_run_identity_from_environment",
    }
    old = {node.name: ast.dump(node, include_attributes=False) for node in before.body if isinstance(node, ast.FunctionDef) and node.name in names}
    new = {node.name: ast.dump(node, include_attributes=False) for node in after.body if isinstance(node, ast.FunctionDef) and node.name in names}
    assert set(old) == set(new) == names
    assert new == old
    for name in ("SCHEMA_VERSION", "LEGACY_SCHEMA_VERSION", "REPLAY_SCHEMA_VERSION", "BOUNDARY_OUTSIDE_BAND_SIZE"):
        old_node = next(node for node in before.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets))
        new_node = next(node for node in after.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets))
        assert ast.dump(old_node) == ast.dump(new_node)
    certified = set("CANDIDATES_STOCKS_PATH CandidateFunnelBatchError P14_ASSIGNMENT_CONTRACT P14_RELEASE_POLICY_VERSION PERTURBATION_PCT PRESCREEN_METADATA_PATH RANK_STABILITY_JACCARD_MIN REGIME_STATE_PATH TOP_N_STABILITY build_context build_prescreen_index compute_p14_release_evidence compute_quality_report compute_rank_stability join_candidates_with_prescreen load_candidates_stocks load_prescreen_metadata load_previous_artifact read_current_regime".split())
    def members(tree):
        return {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "batch"}
    assert len(certified) == 19
    assert members(before) == members(after) == certified
    assert evidence_mod.REPLAY_CANDIDATE_FIELDS is observation_mod.REPLAY_CANDIDATE_FIELDS


def test_schema3_composition_static_zero_computation_and_no_environment():
    node = ast.parse(inspect.getsource(evidence_mod.build_evidence_from_handoff))
    forbidden = {
        "batch", "build_candidate_funnel", "compute_rank_stability", "_perturb_candidates",
        "compute_p14_release_evidence", "compute_quality_report", "build_context", "build_prescreen_index",
        "join_candidates_with_prescreen", "replay_p14", "reclassify_p14", "build_evidence",
        "load_candidates_stocks", "load_prescreen_metadata", "load_previous_artifact", "read_current_regime",
        "environ", "getenv",
    }
    identifiers = {item.id for item in ast.walk(node) if isinstance(item, ast.Name)}
    attributes = {item.attr for item in ast.walk(node) if isinstance(item, ast.Attribute)}
    assert not forbidden & (identifiers | attributes)
    for item in ast.walk(node):
        if isinstance(item, ast.Constant) and isinstance(item.value, str):
            assert not item.value.startswith(("GITHUB_", "RUNNER_TEMP", "P14_"))
    signature = inspect.signature(evidence_mod.build_evidence_from_handoff)
    assert tuple(signature.parameters) == (
        "handoff_root", "producer_reference", "run_identity", "expected_policy_version", "consumer", "engine_versions", "raw_paths", "workflow",
    )
    assert all(parameter.kind == inspect.Parameter.KEYWORD_ONLY for parameter in signature.parameters.values())


def test_schema3_vector_parity_ties_null_ranks_and_40_50_band():
    rows = []
    for index in range(54):
        rows.append({
            "code": f"SYN-{53-index:03d}", "marketRank": index // 2 + 1,
            "marketScore": 100.0 - index, "rawCompositeScore": 1.0 - index / 100,
            "prescreenScore": 90.0 - index, "prescreenRank": index + 1, "prescreenPool": "synthetic",
        })
    rows += [{**rows[0], "code": "SYN-NULL-1", "marketRank": None}, {**rows[1], "code": "SYN-NULL-2", "marketRank": None}]
    rows.reverse()
    original = copy.deepcopy(rows)
    legacy = evidence_mod._full_rank_vector({"candidates": rows})
    projected = observation_mod.project_rank_vector(rows)
    assert len(legacy) == 54
    assert legacy == projected
    expected = sorted((row for row in rows if row["marketRank"] is not None), key=lambda row: (row["marketRank"], row["code"]))
    assert [row["code"] for row in legacy] == [row["code"] for row in expected]
    fields = {"code", "prescreenScore", "prescreenRank", "prescreenPool", "marketRank", "marketScore", "rawCompositeScore"}
    assert all(set(row) == fields and len(row) == 7 for row in legacy)
    assert legacy[40:50] == projected[40:50]
    assert len(legacy[40:50]) == evidence_mod.BOUNDARY_OUTSIDE_BAND_SIZE == 10
    assert legacy[39]["code"] != legacy[40]["code"]
    assert legacy[49]["code"] != legacy[50]["code"]
    assert rows == original


def test_schema3_layer_ge_cross_route_ownership(tmp_path):
    kwargs, parts, _ = _s3_fixture(tmp_path)
    legacy_root = tmp_path / "legacy-inputs"
    legacy_root.mkdir()
    candidates, prescreen, regime, previous = _s3_legacy_inputs(legacy_root)
    legacy = evidence_mod.build_evidence(
        run_identity=copy.deepcopy(RUN_IDENTITY), candidates_path=candidates, prescreen_path=prescreen,
        regime_path=regime, previous_path=previous, batch_status="batch_failed", smoke_status="", now=NOW,
    )
    files = evidence_mod.build_evidence_from_handoff(**kwargs)
    untouched = dict(files)
    decoded = _s3_evidence(files)
    def containers(value):
        if isinstance(value, (dict, list)):
            yield id(value)
            children = value.values() if isinstance(value, dict) else value
            for child in children:
                yield from containers(child)
    assert not set(containers(legacy)) & set(containers(decoded))
    before_legacy = copy.deepcopy(legacy)
    decoded["p14"]["release"]["final"]["status"] = "mutated"
    decoded["expectedBinding"]["captureInput"]["sha256"] = "f" * 64
    view = parts.observation_value()
    view["base"]["candidates"][0]["marketScore"] = -999
    parts.capture_input_value()["context"]["asOf"] = "mutated"
    assert legacy == before_legacy
    legacy["runIdentity"]["gitSha"] = "mutated"
    legacy["inputHashes"].clear()
    assert dict(files) == untouched
    assert _s3_evidence(files)["p14"]["release"]["final"]["status"] == "PASS"
    assert parts.observation_value()["base"]["candidates"][0]["marketScore"] != -999
    assert bundle.verify_bundle_files(files).bundle_integrity == "PASS"
    with pytest.raises(TypeError):
        files.files["evidence.json"] = b"mutated"


def test_schema3_explicit_api_minimal_environment_subprocess(tmp_path):
    kwargs, _, ref = _s3_fixture(tmp_path)
    # The child invokes only the explicit API, with no GITHUB_*, P14_* or runner state.
    script = '''
import json, sys
from pathlib import Path
from data.candidate_funnel_run_evidence import build_evidence_from_handoff
from data.p14_run_evidence_bundle import ConsumerIdentity, WorkflowStatus, verify_bundle_files
value = json.loads(sys.argv[1])
value["consumer"] = ConsumerIdentity(value["consumer"]["sha"], tuple(tuple(row) for row in value["consumer"]["modules"]))
value["workflow"] = WorkflowStatus("batch_passed", "smoke_passed")
value["engine_versions"] = tuple(value["engine_versions"])
report = verify_bundle_files(build_evidence_from_handoff(**value))
assert report.bundle_integrity == "PASS" and report.capture_validity == "VALID", report.to_value()
print("captured evidence")
'''
    serializable = {**kwargs, "handoff_root": str(kwargs["handoff_root"]), "producer_reference": ref.to_value(),
                    "raw_paths": {name: str(path) for name, path in kwargs["raw_paths"].items()},
                    "consumer": {"sha": kwargs["consumer"].executed_git_sha, "modules": kwargs["consumer"].modules}, "workflow": None}
    result = subprocess.run([sys.executable, "-B", "-c", script, json.dumps(serializable)],
                            cwd=S3_REPO, env={"PYTHONDONTWRITEBYTECODE": "1"}, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert result.stdout == "captured evidence\n"


@pytest.mark.parametrize("kind,code,stage", [
    ("build", "BUNDLE_BUILD_FAILED", "BUILD"),
    ("self_verify", "SELF_VERIFICATION_FAILED", "SELF_VERIFY"),
    ("privacy", "BUNDLE_PRIVACY_VIOLATION", "PRIVACY"),
])
def test_schema3_build_self_verify_privacy_failures_are_static_minimal(tmp_path, monkeypatch, kind, code, stage):
    kwargs, _, _ = _s3_fixture(tmp_path)
    private = "/Users/synthetic/private/input"
    secret = "gh" + "p_" + "x" * 36
    if kind == "self_verify":
        failed = bundle.verify_bundle_files({})
        monkeypatch.setattr(evidence_mod, "verify_bundle_files", lambda files: failed)
    else:
        def fail(*args, **kw):
            if kind == "privacy":
                raise bundle.EvidenceBundleError("BUNDLE_PRIVACY_VIOLATION")
            raise RuntimeError(private + secret)
        monkeypatch.setattr(evidence_mod, "build_captured_bundle", fail)
    files = evidence_mod.build_evidence_from_handoff(**kwargs)
    _s3_invalid(files, code, stage)
    for payload in files.values():
        assert private.encode() not in payload and secret.encode() not in payload


@pytest.mark.parametrize("fault", ["identity", "root", "workflow", "versions", "raw_paths", "consumer"])
def test_schema3_configuration_failures_are_minimal(tmp_path, fault):
    kwargs, _, _ = _s3_fixture(tmp_path)
    if fault == "identity":
        kwargs["run_identity"]["runnerOs"] = "Linux"
    elif fault == "root":
        kwargs["handoff_root"] = Path("relative")
    elif fault == "workflow":
        kwargs["workflow"] = {"batchStatus": "batch_passed", "smokeStatus": None}
    elif fault == "versions":
        kwargs["engine_versions"] = ()
    elif fault == "raw_paths":
        kwargs["raw_paths"] = {}
    else:
        kwargs["consumer"] = None
    files = evidence_mod.build_evidence_from_handoff(**kwargs)
    value = _s3_evidence(files)
    assert value["failure"]["code"] == "CONSUMER_CONFIGURATION_INVALID"
    assert value["failure"]["stage"] == "CONFIGURATION"
    assert bundle.verify_bundle_files(files).capture_validity == "INVALID"


def test_schema3_consumer_identity_uses_executed_head_and_exact_modules(monkeypatch):
    seen = []
    def git(command, **kwargs):
        seen.append((command, kwargs))
        return types.SimpleNamespace(stdout=S3_EXECUTED_SHA + "\n")
    monkeypatch.setattr(evidence_mod.subprocess, "run", git)
    identity = evidence_mod._consumer_identity(S3_REPO)
    assert identity.executed_git_sha == S3_EXECUTED_SHA != S3_RUN["gitSha"]
    assert seen[0][0] == ["git", "-C", str(S3_REPO), "rev-parse", "HEAD"]
    assert tuple(path for path, digest in identity.modules) == bundle.CONSUMER_MODULE_PATHS
    assert identity.modules == tuple((path, hashlib.sha256((S3_REPO / path).read_bytes()).hexdigest()) for path in bundle.CONSUMER_MODULE_PATHS)


def test_schema3_cli_installer_no_overwrite_no_repair_retry_or_fallback(tmp_path, monkeypatch, capsys):
    kwargs, _, _ = _s3_fixture(tmp_path)
    _s3_environment(monkeypatch)
    monkeypatch.setattr(evidence_mod, "_consumer_identity", lambda root: kwargs["consumer"])
    _s3_tripwires(monkeypatch)
    args = _s3_cli_args(tmp_path, kwargs)
    calls = []
    original = bundle.install_bundle
    def install(out, files):
        calls.append(out)
        return original(out, files)
    monkeypatch.setattr(evidence_mod, "install_bundle", install)
    assert evidence_mod.main(args) == 0
    path = tmp_path / "output" / f"candidate-funnel-evidence-{S3_RUN['runId']}-1"
    before = {item.relative_to(path).as_posix(): item.read_bytes() for item in path.rglob("*") if item.is_file()}
    capsys.readouterr()
    assert evidence_mod.main(args) == 1
    captured = capsys.readouterr()
    assert captured.out == "" and captured.err == "BUNDLE_ALREADY_EXISTS\n"
    assert len(calls) == 2  # One delegation per invocation, including the rejected install.
    assert {item.relative_to(path).as_posix(): item.read_bytes() for item in path.rglob("*") if item.is_file()} == before


def test_schema3_cli_install_failure_static_error_single_delegation(tmp_path, monkeypatch, capsys):
    kwargs, _, _ = _s3_fixture(tmp_path)
    _s3_environment(monkeypatch)
    monkeypatch.setattr(evidence_mod, "_consumer_identity", lambda root: kwargs["consumer"])
    _s3_tripwires(monkeypatch)
    calls = []
    def fail(out, files):
        calls.append(out)
        raise OSError("/Users/synthetic/private/disk")
    monkeypatch.setattr(evidence_mod, "install_bundle", fail)
    assert evidence_mod.main(_s3_cli_args(tmp_path, kwargs)) == 1
    captured = capsys.readouterr()
    assert captured.out == "" and captured.err == "BUNDLE_WRITE_FAILED\n"
    assert len(calls) == 1
    assert not (tmp_path / "output").exists()


@pytest.mark.parametrize("policy", [None, "", "unknown", "p14-decision-aware-v2", 1])
def test_schema3_policy_configuration_has_no_fallback(tmp_path, policy):
    kwargs, _, _ = _s3_fixture(tmp_path)
    kwargs["expected_policy_version"] = policy
    _s3_invalid(evidence_mod.build_evidence_from_handoff(**kwargs), "POLICY_BINDING_MISMATCH", "CONFIGURATION")


@pytest.mark.parametrize("value", ["/Users/synthetic/private/input", "gh" + "p_" + "x" * 36, "bad\ud800"])
def test_schema3_invalid_identity_never_leaks_untrusted_metadata(tmp_path, value):
    kwargs, _, _ = _s3_fixture(tmp_path)
    kwargs["run_identity"]["repository"] = value
    files = evidence_mod.build_evidence_from_handoff(**kwargs)
    ev = _s3_invalid(files, "CONSUMER_CONFIGURATION_INVALID", "CONFIGURATION", "RUN_IDENTITY")
    assert ev["runIdentity"] is None
    assert all(value.encode("utf-8", errors="backslashreplace") not in payload for payload in files.values())


def test_schema3_typed_builder_failure_preserves_static_detail(tmp_path, monkeypatch):
    kwargs, _, _ = _s3_fixture(tmp_path)
    def invalid_diagnostics(*args, **kw):
        raise bundle.EvidenceBundleError("BUNDLE_BUILD_FAILED", "DIAGNOSTICS_INVALID")
    monkeypatch.setattr(evidence_mod, "build_captured_bundle", invalid_diagnostics)
    _s3_invalid(evidence_mod.build_evidence_from_handoff(**kwargs), "BUNDLE_BUILD_FAILED", "BUILD", "DIAGNOSTICS_INVALID")


def test_schema3_cli_self_verify_failure_installs_minimal_invalid(tmp_path, monkeypatch, capsys):
    kwargs, _, _ = _s3_fixture(tmp_path)
    _s3_environment(monkeypatch)
    monkeypatch.setattr(evidence_mod, "_consumer_identity", lambda root: kwargs["consumer"])
    failed = bundle.verify_bundle_files({})
    monkeypatch.setattr(evidence_mod, "verify_bundle_files", lambda files: failed)
    _s3_tripwires(monkeypatch)
    assert evidence_mod.main(_s3_cli_args(tmp_path, kwargs)) == 1
    path = tmp_path / "output" / f"candidate-funnel-evidence-{S3_RUN['runId']}-1"
    _s3_invalid(bundle.read_bundle_directory(path), "SELF_VERIFICATION_FAILED", "SELF_VERIFY")
    assert capsys.readouterr().out == f"bundle_path={path}\n"


@pytest.mark.parametrize("first", range(6))
def test_schema3_simultaneous_reference_faults_preserve_public_api_order(tmp_path, first):
    kwargs, _, ref = _s3_fixture(tmp_path)
    faults = [
        ("run_id", "900000099", "RUN_ID_MISMATCH"),
        ("run_attempt", "2", "RUN_ATTEMPT_MISMATCH"),
        ("policy_version", "unknown", "POLICY_BINDING_MISMATCH"),
        ("observation_schema_version", "unknown", "UNSUPPORTED_OBSERVATION_SCHEMA"),
        ("handoff_schema_version", "unknown", "UNSUPPORTED_HANDOFF_SCHEMA"),
        ("executed_git_sha", "3" * 40, "SOURCE_IDENTITY_MISMATCH"),
    ]
    kwargs["producer_reference"] = replace(ref, **{name: value for name, value, _ in faults[first:]})
    # Storage and raw failures must not preempt reference identity failures.
    directory = kwargs["handoff_root"] / f"run-{S3_RUN['runId']}" / "attempt-1"
    (directory / handoff.HANDOFF_FILE).write_bytes(b"synthetic corrupted envelope")
    kwargs["raw_paths"]["candidatesStocks"].write_bytes(b"synthetic corrupted raw")
    _s3_invalid(evidence_mod.build_evidence_from_handoff(**kwargs), faults[first][2], "REFERENCE")


@pytest.mark.parametrize("first", range(4))
def test_schema3_simultaneous_storage_faults_preserve_public_api_order(tmp_path, first):
    kwargs, _, ref = _s3_fixture(tmp_path)
    faults = [
        (handoff.HANDOFF_FILE, "TRANSPORT_DIGEST_MISMATCH", None),
        (f"observation-{ref.observation_digest}.json", "OBSERVATION_DIGEST_MISMATCH", None),
        (handoff.RECEIPT_FILE, "BATCH_RECEIPT_INVALID", "DIGEST_MISMATCH"),
        (handoff.CAPTURE_INPUT_FILE, "INPUT_IDENTITY_MISMATCH", None),
    ]
    directory = kwargs["handoff_root"] / f"run-{S3_RUN['runId']}" / "attempt-1"
    for filename, _, _ in faults[first:]:
        path = directory / filename
        path.write_bytes(path.read_bytes() + b" ")
    kwargs["raw_paths"]["candidatesStocks"].write_bytes(b"synthetic corrupted raw")
    _s3_invalid(evidence_mod.build_evidence_from_handoff(**kwargs), faults[first][1], "STORAGE", faults[first][2])


def test_schema3_cli_configuration_fault_preempts_missing_reference(tmp_path, monkeypatch, capsys):
    kwargs, _, _ = _s3_fixture(tmp_path)
    _s3_environment(monkeypatch)
    def no_identity(*args):
        raise AssertionError("configuration should fire before checkout identity")
    monkeypatch.setattr(evidence_mod, "_consumer_identity", no_identity)
    args = _s3_cli_args(tmp_path, kwargs, reference=False) + ["--p14-expected-policy-version", "unknown"]
    assert evidence_mod.main(args) == 1
    path = tmp_path / "output" / "candidate-funnel-evidence-unknown-unknown"
    _s3_invalid(bundle.read_bundle_directory(path), "POLICY_BINDING_MISMATCH", "CONFIGURATION")
    assert capsys.readouterr().out == f"bundle_path={path}\n"
