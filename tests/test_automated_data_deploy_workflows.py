"""Shared Pages-dispatch contract for every automated production data producer."""

import os
from pathlib import Path
import shutil
import subprocess

import pytest


_ROOT = Path(__file__).parents[1]
_PRODUCERS = {
    "full_batch": _ROOT / ".github" / "workflows" / "full_batch.yml",
    "update-data": _ROOT / ".github" / "workflows" / "update-data.yml",
    "intraday_patch": _ROOT / ".github" / "workflows" / "intraday_patch.yml",
}


def _text(producer: str) -> str:
    return _PRODUCERS[producer].read_text()


def _job_step_script(producer: str, step_name: str) -> str:
    text = _text(producer)
    marker = f"      - name: {step_name}\n"
    step = text.split(marker, 1)[1]
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


def _make_remote(tmp_path: Path, producer: str) -> tuple[Path, Path]:
    remote = tmp_path / "remote.git"
    seed = tmp_path / "seed"
    subprocess.run(
        ["git", "init", "--bare", "-b", "main", str(remote)],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "init", "-b", "main", str(seed)],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    )
    for args in (
        ("config", "user.name", "Test User"),
        ("config", "user.email", "test@example.com"),
    ):
        subprocess.run(["git", *args], cwd=seed, check=True)
    (seed / "data").mkdir()
    (seed / "public" / "data").mkdir(parents=True)
    paths = (
        "data/market.json",
        "data/news.json",
        "data/candidates_news.json",
        "data/regime_state.json",
        "public/data/market.json",
        "public/data/news.json",
        "public/data/candidates_news.json",
    )
    if producer == "update-data":
        # Only canonical tracked source outputs required by Update's real git add.
        # holding_evidence, returns and the score backup stay run-local sources.
        paths += (
            "data/correlation.json",
            "data/earnings_calendar.json",
            "data/flows.json",
            "data/macro.json",
            "data/margin.json",
            "data/market_intel.json",
            "data/sq_calendar.json",
            "data/stock_scores_6axis.json",
        )
    for path in paths:
        (seed / path).write_text('{"version":"old"}\n')
    subprocess.run(["git", "add", "data/", "public/data/"], cwd=seed, check=True)
    subprocess.run(["git", "commit", "-m", "seed"], cwd=seed, check=True)
    subprocess.run(["git", "remote", "add", "origin", str(remote)], cwd=seed, check=True)
    subprocess.run(["git", "push", "-u", "origin", "main"], cwd=seed, check=True)
    return remote, seed


