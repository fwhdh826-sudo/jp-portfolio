"""Frozen P14-E4 tests E4-T-01..58 using synthetic temporary evidence only."""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import inspect
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import replace
from pathlib import Path

import pytest

from data import candidate_funnel_batch as batch
from data import p14_evidence_capture as capture
from data import p14_evidence_validate as validator
from data import p14_legacy_replay as replay

REPO = Path(__file__).parents[1]
EXPECTED_REPLAY_MODULE_SHA256 = "3c352bf7a604a0ac01a4ea571e220f1ac7efa7514f41173d028333cde6735aa9"
_E1_ARCHIVE_ENV = "P14_E1_ARCHIVE"
_E1_ARCHIVE_NAME = "p5-b005-c-p14-e1-evidence.tar.gz"
_CANONICAL_AUDIT_ROOT_CANDIDATES = (
    REPO.parent / "jp-portfolio-audit-reports",
    Path.home() / "jp-portfolio-audit-reports",
)


def _archive_sha256(path: Path) -> str:
    return capture.sha256_file(path)


def _resolve_e1_archive_path(
    *,
    environ: dict[str, str] | os._Environ[str] | None = None,
    audit_roots: tuple[Path, ...] | None = None,
) -> Path:
    """Resolve exactly one byte-verified E1 archive without a machine-local path pin."""
    environment = os.environ if environ is None else environ
    explicit = environment.get(_E1_ARCHIVE_ENV)
    if explicit is not None:
        if not explicit.strip():
            raise AssertionError(f"{_E1_ARCHIVE_ENV} is set but empty")
        candidate = Path(explicit).expanduser().resolve()
        if not candidate.is_file():
            raise AssertionError(
                f"P14 E1 archive from {_E1_ARCHIVE_ENV} is missing: {candidate}"
            )
        actual = _archive_sha256(candidate)
        if actual != replay.E1_ARCHIVE_SHA256:
            raise AssertionError(
                f"P14 E1 archive SHA256 mismatch for {_E1_ARCHIVE_ENV}: {candidate}; "
                f"expected {replay.E1_ARCHIVE_SHA256}, actual {actual}"
            )
        return candidate

    roots = _CANONICAL_AUDIT_ROOT_CANDIDATES if audit_roots is None else audit_roots
    candidates: list[Path] = []
    seen: set[Path] = set()
    for root in roots:
        candidate = (root.expanduser() / _E1_ARCHIVE_NAME).resolve()
        if candidate not in seen:
            seen.add(candidate)
            candidates.append(candidate)

    existing = [candidate for candidate in candidates if candidate.is_file()]
    if not existing:
        searched = ", ".join(str(candidate) for candidate in candidates) or "<none>"
        raise AssertionError(
            f"P14 E1 archive missing; set {_E1_ARCHIVE_ENV} or place the archive at "
            f"exactly one canonical candidate: {searched}"
        )

    valid: list[Path] = []
    mismatches: list[tuple[Path, str]] = []
    for candidate in existing:
        actual = _archive_sha256(candidate)
        if actual == replay.E1_ARCHIVE_SHA256:
            valid.append(candidate)
        else:
            mismatches.append((candidate, actual))
    if mismatches:
        details = ", ".join(f"{path} (actual {actual})" for path, actual in mismatches)
        raise AssertionError(
            f"P14 E1 archive SHA256 mismatch; expected {replay.E1_ARCHIVE_SHA256}: {details}"
        )
    if len(valid) > 1:
        raise AssertionError(
            "P14 E1 archive resolution is ambiguous; multiple valid canonical candidates: "
            + ", ".join(str(path) for path in valid)
        )
    return valid[0]


def _historical_snapshot_files(snapshot_id: str) -> dict[str, bytes]:
    """Byte-exact P14-E4 historical input authority for a LEGACY_SOURCES snapshot.

    The LEGACY_SOURCES oracle hashes (input_bundle_hash/market_content_hash/
    population_hash/prescreen_hash/joined_sha256) were calibrated against the
    frozen P14 E1 evidence archive, not against REPO/data (which drifts as the
    live pipeline runs). A historical-replay fixture must source its raw input
    bytes from here so live REPO/data updates can never change a historical
    test's result.
    """
    archive_path = _resolve_e1_archive_path()
    replay.verify_archive(archive_path)
    with tempfile.TemporaryDirectory(prefix="p14-e4-historical-source-") as scratch:
        root = replay._extract(archive_path, Path(scratch))
        source = root / "snapshots" / snapshot_id
        _, source_manifest = replay._source_manifest(source / "source-manifest.sha256")
        files = {}
        for name in replay.REUSE_INPUT_NAMES:
            raw = (source / "inputs/data" / name).read_bytes()
            assert source_manifest[f"inputs/data/{name}"] == capture.sha256_bytes(raw)
            files[name] = raw
        return files


def _write(path: Path, value: object) -> None:
    capture.write_json(path, value)


def _clone_detached(path: Path, revision: str, *, child_commit: bool = False) -> Path:
    subprocess.run(
        ["git", "clone", "--quiet", "--no-checkout", "--local", str(REPO), str(path)],
        check=True,
    )
    subprocess.run(["git", "checkout", "--quiet", "--detach", revision], cwd=path, check=True)
    if child_commit:
        subprocess.run(
            ["git", "-c", "user.name=P14 Test", "-c", "user.email=p14@example.invalid",
             "commit", "--quiet", "--allow-empty", "-m", "synthetic I2 tooling"],
            cwd=path, check=True,
        )
    assert (path / ".git").is_dir()
    assert subprocess.check_output(
        ["git", "rev-parse", "--is-inside-work-tree"], cwd=path, text=True
    ).strip() == "true"
    return path


def _perturb_with_signs(candidates: list[object], signs: dict[str, int]) -> list[object]:
    perturbed: list[object] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            perturbed.append(candidate)
            continue
        row = dict(candidate)
        sign = signs.get(row.get("code"))
        if sign is not None:
            for field, direction in (("per", 1), ("roe", -1)):
                value = row.get(field)
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    row[field] = value * (1 + direction * sign * batch.PERTURBATION_PCT)
        perturbed.append(row)
    return perturbed


@pytest.fixture
def replay_repositories(tmp_path: Path) -> tuple[Path, Path]:
    target = _clone_detached(tmp_path / "replay-target", replay.CURRENT_GIT_SHA)
    return target, REPO


