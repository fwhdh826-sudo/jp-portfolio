"""
Card 2-2 — Watchdog テスト
Detection-only であることを担保するテスト群。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from backend.engine.operation.watchdog import (
    CONSECUTIVE_FAILURE_THRESHOLD,
    DEFAULT_SAFE_MODE_SOURCES,
    STATUS_HEALTHY,
    STATUS_DEGRADED,
    STATUS_CRITICAL,
    SourceEvent,
    SourceWatchResult,
    WatchdogResult,
    evaluate_source,
    evaluate_watchdog,
)

# ── Helpers ──────────────────────────────────────────────────────────────────

TZ_JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 4, 28, 7, 0, 0, tzinfo=TZ_JST)


def _evt(source: str, minutes_ago: float, success: bool, error_type: str = None) -> SourceEvent:
    ts = NOW - timedelta(minutes=minutes_ago)
    return SourceEvent(source=source, timestamp=ts, success=success, error_type=error_type)


def _ok(source: str, minutes_ago: float) -> SourceEvent:
    return _evt(source, minutes_ago, success=True)


def _fail(source: str, minutes_ago: float, error_type: str = "timeout") -> SourceEvent:
    return _evt(source, minutes_ago, success=False, error_type=error_type)


# ── Constants sanity ─────────────────────────────────────────────────────────

class TestConstants:

    def test_failure_threshold_is_3(self):
        assert CONSECUTIVE_FAILURE_THRESHOLD == 3

    def test_status_values(self):
        assert STATUS_HEALTHY == "healthy"
        assert STATUS_DEGRADED == "degraded"
        assert STATUS_CRITICAL == "critical"


# ── TestDefaultSafeModeSourcesConstant ───────────────────────────────────────

class TestDefaultSafeModeSourcesConstant:

    def test_default_safe_mode_sources_contains_market_regime_news(self):
        assert DEFAULT_SAFE_MODE_SOURCES == {"market", "regime", "news"}

    def test_default_safe_mode_sources_is_frozenset(self):
        assert isinstance(DEFAULT_SAFE_MODE_SOURCES, frozenset)


# ── evaluate_source — healthy ────────────────────────────────────────────────

class TestSourceHealthy:

    def test_no_events_is_healthy(self):
        result = evaluate_source("market", [], now=NOW)
        assert result.status == STATUS_HEALTHY
        assert result.consecutive_failures == 0
        assert result.alert_threshold_reached is False

    def test_single_success_is_healthy(self):
        result = evaluate_source("market", [_ok("market", 5)], now=NOW)
        assert result.status == STATUS_HEALTHY
        assert result.consecutive_failures == 0

    def test_multiple_successes_healthy(self):
        events = [_ok("news", 30), _ok("news", 20), _ok("news", 10)]
        result = evaluate_source("news", events, now=NOW)
        assert result.status == STATUS_HEALTHY
        assert result.consecutive_failures == 0

    def test_last_success_at_populated(self):
        ts = NOW - timedelta(minutes=5)
        evt = SourceEvent(source="market", timestamp=ts, success=True)
        result = evaluate_source("market", [evt], now=NOW)
        assert result.last_success_at == ts

    def test_last_failure_at_none_when_all_success(self):
        result = evaluate_source("market", [_ok("market", 10)], now=NOW)
        assert result.last_failure_at is None


# ── evaluate_source — degraded ────────────────────────────────────────────────

class TestSourceDegraded:

    def test_one_failure_is_degraded(self):
        result = evaluate_source("market", [_fail("market", 5)], now=NOW)
        assert result.status == STATUS_DEGRADED
        assert result.consecutive_failures == 1
        assert result.alert_threshold_reached is False

    def test_two_failures_is_degraded(self):
        events = [_fail("market", 10), _fail("market", 5)]
        result = evaluate_source("market", events, now=NOW)
        assert result.status == STATUS_DEGRADED
        assert result.consecutive_failures == 2
        assert result.alert_threshold_reached is False

    def test_last_failure_at_populated(self):
        ts = NOW - timedelta(minutes=3)
        evt = SourceEvent(source="market", timestamp=ts, success=False)
        result = evaluate_source("market", [evt], now=NOW)
        assert result.last_failure_at == ts


# ── evaluate_source — critical ────────────────────────────────────────────────

class TestSourceCritical:

    def test_three_consecutive_failures_is_critical(self):
        events = [_fail("market", 15), _fail("market", 10), _fail("market", 5)]
        result = evaluate_source("market", events, now=NOW)
        assert result.status == STATUS_CRITICAL
        assert result.consecutive_failures == 3
        assert result.alert_threshold_reached is True

    def test_four_failures_is_critical(self):
        events = [_fail("m", 20), _fail("m", 15), _fail("m", 10), _fail("m", 5)]
        result = evaluate_source("m", events, now=NOW)
        assert result.status == STATUS_CRITICAL
        assert result.consecutive_failures == 4

    def test_boundary_exactly_threshold_is_critical(self):
        """consecutive == CONSECUTIVE_FAILURE_THRESHOLD → critical（境界値）"""
        events = [_fail("news", i * 5) for i in range(CONSECUTIVE_FAILURE_THRESHOLD, 0, -1)]
        result = evaluate_source("news", events, now=NOW)
        assert result.status == STATUS_CRITICAL
        assert result.consecutive_failures == CONSECUTIVE_FAILURE_THRESHOLD


# ── evaluate_source — reset on success ───────────────────────────────────────

class TestSourceReset:

    def test_success_after_three_failures_resets_to_healthy(self):
        events = [
            _fail("market", 20),
            _fail("market", 15),
            _fail("market", 10),
            _ok("market", 5),
        ]
        result = evaluate_source("market", events, now=NOW)
        assert result.status == STATUS_HEALTHY
        assert result.consecutive_failures == 0
        assert result.alert_threshold_reached is False

    def test_failure_after_success_resets_count(self):
        """成功→失敗×2 → degraded（失敗カウントは成功でリセットされる）"""
        events = [
            _fail("market", 30),
            _fail("market", 25),
            _fail("market", 20),
            _ok("market", 15),   # reset
            _fail("market", 10),
            _fail("market", 5),
        ]
        result = evaluate_source("market", events, now=NOW)
        assert result.status == STATUS_DEGRADED
        assert result.consecutive_failures == 2

    def test_chronological_order_respected(self):
        """順序が逆でも timestamp でソートして正しく処理する"""
        events = [
            _fail("market", 5),   # 最新が先
            _ok("market", 10),    # 古い成功
        ]
        result = evaluate_source("market", events, now=NOW)
        # 時刻順: ok(10 min ago) → fail(5 min ago) → consecutive=1 (degraded)
        assert result.status == STATUS_DEGRADED
        assert result.consecutive_failures == 1


# ── evaluate_watchdog ─────────────────────────────────────────────────────────

class TestWatchdog:

    def test_empty_events_returns_empty_sources(self):
        result = evaluate_watchdog([], now=NOW)
        assert result.sources == {}
        assert result.any_critical is False
        assert result.system_error is False

    def test_single_source_healthy(self):
        events = [_ok("market", 10)]
        result = evaluate_watchdog(events, now=NOW)
        assert "market" in result.sources
        assert result.sources["market"].status == STATUS_HEALTHY
        assert result.any_critical is False
        assert result.system_error is False

    def test_single_source_critical_sets_system_error(self):
        events = [_fail("market", 15), _fail("market", 10), _fail("market", 5)]
        result = evaluate_watchdog(events, now=NOW)
        assert result.sources["market"].status == STATUS_CRITICAL
        assert result.any_critical is True
        assert result.system_error is True

    def test_multiple_sources_tracked_independently(self):
        events = [
            _ok("market", 10),
            _ok("market", 5),
            _fail("news", 15),
            _fail("news", 10),
            _fail("news", 5),
        ]
        result = evaluate_watchdog(events, now=NOW)
        assert result.sources["market"].status == STATUS_HEALTHY
        assert result.sources["news"].status == STATUS_CRITICAL
        assert result.any_critical is True

    def test_all_sources_healthy_no_system_error(self):
        events = [
            _ok("market", 10),
            _ok("news", 10),
            _ok("regime", 10),
        ]
        result = evaluate_watchdog(events, now=NOW)
        assert result.any_critical is False
        assert result.system_error is False

    def test_degraded_source_does_not_set_system_error(self):
        events = [_fail("market", 10), _fail("market", 5)]
        result = evaluate_watchdog(events, now=NOW)
        assert result.sources["market"].status == STATUS_DEGRADED
        assert result.any_critical is False
        assert result.system_error is False

    def test_checked_at_equals_now(self):
        result = evaluate_watchdog([], now=NOW)
        assert result.checked_at == NOW


# ── TestSystemError ───────────────────────────────────────────────────────────

class TestSystemError:
    """system_error は DEFAULT_SAFE_MODE_SOURCES の critical のみに連動する"""

    def test_tier1_source_critical_sets_system_error(self):
        """market (Tier 1) が critical → system_error=True"""
        events = [_fail("market", 15), _fail("market", 10), _fail("market", 5)]
        result = evaluate_watchdog(events, now=NOW)
        assert result.system_error is True

    def test_tier3_source_critical_does_not_set_system_error(self):
        """correlation (Tier 3) が critical → system_error=False (default sources)"""
        events = [_fail("correlation", 15), _fail("correlation", 10), _fail("correlation", 5)]
        result = evaluate_watchdog(events, now=NOW)
        assert result.any_critical is True
        assert result.system_error is False

    def test_custom_safe_mode_sources(self):
        """custom safe_mode_sources で system_error スコープを制御できる"""
        events = [
            _fail("correlation", 15), _fail("correlation", 10), _fail("correlation", 5),
            _ok("market", 5),
        ]
        result = evaluate_watchdog(
            events,
            safe_mode_sources=frozenset({"correlation"}),
            now=NOW,
        )
        assert result.system_error is True

    def test_any_critical_can_be_true_while_system_error_false(self):
        """Tier 3 のみが critical の場合: any_critical=True, system_error=False"""
        events = [_fail("trust", 15), _fail("trust", 10), _fail("trust", 5)]
        result = evaluate_watchdog(events, now=NOW)
        assert result.any_critical is True
        assert result.system_error is False


# ── Detection-only ────────────────────────────────────────────────────────────

class TestDetectionOnly:

    def test_watchdog_result_has_no_order_field(self):
        result = evaluate_watchdog([], now=NOW)
        assert not hasattr(result, "order")
        assert not hasattr(result, "action")
        assert not hasattr(result, "notification")

    def test_source_watch_result_has_no_notify_field(self):
        events = [_fail("market", 5)]
        result = evaluate_watchdog(events, now=NOW)
        assert not hasattr(result.sources["market"], "notify")
        assert not hasattr(result.sources["market"], "send_alert")
