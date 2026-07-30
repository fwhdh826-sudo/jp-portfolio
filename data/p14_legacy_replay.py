#!/usr/bin/env python3
"""Fail-closed current-canonical tooling for P-14 legacy E1 replay."""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from data import candidate_funnel_batch as batch
from data import p14_evidence_capture as capture
from data.p14_evidence_privacy_filter import scan_bundle

CURRENT_GIT_SHA = "8cfa55680a643415f18c6df8eb5ff2d767a0b77f"
CURRENT_GIT_REF = "refs/heads/v13.3-dev"
E1_ARCHIVE_SHA256 = "35f55858a9dd243371de9aa4575e3816ebefbdf0526d9500213961ff74be252e"
E1_ARCHIVE_BYTES = 7_517_928
E1_ARCHIVE_REGULAR_FILES = 330
E1_MANIFEST_SHA256 = "559cb8272734565609a753553540e5fd71e43deeb94ee2dafc363297a0eea681"
E1_REPORT_SHA256 = "b0faf1d8b8cc7084136eda0aa319d671be438d843224a1e3cbc1a7bcc6779c65"
LEGACY_EXTENSION = "p14-e4-legacy-replay-1"
WAIVED_CRITERIA = ("AC-04", "AC-05", "AC-13")
REUSE_INPUT_NAMES = ("candidates_stocks.json", "prescreen_metadata.json", "regime_state.json")
OUTCOMES = frozenset({
    "ACCEPTED_LEGACY_REPLAY_DISTINCT", "ACCEPTED_LEGACY_REPLAY_DUPLICATE",
    "REJECTED_LEGACY_LINEAGE", "REJECTED_LEGACY_PRIVACY",
    "REJECTED_LEGACY_INTEGRITY", "REJECTED_LEGACY_VALIDATION",
})
E4_TEST_MAPPING = tuple(
    (f"E4-T-{number:02d}", name)
    for number, name in enumerate((
        "test_two_legacy_sets_are_uniquely_identified",
        "test_legacy_source_bytes_are_unchanged",
        "test_source_hashes_match_archive_source_manifest",
        "test_e1_archive_sha256_and_file_count_unchanged",
        "test_current_git_sha_is_fixed_and_matches_manifest",
        "test_assignment_contract_read_from_module_constant",
        "test_old_assignment_output_is_not_reused",
        "test_five_reruns_are_hash_identical",
        "test_eight_permutations_present_with_verdicts",
        "test_permutation_base_scores_are_invariant",
        "test_market_content_hash_independently_recomputed",
        "test_input_bundle_hash_matches_frozen_prediction",
        "test_duplicate_detection_follows_frozen_order",
        "test_privacy_scan_zero_violations",
        "test_test_fixtures_are_never_bundled",
        "test_lineage_map_is_complete",
        "test_missing_metadata_fails_closed",
        "test_waived_criteria_are_exactly_ac04_ac05_ac13",
        "test_corpus_index_count_semantics",
        "test_corpus_index_is_append_only",
        "test_repository_side_effects_are_zero",
        "test_context_as_of_is_pinned_to_legacy_value",
        "test_previous_artifact_is_not_current_head_artifact",
        "test_control_checks_ctl01_to_ctl07",
    ), start=1)
)
MUTATION_MAPPING = tuple(
    (f"E4-M-{number:02d}", name)
    for number, name in enumerate((
        "swap-legacy-input-sets", "alter-one-source-byte", "reuse-old-assignment-output",
        "change-git-sha", "change-assignment-contract", "omit-lineage-mapping",
        "fabricate-run-token", "alter-generated-at", "include-forbidden-private-key",
        "force-distinct-despite-duplicate", "count-rejected-replay",
        "overwrite-existing-corpus-entry", "allow-incomplete-manifest",
        "silently-normalize-source-bytes", "count-legacy-as-real-captured-same-run",
        "use-runtime-now-as-as-of",
    ), start=1)
)