@pytest.fixture
def legacy_bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                  replay_repositories: tuple[Path, Path]):
    replay_target, tooling_repo = replay_repositories
    source_id = "current-dev-committed-20260726"
    base_profile = replay.LEGACY_SOURCES[source_id]
    historical = _historical_snapshot_files(source_id)
    candidates_raw = historical["candidates_stocks.json"]
    candidates_payload = json.loads(candidates_raw)
    prescreen_raw = historical["prescreen_metadata.json"]
    prescreen_payload = json.loads(prescreen_raw)
    regime_raw = historical["regime_state.json"]
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
        raw = (replay_target / relative).read_bytes()
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
        "L-04": [{
            "archivePath": f"snapshots/{source_id}/inputs/data/{name}",
            "replayPath": f"snapshots/reeval-{source_id}/inputs/data/{name}",
            "sha256": capture.sha256_bytes(raw), "bytes": len(raw),
        } for name, raw in sorted(source_files.items())],
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
        f"CTL-{number:02d}": {"passed": True} for number in range(1, 11)
    })
    identity = {"runId": None, "runAttempt": None, "runToken": None, "workflow": None,
                "event": "legacy-replay", "gitSha": replay.CURRENT_GIT_SHA,
                "executionRepositoryHead": replay.CURRENT_GIT_SHA,
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
        "tooling": {
            "toolingImplementationSha": subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=tooling_repo, text=True
            ).strip(),
            "toolingSourceHashes": dict(replay.TOOLING_SOURCE_HASHES),
        },
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
                       "waivedCriteria": list(replay.WAIVED_CRITERIA),
                       "waiverAuthority": replay.WAIVER_AUTHORITY},
    }
    pending = {
        "accepted": False, "phase": "pending-independent-ci-validation",
        "criteriaVersion": capture.ACCEPTANCE_VERSION,
        "legacyExtension": replay.LEGACY_EXTENSION, "legacyReplayOutcome": None,
        "failedCriteria": [], "waivedCriteria": list(replay.WAIVED_CRITERIA),
        "waiverAuthority": replay.WAIVER_AUTHORITY,
    }
    _write(root / "validation/status.json", pending)
    _write(root / "validation/acceptance-report.json", pending)
    _write(root / "validation/privacy-report.json", validator.scan_bundle(root))
    capture.finalize_manifest(root, manifest)
    report = validator.validate_bundle(
        root, repo_root=replay_target, tooling_repo=tooling_repo, ci=True, legacy=True
    )
    assert report["accepted"], report["failedCriteria"]
    return root, snapshot, profile, candidates_raw, prescreen_raw, regime_raw, joined


def _manifest(root: Path) -> dict:
    return json.loads((root / "manifest.json").read_text())


def _criterion_failed(report: dict, identifier: str) -> bool:
    return any(row["id"] == identifier and row["passed"] is False for row in report["criteria"])


def _refinalize(root: Path, manifest: dict | None = None) -> None:
    capture.finalize_manifest(root, manifest or _manifest(root))


def _validate(root: Path) -> dict:
    return validator.validate_bundle(
        root, repo_root=root.parent / "replay-target",
        tooling_repo=REPO, ci=True, legacy=True
    )


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
    report = _validate(root)
    assert _criterion_failed(report, "E4-SOURCE-BYTES")
    path.write_bytes(json.dumps(json.loads(candidates_raw), ensure_ascii=False,
                                indent=2).encode() + b"\n")
    _refinalize(root)
    report = _validate(root)
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


def test_legacy_source_hashes_match_e1_archive():
    """The frozen hash oracle must be semantically derivable from E1 raw bytes."""
    source_id = "current-dev-committed-20260726"
    profile = replay.LEGACY_SOURCES[source_id]
    historical = _historical_snapshot_files(source_id)
    candidates_raw = historical["candidates_stocks.json"]
    prescreen_raw = historical["prescreen_metadata.json"]
    regime_raw = historical["regime_state.json"]
    candidates = json.loads(candidates_raw)["candidates"]
    prescreen_index, duplicates = batch.build_prescreen_index(json.loads(prescreen_raw))
    assert duplicates == []
    joined, _ = batch.join_candidates_with_prescreen(candidates, prescreen_index)
    input_bundle_hash, market_content_hash, population_hash, prescreen_hash = (
        capture.compute_input_hashes(candidates_raw, prescreen_raw, regime_raw, joined)
    )
    joined_sha256 = capture.sha256_bytes(
        capture.canonical_bytes({"candidates": joined})
    )
    assert {
        "market_content_hash": market_content_hash,
        "input_bundle_hash": input_bundle_hash,
        "population_hash": population_hash,
        "prescreen_hash": prescreen_hash,
        "joined_sha256": joined_sha256,
    } == {
        "market_content_hash": profile.market_content_hash,
        "input_bundle_hash": profile.input_bundle_hash,
        "population_hash": profile.population_hash,
        "prescreen_hash": profile.prescreen_hash,
        "joined_sha256": profile.joined_sha256,
    }


def test_e1_archive_explicit_env_has_priority(tmp_path):
    source = _resolve_e1_archive_path()
    explicit = tmp_path / "explicit.tar.gz"
    shutil.copyfile(source, explicit)
    canonical_root = tmp_path / "canonical"
    canonical_root.mkdir()
    (canonical_root / _E1_ARCHIVE_NAME).write_bytes(b"wrong canonical bytes")
    assert _resolve_e1_archive_path(
        environ={_E1_ARCHIVE_ENV: str(explicit)}, audit_roots=(canonical_root,)
    ) == explicit.resolve()


def test_e1_archive_resolves_one_valid_canonical_candidate(tmp_path):
    source = _resolve_e1_archive_path()
    canonical_root = tmp_path / "canonical"
    canonical_root.mkdir()
    expected = canonical_root / _E1_ARCHIVE_NAME
    shutil.copyfile(source, expected)
    assert _resolve_e1_archive_path(environ={}, audit_roots=(canonical_root,)) == expected


def test_e1_archive_wrong_hash_fails_closed(tmp_path):
    canonical_root = tmp_path / "canonical"
    canonical_root.mkdir()
    wrong = canonical_root / _E1_ARCHIVE_NAME
    wrong.write_bytes(b"not the frozen E1 archive")
    with pytest.raises(AssertionError, match="P14 E1 archive SHA256 mismatch"):
        _resolve_e1_archive_path(environ={}, audit_roots=(canonical_root,))


def test_e1_archive_missing_fails_with_resolution_guidance(tmp_path):
    with pytest.raises(AssertionError, match=(
        rf"P14 E1 archive missing; set {_E1_ARCHIVE_ENV} or place the archive"
    )):
        _resolve_e1_archive_path(environ={}, audit_roots=(tmp_path / "missing",))


