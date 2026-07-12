"""
test_fund_pf_builder.py — Card 7-8
Phase 7: FundPfBuilder / FundHoldingInfo / FundHoldingObservation /
          FundPfInput / FundPfResult のテスト。

投信は 3ヶ月ロック制約の対象外。
FundHoldingObservation は is_lock_period_active / lock_floor_weight を持たない。
"""
import math
import pytest

from engine.portfolio.fund_pf_builder import (
    FundHoldingInfo,
    FundHoldingObservation,
    FundPfInput,
    FundPfResult,
    FundPfBuilder,
)


# ── helpers ───────────────────────────────────────────────────────────────────

BUILDER = FundPfBuilder()


def _holding(fund_code="F1", current_weight=0.2, days_since_purchase=30):
    return FundHoldingInfo(
        fund_code=fund_code,
        current_weight=current_weight,
        days_since_purchase=days_since_purchase,
    )


def _build(ideal_pf, holdings=(), regime="bull"):
    return BUILDER.build(FundPfInput(
        fund_ideal_pf=tuple(ideal_pf),
        current_holdings=tuple(holdings),
        regime=regime,
    ))


def _weight_sum(pf_tuple):
    return sum(w for _, w in pf_tuple)


# ════════════════════════════════════════════════════════════════════════════
# 1. Module / constants
# ════════════════════════════════════════════════════════════════════════════

class TestModuleConstants:
    def test_fund_holding_info_importable(self):
        assert FundHoldingInfo is not None

    def test_fund_holding_observation_importable(self):
        assert FundHoldingObservation is not None

    def test_fund_pf_input_importable(self):
        assert FundPfInput is not None

    def test_fund_pf_result_importable(self):
        assert FundPfResult is not None

    def test_fund_pf_builder_importable(self):
        assert FundPfBuilder is not None

    def test_no_lock_days_constant(self):
        import engine.portfolio.fund_pf_builder as m
        assert not hasattr(m, "LOCK_DAYS")

    def test_stdlib_only_no_numpy(self):
        import engine.portfolio.fund_pf_builder as m
        src = open(m.__file__).read()
        assert "import numpy" not in src
        assert "import pandas" not in src
        assert "import scipy" not in src

    def test_no_http_import(self):
        import engine.portfolio.fund_pf_builder as m
        src = open(m.__file__).read()
        assert "requests" not in src
        assert "httpx" not in src

    def test_no_fund_short_term_risk_import(self):
        import engine.portfolio.fund_pf_builder as m
        src = open(m.__file__).read()
        assert "import fund_short_term_risk" not in src
        assert "from engine.behavioral.fund_short_term_risk" not in src


# ════════════════════════════════════════════════════════════════════════════
# 2. FundHoldingInfo
# ════════════════════════════════════════════════════════════════════════════

class TestFundHoldingInfo:
    def test_frozen(self):
        h = _holding()
        with pytest.raises((AttributeError, TypeError)):
            h.fund_code = "X"  # type: ignore[misc]

    def test_current_weight_stored(self):
        h = FundHoldingInfo(fund_code="F1", current_weight=0.25, days_since_purchase=10)
        assert h.current_weight == pytest.approx(0.25)

    def test_negative_weight_clamped(self):
        h = FundHoldingInfo(fund_code="F1", current_weight=-0.5, days_since_purchase=10)
        assert h.current_weight == 0.0

    def test_none_weight_defaults_to_zero(self):
        h = FundHoldingInfo(fund_code="F1", current_weight=None, days_since_purchase=10)  # type: ignore[arg-type]
        assert h.current_weight == 0.0

    def test_nan_weight_defaults_to_zero(self):
        h = FundHoldingInfo(fund_code="F1", current_weight=float("nan"), days_since_purchase=10)
        assert h.current_weight == 0.0

    def test_days_stored(self):
        h = FundHoldingInfo(fund_code="F1", current_weight=0.1, days_since_purchase=45)
        assert h.days_since_purchase == 45

    def test_negative_days_clamped(self):
        h = FundHoldingInfo(fund_code="F1", current_weight=0.1, days_since_purchase=-5)
        assert h.days_since_purchase == 0

    def test_none_days_defaults_to_zero(self):
        h = FundHoldingInfo(fund_code="F1", current_weight=0.1, days_since_purchase=None)  # type: ignore[arg-type]
        assert h.days_since_purchase == 0

    def test_no_action_field(self):
        h = _holding()
        assert not hasattr(h, "action")

    def test_no_is_buy_field(self):
        h = _holding()
        assert not hasattr(h, "is_buy")

    def test_no_verdict_field(self):
        h = _holding()
        assert not hasattr(h, "verdict")

    def test_no_is_lock_period_active_field(self):
        h = _holding()
        assert not hasattr(h, "is_lock_period_active")

    def test_no_lock_floor_weight_field(self):
        h = _holding()
        assert not hasattr(h, "lock_floor_weight")


