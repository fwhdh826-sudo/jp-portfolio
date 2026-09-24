"""Synthetic Phase II-A handoff, privacy, ownership, and storage contracts."""
from __future__ import annotations

import ast
import copy
import hashlib
import inspect
import json
import os
from dataclasses import replace
from pathlib import Path

import pytest

from data import p14_handoff as handoff
from data.p14_handoff import (
    CAPTURE_INPUT_FILE,
    CAPTURE_INPUT_SCHEMA_VERSION,
    FIXED_MODULE_PATHS,
    HANDOFF_FILE,
    HANDOFF_SCHEMA_VERSION,
    OBSERVATION_SCHEMA_VERSION,
    RECEIPT_FILE,
    RECEIPT_SCHEMA_VERSION,
    AttemptClaim,
    DigestBinding,
    ExpectedBinding,
    HandoffError,
    HandoffParts,
    ModuleBinding,
    ProducerReference,
    RawFileBinding,
    build_batch_receipt_bytes,
    build_capture_input_bytes,
    build_handoff_envelope_bytes,
    build_handoff_parts,
    build_observation_bytes,
    canonical_json_bytes,
    claim_attempt,
    compute_confidence_invariant,
    make_producer_reference,
    read_handoff_parts,
    validate_handoff_observation,
    validate_handoff_parts,
    write_handoff_parts,
)

REPO = Path(__file__).resolve().parents[1]
EVENT_SHA = "1" * 40
EXECUTED_SHA = "2" * 40
POLICY = "p14-decision-aware-v1"


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def run_identity(**overrides):
    value = {
        "repository": "fwhdh826-sudo/jp-portfolio",
        "workflow": "full_batch.yml",
        "job": "update-data",
        "runId": "12345",
        "runAttempt": "2",
        "event": "schedule",
        "gitRef": "refs/heads/main",
        "gitRefType": "branch",
        "gitSha": EVENT_SHA,
    }
    value.update(overrides)
    return value


def selection_observability():
    return {
        "regimeApplied": "bull_calm",
        "actionableHardMaxApplied": 12,
        "actionableSectorCapApplied": 2,
        "deepReviewHardMaxApplied": 40,
        "deepReviewSectorCapApplied": 6,
        "deepReviewSectorCapRelaxed": False,
        "actionableSectorCapRelaxed": False,
        "deepReviewEligibleCount": 2,
        "deepReviewSelectedCount": 2,
        "actionableEligibleCount": 1,
        "actionableSelectedCount": 1,
        "sourceStale": False,
        "fallbackProvenance": False,
    }


def candidates(*, perturbed=False):
    return [
        {
            "artifactIndex": 0,
            "code": "1001",
            "tier": "actionable",
            "marketRank": 1,
            "prescreenScore": 88.5,
            "prescreenRank": 1,
            "prescreenPool": "main",
            "marketScore": 80.0,
            "rawCompositeScore": 0.8,
            "sector": "Technology",
            "dataStatus": "ok",
            "dataConfidence": 0.9 if not perturbed else 0.8,
        },
        {
            "artifactIndex": 1,
            "code": "1002",
            "tier": "deep_review",
            "marketRank": 2,
            "prescreenScore": 70.0,
            "prescreenRank": 2,
            "prescreenPool": "main",
            "marketScore": 70.0,
            "rawCompositeScore": 0.7,
            "sector": None,
            "dataStatus": "partial",
            "dataConfidence": None,
        },
    ]


def side(*, perturbed=False):
    return {
        "engineStatus": "generated",
        "candidates": candidates(perturbed=perturbed),
        "selectionObservability": selection_observability(),
    }


def context():
    return {
        "pipelinePath": "normal",
        "regime": "bull_calm",
        "sourceUpdatedAt": "2026-09-24T00:00:00.000Z",
        "asOf": "2026-09-24T00:30:00.000Z",
        "staleThresholdHours": 24,
        "prescreenFallbackUsed": False,
    }


def join_stats():
    return {
        "candidateCount": 2,
        "prescreenCount": 2,
        "joinedCount": 2,
        "unmatchedCandidateCount": 0,
        "unmatchedPrescreenCount": 0,
        "joinRate": 1.0,
        "unmatchedCandidateRate": 0.0,
    }


