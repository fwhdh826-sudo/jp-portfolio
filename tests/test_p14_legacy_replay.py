"""Frozen P14-E4 tests E4-T-01..24 using synthetic temporary evidence only."""
from __future__ import annotations

import copy
import json
import os
import subprocess
import tarfile
from dataclasses import replace
from pathlib import Path

import pytest

from data import candidate_funnel_batch as batch
from data import p14_evidence_capture as capture
from data import p14_evidence_validate as validator
from data import p14_legacy_replay as replay

REPO = Path(__file__).parents[1]


def _write(path: Path, value: object) -> None:
    capture.write_json(path, value)


@pytest.fixture
def legacy_bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    source_id = "current-dev-committed-20260726"
    base_profile = replay.LEGACY_SOURCES[source_id]
    candidates_raw = (REPO / "data/candidates_stocks.json").read_bytes()
    candidates_payload = json.loads(candidates_raw)
    funnel = json.loads((REPO / "data/candidate_funnel.json").read_text())
    prescreen_payload = {
        "schemaVersion": "prescreen-metadata-1", "generatedAt": base_profile.replay_as_of,
        "entries": [
            {key: row[key] for key in ("code", "prescreenScore", "prescreenRank", "prescreenPool")}
            for row in funnel["candidates"]
        ],
    }
    prescreen_raw = json.dumps(prescreen_payload, separators=(",", ":")).encode()
    regime_raw = (REPO / "data/regime_state.json").read_bytes()
    regime_payload = json.loads(regime_raw)
    prescreen_index, duplicates = batch.build_prescreen_index(prescreen_payload)
    assert duplicates == []
    joined, _ = batch.join_candidates_with_prescreen(candidates_payload["candidates"],
                                                     prescreen_index)
    hashes = capture.compute_input_hashes(candidates_raw, prescreen_raw, regime_raw, joined)
    profile = replace(base_profile, input_bundle_hash=hashes[0], market_content_hash=hashes[1],
                      population_hash=hashes[2], prescreen_hash=hashes[3])
    monkeypatch.setitem(replay.LEGACY_SOURCES, source_id, profile)
    source_files = {"candidates_stocks.json": candidates_raw,
                    "prescreen_metadata.json": prescreen_raw,
                    "regime_state.json": regime_raw}
    source_bundle_hash = replay._source_hash(profile, source_files)
    root = tmp_path / "synthetic-legacy-bundle"
    snapshot = root / "snapshots" / f"reeval-{source_id}"
    inputs = snapshot / "inputs/data"
    inputs.mkdir(parents=True)
    (inputs / "candidates_stocks.json").write_bytes(candidates_raw)
    (inputs / "prescreen_metadata.json").write_bytes(prescreen_raw)
    (inputs / "regime_state.json").write_bytes(regime_raw)
    _write(snapshot / "inputs/joined_candidates.json", {"candidates": joined})
    configuration = {
        "context": {"pipelinePath": "normal", "regime": "uncertain",
                    "sourceUpdatedAt": candidates_payload["sourceUpdatedAt"],
                    "asOf": profile.replay_as_of, "staleThresholdHours": 48,
                    "prescreenFallbackUsed": False, "sourceStale": False,
                    "fallbackProvenance": False},
        "productionThreshold": batch.RANK_STABILITY_JACCARD_MIN,
        "productionTopK": batch.TOP_N_STABILITY,
        "productionPerturbationPct": batch.PERTURBATION_PCT,
        "assignmentContract": batch.P14_ASSIGNMENT_CONTRACT,
    }
    _write(snapshot / "inputs/configuration.json", configuration)
    generator_hashes = {}
    for relative in capture.GENERATOR_PATHS:
        raw = (REPO / relative).read_bytes()
        generator_hashes[relative] = capture.sha256_bytes(raw)
        copied = snapshot / "inputs/production_code/data" / Path(relative).name
        copied.parent.mkdir(parents=True, exist_ok=True)
        copied.write_text(capture.normalize_private_paths(raw.decode("utf-8")))
    _write(root / "environment.json", {
        "runnerOs": "Darwin", "runnerArch": "arm64", "pythonVersion": "3.11.14",
        "pipFreeze": ["pytest==9.0.2"], "locale": "C.UTF-8", "timezone": "UTC",
        "pythonHashSeed": "0",
    })

    _write(snapshot / "snapshot.json", {
        "snapshotId": f"reeval-{source_id}", "evidenceClass": "real_reconstructed",
        "prescreenBytesReconstructed": True,
    })
    rerun = {"assignmentMapSha256": "0" * 64, "baseRankSha256": "a" * 64,
             "perturbedRankSha256": "b" * 64, "metricsSha256": "c" * 64,
             "verdict": "PASS"}
    production = {"baseTop": [], "perturbedTop": [], "jaccard": 1.0, "retention": 1.0,
                  "swapCount": 0, "verdict": "PASS",
                  "assignmentContract": batch.P14_ASSIGNMENT_CONTRACT,
                  "assignmentNote": batch.P14_ASSIGNMENT_NOTE}
    _write(snapshot / "reruns/five-reruns.json", [dict(rerun, run=n) for n in range(1, 6)])
    for number in range(1, 6):
        _write(snapshot / f"ranks/run-{number}-full-rank-vector.json", joined)
        _write(snapshot / f"metrics/run-{number}-metrics.json", {"productionP14": production})
    permutations = []
    for case in capture.PERMUTATION_CASES:
        row = {"case": case, "verdict": "PASS", "unperturbedScoreChangedCount": 0,
               "unperturbedRankChangedCount": 0}
        permutations.append(row)
        _write(snapshot / "permutations" / case / "production-p14.json", row)
        _write(snapshot / "permutations" / case / "full-rank-vector.json", joined)
    _write(snapshot / "metrics/input-order-permutations.json", permutations)
    signs = batch._p14_canonical_sign_by_code(joined)
    ordinals = {code: number for number, code in enumerate(signs)}
    _write(snapshot / "metrics/production-perturbation-assignment.json", {
        "perturbationPct": batch.PERTURBATION_PCT,
        "assignmentAuthority": batch.P14_ASSIGNMENT_CONTRACT,
        "assignmentNote": batch.P14_ASSIGNMENT_NOTE,
        "records": [{"code": row["code"], "canonicalOrdinal": ordinals[row["code"]],
                     "sign": signs[row["code"]],
                     "perMultiplier": 1 + signs[row["code"]] * batch.PERTURBATION_PCT,
                     "roeMultiplier": 1 - signs[row["code"]] * batch.PERTURBATION_PCT}
                    for row in joined],
    })
    for relative in (
        "metrics/production-p14.json",
        "metrics/boundary-ranks-30-50.json",
        "metrics/score-decomposition-boundary.json",
        "metrics/perturbation-decomposition.json",
        "metrics/entered-exited.json",
        "metrics/multi-k.json",
        "metrics/rank-correlation.json",
    ):
        _write(snapshot / relative, {})
    for name in capture.ANALYTICAL_CASES:
        _write(snapshot / f"ranks/analytical-{name}.json", joined)
    _write(snapshot / "outputs/quality-report.json", {
        "p15Evaluable": False,
        "qualityGate": {"overallPass": False, "hardFailIds": ["P-14"],
                        "gates": [{"id": f"P-{number:02d}", "status": "PASS"}
                                  for number in range(1, 16)]},
    })
    source_lines = [f"{capture.sha256_bytes(raw)}  inputs/data/{name}"
                    for name, raw in source_files.items()]
    _write(root / "lineage/source-to-replay.json", {
        **{f"L-{number:02d}": {"present": True} for number in range(1, 9)},
        "L-05": dict(replay.CLASSIFICATIONS),
        "L-03": {"sourceManifestLines": source_lines},
        "L-01": {"sha256": replay.E1_ARCHIVE_SHA256, "bytes": replay.E1_ARCHIVE_BYTES,
                 "regularFiles": replay.E1_ARCHIVE_REGULAR_FILES},
        "L-02": {"e1ManifestSha256": replay.E1_MANIFEST_SHA256,
                 "e1ReportSha256": replay.E1_REPORT_SHA256},
        "L-04": [{"path": name} for name in source_files],
        "L-06": {"e1DistinctInputSha256": "d" * 64,
                 "replayInputBundleHash": profile.input_bundle_hash,
                 "valuesExpectedToDiffer": True},
        "L-08": {"e1ProductionCodeSha256": {
            "candidate_funnel_engine.py": generator_hashes["data/candidate_funnel_engine.py"],
            "candidate_funnel_batch.py": "f" * 64,
            "build_candidates_stocks.py": generator_hashes["data/build_candidates_stocks.py"],
        }, "headProductionCodeSha256": generator_hashes},
        "legacySourceBundleHash": source_bundle_hash,
        "L-07": {"oldOutputReused": False,
                 "e1PreO2Reference": replay.E1_OUTPUT_SUMMARIES[source_id],
                 "replay": {"permutations": permutations}},
    })
    _write(root / "validation/legacy-control.json", {
        f"CTL-{number:02d}": {"passed": True} for number in range(1, 8)
    })
    identity = {"runId": None, "runAttempt": None, "runToken": None, "workflow": None,
                "event": "legacy-replay", "gitSha": replay.CURRENT_GIT_SHA,
                "gitRef": replay.CURRENT_GIT_REF, "gitRefType": "branch",
                "startedAt": "2026-07-31T00:00:00+00:00", "runnerOs": "Darwin",
                "runnerArch": "arm64", "pythonVersion": "3.11.14", "locale": "C.UTF-8",
                "timezone": "UTC", "pythonHashSeed": "0", "replayExecutionId": "r99"}
    manifest = {
        "schemaVersion": capture.BUNDLE_SCHEMA_VERSION, "bundleId": root.name,
        "createdAt": "2026-07-31T00:00:00+00:00",
        "createdAtJst": "2026-07-31T09:00:00+09:00",
        "captureMode": "legacy-replay", "gitSha": replay.CURRENT_GIT_SHA,
        "versions": {}, "repository": "fwhdh826-sudo/jp-portfolio",
        "frozenTests": [{"id": key, "function": value} for key, value in replay.E4_TEST_MAPPING],
        "mutations": [{"id": key, "name": value} for key, value in replay.MUTATION_MAPPING],
        "gitRef": replay.CURRENT_GIT_REF, "gitRefType": "branch", "runIdentity": identity,
        "assignmentContract": batch.P14_ASSIGNMENT_CONTRACT,
        "assignmentNote": batch.P14_ASSIGNMENT_NOTE,
        "p14Parameters": {"threshold": batch.RANK_STABILITY_JACCARD_MIN,
                          "topK": batch.TOP_N_STABILITY,
                          "perturbationPct": batch.PERTURBATION_PCT},
        "legacySource": {"legacySnapshotId": source_id,
                         "legacyKey": replay.legacy_key(source_id, profile.market_content_hash),
                         "legacySourceBundleHash": source_bundle_hash,
                         "e1ArchiveSha256": replay.E1_ARCHIVE_SHA256,
                         "e1ManifestSha256": replay.E1_MANIFEST_SHA256,
                         "e1ReportSha256": replay.E1_REPORT_SHA256,
                         "e1GitSource": profile.e1_git_source,
                         "e1EvidenceClass": profile.e1_evidence_class,
                         "replayExecutionId": "r99",
                         "replayAsOf": profile.replay_as_of},
        "legacyDeviations": {"prescreenBytesReconstructed": True,
                             "runTokenSameRunProven": False,
                             "legacyProductionRunToken": profile.production_run_token,
                             "prescreenGeneratedAtDeltaSeconds": profile.prescreen_delta_seconds,
                             "regimeSameRunProven": False, "regimeGeneratedAtDeltaSeconds": 0.0,
                             "p15Evaluable": False, "captureMode": "legacy-replay"},
        "generatorSha256": generator_hashes,
        "configurationSha256": capture.sha256_bytes(capture.canonical_bytes(configuration)),
        "inputHashes": {"candidates": capture.sha256_bytes(candidates_raw),
                        "prescreen": capture.sha256_bytes(prescreen_raw),
                        "regime": capture.sha256_bytes(regime_raw)},
        "inputBundleHash": hashes[0], "marketContentHash": hashes[1],
        "candidatePopulationHash": hashes[2], "prescreenSemanticHash": hashes[3],
        "sourceTimestamps": {
            "candidatesUpdatedAt": candidates_payload["updatedAt"],
            "candidatesSourceUpdatedAt": candidates_payload["sourceUpdatedAt"],
            "prescreenGeneratedAt": prescreen_payload["generatedAt"],
            "regimeGeneratedAt": regime_payload["_meta"]["generatedAt"],
        },
        "pipelinePath": "normal", "shortlistId": None, "population": len(joined),
        "outputHashes": {}, "rerunHashes": [], "permutationHashes": {},
        "privacy": {"violations": []},
        "validation": {"ciAccepted": False, "offlineRequired": True, "twoPartyRule": True},
        "acceptance": {"accepted": False, "criteriaVersion": capture.ACCEPTANCE_VERSION,
                       "failedCriteria": [], "legacyExtension": replay.LEGACY_EXTENSION,
                       "waivedCriteria": list(replay.WAIVED_CRITERIA)},
    }
    _write(root / "validation/privacy-report.json", validator.scan_bundle(root))
    capture.finalize_manifest(root, manifest)
    report = validator.validate_bundle(root, repo_root=REPO, ci=True, legacy=True)
    assert report["accepted"], report["failedCriteria"]
    return root, snapshot, profile, candidates_raw, prescreen_raw, regime_raw, joined


