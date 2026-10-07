"""Synthetic-only diagnostic privacy, serialization, and ownership contracts."""
from __future__ import annotations

import copy

import pytest

from data.p14_observation import OBSERVATION_SCHEMA_VERSION, CanonicalP14Observation, canonical_json_bytes
from data.p14_reference_classifier import (
    CAUSE_UNRESOLVED, classify_reference_transition, explain_pair_order,
)
from data.p14_reference_diagnostics import (
    DIAGNOSTICS_SCHEMA_VERSION,
    LIVE_CAUSAL_DIAGNOSTIC_POSSIBLE,
    S03_DECISION,
    DiagnosticContractError,
    DiagnosticPrivacyError,
    ReferenceDiagnosticDocument,
    build_reference_diagnostics,
    decode_reference_diagnostics,
    serialize_reference_diagnostics,
)
from test_p14_observation import canonical_observation_value


def classification():
    base = [{"code": "A", "tier": "actionable", "marketRank": 1},
            {"code": "B", "tier": "deep_review", "marketRank": 2},
            {"code": "C", "tier": "actionable", "marketRank": 3}]
    perturbed = [{"code": "A", "tier": "actionable", "marketRank": 1},
                 {"code": "B", "tier": "actionable", "marketRank": 2},
                 {"code": "C", "tier": "actionable", "marketRank": 3}]
    return classify_reference_transition(base, perturbed)


def valid_diagnostic(**overrides):
    payload = {
        "diagnosticsVersion": DIAGNOSTICS_SCHEMA_VERSION,
        "classification": {
            "status": "SUPPORTED", "classes": ["STABLE_REFERENCE"], "violations": [],
            "transitions": [], "population": {"base": 3, "perturbed": 3},
            "baseShortlistCodes": ["A"], "perturbedShortlistCodes": ["A"],
            "enteredReferenceCodes": [], "exitedReferenceCodes": [],
            "enteredEligibleCodes": [], "exitedEligibleCodes": [],
            "membershipChanged": False, "tierChanged": False, "orderChanged": False,
        },
        "causalClassification": {"status": CAUSE_UNRESOLVED},
        "completeness": {
            "classification": "COMPLETE", "cause": "UNAVAILABLE", "population": "COMPLETE",
            "referenceShortlist": "COMPLETE", "candidateTransitions": "COMPLETE",
            "retainedMemberOrder": "COMPLETE", "orderingObservations": "COMPLETE",
            "prescreenRankTiebreaks": "COMPLETE",
        },
        "population": {"base": 3, "perturbed": 3},
        "referenceShortlist": {"base": ["A"], "perturbed": ["A"]},
        "candidateTransitions": [],
        "retainedMemberOrder": {"changed": False, "base": ["A"], "perturbed": ["A"]},
        "orderingObservations": [],
        "prescreenRankTiebreaks": [],
    }
    payload.update(overrides)
    if "candidateTransitions" in overrides and type(payload["candidateTransitions"]) is list:
        payload["classification"]["transitions"] = copy.deepcopy(payload["candidateTransitions"])
    return payload


def test_synthetic_classifier_input_builds_strict_complete_diagnostic_record():
    result = classification()
    diagnostic = build_reference_diagnostics(result)
    assert diagnostic["diagnosticsVersion"] == DIAGNOSTICS_SCHEMA_VERSION
    assert diagnostic["classification"]["status"] == "SUPPORTED"
    assert diagnostic["causalClassification"] == {"status": CAUSE_UNRESOLVED}
    assert diagnostic["completeness"]["classification"] == "COMPLETE"
    assert diagnostic["completeness"]["cause"] == "UNAVAILABLE"
    assert diagnostic["completeness"]["population"] == "COMPLETE"
    assert diagnostic["causalClassification"]["status"] == CAUSE_UNRESOLVED
    assert diagnostic["orderingObservations"] == {"status": "UNAVAILABLE"}
    assert diagnostic["prescreenRankTiebreaks"] == {"status": "UNAVAILABLE"}
    assert "severity" not in diagnostic and "severity" not in diagnostic["classification"]




def test_mf_a10_integrity_and_contradiction_diagnostics_remain_distinct_without_fake_counts():
    integrity = classify_reference_transition(
        [{"code": "A", "tier": "actionable", "marketRank": 1},
         {"code": "A", "tier": "actionable", "marketRank": 2}],
        [{"code": "A", "tier": "actionable", "marketRank": 1},
         {"code": "B", "tier": "actionable", "marketRank": 2}],
    )
    integrity_diagnostic = build_reference_diagnostics(integrity)
    assert integrity_diagnostic["classification"]["status"] == "INTEGRITY_FAILURE"
    assert integrity_diagnostic["classification"]["violations"] == ["DUPLICATE_CODE"]
    assert integrity_diagnostic["classification"]["classes"] == []
    assert integrity_diagnostic["population"] == {"status": "UNAVAILABLE"}
    assert integrity_diagnostic["candidateTransitions"] == []
    assert serialize_reference_diagnostics(integrity_diagnostic)

    contradictory = classify_reference_transition(
        [{"code": "A", "tier": "actionable", "marketRank": 1, "sector": "one"}],
        [{"code": "A", "tier": "actionable", "marketRank": 1, "sector": "two"}],
    )
    contradiction_diagnostic = build_reference_diagnostics(contradictory)
    assert contradiction_diagnostic["classification"]["status"] == "CONTRADICTORY"
    assert contradiction_diagnostic["classification"]["violations"] == ["INVARIANT_SECTOR_CHANGED"]
    assert contradiction_diagnostic["classification"]["classes"] == []
    assert contradiction_diagnostic["population"] == {"status": "UNAVAILABLE"}
    assert serialize_reference_diagnostics(contradiction_diagnostic)