def joined_input():
    return [
        {
            "code": "1001", "name": "Alpha", "sector": "Technology", "price": 1000.0,
            "per": 12.0, "pbr": 1.1, "roe": 0.12, "dividendYield": 0.02,
            "sigma252d": 0.2, "mom3m": 0.1, "dataStatus": "ok",
            "prescreenScore": 88.5, "prescreenRank": 1, "prescreenPool": "main",
            "unknownBroadInput": "is projected out",
        },
        "invalid-scalar-row-preserved",
    ]


def source_identity():
    return {
        "executedGitSha": EXECUTED_SHA,
        "modules": [
            {"path": path, "sha256": f"{index + 1:064x}"}
            for index, path in enumerate(FIXED_MODULE_PATHS)
        ],
        "engineSchemaVersion": "candidate-funnel-1",
        "engineScoreVersion": "market-score-v1",
        "engineFunnelVersion": "candidate-funnel-v1",
    }


def release_evidence():
    return {
        "policyVersion": POLICY,
        "top40": {
            "intersection": ["1001", "1002"],
            "union": ["1001", "1002"],
            "retention": 1.0,
            "swapCount": 0,
            "jaccard": 1.0,
            "warnThreshold": 0.95,
            "hardThreshold": 0.8,
        },
        "deepReview": {
            "baseCodes": ["1002"], "perturbedCodes": ["1002"],
            "entered": [], "exited": [], "exitCount": 0,
        },
        "actionable": {
            "baseCodes": ["1001"], "perturbedCodes": ["1001"],
            "entered": [], "exited": [], "exitCount": 0,
            "warnThreshold": 2, "hardThreshold": 3,
        },
        "marketReferenceShortlist": {
            "name": "P14_MARKET_REFERENCE_SHORTLIST",
            "holdingsDependent": False,
            "n": 3,
            "base": [
                {"code": "1001", "tier": "actionable", "marketRank": 1, "artifactIndex": 0},
                {"code": "1002", "tier": "deep_review", "marketRank": 2, "artifactIndex": 1},
            ],
            "perturbed": [
                {"code": "1001", "tier": "actionable", "marketRank": 1, "artifactIndex": 0},
                {"code": "1002", "tier": "deep_review", "marketRank": 2, "artifactIndex": 1},
            ],
            "membershipChanged": False,
            "tierChanged": False,
            "orderChanged": False,
        },
        "final": {"status": "PASS", "hardReasons": [], "warnReasons": []},
        "p14ProvesOfficialDecisionStability": False,
    }


def gates():
    result = []
    for number in range(1, 16):
        gate_id = f"P-{number:02d}"
        value = 1
        if gate_id == "P-06":
            value = {"count": 2, "min": 4, "p25": 4, "median": 5, "p75": 6, "max": 6, "atOrBelow4AxesCount": 1}
        elif gate_id == "P-07":
            value = {"count": 2, "min": 0.7, "max": 0.8, "range": 0.1, "p25": 0.7, "p75": 0.8, "iqr": 0.1, "median": 0.75}
        elif gate_id == "P-10":
            value = {"deepReview": 1, "actionable": 1}
        elif gate_id == "P-11":
            value = {
                "deepReviewSectorCapOverflow": {"Technology": 0},
                "actionableSectorCapOverflow": {"Technology": 0},
                "deepReviewEligibleMinusSelected": 0,
                "actionableEligibleMinusSelected": 0,
            }
        elif gate_id == "P-12":
            value = {"soft": {}, "hard": {}}
        elif gate_id == "P-13":
            value = {"currentRunActionable": 1, "cacheFallbackMirrorActionable": 0}
        result.append({"id": gate_id, "metric": f"metric-{number}", "value": value, "threshold": None, "status": "PASS", "note": None})
    return result


def quality_gate():
    return {
        "gates": gates(),
        "overallPass": True,
        "hardFailIds": [],
        "notes": [],
        "p14ReleaseEvidence": release_evidence(),
    }


