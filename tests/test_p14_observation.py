"""Synthetic-only contracts for P-14 canonical observations."""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

from data.p14_observation import (
    CANDIDATE_PROJECTION_FIELDS,
    MISSING,
    OBSERVATION_SCHEMA_VERSION,
    CanonicalP14Observation,
    ObservationContractError,
    StrictJSONError,
    canonical_json_bytes,
    content_digest,
    diagnostic_prescreen_rank,
    make_canonical_p14_observation,
    project_candidate_rows,
    project_rank_vector,
    project_legacy_release_reference_shortlist,
    project_replay_candidate_input,
    require_positive_int,
    strict_json_loads,
    validate_finite_json,
)


REPO = Path(__file__).resolve().parents[1]
PURE_MODULES = (
    REPO / "data/p14_observation.py",
    REPO / "data/p14_reference_classifier.py",
    REPO / "data/p14_policy_dispatch.py",
    REPO / "data/p14_reference_diagnostics.py",
)
FORBIDDEN_CALLS = {
    "open", "input", "getenv", "read_text", "read_bytes", "write_text", "write_bytes",
    "system", "run", "Popen", "urlopen", "connect", "create_connection", "now", "utcnow",
    "monotonic", "time", "sleep",
}


def canonical_observation_value():
    return {
        "schemaVersion": OBSERVATION_SCHEMA_VERSION,
        "policyVersion": "p14-decision-aware-v1",
        "runIdentity": {
            "repository": "owner/repository",
            "workflow": "full_batch.yml",
            "job": "update-data",
            "runId": "123456",
            "runAttempt": "2",
            "event": "schedule",
            "gitRef": "refs/heads/main",
            "gitRefType": "branch",
            "gitSha": "a" * 40,
        },
        "sourceIdentity": {"engineSha256": "b" * 64},
        "inputIdentity": {"candidates": {"present": True, "sha256": "c" * 64, "bytes": 4}},
        "parameters": {"topK": 40, "perturbationPct": 0.02, "shortlistN": 3},
        "base": {
            "engineStatus": "generated",
            "candidates": [
                {"artifactIndex": 0, "code": "A", "tier": "actionable", "marketRank": 1,
                 "prescreenScore": 80.0, "prescreenRank": 1, "prescreenPool": "main",
                 "marketScore": 75.5, "rawCompositeScore": 74.4, "sector": "industry",
                 "dataStatus": "complete", "dataConfidence": 0.9}
            ],
        },
        "perturbed": {
            "engineStatus": "generated",
            "candidates": [
                {"artifactIndex": 0, "code": "A", "tier": "actionable", "marketRank": 1,
                 "prescreenScore": 80.0, "prescreenRank": 1, "prescreenPool": "main",
                 "marketScore": 75.5, "rawCompositeScore": 73.0, "sector": "industry",
                 "dataStatus": "complete", "dataConfidence": 0.9}
            ],
        },
        "diagnosticAvailability": {"internalDataConfidence": "UNAVAILABLE", "exactCause": "UNAVAILABLE"},
    }


def test_canonical_serialization_is_deterministic_sorted_compact_utf8_and_not_rfc8785_claim():
    first = {"z": [3, "日本語"], "a": {"y": 2, "x": 1}}
    second = {"a": {"x": 1, "y": 2}, "z": [3, "日本語"]}
    assert canonical_json_bytes(first) == canonical_json_bytes(second)
    assert canonical_json_bytes(first) == '{"a":{"x":1,"y":2},"z":[3,"日本語"]}'.encode("utf-8")
    assert b"\n" not in canonical_json_bytes(first)


def test_canonical_codec_preserves_negative_zero_and_exact_unicode():
    encoded = canonical_json_bytes({"code": "é", "number": -0.0})
    assert "é".encode("utf-8") in encoded
    assert b"-0.0" in encoded
    assert strict_json_loads(encoded, require_canonical=True)["code"] == "é"


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_finite_json_validation_and_serialization_reject_nan_and_both_infinities(value):
    with pytest.raises(ObservationContractError):
        validate_finite_json({"nested": [value]})
    with pytest.raises(StrictJSONError):
        canonical_json_bytes({"value": value})