# ════════════════════════════════════════════════════════════════════════════
# 3. FundHoldingObservation
# ════════════════════════════════════════════════════════════════════════════

class TestFundHoldingObservation:
    def _obs(self, fc="F1", cw=0.2, dsp=30):
        return FundHoldingObservation(
            fund_code=fc,
            current_weight=cw,
            days_since_purchase=dsp,
        )

    def test_frozen(self):
        obs = self._obs()
        with pytest.raises((AttributeError, TypeError)):
            obs.fund_code = "X"  # type: ignore[misc]

    def test_has_fund_code(self):
        obs = self._obs()
        assert obs.fund_code == "F1"

    def test_has_current_weight(self):
        obs = self._obs(cw=0.3)
        assert obs.current_weight == pytest.approx(0.3)

    def test_has_days_since_purchase(self):
        obs = self._obs(dsp=50)
        assert obs.days_since_purchase == 50

    def test_no_is_lock_period_active(self):
        obs = self._obs()
        assert not hasattr(obs, "is_lock_period_active")

    def test_no_lock_floor_weight(self):
        obs = self._obs()
        assert not hasattr(obs, "lock_floor_weight")

    def test_no_lock_days_remaining(self):
        obs = self._obs()
        assert not hasattr(obs, "lock_days_remaining")

    def test_no_is_hold(self):
        obs = self._obs()
        assert not hasattr(obs, "is_hold")

    def test_no_sell_locked(self):
        obs = self._obs()
        assert not hasattr(obs, "sell_locked")

    def test_no_action(self):
        obs = self._obs()
        assert not hasattr(obs, "action")

    def test_negative_weight_clamped(self):
        obs = FundHoldingObservation(fund_code="F1", current_weight=-0.1, days_since_purchase=10)
        assert obs.current_weight == 0.0

    def test_negative_days_clamped(self):
        obs = FundHoldingObservation(fund_code="F1", current_weight=0.1, days_since_purchase=-1)
        assert obs.days_since_purchase == 0


# ════════════════════════════════════════════════════════════════════════════
# 4. FundPfInput
# ════════════════════════════════════════════════════════════════════════════

class TestFundPfInput:
    def test_frozen(self):
        pf_input = FundPfInput(fund_ideal_pf=(("F1", 1.0),), current_holdings=(), regime="bull")
        with pytest.raises((AttributeError, TypeError)):
            pf_input.regime = "bear"  # type: ignore[misc]

    def test_list_ideal_pf_converted_to_tuple(self):
        pf_input = FundPfInput(
            fund_ideal_pf=[("F1", 1.0)],  # type: ignore[arg-type]
            current_holdings=(),
            regime="bull",
        )
        assert isinstance(pf_input.fund_ideal_pf, tuple)

    def test_list_holdings_converted_to_tuple(self):
        pf_input = FundPfInput(
            fund_ideal_pf=(("F1", 1.0),),
            current_holdings=[_holding()],  # type: ignore[arg-type]
            regime="bull",
        )
        assert isinstance(pf_input.current_holdings, tuple)

    def test_context_defaults_to_empty_dict(self):
        pf_input = FundPfInput(fund_ideal_pf=(), current_holdings=(), regime="uncertain")
        assert pf_input.context == {}

    def test_no_action_field(self):
        pf_input = FundPfInput(fund_ideal_pf=(), current_holdings=(), regime="bull")
        assert not hasattr(pf_input, "action")


# ════════════════════════════════════════════════════════════════════════════
# 5. FundPfResult
# ════════════════════════════════════════════════════════════════════════════

