"""Permanent synthetic contracts for pure schema-3 run-evidence bundles.

Gate A created this module and the two golden directories but deliberately did
not execute pytest.  Negative cases are derived in memory; no extra fixture
directories are required.

R3 (Phase III plan) layer map for this Phase III-B module:

* A  schema-3 construction, exact key sets, canonical bytes, determinism
* C  digest corruption (raw / manifest-resealed / coherent digest chain)
* D  provenance faults observed through the offline verifier
* E  V1-V13 single faults, first-fault precedence, dir/zip readers, CLI,
     ``--source-repo`` (local temporary git repository only)
* F  legacy compatibility boundary (no schema-1/2 verification is added)
* G  ownership / aliasing
* H  partial-install failure injection
* I  recursive privacy injection matrix
* K  no engine / batch / privacy-filter import
* L  no network (AST + runtime ``socket`` tripwire)
* M  unknown-schema routing
* AH-2 III-B rows: BATCH_READY / QUALITY_GATE_FAILED / reviewed SV bundles

Every expected first-fault code below is derived from the ordered V1-V13
verifier in ``data/p14_run_evidence_bundle.py`` and the audited admission in
``data/p14_handoff.py``.  Subprocesses launched by this module never write
bytecode.
"""
from __future__ import annotations

import ast
import copy
import functools
import hashlib
import inspect
import io
import itertools
import json
import os
import re
import socket
import stat
import subprocess
import sys
import time
import types
import zipfile
from dataclasses import FrozenInstanceError, replace
from pathlib import Path

import pytest

from data import p14_handoff as handoff
from data import p14_run_evidence_bundle as bundle
from data.p14_handoff import (
    FIXED_MODULE_PATHS,
    DigestBinding,
    ExpectedBinding,
    HandoffParts,
    ModuleBinding,
    RawFileBinding,
)

REPO = Path(__file__).resolve().parents[1]
GOLDEN_ROOT = REPO / "tests/fixtures/p14_run_evidence_schema3_golden_v1"
POLICY = "p14-decision-aware-v1"
EVENT_SHA = "1" * 40
EXECUTED_SHA = "2" * 40

CAPTURE_PATH = "attachments/capture-input.json"
RECEIPT_PATH = "attachments/batch-receipt.json"
ENVELOPE_PATH = "attachments/handoff.json"
DIAGNOSTICS_PATH = "p14-reference-diagnostics.json"
EVIDENCE_PATH = "evidence.json"
PRIVACY_PATH = "validation/privacy-report.json"
MANIFEST_PATH = "manifest.json"
MANIFEST_DIGEST_PATH = "manifest.sha256"
GOLDEN_A_ID = "candidate-funnel-evidence-900000001-1"
GOLDEN_B_ID = "candidate-funnel-evidence-900000002-1"

GOLDEN_MANIFEST_DIGESTS = {
    "candidate-funnel-evidence-900000001-1": "10f201511eff676be244f53640361b301f829f9f7b2c146bdef6b674ce8c4925",
    "candidate-funnel-evidence-900000002-1": "b00b38c88a6e7c8be57b08c413c7b809c8ce1f36e81570f0e1009c41fc8db43d",
}

GOLDEN_COMPONENT_SHA256 = {
    "candidate-funnel-evidence-900000001-1": {
        "attachments/observation-94fae0bcf7799f740014660a5c2fd920016f4156578cacad711673c186d81a2c.json": "94fae0bcf7799f740014660a5c2fd920016f4156578cacad711673c186d81a2c",
        "attachments/capture-input.json": "cb75acf0b67864efeae3d55cd34942c256bff88511795eb25dfd08bae7647cd5",
        "attachments/batch-receipt.json": "da056d32d2f4d252646cfdcd7d8d700a85a48b6113cd2d5ec4a3cb8693f101e9",
        "attachments/handoff.json": "c1548570bee84c9c2170d23ada1522c5400a2cb4275f2fea5b360662ac4004e4",
        "p14-reference-diagnostics.json": "204375e66651ff94149cd98d57b1a3268439c1b99ee74e84678081cfcaeb64c7",
        "evidence.json": "27bdbac7d603ed50631c2cd330daf46b4226e8f12fe91880134f82fbd8571aee",
        "validation/privacy-report.json": "4807efb5f14e694c97432edff66b843308750279be088c9d04022cf59ebebd13",
        "manifest.json": "10f201511eff676be244f53640361b301f829f9f7b2c146bdef6b674ce8c4925",
        "manifest.sha256": "f65fe1d7839cec157b5228502cf65c0149c13a01333b36ca26b648e2000fb3fc",
    },
    "candidate-funnel-evidence-900000002-1": {
        "attachments/observation-33b92bd22981811d5b87d42e6315f9b19b32a410f4c5f7c5796ae2faaac4a1e2.json": "33b92bd22981811d5b87d42e6315f9b19b32a410f4c5f7c5796ae2faaac4a1e2",
        "attachments/capture-input.json": "cb75acf0b67864efeae3d55cd34942c256bff88511795eb25dfd08bae7647cd5",
        "attachments/batch-receipt.json": "f75f798a96f33ecc59bac874ce4f1ceb5a4c3eeba270aadfc2c022289e9dbe08",
        "attachments/handoff.json": "06a7b079cfda6eb314c7739d0ce67d757bf18ebfee4a45850f65599726630dbe",
        "p14-reference-diagnostics.json": "c6e818e090f1348649c68245099f707521db0830ad8d9aa32f69b2fa6e8345d2",
        "evidence.json": "934560c3746f5c811aa26d25f64e11f5db4efaf7a557b13fcb80eb04291438e3",
        "validation/privacy-report.json": "3c381ccaac1528faa5995c48d4c1d6394ce32c2e4622f7960dbf97f45097db0c",
        "manifest.json": "b00b38c88a6e7c8be57b08c413c7b809c8ce1f36e81570f0e1009c41fc8db43d",
        "manifest.sha256": "63b62128ccaf18a12895daecdc4b9408e88448dd4d2022c7d595bd3903a4a73e",
    },
}

# Source-segment digests of the frozen legacy replay entrypoints
# (data/candidate_funnel_run_evidence.py).  Phase III must not change them.
LEGACY_REPLAY_P14_SEGMENT_SHA256 = "02e5940ab038b5f560c1cca24f0984389c918f7530a04992f627984dc560776b"
LEGACY_RECLASSIFY_P14_SEGMENT_SHA256 = "b5bee66d16083db4096abf5b9dc9bd75bee3b2fab30482b4318827311b00cd16"

# Token-shaped values are assembled at runtime so that this file never contains
# a literal that repository secret scanners would flag.
SECRET_TOKEN = "gh" + "p_" + "x" * 36
SECRET_PAT = "github" + "_pat_" + "y" * 22
PRIVATE_USERS_PATH = "/Users/synthetic/private/portfolio.csv"
PRIVATE_HOME_PATH = "/home/runner/work/private/state"


