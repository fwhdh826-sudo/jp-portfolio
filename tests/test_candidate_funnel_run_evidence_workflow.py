"""OPS-P14-2: .github/workflows/full_batch.yml への same-run evidence capture
統合の回帰テスト。

tests/test_candidate_funnel_workflow.pyと同じ規律（yml本文へのtext-based
アサーション、実CI実行はしない）で、以下を確認する:
  1. evidence capture / upload stepが存在し、smoke stepの直後・
     SAFE_MODEスナップショットより前に位置する
  2. capture / upload の両stepは `if: always()` かつ `continue-on-error: true`
     — candidate funnelがnonzero exitでも必ず実行され、かつこの2stepの
     失敗がjob全体やpublish判定に波及しない
  3. 「Enforce candidate funnel publication status」step（真の
     fail-closed enforcement）の本文がこのticketで一切変更されていない
     （byte-exact pin）
  4. previous artifact snapshot stepがbuild stepより前に存在する
  5. upload artifact名にrun id/attemptを含み、retention-daysを指定している
  6. pip installの依存集合に変更が無い（新規dependency追加 0）
  7. batch/smoke stepの `|| true` 不在（既存fail-closed hard gateを壊さない）
  8. (OPS P14 v13.4 Phase IV D01) dormant transport wiring: 共有 disabled mode、
     same-job producer/consumer の 11 field mapping、attempt root cleanup、
     N-PUB-1..6 と failed-step output 配送。実 workflow の step 本文を stub
     python3/git/gh の境界の背後で実行する（実 GitHub 操作・実 rebase・実 push なし）。
"""
import hashlib
import inspect
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from data import candidate_funnel_engine as engine
from data import candidate_funnel_run_evidence as evidence_mod
from data import p14_handoff as handoff
from data import p14_observation as observation_mod
from data import p14_run_evidence_bundle as bundle

_WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "full_batch.yml"
_TEXT = _WORKFLOW.read_text()

_ENFORCE_STEP_EXPECTED = """      - name: Enforce candidate funnel publication status
        if: ${{ always() && !cancelled() }}
        env:
          CANDIDATE_FUNNEL_BATCH_STATUS: ${{ steps.candidate-funnel-build.outputs.publication_status }}
          CANDIDATE_FUNNEL_SMOKE_STATUS: ${{ steps.candidate-funnel-smoke.outputs.publication_status }}
        run: |
          set -euo pipefail

          if [ "$CANDIDATE_FUNNEL_BATCH_STATUS" = "batch_failed" ]; then
            echo "::error::Candidate funnel publication failed at the P-01..P-15 batch gate" >&2
            exit 1
          fi
          if [ "$CANDIDATE_FUNNEL_BATCH_STATUS" != "batch_passed" ]; then
            echo "::error::Candidate funnel batch status is unavailable or unsafe" >&2
            exit 1
          fi
          if [ "$CANDIDATE_FUNNEL_SMOKE_STATUS" = "smoke_failed" ]; then
            echo "::error::Candidate funnel publication failed at the privacy/schema gate" >&2
            exit 1
          fi
          if [ "$CANDIDATE_FUNNEL_SMOKE_STATUS" != "smoke_passed" ]; then
            echo "::error::Candidate funnel privacy/schema status is unavailable or unsafe" >&2
            exit 1
          fi

          echo "Candidate funnel publication gates passed"
"""


def _update_data_section() -> str:
    return _TEXT.split("  update-data:")[1].split("  routines-stub:")[0]


def _step_block(marker: str) -> str:
    """`marker`を含む`- name:`行から次のstep見出しまでのYAML断片を返す。"""
    section = _update_data_section()
    start = section.index(marker)
    head = section.rindex("\n      - name:", 0, start + 1)
    rest = section[head:]
    next_step_marker = rest.index("\n      - name:", 1)
    return rest[:next_step_marker]


def test_snapshot_previous_artifact_step_present_before_build():
    section = _update_data_section()
    snapshot_pos = section.index("Snapshot previous candidate_funnel artifact for evidence")
    build_pos = section.index("Build candidate_funnel.json (prescreen join + P-01..P-15 quality gate)")
    assert snapshot_pos < build_pos


def test_capture_step_present():
    assert "python3 -m data.candidate_funnel_run_evidence" in _TEXT


def test_capture_step_runs_after_smoke_and_before_safe_mode():
    section = _update_data_section()
    smoke_pos = section.index("python3 -m data.candidate_funnel_privacy_smoke")
    capture_pos = section.index("python3 -m data.candidate_funnel_run_evidence")
    safe_mode_pos = section.index("Build SAFE_MODE snapshot")
    assert smoke_pos < capture_pos < safe_mode_pos


def test_capture_step_has_always_and_continue_on_error():
    block = _step_block("python3 -m data.candidate_funnel_run_evidence")
    assert "if: always()" in block
    assert "continue-on-error: true" in block


def test_upload_step_present_and_configured():
    block = _step_block("actions/upload-artifact@v4\n        with:\n          name: candidate-funnel-evidence-")
    assert "if: always()" in block
    assert "continue-on-error: true" in block
    assert "retention-days: 90" in block
    assert "${{ github.run_id }}" in block
    assert "${{ github.run_attempt }}" in block
    assert "if-no-files-found: warn" in block


def test_upload_step_runs_after_capture_step():
    section = _update_data_section()
    capture_pos = section.index("python3 -m data.candidate_funnel_run_evidence")
    upload_pos = section.index("actions/upload-artifact@v4\n        with:\n          name: candidate-funnel-evidence-")
    assert capture_pos < upload_pos


def test_evidence_steps_do_not_disturb_safe_mode_or_tier_a_order():
    section = _update_data_section()
    upload_pos = section.index("actions/upload-artifact@v4\n        with:\n          name: candidate-funnel-evidence-")
    safe_mode_pos = section.index("Build SAFE_MODE snapshot")
    tier_a_pos = section.index("Build TierA snapshots")
    assert upload_pos < safe_mode_pos < tier_a_pos


def test_enforce_publication_status_step_is_byte_identical_to_pin():
    """真のfail-closed enforcement stepはこのticketで1バイトも変更しない
    ——additive evidence captureがexit statusのsemanticsに触れていないことの
    直接的な証拠。"""
    assert _ENFORCE_STEP_EXPECTED in _TEXT


def test_batch_and_smoke_steps_remain_blocking():
    section = _update_data_section()
    assert "python3 -m data.candidate_funnel_batch\n" in section
    assert "python3 -m data.candidate_funnel_batch || true" not in section
    assert "python3 -m data.candidate_funnel_privacy_smoke\n" in section
    assert "python3 -m data.candidate_funnel_privacy_smoke || true" not in section


def test_no_new_pip_dependency_added():
    # P5-B005-B4-A: yfinance を production 解決版へ pin する以外、依存の
    # 追加・upgrade はしない（§21）。パッケージ集合は不変。
    assert (
        "pip install yfinance==1.7.0 pandas numpy feedparser requests xlrd openpyxl" in _TEXT
    )
    # 新規パッケージ名が混入していないこと
    assert "pip install yfinance pandas numpy feedparser requests xlrd" not in _TEXT


def test_capture_and_upload_steps_have_no_secrets_env():
    """evidence step群はDEEPL_API_KEY等のsecretsを一切参照しない。"""
    capture_block = _step_block("python3 -m data.candidate_funnel_run_evidence")
    upload_block = _step_block("actions/upload-artifact@v4\n        with:\n          name: candidate-funnel-evidence-")
    assert "secrets." not in capture_block
    assert "secrets." not in upload_block


# ── 自己完結の synthetic schema-3 producer (OPS P14 v13.4 Phase IV D01) ────────
# tests/test_candidate_funnel_run_evidence.py の `_s3_fixture` と同形の独立
# synthetic producer。他 test file の private helper は import しない規約のため、
# この file 専用に複製している（挙動の変更は無い）。
SYN_REPO = Path(__file__).resolve().parents[1]
SYN_POLICY = "p14-decision-aware-v1"
SYN_EXECUTED_SHA = "2" * 40
SYN_RUN = {
    "repository": "synthetic/schema3", "workflow": "full_batch.yml", "job": "update-data",
    "runId": "900000031", "runAttempt": "1", "event": "schedule",
    "gitRef": "refs/heads/main", "gitRefType": "branch", "gitSha": "1" * 40,
}
SYN_VERSIONS = (
    engine.CANDIDATE_FUNNEL_SCHEMA_VERSION, engine.CANDIDATE_FUNNEL_SCORE_VERSION,
    engine.CANDIDATE_FUNNEL_VERSION,
)


def _syn_context() -> dict[str, object]:
    return {
        "pipelinePath": "normal",
        "regime": "bull_calm",
        "sourceUpdatedAt": "2026-09-20T00:00:00.000Z",
        "asOf": "2026-09-20T00:30:00.000Z",
        "staleThresholdHours": 24,
        "prescreenFallbackUsed": False,
    }


def _syn_join_stats() -> dict[str, object]:
    return {
        "candidateCount": 6,
        "prescreenCount": 6,
        "joinedCount": 6,
        "unmatchedCandidateCount": 0,
        "unmatchedPrescreenCount": 0,
        "joinRate": 1.0,
        "unmatchedCandidateRate": 0.0,
    }


def _syn_joined_input() -> list[dict[str, object]]:
    return [
        {
            "code": f"SYN-{index}",
            "name": f"SYN-{index}",
            "sector": "Synthetic",
            "price": 100.0 + index,
            "per": 10.0,
            "pbr": 1.0,
            "roe": 0.1,
            "dividendYield": 0.01,
            "sigma252d": 0.2,
            "mom3m": 0.05,
            "dataStatus": "synthetic",
            "prescreenScore": 100.0 - index,
            "prescreenRank": index,
            "prescreenPool": "synthetic",
        }
        for index in range(1, 7)
    ]


def _syn_candidates(*, dropped: int) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for index in range(1, 7):
        rank: int | None = index if index <= 6 - dropped else None
        rows.append(
            {
                "artifactIndex": index - 1,
                "code": f"SYN-{index}",
                "tier": "actionable" if index <= 2 else "deep_review",
                "marketRank": rank,
                "prescreenScore": 100.0 - index,
                "prescreenRank": index,
                "prescreenPool": "synthetic",
                "marketScore": 90.0 - index,
                "rawCompositeScore": 0.9 - index / 100,
                "sector": "Synthetic",
                "dataStatus": "synthetic",
                "dataConfidence": 0.9,
            }
        )
    return rows


def _syn_selection() -> dict[str, object]:
    return {
        "regimeApplied": "bull_calm",
        "actionableHardMaxApplied": 12,
        "actionableSectorCapApplied": 2,
        "deepReviewHardMaxApplied": 40,
        "deepReviewSectorCapApplied": 6,
        "deepReviewSectorCapRelaxed": False,
        "actionableSectorCapRelaxed": False,
        "deepReviewEligibleCount": 4,
        "deepReviewSelectedCount": 4,
        "actionableEligibleCount": 2,
        "actionableSelectedCount": 2,
        "sourceStale": False,
        "fallbackProvenance": False,
    }


