"""
test_jp_equity_pf_builder.py — Card 7-7
Phase 7: JpEquityPfBuilder / EquityHoldingInfo / LockObservation /
          EquityPfInput / EquityPfResult のテスト。
"""
import math
import pytest

from engine.portfolio.jp_equity_pf_builder import (
    LOCK_DAYS,
    EquityHoldingInfo,
    LockObservation,
    EquityPfInput,
    EquityPfResult,
    JpEquityPfBuilder,
)


# ── helpers ───────────────────────────────────────────────────────────────────

BUILDER = JpEquityPfBuilder()


def _holding(ticker, current_weight=0.1, days_since_purchase=30):
    return EquityHoldingInfo(
        ticker=ticker,
        current_weight=current_weight,
        days_since_purchase=days_since_purchase,
    )


def _build(ideal_pf, holdings=(), regime="bull"):
    pf_input = EquityPfInput(
        equity_ideal_pf=tuple(ideal_pf),
        current_holdings=tuple(holdings),
        regime=regime,
    )
    return BUILDER.build(pf_input)


def _weight_sum(pf_tuple):
    return sum(w for _, w in pf_tuple)


# ════════════════════════════════════════════════════════════════════════════
# 1. Constants / imports
# ════════════════════════════════════════════════════════════════════════════

class TestModuleConstants:
    def test_lock_days_is_91(self):
        assert LOCK_DAYS == 91

    def test_equity_holding_info_importable(self):
        assert EquityHoldingInfo is not None

    def test_lock_observation_importable(self):
        assert LockObservation is not None

    def test_equity_pf_input_importable(self):
        assert EquityPfInput is not None

    def test_equity_pf_result_importable(self):
        assert EquityPfResult is not None

    def test_jp_equity_pf_builder_importable(self):
        assert JpEquityPfBuilder is not None

    def test_stdlib_only_no_numpy(self):
        import engine.portfolio.jp_equity_pf_builder as m
        src = open(m.__file__).read()
        assert "import numpy" not in src
        assert "import pandas" not in src
        assert "import scipy" not in src

    def test_no_http_import(self):
        import engine.portfolio.jp_equity_pf_builder as m
        src = open(m.__file__).read()
        assert "requests" not in src
        assert "httpx" not in src


# ════════════════════════════════════════════════════════════════════════════
# 2. EquityHoldingInfo
# ════════════════════════════════════════════════════════════════════════════

class TestEquityHoldingInfo:
    def test_frozen(self):
        h = _holding("A")
        with pytest.raises((AttributeError, TypeError)):
            h.ticker = "B"  # type: ignore[misc]

    def test_current_weight_stored(self):
        h = EquityHoldingInfo(ticker="A", current_weight=0.25, days_since_purchase=10)
        assert h.current_weight == pytest.approx(0.25)

    def test_negative_weight_clamped_to_zero(self):
        h = EquityHoldingInfo(ticker="A", current_weight=-0.5, days_since_purchase=10)
        assert h.current_weight == 0.0

    def test_none_weight_defaults_to_zero(self):
        h = EquityHoldingInfo(ticker="A", current_weight=None, days_since_purchase=10)  # type: ignore[arg-type]
        assert h.current_weight == 0.0

    def test_nan_weight_defaults_to_zero(self):
        h = EquityHoldingInfo(ticker="A", current_weight=float("nan"), days_since_purchase=10)
        assert h.current_weight == 0.0

    def test_days_stored(self):
        h = EquityHoldingInfo(ticker="A", current_weight=0.1, days_since_purchase=45)
        assert h.days_since_purchase == 45

    def test_negative_days_clamped_to_zero(self):
        h = EquityHoldingInfo(ticker="A", current_weight=0.1, days_since_purchase=-5)
        assert h.days_since_purchase == 0

    def test_none_days_defaults_to_zero(self):
        h = EquityHoldingInfo(ticker="A", current_weight=0.1, days_since_purchase=None)  # type: ignore[arg-type]
        assert h.days_since_purchase == 0

    def test_no_action_field(self):
        h = _holding("A")
        assert not hasattr(h, "action")

    def test_no_is_buy_field(self):
        h = _holding("A")
        assert not hasattr(h, "is_buy")

    def test_no_verdict_field(self):
        h = _holding("A")
        assert not hasattr(h, "verdict")

    def test_no_order_field(self):
        h = _holding("A")
        assert not hasattr(h, "order")