def _sha(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _run_identity(run_id: str) -> dict[str, object]:
    return {
        "repository": "synthetic/schema3",
        "workflow": "full_batch.yml",
        "job": "update-data",
        "runId": run_id,
        "runAttempt": "1",
        "event": "schedule",
        "gitRef": "refs/heads/main",
        "gitRefType": "branch",
        "gitSha": EVENT_SHA,
    }


def _context() -> dict[str, object]:
    return {
        "pipelinePath": "normal",
        "regime": "bull_calm",
        "sourceUpdatedAt": "2026-09-20T00:00:00.000Z",
        "asOf": "2026-09-20T00:30:00.000Z",
        "staleThresholdHours": 24,
        "prescreenFallbackUsed": False,
    }


def _join_stats() -> dict[str, object]:
    return {
        "candidateCount": 6,
        "prescreenCount": 6,
        "joinedCount": 6,
        "unmatchedCandidateCount": 0,
        "unmatchedPrescreenCount": 0,
        "joinRate": 1.0,
        "unmatchedCandidateRate": 0.0,
    }


def _joined_input() -> list[dict[str, object]]:
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


def _candidates(*, dropped: int) -> list[dict[str, object]]:
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


def _selection() -> dict[str, object]:
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


def _side(*, dropped: int = 0) -> dict[str, object]:
    return {
        "engineStatus": "generated",
        "candidates": _candidates(dropped=dropped),
        "selectionObservability": _selection(),
    }


def _source_identity(executed_sha: str = EXECUTED_SHA, digests=None) -> dict[str, object]:
    return {
        "executedGitSha": executed_sha,
        "modules": [
            {
                "path": path,
                "sha256": digests[path] if digests is not None else f"{index + 1:064x}",
            }
            for index, path in enumerate(FIXED_MODULE_PATHS)
        ],
        "engineSchemaVersion": "candidate-funnel-1",
        "engineScoreVersion": "market-score-v1",
        "engineFunnelVersion": "candidate-funnel-v1",
    }


def _release(*, dropped: int, status: str) -> dict[str, object]:
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
        "policyVersion": POLICY,
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


def _gates(*, dropped: int, status: str, fail_id: str | None = None) -> list[dict[str, object]]:
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


def _quality(*, dropped: int, status: str, fail_id: str | None = None) -> dict[str, object]:
    hard_ids = [fail_id] if fail_id is not None else (["P-14"] if status == "FAIL" else [])
    return {
        "gates": _gates(dropped=dropped, status=status, fail_id=fail_id),
        "overallPass": not hard_ids,
        "hardFailIds": hard_ids,
        "notes": [],
        "p14ReleaseEvidence": _release(dropped=dropped, status=status),
    }


def _consumer(executed_sha: str = EXECUTED_SHA, digests=None) -> bundle.ConsumerIdentity:
    return bundle.ConsumerIdentity(
        executed_sha,
        tuple(
            (path, digests[path] if digests is not None else f"{index + 101:064x}")
            for index, path in enumerate(bundle.CONSUMER_MODULE_PATHS)
        ),
    )


def _make_bundle(
    run_id: str,
    *,
    terminal: str,
    p14_status: str,
    dropped: int,
    fail_id: str | None = None,
    schema_violations: list[str] | None = None,
    executed_sha: str = EXECUTED_SHA,
    producer_digests=None,
    consumer_digests=None,
) -> tuple[bundle.BundleFiles, HandoffParts, object, ExpectedBinding]:
    capture = handoff.build_capture_input_bytes(
        joined_candidate_input=_joined_input(),
        context=_context(),
        join_stats=_join_stats(),
        source_updated_at="2026-09-20T00:00:00.000Z",
        candidates_updated_at="2026-09-20T00:01:00.000Z",
    )
    capture_value = json.loads(capture)
    joined = handoff.canonical_json_bytes(capture_value["joinedCandidateInput"])
    context = handoff.canonical_json_bytes(capture_value["context"])
    modules = tuple(
        ModuleBinding(
            path,
            producer_digests[path] if producer_digests is not None else f"{index + 1:064x}",
        )
        for index, path in enumerate(FIXED_MODULE_PATHS)
    )
    raw_files = (
        RawFileBinding("candidatesStocks", True, "a" * 64, 10),
        RawFileBinding("prescreenMetadata", True, "b" * 64, 11),
        RawFileBinding("regimeState", False, None, None),
        RawFileBinding("previousArtifact", True, "c" * 64, 12),
    )
    expected = ExpectedBinding(
        repository="synthetic/schema3",
        workflow="full_batch.yml",
        job="update-data",
        run_id=run_id,
        run_attempt="1",
        event="schedule",
        git_ref="refs/heads/main",
        git_ref_type="branch",
        event_git_sha=EVENT_SHA,
        executed_git_sha=executed_sha,
        policy_version=POLICY,
        engine_schema_version="candidate-funnel-1",
        engine_score_version="market-score-v1",
        engine_funnel_version="candidate-funnel-v1",
        modules=modules,
        raw_files=raw_files,
        joined_candidate_input=DigestBinding(_sha(joined), len(joined)),
        replay_context=DigestBinding(_sha(context), len(context)),
        capture_input=DigestBinding(_sha(capture), len(capture)),
    )
    input_identity = {
        "rawFiles": {item.name: {"present": item.present, "sha256": item.sha256, "bytes": item.bytes} for item in raw_files},
        "joinedCandidateInput": {"sha256": expected.joined_candidate_input.sha256, "bytes": expected.joined_candidate_input.bytes},
        "replayContext": {"sha256": expected.replay_context.sha256, "bytes": expected.replay_context.bytes},
        "captureInput": {"sha256": expected.capture_input.sha256, "bytes": expected.capture_input.bytes},
    }
    observation = handoff.build_observation_bytes(
        policy_version=POLICY,
        run_identity=_run_identity(run_id),
        source_identity=_source_identity(executed_sha, producer_digests),
        input_identity=input_identity,
        base=_side(dropped=0),
        perturbed=_side(dropped=dropped),
    )
    report: dict[str, object] = {
        "context": _context(),
        "joinStats": _join_stats(),
        "prescreenDuplicateCodes": [],
        "qualityGate": _quality(dropped=dropped, status=p14_status, fail_id=fail_id),
        "engineStatus": "generated",
    }
    if schema_violations is not None:
        report["schemaViolations"] = schema_violations
    receipt_value = {
        "schemaVersion": handoff.RECEIPT_SCHEMA_VERSION,
        "runIdentity": _run_identity(run_id),
        "policyVersion": POLICY,
        "executedGitSha": executed_sha,
        "observationDigest": _sha(observation),
        "captureInputDigest": _sha(capture),
        "terminalStatus": terminal,
        "artifactAvailable": terminal == "BATCH_READY",
        "transportStatus": "READY",
        "failureCode": None,
        "reportState": "COMPLETE",
        "report": report,
    }
    receipt = handoff.build_batch_receipt_bytes(
        receipt_value, observation_bytes=observation, capture_input_bytes=capture
    )
    parts, reference = handoff.build_handoff_parts(
        observation_bytes=observation, capture_input_bytes=capture, receipt_bytes=receipt
    )
    workflow = bundle.WorkflowStatus(
        "batch_passed" if terminal == "BATCH_READY" else "batch_failed",
        "smoke_passed" if terminal == "BATCH_READY" else None,
    )
    return (
        bundle.build_captured_bundle(
            parts, reference, expected, _consumer(executed_sha, consumer_digests), workflow
        ),
        parts,
        reference,
        expected,
    )


def _golden_a() -> bundle.BundleFiles:
    return _make_bundle(
        "900000001", terminal="BATCH_READY", p14_status="WARN", dropped=1
    )[0]


def _golden_b() -> bundle.BundleFiles:
    return _make_bundle(
        "900000002", terminal="QUALITY_GATE_FAILED", p14_status="FAIL", dropped=2
    )[0]


_CASES = {
    "A": dict(run_id="900000001", terminal="BATCH_READY", p14_status="WARN", dropped=1),
    "B": dict(run_id="900000002", terminal="QUALITY_GATE_FAILED", p14_status="FAIL", dropped=2),
    "QGF_P10_WARN": dict(
        run_id="900000011", terminal="QUALITY_GATE_FAILED", p14_status="WARN", dropped=1, fail_id="P-10"
    ),
    "QGF_P10_PASS": dict(
        run_id="900000016", terminal="QUALITY_GATE_FAILED", p14_status="PASS", dropped=0, fail_id="P-10"
    ),
    "SV": dict(
        run_id="900000012", terminal="SCHEMA_VIOLATIONS", p14_status="PASS", dropped=0,
        schema_violations=("synthetic.schema",),
    ),
}


@functools.lru_cache(maxsize=None)
def _case(name: str):
    """Cached (bundle, parts, reference, expected); callers must copy before mutating."""
    options = dict(_CASES[name])
    violations = options.pop("schema_violations", None)
    return _make_bundle(
        options.pop("run_id"),
        schema_violations=list(violations) if violations is not None else None,
        **options,
    )


def _files(name: str) -> dict[str, bytes]:
    return dict(_case(name)[0])


@functools.lru_cache(maxsize=None)
def _invalid_bundle() -> bundle.BundleFiles:
    return bundle.build_invalid_bundle(
        {"code": "HANDOFF_MISSING", "detail": "PRODUCER_REFERENCE_MISSING", "stage": "REFERENCE"},
        _run_identity("900000013"),
        _consumer(),
        bundle.WorkflowStatus("batch_failed", None),
    )


def _invalid_files() -> dict[str, bytes]:
    return dict(_invalid_bundle())


def _obs_path(files) -> str:
    return next(path for path in files if path.startswith("attachments/observation-"))


def _disk_files(directory: Path) -> dict[str, bytes]:
    return {
        path.relative_to(directory).as_posix(): path.read_bytes()
        for path in directory.rglob("*")
        if path.is_file()
    }


def _replace_json(files: dict[str, bytes], path: str, mutate) -> dict[str, bytes]:
    changed = dict(files)
    value = json.loads(changed[path])
    mutate(value)
    changed[path] = handoff.canonical_json_bytes(value)
    return changed


def _manifest_digest_line(manifest: bytes) -> bytes:
    return f"{_sha(manifest)}  manifest.json\n".encode()


def _reseal(files: dict[str, bytes], *, bundle_id: str | None = None) -> dict[str, bytes]:
    """Rebuild manifest.json / manifest.sha256 over the current content bytes."""
    changed = dict(files)
    if bundle_id is None:
        bundle_id = json.loads(changed[MANIFEST_PATH])["bundleId"]
    content = {
        path: payload for path, payload in changed.items()
        if path not in {MANIFEST_PATH, MANIFEST_DIGEST_PATH}
    }
    manifest = handoff.canonical_json_bytes(
        {
            "schemaVersion": bundle.BUNDLE_SCHEMA_VERSION,
            "bundleId": bundle_id,
            "files": [
                {"path": path, "sha256": _sha(content[path]), "bytes": len(content[path])}
                for path in sorted(content)
            ],
        }
    )
    changed[MANIFEST_PATH] = manifest
    changed[MANIFEST_DIGEST_PATH] = _manifest_digest_line(manifest)
    return changed


def _manifest_edit(files: dict[str, bytes], edit) -> dict[str, bytes]:
    """Edit manifest.json and keep manifest.sha256 coherent with the edit."""
    changed = dict(files)
    manifest = json.loads(changed[MANIFEST_PATH])
    edit(manifest)
    payload = handoff.canonical_json_bytes(manifest)
    changed[MANIFEST_PATH] = payload
    changed[MANIFEST_DIGEST_PATH] = _manifest_digest_line(payload)
    return changed


def _flip_byte(payload: bytes, index: int | None = None) -> bytes:
    """Change exactly one byte (xor 0x01 keeps ASCII payloads ASCII)."""
    position = len(payload) // 2 if index is None else index
    changed = bytearray(payload)
    changed[position] ^= 0x01
    assert bytes(changed) != payload
    return bytes(changed)


def _swap(payload: bytes, old: bytes, new: bytes) -> bytes:
    assert payload.count(old) >= 1, old
    return payload.replace(old, new, 1)


def _swap_pattern(payload: bytes, pattern: bytes, replacement: bytes) -> bytes:
    changed, count = re.subn(pattern, lambda _match: replacement, payload, count=1)
    assert count == 1, pattern
    return changed


def _retie(
    files: dict[str, bytes],
    *,
    observation: bytes | None = None,
    capture: bytes | None = None,
    receipt: bytes | None = None,
    envelope: bytes | None = None,
) -> dict[str, bytes]:
    """Replace attachment bytes and coherently rebind every enclosing digest.

    Only integrity data that *encloses* the replaced bytes is repaired (envelope
    records, producer reference, evidence attachment records, expected binding,
    manifest), so verification proceeds to the intrinsic layer of the replaced
    payload.  ``envelope`` replaces handoff.json verbatim (raw bytes).
    """
    changed = dict(files)
    evidence = json.loads(changed[EVIDENCE_PATH])
    reference = evidence["producerReference"]
    records = evidence["attachments"]
    envelope_value = None if envelope is not None else json.loads(changed[ENVELOPE_PATH])
    if capture is not None:
        changed[CAPTURE_PATH] = capture
        digest = _sha(capture)
        reference["captureInputDigest"] = digest
        records["captureInput"].update(sha256=digest, bytes=len(capture))
        evidence["expectedBinding"]["captureInput"] = {"sha256": digest, "bytes": len(capture)}
        if envelope_value is not None:
            envelope_value["captureInput"].update(sha256=digest, bytes=len(capture))
        if observation is None:
            current = json.loads(changed[_obs_path(changed)])
            current["inputIdentity"]["captureInput"] = {"sha256": digest, "bytes": len(capture)}
            observation = handoff.canonical_json_bytes(current)
    if observation is not None:
        del changed[_obs_path(changed)]
        digest = _sha(observation)
        name = f"observation-{digest}.json"
        changed[f"attachments/{name}"] = observation
        reference["observationDigest"] = digest
        records["observation"].update(file=f"attachments/{name}", sha256=digest, bytes=len(observation))
        if envelope_value is not None:
            envelope_value["observation"] = {"file": name, "sha256": digest, "bytes": len(observation)}
    if receipt is not None:
        changed[RECEIPT_PATH] = receipt
        digest = _sha(receipt)
        reference["receiptDigest"] = digest
        records["receipt"].update(sha256=digest, bytes=len(receipt))
        if envelope_value is not None:
            envelope_value["receipt"].update(sha256=digest, bytes=len(receipt))
    if envelope is None:
        envelope = handoff.canonical_json_bytes(envelope_value)
    changed[ENVELOPE_PATH] = envelope
    reference["transportDigest"] = _sha(envelope)
    records["envelope"].update(sha256=_sha(envelope), bytes=len(envelope))
    changed[EVIDENCE_PATH] = handoff.canonical_json_bytes(evidence)
    return _reseal(changed)


_ATTACHMENT_KEYWORDS = ("observation", "capture", "receipt", "envelope")


def _attachment_path(files: dict[str, bytes], target: str) -> str:
    return {
        "observation": _obs_path(files) if target == "observation" else "",
        "capture": CAPTURE_PATH,
        "receipt": RECEIPT_PATH,
        "envelope": ENVELOPE_PATH,
    }[target]


def _retie_json(files: dict[str, bytes], target: str, mutate) -> dict[str, bytes]:
    """Mutate one attachment's decoded value and rebind enclosing digests."""
    value = json.loads(files[_attachment_path(files, target)])
    mutate(value)
    return _retie(files, **{target: handoff.canonical_json_bytes(value)})


def _retie_receipt(files: dict[str, bytes], mutate) -> dict[str, bytes]:
    return _retie_json(files, "receipt", mutate)


def _expect_fault(files, code: str, detail: str | None = None, *, source_repo=None):
    report = bundle.verify_bundle_files(files, source_repo=source_repo)
    assert report.route == "SCHEMA3_RUN_EVIDENCE"
    assert report.bundle_integrity == "FAIL"
    assert report.capture_validity == "N/A"
    assert len(report.errors) == 1, report.errors
    actual = (report.errors[0].code, report.errors[0].detail)
    assert actual == (code, detail), actual
    return report


def _expect_pass(files, *, terminal: str | None, artifact: bool | None, validity: str = "VALID"):
    report = bundle.verify_bundle_files(files)
    assert (report.route, report.bundle_integrity, report.capture_validity) == ("SCHEMA3_RUN_EVIDENCE", "PASS", validity)
    assert (report.terminal_status, report.artifact_available, report.errors) == (terminal, artifact, ())
    return report


def _python_env(**extra: str) -> dict[str, str]:
    env = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONPATH": str(REPO),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    env.update(extra)
    return env


def _run_python(arguments: list[str], *, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    """Run a bytecode-free Python subprocess from the repository root."""
    return subprocess.run(
        [sys.executable, "-B", *arguments],
        cwd=REPO,
        env=_python_env() if env is None else env,
        capture_output=True,
        text=True,
        check=False,
    )


def _write_bundle_dir(parent: Path, files) -> Path:
    bundle_id = json.loads(files[MANIFEST_PATH])["bundleId"]
    root = parent / bundle_id
    for path, payload in files.items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
    return root.resolve()


@pytest.fixture
def default_int_digit_limit():
    """Pin CPython's integer-string conversion limit for oversized-number cases."""
    getter = getattr(sys, "get_int_max_str_digits", None)
    if getter is None:  # pragma: no cover - interpreter without the limit
        pytest.skip("interpreter has no integer string conversion limit")
    previous = getter()
    sys.set_int_max_str_digits(4300)
    try:
        yield
    finally:
        sys.set_int_max_str_digits(previous)


# --------------------------------------------------------------------------
# Layer A: construction, determinism, exact key sets, canonical bytes.
# --------------------------------------------------------------------------


@pytest.mark.parametrize("factory", [_golden_a, _golden_b])
def test_builder_is_deterministic_and_verbatim_in_three_timezones(factory, monkeypatch):
    if not hasattr(time, "tzset"):  # pragma: no cover - non-POSIX
        pytest.skip("time.tzset is unavailable")
    outputs = []
    reports = []
    try:
        for timezone in ("UTC", "Asia/Tokyo", "Pacific/Honolulu"):
            monkeypatch.setenv("TZ", timezone)
            time.tzset()
            built = factory()
            outputs.append(dict(built))
            reports.append(bundle.verify_bundle_files(built).to_value())
    finally:
        monkeypatch.undo()
        time.tzset()
    assert outputs[0] == outputs[1] == outputs[2]
    assert reports[0] == reports[1] == reports[2]


def test_public_contract_is_frozen_and_bytes_only():
    assert bundle.BUNDLE_SCHEMA_VERSION == "candidate-funnel-run-evidence-3"
    assert bundle.REPLAY_SCHEMA_VERSION_3 == "candidate-funnel-p14-replay-2"
    assert bundle.ACCEPTED_POLICY_VERSIONS == frozenset({POLICY})
    assert bundle.CONSUMER_MODULE_PATHS == (
        "data/candidate_funnel_run_evidence.py",
        "data/p14_handoff.py",
        "data/p14_observation.py",
        "data/p14_reference_classifier.py",
        "data/p14_reference_diagnostics.py",
        "data/p14_run_evidence_bundle.py",
    )
    built, parts, _, _ = _make_bundle("900000010", terminal="BATCH_READY", p14_status="PASS", dropped=0)
    evidence = json.loads(built["evidence.json"])
    assert built[evidence["attachments"]["observation"]["file"]] == parts.observation_bytes
    assert built["attachments/capture-input.json"] == parts.capture_input_bytes
    assert built["attachments/batch-receipt.json"] == parts.receipt_bytes
    assert built["attachments/handoff.json"] == parts.envelope_bytes
    with pytest.raises(TypeError):
        built.files["new"] = b"x"


def test_golden_regeneration_and_fixed_component_hashes():
    for golden_id, generated in (("candidate-funnel-evidence-900000001-1", _golden_a()), ("candidate-funnel-evidence-900000002-1", _golden_b())):
        disk = _disk_files(GOLDEN_ROOT / golden_id)
        assert dict(generated) == disk
        assert set(disk) == set(GOLDEN_COMPONENT_SHA256[golden_id])
        assert {path: _sha(payload) for path, payload in disk.items()} == GOLDEN_COMPONENT_SHA256[golden_id]
        assert disk["manifest.sha256"].decode().split()[0] == GOLDEN_MANIFEST_DIGESTS[golden_id]


def test_layer_a_exact_key_sets_for_captured_invalid_manifest_and_privacy_report():
    captured = json.loads(_files("A")[EVIDENCE_PATH])
    assert set(captured) == {
        "schemaVersion", "bundleId", "captureStatus", "runIdentity", "consumerIdentity",
        "workflowStatus", "producerReference", "expectedBinding", "attachments", "terminal",
        "p14", "replay", "confidenceInvariant", "diagnostics",
    }
    assert captured["schemaVersion"] == "candidate-funnel-run-evidence-3"
    assert captured["captureStatus"] == "captured"
    assert set(captured["terminal"]) == {
        "terminalStatus", "reportState", "transportStatus", "failureCode",
        "artifactAvailable", "observationAvailable", "producerReferenceAvailable",
    }
    assert set(captured["p14"]) == {"verdict", "jaccard", "swapCount", "baseTop40", "perturbedTop40", "release"}
    assert set(captured["replay"]) == {
        "schemaVersion", "input", "baseFullOrderedRankVector", "perturbedFullOrderedRankVector",
        "boundaryOutsideBand",
    }
    assert set(captured["attachments"]) == {"observation", "captureInput", "receipt", "envelope"}
    assert all(set(item) == {"file", "sha256", "bytes", "schemaVersion"} for item in captured["attachments"].values())
    assert set(captured["diagnostics"]) == {"file", "sha256", "bytes", "diagnosticsVersion"}
    assert set(captured["producerReference"]) == {
        "status", "transportDigest", "observationDigest", "receiptDigest", "captureInputDigest",
        "executedGitSha", "observationSchemaVersion", "handoffSchemaVersion", "policyVersion",
        "runId", "runAttempt",
    }
    assert set(captured["consumerIdentity"]) == {"executedGitSha", "modules"}
    assert set(captured["workflowStatus"]) == {"batchStatus", "smokeStatus"}
    invalid = json.loads(_invalid_files()[EVIDENCE_PATH])
    assert set(invalid) == {
        "schemaVersion", "bundleId", "captureStatus", "runIdentity", "consumerIdentity",
        "workflowStatus", "failure",
    }
    assert invalid["captureStatus"] == "invalid"
    assert set(invalid["failure"]) == {"code", "detail", "stage"}
    for files in (_files("A"), _invalid_files()):
        manifest = json.loads(files[MANIFEST_PATH])
        assert set(manifest) == {"schemaVersion", "bundleId", "files"}
        assert all(set(record) == {"path", "sha256", "bytes"} for record in manifest["files"])
        privacy = json.loads(files[PRIVACY_PATH])
        assert set(privacy) == {"schemaVersion", "status", "files"}
        assert privacy["status"] == "PASS"


@pytest.mark.parametrize("name", sorted(_CASES))
def test_layer_a_every_json_document_is_canonical_and_manifest_is_complete(name):
    files = _files(name)
    for path, payload in files.items():
        if path == MANIFEST_DIGEST_PATH:
            assert payload == _manifest_digest_line(files[MANIFEST_PATH])
            continue
        assert handoff.canonical_json_bytes(json.loads(payload)) == payload, path
    manifest = json.loads(files[MANIFEST_PATH])
    assert {record["path"] for record in manifest["files"]} == set(files) - {MANIFEST_PATH, MANIFEST_DIGEST_PATH}
    assert all(
        record["sha256"] == _sha(files[record["path"]]) and record["bytes"] == len(files[record["path"]])
        for record in manifest["files"]
    )


def test_layer_a_invalid_builder_taxonomy_and_unknown_bundle_id():
    unknown = bundle.build_invalid_bundle(
        {"code": "HANDOFF_MISSING", "detail": None, "stage": "REFERENCE"},
        None,
        None,
        bundle.WorkflowStatus(None, None),
    )
    assert json.loads(unknown[EVIDENCE_PATH])["bundleId"] == "candidate-funnel-evidence-unknown-unknown"
    _expect_pass(unknown, terminal=None, artifact=None, validity="INVALID")
    for failure, detail in (
        ({"code": "NOT_A_CODE", "detail": None, "stage": "REFERENCE"}, "FAILURE_CODE"),
        ({"code": "HANDOFF_MISSING", "detail": "unsafe detail", "stage": "REFERENCE"}, "FAILURE_DETAIL"),
        ({"code": "HANDOFF_MISSING", "detail": None, "stage": "NOT_A_STAGE"}, "FAILURE_STAGE"),
    ):
        with pytest.raises(bundle.EvidenceBundleError) as caught:
            bundle.build_invalid_bundle(failure, None, None, bundle.WorkflowStatus(None, None))
        assert (caught.value.code, caught.value.detail) == ("BUNDLE_BUILD_FAILED", detail)
    with pytest.raises(bundle.EvidenceBundleError) as not_mapping:
        bundle.build_invalid_bundle(None, None, None, bundle.WorkflowStatus(None, None))
    assert not_mapping.value.code == "BUNDLE_BUILD_FAILED"


def test_layer_a_builder_consumer_source_mismatch_and_value_object_validation():
    _, parts, reference, expected = _case("A")
    with pytest.raises(bundle.EvidenceBundleError) as caught:
        bundle.build_captured_bundle(
            parts, reference, expected,
            _consumer("4" * 40), bundle.WorkflowStatus("batch_passed", "smoke_passed"),
        )
    assert caught.value.code == "SOURCE_IDENTITY_MISMATCH"
    with pytest.raises(ValueError):
        bundle.WorkflowStatus("batch_failed", "smoke_passed")
    with pytest.raises(ValueError):
        bundle.WorkflowStatus("not-a-status", None)
    with pytest.raises(ValueError):
        bundle.ConsumerIdentity("not-a-sha", tuple((path, "0" * 64) for path in bundle.CONSUMER_MODULE_PATHS))


def test_layer_a_report_shape_is_closed_and_json_serializable():
    value = bundle.verify_bundle_files(_files("A")).to_value()
    assert list(value) == ["route", "bundleIntegrity", "captureValidity", "terminalStatus", "artifactAvailable", "errors"]
    assert handoff.canonical_json_bytes(value) == handoff.canonical_json_bytes(json.loads(json.dumps(value)))


def test_golden_a_and_b_terminal_semantics_are_independent_of_integrity():
    a = bundle.verify_bundle_files(_golden_a())
    b = bundle.verify_bundle_files(_golden_b())
    assert (a.bundle_integrity, a.capture_validity, a.terminal_status, a.artifact_available) == ("PASS", "VALID", "BATCH_READY", True)
    assert (b.bundle_integrity, b.capture_validity, b.terminal_status, b.artifact_available) == ("PASS", "VALID", "QUALITY_GATE_FAILED", False)
    evidence_b = json.loads(_golden_b()["evidence.json"])
    receipt_b = json.loads(_golden_b()["attachments/batch-receipt.json"])
    assert evidence_b["p14"]["verdict"] == "FAIL"
    assert evidence_b["p14"]["release"]["final"]["status"] == "FAIL"
    assert receipt_b["report"]["qualityGate"]["hardFailIds"] == ["P-14"]


def test_non_p14_only_qgf_never_promotes_p14_to_fail():
    built, _, _, _ = _make_bundle(
        "900000011", terminal="QUALITY_GATE_FAILED", p14_status="WARN", dropped=1, fail_id="P-10"
    )
    evidence = json.loads(built["evidence.json"])
    receipt = json.loads(built["attachments/batch-receipt.json"])
    assert bundle.verify_bundle_files(built).bundle_integrity == "PASS"
    assert evidence["p14"]["verdict"] == "WARN"
    assert evidence["p14"]["release"]["final"]["status"] == "WARN"
    assert receipt["report"]["qualityGate"]["hardFailIds"] == ["P-10"]


def test_reference_identity_faults_precede_bundle_building():
    _, parts, reference, expected = _make_bundle(
        "900000014", terminal="BATCH_READY", p14_status="PASS", dropped=0
    )
    with pytest.raises(handoff.HandoffError) as wrong_run:
        bundle.build_captured_bundle(parts, reference, replace(expected, run_id="900000015"), _consumer(), bundle.WorkflowStatus(None, None))
    assert wrong_run.value.code == "RUN_ID_MISMATCH"
    with pytest.raises(handoff.HandoffError) as wrong_attempt:
        bundle.build_captured_bundle(parts, reference, replace(expected, run_attempt="2"), _consumer(), bundle.WorkflowStatus(None, None))
    assert wrong_attempt.value.code == "RUN_ATTEMPT_MISMATCH"
    with pytest.raises(handoff.HandoffError) as wrong_policy:
        bundle.build_captured_bundle(parts, reference, replace(expected, policy_version="unknown-policy"), _consumer(), bundle.WorkflowStatus(None, None))
    assert wrong_policy.value.code == "POLICY_BINDING_MISMATCH"


def test_reviewed_schema_violations_remains_valid_failure_evidence():
    built, _, _, _ = _make_bundle(
        "900000012", terminal="SCHEMA_VIOLATIONS", p14_status="PASS", dropped=0,
        schema_violations=["synthetic.schema"],
    )
    report = bundle.verify_bundle_files(built)
    receipt = json.loads(built["attachments/batch-receipt.json"])
    assert (report.bundle_integrity, report.capture_validity, report.terminal_status, report.artifact_available) == ("PASS", "VALID", "SCHEMA_VIOLATIONS", False)
    assert receipt["report"]["qualityGate"]["overallPass"] is True
    assert receipt["report"]["schemaViolations"] == ["synthetic.schema"]


def test_invalid_builder_is_integrity_pass_capture_invalid():
    files = bundle.build_invalid_bundle(
        {"code": "HANDOFF_MISSING", "detail": "PRODUCER_REFERENCE_MISSING", "stage": "REFERENCE"},
        _run_identity("900000013"),
        _consumer(),
        bundle.WorkflowStatus("batch_failed", None),
    )
    report = bundle.verify_bundle_files(files)
    assert (report.bundle_integrity, report.capture_validity, report.terminal_status, report.artifact_available) == ("PASS", "INVALID", None, None)
    assert set(files) == {"evidence.json", "validation/privacy-report.json", "manifest.json", "manifest.sha256"}


# --------------------------------------------------------------------------
# AH-2 (Phase III-B rows): terminal projections and success-side rewrites.
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name,terminal,available",
    [
        ("A", "BATCH_READY", True),
        ("B", "QUALITY_GATE_FAILED", False),
        ("QGF_P10_WARN", "QUALITY_GATE_FAILED", False),
        ("QGF_P10_PASS", "QUALITY_GATE_FAILED", False),
        ("SV", "SCHEMA_VIOLATIONS", False),
    ],
)
def test_ah2_terminal_projection_is_receipt_verbatim(name, terminal, available):
    built, parts, _, _ = _case(name)
    _expect_pass(built, terminal=terminal, artifact=available)
    evidence = json.loads(built[EVIDENCE_PATH])
    receipt = json.loads(parts.receipt_bytes)
    quality = receipt["report"]["qualityGate"]
    assert built[RECEIPT_PATH] == parts.receipt_bytes
    assert evidence["captureStatus"] == "captured"
    assert evidence["terminal"] == {
        "terminalStatus": terminal, "reportState": "COMPLETE", "transportStatus": "READY",
        "failureCode": None, "artifactAvailable": available, "observationAvailable": True,
        "producerReferenceAvailable": True,
    }
    assert evidence["p14"]["release"] == quality["p14ReleaseEvidence"]
    p14_gate = next(item for item in quality["gates"] if item["id"] == "P-14")
    assert evidence["p14"]["verdict"] == p14_gate["status"]
    if terminal == "BATCH_READY":
        assert quality["overallPass"] is True
    elif terminal == "QUALITY_GATE_FAILED":
        assert quality["overallPass"] is False
        assert quality["hardFailIds"]
    else:
        assert quality["overallPass"] is True
        assert receipt["report"]["schemaViolations"] == ["synthetic.schema"]


def test_ah2_qgf_p14_hard_versus_non_p14_only_keeps_p14_status_verbatim():
    hard = json.loads(_files("B")[EVIDENCE_PATH])
    hard_receipt = json.loads(_files("B")[RECEIPT_PATH])
    assert "P-14" in hard_receipt["report"]["qualityGate"]["hardFailIds"]
    assert hard["p14"]["verdict"] == "FAIL"
    assert hard["p14"]["release"]["final"]["status"] == "FAIL"
    for name, status in (("QGF_P10_WARN", "WARN"), ("QGF_P10_PASS", "PASS")):
        files = _files(name)
        evidence = json.loads(files[EVIDENCE_PATH])
        receipt = json.loads(files[RECEIPT_PATH])
        assert "P-14" not in receipt["report"]["qualityGate"]["hardFailIds"]
        assert receipt["report"]["qualityGate"]["hardFailIds"] == ["P-10"]
        assert evidence["p14"]["verdict"] == status
        assert evidence["p14"]["release"]["final"]["status"] == status
        assert status in {"PASS", "WARN"}
        # The verifier never rewrites P-14 to FAIL: a FAIL claim is a derived mismatch.
        forged = _reseal(_replace_json(files, EVIDENCE_PATH, lambda value: value["p14"].update(verdict="FAIL")))
        _expect_fault(forged, "DERIVED_PROJECTION_MISMATCH")


@pytest.mark.parametrize(
    "name,mutate,code",
    [
        ("B", lambda value: value["terminal"].update(terminalStatus="BATCH_READY"), "RECEIPT_PROJECTION_MISMATCH"),
        ("B", lambda value: value["terminal"].update(artifactAvailable=True), "RECEIPT_PROJECTION_MISMATCH"),
        ("B", lambda value: value["terminal"].update(reportState="UNAVAILABLE"), "RECEIPT_PROJECTION_MISMATCH"),
        ("B", lambda value: value["p14"].update(verdict="PASS"), "DERIVED_PROJECTION_MISMATCH"),
        ("B", lambda value: value["p14"]["release"]["final"].update(status="PASS"), "DERIVED_PROJECTION_MISMATCH"),
        ("B", lambda value: value["p14"]["release"]["final"].update(hardReasons=[]), "DERIVED_PROJECTION_MISMATCH"),
        ("SV", lambda value: value["terminal"].update(terminalStatus="BATCH_READY"), "RECEIPT_PROJECTION_MISMATCH"),
        ("SV", lambda value: value["terminal"].update(artifactAvailable=True), "RECEIPT_PROJECTION_MISMATCH"),
        ("QGF_P10_WARN", lambda value: value["terminal"].update(terminalStatus="BATCH_READY", artifactAvailable=True), "RECEIPT_PROJECTION_MISMATCH"),
    ],
    ids=[
        "qgf-terminal-status", "qgf-artifact-available", "qgf-report-state", "qgf-verdict", "qgf-release-status",
        "qgf-hard-reasons", "sv-terminal-status", "sv-artifact-available", "non-p14-qgf-terminal-and-artifact",
    ],
)
def test_ah2_success_side_rewrites_of_failure_evidence_are_rejected(name, mutate, code):
    forged = _reseal(_replace_json(_files(name), EVIDENCE_PATH, mutate))
    _expect_fault(forged, code)


# --------------------------------------------------------------------------
# Layer C: digest corruption.
# --------------------------------------------------------------------------


@pytest.mark.parametrize("target_index", range(9))
def test_layer_c_raw_one_byte_flip_of_any_bundle_file_is_a_manifest_fault(target_index):
    files = _files("A")
    target = sorted(files)[target_index]
    assert len(files) == 9
    corrupted = dict(files)
    corrupted[target] = _flip_byte(files[target])
    _expect_fault(corrupted, "MANIFEST_MISMATCH")


_C_RESEALED = {
    "observation": (None, "OBSERVATION_DIGEST_MISMATCH", None),
    "capture-input": (CAPTURE_PATH, "INPUT_IDENTITY_MISMATCH", None),
    "batch-receipt": (RECEIPT_PATH, "BATCH_RECEIPT_INVALID", "DIGEST_MISMATCH"),
    "handoff": (ENVELOPE_PATH, "TRANSPORT_DIGEST_MISMATCH", None),
    "diagnostics": (DIAGNOSTICS_PATH, "DIAGNOSTICS_MISMATCH", None),
}


@pytest.mark.parametrize("target", sorted(_C_RESEALED))
@pytest.mark.parametrize("name", ["A", "B", "SV"])
def test_layer_c_one_byte_flip_with_only_the_manifest_resealed(name, target):
    files = _files(name)
    path, code, detail = _C_RESEALED[target]
    path = path or _obs_path(files)
    corrupted = dict(files)
    corrupted[path] = _flip_byte(files[path])
    _expect_fault(_reseal(corrupted), code, detail)


def test_layer_c_evidence_privacy_report_and_manifest_flips_reach_their_own_stage():
    files = _files("A")
    # evidence.json: a recorded attachment digest character (V8 stage).
    marker = b'"file":"attachments/capture-input.json","schemaVersion":"p14-capture-input-1","sha256":"'
    evidence = files[EVIDENCE_PATH]
    position = evidence.index(marker) + len(marker)
    flipped = evidence[:position] + (b"0" if evidence[position:position + 1] != b"0" else b"1") + evidence[position + 1:]
    assert len(flipped) == len(evidence) and flipped != evidence
    _expect_fault(_reseal({**files, EVIDENCE_PATH: flipped}), "ATTACHMENT_DIGEST_MISMATCH")
    # evidence.json: the capture status literal (V5 stage).
    status = _swap(evidence, b'"captureStatus":"captured"', b'"captureStatus":"Captured"')
    _expect_fault(_reseal({**files, EVIDENCE_PATH: status}), "BUNDLE_MALFORMED", "CAPTURE_STATUS")
    # validation/privacy-report.json (V12 stage).
    privacy = _swap(files[PRIVACY_PATH], b'"status":"PASS"', b'"status":"PASR"')
    _expect_fault(_reseal({**files, PRIVACY_PATH: privacy}), "BUNDLE_PRIVACY_VIOLATION")
    # manifest.json with manifest.sha256 coherent (V4 stage).
    manifest = files[MANIFEST_PATH]
    first = manifest.index(b'"sha256":"') + len(b'"sha256":"')
    changed = manifest[:first] + (b"0" if manifest[first:first + 1] != b"0" else b"1") + manifest[first + 1:]
    coherent = {**files, MANIFEST_PATH: changed, MANIFEST_DIGEST_PATH: _manifest_digest_line(changed)}
    _expect_fault(coherent, "MANIFEST_MISMATCH")


def test_layer_c_diagnostics_digest_cotamper_cannot_launder_the_change():
    files = _files("B")
    forged = _flip_byte(files[DIAGNOSTICS_PATH])
    evidence_files = _replace_json(
        {**files, DIAGNOSTICS_PATH: forged}, EVIDENCE_PATH,
        lambda value: value["diagnostics"].update(sha256=_sha(forged), bytes=len(forged)),
    )
    _expect_fault(_reseal(evidence_files), "DIAGNOSTICS_MISMATCH")


_MALFORMED_PAYLOADS = {
    "invalid_utf8": (lambda original: b"\xff\xfe\x00", "INVALID_UTF8"),
    "json_syntax": (lambda original: original[:-1], "JSON_SYNTAX"),
    "trailing_data": (lambda original: original + b" x", "TRAILING_DATA"),
    "noncanonical": (lambda original: original + b" ", "NONCANONICAL_ENCODING"),
    "duplicate_key": (lambda original: b'{"a":1,"a":2}', "DUPLICATE_KEY"),
    "nan_constant": (lambda original: b'{"a":NaN}', "NONFINITE_JSON"),
    "float_overflow": (lambda original: b'{"a":1e999}', "NONFINITE_JSON"),
    "huge_integer": (lambda original: b'{"a":' + b"9" * 5000 + b"}", "JSON_SYNTAX"),
}


@pytest.mark.parametrize("payload_name", sorted(_MALFORMED_PAYLOADS))
@pytest.mark.parametrize("target", _ATTACHMENT_KEYWORDS)
def test_layer_c_coherent_digest_chain_reaches_strict_attachment_decode(
    target, payload_name, default_int_digit_limit
):
    files = _files("A")
    build, detail = _MALFORMED_PAYLOADS[payload_name]
    replacement = build(files[_attachment_path(files, target)])
    _expect_fault(_retie(files, **{target: replacement}), "HANDOFF_MALFORMED", detail)


@pytest.mark.parametrize("payload_name", sorted(_MALFORMED_PAYLOADS))
@pytest.mark.parametrize(
    "target,code,detail",
    [
        ("manifest", "BUNDLE_MALFORMED", "MANIFEST"),
        ("evidence", "BUNDLE_MALFORMED", "EVIDENCE"),
        ("privacy-report", "BUNDLE_MALFORMED", "PRIVACY_DOCUMENT"),
        ("diagnostics", "DIAGNOSTICS_MISMATCH", None),
    ],
)
def test_layer_c_coherent_bundle_documents_reach_strict_decode(
    target, code, detail, payload_name, default_int_digit_limit
):
    files = _files("A")
    build, _ = _MALFORMED_PAYLOADS[payload_name]
    paths = {
        "manifest": MANIFEST_PATH, "evidence": EVIDENCE_PATH,
        "privacy-report": PRIVACY_PATH, "diagnostics": DIAGNOSTICS_PATH,
    }
    replacement = build(files[paths[target]])
    if target == "manifest":
        changed = {**files, MANIFEST_PATH: replacement, MANIFEST_DIGEST_PATH: _manifest_digest_line(replacement)}
    elif target == "diagnostics":
        changed = _replace_json(
            {**files, DIAGNOSTICS_PATH: replacement}, EVIDENCE_PATH,
            lambda value: value["diagnostics"].update(sha256=_sha(replacement), bytes=len(replacement)),
        )
        changed = _reseal(changed)
    else:
        changed = _reseal({**files, paths[target]: replacement})
    _expect_fault(changed, code, detail)


_SEMANTIC_ONE_BYTE_FLIPS = [
    (
        "observation-policy", "observation",
        b'"policyVersion":"p14-decision-aware-v1"', b'"policyVersion":"p14-decision-aware-v2"',
        "POLICY_BINDING_MISMATCH", None,
    ),
    (
        "capture-context", "capture",
        b'"regime":"bull_calm"', b'"regime":"bull_calN"',
        "INPUT_IDENTITY_MISMATCH", None,
    ),
    (
        "receipt-terminal", "receipt",
        b'"terminalStatus":"BATCH_READY"', b'"terminalStatus":"BATCH_READX"',
        "HANDOFF_MALFORMED", "TYPE",
    ),
    (
        "envelope-executed-sha", "envelope",
        b'"executedGitSha":"' + b"2" * 40 + b'"', b'"executedGitSha":"' + b"2" * 39 + b'3"',
        "SOURCE_IDENTITY_MISMATCH", None,
    ),
]


@pytest.mark.parametrize(
    "target,old,new,code,detail",
    [item[1:] for item in _SEMANTIC_ONE_BYTE_FLIPS],
    ids=[item[0] for item in _SEMANTIC_ONE_BYTE_FLIPS],
)
def test_layer_c_one_byte_semantic_flip_with_coherent_digest_chain(target, old, new, code, detail):
    files = _files("A")
    original = files[_attachment_path(files, target)]
    replacement = _swap(original, old, new)
    assert len(replacement) == len(original) and replacement != original
    assert sum(1 for left, right in zip(original, replacement) if left != right) == 1
    _expect_fault(_retie(files, **{target: replacement}), code, detail)


def test_layer_c_non_utf8_reaches_strict_decode_instead_of_the_manifest_stage():
    files = _files("A")
    stale = {**files, EVIDENCE_PATH: b"\xff"}
    _expect_fault(stale, "MANIFEST_MISMATCH")
    coherent = _reseal(stale)
    _expect_fault(coherent, "BUNDLE_MALFORMED", "EVIDENCE")
    manifest_coherent = {**files, MANIFEST_PATH: b"\xff", MANIFEST_DIGEST_PATH: _manifest_digest_line(b"\xff")}
    _expect_fault(manifest_coherent, "BUNDLE_MALFORMED", "MANIFEST")


_OVERSIZED_INTEGER = b"9" * 5000


@pytest.mark.parametrize("flavour", ["integer_digits", "float_overflow"])
@pytest.mark.parametrize(
    "target,pattern",
    [
        ("manifest", rb'"bytes":\d+'),
        ("evidence", rb'"bytes":\d+'),
        ("privacy-report", None),
        ("observation", rb'"artifactIndex":0'),
        ("capture", rb'"candidateCount":6'),
        ("receipt", rb'"candidateCount":6'),
        ("envelope", rb'"bytes":\d+'),
    ],
)
def test_layer_c_oversized_number_in_a_schema_number_position(
    target, pattern, flavour, default_int_digit_limit
):
    files = _files("A")
    huge = _OVERSIZED_INTEGER if flavour == "integer_digits" else b"1e999"
    if target == "privacy-report":
        replacement = _swap(files[PRIVACY_PATH], b'"status":"PASS"', b'"n":' + huge + b',"status":"PASS"')
        changed = _reseal({**files, PRIVACY_PATH: replacement})
        expected = ("BUNDLE_MALFORMED", "PRIVACY_DOCUMENT")
    elif target in {"manifest", "evidence"}:
        path = MANIFEST_PATH if target == "manifest" else EVIDENCE_PATH
        prefix = pattern[: pattern.index(rb":") + 1].replace(b"\\", b"")
        replacement = _swap_pattern(files[path], pattern, prefix + huge)
        if target == "manifest":
            changed = {**files, MANIFEST_PATH: replacement, MANIFEST_DIGEST_PATH: _manifest_digest_line(replacement)}
            expected = ("BUNDLE_MALFORMED", "MANIFEST")
        else:
            changed = _reseal({**files, EVIDENCE_PATH: replacement})
            expected = ("BUNDLE_MALFORMED", "EVIDENCE")
    else:
        path = _attachment_path(files, target)
        prefix = pattern[: pattern.index(rb":") + 1].replace(b"\\", b"")
        replacement = _swap_pattern(files[path], pattern, prefix + huge)
        changed = _retie(files, **{target: replacement})
        expected = ("HANDOFF_MALFORMED", "JSON_SYNTAX" if flavour == "integer_digits" else "NONFINITE_JSON")
    _expect_fault(changed, *expected)


def test_layer_c_in_bounds_large_integer_is_a_typed_mismatch_not_a_parse_failure(default_int_digit_limit):
    files = _files("A")
    manifest = _swap_pattern(files[MANIFEST_PATH], rb'"bytes":\d+', b'"bytes":' + b"9" * 4000)
    changed = {**files, MANIFEST_PATH: manifest, MANIFEST_DIGEST_PATH: _manifest_digest_line(manifest)}
    _expect_fault(changed, "MANIFEST_MISMATCH")


# --------------------------------------------------------------------------
# Layer D: provenance faults reached through the offline verifier.
# --------------------------------------------------------------------------


def _evidence_fault(name: str, mutate):
    return _reseal(_replace_json(_files(name), EVIDENCE_PATH, mutate))


_EVIDENCE_PROVENANCE = [
    ("reference-run-id", lambda v: v["producerReference"].update(runId="900000099"), "RUN_ID_MISMATCH", None),
    ("reference-run-attempt", lambda v: v["producerReference"].update(runAttempt="2"), "RUN_ATTEMPT_MISMATCH", None),
    ("reference-policy", lambda v: v["producerReference"].update(policyVersion="p14-other"), "POLICY_BINDING_MISMATCH", None),
    ("reference-observation-schema", lambda v: v["producerReference"].update(observationSchemaVersion="p14-canonical-observation-9"), "UNSUPPORTED_OBSERVATION_SCHEMA", None),
    ("reference-handoff-schema", lambda v: v["producerReference"].update(handoffSchemaVersion="p14-handoff-9"), "UNSUPPORTED_HANDOFF_SCHEMA", None),
    ("reference-executed-sha", lambda v: v["producerReference"].update(executedGitSha="3" * 40), "SOURCE_IDENTITY_MISMATCH", None),
    ("reference-status", lambda v: v["producerReference"].update(status="PENDING"), "PRODUCER_REFERENCE_MISSING", None),
    ("expected-run-id", lambda v: v["expectedBinding"].update(runId="900000099"), "RUN_ID_MISMATCH", None),
    ("expected-run-attempt", lambda v: v["expectedBinding"].update(runAttempt="2"), "RUN_ATTEMPT_MISMATCH", None),
    ("expected-policy", lambda v: v["expectedBinding"].update(policyVersion="p14-other"), "POLICY_BINDING_MISMATCH", None),
    ("expected-executed-sha", lambda v: v["expectedBinding"].update(executedGitSha="3" * 40), "SOURCE_IDENTITY_MISMATCH", None),
    ("expected-module", lambda v: v["expectedBinding"]["modules"][0].update(sha256="f" * 64), "SOURCE_IDENTITY_MISMATCH", None),
    ("expected-engine-score", lambda v: v["expectedBinding"].update(engineScoreVersion="market-score-v9"), "SOURCE_IDENTITY_MISMATCH", None),
    ("expected-raw-file", lambda v: v["expectedBinding"]["rawFiles"][0].update(sha256="e" * 64), "INPUT_IDENTITY_MISMATCH", None),
    ("expected-joined-input", lambda v: v["expectedBinding"]["joinedCandidateInput"].update(bytes=v["expectedBinding"]["joinedCandidateInput"]["bytes"] + 1), "INPUT_IDENTITY_MISMATCH", None),
    ("expected-replay-context", lambda v: v["expectedBinding"]["replayContext"].update(sha256="e" * 64), "INPUT_IDENTITY_MISMATCH", None),
    ("expected-capture-input", lambda v: v["expectedBinding"]["captureInput"].update(sha256="e" * 64), "INPUT_IDENTITY_MISMATCH", None),
    ("expected-repository", lambda v: v["expectedBinding"].update(repository="other/repository"), "RUN_IDENTITY_MISMATCH", None),
    ("expected-event", lambda v: v["expectedBinding"].update(event="workflow_dispatch"), "RUN_IDENTITY_MISMATCH", None),
    ("workflow-unknown-literal", lambda v: v["workflowStatus"].update(batchStatus="weird"), "WORKFLOW_STATUS_INCONSISTENT", None),
    ("workflow-smoke-without-pass", lambda v: v["workflowStatus"].update(batchStatus="batch_failed"), "WORKFLOW_STATUS_INCONSISTENT", None),
    ("consumer-module-path", lambda v: v["consumerIdentity"]["modules"][0].update(path="data/other.py"), "BUNDLE_MALFORMED", "CONSUMER_IDENTITY"),
    ("consumer-executed-sha", lambda v: v["consumerIdentity"].update(executedGitSha="3" * 40), "SOURCE_IDENTITY_MISMATCH", None),
    ("evidence-run-identity", lambda v: v["runIdentity"].update(repository="other/repository"), "RUN_IDENTITY_MISMATCH", None),
]


@pytest.mark.parametrize(
    "mutate,code,detail",
    [item[1:] for item in _EVIDENCE_PROVENANCE],
    ids=[item[0] for item in _EVIDENCE_PROVENANCE],
)
def test_layer_d_evidence_level_provenance_single_faults(mutate, code, detail):
    _expect_fault(_evidence_fault("A", mutate), code, detail)


_ENVELOPE_FAULTS = [
    ("schema", lambda v: v.update(schemaVersion="p14-handoff-9"), "UNSUPPORTED_HANDOFF_SCHEMA", None),
    ("observation-schema", lambda v: v.update(observationSchemaVersion="p14-canonical-observation-9"), "UNSUPPORTED_OBSERVATION_SCHEMA", None),
    ("receipt-schema", lambda v: v.update(receiptSchemaVersion="p14-handoff-receipt-9"), "UNSUPPORTED_RECEIPT_SCHEMA", None),
    ("capture-schema", lambda v: v.update(captureInputSchemaVersion="p14-capture-input-9"), "UNSUPPORTED_CAPTURE_INPUT_SCHEMA", None),
    ("unknown-key", lambda v: v.update(arbitraryUnknownKey=True), "HANDOFF_UNKNOWN_KEY", None),
    ("observation-file", lambda v: v["observation"].update(file="observation-other.json"), "HANDOFF_LOCATION_INVALID", None),
    ("receipt-file", lambda v: v["receipt"].update(file="other.json"), "HANDOFF_LOCATION_INVALID", None),
    ("run-id", lambda v: v["runIdentity"].update(runId="900000099"), "RUN_ID_MISMATCH", None),
    ("run-attempt", lambda v: v["runIdentity"].update(runAttempt="2"), "RUN_ATTEMPT_MISMATCH", None),
    ("run-repository", lambda v: v["runIdentity"].update(repository="other/repository"), "RUN_IDENTITY_MISMATCH", None),
    ("policy", lambda v: v.update(policyVersion="p14-other"), "POLICY_BINDING_MISMATCH", None),
    ("executed-sha", lambda v: v.update(executedGitSha="3" * 40), "SOURCE_IDENTITY_MISMATCH", None),
    ("receipt-record-bytes", lambda v: v["receipt"].update(bytes=v["receipt"]["bytes"] + 1), "BATCH_RECEIPT_INVALID", None),
    ("observation-record-bytes", lambda v: v["observation"].update(bytes=v["observation"]["bytes"] + 1), "OBSERVATION_DIGEST_MISMATCH", None),
    ("capture-record-bytes", lambda v: v["captureInput"].update(bytes=v["captureInput"]["bytes"] + 1), "INPUT_IDENTITY_MISMATCH", None),
]


@pytest.mark.parametrize(
    "mutate,code,detail",
    [item[1:] for item in _ENVELOPE_FAULTS],
    ids=[item[0] for item in _ENVELOPE_FAULTS],
)
def test_layer_d_envelope_single_faults_with_coherent_transport_digest(mutate, code, detail):
    _expect_fault(_retie_json(_files("A"), "envelope", mutate), code, detail)


_RECEIPT_FAULTS = [
    ("schema", lambda v: v.update(schemaVersion="p14-handoff-receipt-9"), "UNSUPPORTED_RECEIPT_SCHEMA", None),
    ("unknown-key", lambda v: v.update(arbitraryUnknownKey=True), "HANDOFF_UNKNOWN_KEY", None),
    ("run-identity", lambda v: v["runIdentity"].update(runId="900000099"), "RUN_IDENTITY_MISMATCH", None),
    ("policy", lambda v: v.update(policyVersion="p14-other"), "POLICY_BINDING_MISMATCH", None),
    ("executed-sha", lambda v: v.update(executedGitSha="3" * 40), "SOURCE_IDENTITY_MISMATCH", None),
    ("observation-digest", lambda v: v.update(observationDigest="e" * 64), "RECEIPT_OBSERVATION_MISMATCH", None),
    ("capture-digest", lambda v: v.update(captureInputDigest="e" * 64), "INPUT_IDENTITY_MISMATCH", None),
    ("report-context", lambda v: v["report"]["context"].update(regime="bear_volatile"), "INPUT_IDENTITY_MISMATCH", None),
    ("unknown-terminal", lambda v: v.update(terminalStatus="UNKNOWN_TERMINAL"), "HANDOFF_MALFORMED", "TYPE"),
    ("ready-forbidden-terminal", lambda v: v.update(terminalStatus="BATCH_EXCEPTION", artifactAvailable=False), "BATCH_RECEIPT_INVALID", "REPORT_STATE"),
    ("non-ready-allowed-terminal", lambda v: v.update(transportStatus="HANDOFF_WRITE_FAILED", failureCode="HANDOFF_WRITE_FAILED"), "BATCH_RECEIPT_INVALID", "TRANSPORT_STATUS"),
]


@pytest.mark.parametrize(
    "mutate,code,detail",
    [item[1:] for item in _RECEIPT_FAULTS],
    ids=[item[0] for item in _RECEIPT_FAULTS],
)
def test_layer_d_receipt_single_faults_with_coherent_digest_chain(mutate, code, detail):
    _expect_fault(_retie_receipt(_files("A"), mutate), code, detail)


def test_layer_d_qgf_receipt_gate_parity_faults():
    artifact = _retie_receipt(_files("B"), lambda v: v.update(artifactAvailable=True))
    _expect_fault(artifact, "BATCH_RECEIPT_INVALID", "ARTIFACT_AVAILABLE")
    parity = _retie_receipt(_files("B"), lambda v: v["report"]["qualityGate"].update(hardFailIds=[]))
    _expect_fault(parity, "BATCH_RECEIPT_INVALID", "GATE_PARITY")


_OBSERVATION_FAULTS = [
    ("schema", lambda v: v.update(schemaVersion="p14-canonical-observation-9"), "UNSUPPORTED_OBSERVATION_SCHEMA", None),
    ("unknown-key", lambda v: v.update(arbitraryUnknownKey=True), "HANDOFF_UNKNOWN_KEY", None),
    ("run-id", lambda v: v["runIdentity"].update(runId="900000099"), "RUN_ID_MISMATCH", None),
    ("run-attempt", lambda v: v["runIdentity"].update(runAttempt="2"), "RUN_ATTEMPT_MISMATCH", None),
    ("policy", lambda v: v.update(policyVersion="p14-other"), "POLICY_BINDING_MISMATCH", None),
    ("executed-sha", lambda v: v["sourceIdentity"].update(executedGitSha="3" * 40), "SOURCE_IDENTITY_MISMATCH", None),
    ("module-digest", lambda v: v["sourceIdentity"]["modules"][0].update(sha256="f" * 64), "SOURCE_IDENTITY_MISMATCH", None),
    ("module-set", lambda v: v["sourceIdentity"]["modules"].reverse(), "SOURCE_IDENTITY_MISMATCH", "MODULE_SET"),
    ("raw-file", lambda v: v["inputIdentity"]["rawFiles"]["candidatesStocks"].update(sha256="e" * 64), "INPUT_IDENTITY_MISMATCH", None),
    ("replay-context", lambda v: v["inputIdentity"]["replayContext"].update(sha256="e" * 64), "INPUT_IDENTITY_MISMATCH", None),
    ("parameters", lambda v: v["parameters"].update(topK=41), "HANDOFF_UNKNOWN_KEY", None),
    ("artifact-index", lambda v: v["base"]["candidates"][0].update(artifactIndex=5), "HANDOFF_MALFORMED", "TYPE"),
]


@pytest.mark.parametrize(
    "mutate,code,detail",
    [item[1:] for item in _OBSERVATION_FAULTS],
    ids=[item[0] for item in _OBSERVATION_FAULTS],
)
def test_layer_d_observation_single_faults_with_coherent_digest_chain(mutate, code, detail):
    _expect_fault(_retie_json(_files("A"), "observation", mutate), code, detail)


_CAPTURE_FAULTS = [
    ("schema", lambda v: v.update(schemaVersion="p14-capture-input-9"), "UNSUPPORTED_CAPTURE_INPUT_SCHEMA", None),
    ("unknown-key", lambda v: v.update(arbitraryUnknownKey=True), "HANDOFF_UNKNOWN_KEY", None),
    ("row-unknown-key", lambda v: v["joinedCandidateInput"][0].update(arbitraryUnknownKey=1), "HANDOFF_UNKNOWN_KEY", None),
    ("context-unknown-key", lambda v: v["context"].update(arbitraryUnknownKey=1), "HANDOFF_UNKNOWN_KEY", None),
    ("timestamp-type", lambda v: v.update(candidatesUpdatedAt=1), "HANDOFF_MALFORMED", "TYPE"),
    ("context-value", lambda v: v["context"].update(regime="bear_volatile"), "INPUT_IDENTITY_MISMATCH", None),
    ("joined-row-value", lambda v: v["joinedCandidateInput"][0].update(price=1.0), "INPUT_IDENTITY_MISMATCH", None),
]


@pytest.mark.parametrize(
    "mutate,code,detail",
    [item[1:] for item in _CAPTURE_FAULTS],
    ids=[item[0] for item in _CAPTURE_FAULTS],
)
def test_layer_d_capture_single_faults_with_coherent_digest_chain(mutate, code, detail):
    _expect_fault(_retie_json(_files("A"), "capture", mutate), code, detail)


# --------------------------------------------------------------------------
# Layer E: V1-V13 single faults and first-fault precedence.
# --------------------------------------------------------------------------


def _v1_inventory_cases():
    files = _files("A")
    return [
        ("unsafe-parent-path", {**files, "../escape": b"x"}, "BUNDLE_LOCATION_INVALID", None),
        ("absolute-path", {**files, "/etc/passwd": b"x"}, "BUNDLE_LOCATION_INVALID", None),
        ("backslash-path", {**files, "attachments\\evil": b"x"}, "BUNDLE_LOCATION_INVALID", None),
        ("non-normalised-path", {**files, "attachments/./x": b"x"}, "BUNDLE_LOCATION_INVALID", None),
        ("empty-path", {**files, "": b"x"}, "BUNDLE_LOCATION_INVALID", None),
        ("non-bytes-payload", {**files, "attachments/x": "text"}, "BUNDLE_LOCATION_INVALID", None),
        ("bytearray-payload", {**files, "attachments/x": bytearray(b"x")}, "BUNDLE_LOCATION_INVALID", None),
        ("missing-manifest-json", {k: v for k, v in files.items() if k != MANIFEST_PATH}, "BUNDLE_INCOMPLETE", None),
        ("missing-manifest-sha", {k: v for k, v in files.items() if k != MANIFEST_DIGEST_PATH}, "BUNDLE_INCOMPLETE", None),
        ("empty-map", {}, "BUNDLE_INCOMPLETE", None),
    ]


@pytest.mark.parametrize("index", range(10))
def test_v1_file_map_inventory_faults(index):
    label, files, code, detail = _v1_inventory_cases()[index]
    _expect_fault(files, code, detail)


def test_v1_non_mapping_and_size_limits(monkeypatch):
    for value in (None, [("a", b"x")], "text", 3):
        _expect_fault(value, "BUNDLE_MALFORMED", "FILE_MAP")
    oversized = _files("A")
    oversized[EVIDENCE_PATH] = b"0" * (bundle.MAX_FILE_BYTES + 1)
    _expect_fault(oversized, "BUNDLE_MALFORMED", "FILE_SIZE")
    monkeypatch.setattr(bundle, "MAX_TOTAL_BYTES", 1000)
    _expect_fault(_files("A"), "BUNDLE_MALFORMED", "TOTAL_SIZE")


@pytest.mark.parametrize(
    "digest_line",
    [
        b"0" * 64 + b"  manifest.json\n",
        b"",
        b"\n",
        b"not-a-digest  manifest.json\n",
        b"X" * 64 + b"  manifest.json\n",
    ],
    ids=["stale", "empty", "newline", "not-hex", "uppercase-x"],
)
def test_v2_manifest_digest_marker_value_faults(digest_line):
    _expect_fault({**_files("A"), MANIFEST_DIGEST_PATH: digest_line}, "MANIFEST_MISMATCH")


def test_v2_manifest_digest_marker_format_faults():
    files = _files("A")
    good = files[MANIFEST_DIGEST_PATH]
    for malformed in (
        good.upper(),
        good.rstrip(b"\n"),
        good.replace(b"  ", b" "),
        good.replace(b"manifest.json", b"evidence.json"),
        good + b"\n",
    ):
        _expect_fault({**files, MANIFEST_DIGEST_PATH: malformed}, "MANIFEST_MISMATCH")


def _manifest_replaced(files, payload: bytes):
    return {**files, MANIFEST_PATH: payload, MANIFEST_DIGEST_PATH: _manifest_digest_line(payload)}


@pytest.mark.parametrize(
    "build,code,detail",
    [
        (lambda original: b"{", "BUNDLE_MALFORMED", "MANIFEST"),
        (lambda original: original + b" ", "BUNDLE_MALFORMED", "MANIFEST"),
        (lambda original: b'{"a":1,"a":2}', "BUNDLE_MALFORMED", "MANIFEST"),
        (lambda original: b"[]", "BUNDLE_MALFORMED", "MANIFEST"),
        (lambda original: original[:-1] + b',"arbitraryUnknownKey":true}', "BUNDLE_MALFORMED", "MANIFEST"),
    ],
    ids=["syntax", "noncanonical", "duplicate-key", "not-an-object", "unsorted-extra-key"],
)
def test_v3_manifest_strict_decode_faults(build, code, detail):
    files = _files("A")
    _expect_fault(_manifest_replaced(files, build(files[MANIFEST_PATH])), code, detail)


def test_v3_manifest_closed_keys_and_bundle_id():
    files = _files("A")
    _expect_fault(_manifest_edit(files, lambda m: m.update(arbitraryUnknownKey=True)), "BUNDLE_UNKNOWN_KEY", "MANIFEST")
    _expect_fault(_manifest_edit(files, lambda m: m.pop("files")), "BUNDLE_MALFORMED", "MANIFEST")
    _expect_fault(_manifest_edit(files, lambda m: m.update(bundleId="candidate-funnel-evidence-abc-1")), "BUNDLE_MALFORMED", "BUNDLE_ID")
    _expect_fault(_manifest_edit(files, lambda m: m.update(files={})), "BUNDLE_MALFORMED", "MANIFEST_FILES")
    _expect_fault(_manifest_edit(files, lambda m: m["files"][0].update(holdings=1)), "BUNDLE_UNKNOWN_KEY", "MANIFEST_RECORD")
    _expect_fault(_manifest_edit(files, lambda m: m["files"][0].pop("bytes")), "BUNDLE_MALFORMED", "MANIFEST_RECORD")
    _expect_fault(_manifest_edit(files, lambda m: m["files"][0].update(sha256="ZZ")), "BUNDLE_MALFORMED", "MANIFEST_DIGEST")
    _expect_fault(_manifest_edit(files, lambda m: m["files"][0].update(bytes=-1)), "BUNDLE_MALFORMED", "MANIFEST_BYTES")


def test_v4_manifest_file_list_versus_actual_files():
    files = _files("A")
    _expect_fault(_manifest_edit(files, lambda m: m["files"][0].update(sha256="0" * 64)), "MANIFEST_MISMATCH")
    _expect_fault(_manifest_edit(files, lambda m: m["files"][0].update(bytes=m["files"][0]["bytes"] + 1)), "MANIFEST_MISMATCH")
    _expect_fault(_manifest_edit(files, lambda m: m["files"].pop()), "MANIFEST_MISMATCH")
    _expect_fault(_manifest_edit(files, lambda m: m["files"].append(dict(m["files"][0]))), "MANIFEST_MISMATCH")
    _expect_fault(_manifest_edit(files, lambda m: m["files"].append({"path": "../x", "sha256": "0" * 64, "bytes": 0})), "MANIFEST_MISMATCH")
    _expect_fault(_manifest_edit(files, lambda m: m["files"].append({"path": "manifest.json", "sha256": "0" * 64, "bytes": 0})), "MANIFEST_MISMATCH")
    _expect_fault({**files, "attachments/unlisted.json": b"{}"}, "MANIFEST_MISMATCH")
    _expect_fault({k: v for k, v in files.items() if k != EVIDENCE_PATH}, "MANIFEST_MISMATCH")


def test_v5_evidence_strict_decode_keys_and_types():
    files = _files("A")
    for payload, code, detail in (
        (b"{", "BUNDLE_MALFORMED", "EVIDENCE"),
        (b"[]", "BUNDLE_MALFORMED", "EVIDENCE"),
        (b"", "BUNDLE_MALFORMED", "EVIDENCE"),
        (files[EVIDENCE_PATH] + b" ", "BUNDLE_MALFORMED", "EVIDENCE"),
    ):
        _expect_fault(_reseal({**files, EVIDENCE_PATH: payload}), code, detail)
    _expect_fault(_evidence_fault("A", lambda v: v.update(arbitraryUnknownKey=True)), "BUNDLE_UNKNOWN_KEY", "EVIDENCE")
    _expect_fault(_evidence_fault("A", lambda v: v.pop("p14")), "BUNDLE_MALFORMED", "EVIDENCE")
    _expect_fault(_evidence_fault("A", lambda v: v.update(captureStatus=1)), "BUNDLE_MALFORMED", "CAPTURE_STATUS")
    _expect_fault(_evidence_fault("A", lambda v: v.update(captureStatus="bogus")), "BUNDLE_MALFORMED", "CAPTURE_STATUS")
    _expect_fault(_evidence_fault("A", lambda v: v.update(schemaVersion="candidate-funnel-run-evidence-4")), "UNSUPPORTED_BUNDLE_SCHEMA")
    _expect_fault(_evidence_fault("A", lambda v: v.update(bundleId="candidate-funnel-evidence-900000099-1")), "MANIFEST_MISMATCH")
    _expect_fault(_evidence_fault("A", lambda v: v["attachments"].update(arbitraryUnknownKey={})), "BUNDLE_UNKNOWN_KEY", "ATTACHMENTS")
    _expect_fault(_evidence_fault("A", lambda v: v["attachments"]["observation"].update(file="attachments/not-an-observation.json")), "ATTACHMENT_DIGEST_MISMATCH")


def test_v6_invalid_bundle_shape_faults():
    files = _invalid_files()
    _expect_fault(_reseal({**files, "attachments/capture-input.json": b"{}"}), "BUNDLE_INCOMPLETE")
    _expect_fault(_reseal({**files, DIAGNOSTICS_PATH: b"{}"}), "BUNDLE_INCOMPLETE")
    for mutate, code, detail in (
        (lambda v: v["failure"].update(code="NOT_A_CODE"), "BUNDLE_MALFORMED", "FAILURE"),
        (lambda v: v["failure"].update(stage="NOT_A_STAGE"), "BUNDLE_MALFORMED", "FAILURE"),
        (lambda v: v["failure"].update(detail="unsafe detail"), "BUNDLE_MALFORMED", "FAILURE"),
        (lambda v: v["failure"].update(detail=3), "BUNDLE_MALFORMED", "FAILURE"),
        (lambda v: v["failure"].update(holdings=1), "BUNDLE_UNKNOWN_KEY", "FAILURE"),
        (lambda v: v["failure"].pop("stage"), "BUNDLE_MALFORMED", "FAILURE"),
        (lambda v: v["consumerIdentity"].update(executedGitSha="short"), "BUNDLE_MALFORMED", "CONSUMER_IDENTITY"),
        (lambda v: v["runIdentity"].update(runId="0"), "BUNDLE_MALFORMED", "RUN_IDENTITY"),
        (lambda v: v["runIdentity"].update(broker="x"), "BUNDLE_UNKNOWN_KEY", "RUN_IDENTITY"),
        (lambda v: v["workflowStatus"].update(batchStatus="weird"), "WORKFLOW_STATUS_INCONSISTENT", None),
        (lambda v: v.update(consumerIdentity=[]), "BUNDLE_MALFORMED", "CONSUMER_IDENTITY"),
    ):
        changed = _reseal(_replace_json(files, EVIDENCE_PATH, mutate))
        _expect_fault(changed, code, detail)


def test_v7_v8_reference_admission_and_attachment_records():
    for field, value in (("sha256", "0" * 64), ("bytes", 0), ("schemaVersion", "other-1"), ("file", "attachments/other.json")):
        changed = _evidence_fault("A", lambda v, f=field, x=value: v["attachments"]["captureInput"].update({f: x}))
        _expect_fault(changed, "ATTACHMENT_DIGEST_MISMATCH")
    for target in ("observation", "receipt", "envelope"):
        changed = _evidence_fault("A", lambda v, t=target: v["attachments"][t].update(sha256="0" * 64))
        _expect_fault(changed, "ATTACHMENT_DIGEST_MISMATCH")


def test_v9_terminal_and_workflow_projection_faults():
    for key, value in (
        ("terminalStatus", "SCHEMA_VIOLATIONS"), ("reportState", "UNAVAILABLE"), ("transportStatus", "P14_NOT_EVALUATED"),
        ("failureCode", "HANDOFF_WRITE_FAILED"), ("artifactAvailable", False), ("observationAvailable", False),
        ("producerReferenceAvailable", False),
    ):
        changed = _evidence_fault("A", lambda v, k=key, x=value: v["terminal"].update({k: x}))
        _expect_fault(changed, "RECEIPT_PROJECTION_MISMATCH")
    _expect_fault(_evidence_fault("A", lambda v: v["terminal"].update(holdings=1)), "BUNDLE_UNKNOWN_KEY", "TERMINAL")
    _expect_fault(_evidence_fault("B", lambda v: v["workflowStatus"].update(batchStatus="batch_passed")), "WORKFLOW_STATUS_INCONSISTENT")


def test_v10_derived_projection_faults():
    for mutate in (
        lambda v: v["p14"].update(verdict="PASS"),
        lambda v: v["p14"].update(jaccard=0.5),
        lambda v: v["p14"].update(swapCount=99),
        lambda v: v["p14"]["baseTop40"].reverse(),
        lambda v: v["p14"]["perturbedTop40"].pop(),
        lambda v: v["p14"]["release"].update(policyVersion="p14-other"),
        lambda v: v["replay"].update(schemaVersion="candidate-funnel-p14-replay-1"),
        lambda v: v["replay"].update(input={"attachment": "receipt"}),
        lambda v: v["replay"]["baseFullOrderedRankVector"].pop(),
        lambda v: v["replay"]["perturbedFullOrderedRankVector"][0].update(marketRank=9),
        lambda v: v["replay"]["boundaryOutsideBand"].update(size=11),
        lambda v: v["confidenceInvariant"].update(state="NOT_VERIFIABLE"),
        lambda v: v["p14"]["release"]["top40"].update(jaccard=0.25),
    ):
        _expect_fault(_evidence_fault("A", mutate), "DERIVED_PROJECTION_MISMATCH")
    _expect_fault(_evidence_fault("A", lambda v: v["p14"].update(holdings=1)), "BUNDLE_UNKNOWN_KEY", "P14")
    _expect_fault(_evidence_fault("A", lambda v: v["replay"].update(holdings=1)), "BUNDLE_UNKNOWN_KEY", "REPLAY")


def test_v11_diagnostics_faults():
    files = _files("A")
    _expect_fault(_reseal({**files, DIAGNOSTICS_PATH: b"{}"}), "DIAGNOSTICS_MISMATCH")
    _expect_fault(_evidence_fault("A", lambda v: v["diagnostics"].update(sha256="0" * 64)), "DIAGNOSTICS_MISMATCH")
    _expect_fault(_evidence_fault("A", lambda v: v["diagnostics"].update(bytes=0)), "DIAGNOSTICS_MISMATCH")
    _expect_fault(_evidence_fault("A", lambda v: v["diagnostics"].update(file="other.json")), "DIAGNOSTICS_MISMATCH")
    _expect_fault(_evidence_fault("A", lambda v: v["diagnostics"].update(diagnosticsVersion="other-1")), "DIAGNOSTICS_MISMATCH")
    _expect_fault(_evidence_fault("A", lambda v: v["diagnostics"].update(holdings=1)), "BUNDLE_UNKNOWN_KEY", "DIAGNOSTICS")


def test_v12_privacy_report_faults():
    files = _files("A")
    _expect_fault(_reseal({**files, PRIVACY_PATH: _swap(files[PRIVACY_PATH], b'"status":"PASS"', b'"status":"FAIL"')}), "BUNDLE_PRIVACY_VIOLATION")
    _expect_fault(_reseal({**files, PRIVACY_PATH: b'{"files":[],"schemaVersion":"other","status":"PASS"}'}), "BUNDLE_PRIVACY_VIOLATION")
    _expect_fault(_reseal({**files, PRIVACY_PATH: b"{}"}), "BUNDLE_MALFORMED", "PRIVACY_REPORT")
    missing_key = _reseal(_replace_json(files, PRIVACY_PATH, lambda value: value.pop("status")))
    _expect_fault(missing_key, "BUNDLE_MALFORMED", "PRIVACY_REPORT")
    unknown_key = _reseal(_replace_json(files, PRIVACY_PATH, lambda value: value.update(arbitraryUnknownKey=1)))
    _expect_fault(unknown_key, "BUNDLE_UNKNOWN_KEY", "PRIVACY_REPORT")


def test_v13_consumer_and_source_identity_faults(tmp_path):
    _expect_fault(_evidence_fault("A", lambda v: v["consumerIdentity"].update(executedGitSha="3" * 40)), "SOURCE_IDENTITY_MISMATCH")
    empty = tmp_path / "empty-repo"
    empty.mkdir()
    subprocess.run(["git", "init", "-q", str(empty)], check=True, capture_output=True, env=_git_env(tmp_path))
    _expect_fault(_files("A"), "SOURCE_IDENTITY_MISMATCH", source_repo=empty.resolve())
    for hostile in (Path("relative/repo"), tmp_path / "does-not-exist", tmp_path / "file.txt"):
        (tmp_path / "file.txt").write_text("x")
        _expect_fault(_files("A"), "SOURCE_IDENTITY_MISMATCH", source_repo=hostile)


_CONTAINER_FAULTS = (
    ("C1-unsafe-path", lambda f: {**f, "../escape": b"x"}, "BUNDLE_LOCATION_INVALID"),
    ("C2-manifest-sha-missing", lambda f: {k: v for k, v in f.items() if k != MANIFEST_DIGEST_PATH}, "BUNDLE_INCOMPLETE"),
    ("C3-manifest-sha-stale", lambda f: {**f, MANIFEST_DIGEST_PATH: b"0" * 64 + b"  manifest.json\n"}, "MANIFEST_MISMATCH"),
    ("C4-manifest-unknown-key", lambda f: _manifest_edit(f, lambda m: m.update(arbitraryUnknownKey=True)), "BUNDLE_UNKNOWN_KEY"),
    ("C5-manifest-schema", lambda f: _manifest_edit(f, lambda m: m.update(schemaVersion="candidate-funnel-run-evidence-4")), "UNSUPPORTED_BUNDLE_SCHEMA"),
    ("C6-manifest-record", lambda f: _manifest_edit(f, lambda m: m["files"][0].update(sha256="0" * 64)), "MANIFEST_MISMATCH"),
)


def _evidence_edit(mutate):
    return lambda files: _replace_json(files, EVIDENCE_PATH, mutate)


# A recorded observation filename that violates the V8 filename shape.
MALFORMED_OBSERVATION_FILE = "attachments/not-an-observation.json"


_CONTENT_FAULTS = (
    ("E1-evidence-unknown-key", _evidence_edit(lambda v: v.update(arbitraryUnknownKey=True)), "BUNDLE_UNKNOWN_KEY"),
    ("E2-evidence-schema", _evidence_edit(lambda v: v.update(schemaVersion="candidate-funnel-run-evidence-4")), "UNSUPPORTED_BUNDLE_SCHEMA"),
    ("E3-reference-status", _evidence_edit(lambda v: v["producerReference"].update(status="PENDING")), "PRODUCER_REFERENCE_MISSING"),
    ("E4-inventory-extra-file", lambda f: {**f, "attachments/extra.json": b"{}"}, "BUNDLE_INCOMPLETE"),
    ("E5-reference-run-id", _evidence_edit(lambda v: v["producerReference"].update(runId="900000099")), "RUN_ID_MISMATCH"),
    ("E6-envelope-transport-digest", lambda f: {**f, ENVELOPE_PATH: _flip_byte(f[ENVELOPE_PATH])}, "TRANSPORT_DIGEST_MISMATCH"),
    ("E6b-observation-filename", _evidence_edit(lambda v: v["attachments"]["observation"].update(file=MALFORMED_OBSERVATION_FILE)), "ATTACHMENT_DIGEST_MISMATCH"),
    ("E7-attachment-record", _evidence_edit(lambda v: v["attachments"]["captureInput"].update(sha256="0" * 64)), "ATTACHMENT_DIGEST_MISMATCH"),
    ("E8-terminal-projection", _evidence_edit(lambda v: v["terminal"].update(artifactAvailable=True)), "RECEIPT_PROJECTION_MISMATCH"),
    ("E9-workflow-status", _evidence_edit(lambda v: v["workflowStatus"].update(batchStatus="batch_passed")), "WORKFLOW_STATUS_INCONSISTENT"),
    ("E10-derived-projection", _evidence_edit(lambda v: v["p14"].update(verdict="PASS")), "DERIVED_PROJECTION_MISMATCH"),
    ("E11-diagnostics", lambda f: {**f, DIAGNOSTICS_PATH: _flip_byte(f[DIAGNOSTICS_PATH])}, "DIAGNOSTICS_MISMATCH"),
    ("E12-privacy-report", lambda f: {**f, PRIVACY_PATH: _swap(f[PRIVACY_PATH], b'"status":"PASS"', b'"status":"PASR"')}, "BUNDLE_PRIVACY_VIOLATION"),
    ("E13-consumer-source", _evidence_edit(lambda v: v["consumerIdentity"].update(executedGitSha="3" * 40)), "SOURCE_IDENTITY_MISMATCH"),
)

# Order == verifier order (V1 location/inventory, V2-V4 manifest, V5 schema/key/type,
# V7 handoff/reference/admission, then V8 attachment filename / digest records
# (E6b: the observation filename shape is V8 and never preempts a V7 fault),
# V9 receipt projection / workflow,
# V10 derived projection, V11 diagnostics, V12 privacy, V13 source identity).
_FAULTS = tuple(("container", *item) for item in _CONTAINER_FAULTS) + tuple(
    ("content", *item) for item in _CONTENT_FAULTS
)


def _faulted_bundle(indexes) -> dict[str, bytes]:
    """Apply the selected faults, later verifier stages first, on top of Golden B."""
    files = _files("B")
    selected = [_FAULTS[index] for index in sorted(indexes, reverse=True)]
    for kind, _name, apply, _code in selected:
        if kind == "content":
            files = apply(files)
    files = _reseal(files)
    for kind, _name, apply, _code in selected:
        if kind == "container":
            files = apply(files)
    return files


@pytest.mark.parametrize("index", range(len(_FAULTS)), ids=[item[1] for item in _FAULTS])
def test_first_fault_matrix_single_fault_per_verifier_stage(index):
    _, name, _apply, code = _FAULTS[index]
    report = bundle.verify_bundle_files(_faulted_bundle([index]))
    assert report.bundle_integrity == "FAIL", name
    assert len(report.errors) == 1
    assert report.errors[0].code == code, (name, report.errors[0])


@pytest.mark.parametrize(
    "first,second",
    list(itertools.combinations(range(len(_FAULTS)), 2)),
    ids=[f"{_FAULTS[a][1].split('-')[0]}+{_FAULTS[b][1].split('-')[0]}" for a, b in itertools.combinations(range(len(_FAULTS)), 2)],
)
def test_first_fault_matrix_earlier_verifier_stage_wins_over_later_stage(first, second):
    report = bundle.verify_bundle_files(_faulted_bundle([first, second]))
    assert report.bundle_integrity == "FAIL"
    assert len(report.errors) == 1
    assert report.errors[0].code == _FAULTS[first][3], (_FAULTS[first][1], _FAULTS[second][1], report.errors[0])


def test_first_fault_matrix_covers_every_verifier_stage_and_reports_a_single_error():
    covered = {item[1].split("-")[0] for item in _FAULTS}
    assert covered == {f"C{n}" for n in range(1, 7)} | {f"E{n}" for n in range(1, 14)} | {"E6b"}
    assert len(_FAULTS) == 20 and len(list(itertools.combinations(range(len(_FAULTS)), 2))) == 190
    # Multiple faults never yield more than one reported error (fail at first fault).
    report = bundle.verify_bundle_files(_faulted_bundle(range(len(_FAULTS))))
    assert len(report.errors) == 1
    assert report.errors[0].code == "BUNDLE_LOCATION_INVALID"


# --------------------------------------------------------------------------
# V7 (handoff / reference / admission) precedes V8 (observation filename and
# attachment records).  The observation filename shape must never preempt a V7
# fault; it is reported only once V7 is otherwise clean.
# --------------------------------------------------------------------------


def _with_malformed_observation_filename(mutate):
    def both(value):
        mutate(value)
        value["attachments"]["observation"].update(file=MALFORMED_OBSERVATION_FILE)

    return both


def test_v7_run_id_fault_precedes_v8_malformed_observation_filename():
    fault = lambda v: v["producerReference"].update(runId="900000099")
    _expect_fault(_evidence_fault("A", fault), "RUN_ID_MISMATCH")
    _expect_fault(_evidence_fault("A", _with_malformed_observation_filename(fault)), "RUN_ID_MISMATCH")


def test_v7_run_attempt_fault_precedes_v8_malformed_observation_filename():
    fault = lambda v: v["producerReference"].update(runAttempt="2")
    _expect_fault(_evidence_fault("A", fault), "RUN_ATTEMPT_MISMATCH")
    _expect_fault(_evidence_fault("A", _with_malformed_observation_filename(fault)), "RUN_ATTEMPT_MISMATCH")


def test_v7_policy_reference_admission_fault_precedes_v8_malformed_observation_filename():
    policy = lambda v: v["producerReference"].update(policyVersion="p14-other")
    _expect_fault(_evidence_fault("A", _with_malformed_observation_filename(policy)), "POLICY_BINDING_MISMATCH")
    reference = lambda v: v["producerReference"].update(status="PENDING")
    _expect_fault(_evidence_fault("A", _with_malformed_observation_filename(reference)), "PRODUCER_REFERENCE_MISSING")
    admission = lambda v: v["expectedBinding"]["captureInput"].update(sha256="e" * 64)
    _expect_fault(_evidence_fault("A", _with_malformed_observation_filename(admission)), "INPUT_IDENTITY_MISMATCH")
    tampered = _evidence_fault("A", _with_malformed_observation_filename(lambda v: None))
    tampered[ENVELOPE_PATH] = _flip_byte(tampered[ENVELOPE_PATH])
    _expect_fault(_reseal(tampered), "TRANSPORT_DIGEST_MISMATCH")


_V7_ADMISSION_FAULTS = [
    item for item in _EVIDENCE_PROVENANCE
    if item[0].startswith(("reference-", "expected-")) and item[2] != "SOURCE_IDENTITY_MISMATCH"
]


@pytest.mark.parametrize(
    "mutate,code,detail",
    [item[1:] for item in _V7_ADMISSION_FAULTS],
    ids=[item[0] for item in _V7_ADMISSION_FAULTS],
)
def test_v7_admission_faults_are_reported_ahead_of_a_malformed_observation_filename(mutate, code, detail):
    assert _V7_ADMISSION_FAULTS
    _expect_fault(_evidence_fault("A", _with_malformed_observation_filename(mutate)), code, detail)


@pytest.mark.parametrize(
    "recorded",
    [MALFORMED_OBSERVATION_FILE, "attachments/observation-" + "0" * 64 + ".json", "attachments/Observation-x.json", "", None, 7, [], {}],
    ids=["not-an-observation", "absent-well-shaped", "wrong-case", "empty", "null", "integer", "array", "object"],
)
def test_v8_observation_filename_is_reported_when_v7_is_otherwise_valid(recorded):
    changed = _evidence_fault("A", lambda v: v["attachments"]["observation"].update(file=recorded))
    _expect_fault(changed, "ATTACHMENT_DIGEST_MISMATCH")
    changed_b = _evidence_fault("B", lambda v: v["attachments"]["observation"].update(file=recorded))
    _expect_fault(changed_b, "ATTACHMENT_DIGEST_MISMATCH")


def test_v8_observation_attachment_that_is_not_an_object_is_reported_after_v7():
    _expect_fault(
        _evidence_fault("A", lambda v: v["attachments"].update(observation=None)), "ATTACHMENT_DIGEST_MISMATCH",
    )
    fault = lambda v: (v["producerReference"].update(runId="900000099"), v["attachments"].update(observation=None))
    _expect_fault(_evidence_fault("A", fault), "RUN_ID_MISMATCH")


# --------------------------------------------------------------------------
# Layer E: directory / ZIP readers.
# --------------------------------------------------------------------------


def test_directory_reader_rejects_missing_extra_symlink_and_non_regular(tmp_path):
    source = GOLDEN_ROOT / "candidate-funnel-evidence-900000001-1"
    assert bundle.read_bundle_directory(source.resolve()) == _golden_a()
    copied = tmp_path / source.name
    copied.mkdir()
    (copied / "attachments").mkdir()
    (copied / "validation").mkdir()
    for path, payload in _golden_a().items():
        target = copied / path
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(payload)
    (copied / "extra").write_bytes(b"x")
    with pytest.raises(bundle.EvidenceBundleError):
        bundle.read_bundle_directory(copied)
    (copied / "extra").unlink()
    (copied / "evidence.json").unlink()
    with pytest.raises(bundle.EvidenceBundleError):
        bundle.read_bundle_directory(copied)
    (copied / "evidence.json").symlink_to(source / "evidence.json")
    with pytest.raises(bundle.EvidenceBundleError) as caught:
        bundle.read_bundle_directory(copied)
    assert caught.value.code == "BUNDLE_LOCATION_INVALID"
    (copied / "evidence.json").unlink()
    os.mkfifo(copied / "evidence.json")
    with pytest.raises(bundle.EvidenceBundleError) as non_regular:
        bundle.read_bundle_directory(copied)
    assert non_regular.value.code == "BUNDLE_LOCATION_INVALID"


def test_layer_e_directory_reader_location_size_and_bundle_id_rules(tmp_path, monkeypatch):
    good = _write_bundle_dir(tmp_path / "good", _files("A"))
    assert bundle.read_bundle_directory(good) == _golden_a()
    for hostile in (Path("relative") / good.name, good / ".." / good.name):
        with pytest.raises(bundle.EvidenceBundleError) as caught:
            bundle.read_bundle_directory(hostile)
        assert caught.value.code == "BUNDLE_LOCATION_INVALID"
    with pytest.raises(bundle.EvidenceBundleError) as missing:
        bundle.read_bundle_directory(tmp_path / "missing")
    assert missing.value.code == "BUNDLE_LOCATION_INVALID"
    nested = _write_bundle_dir(tmp_path / "nested", _files("A"))
    (nested / "attachments" / "nested-dir").mkdir()
    with pytest.raises(bundle.EvidenceBundleError) as unexpected_directory:
        bundle.read_bundle_directory(nested)
    assert unexpected_directory.value.code == "BUNDLE_LOCATION_INVALID"
    renamed = tmp_path / "renamed"
    renamed.mkdir()
    (tmp_path / "good" / good.name).rename(renamed / "other-name")
    with pytest.raises(bundle.EvidenceBundleError) as wrong_id:
        bundle.read_bundle_directory((renamed / "other-name").resolve())
    assert (wrong_id.value.code, wrong_id.value.detail) == ("BUNDLE_LOCATION_INVALID", "BUNDLE_ID")
    sized = _write_bundle_dir(tmp_path / "sized", _files("A"))
    monkeypatch.setattr(bundle, "MAX_TOTAL_BYTES", 1000)
    with pytest.raises(bundle.EvidenceBundleError) as total:
        bundle.read_bundle_directory(sized)
    assert (total.value.code, total.value.detail) == ("BUNDLE_MALFORMED", "TOTAL_SIZE")
    monkeypatch.undo()
    monkeypatch.setattr(bundle, "MAX_FILE_BYTES", 10)
    with pytest.raises(bundle.EvidenceBundleError) as oversized:
        bundle.read_bundle_directory(sized)
    assert oversized.value.code == "BUNDLE_LOCATION_INVALID"


def test_layer_e_directory_reader_reports_integrity_faults_as_typed_errors(tmp_path):
    corrupted = dict(_files("A"))
    corrupted[EVIDENCE_PATH] = _flip_byte(corrupted[EVIDENCE_PATH])
    root = _write_bundle_dir(tmp_path, corrupted)
    with pytest.raises(bundle.EvidenceBundleError) as caught:
        bundle.read_bundle_directory(root)
    assert caught.value.code == "MANIFEST_MISMATCH"


def _zip_bytes(files: object, root: str, *, duplicate: bool = False, traversal: bool = False) -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, payload in files.items():
            archive.writestr(f"{root}/{path}", payload)
        if duplicate:
            archive.writestr(f"{root}/evidence.json", files["evidence.json"])
        if traversal:
            archive.writestr(f"{root}/../escape", b"x")
    return stream.getvalue()


def test_zip_reader_supports_memory_and_rejects_traversal_duplicate_and_bad_root():
    files = _golden_a()
    root = "candidate-funnel-evidence-900000001-1"
    assert bundle.read_bundle_zip(_zip_bytes(files, root)) == files
    for payload in (
        _zip_bytes(files, root, duplicate=True),
        _zip_bytes(files, root, traversal=True),
        _zip_bytes(files, "wrong-root"),
        b"not a zip",
    ):
        with pytest.raises(bundle.EvidenceBundleError):
            bundle.read_bundle_zip(payload)


def test_layer_e_zip_reader_typed_codes_paths_and_limits(tmp_path, monkeypatch):
    files = _files("A")
    root = GOLDEN_A_ID
    archive_path = tmp_path / "bundle.zip"
    archive_path.write_bytes(_zip_bytes(files, root))
    assert bundle.read_bundle_zip(archive_path.resolve()) == _golden_a()
    assert bundle.read_bundle_zip(io.BytesIO(_zip_bytes(files, root))) == _golden_a()
    assert bundle.read_bundle_zip(bytearray(_zip_bytes(files, root))) == _golden_a()
    for hostile in (Path("relative.zip"), tmp_path / ".." / "bundle.zip"):
        with pytest.raises(bundle.EvidenceBundleError) as caught:
            bundle.read_bundle_zip(hostile)
        assert caught.value.code == "BUNDLE_LOCATION_INVALID"
    with pytest.raises(bundle.EvidenceBundleError) as duplicate:
        bundle.read_bundle_zip(_zip_bytes(files, root, duplicate=True))
    assert (duplicate.value.code, duplicate.value.detail) == ("BUNDLE_LOCATION_INVALID", "DUPLICATE")
    with pytest.raises(bundle.EvidenceBundleError) as wrong_root:
        bundle.read_bundle_zip(_zip_bytes(files, "wrong-root"))
    assert (wrong_root.value.code, wrong_root.value.detail) == ("BUNDLE_LOCATION_INVALID", "BUNDLE_ID")
    with pytest.raises(bundle.EvidenceBundleError) as not_zip:
        bundle.read_bundle_zip(b"not a zip")
    assert (not_zip.value.code, not_zip.value.detail) == ("BUNDLE_MALFORMED", "ZIP")
    two_roots = io.BytesIO()
    with zipfile.ZipFile(two_roots, "w") as archive:
        for path, payload in files.items():
            archive.writestr(f"{root}/{path}", payload)
        archive.writestr("other-root/extra.txt", b"x")
    with pytest.raises(bundle.EvidenceBundleError) as roots:
        bundle.read_bundle_zip(two_roots.getvalue())
    assert (roots.value.code, roots.value.detail) == ("BUNDLE_LOCATION_INVALID", "ZIP_ROOT")
    symlink = io.BytesIO()
    with zipfile.ZipFile(symlink, "w") as archive:
        for path, payload in files.items():
            archive.writestr(f"{root}/{path}", payload)
        link = zipfile.ZipInfo(f"{root}/attachments/link")
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(link, b"evidence.json")
    with pytest.raises(bundle.EvidenceBundleError) as link_error:
        bundle.read_bundle_zip(symlink.getvalue())
    assert link_error.value.code == "BUNDLE_LOCATION_INVALID"
    many = io.BytesIO()
    with zipfile.ZipFile(many, "w") as archive:
        for path, payload in files.items():
            archive.writestr(f"{root}/{path}", payload)
        for index in range(8):
            archive.writestr(f"{root}/attachments/extra-{index}.json", b"{}")
    with pytest.raises(bundle.EvidenceBundleError) as too_many:
        bundle.read_bundle_zip(many.getvalue())
    assert too_many.value.code == "MANIFEST_MISMATCH"
    monkeypatch.setattr(bundle, "MAX_TOTAL_BYTES", 1000)
    with pytest.raises(bundle.EvidenceBundleError) as total:
        bundle.read_bundle_zip(_zip_bytes(files, root))
    assert (total.value.code, total.value.detail) == ("BUNDLE_MALFORMED", "TOTAL_SIZE")
    monkeypatch.undo()
    monkeypatch.setattr(bundle, "MAX_FILE_BYTES", 10)
    with pytest.raises(bundle.EvidenceBundleError) as member:
        bundle.read_bundle_zip(_zip_bytes(files, root))
    assert (member.value.code, member.value.detail) == ("BUNDLE_MALFORMED", "FILE_SIZE")


# --------------------------------------------------------------------------
# Layer E: --source-repo (local temporary git repository only; no network).
# --------------------------------------------------------------------------


def _git_env(home: Path) -> dict[str, str]:
    return {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(home),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
    }


def _git(repo: Path, *arguments: str) -> str:
    completed = subprocess.run(
        [
            "git", "-C", str(repo),
            "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid",
            "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false",
            *arguments,
        ],
        check=True,
        capture_output=True,
        text=True,
        env=_git_env(repo),
    )
    return completed.stdout.strip()


def _module_blob(path: str) -> bytes:
    return f"# synthetic module {path}\n".encode()


def _local_source_repo(tmp_path: Path):
    """Create a local git repo committing every producer/consumer module path."""
    repo = tmp_path / "source-repo"
    repo.mkdir()
    paths = sorted(set(FIXED_MODULE_PATHS) | set(bundle.CONSUMER_MODULE_PATHS))
    for path in paths:
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(_module_blob(path))
    _git(repo, "init", "-q")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "synthetic source identity")
    commit = _git(repo, "rev-parse", "HEAD")
    if len(commit) != 40:
        pytest.skip("repository object format is not SHA-1")
    digests = {path: _sha(_module_blob(path)) for path in paths}
    return repo.resolve(), commit, digests