def _syn_side(*, dropped: int = 0) -> dict[str, object]:
    return {
        "engineStatus": "generated",
        "candidates": _syn_candidates(dropped=dropped),
        "selectionObservability": _syn_selection(),
    }


def _syn_source_identity(executed_sha: str = SYN_EXECUTED_SHA, digests=None) -> dict[str, object]:
    return {
        "executedGitSha": executed_sha,
        "modules": [
            {
                "path": path,
                "sha256": digests[path] if digests is not None else f"{index + 1:064x}",
            }
            for index, path in enumerate(handoff.FIXED_MODULE_PATHS)
        ],
        "engineSchemaVersion": "candidate-funnel-1",
        "engineScoreVersion": "market-score-v1",
        "engineFunnelVersion": "candidate-funnel-v1",
    }


def _syn_release(*, dropped: int, status: str) -> dict[str, object]:
    base_codes = [f"SYN-{index}" for index in range(1, 7)]
    perturbed_codes = [f"SYN-{index}" for index in range(1, 7 - dropped)]
    intersection = sorted(set(base_codes) & set(perturbed_codes))
    union = sorted(set(base_codes) | set(perturbed_codes))
    jaccard = len(intersection) / len(union)
    reasons = {
        "PASS": ([], []),
        "WARN": ([], ["P14_TOP40_JACCARD_WARN"]),
        "FAIL": (["P14_TOP40_JACCARD_HARD_FAIL"], []),
    }
    hard, warn = reasons[status]
    shortlist = [
        {"code": f"SYN-{index}", "tier": "actionable" if index <= 2 else "deep_review", "marketRank": index, "artifactIndex": index - 1}
        for index in range(1, 4)
    ]
    return {
        "policyVersion": SYN_POLICY,
        "top40": {
            "intersection": intersection,
            "union": union,
            "retention": len(intersection) / len(base_codes),
            "swapCount": dropped,
            "jaccard": jaccard,
            "warnThreshold": 0.95,
            "hardThreshold": 0.8,
        },
        "deepReview": {
            "baseCodes": ["SYN-3", "SYN-4", "SYN-5", "SYN-6"],
            "perturbedCodes": [code for code in ["SYN-3", "SYN-4", "SYN-5", "SYN-6"] if code in perturbed_codes],
            "entered": [],
            "exited": [code for code in ["SYN-3", "SYN-4", "SYN-5", "SYN-6"] if code not in perturbed_codes],
            "exitCount": len([code for code in ["SYN-3", "SYN-4", "SYN-5", "SYN-6"] if code not in perturbed_codes]),
        },
        "actionable": {
            "baseCodes": ["SYN-1", "SYN-2"],
            "perturbedCodes": ["SYN-1", "SYN-2"],
            "entered": [],
            "exited": [],
            "exitCount": 0,
            "warnThreshold": 2,
            "hardThreshold": 3,
        },
        "marketReferenceShortlist": {
            "name": "P14_MARKET_REFERENCE_SHORTLIST",
            "holdingsDependent": False,
            "n": 3,
            "base": shortlist,
            "perturbed": shortlist,
            "membershipChanged": False,
            "tierChanged": False,
            "orderChanged": False,
        },
        "final": {"status": status, "hardReasons": hard, "warnReasons": warn},
        "p14ProvesOfficialDecisionStability": False,
    }


def _syn_gates(*, dropped: int, status: str, fail_id: str | None = None) -> list[dict[str, object]]:
    jaccard = (6 - dropped) / 6
    values: dict[str, object] = {
        "P-01": 6,
        "P-02": 1.0,
        "P-03": 0.0,
        "P-04": 0.0,
        "PRESCREEN_DUPLICATE": 0,
        "P-05": 0.0,
        "P-06": {"count": 6, "min": 4, "p25": 4, "median": 5, "p75": 6, "max": 6, "atOrBelow4AxesCount": 1},
        "P-07": {"count": 6, "min": 20.0, "max": 80.0, "range": 60.0, "p25": 30.0, "p75": 50.0, "iqr": 20.0, "median": 40.0},
        "P-08": 4,
        "P-09": 2,
        "P-10": {"deepReview": 7, "actionable": 4},
        "P-11": {"deepReviewSectorCapOverflow": {"Synthetic": 0}, "actionableSectorCapOverflow": {"Synthetic": 0}, "deepReviewEligibleMinusSelected": 0, "actionableEligibleMinusSelected": 0},
        "P-12": {"soft": {}, "hard": {}},
        "P-13": {"currentRunActionable": 2, "cacheFallbackMirrorActionable": 0},
        "P-14": jaccard,
        "P-15": None,
    }
    result: list[dict[str, object]] = []
    ids = ["P-01", "P-02", "P-03", "P-04", "PRESCREEN_DUPLICATE", *[f"P-{index:02d}" for index in range(5, 16)]]
    for gate_id in ids:
        gate_status = "RECORD" if gate_id in {"P-01", "P-03", "P-05", "P-06", "P-09", "P-11", "P-15"} else "PASS"
        if gate_id == "P-14":
            gate_status = status
        if gate_id == fail_id:
            gate_status = "FAIL"
        result.append(
            {
                "id": gate_id,
                "metric": f"synthetic {gate_id}",
                "value": values[gate_id],
                "threshold": "synthetic",
                "status": gate_status,
                "note": "is_degraded=False" if gate_id == "P-13" else "[]" if gate_id in {"P-04", "PRESCREEN_DUPLICATE"} else "",
            }
        )
    return result


def _syn_quality(*, dropped: int, status: str, fail_id: str | None = None) -> dict[str, object]:
    hard_ids = [fail_id] if fail_id is not None else (["P-14"] if status == "FAIL" else [])
    return {
        "gates": _syn_gates(dropped=dropped, status=status, fail_id=fail_id),
        "overallPass": not hard_ids,
        "hardFailIds": hard_ids,
        "notes": [],
        "p14ReleaseEvidence": _syn_release(dropped=dropped, status=status),
    }