E1_OUTPUT_SUMMARIES = {
    "current-dev-committed-20260726": {
        "jaccard": 0.9512195122,
        "retention": 0.975, "swapCount": 1, "verdict": "PASS",
        "entered": ["9107"], "exited": ["5444"], "permutationVerdictChanges": 2,
        "changedCases": ["code-ascending", "market-rank-ascending"],
    },
    "historical-real-20260714-cache": {
        "jaccard": 0.8604651163,
        "retention": 0.925, "swapCount": 3, "verdict": "FAIL",
        "entered": ["4732", "8253", "9001"], "exited": ["4722", "4768", "8613"],
        "permutationVerdictChanges": 2, "changedCases": ["reverse-order", "code-ascending"],
    },
}
class LegacyReplayError(RuntimeError):
    """A frozen replay contract failed closed."""


@dataclass(frozen=True)
class LegacySourceAuthority:
    snapshot_id: str
    market_content_hash: str
    input_bundle_hash: str
    population_hash: str
    prescreen_hash: str
    replay_as_of: str
    e1_git_source: str
    e1_evidence_class: str
    production_run_token: str | None
    prescreen_delta_seconds: float
    joined_sha256: str
    marker_present: str
    marker_absent: str


LEGACY_SOURCES = {
    "current-dev-committed-20260726": LegacySourceAuthority(
        "current-dev-committed-20260726",
        "ea1686f5927b9880b64aedafb6f18c5d3d1c3089cb451a39d4f966ca598945fd",
        "9bc0f89416d293b43df13ac63a6409c886667f3267a3a245433d8c1e6d4cdbbe",
        "e9ca4d1be6f2b4783cf061d61cd45d9c6049fe87caa2d43ccd2e50f1a4ee8e09",
        "da8358adab8488434f68295f0e43eb4bb3acfffbeea6c30a0cc44d2474ef61d9",
        "2026-07-26T07:11:40.540540+00:00", "0c24afe13d431ac66e99bd084301cf9090594ac6",
        "real_git_snapshot_reconstructed_control", "f7ecc35a-4f5b-4132-be10-24fb651d44ac",
        158.877741, "c2a259a434bb0da473cc56b2822128d35305835379bd3fabf868d99a98839b73",
        "inputs/data/candidate_funnel_source.json", "inputs/data/cheap_prescreen_cache.json",
    ),
    "historical-real-20260714-cache": LegacySourceAuthority(
        "historical-real-20260714-cache",
        "c9b4a0e3e5bcfafcc8670f50324c3b94d6953bf19500faec355784e63bedfd15",
        "8357850fa38875296c36fad3cc9644170c00f2a6351533d517a93ab7d35edc0a",
        "027e2f09062337a5b00ca075415510eaa775d8e40c450101af0caac9e517c37f",
        "433d9c4c4aaddd5ab5738fa24841650adc3c0f49a3d3c829f13840da2293d0c8",
        "2026-07-14T13:56:56.181804+00:00", "871d8ca3773c801665f59dc95dd28c15c8a908a8",
        "real_git_snapshot_exact_cache_lineage", None, 0.000171,
        "7913afd4e311b4e91e11e9511713e4f2e68746ea3acba3a7d2e0002b0bcd8694",
        "inputs/data/cheap_prescreen_cache.json", "inputs/data/candidate_funnel_source.json",
    ),
}
CLASSIFICATIONS = {f"C-{number:02d}": "REFERENCE_ONLY" for number in range(1, 33)}
CLASSIFICATIONS.update({
    "C-01": "REUSE_BYTE_EXACT", "C-02": "REUSE_BYTE_EXACT", "C-03": "REUSE_BYTE_EXACT",
    "C-04": "RECOMPUTE_CURRENT_CANONICAL", "C-09": "FORBIDDEN_REFERENCE_ONLY",
    "C-11": "RECOMPUTE_CURRENT_CANONICAL", "C-13": "FORBIDDEN", "C-14": "FORBIDDEN",
    "C-15": "FORBIDDEN_CONTROL_ONLY", "C-16": "FORBIDDEN", "C-17": "FORBIDDEN",
    "C-18": "FORBIDDEN", "C-19": "FORBIDDEN", "C-24": "REUSE_BYTE_EXACT_AS_OF_PINNED",
    "C-25": "REUSE_OR_INSUFFICIENT", "C-26": "FORBIDDEN", "C-27": "FORBIDDEN",
    "C-28": "FORBIDDEN", "C-29": "FORBIDDEN", "C-31": "INSUFFICIENT",
    "C-32": "RECOMPUTE_CURRENT_CANONICAL",
})


