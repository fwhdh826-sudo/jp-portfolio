"""Exact-SHA and backward-compatibility guards for the Pages workflow."""

import os
from pathlib import Path
import subprocess

import pytest


_WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "deploy.yml"
_TEXT = _WORKFLOW.read_text()


def _step_script(step_name: str) -> str:
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


def _resolve(tmp_path: Path, *, event: str, push_sha: str, dispatch_sha: str):
    output = tmp_path / "output"
    env = os.environ.copy()
    env.update(
        EVENT_NAME=event,
        PUSH_SHA=push_sha,
        DISPATCH_SHA=dispatch_sha,
        GITHUB_OUTPUT=str(output),
    )
    result = subprocess.run(
        ["bash", "-c", _step_script("Resolve deployment SHA")],
        env=env,
        text=True,
        capture_output=True,
    )
    values = {}
    if output.exists():
        values = dict(line.split("=", 1) for line in output.read_text().splitlines())
    return result, values


def test_dep_01_push_main_trigger_is_preserved():
    trigger = _TEXT.split("on:\n", 1)[1].split("\npermissions:", 1)[0]
    assert "push:" in trigger
    assert "branches: [main]" in trigger
    assert "workflow_dispatch:" in trigger


def test_dep_02_dispatch_declares_exact_sha_input():
    trigger = _TEXT.split("on:\n", 1)[1].split("\npermissions:", 1)[0]
    assert "deploy_sha:" in trigger
    assert "required: true" in trigger
    assert "type: string" in trigger


def test_dep_03_push_resolves_to_github_sha(tmp_path):
    sha = "1" * 40
    result, values = _resolve(
        tmp_path, event="push", push_sha=sha, dispatch_sha=""
    )

    assert result.returncode == 0, result.stderr
    assert values == {"deploy_sha": sha}


def test_dep_04_dispatch_resolves_to_supplied_exact_sha(tmp_path):
    supplied = "ABCDEF0123456789ABCDEF0123456789ABCDEF01"
    result, values = _resolve(
        tmp_path,
        event="workflow_dispatch",
        push_sha="2" * 40,
        dispatch_sha=supplied,
    )

    assert result.returncode == 0, result.stderr
    assert values == {"deploy_sha": supplied.lower()}
    assert "ref: ${{ steps.deploy-target.outputs.deploy_sha }}" in _TEXT


@pytest.mark.parametrize("dispatch_sha", ["", "abc", "g" * 40, "1" * 39, "1" * 41])
def test_dep_05_missing_or_malformed_dispatch_sha_fails_closed(
    tmp_path, dispatch_sha
):
    result, values = _resolve(
        tmp_path,
        event="workflow_dispatch",
        push_sha="3" * 40,
        dispatch_sha=dispatch_sha,
    )

    assert result.returncode != 0
    assert values == {}
    assert "exact 40-character deploy_sha" in result.stderr


def test_existing_pages_build_and_deploy_steps_are_preserved():
    for command in ("npm ci", "npm run test:unit", "npm run build"):
        assert command in _TEXT
    assert "actions/upload-pages-artifact@v5" in _TEXT
    assert "actions/deploy-pages@v5" in _TEXT
    assert "contents: read" in _TEXT
    assert "pages: write" in _TEXT
    assert "id-token: write" in _TEXT
