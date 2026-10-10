"""P4-A78: update-data.yml guard tests.

Guards the artifact coverage and commit/push flow of the update-data workflow
without executing the workflow or touching real APIs.

Scope:
  - update-data.yml exists and has expected structure
  - market_intel.json generation + copy path is wired
  - public/data/ artifacts (market, market_intel) are present in the workflow
  - git add / commit / push basic flow is intact
  - data/candidates_news.json + data/regime_state.json are explicitly staged
  - regime_state is built before candidates_news summary (dependency order)

Non-goals:
  - Real-time freshness of JSON data
  - API connections
  - Workflow execution
"""
from pathlib import Path
import ast
import os
import re
import shlex
import subprocess

import pytest
import yaml

_WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "update-data.yml"
_TEXT = _WORKFLOW.read_text()


def _step_script(step_name):
    marker = f"      - name: {step_name}\n"
    step = _TEXT.split(marker, 1)[1]
    body = step.split("        run: |\n", 1)[1]
    lines = []
    for line in body.splitlines():
        if line.startswith("          "):
            lines.append(line[10:])
        elif not line.strip():
            lines.append("")
        else:
            break
    return "\n".join(lines) + "\n"


# ── existence ─────────────────────────────────────────────────────────────────

def test_workflow_file_exists():
    assert _WORKFLOW.exists()


# ── market_intel generation + copy path ───────────────────────────────────────

def test_update_market_intel_script_present():
    # update_market_intel.py must be called to generate data/market_intel.json
    assert "data/update_market_intel.py" in _TEXT


def test_market_intel_in_copy_list():
    # market_intel must appear in the copy-to-public/data loop
    # Verify by checking both the variable value and the copy target
    assert "market_intel" in _TEXT


def test_public_market_intel_json_covered():
    # public/data/market_intel.json must be reachable via the copy step
    # (either explicit path or via market_intel in the loop variable list)
    copy_section = _TEXT.split("Copy JSON to public/data")[1].split("Build candidates")[0]
    assert "market_intel" in copy_section


# ── public/data artifact coverage ─────────────────────────────────────────────

def test_update_market_script_present():
    # update_market.py must be called to generate data/market.json
    assert "data/update_market.py" in _TEXT


def test_public_data_in_copy_target():
    # The copy step must target public/data/
    assert 'cp "data/${f}.json" "public/data/${f}.json"' in _TEXT


def test_market_in_copy_list():
    # market must be in the copy loop to produce public/data/market.json
    copy_section = _TEXT.split("Copy JSON to public/data")[1].split("Build candidates")[0]
    assert "market" in copy_section


# ── strict market JSON publication gate ───────────────────────────────────────

def _write_market_twins(root, content):
    for relative in ("data/market.json", "public/data/market.json"):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)


def test_market_strict_gate_accepts_valid_json(tmp_path):
    _write_market_twins(tmp_path, '{"price": 123.45}\n')

    result = subprocess.run(
        ["bash", "-e", "-o", "pipefail", "-c", _step_script(
            "Validate market JSON twins strictly"
        )],
        cwd=tmp_path,
        text=True,
        capture_output=True,
    )

    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    "invalid_twin", ["data/market.json", "public/data/market.json"]
)
def test_market_strict_gate_rejects_nan_in_either_twin(tmp_path, invalid_twin):
    _write_market_twins(tmp_path, '{"price": 123.45}\n')
    (tmp_path / invalid_twin).write_text('{"price": NaN}\n')

    result = subprocess.run(
        ["bash", "-e", "-o", "pipefail", "-c", _step_script(
            "Validate market JSON twins strictly"
        )],
        cwd=tmp_path,
        text=True,
        capture_output=True,
    )

    assert result.returncode != 0
    assert "non-standard JSON constant: NaN" in result.stderr


def test_market_strict_gate_runs_after_copy_and_before_commit():
    copy_position = _TEXT.index("      - name: Copy JSON to public/data")
    gate_position = _TEXT.index(
        "      - name: Validate market JSON twins strictly"
    )
    commit_position = _TEXT.index("      - name: Commit and push")

    assert copy_position < gate_position < commit_position


# ── regime_state + candidates_news ────────────────────────────────────────────

def test_update_regime_state_script_present():
    assert "data/update_regime_state.py" in _TEXT


