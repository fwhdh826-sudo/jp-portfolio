#!/usr/bin/env python3
"""Fail-closed current-canonical tooling for P-14 legacy E1 replay."""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
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
from data.p14_evidence_privacy_filter import PrivacyViolation, scan_bundle

CURRENT_GIT_SHA = "8cfa55680a643415f18c6df8eb5ff2d767a0b77f"
CURRENT_GIT_REF = "refs/heads/v13.3-dev"
TOOLING_SOURCE_HASHES = {
    "data/p14_evidence_validate.py":
        "899d9db04c9913c37ae5c2cc810d5cd5f1c56ee9667088d34c70bf6f0eb4f050",
    "data/p14_evidence_capture.py":
        "f8a37b5c9cd3d6c5ae344aa3ecaf6e6113f51baf2a6539456ef9aea704dc4a06",
    "data/p14_evidence_privacy_filter.py":
        "f8740ca263b5a90cfea340d3132a1b245b4fcba63905b2f063fad3fb391d7c8d",
}
WAIVER_AUTHORITY = "P14-E2-A1 §8.1 real_reconstructed grandfather + P14-E4-A1 §9.6"
PRODUCTION_SOURCE_HASHES = {
    "data/candidate_funnel_engine.py": "25e12a4217ace5d807963b54fe2e9918d8613c834b06b730fff8701a4b45d710",
    "data/candidate_funnel_batch.py": "e68fff47290b3f882a5be7251cee433a89a8464fc4b6adb7460ec66e0881762c",
    "data/build_candidates_stocks.py": "acc248fba4919f29814fcb17dcfdd6343c1c4c2488da005b4c1c56b518b97b7a",
}
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
        "test_delivered_commit_uses_base_pinned_replay_repository",
        "test_live_replay_target_head_check_remains_strict",
        "test_tooling_and_replay_sha_roles_are_distinct",
        "test_permutation_score_changed_count_is_exact",
        "test_permutation_rank_changed_count_is_exact",
        "test_permutation_score_and_rank_counts_are_independent",
        "test_waiver_authority_exact_contract",
        "test_regime_state_byte_identity_is_bound",
        "test_legacy_source_bundle_hash_is_bound_to_manifest_and_lineage",
        "test_partial_output_failure_is_atomic_and_cleaned",
        "test_normal_status_schema_excludes_legacy_fields",
        "test_cli_argument_validation_precedes_archive_verification",
        "test_cli_failures_use_json_error_contract",
        "test_old_output_and_fixture_criteria_are_distinct",
        "test_output_collision_and_cleanup_failure_fail_closed",
        "test_delivered_chain_replay_starts_from_shipped_checkout",
        "test_stale_tooling_anchor_is_rejected",
        "test_partial_e4_stack_is_rejected",
        "test_required_tooling_blobs_are_hash_pinned",
        "test_topology_linear_tip",
        "test_topology_detached_head",
        "test_topology_arbitrary_branch",
        "test_topology_merge_first_parent",
        "test_topology_merge_second_parent",
        "test_topology_same_tree_merge_commit",
        "test_same_ancestry_changed_tooling_tree_is_rejected",
        "test_tooling_identity_is_topology_free",
        "test_perturbation_path_is_consumed",
        "test_rank_order_semantic_change_is_detected",
        "test_o2_observable_branch_detects_swap",
        "test_real_legacy_a_is_not_false_rejected",
        "test_real_legacy_b_is_not_false_rejected",
        "test_noop_perturbation_is_rejected",
        "test_wrong_stage_comparison_is_rejected",
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
        "fixture-target-tooling-head", "current-sha-always-true",
        "alias-target-and-tooling-sha", "score-count-to-bool", "rank-count-to-bool",
        "alias-score-and-rank-counts", "shortened-waiver-authority",
        "arbitrary-waiver-authority", "missing-waiver-authority", "allow-ac01-waiver",
        "allow-ac25-waiver", "remove-regime-byte-predicate",
        "accept-semantic-regime-reserialize", "trust-regime-manifest-hash-only",
        "remove-source-bundle-hash-predicate", "accept-missing-source-bundle-hash",
        "trust-source-change-manifest-only", "remove-manifest-lineage-hash-binding",
        "remove-partial-output-cleanup", "publish-before-postprocess",
        "add-normal-legacy-null-fields", "archive-before-argument-validation",
        "remove-json-error-catches", "merge-old-output-and-fixture-criteria",
        "overwrite-output-collision", "ignore-cleanup-failure",
        "restore-tooling-parent-anchor", "anchor-tooling-blobs-to-i1",
        "synthetic-only-delivered-chain-test", "drop-validate-module-from-required-set",
        "blob-presence-without-hash", "reintroduce-head-caret-in-validator",
        "first-parent-only", "drop-tooling-tree-fingerprint", "require-single-parent",
        "perturbation-not-consumed", "ctl03-always-pass", "ctl03-wrong-stage",
        "invert-o2-observable-branch", "pre-o2-oracle-aliases-o2",
        "ignore-frozen-agreement-counts",
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
    o2_observable: bool
    pre_o2_sign_agreement: int
    perturbed_row_count: int
    base_perturbed_rank_delta: int


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
        False, 200, 200, 166,
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
        False, 200, 199, 164,
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