def _manifest(root: Path) -> dict:
    return json.loads((root / "manifest.json").read_text())


def _criterion_failed(report: dict, identifier: str) -> bool:
    return any(row["id"] == identifier and row["passed"] is False for row in report["criteria"])


def _refinalize(root: Path, manifest: dict | None = None) -> None:
    capture.finalize_manifest(root, manifest or _manifest(root))


def test_two_legacy_sets_are_uniquely_identified():
    """E4-T-01 / M-01."""
    left, right = replay.LEGACY_SOURCES.values()
    assert left.market_content_hash != right.market_content_hash
    assert replay.legacy_key(left.snapshot_id, left.market_content_hash) != replay.legacy_key(
        right.snapshot_id, right.market_content_hash)
    with pytest.raises(replay.LegacyReplayError, match="identity mapping"):
        replay.legacy_key(left.snapshot_id, right.market_content_hash)


def test_legacy_source_bytes_are_unchanged(legacy_bundle):
    """E4-T-02 / M-02, M-08, M-14."""
    root, snapshot, _, candidates_raw, prescreen_raw, regime_raw, _ = legacy_bundle
    assert (snapshot / "inputs/data/candidates_stocks.json").read_bytes() == candidates_raw
    assert (snapshot / "inputs/data/prescreen_metadata.json").read_bytes() == prescreen_raw
    assert (snapshot / "inputs/data/regime_state.json").read_bytes() == regime_raw
    path = snapshot / "inputs/data/candidates_stocks.json"
    path.write_bytes(candidates_raw.replace(b"2026", b"2025", 1))
    _refinalize(root)
    report = validator.validate_bundle(root, repo_root=REPO, ci=True, legacy=True)
    assert _criterion_failed(report, "E4-SOURCE-BYTES")
    path.write_bytes(json.dumps(json.loads(candidates_raw), ensure_ascii=False,
                                indent=2).encode() + b"\n")
    _refinalize(root)
    report = validator.validate_bundle(root, repo_root=REPO, ci=True, legacy=True)
    assert _criterion_failed(report, "E4-SOURCE-BYTES")