def build_contract():
    capture_bytes = build_capture_input_bytes(
        joined_candidate_input=joined_input(),
        context=context(),
        join_stats=join_stats(),
        source_updated_at="2026-09-24T00:00:00.000Z",
        candidates_updated_at="2026-09-24T00:01:00.000Z",
    )
    capture_value = json.loads(capture_bytes)
    joined_bytes = canonical_json_bytes(capture_value["joinedCandidateInput"])
    context_bytes = canonical_json_bytes(capture_value["context"])
    raw_bindings = (
        RawFileBinding("candidatesStocks", True, "a" * 64, 10),
        RawFileBinding("prescreenMetadata", True, "b" * 64, 11),
        RawFileBinding("regimeState", False, None, None),
        RawFileBinding("previousArtifact", True, "c" * 64, 12),
    )
    module_bindings = tuple(
        ModuleBinding(path, f"{index + 1:064x}") for index, path in enumerate(FIXED_MODULE_PATHS)
    )
    expected = ExpectedBinding(
        repository="fwhdh826-sudo/jp-portfolio",
        workflow="full_batch.yml",
        job="update-data",
        run_id="12345",
        run_attempt="2",
        event="schedule",
        git_ref="refs/heads/main",
        git_ref_type="branch",
        event_git_sha=EVENT_SHA,
        executed_git_sha=EXECUTED_SHA,
        policy_version=POLICY,
        engine_schema_version="candidate-funnel-1",
        engine_score_version="market-score-v1",
        engine_funnel_version="candidate-funnel-v1",
        modules=module_bindings,
        raw_files=raw_bindings,
        joined_candidate_input=DigestBinding(digest(joined_bytes), len(joined_bytes)),
        replay_context=DigestBinding(digest(context_bytes), len(context_bytes)),
        capture_input=DigestBinding(digest(capture_bytes), len(capture_bytes)),
    )
    input_identity = {
        "rawFiles": {
            item.name: {"present": item.present, "sha256": item.sha256, "bytes": item.bytes}
            for item in raw_bindings
        },
        "joinedCandidateInput": {"sha256": expected.joined_candidate_input.sha256, "bytes": expected.joined_candidate_input.bytes},
        "replayContext": {"sha256": expected.replay_context.sha256, "bytes": expected.replay_context.bytes},
        "captureInput": {"sha256": expected.capture_input.sha256, "bytes": expected.capture_input.bytes},
    }
    observation_bytes = build_observation_bytes(
        policy_version=POLICY,
        run_identity=run_identity(),
        source_identity=source_identity(),
        input_identity=input_identity,
        base=side(),
        perturbed=side(perturbed=True),
    )
    receipt = {
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "runIdentity": run_identity(),
        "policyVersion": POLICY,
        "executedGitSha": EXECUTED_SHA,
        "observationDigest": digest(observation_bytes),
        "captureInputDigest": digest(capture_bytes),
        "terminalStatus": "BATCH_READY",
        "artifactAvailable": True,
        "transportStatus": "READY",
        "failureCode": None,
        "reportState": "COMPLETE",
        "report": {
            "context": context(),
            "joinStats": join_stats(),
            "prescreenDuplicateCodes": [],
            "qualityGate": quality_gate(),
            "engineStatus": "generated",
        },
    }
    receipt_bytes = build_batch_receipt_bytes(
        receipt, observation_bytes=observation_bytes, capture_input_bytes=capture_bytes
    )
    parts, reference = build_handoff_parts(
        observation_bytes=observation_bytes,
        capture_input_bytes=capture_bytes,
        receipt_bytes=receipt_bytes,
    )
    return expected, parts, reference


@pytest.fixture
def contract():
    return build_contract()


def assert_error(code, action, detail=None):
    with pytest.raises(HandoffError) as caught:
        action()
    assert caught.value.code == code
    if detail is not None:
        assert caught.value.detail == detail


def test_deterministic_encoding_and_observation_digest(contract):
    expected, parts, _ = contract
    value = parts.observation_value()
    reordered = dict(reversed(list(value.items())))
    assert canonical_json_bytes(value) == canonical_json_bytes(reordered) == parts.observation_bytes
    assert validate_handoff_observation(parts.observation_bytes, expected).sha256 == digest(parts.observation_bytes)
    assert b"\n" not in parts.observation_bytes


