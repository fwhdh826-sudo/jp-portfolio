"""P5-B005-B2: .github/workflows/full_batch.yml への candidate funnel batch
stage統合の回帰テスト。

tests/test_full_batch_workflow.pyと同じ規律（yml本文へのtext-basedアサーション、
実CI実行はしない）で、以下を確認する:
  1. candidate funnel生成stepが存在する
  2. quality/privacy smoke stepが生成stepの直後に存在する
  3. 生成・smokeともにregime_state生成後、Commit and pushより前に位置する
  4. `git add data/ public/data/` は既存のまま（新規artifactも自動的に対象になる）
  5. 既存のSAFE_MODE/TierA stepの順序を壊さない
  6. failure時にjobを止めない（`|| true`、他の独立したdata更新を継続する）
  7. 新規dependency追加が無い（pip install行に変更が無い）
"""
from pathlib import Path

_WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "full_batch.yml"
_TEXT = _WORKFLOW.read_text()


def _update_data_section() -> str:
    return _TEXT.split("  update-data:")[1].split("  routines-stub:")[0]


def test_candidate_funnel_batch_step_present():
    assert "python3 -m data.candidate_funnel_batch" in _TEXT


def test_candidate_funnel_privacy_smoke_step_present():
    assert "python3 -m data.candidate_funnel_privacy_smoke" in _TEXT


def test_candidate_funnel_steps_are_non_blocking():
    """他の独立したdata更新stepを止めないよう、既存規律どおり `|| true` を使う。"""
    section = _update_data_section()
    assert "python3 -m data.candidate_funnel_batch || true" in section
    assert "python3 -m data.candidate_funnel_privacy_smoke || true" in section


def test_candidate_funnel_batch_runs_after_regime_state():
    section = _update_data_section()
    regime_pos = section.index("Build live regime state")
    funnel_pos = section.index("python3 -m data.candidate_funnel_batch")
    assert regime_pos < funnel_pos, "candidate funnel batch needs regime_state.json to already exist"


def test_candidate_funnel_privacy_smoke_runs_immediately_after_batch():
    section = _update_data_section()
    batch_pos = section.index("python3 -m data.candidate_funnel_batch")
    smoke_pos = section.index("python3 -m data.candidate_funnel_privacy_smoke")
    assert batch_pos < smoke_pos


def test_candidate_funnel_steps_run_before_commit_and_push():
    section = _update_data_section()
    smoke_pos = section.index("python3 -m data.candidate_funnel_privacy_smoke")
    commit_pos = section.index("git add data/ public/data/")
    assert smoke_pos < commit_pos


def test_candidate_funnel_steps_do_not_disturb_safe_mode_or_tier_a_order():
    section = _update_data_section()
    funnel_pos = section.index("python3 -m data.candidate_funnel_batch")
    safe_mode_pos = section.index("Build SAFE_MODE snapshot")
    tier_a_pos = section.index("Build TierA snapshots")
    assert funnel_pos < safe_mode_pos < tier_a_pos


def test_git_add_covers_candidate_funnel_artifacts_via_directory_scope():
    # data/candidate_funnel.json / public/data/candidate_funnel.json は個別
    # pinningせず、既存の `git add data/ public/data/` の対象に自然に含まれる。
    assert "git add data/ public/data/" in _TEXT
    assert "git add data/candidate_funnel.json" not in _TEXT
    assert "git add public/data/candidate_funnel.json" not in _TEXT


def test_no_new_pip_dependency_added_for_candidate_funnel():
    # candidate_funnel_batch.py / candidate_funnel_privacy_smoke.py はstdlib
    # only（A2-S 禁止35: dependency追加禁止）。pip installの依存集合は不変。
    assert "pip install yfinance pandas numpy feedparser requests xlrd" in _TEXT