def _source_bound_bundle(commit: str, digests, *, producer=None, consumer=None):
    return _make_bundle(
        "900000021", terminal="BATCH_READY", p14_status="PASS", dropped=0,
        executed_sha=commit,
        producer_digests=producer if producer is not None else {p: digests[p] for p in FIXED_MODULE_PATHS},
        consumer_digests=consumer if consumer is not None else {p: digests[p] for p in bundle.CONSUMER_MODULE_PATHS},
    )[0]


def test_layer_e_source_repo_positive_case_with_committed_module_identity(tmp_path, capsys, monkeypatch):
    repo, commit, digests = _local_source_repo(tmp_path)
    built = _source_bound_bundle(commit, digests)
    report = bundle.verify_bundle_files(built, source_repo=repo)
    assert (report.bundle_integrity, report.capture_validity, report.errors) == ("PASS", "VALID", ())
    # Without --source-repo no git process is ever started.
    def no_subprocess(*_args, **_kwargs):
        raise AssertionError("git must only run for an explicit --source-repo")
    monkeypatch.setattr(
        bundle, "subprocess",
        types.SimpleNamespace(run=no_subprocess, SubprocessError=subprocess.SubprocessError),
    )
    _expect_pass(built, terminal="BATCH_READY", artifact=True)
    monkeypatch.undo()
    directory = _write_bundle_dir(tmp_path / "bundle", built)
    assert bundle.main(["verify", str(directory), "--source-repo", str(repo)]) == 0
    printed = json.loads(capsys.readouterr().out)
    assert (printed["bundleIntegrity"], printed["captureValidity"], printed["errors"]) == ("PASS", "VALID", [])
    completed = _run_python(
        ["-m", "data.p14_run_evidence_bundle", "verify", str(directory), "--source-repo", str(repo)]
    )
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout)["bundleIntegrity"] == "PASS"


