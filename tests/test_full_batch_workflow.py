"""P4-A23 / P4-A23-1 / P4-A23-2 / P4-A28 / P5-B004e-3 guard.

P4-A23: dry-run health-check steps are retained in routines-stub (detection-only).
P4-A23-1: Job 2 commit/push step follows correct order (add → commit → pull → push).
P4-A23-2: git add covers full data/ directory, not individual files.
P4-A28: real write steps for safe_mode.json and TierA snapshots are wired in Job 2
        (update-data), covered by the existing "git add data/ public/data/" commit step.
P5-B004e-3: pull/rebase and push target the validated workflow branch, fail-closed.
"""
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import re
import shutil
import subprocess
from zoneinfo import ZoneInfo

import pytest

_WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "full_batch.yml"
_TEXT = _WORKFLOW.read_text()


def test_workflow_file_exists():
    assert _WORKFLOW.exists()


def test_schedule_is_monday_to_friday_at_0630_jst():
    """The GitHub UTC cron must map to the intended local trading weekdays."""
    cron_entries = re.findall(
        r"^\s*-\s*cron:\s*['\"]([^'\"]+)['\"]\s*$", _TEXT, re.MULTILINE
    )
    assert cron_entries == ["30 21 * * 0-4"]

    minute, hour, day_of_month, month, day_of_week = cron_entries[0].split()
    assert day_of_month == month == "*"
    start_day, end_day = (int(value) for value in day_of_week.split("-", 1))

    # 2024-01-07 is a Sunday, matching GitHub cron weekday 0.
    utc_sunday = datetime(2024, 1, 7, tzinfo=timezone.utc)
    jst = ZoneInfo("Asia/Tokyo")
    local_runs = set()
    for weekday in range(start_day, end_day + 1):
        local_run = (
            utc_sunday
            + timedelta(days=weekday, hours=int(hour), minutes=int(minute))
        ).astimezone(jst)
        local_runs.add((local_run.weekday(), local_run.hour, local_run.minute))

    monday_to_friday_0630 = {(weekday, 6, 30) for weekday in range(5)}
    tuesday_to_saturday_0630 = {(weekday, 6, 30) for weekday in range(1, 6)}
    assert local_runs == monday_to_friday_0630
    assert local_runs != tuesday_to_saturday_0630


def test_r4_pre_trade_dry_run_present():
    assert "backend.engine.operation.r4_pre_trade --dry-run" in _TEXT


def test_r4_pre_trade_exit1_suppressed():
    assert "r4_pre_trade --dry-run || true" in _TEXT


def test_tier_a_snapshot_writer_dry_run_present():
    assert "backend.engine.tier_a.tier_a_snapshot_writer --dry-run" in _TEXT


def test_no_upload_artifact_added():
    # upload-artifact is already used in deploy.yml for dist/; must not appear
    # in the routines-stub job section of full_batch.yml
    routines_section = _TEXT.split("Job 3: Routines")[-1]
    assert "upload-artifact" not in routines_section


# ── P4-A23-1: Job 2 commit/push order guards ─────────────────────────────────

def test_git_pull_rebase_uses_explicit_remote_and_target_branch():
    assert 'git pull --rebase origin "$target_ref"' in _TEXT


def test_git_pull_rebase_does_not_hardcode_main():
    assert "git pull --rebase origin main" not in _TEXT


def test_git_add_before_pull_rebase():
    add_pos = _TEXT.index("git add data/")
    rebase_pos = _TEXT.index('git pull --rebase origin "$target_ref"')
    assert add_pos < rebase_pos, "git add must come before git pull --rebase"


def test_git_commit_before_pull_rebase():
    commit_pos = _TEXT.index('git commit -m "chore: full-batch data update')
    rebase_pos = _TEXT.index('git pull --rebase origin "$target_ref"')
    assert commit_pos < rebase_pos, "git commit must come before git pull --rebase"


def test_git_push_after_pull_rebase():
    rebase_pos = _TEXT.index('git pull --rebase origin "$target_ref"')
    push_pos = _TEXT.index("git push", rebase_pos)
    assert push_pos > rebase_pos, "git push must come after git pull --rebase"


def test_git_push_uses_explicit_matching_target_refspec():
    assert 'git push origin "HEAD:$target_ref"' in _TEXT


def test_target_branch_comes_from_actions_runtime_environment():
    assert 'target_branch="${GITHUB_REF_NAME:?' in _TEXT
    assert "${{ github.ref_name }}" not in _update_data_section()


def test_commit_push_requires_branch_ref_and_matching_checkout():
    update_data_section = _update_data_section()
    assert 'target_ref_type="${GITHUB_REF_TYPE:?' in update_data_section
    assert '[ "$target_ref_type" != "branch" ]' in update_data_section
    assert '[ "$target_ref" != "refs/heads/$target_branch" ]' in update_data_section
    assert "git check-ref-format --branch \"$target_branch\"" in update_data_section
    assert "git symbolic-ref --quiet --short HEAD" in update_data_section
    assert '[ "$checked_out_branch" != "$target_branch" ]' in update_data_section


def test_no_git_add_all():
    assert "git add ." not in _TEXT
    assert "git add -A" not in _TEXT


def test_no_contracts_in_git_add():
    # public/data/contracts must not be staged by the data-update commit step
    assert "public/data/contracts" not in _TEXT


# ── P4-A23-2: git add scope covers full data/ directory ──────────────────────

def test_git_add_covers_data_dir():
    # data/ directory must be included to catch all update-script outputs
    assert "git add data/ public/data/" in _TEXT


