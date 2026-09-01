"""OPS-ROUTINES-3-R2 workflow placement and frozen-byte tests."""

import hashlib
from pathlib import Path

import pytest
import yaml

from backend.engine.operation import mutation_admission


ROOT = Path(__file__).parents[1]
COMMAND = "python3 -m backend.engine.operation.ref_reanchor_gate"
WORKFLOWS = {
    "full": ROOT / ".github/workflows/full_batch.yml",
    "update": ROOT / ".github/workflows/update-data.yml",
    "intraday": ROOT / ".github/workflows/intraday_patch.yml",
}
EXPECTED_TRIGGER_BLOCK_SHA256 = {
    "full": "a75d60af45bee4950e1ea65183b762ff8879cc51ba41824b56e150550168e2df",
    "update": "75c248bccacfb3f4413c70e126a868d5483c571b6b5e80f2a758e8422a2d758b",
    "intraday": "bb70ed647bf1f04dd285d15be52231c087ad53bc9ad0f88fddbda69a01bc0936",
}
EXPECTED_COMMIT_AND_PAGES_BLOCK_SHA256 = {
    ("full", "Commit and push"): "8bf450a78161c1db43c031ad3054262b0bc7899501c4944ab71fbe2e9a5ce7b6",
    ("full", "Dispatch Pages for pushed data"): "12ad918d41af46a7e455d24975651c124692b3ce08186cf69dfe2a04cbb23339",
    ("update", "Commit and push"): "6f678dfdffb605c0ab16a18a1de0146ff8870baec8906a92ade1e2272dff6a7a",
    ("update", "Dispatch Pages for pushed data"): "12ad918d41af46a7e455d24975651c124692b3ce08186cf69dfe2a04cbb23339",
    ("intraday", "Commit and push"): "47d183813f118d13fc371bd7eb9fc81b22fae8c35fdb0726a0b2bbbef7ab51b6",
    ("intraday", "Dispatch Pages for pushed data"): "68a52f52e2127dfd32c479dc38a6649417044c0100d67e2a003c467e474b9371",
}
EXPECTED_PRE_FETCH_BLOCK_SHA256 = {
    "full": "e4c97c9ffa279156567bee9349ccfb33a316723fceafb67c30a3857b49939358",
    "update": "daaec2170311666c3514be134c8933f1b04a8cfa634b32685c6eb8c455d3d3de",
    "intraday": "8cf7b4d2e4e0ef7091a19c02b33e688ee81bb9582d6740fb6c3e18bd5fd9601a",
}


def source(workflow: str) -> str:
    return WORKFLOWS[workflow].read_text(encoding="utf-8")


def frozen_sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def step_block(text: str, name: str) -> str:
    marker = f"      - name: {name}\n"
    start = text.index(marker)
    boundaries = [
        position
        for position in (
            text.find("\n      - name: ", start + len(marker)),
            text.find("\n      - uses: ", start + len(marker)),
        )
        if position >= 0
    ]
    return text[start : min(boundaries) if boundaries else len(text)]


def full_update_job(text: str) -> str:
    return text.split("  update-data:\n", 1)[1].split("  routines-stub:\n", 1)[0]


@pytest.mark.parametrize("workflow", WORKFLOWS)
def test_each_workflow_has_one_unconditional_reanchor_step(workflow):
    text = source(workflow)
    assert text.count(COMMAND) == 1
    step_name = (
        "Re-anchor to latest remote tip"
        if workflow == "full"
        else "Evaluate scheduled safe-start admission"
    )
    block = step_block(text, step_name)
    assert "if:" not in block
    assert "continue-on-error" not in block
    if workflow == "full":
        assert text.count("      - name: Re-anchor to latest remote tip\n") == 1
    else:
        assert block.index("late_run_guard") < block.index(COMMAND)


def test_full_exact_placement_checkout_setup_reanchor_deps_then_p1():
    job = full_update_job(source("full"))
    positions = [
        job.index("actions/checkout@v4"),
        job.index("actions/setup-python@v5"),
        job.index(COMMAND),
        job.index("pip install yfinance pandas numpy feedparser requests xlrd"),
        job.index("Evaluate mutation admission (pre_fetch)"),
    ]
    assert positions == sorted(positions)