def test_known_explicit_cause_is_preserved_and_unavailable_cause_is_not_corruption():
    known = build_reference_diagnostics(classification(), cause_evidence={"state": "EXACT", "causeClass": "CAPACITY"})
    assert known["causalClassification"] == {"status": "KNOWN_CAUSE", "causeClass": "CAPACITY"}
    assert known["completeness"]["cause"] == "COMPLETE"
    unresolved = build_reference_diagnostics(classification(), cause_evidence={"state": "UNAVAILABLE"})
    assert unresolved["causalClassification"] == {"status": CAUSE_UNRESOLVED}
    assert unresolved["completeness"]["cause"] == "UNAVAILABLE"
    assert serialize_reference_diagnostics(unresolved)


def test_serializer_is_deterministic_strict_and_round_trips_only_canonical_bytes():
    payload = valid_diagnostic()
    first = serialize_reference_diagnostics(payload)
    second = serialize_reference_diagnostics(dict(reversed(list(payload.items()))))
    assert first == second
    assert decode_reference_diagnostics(first) == payload
    assert b"\n" not in first
    document = ReferenceDiagnosticDocument.from_value(payload)
    assert document.payload_bytes == first
    assert document.sha256




def test_builder_rejects_incomplete_classifier_values_without_inserting_empty_defaults():
    with pytest.raises(DiagnosticContractError):
        build_reference_diagnostics({"status": "SUPPORTED", "classes": []})


def test_s03_rejects_nan_positive_and_negative_infinity_without_partial_output():
    assert S03_DECISION == "REJECT"
    assert LIVE_CAUSAL_DIAGNOSTIC_POSSIBLE == "PARTIAL"
    for number in (float("nan"), float("inf"), float("-inf")):
        payload = valid_diagnostic()
        payload["orderingObservations"] = [{"marketScore": number}]
        with pytest.raises(DiagnosticContractError):
            serialize_reference_diagnostics(payload)


def test_malformed_incomplete_or_unknown_diagnostic_state_rejects_whole_record():
    missing = valid_diagnostic()
    del missing["classification"]
    with pytest.raises(DiagnosticContractError):
        serialize_reference_diagnostics(missing)
    unknown = valid_diagnostic(diagnosticsVersion="p14-reference-diagnostics-999")
    with pytest.raises(DiagnosticContractError):
        serialize_reference_diagnostics(unknown)
    invalid_completeness = valid_diagnostic(completeness={"classification": "COMPLETE", "cause": "zero"})
    with pytest.raises(DiagnosticContractError):
        serialize_reference_diagnostics(invalid_completeness)
    partial = valid_diagnostic()
    partial["completeness"]["orderingObservations"] = "PARTIAL"
    with pytest.raises(DiagnosticContractError):
        serialize_reference_diagnostics(partial)


def test_cause_unresolved_is_semantic_unavailability_and_requires_no_default_value():
    payload = valid_diagnostic()
    assert serialize_reference_diagnostics(payload)
    payload["causalClassification"] = {"status": CAUSE_UNRESOLVED, "causeClass": "invented"}
    with pytest.raises(DiagnosticContractError):
        serialize_reference_diagnostics(payload)


def test_s04_missing_prescreen_rank_uses_only_the_canonical_sentinel():
    missing_rank = build_reference_diagnostics(
        classification(), prescreen_rank_rows=[{"code": "A", "prescreenRank": None}]
    )
    sentinel = missing_rank["prescreenRankTiebreaks"][0]
    assert sentinel == {"prescreenRankTiebreakState": "MISSING", "code": "A"}
    encoded = serialize_reference_diagnostics(missing_rank)
    assert b"Infinity" not in encoded
    assert b'"prescreenRankTiebreak":' not in encoded

    valid_rank = build_reference_diagnostics(
        classification(), prescreen_rank_rows=[{"code": "A", "prescreenRank": 5}]
    )
    assert valid_rank["prescreenRankTiebreaks"][0] == {
        "prescreenRankTiebreakState": "VALID", "prescreenRankTiebreak": 5.0, "code": "A",
    }


def test_nonfinite_rank_input_rejects_entire_diagnostic():
    with pytest.raises(DiagnosticContractError):
        build_reference_diagnostics(
            classification(), prescreen_rank_rows=[{"code": "A", "prescreenRank": float("inf")}]
        )


