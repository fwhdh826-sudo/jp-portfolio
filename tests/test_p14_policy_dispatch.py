"""Synthetic-only exact policy-identity dispatch tests."""
from __future__ import annotations

import copy

import pytest

from data.p14_policy_dispatch import (
    LEGACY_PARAMETERS,
    P14_DECISION_AWARE_V1,
    SCHEMA_COMPATIBLE_NOT_REPLAYABLE,
    UNSUPPORTED_ROUTE,
    V1_PARAMETERS,
    V1_ROUTE,
    V2_ROUTE,
    LEGACY_ROUTE,
    PolicyEntry,
    UnsupportedPolicyError,
    dispatch_policy,
)

SCHEMA_V2 = "candidate-funnel-run-evidence-2"
TEST_POLICY = "p14-test-injected-v2"
TEST_DEFINITION_DIGEST = "a" * 64


def legacy_bundle():
    return {
        "schemaVersion": SCHEMA_V2,
        "p14Parameters": dict(LEGACY_PARAMETERS),
        "p14": {},
    }


def v1_bundle():
    return {
        "schemaVersion": SCHEMA_V2,
        "p14Parameters": dict(V1_PARAMETERS),
        "p14": {"release": {"policyVersion": P14_DECISION_AWARE_V1}},
    }


def v2_entry(evaluator=None):
    params = {
        "policyVersion": TEST_POLICY,
        "definitionDigest": TEST_DEFINITION_DIGEST,
        "parameters": {"switch": True, "limits": [1, 2]},
    }
    return PolicyEntry.injected_v2_for_test(
        TEST_POLICY,
        params,
        definition_digest=TEST_DEFINITION_DIGEST,
        evaluator=evaluator,
    )


def v2_bundle():
    entry = v2_entry()
    return {
        "schemaVersion": SCHEMA_V2,
        "p14Parameters": entry.parameter_mapping(),
        "p14": {"release": {"policyVersion": TEST_POLICY}},
    }


def test_genuine_legacy_identity_routes_only_to_legacy():
    bundle = legacy_bundle()
    result = dispatch_policy(bundle)
    assert result.supported
    assert result.route == LEGACY_ROUTE
    assert result.policy_version is None
    assert result.reason is None


def test_exact_v1_identity_routes_to_v1_without_consulting_injected_v2():
    calls = []
    v2 = v2_entry(lambda _bundle: calls.append("v2"))
    result = dispatch_policy(v1_bundle(), injected_policies=(v2,))
    assert result.supported
    assert result.route == V1_ROUTE
    assert result.policy_version == P14_DECISION_AWARE_V1
    assert calls == []


def test_explicit_injected_v2_identity_routes_to_the_exact_v2_entry():
    result = dispatch_policy(v2_bundle(), injected_policies=(v2_entry(),))
    assert result.supported
    assert result.route == V2_ROUTE
    assert result.policy_version == TEST_POLICY


def test_test_injected_v2_evaluator_is_called_only_after_exact_dispatch():
    calls = []
    evaluator = lambda bundle: calls.append(bundle["p14Parameters"]["policyVersion"]) or {"result": "test-route"}
    entry = v2_entry(evaluator)
    bundle = v2_bundle()
    dispatch = dispatch_policy(bundle, injected_policies=(entry,))
    assert dispatch.evaluate(bundle) == {"result": "test-route"}
    assert calls == [TEST_POLICY]


def test_unknown_explicit_policy_fails_closed_even_with_legacy_parameter_shape():
    bundle = legacy_bundle()
    bundle["p14Parameters"]["policyVersion"] = "p14-decision-aware-v9"
    result = dispatch_policy(bundle)
    assert result.route == UNSUPPORTED_ROUTE
    assert not result.supported
    assert result.reason == "UNKNOWN_POLICY_VERSION"
    with pytest.raises(UnsupportedPolicyError):
        result.evaluate(bundle)


@pytest.mark.parametrize("version", ["", None, 7, True, [], {}])
def test_malformed_explicit_versions_fail_closed_without_legacy_fallback(version):
    bundle = legacy_bundle()
    bundle["p14Parameters"]["policyVersion"] = version
    result = dispatch_policy(bundle)
    assert result.route == UNSUPPORTED_ROUTE
    assert result.reason == "INVALID_EXPLICIT_POLICY_VERSION"


def test_missing_version_with_decision_aware_shape_fails_closed():
    bundle = legacy_bundle()
    bundle["p14"]["release"] = {"policyVersion": P14_DECISION_AWARE_V1}
    result = dispatch_policy(bundle)
    assert result.route == UNSUPPORTED_ROUTE
    assert result.reason == "AMBIGUOUS_MISSING_POLICY_VERSION"


