"""
Tests for backend/engine/universe/size_segments.py — Card 3-6
"""
from __future__ import annotations

import math

import pytest

from backend.engine.universe.size_segments import (
    LARGE_CAP_THRESHOLD,
    SIZE_LABELS,
    SMALL_CAP_THRESHOLD,
    SizeInput,
    SizeResult,
    classify_size,
    classify_size_batch,
)


# ── Constants ─────────────────────────────────────────────────────────────────

class TestConstants:
    def test_small_cap_threshold_value(self):
        assert SMALL_CAP_THRESHOLD == 200_000_000_000

    def test_large_cap_threshold_value(self):
        assert LARGE_CAP_THRESHOLD == 1_000_000_000_000

    def test_size_labels_completeness(self):
        assert set(SIZE_LABELS) == {"large_cap", "mid_cap", "small_cap"}

    def test_size_labels_count(self):
        assert len(SIZE_LABELS) == 3

    def test_thresholds_ordered(self):
        assert SMALL_CAP_THRESHOLD < LARGE_CAP_THRESHOLD


# ── classify_size: typical values ─────────────────────────────────────────────

class TestClassifySizeTypical:
    def test_small_cap_typical(self):
        assert classify_size(100_000_000_000) == "small_cap"  # ¥100B

    def test_mid_cap_typical(self):
        assert classify_size(500_000_000_000) == "mid_cap"  # ¥500B

    def test_large_cap_typical(self):
        assert classify_size(2_000_000_000_000) == "large_cap"  # ¥2T

    def test_returns_valid_label(self):
        for cap in [50e9, 300e9, 5e12]:
            assert classify_size(cap) in SIZE_LABELS


# ── classify_size: boundary values ───────────────────────────────────────────

class TestClassifySizeBoundary:
    def test_boundary_just_below_small_threshold(self):
        # 199_999_999_999 → small_cap
        assert classify_size(199_999_999_999) == "small_cap"

    def test_boundary_at_small_threshold(self):
        # 200_000_000_000 → mid_cap (>= SMALL_CAP_THRESHOLD)
        assert classify_size(200_000_000_000) == "mid_cap"

    def test_boundary_just_below_large_threshold(self):
        # 999_999_999_999 → mid_cap
        assert classify_size(999_999_999_999) == "mid_cap"

    def test_boundary_at_large_threshold(self):
        # 1_000_000_000_000 → large_cap (>= LARGE_CAP_THRESHOLD)
        assert classify_size(1_000_000_000_000) == "large_cap"

    def test_boundary_small_cap_one_yen(self):
        assert classify_size(1) == "small_cap"

    def test_boundary_large_cap_very_large(self):
        assert classify_size(100_000_000_000_000) == "large_cap"  # ¥100T


# ── classify_size: validation ─────────────────────────────────────────────────

class TestClassifySizeValidation:
    def test_zero_raises(self):
        with pytest.raises(ValueError):
            classify_size(0)

    def test_negative_raises(self):
        with pytest.raises(ValueError):
            classify_size(-1)

    def test_large_negative_raises(self):
        with pytest.raises(ValueError):
            classify_size(-200_000_000_000)

    def test_nan_raises(self):
        with pytest.raises(ValueError):
            classify_size(float("nan"))

    def test_positive_inf_raises(self):
        with pytest.raises(ValueError):
            classify_size(float("inf"))

    def test_negative_inf_raises(self):
        with pytest.raises(ValueError):
            classify_size(float("-inf"))

    def test_error_message_includes_value_for_zero(self):
        with pytest.raises(ValueError, match="0"):
            classify_size(0)

    def test_error_message_includes_value_for_nan(self):
        with pytest.raises(ValueError, match="nan"):
            classify_size(float("nan"))


# ── classify_size_batch ───────────────────────────────────────────────────────

class TestClassifySizeBatch:
    def test_empty_list(self):
        assert classify_size_batch([]) == []

    def test_single_stock(self):
        result = classify_size_batch([SizeInput(ticker="7203", market_cap=300_000_000_000)])
        assert len(result) == 1
        assert result[0].size_segment == "mid_cap"

    def test_mixed_segments(self):
        stocks = [
            SizeInput("A", 100_000_000_000),   # small
            SizeInput("B", 500_000_000_000),   # mid
            SizeInput("C", 2_000_000_000_000), # large
        ]
        results = classify_size_batch(stocks)
        assert results[0].size_segment == "small_cap"
        assert results[1].size_segment == "mid_cap"
        assert results[2].size_segment == "large_cap"

    def test_ticker_preserved(self):
        stocks = [SizeInput("9984", 200_000_000_000)]
        result = classify_size_batch(stocks)
        assert result[0].ticker == "9984"

    def test_market_cap_preserved(self):
        cap = 750_000_000_000
        result = classify_size_batch([SizeInput("1234", cap)])
        assert result[0].market_cap == cap

    def test_result_type(self):
        result = classify_size_batch([SizeInput("0001", 1_000_000_000_000)])
        assert isinstance(result[0], SizeResult)

    def test_all_results_have_valid_labels(self):
        stocks = [SizeInput(str(i), float(i * 1e10)) for i in range(1, 200)]
        results = classify_size_batch(stocks)
        for r in results:
            assert r.size_segment in SIZE_LABELS

    def test_batch_propagates_validation_error(self):
        stocks = [SizeInput("bad", -1.0)]
        with pytest.raises(ValueError):
            classify_size_batch(stocks)


# ── Detection-only / pure function guarantees ─────────────────────────────────

class TestDetectionOnly:
    def test_pure_function_same_input_same_output(self):
        cap = 300_000_000_000
        assert classify_size(cap) == classify_size(cap)

    def test_classify_size_has_no_side_effects(self, tmp_path):
        # Call does not create files or modify state
        before = list(tmp_path.iterdir())
        classify_size(500_000_000_000)
        after = list(tmp_path.iterdir())
        assert before == after

    def test_batch_has_no_side_effects(self, tmp_path):
        before = list(tmp_path.iterdir())
        classify_size_batch([SizeInput("X", 1e11)])
        after = list(tmp_path.iterdir())
        assert before == after
