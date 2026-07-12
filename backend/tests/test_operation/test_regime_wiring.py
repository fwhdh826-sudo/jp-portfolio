"""
Tests for backend/engine/operation/regime_wiring.py — Card 3-9
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

from backend.engine.operation.regime_wiring import read_is_crisis
from backend.engine.operation._routine_common import build_safe_mode_input
from backend.engine.snapshot.phase3_snapshot import write_json_atomic
from backend.engine.shadow.shadow_mode import (
    ShadowAuditInput,
    make_default_scenarios,
    run_shadow_audit,
)
from backend.engine.snapshot.regime_state_schema import build_regime_state_dict


# ── Helpers ───────────────────────────────────────────────────────────────────

FIXED_DATE = date(2026, 5, 3)


def _get_regime_result(name: str):
    inp = ShadowAuditInput(scenarios=make_default_scenarios(), run_date=FIXED_DATE)
    result = run_shadow_audit(inp)
    for r in result.results:
        if r.scenario_name == name:
            return r.regime_result
    raise KeyError(name)


def _write_regime_state(tmp_path: Path, scenario: str) -> Path:
    """scenario の regime_state.json を tmp_path に書いてパスを返す。"""
    rr = _get_regime_result(scenario)
    regime_dict = build_regime_state_dict(rr)
    p = tmp_path / "regime_state.json"
    write_json_atomic(regime_dict, p)
    return p


# ── read_is_crisis: basic ─────────────────────────────────────────────────────

class TestReadIsCrisisBasic:
    def test_returns_false_when_file_missing(self, tmp_path):
        p = tmp_path / "no_such_file.json"
        assert read_is_crisis(p) is False

    def test_returns_custom_default_when_file_missing(self, tmp_path):
        p = tmp_path / "no_such_file.json"
        assert read_is_crisis(p, default=True) is True

    def test_returns_default_on_json_decode_error(self, tmp_path):
        p = tmp_path / "regime_state.json"
        p.write_text("INVALID_JSON", encoding="utf-8")
        assert read_is_crisis(p) is False

    def test_returns_default_on_missing_regime_state_key(self, tmp_path):
        p = tmp_path / "regime_state.json"
        write_json_atomic({"other_key": {}}, p)
        assert read_is_crisis(p) is False

    def test_returns_default_on_missing_is_crisis_key(self, tmp_path):
        p = tmp_path / "regime_state.json"
        write_json_atomic({"regime_state": {"current_regime": "bull_calm"}}, p)
        assert read_is_crisis(p) is False

    def test_returns_bool_type(self, tmp_path):
        p = _write_regime_state(tmp_path, "S1_bull_calm_normal")
        result = read_is_crisis(p)
        assert isinstance(result, bool)

    def test_accepts_path_string(self, tmp_path):
        p = _write_regime_state(tmp_path, "S1_bull_calm_normal")
        result = read_is_crisis(str(p))
        assert isinstance(result, bool)


# ── read_is_crisis: scenario-based ───────────────────────────────────────────

class TestReadIsCrisisScenarios:
    def test_non_crisis_returns_false(self, tmp_path):
        p = _write_regime_state(tmp_path, "S1_bull_calm_normal")
        assert read_is_crisis(p) is False

    def test_bear_regime_returns_false(self, tmp_path):
        p = _write_regime_state(tmp_path, "S2_bear_two_thirds")
        assert read_is_crisis(p) is False

    def test_s3_crisis_returns_true(self, tmp_path):
        # S3: rule_based crisis → is_crisis=True
        p = _write_regime_state(tmp_path, "S3_crisis_rule_based")
        assert read_is_crisis(p) is True

    def test_s8_override_crisis_returns_true(self, tmp_path):
        # S8: LLM override → crisis → is_crisis=True AND is_override=True
        p = _write_regime_state(tmp_path, "S8_override_crisis")
        assert read_is_crisis(p) is True

    def test_fallback_uncertain_returns_false(self, tmp_path):
        p = _write_regime_state(tmp_path, "S5_fallback_all_disagree")
        assert read_is_crisis(p) is False

    def test_s9_hmm_low_confidence_returns_false(self, tmp_path):
        p = _write_regime_state(tmp_path, "S9_hmm_low_confidence")
        assert read_is_crisis(p) is False


# ── write-then-read roundtrip ─────────────────────────────────────────────────

class TestWriteThenReadRoundtrip:
    def test_write_crisis_true_read_crisis_true(self, tmp_path):
        p = tmp_path / "regime_state.json"
        write_json_atomic({"regime_state": {"is_crisis": True}}, p)
        assert read_is_crisis(p) is True

    def test_write_crisis_false_read_crisis_false(self, tmp_path):
        p = tmp_path / "regime_state.json"
        write_json_atomic({"regime_state": {"is_crisis": False}}, p)
        assert read_is_crisis(p) is False

    def test_reads_from_tmp_path_only(self, tmp_path):
        # テストは public/data を参照しない
        p = _write_regime_state(tmp_path, "S3_crisis_rule_based")
        assert str(p).startswith(str(tmp_path))
        assert read_is_crisis(p) is True


# ── is_crisis → crisis_regime bridge ─────────────────────────────────────────

class TestCrisisRegimeBridge:
    """
    read_is_crisis() の戻り値が build_safe_mode_input() の crisis_regime 引数に
    そのまま渡せることを確認する。run_morning_routine は呼ばない。
    """

    def _dummy_freshness(self):
        from backend.engine.operation.data_freshness import (
            FreshnessResult, SourceFreshnessResult, STATUS_LOADED, TIER_1
        )
        from datetime import datetime, timezone
        now = datetime(2026, 5, 5, 7, 0, 0, tzinfo=timezone.utc)
        return FreshnessResult(
            checked_at=now,
            sources={
                "regime": SourceFreshnessResult(
                    name="regime", tier=TIER_1, max_age_minutes=60,
                    last_updated_at=now, is_stale=False,
                    status=STATUS_LOADED, age_minutes=0.0,
                )
            },
            any_tier1_stale=False,
            any_tier2_stale=False,
            safe_mode_triggered=False,
        )

    def _dummy_watchdog(self):
        from backend.engine.operation.watchdog import WatchdogResult
        return WatchdogResult(
            sources={}, any_critical=False, system_error=False,
            checked_at=datetime(2026, 5, 5, 7, 0, 0, tzinfo=timezone.utc),
        )

    def test_is_crisis_true_sets_crisis_regime_true(self, tmp_path):
        p = tmp_path / "regime_state.json"
        write_json_atomic({"regime_state": {"is_crisis": True}}, p)

        crisis = read_is_crisis(p)
        safe_mode_input = build_safe_mode_input(
            self._dummy_freshness(),
            self._dummy_watchdog(),
            crisis_regime=crisis,
        )
        assert safe_mode_input.crisis_regime is True

    def test_is_crisis_false_sets_crisis_regime_false(self, tmp_path):
        p = tmp_path / "regime_state.json"
        write_json_atomic({"regime_state": {"is_crisis": False}}, p)

        crisis = read_is_crisis(p)
        safe_mode_input = build_safe_mode_input(
            self._dummy_freshness(),
            self._dummy_watchdog(),
            crisis_regime=crisis,
        )
        assert safe_mode_input.crisis_regime is False

    def test_missing_file_defaults_to_false_crisis_regime(self, tmp_path):
        p = tmp_path / "no_file.json"
        crisis = read_is_crisis(p, default=False)
        safe_mode_input = build_safe_mode_input(
            self._dummy_freshness(),
            self._dummy_watchdog(),
            crisis_regime=crisis,
        )
        assert safe_mode_input.crisis_regime is False

    def test_s3_crisis_activates_safe_mode(self, tmp_path):
        """S3 crisis → is_crisis=True → safe_mode.crisis_regime=True を end-to-end で確認。"""
        from backend.engine.operation.safe_mode import evaluate_safe_mode

        p = _write_regime_state(tmp_path, "S3_crisis_rule_based")
        crisis = read_is_crisis(p)

        safe_mode_input = build_safe_mode_input(
            self._dummy_freshness(),
            self._dummy_watchdog(),
            crisis_regime=crisis,
        )
        safe_mode = evaluate_safe_mode(safe_mode_input)
        assert safe_mode.active is True
        assert safe_mode.restrictions.new_buys_frozen is True
        assert safe_mode.restrictions.rebalance_frozen is True

    def test_s1_non_crisis_does_not_activate_safe_mode(self, tmp_path):
        """S1 bull_calm → is_crisis=False → safe_mode.active=False を確認。"""
        from backend.engine.operation.safe_mode import evaluate_safe_mode

        p = _write_regime_state(tmp_path, "S1_bull_calm_normal")
        crisis = read_is_crisis(p)

        safe_mode_input = build_safe_mode_input(
            self._dummy_freshness(),
            self._dummy_watchdog(),
            crisis_regime=crisis,
        )
        safe_mode = evaluate_safe_mode(safe_mode_input)
        assert safe_mode.active is False
