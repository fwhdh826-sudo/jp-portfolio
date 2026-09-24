"""Dormant Phase II-A P-14 handoff and bounded run-local storage.

The module owns transport validation and storage only.  It does not import or
execute the candidate funnel engine, batch producer, evidence consumer, policy
dispatcher, classifier, or diagnostics implementation.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from data.p14_observation import (
    ALL_TIERS,
    CANDIDATE_PROJECTION_FIELDS,
    OBSERVATION_SCHEMA_VERSION,
    REPLAY_CANDIDATE_FIELDS,
    CanonicalP14Observation,
    ObservationContractError,
    canonical_json_bytes,
    make_canonical_p14_observation,
)

HANDOFF_SCHEMA_VERSION = "p14-handoff-1"
RECEIPT_SCHEMA_VERSION = "p14-handoff-receipt-1"
CAPTURE_INPUT_SCHEMA_VERSION = "p14-capture-input-1"

CAPTURE_INPUT_FILE = "capture-input.json"
RECEIPT_FILE = "batch-receipt.json"
HANDOFF_FILE = "handoff.json"
CLAIM_FILE = ".claim"

FIXED_MODULE_PATHS = (
    "data/candidate_funnel_batch.py",
    "data/candidate_funnel_engine.py",
    "data/candidate_funnel_privacy_smoke.py",
    "data/p14_evidence_privacy_filter.py",
    "data/p14_handoff.py",
    "data/p14_observation.py",
    "data/p14_policy_dispatch.py",
    "data/p14_reference_classifier.py",
)
RAW_FILE_NAMES = (
    "candidatesStocks",
    "prescreenMetadata",
    "regimeState",
    "previousArtifact",
)

EXPECTED_PARAMETERS = {
    "topK": 40,
    "perturbationPct": 0.02,
    "assignmentContract": "p14-prescreen-rank-code-v1",
    "shortlistN": 3,
    "eligibleTiers": ["deep_review", "actionable"],
    "top40WarnMin": 0.95,
    "top40HardMin": 0.80,
    "actionableExitWarnMin": 2,
    "actionableExitHardMin": 3,
}

FORBIDDEN_KEYS = frozenset(
    {
        "portfolioFit", "portfolio", "holdings", "cash", "reserve", "amount",
        "maxAmount", "sizing", "headroom", "quantity", "purchasePrice",
        "marketValue", "officialDecision", "action", "BUY_NEW", "WATCH", "SELL",
        "account", "accountType", "broker", "nisa", "csv", "blockedReasons",
        "normalizedPrescreenScore", "eval", "pnlPct", "purchase_date", "acquiredAt",
    }
)
SECRET_PATTERN_TEXTS = (
    r"gh[pousr]_[A-Za-z0-9]{36,}",
    r"github_pat_[A-Za-z0-9_]{20,}",
)
PRIVATE_PATH_PATTERN_TEXTS = (
    r"/Users/[^/\s\"']+(?:/[^/\s\"']+)*",
    r"/home/[^/\s\"']+(?:/[^/\s\"']+)*",
)
SECRET_PATTERNS = tuple(re.compile(value) for value in SECRET_PATTERN_TEXTS)
PRIVATE_PATH_PATTERNS = tuple(re.compile(value) for value in PRIVATE_PATH_PATTERN_TEXTS)

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_GIT_SHA = re.compile(r"^[0-9a-f]{40}$")
_POSITIVE_DECIMAL = re.compile(r"^[1-9][0-9]*$")
_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9._-]+$")

TERMINAL_STATUSES = frozenset(
    {
        "BATCH_READY", "QUALITY_GATE_FAILED", "NOT_GENERATED",
        "SCHEMA_VIOLATIONS", "BATCH_INPUT_ERROR", "BATCH_EXCEPTION",
    }
)
TRANSPORT_STATUSES = frozenset(
    {
        "READY", "CANONICAL_CONSTRUCTION_FAILED", "HANDOFF_WRITE_FAILED",
        "CAPTURE_CONFIGURATION_INVALID", "INPUT_IDENTITY_UNAVAILABLE",
        "P14_NOT_EVALUATED", "RECEIPT_CONSTRUCTION_FAILED",
    }
)
HANDOFF_ERROR_CODES = frozenset(
    {
        "PRODUCER_REFERENCE_MISSING", "HANDOFF_MISSING", "HANDOFF_MALFORMED",
        "HANDOFF_UNKNOWN_KEY", "HANDOFF_PRIVACY_VIOLATION",
        "OBSERVATION_DIGEST_MISMATCH", "TRANSPORT_DIGEST_MISMATCH",
        "BATCH_RECEIPT_INVALID", "INPUT_IDENTITY_MISMATCH", "RUN_ID_MISMATCH",
        "RUN_ATTEMPT_MISMATCH", "RUN_IDENTITY_MISMATCH", "POLICY_BINDING_MISMATCH",
        "UNSUPPORTED_OBSERVATION_SCHEMA", "UNSUPPORTED_HANDOFF_SCHEMA",
        "UNSUPPORTED_RECEIPT_SCHEMA", "UNSUPPORTED_CAPTURE_INPUT_SCHEMA",
        "SOURCE_IDENTITY_MISMATCH", "RECEIPT_OBSERVATION_MISMATCH", "STALE_HANDOFF",
        "DUPLICATE_PRODUCER_OUTPUT", "HANDOFF_LOCATION_INVALID", "HANDOFF_WRITE_FAILED",
    }
)
MALFORMED_DETAILS = frozenset(
    {
        "JSON_SYNTAX", "TRAILING_DATA", "TYPE", "NONCANONICAL_ENCODING",
        "INVALID_UTF8", "DUPLICATE_KEY", "NONFINITE_JSON",
    }
)

_OBSERVATION_KEYS = frozenset(
    {
        "schemaVersion", "policyVersion", "runIdentity", "sourceIdentity",
        "inputIdentity", "parameters", "base", "perturbed", "diagnosticAvailability",
    }
)
_RUN_KEYS = frozenset(
    {"repository", "workflow", "job", "runId", "runAttempt", "event", "gitRef", "gitRefType", "gitSha"}
)
_SOURCE_KEYS = frozenset(
    {"executedGitSha", "modules", "engineSchemaVersion", "engineScoreVersion", "engineFunnelVersion"}
)
_INPUT_KEYS = frozenset({"rawFiles", "joinedCandidateInput", "replayContext", "captureInput"})
_SIDE_KEYS = frozenset({"engineStatus", "candidates", "selectionObservability"})
_SELECTION_KEYS = frozenset(
    {
        "regimeApplied", "actionableHardMaxApplied", "actionableSectorCapApplied",
        "deepReviewHardMaxApplied", "deepReviewSectorCapApplied",
        "deepReviewSectorCapRelaxed", "actionableSectorCapRelaxed",
        "deepReviewEligibleCount", "deepReviewSelectedCount", "actionableEligibleCount",
        "actionableSelectedCount", "sourceStale", "fallbackProvenance",
    }
)
_AVAILABILITY_KEYS = frozenset({"internalDataConfidence", "exactCause", "confidenceInvariant"})
_CONFIDENCE_KEYS = frozenset(
    {"state", "basis", "comparedCount", "totalCount", "mismatchedCodes", "unavailableCodes", "reason"}
)
_CAPTURE_KEYS = frozenset(
    {"schemaVersion", "joinedCandidateInput", "context", "joinStats", "sourceUpdatedAt", "candidatesUpdatedAt"}
)
_CONTEXT_KEYS = frozenset(
    {"pipelinePath", "regime", "sourceUpdatedAt", "asOf", "staleThresholdHours", "prescreenFallbackUsed"}
)
_JOIN_KEYS = frozenset(
    {
        "candidateCount", "prescreenCount", "joinedCount", "unmatchedCandidateCount",
        "unmatchedPrescreenCount", "joinRate", "unmatchedCandidateRate",
    }
)
_RECEIPT_KEYS = frozenset(
    {
        "schemaVersion", "runIdentity", "policyVersion", "executedGitSha",
        "observationDigest", "captureInputDigest", "terminalStatus", "artifactAvailable",
        "transportStatus", "failureCode", "reportState", "report",
    }
)
_ENVELOPE_KEYS = frozenset(
    {
        "schemaVersion", "observationSchemaVersion", "receiptSchemaVersion",
        "captureInputSchemaVersion", "policyVersion", "runIdentity", "executedGitSha",
        "observation", "captureInput", "receipt",
    }
)
_REFERENCE_KEYS = frozenset(
    {
        "status", "transportDigest", "observationDigest", "receiptDigest",
        "captureInputDigest", "executedGitSha", "observationSchemaVersion",
        "handoffSchemaVersion", "policyVersion", "runId", "runAttempt",
    }
)


class HandoffError(ValueError):
    """Fail-closed transport error with only stable, safe identifiers."""

    def __init__(self, code: str, detail: str | None = None):
        if code not in HANDOFF_ERROR_CODES:
            raise ValueError("unsupported handoff error code")
        if detail is not None and (type(detail) is not str or not _SAFE_SEGMENT.fullmatch(detail)):
            raise ValueError("handoff error detail must be a safe enum")
        self.code = code
        self.detail = detail
        super().__init__(code if detail is None else f"{code}:{detail}")


@dataclass(frozen=True, slots=True)
class DigestBinding:
    sha256: str
    bytes: int

    def __post_init__(self) -> None:
        _require_digest(self.sha256, "digest")
        _require_nonnegative_int(self.bytes, "bytes")


@dataclass(frozen=True, slots=True)
class RawFileBinding:
    name: str
    present: bool
    sha256: str | None
    bytes: int | None

    def __post_init__(self) -> None:
        if self.name not in RAW_FILE_NAMES or type(self.present) is not bool:
            raise ValueError("invalid raw-file binding")
        if self.present:
            _require_digest(self.sha256, "raw file digest")
            _require_nonnegative_int(self.bytes, "raw file bytes")
        elif self.sha256 is not None or self.bytes is not None:
            raise ValueError("absent raw file must have null digest and bytes")


@dataclass(frozen=True, slots=True)
class ModuleBinding:
    path: str
    sha256: str

    def __post_init__(self) -> None:
        if self.path not in FIXED_MODULE_PATHS:
            raise ValueError("unsupported source module path")
        _require_digest(self.sha256, "module digest")


@dataclass(frozen=True, slots=True)
class ExpectedBinding:
    repository: str
    workflow: str
    job: str
    run_id: str
    run_attempt: str
    event: str
    git_ref: str
    git_ref_type: str
    event_git_sha: str
    executed_git_sha: str
    policy_version: str
    engine_schema_version: str
    engine_score_version: str
    engine_funnel_version: str
    modules: tuple[ModuleBinding, ...]
    raw_files: tuple[RawFileBinding, ...]
    joined_candidate_input: DigestBinding
    replay_context: DigestBinding
    capture_input: DigestBinding

    def __post_init__(self) -> None:
        for value in (
            self.repository, self.workflow, self.job, self.event, self.git_ref,
            self.git_ref_type, self.policy_version, self.engine_schema_version,
            self.engine_score_version, self.engine_funnel_version,
        ):
            _require_identity_string(value)
        _require_positive_decimal(self.run_id, "run id")
        _require_positive_decimal(self.run_attempt, "run attempt")
        _require_git_sha(self.event_git_sha, "event git sha")
        _require_git_sha(self.executed_git_sha, "executed git sha")
        if self.workflow != "full_batch.yml" or self.job != "update-data":
            raise ValueError("unsupported workflow/job binding")
        if tuple(item.path for item in self.modules) != FIXED_MODULE_PATHS:
            raise ValueError("module bindings must be the exact sorted fixed module set")
        if tuple(item.name for item in self.raw_files) != RAW_FILE_NAMES:
            raise ValueError("raw-file bindings must be the exact fixed input set")


@dataclass(frozen=True, slots=True)
class ProducerReference:
    status: str
    transport_digest: str
    observation_digest: str
    receipt_digest: str
    capture_input_digest: str
    executed_git_sha: str
    observation_schema_version: str
    handoff_schema_version: str
    policy_version: str
    run_id: str
    run_attempt: str

    def __post_init__(self) -> None:
        if self.status != "READY":
            raise HandoffError("PRODUCER_REFERENCE_MISSING", "INVALID_STATUS")
        for value in (
            self.transport_digest, self.observation_digest, self.receipt_digest,
            self.capture_input_digest,
        ):
            _require_digest(value, "producer digest")
        _require_git_sha(self.executed_git_sha, "producer executed sha")
        _require_positive_decimal(self.run_id, "producer run id")
        _require_positive_decimal(self.run_attempt, "producer run attempt")
        for value in (self.observation_schema_version, self.handoff_schema_version, self.policy_version):
            _require_identity_string(value)

    def to_value(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "transportDigest": self.transport_digest,
            "observationDigest": self.observation_digest,
            "receiptDigest": self.receipt_digest,
            "captureInputDigest": self.capture_input_digest,
            "executedGitSha": self.executed_git_sha,
            "observationSchemaVersion": self.observation_schema_version,
            "handoffSchemaVersion": self.handoff_schema_version,
            "policyVersion": self.policy_version,
            "runId": self.run_id,
            "runAttempt": self.run_attempt,
        }

    @classmethod
    def from_value(cls, value: Mapping[str, Any]) -> "ProducerReference":
        _require_exact_keys(value, _REFERENCE_KEYS, "producer reference")
        return cls(
            status=value["status"],
            transport_digest=value["transportDigest"],
            observation_digest=value["observationDigest"],
            receipt_digest=value["receiptDigest"],
            capture_input_digest=value["captureInputDigest"],
            executed_git_sha=value["executedGitSha"],
            observation_schema_version=value["observationSchemaVersion"],
            handoff_schema_version=value["handoffSchemaVersion"],
            policy_version=value["policyVersion"],
            run_id=value["runId"],
            run_attempt=value["runAttempt"],
        )


@dataclass(frozen=True, slots=True)
class HandoffParts:
    capture_input_bytes: bytes
    observation_bytes: bytes
    receipt_bytes: bytes
    envelope_bytes: bytes

    def __post_init__(self) -> None:
        if any(type(value) is not bytes for value in (
            self.capture_input_bytes, self.observation_bytes, self.receipt_bytes, self.envelope_bytes
        )):
            raise TypeError("handoff parts must be immutable bytes")

    def capture_input_value(self) -> dict[str, Any]:
        return _decode_canonical(self.capture_input_bytes)

    def observation_value(self) -> dict[str, Any]:
        return _decode_canonical(self.observation_bytes)

    def receipt_value(self) -> dict[str, Any]:
        return _decode_canonical(self.receipt_bytes)

    def envelope_value(self) -> dict[str, Any]:
        return _decode_canonical(self.envelope_bytes)


@dataclass(frozen=True, slots=True)
class AttemptClaim:
    root: str
    attempt_directory: str
    run_id: str
    run_attempt: str


class _DuplicateKey(Exception):
    pass


class _NonfiniteJSON(Exception):
    pass


def _require_exact_keys(value: Any, expected: frozenset[str], label: str) -> dict[str, Any]:
    if type(value) is not dict:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    if set(value) != expected:
        raise HandoffError("HANDOFF_UNKNOWN_KEY")
    return value


def _require_nonnegative_int(value: Any, label: str) -> int:
    if type(value) is not int or value < 0:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    return value


def _require_positive_int(value: Any, label: str) -> int:
    if type(value) is not int or value <= 0:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    return value


def _require_finite_number(value: Any, label: str, *, nullable: bool = False) -> int | float | None:
    if value is None and nullable:
        return None
    if type(value) not in (int, float) or (type(value) is float and not math.isfinite(value)):
        raise HandoffError("HANDOFF_MALFORMED", "NONFINITE_JSON" if type(value) is float else "TYPE")
    return value


def _require_string(value: Any, label: str, *, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if type(value) is not str or value == "":
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    _scan_string(value)
    return value


def _require_identity_string(value: Any) -> str:
    result = _require_string(value, "identity")
    assert result is not None
    return result


def _require_positive_decimal(value: Any, label: str) -> str:
    if type(value) is not str or _POSITIVE_DECIMAL.fullmatch(value) is None:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    return value


def _require_digest(value: Any, label: str) -> str:
    if type(value) is not str or _SHA256.fullmatch(value) is None:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    return value


def _require_git_sha(value: Any, label: str) -> str:
    if type(value) is not str or _GIT_SHA.fullmatch(value) is None:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    return value


def _scan_string(value: str) -> None:
    if any(pattern.search(value) for pattern in SECRET_PATTERNS + PRIVATE_PATH_PATTERNS):
        raise HandoffError("HANDOFF_PRIVACY_VIOLATION")


def _privacy_scan(value: Any) -> None:
    if type(value) is dict:
        for key, child in value.items():
            if key in FORBIDDEN_KEYS:
                raise HandoffError("HANDOFF_PRIVACY_VIOLATION")
            _scan_string(key)
            _privacy_scan(child)
    elif type(value) is list:
        for child in value:
            _privacy_scan(child)
    elif type(value) is str:
        _scan_string(value)


def _object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKey
        result[key] = value
    return result


def _reject_nonfinite(token: str) -> Any:
    raise _NonfiniteJSON


def _walk_finite(value: Any) -> None:
    if type(value) is float and not math.isfinite(value):
        raise _NonfiniteJSON
    if type(value) is dict:
        for child in value.values():
            _walk_finite(child)
    elif type(value) is list:
        for child in value:
            _walk_finite(child)


def _decode_canonical(payload: bytes) -> Any:
    if type(payload) is not bytes:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    try:
        text = payload.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise HandoffError("HANDOFF_MALFORMED", "INVALID_UTF8") from exc
    decoder = json.JSONDecoder(object_pairs_hook=_object_pairs, parse_constant=_reject_nonfinite)
    try:
        value, end = decoder.raw_decode(text)
    except _DuplicateKey as exc:
        raise HandoffError("HANDOFF_MALFORMED", "DUPLICATE_KEY") from exc
    except _NonfiniteJSON as exc:
        raise HandoffError("HANDOFF_MALFORMED", "NONFINITE_JSON") from exc
    except (json.JSONDecodeError, ValueError) as exc:
        raise HandoffError("HANDOFF_MALFORMED", "JSON_SYNTAX") from exc
    if text[end:].strip():
        raise HandoffError("HANDOFF_MALFORMED", "TRAILING_DATA")
    try:
        _walk_finite(value)
        encoded = canonical_json_bytes(value)
    except _NonfiniteJSON as exc:
        raise HandoffError("HANDOFF_MALFORMED", "NONFINITE_JSON") from exc
    except Exception as exc:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE") from exc
    if encoded != payload:
        raise HandoffError("HANDOFF_MALFORMED", "NONCANONICAL_ENCODING")
    _privacy_scan(value)
    return value


def _digest_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _validate_digest_record(value: Any) -> DigestBinding:
    record = _require_exact_keys(value, frozenset({"sha256", "bytes"}), "digest record")
    return DigestBinding(record["sha256"], record["bytes"])


def _validate_raw_record(name: str, value: Any) -> RawFileBinding:
    record = _require_exact_keys(value, frozenset({"present", "sha256", "bytes"}), "raw file record")
    return RawFileBinding(name, record["present"], record["sha256"], record["bytes"])


def _validate_run_identity(value: Any) -> dict[str, Any]:
    run = _require_exact_keys(value, _RUN_KEYS, "run identity")
    for key in _RUN_KEYS:
        _require_identity_string(run[key])
    _require_positive_decimal(run["runId"], "run id")
    _require_positive_decimal(run["runAttempt"], "run attempt")
    _require_git_sha(run["gitSha"], "event git sha")
    if run["workflow"] != "full_batch.yml" or run["job"] != "update-data":
        raise HandoffError("RUN_IDENTITY_MISMATCH")
    return run


def _validate_source_identity(value: Any) -> dict[str, Any]:
    source = _require_exact_keys(value, _SOURCE_KEYS, "source identity")
    _require_git_sha(source["executedGitSha"], "executed git sha")
    for key in ("engineSchemaVersion", "engineScoreVersion", "engineFunnelVersion"):
        _require_identity_string(source[key])
    modules = source["modules"]
    if type(modules) is not list or len(modules) != len(FIXED_MODULE_PATHS):
        raise HandoffError("SOURCE_IDENTITY_MISMATCH", "MODULE_SET")
    paths: list[str] = []
    for module in modules:
        item = _require_exact_keys(module, frozenset({"path", "sha256"}), "source module")
        _require_string(item["path"], "module path")
        _require_digest(item["sha256"], "module digest")
        paths.append(item["path"])
    if tuple(paths) != FIXED_MODULE_PATHS:
        raise HandoffError("SOURCE_IDENTITY_MISMATCH", "MODULE_SET")
    return source


def _validate_input_identity(value: Any) -> dict[str, Any]:
    identity = _require_exact_keys(value, _INPUT_KEYS, "input identity")
    raw = _require_exact_keys(identity["rawFiles"], frozenset(RAW_FILE_NAMES), "raw files")
    for name in RAW_FILE_NAMES:
        _validate_raw_record(name, raw[name])
    for name in ("joinedCandidateInput", "replayContext", "captureInput"):
        _validate_digest_record(identity[name])
    return identity


def _validate_selection_observability(value: Any) -> None:
    item = _require_exact_keys(value, _SELECTION_KEYS, "selection observability")
    _require_string(item["regimeApplied"], "regime applied", nullable=True)
    for key in (
        "actionableHardMaxApplied", "actionableSectorCapApplied", "deepReviewHardMaxApplied",
        "deepReviewSectorCapApplied",
    ):
        if item[key] is not None:
            _require_positive_int(item[key], key)
    for key in (
        "deepReviewSectorCapRelaxed", "actionableSectorCapRelaxed", "sourceStale", "fallbackProvenance",
    ):
        if type(item[key]) is not bool:
            raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    for key in (
        "deepReviewEligibleCount", "deepReviewSelectedCount", "actionableEligibleCount", "actionableSelectedCount",
    ):
        _require_nonnegative_int(item[key], key)


def _validate_candidate(candidate: Any, index: int) -> None:
    if type(candidate) is not dict:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    allowed = frozenset(CANDIDATE_PROJECTION_FIELDS)
    required = frozenset({"artifactIndex", "code", "tier", "marketRank"})
    if not required.issubset(candidate) or not set(candidate).issubset(allowed):
        raise HandoffError("HANDOFF_UNKNOWN_KEY")
    if candidate["artifactIndex"] != index or type(candidate["artifactIndex"]) is not int:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    _require_string(candidate["code"], "candidate code")
    if candidate["tier"] not in ALL_TIERS:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    if candidate["marketRank"] is not None:
        _require_positive_int(candidate["marketRank"], "market rank")
    for key in ("prescreenScore", "marketScore", "rawCompositeScore", "dataConfidence"):
        if key in candidate:
            _require_finite_number(candidate[key], key, nullable=True)
    if "prescreenRank" in candidate and type(candidate["prescreenRank"]) not in (type(None), int, float, str):
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    if type(candidate.get("prescreenRank")) is bool:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    for key in ("prescreenPool", "sector", "dataStatus"):
        if key in candidate:
            _require_string(candidate[key], key, nullable=True)


def compute_confidence_invariant(base_candidates: Sequence[Mapping[str, Any]], perturbed_candidates: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Return NOTE-R1-01 observability without classifier or severity semantics."""
    base_codes = [row.get("code") for row in base_candidates]
    perturbed_codes = [row.get("code") for row in perturbed_candidates]
    if not base_codes and not perturbed_codes:
        return {
            "state": "NOT_APPLICABLE", "basis": "PUBLIC_ROUNDED_ONLY", "comparedCount": 0,
            "totalCount": 0, "mismatchedCodes": [], "unavailableCodes": [], "reason": "EMPTY_POPULATION",
        }
    if (
        any(type(code) is not str for code in base_codes + perturbed_codes)
        or len(set(base_codes)) != len(base_codes)
        or len(set(perturbed_codes)) != len(perturbed_codes)
        or set(base_codes) != set(perturbed_codes)
    ):
        return {
            "state": "NOT_VERIFIABLE", "basis": "PUBLIC_ROUNDED_ONLY", "comparedCount": 0,
            "totalCount": None, "mismatchedCodes": [], "unavailableCodes": [], "reason": "IDENTITY_NOT_COMPARABLE",
        }
    base_by_code = {row["code"]: row for row in base_candidates}
    perturbed_by_code = {row["code"]: row for row in perturbed_candidates}
    mismatched: list[str] = []
    unavailable: list[str] = []
    compared = 0
    for code in sorted(base_by_code):
        before = base_by_code[code].get("dataConfidence")
        after = perturbed_by_code[code].get("dataConfidence")
        if type(before) not in (int, float) or type(before) is bool or not math.isfinite(before):
            unavailable.append(code)
            continue
        if type(after) not in (int, float) or type(after) is bool or not math.isfinite(after):
            unavailable.append(code)
            continue
        compared += 1
        if before != after:
            mismatched.append(code)
    if unavailable:
        state, reason = "NOT_VERIFIABLE", "CONFIDENCE_VALUE_UNAVAILABLE"
    else:
        state, reason = "VERIFIED", None
    return {
        "state": state, "basis": "PUBLIC_ROUNDED_ONLY", "comparedCount": compared,
        "totalCount": len(base_codes), "mismatchedCodes": mismatched,
        "unavailableCodes": unavailable, "reason": reason,
    }