def test_transport_digest_is_deterministic_and_distinct_from_observation(contract):
    _, parts, reference = contract
    assert reference.transport_digest == digest(parts.envelope_bytes)
    assert reference.observation_digest == digest(parts.observation_bytes)
    assert reference.transport_digest != reference.observation_digest
    assert "transportDigest" not in parts.envelope_value()


def test_valid_round_trip_and_fresh_container_ownership(contract):
    expected, parts, reference = contract
    validated = validate_handoff_parts(parts, expected, reference)
    first = validated.observation_value()
    first["base"]["candidates"][0]["code"] = "MUTATED"
    second = validated.observation_value()
    assert second["base"]["candidates"][0]["code"] == "1001"
    assert validated.observation_bytes == parts.observation_bytes


def test_builder_detaches_every_caller_container():
    joined = joined_input()
    ctx = context()
    stats = join_stats()
    encoded = build_capture_input_bytes(
        joined_candidate_input=joined, context=ctx, join_stats=stats,
        source_updated_at=None, candidates_updated_at=None,
    )
    before = bytes(encoded)
    joined[0]["code"] = "MUTATED"
    ctx["pipelinePath"] = "cache_fallback"
    stats["candidateCount"] = 999
    assert encoded == before
    assert json.loads(encoded)["joinedCandidateInput"][0]["code"] == "1001"


def test_observation_digest_mismatch_fails_before_payload_trust(contract):
    expected, parts, reference = contract
    changed = HandoffParts(parts.capture_input_bytes, parts.observation_bytes + b" ", parts.receipt_bytes, parts.envelope_bytes)
    assert_error("OBSERVATION_DIGEST_MISMATCH", lambda: validate_handoff_parts(changed, expected, reference))


def test_transport_digest_mismatch(contract):
    expected, parts, reference = contract
    changed = HandoffParts(parts.capture_input_bytes, parts.observation_bytes, parts.receipt_bytes, parts.envelope_bytes + b" ")
    assert_error("TRANSPORT_DIGEST_MISMATCH", lambda: validate_handoff_parts(changed, expected, reference))


@pytest.mark.parametrize(
    ("field", "value", "code"),
    [
        ("run_id", "999", "RUN_ID_MISMATCH"),
        ("run_attempt", "3", "RUN_ATTEMPT_MISMATCH"),
        ("policy_version", "p14-other", "POLICY_BINDING_MISMATCH"),
        ("repository", "other/repository", "RUN_IDENTITY_MISMATCH"),
        ("event_git_sha", "3" * 40, "RUN_IDENTITY_MISMATCH"),
        ("executed_git_sha", "4" * 40, "SOURCE_IDENTITY_MISMATCH"),
        ("engine_schema_version", "candidate-funnel-999", "SOURCE_IDENTITY_MISMATCH"),
    ],
)
def test_wrong_expected_bindings_fail_closed(contract, field, value, code):
    expected, parts, reference = contract
    wrong = replace(expected, **{field: value})
    assert_error(code, lambda: validate_handoff_parts(parts, wrong, reference))


def test_wrong_input_and_context_identity(contract):
    expected, parts, reference = contract
    wrong_input = replace(expected, joined_candidate_input=DigestBinding("d" * 64, expected.joined_candidate_input.bytes))
    assert_error("INPUT_IDENTITY_MISMATCH", lambda: validate_handoff_parts(parts, wrong_input, reference))
    wrong_context = replace(expected, replay_context=DigestBinding("e" * 64, expected.replay_context.bytes))
    assert_error("INPUT_IDENTITY_MISMATCH", lambda: validate_handoff_parts(parts, wrong_context, reference))


def test_wrong_schema_is_distinct(contract):
    expected, parts, _ = contract
    value = parts.observation_value()
    value["schemaVersion"] = "p14-canonical-observation-999"
    assert_error(
        "UNSUPPORTED_OBSERVATION_SCHEMA",
        lambda: validate_handoff_observation(canonical_json_bytes(value), expected),
    )


