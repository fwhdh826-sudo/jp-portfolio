"""P14-AC19 rank-vector identity integrity: focused, isolated test authority.

P14-AC19-IDENTITY-INTEGRITY-REPAIR: this branch is intentionally rooted on
P14-P3B (data/p14_evidence_validate.py + data/p14_legacy_replay.py hash-pinned
current-tooling authority only) and does NOT include P14-P3C/R1A. That means
tests/fixtures/p14_same_run_normal_v1.json does not exist here and the
existing tests/test_p14_evidence_validate.py::valid_bundle fixture -- which
still derives its baseline from the mutable committed data/candidates_stocks.json
-- cannot provide a clean deterministic AC-19 baseline on this lineage (that
production artifact currently carries pipelinePath=seed_fallback, which makes
candidate_funnel_engine skip generation entirely and yields a zero-length rank
vector unrelated to AC-19 logic).

This file therefore builds its own small, self-authored, deterministic
same-run NORMAL candidate population directly (not copied from any P3-C
fixture, not read from any production JSON) and exercises the REAL
data.p14_evidence_validate AC-19 implementation through the real
data.p14_evidence_capture.build_bundle -> data.p14_evidence_validate.validate_bundle
pipeline. No validator logic is duplicated here -- every assertion below reads
checks["AC-19"]["passed"] (report["criteria"]) from the genuine validator
output.

Frozen AC-19 intent under test (see P14-AC19-IDENTITY-INTEGRITY-REPAIR goal):
for the joined candidate population J and every one of the five full rank
vectors V (ranks/run-1..5-full-rank-vector.json):
  1. len(V) == len(J)
  2. every V/J identity ("code") is well-formed (non-null string, non-empty)
  3. identities within V are unique; identities within J are unique
  4. set(ids(V)) == set(ids(J)) exactly (order-independent)
"""
from __future__ import annotations

import copy
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from data import p14_evidence_capture as capture
from data import p14_evidence_validate as validator

REPO = Path(__file__).parents[1]

# Deliberately small and self-authored: only the AC-19 population-integrity
# rule is under test here, not sector-cap/actionable-selection behaviour
# (which operates on a subset of this same full rank vector and is untouched
# by this repair).
POPULATION = 14
_SECTORS = ("情報・通信業", "電気機器", "化学", "銀行業", "小売業", "医薬品", "輸送用機器")


def _synthetic_candidates_payload() -> dict[str, Any]:
    """One coherent, self-authored same-run NORMAL candidates_stocks.json shape.

    Strictly monotonic per/roe values guarantee a tie-free ranking, which
    keeps every adversarial identity mutation below attributable purely to
    AC-19 and not to incidental rank-order ambiguity.
    """
    candidates = [
        {
            "code": f"AC19-{index:03d}",
            "name": f"AC19 Identity Fixture {index:03d}",
            "sector": _SECTORS[index % len(_SECTORS)],
            "price": 1000.0 + index * 15.0,
            "per": 5.0 + index * 0.75,
            "pbr": 0.5 + index * 0.05,
            "roe": 18.0 - index * 0.6,
            "dividendYield": 1.0,
            "sigma252d": 0.2,
            "mom3m": 0.0,
            "screenReasons": ["AC19フィクスチャ"],
            "dataStatus": "ok",
        }
        for index in range(POPULATION)
    ]
    return {
        "schemaVersion": "candidates-stocks-1",
        "updatedAt": "2026-08-01T00:00:00+09:00",
        "sourceUpdatedAt": "2026-07-31T23:30:00+09:00",
        "staleThresholdHours": 48,
        "status": "ok",
        "_meta": {
            "kind": "candidates_stocks",
            "source": "tests/test_p14_ac19_identity_integrity.py (synthetic, self-authored)",
            "not_for_trading": True,
            "universe": "p14_ac19_identity_fixture_v1",
            "note": "AC-19 identity-integrity focused fixture. Market-public-shape synthetic values only; no personal asset/holding/account data.",
            "counts": {
                "universeCount": POPULATION,
                "publishedCount": POPULATION,
                "truncatedCount": 0,
                "failedTotalCount": 0,
            },
            "runToken": "00000000-0000-4000-8000-0000000000ac",
            "universeProvenance": {
                "pipelinePath": "normal",
                "jpxSource": "tests/test_p14_ac19_identity_integrity.py::SYNTHETIC",
                "jpxFallbackUsed": False,
                "jpxEligibleCount": POPULATION,
                "shortlistId": "p14_ac19_identity_fixture_shortlist_v1",
                "shortlistCount": POPULATION,
                "shortlistSuccessRatio": 1.0,
                "shortlistFallbackUsed": False,
                "shortlistBypassSeedListV1": False,
                "sectorCapRelaxed": False,
                "sectorCapRelaxedCount": 0,
            },
            "pipelineContract": "jpx_whole_market_candidates_v1",
            "pipelinePath": "normal",
        },
        "candidates": candidates,
    }