def test_git_add_covers_public_data_dir():
    assert "public/data/" in _TEXT


def test_no_individual_data_files_only():
    # After P4-A23-2, individual file pinning is replaced by data/ directory
    # Ensure the old narrow scope is not the only add target
    narrow_only = (
        "git add public/data/ data/candidates_news.json data/regime_state.json"
    )
    assert narrow_only not in _TEXT, "old narrow git add must be replaced by data/ scope"


# ── P4-A28: SAFE_MODE / TierA real-write wiring ──────────────────────────────

def _update_data_section() -> str:
    """Extract Job 2 (update-data) section from workflow text.

    Uses YAML job-key boundaries (two-space indented) which are unique in the file.
    Avoids splitting on the human-readable "Full Data Update" name which appears twice
    (once in a section comment header, once as the job's name: field).
    """
    return _TEXT.split("  update-data:")[1].split("  routines-stub:")[0]


def _commit_and_push_script() -> str:
    """Return the exact shell body used by the Commit and push step."""
    step = _update_data_section().split("      - name: Commit and push\n", 1)[1]
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


def _workflow_step_script(step_name: str) -> str:
    """Return a literal ``run: |`` shell body from an update-data step."""
    marker = f"      - name: {step_name}\n"
    step = _update_data_section().split(marker, 1)[1]
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


def _git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=check,
        text=True,
        capture_output=True,
    )


def _make_funnel_simulation_repo(tmp_path: Path) -> tuple[Path, Path]:
    repo = tmp_path / "funnel-worktree"
    repo.mkdir()
    _git(repo, "init", "-b", "v13.3-dev")
    _git(repo, "config", "user.name", "Test User")
    _git(repo, "config", "user.email", "test@example.com")
    (repo / "data").mkdir()
    (repo / "public" / "data").mkdir(parents=True)
    for path in (
        repo / "data" / "candidate_funnel.json",
        repo / "public" / "data" / "candidate_funnel.json",
    ):
        path.write_text('{"version":"committed"}\n')
    (repo / "data" / "unrelated.json").write_text('{"version":"old"}\n')
    _git(repo, "add", "data/", "public/data/")
    _git(repo, "commit", "-m", "baseline")

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake_python = bin_dir / "python3"
    fake_python.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"data.candidate_funnel_batch"* ]]; then
  if [ "${BATCH_WRITES:-1}" = "1" ]; then
    printf '%s\\n' '{"version":"new"}' > data/candidate_funnel.json
    printf '%s\\n' '{"version":"new"}' > public/data/candidate_funnel.json
  fi
  exit "${BATCH_EXIT:-0}"
fi
if [[ "$*" == *"data.candidate_funnel_privacy_smoke"* ]]; then
  exit "${SMOKE_EXIT:-0}"
