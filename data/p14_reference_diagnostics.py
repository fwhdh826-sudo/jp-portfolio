"""Pure evidence-only P-14 diagnostics and strict privacy serialization.

This module is not imported by public-artifact or release code. It accepts
value-contract inputs and classifier outputs only, and stores output as bytes.
"""
from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from data.p14_observation import (
    CanonicalP14Observation,
    MISSING,
    ObservationContractError,
    canonical_json_bytes,
    diagnostic_prescreen_rank,
    strict_json_loads,
    validate_canonical_observation,
)
from data.p14_reference_classifier import (
    CAUSE_UNRESOLVED,
    ClassificationResult,
    CauseClassification,
    classify_cause,
)

DIAGNOSTICS_SCHEMA_VERSION = "p14-reference-diagnostics-1"
S03_DECISION = "REJECT"
LIVE_CAUSAL_DIAGNOSTIC_POSSIBLE = "PARTIAL"

FORBIDDEN_KEYS = frozenset(
    {
        "portfolioFit", "portfolio", "holdings", "cash", "reserve", "amount",
        "maxAmount", "sizing", "headroom", "quantity", "purchasePrice",
        "marketValue", "officialDecision", "action", "BUY_NEW", "WATCH", "SELL",
        "account", "accountType", "broker", "nisa", "csv", "blockedReasons",
        "normalizedPrescreenScore", "eval", "pnlPct", "purchase_date", "acquiredAt",
    }
)
_SECRET_PATTERNS = (
    re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
)
_PRIVATE_PATH_PATTERNS = (
    re.compile(r"/Users/[^/\s\"']+(?:/[^/\s\"']+)*"),
    re.compile(r"/home/[^/\s\"']+(?:/[^/\s\"']+)*"),
)
_REQUIRED_KEYS = frozenset(
    {
        "diagnosticsVersion", "classification", "causalClassification", "completeness",
        "population", "referenceShortlist", "candidateTransitions", "retainedMemberOrder",
        "orderingObservations", "prescreenRankTiebreaks",
    }
)
_ALLOWED_KEYS = _REQUIRED_KEYS | frozenset({"observationDigest", "policyVersion"})
_COMPLETENESS_STATES = frozenset({"COMPLETE", "PARTIAL", "UNAVAILABLE", "CONTRADICTORY"})


class DiagnosticContractError(ValueError):
    """A diagnostic record is malformed, incomplete, or unsupported."""


class DiagnosticPrivacyError(DiagnosticContractError):
    """A diagnostic contains an exact forbidden key or private material."""


def _owned_value(value: Any, field: str = "$") -> Any:
    """Validate JSON shape and copy through the canonical codec."""
    try:
        return strict_json_loads(canonical_json_bytes(value), require_canonical=True)
    except ObservationContractError as exc:
        raise DiagnosticContractError(f"{field} is not finite JSON") from exc


def _forbidden_key_paths(value: Any, path: str = "$") -> list[str]:
    found: list[str] = []
    if type(value) is dict:
        for key, child in value.items():
            if key in FORBIDDEN_KEYS:
                found.append(f"{path}.{key}")
            found.extend(_forbidden_key_paths(child, f"{path}.{key}"))
    elif type(value) is list:
        for index, child in enumerate(value):
            found.extend(_forbidden_key_paths(child, f"{path}[{index}]"))
    return found


def _validate_privacy(payload: Any, raw: bytes) -> None:
    key_paths = _forbidden_key_paths(payload)
    if key_paths:
        raise DiagnosticPrivacyError("forbidden diagnostic key: " + ", ".join(key_paths))
    text = raw.decode("utf-8", errors="strict")
    if any(pattern.search(text) for pattern in _SECRET_PATTERNS):
        raise DiagnosticPrivacyError("token-shaped secret material is forbidden")
    if any(pattern.search(text) for pattern in _PRIVATE_PATH_PATTERNS):
        raise DiagnosticPrivacyError("private absolute paths are forbidden")