@pytest.mark.parametrize(
    ("payload", "detail"),
    [
        (b"\xff", "INVALID_UTF8"),
        (b'{"a":1,"a":2}', "DUPLICATE_KEY"),
        (b'{"a":NaN}', "NONFINITE_JSON"),
        (b'{"a":Infinity}', "NONFINITE_JSON"),
        (b'{"a":-Infinity}', "NONFINITE_JSON"),
        (b'{"a":1} trailing', "TRAILING_DATA"),
        (b'{"a":1} ', "NONCANONICAL_ENCODING"),
        (b'{', "JSON_SYNTAX"),
    ],
)
def test_strict_decode_failures_are_stable(contract, payload, detail):
    expected, _, _ = contract
    assert_error("HANDOFF_MALFORMED", lambda: validate_handoff_observation(payload, expected), detail)


def test_overflow_to_nonfinite_is_rejected(contract):
    expected, _, _ = contract
    assert_error(
        "HANDOFF_MALFORMED",
        lambda: validate_handoff_observation(b'{"a":1e999}', expected),
        "NONFINITE_JSON",
    )


def test_bool_does_not_satisfy_integer_field(contract):
    expected, parts, _ = contract
    value = parts.observation_value()
    value["base"]["candidates"][0]["artifactIndex"] = False
    assert_error("HANDOFF_MALFORMED", lambda: validate_handoff_observation(canonical_json_bytes(value), expected), "TYPE")


@pytest.mark.parametrize(
    "mutate",
    [
        lambda value: value.update({"unknown": 1}),
        lambda value: value["runIdentity"].update({"unknown": 1}),
        lambda value: value["sourceIdentity"].update({"unknown": 1}),
        lambda value: value["inputIdentity"].update({"unknown": 1}),
        lambda value: value["base"].update({"unknown": 1}),
        lambda value: value["base"]["candidates"][0].update({"unknown": 1}),
        lambda value: value["diagnosticAvailability"]["confidenceInvariant"].update({"unknown": 1}),
        lambda value: value.update({"optionalOrderingFacts": {}}),
    ],
)
def test_recursive_positive_allowlist_rejects_unknown_keys(contract, mutate):
    expected, parts, _ = contract
    value = parts.observation_value()
    mutate(value)
    assert_error("HANDOFF_UNKNOWN_KEY", lambda: validate_handoff_observation(canonical_json_bytes(value), expected))


@pytest.mark.parametrize("private_key", sorted(handoff.FORBIDDEN_KEYS))
def test_private_unapproved_keys_are_rejected_at_every_depth(contract, private_key):
    expected, parts, _ = contract
    value = parts.observation_value()
    value["base"]["candidates"][0][private_key] = "private"
    assert_error("HANDOFF_PRIVACY_VIOLATION", lambda: validate_handoff_observation(canonical_json_bytes(value), expected))


def test_token_and_private_path_values_are_rejected(contract):
    expected, parts, _ = contract
    for private in ("ghp_" + "x" * 36, "/Users/alice/private/file", "/home/alice/private"):
        value = parts.observation_value()
        value["runIdentity"]["event"] = private
        assert_error("HANDOFF_PRIVACY_VIOLATION", lambda value=value: validate_handoff_observation(canonical_json_bytes(value), expected))


def test_unranked_invalid_sector_fails_handoff_f04_boundary(contract):
    expected, parts, _ = contract
    value = parts.observation_value()
    value["base"]["candidates"][1]["marketRank"] = None
    value["base"]["candidates"][1]["sector"] = {"private": "shape"}
    assert_error("HANDOFF_MALFORMED", lambda: validate_handoff_observation(canonical_json_bytes(value), expected), "TYPE")


def test_confidence_observability_verified_with_mismatch():
    value = compute_confidence_invariant(
        [{"code": "A", "dataConfidence": 0.9}],
        [{"code": "A", "dataConfidence": 0.8}],
    )
    assert value == {
        "state": "VERIFIED", "basis": "PUBLIC_ROUNDED_ONLY", "comparedCount": 1,
        "totalCount": 1, "mismatchedCodes": ["A"], "unavailableCodes": [], "reason": None,
    }