def test_layer_e_source_repo_mismatch_and_hostile_locations_fail_closed(tmp_path, capsys):
    repo, commit, digests = _local_source_repo(tmp_path)
    producer_path = "data/candidate_funnel_batch.py"
    consumer_path = "data/p14_handoff.py"
    wrong = "f" * 64
    producer_bad = _source_bound_bundle(
        commit, digests, producer={**{p: digests[p] for p in FIXED_MODULE_PATHS}, producer_path: wrong}
    )
    _expect_fault(producer_bad, "SOURCE_IDENTITY_MISMATCH", source_repo=repo)
    consumer_bad = _source_bound_bundle(
        commit, digests, consumer={**{p: digests[p] for p in bundle.CONSUMER_MODULE_PATHS}, consumer_path: wrong}
    )
    _expect_fault(consumer_bad, "SOURCE_IDENTITY_MISMATCH", source_repo=repo)
    good = _source_bound_bundle(commit, digests)
    other = tmp_path / "other-repo"
    other.mkdir()
    _git(other, "init", "-q")
    (other / "unrelated.txt").write_text("unrelated\n")
    _git(other, "add", "-A")
    _git(other, "commit", "-q", "-m", "unrelated history")
    _expect_fault(good, "SOURCE_IDENTITY_MISMATCH", source_repo=other.resolve())
    link = tmp_path / "linked-repo"
    link.symlink_to(repo)
    _expect_fault(good, "SOURCE_IDENTITY_MISMATCH", source_repo=link)
    _expect_fault(good, "SOURCE_IDENTITY_MISMATCH", source_repo=Path("relative-repo"))
    _expect_fault(good, "SOURCE_IDENTITY_MISMATCH", source_repo=repo / ".." / repo.name)
    directory = _write_bundle_dir(tmp_path / "cli", producer_bad)
    assert bundle.main(["verify", str(directory), "--source-repo", str(repo)]) == 1
    printed = json.loads(capsys.readouterr().out)
    assert printed["errors"] == [{"code": "SOURCE_IDENTITY_MISMATCH", "detail": None}]
    assert bundle.main(["verify", str(directory), "--source-repo", "../escape"]) == 1
    assert json.loads(capsys.readouterr().out)["errors"][0]["code"] == "SOURCE_IDENTITY_MISMATCH"