def _syn_fixture(tmp_path, *, terminal="BATCH_READY", status="PASS", dropped=0, fail_id=None):
    """Independent synthetic producer; construction finishes before tripwires."""
    raw_paths = {}
    for name in handoff.RAW_FILE_NAMES:
        path = tmp_path / f"{name}.json"
        path.write_bytes(observation_mod.canonical_json_bytes({"synthetic": name}))
        raw_paths[name] = path
    digests = {
        path: hashlib.sha256((SYN_REPO / path).read_bytes()).hexdigest()
        for path in handoff.FIXED_MODULE_PATHS
    }
    consumer = bundle.ConsumerIdentity(
        SYN_EXECUTED_SHA,
        tuple((path, hashlib.sha256((SYN_REPO / path).read_bytes()).hexdigest()) for path in bundle.CONSUMER_MODULE_PATHS),
    )
    capture = handoff.build_capture_input_bytes(
        joined_candidate_input=_syn_joined_input(), context=_syn_context(), join_stats=_syn_join_stats(),
        source_updated_at="2026-09-20T00:00:00.000Z", candidates_updated_at="2026-09-20T00:01:00.000Z",
    )
    joined, context = handoff.expected_input_digests_from_capture(capture)
    def record(payload):
        return {"sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload)}
    input_identity = {
        "rawFiles": {name: {"present": True, **record(path.read_bytes())} for name, path in raw_paths.items()},
        "joinedCandidateInput": {"sha256": joined.sha256, "bytes": joined.bytes},
        "replayContext": {"sha256": context.sha256, "bytes": context.bytes},
        "captureInput": record(capture),
    }
    observation = handoff.build_observation_bytes(
        policy_version=SYN_POLICY, run_identity=SYN_RUN,
        source_identity=_syn_source_identity(digests=digests), input_identity=input_identity,
        base=_syn_side(), perturbed=_syn_side(dropped=dropped),
    )
    report = {
        "context": _syn_context(), "joinStats": _syn_join_stats(), "prescreenDuplicateCodes": [],
        "qualityGate": _syn_quality(dropped=dropped, status=status, fail_id=fail_id), "engineStatus": "generated",
    }
    if terminal == "SCHEMA_VIOLATIONS":
        report["schemaViolations"] = ["synthetic reviewed schema violation"]
    receipt = handoff.build_batch_receipt_bytes({
        "schemaVersion": handoff.RECEIPT_SCHEMA_VERSION, "runIdentity": SYN_RUN,
        "policyVersion": SYN_POLICY, "executedGitSha": SYN_EXECUTED_SHA,
        "observationDigest": record(observation)["sha256"], "captureInputDigest": record(capture)["sha256"],
        "terminalStatus": terminal, "artifactAvailable": terminal == "BATCH_READY",
        "transportStatus": "READY", "failureCode": None, "reportState": "COMPLETE", "report": report,
    }, observation_bytes=observation, capture_input_bytes=capture)
    parts, reference = handoff.build_handoff_parts(
        observation_bytes=observation, capture_input_bytes=capture, receipt_bytes=receipt,
    )
    root = tmp_path / "handoff"
    claim = handoff.claim_attempt(root, SYN_RUN["runId"], SYN_RUN["runAttempt"])
    handoff.write_handoff_parts(claim, parts)
    kwargs = dict(
        handoff_root=root, producer_reference=reference, run_identity=dict(SYN_RUN),
        expected_policy_version=SYN_POLICY, consumer=consumer, engine_versions=SYN_VERSIONS,
        raw_paths=raw_paths,
        workflow=bundle.WorkflowStatus("batch_passed", "smoke_passed") if terminal == "BATCH_READY"
        else bundle.WorkflowStatus("batch_failed", None),
    )
    return kwargs, parts, reference


def _syn_evidence(files):
    return json.loads(files[bundle.EVIDENCE_FILE])


# ═══════════════════════════════════════════════════════════════════════════
# OPS P14 v13.4 Phase IV D01 — dormant transport wiring.
#
# The tests below execute the ACTUAL parsed `full_batch.yml` step bodies (bash)
# in temporary repositories behind stub python3 / git / gh boundaries. No real
# GitHub operation and no production engine run takes place; the Commit block's
# fetch / push / ls-remote reach only a filesystem-local bare origin created inside
# the simulation's own temporary root (H01), and history-unsafe subcommands
# (pull / rebase / merge / force) are rejected by the git boundary. The repository
# default stays `P14_HANDOFF_MODE: disabled`; the real schema-3 consumer is only
# exercised in-process with an injected test-only enabled mode, fed with the argv
# that the workflow's own consumer command line delivered.
# ═══════════════════════════════════════════════════════════════════════════

_DOC = yaml.safe_load(_TEXT)
_JOB = _DOC["jobs"]["update-data"]
_STEPS_BY_NAME = {step["name"]: step for step in _JOB["steps"] if "name" in step}

_BUILD_STEP = "Build candidate_funnel.json (prescreen join + P-01..P-15 quality gate)"
_SMOKE_STEP = "Privacy/schema smoke test candidate_funnel.json"
_DERIVED_PER_STEP = "Derived PER migration calibration observability"
_CAPTURE_STEP = "Capture candidate funnel run evidence"
_UPLOAD_STEP = "Upload candidate funnel run evidence"
_CLEANUP_STEP = "Cleanup candidate funnel P14 handoff"
_DERIVED_PER_UPLOAD_STEP = "Upload derived PER migration calibration evidence"
_SAFE_MODE_BUILD_STEP = "Build SAFE_MODE snapshot"
_SAFE_MODE_SMOKE_STEP = "Smoke test safe_mode schema"
_TIER_A_BUILD_STEP = "Build TierA snapshots"
_TIER_A_SMOKE_STEP = "Smoke test TierA schemas"
_COMMIT_STEP = "Commit and push"
_DISPATCH_STEP = "Dispatch Pages for pushed data"
_ENFORCE_STEP = "Enforce candidate funnel publication status"

_EXPECTED_POLICY = "p14-decision-aware-v1"
_HANDOFF_DIR_EXPRESSION = (
    "${{ runner.temp }}/candidate-funnel-p14/${{ github.run_id }}-${{ github.run_attempt }}"
)
_TWIN_PATHS = ("data/candidate_funnel.json", "public/data/candidate_funnel.json")

# Independent frozen literal of the exact 11-field producer output contract
# (reconciliation §28.6). It is deliberately NOT derived from the workflow under
# test and NOT read from any handoff file.
#   (GITHUB_OUTPUT name, consumer flag, ProducerReference field, consumer env var)
_OUTPUT_CONTRACT = (
    ("p14_transport_status", "--p14-transport-status", "status", "P14_TRANSPORT_STATUS"),
    ("p14_handoff_digest", "--p14-handoff-digest", "transportDigest", "P14_HANDOFF_DIGEST"),
    ("p14_observation_digest", "--p14-observation-digest", "observationDigest", "P14_OBSERVATION_DIGEST"),
    ("p14_receipt_digest", "--p14-receipt-digest", "receiptDigest", "P14_RECEIPT_DIGEST"),
    ("p14_capture_input_digest", "--p14-capture-input-digest", "captureInputDigest", "P14_CAPTURE_INPUT_DIGEST"),
    ("p14_executed_git_sha", "--p14-executed-git-sha", "executedGitSha", "P14_EXECUTED_GIT_SHA"),
    ("p14_observation_schema", "--p14-observation-schema", "observationSchemaVersion", "P14_OBSERVATION_SCHEMA"),
    ("p14_handoff_schema", "--p14-handoff-schema", "handoffSchemaVersion", "P14_HANDOFF_SCHEMA"),
    ("p14_policy_version", "--p14-policy-version", "policyVersion", "P14_POLICY_VERSION"),
    ("p14_run_id", "--p14-run-id", "runId", "P14_RUN_ID"),
    ("p14_run_attempt", "--p14-run-attempt", "runAttempt", "P14_RUN_ATTEMPT"),
)
_OUTPUT_NAMES = tuple(row[0] for row in _OUTPUT_CONTRACT)
_CONSUMER_FLAGS = tuple(row[1] for row in _OUTPUT_CONTRACT)
# The audited producer emits the ten reference fields first and the transport
# status line last.
_EMISSION_ROWS = _OUTPUT_CONTRACT[1:] + _OUTPUT_CONTRACT[:1]
_LEGACY_CONSUMER_FLAGS = ("--out", "--previous", "--batch-status", "--smoke-status")
_EXPECTED_ARGV_FLAGS = {
    *_LEGACY_CONSUMER_FLAGS, "--p14-handoff-dir", "--p14-expected-policy-version", *_CONSUMER_FLAGS,
}

_EXPRESSION = re.compile(r"\$\{\{\s*(.+?)\s*\}\}")

_PYTHON_STUB = """#!/usr/bin/env bash
set -e
if [ "${1:-}" = "-m" ]; then
  module="${2:-}"
  case "$module" in
    data.candidate_funnel_batch)
      cat "$STUB_PRODUCER_OUTPUT_FILE" >> "$GITHUB_OUTPUT"
      if [ "${BATCH_WRITES:-1}" = "1" ]; then
        printf '%s\\n' '{"version":"new"}' > data/candidate_funnel.json
        printf '%s\\n' '{"version":"new"}' > public/data/candidate_funnel.json
      fi
      exit "${BATCH_EXIT:-0}"
      ;;
    data.candidate_funnel_privacy_smoke)
      exit "${SMOKE_EXIT:-0}"
      ;;
    data.candidate_funnel_run_evidence)
      shift 2
      printf '%s\\0' "$@" > "$STUB_ARGV_FILE"
      exit "${CONSUMER_EXIT:-0}"
      ;;
    data.derived_per_calibration)
      exit 0
      ;;
    backend.engine.tier_a.tier_a_snapshot_writer)
      exit "${STUB_TIER_A_EXIT:-0}"
      ;;
  esac
  echo "unexpected stubbed python module: $module" >&2
  exit 97
fi
if [ "${1:-}" = "data/update_safe_mode.py" ]; then
  exit "${STUB_SAFE_MODE_EXIT:-0}"
fi
exec "$STUB_REAL_PYTHON" "$@"
"""

# H01: transport subcommands are logged and delegated to REAL git against the
# simulation's filesystem-local bare origin (no fabricated FETCH_HEAD, OID or push
# result). STUB_PUSH_EXIT injects a failure before the actual push and
# STUB_GIT_FAIL_SUBCOMMAND is a logged failure seam for any other subcommand (e.g.
# `merge-base` for the ancestor check). Pull / rebase / merge and any forced,
# deleting or mirroring push are rejected instead of reporting success.
_GIT_STUB = """#!/usr/bin/env bash
subcommand="${1:-}"
case "$subcommand" in
  pull|rebase|merge)
    printf '%s\\n' "$*" >> "$STUB_GIT_LOG"
    echo "history-unsafe git subcommand rejected by the fixture: $subcommand" >&2
    exit 98
    ;;
  push)
    printf '%s\\n' "$*" >> "$STUB_GIT_LOG"
    for argument in "$@"; do
      case "$argument" in
        -f|--force*|-d|--delete|--mirror|+*)
          echo "history-rewriting push rejected by the fixture: $argument" >&2
          exit 98
          ;;
      esac
    done
    if [ "${STUB_PUSH_EXIT:-0}" != "0" ]; then
      exit "$STUB_PUSH_EXIT"
    fi
    exec "$STUB_REAL_GIT" "$@"
    ;;
  fetch|ls-remote)
    printf '%s\\n' "$*" >> "$STUB_GIT_LOG"
    ;;
esac
if [ -n "${STUB_GIT_FAIL_SUBCOMMAND:-}" ] && [ "$subcommand" = "$STUB_GIT_FAIL_SUBCOMMAND" ]; then
  printf 'seam-fail %s\\n' "$*" >> "$STUB_GIT_LOG"
  exit 91
fi
exec "$STUB_REAL_GIT" "$@"
"""

_GH_STUB = """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_GH_LOG"
"""


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, check=True, text=True, capture_output=True)


def _mkdir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def _strict_outputs(pairs) -> dict[str, str]:
    """Harness adapter for one step's GITHUB_OUTPUT lines. Unlike the runner it
    refuses duplicate and unexpected `p14_*` reference names instead of letting
    the last writer win, so a platform quirk can never alter the 11-name set."""
    p14_names = [name for name, _value in pairs if name.startswith("p14_")]
    unexpected = sorted(set(p14_names) - set(_OUTPUT_NAMES))
    duplicated = sorted({name for name in p14_names if p14_names.count(name) > 1})
    if unexpected or duplicated:
        raise ValueError(f"unexpected={unexpected} duplicated={duplicated}")
    return dict(pairs)


class _StepResult:
    def __init__(self, name, status, returncode=None, stdout="", stderr="", output_pairs=()):
        self.name = name
        self.status = status
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.output_pairs = tuple(output_pairs)