def test_e1_archive_multiple_valid_candidates_are_ambiguous(tmp_path):
    source = _resolve_e1_archive_path()
    roots = (tmp_path / "audit-one", tmp_path / "audit-two")
    for root in roots:
        root.mkdir()
        shutil.copyfile(source, root / _E1_ARCHIVE_NAME)
    with pytest.raises(AssertionError, match="multiple valid canonical candidates"):
        _resolve_e1_archive_path(environ={}, audit_roots=roots)


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
    target = root.parent / "replay-target"
    assert subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=target, text=True
    ).strip() == replay.CURRENT_GIT_SHA
    manifest = _manifest(root)
    manifest["gitSha"] = "0" * 40
    _refinalize(root, manifest)
    report = _validate(root)
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
    report = _validate(root)
    assert _criterion_failed(report, "E4-ASSIGNMENT")


def test_old_assignment_output_is_not_reused(legacy_bundle):
    """E4-T-07 / M-03."""
    root, snapshot, *_ = legacy_bundle
    assert not any(b"input-index parity" in path.read_bytes() for path in root.rglob("*") if path.is_file())
    (snapshot / "metrics/old.json").write_text('{"assignmentAuthority":"input-index parity"}\n')
    _refinalize(root)
    report = _validate(root)
    assert _criterion_failed(report, "E4-NO-OLD-OUTPUT")


def test_five_reruns_are_hash_identical(legacy_bundle):
    """E4-T-08."""
    root, snapshot, *_ = legacy_bundle
    rows = json.loads((snapshot / "reruns/five-reruns.json").read_text())
    assert len(rows) == 5
    rows[4]["metricsSha256"] = "d" * 64
    _write(snapshot / "reruns/five-reruns.json", rows)
    _refinalize(root)
    assert _criterion_failed(_validate(root),
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
    assert _criterion_failed(_validate(root),
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
    assert _criterion_failed(_validate(root),
                             "E4-PRIVACY")


def test_test_fixtures_are_never_bundled(legacy_bundle):
    """E4-T-15."""
    root, *_ = legacy_bundle
    path = root / "tests/fixtures/forbidden.json"
    path.parent.mkdir(parents=True)
    path.write_text("{}\n")
    _refinalize(root)
    assert _criterion_failed(_validate(root),
                             "E4-NO-FIXTURES")


def test_lineage_map_is_complete(legacy_bundle):
    """E4-T-16 / M-06."""
    root, *_ = legacy_bundle
    path = root / "lineage/source-to-replay.json"
    lineage = json.loads(path.read_text())
    del lineage["L-05"]["C-32"]
    _write(path, lineage)
    _refinalize(root)
    assert _criterion_failed(_validate(root),
                             "E4-LINEAGE")


def test_missing_metadata_fails_closed(legacy_bundle):
    """E4-T-17 / M-07."""
    root, *_ = legacy_bundle
    assert all(_manifest(root)["runIdentity"][key] is None
               for key in ("runId", "runAttempt", "runToken", "workflow"))
    manifest = _manifest(root)
    manifest["runIdentity"]["runToken"] = "fabricated"
    _refinalize(root, manifest)
    assert _criterion_failed(_validate(root),
                             "E4-NO-FABRICATION")


def test_waived_criteria_are_exactly_ac04_ac05_ac13(legacy_bundle):
    """E4-T-18 / M-08, M-13."""
    root, snapshot, _, _, prescreen_raw, _, _ = legacy_bundle
    prescreen_path = snapshot / "inputs/data/prescreen_metadata.json"
    altered = json.loads(prescreen_raw)
    altered["generatedAt"] = "2026-07-26T16:09:01.662779+09:00"
    prescreen_path.write_bytes(json.dumps(altered).encode())
    _refinalize(root)
    assert _criterion_failed(_validate(root),
                             "E4-SOURCE-BYTES")
    prescreen_path.write_bytes(prescreen_raw)
    assert _manifest(root)["acceptance"]["waivedCriteria"] == ["AC-04", "AC-05", "AC-13"]
    manifest = _manifest(root)
    manifest["acceptance"]["waivedCriteria"].append("AC-10")
    _refinalize(root, manifest)
    assert _criterion_failed(_validate(root),
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
    _validate(root)
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


def _build_synthetic_current_canonical(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    replay_repositories: tuple[Path, Path],
) -> Path:
    """Exercise the real builder without opening either frozen E1 archive set."""
    replay_target, tooling_repo = replay_repositories
    source_id = "current-dev-committed-20260726"
    base_profile = replay.LEGACY_SOURCES[source_id]
    historical = _historical_snapshot_files(source_id)
    candidates_raw = historical["candidates_stocks.json"]
    candidates_payload = json.loads(candidates_raw)
    prescreen_raw = historical["prescreen_metadata.json"]
    prescreen_payload = json.loads(prescreen_raw)
    regime_raw = historical["regime_state.json"]
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
    old_perturbed = capture.engine.build_candidate_funnel(
        _perturb_with_signs(joined, replay._pre_o2_sign_by_code(joined)), context
    )
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
        out_parent=output, repo_root=replay_target, tooling_repo=tooling_repo,
        source_root=source_root,
        legacy_snapshot_id=source_id, replay_execution_id="r99",
        as_of=profile.replay_as_of,
        archive_info={"sha256": replay.E1_ARCHIVE_SHA256, "bytes": replay.E1_ARCHIVE_BYTES,
                      "regularFiles": replay.E1_ARCHIVE_REGULAR_FILES},
        started_at="2026-07-31T00:00:00+00:00",
    )
    report = validator.validate_bundle(
        bundle, repo_root=replay_target, tooling_repo=tooling_repo, ci=True, legacy=True
    )
    assert report["accepted"], report["failedCriteria"]
    return bundle


def test_control_checks_ctl01_to_ctl07(legacy_bundle, tmp_path, monkeypatch,
                                        replay_repositories):
    """E4-T-24 / verifies the 16 frozen mutation IDs are mapped."""
    root, *_ = legacy_bundle
    assert [key for key, _ in replay.MUTATION_MAPPING[:16]] == [f"E4-M-{n:02d}" for n in range(1, 17)]
    path = root / "validation/legacy-control.json"
    controls = json.loads(path.read_text())
    assert set(controls) == {f"CTL-{n:02d}" for n in range(1, 11)}
    controls["CTL-03"]["passed"] = False
    _write(path, controls)
    _refinalize(root)
    assert _criterion_failed(_validate(root),
                             "E4-CONTROLS")
    assert _build_synthetic_current_canonical(
        tmp_path, monkeypatch, replay_repositories
    ).is_dir()



def test_delivered_commit_uses_base_pinned_replay_repository(replay_repositories):
    """E4-T-25 / M-17."""
    replay_target, _ = replay_repositories
    assert subprocess.check_output(
        ["git", "rev-parse", "--is-inside-work-tree"], cwd=REPO, text=True
    ).strip() == "true"
    target_head = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=replay_target, text=True
    ).strip()
    tooling_head = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=REPO, text=True
    ).strip()
    assert target_head == replay.CURRENT_GIT_SHA
    assert tooling_head == subprocess.check_output(
        ["git", "rev-parse", "--verify", "HEAD^{commit}"], cwd=REPO, text=True
    ).strip()
    assert tooling_head != target_head
    for repository in (replay_target, REPO):
        assert {
            path: capture.sha256_file(repository / path)
            for path in replay.PRODUCTION_SOURCE_HASHES
        } == replay.PRODUCTION_SOURCE_HASHES
    assert {
        path: hashlib.sha256((REPO / path).read_bytes()).hexdigest()
        for path in replay.TOOLING_SOURCE_HASHES
    } == replay.TOOLING_SOURCE_HASHES
    status_paths = {
        line[3:] for line in subprocess.check_output(
            ["git", "status", "--short"], cwd=REPO, text=True
        ).splitlines()
    }
    assert status_paths <= {
        "data/p14_evidence_capture.py",
        "data/p14_evidence_validate.py",
        "data/p14_legacy_replay.py",
        "data/p14_corpus_register.py",
        "tests/test_p14_evidence_capture.py",
        "tests/test_p14_evidence_validate.py",
        "tests/test_p14_legacy_replay.py",
        "tests/test_p14_corpus_registry.py",
    }