def test_missing_version_with_release_but_no_release_version_is_still_ambiguous():
    bundle = legacy_bundle()
    bundle["p14"]["release"] = {"final": {"status": "PASS"}}
    result = dispatch_policy(bundle)
    assert result.route == UNSUPPORTED_ROUTE
    assert result.reason == "AMBIGUOUS_MISSING_POLICY_VERSION"


def test_inconsistent_parameter_and_release_identities_fail_closed():
    bundle = v1_bundle()
    bundle["p14"]["release"]["policyVersion"] = TEST_POLICY
    result = dispatch_policy(bundle, injected_policies=(v2_entry(),))
    assert result.route == UNSUPPORTED_ROUTE
    assert result.reason == "CONTRADICTORY_POLICY_IDENTITIES"


def test_explicit_v1_requires_exact_frozen_parameter_contract():
    bundle = v1_bundle()
    bundle["p14Parameters"]["topK"] = True
    result = dispatch_policy(bundle)
    assert result.route == UNSUPPORTED_ROUTE
    assert result.reason == "INVALID_V1_PARAMETERS"

    bundle = v1_bundle()
    bundle["p14Parameters"]["extra"] = "not frozen"
    result = dispatch_policy(bundle)
    assert result.route == UNSUPPORTED_ROUTE
    assert result.reason == "INVALID_V1_PARAMETERS"


def test_v1_does_not_fall_through_to_v2_if_its_evaluator_is_absent():
    calls = []
    bundle = v1_bundle()
    result = dispatch_policy(bundle, injected_policies=(v2_entry(lambda _bundle: calls.append("v2")),))
    assert result.route == V1_ROUTE
    assert result.supported
    with pytest.raises(UnsupportedPolicyError):
        result.evaluate(bundle)
    assert calls == []


def test_evaluator_local_guard_refuses_a_different_policy_identity():
    calls = []
    bundle = v1_bundle()
    result = dispatch_policy(bundle, v1_evaluator=lambda _bundle: calls.append("v1"))
    changed = v2_bundle()
    with pytest.raises(UnsupportedPolicyError):
        result.evaluate(changed)
    assert calls == []

    v2_calls = []
    entry = v2_entry(lambda _bundle: v2_calls.append("v2"))
    v2_result = dispatch_policy(v2_bundle(), injected_policies=(entry,))
    with pytest.raises(UnsupportedPolicyError):
        v2_result.evaluate(v1_bundle())
    assert v2_calls == []


def test_schema_one_is_compatible_but_never_dispatches_an_evaluator():
    calls = []
    bundle = {"schemaVersion": "candidate-funnel-run-evidence-1"}
    result = dispatch_policy(bundle, legacy_evaluator=lambda _bundle: calls.append("legacy"))
    assert result.route == SCHEMA_COMPATIBLE_NOT_REPLAYABLE
    assert result.status == "COMPATIBLE"
    with pytest.raises(UnsupportedPolicyError):
        result.evaluate(bundle)
    assert calls == []


def test_unsupported_schema_and_malformed_parameter_objects_fail_closed():
    result = dispatch_policy({"schemaVersion": "candidate-funnel-run-evidence-3", "p14Parameters": {}})
    assert result.route == UNSUPPORTED_ROUTE and result.reason == "UNSUPPORTED_EVIDENCE_SCHEMA"
    result = dispatch_policy({"schemaVersion": SCHEMA_V2, "p14Parameters": []})
    assert result.route == UNSUPPORTED_ROUTE and result.reason == "INVALID_P14_PARAMETERS"


def test_v2_registry_entry_is_immutable_and_definition_bound():
    entry = v2_entry()
    params = entry.parameter_mapping()
    params["parameters"]["limits"].append(3)
    assert entry.parameter_mapping()["parameters"]["limits"] == [1, 2]
    with pytest.raises(TypeError):
        LEGACY_PARAMETERS["topK"] = 2
    with pytest.raises(ValueError):
        PolicyEntry.injected_v2_for_test(TEST_POLICY, {"policyVersion": TEST_POLICY}, definition_digest="bad")


def test_dispatch_does_not_rewrite_or_mutate_historical_bundle():
    bundle = legacy_bundle()
    before = copy.deepcopy(bundle)
    dispatch_policy(bundle, legacy_evaluator=lambda value: value)
    assert bundle == before
