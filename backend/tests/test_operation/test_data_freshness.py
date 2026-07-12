"""
Card 2-1 — Data Freshness テスト
Detection-only であることを担保するテスト群。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

import pytest

from backend.engine.operation.data_freshness import (
    TIER_1,
    TIER_2,
    TIER_3,
    STATUS_LOADED,
    STATUS_STALE,
    STATUS_MISSING,
    SourceConfig,
    SourceFreshnessResult,
    FreshnessResult,
    DEFAULT_SOURCE_CONFIGS,
    check_source_freshness,
    evaluate_freshness,
)

# ── Helpers ──────────────────────────────────────────────────────────────────

TZ_JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 4, 26, 7, 0, 0, tzinfo=TZ_JST)

def _ts(minutes_ago: float, now: datetime = NOW) -> datetime:
    return now - timedelta(minutes=minutes_ago)

def _cfg(name: str, tier: int, max_age: int) -> SourceConfig:
    return SourceConfig(name=name, tier=tier, max_age_minutes=max_age)


# ── check_source_freshness ────────────────────────────────────────────────────

class TestCheckSourceFreshness:

    def test_fresh_within_max_age(self):
        cfg = _cfg("market", TIER_1, 30)
        result = check_source_freshness(cfg, _ts(20), NOW)
        assert result.is_stale is False
        assert result.status == STATUS_LOADED
        assert result.age_minutes == pytest.approx(20.0)

    def test_stale_exceeds_max_age(self):
        cfg = _cfg("market", TIER_1, 30)
        result = check_source_freshness(cfg, _ts(31), NOW)
        assert result.is_stale is True
        assert result.status == STATUS_STALE

    def test_boundary_equal_to_max_age_is_not_stale(self):
        """age == max_age_minutes → is_stale=False (境界は OK)"""
        cfg = _cfg("market", TIER_1, 30)
        result = check_source_freshness(cfg, _ts(30), NOW)
        assert result.is_stale is False
        assert result.status == STATUS_LOADED

    def test_boundary_one_minute_over_is_stale(self):
        cfg = _cfg("market", TIER_1, 30)
        result = check_source_freshness(cfg, _ts(30.0001), NOW)
        assert result.is_stale is True

    def test_missing_timestamp_returns_status_missing(self):
        cfg = _cfg("market", TIER_1, 30)
        result = check_source_freshness(cfg, None, NOW)
        assert result.is_stale is True
        assert result.status == STATUS_MISSING
        assert result.age_minutes is None
        assert result.last_updated_at is None

    def test_tier_is_propagated(self):
        cfg = _cfg("scoring", TIER_2, 240)
        result = check_source_freshness(cfg, _ts(100), NOW)
        assert result.tier == TIER_2

    def test_max_age_minutes_is_propagated(self):
        cfg = _cfg("correlation", TIER_3, 1440)
        result = check_source_freshness(cfg, _ts(700), NOW)
        assert result.max_age_minutes == 1440

    def test_age_minutes_calculated_correctly(self):
        cfg = _cfg("news", TIER_1, 30)
        result = check_source_freshness(cfg, _ts(15.5), NOW)
        assert result.age_minutes == pytest.approx(15.5, abs=0.01)


# ── evaluate_freshness — Tier 1 ───────────────────────────────────────────────

class TestTier1:
    BASE_TS: dict = {
        "market": _ts(20),
        "regime": _ts(30),
        "news":   _ts(25),
        "scoring":     _ts(60),
        "strategy":    _ts(60),
        "macro":       _ts(120),
        "correlation": _ts(600),
        "trust":       _ts(720),
    }

    def test_all_fresh_tier1_not_stale(self):
        result = evaluate_freshness(self.BASE_TS, now=NOW)
        assert result.any_tier1_stale is False
        assert result.safe_mode_triggered is False

    def test_market_stale_triggers_tier1(self):
        ts = {**self.BASE_TS, "market": _ts(31)}
        result = evaluate_freshness(ts, now=NOW)
        assert result.any_tier1_stale is True
        assert result.sources["market"].is_stale is True

    def test_regime_stale_triggers_tier1(self):
        ts = {**self.BASE_TS, "regime": _ts(61)}
        result = evaluate_freshness(ts, now=NOW)
        assert result.any_tier1_stale is True

    def test_news_stale_triggers_tier1(self):
        ts = {**self.BASE_TS, "news": _ts(31)}
        result = evaluate_freshness(ts, now=NOW)
        assert result.any_tier1_stale is True


# ── evaluate_freshness — Tier 2 ───────────────────────────────────────────────

class TestTier2:
    BASE_TS: dict = {
        "market": _ts(10),
        "regime": _ts(20),
        "news":   _ts(15),
        "scoring":     _ts(60),
        "strategy":    _ts(60),
        "macro":       _ts(120),
        "correlation": _ts(600),
        "trust":       _ts(720),
    }

    def test_scoring_stale_sets_any_tier2_stale(self):
        ts = {**self.BASE_TS, "scoring": _ts(241)}
        result = evaluate_freshness(ts, now=NOW)
        assert result.any_tier2_stale is True
        assert result.sources["scoring"].is_stale is True

    def test_strategy_stale_sets_any_tier2_stale(self):
        ts = {**self.BASE_TS, "strategy": _ts(241)}
        result = evaluate_freshness(ts, now=NOW)
        assert result.any_tier2_stale is True

    def test_macro_stale_sets_any_tier2_stale(self):
        ts = {**self.BASE_TS, "macro": _ts(481)}
        result = evaluate_freshness(ts, now=NOW)
        assert result.any_tier2_stale is True

    def test_tier2_stale_does_not_trigger_safe_mode(self):
        ts = {**self.BASE_TS, "scoring": _ts(300)}
        result = evaluate_freshness(ts, now=NOW)
        assert result.any_tier2_stale is True
        assert result.safe_mode_triggered is False

    def test_tier2_all_fresh(self):
        result = evaluate_freshness(self.BASE_TS, now=NOW)
        assert result.any_tier2_stale is False


# ── evaluate_freshness — Tier 3 ───────────────────────────────────────────────

class TestTier3:
    BASE_TS: dict = {
        "market": _ts(10),
        "regime": _ts(20),
        "news":   _ts(15),
        "scoring":     _ts(60),
        "strategy":    _ts(60),
        "macro":       _ts(120),
        "correlation": _ts(600),
        "trust":       _ts(720),
    }

    def test_correlation_stale_does_not_affect_tier1_or_tier2_flags(self):
        ts = {**self.BASE_TS, "correlation": _ts(1441)}
        result = evaluate_freshness(ts, now=NOW)
        assert result.sources["correlation"].is_stale is True
        assert result.any_tier1_stale is False
        assert result.any_tier2_stale is False
        assert result.safe_mode_triggered is False

    def test_trust_stale_informational_only(self):
        ts = {**self.BASE_TS, "trust": _ts(1441)}
        result = evaluate_freshness(ts, now=NOW)
        assert result.sources["trust"].is_stale is True
        assert result.safe_mode_triggered is False

    def test_tier3_boundary_1440_not_stale(self):
        ts = {**self.BASE_TS, "correlation": _ts(1440)}
        result = evaluate_freshness(ts, now=NOW)
        assert result.sources["correlation"].is_stale is False


# ── safe_mode_triggered ───────────────────────────────────────────────────────

class TestSafeMode:
    BASE_TS: dict = {
        "market": _ts(10),
        "regime": _ts(20),
        "news":   _ts(15),
        "scoring":     _ts(60),
        "strategy":    _ts(60),
        "macro":       _ts(120),
        "correlation": _ts(600),
        "trust":       _ts(720),
    }

    def test_safe_mode_false_when_all_fresh(self):
        result = evaluate_freshness(self.BASE_TS, now=NOW)
        assert result.safe_mode_triggered is False

    def test_safe_mode_true_when_tier1_stale(self):
        ts = {**self.BASE_TS, "market": _ts(31)}
        result = evaluate_freshness(ts, now=NOW)
        assert result.safe_mode_triggered is True

    def test_safe_mode_false_when_only_tier2_stale(self):
        ts = {**self.BASE_TS, "scoring": _ts(300), "strategy": _ts(300)}
        result = evaluate_freshness(ts, now=NOW)
        assert result.safe_mode_triggered is False

    def test_safe_mode_false_when_only_tier3_stale(self):
        ts = {**self.BASE_TS, "correlation": _ts(1500), "trust": _ts(1500)}
        result = evaluate_freshness(ts, now=NOW)
        assert result.safe_mode_triggered is False

    def test_safe_mode_true_when_tier1_missing(self):
        ts = {**self.BASE_TS, "market": None}
        result = evaluate_freshness(ts, now=NOW)
        assert result.safe_mode_triggered is True


# ── Missing timestamps ────────────────────────────────────────────────────────

class TestMissingTimestamps:

    def test_missing_tier1_source_is_stale(self):
        ts = {"market": None, "regime": _ts(10), "news": _ts(10),
              "scoring": _ts(60), "strategy": _ts(60), "macro": _ts(120),
              "correlation": _ts(600), "trust": _ts(720)}
        result = evaluate_freshness(ts, now=NOW)
        assert result.sources["market"].status == STATUS_MISSING
        assert result.sources["market"].is_stale is True

    def test_absent_key_treated_as_missing(self):
        ts = {"regime": _ts(10), "news": _ts(10),
              "scoring": _ts(60), "strategy": _ts(60), "macro": _ts(120),
              "correlation": _ts(600), "trust": _ts(720)}
        # "market" not in ts at all
        result = evaluate_freshness(ts, now=NOW)
        assert result.sources["market"].status == STATUS_MISSING
        assert result.any_tier1_stale is True

    def test_all_missing_triggers_safe_mode(self):
        result = evaluate_freshness({}, now=NOW)
        assert result.safe_mode_triggered is True
        assert result.any_tier1_stale is True


# ── FreshnessResult structure (detection-only) ────────────────────────────────

class TestDetectionOnly:

    def test_freshness_result_has_no_order_field(self):
        result = evaluate_freshness({}, now=NOW)
        assert not hasattr(result, "order")
        assert not hasattr(result, "action")
        assert not hasattr(result, "trade")

    def test_source_result_has_no_order_field(self):
        cfg = _cfg("market", TIER_1, 30)
        r = check_source_freshness(cfg, _ts(10), NOW)
        assert not hasattr(r, "order")
        assert not hasattr(r, "action")

    def test_checked_at_equals_now(self):
        result = evaluate_freshness({}, now=NOW)
        assert result.checked_at == NOW

    def test_sources_dict_contains_all_default_configs(self):
        ts = {c.name: _ts(1) for c in DEFAULT_SOURCE_CONFIGS}
        result = evaluate_freshness(ts, now=NOW)
        expected = {c.name for c in DEFAULT_SOURCE_CONFIGS}
        assert set(result.sources.keys()) == expected


# ── Custom source_configs override ────────────────────────────────────────────

class TestCustomConfigs:

    def test_custom_config_overrides_default(self):
        custom = [_cfg("alpha", TIER_1, 10), _cfg("beta", TIER_2, 100)]
        ts = {"alpha": _ts(5), "beta": _ts(50)}
        result = evaluate_freshness(ts, now=NOW, source_configs=custom)
        assert set(result.sources.keys()) == {"alpha", "beta"}
        assert result.sources["alpha"].is_stale is False
        assert result.sources["beta"].is_stale is False

    def test_custom_config_stale_detection(self):
        custom = [_cfg("alpha", TIER_1, 10)]
        ts = {"alpha": _ts(11)}
        result = evaluate_freshness(ts, now=NOW, source_configs=custom)
        assert result.sources["alpha"].is_stale is True
        assert result.safe_mode_triggered is True


# ── DEFAULT_SOURCE_CONFIGS sanity ─────────────────────────────────────────────

class TestDefaultConfigs:

    def test_tier1_sources(self):
        tier1 = [c for c in DEFAULT_SOURCE_CONFIGS if c.tier == TIER_1]
        assert {c.name for c in tier1} == {"market", "regime", "news"}

    def test_tier2_sources(self):
        tier2 = [c for c in DEFAULT_SOURCE_CONFIGS if c.tier == TIER_2]
        assert {c.name for c in tier2} == {"scoring", "strategy", "macro"}

    def test_tier3_sources(self):
        tier3 = [c for c in DEFAULT_SOURCE_CONFIGS if c.tier == TIER_3]
        assert {c.name for c in tier3} == {"correlation", "trust"}

    def test_market_max_age_30(self):
        market = next(c for c in DEFAULT_SOURCE_CONFIGS if c.name == "market")
        assert market.max_age_minutes == 30

    def test_regime_max_age_60(self):
        regime = next(c for c in DEFAULT_SOURCE_CONFIGS if c.name == "regime")
        assert regime.max_age_minutes == 60

    def test_correlation_max_age_1440(self):
        corr = next(c for c in DEFAULT_SOURCE_CONFIGS if c.name == "correlation")
        assert corr.max_age_minutes == 1440
