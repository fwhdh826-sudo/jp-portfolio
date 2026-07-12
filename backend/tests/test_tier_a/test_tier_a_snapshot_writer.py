"""
P4-A21 — TierA Snapshot Writer テスト
tier_a_violations.json / tier_a_alerts.json の生成・dry-run・fail-safe・
T3 SAFE_MODE連動・T1/T2/T4 非BUY候補ゲート性を担保するテスト群。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from backend.engine.tier_a.tier_a_snapshot_writer import (
    build_alerts_snapshot,
    build_violations_snapshot,
    write_tier_a_alerts_snapshot,
    write_tier_a_violations_snapshot,
    _cli_main,
)
from backend.engine.tier_a.tier_a_hard_gate import (
    HardGateResult,
    HardViolation,
)
from backend.engine.tier_a.alerts_emitter import (
    AlertEvent,
    AlertsResult,
)

# ── Fixtures ──────────────────────────────────────────────────────────────────

NOW = datetime(2026, 6, 17, 9, 0, 0, tzinfo=timezone.utc)


def _make_hard_gate_result(
    *,
    t1_triggered: bool = False,
    t2_triggered: bool = False,
    t3_triggered: bool = False,
    t4_triggered: bool = False,
) -> HardGateResult:
    violations = [
        HardViolation(
            rule_id="T1",
            triggered=t1_triggered,
            detail="T1 test",
            action_recommended="force_sell_recommended" if t1_triggered else "none",
        ),
        HardViolation(
            rule_id="T2",
            triggered=t2_triggered,
            detail="T2 test",
            action_recommended="compress_to_35pct_recommended" if t2_triggered else "none",
        ),
        HardViolation(
            rule_id="T3",
            triggered=t3_triggered,
            detail="T3 test",
            action_recommended="freeze_all_buys_recommended" if t3_triggered else "none",
        ),
        HardViolation(
            rule_id="T4",
            triggered=t4_triggered,
            detail="T4 test",
            action_recommended="scale_down_risk_50pct_recommended" if t4_triggered else "none",
        ),
    ]
    any_triggered = any([t1_triggered, t2_triggered, t3_triggered, t4_triggered])
    return HardGateResult(
        violations=violations,
        any_triggered=any_triggered,
        safe_mode_recommended=t3_triggered,
    )


def _make_alerts_result(*, l1: bool = False, l2: bool = False, l3: bool = False, opp: bool = False) -> AlertsResult:
    def _ev(level: str, triggered: bool) -> AlertEvent:
        return AlertEvent(
            level=level,
            triggered=triggered,
            trigger_reasons=["test"] if triggered else [],
            action_recommended="test_recommended" if triggered else "none",
            detail=f"{level} test",
        )
    levels = {"L1": l1, "L2": l2, "L3": l3, "OPPORTUNITY": opp}
    active = [lv for lv, tr in levels.items() if tr]
    highest = active[-1] if active else "NONE"
    return AlertsResult(
        l1=_ev("L1", l1),
        l2=_ev("L2", l2),
        l3=_ev("L3", l3),
        opportunity=_ev("OPPORTUNITY", opp),
        highest_level=highest,
        has_opportunity=opp,
    )


# ── TestBuildViolationsSnapshot ───────────────────────────────────────────────

class TestBuildViolationsSnapshot:

    def test_none_result_produces_unavailable(self):
        data = build_violations_snapshot(None, NOW)
        assert data["status"] == "unavailable"

    def test_none_result_has_required_fields(self):
        data = build_violations_snapshot(None, NOW)
        assert "generated_at" in data
        assert "status" in data
        assert "summary" in data
        assert "violations" in data
        assert data["_meta"]["kind"] == "live_tier_a_violations"
        assert data["_meta"]["not_for_trading"] is True

    def test_no_violations_status_ok(self):
        result = _make_hard_gate_result()
        data = build_violations_snapshot(result, NOW)
        assert data["status"] == "ok"
        assert data["summary"]["total_violations"] == 0

    def test_t3_triggered_status_degraded(self):
        result = _make_hard_gate_result(t3_triggered=True)
        data = build_violations_snapshot(result, NOW)
        assert data["status"] == "degraded"

    def test_t3_safe_mode_related_true(self):
        result = _make_hard_gate_result(t3_triggered=True)
        data = build_violations_snapshot(result, NOW)
        t3 = next(v for v in data["violations"] if v["code"] == "T3")
        assert t3["safe_mode_related"] is True
        assert t3["triggered"] is True

    def test_t1_t2_t4_not_safe_mode_related(self):
        result = _make_hard_gate_result(t1_triggered=True, t2_triggered=True, t4_triggered=True)
        data = build_violations_snapshot(result, NOW)
        for v in data["violations"]:
            if v["code"] in ("T1", "T2", "T4"):
                assert v["safe_mode_related"] is False, (
                    f"{v['code']} must not be safe_mode_related"
                )

    def test_t1_target_type_holding(self):
        result = _make_hard_gate_result(t1_triggered=True)
        data = build_violations_snapshot(result, NOW)
        t1 = next(v for v in data["violations"] if v["code"] == "T1")
        assert t1["target_type"] == "holding"

    def test_t2_target_type_portfolio(self):
        result = _make_hard_gate_result(t2_triggered=True)
        data = build_violations_snapshot(result, NOW)
        t2 = next(v for v in data["violations"] if v["code"] == "T2")
        assert t2["target_type"] == "portfolio"

    def test_t4_target_type_system(self):
        result = _make_hard_gate_result(t4_triggered=True)
        data = build_violations_snapshot(result, NOW)
        t4 = next(v for v in data["violations"] if v["code"] == "T4")
        assert t4["target_type"] == "system"

    def test_t1_t2_t4_target_not_candidate(self):
        # T1/T2/T4 are holding/portfolio/system concerns, not BUY candidate gates
        result = _make_hard_gate_result(t1_triggered=True, t2_triggered=True, t4_triggered=True)
        data = build_violations_snapshot(result, NOW)
        for v in data["violations"]:
            if v["code"] in ("T1", "T2", "T4"):
                assert v["target_type"] != "candidate", (
                    f"{v['code']} must not have target_type=candidate"
                )

    def test_t3_count_in_summary(self):
        result = _make_hard_gate_result(t3_triggered=True)
        data = build_violations_snapshot(result, NOW)
        assert data["summary"]["t3_count"] == 1
        assert data["summary"]["safe_mode_related_count"] == 1

    def test_t1_does_not_increment_t3_count(self):
        result = _make_hard_gate_result(t1_triggered=True)
        data = build_violations_snapshot(result, NOW)
        assert data["summary"]["t3_count"] == 0
        assert data["summary"]["safe_mode_related_count"] == 0

    def test_source_field(self):
        data = build_violations_snapshot(None, NOW)
        assert data["source"] == "backend_tier_a_hard_gate"


# ── TestBuildAlertsSnapshot ───────────────────────────────────────────────────

class TestBuildAlertsSnapshot:

    def test_none_result_produces_unavailable(self):
        data = build_alerts_snapshot(None, NOW)
        assert data["status"] == "unavailable"

    def test_none_result_has_required_fields(self):
        data = build_alerts_snapshot(None, NOW)
        assert "generated_at" in data
        assert "status" in data
        assert "summary" in data
        assert "alerts" in data
        assert data["_meta"]["kind"] == "live_tier_a_alerts"
        assert data["_meta"]["not_for_trading"] is True

    def test_no_alerts_status_ok(self):
        result = _make_alerts_result()
        data = build_alerts_snapshot(result, NOW)
        assert data["status"] == "ok"
        assert data["summary"]["highest_level"] == "NONE"
        assert data["summary"]["total_triggered"] == 0

    def test_l3_alert_status_degraded(self):
        result = _make_alerts_result(l3=True)
        data = build_alerts_snapshot(result, NOW)
        assert data["status"] == "degraded"

    def test_highest_level_in_summary(self):
        result = _make_alerts_result(l1=True, l2=True)
        data = build_alerts_snapshot(result, NOW)
        assert data["summary"]["highest_level"] == "L2"

    def test_l3_recommended_action_block_new_buy(self):
        result = _make_alerts_result(l3=True)
        data = build_alerts_snapshot(result, NOW)
        l3_entry = next(a for a in data["alerts"] if a["code"] == "L3")
        assert l3_entry["recommended_action_type"] == "BLOCK_NEW_BUY"

    def test_l1_recommended_action_monitor(self):
        result = _make_alerts_result(l1=True)
        data = build_alerts_snapshot(result, NOW)
        l1_entry = next(a for a in data["alerts"] if a["code"] == "L1")
        assert l1_entry["recommended_action_type"] == "MONITOR"

    def test_source_field(self):
        data = build_alerts_snapshot(None, NOW)
        assert data["source"] == "backend_tier_a_alerts_emitter"


# ── TestWriters ───────────────────────────────────────────────────────────────

class TestWriters:

    def test_write_violations_creates_file(self, tmp_path):
        out = tmp_path / "tier_a_violations.json"
        write_tier_a_violations_snapshot(None, out, NOW)
        assert out.exists()
        data = json.loads(out.read_text())
        assert data["status"] == "unavailable"
        assert "generated_at" in data

    def test_write_alerts_creates_file(self, tmp_path):
        out = tmp_path / "tier_a_alerts.json"
        write_tier_a_alerts_snapshot(None, out, NOW)
        assert out.exists()
        data = json.loads(out.read_text())
        assert data["status"] == "unavailable"
        assert "generated_at" in data

    def test_write_violations_with_real_result(self, tmp_path):
        result = _make_hard_gate_result(t3_triggered=True)
        out = tmp_path / "tier_a_violations.json"
        write_tier_a_violations_snapshot(result, out, NOW)
        data = json.loads(out.read_text())
        assert data["status"] == "degraded"
        assert data["summary"]["t3_count"] == 1

    def test_write_creates_parent_dir(self, tmp_path):
        out = tmp_path / "subdir" / "tier_a_violations.json"
        write_tier_a_violations_snapshot(None, out, NOW)
        assert out.exists()


# ── TestCLIEntrypoint ─────────────────────────────────────────────────────────

class TestCLIEntrypoint:

    def test_dry_run_no_file_written(self, tmp_path, capsys):
        with pytest.raises(SystemExit):
            _cli_main(["--dry-run", "--output-dir", str(tmp_path)])
        captured = capsys.readouterr()
        assert "dry-run mode: no files written" in captured.out
        assert not list(tmp_path.glob("*.json"))

    def test_output_dir_writes_both_jsons(self, tmp_path, capsys):
        with pytest.raises(SystemExit):
            _cli_main(["--output-dir", str(tmp_path)])
        assert (tmp_path / "tier_a_violations.json").exists()
        assert (tmp_path / "tier_a_alerts.json").exists()

    def test_output_dir_json_contents(self, tmp_path):
        with pytest.raises(SystemExit):
            _cli_main(["--output-dir", str(tmp_path)])
        v_data = json.loads((tmp_path / "tier_a_violations.json").read_text())
        a_data = json.loads((tmp_path / "tier_a_alerts.json").read_text())
        assert "generated_at" in v_data
        assert "status" in v_data
        assert "summary" in v_data
        assert "generated_at" in a_data
        assert "status" in a_data
        assert "summary" in a_data

    def test_dry_run_suppresses_output_write(self, tmp_path, capsys):
        out_dir = tmp_path / "out"
        out_dir.mkdir()
        with pytest.raises(SystemExit):
            _cli_main(["--dry-run", "--output-dir", str(out_dir)])
        assert not (out_dir / "tier_a_violations.json").exists()
        assert not (out_dir / "tier_a_alerts.json").exists()

    def test_no_output_dir_prints_not_written(self, tmp_path, capsys):
        with pytest.raises(SystemExit):
            _cli_main([])
        captured = capsys.readouterr()
        assert "--output-dir not specified: JSON not written" in captured.out

    def test_stdout_contains_required_fields(self, tmp_path, capsys):
        with pytest.raises(SystemExit):
            _cli_main(["--dry-run"])
        captured = capsys.readouterr()
        for field in [
            "checked_at=",
            "violations.status=",
            "violations.total_violations=",
            "violations.t3_count=",
            "alerts.status=",
            "alerts.highest_level=",
        ]:
            assert field in captured.out, f"missing expected field: {field}"

    def test_cli_unavailable_status_without_portfolio_data(self, tmp_path, capsys):
        # CLI has no portfolio data → fail-safe → unavailable
        with pytest.raises(SystemExit):
            _cli_main(["--dry-run"])
        captured = capsys.readouterr()
        assert "violations.status=unavailable" in captured.out
        assert "alerts.status=unavailable" in captured.out

    def test_cli_exits_0_on_dry_run(self, tmp_path):
        with pytest.raises(SystemExit) as exc_info:
            _cli_main(["--dry-run"])
        assert exc_info.value.code == 0

    def test_cli_exits_0_after_write(self, tmp_path):
        with pytest.raises(SystemExit) as exc_info:
            _cli_main(["--output-dir", str(tmp_path)])
        assert exc_info.value.code == 0