def _validate_rank_sentinel(node: Any, path: str = "$") -> None:
    if type(node) is dict:
        if "prescreenRankTiebreakState" in node:
            state = node["prescreenRankTiebreakState"]
            has_value = "prescreenRankTiebreak" in node
            if state == MISSING:
                if has_value:
                    raise DiagnosticContractError(f"{path} MISSING rank must omit its numeric value")
            elif state == "VALID":
                value = node.get("prescreenRankTiebreak")
                if not has_value or type(value) not in (int, float) or (type(value) is float and not math.isfinite(value)):
                    raise DiagnosticContractError(f"{path} VALID rank requires a finite numeric value")
            else:
                raise DiagnosticContractError(f"{path} has an unsupported rank sentinel")
        for key, child in node.items():
            _validate_rank_sentinel(child, f"{path}.{key}")
    elif type(node) is list:
        for index, child in enumerate(node):
            _validate_rank_sentinel(child, f"{path}[{index}]")


def _validate_raw_score_authority(node: Any, path: str = "$") -> None:
    if type(node) is dict:
        if "rawCompositeScore" in node:
            raw = node["rawCompositeScore"]
            if type(raw) is list:
                if any(type(item) is not dict or item.get("authority") != "DIAGNOSTIC_ONLY" for item in raw):
                    raise DiagnosticContractError(f"{path}.rawCompositeScore must be labelled DIAGNOSTIC_ONLY")
            elif node.get("rawCompositeScoreAuthority") != "DIAGNOSTIC_ONLY":
                raise DiagnosticContractError(f"{path}.rawCompositeScore must be labelled DIAGNOSTIC_ONLY")
        for key, child in node.items():
            _validate_raw_score_authority(child, f"{path}.{key}")
    elif type(node) is list:
        for index, child in enumerate(node):
            _validate_raw_score_authority(child, f"{path}[{index}]")