def _validate_confidence_invariant(value: Any) -> None:
    item = _require_exact_keys(value, _CONFIDENCE_KEYS, "confidence invariant")
    if item["state"] not in {"VERIFIED", "NOT_VERIFIABLE", "NOT_APPLICABLE"}:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    if item["basis"] != "PUBLIC_ROUNDED_ONLY":
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    _require_nonnegative_int(item["comparedCount"], "compared count")
    if item["totalCount"] is not None:
        _require_nonnegative_int(item["totalCount"], "total count")
    for key in ("mismatchedCodes", "unavailableCodes"):
        if type(item[key]) is not list or item[key] != sorted(item[key]) or len(set(item[key])) != len(item[key]):
            raise HandoffError("HANDOFF_MALFORMED", "TYPE")
        for code in item[key]:
            _require_string(code, "confidence code")
    if set(item["mismatchedCodes"]) & set(item["unavailableCodes"]):
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    expected_reason = {
        "VERIFIED": None,
        "NOT_APPLICABLE": "EMPTY_POPULATION",
    }.get(item["state"])
    if item["state"] == "NOT_VERIFIABLE":
        if item["reason"] not in {"CONFIDENCE_VALUE_UNAVAILABLE", "IDENTITY_NOT_COMPARABLE"}:
            raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    elif item["reason"] != expected_reason:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")


