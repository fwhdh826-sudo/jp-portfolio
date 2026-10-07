"""P4-A79: intraday_patch.yml guard tests.

Guards the Tier 1 artifact coverage and forward-only add/commit/fetch/push
flow of the intraday-patch workflow without executing it or touching real APIs.

Scope (Tier 1 = market + news only):
  - intraday_patch.yml exists
  - update_market.py is called (Tier 1 market source)
  - public/data/market.json is handled (copy + explicit git add)
  - public/data/candidates_news.json and data/candidates_news.json are staged
  - bind the base before staging and the proposed child after optional commit
  - validate clean state, fetch the exact target, require the frozen base and
    ancestry, then push and independently observe the child before success

Non-goals:
  - market_intel.json is intentionally NOT covered by intraday_patch
    (full_batch / update-data responsibility) — no test for it here
  - Real-time freshness of JSON data
  - API connections or workflow execution
"""
from pathlib import Path

_WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "intraday_patch.yml"
_TEXT = _WORKFLOW.read_text()


def _commit_and_push_commands() -> str:
    """Bind shell checks to the Commit step, excluding comments/validator prose."""
    step = _TEXT.split("      - name: Commit and push\n", 1)[1]
    body = step.split("        run: |\n", 1)[1]
    lines = []
    in_validator = False
    for raw_line in body.splitlines():
        if not raw_line.strip():
            continue
        if not raw_line.startswith("          "):
            break
        line = raw_line[10:]
        if in_validator:
            if line == "PY":
                in_validator = False
            continue
        if line == "python3 - <<'PY'":
            in_validator = True
        if not line.lstrip().startswith("#"):
            lines.append(line)
    return "\n".join(lines)


# ── existence ─────────────────────────────────────────────────────────────────

def test_workflow_file_exists():
    assert _WORKFLOW.exists()


# ── Tier 1 artifact handling ──────────────────────────────────────────────────

def test_update_market_script_present():
    # Tier 1 market update script must be called
    assert "data/update_market.py" in _TEXT


def test_update_news_script_present():
    # Tier 1 news update script must be called
    assert "data/update_news.py" in _TEXT


def test_build_candidates_news_script_present():
    # candidates_news summary must be (re)built after news update
    assert "data/build_candidates_news.py" in _TEXT


def test_market_in_copy_list():
    # market must appear in the Tier 1 copy loop targeting public/data/
    copy_section = _TEXT.split("Copy Tier 1 JSON to public/data")[1].split("Build candidates")[0]
    assert "market" in copy_section


def test_public_data_market_json_explicitly_staged():
    # public/data/market.json must be in the explicit git add line
    assert "public/data/market.json" in _TEXT


def test_public_data_candidates_news_explicitly_staged():
    # public/data/candidates_news.json must be explicitly staged
    assert "public/data/candidates_news.json" in _TEXT


def test_data_candidates_news_explicitly_staged():
    # data/candidates_news.json must be explicitly staged (data/ side)
    assert "data/candidates_news.json" in _TEXT.split("git add")[1]


# ── P0-INTRADAY-PATCH-GITADD-FIX: exact allowlist regression guard ────────────
# 37/37 real Actions runs failed with "cannot pull with rebase: You have
# unstaged changes" (exit 128) because data/market.json and data/news.json
# were updated but never staged, leaving unstaged tracked changes at
# the old synchronization boundary. These tests lock the exact 6-file allowlist.

_GIT_ADD_LINE = _TEXT.split("git add ")[1].split("\n")[0]

_TIER1_ALLOWLIST = [
    "data/market.json",
    "data/news.json",
    "data/candidates_news.json",
    "public/data/market.json",
    "public/data/news.json",
    "public/data/candidates_news.json",
]


def test_data_market_json_explicitly_staged():
    # data/market.json must be explicitly staged (previously missing -> root cause)
    assert "data/market.json" in _GIT_ADD_LINE


def test_data_news_json_explicitly_staged():
    # data/news.json must be explicitly staged (previously missing -> root cause)
    assert "data/news.json" in _GIT_ADD_LINE


def test_all_six_tier1_files_in_git_add():
    # the exact allowlist of 6 Tier 1 outputs must all be present in the git add line
    for path in _TIER1_ALLOWLIST:
        assert path in _GIT_ADD_LINE, f"{path} missing from git add line"


def test_no_broad_directory_staging():
    # git add data/ or git add public/data/ (whole-directory staging) must
    # never be used: this repo previously leaked personal holdings/trust/cash
    # data and must only ever stage an exact allowlist of generated files.
    assert "git add data/ " not in _TEXT
    assert "git add public/data/ " not in _TEXT
    assert not _GIT_ADD_LINE.rstrip().endswith("data/")
    assert not _GIT_ADD_LINE.rstrip().endswith("public/data/")


def test_unstaged_change_guard_before_pull_rebase():
    # Preserve the explicit post-commit rejection of unstaged Tier 1 changes.
    commands = _commit_and_push_commands()
    commit_pos = commands.index('git commit -m "chore: intraday-patch')
    guard_pos = commands.index("git diff --quiet || {")
    fetch_pos = commands.index('git fetch --no-tags origin "$target_ref"')
    equality_pos = commands.index('[ "$fetched_tip" != "$push_base_sha" ]')
    ancestor_pos = commands.index('git merge-base --is-ancestor "$fetched_tip" "$proposed_push_sha"')
    push_pos = commands.index('git push origin "HEAD:$target_ref"')
    assert commit_pos < guard_pos < fetch_pos < equality_pos < ancestor_pos < push_pos
    guard = commands[guard_pos:commands.index('proposed_push_sha="', guard_pos)]
    assert "Unstaged tracked changes remain after intraday staging" in guard
    assert "exit 1" in guard