fi
exit 97
"""
    )
    fake_python.chmod(0o755)
    return repo, bin_dir


def _run_workflow_step(
    repo: Path,
    bin_dir: Path,
    step_name: str,
    output_path: Path,
    **overrides: str,
) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env.update(overrides)
    env["GITHUB_OUTPUT"] = str(output_path)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    return subprocess.run(
        ["bash", "-c", _workflow_step_script(step_name)],
        cwd=repo,
        env=env,
        text=True,
        capture_output=True,
    )


def _step_output(path: Path, key: str) -> str:
    values = dict(line.split("=", 1) for line in path.read_text().splitlines())
    return values[key]


def _make_remote_with_release_branches(tmp_path: Path) -> Path:
    remote = tmp_path / "remote.git"
    seed = tmp_path / "seed"
    _git(tmp_path, "init", "--bare", "-b", "main", str(remote))
    _git(tmp_path, "init", "-b", "main", str(seed))
    _git(seed, "config", "user.name", "Test User")
    _git(seed, "config", "user.email", "test@example.com")
    (seed / "data").mkdir()
    (seed / "public" / "data").mkdir(parents=True)
    (seed / "data" / "base.json").write_text("{}\n")
    (seed / "public" / "data" / "base.json").write_text("{}\n")
    _git(seed, "add", "data/", "public/data/")
    _git(seed, "commit", "-m", "seed")
    _git(seed, "remote", "add", "origin", str(remote))
    _git(seed, "push", "-u", "origin", "main")
    _git(seed, "branch", "v13.3-dev")
    _git(seed, "push", "origin", "v13.3-dev")
    return remote


def _clone_branch(remote: Path, destination: Path, branch: str) -> None:
    _git(destination.parent, "clone", "--branch", branch, str(remote), str(destination))


def _run_commit_push(
    worktree: Path, branch: str, output_path: Path | None = None
) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    if output_path is None:
        output_path = worktree / "github-output"
    env.update(
        GITHUB_REF_NAME=branch,
        GITHUB_REF=f"refs/heads/{branch}",
        GITHUB_REF_TYPE="branch",
        GITHUB_OUTPUT=str(output_path),
    )
    return subprocess.run(
        ["bash", "-c", _commit_and_push_script()],
        cwd=worktree,
        env=env,
        text=True,
        capture_output=True,
    )


@pytest.mark.parametrize("branch", ["main", "v13.3-dev"])
def test_commit_push_targets_current_execution_branch(tmp_path, branch):
    remote = _make_remote_with_release_branches(tmp_path)
    worktree = tmp_path / "worktree"
    other_branch = "v13.3-dev" if branch == "main" else "main"
    other_before = _git(remote, "rev-parse", f"refs/heads/{other_branch}").stdout.strip()
    _clone_branch(remote, worktree, branch)
    (worktree / "data" / "generated.json").write_text(f'{{"branch":"{branch}"}}\n')

    result = _run_commit_push(worktree, branch)

    assert result.returncode == 0, result.stderr
    assert branch in _git(
        remote, "show", f"refs/heads/{branch}:data/generated.json"
    ).stdout
    assert _git(remote, "rev-parse", f"refs/heads/{other_branch}").stdout.strip() == other_before


def test_commit_push_rebases_onto_stale_remote_update(tmp_path):
    remote = _make_remote_with_release_branches(tmp_path)
    worktree = tmp_path / "worktree"
    updater = tmp_path / "updater"
    _clone_branch(remote, worktree, "v13.3-dev")
    _clone_branch(remote, updater, "v13.3-dev")
    _git(updater, "config", "user.name", "Remote Updater")
    _git(updater, "config", "user.email", "updater@example.com")
    (updater / "data" / "remote.json").write_text('{"remote":true}\n')
    _git(updater, "add", "data/remote.json")
    _git(updater, "commit", "-m", "concurrent remote update")
    _git(updater, "push", "origin", "v13.3-dev")
    remote_update = _git(remote, "rev-parse", "refs/heads/v13.3-dev").stdout.strip()
    (worktree / "data" / "generated.json").write_text('{"local":true}\n')

    result = _run_commit_push(worktree, "v13.3-dev")

    assert result.returncode == 0, result.stderr
    assert _git(remote, "show", "refs/heads/v13.3-dev:data/remote.json").stdout
    assert _git(remote, "show", "refs/heads/v13.3-dev:data/generated.json").stdout
    assert _git(remote, "rev-parse", "refs/heads/v13.3-dev^").stdout.strip() == remote_update


@pytest.mark.parametrize(
    ("ref_name", "ref", "ref_type", "detach"),
    [
        ("v1.0.0", "refs/tags/v1.0.0", "tag", False),
        ("main", "refs/heads/main", "branch", True),
        ("v13.3-dev", "refs/heads/v13.3-dev", "branch", False),
    ],
)
def test_commit_push_fails_closed_for_unexpected_ref_or_checkout(
    tmp_path, ref_name, ref, ref_type, detach
):
    remote = _make_remote_with_release_branches(tmp_path)
    worktree = tmp_path / "worktree"
    _clone_branch(remote, worktree, "main")
    if detach:
        _git(worktree, "checkout", "--detach")
    main_before = _git(remote, "rev-parse", "refs/heads/main").stdout.strip()
    dev_before = _git(remote, "rev-parse", "refs/heads/v13.3-dev").stdout.strip()
    (worktree / "data" / "generated.json").write_text('{"must_not_push":true}\n')
    env = os.environ.copy()
    env.update(GITHUB_REF_NAME=ref_name, GITHUB_REF=ref, GITHUB_REF_TYPE=ref_type)

    result = subprocess.run(
        ["bash", "-c", _commit_and_push_script()],
        cwd=worktree,
        env=env,
        text=True,
        capture_output=True,
    )

    assert result.returncode != 0
    assert _git(remote, "rev-parse", "refs/heads/main").stdout.strip() == main_before
    assert _git(remote, "rev-parse", "refs/heads/v13.3-dev").stdout.strip() == dev_before


def test_update_safe_mode_script_in_update_data_job():
    # update_safe_mode.py must be called in the update-data Job (Job 2)
    # so that the generated file is picked up by the git add/commit step
    assert "data/update_safe_mode.py" in _update_data_section()


def test_tier_a_snapshot_writer_real_output_to_public_data():
    # tier_a_snapshot_writer must be called with --output-dir public/data/ in update-data
    assert "--output-dir public/data/" in _update_data_section()


def test_tier_a_snapshot_writer_real_output_to_data():
    # tier_a_snapshot_writer must also write to data/ (mirror of public/data/)
    assert "--output-dir data/" in _update_data_section()


def test_safe_mode_generation_before_git_add():
    # update_safe_mode.py run command must appear before the "git add data/ public/data/" line
    # Use the actual run command, not any comment text
    safe_mode_pos = _TEXT.index("python3 data/update_safe_mode.py")
    git_add_pos = _TEXT.index("git add data/ public/data/")
    assert safe_mode_pos < git_add_pos, "safe_mode generation must come before git add"


def test_tier_a_generation_before_git_add():
    # tier_a_snapshot_writer --output-dir run command must appear before "git add data/ public/data/"
    tier_a_pos = _TEXT.index("--output-dir public/data/")
    git_add_pos = _TEXT.index("git add data/ public/data/")
    assert tier_a_pos < git_add_pos, "tier_a generation must come before git add"


def test_safe_mode_generation_after_regime_state():
    # update_safe_mode.py must run after update_regime_state.py (reads regime_state.json)
    regime_pos = _TEXT.index("data/update_regime_state.py")
    safe_mode_pos = _TEXT.index("data/update_safe_mode.py")
    assert regime_pos < safe_mode_pos, "regime_state must be built before safe_mode"


def test_smoke_test_safe_mode_present():
    # Smoke test for safe_mode.json schema must exist in update-data Job
    assert "safe_mode smoke" in _TEXT


def test_smoke_test_tier_a_present():
    # Smoke test for tier_a schemas must exist in update-data Job
    assert "tier_a smoke" in _TEXT


def test_dry_run_still_in_routines_stub():
    # dry-run health-check steps must remain in routines-stub (not removed by P4-A28)
    routines_section = _TEXT.split("Job 3: Routines")[-1]
    assert "r4_pre_trade --dry-run" in routines_section
    assert "tier_a_snapshot_writer --dry-run" in routines_section


def test_real_write_not_in_routines_stub():
    # Real writes (update_safe_mode.py, --output-dir) must NOT be in routines-stub
    # They belong in update-data Job (Job 2) where the git commit happens
    routines_section = _TEXT.split("Job 3: Routines")[-1]
    assert "update_safe_mode.py" not in routines_section
    assert "--output-dir" not in routines_section


# ── P4-A28 hardening: || true must NOT suppress real-write failures ───────────

def test_safe_mode_build_not_suppressed():
    # "python3 data/update_safe_mode.py || true" must NOT appear in update-data
    # The real write must propagate failures (|| true only allowed in health-check dry-runs)
    update_data_section = _update_data_section()
    assert "update_safe_mode.py || true" not in update_data_section


def test_tier_a_build_public_data_not_suppressed():
    # tier_a_snapshot_writer --output-dir public/data/ must NOT be followed by || true
    update_data_section = _update_data_section()
    assert "--output-dir public/data/ || true" not in update_data_section


def test_tier_a_build_data_not_suppressed():
    # tier_a_snapshot_writer --output-dir data/ must NOT be followed by || true
    update_data_section = _update_data_section()
    assert "--output-dir data/ || true" not in update_data_section


def test_safe_mode_smoke_exits_on_failure():
    # safe_mode smoke test must call sys.exit(1) on schema failure (not just print WARN)
    update_data_section = _update_data_section()
    # Confirm sys.exit(1) appears in the safe_mode smoke test block
    safe_mode_smoke_idx = update_data_section.index("safe_mode smoke")
    tier_a_smoke_idx = update_data_section.index("tier_a smoke")
    safe_mode_smoke_block = update_data_section[safe_mode_smoke_idx:tier_a_smoke_idx]
    assert "sys.exit(1)" in safe_mode_smoke_block


def test_tier_a_smoke_exits_on_failure():
    # tier_a smoke test must call sys.exit(1) on schema failure (not just print WARN)
    update_data_section = _update_data_section()
    tier_a_smoke_idx = update_data_section.index("tier_a smoke")
    tier_a_smoke_block = update_data_section[tier_a_smoke_idx:]
    assert "sys.exit(1)" in tier_a_smoke_block


def test_dry_run_suppression_preserved_in_routines_stub():
    # routines-stub dry-runs MUST keep || true (stale data is expected there)
    routines_section = _TEXT.split("Job 3: Routines")[-1]
    assert "r4_pre_trade --dry-run || true" in routines_section


# ── P5-B004e: candidates_stocks E2E completion gate ──────────────────────

def test_operation_health_runs_b004_root_tests():
    operation_section = _TEXT.split("  operation-health:")[1].split("  update-data:")[0]
    for test_file in (
        "tests/test_build_candidates_stocks.py",
        "tests/test_jpx_universe_provider.py",
        "tests/test_jpx_cheap_prescreen.py",
        "tests/test_whole_market_universe_provider.py",
        "tests/test_candidates_stocks_privacy_smoke.py",
        "tests/test_full_batch_workflow.py",
    ):
        assert test_file in operation_section


def test_candidates_builder_failure_is_not_suppressed():
    update_data_section = _update_data_section()
    assert "python3 data/build_candidates_stocks.py || true" not in update_data_section
    assert "python3 -m data.build_candidates_stocks || true" not in update_data_section
    assert "python3 -m data.build_candidates_stocks" in update_data_section


def test_candidates_run_start_is_recorded_before_build():
    update_data_section = _update_data_section()
    marker_pos = update_data_section.index("candidates-run-start")
    build_pos = update_data_section.index("python3 -m data.build_candidates_stocks")
    assert marker_pos < build_pos


def test_candidates_unique_run_token_is_generated_before_build():
    update_data_section = _update_data_section()
    token_pos = update_data_section.index("candidates-run-token")
    build_pos = update_data_section.index("python3 -m data.build_candidates_stocks")
    assert "uuid" in update_data_section[token_pos:build_pos].lower()
    assert token_pos < build_pos


def test_candidates_builder_receives_run_token():
    update_data_section = _update_data_section()
    assert '--run-token "${{ steps.candidates-run-token.outputs.run_token }}"' in update_data_section


def test_candidates_production_gate_receives_current_run_marker():
    update_data_section = _update_data_section()
    assert "data.candidates_stocks_privacy_smoke --production" in update_data_section
    assert "steps.candidates-run-start.outputs.started_at" in update_data_section
    assert '--expected-run-token "${{ steps.candidates-run-token.outputs.run_token }}"' in update_data_section


def test_candidates_production_gate_runs_after_copy():
    update_data_section = _update_data_section()
    copy_pos = update_data_section.index("Copy JSON to public/data")
    gate_pos = update_data_section.index("data.candidates_stocks_privacy_smoke --production")
    assert copy_pos < gate_pos


# ── P2-01: candidate funnel publication isolation ───────────────────────────

_FUNNEL_BUILD_STEP = (
    "Build candidate_funnel.json (prescreen join + P-01..P-15 quality gate)"
)
_FUNNEL_SMOKE_STEP = "Privacy/schema smoke test candidate_funnel.json"
_FUNNEL_ENFORCEMENT_STEP = "Enforce candidate funnel publication status"


def _assert_committed_funnel(repo: Path) -> None:
    for path in (
        "data/candidate_funnel.json",
        "public/data/candidate_funnel.json",
    ):
        assert (repo / path).read_text() == '{"version":"committed"}\n'
        assert _git(repo, "diff", "--quiet", "HEAD", "--", path, check=False).returncode == 0


def test_funnel_batch_failure_restores_twins_and_allows_unrelated_staging(tmp_path):
    """AC-P2-01-1/2/5: contained failure reaches unrelated staging, then fails terminally."""
    repo, bin_dir = _make_funnel_simulation_repo(tmp_path)
    build_output = tmp_path / "build-output"

    build = _run_workflow_step(
        repo,
        bin_dir,
        _FUNNEL_BUILD_STEP,
        build_output,
        BATCH_EXIT="23",
        BATCH_WRITES="1",
    )

    assert build.returncode == 0, build.stderr
    assert _step_output(build_output, "publication_status") == "batch_failed"
    _assert_committed_funnel(repo)

    # Structurally equivalent to the reachable SAFE_MODE/TierA writes followed by
    # the shared directory-scoped staging command.
    (repo / "data" / "safe_mode.json").write_text('{"safe":true}\n')
    (repo / "public" / "data" / "tier_a_alerts.json").write_text('{"alerts":[]}\n')
    _git(repo, "add", "data/", "public/data/")
    staged = _git(repo, "diff", "--cached", "--name-only").stdout.splitlines()
    assert staged == ["data/safe_mode.json", "public/data/tier_a_alerts.json"]

    # Production-observed branch: the unrelated data commit is pushed and exposes
    # its exact SHA before the intentionally failing terminal funnel enforcement.
    remote = tmp_path / "funnel-remote.git"
    _git(repo, "branch", "-M", "main")
    _git(tmp_path, "init", "--bare", "-b", "main", str(remote))
    _git(repo, "remote", "add", "origin", str(remote))
    _git(repo, "push", "-u", "origin", "main")
    commit_output = tmp_path / "commit-output"
    commit_push = _run_commit_push(repo, "main", commit_output)
    assert commit_push.returncode == 0, commit_push.stderr
    commit_values = dict(
        line.split("=", 1) for line in commit_output.read_text().splitlines()
    )
    assert commit_values["data_changed"] == "true"
    assert commit_values["pushed_sha"] == _git(repo, "rev-parse", "HEAD").stdout.strip()

    fake_gh = bin_dir / "gh"
    dispatch_log = tmp_path / "dispatch-log"
    fake_gh.write_text(
        "#!/usr/bin/env bash\n"
        "printf '%s\\n' \"$*\" >> \"$DISPATCH_LOG\"\n"
    )
    fake_gh.chmod(0o755)
    dispatch_env = os.environ.copy()
    dispatch_env.update(
        GITHUB_REF="refs/heads/main",
        GITHUB_REPOSITORY="example/jp-portfolio",
        PUSHED_SHA=commit_values["pushed_sha"],
        DISPATCH_LOG=str(dispatch_log),
        PATH=f"{bin_dir}{os.pathsep}{dispatch_env['PATH']}",
    )
    dispatch = subprocess.run(
        ["bash", "-c", _workflow_step_script("Dispatch Pages for pushed data")],
        cwd=repo,
        env=dispatch_env,
        text=True,
        capture_output=True,
    )
    assert dispatch.returncode == 0, dispatch.stderr
    assert dispatch_log.read_text().splitlines() == [
        f"workflow run deploy.yml --repo example/jp-portfolio --ref main "
        f"-f deploy_sha={commit_values['pushed_sha']}"
    ]

    enforcement = _run_workflow_step(
        repo,
        bin_dir,
        _FUNNEL_ENFORCEMENT_STEP,
        tmp_path / "enforcement-output",
        CANDIDATE_FUNNEL_BATCH_STATUS="batch_failed",
        CANDIDATE_FUNNEL_SMOKE_STATUS="",
    )
    assert enforcement.returncode != 0
    assert "P-01..P-15 batch gate" in enforcement.stderr

    update_data = _update_data_section()
    dispatch_pos = update_data.index("Dispatch Pages for pushed data")
    enforcement_pos = update_data.index(_FUNNEL_ENFORCEMENT_STEP)
    assert dispatch_pos < enforcement_pos
    dispatch_condition = update_data[dispatch_pos:enforcement_pos]
    assert "steps.commit-push.outputs.data_changed == 'true'" in dispatch_condition
    assert "github.ref == 'refs/heads/main'" in dispatch_condition


def test_funnel_batch_failure_with_unchanged_twins_continues_safely(tmp_path):
    """The batch module's no-publication guarantee is mechanically verified."""
    repo, bin_dir = _make_funnel_simulation_repo(tmp_path)
    output = tmp_path / "build-output"

    result = _run_workflow_step(
        repo,
        bin_dir,
        _FUNNEL_BUILD_STEP,
        output,
        BATCH_EXIT="1",
        BATCH_WRITES="0",
    )

    assert result.returncode == 0, result.stderr
    assert _step_output(output, "publication_status") == "batch_failed"
    assert "committed twins remain unchanged" in result.stderr
    _assert_committed_funnel(repo)