def test_confidence_observability_not_verifiable_and_not_applicable():
    missing = compute_confidence_invariant(
        [{"code": "A", "dataConfidence": None}], [{"code": "A", "dataConfidence": 0.8}]
    )
    assert missing["state"] == "NOT_VERIFIABLE"
    assert missing["reason"] == "CONFIDENCE_VALUE_UNAVAILABLE"
    assert missing["unavailableCodes"] == ["A"]
    identity = compute_confidence_invariant([{"code": "A"}], [{"code": "B"}])
    assert identity["state"] == "NOT_VERIFIABLE" and identity["reason"] == "IDENTITY_NOT_COMPARABLE"
    empty = compute_confidence_invariant([], [])
    assert empty["state"] == "NOT_APPLICABLE" and empty["reason"] == "EMPTY_POPULATION"


def test_receipt_cannot_claim_publication_success(contract):
    _, parts, _ = contract
    receipt = parts.receipt_value()
    assert "published" not in json.dumps(receipt)
    receipt["report"]["published"] = True
    assert_error("HANDOFF_UNKNOWN_KEY", lambda: build_batch_receipt_bytes(receipt))


def test_receipt_gate_parity_is_fail_closed(contract):
    _, parts, _ = contract
    receipt = parts.receipt_value()
    receipt["report"]["qualityGate"]["gates"][0]["status"] = "FAIL"
    assert_error(
        "BATCH_RECEIPT_INVALID",
        lambda: build_batch_receipt_bytes(
            receipt,
            observation_bytes=parts.observation_bytes,
            capture_input_bytes=parts.capture_input_bytes,
        ),
        "GATE_PARITY",
    )


def test_missing_payload_and_reference_priority(contract):
    expected, parts, _ = contract
    assert_error("HANDOFF_MISSING", lambda: validate_handoff_parts(None, expected, None), "PRODUCER_REFERENCE_MISSING")
    assert_error("PRODUCER_REFERENCE_MISSING", lambda: validate_handoff_parts(parts, expected, None))


def test_incomplete_reference_is_rejected(contract):
    expected, parts, reference = contract
    value = reference.to_value()
    del value["receiptDigest"]
    assert_error("PRODUCER_REFERENCE_MISSING", lambda: validate_handoff_parts(parts, expected, value))


def test_self_consistent_replacement_still_fails_independent_reference(contract):
    expected, parts, reference = contract
    envelope = parts.envelope_value()
    envelope["captureInput"]["bytes"] += 1
    replaced = HandoffParts(
        parts.capture_input_bytes, parts.observation_bytes, parts.receipt_bytes, canonical_json_bytes(envelope)
    )
    assert_error("TRANSPORT_DIGEST_MISMATCH", lambda: validate_handoff_parts(replaced, expected, reference))


def test_producer_reference_is_exact_closed_scalar_contract(contract):
    _, parts, reference = contract
    assert ProducerReference.from_value(reference.to_value()) == reference
    value = reference.to_value()
    value["extra"] = "x"
    assert_error("HANDOFF_UNKNOWN_KEY", lambda: ProducerReference.from_value(value))


def test_first_claim_succeeds_and_second_claim_fails(tmp_path):
    root = tmp_path / "handoff-root"
    first = claim_attempt(root, "12345", "2")
    assert Path(first.attempt_directory).is_dir()
    assert_error("DUPLICATE_PRODUCER_OUTPUT", lambda: claim_attempt(root, "12345", "2"))


def test_successful_atomic_install_and_read(contract, tmp_path):
    expected, parts, reference = contract
    root = tmp_path / "handoff-root"
    claim = claim_attempt(root, expected.run_id, expected.run_attempt)
    write_handoff_parts(claim, parts)
    directory = Path(claim.attempt_directory)
    assert (directory / HANDOFF_FILE).is_file()
    assert (directory / CAPTURE_INPUT_FILE).is_file()
    assert (directory / RECEIPT_FILE).is_file()
    assert not list(directory.glob(".stage-*"))
    loaded = read_handoff_parts(root, expected, reference)
    assert loaded == parts