def _assert_production_sources(repo: Path) -> None:
    for relative, expected in PRODUCTION_SOURCE_HASHES.items():
        path = repo / relative
        if not path.is_file() or capture.sha256_file(path) != expected:
            raise LegacyReplayError("P14_E4_R1_CURRENT_SHA_DRIFT: production source hash")


def tooling_identity(tooling_repo: Path) -> dict[str, Any]:
    implementation_sha = _git(tooling_repo, "rev-parse", "HEAD")
    if not (tooling_repo / "data/p14_legacy_replay.py").is_file():
        raise LegacyReplayError(
            "P14_E4_R2_TOOLING_SOURCE_DRIFT: data/p14_legacy_replay.py"
        )
    actual_hashes: dict[str, str] = {}
    for relative, expected in TOOLING_SOURCE_HASHES.items():
        path = tooling_repo / relative
        if not path.is_file():
            raise LegacyReplayError(f"P14_E4_R2_TOOLING_SOURCE_DRIFT: {relative}")
        actual = capture.sha256_file(path)
        if actual != expected:
            raise LegacyReplayError(f"P14_E4_R2_TOOLING_SOURCE_DRIFT: {relative}")
        actual_hashes[relative] = actual
    _assert_production_sources(tooling_repo)
    return {
        "toolingImplementationSha": implementation_sha,
        "toolingSourceHashes": actual_hashes,
    }


def replay_identity(repo: Path, execution_id: str, started_at: str | None = None) -> dict[str, Any]:
    if re.fullmatch(r"r[0-9]{2}", execution_id) is None:
        raise LegacyReplayError("replay execution ID must match rNN")
    execution_head = _git(repo, "rev-parse", "HEAD")
    if execution_head != CURRENT_GIT_SHA:
        raise LegacyReplayError("P14_E4_R1_CURRENT_SHA_DRIFT")
    _assert_production_sources(repo)
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
            "gitSha": CURRENT_GIT_SHA, "executionRepositoryHead": execution_head,
            "replayExecutionId": execution_id}


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


def _pre_o2_sign_by_code(candidates: list[Any]) -> dict[str, int]:
    """Control oracle for the presentation-index sign contract before O2."""
    return {
        candidate.get("code"): (1 if index % 2 == 0 else -1)
        for index, candidate in enumerate(candidates)
        if isinstance(candidate, dict)
    }


