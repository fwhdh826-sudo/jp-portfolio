"""
Tests for backend/engine/snapshot/orchestrator_persistence.py — Card 3-9
"""
from __future__ import annotations

import json
import math
from datetime import date, datetime, timezone, timedelta
from pathlib import Path

import pytest

from backend.engine.snapshot.orchestrator_persistence import (
    PersistedOrchestratorState,
    compute_gap_days,
    enrich_regime_state_dict,
    load_persisted_state,
    needs_gap_reset,
    save_persisted_state,
    update_persisted_state,
)
from backend.engine.shadow.shadow_mode import (
    ShadowAuditInput,
    make_default_scenarios,
    run_shadow_audit,
)
from backend.engine.snapshot.regime_state_schema import build_regime_state_dict


# ── Helpers ───────────────────────────────────────────────────────────────────

TODAY = date(2026, 5, 5)
YESTERDAY = date(2026, 5, 4)
TWO_DAYS_AGO = date(2026, 5, 3)
THREE_DAYS_AGO = date(2026, 5, 2)

FIXED_TS = datetime(2026, 5, 3, 7, 0, 0, tzinfo=timezone.utc)
FIXED_TS_ISO = "2026-05-03T07:00:00+00:00"


def _get_regime_result(name: str):
    inp = ShadowAuditInput(scenarios=make_default_scenarios(), run_date=date(2026, 5, 3))
    result = run_shadow_audit(inp)
    for r in result.results:
        if r.scenario_name == name:
            return r.regime_result
    raise KeyError(name)


# ── PersistedOrchestratorState ────────────────────────────────────────────────

class TestPersistedOrchestratorStateDefaults:
    def test_all_fields_default_none(self):
        s = PersistedOrchestratorState()
        assert s.last_run_date is None
        assert s.last_regime is None
        assert s.previous_regime is None
        assert s.regime_changed_at is None

    def test_explicit_construction(self):
        s = PersistedOrchestratorState(
            last_run_date=TODAY,
            last_regime="bull_calm",
            previous_regime="bear",
            regime_changed_at=FIXED_TS_ISO,
        )
        assert s.last_run_date == TODAY
        assert s.last_regime == "bull_calm"
        assert s.previous_regime == "bear"
        assert s.regime_changed_at == FIXED_TS_ISO


# ── load_persisted_state ──────────────────────────────────────────────────────

class TestLoadPersistedState:
    def test_returns_default_when_file_missing(self, tmp_path):
        s = load_persisted_state(tmp_path / "no_such_file.json")
        assert s == PersistedOrchestratorState()

    def test_returns_default_when_dir_missing(self, tmp_path):
        s = load_persisted_state(tmp_path / "no_dir" / "state.json")
        assert s == PersistedOrchestratorState()

    def test_returns_default_on_invalid_json(self, tmp_path):
        p = tmp_path / "state.json"
        p.write_text("NOT_JSON", encoding="utf-8")
        s = load_persisted_state(p)
        assert s == PersistedOrchestratorState()

    def test_loads_last_run_date_as_date(self, tmp_path):
        p = tmp_path / "state.json"
        p.write_text(
            json.dumps({"last_run_date": "2026-05-05", "last_regime": None,
                        "previous_regime": None, "regime_changed_at": None}),
            encoding="utf-8",
        )
        s = load_persisted_state(p)
        assert s.last_run_date == date(2026, 5, 5)

    def test_loads_regimes_and_changed_at(self, tmp_path):
        p = tmp_path / "state.json"
        p.write_text(
            json.dumps({
                "last_run_date": "2026-05-05",
                "last_regime": "bull_calm",
                "previous_regime": "bear",
                "regime_changed_at": FIXED_TS_ISO,
            }),
            encoding="utf-8",
        )
        s = load_persisted_state(p)
        assert s.last_regime == "bull_calm"
        assert s.previous_regime == "bear"
        assert s.regime_changed_at == FIXED_TS_ISO

    def test_loads_null_fields_as_none(self, tmp_path):
        p = tmp_path / "state.json"
        p.write_text(
            json.dumps({"last_run_date": None, "last_regime": None,
                        "previous_regime": None, "regime_changed_at": None}),
            encoding="utf-8",
        )
        s = load_persisted_state(p)
        assert s == PersistedOrchestratorState()


# ── save_persisted_state ──────────────────────────────────────────────────────

