"""
Card 2-4 — Recovery Log Writer テスト
atomic write・明示パスのみ・public/data 非参照を担保するテスト群。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from backend.engine.operation.recovery_log_writer import (
    RecoveryLogEntry,
    generate_entry_id,
    build_recovery_entry,
    append_recovery_entry,
    write_recovery_log,
    write_safe_mode_snapshot,
)
from backend.engine.operation.safe_mode import (
    SafeModeInput,
    SafeModeResult,
    SafeModeRestrictions,
    TRIGGER_TIER1_STALE,
)

# ── Fixtures ──────────────────────────────────────────────────────────────────

TZ_JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 4, 28, 7, 0, 0, tzinfo=TZ_JST)

_SM_INPUT_CLEAR = SafeModeInput(
    tier1_data_stale=False,
    tier_a_t3_violated=False,
    crisis_regime=False,
    system_error=False,
)
_SM_INPUT_ACTIVE = SafeModeInput(
    tier1_data_stale=True,
    tier_a_t3_violated=False,
    crisis_regime=False,
    system_error=False,
)
_SM_RESTRICTIONS_CLEAR = SafeModeRestrictions(
    new_buys_frozen=False,
    rebalance_frozen=False,
    force_sell_active=False,
)
_SM_RESTRICTIONS_ACTIVE = SafeModeRestrictions(
    new_buys_frozen=True,
    rebalance_frozen=False,
    force_sell_active=False,
)


def _safe_mode_active() -> SafeModeResult:
    return SafeModeResult(
        active=True,
        trigger_conditions=_SM_INPUT_ACTIVE,
        restrictions=_SM_RESTRICTIONS_ACTIVE,
        trigger_reason=TRIGGER_TIER1_STALE,
        trigger_reason_detail="Tier 1 data stale — freshness exceeded max_age",
        checked_at=NOW,
    )


def _safe_mode_clear() -> SafeModeResult:
    return SafeModeResult(
        active=False,
        trigger_conditions=_SM_INPUT_CLEAR,
        restrictions=_SM_RESTRICTIONS_CLEAR,
        trigger_reason=None,
        trigger_reason_detail=None,
        checked_at=NOW,
    )


def _entry(
    source: str = "news",
    error_type: str = "timeout",
    message: str = "fetch failed",
    action_taken: str = "fallback_to_cache",
    safe_mode_triggered: bool = False,
    entry_id: str = "rec-20260428-001",
) -> RecoveryLogEntry:
    return RecoveryLogEntry(
        id=entry_id,
        occurred_at=NOW,
        resolved_at=None,
        source=source,
        error_type=error_type,
        message=message,
        action_taken=action_taken,
        safe_mode_triggered=safe_mode_triggered,
    )


# ── TestRecoveryLogEntry ──────────────────────────────────────────────────────

class TestRecoveryLogEntry:

    def test_entry_fields_present(self):
        e = _entry()
        assert e.id == "rec-20260428-001"
        assert e.source == "news"
        assert e.error_type == "timeout"
        assert e.message == "fetch failed"
        assert e.action_taken == "fallback_to_cache"
        assert e.safe_mode_triggered is False
        assert e.occurred_at == NOW
        assert e.resolved_at is None

    def test_entry_is_frozen(self):
        e = _entry()
        with pytest.raises((AttributeError, TypeError)):
            e.source = "market"  # type: ignore


# ── TestGenerateEntryId ───────────────────────────────────────────────────────

class TestGenerateEntryId:

    def test_id_format_rec_date_nnn(self):
        entry_id = generate_entry_id(NOW, [])
        assert entry_id == "rec-20260428-001"

    def test_id_starts_at_001_when_no_existing(self):
        entry_id = generate_entry_id(NOW, [])
        assert entry_id.endswith("-001")

    def test_id_increments_with_existing_entries(self):
        existing = [
            _entry(entry_id="rec-20260428-001"),
            _entry(entry_id="rec-20260428-002"),
        ]
        entry_id = generate_entry_id(NOW, existing)
        assert entry_id == "rec-20260428-003"

    def test_id_ignores_entries_from_other_dates(self):
        """他の日付のエントリは無視して 001 から始まる"""
        other_date = datetime(2026, 4, 27, 7, 0, 0, tzinfo=TZ_JST)
        existing = [_entry(entry_id="rec-20260427-005")]
        entry_id = generate_entry_id(NOW, existing)
        assert entry_id == "rec-20260428-001"

    def test_id_three_digit_zero_padding(self):
        existing = [_entry(entry_id=f"rec-20260428-{i:03d}") for i in range(1, 10)]
        entry_id = generate_entry_id(NOW, existing)
        assert entry_id == "rec-20260428-010"


# ── TestBuildRecoveryEntry ────────────────────────────────────────────────────

class TestBuildRecoveryEntry:

    def test_fields_mapped_correctly(self):
        e = build_recovery_entry(
            source="market",
            error_type="http_error",
            message="503 returned",
            action_taken="skip_and_continue",
            occurred_at=NOW,
            resolved_at=None,
            safe_mode_triggered=False,
        )
        assert e.source == "market"
        assert e.error_type == "http_error"
        assert e.message == "503 returned"
        assert e.action_taken == "skip_and_continue"
        assert e.occurred_at == NOW

    def test_safe_mode_triggered_field(self):
        e = build_recovery_entry(
            source="news",
            error_type="timeout",
            message="timeout",
            action_taken="fallback",
            occurred_at=NOW,
            resolved_at=None,
            safe_mode_triggered=True,
        )
        assert e.safe_mode_triggered is True

    def test_resolved_at_optional(self):
        e = build_recovery_entry(
            source="news",
            error_type="timeout",
            message="timeout",
            action_taken="fallback",
            occurred_at=NOW,
            resolved_at=None,
            safe_mode_triggered=False,
        )
        assert e.resolved_at is None

    def test_explicit_entry_id_used_when_provided(self):
        e = build_recovery_entry(
            source="news",
            error_type="timeout",
            message="timeout",
            action_taken="fallback",
            occurred_at=NOW,
            resolved_at=None,
            safe_mode_triggered=False,
            entry_id="rec-20260428-042",
        )
        assert e.id == "rec-20260428-042"

    def test_auto_id_generated_when_none(self):
        e = build_recovery_entry(
            source="news",
            error_type="timeout",
            message="timeout",
            action_taken="fallback",
            occurred_at=NOW,
            resolved_at=None,
            safe_mode_triggered=False,
        )
        assert e.id.startswith("rec-20260428-")


# ── TestAppendEntry ───────────────────────────────────────────────────────────

class TestAppendEntry:

    def test_new_entry_appended(self):
        existing = [_entry(entry_id="rec-20260428-001")]
        new = _entry(entry_id="rec-20260428-002")
        result = append_recovery_entry(existing, new)
        assert len(result) == 2
        assert result[-1].id == "rec-20260428-002"

    def test_existing_list_not_mutated(self):
        existing = [_entry(entry_id="rec-20260428-001")]
        original_len = len(existing)
        new = _entry(entry_id="rec-20260428-002")
        append_recovery_entry(existing, new)
        assert len(existing) == original_len  # unchanged

    def test_returns_new_list(self):
        existing = [_entry(entry_id="rec-20260428-001")]
        new = _entry(entry_id="rec-20260428-002")
        result = append_recovery_entry(existing, new)
        assert result is not existing


# ── TestWriteRecoveryLog ──────────────────────────────────────────────────────

class TestWriteRecoveryLog:

    def test_writes_json_file_at_output_path(self, tmp_path):
        output = tmp_path / "recovery_log.json"
        write_recovery_log([_entry()], output)
        assert output.exists()

    def test_json_has_recovery_log_key(self, tmp_path):
        output = tmp_path / "recovery_log.json"
        write_recovery_log([_entry()], output)
        data = json.loads(output.read_text())
        assert "recovery_log" in data

    def test_json_entries_match_contract_fields(self, tmp_path):
        output = tmp_path / "recovery_log.json"
        e = _entry(source="market", error_type="http_error")
        write_recovery_log([e], output)
        data = json.loads(output.read_text())
        entry = data["recovery_log"][0]
        assert "id" in entry
        assert "occurred_at" in entry
        assert "resolved_at" in entry
        assert "source" in entry
        assert "error_type" in entry
        assert "message" in entry
        assert "action_taken" in entry
        assert "safe_mode_triggered" in entry

    def test_json_entry_source_value_correct(self, tmp_path):
        output = tmp_path / "recovery_log.json"
        write_recovery_log([_entry(source="regime")], output)
        data = json.loads(output.read_text())
        assert data["recovery_log"][0]["source"] == "regime"

    def test_writes_only_to_explicit_path(self, tmp_path):
        """書き込みは指定パスのみ。tmp_path 以外に書かれない"""
        output = tmp_path / "subdir" / "log.json"
        write_recovery_log([_entry()], output)
        # 指定パスが存在し、tmp_path 直下には余分なファイルがない
        assert output.exists()
        extra = [f for f in tmp_path.iterdir() if f.is_file()]
        assert extra == []  # subdir のみ（ファイルは subdir 内）

    def test_meta_not_for_trading_true(self, tmp_path):
        output = tmp_path / "recovery_log.json"
        write_recovery_log([], output)
        data = json.loads(output.read_text())
        assert data["_meta"]["not_for_trading"] is True


# ── TestWriteSafeModeSnapshot ─────────────────────────────────────────────────

class TestWriteSafeModeSnapshot:

    def test_writes_json_at_output_path(self, tmp_path):
        output = tmp_path / "safe_mode.json"
        write_safe_mode_snapshot(_safe_mode_clear(), output)
        assert output.exists()

    def test_json_has_safe_mode_key(self, tmp_path):
        output = tmp_path / "safe_mode.json"
        write_safe_mode_snapshot(_safe_mode_clear(), output)
        data = json.loads(output.read_text())
        assert "safe_mode" in data

    def test_active_field_matches_result(self, tmp_path):
        output = tmp_path / "safe_mode.json"
        write_safe_mode_snapshot(_safe_mode_active(), output)
        data = json.loads(output.read_text())
        assert data["safe_mode"]["active"] is True

    def test_inactive_active_field_false(self, tmp_path):
        output = tmp_path / "safe_mode.json"
        write_safe_mode_snapshot(_safe_mode_clear(), output)
        data = json.loads(output.read_text())
        assert data["safe_mode"]["active"] is False

    def test_trigger_conditions_serialized(self, tmp_path):
        output = tmp_path / "safe_mode.json"
        write_safe_mode_snapshot(_safe_mode_active(), output)
        data = json.loads(output.read_text())
        tc = data["safe_mode"]["trigger_conditions"]
        assert "tier1_data_stale" in tc
        assert "tier_a_t3_violated" in tc
        assert "crisis_regime" in tc
        assert "system_error" in tc

    def test_triggered_at_passthrough(self, tmp_path):
        output = tmp_path / "safe_mode.json"
        triggered = NOW - timedelta(minutes=5)
        write_safe_mode_snapshot(_safe_mode_active(), output, triggered_at=triggered)
        data = json.loads(output.read_text())
        assert data["safe_mode"]["triggered_at"] == triggered.isoformat()

    def test_estimated_resume_at_passthrough(self, tmp_path):
        output = tmp_path / "safe_mode.json"
        resume = NOW + timedelta(hours=1)
        write_safe_mode_snapshot(_safe_mode_active(), output, estimated_resume_at=resume)
        data = json.loads(output.read_text())
        assert data["safe_mode"]["estimated_resume_at"] == resume.isoformat()

    def test_triggered_at_none_when_not_provided(self, tmp_path):
        output = tmp_path / "safe_mode.json"
        write_safe_mode_snapshot(_safe_mode_clear(), output)
        data = json.loads(output.read_text())
        assert data["safe_mode"]["triggered_at"] is None

    def test_last_checked_matches_result_checked_at(self, tmp_path):
        output = tmp_path / "safe_mode.json"
        write_safe_mode_snapshot(_safe_mode_clear(), output)
        data = json.loads(output.read_text())
        assert data["safe_mode"]["last_checked"] == NOW.isoformat()

    def test_meta_not_for_trading_true(self, tmp_path):
        output = tmp_path / "safe_mode.json"
        write_safe_mode_snapshot(_safe_mode_clear(), output)
        data = json.loads(output.read_text())
        assert data["_meta"]["not_for_trading"] is True


# ── TestDetectionOnly ─────────────────────────────────────────────────────────

class TestDetectionOnly:

    def test_entry_has_no_execute_field(self):
        e = _entry()
        assert not hasattr(e, "execute")

    def test_entry_has_no_trade_field(self):
        e = _entry()
        assert not hasattr(e, "trade")

    def test_entry_has_no_order_field(self):
        e = _entry()
        assert not hasattr(e, "order")
