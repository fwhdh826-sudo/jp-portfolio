"""Pure canonical value contracts for dormant P-14 observations.

This module deliberately contains no engine, batch, evidence, filesystem,
network, environment, clock, or subprocess integration.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

OBSERVATION_SCHEMA_VERSION = "p14-canonical-observation-1"
MISSING = "MISSING"
MISSING_SEMANTICS = "MISSING_OR_INVALID_IN_ENGINE_RANK_DOMAIN"

CANDIDATE_PROJECTION_FIELDS = (
    "artifactIndex",
    "code",
    "tier",
    "marketRank",
    "prescreenScore",
    "prescreenRank",
    "prescreenPool",
    "marketScore",
    "rawCompositeScore",
    "sector",
    "dataStatus",
    "dataConfidence",
)
RANK_VECTOR_FIELDS = (
    "code",
    "prescreenScore",
    "prescreenRank",
    "prescreenPool",
    "marketRank",
    "marketScore",
    "rawCompositeScore",
)
REPLAY_CANDIDATE_FIELDS = (
    "code",
    "name",
    "sector",
    "price",
    "per",
    "pbr",
    "roe",
    "dividendYield",
    "sigma252d",
    "mom3m",
    "dataStatus",
    "prescreenScore",
    "prescreenRank",
    "prescreenPool",
)
ELIGIBLE_TIERS = frozenset({"deep_review", "actionable"})
ALL_TIERS = frozenset({"actionable", "deep_review", "screened", "excluded"})


class ObservationContractError(ValueError):
    """A value does not satisfy the strict P-14 observation contract."""


class StrictJSONError(ObservationContractError):
    """JSON bytes cannot be accepted without loss or ambiguity."""


def is_exact_int(value: Any) -> bool:
    """Return true for JSON integers, excluding bool (a Python int subclass)."""
    return type(value) is int


def require_nonnegative_int(value: Any, field: str) -> int:
    if not is_exact_int(value) or value < 0:
        raise ObservationContractError(f"{field} must be a nonnegative integer")
    return value


def require_positive_int(value: Any, field: str) -> int:
    if not is_exact_int(value) or value <= 0:
        raise ObservationContractError(f"{field} must be a positive integer")
    return value


def _json_owned(value: Any, path: str = "$") -> Any:
    """Validate finite JSON data and return a recursively owned copy."""
    if value is None or type(value) in (bool, int):
        return value
    if type(value) is str:
        try:
            value.encode("utf-8", errors="strict")
        except UnicodeEncodeError as exc:
            raise ObservationContractError(f"{path} contains invalid Unicode") from exc
        return value
    if type(value) is float:
        if not math.isfinite(value):
            raise ObservationContractError(f"{path} must contain only finite numbers")
        return value
    if type(value) is list:
        return [_json_owned(child, f"{path}[{index}]") for index, child in enumerate(value)]
    if type(value) is dict:
        owned: dict[str, Any] = {}
        for key, child in value.items():
            if type(key) is not str:
                raise ObservationContractError(f"{path} object keys must be strings")
            try:
                key.encode("utf-8", errors="strict")
            except UnicodeEncodeError as exc:
                raise ObservationContractError(f"{path} contains invalid Unicode key") from exc
            owned[key] = _json_owned(child, f"{path}.{key}")
        return owned
    raise ObservationContractError(f"{path} contains a non-JSON value")


def validate_finite_json(value: Any) -> None:
    """Raise unless value is an unambiguous finite JSON value."""
    _json_owned(value)


def _reject_constant(token: str) -> Any:
    raise StrictJSONError(f"non-finite JSON number is forbidden: {token}")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise StrictJSONError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def canonical_json_bytes(value: Any) -> bytes:
    """Encode deterministic UTF-8 JSON; this is not an RFC 8785 claim."""
    try:
        owned = _json_owned(value)
    except ObservationContractError as exc:
        raise StrictJSONError("value is not finite, unambiguous JSON data") from exc
    try:
        text = json.dumps(
            owned,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        return text.encode("utf-8", errors="strict")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise StrictJSONError("value cannot be encoded as canonical finite JSON") from exc


def strict_json_loads(payload: bytes | bytearray | memoryview | str, *, require_canonical: bool = False) -> Any:
    """Strictly decode UTF-8 JSON, rejecting duplicates, constants, and tails."""
    if isinstance(payload, str):
        try:
            raw = payload.encode("utf-8", errors="strict")
        except UnicodeEncodeError as exc:
            raise StrictJSONError("input contains invalid Unicode") from exc
        text = payload
    elif isinstance(payload, (bytes, bytearray, memoryview)):
        raw = bytes(payload)
        try:
            text = raw.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise StrictJSONError("input is not valid UTF-8") from exc
    else:
        raise StrictJSONError("JSON input must be UTF-8 text or bytes")

    try:
        value = json.loads(
            text,
            parse_constant=_reject_constant,
            object_pairs_hook=_unique_object,
        )
    except StrictJSONError:
        raise
    except (json.JSONDecodeError, UnicodeError, ValueError) as exc:
        raise StrictJSONError("invalid JSON or trailing data") from exc

    try:
        owned = _json_owned(value)
    except ObservationContractError as exc:
        raise StrictJSONError("decoded JSON contains invalid Unicode or non-finite values") from exc
    if require_canonical and canonical_json_bytes(owned) != raw:
        raise StrictJSONError("JSON bytes are not in canonical form")
    return owned


def content_digest(content: bytes | bytearray | memoryview | Any) -> str:
    """Return SHA-256 of bytes, or of the canonical encoding of a JSON value."""
    if isinstance(content, (bytes, bytearray, memoryview)):
        raw = bytes(content)
    else:
        raw = canonical_json_bytes(content)
    return hashlib.sha256(raw).hexdigest()


def _finite_number(value: Any, field: str, *, nullable: bool = True) -> None:
    if value is None and nullable:
        return
    if type(value) not in (int, float) or (type(value) is float and not math.isfinite(value)):
        raise ObservationContractError(f"{field} must be a finite JSON number")


def project_candidate_rows(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Return an owned, allowlisted projection in original artifact order."""
    if not isinstance(rows, (list, tuple)):
        raise ObservationContractError("candidate rows must be a sequence")
    projected: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        if type(row) is not dict:
            raise ObservationContractError(f"candidate row {index} must be an object")
        code = row.get("code")
        tier = row.get("tier")
        if type(code) is not str or code == "":
            raise ObservationContractError(f"candidate row {index} requires an exact nonempty code")
        if type(tier) is not str or tier not in ALL_TIERS:
            raise ObservationContractError(f"candidate row {index} has an unsupported tier")
        if "artifactIndex" in row and row["artifactIndex"] is not None:
            require_nonnegative_int(row["artifactIndex"], f"candidate row {index}.artifactIndex")
        if "marketRank" in row and row["marketRank"] is not None:
            require_positive_int(row["marketRank"], f"candidate row {index}.marketRank")
        for field in ("prescreenScore", "marketScore", "rawCompositeScore", "dataConfidence"):
            if field in row:
                _finite_number(row[field], f"candidate row {index}.{field}")
        if "prescreenRank" in row:
            raw_rank = row["prescreenRank"]
            if type(raw_rank) is float and not math.isfinite(raw_rank):
                raise ObservationContractError(f"candidate row {index}.prescreenRank must be finite JSON")
            if type(raw_rank) not in (type(None), bool, int, float, str):
                raise ObservationContractError(f"candidate row {index}.prescreenRank must be a JSON scalar")
        for field in ("prescreenPool", "sector", "dataStatus"):
            if field in row and row[field] is not None and type(row[field]) is not str:
                raise ObservationContractError(f"candidate row {index}.{field} must be a string or null")
        selected = {field: row[field] for field in CANDIDATE_PROJECTION_FIELDS if field in row}
        projected.append(_json_owned(selected, f"$.candidates[{index}]"))
    return projected