def _validate_observation_value(value: Any) -> dict[str, Any]:
    observation = _require_exact_keys(value, _OBSERVATION_KEYS, "observation")
    if observation["schemaVersion"] != OBSERVATION_SCHEMA_VERSION:
        raise HandoffError("UNSUPPORTED_OBSERVATION_SCHEMA")
    _require_identity_string(observation["policyVersion"])
    _validate_run_identity(observation["runIdentity"])
    _validate_source_identity(observation["sourceIdentity"])
    _validate_input_identity(observation["inputIdentity"])
    if observation["parameters"] != EXPECTED_PARAMETERS:
        raise HandoffError("HANDOFF_UNKNOWN_KEY")
    for side_name in ("base", "perturbed"):
        side = _require_exact_keys(observation[side_name], _SIDE_KEYS, side_name)
        if side["engineStatus"] not in {"generated", "not_generated"} or type(side["candidates"]) is not list:
            raise HandoffError("HANDOFF_MALFORMED", "TYPE")
        for index, candidate in enumerate(side["candidates"]):
            _validate_candidate(candidate, index)
        _validate_selection_observability(side["selectionObservability"])
    availability = _require_exact_keys(observation["diagnosticAvailability"], _AVAILABILITY_KEYS, "availability")
    if availability["internalDataConfidence"] != "UNAVAILABLE" or availability["exactCause"] != "UNAVAILABLE":
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    _validate_confidence_invariant(availability["confidenceInvariant"])
    expected = compute_confidence_invariant(observation["base"]["candidates"], observation["perturbed"]["candidates"])
    if availability["confidenceInvariant"] != expected:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    return observation