@pytest.mark.parametrize("raw", [
    b'{"a":1,"a":2}',
    b'{"n":NaN}',
    b'{"n":Infinity}',
    b'{"n":-Infinity}',
    b'{"a":1} trailing',
    b'{"a":1}{"b":2}',
    b'\xff',
    b'"\\ud800"',
])
def test_strict_decoder_rejects_duplicate_constants_invalid_utf8_and_trailing_data(raw):
    with pytest.raises(StrictJSONError):
        strict_json_loads(raw)


def test_canonical_only_decoder_rejects_whitespace_and_noncanonical_key_order():
    with pytest.raises(StrictJSONError):
        strict_json_loads(b'{ "b": 2, "a": 1 }', require_canonical=True)
    assert strict_json_loads(b'{ "b": 2, "a": 1 }') == {"b": 2, "a": 1}


def test_strict_types_do_not_accept_bool_as_integer():
    assert require_positive_int(1, "rank") == 1
    with pytest.raises(ObservationContractError):
        require_positive_int(True, "rank")
    with pytest.raises(ObservationContractError):
        project_candidate_rows([{"code": "A", "tier": "actionable", "marketRank": True}])
    with pytest.raises(ObservationContractError):
        project_candidate_rows([{"code": "A", "tier": "actionable", "artifactIndex": False}])


def test_content_digest_is_deterministic_and_changes_with_content():
    assert content_digest({"a": 1, "b": 2}) == content_digest({"b": 2, "a": 1})
    assert content_digest({"a": 1}) != content_digest({"a": 2})
    raw = canonical_json_bytes({"a": 1})
    assert content_digest(raw) == content_digest({"a": 1})


@pytest.mark.parametrize("row", [
    {},
    {"prescreenRank": None},
    {"prescreenRank": True},
    {"prescreenRank": 0},
    {"prescreenRank": -1},
    {"prescreenRank": 1.0},
    {"prescreenRank": "1"},
])
def test_missing_rank_has_one_non_numeric_diagnostic_meaning(row):
    encoded = diagnostic_prescreen_rank(row)
    assert encoded == {"prescreenRankTiebreakState": MISSING}
    assert "prescreenRankTiebreak" not in encoded
    assert "Infinity" not in canonical_json_bytes(encoded).decode("utf-8")


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_nonfinite_prescreen_rank_is_rejected_instead_of_collapsing_to_missing(value):
    with pytest.raises(ObservationContractError):
        diagnostic_prescreen_rank({"prescreenRank": value})




def test_unranked_excluded_candidate_is_not_given_a_missing_rank_explanation():
    with pytest.raises(ObservationContractError):
        diagnostic_prescreen_rank({"tier": "excluded", "marketRank": None, "prescreenRank": None})

def test_valid_prescreen_rank_uses_finite_float_value():
    assert diagnostic_prescreen_rank({"prescreenRank": 7}) == {
        "prescreenRankTiebreakState": "VALID", "prescreenRankTiebreak": 7.0,
    }
    with pytest.raises(ObservationContractError):
        diagnostic_prescreen_rank({"prescreenRank": 10**10000})


def test_candidate_projection_is_allowlisted_owned_and_order_preserving():
    rows = [
        {"code": "A", "tier": "actionable", "marketRank": 1, "name": "ignored", "themes": ["x"]},
        {"code": "B", "tier": "screened", "marketRank": None, "officialDecision": "ignored"},
    ]
    projected = project_candidate_rows(rows)
    assert [row["code"] for row in projected] == ["A", "B"]
    assert set(projected[0]) == {"code", "tier", "marketRank"}
    assert "name" not in projected[0] and "themes" not in projected[0]
    rows[0]["code"] = "changed"
    assert projected[0]["code"] == "A"


def test_rank_vector_has_frozen_seven_keys_and_market_rank_code_order():
    rows = [
        {"code": "C", "marketRank": 2, "rawCompositeScore": 99.0},
        {"code": "B", "marketRank": 1, "rawCompositeScore": 1.0},
        {"code": "A", "marketRank": 1, "rawCompositeScore": 2.0},
        {"code": "X", "marketRank": None},
    ]
    vector = project_rank_vector(rows)
    assert [row["code"] for row in vector] == ["A", "B", "C"]
    assert all(tuple(row) == (
        "code", "prescreenScore", "prescreenRank", "prescreenPool", "marketRank",
        "marketScore", "rawCompositeScore",
    ) for row in vector)
    assert rows[0]["code"] == "C"