def test_funnel_smoke_failure_restores_generated_twins_before_staging(tmp_path):
    """AC-P2-01-3: post-generation privacy/schema failure excludes both new twins."""
    repo, bin_dir = _make_funnel_simulation_repo(tmp_path)
    build_output = tmp_path / "build-output"
    smoke_output = tmp_path / "smoke-output"

    build = _run_workflow_step(
        repo, bin_dir, _FUNNEL_BUILD_STEP, build_output, BATCH_EXIT="0"
    )
    assert build.returncode == 0, build.stderr
    assert _step_output(build_output, "publication_status") == "batch_passed"
    assert (repo / "data" / "candidate_funnel.json").read_text() == '{"version":"new"}\n'

    smoke = _run_workflow_step(
        repo,
        bin_dir,
        _FUNNEL_SMOKE_STEP,
        smoke_output,
        SMOKE_EXIT="7",
    )

    assert smoke.returncode == 0, smoke.stderr
    assert _step_output(smoke_output, "publication_status") == "smoke_failed"
    _assert_committed_funnel(repo)
    _git(repo, "add", "data/", "public/data/")
    assert _git(repo, "diff", "--cached", "--name-only").stdout == ""

    enforcement = _run_workflow_step(
        repo,
        bin_dir,
        _FUNNEL_ENFORCEMENT_STEP,
        tmp_path / "enforcement-output",
        CANDIDATE_FUNNEL_BATCH_STATUS="batch_passed",
        CANDIDATE_FUNNEL_SMOKE_STATUS="smoke_failed",
    )
    assert enforcement.returncode != 0
    assert "privacy/schema gate" in enforcement.stderr