# ════════════════════════════════════════════════════════════════════════════
# 3. LockObservation
# ════════════════════════════════════════════════════════════════════════════

class TestLockObservation:
    def _obs(self, dsp=30, cw=0.1):
        active = dsp < LOCK_DAYS
        return LockObservation(
            ticker="A",
            current_weight=cw,
            days_since_purchase=dsp,
            is_lock_period_active=active,
            lock_days_remaining=max(0, LOCK_DAYS - dsp),
            lock_floor_weight=cw if active else 0.0,
        )

    def test_frozen(self):
        obs = self._obs()
        with pytest.raises((AttributeError, TypeError)):
            obs.ticker = "B"  # type: ignore[misc]

    def test_is_active_true_when_dsp_lt_91(self):
        obs = self._obs(dsp=90)
        assert obs.is_lock_period_active is True

    def test_is_active_false_when_dsp_eq_91(self):
        obs = self._obs(dsp=91)
        assert obs.is_lock_period_active is False

    def test_is_active_false_when_dsp_gt_91(self):
        obs = self._obs(dsp=200)
        assert obs.is_lock_period_active is False

    def test_lock_days_remaining_within_lock(self):
        obs = self._obs(dsp=60)
        assert obs.lock_days_remaining == 31  # 91 - 60

    def test_lock_days_remaining_at_boundary(self):
        obs = self._obs(dsp=91)
        assert obs.lock_days_remaining == 0

    def test_lock_days_remaining_beyond_lock(self):
        obs = self._obs(dsp=150)
        assert obs.lock_days_remaining == 0

    def test_lock_floor_weight_when_active(self):
        obs = self._obs(dsp=30, cw=0.15)
        assert obs.lock_floor_weight == pytest.approx(0.15)

    def test_lock_floor_weight_zero_when_not_active(self):
        obs = self._obs(dsp=91, cw=0.15)
        assert obs.lock_floor_weight == 0.0

    def test_no_is_hold_field(self):
        obs = self._obs()
        assert not hasattr(obs, "is_hold")

    def test_no_sell_locked_field(self):
        obs = self._obs()
        assert not hasattr(obs, "sell_locked")

    def test_no_can_sell_field(self):
        obs = self._obs()
        assert not hasattr(obs, "can_sell")

    def test_no_action_field(self):
        obs = self._obs()
        assert not hasattr(obs, "action")

    def test_no_decision_field(self):
        obs = self._obs()
        assert not hasattr(obs, "decision")


# ════════════════════════════════════════════════════════════════════════════
# 4. EquityPfInput
# ════════════════════════════════════════════════════════════════════════════

class TestEquityPfInput:
    def test_frozen(self):
        pf_input = EquityPfInput(
            equity_ideal_pf=(("A", 1.0),),
            current_holdings=(),
            regime="bull",
        )
        with pytest.raises((AttributeError, TypeError)):
            pf_input.regime = "bear"  # type: ignore[misc]

    def test_list_ideal_pf_converted_to_tuple(self):
        pf_input = EquityPfInput(
            equity_ideal_pf=[("A", 1.0)],  # type: ignore[arg-type]
            current_holdings=(),
            regime="bull",
        )
        assert isinstance(pf_input.equity_ideal_pf, tuple)

    def test_list_holdings_converted_to_tuple(self):
        pf_input = EquityPfInput(
            equity_ideal_pf=(("A", 1.0),),
            current_holdings=[_holding("A")],  # type: ignore[arg-type]
            regime="bull",
        )
        assert isinstance(pf_input.current_holdings, tuple)

    def test_context_defaults_to_empty_dict(self):
        pf_input = EquityPfInput(
            equity_ideal_pf=(),
            current_holdings=(),
            regime="uncertain",
        )
        assert pf_input.context == {}

    def test_no_action_field(self):
        pf_input = EquityPfInput(equity_ideal_pf=(), current_holdings=(), regime="bull")
        assert not hasattr(pf_input, "action")