def validate_reference_diagnostics(value: Any) -> dict[str, Any]:
    """Validate the whole diagnostic record before any output bytes are emitted."""
    payload = _owned_value(value)
    if type(payload) is not dict:
        raise DiagnosticContractError("diagnostic representation must be an object")
    forbidden_paths = _forbidden_key_paths(payload)
    if forbidden_paths:
        raise DiagnosticPrivacyError("forbidden diagnostic key: " + ", ".join(forbidden_paths))
    missing = _REQUIRED_KEYS - payload.keys()
    unknown = payload.keys() - _ALLOWED_KEYS
    if missing:
        raise DiagnosticContractError("diagnostic representation is incomplete: " + ", ".join(sorted(missing)))
    if unknown:
        raise DiagnosticContractError("diagnostic representation has unsupported fields: " + ", ".join(sorted(unknown)))
    if payload["diagnosticsVersion"] != DIAGNOSTICS_SCHEMA_VERSION:
        raise DiagnosticContractError("unsupported diagnostics version")

    classification = _classification_value(payload["classification"])
    cause = payload["causalClassification"]
    if type(cause) is not dict or cause.get("status") not in {
        "KNOWN_CAUSE", CAUSE_UNRESOLVED, "CONTRADICTORY"
    }:
        raise DiagnosticContractError("causalClassification is missing or unsupported")
    if cause["status"] == "KNOWN_CAUSE" and (type(cause.get("causeClass")) is not str or not cause["causeClass"]):
        raise DiagnosticContractError("known cause requires an exact causeClass")
    if cause["status"] != "KNOWN_CAUSE" and "causeClass" in cause:
        raise DiagnosticContractError("unresolved or contradictory cause must omit causeClass")

    completeness = payload["completeness"]
    completeness_fields = {
        "classification", "cause", "population", "referenceShortlist",
        "candidateTransitions", "retainedMemberOrder", "orderingObservations",
        "prescreenRankTiebreaks",
    }
    if type(completeness) is not dict or set(completeness) != completeness_fields:
        raise DiagnosticContractError("completeness must describe every required diagnostic section")
    if any(
        type(state) is not str or state not in _COMPLETENESS_STATES or state == "PARTIAL"
        for state in completeness.values()
    ):
        raise DiagnosticContractError("partial or unsupported diagnostic sections must be rejected")

    expected_classification_state = "CONTRADICTORY" if classification["status"] == "CONTRADICTORY" else "COMPLETE"
    if completeness["classification"] != expected_classification_state:
        raise DiagnosticContractError("classification completeness does not match its semantic status")
    if type(payload["candidateTransitions"]) is not list:
        raise DiagnosticContractError("candidateTransitions must be a record list")
    if payload["candidateTransitions"] != classification["transitions"]:
        raise DiagnosticContractError("candidateTransitions must match the pure classifier result")
    if classification["status"] != "SUPPORTED" and payload["candidateTransitions"]:
        raise DiagnosticContractError("unsupported classification cannot emit transitions")
    if type(classification.get("classes")) is not list:
        raise DiagnosticContractError("classification classes must be a list")
    if classification["status"] != "SUPPORTED" and classification["classes"]:
        raise DiagnosticContractError("integrity or contradiction results cannot emit transition classes")
    if completeness["candidateTransitions"] != "COMPLETE":
        raise DiagnosticContractError("transition emission must be complete or omitted by a typed failure")

    population = payload["population"]
    if type(population) is dict and population == {"status": "UNAVAILABLE"}:
        if classification["status"] == "SUPPORTED":
            raise DiagnosticContractError("supported classification requires observed population counts")
        if completeness["population"] != "UNAVAILABLE":
            raise DiagnosticContractError("unavailable population must be labelled UNAVAILABLE")
    elif (
        classification["status"] == "SUPPORTED"
        and type(population) is dict
        and set(population) == {"base", "perturbed"}
        and all(type(population[key]) is int and population[key] >= 0 for key in ("base", "perturbed"))
    ):
        if completeness["population"] != "COMPLETE":
            raise DiagnosticContractError("available population counts must be COMPLETE")
        if population != classification["population"]:
            raise DiagnosticContractError("population projection must match the pure classifier result")
    else:
        raise DiagnosticContractError("population must contain exact counts or typed UNAVAILABLE state")

    reference = payload["referenceShortlist"]
    if type(reference) is dict and reference == {"status": "UNAVAILABLE"}:
        if classification["status"] == "SUPPORTED":
            raise DiagnosticContractError("supported classification requires observed reference lists")
        if completeness["referenceShortlist"] != "UNAVAILABLE":
            raise DiagnosticContractError("unavailable shortlist must be labelled UNAVAILABLE")
    elif (
        classification["status"] == "SUPPORTED"
        and type(reference) is dict
        and set(reference) == {"base", "perturbed"}
    ):
        if any(
            type(reference[side]) is not list
            or any(type(code) is not str or code == "" for code in reference[side])
            or len(reference[side]) != len(set(reference[side]))
            for side in ("base", "perturbed")
        ):
            raise DiagnosticContractError("reference shortlist must contain exact code lists")
        if completeness["referenceShortlist"] != "COMPLETE":
            raise DiagnosticContractError("available shortlist must be COMPLETE")
        if (
            reference["base"] != classification["baseShortlistCodes"]
            or reference["perturbed"] != classification["perturbedShortlistCodes"]
        ):
            raise DiagnosticContractError("reference shortlist must match the pure classifier result")
    else:
        raise DiagnosticContractError("reference shortlist is malformed or unavailable without a state")

    retained = payload["retainedMemberOrder"]
    if type(retained) is dict and retained == {"status": "UNAVAILABLE"}:
        if classification["status"] == "SUPPORTED":
            raise DiagnosticContractError("supported classification requires retained-order values")
        if completeness["retainedMemberOrder"] != "UNAVAILABLE":
            raise DiagnosticContractError("unavailable retained order must be labelled UNAVAILABLE")
    elif (
        classification["status"] == "SUPPORTED"
        and type(retained) is dict
        and set(retained) == {"changed", "base", "perturbed"}
    ):
        if type(retained["changed"]) is not bool or any(
            type(retained[side]) is not list
            or any(type(code) is not str or code == "" for code in retained[side])
            for side in ("base", "perturbed")
        ):
            raise DiagnosticContractError("retained order must use strict booleans and code lists")
        if retained["changed"] != (retained["base"] != retained["perturbed"]):
            raise DiagnosticContractError("retained order changed flag contradicts its ordered lists")
        base_codes = classification["baseShortlistCodes"]
        perturbed_codes = classification["perturbedShortlistCodes"]
        retained_codes = set(base_codes) & set(perturbed_codes)
        expected_base_retained = [code for code in base_codes if code in retained_codes]
        expected_perturbed_retained = [code for code in perturbed_codes if code in retained_codes]
        if (
            retained["changed"] != classification["orderChanged"]
            or retained["base"] != expected_base_retained
            or retained["perturbed"] != expected_perturbed_retained
        ):
            raise DiagnosticContractError("retained order must match the pure classifier result")
        if completeness["retainedMemberOrder"] != "COMPLETE":
            raise DiagnosticContractError("available retained order must be COMPLETE")
    else:
        raise DiagnosticContractError("retained member order is malformed or unavailable without a state")

    for section in ("orderingObservations", "prescreenRankTiebreaks"):
        body = payload[section]
        if type(body) is dict and body == {"status": "UNAVAILABLE"}:
            if completeness[section] != "UNAVAILABLE":
                raise DiagnosticContractError(f"unavailable {section} must be labelled UNAVAILABLE")
        elif type(body) is list:
            if completeness[section] != "COMPLETE":
                raise DiagnosticContractError(f"available {section} must be COMPLETE")
        else:
            raise DiagnosticContractError(f"{section} must be a record list or typed UNAVAILABLE state")

    if cause["status"] == CAUSE_UNRESOLVED and completeness["cause"] != "UNAVAILABLE":
        raise DiagnosticContractError("CAUSE_UNRESOLVED must be marked UNAVAILABLE")
    if cause["status"] == "CONTRADICTORY" and completeness["cause"] != "CONTRADICTORY":
        raise DiagnosticContractError("contradictory cause must be marked CONTRADICTORY")
    if cause["status"] == "KNOWN_CAUSE" and completeness["cause"] != "COMPLETE":
        raise DiagnosticContractError("known cause must be marked COMPLETE")

    if "observationDigest" in payload:
        digest = payload["observationDigest"]
        if type(digest) is not str or len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise DiagnosticContractError("observationDigest must be lowercase SHA-256")
    if "policyVersion" in payload and (type(payload["policyVersion"]) is not str or not payload["policyVersion"]):
        raise DiagnosticContractError("policyVersion must be a nonempty exact string")

    _validate_rank_sentinel(payload)
    _validate_raw_score_authority(payload)
    # Privacy is checked against canonical bytes, but the bytes are not returned
    # until all structural and semantic checks above have passed.
    raw = canonical_json_bytes(payload)
    _validate_privacy(payload, raw)
    return payload