def _run_commit_step(
    producer: str,
    worktree: Path,
    output: Path,
    *,
    path_override: str | None = None,
    env_overrides: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env.update(
        GITHUB_OUTPUT=str(output),
        GITHUB_REF_NAME="main",
        GITHUB_REF="refs/heads/main",
        GITHUB_REF_TYPE="branch",
    )
    if path_override is not None:
        env["PATH"] = path_override
    if env_overrides:
        env.update(env_overrides)
    return subprocess.run(
        [
            "bash",
            "-e",
            "-o",
            "pipefail",
            "-c",
            _job_step_script(producer, "Commit and push"),
        ],
        cwd=worktree,
        env=env,
        text=True,
        capture_output=True,
    )


def _outputs(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    return dict(line.split("=", 1) for line in path.read_text().splitlines())


@pytest.mark.parametrize("producer", _PRODUCERS)
def test_prod_01_successful_commit_exposes_exact_pushed_sha(tmp_path, producer):
    remote, worktree = _make_remote(tmp_path, producer)
    (worktree / "public" / "data" / "market.json").write_text(
        '{"version":"new"}\n'
    )
    if producer == "intraday_patch":
        (worktree / "data" / "market.json").write_text('{"version":"new"}\n')
    output = tmp_path / "output"

    result = _run_commit_step(producer, worktree, output)

    assert result.returncode == 0, result.stderr
    values = _outputs(output)
    remote_sha = subprocess.run(
        ["git", "rev-parse", "refs/heads/main"],
        cwd=remote,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    assert values["data_changed"] == "true"
    assert values["pushed_sha"] == remote_sha
    assert len(remote_sha) == 40


@pytest.mark.parametrize("producer", _PRODUCERS)
def test_prod_02_no_change_exposes_false_and_has_no_dispatch_candidate(
    tmp_path, producer
):
    remote, worktree = _make_remote(tmp_path, producer)
    before = subprocess.run(
        ["git", "rev-parse", "refs/heads/main"],
        cwd=remote,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    output = tmp_path / "output"

    result = _run_commit_step(producer, worktree, output)

    assert result.returncode == 0, result.stderr
    assert _outputs(output) == {"data_changed": "false"}
    after = subprocess.run(
        ["git", "rev-parse", "refs/heads/main"],
        cwd=remote,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    assert after == before


@pytest.mark.parametrize("producer", _PRODUCERS)
def test_prod_03_failed_push_never_exposes_success(tmp_path, producer):
    _, worktree = _make_remote(tmp_path, producer)
    (worktree / "public" / "data" / "market.json").write_text(
        '{"version":"new"}\n'
    )
    if producer == "intraday_patch":
        (worktree / "data" / "market.json").write_text('{"version":"new"}\n')
    output = tmp_path / "output"
    real_git = shutil.which("git")
    assert real_git is not None
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake_git = bin_dir / "git"
    fake_git.write_text(
        f'''#!/usr/bin/env bash
if [ "$1" = "push" ]; then
  exit 71
fi
exec "{real_git}" "$@"
'''
    )
    fake_git.chmod(0o755)

    result = _run_commit_step(
        producer,
        worktree,
        output,
        path_override=f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
    )

    assert result.returncode == 71
    assert _outputs(output) == {"data_changed": "false"}


@pytest.mark.parametrize("producer", _PRODUCERS)
def test_prod_04_05_dispatch_is_main_only_with_runtime_fail_closed_guard(
    tmp_path, producer
):
    text = _text(producer)
    dispatch_step = text.split("      - name: Dispatch Pages for pushed data\n", 1)[1]
    condition = dispatch_step.splitlines()[0]
    script = _job_step_script(producer, "Dispatch Pages for pushed data")

    assert "steps.commit-push.outputs.data_changed == 'true'" in condition
    assert "github.ref == 'refs/heads/main'" in condition
    assert 'GITHUB_REF:?GITHUB_REF is required' in script
    assert '!= "refs/heads/main"' in script

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    dispatch_log = tmp_path / "dispatch-log"
    fake_gh = bin_dir / "gh"
    fake_gh.write_text(
        "#!/usr/bin/env bash\n"
        "printf '%s\\n' \"$*\" >> \"$DISPATCH_LOG\"\n"
    )
    fake_gh.chmod(0o755)
    env = os.environ.copy()
    env.update(
        GITHUB_REF="refs/heads/v13.3-dev",
        GITHUB_REPOSITORY="example/jp-portfolio",
        PUSHED_SHA="1" * 40,
        DISPATCH_LOG=str(dispatch_log),
        PATH=f"{bin_dir}{os.pathsep}{env['PATH']}",
    )
    result = subprocess.run(
        ["bash", "-c", script], env=env, text=True, capture_output=True
    )
    assert result.returncode != 0
    assert not dispatch_log.exists()


@pytest.mark.parametrize("producer", _PRODUCERS)
def test_prod_06_dispatches_existing_deploy_workflow_once(producer):
    text = _text(producer)
    script = _job_step_script(producer, "Dispatch Pages for pushed data")

    assert script.count("gh workflow run deploy.yml") == 1
    assert '--ref main' in script
    assert '-f "deploy_sha=$PUSHED_SHA"' in script
    assert "upload-pages-artifact" not in text
    assert "deploy-pages" not in text
    assert "actions: write" in text
    assert "contents: write" in text


# ── OPS P14 v13.4 H01: forward-only release history ──────────────────────────
# These tests execute the ACTUAL extracted "Commit and push" body of every
# producer against filesystem-local bare remotes only (no GitHub, no network).
# The git boundary used below only LOGS and, in explicitly named seams, makes one
# subcommand fail; every successful fetch / push / ls-remote is real git.

_HISTORY_UNSAFE_SUBCOMMANDS = {
    "pull", "rebase", "merge", "reset", "cherry-pick", "revert", "am",
    "update-ref", "filter-branch",
}
_TARGET_REF = "refs/heads/main"
_BOGUS_OID = "1" * 40


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, text=True, capture_output=True
    ).stdout.strip()


def _edit_data(producer: str, worktree: Path) -> None:
    (worktree / "public" / "data" / "market.json").write_text('{"version":"new"}\n')
    if producer == "intraday_patch":
        (worktree / "data" / "market.json").write_text('{"version":"new"}\n')


def _install_git_wrapper(
    tmp_path: Path, *, fail_subcommand: str | None = None, ls_remote: str | None = None
) -> tuple[str, Path]:
    """Logging git boundary. Everything is delegated to real git except the one
    explicitly requested failure seam / unusable post-push observation."""
    real_git = shutil.which("git")
    assert real_git is not None
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "git-log"
    log.write_text("")
    lines = ["#!/usr/bin/env bash", f'printf "%s\\n" "$*" >> "{log}"']
    if fail_subcommand is not None:
        lines.append(f'if [ "$1" = "{fail_subcommand}" ]; then exit 73; fi')
    if ls_remote == "unavailable":
        lines.append('if [ "$1" = "ls-remote" ]; then exit 2; fi')
    elif ls_remote == "unequal":
        lines.append(
            'if [ "$1" = "ls-remote" ]; then '
            f'printf "%s\\trefs/heads/main\\n" "{_BOGUS_OID}"; exit 0; fi'
        )
    elif ls_remote == "other_ref":
        lines.append(
            'if [ "$1" = "ls-remote" ]; then '
            f'printf "%s\\trefs/heads/other\\n" "$("{real_git}" rev-parse HEAD)"; exit 0; fi'
        )
    elif ls_remote == "two_records":
        lines.append(
            'if [ "$1" = "ls-remote" ]; then '
            f'head="$("{real_git}" rev-parse HEAD)"; '
            'printf "%s\\trefs/heads/main\\n%s\\trefs/heads/main\\n" "$head" "$head"; exit 0; fi'
        )
    lines.append(f'exec "{real_git}" "$@"')
    wrapper = bin_dir / "git"
    wrapper.write_text("\n".join(lines) + "\n")
    wrapper.chmod(0o755)
    return f"{bin_dir}{os.pathsep}{os.environ['PATH']}", log


def _logged_commands(log: Path) -> list[list[str]]:
    return [line.split(" ") for line in log.read_text().splitlines() if line]


def _first_index(commands: list[list[str]], subcommand: str) -> int:
    return next(i for i, command in enumerate(commands) if command[0] == subcommand)


def _bare_main(remote: Path) -> str:
    return _git(remote, "rev-parse", _TARGET_REF)


def _parents(worktree: Path, revision: str) -> list[str]:
    return _git(worktree, "rev-list", "--parents", "-n", "1", revision).split()[1:]


def _commit_and_push_seed_file(worktree: Path, name: str = "notes.txt") -> str:
    (worktree / name).write_text("note\n")
    _git(worktree, "add", name)
    _git(worktree, "commit", "-m", "tracked note")
    _git(worktree, "push", "origin", "main")
    return _git(worktree, "rev-parse", "HEAD")


def _active_lines(producer: str) -> list[str]:
    return [
        line.strip()
        for line in _job_step_script(producer, "Commit and push").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


@pytest.mark.parametrize("scenario", ["data_change", "no_change"])
@pytest.mark.parametrize("producer", _PRODUCERS)
def test_release_history_no_rebase_in_any_production_push_block(
    tmp_path, producer, scenario
):
    active = _active_lines(producer)
    for forbidden in (
        "git pull", "rebase", "git merge ", "git reset", "--force", "--amend", "--delete",
    ):
        assert not any(forbidden in line for line in active), forbidden
    assert sum('git push origin "HEAD:$target_ref"' in line for line in active) == 1
    assert not any(
        line.startswith("git push") and 'origin "HEAD:$target_ref"' not in line
        for line in active
    )

    remote, worktree = _make_remote(tmp_path, producer)
    base = _git(worktree, "rev-parse", "HEAD")
    if scenario == "data_change":
        _edit_data(producer, worktree)
    path, log = _install_git_wrapper(tmp_path)
    output = tmp_path / "output"

    result = _run_commit_step(producer, worktree, output, path_override=path)

    assert result.returncode == 0, result.stderr
    commands = _logged_commands(log)
    subcommands = {command[0] for command in commands}
    assert not subcommands & _HISTORY_UNSAFE_SUBCOMMANDS
    assert not any(command[:2] == ["commit", "--amend"] for command in commands)
    assert ["fetch", "--no-tags", "origin", _TARGET_REF] in commands
    assert ["push", "origin", f"HEAD:{_TARGET_REF}"] in commands
    assert ["ls-remote", "--exit-code", "--refs", "origin", _TARGET_REF] in commands
    assert not any(
        command[0] in {"fetch", "push"} and any(arg.startswith(("+", "--force", "-f")) for arg in command)
        for command in commands
    )
    fetch, push, observe = (
        _first_index(commands, name) for name in ("fetch", "push", "ls-remote")
    )
    assert fetch < push < observe
    head = _git(worktree, "rev-parse", "HEAD")
    if scenario == "data_change":
        assert _first_index(commands, "commit") < fetch
        assert _parents(worktree, head) == [base]
        assert _bare_main(remote) == head != base
        assert _outputs(output) == {"data_changed": "true", "pushed_sha": head}
    else:
        assert head == base == _bare_main(remote)
        assert _outputs(output) == {"data_changed": "false"}


@pytest.mark.parametrize("advance", ["forward_child", "unrelated_root"])
@pytest.mark.parametrize("producer", _PRODUCERS)
def test_release_history_remote_advance_fails_without_success_outputs(
    tmp_path, producer, advance
):
    remote, worktree = _make_remote(tmp_path, producer)
    base = _git(worktree, "rev-parse", "HEAD")
    _edit_data(producer, worktree)
    other = tmp_path / "other"
    _git(tmp_path, "clone", str(remote), str(other))
    for args in (("config", "user.name", "Other"), ("config", "user.email", "other@example.com")):
        _git(other, *args)
    if advance == "forward_child":
        (other / "public" / "data" / "news.json").write_text('{"version":"remote"}\n')
        _git(other, "add", "public/data/news.json")
        _git(other, "commit", "-m", "remote advance")
        _git(other, "push", "origin", "main")
    else:
        _git(other, "checkout", "--orphan", "alt")
        _git(other, "commit", "--allow-empty", "-m", "unrelated root")
        _git(other, "push", "origin", "alt")
        _git(remote, "update-ref", _TARGET_REF, "refs/heads/alt")
    moved = _bare_main(remote)
    assert moved != base
    path, log = _install_git_wrapper(tmp_path)
    output = tmp_path / "output"

    result = _run_commit_step(producer, worktree, output, path_override=path)

    assert result.returncode != 0
    assert _outputs(output) == {"data_changed": "false"}
    commands = _logged_commands(log)
    assert any(command[0] == "fetch" for command in commands)
    assert not any(command[0] in {"push", "ls-remote"} for command in commands)
    assert _bare_main(remote) == moved
    # The already-created local generated commit is retained, never rewritten.
    assert _parents(worktree, "HEAD") == [base]


@pytest.mark.parametrize("failure", ["fetch_exit", "missing_ref", "ancestor_exit"])
@pytest.mark.parametrize("producer", _PRODUCERS)
def test_release_history_fetch_and_ancestor_failure_stop_before_push(
    tmp_path, producer, failure
):
    remote, worktree = _make_remote(tmp_path, producer)
    base = _git(worktree, "rev-parse", "HEAD")
    _edit_data(producer, worktree)
    kwargs = {}
    if failure == "fetch_exit":
        kwargs["fail_subcommand"] = "fetch"
    elif failure == "ancestor_exit":
        # Identity setup passes against real git; only the ancestry command fails.
        kwargs["fail_subcommand"] = "merge-base"
    else:
        _git(remote, "update-ref", "-d", _TARGET_REF)
    path, log = _install_git_wrapper(tmp_path, **kwargs)
    output = tmp_path / "output"

    result = _run_commit_step(producer, worktree, output, path_override=path)

    assert result.returncode != 0
    assert _outputs(output) == {"data_changed": "false"}
    commands = _logged_commands(log)
    assert not any(command[0] in {"push", "ls-remote"} for command in commands)
    if failure == "ancestor_exit":
        assert _first_index(commands, "fetch") < _first_index(commands, "merge-base")
        assert _bare_main(remote) == base
    elif failure == "fetch_exit":
        assert _bare_main(remote) == base
    else:
        assert subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", _TARGET_REF], cwd=remote
        ).returncode != 0
    assert _parents(worktree, "HEAD") == [base]


def _scenario_state(scenario: str, worktree: Path) -> dict[str, str]:
    """Apply one ineligible / unclean state; returns env overrides."""
    market = worktree / "public" / "data" / "market.json"
    if scenario == "duplicate_key":
        market.write_text('{"version":"a","version":"b"}\n')
    elif scenario == "nonfinite_number":
        market.write_text('{"version":NaN}\n')
    elif scenario == "invalid_utf8":
        market.write_bytes(b"\xff\xfe\n")
    elif scenario == "added_data_file":
        (worktree / "public" / "data" / "extra.json").write_text("{}\n")
    elif scenario == "deleted_data_file":
        (worktree / "public" / "data" / "news.json").unlink()
    elif scenario == "mode_change":
        market.write_text('{"version":"new"}\n')
        market.chmod(0o755)
    elif scenario == "unstaged_tracked_leftover":
        (worktree / "notes.txt").write_text("changed\n")
    elif scenario == "untracked_release_file":
        (worktree / "stray.txt").write_text("stray\n")
    elif scenario == "detached_head":
        _git(worktree, "checkout", "--detach")
    elif scenario == "tag_ref":
        return {"GITHUB_REF_TYPE": "tag"}
    elif scenario == "ref_mismatch":
        return {"GITHUB_REF": "refs/heads/other"}
    else:  # pragma: no cover - parametrization guard
        raise AssertionError(scenario)
    return {}


@pytest.mark.parametrize(
    "scenario",
    [
        "duplicate_key", "nonfinite_number", "invalid_utf8", "added_data_file",
        "deleted_data_file", "mode_change", "unstaged_tracked_leftover",
        "untracked_release_file", "detached_head", "tag_ref", "ref_mismatch",
    ],
)
@pytest.mark.parametrize("producer", _PRODUCERS)
def test_release_history_ineligible_ref_or_state_stops_before_commit_and_transport(
    tmp_path, producer, scenario
):
    remote, worktree = _make_remote(tmp_path, producer)
    _git(worktree, "config", "core.fileMode", "true")
    base = _commit_and_push_seed_file(worktree)
    env_overrides = _scenario_state(scenario, worktree)
    path, log = _install_git_wrapper(tmp_path)
    output = tmp_path / "output"

    result = _run_commit_step(
        producer, worktree, output, path_override=path, env_overrides=env_overrides
    )

    assert result.returncode != 0
    assert _outputs(output) == {"data_changed": "false"}
    commands = _logged_commands(log)
    assert not any(command[0] in {"commit", "fetch", "push", "ls-remote"} for command in commands)
    assert _git(worktree, "rev-parse", "HEAD") == base
    assert _bare_main(remote) == base


@pytest.mark.parametrize("producer", _PRODUCERS)
def test_release_history_arbitrary_local_ahead_history_is_not_pushed(tmp_path, producer):
    remote, worktree = _make_remote(tmp_path, producer)
    remote_tip = _bare_main(remote)
    (worktree / "public" / "data" / "news.json").write_text('{"version":"local-ahead"}\n')
    _git(worktree, "add", "public/data/news.json")
    _git(worktree, "commit", "-m", "unpushed local work")
    local_ahead = _git(worktree, "rev-parse", "HEAD")
    _edit_data(producer, worktree)
    path, log = _install_git_wrapper(tmp_path)
    output = tmp_path / "output"

    result = _run_commit_step(producer, worktree, output, path_override=path)

    assert result.returncode != 0
    assert _outputs(output) == {"data_changed": "false"}
    assert not any(command[0] in {"push", "ls-remote"} for command in _logged_commands(log))
    assert _bare_main(remote) == remote_tip != local_ahead


@pytest.mark.parametrize("producer", _PRODUCERS)
def test_release_history_rejected_push_stops_and_keeps_actual_state(tmp_path, producer):
    remote, worktree = _make_remote(tmp_path, producer)
    base = _git(worktree, "rev-parse", "HEAD")
    _edit_data(producer, worktree)
    hook = remote / "hooks" / "pre-receive"
    hook.write_text("#!/bin/sh\nexit 1\n")
    hook.chmod(0o755)
    path, log = _install_git_wrapper(tmp_path)
    output = tmp_path / "output"

    result = _run_commit_step(producer, worktree, output, path_override=path)

    assert result.returncode != 0
    assert _outputs(output) == {"data_changed": "false"}
    commands = _logged_commands(log)
    assert any(command[0] == "push" for command in commands)
    assert not any(command[0] == "ls-remote" for command in commands)
    assert _bare_main(remote) == base
    assert _parents(worktree, "HEAD") == [base]


@pytest.mark.parametrize(
    "observation", ["unavailable", "unequal", "other_ref", "two_records"]
)
@pytest.mark.parametrize("producer", _PRODUCERS)
def test_release_history_unconfirmed_post_push_observation_emits_no_success(
    tmp_path, producer, observation
):
    remote, worktree = _make_remote(tmp_path, producer)
    base = _git(worktree, "rev-parse", "HEAD")
    _edit_data(producer, worktree)
    path, _log = _install_git_wrapper(tmp_path, ls_remote=observation)
    output = tmp_path / "output"

    result = _run_commit_step(producer, worktree, output, path_override=path)

    assert result.returncode != 0
    assert "PUSH_OUTCOME_UNCONFIRMED" in result.stderr
    assert _outputs(output) == {"data_changed": "false"}
    # The push itself really happened; the actual state is recorded, not assumed.
    head = _git(worktree, "rev-parse", "HEAD")
    assert _parents(worktree, head) == [base]
    assert _bare_main(remote) == head


def test_only_the_three_audited_workflows_push_production_data():
    pushing = []
    for path in (_ROOT / ".github" / "workflows").glob("*.yml"):
        if "git push" in path.read_text():
            pushing.append(path.name)
    assert sorted(pushing) == ["full_batch.yml", "intraday_patch.yml", "update-data.yml"]


@pytest.mark.parametrize("producer", _PRODUCERS)
def test_normal_main_push_cannot_trigger_a_producer_dispatch(producer):
    trigger = _text(producer).split("on:\n", 1)[1].split("\npermissions:", 1)[0]
    assert "schedule:" in trigger
    assert "workflow_dispatch:" in trigger
    assert "push:" not in trigger
