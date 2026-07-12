"""
Tests for backend/engine/snapshot/size_segments_schema.py — Card 3-8
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from backend.engine.snapshot.size_segments_schema import (
    SCHEMA_VERSION,
    build_size_segments_dict,
)
from backend.engine.universe.size_segments import SIZE_LABELS, SizeInput, SizeResult, classify_size_batch


# ── Helpers ───────────────────────────────────────────────────────────────────

FIXED_TS = datetime(2026, 5, 3, 0, 0, 0, tzinfo=timezone.utc)

SAMPLE_STOCKS = [
    SizeInput(ticker="A", market_cap=100_000_000_000),   # small_cap
    SizeInput(ticker="B", market_cap=500_000_000_000),   # mid_cap
    SizeInput(ticker="C", market_cap=2_000_000_000_000), # large_cap
]


def _build(stocks=None, generated_at=FIXED_TS):
    if stocks is None:
        stocks = SAMPLE_STOCKS
    results = classify_size_batch(stocks)
    return build_size_segments_dict(results, generated_at=generated_at)


# ── Schema version ────────────────────────────────────────────────────────────

class TestSchemaVersion:
    def test_schema_version_constant(self):
        assert SCHEMA_VERSION == "3.8"

    def test_schema_version_in_size_segments(self):
        d = _build()
        assert d["size_segments"]["schema_version"] == "3.8"

    def test_schema_version_not_at_top_level(self):
        d = _build()
        assert "schema_version" not in d


# ── Top-level structure ───────────────────────────────────────────────────────

class TestTopLevelStructure:
    def test_has_size_segments_key(self):
        d = _build()
        assert "size_segments" in d

    def test_only_size_segments_at_top(self):
        d = _build()
        assert list(d.keys()) == ["size_segments"]

    def test_size_segments_is_dict(self):
        d = _build()
        assert isinstance(d["size_segments"], dict)


# ── Required fields ───────────────────────────────────────────────────────────

class TestRequiredFields:
    def test_has_schema_version(self):
        d = _build()
        assert "schema_version" in d["size_segments"]

    def test_has_generated_at(self):
        d = _build()
        assert "generated_at" in d["size_segments"]

    def test_has_count(self):
        d = _build()
        assert "count" in d["size_segments"]

    def test_has_segments(self):
        d = _build()
        assert "segments" in d["size_segments"]


# ── generated_at ─────────────────────────────────────────────────────────────

class TestGeneratedAt:
    def test_generated_at_is_fixed_timestamp(self):
        d = _build(generated_at=FIXED_TS)
        assert d["size_segments"]["generated_at"] == FIXED_TS.isoformat()

    def test_generated_at_auto_set_when_none(self):
        results = classify_size_batch(SAMPLE_STOCKS)
        d = build_size_segments_dict(results, generated_at=None)
        assert d["size_segments"]["generated_at"] is not None
        assert isinstance(d["size_segments"]["generated_at"], str)


# ── count ─────────────────────────────────────────────────────────────────────

class TestCount:
    def test_count_matches_input(self):
        d = _build()
        assert d["size_segments"]["count"] == len(SAMPLE_STOCKS)

    def test_count_matches_segments_length(self):
        d = _build()
        assert d["size_segments"]["count"] == len(d["size_segments"]["segments"])

    def test_count_zero_for_empty_input(self):
        d = build_size_segments_dict([], generated_at=FIXED_TS)
        assert d["size_segments"]["count"] == 0
        assert d["size_segments"]["segments"] == []


# ── segments ─────────────────────────────────────────────────────────────────

class TestSegments:
    def test_segment_has_ticker(self):
        seg = _build()["size_segments"]["segments"][0]
        assert "ticker" in seg

    def test_segment_has_size_segment(self):
        seg = _build()["size_segments"]["segments"][0]
        assert "size_segment" in seg

    def test_segment_has_market_cap(self):
        seg = _build()["size_segments"]["segments"][0]
        assert "market_cap" in seg

    def test_all_size_segments_are_valid_labels(self):
        d = _build()
        for seg in d["size_segments"]["segments"]:
            assert seg["size_segment"] in SIZE_LABELS

    def test_ticker_values_correct(self):
        d = _build()
        tickers = [s["ticker"] for s in d["size_segments"]["segments"]]
        assert tickers == ["A", "B", "C"]

    def test_size_segment_small_cap(self):
        # ¥100B → small_cap
        results = classify_size_batch([SizeInput("X", 100_000_000_000)])
        d = build_size_segments_dict(results, generated_at=FIXED_TS)
        assert d["size_segments"]["segments"][0]["size_segment"] == "small_cap"

    def test_size_segment_mid_cap(self):
        # ¥500B → mid_cap
        results = classify_size_batch([SizeInput("Y", 500_000_000_000)])
        d = build_size_segments_dict(results, generated_at=FIXED_TS)
        assert d["size_segments"]["segments"][0]["size_segment"] == "mid_cap"

    def test_size_segment_large_cap(self):
        # ¥2T → large_cap
        results = classify_size_batch([SizeInput("Z", 2_000_000_000_000)])
        d = build_size_segments_dict(results, generated_at=FIXED_TS)
        assert d["size_segments"]["segments"][0]["size_segment"] == "large_cap"

    def test_market_cap_value_preserved(self):
        d = _build()
        caps = [s["market_cap"] for s in d["size_segments"]["segments"]]
        assert caps == [s.market_cap for s in SAMPLE_STOCKS]


# ── Shadow DEFAULT_STOCKS integration ────────────────────────────────────────

class TestDefaultStocksIntegration:
    def test_all_default_stocks_have_valid_segments(self):
        from backend.engine.shadow.shadow_mode import DEFAULT_STOCKS
        results = classify_size_batch(DEFAULT_STOCKS)
        d = build_size_segments_dict(results, generated_at=FIXED_TS)
        for seg in d["size_segments"]["segments"]:
            assert seg["size_segment"] in SIZE_LABELS

    def test_default_stocks_count_matches(self):
        from backend.engine.shadow.shadow_mode import DEFAULT_STOCKS
        results = classify_size_batch(DEFAULT_STOCKS)
        d = build_size_segments_dict(results, generated_at=FIXED_TS)
        assert d["size_segments"]["count"] == len(DEFAULT_STOCKS)