def test_live_replay_target_head_check_remains_strict(legacy_bundle):
    """E4-T-26 / M-18."""
    root, *_ = legacy_bundle
    report = validator.validate_bundle(
        root, repo_root=REPO, tooling_repo=REPO, ci=True, legacy=True,
    )
    assert _criterion_failed(report, "E4-CURRENT-SHA")


def test_tooling_and_replay_sha_roles_are_distinct(legacy_bundle):
    """E4-T-27 / M-19."""
    root, *_ = legacy_bundle
    manifest = _manifest(root)
    target = root.parent / "replay-target"
    tooling = REPO
    assert manifest["gitSha"] == replay.CURRENT_GIT_SHA
    assert manifest["runIdentity"]["gitSha"] == replay.CURRENT_GIT_SHA
    assert manifest["runIdentity"]["executionRepositoryHead"] == replay.CURRENT_GIT_SHA
    assert manifest["tooling"]["toolingImplementationSha"] == subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=tooling, text=True
    ).strip()
    assert manifest["tooling"]["toolingSourceHashes"] == replay.TOOLING_SOURCE_HASHES
    assert replay.tooling_identity(tooling) == manifest["tooling"]
    assert subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=target, text=True
    ).strip() != manifest["tooling"]["toolingImplementationSha"]
    assert manifest["generatorSha256"] == replay.PRODUCTION_SOURCE_HASHES


def _count_result(rows):
    return {"candidates": rows}


def test_permutation_score_changed_count_is_exact():
    """E4-T-28 / M-20."""
    base = _count_result([
        {"code": "A", "rawCompositeScore": 1.0, "marketScore": 10, "marketRank": 1},
        {"code": "B", "rawCompositeScore": 2.0, "marketScore": 20, "marketRank": 2},
        {"code": "C", "rawCompositeScore": 3.0, "marketScore": 30, "marketRank": 3},
    ])
    changed = copy.deepcopy(base)
    changed["candidates"][0]["rawCompositeScore"] = 1.1
    changed["candidates"][1]["marketScore"] = 21
    score, rank = capture.permutation_changed_counts(base, changed)
    assert type(score) is int and (score, rank) == (2, 0)


def test_permutation_rank_changed_count_is_exact():
    """E4-T-29 / M-21."""
    base = _count_result([
        {"code": "A", "rawCompositeScore": 1.0, "marketScore": 10, "marketRank": 1},
        {"code": "B", "rawCompositeScore": 2.0, "marketScore": 20, "marketRank": 2},
    ])
    changed = copy.deepcopy(base)
    changed["candidates"][0]["marketRank"] = 2
    changed["candidates"][1]["marketRank"] = 1
    score, rank = capture.permutation_changed_counts(base, changed)
    assert type(rank) is int and (score, rank) == (0, 2)


def test_permutation_score_and_rank_counts_are_independent():
    """E4-T-30 / M-22."""
    base = _count_result([
        {"code": "A", "rawCompositeScore": 1.0, "marketScore": 10, "marketRank": 1},
        {"code": "B", "rawCompositeScore": 2.0, "marketScore": 20, "marketRank": 2},
        {"code": "C", "rawCompositeScore": 3.0, "marketScore": 30, "marketRank": 3},
    ])
    changed = copy.deepcopy(base)
    changed["candidates"][0]["marketScore"] = 11
    changed["candidates"][1]["marketRank"] = 3
    changed["candidates"][2]["marketRank"] = 2
    assert capture.permutation_changed_counts(base, changed) == (1, 2)
    with pytest.raises(capture.CaptureError, match="population mismatch"):
        capture.permutation_changed_counts(base, _count_result(changed["candidates"][:-1]))
    duplicate = copy.deepcopy(base)
    duplicate["candidates"][1]["code"] = "A"
    with pytest.raises(capture.CaptureError, match="unique exact strings"):
        capture.permutation_changed_counts(base, duplicate)


def test_waiver_authority_exact_contract(legacy_bundle):
    """E4-T-31 / M-23..27."""
    root, *_ = legacy_bundle
    report = _validate(root)
    validator._write_ci_result(root, report)
    expected = replay.WAIVER_AUTHORITY
    assert list(replay.WAIVED_CRITERIA) == ["AC-04", "AC-05", "AC-13"]
    assert expected == (
        "P14-E2-A1 §8.1 real_reconstructed grandfather + P14-E4-A1 §9.6"
    )
    assert _manifest(root)["acceptance"]["waiverAuthority"] == expected
    assert json.loads((root / "validation/status.json").read_text())["waiverAuthority"] == expected
    assert json.loads(
        (root / "validation/acceptance-report.json").read_text()
    )["waiverAuthority"] == expected

    def corrupted(name, relative, mutate):
        case = root.parent / name
        shutil.copytree(root, case)
        path = case / relative
        payload = json.loads(path.read_text())
        mutate(payload)
        _write(path, payload)
        _refinalize(case)
        return _validate(case)

    cases = [
        corrupted("waiver-short", "manifest.json", lambda x: x["acceptance"].__setitem__(
            "waiverAuthority", "P14-E4-A1 §9.6")),
        corrupted("waiver-arbitrary", "validation/status.json", lambda x: x.__setitem__(
            "waiverAuthority", "arbitrary")),
        corrupted("waiver-missing", "validation/acceptance-report.json", lambda x: x.pop(
            "waiverAuthority")),
        corrupted("waiver-ac01", "manifest.json", lambda x: x["acceptance"][
            "waivedCriteria"].append("AC-01")),
        corrupted("waiver-ac25", "validation/status.json", lambda x: x[
            "waivedCriteria"].append("AC-25")),
    ]
    assert all(_criterion_failed(item, "E4-WAIVER") for item in cases)