def test_funnel_pass_keeps_new_twins_eligible_and_terminal_status_passes(tmp_path):
    """AC-P2-01-4/5: passing twins stay in shared staging and enforcement succeeds."""
    repo, bin_dir = _make_funnel_simulation_repo(tmp_path)
    build_output = tmp_path / "build-output"
    smoke_output = tmp_path / "smoke-output"

    build = _run_workflow_step(
        repo, bin_dir, _FUNNEL_BUILD_STEP, build_output, BATCH_EXIT="0"
    )
    smoke = _run_workflow_step(
        repo, bin_dir, _FUNNEL_SMOKE_STEP, smoke_output, SMOKE_EXIT="0"
    )
    assert build.returncode == 0, build.stderr
    assert smoke.returncode == 0, smoke.stderr
    assert _step_output(build_output, "publication_status") == "batch_passed"
    assert _step_output(smoke_output, "publication_status") == "smoke_passed"

    _git(repo, "add", "data/", "public/data/")
    staged = _git(repo, "diff", "--cached", "--name-only").stdout.splitlines()
    assert staged == [
        "data/candidate_funnel.json",
        "public/data/candidate_funnel.json",
    ]

    enforcement = _run_workflow_step(
        repo,
        bin_dir,
        _FUNNEL_ENFORCEMENT_STEP,
        tmp_path / "enforcement-output",
        CANDIDATE_FUNNEL_BATCH_STATUS="batch_passed",
        CANDIDATE_FUNNEL_SMOKE_STATUS="smoke_passed",
    )
    assert enforcement.returncode == 0, enforcement.stderr