class _JobSimulation:
    """Run real `update-data` step bodies with stub python3/git/gh boundaries.

    Modelled GitHub semantics: implicit success(), always(), step-level
    continue-on-error, a private GITHUB_OUTPUT file per step, and `${{ }}`
    expressions in step env. Nothing here reimplements publication logic: every
    status and output below is produced by the real workflow shell.
    """

    def __init__(self, tmp_path: Path, *, label: str = "sim", stub_env=None, producer_block: str = ""):
        self.root = _mkdir(tmp_path / label)
        self.repo = self.root / "worktree"
        self.runner_temp = _mkdir(self.root / "runner-temp")
        self.bin_dir = _mkdir(self.root / "bin")
        self.git_log_path = self.root / "git.log"
        self.origin = self.root / "origin.git"
        self.gh_log_path = self.root / "gh.log"
        self.argv_file = self.root / "consumer-argv"
        self.producer_file = self.root / "producer-output"
        for path in (self.git_log_path, self.gh_log_path):
            path.write_text("")
        self.producer_file.write_text(producer_block)
        self.stub_env = dict(stub_env or {})
        self.outputs: dict[str, dict[str, str]] = {}
        self.results: dict[str, _StepResult] = {}
        self.job_failed = False
        self._index = 0
        self._real_git = shutil.which("git")
        assert self._real_git is not None
        self._make_repo()
        for name, body in (("python3", _PYTHON_STUB), ("git", _GIT_STUB), ("gh", _GH_STUB)):
            stub = self.bin_dir / name
            stub.write_text(body)
            stub.chmod(0o755)

    def _make_repo(self) -> None:
        self.repo.mkdir()
        _git(self.repo, "init", "-b", "main")
        _git(self.repo, "config", "user.name", "Test User")
        _git(self.repo, "config", "user.email", "test@example.com")
        (self.repo / "data").mkdir()
        (self.repo / "public" / "data").mkdir(parents=True)
        for relative in _TWIN_PATHS:
            (self.repo / relative).write_text('{"version":"committed"}\n')
        (self.repo / "data" / "unrelated.json").write_text('{"version":"old"}\n')
        _git(self.repo, "add", "data/", "public/data/")
        _git(self.repo, "commit", "-m", "baseline")
        self.baseline_head = _git(self.repo, "rev-parse", "HEAD").stdout.strip()
        # H01: exclusive filesystem-local bare origin seeded at the exact baseline
        # head. Bootstrap uses real git outside the workflow transport log.
        _git(self.root, "init", "--bare", "-b", "main", str(self.origin))
        _git(self.repo, "remote", "add", "origin", str(self.origin))
        _git(self.repo, "push", "origin", "main:refs/heads/main")
        assert self.origin_head() == self.baseline_head

    # -- expression / condition model ------------------------------------
    def _lookup(self, expression: str) -> str:
        expression = expression.strip()
        context = {
            "runner.temp": str(self.runner_temp),
            "github.run_id": SYN_RUN["runId"],
            "github.run_attempt": SYN_RUN["runAttempt"],
            "github.token": "stub-token",
            "github.ref": "refs/heads/main",
        }
        if expression in context:
            return context[expression]
        match = re.fullmatch(r"steps\.([\w-]+)\.outputs\.(\w+)", expression)
        if match is not None:
            return self.outputs.get(match.group(1), {}).get(match.group(2), "")
        raise AssertionError(f"unsupported expression: {expression}")

    def _resolve(self, value) -> str:
        if not isinstance(value, str):
            return str(value)
        return _EXPRESSION.sub(lambda match: self._lookup(match.group(1)), value)

    def _condition(self, raw) -> tuple[bool, bool]:
        """Return (status-check function present, condition value)."""
        if raw is None:
            return False, True
        expression = _EXPRESSION.sub(lambda match: match.group(1), raw).strip()
        always = False
        selected = True
        for term in (part.strip() for part in expression.split("&&")):
            if term == "always()":
                always = True
            elif term == "!cancelled()":
                continue
            else:
                match = re.fullmatch(r"(steps\.[\w-]+\.outputs\.\w+|github\.ref) == '([^']*)'", term)
                assert match is not None, f"unsupported condition term: {term}"
                if self._lookup(match.group(1)) != match.group(2):
                    selected = False
        return always, selected

    def would_run(self, name: str) -> bool:
        always, selected = self._condition(_STEPS_BY_NAME[name].get("if"))
        return selected and (always or not self.job_failed)

    # -- execution ----------------------------------------------------------
    def run(self, name: str, *, force: str | None = None, extra_env=None) -> _StepResult:
        step = _STEPS_BY_NAME[name]
        if not self.would_run(name):
            result = _StepResult(name, "skipped")
        elif force is not None:
            result = _StepResult(name, force)
        else:
            assert "run" in step, f"{name} is a uses: step; evaluate it with would_run()"
            result = self._execute(step, extra_env or {})
        if result.status == "failure" and step.get("continue-on-error") is not True:
            self.job_failed = True
        self.results[name] = result
        return result

    def _execute(self, step, extra_env) -> _StepResult:
        self._index += 1
        env = os.environ.copy()
        env["PATH"] = f"{self.bin_dir}{os.pathsep}{env['PATH']}"
        env.update(
            GITHUB_REPOSITORY="example/jp-portfolio", GITHUB_REF="refs/heads/main",
            GITHUB_REF_NAME="main", GITHUB_REF_TYPE="branch",
            GITHUB_RUN_ID=SYN_RUN["runId"], GITHUB_RUN_ATTEMPT=SYN_RUN["runAttempt"],
            RUNNER_TEMP=str(self.runner_temp),
            STUB_REAL_PYTHON=sys.executable, STUB_REAL_GIT=str(self._real_git),
            STUB_PRODUCER_OUTPUT_FILE=str(self.producer_file), STUB_ARGV_FILE=str(self.argv_file),
            STUB_GIT_LOG=str(self.git_log_path), STUB_GH_LOG=str(self.gh_log_path),
        )
        env.update({key: self._resolve(value) for key, value in (_JOB.get("env") or {}).items()})
        env.update({key: self._resolve(value) for key, value in (step.get("env") or {}).items()})
        env.update(self.stub_env)
        env.update(extra_env)
        output_path = self.root / f"github-output-{self._index}"
        output_path.write_text("")
        env["GITHUB_OUTPUT"] = str(output_path)
        script = step["run"]
        assert "${{" not in script, "expression text must never be inserted into shell code"
        script_path = self.root / f"step-{self._index}.sh"
        script_path.write_text(script if script.endswith("\n") else script + "\n")
        shell = (
            ["bash", "--noprofile", "--norc", "-eo", "pipefail"]
            if step.get("shell") == "bash" else ["bash", "-e"]
        )
        completed = subprocess.run(
            [*shell, str(script_path)], cwd=self.repo, env=env, text=True, capture_output=True,
        )
        pairs = [
            tuple(line.split("=", 1))
            for line in output_path.read_text().splitlines() if "=" in line
        ]
        outputs = _strict_outputs(pairs)
        if "id" in step:
            self.outputs.setdefault(step["id"], {}).update(outputs)
        return _StepResult(
            step["name"], "success" if completed.returncode == 0 else "failure",
            completed.returncode, completed.stdout, completed.stderr, pairs,
        )

    # -- observations ---------------------------------------------------------
    def consumer_argv(self) -> list[str]:
        data = self.argv_file.read_bytes().decode("utf-8")
        assert data.endswith("\0")
        return data.split("\0")[:-1]

    def git_log(self) -> list[str]:
        return self.git_log_path.read_text().splitlines()

    def origin_head(self) -> str:
        return _git(self.origin, "rev-parse", "refs/heads/main").stdout.strip()

    def gh_log(self) -> list[str]:
        return self.gh_log_path.read_text().splitlines()

    @property
    def handoff_root(self) -> Path:
        return self.runner_temp / "candidate-funnel-p14" / f"{SYN_RUN['runId']}-{SYN_RUN['runAttempt']}"


def _producer_block(reference_value, *, drop=(), only=None, override=None) -> str:
    """Producer GITHUB_OUTPUT text in the audited emission order."""
    lines = []
    for name, _flag, field, _env in _EMISSION_ROWS:
        if name in drop or (only is not None and name not in only):
            continue
        value = (override or {}).get(name, reference_value[field])
        lines.append(f"{name}={value}\n")
    return "".join(lines)


def _assert_argv_mapping(sim: _JobSimulation, argv: list[str], reference_value) -> None:
    flags = {item for item in argv if item.startswith("--")}
    assert flags == _EXPECTED_ARGV_FLAGS
    assert all(argv.count(flag) == 1 for flag in flags)
    for _name, flag, field, _env in _OUTPUT_CONTRACT:
        assert argv[argv.index(flag) + 1] == reference_value[field]
    assert argv[argv.index("--p14-expected-policy-version") + 1] == _EXPECTED_POLICY
    assert argv[argv.index("--p14-handoff-dir") + 1] == str(sim.handoff_root)


def _every_dollar_is_double_quoted(command: str) -> bool:
    """True when every shell-variable `$` sits inside a double-quoted region."""
    quoted = False
    for character in command:
        if character == '"':
            quoted = not quoted
        elif character == "$" and not quoted:
            return False
    return not quoted


def _replace_option(argv: list[str], flag: str, value: str) -> list[str]:
    result = list(argv)
    result[result.index(flag) + 1] = value
    return result


def _enable_consumer_environment(monkeypatch) -> None:
    """Test-only injected enabled mode; the repository workflow stays disabled."""
    monkeypatch.setenv("P14_HANDOFF_MODE", "enabled")
    for field, name in {
        "repository": "GITHUB_REPOSITORY", "job": "GITHUB_JOB", "runId": "GITHUB_RUN_ID",
        "runAttempt": "GITHUB_RUN_ATTEMPT", "event": "GITHUB_EVENT_NAME", "gitRef": "GITHUB_REF",
        "gitRefType": "GITHUB_REF_TYPE", "gitSha": "GITHUB_SHA",
    }.items():
        monkeypatch.setenv(name, SYN_RUN[field])
    monkeypatch.setenv("RUNNER_OS", "Linux")
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)


def _run_real_consumer(tmp_path, monkeypatch, kwargs, workflow_argv, *, label, handoff_root=None):
    """Feed the argv delivered by the workflow's own consumer command line to the
    real schema-3 consumer, replacing only runner-temp locations with the
    synthetic fixture locations."""
    raw = kwargs["raw_paths"]
    out = tmp_path / f"consumer-{label}"
    argv = _replace_option(workflow_argv, "--out", str(out))
    argv = _replace_option(argv, "--previous", str(raw["previousArtifact"]))
    argv = _replace_option(
        argv, "--p14-handoff-dir", str(handoff_root if handoff_root is not None else kwargs["handoff_root"]),
    )
    argv += [
        "--candidates", str(raw["candidatesStocks"]), "--prescreen", str(raw["prescreenMetadata"]),
        "--regime", str(raw["regimeState"]),
    ]
    _enable_consumer_environment(monkeypatch)
    monkeypatch.setattr(evidence_mod, "_consumer_identity", lambda root: kwargs["consumer"])
    status = evidence_mod.main(argv)
    files = bundle.read_bundle_directory(
        out / f"candidate-funnel-evidence-{SYN_RUN['runId']}-{SYN_RUN['runAttempt']}"
    )
    return status, files


def _assert_invalid_evidence(files, *, code=None, stage=None):
    value = _syn_evidence(files)
    assert value["captureStatus"] == "invalid"
    if code is not None:
        assert value["failure"]["code"] == code
    if stage is not None:
        assert value["failure"]["stage"] == stage
    # An invalid bundle never carries a terminal, attachments or publication facts.
    assert not {"terminal", "attachments", "p14", "replay", "publish"} & set(value)
    report = bundle.verify_bundle_files(files)
    assert report.bundle_integrity == "PASS" and report.capture_validity == "INVALID"
    assert report.terminal_status is None and report.artifact_available is None
    return value


def _assert_twins_committed(sim: _JobSimulation) -> None:
    for relative in _TWIN_PATHS:
        assert (sim.repo / relative).read_text() == '{"version":"committed"}\n'
        subprocess.run(["git", "diff", "--quiet", "HEAD", "--", relative], cwd=sim.repo, check=True)
    _git(sim.repo, "add", "data/", "public/data/")
    assert _git(sim.repo, "diff", "--cached", "--name-only").stdout == ""


def _publication_states(sim: _JobSimulation) -> dict[str, str]:
    """Distinct publication states derived only from what the real steps did."""
    enforce = sim.results.get(_ENFORCE_STEP)
    commit = sim.results.get(_COMMIT_STEP)
    dispatch = sim.results.get(_DISPATCH_STEP)
    commit_outputs = sim.outputs.get("commit-push", {})
    gates = (
        enforce is not None and enforce.status == "success"
        and "Candidate funnel publication gates passed" in enforce.stdout
    )
    pushed = (
        commit is not None and commit.status == "success"
        and commit_outputs.get("data_changed") == "true"
        and re.fullmatch(r"[0-9a-f]{40}", commit_outputs.get("pushed_sha", "")) is not None
    )
    dispatched = dispatch is not None and dispatch.status == "success" and bool(sim.gh_log())
    deployment_observed = any(re.match(r"(run|api|deployment)", line) for line in sim.gh_log())
    states = {
        "PUBLICATION_GATES_PASSED": "YES" if gates else "NO",
        "REMOTE_PUSH_CONFIRMED": "YES" if pushed else "NO",
        "PAGES_DISPATCH_REQUESTED": "YES" if dispatched else "NO",
        "PAGES_DEPLOYED": "OBSERVED" if deployment_observed else "UNKNOWN",
    }
    states["COMPLETION"] = (
        "CONFIRMED" if states["PUBLICATION_GATES_PASSED"] == "YES" and states["REMOTE_PUSH_CONFIRMED"] == "YES"
        else "NOT_CONFIRMED"
    )
    return states


