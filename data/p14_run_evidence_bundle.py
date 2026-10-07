"""Pure schema-3 run-evidence bundles and offline verification.

This module is deliberately independent of the candidate-funnel engine, batch
producer, legacy run-evidence builder, and production privacy filters.  A valid
bundle proves the integrity of captured transport evidence; it never proves a
release, push, publication, or deployment outcome.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import os
import re
import stat
import subprocess
import sys
import zipfile
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Any

from data.p14_handoff import (
    CAPTURE_INPUT_SCHEMA_VERSION,
    FORBIDDEN_KEYS,
    HANDOFF_ERROR_CODES,
    HANDOFF_SCHEMA_VERSION,
    PRIVATE_PATH_PATTERNS,
    RECEIPT_SCHEMA_VERSION,
    SECRET_PATTERNS,
    DigestBinding,
    ExpectedBinding,
    HandoffError,
    HandoffParts,
    ModuleBinding,
    ProducerReference,
    RawFileBinding,
    install_file_no_overwrite,
    require_private_directory,
    validate_handoff_parts,
)
from data.p14_observation import (
    OBSERVATION_SCHEMA_VERSION,
    ObservationContractError,
    StrictJSONError,
    canonical_json_bytes,
    project_rank_vector,
    strict_json_loads,
)
from data.p14_reference_classifier import classify_reference_transition
from data.p14_reference_diagnostics import (
    DIAGNOSTICS_SCHEMA_VERSION,
    DiagnosticContractError,
    build_reference_diagnostics,
    decode_reference_diagnostics,
    serialize_reference_diagnostics,
)

BUNDLE_SCHEMA_VERSION = "candidate-funnel-run-evidence-3"
_LEGACY_SCHEMA_VERSIONS = frozenset(
    {"candidate-funnel-run-evidence-1", "candidate-funnel-run-evidence-2"}
)
REPLAY_SCHEMA_VERSION_3 = "candidate-funnel-p14-replay-2"
ACCEPTED_POLICY_VERSIONS = frozenset({"p14-decision-aware-v1"})
CONSUMER_MODULE_PATHS = (
    "data/candidate_funnel_run_evidence.py",
    "data/p14_handoff.py",
    "data/p14_observation.py",
    "data/p14_reference_classifier.py",
    "data/p14_reference_diagnostics.py",
    "data/p14_run_evidence_bundle.py",
)

EVIDENCE_FILE = "evidence.json"
DIAGNOSTICS_FILE = "p14-reference-diagnostics.json"
PRIVACY_REPORT_FILE = "validation/privacy-report.json"
MANIFEST_FILE = "manifest.json"
MANIFEST_DIGEST_FILE = "manifest.sha256"
CAPTURE_ATTACHMENT_FILE = "attachments/capture-input.json"
RECEIPT_ATTACHMENT_FILE = "attachments/batch-receipt.json"
ENVELOPE_ATTACHMENT_FILE = "attachments/handoff.json"
PRIVACY_SCHEMA_VERSION = "candidate-funnel-run-evidence-privacy-1"
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_GIT_SHA = re.compile(r"^[0-9a-f]{40}$")
_POSITIVE_DECIMAL = re.compile(r"^[1-9][0-9]*$")
_SAFE_DETAIL = re.compile(r"^[A-Za-z0-9._-]+$")
_BUNDLE_ID = re.compile(
    r"^candidate-funnel-evidence-(?:([1-9][0-9]*)-([1-9][0-9]*)|unknown-unknown)$"
)
_OBSERVATION_FILE = re.compile(r"^attachments/observation-([0-9a-f]{64})\.json$")

_BUNDLE_ERROR_CODES = frozenset(
    {
        "HANDOFF_MISSING",
        "PRODUCER_REFERENCE_MISSING",
        "CONSUMER_CONFIGURATION_INVALID",
        "BUNDLE_BUILD_FAILED",
        "SELF_VERIFICATION_FAILED",
        "BUNDLE_LOCATION_INVALID",
        "BUNDLE_MALFORMED",
        "BUNDLE_UNKNOWN_KEY",
        "BUNDLE_INCOMPLETE",
        "MANIFEST_MISMATCH",
        "UNSUPPORTED_BUNDLE_SCHEMA",
        "ATTACHMENT_DIGEST_MISMATCH",
        "RECEIPT_PROJECTION_MISMATCH",
        "WORKFLOW_STATUS_INCONSISTENT",
        "DERIVED_PROJECTION_MISMATCH",
        "DIAGNOSTICS_MISMATCH",
        "BUNDLE_PRIVACY_VIOLATION",
        "SOURCE_IDENTITY_MISMATCH",
        "BUNDLE_ALREADY_EXISTS",
        "BUNDLE_WRITE_FAILED",
    }
) | HANDOFF_ERROR_CODES

_FAILURE_STAGES = frozenset(
    {"CONFIGURATION", "REFERENCE", "STORAGE", "ADMISSION", "BUILD", "SELF_VERIFY", "PRIVACY"}
)
_BATCH_STATUSES = frozenset({"batch_passed", "batch_failed", None})
_SMOKE_STATUSES = frozenset({"smoke_passed", "smoke_failed", None})
_RUN_KEYS = frozenset(
    {"repository", "workflow", "job", "runId", "runAttempt", "event", "gitRef", "gitRefType", "gitSha"}
)
_REFERENCE_KEYS = frozenset(
    {
        "status", "transportDigest", "observationDigest", "receiptDigest",
        "captureInputDigest", "executedGitSha", "observationSchemaVersion",
        "handoffSchemaVersion", "policyVersion", "runId", "runAttempt",
    }
)
_EXPECTED_KEYS = frozenset(
    {
        "repository", "workflow", "job", "runId", "runAttempt", "event", "gitRef",
        "gitRefType", "eventGitSha", "executedGitSha", "policyVersion",
        "engineSchemaVersion", "engineScoreVersion", "engineFunnelVersion", "modules",
        "rawFiles", "joinedCandidateInput", "replayContext", "captureInput",
    }
)
_CONSUMER_KEYS = frozenset({"executedGitSha", "modules"})
_WORKFLOW_KEYS = frozenset({"batchStatus", "smokeStatus"})
_ATTACHMENT_KEYS = frozenset({"file", "sha256", "bytes", "schemaVersion"})
_TERMINAL_KEYS = frozenset(
    {
        "terminalStatus", "reportState", "transportStatus", "failureCode",
        "artifactAvailable", "observationAvailable", "producerReferenceAvailable",
    }
)
_P14_KEYS = frozenset({"verdict", "jaccard", "swapCount", "baseTop40", "perturbedTop40", "release"})
_REPLAY_KEYS = frozenset(
    {"schemaVersion", "input", "baseFullOrderedRankVector", "perturbedFullOrderedRankVector", "boundaryOutsideBand"}
)
_CAPTURED_EVIDENCE_KEYS = frozenset(
    {
        "schemaVersion", "bundleId", "captureStatus", "runIdentity", "consumerIdentity",
        "workflowStatus", "producerReference", "expectedBinding", "attachments", "terminal",
        "p14", "replay", "confidenceInvariant", "diagnostics",
    }
)
_INVALID_EVIDENCE_KEYS = frozenset(
    {
        "schemaVersion", "bundleId", "captureStatus", "runIdentity", "consumerIdentity",
        "workflowStatus", "failure",
    }
)
_MANIFEST_KEYS = frozenset({"schemaVersion", "bundleId", "files"})
_FILE_RECORD_KEYS = frozenset({"path", "sha256", "bytes"})
_PRIVACY_KEYS = frozenset({"schemaVersion", "status", "files"})


class EvidenceBundleError(ValueError):
    """Fail-closed bundle error carrying stable, non-sensitive identifiers."""

    def __init__(self, code: str, detail: str | None = None):
        if code not in _BUNDLE_ERROR_CODES:
            raise ValueError("unsupported evidence-bundle error code")
        if detail is not None and (type(detail) is not str or not _SAFE_DETAIL.fullmatch(detail)):
            raise ValueError("bundle error detail must be a safe enum")
        self.code = code
        self.detail = detail
        super().__init__(code if detail is None else f"{code}:{detail}")


@dataclass(frozen=True, slots=True)
class ConsumerIdentity:
    executed_git_sha: str
    modules: tuple[tuple[str, str], ...]

    def __post_init__(self) -> None:
        if type(self.executed_git_sha) is not str or not _GIT_SHA.fullmatch(self.executed_git_sha):
            raise ValueError("consumer executed SHA must be lowercase 40-hex")
        if type(self.modules) is not tuple or tuple(path for path, _ in self.modules) != CONSUMER_MODULE_PATHS:
            raise ValueError("consumer modules must be the exact fixed module set")
        for path, digest in self.modules:
            if type(path) is not str or type(digest) is not str or not _SHA256.fullmatch(digest):
                raise ValueError("invalid consumer module binding")


@dataclass(frozen=True, slots=True)
class WorkflowStatus:
    batch_status: str | None
    smoke_status: str | None

    def __post_init__(self) -> None:
        if self.batch_status not in _BATCH_STATUSES or self.smoke_status not in _SMOKE_STATUSES:
            raise ValueError("unsupported workflow status")
        if self.smoke_status is not None and self.batch_status != "batch_passed":
            raise ValueError("smoke status requires batch_passed")


@dataclass(frozen=True, slots=True)
class _VerificationError:
    code: str
    detail: str | None = None

    def to_value(self) -> dict[str, Any]:
        return {"code": self.code, "detail": self.detail}


@dataclass(frozen=True, slots=True)
class VerificationReport:
    route: str
    bundle_integrity: str
    capture_validity: str
    terminal_status: str | None
    artifact_available: bool | None
    errors: tuple[_VerificationError, ...]

    def to_value(self) -> dict[str, Any]:
        return {
            "route": self.route,
            "bundleIntegrity": self.bundle_integrity,
            "captureValidity": self.capture_validity,
            "terminalStatus": self.terminal_status,
            "artifactAvailable": self.artifact_available,
            "errors": [item.to_value() for item in self.errors],
        }


@dataclass(frozen=True, slots=True)
class BundleFiles(Mapping[str, bytes]):
    """Immutable path-to-bytes bundle with no retained decoded objects."""

    files: Mapping[str, bytes]

    def __post_init__(self) -> None:
        if not isinstance(self.files, Mapping):
            raise TypeError("bundle files must be a mapping")
        owned: dict[str, bytes] = {}
        for path, payload in self.files.items():
            if type(path) is not str or type(payload) is not bytes:
                raise TypeError("bundle files must contain only string paths and immutable bytes")
            owned[path] = bytes(payload)
        object.__setattr__(self, "files", MappingProxyType(owned))

    def __getitem__(self, key: str) -> bytes:
        return self.files[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self.files)

    def __len__(self) -> int:
        return len(self.files)


def _digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _exact_keys(value: Any, expected: frozenset[str], *, detail: str) -> dict[str, Any]:
    if type(value) is not dict:
        raise EvidenceBundleError("BUNDLE_MALFORMED", detail)
    keys = set(value)
    if keys - expected:
        raise EvidenceBundleError("BUNDLE_UNKNOWN_KEY", detail)
    if keys != expected:
        raise EvidenceBundleError("BUNDLE_MALFORMED", detail)
    return value


def _decode(payload: bytes, *, detail: str) -> Any:
    try:
        return strict_json_loads(payload, require_canonical=True)
    except (StrictJSONError, ObservationContractError, UnicodeError, TypeError, ValueError) as exc:
        raise EvidenceBundleError("BUNDLE_MALFORMED", detail) from exc


def _require_digest(value: Any, detail: str) -> str:
    if type(value) is not str or not _SHA256.fullmatch(value):
        raise EvidenceBundleError("BUNDLE_MALFORMED", detail)
    return value


def _require_nonnegative_int(value: Any, detail: str) -> int:
    if type(value) is not int or value < 0:
        raise EvidenceBundleError("BUNDLE_MALFORMED", detail)
    return value


def _bundle_id(run_identity: Mapping[str, Any] | None) -> str:
    if run_identity is None:
        return "candidate-funnel-evidence-unknown-unknown"
    run_id = run_identity.get("runId")
    run_attempt = run_identity.get("runAttempt")
    if type(run_id) is not str or not _POSITIVE_DECIMAL.fullmatch(run_id):
        raise EvidenceBundleError("BUNDLE_BUILD_FAILED", "RUN_ID")
    if type(run_attempt) is not str or not _POSITIVE_DECIMAL.fullmatch(run_attempt):
        raise EvidenceBundleError("BUNDLE_BUILD_FAILED", "RUN_ATTEMPT")
    return f"candidate-funnel-evidence-{run_id}-{run_attempt}"


def _consumer_value(consumer: ConsumerIdentity | None) -> dict[str, Any] | None:
    if consumer is None:
        return None
    return {
        "executedGitSha": consumer.executed_git_sha,
        "modules": [{"path": path, "sha256": digest} for path, digest in consumer.modules],
    }


def _workflow_value(workflow: WorkflowStatus) -> dict[str, Any]:
    return {"batchStatus": workflow.batch_status, "smokeStatus": workflow.smoke_status}


def _digest_binding_value(binding: DigestBinding) -> dict[str, Any]:
    return {"sha256": binding.sha256, "bytes": binding.bytes}


def _expected_value(expected: ExpectedBinding) -> dict[str, Any]:
    return {
        "repository": expected.repository,
        "workflow": expected.workflow,
        "job": expected.job,
        "runId": expected.run_id,
        "runAttempt": expected.run_attempt,
        "event": expected.event,
        "gitRef": expected.git_ref,
        "gitRefType": expected.git_ref_type,
        "eventGitSha": expected.event_git_sha,
        "executedGitSha": expected.executed_git_sha,
        "policyVersion": expected.policy_version,
        "engineSchemaVersion": expected.engine_schema_version,
        "engineScoreVersion": expected.engine_score_version,
        "engineFunnelVersion": expected.engine_funnel_version,
        "modules": [{"path": item.path, "sha256": item.sha256} for item in expected.modules],
        "rawFiles": [
            {"name": item.name, "present": item.present, "sha256": item.sha256, "bytes": item.bytes}
            for item in expected.raw_files
        ],
        "joinedCandidateInput": _digest_binding_value(expected.joined_candidate_input),
        "replayContext": _digest_binding_value(expected.replay_context),
        "captureInput": _digest_binding_value(expected.capture_input),
    }


def _expected_from_value(value: Any) -> ExpectedBinding:
    item = _exact_keys(value, _EXPECTED_KEYS, detail="EXPECTED_BINDING")
    try:
        modules_value = item["modules"]
        raw_value = item["rawFiles"]
        if type(modules_value) is not list or type(raw_value) is not list:
            raise ValueError("binding collections must be lists")
        modules = tuple(ModuleBinding(entry["path"], entry["sha256"]) for entry in modules_value)
        raw_files = tuple(
            RawFileBinding(entry["name"], entry["present"], entry["sha256"], entry["bytes"])
            for entry in raw_value
        )
        for entry in modules_value:
            _exact_keys(entry, frozenset({"path", "sha256"}), detail="EXPECTED_MODULE")
        for entry in raw_value:
            _exact_keys(entry, frozenset({"name", "present", "sha256", "bytes"}), detail="EXPECTED_RAW")
        joined = _exact_keys(item["joinedCandidateInput"], frozenset({"sha256", "bytes"}), detail="EXPECTED_DIGEST")
        context = _exact_keys(item["replayContext"], frozenset({"sha256", "bytes"}), detail="EXPECTED_DIGEST")
        capture = _exact_keys(item["captureInput"], frozenset({"sha256", "bytes"}), detail="EXPECTED_DIGEST")
        return ExpectedBinding(
            repository=item["repository"], workflow=item["workflow"], job=item["job"],
            run_id=item["runId"], run_attempt=item["runAttempt"], event=item["event"],
            git_ref=item["gitRef"], git_ref_type=item["gitRefType"], event_git_sha=item["eventGitSha"],
            executed_git_sha=item["executedGitSha"], policy_version=item["policyVersion"],
            engine_schema_version=item["engineSchemaVersion"], engine_score_version=item["engineScoreVersion"],
            engine_funnel_version=item["engineFunnelVersion"], modules=modules, raw_files=raw_files,
            joined_candidate_input=DigestBinding(joined["sha256"], joined["bytes"]),
            replay_context=DigestBinding(context["sha256"], context["bytes"]),
            capture_input=DigestBinding(capture["sha256"], capture["bytes"]),
        )
    except EvidenceBundleError:
        raise
    except (HandoffError, KeyError, TypeError, ValueError) as exc:
        raise EvidenceBundleError("BUNDLE_MALFORMED", "EXPECTED_BINDING") from exc


def _attachment(file: str, payload: bytes, schema_version: str) -> dict[str, Any]:
    return {"file": file, "sha256": _digest(payload), "bytes": len(payload), "schemaVersion": schema_version}


def _top_codes(vector: list[dict[str, Any]]) -> list[str]:
    return [row["code"] for row in vector[:40]]


def _swap_count(left: list[str], right: list[str]) -> int:
    return len(set(left) - set(right))


def _jaccard(left: list[str], right: list[str]) -> float:
    union = set(left) | set(right)
    return 1.0 if not union else len(set(left) & set(right)) / len(union)


def _diagnostics_bytes(observation: Mapping[str, Any]) -> bytes:
    try:
        classification = classify_reference_transition(
            observation["base"]["candidates"], observation["perturbed"]["candidates"]
        )
        value = build_reference_diagnostics(classification, observation=observation)
        return serialize_reference_diagnostics(value)
    except (DiagnosticContractError, ObservationContractError, KeyError, TypeError, ValueError) as exc:
        raise EvidenceBundleError("BUNDLE_BUILD_FAILED", "DIAGNOSTICS_INVALID") from exc


def _privacy_scan_value(value: Any) -> None:
    if type(value) is dict:
        for key, child in value.items():
            if key in FORBIDDEN_KEYS:
                raise EvidenceBundleError("BUNDLE_PRIVACY_VIOLATION")
            _privacy_scan_value(child)
    elif type(value) is list:
        for child in value:
            _privacy_scan_value(child)


def _privacy_scan_payload(payload: bytes) -> None:
    try:
        text = payload.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise EvidenceBundleError("BUNDLE_PRIVACY_VIOLATION") from exc
    if any(pattern.search(text) for pattern in SECRET_PATTERNS):
        raise EvidenceBundleError("BUNDLE_PRIVACY_VIOLATION")
    if any(pattern.search(text) for pattern in PRIVATE_PATH_PATTERNS):
        raise EvidenceBundleError("BUNDLE_PRIVACY_VIOLATION")


def _content_order(paths: Any) -> list[str]:
    available = set(paths)
    ordered = sorted(path for path in available if path.startswith("attachments/"))
    for path in (DIAGNOSTICS_FILE, EVIDENCE_FILE, PRIVACY_REPORT_FILE):
        if path in available:
            ordered.append(path)
    return ordered


def _privacy_report(scanned: Mapping[str, bytes]) -> bytes:
    paths: list[str] = []
    for path in _content_order(scanned):
        payload = scanned[path]
        value = _decode(payload, detail="PRIVACY_INPUT")
        _privacy_scan_value(value)
        _privacy_scan_payload(payload)
        paths.append(path)
    return canonical_json_bytes(
        {"schemaVersion": PRIVACY_SCHEMA_VERSION, "status": "PASS", "files": paths}
    )


def _manifest(bundle_id: str, content: Mapping[str, bytes]) -> bytes:
    return canonical_json_bytes(
        {
            "schemaVersion": BUNDLE_SCHEMA_VERSION,
            "bundleId": bundle_id,
            "files": [
                {"path": path, "sha256": _digest(content[path]), "bytes": len(content[path])}
                for path in _content_order(content)
            ],
        }
    )


def _finish_bundle(bundle_id: str, content: dict[str, bytes]) -> BundleFiles:
    privacy_inputs = dict(content)
    content[PRIVACY_REPORT_FILE] = _privacy_report(privacy_inputs)
    manifest = _manifest(bundle_id, content)
    content[MANIFEST_FILE] = manifest
    content[MANIFEST_DIGEST_FILE] = f"{_digest(manifest)}  {MANIFEST_FILE}\n".encode("ascii")
    bundle = BundleFiles(content)
    report = verify_bundle_files(bundle)
    if report.bundle_integrity != "PASS":
        first = report.errors[0] if report.errors else _VerificationError("SELF_VERIFICATION_FAILED")
        raise EvidenceBundleError("SELF_VERIFICATION_FAILED", first.code)
    return bundle


def build_captured_bundle(
    parts: HandoffParts,
    reference: ProducerReference | Mapping[str, Any],
    expected: ExpectedBinding,
    consumer: ConsumerIdentity,
    workflow: WorkflowStatus,
) -> BundleFiles:
    """Build deterministic captured evidence from already-authoritative bytes."""
    try:
        reference_object = reference if isinstance(reference, ProducerReference) else ProducerReference.from_value(reference)
        validated = validate_handoff_parts(parts, expected, reference_object)
        if expected.policy_version not in ACCEPTED_POLICY_VERSIONS:
            raise EvidenceBundleError("POLICY_BINDING_MISMATCH")
        if consumer.executed_git_sha != expected.executed_git_sha:
            raise EvidenceBundleError("SOURCE_IDENTITY_MISMATCH")
        observation = validated.observation_value()
        receipt = validated.receipt_value()
        diagnostics = _diagnostics_bytes(observation)
        base_vector = project_rank_vector(observation["base"]["candidates"])
        perturbed_vector = project_rank_vector(observation["perturbed"]["candidates"])
        base_top = _top_codes(base_vector)
        perturbed_top = _top_codes(perturbed_vector)
        gate = next(item for item in receipt["report"]["qualityGate"]["gates"] if item["id"] == "P-14")
        release = receipt["report"]["qualityGate"]["p14ReleaseEvidence"]
        if release is None:
            raise EvidenceBundleError("BUNDLE_BUILD_FAILED", "P14_RELEASE_MISSING")
        observation_file = f"attachments/observation-{reference_object.observation_digest}.json"
        terminal = receipt["terminalStatus"]
        evidence = {
            "schemaVersion": BUNDLE_SCHEMA_VERSION,
            "bundleId": _bundle_id(observation["runIdentity"]),
            "captureStatus": "captured",
            "runIdentity": observation["runIdentity"],
            "consumerIdentity": _consumer_value(consumer),
            "workflowStatus": _workflow_value(workflow),
            "producerReference": reference_object.to_value(),
            "expectedBinding": _expected_value(expected),
            "attachments": {
                "observation": _attachment(observation_file, validated.observation_bytes, OBSERVATION_SCHEMA_VERSION),
                "captureInput": _attachment(CAPTURE_ATTACHMENT_FILE, validated.capture_input_bytes, CAPTURE_INPUT_SCHEMA_VERSION),
                "receipt": _attachment(RECEIPT_ATTACHMENT_FILE, validated.receipt_bytes, RECEIPT_SCHEMA_VERSION),
                "envelope": _attachment(ENVELOPE_ATTACHMENT_FILE, validated.envelope_bytes, HANDOFF_SCHEMA_VERSION),
            },
            "terminal": {
                "terminalStatus": terminal,
                "reportState": receipt["reportState"],
                "transportStatus": receipt["transportStatus"],
                "failureCode": receipt["failureCode"],
                "artifactAvailable": receipt["artifactAvailable"],
                "observationAvailable": receipt["observationDigest"] is not None,
                "producerReferenceAvailable": True,
            },
            "p14": {
                "verdict": gate["status"],
                "jaccard": gate["value"],
                "swapCount": _swap_count(base_top, perturbed_top),
                "baseTop40": base_top,
                "perturbedTop40": perturbed_top,
                "release": release,
            },
            "replay": {
                "schemaVersion": REPLAY_SCHEMA_VERSION_3,
                "input": {"attachment": "captureInput"},
                "baseFullOrderedRankVector": base_vector,
                "perturbedFullOrderedRankVector": perturbed_vector,
                "boundaryOutsideBand": {
                    "topK": 40,
                    "size": 10,
                    "base": base_vector[40:50],
                    "perturbed": perturbed_vector[40:50],
                },
            },
            "confidenceInvariant": observation["diagnosticAvailability"]["confidenceInvariant"],
            "diagnostics": {
                "file": DIAGNOSTICS_FILE,
                "sha256": _digest(diagnostics),
                "bytes": len(diagnostics),
                "diagnosticsVersion": DIAGNOSTICS_SCHEMA_VERSION,
            },
        }
        evidence_bytes = canonical_json_bytes(evidence)
        content = {
            observation_file: validated.observation_bytes,
            CAPTURE_ATTACHMENT_FILE: validated.capture_input_bytes,
            RECEIPT_ATTACHMENT_FILE: validated.receipt_bytes,
            ENVELOPE_ATTACHMENT_FILE: validated.envelope_bytes,
            DIAGNOSTICS_FILE: diagnostics,
            EVIDENCE_FILE: evidence_bytes,
        }
        return _finish_bundle(evidence["bundleId"], content)
    except EvidenceBundleError:
        raise
    except HandoffError:
        raise
    except (DiagnosticContractError, ObservationContractError, StopIteration, KeyError, TypeError, ValueError) as exc:
        raise EvidenceBundleError("BUNDLE_BUILD_FAILED") from exc


def build_invalid_bundle(
    failure: Mapping[str, Any],
    run_identity: Mapping[str, Any] | None,
    consumer: ConsumerIdentity | None,
    workflow: WorkflowStatus,
) -> BundleFiles:
    """Build deterministic minimal evidence for a typed consumer failure."""
    try:
        failure_value = _exact_keys(dict(failure), frozenset({"code", "detail", "stage"}), detail="FAILURE")
        if failure_value["code"] not in _BUNDLE_ERROR_CODES:
            raise EvidenceBundleError("BUNDLE_BUILD_FAILED", "FAILURE_CODE")
        if failure_value["detail"] is not None and (
            type(failure_value["detail"]) is not str or not _SAFE_DETAIL.fullmatch(failure_value["detail"])
        ):
            raise EvidenceBundleError("BUNDLE_BUILD_FAILED", "FAILURE_DETAIL")
        if failure_value["stage"] not in _FAILURE_STAGES:
            raise EvidenceBundleError("BUNDLE_BUILD_FAILED", "FAILURE_STAGE")
        if run_identity is not None:
            _exact_keys(dict(run_identity), _RUN_KEYS, detail="RUN_IDENTITY")
        bundle_id = _bundle_id(run_identity)
        evidence = {
            "schemaVersion": BUNDLE_SCHEMA_VERSION,
            "bundleId": bundle_id,
            "captureStatus": "invalid",
            "runIdentity": None if run_identity is None else dict(run_identity),
            "consumerIdentity": _consumer_value(consumer),
            "workflowStatus": _workflow_value(workflow),
            "failure": failure_value,
        }
        return _finish_bundle(bundle_id, {EVIDENCE_FILE: canonical_json_bytes(evidence)})
    except EvidenceBundleError:
        raise
    except (KeyError, TypeError, ValueError) as exc:
        raise EvidenceBundleError("BUNDLE_BUILD_FAILED") from exc


def _path_safe(path: str) -> bool:
    if type(path) is not str or path == "" or "\\" in path or "\x00" in path:
        return False
    parsed = PurePosixPath(path)
    return not parsed.is_absolute() and str(parsed) == path and all(part not in ("", ".", "..") for part in parsed.parts)


def _has_symlink_component(path: Path) -> bool:
    cursor = Path(path.anchor)
    for part in path.parts[1:]:
        cursor = cursor / part
        try:
            if cursor.is_symlink():
                return True
        except OSError:
            return True
    return False


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _v1_file_map(files: Mapping[str, bytes]) -> dict[str, bytes]:
    if not isinstance(files, Mapping):
        raise EvidenceBundleError("BUNDLE_MALFORMED", "FILE_MAP")
    owned: dict[str, bytes] = {}
    total = 0
    for path, payload in files.items():
        if not _path_safe(path) or type(payload) is not bytes:
            raise EvidenceBundleError("BUNDLE_LOCATION_INVALID")
        if path in owned:
            raise EvidenceBundleError("BUNDLE_LOCATION_INVALID", "DUPLICATE")
        if len(payload) > MAX_FILE_BYTES:
            raise EvidenceBundleError("BUNDLE_MALFORMED", "FILE_SIZE")
        total += len(payload)
        if total > MAX_TOTAL_BYTES:
            raise EvidenceBundleError("BUNDLE_MALFORMED", "TOTAL_SIZE")
        owned[path] = bytes(payload)
    if MANIFEST_FILE not in owned or MANIFEST_DIGEST_FILE not in owned:
        raise EvidenceBundleError("BUNDLE_INCOMPLETE")
    return owned


def _manifest_digest(payload: bytes, manifest: bytes) -> None:
    expected = f"{_digest(manifest)}  {MANIFEST_FILE}\n".encode("ascii")
    if payload != expected:
        raise EvidenceBundleError("MANIFEST_MISMATCH")


def _declares_legacy_schema(manifest_payload: bytes) -> bool:
    """Routing-only inspection: does the manifest name a known legacy schema?

    Real schema-1/2 manifests are written by the legacy builder (indented,
    with ``fileCount`` / ``totalBytes``), so they are neither canonical nor
    schema-3 shaped.  Only the schema identifier is read here; nothing about
    the legacy content is verified, replayed, converted or accepted.  Anything
    undecodable or not naming a legacy identifier stays on the schema-3 path,
    which keeps its full closed-key validation and typed failures.
    """
    try:
        value = strict_json_loads(manifest_payload)
    except (StrictJSONError, ObservationContractError, UnicodeError, TypeError, ValueError):
        return False
    if type(value) is not dict:
        return False
    schema = value.get("schemaVersion")
    return type(schema) is str and schema in _LEGACY_SCHEMA_VERSIONS


def _manifest_value(files: Mapping[str, bytes]) -> dict[str, Any]:
    value = _decode(files[MANIFEST_FILE], detail="MANIFEST")
    manifest = _exact_keys(value, _MANIFEST_KEYS, detail="MANIFEST")
    schema = manifest["schemaVersion"]
    if schema != BUNDLE_SCHEMA_VERSION:
        raise EvidenceBundleError("UNSUPPORTED_BUNDLE_SCHEMA")
    if type(manifest["bundleId"]) is not str or not _BUNDLE_ID.fullmatch(manifest["bundleId"]):
        raise EvidenceBundleError("BUNDLE_MALFORMED", "BUNDLE_ID")
    records = manifest["files"]
    if type(records) is not list:
        raise EvidenceBundleError("BUNDLE_MALFORMED", "MANIFEST_FILES")
    indexed: dict[str, dict[str, Any]] = {}
    for record in records:
        item = _exact_keys(record, _FILE_RECORD_KEYS, detail="MANIFEST_RECORD")
        path = item["path"]
        if not _path_safe(path) or path in indexed or path in {MANIFEST_FILE, MANIFEST_DIGEST_FILE}:
            raise EvidenceBundleError("MANIFEST_MISMATCH")
        _require_digest(item["sha256"], "MANIFEST_DIGEST")
        _require_nonnegative_int(item["bytes"], "MANIFEST_BYTES")
        indexed[path] = item
    actual = set(files) - {MANIFEST_FILE, MANIFEST_DIGEST_FILE}
    if set(indexed) != actual:
        raise EvidenceBundleError("MANIFEST_MISMATCH")
    for path, item in indexed.items():
        if item["sha256"] != _digest(files[path]) or item["bytes"] != len(files[path]):
            raise EvidenceBundleError("MANIFEST_MISMATCH")
    return manifest


def _attachment_record(value: Any, path: str, payload: bytes, schema: str) -> None:
    record = _exact_keys(value, _ATTACHMENT_KEYS, detail="ATTACHMENT")
    if (
        record["file"] != path
        or record["sha256"] != _digest(payload)
        or record["bytes"] != len(payload)
        or record["schemaVersion"] != schema
    ):
        raise EvidenceBundleError("ATTACHMENT_DIGEST_MISMATCH")


def _consumer_from_value(value: Any) -> ConsumerIdentity:
    item = _exact_keys(value, _CONSUMER_KEYS, detail="CONSUMER_IDENTITY")
    modules = item["modules"]
    if type(modules) is not list:
        raise EvidenceBundleError("BUNDLE_MALFORMED", "CONSUMER_MODULES")
    pairs: list[tuple[str, str]] = []
    for module in modules:
        entry = _exact_keys(module, frozenset({"path", "sha256"}), detail="CONSUMER_MODULE")
        pairs.append((entry["path"], entry["sha256"]))
    try:
        return ConsumerIdentity(item["executedGitSha"], tuple(pairs))
    except (TypeError, ValueError) as exc:
        raise EvidenceBundleError("BUNDLE_MALFORMED", "CONSUMER_IDENTITY") from exc


def _workflow_from_value(value: Any) -> WorkflowStatus:
    item = _exact_keys(value, _WORKFLOW_KEYS, detail="WORKFLOW_STATUS")
    try:
        return WorkflowStatus(item["batchStatus"], item["smokeStatus"])
    except (TypeError, ValueError) as exc:
        raise EvidenceBundleError("WORKFLOW_STATUS_INCONSISTENT") from exc


def _validate_run_identity_value(value: Any) -> dict[str, Any]:
    identity = _exact_keys(value, _RUN_KEYS, detail="RUN_IDENTITY")
    for key in ("repository", "workflow", "job", "event", "gitRef", "gitRefType"):
        if type(identity[key]) is not str or identity[key] == "":
            raise EvidenceBundleError("BUNDLE_MALFORMED", "RUN_IDENTITY")
    if (
        type(identity["runId"]) is not str
        or not _POSITIVE_DECIMAL.fullmatch(identity["runId"])
        or type(identity["runAttempt"]) is not str
        or not _POSITIVE_DECIMAL.fullmatch(identity["runAttempt"])
        or type(identity["gitSha"]) is not str
        or not _GIT_SHA.fullmatch(identity["gitSha"])
    ):
        raise EvidenceBundleError("BUNDLE_MALFORMED", "RUN_IDENTITY")
    return identity


def _verify_privacy(files: Mapping[str, bytes]) -> None:
    for path, payload in files.items():
        if path.endswith(".json"):
            value = _decode(payload, detail="PRIVACY_DOCUMENT")
            _privacy_scan_value(value)
            _privacy_scan_payload(payload)
    report = _decode(files[PRIVACY_REPORT_FILE], detail="PRIVACY_REPORT")
    _exact_keys(report, _PRIVACY_KEYS, detail="PRIVACY_REPORT")
    scanned = {
        path: payload
        for path, payload in files.items()
        if path not in {PRIVACY_REPORT_FILE, MANIFEST_FILE, MANIFEST_DIGEST_FILE}
    }
    if files[PRIVACY_REPORT_FILE] != _privacy_report(scanned):
        raise EvidenceBundleError("BUNDLE_PRIVACY_VIOLATION")


def _source_blob(source_repo: Path, revision: str, path: str) -> bytes:
    if (
        not source_repo.is_absolute()
        or ".." in source_repo.parts
        or _has_symlink_component(source_repo)
        or not source_repo.is_dir()
    ):
        raise EvidenceBundleError("SOURCE_IDENTITY_MISMATCH")
    try:
        completed = subprocess.run(
            ["git", "-C", os.fspath(source_repo), "show", f"{revision}:{path}"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={"PATH": os.environ.get("PATH", "")},
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise EvidenceBundleError("SOURCE_IDENTITY_MISMATCH") from exc
    return completed.stdout


def _verify_source_repo(
    source_repo: Path,
    revision: str,
    producer_modules: list[dict[str, Any]],
    consumer: ConsumerIdentity,
) -> None:
    expected: dict[str, str] = {}
    for item in producer_modules:
        if type(item) is not dict or set(item) != {"path", "sha256"}:
            raise EvidenceBundleError("SOURCE_IDENTITY_MISMATCH")
        expected[item["path"]] = item["sha256"]
    expected.update(dict(consumer.modules))
    for path, digest in expected.items():
        if _digest(_source_blob(source_repo, revision, path)) != digest:
            raise EvidenceBundleError("SOURCE_IDENTITY_MISMATCH")


def _verify_captured(
    files: Mapping[str, bytes], evidence: dict[str, Any], *, source_repo: Path | None
) -> tuple[str, bool]:
    # V7: reconstruct the two identity objects and reuse audited admission.
    reference_value = _exact_keys(evidence["producerReference"], _REFERENCE_KEYS, detail="PRODUCER_REFERENCE")
    try:
        reference = ProducerReference.from_value(reference_value)
    except (HandoffError, KeyError, TypeError, ValueError) as exc:
        raise EvidenceBundleError("PRODUCER_REFERENCE_MISSING") from exc
    expected = _expected_from_value(evidence["expectedBinding"])
    consumer = _consumer_from_value(evidence["consumerIdentity"])
    workflow = _workflow_from_value(evidence["workflowStatus"])
    attachments = _exact_keys(
        evidence["attachments"], frozenset({"observation", "captureInput", "receipt", "envelope"}),
        detail="ATTACHMENTS",
    )
    # Structural lookup only: find the bytes of the candidate observation
    # attachment.  The recorded name is used when it points at a present file;
    # otherwise the name derived from the admitted-shape reference is used.
    # Filename-shape and record semantics are V8 and are applied after V7.
    recorded = attachments["observation"].get("file") if type(attachments["observation"]) is dict else None
    if type(recorded) is str and recorded in files:
        observation_file = recorded
    else:
        observation_file = f"attachments/observation-{reference.observation_digest}.json"
    required = {
        observation_file,
        CAPTURE_ATTACHMENT_FILE,
        RECEIPT_ATTACHMENT_FILE,
        ENVELOPE_ATTACHMENT_FILE,
        DIAGNOSTICS_FILE,
        EVIDENCE_FILE,
        PRIVACY_REPORT_FILE,
        MANIFEST_FILE,
        MANIFEST_DIGEST_FILE,
    }
    if set(files) != required:
        raise EvidenceBundleError("BUNDLE_INCOMPLETE")
    parts = HandoffParts(
        files[CAPTURE_ATTACHMENT_FILE], files[observation_file], files[RECEIPT_ATTACHMENT_FILE], files[ENVELOPE_ATTACHMENT_FILE]
    )
    try:
        validate_handoff_parts(parts, expected, reference)
    except HandoffError as exc:
        raise EvidenceBundleError(exc.code, exc.detail) from exc
    # V8: attachment location and records must identify the already-admitted exact bytes.
    if type(recorded) is not str or not _OBSERVATION_FILE.fullmatch(recorded) or recorded != observation_file:
        raise EvidenceBundleError("ATTACHMENT_DIGEST_MISMATCH")
    _attachment_record(attachments["observation"], observation_file, files[observation_file], OBSERVATION_SCHEMA_VERSION)
    _attachment_record(attachments["captureInput"], CAPTURE_ATTACHMENT_FILE, files[CAPTURE_ATTACHMENT_FILE], CAPTURE_INPUT_SCHEMA_VERSION)
    _attachment_record(attachments["receipt"], RECEIPT_ATTACHMENT_FILE, files[RECEIPT_ATTACHMENT_FILE], RECEIPT_SCHEMA_VERSION)
    _attachment_record(attachments["envelope"], ENVELOPE_ATTACHMENT_FILE, files[ENVELOPE_ATTACHMENT_FILE], HANDOFF_SCHEMA_VERSION)
    observation = parts.observation_value()
    receipt = parts.receipt_value()
    if evidence["runIdentity"] != observation["runIdentity"]:
        raise EvidenceBundleError("RUN_IDENTITY_MISMATCH")
    # V9: receipt and workflow projections remain truthful terminal metadata.
    terminal = _exact_keys(evidence["terminal"], _TERMINAL_KEYS, detail="TERMINAL")
    expected_terminal = {
        "terminalStatus": receipt["terminalStatus"],
        "reportState": receipt["reportState"],
        "transportStatus": receipt["transportStatus"],
        "failureCode": receipt["failureCode"],
        "artifactAvailable": receipt["artifactAvailable"],
        "observationAvailable": receipt["observationDigest"] is not None,
        "producerReferenceAvailable": True,
    }
    if terminal != expected_terminal:
        raise EvidenceBundleError("RECEIPT_PROJECTION_MISMATCH")
    if workflow.batch_status == "batch_passed" and receipt["terminalStatus"] != "BATCH_READY":
        raise EvidenceBundleError("WORKFLOW_STATUS_INCONSISTENT")
    # V10: replayable arithmetic is projection only; no policy reevaluation.
    p14 = _exact_keys(evidence["p14"], _P14_KEYS, detail="P14")
    replay = _exact_keys(evidence["replay"], _REPLAY_KEYS, detail="REPLAY")
    if replay["schemaVersion"] != REPLAY_SCHEMA_VERSION_3 or replay["input"] != {"attachment": "captureInput"}:
        raise EvidenceBundleError("DERIVED_PROJECTION_MISMATCH")
    base_vector = project_rank_vector(observation["base"]["candidates"])
    perturbed_vector = project_rank_vector(observation["perturbed"]["candidates"])
    base_top = _top_codes(base_vector)
    perturbed_top = _top_codes(perturbed_vector)
    gate = next(item for item in receipt["report"]["qualityGate"]["gates"] if item["id"] == "P-14")
    release = receipt["report"]["qualityGate"]["p14ReleaseEvidence"]
    derived_p14 = {
        "verdict": gate["status"],
        "jaccard": gate["value"],
        "swapCount": _swap_count(base_top, perturbed_top),
        "baseTop40": base_top,
        "perturbedTop40": perturbed_top,
        "release": release,
    }
    expected_replay = {
        "schemaVersion": REPLAY_SCHEMA_VERSION_3,
        "input": {"attachment": "captureInput"},
        "baseFullOrderedRankVector": base_vector,
        "perturbedFullOrderedRankVector": perturbed_vector,
        "boundaryOutsideBand": {
            "topK": 40, "size": 10, "base": base_vector[40:50], "perturbed": perturbed_vector[40:50]
        },
    }
    if p14 != derived_p14 or replay != expected_replay:
        raise EvidenceBundleError("DERIVED_PROJECTION_MISMATCH")
    if gate["value"] != _jaccard(base_top, perturbed_top) or release["top40"]["jaccard"] != gate["value"]:
        raise EvidenceBundleError("DERIVED_PROJECTION_MISMATCH")
    if evidence["confidenceInvariant"] != observation["diagnosticAvailability"]["confidenceInvariant"]:
        raise EvidenceBundleError("DERIVED_PROJECTION_MISMATCH")
    # V11: diagnostics are re-derived from the canonical observation.
    diagnostic_record = _exact_keys(
        evidence["diagnostics"], frozenset({"file", "sha256", "bytes", "diagnosticsVersion"}),
        detail="DIAGNOSTICS",
    )
    expected_diagnostics = _diagnostics_bytes(observation)
    if (
        diagnostic_record != {
            "file": DIAGNOSTICS_FILE, "sha256": _digest(expected_diagnostics),
            "bytes": len(expected_diagnostics), "diagnosticsVersion": DIAGNOSTICS_SCHEMA_VERSION,
        }
        or files[DIAGNOSTICS_FILE] != expected_diagnostics
    ):
        raise EvidenceBundleError("DIAGNOSTICS_MISMATCH")
    try:
        decode_reference_diagnostics(files[DIAGNOSTICS_FILE])
    except DiagnosticContractError as exc:
        raise EvidenceBundleError("DIAGNOSTICS_MISMATCH") from exc
    # V12: scan every document and reproduce the intrinsic privacy report.
    _verify_privacy(files)
    # V13: source identity is byte-checked only when an explicit local repo is supplied.
    if consumer.executed_git_sha != reference.executed_git_sha:
        raise EvidenceBundleError("SOURCE_IDENTITY_MISMATCH")
    if source_repo is not None:
        _verify_source_repo(
            source_repo, reference.executed_git_sha, observation["sourceIdentity"]["modules"], consumer
        )
    return receipt["terminalStatus"], receipt["artifactAvailable"]


def _verify_schema3(files: Mapping[str, bytes], *, source_repo: Path | None) -> VerificationReport:
    # V2 then V3/V3a/V4: completion marker, schema dispatch, and manifest integrity.
    _manifest_digest(files[MANIFEST_DIGEST_FILE], files[MANIFEST_FILE])
    manifest = _manifest_value(files)
    # V5: evidence schema and capture-status-specific exact key set.
    evidence = _decode(files.get(EVIDENCE_FILE, b""), detail="EVIDENCE")
    if type(evidence) is not dict:
        raise EvidenceBundleError("BUNDLE_MALFORMED", "EVIDENCE")
    capture_status = evidence.get("captureStatus")
    if capture_status == "captured":
        _exact_keys(evidence, _CAPTURED_EVIDENCE_KEYS, detail="EVIDENCE")
    elif capture_status == "invalid":
        _exact_keys(evidence, _INVALID_EVIDENCE_KEYS, detail="EVIDENCE")
    else:
        raise EvidenceBundleError("BUNDLE_MALFORMED", "CAPTURE_STATUS")
    if evidence["schemaVersion"] != BUNDLE_SCHEMA_VERSION:
        raise EvidenceBundleError("UNSUPPORTED_BUNDLE_SCHEMA")
    if evidence["bundleId"] != manifest["bundleId"]:
        raise EvidenceBundleError("MANIFEST_MISMATCH")
    if capture_status == "invalid":
        # V6: a minimal invalid bundle has typed failure data and no attachments.
        required = {EVIDENCE_FILE, PRIVACY_REPORT_FILE, MANIFEST_FILE, MANIFEST_DIGEST_FILE}
        if set(files) != required:
            raise EvidenceBundleError("BUNDLE_INCOMPLETE")
        failure = _exact_keys(evidence["failure"], frozenset({"code", "detail", "stage"}), detail="FAILURE")
        if (
            failure["code"] not in _BUNDLE_ERROR_CODES
            or failure["stage"] not in _FAILURE_STAGES
            or (failure["detail"] is not None and (
                type(failure["detail"]) is not str or not _SAFE_DETAIL.fullmatch(failure["detail"])
            ))
        ):
            raise EvidenceBundleError("BUNDLE_MALFORMED", "FAILURE")
        if evidence["consumerIdentity"] is not None:
            _consumer_from_value(evidence["consumerIdentity"])
        if evidence["runIdentity"] is not None:
            _validate_run_identity_value(evidence["runIdentity"])
        _workflow_from_value(evidence["workflowStatus"])
        _verify_privacy(files)
        return VerificationReport("SCHEMA3_RUN_EVIDENCE", "PASS", "INVALID", None, None, ())
    terminal, artifact = _verify_captured(files, evidence, source_repo=source_repo)
    return VerificationReport("SCHEMA3_RUN_EVIDENCE", "PASS", "VALID", terminal, artifact, ())


def verify_bundle_files(
    files: Mapping[str, bytes], *, source_repo: Path | None = None
) -> VerificationReport:
    """Perform ordered V1-V13 verification without network or repository discovery."""
    terminal: str | None = None
    artifact: bool | None = None
    try:
        # V1: closed, bounded, storage-safe immutable file map.
        owned = _v1_file_map(files)
        _manifest_digest(owned[MANIFEST_DIGEST_FILE], owned[MANIFEST_FILE])
        # V3 dispatch: a legacy schema identifier routes out before any
        # schema-3-only exact-key validation is applied to the manifest.
        if _declares_legacy_schema(owned[MANIFEST_FILE]):
            return VerificationReport("LEGACY_RUN_EVIDENCE", "FAIL", "N/A", None, None, ())
        return _verify_schema3(owned, source_repo=source_repo)
    except HandoffError as exc:
        error = _VerificationError(exc.code, exc.detail)
    except EvidenceBundleError as exc:
        error = _VerificationError(exc.code, exc.detail)
    except (DiagnosticContractError, ObservationContractError, StrictJSONError, StopIteration, KeyError, TypeError, ValueError):
        error = _VerificationError("BUNDLE_MALFORMED", None)
    return VerificationReport("SCHEMA3_RUN_EVIDENCE", "FAIL", "N/A", terminal, artifact, (error,))


def _raise_for_report(report: VerificationReport) -> None:
    if report.bundle_integrity != "PASS":
        error = report.errors[0] if report.errors else _VerificationError("BUNDLE_MALFORMED")
        raise EvidenceBundleError(error.code, error.detail)


def read_bundle_directory(path: str | os.PathLike[str]) -> BundleFiles:
    """Read a complete schema-3 directory without following links."""
    root = Path(path)
    if not root.is_absolute() or ".." in root.parts or _has_symlink_component(root):
        raise EvidenceBundleError("BUNDLE_LOCATION_INVALID")
    try:
        root_info = root.lstat()
    except OSError as exc:
        raise EvidenceBundleError("BUNDLE_LOCATION_INVALID") from exc
    if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
        raise EvidenceBundleError("BUNDLE_LOCATION_INVALID")
    files: dict[str, bytes] = {}
    total = 0
    try:
        entries = list(root.rglob("*"))
    except OSError as exc:
        raise EvidenceBundleError("BUNDLE_LOCATION_INVALID") from exc
    for entry in entries:
        relative = entry.relative_to(root).as_posix()
        info = entry.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise EvidenceBundleError("BUNDLE_LOCATION_INVALID")
        if stat.S_ISDIR(info.st_mode):
            if relative not in {"attachments", "validation"}:
                raise EvidenceBundleError("BUNDLE_LOCATION_INVALID")
            continue
        if not stat.S_ISREG(info.st_mode) or not _path_safe(relative) or info.st_size > MAX_FILE_BYTES:
            raise EvidenceBundleError("BUNDLE_LOCATION_INVALID")
        payload = entry.read_bytes()
        if len(payload) != info.st_size:
            raise EvidenceBundleError("BUNDLE_LOCATION_INVALID")
        total += len(payload)
        if total > MAX_TOTAL_BYTES:
            raise EvidenceBundleError("BUNDLE_MALFORMED", "TOTAL_SIZE")
        files[relative] = payload
    bundle = BundleFiles(files)
    report = verify_bundle_files(bundle)
    _raise_for_report(report)
    evidence = _decode(bundle[EVIDENCE_FILE], detail="EVIDENCE")
    if evidence["bundleId"] != root.name:
        raise EvidenceBundleError("BUNDLE_LOCATION_INVALID", "BUNDLE_ID")
    return bundle


def read_bundle_zip(path: str | os.PathLike[str] | bytes | bytearray | memoryview | io.BytesIO) -> BundleFiles:
    """Read one in-memory ZIP root safely; never extract to the filesystem."""
    source: Any
    if isinstance(path, (bytes, bytearray, memoryview)):
        source = io.BytesIO(bytes(path))
    elif isinstance(path, io.BytesIO):
        source = path
    else:
        candidate = Path(path)
        if not candidate.is_absolute() or ".." in candidate.parts or _has_symlink_component(candidate):
            raise EvidenceBundleError("BUNDLE_LOCATION_INVALID")
        source = candidate
    try:
        with zipfile.ZipFile(source, "r") as archive:
            names: set[str] = set()
            roots: set[str] = set()
            files: dict[str, bytes] = {}
            total = 0
            for info in archive.infolist():
                name = info.filename
                if name in names:
                    raise EvidenceBundleError("BUNDLE_LOCATION_INVALID", "DUPLICATE")
                names.add(name)
                parsed = PurePosixPath(name)
                if not _path_safe(name.rstrip("/")) or info.flag_bits & 0x1 or stat.S_ISLNK(info.external_attr >> 16):
                    raise EvidenceBundleError("BUNDLE_LOCATION_INVALID")
                if (info.is_dir() and len(parsed.parts) < 1) or (not info.is_dir() and len(parsed.parts) < 2):
                    raise EvidenceBundleError("BUNDLE_LOCATION_INVALID")
                roots.add(parsed.parts[0])
                if info.is_dir():
                    relative_directory = PurePosixPath(*parsed.parts[1:]).as_posix()
                    if relative_directory not in {".", "attachments", "validation"}:
                        raise EvidenceBundleError("BUNDLE_LOCATION_INVALID")
                    continue
                relative = PurePosixPath(*parsed.parts[1:]).as_posix()
                if not _path_safe(relative) or info.file_size > MAX_FILE_BYTES:
                    raise EvidenceBundleError("BUNDLE_MALFORMED", "FILE_SIZE")
                if relative in files:
                    raise EvidenceBundleError("BUNDLE_LOCATION_INVALID", "DUPLICATE")
                payload = archive.read(info)
                if len(payload) != info.file_size:
                    raise EvidenceBundleError("BUNDLE_MALFORMED", "ZIP_SIZE")
                total += len(payload)
                if total > MAX_TOTAL_BYTES:
                    raise EvidenceBundleError("BUNDLE_MALFORMED", "TOTAL_SIZE")
                files[relative] = payload
    except EvidenceBundleError:
        raise
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile, RuntimeError) as exc:
        raise EvidenceBundleError("BUNDLE_MALFORMED", "ZIP") from exc
    if len(roots) != 1:
        raise EvidenceBundleError("BUNDLE_LOCATION_INVALID", "ZIP_ROOT")
    bundle = BundleFiles(files)
    report = verify_bundle_files(bundle)
    _raise_for_report(report)
    evidence = _decode(bundle[EVIDENCE_FILE], detail="EVIDENCE")
    if next(iter(roots)) != evidence["bundleId"]:
        raise EvidenceBundleError("BUNDLE_LOCATION_INVALID", "BUNDLE_ID")
    return bundle


def install_bundle(out_root: str | os.PathLike[str], files: Mapping[str, bytes]) -> Path:
    """Install verified bytes once, with manifest.sha256 as the final marker."""
    bundle = BundleFiles(files)
    report = verify_bundle_files(bundle)
    _raise_for_report(report)
    evidence = _decode(bundle[EVIDENCE_FILE], detail="EVIDENCE")
    bundle_id = evidence["bundleId"]
    root = Path(out_root)
    repository_root = Path(__file__).resolve().parent.parent
    if not root.is_absolute() or ".." in root.parts or _has_symlink_component(root):
        raise EvidenceBundleError("BUNDLE_LOCATION_INVALID")
    resolved = root.resolve(strict=False)
    try:
        resolved.relative_to(repository_root)
    except ValueError:
        pass
    else:
        raise EvidenceBundleError("BUNDLE_LOCATION_INVALID")
    created_root = False
    try:
        if resolved.exists():
            require_private_directory(resolved)
        else:
            if not resolved.parent.is_dir():
                raise EvidenceBundleError("BUNDLE_LOCATION_INVALID")
            resolved.mkdir(mode=0o700, parents=False, exist_ok=False)
            require_private_directory(resolved)
            created_root = True
        if created_root:
            _fsync_directory(resolved.parent)
        destination = resolved / bundle_id
        destination.mkdir(mode=0o700, parents=False, exist_ok=False)
        require_private_directory(destination)
        _fsync_directory(resolved)
    except FileExistsError as exc:
        raise EvidenceBundleError("BUNDLE_ALREADY_EXISTS") from exc
    except HandoffError as exc:
        raise EvidenceBundleError("BUNDLE_LOCATION_INVALID", exc.code) from exc
    except OSError as exc:
        raise EvidenceBundleError("BUNDLE_WRITE_FAILED") from exc
    order = [
        *sorted(path for path in bundle if path.startswith("attachments/")),
        DIAGNOSTICS_FILE,
        EVIDENCE_FILE,
        PRIVACY_REPORT_FILE,
        MANIFEST_FILE,
        MANIFEST_DIGEST_FILE,
    ]
    order = [path for path in order if path in bundle]
    try:
        for path in order:
            parent = destination / PurePosixPath(path).parent
            if parent != destination and not parent.exists():
                parent.mkdir(mode=0o700, parents=False, exist_ok=False)
                require_private_directory(parent)
                _fsync_directory(destination)
            install_file_no_overwrite(parent, PurePosixPath(path).name, bundle[path])
        _fsync_directory(destination)
    except HandoffError as exc:
        raise EvidenceBundleError("BUNDLE_WRITE_FAILED", exc.code) from exc
    except OSError as exc:
        raise EvidenceBundleError("BUNDLE_WRITE_FAILED") from exc
    return destination


def main(argv: list[str] | None = None) -> int:
    """Verification-only CLI; exit zero means integrity PASS, nothing more."""
    parser = argparse.ArgumentParser(prog="p14_run_evidence_bundle")
    subparsers = parser.add_subparsers(dest="command", required=True)
    verify = subparsers.add_parser("verify")
    verify.add_argument("bundle")
    verify.add_argument("--source-repo", type=Path, default=None)
    args = parser.parse_args(argv)
    try:
        target_input = Path(args.bundle)
        if ".." in target_input.parts:
            raise EvidenceBundleError("BUNDLE_LOCATION_INVALID")
        target = target_input if target_input.is_absolute() else (Path.cwd() / target_input).resolve(strict=False)
        source_repo = args.source_repo
        if source_repo is not None:
            if ".." in source_repo.parts:
                raise EvidenceBundleError("SOURCE_IDENTITY_MISMATCH")
            source_repo = source_repo if source_repo.is_absolute() else (Path.cwd() / source_repo).resolve(strict=False)
        files = read_bundle_zip(target) if target.suffix.lower() == ".zip" else read_bundle_directory(target)
        report = verify_bundle_files(files, source_repo=source_repo)
    except EvidenceBundleError as exc:
        report = VerificationReport(
            "SCHEMA3_RUN_EVIDENCE", "FAIL", "N/A", None, None,
            (_VerificationError(exc.code, exc.detail),),
        )
    sys.stdout.buffer.write(canonical_json_bytes(report.to_value()) + b"\n")
    return 0 if report.bundle_integrity == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
