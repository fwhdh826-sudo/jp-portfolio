"""Pure, exact-identity dispatch contracts for dormant P-14 policy routes.

No policy severity is selected here. V2 identities exist only as explicit,
test-injected registry entries; there is no production v2 literal or fallback.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Callable, Mapping, Sequence

P14_DECISION_AWARE_V1 = "p14-decision-aware-v1"
LEGACY_ROUTE = "legacy-binary"
V1_ROUTE = "decision-aware-v1"
V2_ROUTE = "explicit-v2"
UNSUPPORTED_ROUTE = "unsupported"
SCHEMA_COMPATIBLE_NOT_REPLAYABLE = "schema-compatible-not-replayable"

LEGACY_PARAMETERS = MappingProxyType({
    "threshold": 0.95,
    "topK": 40,
    "perturbationPct": 0.02,
    "assignmentContract": "p14-prescreen-rank-code-v1",
})
V1_PARAMETERS = MappingProxyType({**LEGACY_PARAMETERS, "policyVersion": P14_DECISION_AWARE_V1})
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class UnsupportedPolicyError(ValueError):
    """Raised when an identity is unknown, malformed, ambiguous, or mismatched."""


def _strict_equal(left: Any, right: Any) -> bool:
    """JSON-shaped recursive equality that never equates bool and int."""
    if type(left) is not type(right):
        return False
    if type(left) is dict:
        return left.keys() == right.keys() and all(_strict_equal(left[key], right[key]) for key in left)
    if type(left) is list:
        return len(left) == len(right) and all(_strict_equal(a, b) for a, b in zip(left, right))
    return left == right


def _freeze_parameter(value: Any) -> Any:
    if type(value) is dict:
        if any(type(key) is not str for key in value):
            raise ValueError("policy parameter keys must be exact strings")
        return ("__p14_object__", tuple((key, _freeze_parameter(value[key])) for key in sorted(value)))
    if type(value) is list:
        return ("__p14_array__", tuple(_freeze_parameter(child) for child in value))
    if type(value) not in (type(None), bool, int, float, str):
        raise ValueError("policy parameters must be finite JSON scalars or containers")
    if type(value) is float and (value != value or value in (float("inf"), float("-inf"))):
        raise ValueError("policy parameters must be finite")
    return value


def _thaw_parameter(value: Any) -> Any:
    if type(value) is tuple and len(value) == 2 and value[0] == "__p14_object__":
        return {key: _thaw_parameter(child) for key, child in value[1]}
    if type(value) is tuple and len(value) == 2 and value[0] == "__p14_array__":
        return [_thaw_parameter(child) for child in value[1]]
    return value


def _release_identity(bundle: Mapping[str, Any]) -> tuple[bool, Any, bool]:
    p14 = bundle.get("p14")
    if type(p14) is not dict:
        return False, None, False
    release_present = "release" in p14
    release = p14.get("release")
    if type(release) is not dict:
        return release_present, None, False
    return release_present, release.get("policyVersion"), "policyVersion" in release


@dataclass(frozen=True, slots=True)
class PolicyEntry:
    """An explicit evaluator binding supplied by an authorized composition root."""

    policy_version: str
    route: str
    expected_parameters: tuple[tuple[str, Any], ...]
    evaluator: Callable[[Mapping[str, Any]], Any] | None = field(default=None, compare=False, repr=False)
    injected_for_test: bool = False
    definition_digest: str | None = None

    def __post_init__(self) -> None:
        if type(self.policy_version) is not str or not self.policy_version:
            raise ValueError("policy entry requires an exact nonempty identity")
        if self.policy_version == P14_DECISION_AWARE_V1 or self.route != V2_ROUTE:
            raise ValueError("only an explicit test v2 route may be injected")
        if self.injected_for_test is not True:
            raise ValueError("v2 registry entries must be explicitly test-injected")
        if type(self.definition_digest) is not str or not _SHA256_RE.fullmatch(self.definition_digest):
            raise ValueError("v2 registry entries require a SHA-256 definition digest")
        if type(self.expected_parameters) is not tuple:
            raise ValueError("expected_parameters must be an immutable tuple")
        frozen_pairs = []
        for pair in self.expected_parameters:
            if type(pair) is not tuple or len(pair) != 2 or type(pair[0]) is not str:
                raise ValueError("expected_parameters must contain exact key/value pairs")
            frozen_pairs.append((pair[0], _freeze_parameter(pair[1])))
        if len({key for key, _ in frozen_pairs}) != len(frozen_pairs):
            raise ValueError("expected parameter keys must be unique")
        object.__setattr__(self, "expected_parameters", tuple(sorted(frozen_pairs, key=lambda pair: pair[0])))
        thawed = dict((key, _thaw_parameter(value)) for key, value in self.expected_parameters)
        if thawed.get("policyVersion") != self.policy_version:
            raise ValueError("v2 parameters must bind the exact policy identity")
        if thawed.get("definitionDigest") != self.definition_digest:
            raise ValueError("v2 parameters must bind the injected definition digest")

    @classmethod
    def injected_v2_for_test(
        cls,
        policy_version: str,
        expected_parameters: Mapping[str, Any],
        *,
        definition_digest: str,
        evaluator: Callable[[Mapping[str, Any]], Any] | None = None,
    ) -> "PolicyEntry":
        if type(policy_version) is not str or not policy_version or policy_version == P14_DECISION_AWARE_V1:
            raise ValueError("test v2 requires a distinct explicit policy identity")
        if type(definition_digest) is not str or not _SHA256_RE.fullmatch(definition_digest):
            raise ValueError("test v2 requires an explicit SHA-256 definition digest")
        if type(expected_parameters) is not dict:
            raise ValueError("expected_parameters must be an exact object")
        if expected_parameters.get("policyVersion") != policy_version:
            raise ValueError("test v2 parameters must bind the exact policy identity")
        return cls(
            policy_version=policy_version,
            route=V2_ROUTE,
            expected_parameters=tuple((key, expected_parameters[key]) for key in sorted(expected_parameters)),
            evaluator=evaluator,
            injected_for_test=True,
            definition_digest=definition_digest,
        )

    def parameter_mapping(self) -> dict[str, Any]:
        return {key: _thaw_parameter(value) for key, value in self.expected_parameters}


@dataclass(frozen=True, slots=True)
class PolicyDispatch:
    route: str
    policy_version: str | None
    status: str
    reason: str | None = None
    _evaluator: Callable[[Mapping[str, Any]], Any] | None = field(default=None, compare=False, repr=False)
    _entry: PolicyEntry | None = field(default=None, compare=False, repr=False)

    @property
    def supported(self) -> bool:
        return self.status == "SUPPORTED"

    def evaluate(self, bundle: Mapping[str, Any]) -> Any:
        """Invoke only the evaluator whose exact identity produced this dispatch."""
        if not self.supported or self._evaluator is None:
            raise UnsupportedPolicyError(self.reason or "no evaluator is registered for this route")
        repeated = dispatch_policy(
            bundle,
            legacy_evaluator=self._evaluator if self.route == LEGACY_ROUTE else None,
            v1_evaluator=self._evaluator if self.route == V1_ROUTE else None,
            injected_policies=(self._entry,) if self._entry is not None else (),
        )
        if not repeated.supported or repeated.route != self.route or repeated.policy_version != self.policy_version:
            raise UnsupportedPolicyError("evaluator-local policy identity guard refused the call")
        if self.route == V2_ROUTE and repeated._entry != self._entry:
            raise UnsupportedPolicyError("v2 evaluator binding changed")
        return self._evaluator(bundle)


def _unsupported(reason: str, policy_version: str | None = None) -> PolicyDispatch:
    return PolicyDispatch(UNSUPPORTED_ROUTE, policy_version, "UNSUPPORTED", reason)


def dispatch_policy(
    bundle: Mapping[str, Any],
    *,
    legacy_evaluator: Callable[[Mapping[str, Any]], Any] | None = None,
    v1_evaluator: Callable[[Mapping[str, Any]], Any] | None = None,
    injected_policies: Sequence[PolicyEntry] = (),
) -> PolicyDispatch:
    """Resolve a bundle only by exact schema and policy identity."""
    if type(bundle) is not dict:
        return _unsupported("INVALID_BUNDLE")
    schema = bundle.get("schemaVersion")
    if schema == "candidate-funnel-run-evidence-1":
        return PolicyDispatch(SCHEMA_COMPATIBLE_NOT_REPLAYABLE, None, "COMPATIBLE", "SCHEMA_1_NOT_REPLAYABLE")

    if schema != "candidate-funnel-run-evidence-2":
        return _unsupported("UNSUPPORTED_EVIDENCE_SCHEMA")

    params = bundle.get("p14Parameters")
    if type(params) is not dict:
        return _unsupported("INVALID_P14_PARAMETERS")
    has_version = "policyVersion" in params
    release_present, release_version, release_has_version = _release_identity(bundle)
    if not has_version:
        if release_present or release_has_version:
            return _unsupported("AMBIGUOUS_MISSING_POLICY_VERSION")
        if not _strict_equal(params, dict(LEGACY_PARAMETERS)):
            return _unsupported("INVALID_LEGACY_PARAMETERS")
        return PolicyDispatch(LEGACY_ROUTE, None, "SUPPORTED", _evaluator=legacy_evaluator)

    version = params["policyVersion"]
    if type(version) is not str or not version:
        return _unsupported("INVALID_EXPLICIT_POLICY_VERSION")
    if release_present and (not release_has_version or type(release_version) is not str or release_version != version):
        return _unsupported("CONTRADICTORY_POLICY_IDENTITIES", version)

    if version == P14_DECISION_AWARE_V1:
        if not _strict_equal(params, dict(V1_PARAMETERS)):
            return _unsupported("INVALID_V1_PARAMETERS", version)
        return PolicyDispatch(V1_ROUTE, version, "SUPPORTED", _evaluator=v1_evaluator)

    matching = [entry for entry in injected_policies if entry.policy_version == version]
    if len(matching) != 1:
        return _unsupported("UNKNOWN_POLICY_VERSION", version)
    entry = matching[0]
    if (
        entry.route != V2_ROUTE
        or not entry.injected_for_test
        or not entry.definition_digest
        or not _SHA256_RE.fullmatch(entry.definition_digest)
        or not _strict_equal(params, entry.parameter_mapping())
    ):
        return _unsupported("UNAUTHORIZED_OR_MISMATCHED_V2_ENTRY", version)
    return PolicyDispatch(
        V2_ROUTE,
        version,
        "SUPPORTED",
        _evaluator=entry.evaluator,
        _entry=entry,
    )