def _match_expected_observation(observation: Mapping[str, Any], expected: ExpectedBinding) -> None:
    run = observation["runIdentity"]
    if run["runId"] != expected.run_id:
        raise HandoffError("RUN_ID_MISMATCH")
    if run["runAttempt"] != expected.run_attempt:
        raise HandoffError("RUN_ATTEMPT_MISMATCH")
    expected_run = {
        "repository": expected.repository, "workflow": expected.workflow, "job": expected.job,
        "runId": expected.run_id, "runAttempt": expected.run_attempt, "event": expected.event,
        "gitRef": expected.git_ref, "gitRefType": expected.git_ref_type, "gitSha": expected.event_git_sha,
    }
    if run != expected_run:
        raise HandoffError("RUN_IDENTITY_MISMATCH")
    if observation["policyVersion"] != expected.policy_version:
        raise HandoffError("POLICY_BINDING_MISMATCH")
    source = observation["sourceIdentity"]
    expected_source = {
        "executedGitSha": expected.executed_git_sha,
        "modules": [{"path": item.path, "sha256": item.sha256} for item in expected.modules],
        "engineSchemaVersion": expected.engine_schema_version,
        "engineScoreVersion": expected.engine_score_version,
        "engineFunnelVersion": expected.engine_funnel_version,
    }
    if source != expected_source:
        raise HandoffError("SOURCE_IDENTITY_MISMATCH")
    identity = observation["inputIdentity"]
    expected_input = {
        "rawFiles": {
            item.name: {"present": item.present, "sha256": item.sha256, "bytes": item.bytes}
            for item in expected.raw_files
        },
        "joinedCandidateInput": {"sha256": expected.joined_candidate_input.sha256, "bytes": expected.joined_candidate_input.bytes},
        "replayContext": {"sha256": expected.replay_context.sha256, "bytes": expected.replay_context.bytes},
        "captureInput": {"sha256": expected.capture_input.sha256, "bytes": expected.capture_input.bytes},
    }
    if identity != expected_input:
        raise HandoffError("INPUT_IDENTITY_MISMATCH")


def validate_handoff_observation(observation_bytes: bytes, expected_binding: ExpectedBinding) -> CanonicalP14Observation:
    value = _decode_canonical(observation_bytes)
    _validate_observation_value(value)
    _match_expected_observation(value, expected_binding)
    try:
        canonical = CanonicalP14Observation.from_bytes(observation_bytes)
    except ObservationContractError as exc:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE") from exc
    return canonical


def build_observation_bytes(
    *,
    policy_version: str,
    run_identity: Mapping[str, Any],
    source_identity: Mapping[str, Any],
    input_identity: Mapping[str, Any],
    base: Mapping[str, Any],
    perturbed: Mapping[str, Any],
) -> bytes:
    base_owned = json.loads(canonical_json_bytes(base))
    perturbed_owned = json.loads(canonical_json_bytes(perturbed))
    value = {
        "schemaVersion": OBSERVATION_SCHEMA_VERSION,
        "policyVersion": policy_version,
        "runIdentity": json.loads(canonical_json_bytes(run_identity)),
        "sourceIdentity": json.loads(canonical_json_bytes(source_identity)),
        "inputIdentity": json.loads(canonical_json_bytes(input_identity)),
        "parameters": json.loads(canonical_json_bytes(EXPECTED_PARAMETERS)),
        "base": base_owned,
        "perturbed": perturbed_owned,
        "diagnosticAvailability": {
            "internalDataConfidence": "UNAVAILABLE",
            "exactCause": "UNAVAILABLE",
            "confidenceInvariant": compute_confidence_invariant(
                base_owned.get("candidates", []), perturbed_owned.get("candidates", [])
            ),
        },
    }
    _validate_observation_value(value)
    try:
        return make_canonical_p14_observation(value).payload_bytes
    except ObservationContractError as exc:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE") from exc


def _validate_context(value: Any) -> dict[str, Any]:
    context = _require_exact_keys(value, _CONTEXT_KEYS, "context")
    for key in ("pipelinePath", "regime", "sourceUpdatedAt"):
        if context[key] is not None:
            _require_string(context[key], key)
    _require_string(context["asOf"], "asOf")
    if context["staleThresholdHours"] is not None:
        _require_finite_number(context["staleThresholdHours"], "stale threshold")
    if type(context["prescreenFallbackUsed"]) is not bool:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    return context


def _validate_join_stats(value: Any) -> dict[str, Any]:
    stats = _require_exact_keys(value, _JOIN_KEYS, "join stats")
    for key in (
        "candidateCount", "prescreenCount", "joinedCount", "unmatchedCandidateCount", "unmatchedPrescreenCount",
    ):
        _require_nonnegative_int(stats[key], key)
    for key in ("joinRate", "unmatchedCandidateRate"):
        _require_finite_number(stats[key], key)
    return stats


def _validate_capture_value(value: Any) -> dict[str, Any]:
    capture = _require_exact_keys(value, _CAPTURE_KEYS, "capture input")
    if capture["schemaVersion"] != CAPTURE_INPUT_SCHEMA_VERSION:
        raise HandoffError("UNSUPPORTED_CAPTURE_INPUT_SCHEMA")
    rows = capture["joinedCandidateInput"]
    if type(rows) is not list:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    allowed = frozenset(REPLAY_CANDIDATE_FIELDS)
    for row in rows:
        if type(row) is dict:
            if not set(row).issubset(allowed):
                raise HandoffError("HANDOFF_UNKNOWN_KEY")
            for child in row.values():
                if type(child) not in (type(None), bool, int, float, str):
                    raise HandoffError("HANDOFF_MALFORMED", "TYPE")
                if type(child) is float and not math.isfinite(child):
                    raise HandoffError("HANDOFF_MALFORMED", "NONFINITE_JSON")
        elif type(row) not in (type(None), bool, int, float, str):
            raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    _validate_context(capture["context"])
    _validate_join_stats(capture["joinStats"])
    for key in ("sourceUpdatedAt", "candidatesUpdatedAt"):
        if capture[key] is not None:
            _require_string(capture[key], key)
    return capture


def build_capture_input_bytes(
    *,
    joined_candidate_input: Sequence[Any],
    context: Mapping[str, Any],
    join_stats: Mapping[str, Any],
    source_updated_at: str | None,
    candidates_updated_at: str | None,
) -> bytes:
    projected: list[Any] = []
    for row in joined_candidate_input:
        if type(row) is dict:
            projected.append({key: row[key] for key in REPLAY_CANDIDATE_FIELDS if key in row})
        else:
            projected.append(row)
    value = {
        "schemaVersion": CAPTURE_INPUT_SCHEMA_VERSION,
        "joinedCandidateInput": projected,
        "context": dict(context),
        "joinStats": dict(join_stats),
        "sourceUpdatedAt": source_updated_at,
        "candidatesUpdatedAt": candidates_updated_at,
    }
    _validate_capture_value(value)
    _privacy_scan(value)
    return canonical_json_bytes(value)