# ════════════════════════════════════════════════════════════════════════════
# 5. EquityPfResult
# ════════════════════════════════════════════════════════════════════════════

class TestEquityPfResult:
    def _make(self, **kw):
        defaults = dict(
            constrained_ideal_pf=(("A", 1.0),),
            lock_observations=(),
            tickers_included_by_lock_floor=(),
            diagnostics=(),
        )
        defaults.update(kw)
        return EquityPfResult(**defaults)

    def test_frozen(self):
        r = self._make()
        with pytest.raises((AttributeError, TypeError)):
            r.constrained_ideal_pf = ()  # type: ignore[misc]

    def test_has_constrained_ideal_pf(self):
        r = self._make()
        assert hasattr(r, "constrained_ideal_pf")

    def test_has_lock_observations(self):
        r = self._make()
        assert hasattr(r, "lock_observations")

    def test_has_tickers_included_by_lock_floor(self):
        r = self._make()
        assert hasattr(r, "tickers_included_by_lock_floor")

    def test_no_tickers_added_from_lock(self):
        r = self._make()
        assert not hasattr(r, "tickers_added_from_lock")

    def test_diagnostics_defaults_empty(self):
        r = EquityPfResult(
            constrained_ideal_pf=(),
            lock_observations=(),
            tickers_included_by_lock_floor=(),
        )
        assert r.diagnostics == ()

    def test_no_action_field(self):
        r = self._make()
        assert not hasattr(r, "action")

    def test_no_recommendation_field(self):
        r = self._make()
        assert not hasattr(r, "recommendation")

    def test_no_verdict_field(self):
        r = self._make()
        assert not hasattr(r, "verdict")

    def test_no_is_buy_field(self):
        r = self._make()
        assert not hasattr(r, "is_buy")

    def test_no_is_sell_field(self):
        r = self._make()
        assert not hasattr(r, "is_sell")

    def test_no_order_field(self):
        r = self._make()
        assert not hasattr(r, "order")

    def test_no_rebalance_order_field(self):
        r = self._make()
        assert not hasattr(r, "rebalance_order")

    def test_to_dict_structure(self):
        r = self._make()
        d = r.to_dict()
        assert set(d.keys()) == {
            "constrained_ideal_pf", "lock_observations",
            "tickers_included_by_lock_floor", "diagnostics",
        }

    def test_to_dict_constrained_pf_is_dict(self):
        r = self._make(constrained_ideal_pf=(("A", 0.6), ("B", 0.4)))
        d = r.to_dict()
        assert isinstance(d["constrained_ideal_pf"], dict)

    def test_to_dict_lock_observations_is_list(self):
        r = self._make()
        assert isinstance(r.to_dict()["lock_observations"], list)

    def test_to_dict_tickers_included_is_list(self):
        r = self._make(tickers_included_by_lock_floor=("X",))
        assert isinstance(r.to_dict()["tickers_included_by_lock_floor"], list)


# ════════════════════════════════════════════════════════════════════════════
# 6. JpEquityPfBuilder.build() — no holdings / passthrough
# ════════════════════════════════════════════════════════════════════════════