def test_source_identity_mismatch_fails_closed(tmp_path):
    source = tmp_path / "repo"
    source.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=source, check=True, env=_git_env(tmp_path), capture_output=True)
    report = bundle.verify_bundle_files(_golden_a(), source_repo=source.resolve())
    assert report.errors[0].code == "SOURCE_IDENTITY_MISMATCH"


# --------------------------------------------------------------------------
# CLI (offline verification-only entrypoint).
# --------------------------------------------------------------------------


def test_layer_e_cli_exit_codes_report_bytes_and_relative_paths(tmp_path, capsys, monkeypatch):
    good = _write_bundle_dir(tmp_path / "good", _files("A"))
    assert bundle.main(["verify", str(good)]) == 0
    out = capsys.readouterr().out
    report = json.loads(out)
    assert out.encode() == handoff.canonical_json_bytes(report) + b"\n"
    assert report == {
        "route": "SCHEMA3_RUN_EVIDENCE", "bundleIntegrity": "PASS", "captureValidity": "VALID",
        "terminalStatus": "BATCH_READY", "artifactAvailable": True, "errors": [],
    }
    monkeypatch.chdir(good.parent)
    assert bundle.main(["verify", good.name]) == 0
    assert json.loads(capsys.readouterr().out)["bundleIntegrity"] == "PASS"
    monkeypatch.undo()
    invalid = _write_bundle_dir(tmp_path / "invalid", _invalid_files())
    assert bundle.main(["verify", str(invalid)]) == 0
    printed = json.loads(capsys.readouterr().out)
    assert (printed["bundleIntegrity"], printed["captureValidity"], printed["terminalStatus"], printed["artifactAvailable"]) == ("PASS", "INVALID", None, None)
    corrupted = dict(_files("A"))
    corrupted[DIAGNOSTICS_PATH] = _flip_byte(corrupted[DIAGNOSTICS_PATH])
    bad = _write_bundle_dir(tmp_path / "bad", corrupted)
    assert bundle.main(["verify", str(bad)]) == 1
    failed = json.loads(capsys.readouterr().out)
    assert failed["bundleIntegrity"] == "FAIL" and failed["errors"] == [{"code": "MANIFEST_MISMATCH", "detail": None}]
    assert bundle.main(["verify", "../escape"]) == 1
    assert json.loads(capsys.readouterr().out)["errors"][0]["code"] == "BUNDLE_LOCATION_INVALID"
    assert bundle.main(["verify", str(tmp_path / "does-not-exist")]) == 1
    assert json.loads(capsys.readouterr().out)["errors"][0]["code"] == "BUNDLE_LOCATION_INVALID"
    with pytest.raises(SystemExit) as usage:
        bundle.main([])
    assert usage.value.code == 2
    capsys.readouterr()