def _correction_controls(
    joined: list[Any], base: dict[str, Any], perturbed: dict[str, Any],
    old_perturbed: dict[str, Any], profile: LegacySourceAuthority,
) -> dict[str, dict[str, Any]]:
    head_signs = batch._p14_canonical_sign_by_code(joined)
    legacy_signs = _pre_o2_sign_by_code(joined)
    agreement = sum(
        head_signs.get(code) == sign for code, sign in legacy_signs.items()
        if code in head_signs
    )
    rank_base = _rank_map(base)
    rank_perturbed = _rank_map(perturbed)
    rank_old_perturbed = _rank_map(old_perturbed)
    rank_delta = sum(
        rank_base.get(code) != rank_perturbed.get(code)
        for code in rank_base.keys() | rank_perturbed.keys()
    )
    perturbed_inputs = batch._perturb_candidates(joined)
    changed_rows = sum(
        isinstance(before, dict) and isinstance(after, dict)
        and any(before.get(field) != after.get(field) for field in ("per", "roe"))
        for before, after in zip(joined, perturbed_inputs, strict=True)
    )
    base_digest = capture.sha256_bytes(capture.canonical_bytes(rank_base))
    perturbed_digest = capture.sha256_bytes(capture.canonical_bytes(rank_perturbed))
    ctl03_observed = rank_perturbed != rank_old_perturbed
    return {
        "CTL-03": {
            "passed": ctl03_observed is profile.o2_observable,
            "o2Observable": profile.o2_observable,
            "rankDifferenceObserved": ctl03_observed,
        },
        "CTL-08": {
            "passed": agreement == profile.pre_o2_sign_agreement
            and (head_signs != legacy_signs) is profile.o2_observable,
            "agreement": agreement,
            "expectedAgreement": profile.pre_o2_sign_agreement,
        },
        "CTL-09": {
            "passed": base_digest != perturbed_digest
            and rank_delta == profile.base_perturbed_rank_delta,
            "baseSemanticDigest": base_digest,
            "perturbedSemanticDigest": perturbed_digest,
            "rankDelta": rank_delta,
            "expectedRankDelta": profile.base_perturbed_rank_delta,
        },
        "CTL-10": {
            "passed": changed_rows == profile.perturbed_row_count,
            "perturbedRepresentationConsumed": changed_rows > 0,
            "changedRows": changed_rows,
            "expectedChangedRows": profile.perturbed_row_count,
        },
    }


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
                 archive_info: dict[str, Any], identity: dict[str, Any],
                 tooling: dict[str, Any], files: dict[str, bytes],
                 source_lines: list[str]) -> Path:
    old_snapshot = next((bundle / "snapshots").glob("real-*"))
    snapshot_id = f"reeval-{profile.snapshot_id}"
    snapshot = old_snapshot.with_name(snapshot_id)
    old_snapshot.rename(snapshot)
    desired_id = f"p14-legacy-replay-{profile.snapshot_id}-{CURRENT_GIT_SHA[:12]}-{identity['replayExecutionId']}"
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
        population = len(joined)
        if (type(row.get("unperturbedScoreChangedCount")) is not int
                or type(row.get("unperturbedRankChangedCount")) is not int
                or not 0 <= row["unperturbedScoreChangedCount"] <= population
                or not 0 <= row["unperturbedRankChangedCount"] <= population):
            raise LegacyReplayError("P14_E4_I2_COUNT_SEMANTICS_FAILED")
        capture.write_json(snapshot / "permutations" / row["case"] / "production-p14.json", row)
    capture.write_json(snapshot / "metrics/input-order-permutations.json", permutations)
    base = json.loads((snapshot / "outputs/run-1/base-engine.json").read_text())
    perturbed = json.loads((snapshot / "outputs/run-1/perturbed-engine.json").read_text())
    old_base = json.loads((source / "outputs/run-1/base-engine.json").read_text())
    old_perturbed = json.loads((source / "outputs/run-1/perturbed-engine.json").read_text())
    correction_controls = _correction_controls(
        joined, base, perturbed, old_perturbed, profile
    )
    controls = {
        "CTL-01": {"passed": joined_hash == profile.joined_sha256},
        "CTL-02": {"passed": _rank_map(base) == _rank_map(old_base)},
        "CTL-03": correction_controls["CTL-03"],
        "CTL-04": {"passed": assignment["assignmentAuthority"] == batch.P14_ASSIGNMENT_CONTRACT},
        "CTL-05": {"passed": len(signs) == 200 and list(signs.values()).count(1) == 100
                              and list(signs.values()).count(-1) == 100},
        "CTL-06": {"passed": hashes[1] == profile.market_content_hash},
        "CTL-07": {"passed": hashes[0] == profile.input_bundle_hash},
        "CTL-08": correction_controls["CTL-08"],
        "CTL-09": correction_controls["CTL-09"],
        "CTL-10": correction_controls["CTL-10"],
    }
    failed = [identifier for identifier, item in controls.items() if not item["passed"]]
    if set(failed) & {"CTL-01", "CTL-06", "CTL-07"}:
        raise LegacyReplayError(
            "P14_E4_R1_SOURCE_INTEGRITY_FAILED: " + ",".join(failed)
        )
    if "CTL-03" in failed:
        raise LegacyReplayError("P14_E4_R1_CURRENT_SHA_DRIFT: CTL-03")
    if failed:
        raise LegacyReplayError("P14_E4_R1_VALIDATION_FAILED: " + ",".join(failed))
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
        "tooling": tooling,
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
                       "waiverAuthority": WAIVER_AUTHORITY},
    })
    privacy = scan_bundle(bundle)
    capture.write_json(bundle / "validation/privacy-report.json", privacy)
    if not privacy["passed"]:
        raise LegacyReplayError("P14_E4_R1_PRIVACY_FAILED")
    pending = {
        "accepted": False, "phase": "pending-independent-ci-validation",
        "criteriaVersion": capture.ACCEPTANCE_VERSION, "legacyExtension": LEGACY_EXTENSION,
        "legacyReplayOutcome": None, "failedCriteria": [],
        "waivedCriteria": list(WAIVED_CRITERIA), "waiverAuthority": WAIVER_AUTHORITY,
    }
    capture.write_json(bundle / "validation/status.json", pending)
    capture.write_json(bundle / "validation/acceptance-report.json", pending)
    capture.finalize_manifest(bundle, manifest)
    return bundle