class TestBuildNoHoldings:
    def test_no_holdings_passthrough_weights_sum_to_1(self):
        r = _build([("A", 0.6), ("B", 0.4)])
        assert math.isclose(_weight_sum(r.constrained_ideal_pf), 1.0, abs_tol=1e-9)

    def test_no_holdings_passthrough_tickers_match(self):
        r = _build([("A", 0.6), ("B", 0.4)])
        tickers = {t for t, _ in r.constrained_ideal_pf}
        assert tickers == {"A", "B"}

    def test_no_holdings_no_lock_observations(self):
        r = _build([("A", 1.0)])
        assert r.lock_observations == ()

    def test_no_holdings_no_tickers_included_by_lock_floor(self):
        r = _build([("A", 1.0)])
        assert r.tickers_included_by_lock_floor == ()

    def test_empty_ideal_pf_and_no_holdings_empty_result(self):
        r = _build([])
        assert r.constrained_ideal_pf == ()
        assert r.lock_observations == ()

    def test_no_holdings_ideal_pf_proportions_preserved(self):
        # With no locked holdings, unlocked portion = remaining = 1.0 - 0.0 = 1.0
        # unlocked_scaled = ideal weights scaled to 1.0 proportionally
        r = _build([("A", 0.3), ("B", 0.7)])
        weights = dict(r.constrained_ideal_pf)
        assert weights["A"] == pytest.approx(0.3, abs=1e-9)
        assert weights["B"] == pytest.approx(0.7, abs=1e-9)


# ════════════════════════════════════════════════════════════════════════════
# 7. JpEquityPfBuilder.build() — LockObservation construction
# ════════════════════════════════════════════════════════════════════════════

class TestLockObservationConstruction:
    def test_lock_obs_built_for_each_holding(self):
        r = _build(
            [("A", 0.5), ("B", 0.5)],
            [_holding("A", days_since_purchase=30), _holding("B", days_since_purchase=100)],
        )
        assert len(r.lock_observations) == 2

    def test_lock_obs_is_active_true_when_dsp_lt_91(self):
        r = _build([("A", 1.0)], [_holding("A", current_weight=0.2, days_since_purchase=90)])
        obs = {o.ticker: o for o in r.lock_observations}
        assert obs["A"].is_lock_period_active is True

    def test_lock_obs_is_active_false_when_dsp_eq_91(self):
        r = _build([("A", 1.0)], [_holding("A", current_weight=0.2, days_since_purchase=91)])
        obs = {o.ticker: o for o in r.lock_observations}
        assert obs["A"].is_lock_period_active is False

    def test_lock_obs_lock_days_remaining(self):
        r = _build([("A", 1.0)], [_holding("A", current_weight=0.2, days_since_purchase=60)])
        obs = {o.ticker: o for o in r.lock_observations}
        assert obs["A"].lock_days_remaining == 31  # 91 - 60

    def test_duplicate_ticker_first_wins(self):
        holdings = [
            _holding("A", current_weight=0.1, days_since_purchase=30),
            _holding("A", current_weight=0.2, days_since_purchase=50),
        ]
        r = _build([("A", 1.0)], holdings)
        obs = {o.ticker: o for o in r.lock_observations}
        # first occurrence used
        assert obs["A"].current_weight == pytest.approx(0.1)
        assert len([o for o in r.lock_observations if o.ticker == "A"]) == 1

    def test_duplicate_ticker_generates_diagnostic(self):
        holdings = [
            _holding("A", current_weight=0.1, days_since_purchase=30),
            _holding("A", current_weight=0.2, days_since_purchase=50),
        ]
        r = _build([("A", 1.0)], holdings)
        assert any("duplicate" in d and "A" in d for d in r.diagnostics)


# ════════════════════════════════════════════════════════════════════════════
# 8. JpEquityPfBuilder.build() — input quality check
# ════════════════════════════════════════════════════════════════════════════

class TestInputQualityCheck:
    def test_current_weight_sum_gt_1_generates_diagnostic(self):
        holdings = [
            _holding("A", current_weight=0.7, days_since_purchase=30),
            _holding("B", current_weight=0.6, days_since_purchase=30),
        ]
        r = _build([("A", 0.5), ("B", 0.5)], holdings)
        assert any("current_weight sum" in d for d in r.diagnostics)

    def test_current_weight_sum_le_1_no_quality_diagnostic(self):
        holdings = [
            _holding("A", current_weight=0.5, days_since_purchase=30),
            _holding("B", current_weight=0.5, days_since_purchase=30),
        ]
        r = _build([("A", 0.5), ("B", 0.5)], holdings)
        assert not any("current_weight sum" in d for d in r.diagnostics)