def _prescreen_entries(candidates_payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = sorted(candidates_payload["candidates"], key=lambda row: row["code"])
    population = len(rows)
    return [
        {
            "code": row["code"],
            "prescreenScore": (population - rank + 1) / population,
            "prescreenRank": rank,
            "prescreenPool": "main",
        }
        for rank, row in enumerate(rows, start=1)
    ]


def _write_sources(tmp: Path, candidates_payload: dict[str, Any]) -> tuple[Path, Path, Path]:
    prescreen = {
        "schemaVersion": "prescreen-metadata-1",
        "generatedAt": candidates_payload["updatedAt"],
        "not_for_trading": True,
        "shortlistId": candidates_payload["_meta"]["universeProvenance"]["shortlistId"],
        "pipelinePath": "normal",
        "duplicateCodes": [],
        "entries": _prescreen_entries(candidates_payload),
    }
    root = tmp / "sources"
    root.mkdir()
    cp, pp, rp = (
        root / "candidates_stocks.json",
        root / "prescreen_metadata.json",
        root / "regime_state.json",
    )
    cp.write_text(json.dumps(candidates_payload, ensure_ascii=False, indent=2) + "\n")
    pp.write_text(json.dumps(prescreen, ensure_ascii=False, indent=2) + "\n")
    # public/data/regime_state.json is a non-personal, public market-regime
    # indicator unrelated to candidate identity; reused byte-for-byte exactly
    # as tests/test_p14_evidence_validate.py already did before P14-P3C.
    rp.write_bytes((REPO / "public/data/regime_state.json").read_bytes())
    return cp, pp, rp


def _run_identity() -> dict[str, str]:
    return {
        "runId": "9200",
        "runAttempt": "1",
        "runToken": "00000000-0000-4000-8000-0000000000ac",
        "workflow": capture.WORKFLOW,
        "event": "workflow_dispatch",
        "startedAt": "2026-08-01T00:00:00Z",
        "runnerOs": "Linux",
        "runnerArch": "X64",
        "timezone": "UTC",
        "locale": "C.UTF-8",
        "pythonVersion": "3.11.15",
        "pythonHashSeed": "0",
        "gitRef": "refs/heads/v13.3-dev",
        "gitRefType": "branch",
        "gitSha": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=REPO, text=True
        ).strip(),
    }


def _environment(_identity: dict[str, str]) -> dict[str, object]:
    return {
        "capturedAt": "2026-08-01T00:00:01+00:00",
        "runnerOs": "Linux",
        "runnerArch": "X64",
        "pythonVersion": "3.11.15",
        "pipFreeze": ["pytest==test"],
        "locale": "C.UTF-8",
        "timezone": "UTC",
        "pythonHashSeed": "0",
        "variableNames": [],
        "redactedVariableNames": [],
    }