def legacy_key(snapshot_id: str, market_hash: str) -> str:
    profile = LEGACY_SOURCES.get(snapshot_id)
    if profile is None or profile.market_content_hash != market_hash:
        raise LegacyReplayError("P14_E4_R1_SOURCE_INTEGRITY_FAILED: legacy identity mapping")
    return capture.sha256_bytes(capture.canonical_bytes({
        "e1ArchiveSha256": E1_ARCHIVE_SHA256, "legacySnapshotId": snapshot_id,
        "marketContentHash": market_hash,
    }))


def parse_replay_as_of(value: str, profile: LegacySourceAuthority) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError) as exc:
        raise LegacyReplayError("P14_E4_R1_VALIDATION_FAILED: invalid --as-of") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise LegacyReplayError("P14_E4_R1_VALIDATION_FAILED: naive --as-of")
    if value != profile.replay_as_of:
        raise LegacyReplayError("P14_E4_R1_VALIDATION_FAILED: contradictory --as-of")
    return parsed


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True,
                          text=True).stdout.strip()


def replay_identity(repo: Path, execution_id: str, started_at: str | None = None) -> dict[str, Any]:
    if re.fullmatch(r"r[0-9]{2}", execution_id) is None:
        raise LegacyReplayError("replay execution ID must match rNN")
    if _git(repo, "rev-parse", "HEAD") != CURRENT_GIT_SHA:
        raise LegacyReplayError("P14_E4_R1_CURRENT_SHA_DRIFT")
    if not platform.python_version().startswith("3.11."):
        raise LegacyReplayError("P14_E4_R1_VALIDATION_FAILED: Python 3.11 required")
    if (os.environ.get("TZ") != "UTC" or os.environ.get("PYTHONHASHSEED") != "0"
            or os.environ.get("LC_ALL") != "C.UTF-8"):
        raise LegacyReplayError("P14_E4_R1_VALIDATION_FAILED: UTC/hash seed/locale required")
    started = started_at or datetime.now(timezone.utc).isoformat()
    if datetime.fromisoformat(started.replace("Z", "+00:00")).tzinfo is None:
        raise LegacyReplayError("replay startedAt must be timezone-aware")
    return {"runId": None, "runAttempt": None, "runToken": None, "workflow": None,
            "event": "legacy-replay", "startedAt": started, "runnerOs": platform.system(),
            "runnerArch": platform.machine(), "timezone": "UTC",
            "locale": os.environ.get("LC_ALL", ""), "pythonVersion": platform.python_version(),
            "pythonHashSeed": "0", "gitRef": CURRENT_GIT_REF, "gitRefType": "branch",
            "gitSha": CURRENT_GIT_SHA, "replayExecutionId": execution_id}


def count_increments(outcome: str) -> dict[str, int]:
    if outcome not in OUTCOMES:
        raise LegacyReplayError(f"unknown outcome: {outcome}")
    accepted = outcome == "ACCEPTED_LEGACY_REPLAY_DISTINCT"
    return {"distinctCount": int(accepted), "realCapturedSameRunCount": 0,
            "realReconstructedCount": int(accepted)}


def duplicate_decision(profile: LegacySourceAuthority, other_hashes: list[str],
                       corpus_rows: list[dict[str, Any]]) -> dict[str, Any]:
    comparisons = []
    for step, rows in ((1, [{"marketContentHash": value} for value in other_hashes]),
                       (2, corpus_rows)):
        for row in rows:
            if row.get("accepted", True) is not True:
                continue
            matched = row.get("marketContentHash") == profile.market_content_hash
            comparisons.append({"step": step, "marketContentHash": row.get("marketContentHash"),
                                "snapshotId": row.get("snapshotId"), "matched": matched})
            if matched:
                return {"duplicate": True, "duplicateOf": row.get("snapshotId"),
                        "comparisons": comparisons,
                        "outcome": "ACCEPTED_LEGACY_REPLAY_DUPLICATE"}
    return {"duplicate": False, "duplicateOf": None, "comparisons": comparisons,
            "outcome": "ACCEPTED_LEGACY_REPLAY_DISTINCT"}


