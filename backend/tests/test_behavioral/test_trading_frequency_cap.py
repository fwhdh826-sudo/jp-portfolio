"""
test_trading_frequency_cap.py — Card 6-7
TradingFrequencyCalculator のユニットテスト。
"""
import pytest

from engine.behavioral.trading_frequency_cap import (
    TradingFrequencyInput,
    TradingFrequencyResult,
    TradingFrequencyCalculator,
    DEFAULT_WINDOW_DAYS,
    DEFAULT_MAX_TRADES,
    OVERTRADING_THRESHOLD,
    COOLING_THRESHOLD,
)


# ── TradingFrequencyInput tests ───────────────────────────────────────────────

class TestTradingFrequencyInput:
    def test_frozen(self):
        fi = TradingFrequencyInput(
            trade_dates=("2024-01-01",),
            reference_date="2024-01-31",
        )
        with pytest.raises((AttributeError, TypeError)):
            fi.reference_date = "2024-02-01"  # type: ignore[misc]

    def test_list_converted_to_tuple(self):
        fi = TradingFrequencyInput(
            trade_dates=["2024-01-01", "2024-01-05"],
            reference_date="2024-01-31",
        )
        assert isinstance(fi.trade_dates, tuple)

    def test_empty_list_converted_to_empty_tuple(self):
        fi = TradingFrequencyInput(trade_dates=[], reference_date="2024-01-31")
        assert fi.trade_dates == ()

    def test_defaults(self):
        fi = TradingFrequencyInput(trade_dates=(), reference_date="2024-01-31")
        assert fi.window_days == DEFAULT_WINDOW_DAYS
        assert fi.max_trades_per_window == DEFAULT_MAX_TRADES


# ── TradingFrequencyResult tests ──────────────────────────────────────────────

class TestTradingFrequencyResult:
    def test_to_dict_keys(self):
        result = TradingFrequencyResult(
            trade_count_in_window=3,
            frequency_ratio=0.375,
            days_since_last_trade=5,
            is_overtrading=False,
            is_cooling_required=False,
            caution_flags=(),
        )
        d = result.to_dict()
        assert set(d.keys()) == {
            "trade_count_in_window", "frequency_ratio", "days_since_last_trade",
            "is_overtrading", "is_cooling_required", "caution_flags",
        }

    def test_to_dict_caution_flags_is_list(self):
        result = TradingFrequencyResult(3, 0.375, 5, False, False, ("a",))
        assert isinstance(result.to_dict()["caution_flags"], list)

    def test_no_forbidden_fields(self):
        forbidden = {
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "verdict", "decision", "rating",
            "approve", "reject", "conditional",
        }
        result = TradingFrequencyResult(0, 0.0, -1, False, False, ())
        for f in forbidden:
            assert not hasattr(result, f), f"Forbidden field found: {f}"


# ── TradingFrequencyCalculator tests ─────────────────────────────────────────

