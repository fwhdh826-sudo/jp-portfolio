#!/usr/bin/env python3
"""OPS-P14-2/3: candidate_funnel_batch実運用run（full_batch.yml `update-data`
job）が同一run内で実際に読んだ入力を、P14 PASS/FAILを問わず保全する。

OPS-P14-3 adds a backward-compatible v2 payload containing privacy-clean raw
replay input, full ordered base/perturbed vectors, and a boundary-outside band.
It enables exact P14 and replacement-metric offline recomputation without
changing production scoring, thresholds, ranking, or publication semantics.

`data/p14_evidence_capture.py`（手動workflow_dispatch専用の別corpus、
INV-1でgitSha 8cfa5568にpin済み）とは独立の運用store。あちらを変更・
拡張しない。目的も異なる: あちらは on-demand で fresh market data を
再取得して calibration corpus を作る研究tool、こちらは scheduled production
runのexact same-run inputを毎回（PASS/FAILどちらでも）保全する運用tool。

honesty: このmoduleはevidenceの読み取り・記録のみを行う。
candidate_funnel_batch.py の metric/threshold/gate/publish判定を一切
変更しない — 既存のpure functionをread-onlyで再利用するだけ。
P-14はdeterministic（診断OPS-P14-1で反復/順序shuffle/hashseed/asOf/regime
の5次元にわたり実証済み）であるため、production runが読んだのと同じ
実input file（この評価stepの実行時点でまだdisk上に残っている同一run生成物）
に対する2回目のpure function呼出しはbit-exactに同一結果を返す。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from data import candidate_funnel_batch as batch
from data.candidate_funnel_engine import (
    CANDIDATE_FUNNEL_SCHEMA_VERSION,
    CANDIDATE_FUNNEL_SCORE_VERSION,
    CANDIDATE_FUNNEL_VERSION,
    build_candidate_funnel,
)
from data import p14_handoff as handoff
from data.p14_observation import REPLAY_CANDIDATE_FIELDS
from data.p14_run_evidence_bundle import (
    ACCEPTED_POLICY_VERSIONS,
    CONSUMER_MODULE_PATHS,
    BundleFiles,
    ConsumerIdentity,
    EvidenceBundleError,
    WorkflowStatus,
    build_captured_bundle,
    build_invalid_bundle,
    install_bundle,
    verify_bundle_files,
)
from data.p14_evidence_privacy_filter import (
    assert_private_paths_normalized,
    normalize_private_paths,
    scan_bundle,
    write_minimal_failure_bundle,
)

LEGACY_SCHEMA_VERSION = "candidate-funnel-run-evidence-1"
SCHEMA_VERSION = "candidate-funnel-run-evidence-2"
REPLAY_SCHEMA_VERSION = "candidate-funnel-p14-replay-1"
WORKFLOW = "full_batch.yml"
BOUNDARY_OUTSIDE_BAND_SIZE = 10

# Public compatibility name; the observation module owns the exact allowlist.


class EvidenceCaptureError(RuntimeError):
    """evidence capture固有のfail-closed error（呼び出し元のgate判定とは無関係）。"""


def _sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8"
    )


def _file_hash(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"present": False, "sha256": None, "bytes": None}
    raw = path.read_bytes()
    return {"present": True, "sha256": _sha256_bytes(raw), "bytes": len(raw)}


def _replay_candidate_input(joined_candidates: list[Any]) -> list[Any]:
    """Return the complete privacy-clean scoring input, preserving row order."""
    replay_input: list[Any] = []
    for candidate in joined_candidates:
        if not isinstance(candidate, dict):
            # Invalid rows are part of the engine contract and must remain replayable.
            replay_input.append(candidate)
            continue
        replay_input.append(
            {field: candidate[field] for field in REPLAY_CANDIDATE_FIELDS if field in candidate}
        )
    normalized = normalize_private_paths(replay_input)
    assert_private_paths_normalized(normalized)
    return normalized


def _full_rank_vector(result: dict[str, Any]) -> list[dict[str, Any]]:
    """Return every ranked row in exact marketRank/code order, not only Top40."""
    rows = [
        candidate
        for candidate in result.get("candidates", [])
        if isinstance(candidate, dict) and candidate.get("marketRank") is not None
    ]
    rows.sort(key=lambda candidate: (candidate["marketRank"], candidate.get("code", "")))
    return [
        {
            "code": row.get("code"),
            "prescreenScore": row.get("prescreenScore"),
            "prescreenRank": row.get("prescreenRank"),
            "prescreenPool": row.get("prescreenPool"),
            "marketRank": row.get("marketRank"),
            "marketScore": row.get("marketScore"),
            "rawCompositeScore": row.get("rawCompositeScore"),
        }
        for row in rows
    ]


def _jaccard_from_vectors(
    base_vector: list[dict[str, Any]], perturbed_vector: list[dict[str, Any]], top_k: int
) -> tuple[float, int]:
    base = {row.get("code") for row in base_vector[:top_k]}
    perturbed = {row.get("code") for row in perturbed_vector[:top_k]}
    union = base | perturbed
    return ((len(base & perturbed) / len(union)) if union else 1.0, len(base - perturbed))


def _replay_payload(
    joined_candidates: list[Any],
    context: dict[str, Any],
    engine_result: dict[str, Any],
    perturbed_result: dict[str, Any],
) -> dict[str, Any]:
    clean_candidates = _replay_candidate_input(joined_candidates)
    clean_context = normalize_private_paths(context)
    assert_private_paths_normalized(clean_context)
    base_vector = _full_rank_vector(engine_result)
    perturbed_vector = _full_rank_vector(perturbed_result)
    top_k = batch.TOP_N_STABILITY
    band_end = top_k + BOUNDARY_OUTSIDE_BAND_SIZE
    return {
        "schemaVersion": REPLAY_SCHEMA_VERSION,
        "joinedCandidateInput": clean_candidates,
        "context": clean_context,
        "baseFullOrderedRankVector": base_vector,
        "perturbedFullOrderedRankVector": perturbed_vector,
        "boundaryOutsideBand": {
            "topK": top_k,
            "size": BOUNDARY_OUTSIDE_BAND_SIZE,
            "base": base_vector[top_k:band_end],
            "perturbed": perturbed_vector[top_k:band_end],
        },
    }


def replay_p14(evidence: dict[str, Any]) -> dict[str, Any]:
    """Offline replay and integrity verification for v2; accept v1 read-only.

    The result is deliberately RED (``passed=False``) for any input-hash,
    rank-vector, metric, or verdict mismatch. Legacy OPS-P14-2 v1 evidence stays
    readable/compatible but correctly reports that raw offline replay is absent.
    """
    schema_version = evidence.get("schemaVersion")
    if schema_version == LEGACY_SCHEMA_VERSION:
        return {
            "passed": True,
            "compatible": True,
            "replayable": False,
            "schemaVersion": schema_version,
            "errors": [],
        }

    errors: list[str] = []
    replay = evidence.get("replay")
    if schema_version != SCHEMA_VERSION:
        errors.append("unsupported evidence schema")
    if not isinstance(replay, dict) or replay.get("schemaVersion") != REPLAY_SCHEMA_VERSION:
        errors.append("missing replay payload")
        replay = {}

    joined = replay.get("joinedCandidateInput")
    context = replay.get("context")
    hashes = evidence.get("inputHashes")
    if not isinstance(joined, list) or not isinstance(context, dict) or not isinstance(hashes, dict):
        errors.append("invalid replay input")
    else:
        joined_hash = hashes.get("joinedCandidateInput")
        context_hash = hashes.get("replayContext")
        if not isinstance(joined_hash, dict) or joined_hash.get("sha256") != _sha256_bytes(
            _canonical_bytes(joined)
        ):
            errors.append("joined candidate input hash mismatch")
        if not isinstance(context_hash, dict) or context_hash.get("sha256") != _sha256_bytes(
            _canonical_bytes(context)
        ):
            errors.append("context input hash mismatch")

    # OPS_P14_D2_RELEASE_METRIC_IMPLEMENTATION_R2 / §16 LEGACY_REPLAY_COMPAT:
    # bundles captured before P14_D2 (policyVersion欠落) は必ず旧binary
    # policy（jaccard>=threshold のみ）で再現する。policyVersionが
    # P14_RELEASE_POLICY_VERSIONと一致する新規captureのみ decision-aware
    # composite policyで再現する。既存の歴史的verdictを新policyへ silent
    # migrationしない（frozen historical evidence — do not rewrite）。
    params = evidence.get("p14Parameters")
    is_decision_aware_bundle = (
        isinstance(params, dict) and params.get("policyVersion") == batch.P14_RELEASE_POLICY_VERSION
    )
    if is_decision_aware_bundle:
        expected_params = {
            "threshold": batch.RANK_STABILITY_JACCARD_MIN,
            "topK": batch.TOP_N_STABILITY,
            "perturbationPct": batch.PERTURBATION_PCT,
            "assignmentContract": batch.P14_ASSIGNMENT_CONTRACT,
            "policyVersion": batch.P14_RELEASE_POLICY_VERSION,
        }
    else:
        expected_params = {
            "threshold": batch.RANK_STABILITY_JACCARD_MIN,
            "topK": batch.TOP_N_STABILITY,
            "perturbationPct": batch.PERTURBATION_PCT,
            "assignmentContract": batch.P14_ASSIGNMENT_CONTRACT,
        }
    if params != expected_params:
        errors.append("P14 frozen parameters mismatch")

    recomputed_jaccard: float | None = None
    recomputed_swap_count: int | None = None
    recomputed_verdict: str | None = None
    if not errors:
        base_result = build_candidate_funnel(joined, context)
        _reported_jaccard, perturbed_result = batch.compute_rank_stability(
            joined, context, base_result
        )
        base_vector = _full_rank_vector(base_result)
        perturbed_vector = _full_rank_vector(perturbed_result)
        recomputed_jaccard, recomputed_swap_count = _jaccard_from_vectors(
            base_vector, perturbed_vector, batch.TOP_N_STABILITY
        )
        if is_decision_aware_bundle:
            recomputed_verdict = batch.compute_p14_release_evidence(
                base_result, perturbed_result
            )["final"]["status"]
        else:
            recomputed_verdict = (
                "PASS"
                if recomputed_jaccard >= batch.RANK_STABILITY_JACCARD_MIN
                else "FAIL"
            )
        if replay.get("baseFullOrderedRankVector") != base_vector:
            errors.append("base rank vector mismatch")
        if replay.get("perturbedFullOrderedRankVector") != perturbed_vector:
            errors.append("perturbed rank vector mismatch")
        expected_boundary = {
            "topK": batch.TOP_N_STABILITY,
            "size": BOUNDARY_OUTSIDE_BAND_SIZE,
            "base": base_vector[
                batch.TOP_N_STABILITY : batch.TOP_N_STABILITY + BOUNDARY_OUTSIDE_BAND_SIZE
            ],
            "perturbed": perturbed_vector[
                batch.TOP_N_STABILITY : batch.TOP_N_STABILITY + BOUNDARY_OUTSIDE_BAND_SIZE
            ],
        }
        if replay.get("boundaryOutsideBand") != expected_boundary:
            errors.append("boundary outside band mismatch")
        if _reported_jaccard != recomputed_jaccard:
            errors.append("production P14 metric mismatch")
        p14 = evidence.get("p14") if isinstance(evidence.get("p14"), dict) else {}
        if p14.get("jaccard") != recomputed_jaccard:
            errors.append("P14 jaccard mismatch")
        if p14.get("swapCount") != recomputed_swap_count:
            errors.append("P14 swap count mismatch")
        if p14.get("verdict") != recomputed_verdict:
            errors.append("P14 verdict mismatch")

    return {
        "passed": not errors,
        "compatible": not errors,
        "replayable": True,
        "schemaVersion": schema_version,
        "errors": errors,
        "jaccard": recomputed_jaccard,
        "swapCount": recomputed_swap_count,
        "verdict": recomputed_verdict,
    }


class ReclassificationError(RuntimeError):
    """reclassify_p14 が deterministic replay input を再構成できない場合の
    fail-closed error（historical bundleの改変・再解釈とは無関係）。"""


def reclassify_p14(evidence: dict[str, Any]) -> dict[str, Any]:
    """§16/§17 new-policy reclassification path（replay_p14とは独立）。

    既存の（PASS/FAIL問わず捕捉済みの）v2 evidence bundleが持つ deterministic
    replay input（replay.joinedCandidateInput + replay.context）から base/
    perturbed engine結果を再構成し、P14_RELEASE_POLICY_VERSION
    ("p14-decision-aware-v1") の下でのcomposite evidenceを計算する。

    honesty:
      * historical bundleのschema/p14Parameters/verdictは一切書き換えない
        （この関数はbundleを受け取り、新しいdictを返すだけ — write_bundle等
        呼び出し元へのpersist責務を持たない）。
      * replay_p14()のPASS/FAIL判定・legacy replay verdictには一切関与
        しない（別関数・別呼び出し経路）。
      * scoring/tier/marketRankの再計算はしない — build_candidate_funnel
        （B1, frozen）へreplay inputをそのまま渡すのみ。
    """
    schema_version = evidence.get("schemaVersion")
    if schema_version not in (SCHEMA_VERSION, LEGACY_SCHEMA_VERSION):
        raise ReclassificationError(f"unsupported evidence schema: {schema_version!r}")
    replay = evidence.get("replay")
    if not isinstance(replay, dict) or replay.get("schemaVersion") != REPLAY_SCHEMA_VERSION:
        raise ReclassificationError("missing replay payload; cannot reconstruct engine input")
    joined = replay.get("joinedCandidateInput")
    context = replay.get("context")
    if not isinstance(joined, list) or not isinstance(context, dict):
        raise ReclassificationError("invalid replay input; cannot reconstruct engine input")

    base_result = build_candidate_funnel(joined, context)
    if base_result.get("status") != "generated":
        raise ReclassificationError(f"engine status={base_result.get('status')!r}; P-14 not evaluable")
    _reported_jaccard, perturbed_result = batch.compute_rank_stability(joined, context, base_result)
    release_evidence = batch.compute_p14_release_evidence(base_result, perturbed_result)

    historical = evidence.get("p14") if isinstance(evidence.get("p14"), dict) else {}
    return {
        "reclassificationPolicyVersion": batch.P14_RELEASE_POLICY_VERSION,
        "historicalVerdict": historical.get("verdict"),
        "historicalJaccard": historical.get("jaccard"),
        "historicalSwapCount": historical.get("swapCount"),
        "release": release_evidence,
    }


def _find_gate(gates: list[dict[str, Any]], gate_id: str) -> dict[str, Any] | None:
    for gate in gates:
        if gate.get("id") == gate_id:
            return gate
    return None


def build_evidence(
    *,
    run_identity: dict[str, Any],
    candidates_path: Path,
    prescreen_path: Path,
    regime_path: Path,
    previous_path: Path,
    batch_status: str,
    smoke_status: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    """PASS/FAIL問わず1 candidate_funnel runのevidenceを構築する
    (pure — file書き込みはしない)。real production run（full_batch.yml）が
    同一process内で読んだのと同じ実input file群を、そのままread-onlyで
    再度読み込む。"""
    if now is None:
        now = datetime.now(timezone.utc)

    evidence: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": now.isoformat(),
        "runIdentity": run_identity,
        "inputHashes": {
            "candidatesStocks": _file_hash(candidates_path),
            "prescreenMetadata": _file_hash(prescreen_path),
            "regimeState": _file_hash(regime_path),
            "previousArtifact": _file_hash(previous_path),
        },
        "p14Parameters": {
            "threshold": batch.RANK_STABILITY_JACCARD_MIN,
            "topK": batch.TOP_N_STABILITY,
            "perturbationPct": batch.PERTURBATION_PCT,
            "assignmentContract": batch.P14_ASSIGNMENT_CONTRACT,
            "policyVersion": batch.P14_RELEASE_POLICY_VERSION,
        },
        "publish": {
            "batchStatus": batch_status or None,
            "smokeStatus": smoke_status or None,
        },
    }

    try:
        candidates_stocks_payload = batch.load_candidates_stocks(candidates_path)
    except batch.CandidateFunnelBatchError as exc:
        evidence["captureStatus"] = "input_unavailable"
        evidence["captureError"] = str(exc)
        return evidence

    prescreen_payload = batch.load_prescreen_metadata(prescreen_path)
    regime = batch.read_current_regime(regime_path)
    previous_artifact = batch.load_previous_artifact(previous_path)

    evidence["asOf"] = candidates_stocks_payload.get("sourceUpdatedAt")
    evidence["candidatesUpdatedAt"] = candidates_stocks_payload.get("updatedAt")

    prescreen_index, prescreen_duplicate_codes = batch.build_prescreen_index(prescreen_payload)
    candidates = candidates_stocks_payload.get("candidates", [])
    joined_candidates, join_stats = batch.join_candidates_with_prescreen(candidates, prescreen_index)
    context = batch.build_context(candidates_stocks_payload, regime, now)
    engine_result = build_candidate_funnel(joined_candidates, context)

    quality_report = batch.compute_quality_report(
        candidates_stocks_payload=candidates_stocks_payload,
        joined_candidates=joined_candidates,
        join_stats=join_stats,
        prescreen_duplicate_codes=prescreen_duplicate_codes,
        engine_result=engine_result,
        context=context,
        previous_artifact=previous_artifact,
    )

    evidence["captureStatus"] = "captured"
    evidence["engineStatus"] = engine_result.get("status")
    evidence["joinStats"] = join_stats
    evidence["qualityGate"] = quality_report

    if engine_result.get("status") == "generated":
        jaccard, perturbed_result = batch.compute_rank_stability(joined_candidates, context, engine_result)
        replay = _replay_payload(joined_candidates, context, engine_result, perturbed_result)
        base_vector = replay["baseFullOrderedRankVector"]
        perturbed_vector = replay["perturbedFullOrderedRankVector"]
        _exact_jaccard, swap_count = _jaccard_from_vectors(
            base_vector, perturbed_vector, batch.TOP_N_STABILITY
        )
        p14_gate = _find_gate(quality_report["gates"], "P-14")
        p14_release_evidence = quality_report.get("p14ReleaseEvidence")
        evidence["p14"] = {
            "jaccard": jaccard,
            "swapCount": swap_count,
            "verdict": p14_gate["status"] if p14_gate else None,
            "baseTop40": base_vector[: batch.TOP_N_STABILITY],
            "perturbedTop40": perturbed_vector[: batch.TOP_N_STABILITY],
            # OPS_P14_D2_RELEASE_METRIC_IMPLEMENTATION_R2: decision-aware
            # composite evidence（top40/deepReview/actionable/
            # marketReferenceShortlist/final）。p14ProvesOfficialDecisionStability
            # は常にfalse — holdings非依存のmarket/funnel段階robustness証拠
            # であり、officialDecisionの安定性を証明しない。
            "release": p14_release_evidence,
        }
        evidence["replay"] = replay
        joined_bytes = _canonical_bytes(replay["joinedCandidateInput"])
        context_bytes = _canonical_bytes(replay["context"])
        evidence["inputHashes"]["joinedCandidateInput"] = {
            "present": True,
            "sha256": _sha256_bytes(joined_bytes),
            "bytes": len(joined_bytes),
            "encoding": "canonical-json",
        }
        evidence["inputHashes"]["replayContext"] = {
            "present": True,
            "sha256": _sha256_bytes(context_bytes),
            "bytes": len(context_bytes),
            "encoding": "canonical-json",
        }
    else:
        evidence["p14"] = {
            "status": "N/A",
            "note": f"engineStatus={engine_result.get('status')}のためP-14評価対象外",
        }

    evidence["p13"] = _find_gate(quality_report["gates"], "P-13")
    evidence["p15"] = _find_gate(quality_report["gates"], "P-15")
    evidence["publish"]["overallPass"] = quality_report.get("overallPass")
    evidence["publish"]["hardFailIds"] = quality_report.get("hardFailIds")

    return evidence


def write_bundle(bundle_root: Path, evidence: dict[str, Any]) -> None:
    """evidence.json + 自己hash manifest + privacy scanを書き出す。
    privacy violation検出時はbundleを最小failure reportへ置換する
    （機密dataを絶対にuploadしない）。"""
    # GitHub runner paths (for example /home/runner/work/...) are operational
    # metadata, not privacy violations. Normalize them before the strict scan;
    # forbidden keys and token-shaped secrets remain untouched and fail closed.
    normalized_evidence = normalize_private_paths(evidence)
    assert_private_paths_normalized(normalized_evidence)
    _write_json(bundle_root / "evidence.json", normalized_evidence)

    files: list[dict[str, Any]] = []
    for path in sorted(item for item in bundle_root.rglob("*") if item.is_file()):
        relative = path.relative_to(bundle_root).as_posix()
        if relative in {"manifest.json", "manifest.sha256"}:
            continue
        raw = path.read_bytes()
        files.append({"path": relative, "sha256": _sha256_bytes(raw), "bytes": len(raw)})
    manifest = {
        "schemaVersion": normalized_evidence.get("schemaVersion", SCHEMA_VERSION),
        "bundleId": bundle_root.name,
        "files": files,
        "fileCount": len(files),
        "totalBytes": sum(item["bytes"] for item in files),
    }
    _write_json(bundle_root / "manifest.json", manifest)
    digest = _sha256_bytes((bundle_root / "manifest.json").read_bytes())
    (bundle_root / "manifest.sha256").write_text(f"{digest}  manifest.json\n", encoding="utf-8")

    privacy_report = scan_bundle(bundle_root)
    _write_json(bundle_root / "validation" / "privacy-report.json", privacy_report)
    if not privacy_report["passed"]:
        write_minimal_failure_bundle(bundle_root, privacy_report["violations"])
        raise EvidenceCaptureError(f"privacy violations detected: {privacy_report['violations']}")


def _run_identity_from_environment() -> dict[str, Any]:
    required = (
        "GITHUB_RUN_ID",
        "GITHUB_RUN_ATTEMPT",
        "GITHUB_SHA",
        "GITHUB_REF",
        "GITHUB_REF_TYPE",
        "GITHUB_EVENT_NAME",
    )
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise EvidenceCaptureError(f"missing run identity environment variables: {missing}")
    return {
        "runId": os.environ["GITHUB_RUN_ID"],
        "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"],
        "workflow": WORKFLOW,
        "event": os.environ["GITHUB_EVENT_NAME"],
        "gitSha": os.environ["GITHUB_SHA"],
        "gitRef": os.environ["GITHUB_REF"],
        "gitRefType": os.environ["GITHUB_REF_TYPE"],
        "runnerOs": os.environ.get("RUNNER_OS", platform.system()),
    }


def _schema3_run_identity(value: Mapping[str, Any]) -> dict[str, str]:
    """Validate configuration metadata before retaining it in failure evidence."""
    keys = {
        "repository", "workflow", "job", "runId", "runAttempt", "event",
        "gitRef", "gitRefType", "gitSha",
    }
    if not isinstance(value, Mapping) or set(value) != keys:
        raise EvidenceBundleError("CONSUMER_CONFIGURATION_INVALID", "RUN_IDENTITY")
    owned = dict(value)
    if any(type(item) is not str or not item for item in owned.values()):
        raise EvidenceBundleError("CONSUMER_CONFIGURATION_INVALID", "RUN_IDENTITY")
    try:
        for item in owned.values():
            item.encode("utf-8")
    except UnicodeError:
        raise EvidenceBundleError("CONSUMER_CONFIGURATION_INVALID", "RUN_IDENTITY") from None
    if (
        not re.fullmatch(r"[1-9][0-9]*", owned["runId"])
        or not re.fullmatch(r"[1-9][0-9]*", owned["runAttempt"])
        or not re.fullmatch(r"[0-9a-f]{40}", owned["gitSha"])
        or owned["workflow"] != WORKFLOW
        or owned["job"] != "update-data"
    ):
        raise EvidenceBundleError("CONSUMER_CONFIGURATION_INVALID", "RUN_IDENTITY")
    if any(
        pattern.search(item)
        for item in owned.values()
        for pattern in handoff.SECRET_PATTERNS + handoff.PRIVATE_PATH_PATTERNS
    ):
        raise EvidenceBundleError("CONSUMER_CONFIGURATION_INVALID", "RUN_IDENTITY")
    return owned


def _consumer_identity(repo_root: Path) -> ConsumerIdentity:
    """Main-only checkout identity; event SHA is a separate trust input."""
    executed_sha = subprocess.run(
        ["git", "-C", str(repo_root), "rev-parse", "HEAD"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return ConsumerIdentity(
        executed_sha,
        tuple((path, _sha256_bytes((repo_root / path).read_bytes())) for path in CONSUMER_MODULE_PATHS),
    )


def build_evidence_from_handoff(
    *,
    handoff_root,
    producer_reference,
    run_identity,
    expected_policy_version,
    consumer,
    engine_versions,
    raw_paths,
    workflow,
) -> BundleFiles:
    """Compose audited handoff admission and schema-3 capture without computation.

    ``engine_versions`` is the (schema, score, funnel) constant tuple;
    ``raw_paths`` maps the four RAW_FILE_NAMES to explicit paths. Producer module
    hashes come from this module's checkout, never from observed handoff data.
    No workflow environment, loader, clock, join, engine, or release evaluator
    supplies authority to this explicit API.
    """
    stage = "CONFIGURATION"
    safe_run = None
    safe_consumer = consumer if isinstance(consumer, ConsumerIdentity) else None
    safe_workflow = workflow if isinstance(workflow, WorkflowStatus) else WorkflowStatus(None, None)
    try:
        if type(expected_policy_version) is not str or expected_policy_version not in ACCEPTED_POLICY_VERSIONS:
            raise EvidenceBundleError("POLICY_BINDING_MISMATCH")
        safe_run = _schema3_run_identity(run_identity)
        if safe_consumer is None or not isinstance(workflow, WorkflowStatus):
            raise EvidenceBundleError("CONSUMER_CONFIGURATION_INVALID", "IDENTITY")
        if (
            type(engine_versions) is not tuple or len(engine_versions) != 3
            or any(type(value) is not str or not value for value in engine_versions)
            or not isinstance(raw_paths, Mapping) or set(raw_paths) != set(handoff.RAW_FILE_NAMES)
        ):
            raise EvidenceBundleError("CONSUMER_CONFIGURATION_INVALID", "INPUT_BINDINGS")
        root = None if handoff_root is None else Path(handoff_root)
        if root is not None and not root.is_absolute():
            raise EvidenceBundleError("CONSUMER_CONFIGURATION_INVALID", "HANDOFF_ROOT")

        stage = "REFERENCE"
        if producer_reference is None:
            if root is None:
                raise handoff.HandoffError("HANDOFF_MISSING", "PRODUCER_REFERENCE_MISSING")
            # III-A owns absence precedence and storage safety.
            handoff.read_handoff_part_bytes(
                root, None, run_id=safe_run["runId"], run_attempt=safe_run["runAttempt"],
                policy_version=expected_policy_version, executed_git_sha=consumer.executed_git_sha,
            )
        try:
            reference = handoff.ProducerReference.from_value(
                producer_reference.to_value()
                if isinstance(producer_reference, handoff.ProducerReference) else producer_reference
            )
        except (handoff.HandoffError, TypeError, ValueError, KeyError):
            raise handoff.HandoffError("PRODUCER_REFERENCE_MISSING") from None

        stage = "STORAGE"
        if root is None:
            raise handoff.HandoffError("HANDOFF_MISSING")
        parts = handoff.read_handoff_part_bytes(
            root, reference, run_id=safe_run["runId"], run_attempt=safe_run["runAttempt"],
            policy_version=expected_policy_version, executed_git_sha=consumer.executed_git_sha,
        )
        stage = "ADMISSION"
        joined_digest, context_digest = handoff.expected_input_digests_from_capture(parts.capture_input_bytes)
        repo_root = Path(__file__).resolve().parents[1]
        modules = tuple(
            handoff.ModuleBinding(path, _sha256_bytes((repo_root / path).read_bytes()))
            for path in handoff.FIXED_MODULE_PATHS
        )
        raw_files = []
        for name in handoff.RAW_FILE_NAMES:
            path = Path(raw_paths[name])
            try:
                payload = path.read_bytes()
            except FileNotFoundError:
                raw_files.append(handoff.RawFileBinding(name, False, None, None))
            else:
                raw_files.append(handoff.RawFileBinding(name, True, _sha256_bytes(payload), len(payload)))
        expected = handoff.ExpectedBinding(
            repository=safe_run["repository"], workflow=safe_run["workflow"], job=safe_run["job"],
            run_id=safe_run["runId"], run_attempt=safe_run["runAttempt"], event=safe_run["event"],
            git_ref=safe_run["gitRef"], git_ref_type=safe_run["gitRefType"], event_git_sha=safe_run["gitSha"],
            executed_git_sha=consumer.executed_git_sha, policy_version=expected_policy_version,
            engine_schema_version=engine_versions[0], engine_score_version=engine_versions[1],
            engine_funnel_version=engine_versions[2], modules=modules, raw_files=tuple(raw_files),
            joined_candidate_input=joined_digest, replay_context=context_digest,
            capture_input=handoff.DigestBinding(reference.capture_input_digest, len(parts.capture_input_bytes)),
        )
        admitted = handoff.validate_handoff_parts(parts, expected, reference)
        # Fresh owned views, only after admission; no view supplies authority.
        admitted.observation_value()
        admitted.capture_input_value()
        admitted.receipt_value()
        stage = "BUILD"
        files = build_captured_bundle(admitted, reference, expected, consumer, workflow)
        stage = "SELF_VERIFY"
        report = verify_bundle_files(files)
        if report.bundle_integrity != "PASS" or report.capture_validity != "VALID":
            if report.errors and report.errors[0].code == "BUNDLE_PRIVACY_VIOLATION":
                raise EvidenceBundleError("BUNDLE_PRIVACY_VIOLATION")
            if report.errors and report.errors[0].code == "WORKFLOW_STATUS_INCONSISTENT":
                raise EvidenceBundleError("WORKFLOW_STATUS_INCONSISTENT")
            raise EvidenceBundleError("SELF_VERIFICATION_FAILED")
        return files
    except handoff.HandoffError as exc:
        code, detail = exc.code, exc.detail
        if code == "HANDOFF_MISSING" and stage == "REFERENCE" and producer_reference is None:
            detail = "PRODUCER_REFERENCE_MISSING"
        if code in {
            "RUN_ID_MISMATCH", "RUN_ATTEMPT_MISMATCH", "POLICY_BINDING_MISMATCH",
            "UNSUPPORTED_OBSERVATION_SCHEMA", "UNSUPPORTED_HANDOFF_SCHEMA", "SOURCE_IDENTITY_MISMATCH",
        } and stage == "STORAGE":
            stage = "REFERENCE"
    except EvidenceBundleError as exc:
        code, detail = exc.code, exc.detail
        if code == "BUNDLE_PRIVACY_VIOLATION":
            stage = "PRIVACY"
        elif (
            stage == "BUILD"
            and code == "SELF_VERIFICATION_FAILED"
            and detail == "WORKFLOW_STATUS_INCONSISTENT"
        ):
            # The builder's self-verification wrapper obscures the workflow semantic it detected.
            code, detail, stage = "WORKFLOW_STATUS_INCONSISTENT", None, "SELF_VERIFY"
    except (TypeError, ValueError, KeyError, UnicodeError):
        code, detail = (
            ("BUNDLE_BUILD_FAILED", "BINDING_INVALID") if stage == "ADMISSION"
            else ("SELF_VERIFICATION_FAILED", None) if stage == "SELF_VERIFY"
            else ("BUNDLE_BUILD_FAILED", None) if stage == "BUILD"
            else ("CONSUMER_CONFIGURATION_INVALID", None)
        )
    except Exception:  # Safe static taxonomy; never copy exception or environment text.
        code, detail = (
            ("SELF_VERIFICATION_FAILED", None) if stage == "SELF_VERIFY"
            else ("BUNDLE_BUILD_FAILED", None)
        )
    return build_invalid_bundle(
        {"code": code, "detail": detail, "stage": stage}, safe_run, safe_consumer, safe_workflow,
    )


def _main_schema3(args, mode: str) -> int:
    run_identity = None
    consumer = None
    workflow = WorkflowStatus(None, None)
    try:
        if mode != "enabled":
            raise EvidenceBundleError("CONSUMER_CONFIGURATION_INVALID", "MODE")
        if args.p14_expected_policy_version not in ACCEPTED_POLICY_VERSIONS:
            raise EvidenceBundleError("POLICY_BINDING_MISMATCH")
        workflow = WorkflowStatus(args.batch_status or None, args.smoke_status or None)
        run_identity = _schema3_run_identity({
            "repository": os.environ.get("GITHUB_REPOSITORY"), "workflow": WORKFLOW,
            "job": os.environ.get("GITHUB_JOB"), "runId": os.environ.get("GITHUB_RUN_ID"),
            "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"), "event": os.environ.get("GITHUB_EVENT_NAME"),
            "gitRef": os.environ.get("GITHUB_REF"), "gitRefType": os.environ.get("GITHUB_REF_TYPE"),
            "gitSha": os.environ.get("GITHUB_SHA"),
        })
        consumer = _consumer_identity(Path(__file__).resolve().parents[1])
        reference = {
            "status": args.p14_transport_status, "transportDigest": args.p14_handoff_digest,
            "observationDigest": args.p14_observation_digest, "receiptDigest": args.p14_receipt_digest,
            "captureInputDigest": args.p14_capture_input_digest, "executedGitSha": args.p14_executed_git_sha,
            "observationSchemaVersion": args.p14_observation_schema, "handoffSchemaVersion": args.p14_handoff_schema,
            "policyVersion": args.p14_policy_version, "runId": args.p14_run_id, "runAttempt": args.p14_run_attempt,
        }
        files = build_evidence_from_handoff(
            handoff_root=args.p14_handoff_dir,
            producer_reference=None if all(value is None for value in reference.values()) else reference,
            run_identity=run_identity, expected_policy_version=args.p14_expected_policy_version,
            consumer=consumer,
            engine_versions=(CANDIDATE_FUNNEL_SCHEMA_VERSION, CANDIDATE_FUNNEL_SCORE_VERSION, CANDIDATE_FUNNEL_VERSION),
            raw_paths=dict(zip(handoff.RAW_FILE_NAMES, (args.candidates, args.prescreen, args.regime, args.previous))),
            workflow=workflow,
        )
    except EvidenceBundleError as exc:
        files = build_invalid_bundle(
            {"code": exc.code, "detail": exc.detail, "stage": "CONFIGURATION"},
            run_identity, consumer, workflow,
        )
    except Exception:
        files = build_invalid_bundle(
            {"code": "CONSUMER_CONFIGURATION_INVALID", "detail": None, "stage": "CONFIGURATION"},
            run_identity, consumer, workflow,
        )
    report = None
    try:
        report = verify_bundle_files(files)
        if report.bundle_integrity != "PASS":
            raise EvidenceBundleError("SELF_VERIFICATION_FAILED")
    except Exception:
        # An existing INVALID record retains its earlier first fault. The
        # installer independently verifies all files before any installation.
        if json.loads(files["evidence.json"])["captureStatus"] != "invalid":
            files = build_invalid_bundle(
                {"code": "SELF_VERIFICATION_FAILED", "detail": None, "stage": "SELF_VERIFY"},
                run_identity, consumer, workflow,
            )
        report = None
    try:
        bundle_root = install_bundle(args.out, files)
    except EvidenceBundleError as exc:
        print(exc.code, file=sys.stderr)
        return 1
    except Exception:
        print("BUNDLE_WRITE_FAILED", file=sys.stderr)
        return 1
    print(f"bundle_path={bundle_root}")
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        try:
            with Path(github_output).open("a", encoding="utf-8") as handle:
                handle.write(f"bundle_path={bundle_root}\n")
        except OSError:
            print("BUNDLE_WRITE_FAILED", file=sys.stderr)
            return 1
    # This exit status describes captured evidence only, including QGF and SV.
    return 0 if report is not None and report.capture_validity == "VALID" else 1


def main(argv: list[str] | tuple[str, ...] = ()) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--previous", type=Path, required=True)
    parser.add_argument("--candidates", type=Path, default=batch.CANDIDATES_STOCKS_PATH)
    parser.add_argument("--prescreen", type=Path, default=batch.PRESCREEN_METADATA_PATH)
    parser.add_argument("--regime", type=Path, default=batch.REGIME_STATE_PATH)
    parser.add_argument("--batch-status", default="")
    parser.add_argument("--smoke-status", default="")
    parser.add_argument("--p14-handoff-dir", type=Path)
    parser.add_argument("--p14-expected-policy-version", default="p14-decision-aware-v1")
    for name in (
        "transport-status", "handoff-digest", "observation-digest", "receipt-digest",
        "capture-input-digest", "executed-git-sha", "observation-schema", "handoff-schema",
        "policy-version", "run-id", "run-attempt",
    ):
        parser.add_argument(f"--p14-{name}")
    args = parser.parse_args(argv)

    mode = os.environ.get("P14_HANDOFF_MODE")
    if mode is not None and mode != "disabled":
        return _main_schema3(args, mode)

    try:
        run_identity = _run_identity_from_environment()
        evidence = build_evidence(
            run_identity=run_identity,
            candidates_path=args.candidates,
            prescreen_path=args.prescreen,
            regime_path=args.regime,
            previous_path=args.previous,
            batch_status=args.batch_status,
            smoke_status=args.smoke_status,
        )
        bundle_id = f"candidate-funnel-evidence-{run_identity['runId']}-{run_identity['runAttempt']}"
        bundle_root = args.out / bundle_id
        write_bundle(bundle_root, evidence)
    except Exception as exc:  # noqa: BLE001 — このstepはnon-blocking(workflow側でcontinue-on-error)。
        # 例外を握り潰さず記録したうえでnon-zero exitのみ返す（job全体の
        # fail-closed判定には一切関与しない — それは既存のEnforce stepの責務）。
        print(f"candidate_funnel run evidence capture failed (non-blocking): {exc}", file=sys.stderr)
        return 1

    print(bundle_root)
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with Path(github_output).open("a", encoding="utf-8") as handle:
            handle.write(f"bundle_path={bundle_root}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
