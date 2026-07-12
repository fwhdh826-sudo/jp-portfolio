"""
P4-A22 — JSON Contract Consistency テスト
public/data/contracts/v13.3 の TierA / SAFE_MODE contract が
P4-A20/P4-A21 実装実態と一致することを担保するテスト群。

検証対象:
  - tier_a_violations.json: T1/T2/T3/T4 定義・safe_mode_related・target_type
  - tier_a_alerts.json: L1/L2/L3/OPPORTUNITY・recommended_action_type
  - safe_mode.json: writer出力との整合・fail-closed設計の明文化

T3のみSAFE_MODE連動候補、T1/T2/T4は非BUY候補ゲートであることを固定する。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from backend.engine.tier_a.tier_a_snapshot_writer import (
    build_violations_snapshot,
    build_alerts_snapshot,
)
from backend.engine.tier_a.tier_a_hard_gate import (
    HardGateResult,
    HardViolation,
)
from backend.engine.tier_a.alerts_emitter import (
    AlertEvent,
    AlertsResult,
)

# ── Contract file paths ────────────────────────────────────────────────────────

_REPO_ROOT = Path(__file__).parents[3]  # jp-portfolio/
_CONTRACTS = _REPO_ROOT / "public" / "data" / "contracts" / "v13.3"

VIOLATIONS_CONTRACT = _CONTRACTS / "tier_a" / "tier_a_violations.json"
ALERTS_CONTRACT     = _CONTRACTS / "tier_a" / "tier_a_alerts.json"
SAFE_MODE_CONTRACT  = _CONTRACTS / "operation" / "safe_mode.json"

NOW = datetime(2026, 6, 17, 9, 0, 0, tzinfo=timezone.utc)

# ── Helpers ───────────────────────────────────────────────────────────────────

def _load(path: Path) -> dict:
    return json.loads(path.read_text())


def _make_violations_result(*, t3_triggered: bool = False) -> HardGateResult:
    violations = [
        HardViolation("T1", False, "T1 clear", "none"),
        HardViolation("T2", False, "T2 clear", "none"),
        HardViolation("T3", t3_triggered, "T3 test", "freeze_all_buys_recommended" if t3_triggered else "none"),
        HardViolation("T4", False, "T4 clear", "none"),
    ]
    return HardGateResult(violations=violations, any_triggered=t3_triggered, safe_mode_recommended=t3_triggered)


def _make_alerts_result(*, l3: bool = False) -> AlertsResult:
    def ev(level: str, triggered: bool) -> AlertEvent:
        return AlertEvent(level=level, triggered=triggered, trigger_reasons=[], action_recommended="none", detail=f"{level} test")
    return AlertsResult(
        l1=ev("L1", False), l2=ev("L2", False), l3=ev("L3", l3), opportunity=ev("OPPORTUNITY", False),
        highest_level="L3" if l3 else "NONE", has_opportunity=False,
    )


# ── TestContractFilesExist ─────────────────────────────────────────────────────

class TestContractFilesExist:

    def test_violations_contract_exists(self):
        assert VIOLATIONS_CONTRACT.exists(), f"Missing: {VIOLATIONS_CONTRACT}"

    def test_alerts_contract_exists(self):
        assert ALERTS_CONTRACT.exists(), f"Missing: {ALERTS_CONTRACT}"

    def test_safe_mode_contract_exists(self):
        assert SAFE_MODE_CONTRACT.exists(), f"Missing: {SAFE_MODE_CONTRACT}"


# ── TestViolationsContract ────────────────────────────────────────────────────

class TestViolationsContract:

    def test_meta_kind_is_live_tier_a_violations(self):
        data = _load(VIOLATIONS_CONTRACT)
        assert data["_meta"]["kind"] == "live_tier_a_violations"

    def test_not_for_trading_true(self):
        data = _load(VIOLATIONS_CONTRACT)
        assert data["_meta"]["not_for_trading"] is True

    def test_fail_closed_documented(self):
        data = _load(VIOLATIONS_CONTRACT)
        assert "fail_closed" in data["_meta"]

    def test_required_top_level_fields(self):
        data = _load(VIOLATIONS_CONTRACT)
        for field in ["generated_at", "source", "status", "violations", "summary"]:
            assert field in data, f"Missing top-level field: {field}"

    def test_status_is_valid_value(self):
        data = _load(VIOLATIONS_CONTRACT)
        assert data["status"] in ("ok", "degraded", "unavailable")

    def test_violations_contains_t1_t2_t3_t4(self):
        data = _load(VIOLATIONS_CONTRACT)
        codes = {v["code"] for v in data["violations"]}
        assert codes == {"T1", "T2", "T3", "T4"}

    def test_t3_safe_mode_related_true(self):
        data = _load(VIOLATIONS_CONTRACT)
        t3 = next(v for v in data["violations"] if v["code"] == "T3")
        assert t3["safe_mode_related"] is True

    def test_t1_t2_t4_not_safe_mode_related(self):
        data = _load(VIOLATIONS_CONTRACT)
        for v in data["violations"]:
            if v["code"] in ("T1", "T2", "T4"):
                assert v["safe_mode_related"] is False, f"{v['code']} must not be safe_mode_related"

    def test_t1_target_type_holding(self):
        data = _load(VIOLATIONS_CONTRACT)
        t1 = next(v for v in data["violations"] if v["code"] == "T1")
        assert t1["target_type"] == "holding"

    def test_t2_target_type_portfolio(self):
        data = _load(VIOLATIONS_CONTRACT)
        t2 = next(v for v in data["violations"] if v["code"] == "T2")
        assert t2["target_type"] == "portfolio"

    def test_t3_target_type_portfolio(self):
        data = _load(VIOLATIONS_CONTRACT)
        t3 = next(v for v in data["violations"] if v["code"] == "T3")
        assert t3["target_type"] == "portfolio"

    def test_t4_target_type_system(self):
        data = _load(VIOLATIONS_CONTRACT)
        t4 = next(v for v in data["violations"] if v["code"] == "T4")
        assert t4["target_type"] == "system"

    def test_t1_t2_t4_target_not_candidate(self):
        # T1/T2/T4 are holding/portfolio/system concerns, not BUY candidate gates
        data = _load(VIOLATIONS_CONTRACT)
        for v in data["violations"]:
            if v["code"] in ("T1", "T2", "T4"):
                assert v.get("target_type") != "candidate", (
                    f"{v['code']} must not have target_type=candidate"
                )

    def test_t2_rule_definition_is_sector_cap_35(self):
        # Verify the contract has correct T2 definition (sector cap, not individual holding cap)
        data = _load(VIOLATIONS_CONTRACT)
        t2 = next(v for v in data["violations"] if v["code"] == "T2")
        rule_def = t2.get("_rule_definition", {})
        condition = rule_def.get("condition", "")
        # Must reference sector and 0.35 threshold (not 0.25 single holding)
        assert "sector" in condition.lower() or "0.35" in condition, (
            f"T2 definition must reference sector cap 0.35, got: {condition}"
        )
        threshold = rule_def.get("threshold")
        assert threshold == 0.35, f"T2 threshold must be 0.35, got: {threshold}"

    def test_t3_rule_definition_is_portfolio_dd_minus30(self):
        # Verify the contract has correct T3 definition (PF drawdown, not cash floor)
        data = _load(VIOLATIONS_CONTRACT)
        t3 = next(v for v in data["violations"] if v["code"] == "T3")
        rule_def = t3.get("_rule_definition", {})
        condition = rule_def.get("condition", "")
        assert "drawdown" in condition.lower() or "-0.30" in condition, (
            f"T3 definition must reference portfolio drawdown -0.30, got: {condition}"
        )
        threshold = rule_def.get("threshold")
        assert threshold == -0.30, f"T3 threshold must be -0.30, got: {threshold}"

    def test_t4_rule_definition_is_vix_nikkei_crash(self):
        # Verify the contract has correct T4 definition (VIX+Nikkei, not 3-month lock)
        data = _load(VIOLATIONS_CONTRACT)
        t4 = next(v for v in data["violations"] if v["code"] == "T4")
        rule_def = t4.get("_rule_definition", {})
        condition = rule_def.get("condition", "")
        assert "vix" in condition.lower(), (
            f"T4 definition must reference VIX, got: {condition}"
        )
        thresholds = rule_def.get("thresholds", {})
        assert thresholds.get("vix") == 40.0, f"T4 VIX threshold must be 40.0"
        assert thresholds.get("nikkei_daily") == -0.02, f"T4 nikkei threshold must be -0.02"

    def test_summary_fields_present(self):
        data = _load(VIOLATIONS_CONTRACT)
        summary = data["summary"]
        for field in ["total_violations", "t3_count", "safe_mode_related_count"]:
            assert field in summary, f"Missing summary field: {field}"

    def test_violation_required_fields(self):
        data = _load(VIOLATIONS_CONTRACT)
        required = {"code", "triggered", "severity", "target_type", "message", "safe_mode_related"}
        for v in data["violations"]:
            assert required.issubset(v.keys()), (
                f"Violation {v.get('code')} missing fields: {required - v.keys()}"
            )


# ── TestAlertsContract ────────────────────────────────────────────────────────

class TestAlertsContract:

    def test_meta_kind_is_live_tier_a_alerts(self):
        data = _load(ALERTS_CONTRACT)
        assert data["_meta"]["kind"] == "live_tier_a_alerts"

    def test_not_for_trading_true(self):
        data = _load(ALERTS_CONTRACT)
        assert data["_meta"]["not_for_trading"] is True

    def test_fail_closed_documented(self):
        data = _load(ALERTS_CONTRACT)
        assert "fail_closed" in data["_meta"]

    def test_required_top_level_fields(self):
        data = _load(ALERTS_CONTRACT)
        for field in ["generated_at", "source", "status", "alerts", "summary"]:
            assert field in data, f"Missing top-level field: {field}"

    def test_status_is_valid_value(self):
        data = _load(ALERTS_CONTRACT)
        assert data["status"] in ("ok", "degraded", "unavailable")

    def test_alerts_contains_l1_l2_l3_opportunity(self):
        data = _load(ALERTS_CONTRACT)
        codes = {a["code"] for a in data["alerts"]}
        assert codes == {"L1", "L2", "L3", "OPPORTUNITY"}

    def test_no_soft_penalty_ids_in_alerts(self):
        # Contract must NOT reference T5/T6/T7/T8 — those are soft penalties, not hard gate alerts
        data = _load(ALERTS_CONTRACT)
        codes = {a["code"] for a in data["alerts"]}
        for soft_id in ("T5", "T6", "T7", "T8", "T_v3"):
            assert soft_id not in codes, f"Soft penalty ID {soft_id} must not appear in alerts contract"

    def test_recommended_action_type_no_buy_sell(self):
        # recommended_action_type must not contain BUY/SELL断定
        data = _load(ALERTS_CONTRACT)
        forbidden_prefixes = ("BUY", "SELL", "FORCE_BUY", "FORCE_SELL")
        for alert in data["alerts"]:
            action = alert.get("recommended_action_type", "")
            for prefix in forbidden_prefixes:
                assert not action.startswith(prefix), (
                    f"recommended_action_type '{action}' contains forbidden prefix '{prefix}'"
                )

    def test_recommended_action_type_valid_values(self):
        data = _load(ALERTS_CONTRACT)
        valid = {"WAIT", "REVIEW", "BLOCK_NEW_BUY", "MONITOR"}
        for alert in data["alerts"]:
            action = alert.get("recommended_action_type", "")
            assert action in valid, f"Invalid recommended_action_type: {action}, must be one of {valid}"

    def test_l3_recommended_action_block_new_buy(self):
        data = _load(ALERTS_CONTRACT)
        l3 = next(a for a in data["alerts"] if a["code"] == "L3")
        assert l3["recommended_action_type"] == "BLOCK_NEW_BUY"

    def test_l1_recommended_action_monitor(self):
        data = _load(ALERTS_CONTRACT)
        l1 = next(a for a in data["alerts"] if a["code"] == "L1")
        assert l1["recommended_action_type"] == "MONITOR"

    def test_summary_fields_present(self):
        data = _load(ALERTS_CONTRACT)
        summary = data["summary"]
        for field in ["total_triggered", "highest_level"]:
            assert field in summary, f"Missing summary field: {field}"

    def test_alert_required_fields(self):
        data = _load(ALERTS_CONTRACT)
        required = {"code", "triggered", "severity", "message", "recommended_action_type"}
        for a in data["alerts"]:
            assert required.issubset(a.keys()), (
                f"Alert {a.get('code')} missing fields: {required - a.keys()}"
            )


# ── TestSafeModeContract ──────────────────────────────────────────────────────

class TestSafeModeContract:

    def test_meta_kind_is_operation_snapshot(self):
        # Matches P4-A20 write_safe_mode_snapshot() output kind
        data = _load(SAFE_MODE_CONTRACT)
        assert data["_meta"]["kind"] == "operation_snapshot"

    def test_not_for_trading_true(self):
        data = _load(SAFE_MODE_CONTRACT)
        assert data["_meta"]["not_for_trading"] is True

    def test_fail_closed_documented(self):
        data = _load(SAFE_MODE_CONTRACT)
        assert "fail_closed" in data["_meta"]

    def test_safe_mode_required_fields(self):
        data = _load(SAFE_MODE_CONTRACT)
        safe_mode = data["safe_mode"]
        required = {
            "active", "triggered_at", "trigger_reason", "trigger_reason_detail",
            "trigger_conditions", "restrictions", "estimated_resume_at", "last_checked",
        }
        assert required.issubset(safe_mode.keys()), (
            f"safe_mode missing fields: {required - safe_mode.keys()}"
        )

    def test_trigger_conditions_fields(self):
        data = _load(SAFE_MODE_CONTRACT)
        tc = data["safe_mode"]["trigger_conditions"]
        for field in ["tier1_data_stale", "tier_a_t3_violated", "crisis_regime", "system_error"]:
            assert field in tc, f"Missing trigger_condition field: {field}"

    def test_restrictions_fields(self):
        data = _load(SAFE_MODE_CONTRACT)
        r = data["safe_mode"]["restrictions"]
        for field in ["new_buys_frozen", "rebalance_frozen", "force_sell_active"]:
            assert field in r, f"Missing restriction field: {field}"

    def test_active_is_boolean(self):
        data = _load(SAFE_MODE_CONTRACT)
        assert isinstance(data["safe_mode"]["active"], bool)


# ── TestWriterOutputMatchesContractSchema ─────────────────────────────────────

class TestWriterOutputMatchesContractSchema:
    """P4-A21 writer の出力が contract schema と一致することを検証する。"""

    def test_violations_writer_output_has_contract_fields(self):
        result = _make_violations_result()
        output = build_violations_snapshot(result, NOW)
        contract = _load(VIOLATIONS_CONTRACT)
        # Top-level structure
        for field in ["generated_at", "source", "status", "violations", "summary"]:
            assert field in output, f"Writer output missing: {field}"
        # Violation item structure matches contract
        contract_fields = {k for k in contract["violations"][0].keys() if not k.startswith("_")}
        output_fields = set(output["violations"][0].keys())
        assert contract_fields.issubset(output_fields), (
            f"Writer output missing contract fields: {contract_fields - output_fields}"
        )

    def test_alerts_writer_output_has_contract_fields(self):
        result = _make_alerts_result()
        output = build_alerts_snapshot(result, NOW)
        contract = _load(ALERTS_CONTRACT)
        for field in ["generated_at", "source", "status", "alerts", "summary"]:
            assert field in output, f"Writer output missing: {field}"
        contract_fields = {k for k in contract["alerts"][0].keys() if not k.startswith("_")}
        output_fields = set(output["alerts"][0].keys())
        assert contract_fields.issubset(output_fields), (
            f"Writer output missing contract fields: {contract_fields - output_fields}"
        )

    def test_violations_contract_kind_matches_writer_meta(self):
        result = _make_violations_result()
        output = build_violations_snapshot(result, NOW)
        contract = _load(VIOLATIONS_CONTRACT)
        assert output["_meta"]["kind"] == contract["_meta"]["kind"]

    def test_alerts_contract_kind_matches_writer_meta(self):
        result = _make_alerts_result()
        output = build_alerts_snapshot(result, NOW)
        contract = _load(ALERTS_CONTRACT)
        assert output["_meta"]["kind"] == contract["_meta"]["kind"]

    def test_writer_t3_safe_mode_related_matches_contract(self):
        result = _make_violations_result(t3_triggered=True)
        output = build_violations_snapshot(result, NOW)
        t3_out = next(v for v in output["violations"] if v["code"] == "T3")
        contract = _load(VIOLATIONS_CONTRACT)
        t3_con = next(v for v in contract["violations"] if v["code"] == "T3")
        assert t3_out["safe_mode_related"] == t3_con["safe_mode_related"] == True

    def test_writer_t1_t2_t4_not_safe_mode_related_matches_contract(self):
        result = _make_violations_result()
        output = build_violations_snapshot(result, NOW)
        for v_out in output["violations"]:
            if v_out["code"] in ("T1", "T2", "T4"):
                assert v_out["safe_mode_related"] is False
        contract = _load(VIOLATIONS_CONTRACT)
        for v_con in contract["violations"]:
            if v_con["code"] in ("T1", "T2", "T4"):
                assert v_con["safe_mode_related"] is False