class TestTradingFrequencyCalculator:

    @pytest.fixture
    def calc(self):
        return TradingFrequencyCalculator()

    # ── basic counting ────────────────────────────────────────────────────────

    def test_no_trades_returns_zero_count(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=(),
            reference_date="2024-01-31",
        )
        result = calc.calculate(fi)
        assert result.trade_count_in_window == 0
        assert result.days_since_last_trade == -1

    def test_trades_within_window_counted(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=("2024-01-10", "2024-01-20", "2024-01-30"),
            reference_date="2024-01-31",
            window_days=30,
        )
        result = calc.calculate(fi)
        assert result.trade_count_in_window == 3

    def test_trades_outside_window_excluded(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=("2023-12-01", "2024-01-20"),
            reference_date="2024-01-31",
            window_days=30,
        )
        # 2024-01-01 is window_start (31-30); 2023-12-01 is before
        result = calc.calculate(fi)
        assert result.trade_count_in_window == 1

    def test_trade_on_window_start_included(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=("2024-01-01",),
            reference_date="2024-01-31",
            window_days=30,
        )
        # window_start = 2024-01-01 (inclusive)
        result = calc.calculate(fi)
        assert result.trade_count_in_window == 1

    def test_trade_on_reference_date_included(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=("2024-01-31",),
            reference_date="2024-01-31",
            window_days=30,
        )
        result = calc.calculate(fi)
        assert result.trade_count_in_window == 1

    def test_trade_after_reference_date_excluded(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=("2024-02-01",),
            reference_date="2024-01-31",
            window_days=30,
        )
        result = calc.calculate(fi)
        assert result.trade_count_in_window == 0

    # ── days_since_last_trade ─────────────────────────────────────────────────

    def test_days_since_last_trade_computed(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=("2024-01-26",),
            reference_date="2024-01-31",
            window_days=30,
        )
        result = calc.calculate(fi)
        assert result.days_since_last_trade == 5

    def test_days_since_last_trade_on_same_day(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=("2024-01-31",),
            reference_date="2024-01-31",
        )
        result = calc.calculate(fi)
        assert result.days_since_last_trade == 0

    def test_days_since_last_trade_uses_latest(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=("2024-01-10", "2024-01-25"),
            reference_date="2024-01-31",
        )
        result = calc.calculate(fi)
        assert result.days_since_last_trade == 6

    # ── frequency_ratio ───────────────────────────────────────────────────────

    def test_frequency_ratio_normal(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=("2024-01-10", "2024-01-20"),
            reference_date="2024-01-31",
            max_trades_per_window=8,
        )
        result = calc.calculate(fi)
        assert result.frequency_ratio == pytest.approx(2 / 8)

    def test_max_trades_zero_ratio_fallback(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=("2024-01-10",),
            reference_date="2024-01-31",
            max_trades_per_window=0,
        )
        result = calc.calculate(fi)
        assert result.frequency_ratio == pytest.approx(0.0)

    def test_max_trades_negative_ratio_fallback(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=("2024-01-10",),
            reference_date="2024-01-31",
            max_trades_per_window=-5,
        )
        result = calc.calculate(fi)
        assert result.frequency_ratio == pytest.approx(0.0)

    # ── window_days fallback ──────────────────────────────────────────────────

    def test_window_days_zero_uses_default(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=("2024-01-10",),
            reference_date="2024-01-31",
            window_days=0,
        )
        result = calc.calculate(fi)
        # default 30-day window: 2024-01-01 is start; 2024-01-10 is within
        assert result.trade_count_in_window == 1

    def test_window_days_negative_uses_default(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=("2024-01-10",),
            reference_date="2024-01-31",
            window_days=-10,
        )
        result = calc.calculate(fi)
        assert result.trade_count_in_window == 1

    # ── is_overtrading / is_cooling_required ──────────────────────────────────

    def test_not_overtrading_below_threshold(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=("2024-01-10",),
            reference_date="2024-01-31",
            max_trades_per_window=8,
        )
        result = calc.calculate(fi)
        assert result.is_overtrading is False
        assert result.is_cooling_required is False

    def test_overtrading_at_ratio_above_1(self, calc):
        # 9 trades / 8 max = 1.125 > 1.0
        dates = [f"2024-01-{i:02d}" for i in range(1, 10)]  # 9 dates
        fi = TradingFrequencyInput(
            trade_dates=tuple(dates),
            reference_date="2024-01-31",
            max_trades_per_window=8,
        )
        result = calc.calculate(fi)
        assert result.frequency_ratio == pytest.approx(9 / 8)
        assert result.is_overtrading is True
        assert result.is_cooling_required is False

    def test_cooling_required_at_ratio_1_5(self, calc):
        # 12 trades / 8 max = 1.5
        dates = [f"2024-01-{i:02d}" for i in range(1, 13)]  # 12 dates
        fi = TradingFrequencyInput(
            trade_dates=tuple(dates),
            reference_date="2024-01-31",
            max_trades_per_window=8,
        )
        result = calc.calculate(fi)
        assert result.frequency_ratio == pytest.approx(1.5)
        assert result.is_overtrading is True
        assert result.is_cooling_required is True

    def test_ratio_exactly_1_not_overtrading(self, calc):
        # 8/8 = 1.0, NOT > 1.0
        dates = [f"2024-01-{i:02d}" for i in range(1, 9)]  # 8 dates
        fi = TradingFrequencyInput(
            trade_dates=tuple(dates),
            reference_date="2024-01-31",
            max_trades_per_window=8,
        )
        result = calc.calculate(fi)
        assert result.frequency_ratio == pytest.approx(1.0)
        assert result.is_overtrading is False

    # ── invalid dates in trade_dates ──────────────────────────────────────────

    def test_invalid_trade_date_excluded(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=("not-a-date", "2024-01-15", "bad"),
            reference_date="2024-01-31",
        )
        result = calc.calculate(fi)
        assert result.trade_count_in_window == 1

    def test_all_invalid_trade_dates(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=("bad1", "bad2"),
            reference_date="2024-01-31",
        )
        result = calc.calculate(fi)
        assert result.trade_count_in_window == 0
        assert result.days_since_last_trade == -1

    # ── invalid reference_date → safe fallback ────────────────────────────────

    def test_invalid_reference_date_safe_fallback(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=("2024-01-10",),
            reference_date="not-a-date",
        )
        result = calc.calculate(fi)
        assert result.trade_count_in_window == 0
        assert result.frequency_ratio == pytest.approx(0.0)
        assert result.days_since_last_trade == -1
        assert result.is_overtrading is False
        assert result.is_cooling_required is False
        assert len(result.caution_flags) >= 1
        assert any("reference_date" in f for f in result.caution_flags)

    def test_none_reference_date_safe_fallback(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=(),
            reference_date=None,  # type: ignore[arg-type]
        )
        result = calc.calculate(fi)
        assert result.trade_count_in_window == 0
        assert result.is_overtrading is False

    def test_empty_reference_date_safe_fallback(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=(),
            reference_date="",
        )
        result = calc.calculate(fi)
        assert result.trade_count_in_window == 0
        assert any("reference_date" in f for f in result.caution_flags)

    # ── caution_flags ─────────────────────────────────────────────────────────

    def test_no_caution_flags_normal(self, calc):
        fi = TradingFrequencyInput(
            trade_dates=("2024-01-10",),
            reference_date="2024-01-31",
            max_trades_per_window=8,
        )
        result = calc.calculate(fi)
        assert result.caution_flags == ()

    def test_overtrading_flag_added(self, calc):
        dates = tuple(f"2024-01-{i:02d}" for i in range(1, 10))  # 9
        fi = TradingFrequencyInput(
            trade_dates=dates,
            reference_date="2024-01-31",
            max_trades_per_window=8,
        )
        result = calc.calculate(fi)
        assert any("overtrading" in f for f in result.caution_flags)

    def test_cooling_flag_added(self, calc):
        dates = tuple(f"2024-01-{i:02d}" for i in range(1, 13))  # 12
        fi = TradingFrequencyInput(
            trade_dates=dates,
            reference_date="2024-01-31",
            max_trades_per_window=8,
        )
        result = calc.calculate(fi)
        assert any("cooling" in f for f in result.caution_flags)

    def test_only_one_flag_when_overtrading(self, calc):
        # ratio = 9/8 = 1.125 → overtrading only, not cooling
        dates = tuple(f"2024-01-{i:02d}" for i in range(1, 10))
        fi = TradingFrequencyInput(
            trade_dates=dates,
            reference_date="2024-01-31",
            max_trades_per_window=8,
        )
        result = calc.calculate(fi)
        assert len(result.caution_flags) == 1
        assert any("overtrading" in f for f in result.caution_flags)

    # ── return type ───────────────────────────────────────────────────────────

    def test_return_type(self, calc):
        fi = TradingFrequencyInput(trade_dates=(), reference_date="2024-01-31")
        result = calc.calculate(fi)
        assert isinstance(result, TradingFrequencyResult)

    # ── constants ─────────────────────────────────────────────────────────────

    def test_constants_values(self):
        assert DEFAULT_WINDOW_DAYS == 30
        assert DEFAULT_MAX_TRADES == 8
        assert OVERTRADING_THRESHOLD == pytest.approx(1.0)
        assert COOLING_THRESHOLD == pytest.approx(1.5)