def test_duplicate_write_cannot_overwrite_successful_producer(contract, tmp_path):
    expected, parts, _ = contract
    root = tmp_path / "handoff-root"
    claim = claim_attempt(root, expected.run_id, expected.run_attempt)
    write_handoff_parts(claim, parts)
    before = (Path(claim.attempt_directory) / HANDOFF_FILE).read_bytes()
    assert_error("DUPLICATE_PRODUCER_OUTPUT", lambda: write_handoff_parts(claim, parts))
    assert (Path(claim.attempt_directory) / HANDOFF_FILE).read_bytes() == before


def test_manifest_last_failure_leaves_partial_output_nonauthoritative(contract, tmp_path, monkeypatch):
    expected, parts, reference = contract
    root = tmp_path / "handoff-root"
    claim = claim_attempt(root, expected.run_id, expected.run_attempt)
    original = handoff._atomic_no_overwrite

    def fail_manifest(directory, file_name, payload):
        if file_name == HANDOFF_FILE:
            raise HandoffError("HANDOFF_WRITE_FAILED")
        return original(directory, file_name, payload)

    monkeypatch.setattr(handoff, "_atomic_no_overwrite", fail_manifest)
    assert_error("HANDOFF_WRITE_FAILED", lambda: write_handoff_parts(claim, parts))
    directory = Path(claim.attempt_directory)
    assert not (directory / HANDOFF_FILE).exists()
    assert (directory / CAPTURE_INPUT_FILE).exists()
    assert_error("STALE_HANDOFF", lambda: read_handoff_parts(root, expected, reference))
    assert directory.exists()


def test_stale_missing_attempt_is_rejected(contract, tmp_path):
    expected, _, reference = contract
    root = tmp_path / "handoff-root"
    root.mkdir(mode=0o700)
    assert_error("STALE_HANDOFF", lambda: read_handoff_parts(root, expected, reference))


def test_old_attempt_reference_is_rejected_before_storage_read(contract, tmp_path):
    expected, _, reference = contract
    old = replace(reference, run_attempt="1")
    assert_error("RUN_ATTEMPT_MISMATCH", lambda: read_handoff_parts(tmp_path / "missing", expected, old))


def test_storage_rejects_repository_root_and_symlink(tmp_path):
    assert_error("HANDOFF_LOCATION_INVALID", lambda: claim_attempt(REPO / "forbidden-handoff", "1", "1"))
    real = tmp_path / "real"
    real.mkdir(mode=0o700)
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    assert_error("HANDOFF_LOCATION_INVALID", lambda: claim_attempt(link, "1", "1"))


def test_storage_is_bounded_to_fixed_files_and_no_cleanup(contract, tmp_path):
    expected, parts, _ = contract
    root = tmp_path / "handoff-root"
    claim = claim_attempt(root, expected.run_id, expected.run_attempt)
    write_handoff_parts(claim, parts)
    names = {path.name for path in Path(claim.attempt_directory).iterdir()}
    assert names == {
        handoff.CLAIM_FILE, CAPTURE_INPUT_FILE, RECEIPT_FILE, HANDOFF_FILE,
        f"observation-{digest(parts.observation_bytes)}.json",
    }
    assert Path(claim.attempt_directory).exists()


def test_consumer_rejects_unbounded_extra_storage_entry(contract, tmp_path):
    expected, parts, reference = contract
    root = tmp_path / "handoff-root"
    claim = claim_attempt(root, expected.run_id, expected.run_attempt)
    write_handoff_parts(claim, parts)
    extra = Path(claim.attempt_directory) / "unapproved.json"
    extra.write_bytes(b"{}")
    assert_error("HANDOFF_LOCATION_INVALID", lambda: read_handoff_parts(root, expected, reference))


def test_claim_object_cannot_be_redirected(contract, tmp_path):
    expected, parts, _ = contract
    root = tmp_path / "handoff-root"
    claim = claim_attempt(root, expected.run_id, expected.run_attempt)
    forged = AttemptClaim(claim.root, str(tmp_path / "elsewhere"), claim.run_id, claim.run_attempt)
    assert_error("HANDOFF_LOCATION_INVALID", lambda: write_handoff_parts(forged, parts))