def _run_failed_batch_chain(sim: _JobSimulation) -> None:
    """Build -> Smoke(skipped) -> Enforce; asserts the invariant N-PUB-1..4 share."""
    build = sim.run(_BUILD_STEP)
    assert build.returncode == 0, build.stderr  # the wrapper reports failure via output, not exit
    assert sim.outputs["candidate-funnel-build"]["publication_status"] == "batch_failed"
    assert sim.would_run(_SMOKE_STEP) is False
    assert sim.run(_SMOKE_STEP).status == "skipped"
    _assert_twins_committed(sim)
    enforce = sim.run(_ENFORCE_STEP)
    assert enforce.status == "failure" and enforce.returncode == 1
    assert "P-01..P-15 batch gate" in enforce.stderr
    assert _publication_states(sim)["PUBLICATION_GATES_PASSED"] == "NO"


def _run_publication_tail(sim: _JobSimulation) -> None:
    """Build/Smoke pass, then SAFE_MODE/TierA, shared commit/push, Pages, enforcement."""
    assert sim.run(_BUILD_STEP).status == "success"
    assert sim.run(_SMOKE_STEP).status == "success"
    sim.run(_SAFE_MODE_BUILD_STEP)
    sim.run(_SAFE_MODE_SMOKE_STEP, force="success")
    sim.run(_TIER_A_BUILD_STEP)
    sim.run(_TIER_A_SMOKE_STEP, force="success")
    sim.run(_COMMIT_STEP)
    sim.run(_DISPATCH_STEP)
    sim.run(_ENFORCE_STEP)


def _make_attempt_tree(sim: _JobSimulation) -> Path:
    """Create the audited nested handoff layout under the configured attempt root."""
    handoff.claim_attempt(sim.handoff_root, SYN_RUN["runId"], SYN_RUN["runAttempt"])
    attempt_dir = sim.handoff_root / f"run-{SYN_RUN['runId']}" / f"attempt-{SYN_RUN['runAttempt']}"
    assert attempt_dir.is_dir()
    for name in ("capture-input.json", "batch-receipt.json", "handoff.json", f"observation-{'a' * 64}.json"):
        (attempt_dir / name).write_text("{}")
    return sim.handoff_root


def _make_bundle_and_neighbours(sim: _JobSimulation) -> None:
    bundle_dir = sim.runner_temp / "candidate-funnel-evidence" / "bundle" / "candidate-funnel-evidence-900000031-1"
    _mkdir(bundle_dir)
    (bundle_dir / "evidence.json").write_text("{}")
    (sim.runner_temp / "candidate-funnel-evidence" / "previous-artifact.json").write_text("{}")
    (sim.runner_temp / "unrelated.txt").write_text("runner temp neighbour")
    parent = sim.runner_temp / "candidate-funnel-p14"
    (parent / "unrelated.txt").write_text("parent neighbour")
    for other in ("900000031-2", "900000030-1"):
        nested = _mkdir(parent / other / "run-x" / "attempt-y")
        (nested / "handoff.json").write_text("{}")


def _snapshot(root: Path) -> dict[str, tuple]:
    entries: dict[str, tuple] = {}
    for current, directories, files in os.walk(root, followlinks=False):
        for name in [*directories, *files]:
            path = Path(current) / name
            relative = path.relative_to(root).as_posix()
            if path.is_symlink():
                entries[relative] = ("link", os.readlink(path))
            elif path.is_dir():
                entries[relative] = ("dir", None)
            else:
                entries[relative] = ("file", path.read_bytes())
    return entries


# ── shared mode, same-job topology, mapping ───────────────────────────────


def test_production_mode_shared_and_literal_enabled():
    assert _JOB["env"] == {"P14_HANDOFF_MODE": "enabled"}
    assert _TEXT.count("P14_HANDOFF_MODE") == 1
    assert _TEXT.count("      P14_HANDOFF_MODE: enabled\n") == 1
    for job_name, job in _DOC["jobs"].items():
        if job_name != "update-data":
            assert "P14_HANDOFF_MODE" not in (job.get("env") or {})
    # No step overrides the shared mode, and nothing makes it configurable.
    for step in _JOB["steps"]:
        assert "P14_HANDOFF_MODE" not in (step.get("env") or {})
    assert re.search(r"\$\{\{[^}]*\b(inputs|vars)\.", _TEXT) is None
    triggers = _DOC.get("on", _DOC.get(True))
    assert "inputs" not in (triggers.get("workflow_dispatch") or {})
    # Producer step: root and policy are set; the mode is only inherited.
    producer = _STEPS_BY_NAME[_BUILD_STEP]
    assert producer["env"] == {
        "P14_HANDOFF_DIR": _HANDOFF_DIR_EXPRESSION,
        "P14_EXPECTED_POLICY_VERSION": _EXPECTED_POLICY,
    }


def test_same_job_transport_and_exact_reference_cli_mapping():
    # Same job / runner / checkout topology.
    assert list(_DOC["jobs"]) == ["safe-start-guard", "operation-health", "update-data", "routines-stub"]
    assert _JOB["runs-on"] == "ubuntu-latest" and _JOB["needs"] == ["operation-health"]
    for job_name, job in _DOC["jobs"].items():
        commands = "\n".join(step.get("run", "") for step in job["steps"])
        expected_here = job_name == "update-data"
        assert ("data.candidate_funnel_batch" in commands) is expected_here
        assert ("data.candidate_funnel_run_evidence" in commands) is expected_here
    names = [step.get("name") for step in _JOB["steps"]]
    assert names.index(_BUILD_STEP) < names.index(_CAPTURE_STEP)
    producer = _STEPS_BY_NAME[_BUILD_STEP]
    consumer = _STEPS_BY_NAME[_CAPTURE_STEP]
    assert producer["id"] == "candidate-funnel-build"
    # Producer command is exactly the pre-existing one (no flags added).
    assert [line.strip() for line in producer["run"].splitlines()].count("python3 -m data.candidate_funnel_batch") == 1
    # Consumer env: legacy status vars, the same attempt root and 11 build outputs, each
    # populated only from steps.candidate-funnel-build.outputs.<name>.
    expected_env = {
        "CANDIDATE_FUNNEL_BATCH_STATUS": "${{ steps.candidate-funnel-build.outputs.publication_status }}",
        "CANDIDATE_FUNNEL_SMOKE_STATUS": "${{ steps.candidate-funnel-smoke.outputs.publication_status }}",
        "P14_HANDOFF_DIR": _HANDOFF_DIR_EXPRESSION,
        **{env: f"${{{{ steps.candidate-funnel-build.outputs.{name} }}}}" for name, _f, _r, env in _OUTPUT_CONTRACT},
    }
    assert consumer["env"] == expected_env
    assert consumer["env"]["P14_HANDOFF_DIR"] == producer["env"]["P14_HANDOFF_DIR"]
    assert consumer["if"] == "always()" and consumer["continue-on-error"] is True
    # Consumer CLI: exact token sequence; every variable is a quoted shell variable.
    run = consumer["run"]
    assert "${{" not in run
    tokens = shlex.split(run)
    expected_tokens = [
        "python3", "-m", "data.candidate_funnel_run_evidence",
        "--out", "$RUNNER_TEMP/candidate-funnel-evidence/bundle",
        "--previous", "$RUNNER_TEMP/candidate-funnel-evidence/previous-artifact.json",
        "--batch-status", "$CANDIDATE_FUNNEL_BATCH_STATUS",
        "--smoke-status", "$CANDIDATE_FUNNEL_SMOKE_STATUS",
        "--p14-handoff-dir", "$P14_HANDOFF_DIR",
        "--p14-expected-policy-version", _EXPECTED_POLICY,
    ]
    for _name, flag, _field, env in _OUTPUT_CONTRACT:
        expected_tokens += [flag, f"${env}"]
    assert tokens == expected_tokens
    assert _every_dollar_is_double_quoted(run)
    # The consumer actually accepts exactly these flags (names come from the real CLI).
    consumer_source = inspect.getsource(evidence_mod.main)
    for _name, flag, _field, _env in _OUTPUT_CONTRACT:
        assert f'"{flag[len("--p14-"):]}"' in consumer_source
    assert "--p14-handoff-dir" in consumer_source and "--p14-expected-policy-version" in consumer_source


# ── cleanup ────────────────────────────────────────────────────────────────


def test_cleanup_exact_attempt_root_after_bundle_upload(tmp_path):
    names = [step.get("name") for step in _JOB["steps"]]
    position = names.index(_CLEANUP_STEP)
    assert names[position - 1] == _UPLOAD_STEP
    assert names[position + 1] == _DERIVED_PER_UPLOAD_STEP
    cleanup = _STEPS_BY_NAME[_CLEANUP_STEP]
    assert cleanup["if"] == "always()" and cleanup["continue-on-error"] is True
    assert "uses" not in cleanup and "env" not in cleanup
    # Only the bundle directory is uploaded: no transport / raw-input directory.
    upload = _STEPS_BY_NAME[_UPLOAD_STEP]
    assert upload["with"]["path"] == "${{ runner.temp }}/candidate-funnel-evidence/bundle/"
    assert "candidate-funnel-p14" not in str(upload["with"])
    # Behavior: the whole configured attempt root (including the audited nested
    # run-<id>/attempt-<n> content) is removed and nothing else is.
    sim = _JobSimulation(tmp_path)
    root = _make_attempt_tree(sim)
    _make_bundle_and_neighbours(sim)
    assert (root / f"run-{SYN_RUN['runId']}" / f"attempt-{SYN_RUN['runAttempt']}" / "handoff.json").is_file()
    result = sim.run(_CLEANUP_STEP)
    assert result.status == "success", result.stderr
    assert not root.exists()
    assert (sim.runner_temp / "candidate-funnel-p14").is_dir()
    assert sim.runner_temp.is_dir()


