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


def _make_remote(tmp_path: Path) -> tuple[Path, Path]:
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
    for path in (
        "data/market.json",
        "data/news.json",
        "data/candidates_news.json",
        "data/regime_state.json",
        "public/data/market.json",
        "public/data/news.json",
        "public/data/candidates_news.json",
    ):
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
    remote, worktree = _make_remote(tmp_path)
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
    remote, worktree = _make_remote(tmp_path)
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
    _, worktree = _make_remote(tmp_path)
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
