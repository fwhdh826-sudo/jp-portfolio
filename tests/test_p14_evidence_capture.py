"""Frozen P14-E2 capture tests T-01..T-12 (one test per frozen ID), plus
P14-P3C-R1A test-authority hardening tests.

P14-P3C: the valid baseline authority is the deterministic same-run NORMAL
fixture (tests/fixtures/p14_same_run_normal_v1.json), not the mutable
committed data/candidates_stocks.json production artifact. See
_load_same_run_fixture / P14_P3C_FIXTURE_PATH below.

P14-P3C-R1A: the ordinary valid baseline also no longer reads the mutable
committed public/data/regime_state.json (see _load_synthetic_regime) and no
longer depends on real datetime.now() (see _frozen_datetime / FRESH_ASOF).
The one test allowed to read current committed production artifacts is
test_current_production_artifacts_follow_fail_closed_contract in
tests/test_p14_evidence_validate.py -- it is isolated from every helper in
this file.
"""
from __future__ import annotations

import copy
import hashlib
import json
import subprocess
from datetime import datetime
from pathlib import Path

import pytest

from data import candidate_funnel_batch as batch
from data import p14_evidence_capture as capture

REPO = Path(__file__).parents[1]
P14_P3C_FIXTURE_PATH = REPO / "tests/fixtures/p14_same_run_normal_v1.json"

# P14-P3C-R1A deterministic clock authority. sourceUpdatedAt in the fixture
# is 2026-07-29T23:30:00+09:00 (== 2026-07-29T14:30:00Z); staleThresholdHours
# is 48. FRESH_ASOF / FRESH_ASOF_ALT are two different real instants that
# both represent the SAME intended freshness (well inside the 48h window);
# STALE_ASOF is deliberately beyond it. None of these is the actual current
# wall-clock time -- the same fixture stays valid indefinitely.
FRESH_ASOF = "2026-07-30T00:30:00+00:00"
FRESH_ASOF_ALT = "2026-07-30T05:00:00+00:00"
STALE_ASOF = "2026-08-01T00:00:00+00:00"


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _load_same_run_fixture() -> dict:
    """Load the deterministic P14-P3C same-run NORMAL fixture (deep copy;
    callers mutate freely without contaminating other tests)."""
    fixture = json.loads(P14_P3C_FIXTURE_PATH.read_text(encoding="utf-8"))
    return copy.deepcopy(fixture["candidatesStocks"])


def _load_synthetic_regime() -> dict:
    """Load the deterministic P14-P3C-R1A synthetic regime_state.json shape
    (deep copy). This is the sole regime authority for the ordinary valid
    baseline -- it must never be the mutable committed
    public/data/regime_state.json (P2-A)."""
    fixture = json.loads(P14_P3C_FIXTURE_PATH.read_text(encoding="utf-8"))
    return copy.deepcopy(fixture["regimeState"])


def _frozen_datetime(as_of: str) -> type[datetime]:
    """Return a datetime subclass whose now() always returns the fixed
    instant `as_of` (ISO8601, offset-aware), for monkeypatching
    capture.datetime. Every other datetime behavior (fromisoformat,
    isoformat, arithmetic, astimezone) is inherited unchanged from the real
    class -- only now() is overridden, so build_bundle's asOf/createdAt stop
    depending on the real wall clock (P2-B)."""
    fixed = datetime.fromisoformat(as_of)

    class _Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed.astimezone(tz) if tz is not None else fixed

    return _Frozen


def _same_observation_prescreen_entries(candidates: dict) -> list[dict]:
    """Build deterministic prescreen metadata for this candidate observation.

    Same-run authority: the fixture's candidates ARE the prescreen authority
    for this observation, not a retained/older funnel (Architecture B).
    """
    rows = sorted(candidates["candidates"], key=lambda row: row["code"])
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