def test_source_hashes_match_archive_source_manifest(tmp_path):
    """E4-T-03 / M-02, M-14."""
    raw = b'{"a":1}\n'
    digest = capture.sha256_bytes(raw)
    manifest = tmp_path / "source-manifest.sha256"
    manifest.write_text(f"{digest}  inputs/data/candidates_stocks.json\n")
    _, parsed = replay._source_manifest(manifest)
    assert parsed["inputs/data/candidates_stocks.json"] == digest
    assert parsed["inputs/data/candidates_stocks.json"] != capture.sha256_bytes(raw + b" ")


def test_e1_archive_sha256_and_file_count_unchanged(tmp_path, monkeypatch):
    """E4-T-04 (synthetic archive; no E1 archive replay)."""
    tree = tmp_path / "tree/root"
    tree.mkdir(parents=True)
    manifest = tree / "manifest.json"
    manifest.write_text('{"synthetic":true}\n')
    payload = tree / "payload.json"
    payload.write_text("{}\n")
    archive = tmp_path / "synthetic.tar.gz"
    with tarfile.open(archive, "w:gz") as handle:
        handle.add(tree, arcname="root")
    monkeypatch.setattr(replay, "E1_ARCHIVE_SHA256", capture.sha256_file(archive))
    monkeypatch.setattr(replay, "E1_ARCHIVE_BYTES", archive.stat().st_size)
    monkeypatch.setattr(replay, "E1_ARCHIVE_REGULAR_FILES", 2)
    monkeypatch.setattr(replay, "E1_MANIFEST_SHA256", capture.sha256_file(manifest))
    assert replay.verify_archive(archive)["regularFiles"] == 2
    archive.write_bytes(archive.read_bytes() + b"x")
    with pytest.raises(replay.LegacyReplayError, match="archive identity"):
        replay.verify_archive(archive)