def project_rank_vector(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Derive the frozen seven-field vector by authoritative marketRank/code.

    rawCompositeScore is retained only because the frozen replay vector includes
    it; it is never consulted to establish or repair this ordering.
    """
    ranked: list[Mapping[str, Any]] = []
    for index, row in enumerate(rows):
        if type(row) is not dict:
            raise ObservationContractError(f"candidate row {index} must be an object")
        rank = row.get("marketRank")
        if rank is None:
            continue
        require_positive_int(rank, f"candidate row {index}.marketRank")
        if type(row.get("code")) is not str:
            raise ObservationContractError(f"candidate row {index}.code must be a string")
        ranked.append(row)
    ranked.sort(key=lambda row: (row["marketRank"], row["code"]))
    result: list[dict[str, Any]] = []
    for row in ranked:
        projected = {field: row.get(field) for field in RANK_VECTOR_FIELDS}
        for field in ("prescreenScore", "marketScore", "rawCompositeScore"):
            _finite_number(projected[field], field)
        if "prescreenRank" in row:
            raw_rank = row.get("prescreenRank")
            if type(raw_rank) is float and not math.isfinite(raw_rank):
                raise ObservationContractError("prescreenRank must be finite JSON")
            if type(raw_rank) not in (type(None), bool, int, float, str):
                raise ObservationContractError("prescreenRank must be a JSON scalar")
        result.append(_json_owned(projected))
    return result


def project_legacy_release_reference_shortlist(
    rows: Sequence[Mapping[str, Any]], *, n: int = 3,
    eligible_tiers: frozenset[str] = ELIGIBLE_TIERS,
) -> list[dict[str, Any]]:
    """Build the frozen v1 release projection with original artifact tie-breaks.

    This helper preserves historical artifactIndex behavior for parity only.
    The v2 reference classifier independently rejects duplicate eligible ranks
    and never uses artifactIndex to repair them.
    """
    require_positive_int(n, "n")
    validated_rows = project_candidate_rows(rows)
    domain: list[tuple[int, int, str, Mapping[str, Any]]] = []
    for index, row in enumerate(validated_rows):
        if row.get("tier") not in eligible_tiers:
            continue
        code = row.get("code")
        if type(code) is not str or code == "":
            raise ObservationContractError(f"eligible candidate row {index} requires an exact code")
        rank = require_positive_int(row.get("marketRank"), f"candidate row {index}.marketRank")
        artifact_index = row.get("artifactIndex", index)
        require_nonnegative_int(artifact_index, f"candidate row {index}.artifactIndex")
        domain.append((rank, artifact_index, code, row))
    domain.sort(key=lambda item: (item[0], item[1]))
    return [
        {
            "code": code,
            "tier": row["tier"],
            "eligibleRank": eligible_rank,
            "marketRank": rank,
            "artifactIndex": artifact_index,
        }
        for eligible_rank, (rank, artifact_index, code, row) in enumerate(domain[:n], start=1)
    ]


def diagnostic_prescreen_rank(row: Mapping[str, Any]) -> dict[str, Any]:
    """Encode the single approved VALID/MISSING tiebreak representation."""
    if row.get("tier") == "excluded" and row.get("marketRank") is None:
        raise ObservationContractError("unranked excluded rows have no participating prescreen rank key")
    raw_rank = row.get("prescreenRank")
    if type(raw_rank) is float and not math.isfinite(raw_rank):
        raise ObservationContractError("non-finite prescreen rank cannot be diagnosed")
    if is_exact_int(raw_rank) and raw_rank > 0:
        try:
            tie_break = float(raw_rank)
        except OverflowError as exc:
            raise ObservationContractError("prescreen rank cannot be represented as a finite tiebreak") from exc
        if not math.isfinite(tie_break):
            raise ObservationContractError("prescreen rank cannot be represented as a finite tiebreak")
        return {"prescreenRankTiebreakState": "VALID", "prescreenRankTiebreak": tie_break}
    return {"prescreenRankTiebreakState": MISSING}


def project_replay_candidate_input(joined_candidates: Sequence[Any]) -> list[Any]:
    """Apply the frozen 14-field structural allowlist without path I/O or rewriting."""
    if not isinstance(joined_candidates, (list, tuple)):
        raise ObservationContractError("joined candidates must be a sequence")
    projected: list[Any] = []
    for candidate in joined_candidates:
        if type(candidate) is dict:
            selected = {field: candidate[field] for field in REPLAY_CANDIDATE_FIELDS if field in candidate}
            projected.append(_json_owned(selected))
        else:
            projected.append(_json_owned(candidate))
    return projected


_REQUIRED_OBSERVATION_FIELDS = frozenset(
    {
        "schemaVersion",
        "policyVersion",
        "runIdentity",
        "sourceIdentity",
        "inputIdentity",
        "parameters",
        "base",
        "perturbed",
        "diagnosticAvailability",
    }
)
_ALLOWED_OBSERVATION_FIELDS = _REQUIRED_OBSERVATION_FIELDS | {"optionalOrderingFacts"}
_DECIMAL_STRING = re.compile(r"^[0-9]+$")


def validate_canonical_observation(value: Any) -> dict[str, Any]:
    """Validate and own the Phase I canonical observation value contract."""
    owned = _json_owned(value)
    if type(owned) is not dict:
        raise ObservationContractError("canonical observation must be an object")
    missing = _REQUIRED_OBSERVATION_FIELDS - owned.keys()
    unknown = owned.keys() - _ALLOWED_OBSERVATION_FIELDS
    if missing:
        raise ObservationContractError(f"canonical observation is incomplete: {sorted(missing)!r}")
    if unknown:
        raise ObservationContractError(f"canonical observation has unsupported fields: {sorted(unknown)!r}")
    if owned["schemaVersion"] != OBSERVATION_SCHEMA_VERSION:
        raise ObservationContractError("unsupported canonical observation schema")
    if type(owned["policyVersion"]) is not str or not owned["policyVersion"]:
        raise ObservationContractError("policyVersion must be a nonempty exact string")
    run = owned["runIdentity"]
    if type(run) is not dict:
        raise ObservationContractError("runIdentity must be an object")
    required_run = ("repository", "workflow", "job", "runId", "runAttempt", "event", "gitRef", "gitRefType", "gitSha")
    if any(type(run.get(key)) is not str or not run[key] for key in required_run):
        raise ObservationContractError("runIdentity is missing a required exact string")
    if not _DECIMAL_STRING.fullmatch(run["runId"]) or not _DECIMAL_STRING.fullmatch(run["runAttempt"]):
        raise ObservationContractError("runId and runAttempt must be decimal strings")
    for field in ("sourceIdentity", "inputIdentity", "parameters", "diagnosticAvailability"):
        if type(owned[field]) is not dict:
            raise ObservationContractError(f"{field} must be an object")
    for side in ("base", "perturbed"):
        projection = owned[side]
        if type(projection) is not dict or type(projection.get("candidates")) is not list:
            raise ObservationContractError(f"{side}.candidates must be an array")
        projected_rows = project_candidate_rows(projection["candidates"])
        if projected_rows != projection["candidates"]:
            raise ObservationContractError(f"{side}.candidates must contain only canonical projected fields")
        if any(set(row) - set(CANDIDATE_PROJECTION_FIELDS) for row in projected_rows):
            raise ObservationContractError(f"{side}.candidates contains an unapproved field")
    if "optionalOrderingFacts" in owned and type(owned["optionalOrderingFacts"]) is not dict:
        raise ObservationContractError("optionalOrderingFacts must be an object")
    return owned


@dataclass(frozen=True, slots=True)
class CanonicalP14Observation:
    """Immutable bytes-only value; each decoded view is newly owned."""

    payload_bytes: bytes
    sha256: str

    def __post_init__(self) -> None:
        if type(self.payload_bytes) is not bytes:
            raise ObservationContractError("payload_bytes must be immutable bytes")
        decoded = strict_json_loads(self.payload_bytes, require_canonical=True)
        validate_canonical_observation(decoded)
        expected = hashlib.sha256(self.payload_bytes).hexdigest()
        if type(self.sha256) is not str or self.sha256 != expected:
            raise ObservationContractError("canonical observation digest mismatch")

    @classmethod
    def from_value(cls, value: Any) -> "CanonicalP14Observation":
        validated = validate_canonical_observation(value)
        raw = canonical_json_bytes(validated)
        return cls(payload_bytes=raw, sha256=hashlib.sha256(raw).hexdigest())

    @classmethod
    def from_bytes(cls, payload: bytes | bytearray | memoryview) -> "CanonicalP14Observation":
        raw = bytes(payload)
        decoded = strict_json_loads(raw, require_canonical=True)
        validate_canonical_observation(decoded)
        return cls(payload_bytes=raw, sha256=hashlib.sha256(raw).hexdigest())

    @property
    def content_digest(self) -> str:
        return self.sha256

    def to_value(self) -> dict[str, Any]:
        return strict_json_loads(self.payload_bytes, require_canonical=True)


def make_canonical_p14_observation(value: Any) -> CanonicalP14Observation:
    """Construct a bytes-only canonical observation from projected pure values."""
    return CanonicalP14Observation.from_value(value)