def test_regime_state_byte_identity_is_bound(legacy_bundle):
    """E4-T-32 / M-28..30."""
    root, snapshot, *_ = legacy_bundle
    case = root.parent / "regime-reserialize"
    shutil.copytree(root, case)
    path = next(case.glob("snapshots/reeval-*/inputs/data/regime_state.json"))
    raw = path.read_bytes()
    reserialized = json.dumps(json.loads(raw), ensure_ascii=False, separators=(",", ":")).encode()
    assert reserialized != raw
    path.write_bytes(reserialized)
    manifest = _manifest(case)
    manifest["inputHashes"]["regime"] = capture.sha256_bytes(reserialized)
    _refinalize(case, manifest)
    assert _criterion_failed(_validate(case), "E4-REGIME-BYTES")

    hash_only = root.parent / "regime-hash-only"
    shutil.copytree(root, hash_only)
    manifest = _manifest(hash_only)
    manifest["inputHashes"]["regime"] = "0" * 64
    _refinalize(hash_only, manifest)
    assert _criterion_failed(_validate(hash_only), "E4-REGIME-BYTES")


def test_legacy_source_bundle_hash_is_bound_to_manifest_and_lineage(legacy_bundle):
    """E4-T-33 / M-31..34."""
    root, *_ = legacy_bundle
    missing = root.parent / "source-hash-missing"
    shutil.copytree(root, missing)
    manifest = _manifest(missing)
    manifest["legacySource"].pop("legacySourceBundleHash")
    _refinalize(missing, manifest)
    assert _criterion_failed(_validate(missing), "E4-SOURCE-BUNDLE")

    stale = root.parent / "source-hash-stale-lineage"
    shutil.copytree(root, stale)
    manifest = _manifest(stale)
    manifest["legacySource"]["legacySourceBundleHash"] = "0" * 64
    _refinalize(stale, manifest)
    report = _validate(stale)
    assert _criterion_failed(report, "E4-SOURCE-BUNDLE")

    source_changed = root.parent / "source-change-manifest-only"
    shutil.copytree(root, source_changed)
    regime = next(source_changed.glob("snapshots/reeval-*/inputs/data/regime_state.json"))
    regime.write_bytes(json.dumps(json.loads(regime.read_bytes()), separators=(",", ":")).encode())
    source_id = _manifest(source_changed)["legacySource"]["legacySnapshotId"]
    snapshot = next(source_changed.glob("snapshots/reeval-*"))
    files = {name: (snapshot / "inputs/data" / name).read_bytes()
             for name in replay.REUSE_INPUT_NAMES}
    new_hash = replay._source_hash(replay.LEGACY_SOURCES[source_id], files)
    manifest = _manifest(source_changed)
    manifest["legacySource"]["legacySourceBundleHash"] = new_hash
    manifest["inputHashes"]["regime"] = capture.sha256_bytes(files["regime_state.json"])
    _refinalize(source_changed, manifest)
    assert _criterion_failed(_validate(source_changed), "E4-SOURCE-BUNDLE")


def test_partial_output_failure_is_atomic_and_cleaned(tmp_path):
    """E4-T-34 / M-35, M-36."""
    parent = tmp_path / "out"

    def fail(container):
        staged = container / "bundle"
        staged.mkdir()
        (staged / "partial.json").write_text("{}")
        raise replay.LegacyReplayError("postprocess failed")

    with pytest.raises(replay.LegacyReplayError, match="postprocess failed"):
        replay._atomic_stage_and_publish(parent, "accepted-name", fail)
    assert not (parent / "accepted-name").exists()
    assert list(parent.iterdir()) == []


def test_normal_status_schema_excludes_legacy_fields(tmp_path):
    """E4-T-35 / M-37."""
    root = tmp_path / "normal"
    (root / "validation").mkdir(parents=True)
    _write(root / "manifest.json", {"acceptance": {}, "validation": {}})
    report = {"accepted": True, "failedCriteria": [], "snapshotVerdict": "accepted"}
    validator._write_ci_result(root, report)
    forbidden = {"legacyExtension", "legacyReplayOutcome", "waivedCriteria", "waiverAuthority"}
    assert forbidden.isdisjoint(json.loads((root / "validation/status.json").read_text()))
    assert forbidden.isdisjoint(json.loads(
        (root / "validation/acceptance-report.json").read_text()))
    assert forbidden.isdisjoint(_manifest(root)["acceptance"])


def test_cli_argument_validation_precedes_archive_verification(tmp_path, monkeypatch):
    """E4-T-36 / M-38."""
    called = False

    def unexpected(_path):
        nonlocal called
        called = True
        raise AssertionError("archive verification ran")

    monkeypatch.setattr(replay, "verify_archive", unexpected)
    profile = next(iter(replay.LEGACY_SOURCES.values()))
    with pytest.raises(replay.LegacyReplayError, match="contradictory --as-of"):
        replay.build_from_archive(
            archive=tmp_path / "missing.tar.gz", out_parent=tmp_path / "out",
            repo_root=tmp_path / "target", tooling_repo=tmp_path / "tooling",
            legacy_snapshot_id=profile.snapshot_id, replay_execution_id="r99",
            as_of="2099-01-01T00:00:00+00:00",
        )
    assert called is False


def test_cli_failures_use_json_error_contract(tmp_path, monkeypatch, capsys):
    """E4-T-37 / M-39."""
    failures = [
        replay.PrivacyViolation("private material"),
        subprocess.CalledProcessError(2, ["git", "rev-parse"]),
    ]
    for failure in failures:
        monkeypatch.setattr(replay, "build_from_archive", lambda **_kwargs: (_ for _ in ()).throw(failure))
        code = replay.main([
            "--archive", str(tmp_path / "archive"), "--legacy-source",
            next(iter(replay.LEGACY_SOURCES)), "--replay-execution-id", "r99",
            "--as-of", next(iter(replay.LEGACY_SOURCES.values())).replay_as_of,
            "--out", str(tmp_path / "out"), "--repo-root", str(tmp_path / "target"),
            "--tooling-repo", str(tmp_path / "tooling"),
        ])
        output = capsys.readouterr().out
        assert code == 1
        assert json.loads(output)["accepted"] is False
        assert "Traceback" not in output


def test_old_output_and_fixture_criteria_are_distinct(legacy_bundle):
    """E4-T-38 / M-40."""
    root, snapshot, *_ = legacy_bundle
    old = root.parent / "old-output-case"
    shutil.copytree(root, old)
    (next(old.glob("snapshots/reeval-*")) / "old.txt").write_text("input-index parity")
    _refinalize(old)
    report = _validate(old)
    assert _criterion_failed(report, "E4-NO-OLD-OUTPUT")
    assert not _criterion_failed(report, "E4-NO-FIXTURES")

    fixtures = root.parent / "fixture-case"
    shutil.copytree(root, fixtures)
    path = fixtures / "tests/fixtures/forbidden.json"
    path.parent.mkdir(parents=True)
    path.write_text("{}")
    _refinalize(fixtures)
    report = _validate(fixtures)
    assert _criterion_failed(report, "E4-NO-FIXTURES")
    assert not _criterion_failed(report, "E4-NO-OLD-OUTPUT")