class TestFundPfResult:
    def _make(self, **kw):
        defaults = dict(
            fund_pf=(("F1", 1.0),),
            fund_holding_observations=(),
            diagnostics=(),
        )
        defaults.update(kw)
        return FundPfResult(**defaults)

    def test_frozen(self):
        r = self._make()
        with pytest.raises((AttributeError, TypeError)):
            r.fund_pf = ()  # type: ignore[misc]

    def test_has_fund_pf(self):
        r = self._make()
        assert hasattr(r, "fund_pf")

    def test_has_fund_holding_observations(self):
        r = self._make()
        assert hasattr(r, "fund_holding_observations")

    def test_diagnostics_defaults_empty(self):
        r = FundPfResult(fund_pf=(), fund_holding_observations=())
        assert r.diagnostics == ()

    def test_no_fund_constrained_pf(self):
        r = self._make()
        assert not hasattr(r, "fund_constrained_pf")

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

    def test_no_rebalance_order(self):
        r = self._make()
        assert not hasattr(r, "rebalance_order")

    def test_to_dict_structure(self):
        r = self._make()
        d = r.to_dict()
        assert set(d.keys()) == {"fund_pf", "fund_holding_observations", "diagnostics"}

    def test_to_dict_fund_pf_is_dict(self):
        r = self._make(fund_pf=(("F1", 0.6), ("F2", 0.4)))
        d = r.to_dict()
        assert isinstance(d["fund_pf"], dict)
        assert "F1" in d["fund_pf"]

    def test_to_dict_observations_is_list(self):
        r = self._make()
        assert isinstance(r.to_dict()["fund_holding_observations"], list)

    def test_to_dict_json_serializable(self):
        import json
        r = _build([("F1", 0.5), ("F2", 0.5)], [_holding()])
        json.dumps(r.to_dict())


# ════════════════════════════════════════════════════════════════════════════
# 6. FundPfBuilder.build() — no holdings
# ════════════════════════════════════════════════════════════════════════════

class TestBuildNoHoldings:
    def test_no_holdings_fund_pf_equals_normalized_ideal(self):
        r = _build([("F1", 0.3), ("F2", 0.7)])
        weights = dict(r.fund_pf)
        assert math.isclose(weights["F1"], 0.3, abs_tol=1e-9)
        assert math.isclose(weights["F2"], 0.7, abs_tol=1e-9)

    def test_no_holdings_weight_sum_to_1(self):
        r = _build([("F1", 0.3), ("F2", 0.7)])
        assert math.isclose(_weight_sum(r.fund_pf), 1.0, abs_tol=1e-9)

    def test_empty_ideal_returns_empty_fund_pf(self):
        r = _build([])
        assert r.fund_pf == ()

    def test_no_holdings_observations_empty(self):
        r = _build([("F1", 1.0)])
        assert r.fund_holding_observations == ()

    def test_single_fund_weight_is_1(self):
        r = _build([("F1", 0.42)])
        assert math.isclose(dict(r.fund_pf)["F1"], 1.0, abs_tol=1e-9)

    def test_all_zero_weights_equal_fallback(self):
        r = _build([("F1", 0.0), ("F2", 0.0)])
        weights = dict(r.fund_pf)
        assert math.isclose(weights["F1"], 0.5, abs_tol=1e-9)
        assert math.isclose(weights["F2"], 0.5, abs_tol=1e-9)

    def test_negative_weight_clamped(self):
        r = _build([("F1", -0.5), ("F2", 1.0)])
        weights = dict(r.fund_pf)
        assert weights["F1"] == pytest.approx(0.0, abs=1e-9)
        assert weights["F2"] == pytest.approx(1.0, abs=1e-9)


# ════════════════════════════════════════════════════════════════════════════
# 7. FundPfBuilder.build() — holdings
# ════════════════════════════════════════════════════════════════════════════

class TestBuildWithHoldings:
    def test_observations_built_for_each_holding(self):
        holdings = [_holding("F1"), _holding("F2")]
        r = _build([("F1", 0.6), ("F2", 0.4)], holdings)
        assert len(r.fund_holding_observations) == 2

    def test_observation_fields_match_holding(self):
        h = FundHoldingInfo(fund_code="253710", current_weight=0.25, days_since_purchase=60)
        r = _build([("253710", 1.0)], [h])
        obs = r.fund_holding_observations[0]
        assert obs.fund_code == "253710"
        assert obs.current_weight == pytest.approx(0.25)
        assert obs.days_since_purchase == 60

    def test_duplicate_fund_code_first_wins(self):
        holdings = [
            _holding("F1", current_weight=0.20, days_since_purchase=30),
            _holding("F1", current_weight=0.10, days_since_purchase=60),
        ]
        r = _build([("F1", 1.0)], holdings)
        obs = {o.fund_code: o for o in r.fund_holding_observations}
        assert obs["F1"].current_weight == pytest.approx(0.20)
        assert len([o for o in r.fund_holding_observations if o.fund_code == "F1"]) == 1

    def test_duplicate_generates_diagnostic(self):
        holdings = [_holding("F1"), _holding("F1")]
        r = _build([("F1", 1.0)], holdings)
        assert any("duplicate" in d and "F1" in d for d in r.diagnostics)

    def test_input_quality_weight_sum_gt_1_diagnostic(self):
        holdings = [
            _holding("F1", current_weight=0.7),
            _holding("F2", current_weight=0.6),
        ]
        r = _build([("F1", 0.5), ("F2", 0.5)], holdings)
        assert any("current_weight sum" in d for d in r.diagnostics)

    def test_weight_sum_le_1_no_quality_diagnostic(self):
        holdings = [_holding("F1", current_weight=0.5), _holding("F2", current_weight=0.5)]
        r = _build([("F1", 0.5), ("F2", 0.5)], holdings)
        assert not any("current_weight sum" in d for d in r.diagnostics)


