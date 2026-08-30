"""Fail-closed checkout re-anchor gate for production-data workflows.

The gate compares the commit checked out by GitHub Actions with the latest
remote tip of the branch named by ``GITHUB_REF``.  It may fast-forward only
when every intervening path is production data; source drift is reported
without changing the worktree.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Mapping, Sequence


EXIT_CONTINUE = 0
EXIT_REJECT = 2
CHECKPOINT = "pre_reanchor"
DRIFT_SAMPLE_LIMIT = 20

_BRANCH_PREFIX = "refs/heads/"
_SHA_PATTERN = re.compile(r"^[0-9a-fA-F]{40}$")
_SUMMARY_FIELDS = (
    "checkpoint",
    "decision",
    "reason",
    "eventSha",
    "remoteTip",
    "targetBranch",
    "driftPathCount",
    "driftPathsSample",
)


@dataclass(frozen=True)
class ReanchorResult:
    decision: str
    reason: str
    event_sha: str | None
    remote_tip: str | None
    target_branch: str | None
    drift_paths: tuple[str, ...] = ()

    @property
    def exit_code(self) -> int:
        return EXIT_CONTINUE if self.decision == "CONTINUE" else EXIT_REJECT

    def as_dict(self) -> dict[str, object]:
        return {
            "checkpoint": CHECKPOINT,
            "decision": self.decision,
            "reason": self.reason,
            "eventSha": self.event_sha,
            "remoteTip": self.remote_tip,
            "targetBranch": self.target_branch,
            "driftPathCount": len(self.drift_paths),
            "driftPathsSample": list(self.drift_paths[:DRIFT_SAMPLE_LIMIT]),
        }


def _git(
    arguments: Sequence[str], *, cwd: Path, text: bool = True
) -> subprocess.CompletedProcess[str] | subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", *arguments],
        cwd=cwd,
        check=False,
        capture_output=True,
        text=text,
    )


def _reject(
    reason: str,
    *,
    event_sha: str | None,
    remote_tip: str | None = None,
    target_branch: str | None = None,
    drift_paths: tuple[str, ...] = (),
) -> ReanchorResult:
    return ReanchorResult(
        decision="EXIT2",
        reason=reason,
        event_sha=event_sha,
        remote_tip=remote_tip,
        target_branch=target_branch,
        drift_paths=drift_paths,
    )


def _target_branch(ref: str | None, *, cwd: Path) -> str | None:
    if not ref or not ref.startswith(_BRANCH_PREFIX):
        return None
    branch = ref[len(_BRANCH_PREFIX) :]
    if not branch:
        return None
    validated = _git(["check-ref-format", "--branch", branch], cwd=cwd)
    if validated.returncode != 0:
        return None
    return branch


def _is_data_path(path: str) -> bool:
    return path.startswith("data/") or path.startswith("public/data/")


def evaluate(
    *, env: Mapping[str, str] = os.environ, cwd: Path | str | None = None
) -> ReanchorResult:
    """Evaluate and, for data-only drift, fast-forward the current checkout."""

    repository = Path.cwd() if cwd is None else Path(cwd)
    event_sha = env.get("GITHUB_SHA")
    target_branch = _target_branch(env.get("GITHUB_REF"), cwd=repository)
    if target_branch is None:
        return _reject(
            "non_ancestor_ref_ambiguity",
            event_sha=event_sha,
        )

    if event_sha is None or _SHA_PATTERN.fullmatch(event_sha) is None:
        return _reject(
            "checkout_head_mismatch",
            event_sha=event_sha,
            target_branch=target_branch,
        )

    head = _git(["rev-parse", "--verify", "HEAD^{commit}"], cwd=repository)
    if head.returncode != 0 or head.stdout.strip().lower() != event_sha.lower():
        return _reject(
            "checkout_head_mismatch",
            event_sha=event_sha,
            target_branch=target_branch,
        )

    status = _git(
        ["status", "--porcelain=v1", "--untracked-files=all"], cwd=repository
    )
    if status.returncode != 0 or status.stdout:
        return _reject(
            "working_tree_not_clean",
            event_sha=event_sha,
            target_branch=target_branch,
        )

    fetched = _git(
        ["fetch", "--no-tags", "origin", target_branch], cwd=repository
    )
    if fetched.returncode != 0:
        return _reject(
            "remote_fetch_failed",
            event_sha=event_sha,
            target_branch=target_branch,
        )

    resolved = _git(
        ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], cwd=repository
    )
    if resolved.returncode != 0:
        return _reject(
            "remote_fetch_failed",
            event_sha=event_sha,
            target_branch=target_branch,
        )
    remote_tip = resolved.stdout.strip().lower()
    current_head = head.stdout.strip().lower()

    if current_head == remote_tip:
        return ReanchorResult(
            decision="CONTINUE",
            reason="no_drift_head_at_tip",
            event_sha=event_sha,
            remote_tip=remote_tip,
            target_branch=target_branch,
        )

    ancestor = _git(
        ["merge-base", "--is-ancestor", current_head, remote_tip], cwd=repository
    )
    if ancestor.returncode != 0:
        return _reject(
            "non_ancestor_ref_ambiguity",
            event_sha=event_sha,
            remote_tip=remote_tip,
            target_branch=target_branch,
        )

    diff = _git(
        ["diff", "--no-renames", "--name-only", "-z", current_head, remote_tip],
        cwd=repository,
        text=False,
    )
    if diff.returncode != 0:
        return _reject(
            "non_ancestor_ref_ambiguity",
            event_sha=event_sha,
            remote_tip=remote_tip,
            target_branch=target_branch,
        )
    drift_paths = tuple(
        entry.decode("utf-8", errors="surrogateescape")
        for entry in diff.stdout.split(b"\0")
        if entry
    )
    if any(not _is_data_path(path) for path in drift_paths):
        return _reject(
            "source_drift_detected",
            event_sha=event_sha,
            remote_tip=remote_tip,
            target_branch=target_branch,
            drift_paths=drift_paths,
        )

    merged = _git(["merge", "--ff-only", remote_tip], cwd=repository)
    if merged.returncode != 0:
        return _reject(
            "non_ancestor_ref_ambiguity",
            event_sha=event_sha,
            remote_tip=remote_tip,
            target_branch=target_branch,
            drift_paths=drift_paths,
        )
    verified = _git(["rev-parse", "--verify", "HEAD^{commit}"], cwd=repository)
    if verified.returncode != 0 or verified.stdout.strip().lower() != remote_tip:
        return _reject(
            "non_ancestor_ref_ambiguity",
            event_sha=event_sha,
            remote_tip=remote_tip,
            target_branch=target_branch,
            drift_paths=drift_paths,
        )

    return ReanchorResult(
        decision="CONTINUE",
        reason="data_only_drift_fast_forwarded",
        event_sha=event_sha,
        remote_tip=remote_tip,
        target_branch=target_branch,
        drift_paths=drift_paths,
    )


def append_summary(payload: Mapping[str, object], env: Mapping[str, str]) -> None:
    summary_path = env.get("GITHUB_STEP_SUMMARY")
    if not summary_path:
        raise OSError("GITHUB_STEP_SUMMARY is missing")
    lines = [
        f"## Ref re-anchor gate: {payload['decision']}",
        "",
        "| Field | Value |",
        "| --- | --- |",
    ]
    for field in _SUMMARY_FIELDS:
        value = payload.get(field)
        rendered = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        lines.append(f"| {field} | {rendered} |")
    with Path(summary_path).open("a", encoding="utf-8") as summary:
        summary.write("\n".join(lines) + "\n")


def main() -> int:
    result = evaluate()
    payload = result.as_dict()
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    try:
        append_summary(payload, os.environ)
    except OSError as exc:
        print(f"ref re-anchor summary error: {exc}", file=sys.stderr)
        return EXIT_REJECT
    return result.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
