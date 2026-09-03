"""OPS-ROUTINES-3 serialized mutation workflow and frozen-byte proof."""

import hashlib
from pathlib import Path

import pytest
import yaml


ROOT = Path(__file__).parents[1]
LOCK_GROUP = "jp-portfolio-production-data-mutation"
WORKFLOWS = {
    "full": ROOT / ".github/workflows/full_batch.yml",
    "update": ROOT / ".github/workflows/update-data.yml",
    "intraday": ROOT / ".github/workflows/intraday_patch.yml",
}
JOBS = {"full": "update-data", "update": "update", "intraday": "patch-tier1"}
EXPECTED_FULL_TOP_LEVEL_CONCURRENCY_SHA256 = (
    "8748350ba21894296af65487469d11af47d9242c910b949855f19e7ed5c54e08"
)
EXPECTED_COMMIT_AND_PAGES_BLOCK_SHA256 = {
    ("full", "Commit and push"): "817633cbd2ae487ab9a793b203aacf034e0c2bea38e2f76275adaf35e751eb9e",
    ("full", "Dispatch Pages for pushed data"): "24873d087c5ffa960d059bace99e4b0e767c41492f54477704852b3c1fece775",
    ("update", "Commit and push"): "d366a333641d51856bb234923fd918abfefbc397d00c410e19344bbd7529897d",
    ("update", "Dispatch Pages for pushed data"): "12ad918d41af46a7e455d24975651c124692b3ce08186cf69dfe2a04cbb23339",
    ("intraday", "Commit and push"): "d95a6bddfc6b1a74d415a58c1ce1c2bef9b0840c225b88d99eadd78ff86f4e65",
    ("intraday", "Dispatch Pages for pushed data"): "68a52f52e2127dfd32c479dc38a6649417044c0100d67e2a003c467e474b9371",
}
EXPECTED_P14_BLOCK_SHA256 = {
    "Snapshot previous candidate_funnel artifact for evidence": "81ea1328407b6bc4e70799cac7fd4645222854d6ba302e129c9f12a289bc6b4d",
    "Build candidate_funnel.json (prescreen join + P-01..P-15 quality gate)": "ca1656a0ebe58b08dda1082ccefd78ee4544194e49b9923abb6842a63e427097",
    "Privacy/schema smoke test candidate_funnel.json": "c8d15a5d87022fd71bf194d5df4d614fd93ba04d9358a25a20f0f3e54e853f0c",
    "Capture candidate funnel run evidence": "f59f29f3e1a068d68cf2b61f31d9a405f3de560c660a3d87122368a92dd632cc",
    "Upload candidate funnel run evidence": "456e0bb0437fdc7343901dc7a8a32a4b04a0595d35f6380676e09f0e7fcdce0d",
    "Enforce candidate funnel publication status": "5e310c23d955e9583f43a19062c5f144a23975b9cc5cc8ce7ef1c872cdc7336b",
}
EXPECTED_MARKET_STRICT_GATE_SHA256 = (
    "2434ceeef653fef30403bf0d230cacbdba6b1a948145afff428a81dfdc75190a"
)
# Files with no legitimate reason to change under this workflow's own
# scope: they are not a target of any full/update/intraday admission or
# mutation-serialization ticket, so their byte content is frozen forever
# (until a ticket explicitly scoped to one of them says otherwise).
EXPECTED_NON_TARGET_WORKFLOW_SHA256 = {
    ".github/workflows/deploy.yml": "9518fb8ab5f5c3a665f21e162cb260f2f00f4ce138281a210243fa38c165fb51",
    ".github/workflows/p14_evidence_capture.yml": "3510a58c47b257149c12e239d4cdfa0eada57de50c545cea3d6026eea44e5f56",
}

# backend/engine/operation/late_run_guard.py is the CURRENT frozen
# safe-start admission authority. Unlike the non-target workflows above, it
# is expected to change over time — but only under an explicit, audited
# authority ticket that updates this digest alongside the corresponding
# late_run_guard test/behavior changes. It must never drift silently.
# OPS-FULL-BATCH-SAFE-START-RECOVERY-R1 last updated this digest to reflect
# the full-batch deadline realignment (07:30 JST -> 12:00 JST).
EXPECTED_LATE_RUN_GUARD_AUTHORITY_SHA256 = (
    "e02af74589394688486b62308759f1455bda4c4ad54421067d5aaf0c9f30c490"
)