def serialize_reference_diagnostics(value: Any) -> bytes:
    """Return strict bytes or reject the entire diagnostic representation."""
    payload = validate_reference_diagnostics(value)
    return canonical_json_bytes(payload)


def decode_reference_diagnostics(payload: bytes | bytearray | memoryview) -> dict[str, Any]:
    """Strictly decode a canonical diagnostic document and validate its contract."""
    raw = bytes(payload)
    value = strict_json_loads(raw, require_canonical=True)
    validated = validate_reference_diagnostics(value)
    if canonical_json_bytes(validated) != raw:
        raise DiagnosticContractError("diagnostic bytes are not canonical")
    return validated


def _cause_value(result: CauseClassification | Mapping[str, Any]) -> dict[str, Any]:
    value = result.as_dict() if isinstance(result, CauseClassification) else result
    if type(value) is not dict:
        raise DiagnosticContractError("cause classification must be a value object")
    return _owned_value(value, "cause classification")


def _classification_value(result: ClassificationResult | Mapping[str, Any]) -> dict[str, Any]:
    value = result.as_dict() if isinstance(result, ClassificationResult) else result
    if type(value) is not dict:
        raise DiagnosticContractError("classifier result must be a value object")
    owned = _owned_value(value, "classification")
    required = {"status", "classes", "violations", "transitions"}
    if not required.issubset(owned):
        raise DiagnosticContractError("classifier result is incomplete")
    if (
        owned["status"] not in {"SUPPORTED", "INTEGRITY_FAILURE", "CONTRADICTORY"}
        or type(owned["classes"]) is not list
        or any(type(item) is not str for item in owned["classes"])
        or type(owned["violations"]) is not list
        or any(type(item) is not str for item in owned["violations"])
        or type(owned["transitions"]) is not list
    ):
        raise DiagnosticContractError("classifier result has invalid field types")
    if owned["status"] == "SUPPORTED":
        supported_fields = {
            "population", "baseShortlistCodes", "perturbedShortlistCodes",
            "enteredReferenceCodes", "exitedReferenceCodes", "enteredEligibleCodes",
            "exitedEligibleCodes", "membershipChanged", "tierChanged", "orderChanged",
        }
        if not supported_fields.issubset(owned):
            raise DiagnosticContractError("supported classifier result is incomplete")
        if any(type(owned[field]) is not bool for field in ("membershipChanged", "tierChanged", "orderChanged")):
            raise DiagnosticContractError("supported classifier booleans must be exact booleans")
        code_fields = (
            "baseShortlistCodes", "perturbedShortlistCodes", "enteredReferenceCodes",
            "exitedReferenceCodes", "enteredEligibleCodes", "exitedEligibleCodes",
        )
        if any(
            type(owned[field]) is not list or any(type(code) is not str or code == "" for code in owned[field])
            or len(owned[field]) != len(set(owned[field]))
            for field in code_fields
        ):
            raise DiagnosticContractError("supported classifier code sets must be unique exact-string lists")
        population = owned["population"]
        if (
            type(population) is not dict or set(population) != {"base", "perturbed"}
            or any(type(population[key]) is not int or population[key] < 0 for key in ("base", "perturbed"))
        ):
            raise DiagnosticContractError("supported classifier population must use exact nonnegative integers")
        if owned["violations"] or not owned["classes"]:
            raise DiagnosticContractError("supported classifier result must have classes and no violations")
    elif (
        owned["classes"] or owned["transitions"] or not owned["violations"]
        or any(key in owned for key in ("population", "membershipChanged", "tierChanged", "orderChanged"))
    ):
        raise DiagnosticContractError("integrity or contradiction result cannot invent population, flags, or transitions")
    return owned


