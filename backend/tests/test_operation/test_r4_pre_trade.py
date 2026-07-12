"""
Card 2-6 — R4 Pre-Trade Routine テスト
pre_trade_ready フラグ・通知閾値・書き込み安全条件を担保するテスト群。
P4-A20: _cli_main / _read_json_timestamp のテストを追加。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

from backend.engine.operation.r4_pre_trade import (
    PreTradeRoutineResult,
    _cli_main,
    _read_json_timestamp,
    run_pre_trade_routine,
)
from backend.engine.operation.discord_notifier import DiscordNotifierConfig
from backend.engine.operation.watchdog import SourceEvent

# ── Fixtures ──────────────────────────────────────────────────────────────────

TZ_JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 4, 29, 8, 45, 0, tzinfo=TZ_JST)


def _fresh_timestamps() -> dict:
    return {
        "market": NOW - timedelta(minutes=10),
        "regime": NOW - timedelta(minutes=10),
        "news":   NOW - timedelta(minutes=10),
    }


def _stale_tier1() -> dict:
    return {
        "market": NOW - timedelta(hours=2),
        "regime": NOW - timedelta(hours=2),
        "news":   NOW - timedelta(hours=2),
    }


def _fail_event(source: str, minutes_ago: float) -> SourceEvent:
    return SourceEvent(
        source=source,
        timestamp=NOW - timedelta(minutes=minutes_ago),
        success=False,
        error_type="timeout",
    )


def _three_failures(source: str) -> list[SourceEvent]:
    return [_fail_event(source, 15), _fail_event(source, 10), _fail_event(source, 5)]


def _dry_run_config() -> DiscordNotifierConfig:
    return DiscordNotifierConfig(webhook_url="https://example.com/hook", dry_run=True)


# ── TestPreTradeRoutineResult ─────────────────────────────────────────────────

class TestPreTradeRoutineResult:

    def test_result_fields_present(self):
        result = run_pre_trade_routine(_fresh_timestamps(), [], now=NOW)
        assert hasattr(result, "freshness")
        assert hasattr(result, "watchdog")
        assert hasattr(result, "safe_mode")
        assert hasattr(result, "notify_result")
        assert hasattr(result, "recovery_entry")
        assert hasattr(result, "safe_mode_written")
        assert hasattr(result, "recovery_log_written")
        assert hasattr(result, "pre_trade_ready")
        assert hasattr(result, "completed_at")

    def test_result_has_no_trade_field(self):
        result = run_pre_trade_routine(_fresh_timestamps(), [], now=NOW)
        assert not hasattr(result, "trade")


# ── TestPreTradeReady ─────────────────────────────────────────────────────────

class TestPreTradeReady:

    def test_ready_when_healthy(self):
        result = run_pre_trade_routine(_fresh_timestamps(), [], now=NOW)
        assert result.pre_trade_ready is True

    def test_not_ready_when_system_error(self):
        events = _three_failures("market")
        result = run_pre_trade_routine(_fresh_timestamps(), events, now=NOW)
        assert result.pre_trade_ready is False

    def test_not_ready_when_safe_mode_active(self):
        result = run_pre_trade_routine(_stale_tier1(), [], now=NOW)
        assert result.pre_trade_ready is False

    def test_sq_days_until_does_not_affect_readiness(self):
        result = run_pre_trade_routine(_fresh_timestamps(), [], sq_days_until=3, now=NOW)
        assert result.pre_trade_ready is True


# ── TestNotification ──────────────────────────────────────────────────────────

class TestNotification:

    def test_system_error_triggers_notify(self):
        events = _three_failures("market")
        result = run_pre_trade_routine(
            _fresh_timestamps(), events,
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is not None

    def test_safe_mode_active_triggers_notify(self):
        result = run_pre_trade_routine(
            _stale_tier1(), [],
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is not None

    def test_healthy_no_notification(self):
        result = run_pre_trade_routine(
            _fresh_timestamps(), [],
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is None

    def test_dry_run_no_http_call(self):
        events = _three_failures("market")
        with patch("backend.engine.operation.discord_notifier._http_post") as mock_post:
            run_pre_trade_routine(
                _fresh_timestamps(), events,
                notifier_config=_dry_run_config(),
                now=NOW,
            )
            mock_post.assert_not_called()


# ── TestRecoveryLog ───────────────────────────────────────────────────────────

class TestRecoveryLog:

    def test_recovery_entry_created_on_system_error(self):
        events = _three_failures("market")
        result = run_pre_trade_routine(_fresh_timestamps(), events, now=NOW)
        assert result.recovery_entry is not None
        assert result.recovery_entry.source == "market"

    def test_no_recovery_log_path_no_write(self):
        events = _three_failures("market")
        result = run_pre_trade_routine(_fresh_timestamps(), events, now=NOW)
        assert result.recovery_log_written is False


# ── TestReadJsonTimestamp (P4-A20) ────────────────────────────────────────────

class TestReadJsonTimestamp:

    def test_reads_top_level_key(self, tmp_path):
        f = tmp_path / "market.json"
        f.write_text(json.dumps({"last_updated": "2026-06-11T15:00:00+09:00"}))
        result = _read_json_timestamp(f, "last_updated")
        assert result is not None
        assert result.year == 2026

    def test_reads_nested_key(self, tmp_path):
        f = tmp_path / "regime_state.json"
        f.write_text(json.dumps({"_meta": {"generatedAt": "2026-06-14T22:27:19+00:00"}}))
        result = _read_json_timestamp(f, "_meta", "generatedAt")
        assert result is not None
        assert result.year == 2026

    def test_space_separated_datetime_parsed(self, tmp_path):
        # market.json uses "2026-06-11 15:00" format (space not T)
        f = tmp_path / "market.json"
        f.write_text(json.dumps({"last_updated": "2026-06-11 15:00"}))
        result = _read_json_timestamp(f, "last_updated")
        assert result is not None
        assert result.hour == 15
        # naive datetime assumed JST (UTC+9)
        assert result.utcoffset() == timedelta(hours=9)

    def test_missing_file_returns_none(self, tmp_path):
        result = _read_json_timestamp(tmp_path / "nonexistent.json", "key")
        assert result is None

    def test_missing_key_returns_none(self, tmp_path):
        f = tmp_path / "data.json"
        f.write_text(json.dumps({"other_key": "value"}))
        result = _read_json_timestamp(f, "last_updated")
        assert result is None

    def test_empty_value_returns_none(self, tmp_path):
        f = tmp_path / "data.json"
        f.write_text(json.dumps({"last_updated": ""}))
        result = _read_json_timestamp(f, "last_updated")
        assert result is None

    def test_malformed_json_returns_none(self, tmp_path):
        f = tmp_path / "data.json"
        f.write_text("not valid json {{{")
        result = _read_json_timestamp(f, "key")
        assert result is None


# ── TestCLIEntrypoint (P4-A20) ───────────────────────────────────────────────

class TestCLIEntrypoint:
    """CLI entrypoint (_cli_main) の挙動確認。P4-A20 追加。"""

    def test_dry_run_no_file_written(self, tmp_path, capsys):
        # empty data_dir → timestamps None → safe_mode active → exit 1
        with pytest.raises(SystemExit):
            _cli_main(["--dry-run", "--data-dir", str(tmp_path)])
        captured = capsys.readouterr()
        assert "dry-run mode: no files written" in captured.out
        # no JSON files created in tmp_path
        assert not list(tmp_path.glob("*.json"))

    def test_output_writes_json_when_not_dry_run(self, tmp_path, capsys):
        output_path = tmp_path / "safe_mode.json"
        with pytest.raises(SystemExit):
            _cli_main(["--output", str(output_path), "--data-dir", str(tmp_path)])
        assert output_path.exists()
        data = json.loads(output_path.read_text())
        assert "safe_mode" in data
        assert isinstance(data["safe_mode"]["active"], bool)

    def test_dry_run_suppresses_output_write(self, tmp_path, capsys):
        output_path = tmp_path / "safe_mode.json"
        with pytest.raises(SystemExit):
            _cli_main(["--dry-run", "--output", str(output_path), "--data-dir", str(tmp_path)])
        # --dry-run takes precedence: file must NOT be written
        assert not output_path.exists()
        captured = capsys.readouterr()
        assert "dry-run mode: no files written" in captured.out

    def test_missing_timestamps_activate_safe_mode_exit1(self, tmp_path, capsys):
        # Empty data_dir → all timestamps None → tier1 stale → safe_mode.active=True → exit 1
        with pytest.raises(SystemExit) as exc_info:
            _cli_main(["--dry-run", "--data-dir", str(tmp_path)])
        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        assert "safe_mode.active=True" in captured.out

    def test_stdout_contains_required_fields(self, tmp_path, capsys):
        with pytest.raises(SystemExit):
            _cli_main(["--dry-run", "--data-dir", str(tmp_path)])
        captured = capsys.readouterr()
        for field in [
            "checked_at=",
            "safe_mode.active=",
            "trigger_reason=",
            "new_buys_frozen=",
            "pre_trade_ready=",
        ]:
            assert field in captured.out, f"missing expected field in stdout: {field}"

    def test_no_output_flag_prints_not_written(self, tmp_path, capsys):
        with pytest.raises(SystemExit):
            _cli_main(["--data-dir", str(tmp_path)])
        captured = capsys.readouterr()
        assert "--output not specified: JSON not written" in captured.out