def test_current_git_sha_is_fixed_and_matches_manifest(legacy_bundle):
    """E4-T-05 / M-04."""
    root, *_ = legacy_bundle
    assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip() == replay.CURRENT_GIT_SHA
    manifest = _manifest(root)
    manifest["gitSha"] = "0" * 40
    _refinalize(root, manifest)
    report = validator.validate_bundle(root, repo_root=REPO, ci=True, legacy=True)
    assert _criterion_failed(report, "E4-CURRENT-SHA")


def test_assignment_contract_read_from_module_constant(legacy_bundle):
    """E4-T-06 / M-05."""
    root, *_ = legacy_bundle
    source = (REPO / "data/p14_legacy_replay.py").read_text()
    assert "p14-prescreen-rank-code-v1" not in source
    assert _manifest(root)["assignmentContract"] == batch.P14_ASSIGNMENT_CONTRACT
    manifest = _manifest(root)
    manifest["assignmentContract"] = "obsolete-contract"
    _refinalize(root, manifest)
    report = validator.validate_bundle(root, repo_root=REPO, ci=True, legacy=True)
    assert _criterion_failed(report, "E4-ASSIGNMENT")


def test_old_assignment_output_is_not_reused(legacy_bundle):
    """E4-T-07 / M-03."""
    root, snapshot, *_ = legacy_bundle
    assert not any(b"input-index parity" in path.read_bytes() for path in root.rglob("*") if path.is_file())
    (snapshot / "metrics/old.json").write_text('{"assignmentAuthority":"input-index parity"}\n')
    _refinalize(root)
    report = validator.validate_bundle(root, repo_root=REPO, ci=True, legacy=True)
    assert _criterion_failed(report, "E4-NO-OLD-OUTPUT")


