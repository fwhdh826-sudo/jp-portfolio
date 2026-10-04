"""OPS-ROUTINES-2 workflow placement and frozen-semantics guards."""

from pathlib import Path
import subprocess

import pytest


ROOT = Path(__file__).parents[1]
BASE = "597c17ed448f1228e126c8699bd251eade07136b"
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


# ── OPS P14 v13.4 Phase IV D01: reviewed dormant-wiring insertions ───────────
# The historical broad P14 envelope comparison below stays byte-for-byte against
# the historical BASE, except for exactly these reviewed insertions:
#   producer  : step-level env on "Build candidate_funnel.json ..."
#   consumer  : step env + CLI args on "Capture candidate funnel run evidence"
#   cleanup   : the named "Cleanup candidate funnel P14 handoff" step (+ its note)
# Nothing else is admitted; every other byte of the envelope is compared to BASE.
BUILD_STEP = "Build candidate_funnel.json (prescreen join + P-01..P-15 quality gate)"
CAPTURE_STEP = "Capture candidate funnel run evidence"
CLEANUP_STEP = "Cleanup candidate funnel P14 handoff"
UPLOAD_DERIVED_PER_STEP_MARKER = (
    "      - name: Upload derived PER migration calibration evidence\n"
)
HANDOFF_DIR_EXPRESSION = (
    "${{ runner.temp }}/candidate-funnel-p14/${{ github.run_id }}-${{ github.run_attempt }}"
)
PRODUCER_ENV_INSERTION = (
    "        env:\n"
    f"          P14_HANDOFF_DIR: {HANDOFF_DIR_EXPRESSION}\n"
    "          P14_EXPECTED_POLICY_VERSION: p14-decision-aware-v1\n"
)
CONSUMER_OUTPUT_ENV = (
    ("P14_TRANSPORT_STATUS", "p14_transport_status"),
    ("P14_HANDOFF_DIGEST", "p14_handoff_digest"),
    ("P14_OBSERVATION_DIGEST", "p14_observation_digest"),
    ("P14_RECEIPT_DIGEST", "p14_receipt_digest"),
    ("P14_CAPTURE_INPUT_DIGEST", "p14_capture_input_digest"),
    ("P14_EXECUTED_GIT_SHA", "p14_executed_git_sha"),
    ("P14_OBSERVATION_SCHEMA", "p14_observation_schema"),
    ("P14_HANDOFF_SCHEMA", "p14_handoff_schema"),
    ("P14_POLICY_VERSION", "p14_policy_version"),
    ("P14_RUN_ID", "p14_run_id"),
    ("P14_RUN_ATTEMPT", "p14_run_attempt"),
)
CONSUMER_FLAGS = (
    "transport-status", "handoff-digest", "observation-digest", "receipt-digest",
    "capture-input-digest", "executed-git-sha", "observation-schema", "handoff-schema",
    "policy-version", "run-id", "run-attempt",
)
CONSUMER_ENV_INSERTION = (
    f"          P14_HANDOFF_DIR: {HANDOFF_DIR_EXPRESSION}\n"
    + "".join(
        f"          {env_name}: ${{{{ steps.candidate-funnel-build.outputs.{output} }}}}\n"
        for env_name, output in CONSUMER_OUTPUT_ENV
    )
)
CONSUMER_ARGS_INSERTION = (
    '          --p14-handoff-dir "$P14_HANDOFF_DIR"\n'
    "          --p14-expected-policy-version p14-decision-aware-v1\n"
    + "".join(
        f'          --p14-{flag} "${env_name}"\n'
        for flag, (env_name, _output) in zip(CONSUMER_FLAGS, CONSUMER_OUTPUT_ENV)
    )
)


def _replace_once(block: str, old: str, new: str) -> str:
    assert block.count(old) == 1, old
    return block.replace(old, new, 1)