def _write_sources(tmp_path: Path) -> tuple[Path, Path, Path]:
    candidates = _load_same_run_fixture()
    candidates["_meta"]["runToken"] = "7f1a076e-2a44-4d92-968d-f9c69c1f83b1"
    entries = _same_observation_prescreen_entries(candidates)
    prescreen = {
        "schemaVersion": "prescreen-metadata-1",
        "generatedAt": candidates["updatedAt"],
        "not_for_trading": True,
        "shortlistId": candidates["_meta"]["universeProvenance"]["shortlistId"],
        "pipelinePath": candidates["_meta"]["pipelinePath"],
        "duplicateCodes": [],
        "entries": entries,
    }
    candidates_path = tmp_path / "source/candidates_stocks.json"
    prescreen_path = tmp_path / "source/prescreen_metadata.json"
    regime_path = tmp_path / "source/regime_state.json"
    candidates_path.parent.mkdir(parents=True)
    candidates_path.write_text(
        json.dumps(candidates, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    prescreen_path.write_text(json.dumps(prescreen, ensure_ascii=False, indent=2) + "\n")
    # P14-P3C-R1A: synthetic regime authority, not the mutable committed
    # public/data/regime_state.json (P2-A).
    regime_path.write_text(
        json.dumps(_load_synthetic_regime(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return candidates_path, prescreen_path, regime_path


def _identity() -> dict[str, str]:
    git_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    return {
        "runId": "9001",
        "runAttempt": "1",
        "runToken": "7f1a076e-2a44-4d92-968d-f9c69c1f83b1",
        "workflow": capture.WORKFLOW,
        "event": "workflow_dispatch",
        "startedAt": "2026-07-30T00:00:00Z",
        "runnerOs": "Linux",
        "runnerArch": "X64",
        "timezone": "UTC",
        "locale": "C.UTF-8",
        "pythonVersion": "3.11.15",
        "pythonHashSeed": "0",
        "gitRef": "refs/heads/v13.3-dev",
        "gitRefType": "branch",
        "gitSha": git_sha,
    }


def _test_environment(_identity: dict[str, str]) -> dict[str, object]:
    return {
        "capturedAt": "2026-07-30T00:00:01+00:00",
        "runnerOs": "Linux",
        "runnerArch": "X64",
        "pythonVersion": "3.11.15",
        "pipFreeze": ["pytest==test"],
        "locale": "C.UTF-8",
        "timezone": "UTC",
        "pythonHashSeed": "0",
        "variableNames": [{"name": "GITHUB_RUN_ID", "present": True}],
        "redactedVariableNames": [],
    }


@pytest.fixture(scope="module")
def evidence_bundle(tmp_path_factory: pytest.TempPathFactory):
    tmp = tmp_path_factory.mktemp("p14-capture")
    sources = _write_sources(tmp)
    patch = pytest.MonkeyPatch()
    patch.setattr(capture, "_environment", _test_environment)
    # P14-P3C-R1A: fixed deterministic clock (P2-B) -- the ordinary valid
    # baseline no longer depends on the real wall clock.
    patch.setattr(capture, "datetime", _frozen_datetime(FRESH_ASOF))
    bundle = capture.build_bundle(
        out_parent=tmp / "out",
        repo_root=REPO,
        run_identity=_identity(),
        candidates_path=sources[0],
        prescreen_path=sources[1],
        regime_path=sources[2],
        # P14-P3C: ordinary baseline tests carry no retained-previous-funnel
        # authority (P-15 is a RECORD gate, not fail-closed) -- the mutable
        # committed data/candidate_funnel.json must not be a hidden baseline.
        previous_path=None,
    )
    patch.undo()
    return bundle, sources


def test_manifest_covers_every_bundle_file_exactly_once(evidence_bundle):
    """T-01."""
    bundle, _ = evidence_bundle
    manifest = json.loads((bundle / "manifest.json").read_text())
    listed = [item["path"] for item in manifest["files"]]
    actual = sorted(
        path.relative_to(bundle).as_posix()
        for path in bundle.rglob("*")
        if path.is_file() and path.name not in {"manifest.json", "manifest.sha256"}
    )
    assert len(listed) == len(set(listed))
    assert sorted(listed) == actual
    assert manifest["frozenTests"] == [
        {"id": test_id, "function": function}
        for test_id, function in capture.FROZEN_TEST_MAPPING
    ]
    assert len({row["id"] for row in manifest["frozenTests"]}) == 34


def test_manifest_hashes_match_recomputed_bytes(evidence_bundle):
    """T-02."""
    bundle, _ = evidence_bundle
    manifest = json.loads((bundle / "manifest.json").read_text())
    for item in manifest["files"]:
        path = bundle / item["path"]
        assert _sha(path) == item["sha256"]
        assert path.stat().st_size == item["bytes"]
    assert (bundle / "manifest.sha256").read_text().split()[0] == _sha(
        bundle / "manifest.json"
    )


def test_inputs_are_byte_identical_to_source_files(evidence_bundle):
    """T-03."""
    bundle, sources = evidence_bundle
    snapshot = next((bundle / "snapshots").glob("real-*"))
    for source, name in zip(
        sources, ("candidates_stocks.json", "prescreen_metadata.json", "regime_state.json")
    ):
        assert (snapshot / "inputs/data" / name).read_bytes() == source.read_bytes()


def test_generator_sha256_matches_checked_out_blobs(evidence_bundle):
    """T-04."""
    bundle, _ = evidence_bundle
    manifest = json.loads((bundle / "manifest.json").read_text())
    for relative in capture.GENERATOR_PATHS:
        blob = subprocess.check_output(
            ["git", "show", f"{manifest['gitSha']}:{relative}"], cwd=REPO
        )
        assert hashlib.sha256(blob).hexdigest() == manifest["generatorSha256"][relative]


def test_run_identity_records_run_id_attempt_and_token(evidence_bundle):
    """T-05."""
    bundle, _ = evidence_bundle
    manifest = json.loads((bundle / "manifest.json").read_text())
    assert manifest["runIdentity"]["runId"] == "9001"
    assert manifest["runIdentity"]["runAttempt"] == "1"
    assert manifest["runIdentity"]["runToken"] == _identity()["runToken"]


def test_five_reruns_are_hash_identical(evidence_bundle):
    """T-06."""
    bundle, _ = evidence_bundle
    snapshot = next((bundle / "snapshots").glob("real-*"))
    reruns = json.loads((snapshot / "reruns/five-reruns.json").read_text())
    assert len(reruns) == 5
    assert len(
        {
            (
                row["assignmentMapSha256"],
                row["baseRankSha256"],
                row["perturbedRankSha256"],
                row["metricsSha256"],
                row["verdict"],
            )
            for row in reruns
        }
    ) == 1


def test_full_rank_vector_length_equals_population(evidence_bundle):
    """T-07."""
    bundle, _ = evidence_bundle
    manifest = json.loads((bundle / "manifest.json").read_text())
    snapshot = next((bundle / "snapshots").glob("real-*"))
    for index in range(1, 6):
        vector = json.loads(
            (snapshot / f"ranks/run-{index}-full-rank-vector.json").read_text()
        )
        assert len(vector) == manifest["population"]


def test_eight_frozen_permutation_cases_present_with_verdicts(evidence_bundle):
    """T-08."""
    bundle, _ = evidence_bundle
    snapshot = next((bundle / "snapshots").glob("real-*"))
    rows = json.loads((snapshot / "metrics/input-order-permutations.json").read_text())
    assert {row["case"] for row in rows} == set(capture.PERMUTATION_CASES)
    assert all(row["verdict"] in {"PASS", "FAIL"} for row in rows)
    assert all(not row["assignmentMismatch"] for row in rows)
    assert all(type(row["unperturbedScoreChangedCount"]) is int
               and type(row["unperturbedRankChangedCount"]) is int
               and row["unperturbedScoreChangedCount"] == 0
               and row["unperturbedRankChangedCount"] == 0 for row in rows)
    for row in rows:
        stored = json.loads((snapshot / "permutations" / row["case"]
                             / "production-p14.json").read_text())
        assert stored["unperturbedScoreChangedCount"] == row["unperturbedScoreChangedCount"]
        assert stored["unperturbedRankChangedCount"] == row["unperturbedRankChangedCount"]


def test_quality_report_saved_even_when_overall_pass_false(tmp_path, monkeypatch):
    """T-09."""
    sources = _write_sources(tmp_path)
    original = batch.compute_quality_report

    def forced_fail(**kwargs):
        report = original(**kwargs)
        report["overallPass"] = False
        report["hardFailIds"] = ["P-14"]
        return report

    monkeypatch.setattr(batch, "compute_quality_report", forced_fail)
    monkeypatch.setattr(capture, "_environment", _test_environment)
    monkeypatch.setattr(capture, "datetime", _frozen_datetime(FRESH_ASOF))
    bundle = capture.build_bundle(
        out_parent=tmp_path / "out",
        repo_root=REPO,
        run_identity=_identity(),
        candidates_path=sources[0],
        prescreen_path=sources[1],
        regime_path=sources[2],
        previous_path=None,
    )
    snapshot = next((bundle / "snapshots").glob("real-*"))
    report = json.loads((snapshot / "outputs/quality-report.json").read_text())
    assert report["qualityGate"]["overallPass"] is False
    assert report["qualityGate"]["hardFailIds"] == ["P-14"]


def test_p14_parameters_read_from_module_constants_not_literals(evidence_bundle):
    """T-10."""
    bundle, _ = evidence_bundle
    manifest = json.loads((bundle / "manifest.json").read_text())
    assert manifest["p14Parameters"] == {
        "threshold": batch.RANK_STABILITY_JACCARD_MIN,
        "topK": batch.TOP_N_STABILITY,
        "perturbationPct": batch.PERTURBATION_PCT,
    }
    assert manifest["assignmentContract"] == batch.P14_ASSIGNMENT_CONTRACT


def test_environment_json_records_timezone_utc_and_hashseed_zero(evidence_bundle):
    """T-11."""
    bundle, _ = evidence_bundle
    environment = json.loads((bundle / "environment.json").read_text())
    assert environment["timezone"] == "UTC"
    assert environment["pythonHashSeed"] == "0"


def test_capture_never_writes_inside_repository_worktree(tmp_path):
    """T-12."""
    sources = _write_sources(tmp_path)
    before = subprocess.check_output(
        ["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd=REPO, text=True
    )
    with pytest.raises(capture.CaptureError, match="outside repository"):
        capture.build_bundle(
            out_parent=REPO / "p14-evidence-forbidden",
            repo_root=REPO,
            run_identity=_identity(),
            candidates_path=sources[0],
            prescreen_path=sources[1],
            regime_path=sources[2],
            previous_path=None,
        )
    after = subprocess.check_output(
        ["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd=REPO, text=True
    )
    assert after == before


# ---------------------------------------------------------------------------
# P14-P3C-R1A: clock independence + freshness contract (P2-B).
#
# build_candidate_funnel is a pure function of (candidates, context); context
# carries the caller-supplied asOf. These tests fix asOf via
# _frozen_datetime instead of letting build_bundle read the real wall clock,
# so the same fixture stays valid regardless of when the suite actually runs.
# ---------------------------------------------------------------------------


def _build_at(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, label: str, as_of: str) -> dict:
    """Build one evidence bundle under its own tmp subdir with a fixed clock
    at `as_of`, and return the run-1 base-engine.json result."""
    root = tmp_path / label
    sources = _write_sources(root)
    monkeypatch.setattr(capture, "_environment", _test_environment)
    monkeypatch.setattr(capture, "datetime", _frozen_datetime(as_of))
    bundle = capture.build_bundle(
        out_parent=root / "out",
        repo_root=REPO,
        run_identity=_identity(),
        candidates_path=sources[0],
        prescreen_path=sources[1],
        regime_path=sources[2],
        previous_path=None,
    )
    snapshot = next((bundle / "snapshots").glob("real-*"))
    return json.loads((snapshot / "outputs/run-1/base-engine.json").read_text())


def _risk_reasons_by_code(base_result: dict) -> dict[str, list[str]]:
    return {
        row["code"]: row["riskReasons"]
        for row in base_result["candidates"]
        if isinstance(row, dict) and row.get("tier") != "excluded"
    }


def test_fresh_synthetic_baseline_has_no_soft_stale_source_and_one_actionable_candidate(
    tmp_path, monkeypatch
):
    """P14-P3C-R1A §7A: the deterministic fresh observation must never carry
    SOFT_STALE_SOURCE -- staleness here is fixture-controlled, not derived
    from the real wall clock."""
    base = _build_at(tmp_path, monkeypatch, "fresh", FRESH_ASOF)
    assert base["counts"]["actionable"] == 1
    reasons = _risk_reasons_by_code(base)
    assert all("SOFT_STALE_SOURCE" not in r for r in reasons.values())


def test_synthetic_stale_observation_activates_soft_stale_source_per_48h_contract(
    tmp_path, monkeypatch
):
    """P14-P3C-R1A §7B: an explicitly synthetic stale asOf (beyond the
    existing 48h staleThresholdHours contract) must activate
    SOFT_STALE_SOURCE and the frozen actionable-eligibility gate
    (`not is_stale`, A2-S §25.8) -- exercised only here, never in the
    ordinary fresh baseline above."""
    base = _build_at(tmp_path, monkeypatch, "stale", STALE_ASOF)
    assert base["counts"]["actionable"] == 0
    reasons = _risk_reasons_by_code(base)
    assert reasons  # sanity: population is non-empty
    assert all("SOFT_STALE_SOURCE" in r for r in reasons.values())


def test_time_travel_equivalent_fresh_asof_values_produce_identical_engine_result(
    tmp_path, monkeypatch
):
    """P14-P3C-R1A §8/§22: two different real instants that both represent
    the SAME intended freshness (well inside the 48h window) must produce a
    byte-identical engine result -- proving the baseline's semantics do not
    depend on which actual wall-clock moment the suite happens to run at.
    A third, deliberately stale asOf must differ (proving the difference is
    caused by staleness alone, not by non-determinism elsewhere)."""
    fresh_a = _build_at(tmp_path, monkeypatch, "fresh-a", FRESH_ASOF)
    fresh_b = _build_at(tmp_path, monkeypatch, "fresh-b", FRESH_ASOF_ALT)
    stale = _build_at(tmp_path, monkeypatch, "stale-c", STALE_ASOF)

    assert fresh_a["candidates"] == fresh_b["candidates"]
    assert fresh_a["counts"] == fresh_b["counts"]
    assert fresh_a["sectorDistribution"] == fresh_b["sectorDistribution"]

    assert fresh_a["counts"] != stale["counts"]
    assert fresh_a["candidates"] != stale["candidates"]