def _desired_bundle_id(profile: LegacySourceAuthority, execution_id: str) -> str:
    return (f"p14-legacy-replay-{profile.snapshot_id}-{CURRENT_GIT_SHA[:12]}-"
            f"{execution_id}")


def _cleanup_staging(*paths: Path) -> None:
    failures: list[str] = []
    for path in paths:
        if not path.exists():
            continue
        try:
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
        except OSError as exc:
            failures.append(f"{path.name}:{type(exc).__name__}")
    if failures:
        raise LegacyReplayError(
            "P14_E4_I2_PARTIAL_OUTPUT_SAFETY_FAILED: " + ",".join(failures)
        )


def _atomic_stage_and_publish(parent: Path, desired_id: str, producer: Any) -> Path:
    desired = parent / desired_id
    if desired.exists():
        raise LegacyReplayError(f"bundle already exists: {desired_id}")
    parent.mkdir(parents=True, exist_ok=True)
    container = Path(tempfile.mkdtemp(prefix=f".{desired_id}.staging-", dir=parent))
    ready = parent / f".{desired_id}.{container.name.rsplit('-', 1)[-1]}.ready"
    try:
        staged = producer(container)
        if staged.parent != container or not staged.is_dir():
            raise LegacyReplayError("invalid staging result")
        staged.rename(ready)
        container.rmdir()
        if desired.exists():
            raise LegacyReplayError(f"bundle already exists: {desired_id}")
        ready.rename(desired)
        return desired
    except Exception:
        try:
            _cleanup_staging(ready, container)
        except LegacyReplayError as cleanup_error:
            raise cleanup_error
        raise


def _prevalidate_request(*, out_parent: Path, repo_root: Path, tooling_repo: Path,
                         legacy_snapshot_id: str, replay_execution_id: str,
                         as_of: str) -> tuple[LegacySourceAuthority, datetime]:
    profile = LEGACY_SOURCES.get(legacy_snapshot_id)
    if profile is None:
        raise LegacyReplayError("P14_E4_R1_SOURCE_INTEGRITY_FAILED: unknown legacy source")
    pinned = parse_replay_as_of(as_of, profile)
    if re.fullmatch(r"r[0-9]{2}", replay_execution_id) is None:
        raise LegacyReplayError("replay execution ID must match rNN")
    repo, tooling, parent = repo_root.resolve(), tooling_repo.resolve(), out_parent.resolve()
    if repo == tooling:
        raise LegacyReplayError("replay target and tooling repositories must be distinct")
    if parent in {repo, tooling} or repo in parent.parents or tooling in parent.parents:
        raise LegacyReplayError("bundle output must be outside repository worktrees")
    return profile, pinned