def test_five_reruns_are_hash_identical(legacy_bundle):
    """E4-T-08."""
    root, snapshot, *_ = legacy_bundle
    rows = json.loads((snapshot / "reruns/five-reruns.json").read_text())
    assert len(rows) == 5
    rows[4]["metricsSha256"] = "d" * 64
    _write(snapshot / "reruns/five-reruns.json", rows)
    _refinalize(root)
    assert _criterion_failed(validator.validate_bundle(root, repo_root=REPO, ci=True, legacy=True),
                             "E4-FIVE-RERUNS")


def test_eight_permutations_present_with_verdicts(legacy_bundle):
    """E4-T-09."""
    _, snapshot, *_ = legacy_bundle
    rows = json.loads((snapshot / "metrics/input-order-permutations.json").read_text())
    assert {row["case"] for row in rows} == set(capture.PERMUTATION_CASES)
    assert all((snapshot / "permutations" / row["case"] / "production-p14.json").is_file()
               for row in rows)


def test_permutation_base_scores_are_invariant(legacy_bundle):
    """E4-T-10."""
    root, snapshot, *_ = legacy_bundle
    rows = json.loads((snapshot / "metrics/input-order-permutations.json").read_text())
    rows[0]["unperturbedRankChangedCount"] = 1
    _write(snapshot / "metrics/input-order-permutations.json", rows)
    _refinalize(root)
    assert _criterion_failed(validator.validate_bundle(root, repo_root=REPO, ci=True, legacy=True),
                             "E4-EIGHT-PERMUTATIONS")


