"""OPS-ROUTINES-3-R2 ref re-anchor gate contract tests."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess

import pytest

from backend.engine.operation import ref_reanchor_gate as gate


BRANCH = "v13.3-dev"


def git(cwd: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", *arguments],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def configure(repository: Path) -> None:
    git(repository, "config", "user.name", "Reanchor Test")
    git(repository, "config", "user.email", "reanchor@example.invalid")
    git(repository, "config", "commit.gpgsign", "false")


def commit_file(repository: Path, relative: str, content: str) -> str:
    path = repository / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    git(repository, "add", relative)
    git(repository, "commit", "-m", f"update {relative}")
    return git(repository, "rev-parse", "HEAD")


@pytest.fixture
def repositories(tmp_path):
    remote = tmp_path / "remote.git"
    writer = tmp_path / "writer"
    checkout = tmp_path / "checkout"
    git(tmp_path, "init", "--bare", str(remote))
    git(tmp_path, "init", "-b", BRANCH, str(writer))
    configure(writer)
    commit_file(writer, "README.md", "initial\n")
    git(writer, "remote", "add", "origin", str(remote))
    git(writer, "push", "-u", "origin", BRANCH)
    git(tmp_path, "clone", "--branch", BRANCH, str(remote), str(checkout))
    configure(checkout)
    return writer, checkout, remote


def environment(checkout: Path, summary: Path | None = None, **extra: str):
    env = {
        "GITHUB_REF": f"refs/heads/{BRANCH}",
        "GITHUB_SHA": git(checkout, "rev-parse", "HEAD"),
    }
    if summary is not None:
        env["GITHUB_STEP_SUMMARY"] = str(summary)
    env.update(extra)
    return env


def push_file(writer: Path, relative: str, content: str) -> str:
    sha = commit_file(writer, relative, content)
    git(writer, "push", "origin", BRANCH)
    return sha


def test_no_drift_continues_at_remote_tip(repositories):
    _, checkout, _ = repositories

    result = gate.evaluate(env=environment(checkout), cwd=checkout)

    assert result.exit_code == 0
    assert result.decision == "CONTINUE"
    assert result.reason == "no_drift_head_at_tip"
    assert result.remote_tip == git(checkout, "rev-parse", "HEAD")
    assert result.drift_paths == ()


def test_data_only_drift_is_fast_forwarded(repositories):
    writer, checkout, _ = repositories
    old_head = git(checkout, "rev-parse", "HEAD")
    remote_tip = push_file(writer, "data/example.json", '{"ok":true}\n')

    result = gate.evaluate(env=environment(checkout), cwd=checkout)

    assert old_head != remote_tip
    assert result.exit_code == 0
    assert result.reason == "data_only_drift_fast_forwarded"
    assert result.remote_tip == remote_tip
    assert result.drift_paths == ("data/example.json",)
    assert git(checkout, "rev-parse", "HEAD") == remote_tip


def test_public_data_only_drift_is_allowed(repositories):
    writer, checkout, _ = repositories
    remote_tip = push_file(writer, "public/data/example.json", "{}\n")

    result = gate.evaluate(env=environment(checkout), cwd=checkout)

    assert result.reason == "data_only_drift_fast_forwarded"
    assert git(checkout, "rev-parse", "HEAD") == remote_tip


def test_empty_commit_drift_is_fast_forwarded(repositories):
    writer, checkout, _ = repositories
    git(writer, "commit", "--allow-empty", "-m", "empty remote advance")
    remote_tip = git(writer, "rev-parse", "HEAD")
    git(writer, "push", "origin", BRANCH)

    result = gate.evaluate(env=environment(checkout), cwd=checkout)

    assert result.reason == "data_only_drift_fast_forwarded"
    assert result.drift_paths == ()
    assert git(checkout, "rev-parse", "HEAD") == remote_tip


def test_source_drift_exits_two_without_changing_worktree(repositories):
    writer, checkout, _ = repositories
    old_head = git(checkout, "rev-parse", "HEAD")
    remote_tip = push_file(writer, "backend/source.py", "value = 1\n")

    result = gate.evaluate(env=environment(checkout), cwd=checkout)

    assert result.exit_code == 2
    assert result.reason == "source_drift_detected"
    assert result.remote_tip == remote_tip
    assert result.drift_paths == ("backend/source.py",)
    assert git(checkout, "rev-parse", "HEAD") == old_head
    assert git(checkout, "status", "--porcelain") == ""


def test_one_non_allowlisted_path_rejects_otherwise_data_only_drift(repositories):
    writer, checkout, _ = repositories
    old_head = git(checkout, "rev-parse", "HEAD")
    commit_file(writer, "data/example.json", "{}\n")
    remote_tip = commit_file(writer, "tests/source_test.py", "pass\n")
    git(writer, "push", "origin", BRANCH)

    result = gate.evaluate(env=environment(checkout), cwd=checkout)

    assert result.reason == "source_drift_detected"
    assert result.remote_tip == remote_tip
    assert set(result.drift_paths) == {"data/example.json", "tests/source_test.py"}
    assert git(checkout, "rev-parse", "HEAD") == old_head


def test_non_ancestor_exits_two(repositories):
    writer, checkout, _ = repositories
    commit_file(checkout, "data/local.json", "local\n")
    local_head = git(checkout, "rev-parse", "HEAD")
    push_file(writer, "data/remote.json", "remote\n")

    result = gate.evaluate(env=environment(checkout), cwd=checkout)

    assert result.exit_code == 2
    assert result.reason == "non_ancestor_ref_ambiguity"
    assert git(checkout, "rev-parse", "HEAD") == local_head


def test_fetch_failure_exits_two(repositories):
    _, checkout, _ = repositories
    git(checkout, "remote", "set-url", "origin", str(checkout / "missing.git"))

    result = gate.evaluate(env=environment(checkout), cwd=checkout)

    assert result.exit_code == 2
    assert result.reason == "remote_fetch_failed"
    assert result.remote_tip is None


@pytest.mark.parametrize(
    "github_ref",
    ["refs/tags/v13.3-dev", "v13.3-dev", "refs/heads/", "refs/heads/-bad"],
)
def test_tag_and_non_branch_refs_are_rejected(repositories, github_ref):
    _, checkout, _ = repositories

    result = gate.evaluate(
        env=environment(checkout, GITHUB_REF=github_ref), cwd=checkout
    )

    assert result.exit_code == 2
    assert result.reason == "non_ancestor_ref_ambiguity"


def test_checkout_head_must_equal_github_sha(repositories):
    _, checkout, _ = repositories

    result = gate.evaluate(
        env=environment(checkout, GITHUB_SHA="0" * 40), cwd=checkout
    )

    assert result.exit_code == 2
    assert result.reason == "checkout_head_mismatch"


def test_working_tree_must_be_clean_before_fetch(repositories):
    _, checkout, _ = repositories
    (checkout / "untracked.txt").write_text("dirty\n", encoding="utf-8")

    result = gate.evaluate(env=environment(checkout), cwd=checkout)

    assert result.exit_code == 2
    assert result.reason == "working_tree_not_clean"
    assert not (checkout / ".git" / "FETCH_HEAD").exists()


def test_manual_dispatch_does_not_bypass_source_drift(repositories):
    writer, checkout, _ = repositories
    push_file(writer, ".github/workflows/drift.yml", "name: drift\n")

    result = gate.evaluate(
        env=environment(checkout, GITHUB_EVENT_NAME="workflow_dispatch"),
        cwd=checkout,
    )

    assert result.exit_code == 2
    assert result.reason == "source_drift_detected"


def test_summary_has_all_required_fields_and_appends(
    repositories, tmp_path, monkeypatch, capsys
):
    _, checkout, _ = repositories
    summary = tmp_path / "summary.md"
    summary.write_text("existing\n", encoding="utf-8")
    for key, value in environment(checkout, summary).items():
        monkeypatch.setenv(key, value)
    monkeypatch.chdir(checkout)

    exit_code = gate.main()

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["checkpoint"] == "pre_reanchor"
    text = summary.read_text(encoding="utf-8")
    assert text.startswith("existing\n")
    for field in (
        "checkpoint",
        "decision",
        "reason",
        "eventSha",
        "remoteTip",
        "targetBranch",
        "driftPathCount",
        "driftPathsSample",
    ):
        assert f"| {field} |" in text


def test_drift_sample_is_bounded(repositories):
    writer, checkout, _ = repositories
    for index in range(gate.DRIFT_SAMPLE_LIMIT + 5):
        path = writer / "backend" / f"source_{index:02}.py"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"value = {index}\n", encoding="utf-8")
    git(writer, "add", "backend")
    git(writer, "commit", "-m", "add bounded drift sample")
    git(writer, "push", "origin", BRANCH)

    result = gate.evaluate(env=environment(checkout), cwd=checkout)
    payload = result.as_dict()

    assert result.reason == "source_drift_detected"
    assert payload["driftPathCount"] == gate.DRIFT_SAMPLE_LIMIT + 5
    assert len(payload["driftPathsSample"]) == gate.DRIFT_SAMPLE_LIMIT


def test_all_public_results_use_only_exit_zero_or_two(repositories):
    _, checkout, _ = repositories
    accepted = gate.evaluate(env=environment(checkout), cwd=checkout)
    rejected = gate.evaluate(env={}, cwd=checkout)

    assert {accepted.exit_code, rejected.exit_code} == {0, 2}