def reviewed_producer_block(original: str) -> str:
    return _replace_once(
        original,
        "        shell: bash\n        run: |\n",
        "        shell: bash\n" + PRODUCER_ENV_INSERTION + "        run: |\n",
    )


def reviewed_consumer_block(original: str) -> str:
    smoke_env = (
        "          CANDIDATE_FUNNEL_SMOKE_STATUS: "
        "${{ steps.candidate-funnel-smoke.outputs.publication_status }}\n"
    )
    smoke_arg = '          --smoke-status "$CANDIDATE_FUNNEL_SMOKE_STATUS"\n'
    block = _replace_once(original, smoke_env, smoke_env + CONSUMER_ENV_INSERTION)
    return _replace_once(block, smoke_arg, smoke_arg + CONSUMER_ARGS_INSERTION)


def reviewed_baseline_source() -> str:
    """BASE with only the producer/consumer insertions applied (cleanup is
    compared separately by removing it from the current source)."""
    source = baseline(WORKFLOWS["full"])
    for step_name, transform in (
        (BUILD_STEP, reviewed_producer_block),
        (CAPTURE_STEP, reviewed_consumer_block),
    ):
        original = step_block(source, step_name)
        assert source.count(original) == 1
        source = source.replace(original, transform(original), 1)
    return source


def source_without_cleanup(source: str) -> str:
    start = source.index(f"      - name: {CLEANUP_STEP}\n")
    assert source.count(f"      - name: {CLEANUP_STEP}\n") == 1
    end = source.index(UPLOAD_DERIVED_PER_STEP_MARKER)
    assert start < end
    return source[:start] + source[end:]


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
    """Historical broad envelope: BASE bytes plus ONLY the reviewed dormant
    wiring (producer env, consumer env/args, named cleanup insertion)."""
    marker = "      # ── OPS-P14-2: same-run evidence input保全"
    end_marker = "  # ── Job 3: Routines (stub)"
    current = source_without_cleanup(text("full")).split(marker, 1)[1].split(
        end_marker, 1
    )[0]
    expected = reviewed_baseline_source().split(marker, 1)[1].split(end_marker, 1)[0]
    assert current == expected


def test_p14_cleanup_is_the_only_new_step_and_follows_the_evidence_upload():
    current_names = [
        line.split("- name: ", 1)[1]
        for line in text("full").splitlines()
        if line.startswith("      - name: ")
    ]
    original_names = [
        line.split("- name: ", 1)[1]
        for line in baseline(WORKFLOWS["full"]).splitlines()
        if line.startswith("      - name: ")
    ]
    assert CLEANUP_STEP in current_names
    assert [name for name in current_names if name != CLEANUP_STEP] == original_names
    position = current_names.index(CLEANUP_STEP)
    assert current_names[position - 1] == "Upload candidate funnel run evidence"
    assert current_names[position + 1] == "Upload derived PER migration calibration evidence"


def test_p14_producer_step_is_base_plus_only_the_reviewed_env():
    current = step_block(text("full"), BUILD_STEP)
    original = step_block(baseline(WORKFLOWS["full"]), BUILD_STEP)
    assert current == reviewed_producer_block(original)
    # The producer command and its exit/rollback shell remain untouched.
    assert current.count("python3 -m data.candidate_funnel_batch\n") == 1
    assert current.split("        run: |\n", 1)[1] == original.split("        run: |\n", 1)[1]


def test_p14_consumer_step_is_base_plus_only_the_reviewed_wiring():
    current = step_block(text("full"), CAPTURE_STEP)
    original = step_block(baseline(WORKFLOWS["full"]), CAPTURE_STEP)
    assert current == reviewed_consumer_block(original)
    # Semantic anchors: still non-blocking, always-run, same id and legacy args.
    assert "        id: candidate-funnel-evidence\n" in current
    assert "        if: always()\n" in current
    assert "        continue-on-error: true\n" in current
    assert "secrets." not in current
    assert "${{" not in current.split("        run: >-\n", 1)[1]


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
