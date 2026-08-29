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
import subprocess

import pytest

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