def source(workflow: str) -> str:
    return WORKFLOWS[workflow].read_text(encoding="utf-8")


def document(workflow: str):
    return yaml.safe_load(source(workflow))


def frozen_sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def step_block(text: str, step_name: str) -> str:
    marker = f"      - name: {step_name}\n"
    start = text.index(marker)
    end = text.find("      - name: ", start + len(marker))
    return text[start:] if end < 0 else text[start:end]


@pytest.mark.parametrize("workflow", WORKFLOWS)
def test_three_mutating_jobs_share_job_level_non_cancelling_mutex(workflow):
    parsed = document(workflow)
    job = parsed["jobs"][JOBS[workflow]]

    assert job["concurrency"] == {
        "group": LOCK_GROUP,
        "cancel-in-progress": False,
        "queue": "max",
    }


def test_queue_max_contract_has_no_cancellation_or_unlocked_mutator():
    mutators = []
    for workflow in WORKFLOWS:
        parsed = document(workflow)
        for job_name, job in parsed["jobs"].items():
            if job.get("concurrency", {}).get("group") == LOCK_GROUP:
                mutators.append((workflow, job_name))
                assert job["concurrency"]["cancel-in-progress"] is False
                assert job["concurrency"]["queue"] == "max"
    assert mutators == [
        ("full", "update-data"),
        ("update", "update"),
        ("intraday", "patch-tier1"),
    ]
    assert document("full")["concurrency"] == {
        "group": "full-batch",
        "cancel-in-progress": False,
    }
    assert document("intraday")["concurrency"] == {
        "group": "intraday-patch",
        "cancel-in-progress": False,
    }
    assert "concurrency" not in document("update")
    current = source("full").split("concurrency:\n", 1)[1].split("\njobs:", 1)[0]
    assert frozen_sha256(current) == EXPECTED_FULL_TOP_LEVEL_CONCURRENCY_SHA256


def test_intraday_manual_and_scheduled_runs_share_non_cancelling_top_level_group():
    parsed = document("intraday")

    # PyYAML 1.1 parses the unquoted workflow key ``on`` as boolean true.
    triggers = parsed.get("on", parsed.get(True))
    assert set(triggers) == {"schedule", "workflow_dispatch"}
    assert parsed["concurrency"] == {
        "group": "intraday-patch",
        "cancel-in-progress": False,
    }


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
    assert frozen_sha256(step_block(source(workflow), step_name)) == (
        EXPECTED_COMMIT_AND_PAGES_BLOCK_SHA256[(workflow, step_name)]
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
    assert frozen_sha256(step_block(source("full"), step_name)) == (
        EXPECTED_P14_BLOCK_SHA256[step_name]
    )


def test_data_market_strict_gate_bytes_are_unchanged():
    step_name = "Validate market JSON twins strictly"
    assert frozen_sha256(step_block(source("update"), step_name)) == (
        EXPECTED_MARKET_STRICT_GATE_SHA256
    )


def test_non_target_workflows_are_byte_unchanged():
    """deploy.yml and p14_evidence_capture.yml are not a target of any
    admission or mutation-serialization ticket; their bytes — including the
    absence of the shared mutation lock group — are frozen indefinitely.
    """
    for relative, expected_sha256 in EXPECTED_NON_TARGET_WORKFLOW_SHA256.items():
        path = ROOT / relative
        assert frozen_sha256(path.read_text(encoding="utf-8")) == expected_sha256
        assert LOCK_GROUP not in path.read_text()


def test_current_late_run_guard_authority_is_frozen():
    """backend/engine/operation/late_run_guard.py is the current safe-start
    admission authority. It changes only under an explicit, audited
    authority ticket that updates EXPECTED_LATE_RUN_GUARD_AUTHORITY_SHA256
    in the same change — never silently.
    """
    path = ROOT / "backend/engine/operation/late_run_guard.py"
    assert frozen_sha256(path.read_text(encoding="utf-8")) == (
        EXPECTED_LATE_RUN_GUARD_AUTHORITY_SHA256
    )