def build_reference_diagnostics(
    classification: ClassificationResult | Mapping[str, Any],
    *,
    cause_evidence: Any = None,
    observation: CanonicalP14Observation | Mapping[str, Any] | None = None,
    ordering_observations: Sequence[Mapping[str, Any]] | None = None,
    prescreen_rank_rows: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build an owned evidence-only diagnostic record from pure values."""
    classification_value = _classification_value(classification)
    cause_value = classify_cause(cause_evidence).as_dict()
    if cause_value["status"] == "KNOWN_CAUSE":
        cause_completeness = "COMPLETE"
    elif cause_value["status"] == "CONTRADICTORY":
        cause_completeness = "CONTRADICTORY"
    else:
        cause_completeness = "UNAVAILABLE"

    has_population = "population" in classification_value
    has_shortlist = "baseShortlistCodes" in classification_value and "perturbedShortlistCodes" in classification_value
    has_order = "orderChanged" in classification_value
    if ordering_observations is None:
        ordering_value: Any = {"status": "UNAVAILABLE"}
    else:
        ordering_value = []
        for item in ordering_observations:
            if not isinstance(item, Mapping):
                raise DiagnosticContractError("ordering observations must be value records")
            ordering_value.append(_owned_value(dict(item)))
    if prescreen_rank_rows is None:
        prescreen_values: Any = {"status": "UNAVAILABLE"}
    else:
        prescreen_values = []
        for row in prescreen_rank_rows:
            if not isinstance(row, Mapping):
                raise DiagnosticContractError("prescreen rank inputs must be value records")
            try:
                rank_record = diagnostic_prescreen_rank(row)
            except ObservationContractError as exc:
                raise DiagnosticContractError("non-finite prescreen rank rejects the diagnostic") from exc
            if "code" in row:
                if type(row["code"]) is not str or not row["code"]:
                    raise DiagnosticContractError("prescreen rank code must be an exact nonempty string")
                rank_record["code"] = row["code"]
            prescreen_values.append(_owned_value(rank_record))

    population_value = classification_value.get("population") if has_population else {"status": "UNAVAILABLE"}
    reference_value = (
        {
            "base": classification_value["baseShortlistCodes"],
            "perturbed": classification_value["perturbedShortlistCodes"],
        }
        if has_shortlist else {"status": "UNAVAILABLE"}
    )
    if has_order and has_shortlist:
        base_codes = classification_value["baseShortlistCodes"]
        perturbed_codes = classification_value["perturbedShortlistCodes"]
        retained_codes = set(base_codes) & set(perturbed_codes)
        retained_order = {
            "changed": classification_value["orderChanged"],
            "base": [code for code in base_codes if code in retained_codes],
            "perturbed": [code for code in perturbed_codes if code in retained_codes],
        }
    else:
        retained_order = {"status": "UNAVAILABLE"}

    class_status = classification_value.get("status")
    cause_section_state = (
        "COMPLETE" if cause_value["status"] == "KNOWN_CAUSE"
        else "CONTRADICTORY" if cause_value["status"] == "CONTRADICTORY"
        else "UNAVAILABLE"
    )
    payload: dict[str, Any] = {
        "diagnosticsVersion": DIAGNOSTICS_SCHEMA_VERSION,
        "classification": classification_value,
        "causalClassification": cause_value,
        "completeness": {
            "classification": "CONTRADICTORY" if class_status == "CONTRADICTORY" else "COMPLETE",
            "cause": cause_section_state,
            "population": "COMPLETE" if has_population else "UNAVAILABLE",
            "referenceShortlist": "COMPLETE" if has_shortlist else "UNAVAILABLE",
            "candidateTransitions": "COMPLETE",
            "retainedMemberOrder": "COMPLETE" if has_order and has_shortlist else "UNAVAILABLE",
            "orderingObservations": "COMPLETE" if isinstance(ordering_value, list) else "UNAVAILABLE",
            "prescreenRankTiebreaks": "COMPLETE" if isinstance(prescreen_values, list) else "UNAVAILABLE",
        },
        "population": population_value,
        "referenceShortlist": reference_value,
        "candidateTransitions": classification_value["transitions"],
        "retainedMemberOrder": retained_order,
        "orderingObservations": ordering_value,
        "prescreenRankTiebreaks": prescreen_values,
    }
    if isinstance(observation, CanonicalP14Observation):
        payload["observationDigest"] = observation.sha256
        payload["policyVersion"] = observation.to_value()["policyVersion"]
    elif observation is not None:
        owned_observation = validate_canonical_observation(observation)
        digest = hashlib.sha256(canonical_json_bytes(owned_observation)).hexdigest()
        payload["observationDigest"] = digest
        if "policyVersion" in owned_observation:
            payload["policyVersion"] = owned_observation["policyVersion"]

    return validate_reference_diagnostics(payload)


@dataclass(frozen=True, slots=True)
class ReferenceDiagnosticDocument:
    """Immutable diagnostic bytes; decoded values are detached on every read."""

    payload_bytes: bytes
    sha256: str

    def __post_init__(self) -> None:
        if type(self.payload_bytes) is not bytes:
            raise DiagnosticContractError("diagnostic bytes must be immutable")
        decode_reference_diagnostics(self.payload_bytes)
        if hashlib.sha256(self.payload_bytes).hexdigest() != self.sha256:
            raise DiagnosticContractError("diagnostic digest mismatch")

    @classmethod
    def from_value(cls, value: Any) -> "ReferenceDiagnosticDocument":
        raw = serialize_reference_diagnostics(value)
        return cls(raw, hashlib.sha256(raw).hexdigest())

    @classmethod
    def from_inputs(
        cls,
        classification: ClassificationResult | Mapping[str, Any],
        **kwargs: Any,
    ) -> "ReferenceDiagnosticDocument":
        return cls.from_value(build_reference_diagnostics(classification, **kwargs))

    def to_value(self) -> dict[str, Any]:
        return decode_reference_diagnostics(self.payload_bytes)
