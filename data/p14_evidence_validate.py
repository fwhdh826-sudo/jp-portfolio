#!/usr/bin/env python3
"""Fail-closed validator for ``p14-evidence-bundle-1`` bundles."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from data import candidate_funnel_batch as batch
from data import candidate_funnel_engine as engine
from data.candidates_stocks_privacy_smoke import check_candidates_stocks_payload
from data.p14_evidence_capture import (
    ACCEPTANCE_VERSION,
    ANALYTICAL_CASES,
    BUNDLE_SCHEMA_VERSION,
    FROZEN_TEST_MAPPING,
    GENERATOR_PATHS,
    PERMUTATION_CASES,
    canonical_bytes,
    compute_input_hashes,
    finalize_manifest,
    sha256_bytes,
    sha256_file,
    write_json,
)
from data.p14_evidence_privacy_filter import ALLOWED_INPUT_DATA_FILES, scan_bundle

REQUIRED_MANIFEST_KEYS = frozenset(
    {
        "schemaVersion",
        "bundleId",
        "createdAt",
        "createdAtJst",
        "assignmentContract",
        "assignmentNote",
        "p14Parameters",
        "versions",
        "repository",
        "frozenTests",
        "gitRef",
        "gitRefType",
        "gitSha",
        "runIdentity",
        "generatorSha256",
        "configurationSha256",
        "inputHashes",
        "inputBundleHash",
        "marketContentHash",
        "candidatePopulationHash",
        "prescreenSemanticHash",
        "sourceTimestamps",
        "pipelinePath",
        "shortlistId",
        "population",
        "outputHashes",
        "rerunHashes",
        "permutationHashes",
        "privacy",
        "validation",
        "acceptance",
        "files",
        "fileCount",
        "totalBytes",
    }
)


class ValidationError(RuntimeError):
    """Malformed bundle prevents validation from running."""


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValidationError(f"failed to read {path}: {exc}") from exc


def _is_iso(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() is not None


def _criterion(
    criteria: list[dict[str, Any]], criterion_id: str, passed: bool, detail: str
) -> None:
    criteria.append({"id": criterion_id, "passed": bool(passed), "detail": detail})


def _snapshot_root(bundle_root: Path, manifest: dict[str, Any]) -> Path:
    candidates = sorted((bundle_root / "snapshots").glob("real-*"))
    if len(candidates) != 1:
        raise ValidationError(f"expected exactly one real snapshot, found {len(candidates)}")
    expected_prefix = f"real-"
    if not candidates[0].name.startswith(expected_prefix):
        raise ValidationError("invalid snapshot name")
    if manifest["marketContentHash"][:10] not in candidates[0].name:
        raise ValidationError("snapshot name does not contain marketContentHash prefix")
    return candidates[0]


def _manifest_integrity(root: Path, manifest: dict[str, Any]) -> tuple[bool, list[str]]:
    problems: list[str] = []
    listed = manifest.get("files")
    if not isinstance(listed, list):
        return False, ["manifest.files is not a list"]
    paths = [item.get("path") for item in listed if isinstance(item, dict)]
    if len(paths) != len(set(paths)):
        problems.append("duplicate manifest path")
    actual = sorted(
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file()
        and path.relative_to(root).as_posix() not in {"manifest.json", "manifest.sha256"}
    )
    if sorted(paths) != actual:
        problems.append("manifest coverage mismatch")
    by_path = {
        item.get("path"): item for item in listed if isinstance(item, dict) and item.get("path")
    }
    for relative in actual:
        path = root / relative
        raw = path.read_bytes()
        item = by_path.get(relative, {})
        if item.get("sha256") != sha256_bytes(raw):
            problems.append(f"hash mismatch: {relative}")
        if item.get("bytes") != len(raw):
            problems.append(f"byte mismatch: {relative}")
        if item.get("lines") != raw.count(b"\n"):
            problems.append(f"line mismatch: {relative}")
    if manifest.get("fileCount") != len(actual):
        problems.append("fileCount mismatch")
    if manifest.get("totalBytes") != sum((root / relative).stat().st_size for relative in actual):
        problems.append("totalBytes mismatch")
    sha_path = root / "manifest.sha256"
    if not sha_path.is_file():
        problems.append("missing manifest.sha256")
    else:
        expected = sha_path.read_text(encoding="utf-8").split()[0]
        if expected != sha256_file(root / "manifest.json"):
            problems.append("manifest self hash mismatch")
    return not problems, problems


def _git_blob_hash(repo_root: Path, git_sha: str, relative: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "show", f"{git_sha}:{relative}"],
            cwd=repo_root,
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return sha256_bytes(result.stdout)


def _load_corpus_hashes(path: Path | None) -> tuple[set[str], dict[str, str]]:
    if path is None or not path.exists():
        return set(), {}
    payload = _read_json(path)
    hashes: set[str] = set()
    ids: dict[str, str] = {}
    rows: list[Any] = []
    if isinstance(payload, dict):
        for key in ("snapshots", "acceptedSnapshots", "entries"):
            if isinstance(payload.get(key), list):
                rows.extend(payload[key])
    elif isinstance(payload, list):
        rows = payload
    for row in rows:
        if not isinstance(row, dict):
            continue
        accepted = row.get("accepted", True)
        digest = row.get("marketContentHash")
        if accepted is True and isinstance(digest, str):
            hashes.add(digest)
            ids[digest] = str(row.get("snapshotId", "unknown"))
    return hashes, ids
def _load_corpus_rows(path: Path | None) -> list[dict[str, Any]]:
    if path is None or not path.exists():
        return []
    payload = _read_json(path)
    values: list[Any] = []
    if isinstance(payload, list):
        values = payload
    elif isinstance(payload, dict):
        for key in ("snapshots", "acceptedSnapshots", "entries"):
            if isinstance(payload.get(key), list):
                values.extend(payload[key])
    return [row for row in values if isinstance(row, dict)]




def validate_bundle(
    bundle_root: Path,
    *,
    repo_root: Path,
    ci: bool,
    corpus_index: Path | None = None,
    legacy: bool = False,
) -> dict[str, Any]:
    if legacy:
        return validate_legacy_bundle(bundle_root, repo_root=repo_root, ci=ci,
                                      corpus_index=corpus_index)
    root = bundle_root.resolve()
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise ValidationError("missing manifest.json")
    manifest = _read_json(manifest_path)
    if not isinstance(manifest, dict):
        raise ValidationError("manifest is not an object")
    snapshot = _snapshot_root(root, manifest)
    inputs = snapshot / "inputs"
    candidates_path = inputs / "data" / "candidates_stocks.json"
    prescreen_path = inputs / "data" / "prescreen_metadata.json"
    regime_path = inputs / "data" / "regime_state.json"
    criteria: list[dict[str, Any]] = []

    candidates = _read_json(candidates_path) if candidates_path.is_file() else None
    prescreen = _read_json(prescreen_path) if prescreen_path.is_file() else None
    regime = _read_json(regime_path) if regime_path.is_file() else None

    candidate_violations = (
        check_candidates_stocks_payload(candidates, "candidates") if candidates is not None else ["missing"]
    )
    _criterion(criteria, "AC-01", not candidate_violations, repr(candidate_violations))

    meta = candidates.get("_meta", {}) if isinstance(candidates, dict) else {}
    provenance = meta.get("universeProvenance", {}) if isinstance(meta, dict) else {}
    normal = (
        meta.get("pipelinePath") == "normal"
        and provenance.get("jpxFallbackUsed") is False
        and provenance.get("shortlistFallbackUsed") is False
        and provenance.get("shortlistBypassSeedListV1") is False
    )
    _criterion(criteria, "AC-02", normal, f"pipelinePath={meta.get('pipelinePath')!r}")

    fixture_files = list(root.glob("**/tests/fixtures/**"))
    snapshot_meta = _read_json(snapshot / "snapshot.json")
    evidence_class = snapshot_meta.get("evidenceClass") if isinstance(snapshot_meta, dict) else None
    _criterion(
        criteria,
        "AC-03",
        not fixture_files and evidence_class == "real_captured_same_run",
        f"fixtures={len(fixture_files)} evidenceClass={evidence_class!r}",
    )

    run_identity = manifest.get("runIdentity", {})
    run_token = meta.get("runToken") if isinstance(meta, dict) else None
    _criterion(
        criteria,
        "AC-04",
        isinstance(run_identity, dict) and run_token == run_identity.get("runToken"),
        "candidate run token equals manifest",
    )

    same_run = (
        isinstance(candidates, dict)
        and isinstance(prescreen, dict)
        and prescreen.get("generatedAt") == candidates.get("updatedAt")
        and prescreen.get("shortlistId") == provenance.get("shortlistId")
        and prescreen.get("pipelinePath") == meta.get("pipelinePath")
    )
    _criterion(criteria, "AC-05", same_run, "generatedAt/updatedAt + shortlist/pipeline")

    generator_ok = True
    generator_detail: list[str] = []
    for relative in GENERATOR_PATHS:
        expected = manifest.get("generatorSha256", {}).get(relative)
        copied = inputs / "production_code" / Path(relative).name
        git_hash = _git_blob_hash(repo_root, str(manifest.get("gitSha", "")), relative)
        if (
            not isinstance(expected, str)
            or not copied.is_file()
            or git_hash != expected
        ):
            generator_ok = False
            generator_detail.append(relative)
    _criterion(criteria, "AC-06", generator_ok, f"mismatches={generator_detail}")

    parameters = manifest.get("p14Parameters")
    configuration_path = inputs / "configuration.json"
    configuration = _read_json(configuration_path) if configuration_path.is_file() else {}
    config_ok = (
        parameters
        == {
            "threshold": batch.RANK_STABILITY_JACCARD_MIN,
            "topK": batch.TOP_N_STABILITY,
            "perturbationPct": batch.PERTURBATION_PCT,
        }
        and configuration.get("productionThreshold") == batch.RANK_STABILITY_JACCARD_MIN
        and configuration.get("productionTopK") == batch.TOP_N_STABILITY
        and configuration.get("productionPerturbationPct") == batch.PERTURBATION_PCT
        and manifest.get("configurationSha256") == sha256_bytes(canonical_bytes(configuration))
    )
    _criterion(criteria, "AC-07", config_ok, "configuration uses canonical module constants")

    environment_path = root / "environment.json"
    environment = _read_json(environment_path) if environment_path.is_file() else {}
    env_ok = all(
        environment.get(key)
        for key in ("runnerOs", "runnerArch", "pythonVersion", "pipFreeze", "locale", "timezone")
    )
    _criterion(criteria, "AC-08", env_ok, "runner/runtime fields present")

    quality_path = snapshot / "outputs" / "quality-report.json"
    quality = _read_json(quality_path) if quality_path.is_file() else {}
    quality_gate = quality.get("qualityGate") if isinstance(quality, dict) else None
    quality_ok = (
        isinstance(quality_gate, dict)
        and isinstance(quality_gate.get("overallPass"), bool)
        and {gate.get("id") for gate in quality_gate.get("gates", []) if isinstance(gate, dict)}
        >= {f"P-{index:02d}" for index in range(1, 16)}
    )
    _criterion(criteria, "AC-09", quality_ok, "P-01..P-15 report preserved")

    byte_exact = (
        isinstance(manifest.get("inputHashes"), dict)
        and candidates_path.is_file()
        and prescreen_path.is_file()
        and regime_path.is_file()
        and manifest["inputHashes"].get("candidates") == sha256_file(candidates_path)
        and manifest["inputHashes"].get("prescreen") == sha256_file(prescreen_path)
        and manifest["inputHashes"].get("regime") == sha256_file(regime_path)
    )
    _criterion(criteria, "AC-10", byte_exact, "byte-exact input hashes")

    manifest_ok, manifest_problems = _manifest_integrity(root, manifest)
    required_keys_ok = REQUIRED_MANIFEST_KEYS <= set(manifest)
    _criterion(
        criteria,
        "AC-11",
        manifest_ok and required_keys_ok,
        repr(manifest_problems + ([] if required_keys_ok else ["missing required manifest keys"])),
    )

    timestamps = manifest.get("sourceTimestamps", {})
    timestamps_ok = isinstance(timestamps, dict) and all(
        _is_iso(timestamps.get(key))
        for key in (
            "candidatesUpdatedAt",
            "candidatesSourceUpdatedAt",
            "prescreenGeneratedAt",
            "regimeGeneratedAt",
        )
    )
    _criterion(criteria, "AC-12", timestamps_ok, repr(timestamps))

    run_ok = (
        isinstance(run_identity, dict)
        and bool(str(run_identity.get("runId", "")))
        and bool(str(run_identity.get("runAttempt", "")))
    )
    _criterion(criteria, "AC-13", run_ok, "run ID and attempt present")

    _criterion(
        criteria,
        "AC-14",
        manifest.get("gitRefType") == "branch"
        and manifest.get("gitRef") == "refs/heads/v13.3-dev",
        f"{manifest.get('gitRefType')}/{manifest.get('gitRef')}",
    )

    git_sha = manifest.get("gitSha")
    _criterion(
        criteria,
        "AC-15",
        isinstance(git_sha, str)
        and re.fullmatch(r"[0-9a-f]{40}", git_sha) is not None
        and git_sha == run_identity.get("gitSha"),
        f"gitSha={git_sha!r}",
    )

    runtime_ok = (
        str(environment.get("pythonVersion", "")).startswith("3.11.")
        and isinstance(environment.get("pipFreeze"), list)
        and bool(environment.get("pipFreeze"))
    )
    _criterion(criteria, "AC-16", runtime_ok, repr(environment.get("pythonVersion")))

    timezone_ok = (
        environment.get("timezone") == "UTC"
        and environment.get("pythonHashSeed") == "0"
        and run_identity.get("timezone") == "UTC"
        and run_identity.get("pythonHashSeed") == "0"
    )
    _criterion(criteria, "AC-17", timezone_ok, "UTC + PYTHONHASHSEED=0")

    rerun_path = snapshot / "reruns" / "five-reruns.json"
    reruns = _read_json(rerun_path) if rerun_path.is_file() else []
    rerun_ok = (
        isinstance(reruns, list)
        and len(reruns) == 5
        and len(
            {
                (
                    row.get("assignmentMapSha256"),
                    row.get("baseRankSha256"),
                    row.get("perturbedRankSha256"),
                    row.get("metricsSha256"),
                    row.get("verdict"),
                )
                for row in reruns
                if isinstance(row, dict)
            }
        )
        == 1
    )
    _criterion(criteria, "AC-18", rerun_ok, f"reruns={len(reruns) if isinstance(reruns, list) else -1}")

    population = manifest.get("population")
    vectors_ok = True
    for index in range(1, 6):
        vector_path = snapshot / "ranks" / f"run-{index}-full-rank-vector.json"
        vector = _read_json(vector_path) if vector_path.is_file() else None
        if not isinstance(vector, list) or len(vector) != population:
            vectors_ok = False
    _criterion(criteria, "AC-19", vectors_ok, f"population={population!r}")

    metrics_ok = True
    for index in range(1, 6):
        metric_path = snapshot / "metrics" / f"run-{index}-metrics.json"
        metric = _read_json(metric_path) if metric_path.is_file() else {}
        production = metric.get("productionP14", {}) if isinstance(metric, dict) else {}
        required = {
            "baseTop",
            "perturbedTop",
            "jaccard",
            "retention",
            "swapCount",
            "verdict",
            "assignmentContract",
            "assignmentNote",
        }
        if not isinstance(production, dict) or not required <= set(production):
            metrics_ok = False
    _criterion(criteria, "AC-20", metrics_ok, "base/perturbed/top40/Jaccard/verdict")

    permutations_path = snapshot / "metrics" / "input-order-permutations.json"
    permutations = _read_json(permutations_path) if permutations_path.is_file() else []
    permutation_names = {
        row.get("case") for row in permutations if isinstance(row, dict)
    } if isinstance(permutations, list) else set()
    permutation_ok = (
        permutation_names == set(PERMUTATION_CASES)
        and all(
            not row.get(key)
            for row in permutations
            if isinstance(row, dict)
            for key in (
                "assignmentMismatch",
                "rankVectorMismatch",
                "top40Mismatch",
                "jaccardMismatch",
                "verdictChangedFromOriginal",
            )
        )
    )
    _criterion(criteria, "AC-21", permutation_ok, repr(sorted(permutation_names)))

    privacy_report = scan_bundle(root)
    recorded_privacy = _read_json(root / "validation" / "privacy-report.json")
    privacy_ok = privacy_report["passed"] and recorded_privacy.get("violations") == []
    _criterion(criteria, "AC-22", privacy_ok, repr(privacy_report["violations"]))
    _criterion(criteria, "AC-23", privacy_ok, "recursive forbidden-key scan")

    assignment_ok = (
        manifest.get("assignmentContract") == batch.P14_ASSIGNMENT_CONTRACT
        and configuration.get("assignmentContract") == batch.P14_ASSIGNMENT_CONTRACT
        and all(
            row.get("assignmentContract") == batch.P14_ASSIGNMENT_CONTRACT
            for index in range(1, 6)
            for row in [_read_json(snapshot / "metrics" / f"run-{index}-metrics.json")["productionP14"]]
        )
    )
    _criterion(criteria, "AC-24", assignment_ok, repr(manifest.get("assignmentContract")))

    corpus_hashes, corpus_ids = _load_corpus_hashes(corpus_index)
    digest = manifest.get("marketContentHash")
    distinct = isinstance(digest, str) and digest not in corpus_hashes
    if ci:
        _criterion(criteria, "AC-25", True, "not evaluated in CI mode")
    else:
        _criterion(
            criteria,
            "AC-25",
            distinct,
            "distinct" if distinct else f"duplicate_of:{corpus_ids.get(str(digest), 'unknown')}",
        )

    recompute_ok = False
    if candidates_path.is_file() and prescreen_path.is_file() and regime_path.is_file():
        joined_payload = _read_json(inputs / "joined_candidates.json")
        joined = joined_payload.get("candidates") if isinstance(joined_payload, dict) else None
        if isinstance(joined, list):
            hashes = compute_input_hashes(
                candidates_path.read_bytes(),
                prescreen_path.read_bytes(),
                regime_path.read_bytes(),
                joined,
            )
            recompute_ok = hashes == (
                manifest.get("inputBundleHash"),
                manifest.get("marketContentHash"),
                manifest.get("candidatePopulationHash"),
                manifest.get("prescreenSemanticHash"),
            )
    if not recompute_ok:
        criteria.append(
            {
                "id": "INTEGRITY-HASH-IDENTITIES",
                "passed": False,
                "detail": "semantic/provenance hash recomputation mismatch",
            }
        )

    non_allowlisted = [
        path.name
        for path in (inputs / "data").glob("*")
        if path.is_file() and path.name not in ALLOWED_INPUT_DATA_FILES
    ]
    if non_allowlisted:
        criteria.append(
            {
                "id": "PUBLIC-DATA-ALLOWLIST",
                "passed": False,
                "detail": repr(non_allowlisted),
            }
        )
    missing_analytical = [
        name
        for name in ANALYTICAL_CASES
        if not (snapshot / "ranks" / f"analytical-{name}.json").is_file()
    ]
    if missing_analytical:
        criteria.append(
            {
                "id": "ANALYTICAL-CASES",
                "passed": False,
                "detail": repr(missing_analytical),
            }
        )
    frozen_tests = manifest.get("frozenTests")
    expected_tests = [
        {"id": test_id, "function": function}
        for test_id, function in FROZEN_TEST_MAPPING
    ]
    if frozen_tests != expected_tests:
        criteria.append(
            {
                "id": "FROZEN-TEST-MAPPING",
                "passed": False,
                "detail": "T-01..T-34 mapping is incomplete, duplicated, or changed",
            }
        )
    if not ci:
        status_path = root / "validation" / "status.json"
        status = _read_json(status_path) if status_path.is_file() else {}
        ci_party_ok = (
            status.get("accepted") is True
            and status.get("phase") == "ci-validation-complete"
            and manifest.get("validation", {}).get("ciAccepted") is True
            and manifest.get("acceptance", {}).get("accepted") is True
        )
        if not ci_party_ok:
            criteria.append(
                {
                    "id": "TWO-PARTY-CI-RESULT",
                    "passed": False,
                    "detail": "offline acceptance requires prior CI validator PASS",
                }
            )

    failed = [item["id"] for item in criteria if not item["passed"]]
    duplicate = not ci and failed == ["AC-25"]
    accepted = not failed
    snapshot_verdict = "accepted" if accepted else "duplicate" if duplicate else "rejected"
    return {
        "criteriaVersion": ACCEPTANCE_VERSION,
        "mode": "ci" if ci else "offline",
        "accepted": accepted,
        "validCapture": accepted or duplicate,
        "snapshotVerdict": snapshot_verdict,
        "duplicate": duplicate,
        "duplicateOf": corpus_ids.get(str(digest)) if duplicate else None,
        "distinctIncrement": 1 if accepted and not ci else 0,
        "marketContentHash": digest,
        "inputBundleHash": manifest.get("inputBundleHash"),
        "criteria": criteria,
        "failedCriteria": failed,
    }


def validate_legacy_bundle(bundle_root: Path, *, repo_root: Path, ci: bool,
                           corpus_index: Path | None = None) -> dict[str, Any]:
    """Validate the E4 extension without weakening the normal capture path."""
    from data import p14_legacy_replay as legacy

    root = bundle_root.resolve()
    manifest = _read_json(root / "manifest.json")
    if not isinstance(manifest, dict):
        raise ValidationError("manifest is not an object")
    source = manifest.get("legacySource", {})
    source_id = source.get("legacySnapshotId") if isinstance(source, dict) else None
    profile = legacy.LEGACY_SOURCES.get(source_id)
    if profile is None:
        raise ValidationError("unknown legacy source identity")
    snapshots = sorted((root / "snapshots").glob("reeval-*"))
    if len(snapshots) != 1 or snapshots[0].name != f"reeval-{source_id}":
        raise ValidationError("legacy snapshot naming mismatch")
    snapshot, criteria = snapshots[0], []
    inputs = snapshot / "inputs"
    candidates = inputs / "data/candidates_stocks.json"
    prescreen = inputs / "data/prescreen_metadata.json"
    regime = inputs / "data/regime_state.json"

    def check(identifier: str, passed: bool, detail: str) -> None:
        _criterion(criteria, identifier, passed, detail)

    check("E4-IDENTITY",
          manifest.get("captureMode") == "legacy-replay"
          and source.get("legacyKey") == legacy.legacy_key(source_id, profile.market_content_hash)
          and source.get("e1ArchiveSha256") == legacy.E1_ARCHIVE_SHA256
          and source.get("e1ManifestSha256") == legacy.E1_MANIFEST_SHA256,
          "legacy ID/hash/key mapping")
    run = manifest.get("runIdentity", {})
    deviations = manifest.get("legacyDeviations", {})
    check("E4-NO-FABRICATION",
          isinstance(run, dict)
          and all(run.get(key) is None for key in ("runId", "runAttempt", "runToken", "workflow"))
          and run.get("event") == "legacy-replay"
          and re.fullmatch(r"r[0-9]{2}", str(run.get("replayExecutionId", ""))) is not None
          and source.get("replayExecutionId") == run.get("replayExecutionId")
          and source.get("e1ReportSha256") == legacy.E1_REPORT_SHA256
          and source.get("e1GitSource") == profile.e1_git_source
          and source.get("e1EvidenceClass") == profile.e1_evidence_class
          and deviations.get("prescreenBytesReconstructed") is True
          and deviations.get("runTokenSameRunProven") is False
          and deviations.get("legacyProductionRunToken") == profile.production_run_token
          and deviations.get("prescreenGeneratedAtDeltaSeconds")
          == profile.prescreen_delta_seconds
          and deviations.get("regimeSameRunProven") is False
          and isinstance(deviations.get("regimeGeneratedAtDeltaSeconds"), (int, float))
          and deviations.get("p15Evaluable") is False
          and deviations.get("captureMode") == "legacy-replay",
          "null replay identity and complete deviations")
    actual_head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo_root, check=True,
                                 capture_output=True, text=True).stdout.strip()
    check("E4-CURRENT-SHA",
          manifest.get("gitSha") == actual_head == legacy.CURRENT_GIT_SHA
          and manifest.get("gitRef") == legacy.CURRENT_GIT_REF
          and manifest.get("gitRefType") == "branch",
          repr(manifest.get("gitSha")))
    generator_ok = True
    for relative in GENERATOR_PATHS:
        expected = manifest.get("generatorSha256", {}).get(relative)
        copied = inputs / "production_code/data" / Path(relative).name
        generator_ok = generator_ok and isinstance(expected, str) and copied.is_file()
        generator_ok = generator_ok and _git_blob_hash(repo_root, legacy.CURRENT_GIT_SHA,
                                                        relative) == expected
    check("E4-GENERATORS", generator_ok, "HEAD code and copied code hashes")
    environment = _read_json(root / "environment.json")
    runtime_ok = (str(environment.get("pythonVersion", "")).startswith("3.11.")
                  and environment.get("timezone") == "UTC"
                  and environment.get("pythonHashSeed") == "0"
                  and run.get("timezone") == "UTC"
                  and run.get("pythonHashSeed") == "0")
    check("E4-RUNTIME", runtime_ok, repr(environment.get("pythonVersion")))

    check("E4-ASSIGNMENT",
          manifest.get("assignmentContract") == batch.P14_ASSIGNMENT_CONTRACT
          and manifest.get("assignmentNote") == batch.P14_ASSIGNMENT_NOTE
          and manifest.get("p14Parameters") == {
              "threshold": batch.RANK_STABILITY_JACCARD_MIN,
              "topK": batch.TOP_N_STABILITY,
              "perturbationPct": batch.PERTURBATION_PCT,
          }, repr(manifest.get("assignmentContract")))
    configuration = _read_json(inputs / "configuration.json")
    context = configuration.get("context", {}) if isinstance(configuration, dict) else {}
    check("E4-AS-OF",
          source.get("replayAsOf") == context.get("asOf") == profile.replay_as_of
          and context.get("sourceStale") is False
          and not (inputs / "data/candidate_funnel_previous.json").exists(),
          repr(context.get("asOf")))
    raw_ok = all(path.is_file() for path in (candidates, prescreen, regime))
    listed = manifest.get("inputHashes", {})
    raw_ok = raw_ok and listed.get("candidates") == sha256_file(candidates)
    raw_ok = raw_ok and listed.get("prescreen") == sha256_file(prescreen)
    raw_ok = raw_ok and listed.get("regime") == sha256_file(regime)
    check("E4-SOURCE-BYTES", raw_ok, "byte-exact source hashes")
    hashes_ok = False
    source_bundle_hash = None
    if raw_ok:
        joined_payload = _read_json(inputs / "joined_candidates.json")
        joined = joined_payload.get("candidates") if isinstance(joined_payload, dict) else None
        source_bundle_hash = legacy._source_hash(profile, {
            "candidates_stocks.json": candidates.read_bytes(),
            "prescreen_metadata.json": prescreen.read_bytes(),
            "regime_state.json": regime.read_bytes(),
        })
        if isinstance(joined, list):
            computed = compute_input_hashes(candidates.read_bytes(), prescreen.read_bytes(),
                                            regime.read_bytes(), joined)
            hashes_ok = computed == (
                profile.input_bundle_hash, profile.market_content_hash,
                profile.population_hash, profile.prescreen_hash,
            ) == (
                manifest.get("inputBundleHash"), manifest.get("marketContentHash"),
                manifest.get("candidatePopulationHash"), manifest.get("prescreenSemanticHash"),
            )
            hashes_ok = hashes_ok and source.get("legacySourceBundleHash") == source_bundle_hash
    check("E4-HASH-CONTRACT", hashes_ok, "independent hash recomputation")
    evidence = _read_json(snapshot / "snapshot.json")
    check("E4-EVIDENCE-CLASS",
          evidence.get("evidenceClass") == "real_reconstructed"
          and evidence.get("prescreenBytesReconstructed") is True,
          repr(evidence.get("evidenceClass")))
    acceptance = manifest.get("acceptance", {})
    check("E4-WAIVER",
          acceptance.get("legacyExtension") == legacy.LEGACY_EXTENSION
          and acceptance.get("waivedCriteria") == list(legacy.WAIVED_CRITERIA),
          repr(acceptance.get("waivedCriteria")))
    reruns = _read_json(snapshot / "reruns/five-reruns.json")
    reruns_ok = isinstance(reruns, list) and len(reruns) == 5 and all(
        len({row.get(key) for row in reruns}) == 1
        for key in ("baseRankSha256", "perturbedRankSha256", "metricsSha256")
    )
    check("E4-FIVE-RERUNS", reruns_ok, f"count={len(reruns) if isinstance(reruns, list) else -1}")
    permutations = _read_json(snapshot / "metrics/input-order-permutations.json")
    permutations_ok = (
        isinstance(permutations, list)
        and {row.get("case") for row in permutations} == set(PERMUTATION_CASES)
        and all(row.get("verdict") in {"PASS", "FAIL"}
                and row.get("unperturbedScoreChangedCount") == 0
                and row.get("unperturbedRankChangedCount") == 0 for row in permutations)
    )
    check("E4-EIGHT-PERMUTATIONS", permutations_ok, "8 invariant permutations")
    required_outputs = [
        snapshot / "metrics/production-perturbation-assignment.json",
        snapshot / "metrics/production-p14.json",
        snapshot / "metrics/boundary-ranks-30-50.json",
        snapshot / "metrics/score-decomposition-boundary.json",
        snapshot / "metrics/perturbation-decomposition.json",
        snapshot / "metrics/entered-exited.json",
        snapshot / "metrics/multi-k.json",
        snapshot / "metrics/rank-correlation.json",
        snapshot / "outputs/quality-report.json",
    ]
    required_outputs.extend(snapshot / f"ranks/run-{number}-full-rank-vector.json"
                            for number in range(1, 6))
    required_outputs.extend(snapshot / f"metrics/run-{number}-metrics.json"
                            for number in range(1, 6))
    required_outputs.extend(snapshot / f"ranks/analytical-{name}.json"
                            for name in ANALYTICAL_CASES)
    required_outputs.extend(snapshot / "permutations" / case / "production-p14.json"
                            for case in PERMUTATION_CASES)
    required_outputs.extend(snapshot / "permutations" / case / "full-rank-vector.json"
                            for case in PERMUTATION_CASES)
    quality = _read_json(snapshot / "outputs/quality-report.json")
    quality_gate = quality.get("qualityGate", {}) if isinstance(quality, dict) else {}
    quality_ids = {row.get("id") for row in quality_gate.get("gates", [])
                   if isinstance(row, dict)}
    output_ok = (all(path.is_file() for path in required_outputs)
                 and quality.get("p15Evaluable") is False
                 and isinstance(quality_gate.get("overallPass"), bool)
                 and quality_ids >= {f"P-{number:02d}" for number in range(1, 16)})
    check("E4-OUTPUT-CONTRACT", output_ok, "R-01..R-20 required paths and P-01..P-15")
    lineage = _read_json(root / "lineage/source-to-replay.json")
    l01 = lineage.get("L-01", {}) if isinstance(lineage, dict) else {}
    l02 = lineage.get("L-02", {}) if isinstance(lineage, dict) else {}
    l04 = lineage.get("L-04", []) if isinstance(lineage, dict) else []
    l06 = lineage.get("L-06", {}) if isinstance(lineage, dict) else {}
    l08 = lineage.get("L-08", {}) if isinstance(lineage, dict) else {}
    e1_code = l08.get("e1ProductionCodeSha256", {}) if isinstance(l08, dict) else {}
    head_code = l08.get("headProductionCodeSha256", {}) if isinstance(l08, dict) else {}
    lineage_ok = (isinstance(lineage, dict)
                  and all(lineage.get(f"L-{number:02d}") not in (None, {}, [])
                          for number in range(1, 9))
                  and set(lineage.get("L-05", {}))
                  == {f"C-{number:02d}" for number in range(1, 33)}
                  and lineage.get("legacySourceBundleHash") == source_bundle_hash
                  and l01.get("sha256") == legacy.E1_ARCHIVE_SHA256
                  and l01.get("bytes") == legacy.E1_ARCHIVE_BYTES
                  and l01.get("regularFiles") == legacy.E1_ARCHIVE_REGULAR_FILES
                  and l02 == {"e1ManifestSha256": legacy.E1_MANIFEST_SHA256,
                              "e1ReportSha256": legacy.E1_REPORT_SHA256}
                  and isinstance(l04, list) and len(l04) == 3
                  and l06.get("replayInputBundleHash") == profile.input_bundle_hash
                  and l06.get("valuesExpectedToDiffer") is True
                  and isinstance(l06.get("e1DistinctInputSha256"), str)
                  and re.fullmatch(r"[0-9a-f]{64}", l06["e1DistinctInputSha256"]) is not None
                  and head_code == manifest.get("generatorSha256")
                  and set(e1_code) == {"candidate_funnel_engine.py",
                                       "candidate_funnel_batch.py", "build_candidates_stocks.py"}
                  and e1_code["candidate_funnel_batch.py"]
                  != head_code.get("data/candidate_funnel_batch.py")
                  and e1_code["candidate_funnel_engine.py"]
                  == head_code.get("data/candidate_funnel_engine.py")
                  and e1_code["build_candidates_stocks.py"]
                  == head_code.get("data/build_candidates_stocks.py"))
    source_lines = lineage.get("L-03", {}).get("sourceManifestLines", [])
    if lineage_ok:
        for name, path in (("candidates_stocks.json", candidates),
                           ("prescreen_metadata.json", prescreen),
                           ("regime_state.json", regime)):
            if f"{sha256_file(path)}  inputs/data/{name}" not in source_lines:
                lineage_ok = False
    check("E4-LINEAGE", lineage_ok, "L-01..08 and C-01..32")
    controls = _read_json(root / "validation/legacy-control.json")
    controls_ok = (set(controls) == {f"CTL-{number:02d}" for number in range(1, 8)}
                   and all(row.get("passed") is True for row in controls.values()))
    check("E4-CONTROLS", controls_ok, "CTL-01..07")
    fixture_files = list(root.glob("**/tests/fixtures/**"))
    old_output = any(b"input-index parity" in path.read_bytes()
                     for path in root.rglob("*") if path.is_file())
    check("E4-NO-OLD-OUTPUT", not fixture_files and not old_output,
          f"fixtures={len(fixture_files)} oldOutput={old_output}")
    privacy = scan_bundle(root)
    check("E4-PRIVACY", privacy["passed"], repr(privacy["violations"]))
    manifest_ok, problems = _manifest_integrity(root, manifest)
    check("E4-MANIFEST", manifest_ok, repr(problems))
    corpus_hashes, corpus_ids = _load_corpus_hashes(corpus_index)
    comparison = legacy.duplicate_decision(
        profile,
        [item.market_content_hash for key, item in legacy.LEGACY_SOURCES.items()
         if key != source_id],
        _load_corpus_rows(corpus_index),
    )
    duplicate = not ci and comparison["duplicate"]
    if not ci:
        status = _read_json(root / "validation/status.json")
        two_party = (status.get("accepted") is True
                     and status.get("phase") == "ci-validation-complete"
                     and manifest.get("validation", {}).get("ciAccepted") is True
                     and manifest.get("acceptance", {}).get("accepted") is True)
        check("E4-TWO-PARTY", two_party, "offline requires prior CI acceptance")

    # The legacy extension waives exactly AC-04/05/13; it does not replace the
    # remaining frozen acceptance criteria.
    ac: list[dict[str, Any]] = []
    candidate_payload = _read_json(candidates) if candidates.is_file() else None
    prescreen_payload = _read_json(prescreen) if prescreen.is_file() else None
    candidate_violations = (check_candidates_stocks_payload(candidate_payload, "candidates")
                            if candidate_payload is not None else ["missing"])
    _criterion(ac, "AC-01", not candidate_violations, repr(candidate_violations))
    meta = candidate_payload.get("_meta", {}) if isinstance(candidate_payload, dict) else {}
    provenance = meta.get("universeProvenance", {}) if isinstance(meta, dict) else {}
    normal = (meta.get("pipelinePath") == "normal"
              and provenance.get("jpxFallbackUsed") is False
              and provenance.get("shortlistFallbackUsed") is False
              and provenance.get("shortlistBypassSeedListV1") is False)
    _criterion(ac, "AC-02", normal, f"pipelinePath={meta.get('pipelinePath')!r}")
    _criterion(ac, "AC-03", not fixture_files
               and evidence.get("evidenceClass") == "real_reconstructed",
               "legacy real_reconstructed; synthetic/fixture inputs absent")
    _criterion(ac, "AC-04", True, "WAIVED by p14-e4-legacy-replay-1")
    _criterion(ac, "AC-05", True, "WAIVED by p14-e4-legacy-replay-1")
    _criterion(ac, "AC-06", generator_ok, "HEAD generator blobs recorded")
    parameters_ok = (manifest.get("p14Parameters") == {
        "threshold": batch.RANK_STABILITY_JACCARD_MIN,
        "topK": batch.TOP_N_STABILITY,
        "perturbationPct": batch.PERTURBATION_PCT,
    } and configuration.get("productionThreshold") == batch.RANK_STABILITY_JACCARD_MIN
        and configuration.get("productionTopK") == batch.TOP_N_STABILITY
        and configuration.get("productionPerturbationPct") == batch.PERTURBATION_PCT
        and manifest.get("configurationSha256") == sha256_bytes(canonical_bytes(configuration)))
    _criterion(ac, "AC-07", parameters_ok, "configuration uses current module constants")
    env_fields = all(environment.get(key) for key in (
        "runnerOs", "runnerArch", "pythonVersion", "pipFreeze", "locale", "timezone"))
    _criterion(ac, "AC-08", env_fields, "replay runtime fields present")
    quality_ok = (isinstance(quality_gate, dict)
                  and isinstance(quality_gate.get("overallPass"), bool)
                  and quality_ids >= {f"P-{number:02d}" for number in range(1, 16)})
    _criterion(ac, "AC-09", quality_ok, "P-01..P-15 report preserved")
    _criterion(ac, "AC-10", raw_ok, "byte-exact input hashes")
    required_keys_ok = REQUIRED_MANIFEST_KEYS <= set(manifest)
    _criterion(ac, "AC-11", manifest_ok and required_keys_ok,
               repr(problems + ([] if required_keys_ok else ["missing required manifest keys"])))
    timestamps = manifest.get("sourceTimestamps", {})
    timestamps_ok = isinstance(timestamps, dict) and all(_is_iso(timestamps.get(key)) for key in (
        "candidatesUpdatedAt", "candidatesSourceUpdatedAt",
        "prescreenGeneratedAt", "regimeGeneratedAt"))
    _criterion(ac, "AC-12", timestamps_ok, repr(timestamps))
    _criterion(ac, "AC-13", True, "WAIVED by p14-e4-legacy-replay-1")
    _criterion(ac, "AC-14", manifest.get("gitRefType") == "branch"
               and manifest.get("gitRef") == legacy.CURRENT_GIT_REF,
               f"{manifest.get('gitRefType')}/{manifest.get('gitRef')}")
    _criterion(ac, "AC-15", manifest.get("gitSha") == run.get("gitSha") == legacy.CURRENT_GIT_SHA,
               repr(manifest.get("gitSha")))
    _criterion(ac, "AC-16", str(environment.get("pythonVersion", "")).startswith("3.11.")
               and isinstance(environment.get("pipFreeze"), list)
               and bool(environment.get("pipFreeze")), repr(environment.get("pythonVersion")))
    _criterion(ac, "AC-17", runtime_ok and bool(environment.get("locale"))
               and run.get("locale") == "C.UTF-8", "UTC/C.UTF-8/PYTHONHASHSEED=0")
    rerun_ac = (reruns_ok and all(isinstance(row, dict) for row in reruns)
                and len({(row.get("assignmentMapSha256"), row.get("baseRankSha256"),
                          row.get("perturbedRankSha256"), row.get("metricsSha256"),
                          row.get("verdict")) for row in reruns}) == 1)
    _criterion(ac, "AC-18", rerun_ac, f"reruns={len(reruns) if isinstance(reruns, list) else -1}")
    population = manifest.get("population")
    vectors_ok = all(isinstance(_read_json(snapshot / f"ranks/run-{number}-full-rank-vector.json"), list)
                     and len(_read_json(snapshot / f"ranks/run-{number}-full-rank-vector.json"))
                     == population for number in range(1, 6))
    _criterion(ac, "AC-19", vectors_ok, f"population={population!r}")
    required_metric_keys = {"baseTop", "perturbedTop", "jaccard", "retention", "swapCount",
                            "verdict", "assignmentContract", "assignmentNote"}
    metrics_ok = all(required_metric_keys <= set(
        _read_json(snapshot / f"metrics/run-{number}-metrics.json").get("productionP14", {}))
        for number in range(1, 6))
    _criterion(ac, "AC-20", metrics_ok, "base/perturbed/top40/Jaccard/verdict")
    permutation_ac = (permutations_ok and all(not row.get(key) for row in permutations
        for key in ("assignmentMismatch", "rankVectorMismatch", "top40Mismatch",
                    "jaccardMismatch", "verdictChangedFromOriginal")))
    _criterion(ac, "AC-21", permutation_ac, "eight invariant permutations")
    recorded_privacy = _read_json(root / "validation/privacy-report.json")
    privacy_ok = privacy["passed"] and recorded_privacy.get("violations") == []
    _criterion(ac, "AC-22", privacy_ok, repr(privacy["violations"]))
    _criterion(ac, "AC-23", privacy_ok, "recursive forbidden-key scan")
    assignment_path = snapshot / "metrics/production-perturbation-assignment.json"
    assignment = _read_json(assignment_path)
    joined_payload = _read_json(inputs / "joined_candidates.json")
    joined = joined_payload.get("candidates", []) if isinstance(joined_payload, dict) else []
    signs = batch._p14_canonical_sign_by_code(joined)
    ordinals = {code: number for number, code in enumerate(signs)}
    expected_records = [
        {"code": row["code"], "canonicalOrdinal": ordinals[row["code"]],
         "sign": signs[row["code"]],
         "perMultiplier": 1 + signs[row["code"]] * batch.PERTURBATION_PCT,
         "roeMultiplier": 1 - signs[row["code"]] * batch.PERTURBATION_PCT}
        for row in joined if isinstance(row, dict) and row.get("code") in signs
    ]
    assignment_ok = (manifest.get("assignmentContract") == batch.P14_ASSIGNMENT_CONTRACT
                     and configuration.get("assignmentContract") == batch.P14_ASSIGNMENT_CONTRACT
                     and assignment.get("assignmentAuthority") == batch.P14_ASSIGNMENT_CONTRACT
                     and assignment.get("assignmentNote") == batch.P14_ASSIGNMENT_NOTE
                     and assignment.get("perturbationPct") == batch.PERTURBATION_PCT
                     and assignment.get("records") == expected_records
                     and all(_read_json(snapshot / f"metrics/run-{number}-metrics.json")
                             ["productionP14"].get("assignmentContract")
                             == batch.P14_ASSIGNMENT_CONTRACT for number in range(1, 6)))
    _criterion(ac, "AC-24", assignment_ok, repr(manifest.get("assignmentContract")))
    _criterion(ac, "AC-25", True,
               "legacy duplicate outcome is accepted without a distinct-count increment")
    check("E4-FROZEN-MAPPING", manifest.get("frozenTests") == [
        {"id": key, "function": value} for key, value in legacy.E4_TEST_MAPPING]
        and manifest.get("mutations") == [
            {"id": key, "name": value} for key, value in legacy.MUTATION_MAPPING],
        "E4-T-01..24 and E4-M-01..16 exact mapping")
    context_contract = (context.get("pipelinePath") == "normal"
                        and context.get("regime") == "uncertain"
                        and context.get("sourceStale") is False
                        and context.get("fallbackProvenance") is False
                        and context.get("staleThresholdHours") == 48
                        and context.get("prescreenFallbackUsed") is False)
    check("E4-CONTEXT", context_contract, repr(context))
    lineage_reference = lineage.get("L-07", {})
    check("E4-LINEAGE-VALUES", lineage_reference.get("oldOutputReused") is False
          and lineage_reference.get("e1PreO2Reference")
          == legacy.E1_OUTPUT_SUMMARIES[source_id]
          and isinstance(lineage_reference.get("replay", {}).get("permutations"), list),
          "E1 pre-O2 reference and current replay are side-by-side")
    criteria = ac + criteria

    failed = [row["id"] for row in criteria if row["passed"] is False]
    valid = not failed
    if valid:
        outcome = ("ACCEPTED_LEGACY_REPLAY_DUPLICATE" if duplicate
                   else "ACCEPTED_LEGACY_REPLAY_DISTINCT")
    elif any(key in failed for key in ("E4-LINEAGE", "E4-LINEAGE-VALUES")):
        outcome = "REJECTED_LEGACY_LINEAGE"
    elif any(key in failed for key in ("AC-22", "AC-23", "E4-PRIVACY")):
        outcome = "REJECTED_LEGACY_PRIVACY"
    elif any(key in failed for key in ("AC-10", "AC-11", "E4-IDENTITY", "E4-SOURCE-BYTES",
                                       "E4-HASH-CONTRACT", "E4-MANIFEST")):
        outcome = "REJECTED_LEGACY_INTEGRITY"
    else:
        outcome = "REJECTED_LEGACY_VALIDATION"
    increments = legacy.count_increments(outcome)
    return {
        "criteriaVersion": ACCEPTANCE_VERSION, "legacyExtension": legacy.LEGACY_EXTENSION,
        "mode": "ci" if ci else "offline", "legacy": True, "accepted": valid,
        "validCapture": valid,
        "snapshotVerdict": "duplicate" if valid and duplicate else "accepted" if valid else "rejected",
        "legacyReplayOutcome": outcome, "duplicate": duplicate,
        "duplicateOf": corpus_ids.get(profile.market_content_hash) if duplicate else None,
        "distinctIncrement": increments["distinctCount"],
        "duplicateComparisons": comparison["comparisons"],
        "realCapturedSameRunIncrement": increments["realCapturedSameRunCount"],
        "realReconstructedIncrement": increments["realReconstructedCount"],
        "marketContentHash": profile.market_content_hash,
        "inputBundleHash": profile.input_bundle_hash, "criteria": criteria,
        "failedCriteria": failed, "waivedCriteria": list(legacy.WAIVED_CRITERIA),
    }


def _write_ci_result(bundle_root: Path, report: dict[str, Any]) -> None:
    root = bundle_root.resolve()
    status = {
        "accepted": report["accepted"],
        "phase": "ci-validation-complete",
        "criteriaVersion": ACCEPTANCE_VERSION,
        "failedCriteria": report["failedCriteria"],
        "snapshotVerdict": report["snapshotVerdict"],
    }
    status["legacyReplayOutcome"] = report.get("legacyReplayOutcome")
    write_json(root / "validation" / "status.json", status)
    write_json(root / "validation" / "acceptance-report.json", report)
    manifest = _read_json(root / "manifest.json")
    manifest["validation"] = {
        "ciAccepted": report["accepted"],
        "offlineRequired": True,
        "twoPartyRule": True,
    }
    manifest["acceptance"] = {
        "accepted": report["accepted"],
        "criteriaVersion": ACCEPTANCE_VERSION,
        "failedCriteria": report["failedCriteria"],
    }
    if report.get("legacy"):
        from data import p14_legacy_replay as legacy
        manifest["acceptance"]["legacyExtension"] = legacy.LEGACY_EXTENSION
        manifest["acceptance"]["waivedCriteria"] = list(legacy.WAIVED_CRITERIA)
        manifest["acceptance"]["waiverAuthority"] = "P14-E4-A1 §9.6"
    finalize_manifest(root, manifest)


def main(argv: list[str] | tuple[str, ...] = ()) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).parents[1])
    parser.add_argument("--ci", action="store_true")
    parser.add_argument("--corpus-index", type=Path)
    parser.add_argument("--legacy", action="store_true")
    args = parser.parse_args(argv)
    if args.ci and args.corpus_index is not None:
        parser.error("--ci and --corpus-index are mutually exclusive")
    if not args.ci and args.corpus_index is None:
        parser.error("offline mode requires --corpus-index")
    try:
        report = validate_bundle(
            args.bundle,
            repo_root=args.repo_root.resolve(),
            ci=args.ci,
            corpus_index=args.corpus_index,
            legacy=args.legacy,
        )
        if args.ci:
            _write_ci_result(args.bundle, report)
            report = validate_bundle(
                args.bundle,
                repo_root=args.repo_root.resolve(),
                ci=True,
                corpus_index=None,
                legacy=args.legacy,
            )
    except (ValidationError, OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"accepted": False, "snapshotVerdict": "rejected", "error": str(exc)}))
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["validCapture"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