def test_layer_e_cli_zip_target_and_legacy_labelled_bundles_are_never_accepted(tmp_path, capsys):
    archive = tmp_path / "bundle.zip"
    archive.write_bytes(_zip_bytes(_files("B"), GOLDEN_B_ID))
    assert bundle.main(["verify", str(archive)]) == 0
    printed = json.loads(capsys.readouterr().out)
    assert (printed["terminalStatus"], printed["artifactAvailable"]) == ("QUALITY_GATE_FAILED", False)
    for legacy in ("candidate-funnel-run-evidence-1", "candidate-funnel-run-evidence-2"):
        relabelled = _manifest_edit(_files("A"), lambda m, s=legacy: m.update(schemaVersion=s))
        directory = _write_bundle_dir(tmp_path / legacy, relabelled)
        assert bundle.main(["verify", str(directory)]) == 1
        result = json.loads(capsys.readouterr().out)
        assert result["bundleIntegrity"] == "FAIL"
        assert result["captureValidity"] == "N/A"


# --------------------------------------------------------------------------
# Layer F / M: legacy compatibility boundary and unknown-schema routing.
#
# Phase III-B does NOT verify, retrofit or replay schema-1/2 bundles.  These
# tests pin the routing / rejection boundary only.
# --------------------------------------------------------------------------


@pytest.mark.parametrize("legacy", ["candidate-funnel-run-evidence-1", "candidate-funnel-run-evidence-2"])
def test_layer_f_legacy_labelled_manifest_routes_out_and_is_never_accepted(legacy):
    # Case A: a schema-3-shaped manifest relabelled legacy.  Routing semantics only; the
    # faithful legacy shape (Case B) is pinned by the actual-legacy-shaped test below.
    relabelled = _manifest_edit(_files("A"), lambda manifest: manifest.update(schemaVersion=legacy))
    report = bundle.verify_bundle_files(relabelled)
    assert (report.route, report.bundle_integrity, report.capture_validity) == ("LEGACY_RUN_EVIDENCE", "FAIL", "N/A")
    assert (report.terminal_status, report.artifact_available, report.errors) == (None, None, ())
    # The manifest digest still gates the route: a stale marker never reaches dispatch.
    stale = {**relabelled, MANIFEST_DIGEST_PATH: b"0" * 64 + b"  manifest.json\n"}
    _expect_fault(stale, "MANIFEST_MISMATCH")
    # A schema-3 manifest that merely gains the legacy counters is NOT legacy:
    # exact-key validation still applies to it.
    schema_3_extra = _manifest_edit(_files("A"), lambda manifest: manifest.update(fileCount=8, totalBytes=1))
    _expect_fault(schema_3_extra, "BUNDLE_UNKNOWN_KEY", "MANIFEST")


LEGACY_FIXTURE_ID = "candidate-funnel-evidence-legacy-fixture"


def _legacy_json(value, *, canonical: bool) -> bytes:
    if canonical:
        return handoff.canonical_json_bytes(value)
    # The legacy writer: json.dumps(sort_keys=True, indent=2, ensure_ascii=False) + "\n".
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def _legacy_bundle(schema: str, *, canonical: bool) -> dict[str, bytes]:
    """A faithful schema-1/2 bundle shape (not derived from a schema-3 golden).

    Mirrors ``candidate_funnel_run_evidence.write_bundle``: manifest keys
    schemaVersion / bundleId / files / fileCount / totalBytes, self-hash marker
    over the manifest bytes, and legacy evidence / privacy documents.
    """
    content = {
        EVIDENCE_PATH: _legacy_json({"schemaVersion": schema, "bundleId": LEGACY_FIXTURE_ID}, canonical=canonical),
        PRIVACY_PATH: _legacy_json({"passed": True, "violations": []}, canonical=canonical),
    }
    records = [{"path": path, "sha256": _sha(payload), "bytes": len(payload)} for path, payload in sorted(content.items())]
    manifest = _legacy_json(
        {
            "schemaVersion": schema,
            "bundleId": LEGACY_FIXTURE_ID,
            "files": records,
            "fileCount": len(records),
            "totalBytes": sum(item["bytes"] for item in records),
        },
        canonical=canonical,
    )
    return {**content, MANIFEST_PATH: manifest, MANIFEST_DIGEST_PATH: _manifest_digest_line(manifest)}


@pytest.mark.parametrize("canonical", [False, True], ids=["legacy-writer-encoding", "canonical-encoding"])
@pytest.mark.parametrize("legacy", ["candidate-funnel-run-evidence-1", "candidate-funnel-run-evidence-2"])
def test_layer_f_actual_legacy_shaped_manifest_routes_out_without_schema_3_key_validation(legacy, canonical):
    files = _legacy_bundle(legacy, canonical=canonical)
    manifest = json.loads(files[MANIFEST_PATH])
    # The legacy-only keys are present exactly as the legacy writer emits them.
    assert set(manifest) == {"schemaVersion", "bundleId", "files", "fileCount", "totalBytes"}
    report = bundle.verify_bundle_files(files)
    assert (report.route, report.bundle_integrity, report.capture_validity) == ("LEGACY_RUN_EVIDENCE", "FAIL", "N/A")
    assert (report.terminal_status, report.artifact_available, report.errors) == (None, None, ())
    # Routing only: legacy content is never verified, so tampering with it is not detected here.
    tampered = {**files, EVIDENCE_PATH: files[EVIDENCE_PATH] + b" "}
    tampered_report = bundle.verify_bundle_files(tampered)
    assert (tampered_report.route, tampered_report.bundle_integrity, tampered_report.errors) == ("LEGACY_RUN_EVIDENCE", "FAIL", ())
    # The completion marker still gates the route.
    _expect_fault({**files, MANIFEST_DIGEST_PATH: b"0" * 64 + b"  manifest.json\n"}, "MANIFEST_MISMATCH")
    # The same manifest labelled schema-3 receives full schema-3 validation.
    relabelled = dict(files)
    payload = _legacy_json({**manifest, "schemaVersion": bundle.BUNDLE_SCHEMA_VERSION}, canonical=True)
    relabelled[MANIFEST_PATH] = payload
    relabelled[MANIFEST_DIGEST_PATH] = _manifest_digest_line(payload)
    _expect_fault(relabelled, "BUNDLE_UNKNOWN_KEY", "MANIFEST")


@pytest.mark.parametrize(
    "payload",
    [b"{", b"[]", b'{"schemaVersion":["candidate-funnel-run-evidence-1"]}', b'{"schemaVersion":1}', b'{"a":1,"a":2}'],
    ids=["syntax", "not-an-object", "container-schema", "scalar-schema", "duplicate-key"],
)
def test_layer_f_undecodable_or_unnamed_legacy_manifests_stay_on_the_schema_3_path(payload):
    files = _manifest_replaced(_files("A"), payload)
    report = bundle.verify_bundle_files(files)
    assert report.route == "SCHEMA3_RUN_EVIDENCE" and report.bundle_integrity == "FAIL"
    assert len(report.errors) == 1 and report.errors[0].code in {"BUNDLE_MALFORMED", "UNSUPPORTED_BUNDLE_SCHEMA"}


def test_layer_f_dispatch_policy_legacy_routes_are_unchanged():
    from data import p14_policy_dispatch as dispatch

    schema_1 = dispatch.dispatch_policy({"schemaVersion": "candidate-funnel-run-evidence-1"})
    assert (schema_1.route, schema_1.status, schema_1.reason) == (
        dispatch.SCHEMA_COMPATIBLE_NOT_REPLAYABLE, "COMPATIBLE", "SCHEMA_1_NOT_REPLAYABLE",
    )
    legacy = dispatch.dispatch_policy(
        {"schemaVersion": "candidate-funnel-run-evidence-2", "p14Parameters": dict(dispatch.LEGACY_PARAMETERS)}
    )
    assert (legacy.route, legacy.status, legacy.policy_version) == (dispatch.LEGACY_ROUTE, "SUPPORTED", None)
    v1 = dispatch.dispatch_policy(
        {"schemaVersion": "candidate-funnel-run-evidence-2", "p14Parameters": dict(dispatch.V1_PARAMETERS)}
    )
    assert (v1.route, v1.status, v1.policy_version) == (dispatch.V1_ROUTE, "SUPPORTED", POLICY)
    schema_3 = dispatch.dispatch_policy(json.loads(_files("A")[EVIDENCE_PATH]))
    assert (schema_3.route, schema_3.status, schema_3.reason) == (
        dispatch.UNSUPPORTED_ROUTE, "UNSUPPORTED", "UNSUPPORTED_EVIDENCE_SCHEMA",
    )


def test_layer_f_replay_and_reclassify_entrypoints_are_frozen_and_reject_schema_3():
    from data import candidate_funnel_run_evidence as legacy

    source = Path(legacy.__file__).read_text(encoding="utf-8")
    segments = {
        node.name: ast.get_source_segment(source, node)
        for node in ast.parse(source).body
        if isinstance(node, ast.FunctionDef) and node.name in {"replay_p14", "reclassify_p14"}
    }
    assert hashlib.sha256(segments["replay_p14"].encode("utf-8")).hexdigest() == LEGACY_REPLAY_P14_SEGMENT_SHA256
    assert hashlib.sha256(segments["reclassify_p14"].encode("utf-8")).hexdigest() == LEGACY_RECLASSIFY_P14_SEGMENT_SHA256
    schema_3_evidence = json.loads(_files("A")[EVIDENCE_PATH])
    replayed = legacy.replay_p14(schema_3_evidence)
    assert replayed["passed"] is False and replayed["compatible"] is False
    assert "unsupported evidence schema" in replayed["errors"]
    with pytest.raises(legacy.ReclassificationError):
        legacy.reclassify_p14(schema_3_evidence)


@pytest.mark.parametrize("value", ["", 3, None, True, 1.5, "candidate-funnel-run-evidence-4", "candidate-funnel-run-evidence-30"])
def test_layer_m_manifest_schema_scalars_are_unsupported(value):
    changed = _manifest_edit(_files("A"), lambda manifest: manifest.update(schemaVersion=value))
    _expect_fault(changed, "UNSUPPORTED_BUNDLE_SCHEMA")


@pytest.mark.parametrize("value", [["candidate-funnel-run-evidence-3"], {"schemaVersion": "candidate-funnel-run-evidence-3"}])
def test_layer_m_manifest_schema_containers_fail_closed_with_a_typed_error(value):
    changed = _manifest_edit(_files("A"), lambda manifest: manifest.update(schemaVersion=value))
    report = bundle.verify_bundle_files(changed)
    assert report.bundle_integrity == "FAIL" and len(report.errors) == 1
    assert report.errors[0].code in {"UNSUPPORTED_BUNDLE_SCHEMA", "BUNDLE_MALFORMED"}


@pytest.mark.parametrize(
    "value",
    ["", 3, None, True, [], {}, "candidate-funnel-run-evidence-4", "candidate-funnel-run-evidence-2", "candidate-funnel-run-evidence-1"],
)
def test_layer_m_evidence_schema_values_including_legacy_relabel_are_unsupported(value):
    _expect_fault(_evidence_fault("A", lambda v: v.update(schemaVersion=value)), "UNSUPPORTED_BUNDLE_SCHEMA")
    _expect_fault(_evidence_fault("B", lambda v: v.update(schemaVersion=value)), "UNSUPPORTED_BUNDLE_SCHEMA")


def test_layer_m_manifest_and_evidence_schema_disagreement_is_not_accepted():
    only_manifest = _manifest_edit(_files("A"), lambda m: m.update(schemaVersion="candidate-funnel-run-evidence-4"))
    _expect_fault(only_manifest, "UNSUPPORTED_BUNDLE_SCHEMA")
    only_evidence = _evidence_fault("A", lambda v: v.update(schemaVersion="candidate-funnel-run-evidence-2"))
    _expect_fault(only_evidence, "UNSUPPORTED_BUNDLE_SCHEMA")


def test_layer_m_attachment_schema_literals_are_admission_faults():
    _expect_fault(_retie_json(_files("A"), "observation", lambda v: v.update(schemaVersion="p14-canonical-observation-9")), "UNSUPPORTED_OBSERVATION_SCHEMA")
    _expect_fault(_retie_json(_files("A"), "capture", lambda v: v.update(schemaVersion="p14-capture-input-9")), "UNSUPPORTED_CAPTURE_INPUT_SCHEMA")
    _expect_fault(_retie_json(_files("A"), "receipt", lambda v: v.update(schemaVersion="p14-handoff-receipt-9")), "UNSUPPORTED_RECEIPT_SCHEMA")
    _expect_fault(_retie_json(_files("A"), "envelope", lambda v: v.update(schemaVersion="p14-handoff-9")), "UNSUPPORTED_HANDOFF_SCHEMA")


# --------------------------------------------------------------------------
# Existing V1-V6 typed integrity faults (kept) and evidence/attachment faults.
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "mutate,code",
    [
        (lambda files: {**files, "evidence.json": files["evidence.json"][:-1] + b" "}, "MANIFEST_MISMATCH"),
        (lambda files: {**files, "manifest.sha256": b"0" * 64 + b"  manifest.json\n"}, "MANIFEST_MISMATCH"),
        (lambda files: {path: payload for path, payload in files.items() if path != "manifest.sha256"}, "BUNDLE_INCOMPLETE"),
        (lambda files: {**files, "extra.json": b"{}"}, "MANIFEST_MISMATCH"),
        (lambda files: {**files, "evidence.json": b"\xff"}, "MANIFEST_MISMATCH"),
    ],
)
def test_v1_v6_integrity_faults_are_typed(mutate, code):
    report = bundle.verify_bundle_files(mutate(dict(_golden_a())))
    assert report.bundle_integrity == "FAIL"
    assert report.errors[0].code == code


def test_co_tampered_attachment_digest_still_fails_admission():
    files = dict(_golden_a())
    observation_path = next(path for path in files if path.startswith("attachments/observation-"))
    files[observation_path] = files[observation_path][:-1] + b" "
    evidence = json.loads(files["evidence.json"])
    evidence["attachments"]["observation"]["sha256"] = _sha(files[observation_path])
    evidence["attachments"]["observation"]["bytes"] = len(files[observation_path])
    files["evidence.json"] = handoff.canonical_json_bytes(evidence)
    files = _reseal(files)
    assert bundle.verify_bundle_files(files).errors[0].code == "OBSERVATION_DIGEST_MISMATCH"


def test_attachment_record_mismatch_and_evidence_unknown_key_are_distinct():
    files = dict(_golden_a())
    attachment = _replace_json(
        files, "evidence.json",
        lambda value: value["attachments"]["captureInput"].update(sha256="0" * 64),
    )
    attachment = _reseal(attachment)
    assert bundle.verify_bundle_files(attachment).errors[0].code == "ATTACHMENT_DIGEST_MISMATCH"
    unknown = _replace_json(files, "evidence.json", lambda value: value.update(arbitraryUnknownKey=True))
    unknown = _reseal(unknown)
    assert bundle.verify_bundle_files(unknown).errors[0].code == "BUNDLE_UNKNOWN_KEY"


def test_unknown_schema_unknown_key_malformed_type_and_oversize_fail_closed():
    files = dict(_golden_a())
    unknown = _replace_json(files, "manifest.json", lambda value: value.update(schemaVersion="candidate-funnel-run-evidence-4"))
    unknown["manifest.sha256"] = f"{_sha(unknown['manifest.json'])}  manifest.json\n".encode()
    assert bundle.verify_bundle_files(unknown).errors[0].code == "UNSUPPORTED_BUNDLE_SCHEMA"
    extra = _replace_json(files, "manifest.json", lambda value: value.update(arbitraryUnknownKey=True))
    extra["manifest.sha256"] = f"{_sha(extra['manifest.json'])}  manifest.json\n".encode()
    assert bundle.verify_bundle_files(extra).errors[0].code == "BUNDLE_UNKNOWN_KEY"
    malformed = _replace_json(files, "evidence.json", lambda value: value.update(captureStatus=1))
    malformed = _reseal(malformed)
    assert bundle.verify_bundle_files(malformed).errors[0].code == "BUNDLE_MALFORMED"
    oversized = dict(files)
    oversized["evidence.json"] = b"0" * (bundle.MAX_FILE_BYTES + 1)
    assert bundle.verify_bundle_files(oversized).errors[0].code == "BUNDLE_MALFORMED"