def test_funnel_rollback_failure_hard_fails_before_shared_commit(tmp_path):
    """AC-P2-01-6: an unprovable rollback cannot reach Commit and push."""
    repo, bin_dir = _make_funnel_simulation_repo(tmp_path)
    head_before = _git(repo, "rev-parse", "HEAD").stdout.strip()
    real_git = shutil.which("git")
    assert real_git is not None
    fake_git = bin_dir / "git"
    fake_git.write_text(
        f"""#!/usr/bin/env bash
if [ "$1" = "restore" ]; then
  exit 91
fi
exec {real_git} "$@"
"""
    )
    fake_git.chmod(0o755)

    result = _run_workflow_step(
        repo,
        bin_dir,
        _FUNNEL_BUILD_STEP,
        tmp_path / "build-output",
        BATCH_EXIT="1",
        BATCH_WRITES="1",
    )

    assert result.returncode != 0
    assert "rollback verification failed" in result.stderr
    assert _git(repo, "diff", "--cached", "--name-only").stdout == ""
    assert _git(repo, "rev-parse", "HEAD").stdout.strip() == head_before


def test_funnel_terminal_enforcement_is_after_shared_commit_push():
    """AC-P2-01-5: failure enforcement runs only after publication had its chance."""
    section = _update_data_section()
    commit_pos = section.index("      - name: Commit and push")
    enforcement_pos = section.index(f"      - name: {_FUNNEL_ENFORCEMENT_STEP}")
    assert commit_pos < enforcement_pos
    enforcement_block = section[enforcement_pos:]
    assert "always() && !cancelled()" in enforcement_block


def test_funnel_containment_does_not_suppress_unrelated_real_write_gates():
    """AC-P2-01-7: only funnel commands capture status; other hard gates stay direct."""
    section = _update_data_section()
    assert "python3 data/update_safe_mode.py || true" not in section
    assert "tier_a_snapshot_writer --output-dir public/data/ || true" not in section
    assert "tier_a_snapshot_writer --output-dir data/ || true" not in section
    assert "data.candidates_stocks_privacy_smoke --production" in section


# ── P5-B005-JPX-UNIVERSE-PRODUCTION-RECOVERY: JPX universe cache persistence ──

_JPX_CACHE_FILE = "data/.jpx_cache/jpx_universe_cache.json"
_JPX_CACHE_RESTORE_STEP = "Restore JPX universe cache (durable last-good fallback)"
_JPX_CACHE_SAVE_STEP = "Save JPX universe cache (durable last-good fallback)"
# P5-B005-R3 BLOCKER C: replaces the R2 file-existence-only
# "Check JPX universe cache is present for save" step.
_JPX_CACHE_ELIGIBILITY_STEP = "Validate JPX cache save eligibility (current-run live provenance)"
# backward-compat alias: earlier R1 tests referenced this name for the
# restore step (the only actions/cache step at the time).
_JPX_CACHE_STEP = _JPX_CACHE_RESTORE_STEP