# ── market_intel is intentionally absent ─────────────────────────────────────

def test_market_intel_not_in_git_add():
    # intraday_patch must NOT stage market_intel (full_batch/update-data responsibility)
    # Guard against accidental scope expansion
    git_add_line = _TEXT.split("git add")[1].split("\n")[0]
    assert "market_intel" not in git_add_line


# ── forward-only add / commit / fetch / push flow ───────────────────────────

def test_git_pull_rebase_present():
    commands = _commit_and_push_commands()
    assert commands.count('git fetch --no-tags origin "$target_ref"') == 1
    assert 'if [ "$fetched_tip" != "$push_base_sha" ]; then' in commands
    assert 'if ! git merge-base --is-ancestor "$fetched_tip" "$proposed_push_sha"; then' in commands
    assert 'git ls-remote --exit-code --refs origin "$target_ref"' in commands
    for subcommand in ("pull", "rebase", "merge", "reset"):
        assert f"git {subcommand} " not in commands
    assert "--force" not in commands and "--amend" not in commands
    assert "git push -f" not in commands and "git push --delete" not in commands


def test_git_add_present():
    assert "git add" in _TEXT


def test_git_commit_present():
    assert "git commit" in _TEXT


def test_git_push_present():
    assert "git push" in _TEXT


def test_git_add_before_pull_rebase():
    commands = _commit_and_push_commands()
    base_pos = commands.index('push_base_sha="$(git rev-parse --verify')
    add_pos = commands.index("git add ")
    validation_pos = commands.index("python3 - <<'PY'")
    optional_commit_pos = commands.index("if ! git diff --staged --quiet; then")
    commit_pos = commands.index('git commit -m "chore: intraday-patch')
    fetch_pos = commands.index('git fetch --no-tags origin "$target_ref"')
    assert base_pos < add_pos < validation_pos < optional_commit_pos < commit_pos < fetch_pos


def test_git_add_before_commit():
    # git add must come before git commit
    add_pos = _TEXT.index("git add ")
    commit_pos = _TEXT.index("git commit")
    assert add_pos < commit_pos, "git add must come before git commit"


def test_commit_before_pull_rebase():
    commands = _commit_and_push_commands()
    commit_pos = commands.index('git commit -m "chore: intraday-patch')
    proposed_pos = commands.index('proposed_push_sha="$(git rev-parse --verify')
    parents_pos = commands.index('git rev-list --parents -n 1 "$proposed_push_sha"')
    child_pos = commands.index('[ "$proposed_parents" != "$proposed_push_sha $push_base_sha" ]')
    unchanged_pos = commands.index('[ "$proposed_push_sha" != "$push_base_sha" ]')
    clean_pos = commands.index("if ! git diff --quiet || ! git diff --cached --quiet;")
    untracked_pos = commands.index("git ls-files --others --exclude-standard")
    fetch_pos = commands.index('git fetch --no-tags origin "$target_ref"')
    assert commit_pos < proposed_pos < parents_pos < child_pos < unchanged_pos < clean_pos < untracked_pos < fetch_pos


def test_commit_before_push():
    # git commit must come before the final git push command.
    # Use the actual commit command and rindex("git push") (last occurrence
    # = actual push command, not the "── git push ──" section comment) to avoid
    # matching the section header comment that names this step.
    commit_pos = _TEXT.index('git commit -m "chore: intraday-patch')
    push_pos = _TEXT.rindex("git push")
    assert commit_pos < push_pos, "git commit must come before git push"


def test_pull_rebase_before_push():
    commands = _commit_and_push_commands()
    fetch_pos = commands.index('git fetch --no-tags origin "$target_ref"')
    fetched_pos = commands.index('fetched_tip="$(git rev-parse --verify')
    assert "git rev-parse --verify 'FETCH_HEAD^{commit}'" in commands
    equality_pos = commands.index('[ "$fetched_tip" != "$push_base_sha" ]')
    ancestor_pos = commands.index('git merge-base --is-ancestor "$fetched_tip" "$proposed_push_sha"')
    push_pos = commands.index('git push origin "HEAD:$target_ref"')
    observed_pos = commands.index('git ls-remote --exit-code --refs origin "$target_ref"')
    confirmed_pos = commands.index('[ "$observed_ref" != "$target_ref" ]')
    assert '[ "$observed_sha" != "$proposed_push_sha" ]' in commands
    true_pos = commands.index('echo "data_changed=true" >> "$GITHUB_OUTPUT"')
    sha_pos = commands.index('echo "pushed_sha=$proposed_push_sha" >> "$GITHUB_OUTPUT"')
    assert fetch_pos < fetched_pos < equality_pos < ancestor_pos < push_pos < observed_pos < confirmed_pos < true_pos < sha_pos


def test_no_git_add_all():
    # git add . and git add -A must not appear (too broad for Tier 1 patch)
    assert "git add ." not in _TEXT
    assert "git add -A" not in _TEXT