# ════════════════════════════════════════════════════════════════════════════
# 9. JpEquityPfBuilder.build() — lock constraint (normal case)
# ════════════════════════════════════════════════════════════════════════════

class TestLockConstraintNormal:
    def test_locked_weight_floored_at_current_weight_when_above_ideal(self):
        # Ideal A=0.10, floor=0.30 → constrained A >= 0.30
        holdings = [_holding("A", current_weight=0.30, days_since_purchase=45)]
        r = _build([("A", 0.10), ("B", 0.90)], holdings)
        weights = dict(r.constrained_ideal_pf)
        assert weights["A"] >= 0.30 - 1e-9

    def test_locked_weight_uses_ideal_when_above_floor(self):
        # Ideal A=0.50, floor=0.30 → constrained A = 0.50 (or scaled)
        # locked_constrained[A] = max(0.50, 0.30) = 0.50
        # locked_total = 0.50, remaining = 0.50 to B
        holdings = [_holding("A", current_weight=0.30, days_since_purchase=45)]
        r = _build([("A", 0.50), ("B", 0.50)], holdings)
        weights = dict(r.constrained_ideal_pf)
        # After: locked A=0.50, unlocked B=0.50 → B scaled to remaining=0.50
        assert weights["A"] == pytest.approx(0.50, abs=1e-9)
        assert weights["B"] == pytest.approx(0.50, abs=1e-9)

    def test_unlocked_ticker_scaled_to_remaining(self):
        # A locked at 0.30, B and C unlocked equally weighted in ideal
        holdings = [_holding("A", current_weight=0.30, days_since_purchase=30)]
        r = _build([("A", 0.10), ("B", 0.45), ("C", 0.45)], holdings)
        weights = dict(r.constrained_ideal_pf)
        locked_total = weights["A"]
        remaining = 1.0 - locked_total
        # B and C split remaining equally (0.45:0.45 ratio = 50%/50%)
        assert math.isclose(weights["B"], remaining * 0.5, abs_tol=1e-9)
        assert math.isclose(weights["C"], remaining * 0.5, abs_tol=1e-9)

    def test_ticker_not_in_ideal_included_by_lock_floor(self):
        # A not in ideal_pf but locked → included by floor
        holdings = [_holding("A", current_weight=0.20, days_since_purchase=30)]
        r = _build([("B", 1.0)], holdings)
        assert "A" in r.tickers_included_by_lock_floor
        assert any(t == "A" for t, _ in r.constrained_ideal_pf)

    def test_tickers_included_by_lock_floor_recorded_in_result(self):
        holdings = [_holding("LOCKED", current_weight=0.20, days_since_purchase=30)]
        r = _build([("A", 1.0)], holdings)
        assert "LOCKED" in r.tickers_included_by_lock_floor

    def test_weights_sum_to_1_with_locked_holding(self):
        holdings = [_holding("A", current_weight=0.30, days_since_purchase=45)]
        r = _build([("A", 0.10), ("B", 0.90)], holdings)
        assert math.isclose(_weight_sum(r.constrained_ideal_pf), 1.0, abs_tol=1e-9)


# ════════════════════════════════════════════════════════════════════════════
# 10. JpEquityPfBuilder.build() — locked_total >= 1.0 fallback (P2-7T)
# ════════════════════════════════════════════════════════════════════════════

