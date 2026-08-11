"""Frozen P14-E2 capture tests T-01..T-12 (one test per frozen ID)."""
from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import pytest

from data import candidate_funnel_batch as batch
from data import p14_evidence_capture as capture

REPO = Path(__file__).parents[1]


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _same_observation_prescreen_entries(candidates: dict) -> list[dict]:
    """Build deterministic prescreen metadata for this candidate observation.

    The committed candidate funnel is an older P-15 baseline under Architecture B,
    not the prescreen authority for a later candidate population.
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
    candidates = json.loads((REPO / "data/candidates_stocks.json").read_text())
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
    regime_path.write_bytes((REPO / "public/data/regime_state.json").read_bytes())
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
    bundle = capture.build_bundle(
        out_parent=tmp / "out",
        repo_root=REPO,
        run_identity=_identity(),
        candidates_path=sources[0],
        prescreen_path=sources[1],
        regime_path=sources[2],
        previous_path=REPO / "data/candidate_funnel.json",
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