def assert_corpus_append_only(before: bytes, after: bytes) -> None:
    """Reject mutation or removal of every pre-existing corpus entry."""
    def rows(raw: bytes) -> list[Any]:
        payload = json.loads(raw)
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            for key in ("snapshots", "acceptedSnapshots", "entries"):
                if isinstance(payload.get(key), list):
                    return payload[key]
        raise LegacyReplayError("P14_E4_R1_CORPUS_CONFLICT: invalid corpus index")

    original, updated = rows(before), rows(after)
    if len(updated) < len(original):
        raise LegacyReplayError("P14_E4_R1_CORPUS_CONFLICT: entry removed")
    for index, row in enumerate(original):
        if updated[index] != row:
            raise LegacyReplayError("P14_E4_R1_CORPUS_CONFLICT: existing entry changed")


def verify_archive(path: Path) -> dict[str, Any]:
    if (not path.is_file() or capture.sha256_file(path) != E1_ARCHIVE_SHA256
            or path.stat().st_size != E1_ARCHIVE_BYTES):
        raise LegacyReplayError("P14_E4_R1_SOURCE_INTEGRITY_FAILED: archive identity")
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        regular = [item for item in members if item.isfile()]
        names = [item.name for item in members]
        unsafe = any(name.startswith("/") or ".." in Path(name).parts for name in names)
        if (unsafe or len(names) != len(set(names)) or len(regular) != E1_ARCHIVE_REGULAR_FILES
                or any(item.issym() or item.islnk() or item.isdev() for item in members)):
            raise LegacyReplayError("P14_E4_R1_SOURCE_INTEGRITY_FAILED: archive structure")
        manifests = [item for item in regular if item.name.endswith("/manifest.json")]
        raw = archive.extractfile(manifests[0]).read() if len(manifests) == 1 else b""
        if capture.sha256_bytes(raw) != E1_MANIFEST_SHA256:
            raise LegacyReplayError("P14_E4_R1_SOURCE_INTEGRITY_FAILED: E1 manifest")
    return {"sha256": E1_ARCHIVE_SHA256, "bytes": E1_ARCHIVE_BYTES,
            "regularFiles": E1_ARCHIVE_REGULAR_FILES}


def _extract(path: Path, destination: Path) -> Path:
    with tarfile.open(path, "r:gz") as archive:
        for item in archive.getmembers():
            target = (destination / item.name).resolve()
            if destination.resolve() not in target.parents and target != destination.resolve():
                raise LegacyReplayError("P14_E4_R1_SOURCE_INTEGRITY_FAILED: extraction path")
            if item.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif item.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(item)
                if source is None:
                    raise LegacyReplayError("P14_E4_R1_SOURCE_INTEGRITY_FAILED: archive member")
                target.write_bytes(source.read())
            else:
                raise LegacyReplayError("P14_E4_R1_SOURCE_INTEGRITY_FAILED: archive member type")
    roots = [item for item in destination.iterdir() if item.is_dir()]
    if len(roots) != 1:
        raise LegacyReplayError("P14_E4_R1_SOURCE_INTEGRITY_FAILED: archive root")
    return roots[0]


def _source_manifest(path: Path) -> tuple[list[str], dict[str, str]]:
    lines, values = path.read_text(encoding="utf-8").splitlines(), {}
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        if match is None or match.group(2) in values:
            raise LegacyReplayError("P14_E4_R1_SOURCE_INTEGRITY_FAILED: source manifest")
        values[match.group(2)] = match.group(1)
    return lines, values


def _source_hash(profile: LegacySourceAuthority, files: dict[str, bytes]) -> str:
    hashes = {f"snapshots/{profile.snapshot_id}/inputs/data/{name}": capture.sha256_bytes(raw)
              for name, raw in sorted(files.items())}
    return capture.sha256_bytes(capture.canonical_bytes({
        "e1ArchiveSha256": E1_ARCHIVE_SHA256, "e1ManifestSha256": E1_MANIFEST_SHA256,
        "legacySnapshotId": profile.snapshot_id, "files": hashes,
    }))


def _rank_map(payload: dict[str, Any]) -> dict[str, int]:
    return {row["code"]: row["marketRank"] for row in capture._ranked(payload)}