def build_legacy_bundle(*, out_parent: Path, repo_root: Path, tooling_repo: Path,
                        source_root: Path, legacy_snapshot_id: str,
                        replay_execution_id: str, as_of: str,
                        archive_info: dict[str, Any], started_at: str | None = None) -> Path:
    profile, pinned = _prevalidate_request(
        out_parent=out_parent, repo_root=repo_root, tooling_repo=tooling_repo,
        legacy_snapshot_id=legacy_snapshot_id, replay_execution_id=replay_execution_id,
        as_of=as_of,
    )
    identity = replay_identity(repo_root, replay_execution_id, started_at)
    tooling = tooling_identity(tooling_repo)
    repo, parent = repo_root.resolve(), out_parent.resolve()
    desired_id = _desired_bundle_id(profile, replay_execution_id)
    desired = parent / desired_id
    if desired.exists():
        raise LegacyReplayError(f"bundle already exists: {desired_id}")
    parent.mkdir(parents=True, exist_ok=True)
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

    def produce(container: Path) -> Path:
        _PinnedDateTime.pinned = pinned
        original_datetime = capture.datetime
        capture.datetime = _PinnedDateTime
        try:
            staged = capture.build_bundle(
                out_parent=container, repo_root=repo, run_identity=identity,
                candidates_path=source / "inputs/data/candidates_stocks.json",
                prescreen_path=source / "inputs/data/prescreen_metadata.json",
                regime_path=source / "inputs/data/regime_state.json", previous_path=None,
            )
        finally:
            capture.datetime = original_datetime
        return _postprocess(
            staged, source, profile, archive_info, identity, tooling, files, source_lines
        )

    return _atomic_stage_and_publish(parent, desired_id, produce)

def build_from_archive(*, archive: Path, out_parent: Path, repo_root: Path,
                       tooling_repo: Path, legacy_snapshot_id: str,
                       replay_execution_id: str, as_of: str) -> Path:
    _prevalidate_request(
        out_parent=out_parent, repo_root=repo_root, tooling_repo=tooling_repo,
        legacy_snapshot_id=legacy_snapshot_id, replay_execution_id=replay_execution_id,
        as_of=as_of,
    )
    info = verify_archive(archive)
    with tempfile.TemporaryDirectory(prefix="p14-e4-source-") as temporary:
        root = _extract(archive, Path(temporary))
        bundle = build_legacy_bundle(
            out_parent=out_parent, repo_root=repo_root, tooling_repo=tooling_repo,
            source_root=root, legacy_snapshot_id=legacy_snapshot_id,
            replay_execution_id=replay_execution_id, as_of=as_of, archive_info=info,
        )
    verify_archive(archive)
    return bundle


def main(argv: list[str] | tuple[str, ...] = ()) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--legacy-source", choices=sorted(LEGACY_SOURCES), required=True)
    parser.add_argument("--replay-execution-id", required=True)
    parser.add_argument("--as-of", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--tooling-repo", type=Path, default=Path(__file__).parents[1])
    args = parser.parse_args(argv)
    try:
        bundle = build_from_archive(archive=args.archive.resolve(), out_parent=args.out.resolve(),
                                    repo_root=args.repo_root.resolve(),
                                    tooling_repo=args.tooling_repo.resolve(),
                                    legacy_snapshot_id=args.legacy_source,
                                    replay_execution_id=args.replay_execution_id,
                                    as_of=args.as_of)
    except (LegacyReplayError, PrivacyViolation, subprocess.SubprocessError, OSError,
            ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"accepted": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(bundle)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
