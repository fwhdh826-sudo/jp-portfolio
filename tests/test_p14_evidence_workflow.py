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


def test_workflow_uses_python_311():
    """P14-P3A: manual evidence workflow must pin Python 3.11."""
    block = _step("Set up Python 3.11")
    assert re.search(r'python-version:\s*["\']?3\.11["\']?', block)


def test_dependency_install_includes_xlsx_and_legacy_xls_parsers():
    """P14-P3A root cause: current JPX source is XLSX (openpyxl), legacy
    fallback is XLS (xlrd). Manual workflow previously installed xlrd only,
    lacking openpyxl for the current XLSX format."""
    block = _step("Install public-data dependencies")
    install_line = block.splitlines()[
        [i for i, ln in enumerate(block.splitlines()) if ln.strip().startswith("run:")][0]
    ]
    assert "xlrd" in install_line
    assert "openpyxl" in install_line


def test_dependency_install_precedes_candidate_acquisition():
    """P14-P3A: dependencies (incl. openpyxl) must be installed before the
    same-run candidate acquisition step that triggers JPX XLSX parsing."""
    install_idx = TEXT.index("- name: Install public-data dependencies")
    acquire_idx = TEXT.index("- name: Acquire same-run candidates and prescreen")
    assert install_idx < acquire_idx


def test_candidate_acquisition_invokes_build_candidates_stocks_with_run_token():
    """P14-P3A: candidate acquisition module and run-token wiring unchanged."""
    block = _step("Acquire same-run candidates and prescreen")
    assert "python3 -m data.build_candidates_stocks" in block
    assert "--run-token" in block
    assert "steps.identity.outputs.run_token" in block


def test_frozen_branch_guard_unchanged():
    """P14-P3A: frozen branch enforcement must remain refs/heads/v13.3-dev."""
    block = _step("Enforce frozen branch")
    assert "refs/heads/v13.3-dev" in block


def test_removing_openpyxl_from_dependency_install_fails_contract():
    """Negative regression: simulating the pre-repair dependency line (xlrd
    only, no openpyxl) must fail the same assertion the fixed test enforces."""
    block = _step("Install public-data dependencies")
    run_line = [ln for ln in block.splitlines() if ln.strip().startswith("run:")][0]
    pre_repair_line = run_line.replace(" openpyxl", "")
    assert "xlrd" in pre_repair_line
    assert "openpyxl" not in pre_repair_line