def _find_distinct_hash(node: Any, snapshot_id: str) -> str | None:
    if isinstance(node, dict):
        if node.get("snapshotId") == snapshot_id:
            value = node.get("distinctInputSha256")
            if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value):
                return value
        for value in node.values():
            found = _find_distinct_hash(value, snapshot_id)
            if found is not None:
                return found
    elif isinstance(node, list):
        for value in node:
            found = _find_distinct_hash(value, snapshot_id)
            if found is not None:
                return found
    return None


class _PinnedDateTime(datetime):
    pinned: datetime

    @classmethod
    def now(cls, tz: Any = None) -> datetime:
        return cls.pinned.astimezone(tz) if tz is not None else cls.pinned.replace(tzinfo=None)


def _postprocess(bundle: Path, source: Path, profile: LegacySourceAuthority,
                 archive_info: dict[str, Any], identity: dict[str, Any], files: dict[str, bytes],
                 source_lines: list[str]) -> Path:
    old_snapshot = next((bundle / "snapshots").glob("real-*"))
    snapshot_id = f"reeval-{profile.snapshot_id}"
    snapshot = old_snapshot.with_name(snapshot_id)
    old_snapshot.rename(snapshot)
    desired_id = f"p14-legacy-replay-{profile.snapshot_id}-{CURRENT_GIT_SHA[:12]}-{identity['replayExecutionId']}"
    desired = bundle.with_name(desired_id)
    if desired.exists():
        raise LegacyReplayError(f"bundle already exists: {desired_id}")
    bundle.rename(desired)
    bundle, snapshot = desired, desired / "snapshots" / snapshot_id
    manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
    configuration_path = snapshot / "inputs/configuration.json"
    configuration = json.loads(configuration_path.read_text(encoding="utf-8"))
    context = configuration.get("context", {})
    if (context.get("asOf") != profile.replay_as_of
            or context.get("prescreenFallbackUsed") is not False):
        raise LegacyReplayError("P14_E4_R1_VALIDATION_FAILED: replay context")
    context.update({"sourceStale": False, "fallbackProvenance": False})
    capture.write_json(configuration_path, configuration)
    joined = json.loads((snapshot / "inputs/joined_candidates.json").read_text())["candidates"]
    hashes = capture.compute_input_hashes(files[REUSE_INPUT_NAMES[0]], files[REUSE_INPUT_NAMES[1]],
                                          files[REUSE_INPUT_NAMES[2]], joined)
    expected = (profile.input_bundle_hash, profile.market_content_hash,
                profile.population_hash, profile.prescreen_hash)
    joined_hash = capture.sha256_bytes(capture.canonical_bytes({"candidates": joined}))
    if hashes != expected or joined_hash != profile.joined_sha256:
        raise LegacyReplayError("P14_E4_R1_SOURCE_INTEGRITY_FAILED: frozen hashes")
    run1 = json.loads((snapshot / "metrics/run-1-metrics.json").read_text())["productionP14"]
    capture.write_json(snapshot / "metrics/production-p14.json", run1)
    capture.write_json(snapshot / "metrics/entered-exited.json",
                       {"entered": run1["entered"], "exited": run1["exited"]})
    correlation = snapshot / "metrics/correlation.json"
    correlation.rename(snapshot / "metrics/rank-correlation.json")
    decomposition = snapshot / "perturbations/decomposition.json"
    decomposition.rename(snapshot / "metrics/perturbation-decomposition.json")
    vector = json.loads((snapshot / "ranks/run-1-full-rank-vector.json").read_text())
    capture.write_json(snapshot / "metrics/score-decomposition-boundary.json",
                       [row for row in vector if 35 <= row["baseRank"] <= 45
                        or 35 <= row["perturbedRank"] <= 45])
    signs = batch._p14_canonical_sign_by_code(joined)
    ordinals = {code: index for index, code in enumerate(signs)}
    assignment = {"perturbationPct": batch.PERTURBATION_PCT,
                  "assignmentAuthority": batch.P14_ASSIGNMENT_CONTRACT,
                  "assignmentNote": batch.P14_ASSIGNMENT_NOTE,
                  "records": [
                      {"code": row["code"], "canonicalOrdinal": ordinals[row["code"]],
                       "sign": signs[row["code"]],
                       "perMultiplier": 1 + signs[row["code"]] * batch.PERTURBATION_PCT,
                       "roeMultiplier": 1 - signs[row["code"]] * batch.PERTURBATION_PCT}
                      for row in joined if isinstance(row, dict) and row.get("code") in signs
                  ]}
    capture.write_json(snapshot / "metrics/production-perturbation-assignment.json", assignment)
    permutations = json.loads((snapshot / "metrics/input-order-permutations.json").read_text())
    for row in permutations:
        row["unperturbedScoreChangedCount"] = int(bool(row["rankVectorMismatch"]))
        row["unperturbedRankChangedCount"] = int(bool(row["rankVectorMismatch"]))
        capture.write_json(snapshot / "permutations" / row["case"] / "production-p14.json", row)
    capture.write_json(snapshot / "metrics/input-order-permutations.json", permutations)
    base = json.loads((snapshot / "outputs/run-1/base-engine.json").read_text())
    perturbed = json.loads((snapshot / "outputs/run-1/perturbed-engine.json").read_text())
    old_base = json.loads((source / "outputs/run-1/base-engine.json").read_text())
    old_perturbed = json.loads((source / "outputs/run-1/perturbed-engine.json").read_text())
    controls = {
        "CTL-01": {"passed": joined_hash == profile.joined_sha256},
        "CTL-02": {"passed": _rank_map(base) == _rank_map(old_base)},
        "CTL-03": {"passed": _rank_map(perturbed) != _rank_map(old_perturbed)},
        "CTL-04": {"passed": assignment["assignmentAuthority"] == batch.P14_ASSIGNMENT_CONTRACT},
        "CTL-05": {"passed": len(signs) == 200 and list(signs.values()).count(1) == 100
                              and list(signs.values()).count(-1) == 100},
        "CTL-06": {"passed": hashes[1] == profile.market_content_hash},
        "CTL-07": {"passed": hashes[0] == profile.input_bundle_hash},
    }
    if not all(item["passed"] for item in controls.values()):
        raise LegacyReplayError("P14_E4_R1_VALIDATION_FAILED: CTL-01..07")
    capture.write_json(bundle / "validation/legacy-control.json", controls)
    source_hash = _source_hash(profile, files)
    prefix = f"snapshots/{profile.snapshot_id}"
    e1_manifest = json.loads((source.parent.parent / "manifest.json").read_text(encoding="utf-8"))
    distinct_input = _find_distinct_hash(e1_manifest, profile.snapshot_id)
    if distinct_input is None:
        raise LegacyReplayError("P14_E4_R1_LINEAGE_INSUFFICIENT: distinct input hash")
    e1_code_hashes = {}
    for name in ("candidate_funnel_engine.py", "candidate_funnel_batch.py",
                 "build_candidates_stocks.py"):
        code_path = source / "inputs/production_code/data" / name
        if not code_path.is_file():
            raise LegacyReplayError("P14_E4_R1_LINEAGE_INSUFFICIENT: E1 production code")
        e1_code_hashes[name] = capture.sha256_file(code_path)
    lineage = {
        "L-01": {"archivePath": "p5-b005-c-p14-e1-evidence.tar.gz", **archive_info},
        "L-02": {"e1ManifestSha256": E1_MANIFEST_SHA256, "e1ReportSha256": E1_REPORT_SHA256},
        "L-03": {"legacySnapshotPath": f"{prefix}/", "sourceManifestLines": source_lines},
        "L-04": [{"archivePath": f"{prefix}/inputs/data/{name}",
                  "replayPath": f"snapshots/{snapshot_id}/inputs/data/{name}",
                  "sha256": capture.sha256_bytes(raw), "bytes": len(raw)}
                 for name, raw in sorted(files.items())],
        "L-05": CLASSIFICATIONS,
        "L-06": {"e1DistinctInputSha256": distinct_input, "replayInputBundleHash": hashes[0],
                  "valuesExpectedToDiffer": True,
                  "reason": "E1 and current replay use different canonicalization contracts"},
        "L-07": {
            "oldOutputReused": False, "e1PreO2Reference": E1_OUTPUT_SUMMARIES[profile.snapshot_id],
            "replay": {**{key: run1[key]
                           for key in ("jaccard", "retention", "swapCount", "verdict",
                                       "entered", "exited")},
                       "permutations": [{"case": row["case"], "verdict": row["verdict"]}
                                        for row in permutations]},
        },
        "L-08": {"e1ProductionCodeSha256": e1_code_hashes,
                  "headProductionCodeSha256": manifest["generatorSha256"],
                  "batchDriftExpected": True},
        "legacySourceBundleHash": source_hash,
    }
    capture.write_json(bundle / "lineage/source-to-replay.json", lineage)
    snapshot_meta = json.loads((snapshot / "snapshot.json").read_text())
    snapshot_meta.update({"snapshotId": snapshot_id, "evidenceClass": "real_reconstructed",
                          "prescreenBytesReconstructed": True})
    capture.write_json(snapshot / "snapshot.json", snapshot_meta)
    quality = json.loads((snapshot / "outputs/quality-report.json").read_text())
    quality["p15Evaluable"] = False
    capture.write_json(snapshot / "outputs/quality-report.json", quality)
    candidate_payload = json.loads(files["candidates_stocks.json"])
    regime_payload = json.loads(files["regime_state.json"])
    regime_delta = None
    if isinstance(candidate_payload.get("updatedAt"), str) and isinstance(
            regime_payload.get("_meta", {}).get("generatedAt"), str):
        regime_delta = (datetime.fromisoformat(regime_payload["_meta"]["generatedAt"].replace("Z", "+00:00"))
                        - datetime.fromisoformat(candidate_payload["updatedAt"].replace("Z", "+00:00"))).total_seconds()

    environment = json.loads((bundle / "environment.json").read_text())
    environment["capturedAt"] = identity["startedAt"]
    capture.write_json(bundle / "environment.json", environment)
    replay_started = datetime.fromisoformat(identity["startedAt"].replace("Z", "+00:00"))
    manifest.update({
        "bundleId": desired_id, "captureMode": "legacy-replay", "gitRef": CURRENT_GIT_REF,
        "createdAt": replay_started.astimezone(timezone.utc).isoformat(),
        "createdAtJst": replay_started.astimezone(capture.JST).isoformat(),
        "gitRefType": "branch", "gitSha": CURRENT_GIT_SHA, "runIdentity": identity,
        "legacySource": {"legacySnapshotId": profile.snapshot_id,
                         "legacyKey": legacy_key(profile.snapshot_id, profile.market_content_hash),
                         "legacySourceBundleHash": source_hash, "e1ArchiveSha256": E1_ARCHIVE_SHA256,
                         "e1ManifestSha256": E1_MANIFEST_SHA256, "e1ReportSha256": E1_REPORT_SHA256,
                         "e1GitSource": profile.e1_git_source,
                         "e1DistinctInputSha256": distinct_input, "e1EvidenceClass": profile.e1_evidence_class,
                         "replayExecutionId": identity["replayExecutionId"],
                         "replayAsOf": profile.replay_as_of},
        "legacyDeviations": {"prescreenBytesReconstructed": True,
                             "runTokenSameRunProven": False,
                             "legacyProductionRunToken": profile.production_run_token,
                             "prescreenGeneratedAtDeltaSeconds": profile.prescreen_delta_seconds,
                             "regimeSameRunProven": False, "regimeGeneratedAtDeltaSeconds": regime_delta,
                             "p15Evaluable": False, "captureMode": "legacy-replay"},
        "configurationSha256": capture.sha256_bytes(capture.canonical_bytes(configuration)),
        "inputBundleHash": hashes[0], "marketContentHash": hashes[1],
        "candidatePopulationHash": hashes[2], "prescreenSemanticHash": hashes[3],
        "frozenTests": [{"id": key, "function": value} for key, value in E4_TEST_MAPPING],
        "mutations": [{"id": key, "name": value} for key, value in MUTATION_MAPPING],
        "acceptance": {"accepted": False, "criteriaVersion": capture.ACCEPTANCE_VERSION,
                       "legacyExtension": LEGACY_EXTENSION, "failedCriteria": [],
                       "waivedCriteria": list(WAIVED_CRITERIA),
                       "waiverAuthority": "P14-E2-A1 §8.1 real_reconstructed grandfather + P14-E4-A1 §9.6"},
    })
    privacy = scan_bundle(bundle)
    capture.write_json(bundle / "validation/privacy-report.json", privacy)
    if not privacy["passed"]:
        raise LegacyReplayError("P14_E4_R1_PRIVACY_FAILED")
    capture.write_json(bundle / "validation/status.json",
                       {"accepted": False, "phase": "pending-independent-ci-validation",
                        "legacyReplayOutcome": None, "failedCriteria": []})
    capture.finalize_manifest(bundle, manifest)
    return bundle


