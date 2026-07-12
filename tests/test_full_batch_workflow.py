"""P4-A23 / P4-A23-1 / P4-A23-2 / P4-A28: full_batch.yml integration guard.

P4-A23: dry-run health-check steps are retained in routines-stub (detection-only).
P4-A23-1: Job 2 commit/push step follows correct order (add → commit → pull → push).
P4-A23-2: git add covers full data/ directory, not individual files.
P4-A28: real write steps for safe_mode.json and TierA snapshots are wired in Job 2
        (update-data), covered by the existing "git add data/ public/data/" commit step.
"""
from pathlib import Path

_WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "full_batch.yml"
_TEXT = _WORKFLOW.read_text()


def test_workflow_file_exists():
    assert _WORKFLOW.exists()


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

def test_git_pull_rebase_uses_explicit_remote():
    assert "git pull --rebase origin main" in _TEXT


def test_git_add_before_pull_rebase():
    add_pos = _TEXT.index("git add data/")
    rebase_pos = _TEXT.index("git pull --rebase origin main")
    assert add_pos < rebase_pos, "git add must come before git pull --rebase"


def test_git_commit_before_pull_rebase():
    commit_pos = _TEXT.index("git diff --staged --quiet || git commit")
    rebase_pos = _TEXT.index("git pull --rebase origin main")
    assert commit_pos < rebase_pos, "git commit must come before git pull --rebase"


def test_git_push_after_pull_rebase():
    rebase_pos = _TEXT.index("git pull --rebase origin main")
    push_pos = _TEXT.index("git push", rebase_pos)
    assert push_pos > rebase_pos, "git push must come after git pull --rebase"


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