class TestLockedTotalGeOneFallback:
    def _heavy_lock_scenario(self):
        # Two locked holdings that together exceed 1.0
        holdings = [
            _holding("A", current_weight=0.65, days_since_purchase=30),
            _holding("B", current_weight=0.60, days_since_purchase=45),
        ]
        # ideal: A=0.10, B=0.10 → locked_constrained = max(0.10, 0.65), max(0.10, 0.60)
        #       = 0.65, 0.60 → locked_total = 1.25 >= 1.0
        return _build([("A", 0.10), ("B", 0.10), ("C", 0.80)], holdings)

    def test_locked_total_ge_1_generates_diagnostic(self):
        r = self._heavy_lock_scenario()
        assert any("locked floor weights exceed or equal 1.0" in d for d in r.diagnostics)

    def test_locked_total_ge_1_unlocked_ticker_absent(self):
        r = self._heavy_lock_scenario()
        # C is unlocked but locked_total >= 1.0 → C allocation = 0
        tickers = {t for t, _ in r.constrained_ideal_pf}
        assert "C" not in tickers

    def test_locked_total_ge_1_only_locked_tickers_in_result(self):
        r = self._heavy_lock_scenario()
        tickers = {t for t, _ in r.constrained_ideal_pf}
        assert tickers == {"A", "B"}

    def test_locked_total_ge_1_weights_sum_to_1(self):
        r = self._heavy_lock_scenario()
        assert math.isclose(_weight_sum(r.constrained_ideal_pf), 1.0, abs_tol=1e-9)

    def test_locked_total_exact_1_0_triggers_fallback(self):
        holdings = [
            _holding("A", current_weight=0.50, days_since_purchase=30),
            _holding("B", current_weight=0.50, days_since_purchase=30),
        ]
        # locked_constrained A=max(0.10,0.50)=0.50, B=max(0.10,0.50)=0.50 → total=1.0
        r = _build([("A", 0.10), ("B", 0.10), ("C", 0.80)], holdings)
        assert any("locked floor weights exceed or equal 1.0" in d for d in r.diagnostics)
        tickers = {t for t, _ in r.constrained_ideal_pf}
        assert "C" not in tickers


# ════════════════════════════════════════════════════════════════════════════
# 11. JpEquityPfBuilder.build() — output ordering
# ════════════════════════════════════════════════════════════════════════════

class TestOutputOrdering:
    def test_constrained_pf_sorted_weight_desc(self):
        r = _build([("A", 0.3), ("B", 0.7)])
        weights = [w for _, w in r.constrained_ideal_pf]
        assert weights == sorted(weights, reverse=True)

    def test_constrained_pf_sorted_ticker_asc_on_equal_weight(self):
        # A and B with equal ideal weights (0.5 each)
        r = _build([("B", 0.5), ("A", 0.5)])
        tickers = [t for t, _ in r.constrained_ideal_pf]
        assert tickers == ["A", "B"]

    def test_constrained_pf_ordering_with_locked(self):
        holdings = [_holding("A", current_weight=0.30, days_since_purchase=30)]
        r = _build([("A", 0.10), ("B", 0.30), ("C", 0.60)], holdings)
        weights = [w for _, w in r.constrained_ideal_pf]
        assert weights == sorted(weights, reverse=True)


# ════════════════════════════════════════════════════════════════════════════
# 12. JpEquityPfBuilder.build() — equal-weight fallback for unlocked
# ════════════════════════════════════════════════════════════════════════════

class TestUnlockedEqualWeightFallback:
    def test_all_zero_unlocked_equal_weight_fallback(self):
        # unlocked B, C with 0.0 ideal weight each
        holdings = [_holding("A", current_weight=0.20, days_since_purchase=30)]
        r = _build([("A", 0.80), ("B", 0.0), ("C", 0.0)], holdings)
        weights = dict(r.constrained_ideal_pf)
        # locked_constrained[A] = max(0.80, 0.20) = 0.80
        # locked_total = 0.80, remaining = 0.20
        # unlocked: B=0.0, C=0.0 → all-zero fallback → equal split of remaining
        # B = C = 0.10
        assert math.isclose(weights.get("B", 0.0), 0.10, abs_tol=1e-9)
        assert math.isclose(weights.get("C", 0.0), 0.10, abs_tol=1e-9)


# ════════════════════════════════════════════════════════════════════════════
# 13. JpEquityPfBuilder.build() — diagnostics
# ════════════════════════════════════════════════════════════════════════════