@pytest.fixture(scope="module")
def ac19_bundle(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """One real, self-authored, deterministic same-run NORMAL bundle built
    through the genuine data.p14_evidence_capture.build_bundle pipeline."""
    tmp = tmp_path_factory.mktemp("p14-ac19")
    cp, pp, rp = _write_sources(tmp, _synthetic_candidates_payload())
    patch = pytest.MonkeyPatch()
    patch.setattr(capture, "_environment", _environment)
    try:
        bundle = capture.build_bundle(
            out_parent=tmp / "out",
            repo_root=REPO,
            run_identity=_run_identity(),
            candidates_path=cp,
            prescreen_path=pp,
            regime_path=rp,
            previous_path=None,
        )
    finally:
        patch.undo()
    return bundle


def _copy(bundle: Path, tmp_path: Path) -> Path:
    target = tmp_path / bundle.name
    shutil.copytree(bundle, target)
    return target


def _snapshot_dir(bundle_root: Path) -> Path:
    snapshots = sorted((bundle_root / "snapshots").glob("real-*"))
    assert len(snapshots) == 1, snapshots
    return snapshots[0]


def _joined_ids(bundle_root: Path) -> list[str]:
    joined = json.loads(
        (_snapshot_dir(bundle_root) / "inputs/joined_candidates.json").read_text()
    )["candidates"]
    return [row["code"] for row in joined]


def _vector_path(bundle_root: Path, number: int) -> Path:
    return _snapshot_dir(bundle_root) / "ranks" / f"run-{number}-full-rank-vector.json"


def _read_vector(bundle_root: Path, number: int) -> list[dict[str, Any]]:
    return json.loads(_vector_path(bundle_root, number).read_text())


def _write_vector(bundle_root: Path, number: int, vector: list[dict[str, Any]]) -> None:
    _vector_path(bundle_root, number).write_text(
        json.dumps(vector, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def _write_joined(bundle_root: Path, joined_candidates: list[dict[str, Any]]) -> None:
    path = _snapshot_dir(bundle_root) / "inputs/joined_candidates.json"
    payload = json.loads(path.read_text())
    payload["candidates"] = joined_candidates
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _validate(bundle_root: Path) -> dict[str, Any]:
    return validator.validate_bundle(bundle_root, repo_root=REPO, ci=True)


def _ac19_passed(report: dict[str, Any]) -> bool:
    matches = [row for row in report["criteria"] if row["id"] == "AC-19"]
    assert len(matches) == 1, report["criteria"]
    return matches[0]["passed"] is True


def _ac19_failed(report: dict[str, Any]) -> bool:
    return not _ac19_passed(report)


# ---------------------------------------------------------------------------
# Root-cause A/B proof: reproduce the exact previously-missed defect against
# the unmodified P14-P3B baseline logic, then prove the repair rejects it.
# ---------------------------------------------------------------------------


def test_baseline_length_only_predicate_missed_the_defect():
    """P14_AC19_ROOT_CAUSE_AB_PROOF (A/BASE half).

    Reproduces the confirmed production defect in isolation, against the
    exact unmodified BASE predicate (length-only), independent of any bundle
    plumbing: population length unchanged, one duplicated identity, one
    legitimate identity silently omitted -- the base predicate still reports
    population integrity intact.
    """
    joined_ids = [f"AC19-{i:03d}" for i in range(POPULATION)]
    joined = [{"code": code} for code in joined_ids]
    mutated_vector_ids = list(joined_ids)
    mutated_vector_ids[-1] = mutated_vector_ids[0]  # duplicate first id, drop last id
    mutated_vector = [{"code": code} for code in mutated_vector_ids]

    def base_length_only_predicate(vector: Any, population: Any) -> bool:
        return isinstance(vector, list) and len(vector) == population

    assert len(set(mutated_vector_ids)) == len(joined_ids) - 1  # duplicate present
    assert base_length_only_predicate(mutated_vector, len(joined))  # BASE: still "passes"
    assert not validator._rank_vector_population_ok(
        mutated_vector, validator._canonical_identity_set(joined), len(joined)
    )  # TARGET: repaired predicate rejects it


def test_valid_reorder_remains_accepted_by_repaired_predicate():
    """P14_AC19_ROOT_CAUSE_AB_PROOF (A/BASE half, case G control).

    The same repaired predicate used above must still accept an exact-set
    population in a different (but still valid) rank order.
    """
    joined_ids = [f"AC19-{i:03d}" for i in range(POPULATION)]
    joined = [{"code": code} for code in joined_ids]
    reordered_vector = [{"code": code} for code in reversed(joined_ids)]
    assert validator._rank_vector_population_ok(
        reordered_vector, validator._canonical_identity_set(joined), len(joined)
    )


# ---------------------------------------------------------------------------
# Full-bundle adversarial matrix against the REAL validate_bundle AC-19 gate.
# ---------------------------------------------------------------------------


def test_valid_exact_set_different_order_per_vector_passes(ac19_bundle, tmp_path):
    """Section 14/10-G: all five vectors carry the exact same joined identity
    set, each in a different (but internally valid) rank order -- AC-19 must
    still pass. Proves the implementation does not require identical order."""
    root = _copy(ac19_bundle, tmp_path)
    joined_ids = _joined_ids(root)
    assert len(set(joined_ids)) == len(joined_ids) == POPULATION
    for number in range(1, 6):
        vector = _read_vector(root, number)
        assert {row["code"] for row in vector} == set(joined_ids)
        rotated = joined_ids[number:] + joined_ids[:number]
        assert rotated != joined_ids  # a genuinely different order per vector
        reordered_vector = [
            {**row, "code": code}
            for row, code in zip(vector, rotated)
        ]
        _write_vector(root, number, reordered_vector)
    report = _validate(root)
    assert _ac19_passed(report), report["criteria"]


@pytest.mark.parametrize("number", range(1, 6))
def test_same_length_duplicate_rejected_for_every_vector(ac19_bundle, tmp_path, number):
    """Section 15/20: replace one identity with a duplicate of another,
    keeping vector length exactly N -- AC-19 must fail, for each of the five
    vectors individually (AC19_SAME_LENGTH_DUPLICATE_REJECTED,
    AC19_ALL_FIVE_VECTORS_ENFORCED)."""
    root = _copy(ac19_bundle, tmp_path)
    vector = _read_vector(root, number)
    mutated = copy.deepcopy(vector)
    mutated[-1]["code"] = mutated[0]["code"]  # duplicate; length unchanged
    _write_vector(root, number, mutated)
    report = _validate(root)
    assert _ac19_failed(report), report["criteria"]


@pytest.mark.parametrize("number", range(1, 6))
def test_same_length_substitution_rejected_for_every_vector(ac19_bundle, tmp_path, number):
    """Section 16/20: remove one legitimate identity and insert one unknown
    identity, keeping length exactly N and all identities within the vector
    unique -- AC-19 must fail (AC19_SAME_LENGTH_SUBSTITUTION_REJECTED,
    AC19_ALL_FIVE_VECTORS_ENFORCED). This separately proves exact set
    equality, not merely uniqueness."""
    root = _copy(ac19_bundle, tmp_path)
    vector = _read_vector(root, number)
    mutated = copy.deepcopy(vector)
    mutated[-1]["code"] = "AC19-UNKNOWN-CANDIDATE"
    assert len({row["code"] for row in mutated}) == len(mutated)  # still unique
    _write_vector(root, number, mutated)
    report = _validate(root)
    assert _ac19_failed(report), report["criteria"]


def test_missing_candidate_vector_rejected(ac19_bundle, tmp_path):
    """Section 17: an N-1 vector (one legitimate candidate dropped, no
    replacement) must fail AC-19."""
    root = _copy(ac19_bundle, tmp_path)
    vector = _read_vector(root, 1)
    _write_vector(root, 1, vector[:-1])
    report = _validate(root)
    assert _ac19_failed(report), report["criteria"]


def test_extra_candidate_vector_rejected(ac19_bundle, tmp_path):
    """Section 17: an N+1 vector (one extra unknown candidate appended) must
    fail AC-19."""
    root = _copy(ac19_bundle, tmp_path)
    vector = _read_vector(root, 1)
    extra = copy.deepcopy(vector[0])
    extra["code"] = "AC19-EXTRA-CANDIDATE"
    _write_vector(root, 1, vector + [extra])
    report = _validate(root)
    assert _ac19_failed(report), report["criteria"]


def test_joined_population_duplicate_identity_rejected(ac19_bundle, tmp_path):
    """Section 9/18: the joined candidate population itself must not
    silently contain a duplicate canonical identity -- AC-19 must fail even
    though every individual vector is untouched and internally consistent
    with the (now duplicate-bearing) joined population's raw identity list."""
    root = _copy(ac19_bundle, tmp_path)
    joined_path = _snapshot_dir(root) / "inputs/joined_candidates.json"
    joined_payload = json.loads(joined_path.read_text())
    joined = joined_payload["candidates"]
    mutated_joined = copy.deepcopy(joined)
    mutated_joined[-1] = copy.deepcopy(mutated_joined[0])  # duplicate identity in J
    _write_joined(root, mutated_joined)
    report = _validate(root)
    assert _ac19_failed(report), report["criteria"]


@pytest.mark.parametrize(
    "malformed_code", [None, "", 12345, True], ids=["null", "empty", "non_string", "bool"]
)
def test_malformed_vector_identity_rejected(ac19_bundle, tmp_path, malformed_code):
    """Section 8/19: fail closed on a full-vector row with a missing/null/
    non-string/empty canonical identity."""
    root = _copy(ac19_bundle, tmp_path)
    vector = _read_vector(root, 1)
    mutated = copy.deepcopy(vector)
    mutated[-1]["code"] = malformed_code
    _write_vector(root, 1, mutated)
    report = _validate(root)
    assert _ac19_failed(report), report["criteria"]


def test_missing_vector_identity_key_rejected(ac19_bundle, tmp_path):
    """Section 8/19: a vector row with the `code` key entirely absent must
    fail closed."""
    root = _copy(ac19_bundle, tmp_path)
    vector = _read_vector(root, 1)
    mutated = copy.deepcopy(vector)
    del mutated[-1]["code"]
    _write_vector(root, 1, mutated)
    report = _validate(root)
    assert _ac19_failed(report), report["criteria"]


def test_ac19_canonical_identity_field_is_code():
    """AC19_CANONICAL_IDENTITY_FIELD: the validator's own AC-19 helpers use
    `code` as the canonical identity -- not row index, rank position, name,
    or display label."""
    joined_ids = validator._canonical_identity_set(
        [{"code": "1001", "name": "ignored-for-identity"}]
    )
    assert joined_ids == {"1001"}
    # A row exposing every other candidate field but no `code` fails closed.
    assert validator._canonical_identity_set(
        [{"name": "no-code-field", "rank": 1}]
    ) is None