_REPORT_REQUIRED_KEYS = frozenset(
    {"context", "joinStats", "prescreenDuplicateCodes", "qualityGate", "engineStatus"}
)
_QUALITY_KEYS = frozenset({"gates", "overallPass", "hardFailIds", "notes", "p14ReleaseEvidence"})
_GATE_KEYS = frozenset({"id", "metric", "value", "threshold", "status", "note"})
_RELEASE_KEYS = frozenset(
    {"policyVersion", "top40", "deepReview", "actionable", "marketReferenceShortlist", "final", "p14ProvesOfficialDecisionStability"}
)
_TOP40_KEYS = frozenset(
    {"intersection", "union", "retention", "swapCount", "jaccard", "warnThreshold", "hardThreshold"}
)
_TIER_RELEASE_KEYS = frozenset({"baseCodes", "perturbedCodes", "entered", "exited", "exitCount"})
_ACTIONABLE_RELEASE_KEYS = _TIER_RELEASE_KEYS | frozenset({"warnThreshold", "hardThreshold"})
_SHORTLIST_KEYS = frozenset(
    {"name", "holdingsDependent", "n", "base", "perturbed", "membershipChanged", "tierChanged", "orderChanged"}
)
_SHORTLIST_ENTRY_KEYS = frozenset({"code", "tier", "marketRank", "artifactIndex"})
_FINAL_KEYS = frozenset({"status", "hardReasons", "warnReasons"})
_ALLOWED_GATE_IDS = frozenset({*(f"P-{index:02d}" for index in range(1, 16)), "PRESCREEN_DUPLICATE"})
_GATE_STATUSES = frozenset({"PASS", "WARN", "FAIL", "RECORD", "N/A"})
_P06_KEYS = frozenset({"count", "min", "p25", "median", "p75", "max", "atOrBelow4AxesCount"})
_P07_KEYS = frozenset({"count", "min", "max", "range", "p25", "p75", "iqr", "median"})
_P10_KEYS = frozenset({"deepReview", "actionable"})
_P11_KEYS = frozenset(
    {"deepReviewSectorCapOverflow", "actionableSectorCapOverflow", "deepReviewEligibleMinusSelected", "actionableEligibleMinusSelected"}
)
_P12_KEYS = frozenset({"soft", "hard"})
_P13_KEYS = frozenset({"currentRunActionable", "cacheFallbackMirrorActionable"})
_HARD_REASON_CODES = frozenset(
    {
        "HARD_NOT_PRIME_DOMESTIC", "HARD_NON_EQUITY_INSTRUMENT",
        "HARD_PREFERRED_OR_NONSTANDARD_CODE", "HARD_INSUFFICIENT_HISTORY",
        "HARD_BELOW_MAIN_FLOOR", "HARD_NONFINITE_SERIES", "HARD_CONTRACT_VIOLATION",
        "HARD_NO_TRADABLE_SERIES",
    }
)
_SOFT_REASON_CODES = frozenset(
    {
        "SOFT_ELEVATED_VOLATILITY", "SOFT_WEAK_MOMENTUM", "SOFT_DEEP_DRAWDOWN",
        "SOFT_WEAK_TREND", "SOFT_SECTOR_CROWDING", "SOFT_THEME_CROWDING",
        "SOFT_LOW_DATA_CONFIDENCE", "SOFT_STALE_SOURCE", "SOFT_PORTFOLIO_OVERLAP",
        "SOFT_FALLBACK_PROVENANCE", "SOFT_PRESCREEN_METADATA_MISSING",
        "SOFT_VOLATILITY_RED_FLAG", "SOFT_VOLATILITY_UNAVAILABLE",
    }
)


def _validate_string_list(value: Any, label: str, *, unique: bool = False, sorted_values: bool = False) -> list[str]:
    if type(value) is not list:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    for item in value:
        _require_string(item, label)
    if unique and len(set(value)) != len(value):
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    if sorted_values and value != sorted(value):
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    return value


def _validate_numeric_summary(value: Any, keys: frozenset[str]) -> None:
    item = _require_exact_keys(value, keys, "numeric summary")
    for key, child in item.items():
        if key in {"count", "atOrBelow4AxesCount"}:
            _require_nonnegative_int(child, key)
        else:
            _require_finite_number(child, key, nullable=True)


def _validate_count_map(value: Any, allowed_keys: frozenset[str] | None = None) -> None:
    if type(value) is not dict:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    if allowed_keys is not None and not set(value).issubset(allowed_keys):
        raise HandoffError("HANDOFF_UNKNOWN_KEY")
    for key, count in value.items():
        _require_string(key, "count map key")
        _require_nonnegative_int(count, "count map value")


def _validate_gate_value(gate_id: str, value: Any, sectors: frozenset[str]) -> None:
    if value is None:
        return
    if gate_id == "P-06":
        _validate_numeric_summary(value, _P06_KEYS)
    elif gate_id == "P-07":
        _validate_numeric_summary(value, _P07_KEYS)
    elif gate_id == "P-10":
        item = _require_exact_keys(value, _P10_KEYS, "P-10")
        for child in item.values():
            _require_nonnegative_int(child, "P-10 count")
    elif gate_id == "P-11":
        item = _require_exact_keys(value, _P11_KEYS, "P-11")
        _validate_count_map(item["deepReviewSectorCapOverflow"], sectors)
        _validate_count_map(item["actionableSectorCapOverflow"], sectors)
        _require_nonnegative_int(item["deepReviewEligibleMinusSelected"], "P-11 count")
        _require_nonnegative_int(item["actionableEligibleMinusSelected"], "P-11 count")
    elif gate_id == "P-12":
        item = _require_exact_keys(value, _P12_KEYS, "P-12")
        _validate_count_map(item["soft"], _SOFT_REASON_CODES)
        _validate_count_map(item["hard"], _HARD_REASON_CODES)
    elif gate_id == "P-13":
        item = _require_exact_keys(value, _P13_KEYS, "P-13")
        for child in item.values():
            _require_nonnegative_int(child, "P-13 count")
    elif type(value) in (bool, int, float, str):
        if type(value) is float and not math.isfinite(value):
            raise HandoffError("HANDOFF_MALFORMED", "NONFINITE_JSON")
        if type(value) is str:
            _scan_string(value)
    else:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")


def _validate_shortlist_entries(value: Any) -> None:
    if type(value) is not list:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    for entry in value:
        item = _require_exact_keys(entry, _SHORTLIST_ENTRY_KEYS, "shortlist entry")
        _require_string(item["code"], "shortlist code")
        if item["tier"] not in ALL_TIERS:
            raise HandoffError("HANDOFF_MALFORMED", "TYPE")
        _require_positive_int(item["marketRank"], "shortlist market rank")
        _require_nonnegative_int(item["artifactIndex"], "shortlist artifact index")


def _validate_release(value: Any, policy_version: str) -> None:
    release = _require_exact_keys(value, _RELEASE_KEYS, "release evidence")
    if release["policyVersion"] != policy_version:
        raise HandoffError("POLICY_BINDING_MISMATCH")
    top = _require_exact_keys(release["top40"], _TOP40_KEYS, "top40")
    for key in ("intersection", "union"):
        _validate_string_list(top[key], key, unique=True, sorted_values=True)
    _require_finite_number(top["retention"], "retention")
    _require_nonnegative_int(top["swapCount"], "swap count")
    _require_finite_number(top["jaccard"], "jaccard")
    _require_finite_number(top["warnThreshold"], "warn threshold")
    _require_finite_number(top["hardThreshold"], "hard threshold")
    for name, keys in (("deepReview", _TIER_RELEASE_KEYS), ("actionable", _ACTIONABLE_RELEASE_KEYS)):
        item = _require_exact_keys(release[name], keys, name)
        for key in ("baseCodes", "perturbedCodes", "entered", "exited"):
            _validate_string_list(item[key], key, unique=True, sorted_values=True)
        _require_nonnegative_int(item["exitCount"], "exit count")
        if item["exitCount"] != len(item["exited"]):
            raise HandoffError("BATCH_RECEIPT_INVALID", "EXIT_COUNT")
        if name == "actionable":
            _require_nonnegative_int(item["warnThreshold"], "warn threshold")
            _require_nonnegative_int(item["hardThreshold"], "hard threshold")
    shortlist = _require_exact_keys(release["marketReferenceShortlist"], _SHORTLIST_KEYS, "shortlist")
    _require_string(shortlist["name"], "shortlist name")
    if shortlist["holdingsDependent"] is not False:
        raise HandoffError("BATCH_RECEIPT_INVALID", "HOLDINGS_DEPENDENT")
    _require_positive_int(shortlist["n"], "shortlist n")
    _validate_shortlist_entries(shortlist["base"])
    _validate_shortlist_entries(shortlist["perturbed"])
    for key in ("membershipChanged", "tierChanged", "orderChanged"):
        if type(shortlist[key]) is not bool:
            raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    final = _require_exact_keys(release["final"], _FINAL_KEYS, "release final")
    if final["status"] not in {"PASS", "WARN", "FAIL"}:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    _validate_string_list(final["hardReasons"], "hard reasons", unique=True)
    _validate_string_list(final["warnReasons"], "warn reasons", unique=True)
    if release["p14ProvesOfficialDecisionStability"] is not False:
        raise HandoffError("BATCH_RECEIPT_INVALID", "OFFICIAL_DECISION_CLAIM")


