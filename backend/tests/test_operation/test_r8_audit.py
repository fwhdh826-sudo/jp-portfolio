"""
Card 2-7 — R8 Audit Routine テスト
横断監査・Tier A optional 統合・通知閾値・書き込み安全条件を担保するテスト群。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from backend.engine.operation.r8_audit import (
    AuditRoutineResult,
    run_audit_routine,
)
from backend.engine.operation.discord_notifier import DiscordNotifierConfig
from backend.engine.operation.watchdog import SourceEvent
from backend.engine.tier_a.tier_a_hard_gate import (
    PortfolioInput,
    MarketInput,
    evaluate_hard_gate,
)
from backend.engine.tier_a.tier_a_soft_penalty import (
    SoftPortfolioInput,
    SoftAssetInput,
    evaluate_soft_penalty,
)

# ── Fixtures ──────────────────────────────────────────────────────────────────

TZ_JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 4, 29, 9, 0, 0, tzinfo=TZ_JST)


def _fresh_timestamps() -> dict:
    return {
        "market":      NOW - timedelta(minutes=10),
        "regime":      NOW - timedelta(minutes=10),
        "news":        NOW - timedelta(minutes=10),
        "scoring":     NOW - timedelta(minutes=30),
        "strategy":    NOW - timedelta(minutes=30),
        "macro":       NOW - timedelta(hours=2),
        "correlation": NOW - timedelta(hours=12),
        "trust":       NOW - timedelta(hours=12),
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


def _t3_hard_gate():
    """T3: PF drawdown -32% → hard_gate.any_triggered=True"""
    portfolio = PortfolioInput(positions=[], drawdown=-0.32)
    market = MarketInput(vix=20.0, nikkei_daily_returns=[0.01, 0.01, 0.01], is_capitulation_signal=False)
    return evaluate_hard_gate(portfolio, market)


def _severe_soft_penalty():
    """T6 severe: leveraged ratio > 25%"""
    assets = [
        SoftAssetInput(ticker="lev", is_core=False, is_leveraged=True, is_cash=False, weight=0.30, v3_target_weight=0.30),
        SoftAssetInput(ticker="cash", is_core=False, is_leveraged=False, is_cash=True, weight=0.10, v3_target_weight=0.10),
        SoftAssetInput(ticker="core", is_core=True, is_leveraged=False, is_cash=False, weight=0.60, v3_target_weight=0.60),
    ]
    return evaluate_soft_penalty(SoftPortfolioInput(assets=assets))


def _dry_run_config() -> DiscordNotifierConfig:
    return DiscordNotifierConfig(webhook_url="https://example.com/hook", dry_run=True)


# ── TestAuditRoutineResult ────────────────────────────────────────────────────

class TestAuditRoutineResult:

    def test_result_fields_present(self):
        result = run_audit_routine(_fresh_timestamps(), [], now=NOW)
        assert hasattr(result, "freshness")
        assert hasattr(result, "watchdog")
        assert hasattr(result, "safe_mode")
        assert hasattr(result, "hard_gate")
        assert hasattr(result, "soft_penalty")
        assert hasattr(result, "audit_issues")
        assert hasattr(result, "any_issue")
        assert hasattr(result, "notify_result")
        assert hasattr(result, "recovery_entry")
        assert hasattr(result, "safe_mode_written")
        assert hasattr(result, "recovery_log_written")
        assert hasattr(result, "completed_at")

    def test_hard_gate_none_when_not_provided(self):
        result = run_audit_routine(_fresh_timestamps(), [], now=NOW)
        assert result.hard_gate is None
        assert result.soft_penalty is None


# ── TestHealthyPath ───────────────────────────────────────────────────────────

class TestHealthyPath:

    def test_healthy_no_issues(self):
        result = run_audit_routine(_fresh_timestamps(), [], now=NOW)
        assert result.any_issue is False
        assert result.audit_issues == []

    def test_healthy_no_notification(self):
        result = run_audit_routine(
            _fresh_timestamps(), [],
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is None


# ── TestIssueDetection ────────────────────────────────────────────────────────

class TestIssueDetection:

    def test_stale_data_creates_issue(self):
        result = run_audit_routine(_stale_tier1(), [], now=NOW)
        assert result.any_issue is True
        assert any("Stale" in issue for issue in result.audit_issues)

    def test_watchdog_failure_creates_issue(self):
        result = run_audit_routine(
            _fresh_timestamps(), _three_failures("market"), now=NOW
        )
        assert result.any_issue is True
        assert any("critical" in issue.lower() for issue in result.audit_issues)

    def test_hard_gate_violation_creates_issue(self):
        result = run_audit_routine(
            _fresh_timestamps(), [],
            hard_gate_result=_t3_hard_gate(),
            now=NOW,
        )
        assert result.any_issue is True
        assert any("hard gate" in issue.lower() for issue in result.audit_issues)

    def test_any_issue_triggers_notify(self):
        result = run_audit_routine(
            _stale_tier1(), [],
            notifier_config=_dry_run_config(),
            now=NOW,
        )
        assert result.notify_result is not None


# ── TestWritePaths ────────────────────────────────────────────────────────────

class TestWritePaths:

    def test_safe_mode_written_when_path_provided(self, tmp_path):
        out = tmp_path / "safe_mode.json"
        result = run_audit_routine(
            _stale_tier1(), [],
            safe_mode_output_path=out,
            now=NOW,
        )
        assert result.safe_mode_written is True
        assert out.exists()

    def test_no_recovery_log_path_no_write(self):
        result = run_audit_routine(
            _stale_tier1(), [], now=NOW
        )
        assert result.recovery_log_written is False

    def test_dry_run_no_http_call(self):
        with patch("backend.engine.operation.discord_notifier._http_post") as mock_post:
            run_audit_routine(
                _stale_tier1(), [],
                notifier_config=_dry_run_config(),
                now=NOW,
            )
            mock_post.assert_not_called()
