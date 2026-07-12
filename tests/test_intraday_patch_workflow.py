"""P4-A79: intraday_patch.yml guard tests.

Guards the Tier 1 artifact coverage and git pull/rebase/add/commit/push
flow of the intraday-patch workflow without executing it or touching real APIs.

Scope (Tier 1 = market + news only):
  - intraday_patch.yml exists
  - update_market.py is called (Tier 1 market source)
  - public/data/market.json is handled (copy + explicit git add)
  - public/data/candidates_news.json and data/candidates_news.json are staged
  - git pull --rebase / add / commit / push basic flow is intact
  - add and commit come before pull --rebase (race-safe order: stage and
    commit local Tier 1 changes first so the working tree is clean before
    rebasing onto origin, avoiding "You have unstaged changes" pull failures)

Non-goals:
  - market_intel.json is intentionally NOT covered by intraday_patch
    (full_batch / update-data responsibility) — no test for it here
  - Real-time freshness of JSON data
  - API connections or workflow execution
"""
from pathlib import Path

_WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "intraday_patch.yml"
_TEXT = _WORKFLOW.read_text()


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


# ── market_intel is intentionally absent ─────────────────────────────────────

def test_market_intel_not_in_git_add():
    # intraday_patch must NOT stage market_intel (full_batch/update-data responsibility)
    # Guard against accidental scope expansion
    git_add_line = _TEXT.split("git add")[1].split("\n")[0]
    assert "market_intel" not in git_add_line


# ── git pull/rebase / add / commit / push flow ───────────────────────────────

def test_git_pull_rebase_present():
    assert "git pull --rebase" in _TEXT


def test_git_add_present():
    assert "git add" in _TEXT


def test_git_commit_present():
    assert "git commit" in _TEXT


def test_git_push_present():
    assert "git push" in _TEXT


def test_git_add_before_pull_rebase():
    # git add must come before pull --rebase: stage local Tier 1 changes
    # first so the working tree is clean when rebase runs (avoids
    # "You have unstaged changes" pull --rebase failures)
    add_pos = _TEXT.index("git add ")
    rebase_pos = _TEXT.index("git pull --rebase")
    assert add_pos < rebase_pos, "git add must come before git pull --rebase"


def test_git_add_before_commit():
    # git add must come before git commit
    add_pos = _TEXT.index("git add ")
    commit_pos = _TEXT.index("git commit")
    assert add_pos < commit_pos, "git add must come before git commit"


def test_commit_before_pull_rebase():
    # git commit must come before pull --rebase: commit local Tier 1
    # changes first so the working tree is clean when rebase runs
    # (avoids "You have unstaged changes" pull --rebase failures).
    # Use "|| git commit" (actual run command) to avoid matching the
    # "── git push ──" section comment.
    commit_pos = _TEXT.index("|| git commit")
    rebase_pos = _TEXT.index("git pull --rebase")
    assert commit_pos < rebase_pos, "git commit must come before git pull --rebase"


def test_commit_before_push():
    # git commit must come before the final git push command.
    # Use "|| git commit" (actual run command) and rindex("git push") (last occurrence
    # = actual push command, not the "── git push ──" section comment) to avoid
    # matching the section header comment that names this step.
    commit_pos = _TEXT.index("|| git commit")
    push_pos = _TEXT.rindex("git push")
    assert commit_pos < push_pos, "git commit must come before git push"


def test_pull_rebase_before_push():
    # pull --rebase must come before the final git push (rebase onto
    # latest origin before pushing, so the push does not get rejected
    # for being behind).
    rebase_pos = _TEXT.index("git pull --rebase")
    push_pos = _TEXT.rindex("git push")
    assert rebase_pos < push_pos, "git pull --rebase must come before git push"


def test_no_git_add_all():
    # git add . and git add -A must not appear (too broad for Tier 1 patch)
    assert "git add ." not in _TEXT
    assert "git add -A" not in _TEXT