@pytest.mark.parametrize(
    ("workflow", "guard_command"),
    [
        ("update", "late_run_guard --workflow update"),
        ("intraday", "late_run_guard --workflow intraday"),
    ],
)
def test_ops_r2_guard_precedes_reanchor_p1_and_dependencies(workflow, guard_command):
    text = source(workflow)
    positions = [
        text.index("actions/checkout@v4"),
        text.index("actions/setup-python@v5"),
        text.index(guard_command),
        text.index(COMMAND),
        text.index("Evaluate mutation admission (pre_fetch)"),
        text.index("pip install yfinance pandas numpy feedparser"),
    ]
    assert positions == sorted(positions)
    before_guard = text[: positions[2]]
    assert "git fetch" not in before_guard
    assert "git merge" not in before_guard


@pytest.mark.parametrize("workflow", WORKFLOWS)
def test_python_311_setup_precedes_reanchor(workflow):
    text = full_update_job(source(workflow)) if workflow == "full" else source(workflow)
    setup_position = text.index("actions/setup-python@v5")
    reanchor_position = text.index(COMMAND)
    assert setup_position < reanchor_position
    between = text[setup_position:reanchor_position]
    assert "python-version: '3.11'" in between


@pytest.mark.parametrize(
    ("workflow", "first_data_operation"),
    [
        ("full", "python3 data/update_correlation.py"),
        ("update", "python3 data/update_correlation.py"),
        ("intraday", "python3 data/update_market.py"),
    ],
)
def test_reanchor_precedes_every_data_fetch_or_write(workflow, first_data_operation):
    text = full_update_job(source(workflow)) if workflow == "full" else source(workflow)
    assert text.index(COMMAND) < text.index(first_data_operation)
    assert text.index(COMMAND) < text.index("git add")


def test_pre_reanchor_is_not_a_mutation_admission_checkpoint():
    assert mutation_admission.CHECKPOINTS == ("pre_fetch", "pre_publish")
    assert "pre_reanchor" not in mutation_admission.CHECKPOINTS


@pytest.mark.parametrize("workflow", WORKFLOWS)
def test_manual_dispatch_trigger_is_frozen_and_cannot_skip_reanchor(workflow):
    current_trigger = source(workflow).split("on:\n", 1)[1].split(
        "\npermissions:", 1
    )[0]
    assert frozen_sha256(current_trigger) == EXPECTED_TRIGGER_BLOCK_SHA256[workflow]
    assert "workflow_dispatch:" in current_trigger
    step_name = (
        "Re-anchor to latest remote tip"
        if workflow == "full"
        else "Evaluate scheduled safe-start admission"
    )
    assert "github.event_name" not in step_block(
        source(workflow), step_name
    )


@pytest.mark.parametrize("workflow", WORKFLOWS)
@pytest.mark.parametrize(
    "step_name", ["Commit and push", "Dispatch Pages for pushed data"]
)
def test_existing_commit_push_and_dispatch_pages_bytes_are_frozen(
    workflow, step_name
):
    assert frozen_sha256(step_block(source(workflow), step_name)) == (
        EXPECTED_COMMIT_AND_PAGES_BLOCK_SHA256[(workflow, step_name)]
    )


@pytest.mark.parametrize("workflow", WORKFLOWS)
def test_existing_p1_step_bytes_are_frozen(workflow):
    assert frozen_sha256(
        step_block(source(workflow), "Evaluate mutation admission (pre_fetch)")
    ) == (
        EXPECTED_PRE_FETCH_BLOCK_SHA256[workflow]
    )


@pytest.mark.parametrize("workflow", WORKFLOWS)
def test_workflow_yaml_parses_and_queue_extension_remains_max(workflow):
    yaml.compose(source(workflow))
    text = source(workflow)
    if workflow in {"update", "intraday"}:
        assert text.count("      queue: max\n") == 1
    else:
        assert text.count("      queue: max\n") == 1