# ════════════════════════════════════════════════════════════════════════════
# 8. FundPfBuilder.build() — output ordering and correctness
# ════════════════════════════════════════════════════════════════════════════

class TestBuildOutput:
    def test_fund_pf_weight_sum_to_1(self):
        r = _build([("F1", 0.3), ("F2", 0.5), ("F3", 0.2)])
        assert math.isclose(_weight_sum(r.fund_pf), 1.0, abs_tol=1e-9)

    def test_fund_pf_sorted_weight_desc(self):
        r = _build([("F1", 0.2), ("F2", 0.5), ("F3", 0.3)])
        weights = [w for _, w in r.fund_pf]
        assert weights == sorted(weights, reverse=True)

    def test_fund_pf_sorted_code_asc_on_equal_weight(self):
        r = _build([("F2", 0.5), ("F1", 0.5)])
        codes = [c for c, _ in r.fund_pf]
        assert codes == ["F1", "F2"]

    def test_no_lock_diagnostic(self):
        holdings = [_holding("F1", current_weight=0.3, days_since_purchase=30)]
        r = _build([("F1", 1.0)], holdings)
        assert not any("is_lock_period_active" in d for d in r.diagnostics)

    def test_holdings_do_not_affect_fund_pf(self):
        # fund_pf is derived from fund_ideal_pf only (no lock constraint)
        r = _build([("F1", 0.3), ("F2", 0.7)], [_holding("F1", 0.9, 10)])
        weights = dict(r.fund_pf)
        assert math.isclose(weights["F1"], 0.3, abs_tol=1e-9)
        assert math.isclose(weights["F2"], 0.7, abs_tol=1e-9)


# ════════════════════════════════════════════════════════════════════════════
# 9. Diagnostics
# ════════════════════════════════════════════════════════════════════════════

class TestDiagnostics:
    def test_all_diagnostics_observation_prefix(self):
        holdings = [_holding("F1"), _holding("F1")]
        r = _build([("F1", 1.0)], holdings)
        for d in r.diagnostics:
            assert d.startswith("observation:")

    def test_no_diagnostics_for_normal_build(self):
        r = _build([("F1", 0.6), ("F2", 0.4)], [_holding("F1")])
        assert len(r.diagnostics) == 0


# ════════════════════════════════════════════════════════════════════════════
# 10. End-to-end
# ════════════════════════════════════════════════════════════════════════════

class TestEndToEnd:
    def test_e2e_with_holdings(self):
        holdings = [
            FundHoldingInfo(fund_code="253710", current_weight=0.30, days_since_purchase=45),
            FundHoldingInfo(fund_code="64311028", current_weight=0.20, days_since_purchase=90),
        ]
        r = _build(
            [("253710", 0.6), ("64311028", 0.4)],
            holdings,
        )
        assert math.isclose(_weight_sum(r.fund_pf), 1.0, abs_tol=1e-9)
        assert len(r.fund_holding_observations) == 2
        weights = dict(r.fund_pf)
        assert math.isclose(weights["253710"], 0.6, abs_tol=1e-9)
        assert math.isclose(weights["64311028"], 0.4, abs_tol=1e-9)
        # ロック diagnostic なし（投信はロック制約なし）
        assert not any("is_lock_period_active" in d for d in r.diagnostics)

    def test_e2e_empty_holdings(self):
        r = _build([("F1", 0.5), ("F2", 0.3), ("F3", 0.2)])
        assert math.isclose(_weight_sum(r.fund_pf), 1.0, abs_tol=1e-9)
        assert r.fund_holding_observations == ()
        weights = [w for _, w in r.fund_pf]
        assert weights == sorted(weights, reverse=True)

    def test_e2e_to_dict_complete(self):
        import json
        holdings = [FundHoldingInfo("F1", 0.5, 30)]
        r = _build([("F1", 0.7), ("F2", 0.3)], holdings)
        d = r.to_dict()
        assert "F1" in d["fund_pf"]
        assert len(d["fund_holding_observations"]) == 1
        json.dumps(d)
