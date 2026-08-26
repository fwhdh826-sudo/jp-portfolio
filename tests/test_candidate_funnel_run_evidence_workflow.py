"""OPS-P14-2: .github/workflows/full_batch.yml への same-run evidence capture
統合の回帰テスト。

tests/test_candidate_funnel_workflow.pyと同じ規律（yml本文へのtext-based
アサーション、実CI実行はしない）で、以下を確認する:
  1. evidence capture / upload stepが存在し、smoke stepの直後・
     SAFE_MODEスナップショットより前に位置する
  2. capture / upload の両stepは `if: always()` かつ `continue-on-error: true`
     — candidate funnelがnonzero exitでも必ず実行され、かつこの2stepの
     失敗がjob全体やpublish判定に波及しない
  3. 「Enforce candidate funnel publication status」step（真の
     fail-closed enforcement）の本文がこのticketで一切変更されていない
     （byte-exact pin）
  4. previous artifact snapshot stepがbuild stepより前に存在する
  5. upload artifact名にrun id/attemptを含み、retention-daysを指定している
  6. pip installの依存集合に変更が無い（新規dependency追加 0）
  7. batch/smoke stepの `|| true` 不在（既存fail-closed hard gateを壊さない）
"""
from pathlib import Path

_WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "full_batch.yml"
_TEXT = _WORKFLOW.read_text()

_ENFORCE_STEP_EXPECTED = """      - name: Enforce candidate funnel publication status
        if: ${{ always() && !cancelled() }}
        env:
          CANDIDATE_FUNNEL_BATCH_STATUS: ${{ steps.candidate-funnel-build.outputs.publication_status }}
          CANDIDATE_FUNNEL_SMOKE_STATUS: ${{ steps.candidate-funnel-smoke.outputs.publication_status }}
        run: |
          set -euo pipefail

          if [ "$CANDIDATE_FUNNEL_BATCH_STATUS" = "batch_failed" ]; then
            echo "::error::Candidate funnel publication failed at the P-01..P-15 batch gate" >&2
            exit 1
          fi
          if [ "$CANDIDATE_FUNNEL_BATCH_STATUS" != "batch_passed" ]; then
            echo "::error::Candidate funnel batch status is unavailable or unsafe" >&2
            exit 1
          fi
          if [ "$CANDIDATE_FUNNEL_SMOKE_STATUS" = "smoke_failed" ]; then
            echo "::error::Candidate funnel publication failed at the privacy/schema gate" >&2
            exit 1
          fi
          if [ "$CANDIDATE_FUNNEL_SMOKE_STATUS" != "smoke_passed" ]; then
            echo "::error::Candidate funnel privacy/schema status is unavailable or unsafe" >&2
            exit 1
          fi

          echo "Candidate funnel publication gates passed"
"""


def _update_data_section() -> str:
    return _TEXT.split("  update-data:")[1].split("  routines-stub:")[0]


def _step_block(marker: str) -> str:
    """`marker`を含む`- name:`行から次のstep見出しまでのYAML断片を返す。"""
    section = _update_data_section()
    start = section.index(marker)
    head = section.rindex("\n      - name:", 0, start + 1)
    rest = section[head:]
    next_step_marker = rest.index("\n      - name:", 1)
    return rest[:next_step_marker]


def test_snapshot_previous_artifact_step_present_before_build():
    section = _update_data_section()
    snapshot_pos = section.index("Snapshot previous candidate_funnel artifact for evidence")
    build_pos = section.index("Build candidate_funnel.json (prescreen join + P-01..P-15 quality gate)")
    assert snapshot_pos < build_pos


def test_capture_step_present():
    assert "python3 -m data.candidate_funnel_run_evidence" in _TEXT


def test_capture_step_runs_after_smoke_and_before_safe_mode():
    section = _update_data_section()
    smoke_pos = section.index("python3 -m data.candidate_funnel_privacy_smoke")
    capture_pos = section.index("python3 -m data.candidate_funnel_run_evidence")
    safe_mode_pos = section.index("Build SAFE_MODE snapshot")
    assert smoke_pos < capture_pos < safe_mode_pos


def test_capture_step_has_always_and_continue_on_error():
    block = _step_block("python3 -m data.candidate_funnel_run_evidence")
    assert "if: always()" in block
    assert "continue-on-error: true" in block


def test_upload_step_present_and_configured():
    block = _step_block("actions/upload-artifact@v4\n        with:\n          name: candidate-funnel-evidence-")
    assert "if: always()" in block
    assert "continue-on-error: true" in block
    assert "retention-days: 90" in block
    assert "${{ github.run_id }}" in block
    assert "${{ github.run_attempt }}" in block
    assert "if-no-files-found: warn" in block


def test_upload_step_runs_after_capture_step():
    section = _update_data_section()
    capture_pos = section.index("python3 -m data.candidate_funnel_run_evidence")
    upload_pos = section.index("actions/upload-artifact@v4\n        with:\n          name: candidate-funnel-evidence-")
    assert capture_pos < upload_pos


def test_evidence_steps_do_not_disturb_safe_mode_or_tier_a_order():
    section = _update_data_section()
    upload_pos = section.index("actions/upload-artifact@v4\n        with:\n          name: candidate-funnel-evidence-")
    safe_mode_pos = section.index("Build SAFE_MODE snapshot")
    tier_a_pos = section.index("Build TierA snapshots")
    assert upload_pos < safe_mode_pos < tier_a_pos


def test_enforce_publication_status_step_is_byte_identical_to_pin():
    """真のfail-closed enforcement stepはこのticketで1バイトも変更しない
    ——additive evidence captureがexit statusのsemanticsに触れていないことの
    直接的な証拠。"""
    assert _ENFORCE_STEP_EXPECTED in _TEXT


def test_batch_and_smoke_steps_remain_blocking():
    section = _update_data_section()
    assert "python3 -m data.candidate_funnel_batch\n" in section
    assert "python3 -m data.candidate_funnel_batch || true" not in section
    assert "python3 -m data.candidate_funnel_privacy_smoke\n" in section
    assert "python3 -m data.candidate_funnel_privacy_smoke || true" not in section


def test_no_new_pip_dependency_added():
    assert "pip install yfinance pandas numpy feedparser requests xlrd" in _TEXT


def test_capture_and_upload_steps_have_no_secrets_env():
    """evidence step群はDEEPL_API_KEY等のsecretsを一切参照しない。"""
    capture_block = _step_block("python3 -m data.candidate_funnel_run_evidence")
    upload_block = _step_block("actions/upload-artifact@v4\n        with:\n          name: candidate-funnel-evidence-")
    assert "secrets." not in capture_block
    assert "secrets." not in upload_block