def _jpx_cache_step_body(section: str, step_name: str) -> str:
    return section.split(f"- name: {step_name}", 1)[1].split("- name:", 1)[0]


def test_jpx_cache_restore_uses_explicit_restore_action_with_correct_path():
    # P5-B005-R2 BLOCKER D: restore/save must be split into the explicit
    # actions/cache/restore + actions/cache/save actions, never the combined
    # actions/cache action (whose post-job save carries an implicit
    # success()-gated skip — see test_no_combined_actions_cache_regression).
    section = _update_data_section()
    assert _JPX_CACHE_RESTORE_STEP in section
    step = _jpx_cache_step_body(section, _JPX_CACHE_RESTORE_STEP)
    assert "uses: actions/cache/restore@v4" in step
    assert f"path: {_JPX_CACHE_FILE}" in step


def test_jpx_cache_save_uses_explicit_save_action_with_correct_path_and_key():
    section = _update_data_section()
    assert _JPX_CACHE_SAVE_STEP in section
    step = _jpx_cache_step_body(section, _JPX_CACHE_SAVE_STEP)
    assert "uses: actions/cache/save@v4" in step
    assert f"path: {_JPX_CACHE_FILE}" in step
    # same rotating primary key as the restore step — never the restored
    # (stale) key, so a live-refreshed cache always rotates forward (§28).
    assert "key: jpx-universe-cache-v1-${{ runner.os }}-${{ github.run_id }}" in step
    # restore-keys is meaningless (and unsupported) for actions/cache/save.
    assert "restore-keys:" not in step


def test_jpx_cache_save_condition_depends_on_current_run_provenance_not_file_presence():
    # P5-B005-R3 BLOCKER C: the save step's own `if:` must depend on the
    # explicit current-run live-provenance validation step's output — never
    # bare file existence (the R2 bug: an invalid restored cache left on
    # disk by a rejected-cache-then-seed-fallback run would still satisfy a
    # pure existence check and get rotated into a fresh key) — and never
    # `if: success()` / `if: always()` tied to the whole job's final outcome
    # (the R1 bug).
    section = _update_data_section()
    save_step = _jpx_cache_step_body(section, _JPX_CACHE_SAVE_STEP)
    assert "if: steps.jpx-cache-save-eligibility.outputs.save_eligible == 'true'" in save_step
    assert "success()" not in save_step
    assert "always()" not in save_step
    assert "cache_exists" not in save_step

    eligibility_step = _jpx_cache_step_body(section, _JPX_CACHE_ELIGIBILITY_STEP)
    assert "id: jpx-cache-save-eligibility" in eligibility_step
    assert "save_eligible" in eligibility_step


def test_jpx_cache_save_eligibility_uses_current_run_pipeline_path_and_run_token():
    # §24/§26: current-run provenance must come from existing fields already
    # produced this run — candidates_stocks.json's _meta.pipelinePath (only
    # "normal" for a fresh live JPX success; whole_market_universe_provider()
    # sets it to "cache_fallback"/"seed_fallback" otherwise) and _meta.runToken
    # (from the existing candidates-run-token step), not an invented schema.
    section = _update_data_section()
    step = _jpx_cache_step_body(section, _JPX_CACHE_ELIGIBILITY_STEP)
    assert "steps.candidates-run-token.outputs.run_token" in step
    assert "steps.candidates-run-start.outputs.started_at" in step
    assert "pipelinePath" in step
    assert 'pipeline_path != "normal"' in step
    assert "runToken" in step


def test_jpx_cache_save_eligibility_revalidates_cache_through_canonical_validator():
    # §11: the eligibility gate must reuse the same canonical cache
    # authority validator the provider itself uses for save/load — not a
    # second, independently-defined notion of a valid cache.
    section = _update_data_section()
    step = _jpx_cache_step_body(section, _JPX_CACHE_ELIGIBILITY_STEP)
    assert "from data.jpx_universe_provider import CACHE_PATH, cache_authority_valid" in step
    assert "cache_authority_valid(payload, now)" in step


def test_jpx_cache_save_eligibility_checks_freshness_against_run_start():
    # §26/§32: a valid cache used only as a fallback (live failed, restored
    # cache still authority-valid) must not be treated as freshly refreshed —
    # its fetched_at predates this run's own started_at.
    section = _update_data_section()
    step = _jpx_cache_step_body(section, _JPX_CACHE_ELIGIBILITY_STEP)
    assert "fetched_at" in step
    assert "run_started - fetched_at" in step


def test_jpx_cache_save_eligibility_never_fails_the_job_on_fallback():
    # §25: a legitimate JPX fallback (cache or seed) must not fail the whole
    # job — the step only ever sets save_eligible=false, never a non-zero
    # exit for that case.
    section = _update_data_section()
    step = _jpx_cache_step_body(section, _JPX_CACHE_ELIGIBILITY_STEP)
    assert "save_eligible=false" in step
    assert "save_eligible=true" in step
    assert "exit 1" not in step
    assert "set -e" not in step


def test_jpx_cache_save_eligibility_is_after_gate_and_before_save():
    section = _update_data_section()
    gate_pos = section.index("Gate candidates_stocks E2E contract")
    eligibility_pos = section.index(_JPX_CACHE_ELIGIBILITY_STEP)
    save_pos = section.index(_JPX_CACHE_SAVE_STEP)
    assert gate_pos < eligibility_pos < save_pos