def build_legacy_bundle(*, out_parent: Path, repo_root: Path, source_root: Path,
                        legacy_snapshot_id: str, replay_execution_id: str, as_of: str,
                        archive_info: dict[str, Any], started_at: str | None = None) -> Path:
    profile = LEGACY_SOURCES.get(legacy_snapshot_id)
    if profile is None:
        raise LegacyReplayError("P14_E4_R1_SOURCE_INTEGRITY_FAILED: unknown legacy source")
    pinned = parse_replay_as_of(as_of, profile)
    identity = replay_identity(repo_root, replay_execution_id, started_at)
    repo, parent = repo_root.resolve(), out_parent.resolve()
    if parent == repo or repo in parent.parents:
        raise LegacyReplayError("bundle output must be outside repository worktree")
    source = source_root / "snapshots" / profile.snapshot_id
    if not (source / profile.marker_present).is_file() or (source / profile.marker_absent).exists():
        raise LegacyReplayError("P14_E4_R1_SOURCE_INTEGRITY_FAILED: source marker")
    source_lines, source_manifest = _source_manifest(source / "source-manifest.sha256")
    files = {}
    for name in REUSE_INPUT_NAMES:
        raw = (source / "inputs/data" / name).read_bytes()
        if source_manifest.get(f"inputs/data/{name}") != capture.sha256_bytes(raw):
            raise LegacyReplayError("P14_E4_R1_SOURCE_INTEGRITY_FAILED: source bytes")
        files[name] = raw
    with tempfile.TemporaryDirectory(prefix="p14-e4-stage-") as staging:
        _PinnedDateTime.pinned = pinned
        original_datetime = capture.datetime
        capture.datetime = _PinnedDateTime
        try:
            staged = capture.build_bundle(out_parent=Path(staging), repo_root=repo,
                                          run_identity=identity,
                                          candidates_path=source / "inputs/data/candidates_stocks.json",
                                          prescreen_path=source / "inputs/data/prescreen_metadata.json",
                                          regime_path=source / "inputs/data/regime_state.json",
                                          previous_path=None)
        finally:
            capture.datetime = original_datetime
        target = parent / staged.name
        if target.exists():
            raise LegacyReplayError(f"staging target already exists: {target}")
        staged.rename(target)
    return _postprocess(target, source, profile, archive_info, identity, files, source_lines)


