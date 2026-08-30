"""OPS-ROUTINES-3 serialized mutation workflow and frozen-byte proof."""

from pathlib import Path
import subprocess

import pytest
import yaml


ROOT = Path(__file__).parents[1]
BASE = "464c484e1f075994fa2eb5762b6552a1b42d33c4"
LOCK_GROUP = "jp-portfolio-production-data-mutation"
WORKFLOWS = {
    "full": ROOT / ".github/workflows/full_batch.yml",
    "update": ROOT / ".github/workflows/update-data.yml",
    "intraday": ROOT / ".github/workflows/intraday_patch.yml",
}
JOBS = {"full": "update-data", "update": "update", "intraday": "patch-tier1"}


def source(workflow: str) -> str:
    return WORKFLOWS[workflow].read_text()


def document(workflow: str):
    return yaml.safe_load(source(workflow))


def baseline(path: Path) -> str:
    relative = path.relative_to(ROOT)
    return subprocess.run(
        ["git", "show", f"{BASE}:{relative}"],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    ).stdout


def step_block(text: str, step_name: str) -> str:
    marker = f"      - name: {step_name}\n"
    start = text.index(marker)
    end = text.find("      - name: ", start + len(marker))
    return text[start:] if end < 0 else text[start:end]


@pytest.mark.parametrize("workflow", WORKFLOWS)
def test_three_mutating_jobs_share_job_level_non_cancelling_mutex(workflow):
    parsed = document(workflow)
    job = parsed["jobs"][JOBS[workflow]]

    assert "concurrency" not in {
        key: value for key, value in parsed.items() if key != "jobs"
    }
    assert job["concurrency"] == {
        "group": LOCK_GROUP,
        "cancel-in-progress": False,
    }


def test_queue_max_contract_has_no_cancellation_or_unlocked_mutator():
    mutators = []
    for workflow in WORKFLOWS:
        parsed = document(workflow)
        for job_name, job in parsed["jobs"].items():
            if job.get("concurrency", {}).get("group") == LOCK_GROUP:
                mutators.append((workflow, job_name))
                assert job["concurrency"]["cancel-in-progress"] is False
    assert mutators == [
        ("full", "update-data"),
        ("update", "update"),
        ("intraday", "patch-tier1"),
    ]


@pytest.mark.parametrize(
    ("workflow", "timeout"), [("full", 30), ("update", 30), ("intraday", 10)]
)
def test_mutating_job_timeouts_are_frozen(workflow, timeout):
    job = document(workflow)["jobs"][JOBS[workflow]]
    assert job["timeout-minutes"] == timeout


@pytest.mark.parametrize("workflow", WORKFLOWS)
def test_each_mutator_has_exactly_one_pre_fetch_and_pre_publish(workflow):
    job = document(workflow)["jobs"][JOBS[workflow]]
    commands = [step.get("run", "") for step in job["steps"]]
    combined = "\n".join(commands)
    prefix = "python3 -m backend.engine.operation.mutation_admission"

    assert combined.count(prefix) == 2
    assert combined.count(f"--workflow {workflow} --checkpoint pre_fetch") == 1
    assert combined.count(f"--workflow {workflow} --checkpoint pre_publish") == 1
    for step in job["steps"]:
        if prefix in step.get("run", ""):
            assert "continue-on-error" not in step


def test_full_checkpoint_positions_and_r11_nine_blocking_steps_are_preserved():
    steps = document("full")["jobs"]["update-data"]["steps"]
    names = [step.get("name") for step in steps]
    p1 = names.index("Evaluate mutation admission (pre_fetch)")
    p2 = names.index("Evaluate mutation admission (pre_publish)")
    commit = names.index("Commit and push")

    assert names[p1 - 1] == "Install Python deps"
    assert names[p1 + 1] == "Update correlation.json"
    assert names[p2 - 1] == "Smoke test regime_state schema"
    assert names[p2 + 1] == "Snapshot previous candidate_funnel artifact for evidence"
    between = steps[p2 + 1 : commit]
    assert len(between) == 9
    assert source("full").index("--checkpoint pre_publish") < source("full").index(
        "# ── OPS-P14-2: same-run evidence input保全"
    )


@pytest.mark.parametrize("workflow", ["update", "intraday"])
def test_update_and_intraday_checkpoint_positions(workflow):
    steps = document(workflow)["jobs"][JOBS[workflow]]["steps"]
    names = [step.get("name") for step in steps]
    p1 = names.index("Evaluate mutation admission (pre_fetch)")
    p2 = names.index("Evaluate mutation admission (pre_publish)")

    assert names[p1 - 1] == "Evaluate scheduled safe-start admission"
    assert names[p1 + 1] == "Install Python deps"
    assert names[p2 + 1] == "Commit and push"


@pytest.mark.parametrize("workflow", WORKFLOWS)
@pytest.mark.parametrize("step_name", ["Commit and push", "Dispatch Pages for pushed data"])
def test_existing_commit_and_pages_step_bytes_are_unchanged(workflow, step_name):
    assert step_block(source(workflow), step_name) == step_block(
        baseline(WORKFLOWS[workflow]), step_name
    )


@pytest.mark.parametrize(
    "step_name",
    [
        "Snapshot previous candidate_funnel artifact for evidence",
        "Build candidate_funnel.json (prescreen join + P-01..P-15 quality gate)",
        "Privacy/schema smoke test candidate_funnel.json",
        "Capture candidate funnel run evidence",
        "Upload candidate funnel run evidence",
        "Enforce candidate funnel publication status",
    ],
)
def test_full_p14_evidence_publication_rollback_enforcement_bytes_unchanged(step_name):
    path = WORKFLOWS["full"]
    assert step_block(source("full"), step_name) == step_block(baseline(path), step_name)


def test_data_market_strict_gate_bytes_are_unchanged():
    path = WORKFLOWS["update"]
    step_name = "Validate market JSON twins strictly"
    assert step_block(source("update"), step_name) == step_block(baseline(path), step_name)


def test_ops_r2_authority_and_non_target_workflows_are_byte_unchanged():
    paths = [
        ROOT / "backend/engine/operation/late_run_guard.py",
        ROOT / ".github/workflows/deploy.yml",
        ROOT / ".github/workflows/p14_evidence_capture.yml",
    ]
    for path in paths:
        assert path.read_text() == baseline(path)
    for path in paths[1:]:
        assert LOCK_GROUP not in path.read_text()


def test_no_source_or_production_data_drift_outside_exact_scope():
    allowed = {
        ".github/workflows/full_batch.yml",
        ".github/workflows/update-data.yml",
        ".github/workflows/intraday_patch.yml",
        "backend/engine/operation/mutation_admission.py",
        "backend/tests/test_operation/test_mutation_admission.py",
        "tests/test_mutation_serialization_workflows.py",
    }
    changed = subprocess.run(
        ["git", "status", "--short"],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.splitlines()
    assert {line[3:] for line in changed} <= allowed
    assert not any(line[3:].startswith(("data/", "public/data/")) for line in changed)