def test_unknown_and_forbidden_terminal_domains_preserve_handoff_precedence():
    files = dict(_golden_a())
    unknown = _retie_receipt(files, lambda receipt: receipt.update(terminalStatus="UNKNOWN_TERMINAL"))
    unknown_report = bundle.verify_bundle_files(unknown)
    assert (unknown_report.errors[0].code, unknown_report.errors[0].detail) == ("HANDOFF_MALFORMED", "TYPE")
    non_ready = _retie_receipt(
        files,
        lambda receipt: receipt.update(transportStatus="HANDOFF_WRITE_FAILED", failureCode="HANDOFF_WRITE_FAILED"),
    )
    non_ready_report = bundle.verify_bundle_files(non_ready)
    assert (non_ready_report.errors[0].code, non_ready_report.errors[0].detail) == ("BATCH_RECEIPT_INVALID", "TRANSPORT_STATUS")
    forbidden = _retie_receipt(
        files,
        lambda receipt: receipt.update(terminalStatus="BATCH_EXCEPTION", artifactAvailable=False),
    )
    forbidden_report = bundle.verify_bundle_files(forbidden)
    assert (forbidden_report.errors[0].code, forbidden_report.errors[0].detail) == ("BATCH_RECEIPT_INVALID", "REPORT_STATE")


def test_projection_workflow_diagnostics_and_privacy_failures_have_distinct_codes():
    files = dict(_golden_b())
    projection = _replace_json(files, "evidence.json", lambda value: value["terminal"].update(artifactAvailable=True))
    projection = _reseal(projection)
    assert bundle.verify_bundle_files(projection).errors[0].code == "RECEIPT_PROJECTION_MISMATCH"
    workflow = _replace_json(files, "evidence.json", lambda value: value["workflowStatus"].update(batchStatus="batch_passed"))
    workflow = _reseal(workflow)
    assert bundle.verify_bundle_files(workflow).errors[0].code == "WORKFLOW_STATUS_INCONSISTENT"
    derived = _replace_json(files, "evidence.json", lambda value: value["p14"].update(verdict="PASS"))
    derived = _reseal(derived)
    assert bundle.verify_bundle_files(derived).errors[0].code == "DERIVED_PROJECTION_MISMATCH"
    diagnostics = dict(files)
    diagnostics["p14-reference-diagnostics.json"] = diagnostics["p14-reference-diagnostics.json"][:-1] + b" "
    diagnostics = _reseal(diagnostics)
    assert bundle.verify_bundle_files(diagnostics).errors[0].code == "DIAGNOSTICS_MISMATCH"
    privacy = _replace_json(files, "evidence.json", lambda value: value["p14"]["release"].update(holdings=[]))
    privacy = _reseal(privacy)
    # A forbidden key inside the derived release is caught by the derived comparison first.
    assert bundle.verify_bundle_files(privacy).errors[0].code == "DERIVED_PROJECTION_MISMATCH"
    direct_privacy = _replace_json(files, "validation/privacy-report.json", lambda value: value.update(holdings=[]))
    direct_privacy = _reseal(direct_privacy)
    assert bundle.verify_bundle_files(direct_privacy).errors[0].code == "BUNDLE_PRIVACY_VIOLATION"


# --------------------------------------------------------------------------
# Layer G: ownership / aliasing.
# --------------------------------------------------------------------------


def test_ownership_and_detachment():
    built = _golden_a()
    decoded = json.loads(built["evidence.json"])
    decoded["terminal"]["terminalStatus"] = "SCHEMA_VIOLATIONS"
    assert json.loads(built["evidence.json"])["terminal"]["terminalStatus"] == "BATCH_READY"
    report = bundle.verify_bundle_files(built)
    value = report.to_value()
    value["errors"].append({"code": "MUTATED", "detail": None})
    assert bundle.verify_bundle_files(built).to_value()["errors"] == []
    with pytest.raises(FrozenInstanceError):
        report.bundle_integrity = "FAIL"


def test_layer_g_builder_inputs_are_not_aliased_into_the_bundle():
    _, parts, reference, expected = _case("A")
    reference_value = reference.to_value()
    workflow = bundle.WorkflowStatus("batch_passed", "smoke_passed")
    built = bundle.build_captured_bundle(parts, reference_value, expected, _consumer(), workflow)
    snapshot = dict(built)
    reference_value["runId"] = "900000099"
    reference_value["status"] = "PENDING"
    assert dict(built) == snapshot == dict(_case("A")[0])
    again = bundle.build_captured_bundle(parts, reference.to_value(), expected, _consumer(), workflow)
    assert dict(again) == snapshot
    failure = {"code": "HANDOFF_MISSING", "detail": "PRODUCER_REFERENCE_MISSING", "stage": "REFERENCE"}
    run_identity = _run_identity("900000013")
    invalid = bundle.build_invalid_bundle(failure, run_identity, _consumer(), bundle.WorkflowStatus("batch_failed", None))
    invalid_snapshot = dict(invalid)
    failure["code"] = "MUTATED"
    run_identity["runId"] = "1"
    assert dict(invalid) == invalid_snapshot == _invalid_files()


def test_layer_g_decoded_views_are_fresh_and_bundle_files_own_their_bytes():
    _, parts, _, _ = _case("A")
    for accessor in (parts.observation_value, parts.capture_input_value, parts.receipt_value, parts.envelope_value):
        first, second = accessor(), accessor()
        assert first is not second and first == second
        first["mutated"] = True
        assert accessor() == second and "mutated" not in accessor()
    source = {"attachments/x": b"1"}
    owned = bundle.BundleFiles(source)
    source["attachments/x"] = b"2"
    source["attachments/y"] = b"3"
    assert dict(owned) == {"attachments/x": b"1"}
    with pytest.raises(TypeError):
        owned.files["attachments/x"] = b"9"
    with pytest.raises(TypeError):
        bundle.BundleFiles({"attachments/x": bytearray(b"1")})
    with pytest.raises(TypeError):
        bundle.BundleFiles(["not", "a", "mapping"])


def test_layer_g_decoded_evidence_mutation_never_changes_attachment_bytes_or_digests():
    built = _files("A")
    before = dict(built)
    evidence = json.loads(built[EVIDENCE_PATH])
    evidence["attachments"]["receipt"]["sha256"] = "0" * 64
    evidence["p14"]["baseTop40"].clear()
    assert built == before
    assert bundle.verify_bundle_files(built).bundle_integrity == "PASS"
    assert all(_sha(built[path]) == GOLDEN_COMPONENT_SHA256[GOLDEN_A_ID][path] for path in built)


# --------------------------------------------------------------------------
# Layer H: install and partial-bundle failure injection.
# --------------------------------------------------------------------------


def test_installer_is_atomic_no_overwrite_and_marker_last(tmp_path, monkeypatch):
    out = tmp_path / "private"
    out.mkdir(mode=0o700)
    installed = bundle.install_bundle(out.resolve(), _golden_a())
    assert (installed / "manifest.sha256").is_file()
    with pytest.raises(bundle.EvidenceBundleError) as caught:
        bundle.install_bundle(out.resolve(), _golden_a())
    assert caught.value.code == "BUNDLE_ALREADY_EXISTS"
    failing_out = tmp_path / "failing"
    failing_out.mkdir(mode=0o700)
    original = bundle.install_file_no_overwrite
    calls = []

    def fail_on_evidence(directory, name, payload):
        calls.append(name)
        if name == "evidence.json":
            raise handoff.HandoffError("HANDOFF_WRITE_FAILED")
        original(directory, name, payload)

    monkeypatch.setattr(bundle, "install_file_no_overwrite", fail_on_evidence)
    with pytest.raises(bundle.EvidenceBundleError) as failed:
        bundle.install_bundle(failing_out.resolve(), _golden_a())
    assert failed.value.code == "BUNDLE_WRITE_FAILED"
    partial = failing_out / "candidate-funnel-evidence-900000001-1"
    assert not (partial / "manifest.sha256").exists()


def test_installer_fsync_and_link_failures_are_typed(tmp_path, monkeypatch):
    out = tmp_path / "fsync"
    out.mkdir(mode=0o700)
    monkeypatch.setattr(bundle.os, "fsync", lambda _fd: (_ for _ in ()).throw(OSError("synthetic")))
    with pytest.raises(bundle.EvidenceBundleError) as caught:
        bundle.install_bundle(out.resolve(), _golden_a())
    assert caught.value.code == "BUNDLE_WRITE_FAILED"
    monkeypatch.undo()
    link_out = tmp_path / "link"
    link_out.mkdir(mode=0o700)
    monkeypatch.setattr(bundle.os, "link", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("synthetic")))
    with pytest.raises(bundle.EvidenceBundleError) as link_failure:
        bundle.install_bundle(link_out.resolve(), _golden_a())
    assert link_failure.value.code == "BUNDLE_WRITE_FAILED"


@pytest.mark.parametrize("stage", range(9))
def test_layer_h_failure_at_each_install_stage_leaves_no_completion_marker(stage, tmp_path, monkeypatch):
    out = tmp_path / "private"
    out.mkdir(mode=0o700)
    original = bundle.install_file_no_overwrite
    calls: list[str] = []

    def fail_at_stage(directory, name, payload):
        calls.append(name)
        if len(calls) - 1 == stage:
            raise handoff.HandoffError("HANDOFF_WRITE_FAILED")
        original(directory, name, payload)

    monkeypatch.setattr(bundle, "install_file_no_overwrite", fail_at_stage)
    with pytest.raises(bundle.EvidenceBundleError) as failed:
        bundle.install_bundle(out.resolve(), _golden_a())
    assert (failed.value.code, failed.value.detail) == ("BUNDLE_WRITE_FAILED", "HANDOFF_WRITE_FAILED")
    assert len(calls) == stage + 1
    partial = (out / GOLDEN_A_ID).resolve()
    assert partial.is_dir()
    assert not (partial / "manifest.sha256").exists()
    with pytest.raises(bundle.EvidenceBundleError) as incomplete:
        bundle.read_bundle_directory(partial)
    assert incomplete.value.code == "BUNDLE_INCOMPLETE"
    assert bundle.verify_bundle_files(_disk_files(partial)).errors[0].code == "BUNDLE_INCOMPLETE"
    monkeypatch.undo()
    with pytest.raises(bundle.EvidenceBundleError) as again:
        bundle.install_bundle(out.resolve(), _golden_a())
    assert again.value.code == "BUNDLE_ALREADY_EXISTS"


@pytest.mark.parametrize("primitive", ["fsync", "link"])
def test_layer_h_os_primitive_failures_leave_an_incomplete_bundle(primitive, tmp_path, monkeypatch):
    out = tmp_path / "private"
    out.mkdir(mode=0o700)

    def boom(*_args, **_kwargs):
        raise OSError("synthetic")

    monkeypatch.setattr(bundle.os, primitive, boom)
    with pytest.raises(bundle.EvidenceBundleError) as failed:
        bundle.install_bundle(out.resolve(), _golden_a())
    assert failed.value.code == "BUNDLE_WRITE_FAILED"
    monkeypatch.undo()
    partial = (out / GOLDEN_A_ID).resolve()
    assert not (partial / "manifest.sha256").exists()
    with pytest.raises(bundle.EvidenceBundleError) as incomplete:
        bundle.read_bundle_directory(partial)
    assert incomplete.value.code == "BUNDLE_INCOMPLETE"
    with pytest.raises(bundle.EvidenceBundleError) as again:
        bundle.install_bundle(out.resolve(), _golden_a())
    assert again.value.code == "BUNDLE_ALREADY_EXISTS"


def test_layer_h_installer_location_rules_and_verify_before_write(tmp_path):
    files = _golden_a()
    inside = REPO / "tests" / "never-created-by-schema3-installer"
    for hostile in (inside, Path("relative-out"), tmp_path / ".." / "out"):
        with pytest.raises(bundle.EvidenceBundleError) as caught:
            bundle.install_bundle(hostile, files)
        assert caught.value.code == "BUNDLE_LOCATION_INVALID"
    assert not inside.exists()
    open_root = tmp_path / "open"
    open_root.mkdir()
    os.chmod(open_root, 0o755)
    with pytest.raises(bundle.EvidenceBundleError) as not_private:
        bundle.install_bundle(open_root.resolve(), files)
    assert not_private.value.code == "BUNDLE_LOCATION_INVALID"
    assert list(open_root.iterdir()) == []
    private_root = tmp_path / "private"
    private_root.mkdir(mode=0o700)
    corrupted = dict(files)
    corrupted[EVIDENCE_PATH] = _flip_byte(corrupted[EVIDENCE_PATH])
    with pytest.raises(bundle.EvidenceBundleError) as unverified:
        bundle.install_bundle(private_root.resolve(), corrupted)
    assert unverified.value.code == "MANIFEST_MISMATCH"
    assert list(private_root.iterdir()) == []


# --------------------------------------------------------------------------
# Layer I: recursive privacy injection matrix.
# --------------------------------------------------------------------------

_FORBIDDEN_KEY_SAMPLES = (
    "holdings", "account", "portfolio", "cash", "portfolioFit", "csv", "broker",
    "officialDecision", "action", "amount",
)


def _privacy_injections():
    for key in _FORBIDDEN_KEY_SAMPLES:
        yield f"key-{key}", {key: []}
    yield "value-token", {"note": SECRET_TOKEN}
    yield "value-pat", {"note": SECRET_PAT}
    yield "value-users-path", {"note": PRIVATE_USERS_PATH}
    yield "value-home-path", {"note": PRIVATE_HOME_PATH}
    yield "key-is-token", {SECRET_TOKEN: True}
    yield "environment-dump", {"environ": {"HOME": PRIVATE_HOME_PATH, "GITHUB_TOKEN": SECRET_TOKEN}}


_PRIVACY_LOCATIONS = {
    "root": lambda report, extra: report.update(copy.deepcopy(extra)),
    "files-element": lambda report, extra: report["files"].append(copy.deepcopy(extra)),
    "deep-list": lambda report, extra: report["files"].append([[{"level": [copy.deepcopy(extra)]}]]),
    "deep-dict": lambda report, extra: report.update({"level1": {"level2": {"level3": [copy.deepcopy(extra)]}}}),
}


def _privacy_base(kind: str) -> dict[str, bytes]:
    return _invalid_files() if kind == "invalid" else _files(kind)


@pytest.mark.parametrize("location", sorted(_PRIVACY_LOCATIONS))
@pytest.mark.parametrize("label,extra", list(_privacy_injections()), ids=[item[0] for item in _privacy_injections()])
@pytest.mark.parametrize("kind", ["A", "B", "invalid"])
def test_layer_i_privacy_report_recursive_injection_is_a_bundle_privacy_violation(kind, label, extra, location):
    files = _privacy_base(kind)
    changed = _reseal(_replace_json(files, PRIVACY_PATH, lambda report: _PRIVACY_LOCATIONS[location](report, extra)))
    report = _expect_fault(changed, "BUNDLE_PRIVACY_VIOLATION")
    text = json.dumps(report.to_value())
    for leaked in (SECRET_TOKEN, SECRET_PAT, PRIVATE_USERS_PATH, PRIVATE_HOME_PATH, "level3"):
        assert leaked not in text


@pytest.mark.parametrize("key", ["positions", "secret", "arbitraryUnknownKey", "environ"])
def test_layer_i_unlisted_keys_never_pass_the_closed_privacy_report_schema(key):
    files = _files("A")
    root = _reseal(_replace_json(files, PRIVACY_PATH, lambda report: report.update({key: {"LANG": "C.UTF-8"}})))
    if key in handoff.FORBIDDEN_KEYS:
        _expect_fault(root, "BUNDLE_PRIVACY_VIOLATION")
    else:
        _expect_fault(root, "BUNDLE_UNKNOWN_KEY", "PRIVACY_REPORT")
    nested = _reseal(_replace_json(files, PRIVACY_PATH, lambda report: report["files"].append({key: 1})))
    _expect_fault(nested, "BUNDLE_PRIVACY_VIOLATION")


_CLOSED_KEYS = ("holdings", "account", "positions", "cash", "portfolio", "arbitraryUnknownKey")


def _closed_location_cases():
    def evidence(mutate):
        return lambda key: _evidence_fault("A", lambda value: mutate(value, key))

    def manifest_record(key):
        return _manifest_edit(_files("A"), lambda m: m["files"][0].update({key: 1}))

    def invalid_evidence(mutate):
        return lambda key: _reseal(_replace_json(_invalid_files(), EVIDENCE_PATH, lambda value: mutate(value, key)))

    return [
        ("evidence-root", evidence(lambda v, k: v.update({k: 1})), "BUNDLE_UNKNOWN_KEY", "EVIDENCE"),
        ("terminal", evidence(lambda v, k: v["terminal"].update({k: 1})), "BUNDLE_UNKNOWN_KEY", "TERMINAL"),
        ("p14-root", evidence(lambda v, k: v["p14"].update({k: 1})), "BUNDLE_UNKNOWN_KEY", "P14"),
        ("p14-release", evidence(lambda v, k: v["p14"]["release"].update({k: 1})), "DERIVED_PROJECTION_MISMATCH", None),
        ("replay-row", evidence(lambda v, k: v["replay"]["baseFullOrderedRankVector"][0].update({k: 1})), "DERIVED_PROJECTION_MISMATCH", None),
        ("confidence-invariant", evidence(lambda v, k: v["confidenceInvariant"].update({k: 1})), "DERIVED_PROJECTION_MISMATCH", None),
        ("expected-raw-files", evidence(lambda v, k: v["expectedBinding"]["rawFiles"][0].update({k: 1})), "BUNDLE_UNKNOWN_KEY", "EXPECTED_RAW"),
        ("expected-modules", evidence(lambda v, k: v["expectedBinding"]["modules"][0].update({k: 1})), "BUNDLE_UNKNOWN_KEY", "EXPECTED_MODULE"),
        ("expected-root", evidence(lambda v, k: v["expectedBinding"].update({k: 1})), "BUNDLE_UNKNOWN_KEY", "EXPECTED_BINDING"),
        ("consumer-modules", evidence(lambda v, k: v["consumerIdentity"]["modules"][0].update({k: 1})), "BUNDLE_UNKNOWN_KEY", "CONSUMER_MODULE"),
        ("consumer-root", evidence(lambda v, k: v["consumerIdentity"].update({k: 1})), "BUNDLE_UNKNOWN_KEY", "CONSUMER_IDENTITY"),
        ("workflow-status", evidence(lambda v, k: v["workflowStatus"].update({k: 1})), "BUNDLE_UNKNOWN_KEY", "WORKFLOW_STATUS"),
        ("producer-reference", evidence(lambda v, k: v["producerReference"].update({k: 1})), "BUNDLE_UNKNOWN_KEY", "PRODUCER_REFERENCE"),
        ("attachment-record", evidence(lambda v, k: v["attachments"]["receipt"].update({k: 1})), "BUNDLE_UNKNOWN_KEY", "ATTACHMENT"),
        ("diagnostics-record", evidence(lambda v, k: v["diagnostics"].update({k: 1})), "BUNDLE_UNKNOWN_KEY", "DIAGNOSTICS"),
        ("run-identity", evidence(lambda v, k: v["runIdentity"].update({k: 1})), "RUN_IDENTITY_MISMATCH", None),
        ("manifest-files-element", manifest_record, "BUNDLE_UNKNOWN_KEY", "MANIFEST_RECORD"),
        ("invalid-failure", invalid_evidence(lambda v, k: v["failure"].update({k: 1})), "BUNDLE_UNKNOWN_KEY", "FAILURE"),
        ("invalid-run-identity", invalid_evidence(lambda v, k: v["runIdentity"].update({k: 1})), "BUNDLE_UNKNOWN_KEY", "RUN_IDENTITY"),
        ("invalid-consumer-modules", invalid_evidence(lambda v, k: v["consumerIdentity"]["modules"][0].update({k: 1})), "BUNDLE_UNKNOWN_KEY", "CONSUMER_MODULE"),
        ("invalid-evidence-root", invalid_evidence(lambda v, k: v.update({k: 1})), "BUNDLE_UNKNOWN_KEY", "EVIDENCE"),
    ]


@pytest.mark.parametrize("key", _CLOSED_KEYS)
@pytest.mark.parametrize("index", range(len(_closed_location_cases())))
def test_layer_i_closed_schema_locations_reject_injected_keys_without_echoing_them(index, key):
    label, build, code, detail = _closed_location_cases()[index]
    report = _expect_fault(build(key), code, detail)
    assert key not in json.dumps(report.to_value()), label


@pytest.mark.parametrize("target", _ATTACHMENT_KEYWORDS)
@pytest.mark.parametrize("location", ["root", "nested"])
@pytest.mark.parametrize("label,extra", list(_privacy_injections()), ids=[item[0] for item in _privacy_injections()])
def test_layer_i_attachment_injection_is_a_handoff_privacy_violation(label, extra, location, target):
    nested_holders = {
        "observation": lambda value: value["base"]["candidates"][0],
        "capture": lambda value: value["joinedCandidateInput"][0],
        "receipt": lambda value: value["report"]["qualityGate"]["gates"][0],
        "envelope": lambda value: value["observation"],
    }

    def inject(value):
        holder = value if location == "root" else nested_holders[target](value)
        holder.update(copy.deepcopy(extra))

    changed = _retie_json(_files("A"), target, inject)
    report = _expect_fault(changed, "HANDOFF_PRIVACY_VIOLATION")
    text = json.dumps(report.to_value())
    assert SECRET_TOKEN not in text and PRIVATE_HOME_PATH not in text