class TestSavePersistedState:
    def test_writes_file_to_tmp_path(self, tmp_path):
        p = tmp_path / "state.json"
        save_persisted_state(PersistedOrchestratorState(), p)
        assert p.exists()

    def test_written_content_is_valid_json(self, tmp_path):
        p = tmp_path / "state.json"
        save_persisted_state(PersistedOrchestratorState(), p)
        data = json.loads(p.read_text(encoding="utf-8"))
        assert isinstance(data, dict)

    def test_no_tmp_file_left_after_success(self, tmp_path):
        save_persisted_state(PersistedOrchestratorState(), tmp_path / "state.json")
        assert list(tmp_path.glob("*.tmp")) == []

    def test_round_trip_preserves_all_fields(self, tmp_path):
        p = tmp_path / "state.json"
        original = PersistedOrchestratorState(
            last_run_date=TODAY,
            last_regime="crisis",
            previous_regime="bull_calm",
            regime_changed_at=FIXED_TS_ISO,
        )
        save_persisted_state(original, p)
        loaded = load_persisted_state(p)
        assert loaded.last_run_date == TODAY
        assert loaded.last_regime == "crisis"
        assert loaded.previous_regime == "bull_calm"
        assert loaded.regime_changed_at == FIXED_TS_ISO

    def test_round_trip_all_none(self, tmp_path):
        p = tmp_path / "state.json"
        save_persisted_state(PersistedOrchestratorState(), p)
        loaded = load_persisted_state(p)
        assert loaded == PersistedOrchestratorState()

    def test_overwrite_existing_file(self, tmp_path):
        p = tmp_path / "state.json"
        save_persisted_state(
            PersistedOrchestratorState(last_regime="bull_calm"), p
        )
        save_persisted_state(
            PersistedOrchestratorState(last_regime="crisis"), p
        )
        loaded = load_persisted_state(p)
        assert loaded.last_regime == "crisis"


# ── compute_gap_days ──────────────────────────────────────────────────────────

class TestComputeGapDays:
    def test_none_last_run_returns_zero(self):
        assert compute_gap_days(None, TODAY) == 0

    def test_same_day_returns_zero(self):
        assert compute_gap_days(TODAY, TODAY) == 0

    def test_one_day_gap_returns_one(self):
        assert compute_gap_days(YESTERDAY, TODAY) == 1

    def test_two_day_gap_returns_two(self):
        assert compute_gap_days(TWO_DAYS_AGO, TODAY) == 2

    def test_three_day_gap_returns_three(self):
        assert compute_gap_days(THREE_DAYS_AGO, TODAY) == 3


# ── needs_gap_reset ───────────────────────────────────────────────────────────

class TestNeedsGapReset:
    def test_none_last_run_returns_false(self):
        # 初回実行 — gap なし
        assert needs_gap_reset(None, TODAY) is False

    def test_same_day_returns_false(self):
        assert needs_gap_reset(TODAY, TODAY) is False

    def test_adjacent_day_returns_false(self):
        # gap = 1（隣接日）→ リセット不要
        assert needs_gap_reset(YESTERDAY, TODAY) is False

    def test_two_day_gap_returns_true(self):
        # gap = 2 → リセット必要
        assert needs_gap_reset(TWO_DAYS_AGO, TODAY) is True

    def test_three_day_gap_returns_true(self):
        assert needs_gap_reset(THREE_DAYS_AGO, TODAY) is True

    def test_long_gap_returns_true(self):
        long_ago = date(2026, 1, 1)
        assert needs_gap_reset(long_ago, TODAY) is True


# ── update_persisted_state ────────────────────────────────────────────────────

