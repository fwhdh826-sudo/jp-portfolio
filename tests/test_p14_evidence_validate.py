"""Frozen P14-E2 validator tests T-13..T-22, plus P14-P3C-R1A test-authority
hardening tests.

P14-P3C: the valid baseline authority is the deterministic same-run NORMAL
fixture (tests/fixtures/p14_same_run_normal_v1.json), not the mutable
committed data/candidates_stocks.json production artifact. The fixture's
olderFunnel section is a dedicated, deliberately older synthetic funnel used
ONLY by the Architecture-B temporal-independence test below -- it must never
serve as a hidden baseline for AC-02/AC-05/AC-19.

P14-P3C-R1A: the ordinary valid baseline also no longer reads the mutable
committed public/data/regime_state.json (see _load_synthetic_regime) and no
longer depends on real datetime.now() (see _frozen_datetime / FRESH_ASOF).
test_current_production_artifacts_follow_fail_closed_contract near the
bottom of this file is the ONE test allowed to read current real production
inputs -- it is isolated from every helper above it (P2-C).

P14-REAL-ARTIFACT-TEST-ENVIRONMENT-AUTHORITY: of the three real inputs that
one test reads, only data/candidates_stocks.json and
public/data/regime_state.json are committed durable artifacts;
data/prescreen_metadata.json is job-local ephemeral plumbing (.gitignore:33
-- generated solely by data.build_candidates_stocks, consumed only by later
steps of the same CI job, never committed). A clean checkout therefore
legitimately lacks it, and that absence is NOT a production-contract
failure. The real-artifact test recognizes the three legitimate prescreen
states via _classify_local_prescreen (absent / present-coherent /
present-incoherent) and only exercises the full capture+validate contract
path when a real prescreen is actually available; authoritative same-job
real-artifact fail-closed coverage lives in
.github/workflows/p14_evidence_capture.yml (build_candidates_stocks ->
p14_evidence_capture -> p14_evidence_validate --ci, one job, real data).
A prescreen file that exists but is malformed is a hard error, never
silently downgraded to "absent".

Known open defect (out of scope for this ticket, see P14-AC19-IDENTITY-
INTEGRITY-REPAIR): AC-19 currently checks only rank-vector length against
manifest population, not identity-set/uniqueness equality, so a same-count
duplicate/substituted identity can still pass AC-19. Not repaired here.
"""
from __future__ import annotations

import copy
import json
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

import pytest

from data import p14_evidence_capture as capture
from data import p14_evidence_validate as validator

REPO = Path(__file__).parents[1]
TEMPORAL_DIVERGENCE_CODE = "9999"
P14_P3C_FIXTURE_PATH = REPO / "tests/fixtures/p14_same_run_normal_v1.json"

# P14-P3C-R1A deterministic clock authority -- see the identical constants
# and rationale in tests/test_p14_evidence_capture.py.
FRESH_ASOF = "2026-07-30T00:30:00+00:00"
FRESH_ASOF_ALT = "2026-07-30T05:00:00+00:00"
STALE_ASOF = "2026-08-01T00:00:00+00:00"


def _load_p3c_fixture() -> dict:
    """Load the whole P14-P3C fixture document (deep copy)."""
    return copy.deepcopy(json.loads(P14_P3C_FIXTURE_PATH.read_text(encoding="utf-8")))


def _load_same_run_fixture() -> dict:
    """Load just the same-run NORMAL candidatesStocks authority (deep copy)."""
    return copy.deepcopy(_load_p3c_fixture()["candidatesStocks"])


def _load_synthetic_regime() -> dict:
    """Load the deterministic P14-P3C-R1A synthetic regime_state.json shape
    (deep copy) -- the sole regime authority for the ordinary valid baseline
    (P2-A). Never the mutable committed public/data/regime_state.json."""
    return copy.deepcopy(_load_p3c_fixture()["regimeState"])


def _frozen_datetime(as_of: str) -> type[datetime]:
    """Return a datetime subclass whose now() always returns the fixed
    instant `as_of`. See the identical helper in
    tests/test_p14_evidence_capture.py for the full rationale (P2-B)."""
    fixed = datetime.fromisoformat(as_of)

    class _Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed.astimezone(tz) if tz is not None else fixed

    return _Frozen