def test_market_content_hash_independently_recomputed(legacy_bundle):
    """E4-T-11."""
    _, _, _, candidates_raw, prescreen_raw, regime_raw, joined = legacy_bundle
    original = capture.compute_input_hashes(candidates_raw, prescreen_raw, regime_raw, joined)
    candidates = json.loads(candidates_raw)
    candidates["updatedAt"] = "2099-01-01T00:00:00+00:00"
    candidates["_meta"]["runToken"] = "different"
    changed = capture.compute_input_hashes(json.dumps(candidates).encode(), prescreen_raw,
                                           regime_raw, joined)
    assert changed[0] != original[0]
    assert changed[1:] == original[1:]


def test_input_bundle_hash_matches_frozen_prediction(legacy_bundle):
    """E4-T-12."""
    root, _, profile, *_ = legacy_bundle
    assert _manifest(root)["inputBundleHash"] == profile.input_bundle_hash
    frozen = list(replay.LEGACY_SOURCES.values())[1]
    assert frozen.input_bundle_hash == "8357850fa38875296c36fad3cc9644170c00f2a6351533d517a93ab7d35edc0a"


def test_duplicate_detection_follows_frozen_order():
    """E4-T-13 / M-10."""
    profile = next(iter(replay.LEGACY_SOURCES.values()))
    result = replay.duplicate_decision(profile, [profile.market_content_hash], [])
    assert result["duplicate"] and result["comparisons"][0]["step"] == 1
    assert replay.count_increments(result["outcome"])["distinctCount"] == 0


def test_privacy_scan_zero_violations(legacy_bundle):
    """E4-T-14 / M-09."""
    root, *_ = legacy_bundle
    assert (scan := validator.scan_bundle(root))
    assert scan["passed"]
    injected = root / "validation/injected.json"
    _write(injected, {"holdings": []})
    _refinalize(root)
    assert _criterion_failed(validator.validate_bundle(root, repo_root=REPO, ci=True, legacy=True),
                             "E4-PRIVACY")


def test_test_fixtures_are_never_bundled(legacy_bundle):
    """E4-T-15."""
    root, *_ = legacy_bundle
    path = root / "tests/fixtures/forbidden.json"
    path.parent.mkdir(parents=True)
    path.write_text("{}\n")
    _refinalize(root)
    assert _criterion_failed(validator.validate_bundle(root, repo_root=REPO, ci=True, legacy=True),
                             "E4-NO-OLD-OUTPUT")


def test_lineage_map_is_complete(legacy_bundle):
    """E4-T-16 / M-06."""
    root, *_ = legacy_bundle
    path = root / "lineage/source-to-replay.json"
    lineage = json.loads(path.read_text())
    del lineage["L-05"]["C-32"]
    _write(path, lineage)
    _refinalize(root)
    assert _criterion_failed(validator.validate_bundle(root, repo_root=REPO, ci=True, legacy=True),
                             "E4-LINEAGE")


def test_missing_metadata_fails_closed(legacy_bundle):
    """E4-T-17 / M-07."""
    root, *_ = legacy_bundle
    assert all(_manifest(root)["runIdentity"][key] is None
               for key in ("runId", "runAttempt", "runToken", "workflow"))
    manifest = _manifest(root)
    manifest["runIdentity"]["runToken"] = "fabricated"
    _refinalize(root, manifest)
    assert _criterion_failed(validator.validate_bundle(root, repo_root=REPO, ci=True, legacy=True),
                             "E4-NO-FABRICATION")


def test_waived_criteria_are_exactly_ac04_ac05_ac13(legacy_bundle):
    """E4-T-18 / M-08, M-13."""
    root, snapshot, _, _, prescreen_raw, _, _ = legacy_bundle
    prescreen_path = snapshot / "inputs/data/prescreen_metadata.json"
    altered = json.loads(prescreen_raw)
    altered["generatedAt"] = "2026-07-26T16:09:01.662779+09:00"
    prescreen_path.write_bytes(json.dumps(altered).encode())
    _refinalize(root)
    assert _criterion_failed(validator.validate_bundle(root, repo_root=REPO, ci=True, legacy=True),
                             "E4-SOURCE-BYTES")
    prescreen_path.write_bytes(prescreen_raw)
    assert _manifest(root)["acceptance"]["waivedCriteria"] == ["AC-04", "AC-05", "AC-13"]
    manifest = _manifest(root)
    manifest["acceptance"]["waivedCriteria"].append("AC-10")
    _refinalize(root, manifest)
    assert _criterion_failed(validator.validate_bundle(root, repo_root=REPO, ci=True, legacy=True),
                             "E4-WAIVER")


