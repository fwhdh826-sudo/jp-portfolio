"""P5-B005-B2-R1: .github/workflows/full_batch.yml への candidate funnel batch
stage統合の回帰テスト。

tests/test_full_batch_workflow.pyと同じ規律（yml本文へのtext-basedアサーション、
実CI実行はしない）で、以下を確認する:
  1. candidate funnel生成stepが存在する
  2. quality/privacy smoke stepが生成stepの直後に存在する
  3. 生成・smokeともにregime_state生成後、Commit and pushより前に位置する
  4. `git add data/ public/data/` は既存のまま（新規artifactも自動的に対象になる）
  5. 既存のSAFE_MODE/TierA stepの順序を壊さない
  6. batch stepはblocking（`|| true`も`continue-on-error`も無い）。
     P-02/P-04/P-07/P-08/P-10/P-12/P-13/P-14はhard gateであり、失敗runは
     job全体を停止しcommit/pushへ進んではならない（旧: `|| true`で
     job全体を継続していたfail-open経路を反転する — P5-B005-B2-R1）。
  7. 新規dependency追加が無い（pip install行に変更が無い）
"""
from pathlib import Path

_WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "full_batch.yml"
_TEXT = _WORKFLOW.read_text()


def _update_data_section() -> str:
    return _TEXT.split("  update-data:")[1].split("  routines-stub:")[0]


def _funnel_batch_step_block() -> str:
    """「Build candidate_funnel.json」stepの見出しから次のstep見出し
    （次の`- name:`行）までのYAML断片を取り出す（`continue-on-error`等の
    step-level属性がこのstep自身に付いているかを確認するため）。"""
    section = _update_data_section()
    start = section.index("Build candidate_funnel.json (prescreen join + P-01..P-15 quality gate)")
    rest = section[start:]
    next_step_marker = rest.index("\n      - name:", 1)
    return rest[:next_step_marker]


def test_candidate_funnel_batch_step_present():
    assert "python3 -m data.candidate_funnel_batch" in _TEXT


def test_candidate_funnel_privacy_smoke_step_present():
    assert "python3 -m data.candidate_funnel_privacy_smoke" in _TEXT


def test_candidate_funnel_batch_step_is_blocking():
    """batch stepは`|| true`を持たない — quality gate FAIL/schema FAIL/
    input不正/prescreen metadata不在・不整合時のexit 1がjob failureとして
    GitHub Actionsへ伝播し、直後のprivacy smoke・commit/push stepへ
    到達させない（P5-B005-B2-R1: 旧fail-open経路の再発防止）。"""
    section = _update_data_section()
    assert "python3 -m data.candidate_funnel_batch\n" in section
    assert "python3 -m data.candidate_funnel_batch || true" not in section


def test_candidate_funnel_batch_step_has_no_continue_on_error():
    block = _funnel_batch_step_block()
    assert "continue-on-error" not in block


def test_candidate_funnel_privacy_smoke_step_is_blocking():
    """privacy/schema smokeはcommit直前の最終防衛線のため `|| true` を
    付けない——batch内部の検証をすり抜けた不正artifactがあった場合、
    git addされる前にjob failureとして検出しcommit stepへ到達させない
    （validation前のpublic配布禁止）。"""
    section = _update_data_section()
    assert "python3 -m data.candidate_funnel_privacy_smoke\n" in section
    assert "python3 -m data.candidate_funnel_privacy_smoke || true" not in section


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