def _validate_quality_gate(value: Any, policy_version: str, sectors: frozenset[str]) -> None:
    quality = _require_exact_keys(value, _QUALITY_KEYS, "quality gate")
    if type(quality["gates"]) is not list or type(quality["overallPass"]) is not bool:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    ids: list[str] = []
    fail_ids: list[str] = []
    for gate in quality["gates"]:
        item = _require_exact_keys(gate, _GATE_KEYS, "quality gate item")
        if item["id"] not in _ALLOWED_GATE_IDS or item["id"] in ids:
            raise HandoffError("BATCH_RECEIPT_INVALID", "GATE_ID")
        ids.append(item["id"])
        _require_string(item["metric"], "gate metric")
        if item["status"] not in _GATE_STATUSES:
            raise HandoffError("HANDOFF_MALFORMED", "TYPE")
        if item["status"] == "FAIL":
            fail_ids.append(item["id"])
        if item["note"] is not None:
            _require_string(item["note"], "gate note")
        threshold = item["threshold"]
        if threshold is not None and type(threshold) not in (bool, int, float, str):
            raise HandoffError("HANDOFF_MALFORMED", "TYPE")
        if type(threshold) is float and not math.isfinite(threshold):
            raise HandoffError("HANDOFF_MALFORMED", "NONFINITE_JSON")
        _validate_gate_value(item["id"], item["value"], sectors)
    if not frozenset(f"P-{index:02d}" for index in range(1, 16)).issubset(ids):
        raise HandoffError("BATCH_RECEIPT_INVALID", "GATE_ID")
    if type(quality["hardFailIds"]) is not list or quality["hardFailIds"] != fail_ids:
        raise HandoffError("BATCH_RECEIPT_INVALID", "GATE_PARITY")
    if quality["overallPass"] is not (not fail_ids):
        raise HandoffError("BATCH_RECEIPT_INVALID", "GATE_PARITY")
    if type(quality["notes"]) is not list:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    for note in quality["notes"]:
        _require_string(note, "quality note")
    if quality["p14ReleaseEvidence"] is not None:
        _validate_release(quality["p14ReleaseEvidence"], policy_version)


def _observation_sectors(observation: Mapping[str, Any] | None) -> frozenset[str]:
    if observation is None:
        return frozenset()
    values: set[str] = set()
    for side in ("base", "perturbed"):
        for candidate in observation[side]["candidates"]:
            sector = candidate.get("sector")
            if type(sector) is str:
                values.add(sector)
    return frozenset(values)


def _validate_report(value: Any, policy_version: str, sectors: frozenset[str]) -> None:
    if type(value) is not dict:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    keys = set(value)
    if not _REPORT_REQUIRED_KEYS.issubset(keys) or not keys.issubset(_REPORT_REQUIRED_KEYS | {"schemaViolations"}):
        raise HandoffError("HANDOFF_UNKNOWN_KEY")
    _validate_context(value["context"])
    _validate_join_stats(value["joinStats"])
    _validate_string_list(value["prescreenDuplicateCodes"], "duplicate codes", unique=True, sorted_values=True)
    _validate_quality_gate(value["qualityGate"], policy_version, sectors)
    if value["engineStatus"] not in {"generated", "not_generated"}:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    if "schemaViolations" in value:
        _validate_string_list(value["schemaViolations"], "schema violations")