class TestDiagnostics:
    def test_locked_holdings_diagnostic_present(self):
        holdings = [_holding("A", current_weight=0.20, days_since_purchase=30)]
        r = _build([("A", 0.5), ("B", 0.5)], holdings)
        assert any("is_lock_period_active=True" in d for d in r.diagnostics)

    def test_lock_floor_included_diagnostic(self):
        holdings = [_holding("EXTRA", current_weight=0.20, days_since_purchase=30)]
        r = _build([("B", 1.0)], holdings)
        assert any("included in" in d and "lock floor" in d for d in r.diagnostics)

    def test_all_diagnostics_observation_prefix(self):
        holdings = [
            _holding("A", current_weight=0.20, days_since_purchase=30),
            _holding("A", current_weight=0.10, days_since_purchase=50),
        ]
        r = _build([("A", 0.5), ("B", 0.5)], holdings)
        for d in r.diagnostics:
            assert d.startswith("observation:")

    def test_no_diagnostics_when_no_locked_holdings(self):
        holdings = [_holding("A", current_weight=0.20, days_since_purchase=100)]
        r = _build([("A", 0.5), ("B", 0.5)], holdings)
        assert not any("is_lock_period_active=True" in d for d in r.diagnostics)


# ════════════════════════════════════════════════════════════════════════════
# 14. EquityPfResult.to_dict()
# ════════════════════════════════════════════════════════════════════════════

class TestToDictOutput:
    def test_to_dict_keys_complete(self):
        r = _build([("A", 0.5), ("B", 0.5)])
        d = r.to_dict()
        assert "constrained_ideal_pf" in d
        assert "lock_observations" in d
        assert "tickers_included_by_lock_floor" in d
        assert "diagnostics" in d

    def test_to_dict_constrained_pf_is_dict(self):
        r = _build([("A", 0.5), ("B", 0.5)])
        assert isinstance(r.to_dict()["constrained_ideal_pf"], dict)

    def test_to_dict_lock_obs_is_list(self):
        holdings = [_holding("A", current_weight=0.2, days_since_purchase=30)]
        r = _build([("A", 1.0)], holdings)
        d = r.to_dict()
        assert isinstance(d["lock_observations"], list)

    def test_to_dict_lock_obs_has_required_keys(self):
        holdings = [_holding("A", current_weight=0.2, days_since_purchase=30)]
        r = _build([("A", 1.0)], holdings)
        obs_list = r.to_dict()["lock_observations"]
        assert len(obs_list) == 1
        obs = obs_list[0]
        required = {
            "ticker", "current_weight", "days_since_purchase",
            "is_lock_period_active", "lock_days_remaining", "lock_floor_weight",
        }
        assert set(obs.keys()) == required

    def test_to_dict_is_json_serializable(self):
        import json
        holdings = [_holding("A", current_weight=0.2, days_since_purchase=30)]
        r = _build([("A", 0.5), ("B", 0.5)], holdings)
        json.dumps(r.to_dict())  # must not raise


# ════════════════════════════════════════════════════════════════════════════
# 15. End-to-end scenarios
# ════════════════════════════════════════════════════════════════════════════

