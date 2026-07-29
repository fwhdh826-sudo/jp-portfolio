"""P14-O1で凍結された2件のreal snapshotによるorder-invariance検証。"""
from __future__ import annotations

import copy
import json
import random
from pathlib import Path
from typing import Any

import data.candidate_funnel_batch as batch


FIXTURE_PATH = (
    Path(__file__).resolve().parent
    / "fixtures"
    / "candidate_funnel_order_invariance_real_v1.json"
)
CURRENT_ID = "current-dev-committed-20260726"
HISTORICAL_ID = "historical-real-20260714-cache"
ASSIGNMENT_MARKER = "p14-prescreen-rank-code-v1"
ASSIGNMENT_NOTE = (
    "assignment=p14-prescreen-rank-code-v1; identity=exact-string-code; "
    "invalid-or-duplicate-identities-do-not-consume-ordinal"
)


def _fixture() -> dict[str, Any]:
    with FIXTURE_PATH.open(encoding="utf-8") as fixture_file:
        return json.load(fixture_file)


def _snapshot(snapshot_id: str) -> dict[str, Any]:
    return next(
        snapshot
        for snapshot in _fixture()["snapshots"]
        if snapshot["snapshotIdentity"]["snapshotId"] == snapshot_id
    )


def _vector_by_code(vector: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    assert len(vector) == len({record["code"] for record in vector})
    return {record["code"]: record for record in vector}


def _engine_vector(result: dict[str, Any]) -> list[dict[str, Any]]:
    fields = (
        "code",
        "dataConfidence",
        "marketRank",
        "marketScore",
        "rawCompositeScore",
        "tier",
    )
    return [{field: candidate[field] for field in fields} for candidate in result["candidates"]]


def _ordered_candidates(snapshot: dict[str, Any], permutation: str) -> list[dict[str, Any]]:
    candidates = copy.deepcopy(snapshot["candidates"])
    if permutation == "original-order":
        return candidates
    if permutation == "reverse-order":
        return list(reversed(candidates))
    if permutation == "code-ascending":
        return sorted(candidates, key=lambda candidate: candidate["code"])
    if permutation == "code-descending":
        return sorted(candidates, key=lambda candidate: candidate["code"], reverse=True)
    if permutation == "market-rank-ascending":
        base_rank = {
            record["code"]: record["marketRank"]
            for record in snapshot["expected"]["baseVector"]
        }
        return sorted(candidates, key=lambda candidate: base_rank[candidate["code"]])
    if permutation.startswith("seeded-shuffle-"):
        seed = int(permutation.rsplit("-", 1)[1])
        random.Random(seed).shuffle(candidates)
        return candidates
    raise AssertionError(f"unknown frozen permutation: {permutation}")


def _assert_same_records_only_reordered(
    original: list[dict[str, Any]], permuted: list[dict[str, Any]]
) -> None:
    original_codes = [candidate["code"] for candidate in original]
    permuted_codes = [candidate["code"] for candidate in permuted]
    assert len(original_codes) == len(permuted_codes)
    assert len(original_codes) == len(set(original_codes))
    assert set(original_codes) == set(permuted_codes)
    assert _vector_by_code(original) == _vector_by_code(permuted)


def _assert_assignment_vector(
    snapshot: dict[str, Any],
    perturbed_candidates: list[dict[str, Any]],
) -> None:
    original_by_code = _vector_by_code(snapshot["candidates"])
    perturbed_by_code = _vector_by_code(perturbed_candidates)
    expected = snapshot["expected"]["assignmentVector"]
    actual = []
    for expected_record in expected:
        code = expected_record["code"]
        original = original_by_code[code]
        perturbed = perturbed_by_code[code]
        actual.append(
            {
                "basePER": original.get("per"),
                "baseROE": original.get("roe"),
                "canonicalOrdinal": expected_record["canonicalOrdinal"],
                "code": code,
                "perMultiplier": expected_record["perMultiplier"],
                "perturbedPER": perturbed.get("per"),
                "perturbedROE": perturbed.get("roe"),
                "roeMultiplier": expected_record["roeMultiplier"],
                "sign": batch._p14_canonical_sign_by_code(snapshot["candidates"])[code],
            }
        )
    assert actual == expected


def _assert_snapshot_permutation(snapshot_id: str, permutation: str) -> None:
    snapshot = _snapshot(snapshot_id)
    assert permutation in snapshot["permutationNames"]
    original = copy.deepcopy(snapshot["candidates"])
    permuted = _ordered_candidates(snapshot, permutation)
    _assert_same_records_only_reordered(original, permuted)
    before = copy.deepcopy(permuted)

    base_result = batch.build_candidate_funnel(permuted, snapshot["context"])
    perturbed_candidates = batch._perturb_candidates(permuted)
    perturbed_result = batch.build_candidate_funnel(
        perturbed_candidates, snapshot["context"]
    )

    assert permuted == before
    assert [candidate["code"] for candidate in perturbed_candidates] == [
        candidate["code"] for candidate in permuted
    ]
    assert [candidate["code"] for candidate in base_result["candidates"]] == [
        candidate["code"] for candidate in permuted
    ]
    _assert_assignment_vector(snapshot, perturbed_candidates)

    expected = snapshot["expected"]
    assert _vector_by_code(_engine_vector(base_result)) == _vector_by_code(
        expected["baseVector"]
    )
    assert _vector_by_code(_engine_vector(perturbed_result)) == _vector_by_code(
        expected["perturbedVector"]
    )

    base_top = batch._top_n_codes_ordered(base_result)
    perturbed_top = batch._top_n_codes_ordered(perturbed_result)
    assert base_top == expected["p14"]["baseTop40"]
    assert perturbed_top == expected["p14"]["perturbedTop40"]

    jaccard, computed_perturbed = batch.compute_rank_stability(
        permuted, snapshot["context"], base_result
    )
    assert computed_perturbed == perturbed_result
    assert jaccard == expected["p14"]["jaccard"]
    exited = [code for code in base_top if code not in set(perturbed_top)]
    entered = [code for code in perturbed_top if code not in set(base_top)]
    assert set(exited) == set(expected["p14"]["exited"])
    assert set(entered) == set(expected["p14"]["entered"])
    assert sorted(exited) == expected["p14"]["exited"]
    assert sorted(entered) == expected["p14"]["entered"]
    verdict = "PASS" if jaccard >= batch.RANK_STABILITY_JACCARD_MIN else "FAIL"
    assert verdict == expected["p14"]["severity"]
    assert expected["assignmentMarker"] == ASSIGNMENT_MARKER
    assert expected["assignmentNote"] == ASSIGNMENT_NOTE


def _assert_five_reruns(snapshot_id: str) -> None:
    snapshot = _snapshot(snapshot_id)
    serialized_runs = []
    for _ in range(5):
        candidates = copy.deepcopy(snapshot["candidates"])
        base_result = batch.build_candidate_funnel(candidates, snapshot["context"])
        perturbed_result = batch.build_candidate_funnel(
            batch._perturb_candidates(candidates), snapshot["context"]
        )
        payload = {
            "baseVector": _engine_vector(base_result),
            "perturbedVector": _engine_vector(perturbed_result),
            "baseTop40": batch._top_n_codes_ordered(base_result),
            "perturbedTop40": batch._top_n_codes_ordered(perturbed_result),
        }
        serialized_runs.append(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        )
    assert len(set(serialized_runs)) == 1
    assert _vector_by_code(json.loads(serialized_runs[0])["baseVector"]) == _vector_by_code(
        snapshot["expected"]["baseVector"]
    )
    assert _vector_by_code(
        json.loads(serialized_runs[0])["perturbedVector"]
    ) == _vector_by_code(snapshot["expected"]["perturbedVector"])


def test_o1_current_original_order_invariant():
    _assert_snapshot_permutation(CURRENT_ID, "original-order")


def test_o1_current_reverse_order_invariant():
    _assert_snapshot_permutation(CURRENT_ID, "reverse-order")


def test_o1_current_code_ascending_invariant():
    _assert_snapshot_permutation(CURRENT_ID, "code-ascending")


def test_o1_current_code_descending_invariant():
    _assert_snapshot_permutation(CURRENT_ID, "code-descending")


def test_o1_current_market_rank_ascending_invariant():
    _assert_snapshot_permutation(CURRENT_ID, "market-rank-ascending")


def test_o1_current_seeded_shuffle_101_invariant():
    _assert_snapshot_permutation(CURRENT_ID, "seeded-shuffle-101")


def test_o1_current_seeded_shuffle_202_invariant():
    _assert_snapshot_permutation(CURRENT_ID, "seeded-shuffle-202")


def test_o1_current_seeded_shuffle_303_invariant():
    _assert_snapshot_permutation(CURRENT_ID, "seeded-shuffle-303")


def test_o1_historical_original_order_invariant():
    _assert_snapshot_permutation(HISTORICAL_ID, "original-order")


def test_o1_historical_reverse_order_invariant():
    _assert_snapshot_permutation(HISTORICAL_ID, "reverse-order")


def test_o1_historical_code_ascending_invariant():
    _assert_snapshot_permutation(HISTORICAL_ID, "code-ascending")


def test_o1_historical_code_descending_invariant():
    _assert_snapshot_permutation(HISTORICAL_ID, "code-descending")


def test_o1_historical_market_rank_ascending_invariant():
    _assert_snapshot_permutation(HISTORICAL_ID, "market-rank-ascending")


def test_o1_historical_seeded_shuffle_101_invariant():
    _assert_snapshot_permutation(HISTORICAL_ID, "seeded-shuffle-101")


def test_o1_historical_seeded_shuffle_202_invariant():
    _assert_snapshot_permutation(HISTORICAL_ID, "seeded-shuffle-202")


def test_o1_historical_seeded_shuffle_303_invariant():
    _assert_snapshot_permutation(HISTORICAL_ID, "seeded-shuffle-303")


def test_o1_real_snapshot_multisets_values_contexts_and_run_ids_are_exact():
    fixture = _fixture()
    assert fixture["schemaVersion"] == "candidate-funnel-order-invariance-real-v1"
    assert fixture["evidenceClass"] == "real_byte_exact_e1"
    assert fixture["sourceEvidenceArchiveSha256"] == (
        "35f55858a9dd243371de9aa4575e3816ebefbdf0526d9500213961ff74be252e"
    )
    assert fixture["privacy"] == {
        "accountData": False,
        "cash": False,
        "executionData": False,
        "holdings": False,
        "portfolioData": False,
        "userIdentity": False,
    }
    expected_sources = {
        CURRENT_ID: (
            "196c7ebfdd3ef9833f862301658bb978f514f08d1ad819db2eea36861f948c31",
            "p5-b005-c-p14-e1-current-dev-20260726",
        ),
        HISTORICAL_ID: (
            "05d291fbe765732633604d603fb155fcc8f382285bb9dac38f589710baf4818e",
            "p5-b005-c-p14-e1-historical-20260714",
        ),
    }
    assert len(fixture["snapshots"]) == 2
    for snapshot in fixture["snapshots"]:
        snapshot_id = snapshot["snapshotIdentity"]["snapshotId"]
        joined_sha, run_token = expected_sources[snapshot_id]
        assert snapshot["sourceHashes"]["joinedCandidates"] == joined_sha
        assert snapshot["snapshotIdentity"]["distinctInputSha256"] == joined_sha
        assert snapshot["runIdentity"]["runToken"] == run_token
        assert snapshot["configuration"]["context"] == snapshot["context"]
        assert snapshot["configuration"]["productionThreshold"] == 0.95
        assert snapshot["configuration"]["productionTopK"] == 40
        assert snapshot["configuration"]["productionPerturbationPct"] == 0.02
        assert snapshot["synthetic"] is False
        assert len(snapshot["candidates"]) == 200
        assert len({candidate["code"] for candidate in snapshot["candidates"]}) == 200


def test_o1_current_five_deterministic_reruns_are_byte_exact():
    _assert_five_reruns(CURRENT_ID)


def test_o1_historical_five_deterministic_reruns_are_byte_exact():
    _assert_five_reruns(HISTORICAL_ID)


def test_o1_real_snapshot_expected_scores_verdicts_and_swap_vectors():
    expected = {
        CURRENT_ID: {
            "jaccard": 0.9512195121951219,
            "severity": "PASS",
            "exited": ["5444"],
            "entered": ["9107"],
        },
        HISTORICAL_ID: {
            "jaccard": 0.8604651162790697,
            "severity": "FAIL",
            "exited": ["4722", "4768", "8613"],
            "entered": ["4732", "8253", "9001"],
        },
    }
    for snapshot_id, expected_result in expected.items():
        snapshot = _snapshot(snapshot_id)
        assert {
            key: snapshot["expected"]["p14"][key]
            for key in ("jaccard", "severity", "exited", "entered")
        } == expected_result
        assert len(snapshot["expected"]["baseVector"]) == 200
        assert len(snapshot["expected"]["perturbedVector"]) == 200
        assert len(snapshot["expected"]["assignmentVector"]) == 200
        _assert_snapshot_permutation(snapshot_id, "original-order")