@pytest.mark.parametrize("scenario", [
    "valid_attempt_root",
    "missing_attempt_root",
    "missing_handoff_parent",
    "relative_runner_temp",
    "run_id_zero",
    "run_id_leading_zero",
    "run_id_alpha",
    "run_id_path",
    "attempt_empty",
    "attempt_negative",
    "symlinked_attempt_root",
    "symlinked_handoff_parent",
])
def test_cleanup_preserves_bundle_and_other_attempts(tmp_path, scenario):
    sim = _JobSimulation(tmp_path)
    parent = sim.runner_temp / "candidate-funnel-p14"
    outside = _mkdir(sim.root / "outside")
    (outside / "sentinel.txt").write_text("must survive")
    _make_attempt_tree(sim)
    _make_bundle_and_neighbours(sim)
    extra_env: dict[str, str] = {}
    expect_success = True
    removed_prefix = None
    if scenario == "valid_attempt_root":
        removed_prefix = "candidate-funnel-p14/900000031-1"
    elif scenario == "missing_attempt_root":
        shutil.rmtree(sim.handoff_root)
    elif scenario == "missing_handoff_parent":
        shutil.rmtree(parent)
    elif scenario == "relative_runner_temp":
        extra_env, expect_success = {"RUNNER_TEMP": "relative-temp"}, False
    elif scenario == "run_id_zero":
        extra_env, expect_success = {"GITHUB_RUN_ID": "0"}, False
    elif scenario == "run_id_leading_zero":
        extra_env, expect_success = {"GITHUB_RUN_ID": "0900000031"}, False
    elif scenario == "run_id_alpha":
        extra_env, expect_success = {"GITHUB_RUN_ID": "abc"}, False
    elif scenario == "run_id_path":
        extra_env, expect_success = {"GITHUB_RUN_ID": "900000031/../900000030"}, False
    elif scenario == "attempt_empty":
        extra_env, expect_success = {"GITHUB_RUN_ATTEMPT": ""}, False
    elif scenario == "attempt_negative":
        extra_env, expect_success = {"GITHUB_RUN_ATTEMPT": "-1"}, False
    elif scenario == "symlinked_attempt_root":
        shutil.rmtree(sim.handoff_root)
        sim.handoff_root.symlink_to(outside, target_is_directory=True)
        expect_success = False
    elif scenario == "symlinked_handoff_parent":
        shutil.rmtree(parent)
        _mkdir(outside / "900000031-1")
        (outside / "900000031-1" / "sentinel.txt").write_text("must survive")
        parent.symlink_to(outside, target_is_directory=True)
        expect_success = False
    before_runner_temp = _snapshot(sim.runner_temp)
    before_outside = _snapshot(outside)
    result = sim.run(_CLEANUP_STEP, extra_env=extra_env)
    assert (result.status == "success") is expect_success, result.stderr
    if not expect_success:
        assert "P14 handoff cleanup:" in result.stderr
    # Anything outside the validated attempt root is byte-for-byte untouched.
    expected = {
        key: value for key, value in before_runner_temp.items()
        if removed_prefix is None or not (key == removed_prefix or key.startswith(removed_prefix + "/"))
    }
    assert _snapshot(sim.runner_temp) == expected
    assert _snapshot(outside) == before_outside
    assert sim.runner_temp.is_dir()
    assert (sim.runner_temp / "candidate-funnel-evidence" / "previous-artifact.json").is_file()
    assert (
        sim.runner_temp / "candidate-funnel-evidence" / "bundle"
        / "candidate-funnel-evidence-900000031-1" / "evidence.json"
    ).is_file()
    if scenario in {"valid_attempt_root", "missing_attempt_root"}:
        assert (parent / "900000031-2").is_dir() and (parent / "900000030-1").is_dir()
        assert (parent / "unrelated.txt").read_text() == "parent neighbour"


# An existing path of the wrong type is invalid input (non-zero), never the same
# thing as a genuinely absent path (already-cleaned, exit 0).


def test_cleanup_rejects_handoff_parent_that_is_a_regular_file(tmp_path):
    """REG-CLEANUP-PARENT-FILE"""
    sim = _JobSimulation(tmp_path)
    outside = _mkdir(sim.root / "outside")
    (outside / "sentinel.txt").write_text("must survive")
    _make_attempt_tree(sim)
    _make_bundle_and_neighbours(sim)
    parent = sim.runner_temp / "candidate-funnel-p14"
    shutil.rmtree(parent)
    parent.write_text("not a directory")
    before_runner_temp = _snapshot(sim.runner_temp)
    before_outside = _snapshot(outside)
    result = sim.run(_CLEANUP_STEP)
    assert result.status == "failure" and result.returncode != 0, result.stderr
    assert "P14 handoff cleanup: HANDOFF_PARENT_NOT_DIRECTORY" in result.stderr
    assert parent.is_file() and parent.read_text() == "not a directory"
    assert _snapshot(sim.runner_temp) == before_runner_temp
    assert _snapshot(outside) == before_outside
    assert (outside / "sentinel.txt").read_text() == "must survive"


def test_cleanup_rejects_runner_temp_that_is_a_regular_file(tmp_path):
    """REG-CLEANUP-RUNNER-TEMP-FILE"""
    sim = _JobSimulation(tmp_path)
    outside = _mkdir(sim.root / "outside")
    (outside / "sentinel.txt").write_text("must survive")
    runner_temp_file = sim.root / "runner-temp-file"
    runner_temp_file.write_text("not a directory")
    before_outside = _snapshot(outside)
    result = sim.run(_CLEANUP_STEP, extra_env={"RUNNER_TEMP": str(runner_temp_file)})
    assert result.status == "failure" and result.returncode != 0, result.stderr
    assert "P14 handoff cleanup: RUNNER_TEMP_NOT_DIRECTORY" in result.stderr
    assert runner_temp_file.is_file() and runner_temp_file.read_text() == "not a directory"
    assert _snapshot(outside) == before_outside
    assert (outside / "sentinel.txt").read_text() == "must survive"


# ── publication predicates exclude transport/evidence signals ───────────────


def _dump(step) -> str:
    return yaml.safe_dump(step, width=10**9)


def test_publication_predicates_exclude_transport_and_evidence_signals():
    users_of_p14_outputs = [
        step["name"] for step in _JOB["steps"] if "outputs.p14_" in _dump(step)
    ]
    assert users_of_p14_outputs == [_CAPTURE_STEP]
    # No condition, env or shell of any step consumes the evidence step's outputs or ids.
    for step in _JOB["steps"]:
        serialized = _dump(step)
        assert "steps.candidate-funnel-evidence" not in serialized, step.get("name")
        assert "bundle_path" not in serialized, step.get("name")
        for key in ("if",):
            condition = str(step.get(key, ""))
            assert "p14" not in condition.lower() and "evidence" not in condition.lower(), step.get("name")
    # The publication-affecting steps never mention the schema-3 transport at all.
    for name in (_COMMIT_STEP, _DISPATCH_STEP, _ENFORCE_STEP, _SMOKE_STEP):
        serialized = _dump(_STEPS_BY_NAME[name])
        assert "p14" not in serialized.lower(), name
        for token in ("overallPass", "VALID", "READY", "transportStatus"):
            assert re.search(rf"\b{token}\b", serialized) is None, (name, token)
    # Enforcement is still fed by exactly the batch/smoke publication status chain.
    assert _STEPS_BY_NAME[_ENFORCE_STEP]["env"] == {
        "CANDIDATE_FUNNEL_BATCH_STATUS": "${{ steps.candidate-funnel-build.outputs.publication_status }}",
        "CANDIDATE_FUNNEL_SMOKE_STATUS": "${{ steps.candidate-funnel-smoke.outputs.publication_status }}",
    }
    assert _STEPS_BY_NAME[_SMOKE_STEP]["if"] == (
        "${{ steps.candidate-funnel-build.outputs.publication_status == 'batch_passed' }}"
    )
    assert "if" not in _STEPS_BY_NAME[_COMMIT_STEP]
    assert _STEPS_BY_NAME[_DISPATCH_STEP]["if"] == (
        "${{ steps.commit-push.outputs.data_changed == 'true' && github.ref == 'refs/heads/main' }}"
    )
    # The offline schema-3 verifier is never a workflow gate.
    assert "p14_run_evidence_bundle" not in _TEXT


_COMMIT_HISTORY_COMMANDS = (
    "git rev-parse --verify 'HEAD^{commit}'",  # push base X, bound before any data commit
    'git add data/ public/data/',
    "git commit -m ",
    "git rev-list --parents -n 1",  # Y is X or exactly one single-parent child of X
    'git fetch --no-tags origin "$target_ref"',
    "git rev-parse --verify 'FETCH_HEAD^{commit}'",
    "git merge-base --is-ancestor",
    'git push origin "HEAD:$target_ref"',
    'git ls-remote --exit-code --refs origin "$target_ref"',
    'echo "data_changed=true" >> "$GITHUB_OUTPUT"',
    'echo "pushed_sha=$proposed_push_sha" >> "$GITHUB_OUTPUT"',
)