def test_output_collision_and_cleanup_failure_fail_closed(tmp_path, monkeypatch):
    """E4-T-39 / M-41, M-42."""
    parent = tmp_path / "out"
    collision = parent / "accepted-name"
    collision.mkdir(parents=True)
    marker = collision / "existing"
    marker.write_text("preserve")
    called = False

    def producer(_container):
        nonlocal called
        called = True
        raise AssertionError

    with pytest.raises(replay.LegacyReplayError, match="already exists"):
        replay._atomic_stage_and_publish(parent, "accepted-name", producer)
    assert called is False and marker.read_text() == "preserve"

    original_rmtree = shutil.rmtree

    def fail_cleanup(_path):
        raise OSError("cleanup denied")

    monkeypatch.setattr(replay.shutil, "rmtree", fail_cleanup)

    def partial(container):
        staged = container / "bundle"
        staged.mkdir()
        raise replay.LegacyReplayError("postprocess failed")

    with pytest.raises(replay.LegacyReplayError, match="PARTIAL_OUTPUT_SAFETY_FAILED"):
        replay._atomic_stage_and_publish(parent, "second-name", partial)
    assert not (parent / "second-name").exists()
    monkeypatch.setattr(replay.shutil, "rmtree", original_rmtree)
    for path in parent.glob(".second-name.staging-*"):
        original_rmtree(path)
    assert [key for key, _ in replay.MUTATION_MAPPING] == [
        f"E4-M-{number:02d}" for number in range(1, 58)
    ]


def _commit(repo: Path, message: str, *, allow_empty: bool = False) -> str:
    command = [
        "git", "-c", "user.name=P14 Test", "-c", "user.email=p14@example.invalid",
        "commit", "--quiet", "-m", message,
    ]
    if allow_empty:
        command.insert(-2, "--allow-empty")
    subprocess.run(command, cwd=repo, check=True)
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()


def _clone_approved_tooling(path: Path) -> Path:
    clone = _clone_detached(path, subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=REPO, text=True
    ).strip())
    for relative in (
        "data/p14_evidence_validate.py",
        "data/p14_evidence_capture.py",
        "data/p14_evidence_privacy_filter.py",
        "data/p14_legacy_replay.py",
    ):
        shutil.copy2(REPO / relative, clone / relative)
    subprocess.run(["git", "add", "data"], cwd=clone, check=True)
    _commit(clone, "approved corrected tooling", allow_empty=True)
    assert replay.tooling_identity(clone)["toolingSourceHashes"] == replay.TOOLING_SOURCE_HASHES
    return clone


def _commit_tree(repo: Path, tree: str, parents: list[str], message: str) -> str:
    command = ["git", "commit-tree", tree]
    for parent in parents:
        command.extend(["-p", parent])
    return subprocess.check_output(
        command, cwd=repo, input=message + "\n", text=True
    ).strip()


def _topology_repo(path: Path, topology: str) -> Path:
    repository = _clone_approved_tooling(path)
    approved = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=repository, text=True
    ).strip()
    tree = subprocess.check_output(
        ["git", "rev-parse", "HEAD^{tree}"], cwd=repository, text=True
    ).strip()
    if topology == "linear":
        _commit(repository, "linear child", allow_empty=True)
    elif topology == "detached":
        subprocess.run(["git", "checkout", "--quiet", "--detach", approved],
                       cwd=repository, check=True)
    elif topology == "branch":
        subprocess.run(["git", "checkout", "--quiet", "-b", "arbitrary-name-xyz"],
                       cwd=repository, check=True)
    elif topology in {"merge-first", "merge-second", "message-only"}:
        parents = ([approved, replay.CURRENT_GIT_SHA] if topology != "merge-second"
                   else [replay.CURRENT_GIT_SHA, approved])
        commit = _commit_tree(repository, tree, parents, f"{topology} topology")
        subprocess.run(["git", "checkout", "--quiet", "--detach", commit],
                       cwd=repository, check=True)
    elif topology == "real-merge":
        subprocess.run(["git", "checkout", "--quiet", "-B", "real-merge-base",
                        replay.CURRENT_GIT_SHA], cwd=repository, check=True)
        subprocess.run([
            "git", "-c", "user.name=P14 Test", "-c", "user.email=p14@example.invalid",
            "merge", "--quiet", "--no-ff", "-m", "real same-tree merge", approved,
        ], cwd=repository, check=True)
    else:
        raise AssertionError(f"unknown topology: {topology}")
    return repository


def _frozen_control_inputs(profile: replay.LegacySourceAuthority):
    joined = []
    for index in range(200):
        active = index < profile.perturbed_row_count
        joined.append({
            "code": f"C{index:03d}", "prescreenRank": index + 1,
            "per": float(index + 10) if active else None,
            "roe": float(index + 1) / 100 if active else None,
        })
    base_rows = [
        {"code": row["code"], "marketRank": index + 1}
        for index, row in enumerate(joined)
    ]
    delta = profile.base_perturbed_rank_delta
    perturbed_rows = copy.deepcopy(base_rows)
    for index in range(delta):
        perturbed_rows[index]["marketRank"] = (index + 1) % delta + 1
    base = {"candidates": base_rows}
    perturbed = {"candidates": perturbed_rows}
    return joined, base, perturbed


def _current_joined_context():
    source_id = "current-dev-committed-20260726"
    historical = _historical_snapshot_files(source_id)
    candidates_payload = json.loads(historical["candidates_stocks.json"])
    prescreen = json.loads(historical["prescreen_metadata.json"])
    index, duplicates = batch.build_prescreen_index(prescreen)
    assert duplicates == []
    joined, _ = batch.join_candidates_with_prescreen(candidates_payload["candidates"], index)
    profile = replay.LEGACY_SOURCES[source_id]
    pinned = replay.parse_replay_as_of(profile.replay_as_of, profile)
    with tempfile.TemporaryDirectory(prefix="p14-e4-current-joined-context-") as scratch:
        regime_path = Path(scratch) / "regime_state.json"
        regime_path.write_bytes(historical["regime_state.json"])
        regime = batch.read_current_regime(regime_path)
    context = batch.build_context(candidates_payload, regime, pinned)
    return joined, context