def build_from_archive(*, archive: Path, out_parent: Path, repo_root: Path,
                       legacy_snapshot_id: str, replay_execution_id: str, as_of: str) -> Path:
    info = verify_archive(archive)
    with tempfile.TemporaryDirectory(prefix="p14-e4-source-") as temporary:
        root = _extract(archive, Path(temporary))
        bundle = build_legacy_bundle(out_parent=out_parent, repo_root=repo_root, source_root=root,
                                     legacy_snapshot_id=legacy_snapshot_id,
                                     replay_execution_id=replay_execution_id, as_of=as_of,
                                     archive_info=info)
    verify_archive(archive)
    return bundle


def main(argv: list[str] | tuple[str, ...] = ()) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--legacy-source", choices=sorted(LEGACY_SOURCES), required=True)
    parser.add_argument("--replay-execution-id", required=True)
    parser.add_argument("--as-of", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).parents[1])
    args = parser.parse_args(argv)
    try:
        bundle = build_from_archive(archive=args.archive.resolve(), out_parent=args.out.resolve(),
                                    repo_root=args.repo_root.resolve(),
                                    legacy_snapshot_id=args.legacy_source,
                                    replay_execution_id=args.replay_execution_id,
                                    as_of=args.as_of)
    except (LegacyReplayError, OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"accepted": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(bundle)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
