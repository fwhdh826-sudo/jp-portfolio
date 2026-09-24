"""Synthetic Phase II-A handoff, privacy, ownership, and storage contracts."""
from __future__ import annotations

import ast
import copy
import hashlib
import inspect
import json
import multiprocessing
import os
from dataclasses import replace
from pathlib import Path

import pytest

from data import p14_handoff as handoff
from data.p14_handoff import (
    CAPTURE_INPUT_FILE,
    CAPTURE_INPUT_SCHEMA_VERSION,
    CLAIM_CONSUMED_FILE,
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


def _claim_contender(root, run_id, run_attempt, barrier, queue):
    try:
        barrier.wait(timeout=15)
        claim = claim_attempt(root, run_id, run_attempt)
        queue.put(("WIN", claim.owner_nonce, claim.attempt_directory))
    except HandoffError as exc:
        queue.put(("LOSE", exc.code, exc.detail))
    except BaseException as exc:  # surfaced to the parent as a test failure
        queue.put(("ERROR", type(exc).__name__, str(exc)))


def _forged_write_contender(claim_values, parts, queue):
    forged = AttemptClaim(*claim_values)
    try:
        write_handoff_parts(forged, parts)
    except HandoffError as exc:
        queue.put((exc.code, exc.detail))
    else:
        queue.put(("ACCEPTED", None))


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
    """Exact candidate_funnel_batch generated-report gate field shapes."""
    return [
        {"id": "P-01", "metric": "candidate総数", "value": 2, "threshold": "記録", "status": "RECORD", "note": ""},
        {"id": "P-02", "metric": "prescreen join率", "value": 1.0, "threshold": ">= 0.95", "status": "PASS", "note": ""},
        {"id": "P-03", "metric": "unmatched candidate率", "value": 0.0, "threshold": "記録（> 0.05 で要調査）", "status": "RECORD", "note": ""},
        {"id": "P-04", "metric": "duplicate code率（candidate側）", "value": 0.0, "threshold": "== 0", "status": "PASS", "note": "[]"},
        {"id": "PRESCREEN_DUPLICATE", "metric": "duplicate code（prescreen側）", "value": 0, "threshold": "== 0", "status": "PASS", "note": "[]"},
        {"id": "P-05", "metric": "missing prescreen率（engine出力ベース）", "value": 0.0, "threshold": "記録。P-02と整合", "status": "RECORD", "note": ""},
        {
            "id": "P-06", "metric": "dataConfidence分布",
            "value": {"count": 2, "min": 4, "p25": 4, "median": 5, "p75": 6, "max": 6, "atOrBelow4AxesCount": 1},
            "threshold": "記録", "status": "RECORD", "note": "",
        },
        {
            "id": "P-07", "metric": "marketScore分布(IQR/range)",
            "value": {"count": 2, "min": 20.0, "max": 80.0, "range": 60.0, "p25": 30.0, "p75": 50.0, "iqr": 20.0, "median": 40.0},
            "threshold": "IQR>=10.0 かつ range>=40.0", "status": "PASS", "note": "",
        },
        {"id": "P-08", "metric": "deep-review件数", "value": 1, "threshold": "> 0", "status": "PASS", "note": ""},
        {"id": "P-09", "metric": "actionable件数", "value": 1, "threshold": "記録。0の場合はreason分布で説明可能なこと", "status": "RECORD", "note": ""},
        {
            "id": "P-10", "metric": "sector breadth(deepReview/actionable)",
            "value": {"deepReview": 7, "actionable": 4},
            "threshold": "deepReview>=7 かつ actionable>=4", "status": "PASS", "note": "",
        },
        {
            "id": "P-11", "metric": "cap overflow",
            "value": {
                "deepReviewSectorCapOverflow": {"Technology": 0},
                "actionableSectorCapOverflow": {"Technology": 0},
                "deepReviewEligibleMinusSelected": 0,
                "actionableEligibleMinusSelected": 0,
            },
            "threshold": "記録", "status": "RECORD", "note": "",
        },
        {
            "id": "P-12", "metric": "reason code分布(soft/hard)",
            "value": {"soft": {}, "hard": {}},
            "threshold": "記録。v1 inactive 4件は0件であること", "status": "PASS", "note": "",
        },
        {
            "id": "P-13", "metric": "degraded path actionable",
            "value": {"currentRunActionable": 1, "cacheFallbackMirrorActionable": 0},
            "threshold": "現在runがdegradedならactionable==0、かつcache_fallback mirrorでactionable==0",
            "status": "PASS", "note": "is_degraded=False",
        },
        {
            "id": "P-14", "metric": "rank stability Jaccard(±2%) + decision-aware market reference gate",
            "value": 1.0,
            "threshold": ">= 0.95 (WARN backstop) / >= 0.8 (HARD backstop)",
            "status": "PASS",
            "note": "assignment=p14-prescreen-rank-code-v1; identity=exact-string-code; invalid-or-duplicate-identities-do-not-consume-ordinal",
        },
        {"id": "P-15", "metric": "rank drift vs previous", "value": None, "threshold": "記録", "status": "RECORD", "note": "baseline無し（初回run or 前回not_generated）"},
    ]


def not_generated_gates():
    metrics = [gate["metric"] for gate in gates() if gate["id"] != "PRESCREEN_DUPLICATE"]
    result = [{"id": "P-01", "metric": metrics[0], "value": 2, "threshold": "記録", "status": "RECORD", "note": ""}]
    for number, metric in enumerate(metrics[1:], start=2):
        result.append(
            {
                "id": f"P-{number:02d}", "metric": metric, "value": None,
                "threshold": "N/A", "status": "N/A",
                "note": "status=not_generatedのため評価対象外",
            }
        )
    return result


def quality_gate():
    return {
        "gates": gates(),
        "overallPass": True,
        "hardFailIds": [],
        "notes": [],
        "p14ReleaseEvidence": release_evidence(),
    }


def failed_quality_gate():
    value = quality_gate()
    p14 = next(gate for gate in value["gates"] if gate["id"] == "P-14")
    p14["status"] = "FAIL"
    value["overallPass"] = False
    value["hardFailIds"] = ["P-14"]
    value["p14ReleaseEvidence"]["final"] = {
        "status": "FAIL", "hardReasons": ["P14_TOP40_JACCARD_HARD_FAIL"], "warnReasons": [],
    }
    return value


def not_generated_quality_gate():
    return {
        "gates": not_generated_gates(),
        "overallPass": False,
        "hardFailIds": [],
        "notes": [
            "status=not_generated（not_generated）のため新規artifactをpublishしない"
            "（既存artifactがあればそのまま保持、frozenなdegraded path failure policy）",
        ],
        "p14ReleaseEvidence": None,
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


def test_module_and_raw_file_bindings_fail_with_canonical_codes(contract):
    expected, parts, reference = contract
    modules = list(expected.modules)
    modules[0] = replace(modules[0], sha256="f" * 64)
    assert_error(
        "SOURCE_IDENTITY_MISMATCH",
        lambda: validate_handoff_parts(parts, replace(expected, modules=tuple(modules)), reference),
    )
    raw_files = list(expected.raw_files)
    raw_files[0] = replace(raw_files[0], sha256="e" * 64)
    assert_error(
        "INPUT_IDENTITY_MISMATCH",
        lambda: validate_handoff_parts(parts, replace(expected, raw_files=tuple(raw_files)), reference),
    )


def test_receipt_and_producer_reference_digest_bindings_fail_closed(contract):
    expected, parts, reference = contract
    assert_error(
        "BATCH_RECEIPT_INVALID",
        lambda: validate_handoff_parts(parts, expected, replace(reference, receipt_digest="d" * 64)),
        "DIGEST_MISMATCH",
    )
    assert_error(
        "TRANSPORT_DIGEST_MISMATCH",
        lambda: validate_handoff_parts(parts, expected, replace(reference, transport_digest="c" * 64)),
    )
    assert_error(
        "OBSERVATION_DIGEST_MISMATCH",
        lambda: validate_handoff_parts(parts, expected, replace(reference, observation_digest="b" * 64)),
    )


def test_receipt_cannot_link_to_another_observation(contract):
    _, parts, _ = contract
    receipt = parts.receipt_value()
    receipt["observationDigest"] = "d" * 64
    assert_error(
        "RECEIPT_OBSERVATION_MISMATCH",
        lambda: build_batch_receipt_bytes(
            receipt,
            observation_bytes=parts.observation_bytes,
            capture_input_bytes=parts.capture_input_bytes,
        ),
    )


def test_run_attempt_policy_and_schema_reference_bindings_are_explicit(contract):
    expected, parts, reference = contract
    cases = [
        (replace(reference, run_id="999"), "RUN_ID_MISMATCH"),
        (replace(reference, run_attempt="3"), "RUN_ATTEMPT_MISMATCH"),
        (replace(reference, policy_version="p14-other"), "POLICY_BINDING_MISMATCH"),
        (replace(reference, observation_schema_version="p14-canonical-observation-999"), "UNSUPPORTED_OBSERVATION_SCHEMA"),
        (replace(reference, handoff_schema_version="p14-handoff-999"), "UNSUPPORTED_HANDOFF_SCHEMA"),
        (replace(reference, executed_git_sha="9" * 40), "SOURCE_IDENTITY_MISMATCH"),
    ]
    for changed, code in cases:
        assert_error(code, lambda changed=changed: validate_handoff_parts(parts, expected, changed))


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


@pytest.mark.parametrize("artifact", ["capture", "receipt", "envelope"])
@pytest.mark.parametrize("depth", ["root", "nested"])
@pytest.mark.parametrize("key", ["holdings", "account", "positions", "portfolio", "arbitraryUnknownKey"])
def test_f03_multilevel_payloads_fail_closed(contract, artifact, depth, key):
    _, parts, _ = contract
    if artifact == "capture":
        value = parts.capture_input_value()
        target = value if depth == "root" else value["context"]
        target[key] = {"nested": [{"value": 1}]}
        action = lambda: build_handoff_envelope_bytes(
            observation_bytes=parts.observation_bytes,
            capture_input_bytes=canonical_json_bytes(value),
            receipt_bytes=parts.receipt_bytes,
        )
    elif artifact == "receipt":
        value = parts.receipt_value()
        target = value if depth == "root" else value["report"]["qualityGate"]
        target[key] = {"nested": [{"value": 1}]}
        action = lambda: build_batch_receipt_bytes(
            value,
            observation_bytes=parts.observation_bytes,
            capture_input_bytes=parts.capture_input_bytes,
        )
    else:
        value = parts.envelope_value()
        target = value if depth == "root" else value["observation"]
        target[key] = {"nested": [{"value": 1}]}
        changed = HandoffParts(
            parts.capture_input_bytes,
            parts.observation_bytes,
            parts.receipt_bytes,
            canonical_json_bytes(value),
        )
        action = lambda: make_producer_reference(changed)
    with pytest.raises(HandoffError):
        action()


def test_unknown_key_inside_nested_list_element_fails_closed(contract):
    expected, parts, _ = contract
    value = parts.observation_value()
    value["base"]["candidates"][0]["arbitraryUnknownKey"] = {"nested": [1]}
    assert_error(
        "HANDOFF_UNKNOWN_KEY",
        lambda: validate_handoff_observation(canonical_json_bytes(value), expected),
    )


def test_unknown_dict_replacing_scalar_leaf_fails_closed(contract):
    _, parts, _ = contract
    receipt = parts.receipt_value()
    receipt["terminalStatus"] = {"arbitraryUnknownKey": []}
    assert_error(
        "HANDOFF_MALFORMED",
        lambda: build_batch_receipt_bytes(
            receipt,
            observation_bytes=parts.observation_bytes,
            capture_input_bytes=parts.capture_input_bytes,
        ),
        "TYPE",
    )


def test_extra_list_entry_with_unknown_structure_fails_closed(contract):
    _, parts, _ = contract
    capture = parts.capture_input_value()
    capture["joinedCandidateInput"].append({"arbitraryUnknownKey": {"nested": [1]}})
    assert_error(
        "HANDOFF_UNKNOWN_KEY",
        lambda: build_handoff_envelope_bytes(
            observation_bytes=parts.observation_bytes,
            capture_input_bytes=canonical_json_bytes(capture),
            receipt_bytes=parts.receipt_bytes,
        ),
    )


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


def test_batch_shaped_complete_receipt_accepts_empty_gate_notes(contract):
    _, parts, _ = contract
    receipt = parts.receipt_value()
    assert any(gate["note"] == "" for gate in receipt["report"]["qualityGate"]["gates"])
    rebuilt = build_batch_receipt_bytes(
        receipt,
        observation_bytes=parts.observation_bytes,
        capture_input_bytes=parts.capture_input_bytes,
    )
    assert json.loads(rebuilt) == receipt


def test_batch_shaped_quality_failure_receipt_is_accepted(contract):
    _, parts, _ = contract
    receipt = parts.receipt_value()
    receipt.update({"terminalStatus": "QUALITY_GATE_FAILED", "artifactAvailable": False})
    receipt["report"]["qualityGate"] = failed_quality_gate()
    rebuilt = build_batch_receipt_bytes(
        receipt,
        observation_bytes=parts.observation_bytes,
        capture_input_bytes=parts.capture_input_bytes,
    )
    assert json.loads(rebuilt)["report"]["qualityGate"]["hardFailIds"] == ["P-14"]
    assert_error(
        "BATCH_RECEIPT_INVALID",
        lambda: build_handoff_envelope_bytes(
            observation_bytes=parts.observation_bytes,
            capture_input_bytes=parts.capture_input_bytes,
            receipt_bytes=rebuilt,
        ),
        "TRANSPORT_STATUS",
    )


def test_batch_shaped_not_generated_receipt_is_accepted(contract):
    _, parts, _ = contract
    receipt = {
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "runIdentity": run_identity(),
        "policyVersion": POLICY,
        "executedGitSha": EXECUTED_SHA,
        "observationDigest": None,
        "captureInputDigest": digest(parts.capture_input_bytes),
        "terminalStatus": "NOT_GENERATED",
        "artifactAvailable": False,
        "transportStatus": "P14_NOT_EVALUATED",
        "failureCode": "P14_NOT_EVALUATED",
        "reportState": "COMPLETE",
        "report": {
            "context": context(),
            "joinStats": join_stats(),
            "prescreenDuplicateCodes": [],
            "qualityGate": not_generated_quality_gate(),
            "engineStatus": "not_generated",
        },
    }
    rebuilt = build_batch_receipt_bytes(receipt, capture_input_bytes=parts.capture_input_bytes)
    value = json.loads(rebuilt)
    assert value["report"]["qualityGate"]["overallPass"] is False
    assert value["report"]["qualityGate"]["hardFailIds"] == []


def test_batch_shaped_schema_violations_receipt_is_accepted(contract):
    _, parts, _ = contract
    receipt = parts.receipt_value()
    receipt.update({"terminalStatus": "SCHEMA_VIOLATIONS", "artifactAvailable": False})
    receipt["report"]["schemaViolations"] = ["status not in allowed enum"]
    rebuilt = build_batch_receipt_bytes(
        receipt,
        observation_bytes=parts.observation_bytes,
        capture_input_bytes=parts.capture_input_bytes,
    )
    assert json.loads(rebuilt)["report"]["schemaViolations"] == ["status not in allowed enum"]


def test_report_unavailable_input_failure_receipt_is_accepted():
    receipt = {
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "runIdentity": run_identity(),
        "policyVersion": POLICY,
        "executedGitSha": EXECUTED_SHA,
        "observationDigest": None,
        "captureInputDigest": None,
        "terminalStatus": "BATCH_INPUT_ERROR",
        "artifactAvailable": False,
        "transportStatus": "INPUT_IDENTITY_UNAVAILABLE",
        "failureCode": "INPUT_IDENTITY_UNAVAILABLE",
        "reportState": "UNAVAILABLE",
        "report": None,
    }
    assert json.loads(build_batch_receipt_bytes(receipt)) == receipt


@pytest.mark.parametrize(
    "mutation",
    [
        lambda receipt: (
            receipt.update({"terminalStatus": "BATCH_READY", "artifactAvailable": True}),
            receipt["report"].update({"qualityGate": failed_quality_gate()}),
        ),
        lambda receipt: receipt.update({"terminalStatus": "SCHEMA_VIOLATIONS", "artifactAvailable": False}),
        lambda receipt: receipt["report"].update(
            {"engineStatus": "not_generated", "qualityGate": not_generated_quality_gate()}
        ),
        lambda receipt: receipt.update({"reportState": "UNAVAILABLE", "report": None}),
    ],
)
def test_impossible_terminal_report_combinations_are_rejected(contract, mutation):
    _, parts, _ = contract
    receipt = parts.receipt_value()
    mutation(receipt)
    assert_error(
        "BATCH_RECEIPT_INVALID",
        lambda: build_batch_receipt_bytes(
            receipt,
            observation_bytes=parts.observation_bytes,
            capture_input_bytes=parts.capture_input_bytes,
        ),
        "REPORT_STATE",
    )


def test_failure_receipt_cannot_invent_unvalidated_digests():
    receipt = {
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "runIdentity": run_identity(),
        "policyVersion": POLICY,
        "executedGitSha": EXECUTED_SHA,
        "observationDigest": "a" * 64,
        "captureInputDigest": None,
        "terminalStatus": "BATCH_EXCEPTION",
        "artifactAvailable": False,
        "transportStatus": "CANONICAL_CONSTRUCTION_FAILED",
        "failureCode": "CANONICAL_CONSTRUCTION_FAILED",
        "reportState": "UNAVAILABLE",
        "report": None,
    }
    assert_error(
        "BATCH_RECEIPT_INVALID",
        lambda: build_batch_receipt_bytes(receipt),
        "DIGEST_MISMATCH",
    )


@pytest.mark.parametrize("replacement", [[], {}])
@pytest.mark.parametrize("field", ["tier", "engineStatus", "confidenceState"])
def test_malformed_enum_containers_raise_typed_handoff_error(contract, field, replacement):
    expected, parts, _ = contract
    value = parts.observation_value()
    if field == "tier":
        value["base"]["candidates"][0]["tier"] = replacement
    elif field == "engineStatus":
        value["base"]["engineStatus"] = replacement
    else:
        value["diagnosticAvailability"]["confidenceInvariant"]["state"] = replacement
    assert_error(
        "HANDOFF_MALFORMED",
        lambda: validate_handoff_observation(canonical_json_bytes(value), expected),
        "TYPE",
    )


@pytest.mark.parametrize("replacement", [[], {}])
@pytest.mark.parametrize("field", ["terminalStatus", "gateId", "gateStatus", "gateNote"])
def test_malformed_receipt_enum_and_nested_containers_are_typed(contract, field, replacement):
    _, parts, _ = contract
    receipt = parts.receipt_value()
    if field == "terminalStatus":
        receipt["terminalStatus"] = replacement
    elif field == "gateId":
        receipt["report"]["qualityGate"]["gates"][0]["id"] = replacement
    elif field == "gateStatus":
        receipt["report"]["qualityGate"]["gates"][0]["status"] = replacement
    else:
        receipt["report"]["qualityGate"]["gates"][0]["note"] = replacement
    assert_error(
        "HANDOFF_MALFORMED",
        lambda: build_batch_receipt_bytes(
            receipt,
            observation_bytes=parts.observation_bytes,
            capture_input_bytes=parts.capture_input_bytes,
        ),
        "TYPE",
    )


@pytest.mark.parametrize(
    ("value", "accepted"),
    [(40, True), (40.0, False), (True, False), (41, False)],
)
def test_top_k_parameter_uses_exact_integer_type(contract, value, accepted):
    expected, parts, _ = contract
    observation = parts.observation_value()
    observation["parameters"]["topK"] = value
    payload = canonical_json_bytes(observation)
    if accepted:
        validate_handoff_observation(payload, expected)
    else:
        assert_error("HANDOFF_UNKNOWN_KEY", lambda: validate_handoff_observation(payload, expected))


def test_lone_surrogate_is_invalid_utf8_not_generic_type(contract):
    expected, parts, _ = contract
    observation = parts.observation_value()
    observation["runIdentity"]["event"] = "\ud800"
    payload = json.dumps(
        observation, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode("ascii")
    assert_error(
        "HANDOFF_MALFORMED",
        lambda: validate_handoff_observation(payload, expected),
        "INVALID_UTF8",
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


def test_read_reference_failures_are_normalized(contract, tmp_path):
    expected, parts, reference = contract
    root = tmp_path / "handoff-root"
    claim = claim_attempt(root, expected.run_id, expected.run_attempt)
    write_handoff_parts(claim, parts)
    incomplete = reference.to_value()
    del incomplete["receiptDigest"]
    assert_error("PRODUCER_REFERENCE_MISSING", lambda: read_handoff_parts(root, expected, incomplete))
    wrong_type = reference.to_value()
    wrong_type["runId"] = []
    assert_error("PRODUCER_REFERENCE_MISSING", lambda: read_handoff_parts(root, expected, wrong_type))


def test_read_without_reference_and_without_files_is_handoff_missing(contract, tmp_path):
    expected, _, _ = contract
    assert_error("HANDOFF_MISSING", lambda: read_handoff_parts(tmp_path / "missing", expected, None))


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


def test_concurrent_os_process_claim_has_one_winner_and_deterministic_losers(tmp_path):
    process_context = multiprocessing.get_context("fork")
    contender_count = 8
    barrier = process_context.Barrier(contender_count)
    queue = process_context.Queue()
    root = str(tmp_path / "handoff-root")
    processes = [
        process_context.Process(
            target=_claim_contender,
            args=(root, "12345", "2", barrier, queue),
        )
        for _ in range(contender_count)
    ]
    for process in processes:
        process.start()
    results = [queue.get(timeout=20) for _ in processes]
    for process in processes:
        process.join(timeout=20)
        assert process.exitcode == 0
    winners = [result for result in results if result[0] == "WIN"]
    losers = [result for result in results if result[0] == "LOSE"]
    assert len(winners) == 1
    assert len(losers) == contender_count - 1
    assert {result[1] for result in losers} == {"DUPLICATE_PRODUCER_OUTPUT"}
    attempt_directory = Path(winners[0][2])
    marker_before = (attempt_directory / handoff.CLAIM_FILE).read_bytes()
    assert {path.name for path in attempt_directory.iterdir()} == {handoff.CLAIM_FILE}
    assert json.loads(marker_before)["ownerNonce"] == winners[0][1]
    assert (attempt_directory / handoff.CLAIM_FILE).read_bytes() == marker_before


def test_claim_owner_nonce_is_fresh_and_not_public(contract, tmp_path):
    _, parts, reference = contract
    first = claim_attempt(tmp_path / "root-a", "1", "1")
    second = claim_attempt(tmp_path / "root-b", "1", "1")
    assert first.owner_nonce != second.owner_nonce
    assert len(first.owner_nonce) == len(second.owner_nonce) == 64
    public_bytes = b"".join(
        (parts.capture_input_bytes, parts.observation_bytes, parts.receipt_bytes, parts.envelope_bytes)
    ) + canonical_json_bytes(reference.to_value())
    assert first.owner_nonce.encode() not in public_bytes
    assert second.owner_nonce.encode() not in public_bytes


def test_forged_claim_with_wrong_nonce_cannot_write(contract, tmp_path):
    expected, parts, _ = contract
    claim = claim_attempt(tmp_path / "handoff-root", expected.run_id, expected.run_attempt)
    forged = replace(claim, owner_nonce="f" * 64)
    assert_error("HANDOFF_LOCATION_INVALID", lambda: write_handoff_parts(forged, parts))
    assert not (Path(claim.attempt_directory) / CLAIM_CONSUMED_FILE).exists()


def test_claim_from_different_root_cannot_write(contract, tmp_path):
    expected, parts, _ = contract
    claim = claim_attempt(tmp_path / "handoff-root", expected.run_id, expected.run_attempt)
    forged = replace(claim, root=str(tmp_path / "different-root"))
    assert_error("HANDOFF_LOCATION_INVALID", lambda: write_handoff_parts(forged, parts))


def test_second_process_cannot_become_owner_from_visible_metadata(contract, tmp_path):
    expected, parts, _ = contract
    claim = claim_attempt(tmp_path / "handoff-root", expected.run_id, expected.run_attempt)
    process_context = multiprocessing.get_context("fork")
    queue = process_context.Queue()
    copied_metadata = (
        claim.root,
        claim.attempt_directory,
        claim.run_id,
        claim.run_attempt,
        "f" * 64,
    )
    process = process_context.Process(
        target=_forged_write_contender,
        args=(copied_metadata, parts, queue),
    )
    process.start()
    result = queue.get(timeout=20)
    process.join(timeout=20)
    assert process.exitcode == 0
    assert result == ("HANDOFF_LOCATION_INVALID", None)
    assert not (Path(claim.attempt_directory) / CLAIM_CONSUMED_FILE).exists()


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
    manifest = Path(claim.attempt_directory) / HANDOFF_FILE
    before = (manifest.read_bytes(), manifest.stat().st_ino)
    assert_error("DUPLICATE_PRODUCER_OUTPUT", lambda: write_handoff_parts(claim, parts))
    assert (manifest.read_bytes(), manifest.stat().st_ino) == before


def test_claim_is_consumed_after_authoritative_write_failure(contract, tmp_path, monkeypatch):
    expected, parts, reference = contract
    root = tmp_path / "handoff-root"
    claim = claim_attempt(root, expected.run_id, expected.run_attempt)
    original = handoff._atomic_no_overwrite

    def fail_first_payload(directory, file_name, payload):
        if file_name == CAPTURE_INPUT_FILE:
            raise HandoffError("HANDOFF_WRITE_FAILED")
        return original(directory, file_name, payload)

    monkeypatch.setattr(handoff, "_atomic_no_overwrite", fail_first_payload)
    assert_error("HANDOFF_WRITE_FAILED", lambda: write_handoff_parts(claim, parts))
    assert (Path(claim.attempt_directory) / CLAIM_CONSUMED_FILE).is_file()
    monkeypatch.setattr(handoff, "_atomic_no_overwrite", original)
    assert_error("DUPLICATE_PRODUCER_OUTPUT", lambda: write_handoff_parts(claim, parts))
    assert_error("STALE_HANDOFF", lambda: read_handoff_parts(root, expected, reference))


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
        handoff.CLAIM_FILE, CLAIM_CONSUMED_FILE, CAPTURE_INPUT_FILE, RECEIPT_FILE, HANDOFF_FILE,
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
    forged = AttemptClaim(
        claim.root, str(tmp_path / "elsewhere"), claim.run_id, claim.run_attempt, claim.owner_nonce
    )
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
        "HANDOFF_PRIVACY_VIOLATION",
        lambda: build_capture_input_bytes(
            joined_candidate_input=bad, context=context(), join_stats=join_stats(),
            source_updated_at=None, candidates_updated_at=None,
        ),
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
