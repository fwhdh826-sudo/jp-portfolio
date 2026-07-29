"""Frozen P14-E2 validator tests T-13..T-22."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from data import p14_evidence_capture as capture
from data import p14_evidence_validate as validator

REPO = Path(__file__).parents[1]


def _sources(tmp: Path) -> tuple[Path, Path, Path]:
    candidates = json.loads((REPO / "data/candidates_stocks.json").read_text())
    candidates["_meta"]["runToken"] = "cc139a4e-e3b8-4515-843e-cf5b73612237"
    funnel = json.loads((REPO / "data/candidate_funnel.json").read_text())
    by_code = {row["code"]: row for row in funnel["candidates"]}
    entries = [
        {
            "code": row["code"],
            "prescreenScore": by_code[row["code"]]["prescreenScore"],
            "prescreenRank": by_code[row["code"]]["prescreenRank"],
            "prescreenPool": by_code[row["code"]]["prescreenPool"],
        }
        for row in candidates["candidates"]
    ]
    entries.sort(key=lambda row: (row["prescreenRank"], row["code"]))
    prescreen = {
        "schemaVersion": "prescreen-metadata-1",
        "generatedAt": candidates["updatedAt"],
        "not_for_trading": True,
        "shortlistId": candidates["_meta"]["universeProvenance"]["shortlistId"],
        "pipelinePath": "normal",
        "duplicateCodes": [],
        "entries": entries,
    }
    root = tmp / "sources"
    root.mkdir()
    cp, pp, rp = (
        root / "candidates_stocks.json",
        root / "prescreen_metadata.json",
        root / "regime_state.json",
    )
    cp.write_text(json.dumps(candidates, ensure_ascii=False, indent=2) + "\n")
    pp.write_text(json.dumps(prescreen, ensure_ascii=False, indent=2) + "\n")
    rp.write_bytes((REPO / "public/data/regime_state.json").read_bytes())
    return cp, pp, rp


def _identity() -> dict[str, str]:
    return {
        "runId": "9100",
        "runAttempt": "1",
        "runToken": "cc139a4e-e3b8-4515-843e-cf5b73612237",
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
        "gitSha": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=REPO, text=True
        ).strip(),
    }


def _environment(_identity: dict[str, str]) -> dict[str, object]:
    return {
        "capturedAt": "2026-07-30T00:00:01+00:00",
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
def valid_bundle(tmp_path_factory: pytest.TempPathFactory):
    tmp = tmp_path_factory.mktemp("p14-validator")
    cp, pp, rp = _sources(tmp)
    patch = pytest.MonkeyPatch()
    patch.setattr(capture, "_environment", _environment)
    bundle = capture.build_bundle(
        out_parent=tmp / "out",
        repo_root=REPO,
        run_identity=_identity(),
        candidates_path=cp,
        prescreen_path=pp,
        regime_path=rp,
        previous_path=REPO / "data/candidate_funnel.json",
    )
    patch.undo()
    report = validator.validate_bundle(bundle, repo_root=REPO, ci=True)
    assert report["accepted"], report
    validator._write_ci_result(bundle, report)
    report = validator.validate_bundle(bundle, repo_root=REPO, ci=True)
    assert report["accepted"], report
    return bundle


def _copy(valid_bundle: Path, tmp_path: Path) -> Path:
    target = tmp_path / valid_bundle.name
    shutil.copytree(valid_bundle, target)
    return target


def _failed(report: dict, criterion_id: str) -> bool:
    return any(
        row["id"] == criterion_id and row["passed"] is False
        for row in report["criteria"]
    )


def test_market_content_hash_ignores_timestamps_and_run_token(valid_bundle):
    """T-13."""
    snapshot = next((valid_bundle / "snapshots").glob("real-*"))
    candidates = json.loads((snapshot / "inputs/data/candidates_stocks.json").read_text())
    prescreen = json.loads((snapshot / "inputs/data/prescreen_metadata.json").read_text())
    regime_bytes = (snapshot / "inputs/data/regime_state.json").read_bytes()
    joined = json.loads((snapshot / "inputs/joined_candidates.json").read_text())["candidates"]
    original = capture.compute_input_hashes(
        json.dumps(candidates).encode(), json.dumps(prescreen).encode(), regime_bytes, joined
    )
    candidates["updatedAt"] = "2099-01-01T00:00:00+09:00"
    candidates["_meta"]["runToken"] = "different-run"
    prescreen["generatedAt"] = candidates["updatedAt"]
    changed = capture.compute_input_hashes(
        json.dumps(candidates).encode(), json.dumps(prescreen).encode(), regime_bytes, joined
    )
    assert changed[0] != original[0]
    assert changed[1:] == original[1:]


def test_duplicate_market_content_hash_is_rejected_as_not_distinct(valid_bundle, tmp_path):
    """T-14."""
    manifest = json.loads((valid_bundle / "manifest.json").read_text())
    corpus = tmp_path / "corpus-index.json"
    corpus.write_text(
        json.dumps(
            {
                "snapshots": [
                    {
                        "snapshotId": "existing",
                        "accepted": True,
                        "marketContentHash": manifest["marketContentHash"],
                    }
                ]
            }
        )
    )
    report = validator.validate_bundle(
        valid_bundle, repo_root=REPO, ci=False, corpus_index=corpus
    )
    assert report["accepted"] is False
    assert report["validCapture"] is True
    assert report["snapshotVerdict"] == "duplicate"
    assert _failed(report, "AC-25")


def test_missing_prescreen_metadata_is_rejected(valid_bundle, tmp_path):
    """T-15."""
    bundle = _copy(valid_bundle, tmp_path)
    next(bundle.glob("snapshots/real-*/inputs/data/prescreen_metadata.json")).unlink()
    report = validator.validate_bundle(bundle, repo_root=REPO, ci=True)
    assert report["accepted"] is False
    assert _failed(report, "AC-05")
    assert _failed(report, "AC-10")
    assert _failed(report, "AC-11")


def test_missing_candidates_input_is_rejected(valid_bundle, tmp_path):
    """T-16."""
    bundle = _copy(valid_bundle, tmp_path)
    next(bundle.glob("snapshots/real-*/inputs/data/candidates_stocks.json")).unlink()
    report = validator.validate_bundle(bundle, repo_root=REPO, ci=True)
    assert report["accepted"] is False
    assert _failed(report, "AC-01")
    assert _failed(report, "AC-10")
    assert _failed(report, "AC-11")


def test_generator_sha_mismatch_is_rejected(valid_bundle, tmp_path):
    """T-17."""
    bundle = _copy(valid_bundle, tmp_path)
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["generatorSha256"]["data/candidate_funnel_batch.py"] = "0" * 64
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    report = validator.validate_bundle(bundle, repo_root=REPO, ci=True)
    assert report["accepted"] is False
    assert _failed(report, "AC-06")


def test_prescreen_generated_at_not_equal_candidates_updated_at_is_rejected(
    valid_bundle, tmp_path
):
    """T-18."""
    bundle = _copy(valid_bundle, tmp_path)
    path = next(bundle.glob("snapshots/real-*/inputs/data/prescreen_metadata.json"))
    payload = json.loads(path.read_text())
    payload["generatedAt"] = "2099-01-01T00:00:00+09:00"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    report = validator.validate_bundle(bundle, repo_root=REPO, ci=True)
    assert _failed(report, "AC-05")


def test_incomplete_bundle_missing_any_required_path_is_rejected(valid_bundle, tmp_path):
    """T-19."""
    bundle = _copy(valid_bundle, tmp_path)
    next(bundle.glob("snapshots/real-*/metrics/run-3-metrics.json")).unlink()
    with pytest.raises(validator.ValidationError, match="run-3-metrics"):
        validator.validate_bundle(bundle, repo_root=REPO, ci=True)


def test_assignment_contract_other_than_p14_prescreen_rank_code_v1_is_rejected(
    valid_bundle, tmp_path
):
    """T-20."""
    bundle = _copy(valid_bundle, tmp_path)
    path = bundle / "manifest.json"
    manifest = json.loads(path.read_text())
    manifest["assignmentContract"] = "p14-input-index-parity-v0"
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    report = validator.validate_bundle(bundle, repo_root=REPO, ci=True)
    assert _failed(report, "AC-24")


def test_missing_source_timestamps_are_rejected(valid_bundle, tmp_path):
    """T-21."""
    bundle = _copy(valid_bundle, tmp_path)
    path = bundle / "manifest.json"
    manifest = json.loads(path.read_text())
    manifest["sourceTimestamps"]["prescreenGeneratedAt"] = None
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    report = validator.validate_bundle(bundle, repo_root=REPO, ci=True)
    assert _failed(report, "AC-12")


def test_non_normal_pipeline_path_is_rejected(valid_bundle, tmp_path):
    """T-22."""
    bundle = _copy(valid_bundle, tmp_path)
    path = next(bundle.glob("snapshots/real-*/inputs/data/candidates_stocks.json"))
    payload = json.loads(path.read_text())
    payload["_meta"]["pipelinePath"] = "cache_fallback"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    report = validator.validate_bundle(bundle, repo_root=REPO, ci=True)
    assert _failed(report, "AC-02")