def test_delivered_chain_replay_starts_from_shipped_checkout():
    """E4-T-40 / E4-M-43..45."""
    test_source = (REPO / "tests/test_p14_legacy_replay.py").read_text()
    source = test_source.split("def test_delivered_chain_replay_starts_from_shipped_checkout", 1)[1]
    source = source.split("\ndef ", 1)[0]
    assert "replay.tooling_identity(REPO)" in source
    assert source.count("_clone_approved_tooling") == 1
    identity = replay.tooling_identity(REPO)
    assert identity["toolingSourceHashes"] == replay.TOOLING_SOURCE_HASHES
    assert set(identity) == {"toolingImplementationSha", "toolingSourceHashes"}


def test_stale_tooling_anchor_is_rejected(tmp_path):
    """E4-T-41 / stale I1 tooling is not approved."""
    stale = _clone_detached(tmp_path / "stale-i1", "7f0ec37a827ac036d78108d0d56b17e082da0f6a")
    with pytest.raises(replay.LegacyReplayError, match=(
        r"^P14_E4_R2_TOOLING_SOURCE_DRIFT: data/p14_evidence_validate\.py$"
    )):
        replay.tooling_identity(stale)


@pytest.mark.parametrize("case", [
    "validate-reverted-to-base",
    "capture-reverted-to-base",
    "privacy-guard-marker-dropped",
])
def test_partial_e4_stack_is_rejected(tmp_path, case):
    """E4-T-42 / E4-M-46..47; all degradations are parse/import valid."""
    assert replay.tooling_identity(REPO)["toolingSourceHashes"] == replay.TOOLING_SOURCE_HASHES
    degraded = _clone_approved_tooling(tmp_path / case)
    if case == "validate-reverted-to-base":
        relative = "data/p14_evidence_validate.py"
        raw = subprocess.check_output(
            ["git", "show", f"{replay.CURRENT_GIT_SHA}:{relative}"], cwd=degraded
        )
        (degraded / relative).write_bytes(raw)
    elif case == "capture-reverted-to-base":
        relative = "data/p14_evidence_capture.py"
        raw = subprocess.check_output(
            ["git", "show", f"{replay.CURRENT_GIT_SHA}:{relative}"], cwd=degraded
        )
        (degraded / relative).write_bytes(raw)
    else:
        relative = "data/p14_evidence_privacy_filter.py"
        path = degraded / relative
        source = path.read_text()
        assert source.count('    "CREDENTIAL",\n') == 1
        path.write_text(source.replace('    "CREDENTIAL",\n', "", 1))
        before_spec = importlib.util.spec_from_file_location("privacy_before", REPO / relative)
        after_spec = importlib.util.spec_from_file_location("privacy_after", path)
        assert before_spec and before_spec.loader and after_spec and after_spec.loader
        before = importlib.util.module_from_spec(before_spec)
        after = importlib.util.module_from_spec(after_spec)
        before_spec.loader.exec_module(before)
        after_spec.loader.exec_module(after)
        names = {"AWS_CREDENTIAL_FILE", "MY_TOKEN"}
        environment = {"AWS_CREDENTIAL_FILE": "x", "MY_TOKEN": "y"}
        assert before.environment_presence(names, environment)[1] == [
            "AWS_CREDENTIAL_FILE", "MY_TOKEN"
        ]
        assert after.environment_presence(names, environment)[1] == ["MY_TOKEN"]
    compile((degraded / relative).read_text(), relative, "exec")
    subprocess.run([
        str(Path(os.environ.get("P14_PY311", sys.executable))),
        "-c", f"import sys; sys.path.insert(0,{str(degraded)!r}); import data.{Path(relative).stem}",
    ], cwd=degraded, check=True)
    with pytest.raises(replay.LegacyReplayError, match=(
        rf"^P14_E4_R2_TOOLING_SOURCE_DRIFT: {re.escape(relative)}$"
    )):
        replay.tooling_identity(degraded)


def test_required_tooling_blobs_are_hash_pinned(tmp_path):
    """E4-T-43 / independent hashlib trust anchor."""
    assert set(replay.TOOLING_SOURCE_HASHES) == {
        "data/p14_evidence_validate.py",
        "data/p14_evidence_capture.py",
        "data/p14_evidence_privacy_filter.py",
    }
    assert {
        relative: hashlib.sha256((REPO / relative).read_bytes()).hexdigest()
        for relative in replay.TOOLING_SOURCE_HASHES
    } == replay.TOOLING_SOURCE_HASHES
    assert hashlib.sha256((REPO / "data/p14_legacy_replay.py").read_bytes()).hexdigest() == (
        EXPECTED_REPLAY_MODULE_SHA256
    )
    changed = _clone_approved_tooling(tmp_path / "one-byte-change")
    path = changed / "data/p14_evidence_validate.py"
    path.write_bytes(path.read_bytes() + b"\n")
    with pytest.raises(replay.LegacyReplayError, match="p14_evidence_validate.py"):
        replay.tooling_identity(changed)


def test_topology_linear_tip(tmp_path):
    """E4-T-44 / E4-M-43."""
    assert replay.tooling_identity(_topology_repo(tmp_path / "linear", "linear"))[
        "toolingSourceHashes"
    ] == replay.TOOLING_SOURCE_HASHES


def test_topology_detached_head(tmp_path):
    """E4-T-45."""
    repository = _topology_repo(tmp_path / "detached", "detached")
    assert subprocess.check_output(["git", "branch", "--show-current"], cwd=repository,
                                   text=True).strip() == ""
    assert replay.tooling_identity(repository)["toolingSourceHashes"] == replay.TOOLING_SOURCE_HASHES


def test_topology_arbitrary_branch(tmp_path):
    """E4-T-46."""
    repository = _topology_repo(tmp_path / "branch", "branch")
    assert subprocess.check_output(["git", "branch", "--show-current"], cwd=repository,
                                   text=True).strip() == "arbitrary-name-xyz"
    replay.tooling_identity(repository)


def test_topology_merge_first_parent(tmp_path):
    """E4-T-47 / E4-M-43, M-48, M-51."""
    replay.tooling_identity(_topology_repo(tmp_path / "merge-first", "merge-first"))


def test_topology_merge_second_parent(tmp_path):
    """E4-T-48 / E4-M-49."""
    replay.tooling_identity(_topology_repo(tmp_path / "merge-second", "merge-second"))


@pytest.mark.parametrize("variant", ["message-only", "real-merge"])
def test_topology_same_tree_merge_commit(tmp_path, variant):
    """E4-T-49 / E4-M-43, M-48, M-51."""
    repository = _topology_repo(tmp_path / variant, variant)
    parents = subprocess.check_output(
        ["git", "rev-list", "--parents", "-n", "1", "HEAD"], cwd=repository, text=True
    ).split()
    assert len(parents) == 3
    assert replay.tooling_identity(repository)["toolingSourceHashes"] == replay.TOOLING_SOURCE_HASHES