@pytest.mark.parametrize(
    "field,value",
    [("repository", SECRET_TOKEN), ("event", PRIVATE_USERS_PATH), ("gitRef", PRIVATE_HOME_PATH), ("workflow", SECRET_PAT)],
)
def test_layer_i_invalid_bundle_run_identity_values_are_privacy_violations(field, value):
    changed = _reseal(_replace_json(_invalid_files(), EVIDENCE_PATH, lambda v: v["runIdentity"].update({field: value})))
    _expect_fault(changed, "BUNDLE_PRIVACY_VIOLATION")
    identity = _run_identity("900000013")
    identity[field] = value
    with pytest.raises(bundle.EvidenceBundleError) as builder:
        bundle.build_invalid_bundle(
            {"code": "HANDOFF_MISSING", "detail": None, "stage": "REFERENCE"},
            identity, _consumer(), bundle.WorkflowStatus("batch_failed", None),
        )
    assert builder.value.code == "BUNDLE_PRIVACY_VIOLATION"
    assert value not in str(builder.value)


@pytest.mark.parametrize("key", ["holdings", "account", "arbitraryUnknownKey"])
def test_layer_i_builder_rejects_unknown_keys_in_failure_and_run_identity(key):
    with pytest.raises(bundle.EvidenceBundleError) as failure:
        bundle.build_invalid_bundle(
            {"code": "HANDOFF_MISSING", "detail": None, "stage": "REFERENCE", key: 1},
            None, None, bundle.WorkflowStatus(None, None),
        )
    assert (failure.value.code, failure.value.detail) == ("BUNDLE_UNKNOWN_KEY", "FAILURE")
    identity = _run_identity("900000013")
    identity[key] = 1
    with pytest.raises(bundle.EvidenceBundleError) as run:
        bundle.build_invalid_bundle(
            {"code": "HANDOFF_MISSING", "detail": None, "stage": "REFERENCE"},
            identity, None, bundle.WorkflowStatus(None, None),
        )
    assert (run.value.code, run.value.detail) == ("BUNDLE_UNKNOWN_KEY", "RUN_IDENTITY")


def test_layer_i_schema3_key_vocabulary_never_intersects_forbidden_keys():
    for name in (
        "_CAPTURED_EVIDENCE_KEYS", "_INVALID_EVIDENCE_KEYS", "_MANIFEST_KEYS", "_FILE_RECORD_KEYS",
        "_PRIVACY_KEYS", "_REFERENCE_KEYS", "_EXPECTED_KEYS", "_CONSUMER_KEYS", "_WORKFLOW_KEYS",
        "_ATTACHMENT_KEYS", "_TERMINAL_KEYS", "_P14_KEYS", "_REPLAY_KEYS", "_RUN_KEYS",
    ):
        assert not getattr(bundle, name) & handoff.FORBIDDEN_KEYS, name

    def walk(value):
        if isinstance(value, dict):
            for key, child in value.items():
                yield key
                yield from walk(child)
        elif isinstance(value, list):
            for child in value:
                yield from walk(child)

    for files in [_files(name) for name in _CASES] + [_invalid_files()]:
        for path, payload in files.items():
            if path != MANIFEST_DIGEST_PATH:
                assert not set(walk(json.loads(payload))) & handoff.FORBIDDEN_KEYS, path


def test_layer_i_privacy_layer_does_not_import_the_production_filters():
    imported = _imported_modules(_runtime_tree())
    assert not imported & {"data.p14_evidence_privacy_filter", "data.candidate_funnel_privacy_smoke"}
    assert handoff.SECRET_PATTERNS and handoff.PRIVATE_PATH_PATTERNS and handoff.FORBIDDEN_KEYS


# --------------------------------------------------------------------------
# Layer K / L: no engine, no network, no workflow environment.
# --------------------------------------------------------------------------

_FORBIDDEN_MODULES = (
    "data.candidate_funnel_engine", "data.candidate_funnel_batch",
    "data.candidate_funnel_run_evidence", "data.p14_evidence_privacy_filter",
    "data.candidate_funnel_privacy_smoke",
)
_NETWORK_PACKAGES = frozenset(
    {"socket", "urllib", "http", "requests", "ssl", "ftplib", "smtplib", "asyncio",
     "socketserver", "xmlrpc", "httpx", "aiohttp"}
)
_ENGINE_NAMES = frozenset(
    {"_perturb_candidates", "compute_rank_stability", "compute_p14_release_evidence",
     "compute_quality_report", "build_candidate_funnel"}
)


def _runtime_tree() -> ast.Module:
    return ast.parse(Path(bundle.__file__).read_text(encoding="utf-8"))


def _imported_modules(tree: ast.Module) -> set[str]:
    imports: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imports.add(node.module)
    return imports


def test_layer_k_import_graph_is_engine_batch_privacy_filter_clean_and_perturbation_free():
    tree = _runtime_tree()
    imports = _imported_modules(tree)
    assert not imports & set(_FORBIDDEN_MODULES)
    names = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
    names |= {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
    names |= {alias.name.split(".")[-1] for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom)) for alias in node.names}
    assert not names & _ENGINE_NAMES


def test_layer_l_network_imports_absent_and_git_call_is_confined_to_one_function():
    tree = _runtime_tree()
    packages = {name.split(".")[0] for name in _imported_modules(tree)}
    assert not packages & _NETWORK_PACKAGES
    # The oracle constrains process-launch capability, not the passive subprocess
    # names (PIPE / DEVNULL / SubprocessError) that the single launch site may use.
    executors = {"run", "Popen", "call", "check_call", "check_output", "getoutput", "getstatusoutput"}
    passive = {"SubprocessError", "PIPE", "DEVNULL"}
    os_launchers = ("system", "popen", "spawn", "exec", "posix_spawn", "fork")
    usage: dict[str, set[str]] = {}
    environ: set[str] = set()
    dangerous = []
    # Module-level code is walked too, so a launch outside any def/class is not missed.
    scopes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))]
    module_level = [node for node in tree.body if node not in scopes]
    for scope, nodes in [(function.name, [function]) for function in scopes] + [("<module>", module_level)]:
        for root in nodes:
            for node in ast.walk(root):
                if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
                    if node.value.id == "subprocess":
                        usage.setdefault(scope, set()).add(node.attr)
                    if node.value.id == "os" and node.attr == "environ":
                        environ.add(scope)
                    if node.value.id == "os" and node.attr.startswith(os_launchers):
                        dangerous.append(node.attr)
    # Only the plain `import subprocess` form is allowed: no aliasing, no from-import
    # that could hide an executor behind a bare name.
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            assert node.module != "subprocess"
            if node.module == "os":
                assert not any(alias.name.startswith(os_launchers) for alias in node.names)
        if isinstance(node, ast.Import):
            assert all(alias.name != "subprocess" or alias.asname is None for alias in node.names)
    # Execution-capable subprocess APIs: exactly `run`, and only inside `_source_blob`.
    executor_scopes = {scope: attrs & executors for scope, attrs in usage.items() if attrs & executors}
    assert executor_scopes == {"_source_blob": {"run"}}
    # Every other subprocess attribute must be a known passive name (subset, not equality).
    for scope, attrs in usage.items():
        assert attrs - executors <= passive, (scope, attrs - executors - passive)
    assert environ == {"_source_blob"}
    assert not dangerous
    launches = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name) and node.func.value.id == "subprocess"
    ]
    assert len(launches) == 1
    assert launches[0].func.attr == "run"


def _install_socket_tripwire(monkeypatch):
    attempts: list[str] = []

    def blocked(*_args, **_kwargs):
        attempts.append("network")
        raise AssertionError("network access attempted")

    class Tripwire:
        def __init__(self, *_args, **_kwargs):
            blocked()

    monkeypatch.setattr(socket, "socket", Tripwire)
    monkeypatch.setattr(socket, "create_connection", blocked)
    monkeypatch.setattr(socket, "getaddrinfo", blocked)
    monkeypatch.setattr(socket, "gethostbyname", blocked)
    return attempts


def test_layer_l_socket_tripwire_builder_verifier_readers_installer_and_cli_stay_offline(
    tmp_path, monkeypatch, capsys
):
    attempts = _install_socket_tripwire(monkeypatch)
    with pytest.raises(AssertionError):
        socket.socket()
    attempts.clear()
    built = {
        "ready": _make_bundle("900000031", terminal="BATCH_READY", p14_status="PASS", dropped=0)[0],
        "qgf": _make_bundle("900000032", terminal="QUALITY_GATE_FAILED", p14_status="FAIL", dropped=2)[0],
        "sv": _make_bundle(
            "900000033", terminal="SCHEMA_VIOLATIONS", p14_status="PASS", dropped=0,
            schema_violations=["synthetic.schema"],
        )[0],
    }
    invalid = bundle.build_invalid_bundle(
        {"code": "HANDOFF_MISSING", "detail": None, "stage": "REFERENCE"}, None, None, bundle.WorkflowStatus(None, None)
    )
    for label, files in {**built, "invalid": invalid}.items():
        report = bundle.verify_bundle_files(files)
        assert report.bundle_integrity == "PASS", label
        directory = _write_bundle_dir(tmp_path / f"dir-{label}", files)
        assert bundle.read_bundle_directory(directory) == files
        archive = tmp_path / f"{label}.zip"
        archive.write_bytes(_zip_bytes(files, directory.name))
        assert bundle.read_bundle_zip(archive.resolve()) == files
        assert bundle.main(["verify", str(directory)]) == 0
        capsys.readouterr()
        out = tmp_path / f"out-{label}"
        out.mkdir(mode=0o700)
        assert (bundle.install_bundle(out.resolve(), files) / "manifest.sha256").is_file()
    assert attempts == []


_OFFLINE_DRIVER = r"""
import io, json, socket, sys

def _blocked(*args, **kwargs):
    raise AssertionError("network access attempted")

class _Tripwire:
    def __init__(self, *args, **kwargs):
        _blocked()

socket.socket = _Tripwire
socket.create_connection = _blocked
socket.getaddrinfo = _blocked
socket.gethostbyname = _blocked

from data import p14_run_evidence_bundle as bundle

results = []
for target in sys.argv[1:]:
    buffer = io.BytesIO()
    wrapper = io.TextIOWrapper(buffer, encoding="utf-8", write_through=True)
    real = sys.stdout
    sys.stdout = wrapper
    try:
        code = bundle.main(["verify", target])
    finally:
        sys.stdout = real
    wrapper.flush()
    results.append({"exit": code, "report": json.loads(buffer.getvalue())})
forbidden = {
    "data.candidate_funnel_engine", "data.candidate_funnel_batch",
    "data.candidate_funnel_run_evidence", "data.p14_evidence_privacy_filter",
    "data.candidate_funnel_privacy_smoke",
}
sys.stdout.write(json.dumps({"results": results, "loaded": sorted(m for m in sys.modules if m in forbidden)}))
"""


def _offline_directories(tmp_path: Path) -> list[Path]:
    return [
        _write_bundle_dir(tmp_path / "ready", _files("A")),
        _write_bundle_dir(tmp_path / "qgf", _files("B")),
        _write_bundle_dir(tmp_path / "sv", _files("SV")),
        _write_bundle_dir(tmp_path / "non-p14-qgf", _files("QGF_P10_WARN")),
    ]


def test_layer_k_l_ah2_offline_cli_in_minimal_environment_for_ready_qgf_and_reviewed_sv(tmp_path):
    directories = _offline_directories(tmp_path)
    completed = _run_python(["-c", _OFFLINE_DRIVER, *map(str, directories)])
    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["loaded"] == []
    outcomes = [
        (item["exit"], item["report"]["bundleIntegrity"], item["report"]["captureValidity"],
         item["report"]["terminalStatus"], item["report"]["artifactAvailable"])
        for item in payload["results"]
    ]
    assert outcomes == [
        (0, "PASS", "VALID", "BATCH_READY", True),
        (0, "PASS", "VALID", "QUALITY_GATE_FAILED", False),
        (0, "PASS", "VALID", "SCHEMA_VIOLATIONS", False),
        (0, "PASS", "VALID", "QUALITY_GATE_FAILED", False),
    ]


def test_layer_k_l_offline_cli_ignores_workflow_environment(tmp_path):
    directories = [str(item) for item in _offline_directories(tmp_path)]
    poisoned_output = tmp_path / "must-not-exist" / "github-output.txt"
    minimal = _run_python(["-c", _OFFLINE_DRIVER, *directories])
    poisoned = _run_python(
        ["-c", _OFFLINE_DRIVER, *directories],
        env=_python_env(
            GITHUB_OUTPUT=str(poisoned_output),
            GITHUB_ENV=str(poisoned_output),
            RUNNER_TEMP=str(tmp_path / "runner-temp"),
            GITHUB_RUN_ID="1",
            P14_EVIDENCE_MODE="enabled",
        ),
    )
    assert minimal.returncode == 0 and poisoned.returncode == 0, (minimal.stderr, poisoned.stderr)
    assert minimal.stdout == poisoned.stdout
    assert not poisoned_output.parent.exists()
    assert not (tmp_path / "runner-temp").exists()


def test_cli_and_import_are_engine_batch_privacy_filter_clean(monkeypatch, capsys):
    source = Path(bundle.__file__).read_text()
    tree = ast.parse(source)
    imports = {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.Import)
        for alias in node.names
    } | {
        node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module
    }
    assert not imports & set(_FORBIDDEN_MODULES)
    assert not {name.split(".")[0] for name in imports} & _NETWORK_PACKAGES
    monkeypatch.setattr(sys, "argv", ["p14_run_evidence_bundle", "verify", str(GOLDEN_ROOT / "candidate-funnel-evidence-900000001-1")])
    assert bundle.main(sys.argv[1:]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["bundleIntegrity"] == "PASS"
    completed = _run_python(
        ["-c", "import sys; import data.p14_run_evidence_bundle; print(sorted(x for x in sys.modules if x in {'data.candidate_funnel_engine','data.candidate_funnel_batch','data.p14_evidence_privacy_filter','data.candidate_funnel_privacy_smoke'}))"],
    )
    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == "[]"


def test_layer_e_module_entrypoint_exit_codes_in_a_bytecode_free_subprocess(tmp_path):
    good = _write_bundle_dir(tmp_path / "good", _files("A"))
    ok = _run_python(["-m", "data.p14_run_evidence_bundle", "verify", str(good)])
    assert ok.returncode == 0, ok.stderr
    assert json.loads(ok.stdout)["terminalStatus"] == "BATCH_READY"
    corrupted = dict(_files("A"))
    corrupted[EVIDENCE_PATH] = _flip_byte(corrupted[EVIDENCE_PATH])
    bad = _write_bundle_dir(tmp_path / "bad", corrupted)
    failed = _run_python(["-m", "data.p14_run_evidence_bundle", "verify", str(bad)])
    assert failed.returncode == 1
    assert json.loads(failed.stdout)["errors"] == [{"code": "MANIFEST_MISMATCH", "detail": None}]


def test_no_environment_authority_or_publication_inference():
    source = Path(bundle.__file__).read_text()
    assert "GITHUB_" not in source
    assert "RUNNER_TEMP" not in source
    assert 'os.environ.get("P14_' not in source
    report = bundle.verify_bundle_files(_golden_b())
    assert report.bundle_integrity == "PASS"
    assert report.capture_validity == "VALID"
    assert report.artifact_available is False


def test_public_signatures_are_stable():
    assert str(inspect.signature(bundle.build_captured_bundle)) == "(parts: 'HandoffParts', reference: 'ProducerReference | Mapping[str, Any]', expected: 'ExpectedBinding', consumer: 'ConsumerIdentity', workflow: 'WorkflowStatus') -> 'BundleFiles'"
    assert str(inspect.signature(bundle.build_invalid_bundle)) == "(failure: 'Mapping[str, Any]', run_identity: 'Mapping[str, Any] | None', consumer: 'ConsumerIdentity | None', workflow: 'WorkflowStatus') -> 'BundleFiles'"
    assert str(inspect.signature(bundle.verify_bundle_files)) == "(files: 'Mapping[str, bytes]', *, source_repo: 'Path | None' = None) -> 'VerificationReport'"
    assert str(inspect.signature(bundle.read_bundle_directory)) == "(path: 'str | os.PathLike[str]') -> 'BundleFiles'"
    assert str(inspect.signature(bundle.install_bundle)) == "(out_root: 'str | os.PathLike[str]', files: 'Mapping[str, bytes]') -> 'Path'"


def test_all_required_error_families_are_represented():
    source = Path(bundle.__file__).read_text()
    for code in (
        "HANDOFF_MISSING", "PRODUCER_REFERENCE_MISSING", "CONSUMER_CONFIGURATION_INVALID",
        "BUNDLE_BUILD_FAILED", "SELF_VERIFICATION_FAILED", "BUNDLE_LOCATION_INVALID",
        "BUNDLE_MALFORMED", "BUNDLE_UNKNOWN_KEY", "BUNDLE_INCOMPLETE", "MANIFEST_MISMATCH",
        "UNSUPPORTED_BUNDLE_SCHEMA", "ATTACHMENT_DIGEST_MISMATCH", "RECEIPT_PROJECTION_MISMATCH",
        "WORKFLOW_STATUS_INCONSISTENT", "DERIVED_PROJECTION_MISMATCH", "DIAGNOSTICS_MISMATCH",
        "BUNDLE_PRIVACY_VIOLATION", "SOURCE_IDENTITY_MISMATCH", "BUNDLE_ALREADY_EXISTS",
        "BUNDLE_WRITE_FAILED",
    ):
        assert code in source


def test_manifest_digest_graph_is_acyclic_and_completion_marker_is_final():
    files = _golden_a()
    manifest = json.loads(files["manifest.json"])
    indexed = {item["path"] for item in manifest["files"]}
    assert "manifest.json" not in indexed
    assert "manifest.sha256" not in indexed
    assert files["manifest.sha256"] == f"{_sha(files['manifest.json'])}  manifest.json\n".encode()
    source = Path(bundle.__file__).read_text()
    assert source.index("content[PRIVACY_REPORT_FILE]") < source.index("content[MANIFEST_FILE]") < source.index("content[MANIFEST_DIGEST_FILE]")


# --------------------------------------------------------------------------
# Typed-error fuzz: deterministic mutation series never leaks a raw exception.
# --------------------------------------------------------------------------


def _leaf_paths(value, prefix=()):
    if isinstance(value, dict):
        for key in sorted(value):
            yield from _leaf_paths(value[key], prefix + (key,))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _leaf_paths(child, prefix + (index,))
    else:
        yield prefix


def _set_path(value, path, replacement):
    cursor = value
    for step in path[:-1]:
        cursor = cursor[step]
    cursor[path[-1]] = replacement


def _fuzz_variants(payload: bytes):
    yield "invalid-utf8", b"\xff\xfe\x00"
    yield "truncated", payload[:-1]
    yield "empty", b""
    yield "huge-integer", b'{"n":' + b"9" * 5000 + b"}"
    yield "float-overflow", b'{"n":1e999}'
    value = json.loads(payload)
    paths = [path for path in _leaf_paths(value) if path]
    step = max(1, len(paths) // 8)
    for path in paths[::step]:
        for label, replacement in (("null", None), ("string", "x"), ("integer", 1), ("array", []), ("object", {})):
            mutated = copy.deepcopy(value)
            _set_path(mutated, path, replacement)
            if mutated != value:
                yield f"type-{label}@{'/'.join(map(str, path))}", handoff.canonical_json_bytes(mutated)
    if isinstance(value, dict):
        for key in sorted(value):
            mutated = {name: child for name, child in value.items() if name != key}
            yield f"drop@{key}", handoff.canonical_json_bytes(mutated)


_FUZZ_TARGETS = (
    "manifest.json", "evidence.json", "p14-reference-diagnostics.json", "validation/privacy-report.json",
    "attachments/capture-input.json", "attachments/batch-receipt.json", "attachments/handoff.json",
    "observation",
)


@pytest.mark.parametrize("target", _FUZZ_TARGETS)
def test_typed_error_fuzz_verifier_never_raises_and_only_reports_typed_codes(target, default_int_digit_limit):
    files = _files("A")
    path = _obs_path(files) if target == "observation" else target
    checked = 0
    for label, variant in _fuzz_variants(files[path]):
        if path == MANIFEST_PATH:
            mutated = {**files, MANIFEST_PATH: variant, MANIFEST_DIGEST_PATH: _manifest_digest_line(variant)}
        else:
            mutated = _reseal({**files, path: variant})
        report = bundle.verify_bundle_files(mutated)
        assert isinstance(report, bundle.VerificationReport), label
        assert len(report.errors) <= 1, label
        for error in report.errors:
            assert error.code in bundle._BUNDLE_ERROR_CODES, (label, error)
        checked += 1
    assert checked >= 10


def test_typed_error_fuzz_builder_and_hostile_maps_only_raise_typed_errors():
    _, parts, reference, expected = _case("A")
    workflow = bundle.WorkflowStatus("batch_passed", "smoke_passed")
    fields = ("capture_input_bytes", "observation_bytes", "receipt_bytes", "envelope_bytes")
    for field in fields:
        original = getattr(parts, field)
        for variant in (b"\xff\xfe", original[:-1], b"", b'{"n":1e999}', _flip_byte(original)):
            mutated = replace(parts, **{field: variant})
            with pytest.raises((handoff.HandoffError, bundle.EvidenceBundleError)):
                bundle.build_captured_bundle(mutated, reference, expected, _consumer(), workflow)
    for hostile in (None, [], "text", 3, {1: b"x"}, {"a": None}, {"a": "text"}, {"": b"x"}):
        report = bundle.verify_bundle_files(hostile)
        assert report.bundle_integrity == "FAIL" and len(report.errors) == 1
        assert report.errors[0].code in bundle._BUNDLE_ERROR_CODES