def test_corpus_index_count_semantics():
    """E4-T-19 / M-11, M-15."""
    accepted = replay.count_increments("ACCEPTED_LEGACY_REPLAY_DISTINCT")
    assert accepted == {"distinctCount": 1, "realCapturedSameRunCount": 0,
                        "realReconstructedCount": 1}
    for outcome in replay.OUTCOMES - {"ACCEPTED_LEGACY_REPLAY_DISTINCT"}:
        assert replay.count_increments(outcome) == {"distinctCount": 0,
                                                   "realCapturedSameRunCount": 0,
                                                   "realReconstructedCount": 0}


def test_corpus_index_is_append_only():
    """E4-T-20 / M-12."""
    original = json.dumps({"snapshots": [{"snapshotId": "real-20260730-758846f07e",
                                           "accepted": True}]}).encode()
    appended = json.dumps({"snapshots": [{"snapshotId": "real-20260730-758846f07e",
                                           "accepted": True}, {"snapshotId": "new"}]}).encode()
    replay.assert_corpus_append_only(original, appended)
    overwritten = appended.replace(b"758846f07e", b"0000000000")
    with pytest.raises(replay.LegacyReplayError, match="CORPUS_CONFLICT"):
        replay.assert_corpus_append_only(original, overwritten)


def test_repository_side_effects_are_zero(legacy_bundle):
    """E4-T-21."""
    before = subprocess.check_output(["git", "status", "--short"], cwd=REPO, text=True)
    root, *_ = legacy_bundle
    validator.validate_bundle(root, repo_root=REPO, ci=True, legacy=True)
    after = subprocess.check_output(["git", "status", "--short"], cwd=REPO, text=True)
    assert after == before


def test_context_as_of_is_pinned_to_legacy_value():
    """E4-T-22 / M-16."""
    profile = next(iter(replay.LEGACY_SOURCES.values()))
    assert replay.parse_replay_as_of(profile.replay_as_of, profile).tzinfo is not None
    with pytest.raises(replay.LegacyReplayError, match="naive"):
        replay.parse_replay_as_of("2026-07-26T07:11:40.540540", profile)
    with pytest.raises(replay.LegacyReplayError, match="contradictory"):
        replay.parse_replay_as_of("2026-07-27T07:11:40.540540+00:00", profile)


def test_previous_artifact_is_not_current_head_artifact(legacy_bundle):
    """E4-T-23."""
    root, snapshot, *_ = legacy_bundle
    assert not (snapshot / "inputs/data/candidate_funnel_previous.json").exists()
    assert _manifest(root)["legacyDeviations"]["p15Evaluable"] is False