def test_reference_projection_uses_eligible_domain_and_artifact_tiebreak():
    rows = [
        {"code": "B", "tier": "actionable", "marketRank": 2, "artifactIndex": 0},
        {"code": "A", "tier": "deep_review", "marketRank": 2, "artifactIndex": 1},
        {"code": "X", "tier": "screened", "marketRank": 1, "artifactIndex": 2},
        {"code": "C", "tier": "actionable", "marketRank": 3, "artifactIndex": 3},
    ]
    shortlist = project_legacy_release_reference_shortlist(rows, n=2)
    assert [(item["code"], item["eligibleRank"]) for item in shortlist] == [("B", 1), ("A", 2)]


def test_replay_input_projection_keeps_only_exact_fourteen_fields_and_original_order():
    source = [
        {field: field for field in (
            "code", "name", "sector", "price", "per", "pbr", "roe", "dividendYield",
            "sigma252d", "mom3m", "dataStatus", "prescreenScore", "prescreenRank", "prescreenPool",
            "portfolioFit", "holdings",
        )},
        "malformed-row",
    ]
    projected = project_replay_candidate_input(source)
    assert len(projected[0]) == 14
    assert set(projected[0]) == {
        "code", "name", "sector", "price", "per", "pbr", "roe", "dividendYield",
        "sigma252d", "mom3m", "dataStatus", "prescreenScore", "prescreenRank", "prescreenPool",
    }
    assert projected[1] == "malformed-row"
    source[0]["code"] = "mutated"
    assert projected[0]["code"] == "code"


def test_canonical_observation_is_immutable_bytes_with_detached_views_and_digest_outside_payload():
    payload = canonical_observation_value()
    observation = make_canonical_p14_observation(payload)
    assert observation.sha256 == content_digest(observation.payload_bytes)
    assert observation.content_digest == observation.sha256
    first_view = observation.to_value()
    first_view["base"]["candidates"][0]["code"] = "MUTATED"
    assert observation.to_value()["base"]["candidates"][0]["code"] == "A"
    assert "sha256" not in observation.to_value()
    assert CanonicalP14Observation.from_bytes(observation.payload_bytes).sha256 == observation.sha256
    payload["policyVersion"] = "mutated"
    assert observation.to_value()["policyVersion"] == "p14-decision-aware-v1"


def test_canonical_observation_requires_strict_schema_identity_and_string_run_ids():
    payload = canonical_observation_value()
    payload["runIdentity"]["runId"] = 12
    with pytest.raises(ObservationContractError):
        make_canonical_p14_observation(payload)
    payload = canonical_observation_value()
    payload["runIdentity"]["runAttempt"] = True
    with pytest.raises(ObservationContractError):
        make_canonical_p14_observation(payload)
    payload = canonical_observation_value()
    payload["schemaVersion"] = "future-unknown"
    with pytest.raises(ObservationContractError):
        make_canonical_p14_observation(payload)
    payload = canonical_observation_value()
    payload["base"]["candidates"][0]["name"] = "not projected"
    with pytest.raises(ObservationContractError):
        make_canonical_p14_observation(payload)


def _imports_and_calls(source: str):
    tree = ast.parse(source)
    imports = set()
    calls = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imports.add(node.module.split(".")[0])
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                calls.add(node.func.id)
            elif isinstance(node.func, ast.Attribute):
                calls.add(node.func.attr)
    return imports, calls


def test_all_phase_i_production_modules_are_statically_pure_and_import_isolated():
    forbidden_module_exact = {
        "candidate_funnel_batch", "candidate_funnel_run_evidence", "candidate_funnel_engine",
        "p14_handoff", "p14_evidence_capture", "p14_evidence_validate", "p14_legacy_replay",
        "p14_evidence_privacy_filter", "p14_corpus_register",
        "p14_corpus_register", "p14_policy_runtime", "p14_evidence_orchestrator",
        "os", "time", "datetime", "subprocess", "socket", "urllib", "requests", "http",
        "pathlib", "tempfile", "shutil", "zoneinfo",
    }
    for path in PURE_MODULES:
        imports, calls = _imports_and_calls(path.read_text(encoding="utf-8"))
        assert imports.isdisjoint(forbidden_module_exact), (path.name, imports & forbidden_module_exact)
        assert calls.isdisjoint(FORBIDDEN_CALLS), (path.name, calls & FORBIDDEN_CALLS)