class TestEndToEnd:
    def test_e2e_no_locked_holdings(self):
        # All holdings expired, ideal PF passes through
        holdings = [
            _holding("7203", current_weight=0.30, days_since_purchase=120),
            _holding("6758", current_weight=0.20, days_since_purchase=200),
        ]
        r = _build(
            [("7203", 0.4), ("6758", 0.35), ("9984", 0.25)],
            holdings,
        )
        weights = dict(r.constrained_ideal_pf)
        assert math.isclose(weights["7203"], 0.4, abs_tol=1e-9)
        assert math.isclose(weights["6758"], 0.35, abs_tol=1e-9)
        assert math.isclose(weights["9984"], 0.25, abs_tol=1e-9)
        assert math.isclose(_weight_sum(r.constrained_ideal_pf), 1.0, abs_tol=1e-9)

    def test_e2e_locked_holding_within_ideal(self):
        # A ideal > floor → ideal wins
        holdings = [_holding("A", current_weight=0.10, days_since_purchase=60)]
        r = _build([("A", 0.40), ("B", 0.60)], holdings)
        weights = dict(r.constrained_ideal_pf)
        assert math.isclose(weights["A"], 0.40, abs_tol=1e-9)
        assert math.isclose(weights["B"], 0.60, abs_tol=1e-9)
        assert math.isclose(_weight_sum(r.constrained_ideal_pf), 1.0, abs_tol=1e-9)

    def test_e2e_locked_holding_above_ideal(self):
        # A floor=0.35 > ideal=0.15 → A gets floor, B scaled to remaining
        holdings = [_holding("A", current_weight=0.35, days_since_purchase=30)]
        r = _build([("A", 0.15), ("B", 0.85)], holdings)
        weights = dict(r.constrained_ideal_pf)
        # locked_constrained[A] = max(0.15, 0.35) = 0.35
        # locked_total = 0.35, remaining = 0.65
        # B scaled to 0.65
        assert math.isclose(weights["A"], 0.35, abs_tol=1e-9)
        assert math.isclose(weights["B"], 0.65, abs_tol=1e-9)
        assert math.isclose(_weight_sum(r.constrained_ideal_pf), 1.0, abs_tol=1e-9)

    def test_e2e_locked_not_in_ideal(self):
        # EXTRA locked but not in ideal → tickers_included_by_lock_floor
        holdings = [_holding("EXTRA", current_weight=0.20, days_since_purchase=45)]
        r = _build([("A", 0.60), ("B", 0.40)], holdings)
        assert "EXTRA" in r.tickers_included_by_lock_floor
        weights = dict(r.constrained_ideal_pf)
        # EXTRA floor = 0.20, A+B scaled to remaining 0.80
        assert math.isclose(weights.get("EXTRA", 0.0), 0.20, abs_tol=1e-9)
        assert math.isclose(_weight_sum(r.constrained_ideal_pf), 1.0, abs_tol=1e-9)

    def test_e2e_locked_total_ge_1_scenario(self):
        # P2-7T: heavy lock forces renorm locked only
        holdings = [
            _holding("A", current_weight=0.65, days_since_purchase=20),
            _holding("B", current_weight=0.55, days_since_purchase=30),
        ]
        r = _build([("A", 0.10), ("B", 0.10), ("C", 0.80)], holdings)
        assert any("locked floor weights exceed or equal 1.0" in d for d in r.diagnostics)
        tickers = {t for t, _ in r.constrained_ideal_pf}
        assert "C" not in tickers
        assert math.isclose(_weight_sum(r.constrained_ideal_pf), 1.0, abs_tol=1e-9)

    def test_e2e_mixed_locked_and_unlocked(self):
        holdings = [
            _holding("7203", current_weight=0.25, days_since_purchase=30),   # locked
            _holding("6758", current_weight=0.15, days_since_purchase=100),  # unlocked
        ]
        r = _build(
            [("7203", 0.30), ("6758", 0.30), ("9984", 0.40)],
            holdings,
        )
        weights = dict(r.constrained_ideal_pf)
        # 7203: locked, ideal=0.30 > floor=0.25 → 0.30
        # 6758, 9984: unlocked, scaled to remaining 0.70 (ideal ratio 0.30:0.40=3:4)
        assert math.isclose(weights["7203"], 0.30, abs_tol=1e-9)
        # unlocked: 6758 and 9984 with ideal 0.30:0.40
        # scale: 6758 = 0.30/0.70 * 0.70 = 0.30, 9984 = 0.40/0.70 * 0.70 = 0.40
        assert math.isclose(weights["6758"], 0.30, abs_tol=1e-9)
        assert math.isclose(weights["9984"], 0.40, abs_tol=1e-9)
        assert math.isclose(_weight_sum(r.constrained_ideal_pf), 1.0, abs_tol=1e-9)