def _validate_receipt_value(
    value: Any,
    *,
    observation: Mapping[str, Any] | None = None,
    capture: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    receipt = _require_exact_keys(value, _RECEIPT_KEYS, "receipt")
    if receipt["schemaVersion"] != RECEIPT_SCHEMA_VERSION:
        raise HandoffError("UNSUPPORTED_RECEIPT_SCHEMA")
    _validate_run_identity(receipt["runIdentity"])
    _require_identity_string(receipt["policyVersion"])
    _require_git_sha(receipt["executedGitSha"], "receipt executed sha")
    for key in ("observationDigest", "captureInputDigest"):
        if receipt[key] is not None:
            _require_digest(receipt[key], key)
    if receipt["terminalStatus"] not in TERMINAL_STATUSES or receipt["transportStatus"] not in TRANSPORT_STATUSES:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    if type(receipt["artifactAvailable"]) is not bool:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    if receipt["artifactAvailable"] is not (receipt["terminalStatus"] == "BATCH_READY"):
        raise HandoffError("BATCH_RECEIPT_INVALID", "ARTIFACT_AVAILABLE")
    if receipt["transportStatus"] == "READY":
        if receipt["failureCode"] is not None or receipt["observationDigest"] is None or receipt["captureInputDigest"] is None:
            raise HandoffError("BATCH_RECEIPT_INVALID", "TRANSPORT_STATUS")
    else:
        if receipt["failureCode"] not in (HANDOFF_ERROR_CODES | TRANSPORT_STATUSES):
            raise HandoffError("BATCH_RECEIPT_INVALID", "FAILURE_CODE")
    if receipt["reportState"] == "COMPLETE":
        if receipt["report"] is None:
            raise HandoffError("BATCH_RECEIPT_INVALID", "REPORT_STATE")
        _validate_report(receipt["report"], receipt["policyVersion"], _observation_sectors(observation))
        if capture is not None and (
            receipt["report"]["context"] != capture["context"]
            or receipt["report"]["joinStats"] != capture["joinStats"]
        ):
            raise HandoffError("INPUT_IDENTITY_MISMATCH")
    elif receipt["reportState"] == "UNAVAILABLE":
        if receipt["report"] is not None:
            raise HandoffError("BATCH_RECEIPT_INVALID", "REPORT_STATE")
    else:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    if observation is not None:
        if receipt["observationDigest"] != _digest_bytes(canonical_json_bytes(observation)):
            raise HandoffError("RECEIPT_OBSERVATION_MISMATCH")
        if receipt["runIdentity"] != observation["runIdentity"]:
            raise HandoffError("RUN_IDENTITY_MISMATCH")
        if receipt["policyVersion"] != observation["policyVersion"]:
            raise HandoffError("POLICY_BINDING_MISMATCH")
        if receipt["executedGitSha"] != observation["sourceIdentity"]["executedGitSha"]:
            raise HandoffError("SOURCE_IDENTITY_MISMATCH")
    if capture is not None and receipt["captureInputDigest"] != _digest_bytes(canonical_json_bytes(capture)):
        raise HandoffError("INPUT_IDENTITY_MISMATCH")
    return receipt


def build_batch_receipt_bytes(
    receipt: Mapping[str, Any],
    *,
    observation_bytes: bytes | None = None,
    capture_input_bytes: bytes | None = None,
) -> bytes:
    value = json.loads(canonical_json_bytes(receipt))
    observation = _decode_canonical(observation_bytes) if observation_bytes is not None else None
    capture = _decode_canonical(capture_input_bytes) if capture_input_bytes is not None else None
    if observation is not None:
        _validate_observation_value(observation)
    if capture is not None:
        _validate_capture_value(capture)
    _validate_receipt_value(value, observation=observation, capture=capture)
    _privacy_scan(value)
    return canonical_json_bytes(value)


def _part_record(file_name: str, payload: bytes) -> dict[str, Any]:
    return {"file": file_name, "sha256": _digest_bytes(payload), "bytes": len(payload)}


def _validate_part_record(value: Any, expected_file: str) -> DigestBinding:
    item = _require_exact_keys(value, frozenset({"file", "sha256", "bytes"}), "part record")
    if item["file"] != expected_file:
        raise HandoffError("HANDOFF_LOCATION_INVALID")
    return DigestBinding(item["sha256"], item["bytes"])


def build_handoff_envelope_bytes(
    *,
    observation_bytes: bytes,
    capture_input_bytes: bytes,
    receipt_bytes: bytes,
) -> bytes:
    observation = _decode_canonical(observation_bytes)
    capture = _decode_canonical(capture_input_bytes)
    receipt = _decode_canonical(receipt_bytes)
    _validate_observation_value(observation)
    _validate_capture_value(capture)
    _validate_receipt_value(receipt, observation=observation, capture=capture)
    if receipt["transportStatus"] != "READY":
        raise HandoffError("BATCH_RECEIPT_INVALID", "TRANSPORT_STATUS")
    observation_digest = _digest_bytes(observation_bytes)
    value = {
        "schemaVersion": HANDOFF_SCHEMA_VERSION,
        "observationSchemaVersion": OBSERVATION_SCHEMA_VERSION,
        "receiptSchemaVersion": RECEIPT_SCHEMA_VERSION,
        "captureInputSchemaVersion": CAPTURE_INPUT_SCHEMA_VERSION,
        "policyVersion": observation["policyVersion"],
        "runIdentity": observation["runIdentity"],
        "executedGitSha": observation["sourceIdentity"]["executedGitSha"],
        "observation": _part_record(f"observation-{observation_digest}.json", observation_bytes),
        "captureInput": _part_record(CAPTURE_INPUT_FILE, capture_input_bytes),
        "receipt": _part_record(RECEIPT_FILE, receipt_bytes),
    }
    return canonical_json_bytes(value)


def _validate_envelope_value(value: Any) -> dict[str, Any]:
    envelope = _require_exact_keys(value, _ENVELOPE_KEYS, "envelope")
    if envelope["schemaVersion"] != HANDOFF_SCHEMA_VERSION:
        raise HandoffError("UNSUPPORTED_HANDOFF_SCHEMA")
    if envelope["observationSchemaVersion"] != OBSERVATION_SCHEMA_VERSION:
        raise HandoffError("UNSUPPORTED_OBSERVATION_SCHEMA")
    if envelope["receiptSchemaVersion"] != RECEIPT_SCHEMA_VERSION:
        raise HandoffError("UNSUPPORTED_RECEIPT_SCHEMA")
    if envelope["captureInputSchemaVersion"] != CAPTURE_INPUT_SCHEMA_VERSION:
        raise HandoffError("UNSUPPORTED_CAPTURE_INPUT_SCHEMA")
    _require_identity_string(envelope["policyVersion"])
    _validate_run_identity(envelope["runIdentity"])
    _require_git_sha(envelope["executedGitSha"], "envelope executed sha")
    observation_record = envelope["observation"]
    if type(observation_record) is not dict or type(observation_record.get("sha256")) is not str:
        raise HandoffError("HANDOFF_MALFORMED", "TYPE")
    _validate_part_record(observation_record, f"observation-{observation_record['sha256']}.json")
    _validate_part_record(envelope["captureInput"], CAPTURE_INPUT_FILE)
    _validate_part_record(envelope["receipt"], RECEIPT_FILE)
    return envelope


def make_producer_reference(parts: HandoffParts) -> ProducerReference:
    envelope = _validate_parts_intrinsic(parts)
    return ProducerReference(
        status="READY",
        transport_digest=_digest_bytes(parts.envelope_bytes),
        observation_digest=_digest_bytes(parts.observation_bytes),
        receipt_digest=_digest_bytes(parts.receipt_bytes),
        capture_input_digest=_digest_bytes(parts.capture_input_bytes),
        executed_git_sha=envelope["executedGitSha"],
        observation_schema_version=envelope["observationSchemaVersion"],
        handoff_schema_version=envelope["schemaVersion"],
        policy_version=envelope["policyVersion"],
        run_id=envelope["runIdentity"]["runId"],
        run_attempt=envelope["runIdentity"]["runAttempt"],
    )


def build_handoff_parts(
    *,
    observation_bytes: bytes,
    capture_input_bytes: bytes,
    receipt_bytes: bytes,
) -> tuple[HandoffParts, ProducerReference]:
    envelope_bytes = build_handoff_envelope_bytes(
        observation_bytes=observation_bytes,
        capture_input_bytes=capture_input_bytes,
        receipt_bytes=receipt_bytes,
    )
    parts = HandoffParts(capture_input_bytes, observation_bytes, receipt_bytes, envelope_bytes)
    return parts, make_producer_reference(parts)


def _validate_reference(reference: ProducerReference, expected: ExpectedBinding) -> None:
    if reference.status != "READY":
        raise HandoffError("PRODUCER_REFERENCE_MISSING")
    if reference.run_id != expected.run_id:
        raise HandoffError("RUN_ID_MISMATCH")
    if reference.run_attempt != expected.run_attempt:
        raise HandoffError("RUN_ATTEMPT_MISMATCH")
    if reference.policy_version != expected.policy_version:
        raise HandoffError("POLICY_BINDING_MISMATCH")
    if reference.observation_schema_version != OBSERVATION_SCHEMA_VERSION:
        raise HandoffError("UNSUPPORTED_OBSERVATION_SCHEMA")
    if reference.handoff_schema_version != HANDOFF_SCHEMA_VERSION:
        raise HandoffError("UNSUPPORTED_HANDOFF_SCHEMA")
    if reference.executed_git_sha != expected.executed_git_sha:
        raise HandoffError("SOURCE_IDENTITY_MISMATCH")


def _validate_parts_intrinsic(parts: HandoffParts) -> dict[str, Any]:
    envelope = _decode_canonical(parts.envelope_bytes)
    _validate_envelope_value(envelope)
    observation = _decode_canonical(parts.observation_bytes)
    capture = _decode_canonical(parts.capture_input_bytes)
    receipt = _decode_canonical(parts.receipt_bytes)
    _validate_observation_value(observation)
    _validate_capture_value(capture)
    _validate_receipt_value(receipt, observation=observation, capture=capture)
    if receipt["transportStatus"] != "READY":
        raise HandoffError("BATCH_RECEIPT_INVALID", "TRANSPORT_STATUS")
    expected_records = (
        (envelope["observation"], parts.observation_bytes, "OBSERVATION_DIGEST_MISMATCH"),
        (envelope["captureInput"], parts.capture_input_bytes, "INPUT_IDENTITY_MISMATCH"),
        (envelope["receipt"], parts.receipt_bytes, "BATCH_RECEIPT_INVALID"),
    )
    for record, payload, code in expected_records:
        if record["sha256"] != _digest_bytes(payload) or record["bytes"] != len(payload):
            raise HandoffError(code)
    if envelope["runIdentity"] != observation["runIdentity"] or envelope["runIdentity"] != receipt["runIdentity"]:
        raise HandoffError("RUN_IDENTITY_MISMATCH")
    if envelope["policyVersion"] != observation["policyVersion"] or envelope["policyVersion"] != receipt["policyVersion"]:
        raise HandoffError("POLICY_BINDING_MISMATCH")
    if (
        envelope["executedGitSha"] != observation["sourceIdentity"]["executedGitSha"]
        or envelope["executedGitSha"] != receipt["executedGitSha"]
    ):
        raise HandoffError("SOURCE_IDENTITY_MISMATCH")
    if observation["inputIdentity"]["captureInput"] != {
        "sha256": _digest_bytes(parts.capture_input_bytes), "bytes": len(parts.capture_input_bytes)
    }:
        raise HandoffError("INPUT_IDENTITY_MISMATCH")
    return envelope


def validate_handoff_parts(
    parts: HandoffParts | None,
    expected_binding: ExpectedBinding,
    producer_reference: ProducerReference | Mapping[str, Any] | None,
) -> HandoffParts:
    if producer_reference is None:
        if parts is None:
            raise HandoffError("HANDOFF_MISSING", "PRODUCER_REFERENCE_MISSING")
        raise HandoffError("PRODUCER_REFERENCE_MISSING")
    if not isinstance(producer_reference, ProducerReference):
        try:
            producer_reference = ProducerReference.from_value(producer_reference)
        except Exception as exc:
            raise HandoffError("PRODUCER_REFERENCE_MISSING") from exc
    _validate_reference(producer_reference, expected_binding)
    if parts is None:
        raise HandoffError("HANDOFF_MISSING")
    if _digest_bytes(parts.envelope_bytes) != producer_reference.transport_digest:
        raise HandoffError("TRANSPORT_DIGEST_MISMATCH")
    envelope = _decode_canonical(parts.envelope_bytes)
    _validate_envelope_value(envelope)
    if envelope["runIdentity"]["runId"] != expected_binding.run_id:
        raise HandoffError("RUN_ID_MISMATCH")
    if envelope["runIdentity"]["runAttempt"] != expected_binding.run_attempt:
        raise HandoffError("RUN_ATTEMPT_MISMATCH")
    expected_run = {
        "repository": expected_binding.repository, "workflow": expected_binding.workflow,
        "job": expected_binding.job, "runId": expected_binding.run_id,
        "runAttempt": expected_binding.run_attempt, "event": expected_binding.event,
        "gitRef": expected_binding.git_ref, "gitRefType": expected_binding.git_ref_type,
        "gitSha": expected_binding.event_git_sha,
    }
    if envelope["runIdentity"] != expected_run:
        raise HandoffError("RUN_IDENTITY_MISMATCH")
    if envelope["policyVersion"] != expected_binding.policy_version:
        raise HandoffError("POLICY_BINDING_MISMATCH")
    if envelope["executedGitSha"] != expected_binding.executed_git_sha:
        raise HandoffError("SOURCE_IDENTITY_MISMATCH")

    if _digest_bytes(parts.observation_bytes) != producer_reference.observation_digest:
        raise HandoffError("OBSERVATION_DIGEST_MISMATCH")
    if _digest_bytes(parts.receipt_bytes) != producer_reference.receipt_digest:
        raise HandoffError("BATCH_RECEIPT_INVALID", "DIGEST_MISMATCH")
    if _digest_bytes(parts.capture_input_bytes) != producer_reference.capture_input_digest:
        raise HandoffError("INPUT_IDENTITY_MISMATCH")
    records = (
        (envelope["observation"], parts.observation_bytes, "OBSERVATION_DIGEST_MISMATCH"),
        (envelope["captureInput"], parts.capture_input_bytes, "INPUT_IDENTITY_MISMATCH"),
        (envelope["receipt"], parts.receipt_bytes, "BATCH_RECEIPT_INVALID"),
    )
    for record, payload, code in records:
        if record["sha256"] != _digest_bytes(payload) or record["bytes"] != len(payload):
            raise HandoffError(code)
    observation_object = validate_handoff_observation(parts.observation_bytes, expected_binding)
    observation = observation_object.to_value()
    capture = _decode_canonical(parts.capture_input_bytes)
    _validate_capture_value(capture)
    if _digest_bytes(parts.capture_input_bytes) != expected_binding.capture_input.sha256:
        raise HandoffError("INPUT_IDENTITY_MISMATCH")
    if len(parts.capture_input_bytes) != expected_binding.capture_input.bytes:
        raise HandoffError("INPUT_IDENTITY_MISMATCH")
    if _digest_bytes(canonical_json_bytes(capture["joinedCandidateInput"])) != expected_binding.joined_candidate_input.sha256:
        raise HandoffError("INPUT_IDENTITY_MISMATCH")
    if len(canonical_json_bytes(capture["joinedCandidateInput"])) != expected_binding.joined_candidate_input.bytes:
        raise HandoffError("INPUT_IDENTITY_MISMATCH")
    if _digest_bytes(canonical_json_bytes(capture["context"])) != expected_binding.replay_context.sha256:
        raise HandoffError("INPUT_IDENTITY_MISMATCH")
    if len(canonical_json_bytes(capture["context"])) != expected_binding.replay_context.bytes:
        raise HandoffError("INPUT_IDENTITY_MISMATCH")
    receipt = _decode_canonical(parts.receipt_bytes)
    _validate_receipt_value(receipt, observation=observation, capture=capture)
    if receipt["observationDigest"] != producer_reference.observation_digest:
        raise HandoffError("RECEIPT_OBSERVATION_MISMATCH")
    if envelope["observationSchemaVersion"] != observation["schemaVersion"]:
        raise HandoffError("UNSUPPORTED_OBSERVATION_SCHEMA")
    if envelope["policyVersion"] != receipt["policyVersion"]:
        raise HandoffError("POLICY_BINDING_MISMATCH")
    if envelope["runIdentity"] != receipt["runIdentity"]:
        raise HandoffError("RUN_IDENTITY_MISMATCH")
    if envelope["executedGitSha"] != receipt["executedGitSha"]:
        raise HandoffError("SOURCE_IDENTITY_MISMATCH")
    return HandoffParts(
        bytes(parts.capture_input_bytes), bytes(parts.observation_bytes),
        bytes(parts.receipt_bytes), bytes(parts.envelope_bytes),
    )


def _validate_storage_root(root: Path) -> Path:
    if not root.is_absolute() or ".." in root.parts:
        raise HandoffError("HANDOFF_LOCATION_INVALID")
    original_cursor = Path(root.anchor)
    for part in root.parts[1:]:
        original_cursor = original_cursor / part
        if original_cursor.is_symlink():
            raise HandoffError("HANDOFF_LOCATION_INVALID")
    repository_root = Path(__file__).resolve().parent.parent
    resolved = root.resolve(strict=False)
    try:
        resolved.relative_to(repository_root)
    except ValueError:
        pass
    else:
        raise HandoffError("HANDOFF_LOCATION_INVALID")
    cursor = Path(resolved.anchor)
    for part in resolved.parts[1:]:
        cursor = cursor / part
        if cursor.exists() and cursor.is_symlink():
            raise HandoffError("HANDOFF_LOCATION_INVALID")
    return resolved


def _mkdir_private(path: Path, *, exclusive: bool) -> None:
    try:
        path.mkdir(mode=0o700, parents=False, exist_ok=not exclusive)
    except FileExistsError as exc:
        raise HandoffError("DUPLICATE_PRODUCER_OUTPUT") from exc
    except OSError as exc:
        raise HandoffError("HANDOFF_WRITE_FAILED") from exc
    _require_private_directory(path)


def _require_private_directory(path: Path) -> None:
    try:
        info = path.lstat()
    except OSError as exc:
        raise HandoffError("HANDOFF_LOCATION_INVALID") from exc
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) & 0o077
    ):
        raise HandoffError("HANDOFF_LOCATION_INVALID")