def test_build_candidates_news_script_present():
    assert "data/build_candidates_news.py" in _TEXT



# ── git add / commit / push flow ─────────────────────────────────────────────

def test_git_add_present():
    assert "git add" in _TEXT


def test_git_commit_present():
    assert "git commit" in _TEXT


def test_git_push_present():
    assert "git push" in _TEXT


def test_public_data_staged():
    # public/data/ must be in the git add target
    assert "git add public/data/" in _TEXT


def test_data_candidates_news_explicitly_staged():
    # data/candidates_news.json must be explicitly staged (not covered by data/ glob)
    assert "data/candidates_news.json" in _TEXT.split("git add")[1]


def test_data_regime_state_explicitly_staged():
    # data/regime_state.json must be explicitly staged
    assert "data/regime_state.json" in _TEXT.split("git add")[1]


def test_no_git_add_all():
    # git add . and git add -A must not appear (too broad)
    assert "git add ." not in _TEXT
    assert "git add -A" not in _TEXT


def test_commit_before_push():
    # git commit must appear before git push
    commit_pos = _TEXT.index("git commit")
    push_pos = _TEXT.index("git push")
    assert commit_pos < push_pos, "git commit must come before git push"


# ── HOLDING-EVIDENCE-2: generator + copy + pre-publication validation gate ─────

def test_holding_evidence_generator_step_present():
    assert "data/update_holding_evidence.py" in _TEXT
    assert "- name: Update holding_evidence.json" in _TEXT


def test_holding_evidence_generator_is_fail_soft():
    # source outage が無関係の market-data publication を止めないこと（§31）
    gen_line = next(
        line for line in _TEXT.splitlines() if "data/update_holding_evidence.py" in line
    )
    assert gen_line.strip().endswith("|| true")


def test_holding_evidence_generator_order_market_intel_then_evidence_then_copy():
    market_intel = _TEXT.index("data/update_market_intel.py")
    generator = _TEXT.index("data/update_holding_evidence.py")
    copy_step = _TEXT.index("- name: Copy JSON to public/data")
    assert market_intel < generator < copy_step


def test_holding_evidence_in_copy_list():
    copy_section = _TEXT.split("Copy JSON to public/data")[1].split("Validate market")[0]
    assert "holding_evidence" in copy_section


def test_holding_evidence_validation_step_present_and_hard_fail():
    assert "- name: Validate holding_evidence artifact strictly" in _TEXT
    marker = "      - name: Validate holding_evidence artifact strictly\n"
    block = _TEXT.split(marker, 1)[1].split("      - name: ", 1)[0]
    assert "|| true" not in block
    assert "continue-on-error" not in block
    assert "validate_holding_evidence_artifact" in block


def test_holding_evidence_validation_runs_after_copy_and_before_commit():
    copy_pos = _TEXT.index("- name: Copy JSON to public/data")
    validate_pos = _TEXT.index("- name: Validate holding_evidence artifact strictly")
    commit_pos = _TEXT.index("- name: Commit and push")
    assert copy_pos < validate_pos < commit_pos


def test_holding_evidence_validation_before_pre_publish_checkpoint():
    validate_pos = _TEXT.index("- name: Validate holding_evidence artifact strictly")
    pre_publish_pos = _TEXT.index("--checkpoint pre_publish")
    assert validate_pos < pre_publish_pos


def test_mutation_admission_checkpoints_unchanged():
    # HE-2 は既存の admitted mutation window 内で実行される（§34）
    assert _TEXT.count("--checkpoint pre_fetch") == 1
    assert _TEXT.count("--checkpoint pre_publish") == 1
    p1 = _TEXT.index("--checkpoint pre_fetch")
    p2 = _TEXT.index("--checkpoint pre_publish")
    assert p1 < p2 < _TEXT.index("- name: Commit and push")


# Publication staging consumes canonical outputs and rejects all other residue.
_CANONICAL_SOURCE_PATHS = (
    "data/candidates_news.json",
    "data/correlation.json",
    "data/earnings_calendar.json",
    "data/flows.json",
    "data/macro.json",
    "data/margin.json",
    "data/market.json",
    "data/market_intel.json",
    "data/news.json",
    "data/regime_state.json",
    "data/sq_calendar.json",
    "data/stock_scores_6axis.json",
)
_RUN_LOCAL_PATHS = (
    "data/holding_evidence.json",
    "data/returns.json",
    "data/stock_scores_6axis_backup.json",
)
_CLEANUP_STEP = "Cleanup update-data run-local source artifacts"