def test_jpx_cache_check_file_existence_only_step_is_removed():
    # R2's "Check JPX universe cache is present for save" step (bare
    # existence check, no current-run provenance) must not remain anywhere —
    # a step name reappearing would silently reintroduce a second,
    # weaker save gate alongside the eligibility one.
    assert "Check JPX universe cache is present for save" not in _TEXT


def test_no_combined_actions_cache_regression():
    # Guard against regressing back to the single combined `actions/cache@v4`
    # step, whose automatic post-job save is skipped whenever any later step
    # in the job fails (BLOCKER D). Only the explicit restore/save actions
    # are allowed anywhere in the workflow.
    for line in _TEXT.splitlines():
        stripped = line.strip()
        if stripped.startswith("uses: actions/cache@"):
            raise AssertionError(f"combined actions/cache action must not be used: {line!r}")


def test_jpx_cache_restore_is_after_reanchor():
    section = _update_data_section()
    reanchor_pos = section.index("Re-anchor to latest remote tip")
    cache_pos = section.index(_JPX_CACHE_RESTORE_STEP)
    assert reanchor_pos < cache_pos, "cache restore must run after the re-anchor gate"


def test_jpx_cache_restore_is_before_candidates_provider_execution():
    section = _update_data_section()
    cache_pos = section.index(_JPX_CACHE_RESTORE_STEP)
    build_pos = section.index("python3 -m data.build_candidates_stocks")
    assert cache_pos < build_pos, "cache restore must run before the whole-market provider"


def test_jpx_cache_save_is_after_candidates_stocks_build_and_its_gate():
    # §25: save must happen only after both the whole-market acquisition
    # step and its own schema/privacy/provenance/freshness contract gate
    # have succeeded (sequential step ordering enforces this at runtime).
    section = _update_data_section()
    build_pos = section.index("python3 -m data.build_candidates_stocks")
    gate_pos = section.index("Gate candidates_stocks E2E contract")
    save_pos = section.index(_JPX_CACHE_SAVE_STEP)
    assert build_pos < gate_pos < save_pos


def test_jpx_cache_save_is_before_candidate_funnel_build_and_terminal_enforcement():
    # §25/§29: save must run before candidate funnel generation and the
    # terminal publication enforcement step, so a later funnel failure can
    # never prevent the JPX cache that was already validated from being
    # persisted.
    section = _update_data_section()
    save_pos = section.index(_JPX_CACHE_SAVE_STEP)
    funnel_build_pos = section.index("Build candidate_funnel.json")
    enforce_pos = section.index("Enforce candidate funnel publication status")
    assert save_pos < funnel_build_pos
    assert save_pos < enforce_pos


def test_jpx_cache_has_versioned_key_and_stable_restore_prefix():
    section = _update_data_section()
    step = _jpx_cache_step_body(section, _JPX_CACHE_RESTORE_STEP)
    # rotating exact key: schema version + os + per-run uniqueness
    assert "key: jpx-universe-cache-v1-${{ runner.os }}-${{ github.run_id }}" in step
    # stable restore prefix so a later run restores the newest prior cache
    assert "restore-keys:" in step
    assert "jpx-universe-cache-v1-${{ runner.os }}-\n" in step


def test_jpx_cache_scope_is_single_universe_file_not_whole_dir():
    section = _update_data_section()
    for step_name in (_JPX_CACHE_RESTORE_STEP, _JPX_CACHE_SAVE_STEP):
        step = _jpx_cache_step_body(section, step_name)
        # smallest safe scope: the prescreen cache in the same dir is NOT persisted
        assert "path: data/.jpx_cache\n" not in step
        assert "cheap_prescreen_cache" not in step


def test_jpx_cache_is_never_staged_copied_or_published():
    for line in _TEXT.splitlines():
        if ".jpx_cache" not in line and "jpx_universe_cache" not in line:
            continue
        low = line.lower()
        assert "git add" not in low, line
        assert "cp " not in low, line
        assert "upload-artifact" not in low, line
        assert "public/data" not in low, line
    copy_step = _TEXT.split("Copy JSON to public/data", 1)[1].split("- name:", 1)[0]
    assert "jpx_cache" not in copy_step


def test_jpx_cache_file_is_git_ignored():
    repo_root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["git", "check-ignore", "-q", _JPX_CACHE_FILE], cwd=repo_root
    )
    assert result.returncode == 0


def test_openpyxl_installed_in_both_provider_execution_paths():
    # §21: every Full Batch dependency-install step that can execute the JPX
    # provider / build_candidates_stocks must install the xlsx parser.
    operation_section = _TEXT.split("  operation-health:")[1].split("  update-data:")[0]
    update_section = _update_data_section()
    for section in (operation_section, update_section):
        pip_lines = [l for l in section.splitlines() if "pip install" in l]
        assert pip_lines
        assert all("openpyxl" in l for l in pip_lines), pip_lines
        assert all("xlrd" in l for l in pip_lines), pip_lines


def test_safe_start_guard_job_is_unchanged_shape():
    # §29: safe-start recovery is CLOSED — this ticket must not alter it.
    assert "safe-start-guard:" in _TEXT
    assert "late_run_guard --workflow full" in _TEXT
    assert "needs: [safe-start-guard]" in _TEXT
    assert _TEXT.count("- cron: '30 21 * * 0-4'") == 1
