"""Frozen P14-E2 workflow tests T-29..T-34."""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).parents[1]
WORKFLOW = REPO / ".github/workflows/p14_evidence_capture.yml"
TEXT = WORKFLOW.read_text(encoding="utf-8")


def _step(name: str) -> str:
    start = TEXT.index(f"- name: {name}")
    next_step = TEXT.find("\n      - name:", start + 1)
    return TEXT[start:] if next_step == -1 else TEXT[start:next_step]


def test_workflow_has_workflow_dispatch_only_no_schedule_no_push():
    """T-29."""
    trigger = TEXT.split("on:", 1)[1].split("permissions:", 1)[0]
    assert "workflow_dispatch:" in trigger
    assert "schedule:" not in trigger
    assert re.search(r"(?m)^\s+push:", trigger) is None
    assert "pull_request:" not in trigger


def test_workflow_declares_contents_read_permission():
    """T-30."""
    permissions = TEXT.split("permissions:", 1)[1].split("concurrency:", 1)[0]
    assert re.search(r"(?m)^\s+contents:\s+read\s*$", permissions)
    assert "write" not in permissions


def test_workflow_has_no_git_commit_push_or_publish_step():
    """T-31."""
    assert re.search(r"(?m)^\s*(git\s+add|git\s+commit|git\s+push)\b", TEXT) is None
    assert "publish_artifact" not in TEXT
    assert "data.candidate_funnel_batch" not in TEXT
    assert "deploy-pages" not in TEXT


def test_upload_artifact_uses_if_always_and_retention_90():
    """T-32."""
    block = _step("Upload evidence artifact")
    assert "if: always()" in block
    assert "uses: actions/upload-artifact@v4" in block
    assert "if-no-files-found: error" in block
    assert "retention-days: 90" in block
    assert "continue-on-error" not in block


def test_validate_step_is_blocking_no_or_true():
    """T-33."""
    block = _step("Validate bundle in CI mode")
    assert "python3 -m data.p14_evidence_validate" in block
    assert "|| true" not in block
    assert "continue-on-error" not in block
    assert "if:" not in block


def test_full_batch_has_no_p14_evidence_capture_responsibility():
    """T-34: the isolated evidence workflow must not leak into full_batch."""
    full_batch = (REPO / ".github/workflows/full_batch.yml").read_text(
        encoding="utf-8"
    )
    assert "p14_evidence_capture" not in full_batch
    assert "data.p14_evidence" not in full_batch
    assert "Upload evidence artifact" not in full_batch