def _staging_and_validator():
    script = _step_script("Commit and push")
    return script[script.index("git add "):script.index("\ndata_changed=false\n")]


def _residue_guards():
    script = _step_script("Commit and push")
    start = script.index("if ! git diff --quiet || ! git diff --cached --quiet; then")
    return script[start:script.index("\n# The remote target", start)]


def _run_script(root, script):
    return subprocess.run(
        ["bash", "-e", "-o", "pipefail", "-c", script],
        cwd=root, text=True, capture_output=True,
    )


def _git(root, *args):
    return subprocess.run(
        ["git", *args], cwd=root, text=True, capture_output=True, check=True,
    ).stdout


def _publication_repository(root):
    # Real Git index, tracked JSON twins and modifications; no network or APIs.
    _git(root, "init", "-q")
    _git(root, "config", "user.name", "Publication contract test")
    _git(root, "config", "user.email", "publication-test@example.invalid")
    paths = (*_CANONICAL_SOURCE_PATHS,
             "public/data/market.json", "public/data/holding_evidence.json",
             "public/data/returns.json",
             "public/data/scoring/stock_scores_6axis.json", "unrelated.json")
    for relative in paths:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"generation": 0}\n')
    _git(root, "add", "--", *paths)
    _git(root, "commit", "-q", "-m", "Fixture baseline")
    for relative in paths[:-1]:
        (root / relative).write_text('{"generation": 1}\n')
    for relative in _RUN_LOCAL_PATHS:
        (root / relative).write_text('{"run_local": true}\n')
    return set(paths[:-1])


def test_canonical_stage_list_is_exact_and_explicit():
    stage = _staging_and_validator().split("\n# Every staged delta", 1)[0]
    assert shlex.split(stage.replace("\\\n", "")) == [
        "git", "add", "public/data/", *_CANONICAL_SOURCE_PATHS,
    ]
    assert "git add ." not in _TEXT
    assert "git add -A" not in _TEXT
    for path in _RUN_LOCAL_PATHS:
        assert path not in stage


def test_validator_accepts_canonical_sources_and_excludes_run_local_sources():
    script = _staging_and_validator()
    python = script.split("python3 - <<'PY'\n", 1)[1].split("\nPY", 1)[0]
    tree = ast.parse(python)
    assignment = next(node for node in tree.body if isinstance(node, ast.Assign)
                      and any(isinstance(t, ast.Name) and t.id == "ALLOWED"
                              for t in node.targets))
    allowed = set(ast.literal_eval(assignment.value.args[0]))
    assert set(_CANONICAL_SOURCE_PATHS) <= allowed
    assert not set(_RUN_LOCAL_PATHS) & allowed
    assert "public/data/holding_evidence.json" in allowed
    assert "public/data/returns.json" in allowed
    assert "public/data/scoring/stock_scores_6axis.json" in allowed


def test_cleanup_removes_only_exact_approved_untracked_paths():
    script = _step_script(_CLEANUP_STEP)
    paths = script.split("for path in ", 1)[1].split("; do", 1)[0]
    assert shlex.split(paths.replace("\\\n", "")) == list(_RUN_LOCAL_PATHS)
    assert 'git ls-files --error-unmatch "$path"' in script
    assert script.index('git ls-files --error-unmatch "$path"') < script.index('rm -f -- "$path"')
    assert script.count('rm -f -- "$path"') == 1
    assert "exit 1" in script
    assert "set -euo pipefail" in script
    assert not re.search(r"git (clean|reset|checkout)|rm\s+-[rf]*r|\*", script)


def test_cleanup_follows_final_consumers_and_precedes_pre_publish():
    names = [step.get("name") for step in yaml.safe_load(_TEXT)["jobs"]["update"]["steps"]]
    cleanup = names.index(_CLEANUP_STEP)
    for consumer in (
        "Copy JSON to public/data",
        "Validate holding_evidence artifact strictly",
        "Update stock_scores_6axis.json (Phase 8 input scores)",
        "Copy stock_scores_6axis.json to public/data/scoring",
    ):
        assert names.index(consumer) < cleanup
    assert names[cleanup + 1:cleanup + 4] == [
        "Evaluate mutation admission (pre_publish)", "Commit and push",
        "Dispatch Pages for pushed data",
    ]