def test_same_ancestry_changed_tooling_tree_is_rejected(tmp_path):
    """E4-T-50 / E4-M-47, M-50."""
    repository = _clone_approved_tooling(tmp_path / "changed-tree")
    path = repository / "data/p14_evidence_validate.py"
    path.write_bytes(path.read_bytes() + b"\n")
    subprocess.run(["git", "add", str(path.relative_to(repository))], cwd=repository, check=True)
    _commit(repository, "changed tooling tree")
    with pytest.raises(replay.LegacyReplayError, match="p14_evidence_validate.py"):
        replay.tooling_identity(repository)


def test_tooling_identity_is_topology_free(tmp_path):
    """E4-T-51 / source scan plus five topology executions."""
    forbidden = ("HEAD^", "HEAD^^", "rev-list\", \"--parents", "merge-base")
    runtime_source = inspect.getsource(replay.tooling_identity)
    validator_source = inspect.getsource(validator.validate_legacy_bundle)
    assert all(token not in runtime_source for token in forbidden)
    assert all(token not in validator_source for token in forbidden)
    identities = [
        replay.tooling_identity(_topology_repo(tmp_path / topology, topology))[
            "toolingSourceHashes"
        ]
        for topology in ("linear", "detached", "merge-first", "merge-second", "message-only")
    ]
    assert identities == [replay.TOOLING_SOURCE_HASHES] * 5


def test_perturbation_path_is_consumed():
    """E4-T-52 / E4-M-52, M-57."""
    assert "perturbed_inputs = batch._perturb_candidates(joined)" in inspect.getsource(
        capture.build_bundle
    )
    profile = replay.LEGACY_SOURCES["current-dev-committed-20260726"]
    joined, base, perturbed = _frozen_control_inputs(profile)
    control = replay._correction_controls(joined, base, perturbed, perturbed, profile)["CTL-10"]
    assert control["passed"] is True
    assert control["perturbedRepresentationConsumed"] is True
    assert control["changedRows"] == 200


def test_rank_order_semantic_change_is_detected():
    """E4-T-53 / E4-M-56; synthetic order excites O2."""
    joined, context = _current_joined_context()
    ordered = list(reversed(joined))
    head_signs = batch._p14_canonical_sign_by_code(ordered)
    legacy_signs = replay._pre_o2_sign_by_code(ordered)
    assert sum(head_signs.get(code) != sign for code, sign in legacy_signs.items()) == 200
    head = capture.engine.build_candidate_funnel(_perturb_with_signs(ordered, head_signs), context)
    legacy = capture.engine.build_candidate_funnel(
        _perturb_with_signs(ordered, legacy_signs), context
    )
    assert sum(
        replay._rank_map(head).get(code) != replay._rank_map(legacy).get(code)
        for code in replay._rank_map(head)
    ) == 188


def test_o2_observable_branch_detects_swap():
    """E4-T-54 / E4-M-53, M-55, M-56."""
    joined, context = _current_joined_context()
    ordered = list(reversed(joined))
    head = capture.engine.build_candidate_funnel(batch._perturb_candidates(ordered), context)
    legacy = capture.engine.build_candidate_funnel(
        _perturb_with_signs(ordered, replay._pre_o2_sign_by_code(ordered)), context
    )
    base = capture.engine.build_candidate_funnel(ordered, context)
    profile = replace(
        replay.LEGACY_SOURCES["current-dev-committed-20260726"],
        o2_observable=True, pre_o2_sign_agreement=0,
    )
    assert replay._correction_controls(ordered, base, head, legacy, profile)["CTL-03"][
        "passed"
    ] is True
    assert replay._correction_controls(ordered, base, head, head, profile)["CTL-03"][
        "passed"
    ] is False


def test_real_legacy_a_is_not_false_rejected():
    """E4-T-55 / E4-M-55, M-57."""
    profile = replay.LEGACY_SOURCES["current-dev-committed-20260726"]
    assert (profile.o2_observable, profile.pre_o2_sign_agreement,
            profile.perturbed_row_count, profile.base_perturbed_rank_delta) == (
                False, 200, 200, 166
            )
    joined, base, perturbed = _frozen_control_inputs(profile)
    controls = replay._correction_controls(joined, base, perturbed, perturbed, profile)
    assert all(controls[key]["passed"] for key in ("CTL-03", "CTL-08", "CTL-09", "CTL-10"))
    wrong = replace(
        profile, pre_o2_sign_agreement=199, perturbed_row_count=199,
        base_perturbed_rank_delta=165,
    )
    wrong_controls = replay._correction_controls(joined, base, perturbed, perturbed, wrong)
    assert all(wrong_controls[key]["passed"] is False for key in ("CTL-08", "CTL-09", "CTL-10"))


def test_real_legacy_b_is_not_false_rejected():
    """E4-T-56 / E4-M-55, M-57."""
    profile = replay.LEGACY_SOURCES["historical-real-20260714-cache"]
    assert (profile.o2_observable, profile.pre_o2_sign_agreement,
            profile.perturbed_row_count, profile.base_perturbed_rank_delta) == (
                False, 200, 199, 164
            )
    joined, base, perturbed = _frozen_control_inputs(profile)
    controls = replay._correction_controls(joined, base, perturbed, perturbed, profile)
    assert all(controls[key]["passed"] for key in ("CTL-03", "CTL-08", "CTL-09", "CTL-10"))
    wrong = replace(
        profile, pre_o2_sign_agreement=199, perturbed_row_count=198,
        base_perturbed_rank_delta=163,
    )
    wrong_controls = replay._correction_controls(joined, base, perturbed, perturbed, wrong)
    assert all(wrong_controls[key]["passed"] is False for key in ("CTL-08", "CTL-09", "CTL-10"))


def test_noop_perturbation_is_rejected():
    """E4-T-57 / E4-M-52."""
    profile = replay.LEGACY_SOURCES["current-dev-committed-20260726"]
    joined, base, _ = _frozen_control_inputs(profile)
    controls = replay._correction_controls(joined, base, base, base, profile)
    assert controls["CTL-09"]["passed"] is False
    assert controls["CTL-09"]["baseSemanticDigest"] == controls["CTL-09"][
        "perturbedSemanticDigest"
    ]


def test_wrong_stage_comparison_is_rejected():
    """E4-T-58 / E4-M-53, M-54."""
    assert "ctl03_observed = rank_perturbed != rank_old_perturbed" in inspect.getsource(
        replay._correction_controls
    )
    profile = replay.LEGACY_SOURCES["current-dev-committed-20260726"]
    joined, base, perturbed = _frozen_control_inputs(profile)
    controls = replay._correction_controls(joined, base, perturbed, base, profile)
    assert controls["CTL-03"]["passed"] is False
    assert controls["CTL-09"]["passed"] is True