def test_privacy_authority_literals_match_without_importing_engine():
    candidate_source = (REPO / "data/candidate_funnel_privacy_smoke.py").read_text(encoding="utf-8")
    candidate_tree = ast.parse(candidate_source)
    assignment = next(
        node for node in candidate_tree.body
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "FORBIDDEN_KEYS" for target in node.targets)
    )
    assert frozenset(ast.literal_eval(assignment.value)) == handoff.FORBIDDEN_KEYS

    privacy_source = (REPO / "data/p14_evidence_privacy_filter.py").read_text(encoding="utf-8")
    privacy_tree = ast.parse(privacy_source)
    compiled = [
        ast.literal_eval(node.args[0])
        for node in ast.walk(privacy_tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "re"
        and node.func.attr == "compile"
        and node.args
    ]
    for pattern in handoff.SECRET_PATTERN_TEXTS + handoff.PRIVATE_PATH_PATTERN_TEXTS:
        assert pattern in compiled


def test_purity_import_boundary_and_no_activation_logic():
    source = inspect.getsource(handoff)
    tree = ast.parse(source)
    imported = {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.Import)
        for alias in node.names
    } | {
        node.module or ""
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom)
    }
    assert not any(
        forbidden in name
        for name in imported
        for forbidden in (
            "candidate_funnel_engine", "candidate_funnel_batch", "candidate_funnel_run_evidence",
            "subprocess", "urllib", "requests",
        )
    )
    assert "P14_HANDOFF_MODE" not in source
    assert "RUNNER_TEMP" not in source
    assert "os.environ" not in source


def test_timezone_independent_bytes(contract, monkeypatch):
    _, parts, reference = contract
    before = (parts.observation_bytes, parts.capture_input_bytes, parts.receipt_bytes, parts.envelope_bytes, reference)
    monkeypatch.setenv("TZ", "Pacific/Honolulu")
    _, second_parts, second_reference = build_contract()
    after = (
        second_parts.observation_bytes, second_parts.capture_input_bytes,
        second_parts.receipt_bytes, second_parts.envelope_bytes, second_reference,
    )
    assert after == before


def test_no_mutable_nested_graph_is_retained_in_frozen_wrappers(contract):
    expected, parts, reference = contract
    assert all(isinstance(item, tuple) for item in (expected.modules, expected.raw_files))
    assert all(type(value) is bytes for value in (
        parts.capture_input_bytes, parts.observation_bytes, parts.receipt_bytes, parts.envelope_bytes
    ))
    assert make_producer_reference(parts) == reference


def test_envelope_binds_each_exact_byte_length_and_digest(contract):
    _, parts, reference = contract
    envelope = parts.envelope_value()
    assert envelope["observation"] == {
        "file": f"observation-{reference.observation_digest}.json",
        "sha256": reference.observation_digest,
        "bytes": len(parts.observation_bytes),
    }
    assert envelope["captureInput"]["sha256"] == digest(parts.capture_input_bytes)
    assert envelope["receipt"]["sha256"] == digest(parts.receipt_bytes)


def test_capture_projection_does_not_transit_unknown_broad_input():
    payload = build_capture_input_bytes(
        joined_candidate_input=joined_input(), context=context(), join_stats=join_stats(),
        source_updated_at=None, candidates_updated_at=None,
    )
    assert "unknownBroadInput" not in json.loads(payload)["joinedCandidateInput"][0]


def test_capture_rejects_nested_unapproved_private_data():
    bad = joined_input()
    bad[0]["price"] = {"holdings": [1]}
    assert_error(
        "HANDOFF_MALFORMED",
        lambda: build_capture_input_bytes(
            joined_candidate_input=bad, context=context(), join_stats=join_stats(),
            source_updated_at=None, candidates_updated_at=None,
        ),
        "TYPE",
    )


def test_signed_zero_and_unicode_are_preserved():
    rows = joined_input()
    rows[0]["name"] = "日本株"
    rows[0]["mom3m"] = -0.0
    payload = build_capture_input_bytes(
        joined_candidate_input=rows, context=context(), join_stats=join_stats(),
        source_updated_at=None, candidates_updated_at=None,
    )
    assert "日本株" in payload.decode("utf-8")
    assert b"-0.0" in payload


def test_reference_output_is_single_line_safe(contract):
    _, _, reference = contract
    for value in reference.to_value().values():
        assert type(value) is str
        assert "\n" not in value and "\r" not in value