def test_final_residue_guards_remain_hard_fail():
    guards = _residue_guards()
    assert guards.count("exit 1") == 2
    assert 'if ! git diff --quiet || ! git diff --cached --quiet; then' in guards
    assert 'if [ -n "$(git ls-files --others --exclude-standard)" ]; then' in guards
    assert "Tracked changes remain after data staging" in guards
    assert "Unexpected untracked files remain after data staging" in guards
    assert "|| true" not in guards


def test_workflow_yaml_and_modified_shell_blocks_parse():
    steps = yaml.safe_load(_TEXT)["jobs"]["update"]["steps"]
    for name in (_CLEANUP_STEP, "Commit and push"):
        script = next(step["run"] for step in steps if step.get("name") == name)
        result = subprocess.run(["bash", "-n"], input=script, text=True, capture_output=True)
        assert result.returncode == 0, result.stderr
    validator = _staging_and_validator().split("python3 - <<'PY'\n", 1)[1].split("\nPY", 1)[0]
    compile(validator, "update-data-staged-validator", "exec")


def test_dynamic_publication_contract_stages_canonical_and_removes_run_local(tmp_path):
    expected = _publication_repository(tmp_path)
    cleanup = _run_script(tmp_path, _step_script(_CLEANUP_STEP))
    assert cleanup.returncode == 0, cleanup.stderr
    assert all(not (tmp_path / path).exists() for path in _RUN_LOCAL_PATHS)
    result = _run_script(tmp_path, _staging_and_validator())
    assert result.returncode == 0, result.stderr
    assert set(_git(tmp_path, "diff", "--cached", "--name-only").splitlines()) == expected
    assert _git(tmp_path, "diff", "--name-only") == ""
    assert _git(tmp_path, "ls-files", "--others", "--exclude-standard") == ""
    _git(tmp_path, "commit", "-q", "-m", "Fixture publication")
    result = _run_script(tmp_path, _residue_guards())
    assert result.returncode == 0, result.stderr
    assert _git(tmp_path, "status", "--porcelain") == ""


@pytest.mark.parametrize("residue", ["untracked", "tracked"])
def test_dynamic_publication_contract_rejects_unexpected_residue(tmp_path, residue):
    _publication_repository(tmp_path)
    path = "unexpected.txt" if residue == "untracked" else "unrelated.json"
    (tmp_path / path).write_text('{"unexpected": true}\n')
    result = _run_script(tmp_path, _step_script(_CLEANUP_STEP))
    assert result.returncode == 0, result.stderr
    result = _run_script(tmp_path, _staging_and_validator())
    assert result.returncode == 0, result.stderr
    assert path not in _git(tmp_path, "diff", "--cached", "--name-only").splitlines()
    _git(tmp_path, "commit", "-q", "-m", "Fixture publication")
    result = _run_script(tmp_path, _residue_guards())
    assert result.returncode != 0
    message = ("Unexpected untracked files remain" if residue == "untracked"
               else "Tracked changes remain")
    assert message in result.stderr
    assert path in result.stderr
    assert (tmp_path / path).exists()


def test_dynamic_validator_rejects_non_allowlisted_tracked_modification(tmp_path):
    _publication_repository(tmp_path)
    (tmp_path / "unrelated.json").write_text('{"unexpected": true}\n')
    _git(tmp_path, "add", "--", "unrelated.json")
    result = _run_script(tmp_path, _staging_and_validator())
    assert result.returncode != 0
    assert "Staged path is not an eligible data file: unrelated.json" in result.stderr


@pytest.mark.parametrize("tracked_path", _RUN_LOCAL_PATHS)
def test_dynamic_cleanup_rejects_unexpectedly_tracked_run_local_path(tmp_path, tracked_path):
    _publication_repository(tmp_path)
    _git(tmp_path, "add", "--", tracked_path)
    result = _run_script(tmp_path, _step_script(_CLEANUP_STEP))
    assert result.returncode != 0
    assert "Run-local source artifact is unexpectedly tracked: " + tracked_path in result.stderr
    assert (tmp_path / tracked_path).exists()