class TestUpdatePersistedState:
    def _make_result(self, regime: str):
        """Build OrchestratorResult with specified regime via shadow scenarios."""
        name_map = {
            "bull_calm": "S1_bull_calm_normal",
            "bear": "S2_bear_two_thirds",
            "crisis": "S3_crisis_rule_based",
        }
        return _get_regime_result(name_map[regime])

    def test_first_run_sets_last_run_date(self):
        prev = PersistedOrchestratorState()
        result = self._make_result("bull_calm")
        new = update_persisted_state(prev, result, TODAY)
        assert new.last_run_date == TODAY

    def test_first_run_sets_last_regime(self):
        prev = PersistedOrchestratorState()
        result = self._make_result("bull_calm")
        new = update_persisted_state(prev, result, TODAY)
        assert new.last_regime == "bull_calm"

    def test_first_run_previous_regime_is_none(self):
        # 初回は previous_regime = None（前がないため）
        prev = PersistedOrchestratorState()
        result = self._make_result("bull_calm")
        new = update_persisted_state(prev, result, TODAY)
        assert new.previous_regime is None

    def test_first_run_regime_changed_at_is_set(self):
        prev = PersistedOrchestratorState()
        result = self._make_result("bull_calm")
        new = update_persisted_state(prev, result, TODAY)
        assert new.regime_changed_at is not None

    def test_regime_unchanged_preserves_changed_at(self):
        prev = PersistedOrchestratorState(
            last_run_date=YESTERDAY,
            last_regime="bull_calm",
            previous_regime=None,
            regime_changed_at=FIXED_TS_ISO,
        )
        result = self._make_result("bull_calm")
        new = update_persisted_state(prev, result, TODAY)
        assert new.regime_changed_at == FIXED_TS_ISO

    def test_regime_unchanged_preserves_previous_regime(self):
        prev = PersistedOrchestratorState(
            last_run_date=YESTERDAY,
            last_regime="bull_calm",
            previous_regime="bear",
            regime_changed_at=FIXED_TS_ISO,
        )
        result = self._make_result("bull_calm")
        new = update_persisted_state(prev, result, TODAY)
        assert new.previous_regime == "bear"

    def test_regime_changed_updates_changed_at(self):
        prev = PersistedOrchestratorState(
            last_run_date=YESTERDAY,
            last_regime="bull_calm",
            previous_regime=None,
            regime_changed_at=FIXED_TS_ISO,
        )
        result = self._make_result("bear")
        new = update_persisted_state(prev, result, TODAY)
        # regime_changed_at が新しい値になっている（result.checked_at）
        assert new.regime_changed_at != FIXED_TS_ISO
        assert new.regime_changed_at is not None

    def test_regime_changed_sets_previous_regime_to_old(self):
        prev = PersistedOrchestratorState(
            last_run_date=YESTERDAY,
            last_regime="bull_calm",
            previous_regime=None,
            regime_changed_at=FIXED_TS_ISO,
        )
        result = self._make_result("bear")
        new = update_persisted_state(prev, result, TODAY)
        assert new.previous_regime == "bull_calm"

    def test_regime_changed_last_regime_is_new(self):
        prev = PersistedOrchestratorState(
            last_run_date=YESTERDAY,
            last_regime="bull_calm",
        )
        result = self._make_result("crisis")
        new = update_persisted_state(prev, result, TODAY)
        assert new.last_regime == "crisis"

    def test_crisis_then_bear_transition(self):
        prev = PersistedOrchestratorState(
            last_run_date=YESTERDAY,
            last_regime="crisis",
            previous_regime="bull_calm",
            regime_changed_at=FIXED_TS_ISO,
        )
        result = self._make_result("bear")
        new = update_persisted_state(prev, result, TODAY)
        assert new.last_regime == "bear"
        assert new.previous_regime == "crisis"


# ── enrich_regime_state_dict ──────────────────────────────────────────────────