def _build_synthetic_current_canonical(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Exercise the real builder without opening either frozen E1 archive set."""
    source_id = "current-dev-committed-20260726"
    base_profile = replay.LEGACY_SOURCES[source_id]
    candidates_raw = (REPO / "data/candidates_stocks.json").read_bytes()
    candidates_payload = json.loads(candidates_raw)
    funnel = json.loads((REPO / "data/candidate_funnel.json").read_text())
    prescreen_payload = {
        "schemaVersion": "prescreen-metadata-1",
        "generatedAt": base_profile.replay_as_of,
        "entries": [
            {key: row[key] for key in ("code", "prescreenScore", "prescreenRank", "prescreenPool")}
            for row in funnel["candidates"]
        ],
    }
    prescreen_raw = json.dumps(prescreen_payload, ensure_ascii=False,
                               separators=(",", ":")).encode()
    regime_raw = (REPO / "data/regime_state.json").read_bytes()
    prescreen_index, duplicates = batch.build_prescreen_index(prescreen_payload)
    assert duplicates == []
    joined, _ = batch.join_candidates_with_prescreen(candidates_payload["candidates"],
                                                     prescreen_index)
    hashes = capture.compute_input_hashes(candidates_raw, prescreen_raw, regime_raw, joined)
    joined_hash = capture.sha256_bytes(capture.canonical_bytes({"candidates": joined}))
    profile = replace(base_profile, input_bundle_hash=hashes[0], market_content_hash=hashes[1],
                      population_hash=hashes[2], prescreen_hash=hashes[3],
                      joined_sha256=joined_hash)
    monkeypatch.setitem(replay.LEGACY_SOURCES, source_id, profile)

    source_root = tmp_path / "synthetic-e1"
    source = source_root / "snapshots" / source_id
    inputs = source / "inputs/data"
    inputs.mkdir(parents=True)
    files = {"candidates_stocks.json": candidates_raw,
             "prescreen_metadata.json": prescreen_raw, "regime_state.json": regime_raw}
    for name, raw in files.items():
        (inputs / name).write_bytes(raw)
    (source / profile.marker_present).write_text("synthetic marker\n")
    (source / "source-manifest.sha256").write_text("".join(
        f"{capture.sha256_bytes(raw)}  inputs/data/{name}\n"
        for name, raw in files.items()
    ))
    production_code = source / "inputs/production_code/data"
    production_code.mkdir(parents=True)
    for name in ("candidate_funnel_engine.py", "candidate_funnel_batch.py",
                 "build_candidates_stocks.py"):
        raw = (REPO / "data" / name).read_bytes()
        if name == "candidate_funnel_batch.py":
            raw += b"\n# synthetic pre-O2 drift marker\n"
        (production_code / name).write_bytes(raw)

    pinned = replay.parse_replay_as_of(profile.replay_as_of, profile)
    regime_path = inputs / "regime_state.json"
    context = batch.build_context(candidates_payload, batch.read_current_regime(regime_path), pinned)
    old_base = capture.engine.build_candidate_funnel(joined, context)
    old_perturbed = copy.deepcopy(old_base)
    ranked = capture._ranked(old_perturbed)
    for row in ranked:
        row["marketRank"] = len(ranked) + 1 - row["marketRank"]
    _write(source / "outputs/run-1/base-engine.json", old_base)
    _write(source / "outputs/run-1/perturbed-engine.json", old_perturbed)
    _write(source_root / "manifest.json", {
        "snapshots": [{"snapshotId": source_id, "distinctInputSha256": "d" * 64}],
    })

    monkeypatch.setenv("TZ", "UTC")
    monkeypatch.setenv("PYTHONHASHSEED", "0")
    monkeypatch.setenv("LC_ALL", "C.UTF-8")
    output = tmp_path / "replay-output"
    output.mkdir()
    bundle = replay.build_legacy_bundle(
        out_parent=output, repo_root=REPO, source_root=source_root,
        legacy_snapshot_id=source_id, replay_execution_id="r99",
        as_of=profile.replay_as_of,
        archive_info={"sha256": replay.E1_ARCHIVE_SHA256, "bytes": replay.E1_ARCHIVE_BYTES,
                      "regularFiles": replay.E1_ARCHIVE_REGULAR_FILES},
        started_at="2026-07-31T00:00:00+00:00",
    )
    report = validator.validate_bundle(bundle, repo_root=REPO, ci=True, legacy=True)
    assert report["accepted"], report["failedCriteria"]
    return bundle


def test_control_checks_ctl01_to_ctl07(legacy_bundle, tmp_path, monkeypatch):
    """E4-T-24 / verifies the 16 frozen mutation IDs are mapped."""
    root, *_ = legacy_bundle
    assert [key for key, _ in replay.MUTATION_MAPPING] == [f"E4-M-{n:02d}" for n in range(1, 17)]
    path = root / "validation/legacy-control.json"
    controls = json.loads(path.read_text())
    assert set(controls) == {f"CTL-{n:02d}" for n in range(1, 8)}
    controls["CTL-03"]["passed"] = False
    _write(path, controls)
    _refinalize(root)
    assert _criterion_failed(validator.validate_bundle(root, repo_root=REPO, ci=True, legacy=True),
                             "E4-CONTROLS")
    assert _build_synthetic_current_canonical(tmp_path, monkeypatch).is_dir()