def _assert_commit_block_is_history_safe(run: str) -> None:
    """H01 oracle: active commands only (a comment never satisfies it)."""
    active = [
        line.strip() for line in run.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    for forbidden in (
        "git pull", "rebase", "git merge ", "git reset", "--force", "--amend", "--delete",
    ):
        assert not any(forbidden in line for line in active), forbidden
    positions = []
    for command in _COMMIT_HISTORY_COMMANDS:
        found = [index for index, line in enumerate(active) if command in line]
        assert found, command
        positions.append(found[0])
    assert all(earlier < later for earlier, later in zip(positions, positions[1:])), positions
    assert sum('git push origin "HEAD:$target_ref"' in line for line in active) == 1
    # Both equality (fetched tip == bound base) and ancestry are mandatory, and an
    # unobservable or unequal post-push remote is an unconfirmed outcome, not success.
    assert 'if [ "$fetched_tip" != "$push_base_sha" ]; then' in active
    assert 'if ! git merge-base --is-ancestor "$fetched_tip" "$proposed_push_sha"; then' in active
    assert any("PUSH_OUTCOME_UNCONFIRMED" in line for line in active)
    assert any('"$observed_sha" != "$proposed_push_sha"' in line for line in active)


_PINNED_RUN_BODY_SHA256 = {
    _BUILD_STEP: "e451077c9900b65ff05052c83012d482bd18e9907a9ededa6a516d5bcfdc0339",
    _SMOKE_STEP: "974139a0212e54fc9c78b653af1777466305a1e1214e1c02dfd616c749f1bc44",
    # H01 re-pin of the Commit run body (history-safe replacement of pull/rebase);
    # old 4fdf18961ca265109c8f8ecc80ef88ec4046fcd0ec9af258253d82a5465bc97f
    _COMMIT_STEP: "a7287258bce409f403c8f82d1aef669693c29d4575eb0273b6a3dde356e4e566",
    _DISPATCH_STEP: "e9365724733bfa059d38b4d442805c32fd077552920929b01d47c7c8d2e3c837",
    _ENFORCE_STEP: "874309ae7464ccb4c09eb03b9018b24a8096751fa0018246b06ed06969e98213",
}


def test_original_publication_rollback_and_final_enforcement_subblocks_preserved():
    """Shell bodies of the publication chain are byte-identical to C0 (the new
    wiring only adds env/args/steps AROUND them), except the Commit run body, which
    H01 replaced with the reviewed history-safe sequence (asserted structurally
    below). The full-step historical BASE comparison lives in
    tests/test_late_run_guard_workflows.py."""
    for name, expected in _PINNED_RUN_BODY_SHA256.items():
        assert hashlib.sha256(_STEPS_BY_NAME[name]["run"].encode()).hexdigest() == expected, name
    assert _ENFORCE_STEP_EXPECTED in _TEXT
    assert _DOC["permissions"] == {"contents": "write", "actions": "write"}
    build_body = _STEPS_BY_NAME[_BUILD_STEP]["run"]
    assert build_body.count("python3 -m data.candidate_funnel_batch\n") == 1
    for marker in (
        "publication_status=batch_failed", "publication_status=batch_passed",
        "restore_committed_funnel", "verify_committed_funnel",
        "Candidate funnel rollback verification failed; refusing unrelated data commit",
    ):
        assert marker in build_body
    assert 'echo "publication_status=smoke_passed"' in _STEPS_BY_NAME[_SMOKE_STEP]["run"]
    _assert_commit_block_is_history_safe(_STEPS_BY_NAME[_COMMIT_STEP]["run"])


# ── N-PUB-1..6 ───────────────────────────────────────────────────────────────


def test_n_pub_1_sv_ready_overall_pass_cannot_publish(tmp_path):
    kwargs, parts, reference = _syn_fixture(
        _mkdir(tmp_path / "fixture"), terminal="SCHEMA_VIOLATIONS", status="PASS", dropped=0,
    )
    receipt = parts.receipt_value()
    assert receipt["transportStatus"] == "READY"
    assert receipt["report"]["qualityGate"]["overallPass"] is True
    assert receipt["artifactAvailable"] is False
    assert reference.status == "READY"
    sim = _JobSimulation(
        tmp_path, stub_env={"BATCH_EXIT": "1", "BATCH_WRITES": "1"},
        producer_block=_producer_block(reference.to_value()),
    )
    _run_failed_batch_chain(sim)
    # The producer-side READY reference is delivered but is not a publication signal.
    assert sim.outputs["candidate-funnel-build"]["p14_transport_status"] == "READY"
    assert sim.outputs["candidate-funnel-build"]["publication_status"] == "batch_failed"


@pytest.mark.parametrize("case", [
    pytest.param("p14_hard", id="p14_hard"),
    pytest.param("non_p14_qgf", id="non_p14_qgf"),
])
def test_n_pub_2_qgf_cannot_publish(tmp_path, case):
    if case == "p14_hard":
        kwargs, parts, reference = _syn_fixture(
            _mkdir(tmp_path / "fixture"), terminal="QUALITY_GATE_FAILED", status="FAIL", dropped=2,
        )
    else:
        kwargs, parts, reference = _syn_fixture(
            _mkdir(tmp_path / "fixture"), terminal="QUALITY_GATE_FAILED", status="PASS", dropped=0, fail_id="P-10",
        )
    quality = parts.receipt_value()["report"]["qualityGate"]
    gate_status = {gate["id"]: gate["status"] for gate in quality["gates"]}
    assert quality["overallPass"] is False
    if case == "p14_hard":
        assert quality["hardFailIds"] == ["P-14"] and gate_status["P-14"] == "FAIL"
    else:
        assert quality["hardFailIds"] == ["P-10"]
        assert gate_status["P-10"] == "FAIL" and gate_status["P-14"] == "PASS"
        assert "P-14" not in quality["hardFailIds"]
    sim = _JobSimulation(
        tmp_path, stub_env={"BATCH_EXIT": "1", "BATCH_WRITES": "1"},
        producer_block=_producer_block(reference.to_value()),
    )
    _run_failed_batch_chain(sim)


@pytest.mark.parametrize("twins", [
    pytest.param("0", id="unchanged_twins"),
    pytest.param("1", id="verified_rollback"),
])
def test_n_pub_3_wrapper_zero_preserves_batch_failure(tmp_path, twins):
    sim = _JobSimulation(tmp_path, stub_env={"BATCH_EXIT": "23", "BATCH_WRITES": twins})
    build = sim.run(_BUILD_STEP)
    assert build.returncode == 0 and build.status == "success"
    assert ("committed twins remain unchanged" if twins == "0" else "safely rolled back") in build.stderr
    assert sim.outputs["candidate-funnel-build"]["publication_status"] == "batch_failed"
    _assert_twins_committed(sim)
    assert sim.run(_SMOKE_STEP).status == "skipped"
    enforce = sim.run(_ENFORCE_STEP)
    assert enforce.returncode == 1 and "P-01..P-15 batch gate" in enforce.stderr


@pytest.mark.parametrize("terminal,status,dropped", [
    pytest.param("QUALITY_GATE_FAILED", "FAIL", 2, id="qgf"),
    pytest.param("SCHEMA_VIOLATIONS", "PASS", 0, id="sv"),
])
def test_n_pub_4_valid_failure_evidence_is_not_publication(tmp_path, capsys, terminal, status, dropped):
    kwargs, _parts, reference = _syn_fixture(
        _mkdir(tmp_path / "fixture"), terminal=terminal, status=status, dropped=dropped,
    )
    files = evidence_mod.build_evidence_from_handoff(**kwargs)
    installed = bundle.install_bundle(tmp_path / "immutable", files)
    capsys.readouterr()
    # The actual offline schema-3 verifier accepts the failure bundle (exit 0, VALID)...
    assert bundle.main(["verify", str(installed)]) == 0
    verdict = json.loads(capsys.readouterr().out)
    assert verdict["bundleIntegrity"] == "PASS" and verdict["captureValidity"] == "VALID"
    assert verdict["terminalStatus"] == terminal and verdict["artifactAvailable"] is False
    # ...yet the existing publication chain remains failed, with no substitution.
    sim = _JobSimulation(
        tmp_path, stub_env={"BATCH_EXIT": "1", "BATCH_WRITES": "1"},
        producer_block=_producer_block(reference.to_value()),
    )
    _run_failed_batch_chain(sim)
    assert "p14_run_evidence_bundle" not in _TEXT
    assert _STEPS_BY_NAME[_ENFORCE_STEP]["env"].keys() == {
        "CANDIDATE_FUNNEL_BATCH_STATUS", "CANDIDATE_FUNNEL_SMOKE_STATUS",
    }


@pytest.mark.parametrize("failure", [
    pytest.param({"STUB_PUSH_EXIT": "1"}, id="push_failure"),
    pytest.param({"STUB_SAFE_MODE_EXIT": "1"}, id="safe_mode_failure"),
    pytest.param({"STUB_TIER_A_EXIT": "1"}, id="tier_a_failure"),
])
def test_n_pub_5_successful_gates_do_not_confirm_failed_or_skipped_push(tmp_path, failure):
    sim = _JobSimulation(tmp_path, stub_env={"BATCH_EXIT": "0", **failure})
    _run_publication_tail(sim)
    states = _publication_states(sim)
    # S1: the final enforcement may legitimately report that the gates passed...
    enforce = sim.results[_ENFORCE_STEP]
    assert enforce.status == "success" and "Candidate funnel publication gates passed" in enforce.stdout
    assert states["PUBLICATION_GATES_PASSED"] == "YES"
    # S2/S3: ...while no push was confirmed and no Pages dispatch was requested.
    assert states["REMOTE_PUSH_CONFIRMED"] == "NO"
    assert states["PAGES_DISPATCH_REQUESTED"] == "NO"
    assert states["COMPLETION"] == "NOT_CONFIRMED"
    assert sim.results[_DISPATCH_STEP].status == "skipped" and sim.gh_log() == []
    commit_outputs = sim.outputs.get("commit-push", {})
    assert "pushed_sha" not in commit_outputs and commit_outputs.get("data_changed") != "true"
    head = _git(sim.repo, "rev-parse", "HEAD").stdout.strip()
    if "STUB_PUSH_EXIT" in failure:
        # The data change was committed locally (data_changed is only true in the shell),
        # but the output stays false-before-push and the failed push exposes no SHA.
        assert sim.results[_COMMIT_STEP].status == "failure"
        assert head != sim.baseline_head
        assert commit_outputs == {"data_changed": "false"}
        assert any(line.startswith("push origin HEAD:refs/heads/main") for line in sim.git_log())
        # H01: the failure is the injected push itself, reached after a real exact-target
        # fetch (genuine FETCH_HEAD) and ancestry check; the bare origin never moved.
        log = sim.git_log()
        fetch_index = log.index("fetch --no-tags origin refs/heads/main")
        push_index = next(i for i, line in enumerate(log) if line.startswith("push origin "))
        assert fetch_index < push_index
        assert not any(line.startswith(("ls-remote", "pull", "rebase", "merge ")) for line in log)
        assert (sim.repo / ".git" / "FETCH_HEAD").is_file()
        assert sim.origin_head() == sim.baseline_head
    else:
        assert sim.results[_COMMIT_STEP].status == "skipped"
        assert head == sim.baseline_head and commit_outputs == {}
        assert sim.git_log() == []


def test_n_pub_6_dispatch_acceptance_does_not_prove_deployment(tmp_path):
    sim = _JobSimulation(tmp_path, stub_env={"BATCH_EXIT": "0"})
    _run_publication_tail(sim)
    pushed_sha = _git(sim.repo, "rev-parse", "HEAD").stdout.strip()
    assert pushed_sha != sim.baseline_head
    assert sim.outputs["commit-push"] == {"data_changed": "true", "pushed_sha": pushed_sha}
    # H01: the actual local bare push and independent observation completed first.
    assert sim.origin_head() == pushed_sha
    log = sim.git_log()
    fetch_index = log.index("fetch --no-tags origin refs/heads/main")
    push_index = log.index("push origin HEAD:refs/heads/main")
    observe_index = log.index("ls-remote --exit-code --refs origin refs/heads/main")
    assert fetch_index < push_index < observe_index
    # The stub gh recorded exactly the accepted main/deploy_sha request, nothing else.
    assert sim.gh_log() == [
        f"workflow run deploy.yml --repo example/jp-portfolio --ref main -f deploy_sha={pushed_sha}"
    ]
    states = _publication_states(sim)
    assert states["PUBLICATION_GATES_PASSED"] == "YES"
    assert states["REMOTE_PUSH_CONFIRMED"] == "YES"
    assert states["PAGES_DISPATCH_REQUESTED"] == "YES"
    # Dispatch acceptance is not a deployment/availability fact: Full Batch has no
    # deployment query and therefore can only report UNKNOWN.
    assert states["PAGES_DEPLOYED"] == "UNKNOWN"
    update_data = _update_data_section()
    for forbidden in ("gh run", "gh api", "gh workflow view", "deployments", "pages/builds", "curl "):
        assert forbidden not in update_data
    assert update_data.count("gh workflow run deploy.yml") == 1


# ── producer reference delivery ──────────────────────────────────────────────


def test_producer_reference_qgf_wrapper_zero_delivers_exact_eleven_fields(tmp_path, monkeypatch):
    kwargs, _parts, reference = _syn_fixture(
        _mkdir(tmp_path / "fixture"), terminal="QUALITY_GATE_FAILED", status="FAIL", dropped=2,
    )
    value = reference.to_value()
    sim = _JobSimulation(
        tmp_path, stub_env={"BATCH_EXIT": "1", "BATCH_WRITES": "1"}, producer_block=_producer_block(value),
    )
    build = sim.run(_BUILD_STEP)
    assert build.returncode == 0 and build.status == "success"
    names = [name for name, _v in build.output_pairs]
    assert len(names) == len(set(names)) == 12
    assert set(names) - {"publication_status"} == set(_OUTPUT_NAMES)
    assert len(_OUTPUT_NAMES) == 11
    assert sim.outputs["candidate-funnel-build"]["publication_status"] == "batch_failed"
    assert sim.run(_SMOKE_STEP).status == "skipped"
    capture = sim.run(_CAPTURE_STEP)
    assert capture.status == "success", capture.stderr
    argv = sim.consumer_argv()
    _assert_argv_mapping(sim, argv, value)  # values reach the parsed consumer argv unchanged
    assert argv[argv.index("--batch-status") + 1] == "batch_failed"
    assert argv[argv.index("--smoke-status") + 1] == ""
    # The real consumer accepts exactly that argv (test-only injected enabled mode).
    status, files = _run_real_consumer(tmp_path, monkeypatch, kwargs, argv, label="qgf")
    assert status == 0
    evidence = _syn_evidence(files)
    assert evidence["captureStatus"] == "captured"
    assert evidence["terminal"]["terminalStatus"] == "QUALITY_GATE_FAILED"
    assert evidence["terminal"]["artifactAvailable"] is False
    assert evidence["producerReference"] == value
    # The wrapper's exit 0 never turned the failure into a success.
    enforce = sim.run(_ENFORCE_STEP)
    assert enforce.returncode == 1


def test_producer_reference_rollback_failure_preserves_complete_output(tmp_path):
    kwargs, _parts, reference = _syn_fixture(
        _mkdir(tmp_path / "fixture"), terminal="QUALITY_GATE_FAILED", status="FAIL", dropped=2,
    )
    value = reference.to_value()
    sim = _JobSimulation(
        tmp_path,
        stub_env={"BATCH_EXIT": "1", "BATCH_WRITES": "1", "STUB_GIT_FAIL_SUBCOMMAND": "restore"},
        producer_block=_producer_block(value),
    )
    root = _make_attempt_tree(sim)
    _make_bundle_and_neighbours(sim)
    build = sim.run(_BUILD_STEP)
    assert build.status == "failure" and build.returncode == 1
    assert "rollback verification failed" in build.stderr
    # The reference (and the status the wrapper wrote first) were delivered before the failure.
    assert {name for name, _v in build.output_pairs} == set(_OUTPUT_NAMES) | {"publication_status"}
    assert sim.outputs["candidate-funnel-build"]["publication_status"] == "batch_failed"
    # Always-run consumer, upload and cleanup remain reachable after the failed step.
    assert sim.run(_SMOKE_STEP).status == "skipped"
    assert sim.run(_DERIVED_PER_STEP).status == "success"
    assert sim.run(_CAPTURE_STEP).status == "success"
    _assert_argv_mapping(sim, sim.consumer_argv(), value)
    assert sim.would_run(_UPLOAD_STEP) is True
    assert sim.run(_CLEANUP_STEP).status == "success"
    assert not root.exists()
    assert (
        sim.runner_temp / "candidate-funnel-evidence" / "bundle"
        / "candidate-funnel-evidence-900000031-1" / "evidence.json"
    ).is_file()
    # Release remains failed: no commit/push, and the final enforcement fails.
    assert sim.run(_COMMIT_STEP).status == "skipped"
    assert sim.run(_ENFORCE_STEP).returncode == 1
    assert _publication_states(sim)["COMPLETION"] == "NOT_CONFIRMED"


def _partial_case(case: str, value) -> tuple[str, dict[str, str]]:
    full = {name: value[field] for name, _flag, field, _env in _EMISSION_ROWS}
    if case.startswith("remove_"):
        present = {name: item for name, item in full.items() if name != case[len("remove_"):]}
    elif case == "status_only":
        present = {"p14_transport_status": full["p14_transport_status"]}
    elif case == "truncated_digest_block":
        present = {
            "p14_handoff_digest": full["p14_handoff_digest"],
            "p14_observation_digest": full["p14_observation_digest"],
            "p14_receipt_digest": full["p14_receipt_digest"][:24],
        }
    else:
        assert case == "no_output"
        present = {}
    block = "".join(f"{name}={item}\n" for name, item in present.items())
    return block, present


@pytest.mark.parametrize("case", [
    *[pytest.param(f"remove_{name}", id=f"remove_{name}") for name in _OUTPUT_NAMES],
    pytest.param("status_only", id="status_only"),
    pytest.param("truncated_digest_block", id="truncated_digest_block"),
    pytest.param("no_output", id="no_output"),
])
def test_producer_reference_partial_output_is_rejected(tmp_path, monkeypatch, case):
    kwargs, _parts, reference = _syn_fixture(
        _mkdir(tmp_path / "fixture"), terminal="QUALITY_GATE_FAILED", status="FAIL", dropped=2,
    )
    value = reference.to_value()
    block, present = _partial_case(case, value)
    sim = _JobSimulation(
        tmp_path, stub_env={"BATCH_EXIT": "1", "BATCH_WRITES": "0"}, producer_block=block,
    )
    assert sim.run(_BUILD_STEP).status == "success"
    assert sim.run(_CAPTURE_STEP).status == "success"
    argv = sim.consumer_argv()
    # Absent members arrive as empty strings: nothing is filled in by the shell.
    for name, flag, _field, _env in _OUTPUT_CONTRACT:
        assert argv[argv.index(flag) + 1] == present.get(name, "")
    assert "0" * 64 not in argv
    # The real consumer never reaches an accepted capture; first fault, safe INVALID bundle.
    status, files = _run_real_consumer(tmp_path, monkeypatch, kwargs, argv, label=case)
    assert status == 1
    _assert_invalid_evidence(files, code="PRODUCER_REFERENCE_MISSING", stage="REFERENCE")


def test_producer_reference_never_invents_or_reads_reference_authority_from_handoff(tmp_path, monkeypatch):
    kwargs_a, _pa, reference_a = _syn_fixture(
        _mkdir(tmp_path / "fixture-a"), terminal="QUALITY_GATE_FAILED", status="FAIL", dropped=2,
    )
    kwargs_b, _pb, reference_b = _syn_fixture(
        _mkdir(tmp_path / "fixture-b"), terminal="BATCH_READY", status="PASS", dropped=0,
    )
    value_a = reference_a.to_value()
    assert value_a != reference_b.to_value()
    sim = _JobSimulation(
        tmp_path, label="sim-a", stub_env={"BATCH_EXIT": "1", "BATCH_WRITES": "0"},
        producer_block=_producer_block(value_a),
    )
    assert sim.run(_BUILD_STEP).status == "success"
    assert sim.run(_CAPTURE_STEP).status == "success"
    argv = sim.consumer_argv()
    _assert_argv_mapping(sim, argv, value_a)
    # A different but self-consistent handoff under test, with the original independent
    # outputs: rejected (a coherent digest/binding fault keeps its specific code).
    status, files = _run_real_consumer(
        tmp_path, monkeypatch, kwargs_a, argv, label="swapped", handoff_root=kwargs_b["handoff_root"],
    )
    assert status == 1
    value = _assert_invalid_evidence(files, stage=None)
    assert value["failure"]["code"] != "PRODUCER_REFERENCE_MISSING"
    # Missing outputs are never filled from the (valid, present) handoff files.
    missing = _JobSimulation(
        tmp_path, label="sim-missing", stub_env={"BATCH_EXIT": "1", "BATCH_WRITES": "0"},
        producer_block=_producer_block(value_a, drop={"p14_receipt_digest"}),
    )
    assert missing.run(_BUILD_STEP).status == "success"
    assert missing.run(_CAPTURE_STEP).status == "success"
    missing_argv = missing.consumer_argv()
    assert missing_argv[missing_argv.index("--p14-receipt-digest") + 1] == ""
    status, files = _run_real_consumer(tmp_path, monkeypatch, kwargs_a, missing_argv, label="missing")
    assert status == 1
    _assert_invalid_evidence(files, code="PRODUCER_REFERENCE_MISSING", stage="REFERENCE")
    # No added authority: only the frozen flag set, no terminal/overallPass/joined/context
    # digest argument and no defaulted fake digest.
    assert {item for item in argv if item.startswith("--")} == _EXPECTED_ARGV_FLAGS
    assert not any(
        token in " ".join(argv).lower() for token in ("overall", "joined", "context-digest", "terminal-status")
    )
    assert set(_STEPS_BY_NAME[_CAPTURE_STEP]["env"]) == {
        "CANDIDATE_FUNNEL_BATCH_STATUS", "CANDIDATE_FUNNEL_SMOKE_STATUS", "P14_HANDOFF_DIR",
        *(env for _n, _f, _r, env in _OUTPUT_CONTRACT),
    }


def test_producer_reference_duplicate_or_unexpected_output_names_rejected(tmp_path):
    kwargs, _parts, reference = _syn_fixture(
        _mkdir(tmp_path / "fixture"), terminal="QUALITY_GATE_FAILED", status="FAIL", dropped=2,
    )
    value = reference.to_value()
    normal = _producer_block(value)
    duplicate = normal + f"p14_run_id={value['runId']}\n"
    unexpected = normal + "p14_terminal_status=BATCH_READY\n"
    for label, block in (("duplicate", duplicate), ("unexpected", unexpected)):
        sim = _JobSimulation(
            tmp_path, label=f"sim-{label}", stub_env={"BATCH_EXIT": "1", "BATCH_WRITES": "0"},
            producer_block=block,
        )
        with pytest.raises(ValueError):
            sim.run(_BUILD_STEP)
    with pytest.raises(ValueError):
        _strict_outputs([("p14_run_id", "1"), ("p14_run_id", "2")])
    with pytest.raises(ValueError):
        _strict_outputs([("p14_overall_pass", "true")])
    # A non-reference output such as publication_status is outside the p14_* namespace.
    assert _strict_outputs([("publication_status", "batch_failed")]) == {"publication_status": "batch_failed"}
    # The accepted run preserves the exact argv field set.
    sim = _JobSimulation(
        tmp_path, label="sim-normal", stub_env={"BATCH_EXIT": "1", "BATCH_WRITES": "0"}, producer_block=normal,
    )
    assert sim.run(_BUILD_STEP).status == "success"
    assert sim.run(_CAPTURE_STEP).status == "success"
    argv = sim.consumer_argv()
    assert {item for item in argv if item.startswith("--")} == _EXPECTED_ARGV_FLAGS
    _assert_argv_mapping(sim, argv, value)