def test_missing_rank_with_null_or_numeric_value_is_rejected_not_fixed_up():
    bad = valid_diagnostic(prescreenRankTiebreaks=[{
        "code": "A", "prescreenRankTiebreakState": "MISSING", "prescreenRankTiebreak": None,
    }])
    with pytest.raises(DiagnosticContractError):
        serialize_reference_diagnostics(bad)
    bad = valid_diagnostic(prescreenRankTiebreaks=[{
        "code": "A", "prescreenRankTiebreakState": "MISSING", "prescreenRankTiebreak": 0,
    }])
    with pytest.raises(DiagnosticContractError):
        serialize_reference_diagnostics(bad)


def test_forbidden_privacy_keys_are_rejected_at_every_depth():
    for payload in (
        valid_diagnostic(portfolio={}),
        valid_diagnostic(classification={"status": "SUPPORTED", "nested": [{"cash": 1}]}),
        valid_diagnostic(orderingObservations=[{"candidate": {"account": "x"}}]),
    ):
        with pytest.raises(DiagnosticPrivacyError):
            serialize_reference_diagnostics(payload)


def test_forbidden_word_in_data_value_is_not_misread_as_a_key():
    payload = valid_diagnostic(candidateTransitions=[{"code": "portfolio", "tier": "cash"}])
    assert serialize_reference_diagnostics(payload)


def test_token_shaped_values_and_private_absolute_paths_are_rejected():
    token = "ghp_" + "x" * 36
    with pytest.raises(DiagnosticPrivacyError):
        serialize_reference_diagnostics(valid_diagnostic(candidateTransitions=[{"code": token}]))
    with pytest.raises(DiagnosticPrivacyError):
        serialize_reference_diagnostics(valid_diagnostic(candidateTransitions=[{"source": "/Users/alice/project/file"}]))
    with pytest.raises(DiagnosticPrivacyError):
        serialize_reference_diagnostics(valid_diagnostic(candidateTransitions=[{"source": "/home/alice/project"}]))


def test_raw_composite_score_is_never_authority_in_diagnostic_observations():
    left = {"code": "A", "marketRank": 1, "marketScore": 50.0,
            "internalDataConfidence": 0.4, "rawCompositeScore": -100.0}
    right = {"code": "B", "marketRank": 2, "marketScore": 49.0,
             "internalDataConfidence": 0.9, "rawCompositeScore": 100.0}
    explanation = explain_pair_order(left, right).as_dict()
    payload = build_reference_diagnostics(classification(), ordering_observations=[explanation])
    raw_records = payload["orderingObservations"][0]["rawCompositeScore"]
    assert all(item["authority"] == "DIAGNOSTIC_ONLY" for item in raw_records)
    with pytest.raises(DiagnosticContractError):
        serialize_reference_diagnostics(valid_diagnostic(orderingObservations=[{"rawCompositeScore": 1.0}]))


def test_record_list_contract_rejects_candidate_code_as_an_object_key():
    bad = valid_diagnostic(candidateTransitions={"A": {"tier": "actionable"}})
    with pytest.raises(DiagnosticContractError):
        serialize_reference_diagnostics(bad)


def test_diagnostic_document_uses_bytes_only_and_each_view_is_detached():
    document = ReferenceDiagnosticDocument.from_value(valid_diagnostic())
    first = document.to_value()
    first["classification"]["classes"].append("MUTATED")
    second = document.to_value()
    assert second["classification"]["classes"] == ["STABLE_REFERENCE"]
    assert document.sha256 == ReferenceDiagnosticDocument.from_value(second).sha256


def test_builder_detaches_classifier_inputs_and_does_not_mutate_public_values():
    source_result = classification().as_dict()
    public_value = {"schemaVersion": "public", "candidates": [{"code": "A"}], "_meta": {"qualityGate": {}}}
    public_before = canonical_json_bytes(public_value)
    source_before = copy.deepcopy(source_result)
    built = build_reference_diagnostics(source_result)
    source_result["transitions"].append({"code": "mutated"})
    assert built["candidateTransitions"] == source_before["transitions"]
    assert canonical_json_bytes(public_value) == public_before


def test_canonical_observation_and_diagnostic_document_have_no_mutable_shared_graph():
    observation = CanonicalP14Observation.from_value(canonical_observation_value())
    before_digest = observation.sha256
    doc = ReferenceDiagnosticDocument.from_inputs(classification(), observation=observation)
    diag_view = doc.to_value()
    diag_view["population"]["base"] = 999
    obs_view = observation.to_value()
    obs_view["base"]["candidates"][0]["code"] = "changed"
    assert observation.sha256 == before_digest
    assert observation.to_value()["base"]["candidates"][0]["code"] == "A"
    assert doc.to_value()["population"]["base"] == 3


def test_privacy_failure_does_not_mutate_or_rewrite_public_payload():
    public = {"schemaVersion": "candidate-funnel", "_meta": {"qualityGate": {"status": "PASS"}}}
    public_before = canonical_json_bytes(public)
    bad = valid_diagnostic(holdings={"code": "private"})
    with pytest.raises(DiagnosticPrivacyError):
        serialize_reference_diagnostics(bad)
    assert canonical_json_bytes(public) == public_before