def _same_observation_prescreen_entries(candidates: dict) -> list[dict]:
    """Build prescreen metadata from the candidate population of this observation."""
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


def _sources(
    tmp: Path, *, later_candidate_code: str | None = None
) -> tuple[Path, Path, Path]:
    candidates = _load_same_run_fixture()
    candidates["_meta"]["runToken"] = "cc139a4e-e3b8-4515-843e-cf5b73612237"
    if later_candidate_code is not None:
        assert all(
            row["code"] != later_candidate_code for row in candidates["candidates"]
        )
        later_candidate = dict(candidates["candidates"][0])
        later_candidate.update(
            {"code": later_candidate_code, "name": "Temporal Divergence Fixture"}
        )
        candidates["candidates"].append(later_candidate)
        population = len(candidates["candidates"])
        candidates["_meta"]["counts"]["universeCount"] = population
        candidates["_meta"]["counts"]["publishedCount"] = population
    entries = _same_observation_prescreen_entries(candidates)
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
    # P14-P3C-R1A: synthetic regime authority, not the mutable committed
    # public/data/regime_state.json (P2-A).
    rp.write_text(
        json.dumps(_load_synthetic_regime(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
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
    # P14-P3C-R1A: fixed deterministic clock (P2-B) -- the ordinary valid
    # baseline no longer depends on the real wall clock.
    patch.setattr(capture, "datetime", _frozen_datetime(FRESH_ASOF))
    bundle = capture.build_bundle(
        out_parent=tmp / "out",
        repo_root=REPO,
        run_identity=_identity(),
        candidates_path=cp,
        prescreen_path=pp,
        regime_path=rp,
        # P14-P3C: ordinary baseline tests carry no retained-previous-funnel
        # authority (P-15 is a RECORD gate, not fail-closed) -- the mutable
        # committed data/candidate_funnel.json must not be a hidden baseline.
        previous_path=None,
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


def _passed(report: dict, criterion_id: str) -> bool:
    return any(
        row["id"] == criterion_id and row["passed"] is True
        for row in report["criteria"]
    )


def test_market_content_hash_ignores_timestamps_and_run_token(valid_bundle):
    """T-13; normal capture schema excludes every legacy-only field."""
    legacy_only = {"legacyExtension", "legacyReplayOutcome", "waivedCriteria",
                   "waiverAuthority"}
    status = json.loads((valid_bundle / "validation/status.json").read_text())
    acceptance_report = json.loads(
        (valid_bundle / "validation/acceptance-report.json").read_text()
    )
    manifest = json.loads((valid_bundle / "manifest.json").read_text())
    assert legacy_only.isdisjoint(status)
    assert legacy_only.isdisjoint(acceptance_report)
    assert legacy_only.isdisjoint(manifest["acceptance"])
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
    assert report["accepted"] is False
    assert _failed(report, "AC-05")


def test_later_candidate_need_not_exist_in_retained_previous_funnel(
    tmp_path, monkeypatch
):
    """Architecture B keeps an older funnel while later candidate sets evolve.

    P14-P3C: the "retained older funnel" authority here is a dedicated
    deterministic fixture (fixture's olderFunnel section), deliberately
    older than and disjoint from the same-run candidatesStocks population --
    never the mutable committed data/candidate_funnel.json.
    """
    previous = _load_p3c_fixture()["olderFunnel"]
    assert TEMPORAL_DIVERGENCE_CODE not in {
        row["code"] for row in previous["candidates"]
    }
    previous_path = tmp_path / "older-funnel" / "candidate_funnel_previous.json"
    previous_path.parent.mkdir(parents=True)
    previous_path.write_text(
        json.dumps(previous, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    cp, pp, rp = _sources(
        tmp_path, later_candidate_code=TEMPORAL_DIVERGENCE_CODE
    )
    monkeypatch.setattr(capture, "_environment", _environment)
    monkeypatch.setattr(capture, "datetime", _frozen_datetime(FRESH_ASOF))
    bundle = capture.build_bundle(
        out_parent=tmp_path / "out",
        repo_root=REPO,
        run_identity=_identity(),
        candidates_path=cp,
        prescreen_path=pp,
        regime_path=rp,
        previous_path=previous_path,
    )
    report = validator.validate_bundle(bundle, repo_root=REPO, ci=True)
    assert report["accepted"] is True, report
    snapshot = next((bundle / "snapshots").glob("real-*"))
    joined = json.loads(
        (snapshot / "inputs/joined_candidates.json").read_text()
    )["candidates"]
    assert TEMPORAL_DIVERGENCE_CODE in {row["code"] for row in joined}


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


# ---------------------------------------------------------------------------
# P14-P3C-R1A §9-11: AC-05 adversarial coverage (timestamp already covered by
# T-18 above; shortlist and pipeline were previously uncommitted P2-D gaps).
# AC-05's same_run check is a three-way conjunction (validator.py):
#   prescreen.generatedAt == candidates.updatedAt   (T-18, existing)
#   prescreen.shortlistId == candidates._meta.universeProvenance.shortlistId
#   prescreen.pipelinePath == candidates._meta.pipelinePath
# Each new test here mutates only the minimum relevant field on the
# prescreen side, so the corresponding candidates-side criteria (AC-02 in
# particular) are never weakened by the mutation.
# ---------------------------------------------------------------------------


def test_ac05_passes_on_coherent_baseline_before_any_mutation(valid_bundle):
    """P14-P3C-R1A §9-11: sanity anchor -- AC-05 itself (not merely overall
    acceptance) is proven PASS on the untouched coherent baseline before each
    adversarial mutation test below asserts it flips to FAIL."""
    report = validator.validate_bundle(valid_bundle, repo_root=REPO, ci=True)
    assert report["accepted"] is True, report
    assert _passed(report, "AC-05"), report


def test_ac05_shortlist_mismatch_is_rejected(valid_bundle, tmp_path):
    """P14-P3C-R1A §10: committed adversarial coverage for AC-05 shortlist
    disagreement. Mutates only prescreen_metadata.shortlistId -- the
    candidates-side universeProvenance.shortlistId (and therefore AC-02) is
    untouched."""
    bundle = _copy(valid_bundle, tmp_path)
    path = next(bundle.glob("snapshots/real-*/inputs/data/prescreen_metadata.json"))
    payload = json.loads(path.read_text())
    payload["shortlistId"] = f"{payload['shortlistId']}-mismatch"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    report = validator.validate_bundle(bundle, repo_root=REPO, ci=True)
    assert report["accepted"] is False
    assert _failed(report, "AC-05")
    assert _passed(report, "AC-02")


def test_ac05_pipeline_path_mismatch_is_rejected_without_weakening_ac02(
    valid_bundle, tmp_path
):
    """P14-P3C-R1A §11: committed adversarial coverage for AC-05
    candidate/prescreen pipeline-path disagreement. Mutates only
    prescreen_metadata.pipelinePath -- the candidates-side
    _meta.pipelinePath (and therefore AC-02, which reads only that side) is
    untouched, so AC-05 is proven false without degrading AC-02 (per the
    ticket's "Do NOT weaken AC-02" constraint)."""
    bundle = _copy(valid_bundle, tmp_path)
    path = next(bundle.glob("snapshots/real-*/inputs/data/prescreen_metadata.json"))
    payload = json.loads(path.read_text())
    assert payload["pipelinePath"] == "normal"
    payload["pipelinePath"] = "cache_fallback"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    report = validator.validate_bundle(bundle, repo_root=REPO, ci=True)
    assert report["accepted"] is False
    assert _failed(report, "AC-05")
    assert _passed(report, "AC-02")


# ---------------------------------------------------------------------------
# P14-P3C-R1A §12-14 + P14-REAL-ARTIFACT-TEST-ENVIRONMENT-AUTHORITY: explicit
# CURRENT real-input compatibility / fail-closed test. This is the ONLY test
# in this file allowed to read current real production inputs
# (data/candidates_stocks.json + public/data/regime_state.json, both
# committed; data/prescreen_metadata.json, job-local ephemeral -- .gitignore).
# It is isolated from every synthetic baseline above: it shares none of
# _sources/_load_same_run_fixture/_load_synthetic_regime/valid_bundle, and
# its own bundle never feeds AC-02/AC-05/AC-19 fixtures elsewhere in the
# suite. It intentionally does NOT freeze the clock -- "current" provenance
# compatibility is evaluated against the real wall clock by design, and it
# must not require today's artifact to be permanently seed_fallback: it
# inspects the actual observed provenance and asserts the outcome the P14
# contract requires for THAT observation.
#
# Environment authority (P14-REAL-ARTIFACT-TEST-ENVIRONMENT-AUTHORITY): the
# ephemeral prescreen artifact is only produced by the same-job
# data.build_candidates_stocks step. When it is legitimately absent (clean
# checkout / dev tree where that step has not run) the test asserts only the
# invariants the two COMMITTED artifacts must always satisfy and records the
# prescreen as unavailable in this environment -- it does not fabricate a
# prescreen and call it "current production". The full capture+validate
# contract path (including the observed-provenance PASS/fail-closed branch)
# runs whenever a real prescreen IS available. Same-job real-artifact
# fail-closed coverage is additionally guaranteed by
# .github/workflows/p14_evidence_capture.yml.
# ---------------------------------------------------------------------------

_PROD_CANDIDATES_PATH = REPO / "data/candidates_stocks.json"
_PROD_PRESCREEN_PATH = REPO / "data/prescreen_metadata.json"
_PROD_REGIME_PATH = REPO / "public/data/regime_state.json"


def _classify_local_prescreen(prescreen_path: Path) -> tuple[str, dict | None]:
    """Distinguish the legitimate states of the job-local ephemeral
    data/prescreen_metadata.json (.gitignore:33 -- generated only by
    data.build_candidates_stocks, consumed only by later steps of the same
    CI job, never committed):

      "absent"  -- clean checkout / dev tree where the same-job producer has
                   not run. NOT a production-contract failure. Authoritative
                   same-job real-artifact compatibility is covered by
                   .github/workflows/p14_evidence_capture.yml.
      "present" -- a real same-job / dev-generated prescreen is available;
                   the caller exercises the full capture+validate contract.

    A file that exists but is not valid JSON / not a JSON object is a hard
    error (raised), never silently downgraded to "absent"
    (P14-REAL-ARTIFACT-TEST-ENVIRONMENT-AUTHORITY R7)."""
    if not prescreen_path.exists():
        return "absent", None
    payload = json.loads(prescreen_path.read_text(encoding="utf-8"))
    assert isinstance(payload, dict), (
        f"malformed real prescreen artifact (not a JSON object): {prescreen_path}"
    )
    return "present", payload


def test_absent_ephemeral_prescreen_is_not_a_production_failure(tmp_path):
    """T1 / R1: a checkout where the gitignored ephemeral
    data/prescreen_metadata.json is simply not present classifies as
    'absent' (recognized unavailable in this environment) -- it must never
    raise a production-contract failure."""
    state, payload = _classify_local_prescreen(tmp_path / "prescreen_metadata.json")
    assert state == "absent"
    assert payload is None


def test_malformed_real_prescreen_is_not_silently_treated_as_unavailable(tmp_path):
    """T4 / R7: a prescreen file that exists but is not valid JSON / not a
    JSON object is a hard error, never downgraded to 'absent'."""
    bad = tmp_path / "prescreen_metadata.json"
    bad.write_text("{ not valid json", encoding="utf-8")
    with pytest.raises(json.JSONDecodeError):
        _classify_local_prescreen(bad)
    bad.write_text("[]", encoding="utf-8")
    with pytest.raises(AssertionError, match="malformed real prescreen artifact"):
        _classify_local_prescreen(bad)


def _real_production_identity(candidates_payload: dict, prescreen_payload: dict) -> dict[str, str]:
    meta = candidates_payload.get("_meta", {}) if isinstance(candidates_payload, dict) else {}
    return {
        "runId": "9900",
        "runAttempt": "1",
        "runToken": meta.get("runToken"),
        "workflow": capture.WORKFLOW,
        "event": "workflow_dispatch",
        "startedAt": "2026-01-01T00:00:00Z",
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


def _real_production_environment(_run_identity: dict[str, str]) -> dict[str, object]:
    # CI-consistent environment fields only -- this does not make the test
    # read fabricated candidate/prescreen/regime data, it only prevents the
    # local dev interpreter/timezone from polluting AC-16/AC-17 with noise
    # unrelated to production data provenance.
    return {
        "capturedAt": "2026-01-01T00:00:01+00:00",
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


def test_current_production_artifacts_follow_fail_closed_contract(tmp_path, monkeypatch):
    """P14-P3C-R1A §12/§13 + P14-REAL-ARTIFACT-TEST-ENVIRONMENT-AUTHORITY:
    capture+validate the actual current real inputs and assert the contract
    outcome that matches the OBSERVED provenance -- normal/coherent/same-run
    must be compatible; seed_fallback/cache_fallback/stale/incoherent must
    fail closed.

    Only data/candidates_stocks.json and public/data/regime_state.json are
    committed and therefore hard-required here. data/prescreen_metadata.json
    is job-local ephemeral (.gitignore): when it is legitimately absent
    (clean checkout) this test asserts only the invariants the committed
    artifacts must always hold and stops -- it does not fabricate a
    prescreen (R2). The full capture+validate + observed-provenance branch
    runs whenever a real prescreen is available (R3); a malformed prescreen
    is a hard error via _classify_local_prescreen (R7)."""
    candidates_path = _PROD_CANDIDATES_PATH
    prescreen_path = _PROD_PRESCREEN_PATH
    regime_path = _PROD_REGIME_PATH
    for path in (candidates_path, regime_path):
        assert path.is_file(), f"missing committed production artifact: {path}"

    candidates_payload = json.loads(candidates_path.read_text(encoding="utf-8"))
    meta = candidates_payload.get("_meta", {})
    provenance = meta.get("universeProvenance", {})
    pipeline_path = meta.get("pipelinePath")

    prescreen_state, prescreen_payload = _classify_local_prescreen(prescreen_path)
    if prescreen_state == "absent":
        # R1: legitimate clean-checkout state -- the same-job ephemeral
        # producer (data.build_candidates_stocks) has not run in this
        # environment. Assert only what the committed artifacts must always
        # satisfy; real-artifact same-job fail-closed coverage then lives in
        # .github/workflows/p14_evidence_capture.yml.
        assert isinstance(provenance, dict) and provenance, candidates_payload
        assert pipeline_path in {"normal", "cache_fallback", "seed_fallback"}, meta
        assert isinstance(candidates_payload.get("updatedAt"), str), candidates_payload
        assert regime_path.stat().st_size > 0
        return

    is_normal_provenance = (
        pipeline_path == "normal"
        and provenance.get("jpxFallbackUsed") is False
        and provenance.get("shortlistFallbackUsed") is False
        and provenance.get("shortlistBypassSeedListV1") is False
    )
    is_same_run = (
        prescreen_payload.get("generatedAt") == candidates_payload.get("updatedAt")
        and prescreen_payload.get("shortlistId") == provenance.get("shortlistId")
        and prescreen_payload.get("pipelinePath") == pipeline_path
    )

    monkeypatch.setattr(capture, "_environment", _real_production_environment)
    bundle = capture.build_bundle(
        out_parent=tmp_path / "out",
        repo_root=REPO,
        run_identity=_real_production_identity(candidates_payload, prescreen_payload),
        candidates_path=candidates_path,
        prescreen_path=prescreen_path,
        regime_path=regime_path,
        previous_path=None,
    )
    report = validator.validate_bundle(bundle, repo_root=REPO, ci=True)

    if is_normal_provenance and is_same_run:
        assert report["accepted"] is True, report
        assert _passed(report, "AC-02"), report
        assert _passed(report, "AC-05"), report
    else:
        assert report["accepted"] is False, report
        if not is_normal_provenance:
            assert _failed(report, "AC-02"), report
        if not is_same_run:
            assert _failed(report, "AC-05"), report