class TestEnrichRegimeStateDict:
    def _build_raw_dict(self, scenario: str = "S1_bull_calm_normal"):
        rr = _get_regime_result(scenario)
        return build_regime_state_dict(rr)

    def test_fills_regime_changed_at_from_state(self):
        raw = self._build_raw_dict()
        state = PersistedOrchestratorState(regime_changed_at=FIXED_TS_ISO)
        enriched = enrich_regime_state_dict(raw, state, FIXED_TS)
        assert enriched["regime_state"]["regime_changed_at"] == FIXED_TS_ISO

    def test_fills_previous_regime_from_state(self):
        raw = self._build_raw_dict()
        state = PersistedOrchestratorState(previous_regime="bear")
        enriched = enrich_regime_state_dict(raw, state, FIXED_TS)
        assert enriched["regime_state"]["previous_regime"] == "bear"

    def test_computes_duration_hours_when_changed_at_present(self):
        raw = self._build_raw_dict()
        # regime_changed_at: 48 hours before FIXED_TS
        changed_at = FIXED_TS - timedelta(hours=48)
        state = PersistedOrchestratorState(regime_changed_at=changed_at.isoformat())
        enriched = enrich_regime_state_dict(raw, state, FIXED_TS)
        assert math.isclose(enriched["regime_state"]["duration_hours"], 48.0, abs_tol=0.01)

    def test_duration_hours_is_none_when_changed_at_none(self):
        raw = self._build_raw_dict()
        state = PersistedOrchestratorState()  # regime_changed_at = None
        enriched = enrich_regime_state_dict(raw, state, FIXED_TS)
        assert enriched["regime_state"]["duration_hours"] is None

    def test_duration_hours_positive(self):
        raw = self._build_raw_dict()
        changed_at = FIXED_TS - timedelta(hours=24)
        state = PersistedOrchestratorState(regime_changed_at=changed_at.isoformat())
        enriched = enrich_regime_state_dict(raw, state, FIXED_TS)
        assert enriched["regime_state"]["duration_hours"] > 0

    def test_previous_regime_none_when_state_none(self):
        raw = self._build_raw_dict()
        state = PersistedOrchestratorState()
        enriched = enrich_regime_state_dict(raw, state, FIXED_TS)
        assert enriched["regime_state"]["previous_regime"] is None

    def test_regime_changed_at_none_when_state_none(self):
        raw = self._build_raw_dict()
        state = PersistedOrchestratorState()
        enriched = enrich_regime_state_dict(raw, state, FIXED_TS)
        assert enriched["regime_state"]["regime_changed_at"] is None

    def test_regime_state_key_preserved(self):
        raw = self._build_raw_dict()
        state = PersistedOrchestratorState()
        enriched = enrich_regime_state_dict(raw, state, FIXED_TS)
        assert "regime_state" in enriched

    def test_metadata_key_preserved(self):
        raw = self._build_raw_dict()
        state = PersistedOrchestratorState()
        enriched = enrich_regime_state_dict(raw, state, FIXED_TS)
        assert "_metadata" in enriched

    def test_schema_version_preserved(self):
        raw = self._build_raw_dict()
        state = PersistedOrchestratorState()
        enriched = enrich_regime_state_dict(raw, state, FIXED_TS)
        assert enriched["regime_state"]["schema_version"] == "3.8"

    def test_existing_fields_not_overwritten(self):
        raw = self._build_raw_dict()
        current_regime_before = raw["regime_state"]["current_regime"]
        state = PersistedOrchestratorState(previous_regime="crisis")
        enriched = enrich_regime_state_dict(raw, state, FIXED_TS)
        assert enriched["regime_state"]["current_regime"] == current_regime_before

    def test_duration_hours_rounded_to_two_decimal(self):
        raw = self._build_raw_dict()
        # 1.5 hours → 1.5
        changed_at = FIXED_TS - timedelta(hours=1, minutes=30)
        state = PersistedOrchestratorState(regime_changed_at=changed_at.isoformat())
        enriched = enrich_regime_state_dict(raw, state, FIXED_TS)
        hours = enriched["regime_state"]["duration_hours"]
        assert isinstance(hours, float)
        assert hours == round(hours, 2)

    def test_returns_same_dict_object(self):
        raw = self._build_raw_dict()
        state = PersistedOrchestratorState()
        returned = enrich_regime_state_dict(raw, state, FIXED_TS)
        assert returned is raw


# ── round-trip integration ────────────────────────────────────────────────────

class TestRoundTripIntegration:
    def test_save_update_load_enrich_pipeline(self, tmp_path):
        """save → load → update → enrich の一連フローをテスト。"""
        state_path = tmp_path / "orchestrator_state.json"

        # Step 1: 初回実行
        prev = load_persisted_state(state_path)  # default
        result = _get_regime_result("S1_bull_calm_normal")
        today = date(2026, 5, 5)

        new_state = update_persisted_state(prev, result, today)
        save_persisted_state(new_state, state_path)

        # Step 2: 再ロードして内容確認
        reloaded = load_persisted_state(state_path)
        assert reloaded.last_run_date == today
        assert reloaded.last_regime == "bull_calm"

        # Step 3: enrich
        raw_dict = build_regime_state_dict(result)
        # result.checked_at より後の時刻にすることで duration_hours >= 0 を保証する
        now = result.checked_at + timedelta(hours=1)
        enriched = enrich_regime_state_dict(raw_dict, reloaded, now)
        assert enriched["regime_state"]["regime_changed_at"] is not None
        assert enriched["regime_state"]["duration_hours"] is not None
        assert enriched["regime_state"]["duration_hours"] >= 0
