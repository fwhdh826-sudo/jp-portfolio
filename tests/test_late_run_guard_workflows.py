"""OPS-ROUTINES-2 workflow placement and frozen-semantics guards."""

from pathlib import Path
import subprocess

import pytest


ROOT = Path(__file__).parents[1]
BASE = "a3b9e7e7c7945c18e846d3a2d09514431149dd66"
WORKFLOWS = {
    "full": ROOT / ".github/workflows/full_batch.yml",
    "update": ROOT / ".github/workflows/update-data.yml",
    "intraday": ROOT / ".github/workflows/intraday_patch.yml",
}
MODULE_COMMANDS = {
    "full": "python3 -m backend.engine.operation.late_run_guard --workflow full",
    "update": "python3 -m backend.engine.operation.late_run_guard --workflow update",
    "intraday": "python3 -m backend.engine.operation.late_run_guard --workflow intraday",
}


def text(workflow: str) -> str:
    return WORKFLOWS[workflow].read_text()


def baseline(path: Path) -> str:
    relative = path.relative_to(ROOT).as_posix()
    result = subprocess.run(
        ["git", "show", f"{BASE}:{relative}"],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    )
    return result.stdout


def step_block(source: str, name: str) -> str:
    marker = f"      - name: {name}\n"
    start = source.index(marker)
    next_step = source.find("\n      - name: ", start + len(marker))
    next_uses = source.find("\n      - uses: ", start + len(marker))
    boundaries = [value for value in (next_step, next_uses) if value >= 0]
    end = min(boundaries) if boundaries else len(source)
    return source[start:end]


@pytest.mark.parametrize("workflow", WORKFLOWS)
def test_each_workflow_has_one_guard_command_and_runtime_token(workflow):
    source = text(workflow)
    assert source.count(MODULE_COMMANDS[workflow]) == 1
    block = source.split(MODULE_COMMANDS[workflow], 1)[0].rsplit(
        "      - name: Evaluate scheduled safe-start admission\n", 1
    )[1]
    assert "GITHUB_TOKEN: ${{ github.token }}" in block
    assert "continue-on-error" not in block


@pytest.mark.parametrize("workflow", ["update", "intraday"])
def test_single_job_guard_precedes_install_fetch_write_and_git(workflow):
    source = text(workflow)
    guard_position = source.index(MODULE_COMMANDS[workflow])
    assert source.index("actions/checkout@v4") < guard_position
    assert source.index("actions/setup-python@v5") < guard_position
    for mutation_marker in (
        "pip install",
        "data/update_",
        "Copy ",
        "git config",
        "git add",
        "git push",
    ):
        assert guard_position < source.index(mutation_marker)


def test_full_guard_is_independent_and_all_mutation_jobs_are_transitively_blocked():
    source = text("full")
    guard_job = source.split("  safe-start-guard:", 1)[1].split(
        "  operation-health:", 1
    )[0]
    operation_job = source.split("  operation-health:", 1)[1].split(
        "  update-data:", 1
    )[0]
    update_job = source.split("  update-data:", 1)[1].split(
        "  routines-stub:", 1
    )[0]
    routines_job = source.split("  routines-stub:", 1)[1]

    assert MODULE_COMMANDS["full"] in guard_job
    assert "data/update_" not in guard_job
    assert "git add" not in guard_job
    assert "git push" not in guard_job
    assert "needs: [safe-start-guard]" in operation_job
    assert "needs: [operation-health]" in update_job
    assert "needs: [update-data]" in routines_job
    assert "if: always()" not in operation_job
    assert "if: always()" in update_job  # P14 capture remains inside blocked job.


def test_full_guard_runs_before_any_full_mutation_job_checkout():
    source = text("full")
    guard_position = source.index(MODULE_COMMANDS["full"])
    operation_position = source.index("  operation-health:")
    update_position = source.index("  update-data:")
    assert guard_position < operation_position < update_position


@pytest.mark.parametrize("workflow", WORKFLOWS)
def test_manual_trigger_and_schedule_entries_are_byte_unchanged(workflow):
    current = text(workflow).split("on:\n", 1)[1].split("\npermissions:", 1)[0]
    original = baseline(WORKFLOWS[workflow]).split("on:\n", 1)[1].split(
        "\npermissions:", 1
    )[0]
    assert current == original
    assert "workflow_dispatch:" in current


def test_full_p14_threshold_evidence_publication_rollback_and_enforcement_bytes_frozen():
    marker = "      # ── OPS-P14-2: same-run evidence input保全"
    end_marker = "  # ── Job 3: Routines (stub)"
    current = text("full").split(marker, 1)[1].split(end_marker, 1)[0]
    original = baseline(WORKFLOWS["full"]).split(marker, 1)[1].split(
        end_marker, 1
    )[0]
    assert current == original


@pytest.mark.parametrize("workflow", WORKFLOWS)
@pytest.mark.parametrize(
    "step_name", ["Commit and push", "Dispatch Pages for pushed data"]
)
def test_existing_git_and_pages_step_bytes_are_frozen(workflow, step_name):
    assert step_block(text(workflow), step_name) == step_block(
        baseline(WORKFLOWS[workflow]), step_name
    )


@pytest.mark.parametrize(
    "step_name",
    [
        "Capture candidate funnel run evidence",
        "Upload candidate funnel run evidence",
        "Enforce candidate funnel publication status",
    ],
)
def test_p14_evidence_and_enforcement_step_bytes_are_frozen(step_name):
    assert step_block(text("full"), step_name) == step_block(
        baseline(WORKFLOWS["full"]), step_name
    )


def test_forbidden_workflows_have_no_worktree_diff_from_dev_base():
    result = subprocess.run(
        [
            "git",
            "diff",
            "--name-only",
            BASE,
            "--",
            ".github/workflows/deploy.yml",
            ".github/workflows/p14_evidence_capture.yml",
        ],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    )
    assert result.stdout == ""
