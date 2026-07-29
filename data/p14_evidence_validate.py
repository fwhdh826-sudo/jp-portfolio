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


def validate_bundle(
    bundle_root: Path,
    *,
    repo_root: Path,
    ci: bool,
    corpus_index: Path | None = None,
) -> dict[str, Any]:
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


def _write_ci_result(bundle_root: Path, report: dict[str, Any]) -> None:
    root = bundle_root.resolve()
    status = {
        "accepted": report["accepted"],
        "phase": "ci-validation-complete",
        "criteriaVersion": ACCEPTANCE_VERSION,
        "failedCriteria": report["failedCriteria"],
        "snapshotVerdict": report["snapshotVerdict"],
    }
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
    finalize_manifest(root, manifest)


def main(argv: list[str] | tuple[str, ...] = ()) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).parents[1])
    parser.add_argument("--ci", action="store_true")
    parser.add_argument("--corpus-index", type=Path)
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
        )
        if args.ci:
            _write_ci_result(args.bundle, report)
            report = validate_bundle(
                args.bundle,
                repo_root=args.repo_root.resolve(),
                ci=True,
                corpus_index=None,
            )
    except (ValidationError, OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"accepted": False, "snapshotVerdict": "rejected", "error": str(exc)}))
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["validCapture"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