def claim_attempt(root: str | os.PathLike[str], run_id: str, run_attempt: str) -> AttemptClaim:
    _require_positive_decimal(run_id, "run id")
    _require_positive_decimal(run_attempt, "run attempt")
    root_path = _validate_storage_root(Path(root))
    if root_path.exists():
        _require_private_directory(root_path)
    else:
        try:
            root_path.mkdir(mode=0o700, parents=True, exist_ok=False)
        except OSError as exc:
            raise HandoffError("HANDOFF_WRITE_FAILED") from exc
    run_path = root_path / f"run-{run_id}"
    if run_path.exists():
        _require_private_directory(run_path)
    else:
        _mkdir_private(run_path, exclusive=False)
    attempt_path = run_path / f"attempt-{run_attempt}"
    _mkdir_private(attempt_path, exclusive=True)
    claim_payload = canonical_json_bytes({"runAttempt": run_attempt, "runId": run_id})
    _atomic_no_overwrite(attempt_path, CLAIM_FILE, claim_payload)
    return AttemptClaim(str(root_path), str(attempt_path), run_id, run_attempt)


def _validated_claim(claim: AttemptClaim) -> Path:
    if not isinstance(claim, AttemptClaim):
        raise HandoffError("HANDOFF_LOCATION_INVALID")
    root = _validate_storage_root(Path(claim.root))
    expected = root / f"run-{claim.run_id}" / f"attempt-{claim.run_attempt}"
    path = Path(claim.attempt_directory)
    if path != expected:
        raise HandoffError("HANDOFF_LOCATION_INVALID")
    _require_private_directory(path)
    marker = path / CLAIM_FILE
    if marker.is_symlink() or not marker.is_file():
        raise HandoffError("STALE_HANDOFF")
    return path


def _atomic_no_overwrite(directory: Path, file_name: str, payload: bytes) -> None:
    if Path(file_name).name != file_name or file_name in {"", ".", ".."}:
        raise HandoffError("HANDOFF_LOCATION_INVALID")
    final_path = directory / file_name
    if final_path.exists() or final_path.is_symlink():
        raise HandoffError("DUPLICATE_PRODUCER_OUTPUT")
    temporary_path: Path | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(prefix=".stage-", dir=directory)
        temporary_path = Path(temporary_name)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary_path, final_path, follow_symlinks=False)
        temporary_path.unlink()
        temporary_path = None
        directory_descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except FileExistsError as exc:
        raise HandoffError("DUPLICATE_PRODUCER_OUTPUT") from exc
    except HandoffError:
        raise
    except OSError as exc:
        raise HandoffError("HANDOFF_WRITE_FAILED") from exc
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def write_handoff_parts(claim: AttemptClaim, parts: HandoffParts) -> None:
    directory = _validated_claim(claim)
    envelope = _validate_parts_intrinsic(parts)
    if envelope["runIdentity"]["runId"] != claim.run_id:
        raise HandoffError("RUN_ID_MISMATCH")
    if envelope["runIdentity"]["runAttempt"] != claim.run_attempt:
        raise HandoffError("RUN_ATTEMPT_MISMATCH")
    observation_digest = _digest_bytes(parts.observation_bytes)
    filenames = (
        (CAPTURE_INPUT_FILE, parts.capture_input_bytes),
        (f"observation-{observation_digest}.json", parts.observation_bytes),
        (RECEIPT_FILE, parts.receipt_bytes),
        (HANDOFF_FILE, parts.envelope_bytes),
    )
    for file_name, payload in filenames:
        _atomic_no_overwrite(directory, file_name, payload)


def _read_regular_file(directory: Path, file_name: str) -> bytes:
    if Path(file_name).name != file_name:
        raise HandoffError("HANDOFF_LOCATION_INVALID")
    path = directory / file_name
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        raise HandoffError("STALE_HANDOFF") from exc
    except OSError as exc:
        raise HandoffError("HANDOFF_LOCATION_INVALID") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise HandoffError("HANDOFF_LOCATION_INVALID")
    try:
        return path.read_bytes()
    except OSError as exc:
        raise HandoffError("HANDOFF_LOCATION_INVALID") from exc


def read_handoff_parts(
    root: str | os.PathLike[str],
    expected_binding: ExpectedBinding,
    producer_reference: ProducerReference | Mapping[str, Any] | None,
) -> HandoffParts:
    if producer_reference is None:
        raise HandoffError("PRODUCER_REFERENCE_MISSING")
    if not isinstance(producer_reference, ProducerReference):
        producer_reference = ProducerReference.from_value(producer_reference)
    _validate_reference(producer_reference, expected_binding)
    root_path = _validate_storage_root(Path(root))
    directory = root_path / f"run-{expected_binding.run_id}" / f"attempt-{expected_binding.run_attempt}"
    if not directory.exists():
        raise HandoffError("STALE_HANDOFF")
    _require_private_directory(directory)
    if not (directory / HANDOFF_FILE).exists():
        raise HandoffError("STALE_HANDOFF")
    expected_names = {
        CLAIM_FILE, CAPTURE_INPUT_FILE, RECEIPT_FILE, HANDOFF_FILE,
        f"observation-{producer_reference.observation_digest}.json",
    }
    try:
        actual_names = {path.name for path in directory.iterdir()}
    except OSError as exc:
        raise HandoffError("HANDOFF_LOCATION_INVALID") from exc
    if actual_names != expected_names:
        raise HandoffError("HANDOFF_LOCATION_INVALID")
    parts = HandoffParts(
        capture_input_bytes=_read_regular_file(directory, CAPTURE_INPUT_FILE),
        observation_bytes=_read_regular_file(directory, f"observation-{producer_reference.observation_digest}.json"),
        receipt_bytes=_read_regular_file(directory, RECEIPT_FILE),
        envelope_bytes=_read_regular_file(directory, HANDOFF_FILE),
    )
    return validate_handoff_parts(parts, expected_binding, producer_reference)
