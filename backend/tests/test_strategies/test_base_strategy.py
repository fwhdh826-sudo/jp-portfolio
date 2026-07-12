"""
test_base_strategy.py — Card 7-1
BaseStrategy / StrategyInput / StrategyOutput のユニットテスト。
"""
import math
import pytest

from engine.strategies.base_strategy import (
    VALID_STRATEGY_IDS,
    validate_strategy_id,
    StrategyInput,
    StrategyOutput,
    BaseStrategy,
    _safe_float,
    _safe_int,
    _clamp,
    _normalize_ideal_pf,
)


# ── テスト用 ConcreteStrategy ─────────────────────────────────────────────────

class _FrontierStub(BaseStrategy):
    """テスト専用最小実装。STRATEGY_ID は VALID_STRATEGY_IDS の "frontier" を使用。"""
    STRATEGY_ID   = "frontier"
    STRATEGY_NAME = "Frontier Stub"

    def compute(self, strategy_input: StrategyInput) -> StrategyOutput:
        n = len(strategy_input.universe)
        if n == 0:
            weights: dict[str, float] = {}
        else:
            eq = 1.0 / n
            weights = {t: eq for t in strategy_input.universe}

        normalized = self._normalize_weights(weights)
        pf = self._to_ideal_pf_tuple(normalized)
        return StrategyOutput(
            strategy_id=self.STRATEGY_ID,
            strategy_name=self.STRATEGY_NAME,
            ideal_pf=pf,
            expected_return=0.08,
            expected_vol=0.12,
            sharpe_ratio=0.67,
            max_dd_estimate=-0.15,
            rationale="equal-weight stub for testing",
        )


# ── helper tests ──────────────────────────────────────────────────────────────

class TestSafeFloat:
    def test_none_returns_fallback(self):
        assert _safe_float(None, 9.9) == pytest.approx(9.9)

    def test_str_returns_fallback(self):
        assert _safe_float("abc") == pytest.approx(0.0)

    def test_nan_returns_fallback(self):
        assert _safe_float(float("nan")) == pytest.approx(0.0)

    def test_inf_returns_fallback(self):
        assert _safe_float(float("inf")) == pytest.approx(0.0)

    def test_neg_inf_returns_fallback(self):
        assert _safe_float(float("-inf")) == pytest.approx(0.0)

    def test_valid_float(self):
        assert _safe_float(3.14) == pytest.approx(3.14)

    def test_int_converts(self):
        assert _safe_float(5) == pytest.approx(5.0)

    def test_default_fallback_zero(self):
        assert _safe_float(None) == pytest.approx(0.0)

    def test_custom_fallback(self):
        assert _safe_float(float("nan"), 50.0) == pytest.approx(50.0)


class TestSafeInt:
    def test_none_returns_fallback(self):
        assert _safe_int(None, -1) == -1

    def test_str_returns_fallback(self):
        assert _safe_int("abc") == 0

    def test_nan_returns_fallback(self):
        assert _safe_int(float("nan"), -1) == -1

    def test_inf_returns_fallback(self):
        assert _safe_int(float("inf"), 0) == 0

    def test_float_truncates(self):
        assert _safe_int(3.9) == 3

    def test_valid_int(self):
        assert _safe_int(7) == 7

    def test_default_fallback_zero(self):
        assert _safe_int(None) == 0


class TestClamp:
    def test_below_min(self):
        assert _clamp(-1.0, 0.0, 10.0) == pytest.approx(0.0)

    def test_above_max(self):
        assert _clamp(15.0, 0.0, 10.0) == pytest.approx(10.0)

    def test_in_range(self):
        assert _clamp(5.0, 0.0, 10.0) == pytest.approx(5.0)

    def test_boundary_min(self):
        assert _clamp(0.0, 0.0, 10.0) == pytest.approx(0.0)

    def test_boundary_max(self):
        assert _clamp(10.0, 0.0, 10.0) == pytest.approx(10.0)


# ── validate_strategy_id tests ────────────────────────────────────────────────

class TestValidateStrategyId:
    def test_frontier_valid(self):
        assert validate_strategy_id("frontier") is True

    def test_quality_size_valid(self):
        assert validate_strategy_id("quality_size") is True

    def test_fundamental_valid(self):
        assert validate_strategy_id("fundamental") is True

    def test_cross_factor_valid(self):
        assert validate_strategy_id("cross_factor") is True

    def test_unknown_id_invalid(self):
        assert validate_strategy_id("unknown") is False

    def test_empty_string_invalid(self):
        assert validate_strategy_id("") is False

    def test_none_invalid(self):
        assert validate_strategy_id(None) is False  # type: ignore[arg-type]

    def test_stub_not_in_valid(self):
        # "stub" は VALID_STRATEGY_IDS に含まれない
        assert validate_strategy_id("stub") is False


class TestValidStrategyIds:
    def test_contains_four_ids(self):
        assert len(VALID_STRATEGY_IDS) == 4

    def test_all_four_present(self):
        assert "frontier"     in VALID_STRATEGY_IDS
        assert "quality_size" in VALID_STRATEGY_IDS
        assert "fundamental"  in VALID_STRATEGY_IDS
        assert "cross_factor" in VALID_STRATEGY_IDS


# ── StrategyInput tests ───────────────────────────────────────────────────────

class TestStrategyInput:
    def _base(self, **kwargs):
        defaults = dict(
            universe=("7203.T", "6758.T"),
            scores={"7203.T": {"value": 70.0}, "6758.T": {"value": 60.0}},
            regime="bull_calm",
        )
        defaults.update(kwargs)
        return StrategyInput(**defaults)

    def test_frozen(self):
        si = self._base()
        with pytest.raises((AttributeError, TypeError)):
            si.regime = "bear"  # type: ignore[misc]

    def test_universe_list_converted_to_tuple(self):
        si = StrategyInput(
            universe=["7203.T", "6758.T"],
            scores={},
            regime="bull_calm",
        )
        assert isinstance(si.universe, tuple)

    def test_universe_empty_string_excluded(self):
        si = StrategyInput(
            universe=["7203.T", "", "6758.T", ""],
            scores={},
            regime="bull_calm",
        )
        assert "" not in si.universe
        assert "7203.T" in si.universe
        assert "6758.T" in si.universe

    def test_universe_all_empty_gives_empty_tuple(self):
        si = StrategyInput(universe=["", ""], scores={}, regime="bull_calm")
        assert si.universe == ()

    def test_universe_tuple_input_preserved(self):
        si = StrategyInput(
            universe=("9984.T", "4063.T"),
            scores={},
            regime="bear",
        )
        assert si.universe == ("9984.T", "4063.T")

    def test_context_default_empty_dict(self):
        si = self._base()
        assert si.context == {}

    def test_context_not_shared_between_instances(self):
        si1 = self._base()
        si2 = self._base()
        assert si1.context is not si2.context

    def test_horizon_default_long_term(self):
        si = self._base()
        assert si.horizon == "long_term"

    def test_horizon_short_term(self):
        si = self._base(horizon="short_term")
        assert si.horizon == "short_term"

    def test_scores_accessible(self):
        scores = {"7203.T": {"value": 75.0}}
        si = self._base(scores=scores)
        assert si.scores["7203.T"]["value"] == pytest.approx(75.0)

    def test_empty_universe(self):
        si = StrategyInput(universe=(), scores={}, regime="crisis")
        assert si.universe == ()


# ── StrategyOutput tests ──────────────────────────────────────────────────────

class TestStrategyOutput:
    def _base(self, **kwargs):
        defaults = dict(
            strategy_id="frontier",
            strategy_name="Frontier",
            ideal_pf=(("7203.T", 0.6), ("6758.T", 0.4)),
            expected_return=0.08,
            expected_vol=0.12,
            sharpe_ratio=0.67,
            max_dd_estimate=-0.15,
            rationale="test",
        )
        defaults.update(kwargs)
        return StrategyOutput(**defaults)

    def test_frozen(self):
        so = self._base()
        with pytest.raises((AttributeError, TypeError)):
            so.strategy_id = "bear"  # type: ignore[misc]

    def test_ideal_pf_is_tuple_of_tuples(self):
        so = self._base()
        assert isinstance(so.ideal_pf, tuple)
        for item in so.ideal_pf:
            assert isinstance(item, tuple)
            assert len(item) == 2

    def test_ideal_pf_from_dict_input(self):
        so = StrategyOutput(
            strategy_id="frontier",
            strategy_name="Frontier",
            ideal_pf={"7203.T": 0.6, "6758.T": 0.4},  # type: ignore[arg-type]
            expected_return=0.08,
            expected_vol=0.12,
            sharpe_ratio=0.67,
            max_dd_estimate=-0.15,
            rationale="test",
        )
        assert isinstance(so.ideal_pf, tuple)
        d = dict(so.ideal_pf)
        assert d["7203.T"] == pytest.approx(0.6)
        assert d["6758.T"] == pytest.approx(0.4)

    def test_ideal_pf_from_list_input(self):
        so = StrategyOutput(
            strategy_id="frontier",
            strategy_name="Frontier",
            ideal_pf=[("7203.T", 0.5), ("6758.T", 0.5)],  # type: ignore[arg-type]
            expected_return=0.08,
            expected_vol=0.12,
            sharpe_ratio=0.67,
            max_dd_estimate=-0.15,
            rationale="test",
        )
        assert isinstance(so.ideal_pf, tuple)

    def test_ideal_pf_nan_weight_becomes_zero(self):
        so = StrategyOutput(
            strategy_id="frontier",
            strategy_name="Frontier",
            ideal_pf={"7203.T": float("nan"), "6758.T": 0.5},  # type: ignore[arg-type]
            expected_return=0.0,
            expected_vol=0.0,
            sharpe_ratio=0.0,
            max_dd_estimate=0.0,
            rationale="test",
        )
        d = dict(so.ideal_pf)
        assert d["7203.T"] == pytest.approx(0.0)

    def test_ideal_pf_inf_weight_becomes_zero(self):
        so = StrategyOutput(
            strategy_id="frontier",
            strategy_name="Frontier",
            ideal_pf={"7203.T": float("inf")},  # type: ignore[arg-type]
            expected_return=0.0,
            expected_vol=0.0,
            sharpe_ratio=0.0,
            max_dd_estimate=0.0,
            rationale="test",
        )
        assert dict(so.ideal_pf)["7203.T"] == pytest.approx(0.0)

    def test_ideal_pf_str_weight_becomes_zero(self):
        so = StrategyOutput(
            strategy_id="frontier",
            strategy_name="Frontier",
            ideal_pf={"7203.T": "bad"},  # type: ignore[arg-type]
            expected_return=0.0,
            expected_vol=0.0,
            sharpe_ratio=0.0,
            max_dd_estimate=0.0,
            rationale="test",
        )
        assert dict(so.ideal_pf)["7203.T"] == pytest.approx(0.0)

    def test_ideal_pf_none_weight_becomes_zero(self):
        so = StrategyOutput(
            strategy_id="frontier",
            strategy_name="Frontier",
            ideal_pf={"7203.T": None},  # type: ignore[arg-type]
            expected_return=0.0,
            expected_vol=0.0,
            sharpe_ratio=0.0,
            max_dd_estimate=0.0,
            rationale="test",
        )
        assert dict(so.ideal_pf)["7203.T"] == pytest.approx(0.0)

    def test_ideal_pf_negative_weight_clamped_to_zero(self):
        so = StrategyOutput(
            strategy_id="frontier",
            strategy_name="Frontier",
            ideal_pf={"7203.T": -0.5},  # type: ignore[arg-type]
            expected_return=0.0,
            expected_vol=0.0,
            sharpe_ratio=0.0,
            max_dd_estimate=0.0,
            rationale="test",
        )
        assert dict(so.ideal_pf)["7203.T"] == pytest.approx(0.0)

    def test_expected_vol_negative_clamped_to_zero(self):
        so = self._base(expected_vol=-0.5)
        assert so.expected_vol == pytest.approx(0.0)

    def test_expected_vol_nan_becomes_zero(self):
        so = self._base(expected_vol=float("nan"))
        assert so.expected_vol == pytest.approx(0.0)

    def test_max_dd_estimate_positive_clamped_to_zero(self):
        so = self._base(max_dd_estimate=0.05)
        assert so.max_dd_estimate == pytest.approx(0.0)

    def test_max_dd_estimate_negative_preserved(self):
        so = self._base(max_dd_estimate=-0.15)
        assert so.max_dd_estimate == pytest.approx(-0.15)

    def test_max_dd_estimate_nan_becomes_zero(self):
        so = self._base(max_dd_estimate=float("nan"))
        assert so.max_dd_estimate == pytest.approx(0.0)

    def test_expected_return_safe_float(self):
        so = self._base(expected_return=float("nan"))
        assert so.expected_return == pytest.approx(0.0)

    def test_sharpe_ratio_safe_float(self):
        so = self._base(sharpe_ratio=float("inf"))
        assert so.sharpe_ratio == pytest.approx(0.0)

    def test_diagnostics_default_empty_tuple(self):
        so = self._base()
        assert so.diagnostics == ()

    def test_diagnostics_list_converted_to_tuple(self):
        so = self._base(diagnostics=["note1", "note2"])  # type: ignore[arg-type]
        assert isinstance(so.diagnostics, tuple)
        assert so.diagnostics == ("note1", "note2")

    def test_to_dict_keys(self):
        so = self._base()
        d = so.to_dict()
        assert set(d.keys()) == {
            "strategy_id", "strategy_name", "ideal_pf",
            "expected_return", "expected_vol", "sharpe_ratio",
            "max_dd_estimate", "rationale", "diagnostics",
        }

    def test_to_dict_ideal_pf_is_dict(self):
        so = self._base()
        assert isinstance(so.to_dict()["ideal_pf"], dict)

    def test_to_dict_diagnostics_is_list(self):
        so = self._base(diagnostics=("a", "b"))
        assert isinstance(so.to_dict()["diagnostics"], list)

    def test_to_dict_json_serializable(self):
        import json
        so = self._base(diagnostics=("obs1",))
        json.dumps(so.to_dict())  # no exception

    def test_ideal_pf_as_dict_returns_dict(self):
        so = self._base()
        d = so._ideal_pf_as_dict()
        assert isinstance(d, dict)
        assert d["7203.T"] == pytest.approx(0.6)
        assert d["6758.T"] == pytest.approx(0.4)

    def test_no_forbidden_fields(self):
        forbidden = {
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "verdict", "decision", "rating",
            "approve", "reject", "conditional", "final_verdict",
            "order", "amount", "entry_price", "stop_loss", "take_profit",
        }
        so = self._base()
        for f in forbidden:
            assert not hasattr(so, f), f"Forbidden field found: {f}"

    def test_strategy_id_stored(self):
        so = self._base(strategy_id="quality_size")
        assert so.strategy_id == "quality_size"


# ── BaseStrategy ABC tests ────────────────────────────────────────────────────

class TestBaseStrategyABC:
    def test_cannot_instantiate_directly(self):
        with pytest.raises(TypeError):
            BaseStrategy()  # type: ignore[abstract]

    def test_concrete_without_compute_raises(self):
        class _NakedStrategy(BaseStrategy):
            STRATEGY_ID = "frontier"
            STRATEGY_NAME = "Naked"
            # compute() を実装しない
        with pytest.raises(TypeError):
            _NakedStrategy()  # type: ignore[abstract]


# ── StubStrategy (FrontierStub) tests ─────────────────────────────────────────

class TestStubStrategy:
    @pytest.fixture
    def strat(self):
        return _FrontierStub()

    def _base_input(self, **kwargs):
        defaults = dict(
            universe=("7203.T", "6758.T", "9984.T"),
            scores={
                "7203.T": {"value": 70.0},
                "6758.T": {"value": 60.0},
                "9984.T": {"value": 80.0},
            },
            regime="bull_calm",
        )
        defaults.update(kwargs)
        return StrategyInput(**defaults)

    def test_compute_returns_strategy_output(self, strat):
        result = strat.compute(self._base_input())
        assert isinstance(result, StrategyOutput)

    def test_strategy_id_is_valid(self, strat):
        assert strat.STRATEGY_ID in VALID_STRATEGY_IDS

    def test_strategy_id_is_not_stub(self, strat):
        assert strat.STRATEGY_ID != "stub"

    def test_compute_strategy_id_matches_class(self, strat):
        result = strat.compute(self._base_input())
        assert result.strategy_id == strat.STRATEGY_ID

    def test_compute_ideal_pf_is_tuple(self, strat):
        result = strat.compute(self._base_input())
        assert isinstance(result.ideal_pf, tuple)

    def test_compute_ideal_pf_weight_sum_approx_one(self, strat):
        result = strat.compute(self._base_input())
        total = sum(w for _, w in result.ideal_pf)
        assert total == pytest.approx(1.0, abs=1e-9)

    def test_compute_all_tickers_present(self, strat):
        result = strat.compute(self._base_input())
        tickers = {t for t, _ in result.ideal_pf}
        assert tickers == {"7203.T", "6758.T", "9984.T"}

    def test_compute_empty_universe(self, strat):
        result = strat.compute(StrategyInput(universe=(), scores={}, regime="bull_calm"))
        assert result.ideal_pf == ()

    def test_helper_safe_float_accessible(self, strat):
        assert strat._safe_float(None) == pytest.approx(0.0)
        assert strat._safe_float(3.14) == pytest.approx(3.14)

    def test_helper_safe_int_accessible(self, strat):
        assert strat._safe_int(None) == 0
        assert strat._safe_int(5) == 5

    def test_helper_clamp_accessible(self, strat):
        assert strat._clamp(15.0, 0.0, 10.0) == pytest.approx(10.0)

    def test_is_valid_strategy_id_true(self, strat):
        assert strat._is_valid_strategy_id("frontier") is True

    def test_is_valid_strategy_id_false(self, strat):
        assert strat._is_valid_strategy_id("unknown") is False


# ── _normalize_weights tests ──────────────────────────────────────────────────

class TestNormalizeWeights:
    @pytest.fixture
    def strat(self):
        return _FrontierStub()

    def test_normalizes_to_sum_one(self, strat):
        w = {"A": 2.0, "B": 3.0}
        result = strat._normalize_weights(w)
        assert sum(result.values()) == pytest.approx(1.0)
        assert result["A"] == pytest.approx(0.4)
        assert result["B"] == pytest.approx(0.6)

    def test_all_zero_becomes_equal_weight(self, strat):
        w = {"A": 0.0, "B": 0.0, "C": 0.0}
        result = strat._normalize_weights(w)
        assert sum(result.values()) == pytest.approx(1.0)
        for v in result.values():
            assert v == pytest.approx(1.0 / 3)

    def test_empty_returns_empty_dict(self, strat):
        assert strat._normalize_weights({}) == {}

    def test_nan_weight_treated_as_zero(self, strat):
        w = {"A": float("nan"), "B": 2.0}
        result = strat._normalize_weights(w)
        assert result["A"] == pytest.approx(0.0)
        assert result["B"] == pytest.approx(1.0)

    def test_inf_weight_treated_as_zero(self, strat):
        w = {"A": float("inf"), "B": 1.0}
        result = strat._normalize_weights(w)
        assert result["A"] == pytest.approx(0.0)
        assert result["B"] == pytest.approx(1.0)

    def test_negative_weight_treated_as_zero(self, strat):
        w = {"A": -1.0, "B": 1.0}
        result = strat._normalize_weights(w)
        assert result["A"] == pytest.approx(0.0)
        assert result["B"] == pytest.approx(1.0)

    def test_single_ticker(self, strat):
        result = strat._normalize_weights({"X": 5.0})
        assert result == {"X": pytest.approx(1.0)}

    def test_all_nan_becomes_equal_weight(self, strat):
        w = {"A": float("nan"), "B": float("nan")}
        result = strat._normalize_weights(w)
        assert sum(result.values()) == pytest.approx(1.0)


# ── _to_ideal_pf_tuple tests ──────────────────────────────────────────────────

class TestToIdealPfTuple:
    @pytest.fixture
    def strat(self):
        return _FrontierStub()

    def test_returns_tuple(self, strat):
        result = strat._to_ideal_pf_tuple({"A": 0.5, "B": 0.5})
        assert isinstance(result, tuple)

    def test_each_element_is_tuple_pair(self, strat):
        result = strat._to_ideal_pf_tuple({"A": 0.6, "B": 0.4})
        for item in result:
            assert isinstance(item, tuple)
            assert len(item) == 2

    def test_weights_preserved(self, strat):
        result = strat._to_ideal_pf_tuple({"A": 0.6, "B": 0.4})
        d = dict(result)
        assert d["A"] == pytest.approx(0.6)
        assert d["B"] == pytest.approx(0.4)

    def test_negative_weight_clamped_to_zero(self, strat):
        result = strat._to_ideal_pf_tuple({"A": -0.3})
        assert dict(result)["A"] == pytest.approx(0.0)

    def test_nan_weight_becomes_zero(self, strat):
        result = strat._to_ideal_pf_tuple({"A": float("nan")})
        assert dict(result)["A"] == pytest.approx(0.0)

    def test_does_not_normalize_to_one(self, strat):
        # _to_ideal_pf_tuple は正規化しない
        result = strat._to_ideal_pf_tuple({"A": 0.3, "B": 0.3})
        total = sum(w for _, w in result)
        assert total == pytest.approx(0.6)

    def test_empty_dict_returns_empty_tuple(self, strat):
        assert strat._to_ideal_pf_tuple({}) == ()

    def test_insertion_order_preserved(self, strat):
        d = {"C": 0.3, "A": 0.5, "B": 0.2}
        result = strat._to_ideal_pf_tuple(d)
        tickers = [t for t, _ in result]
        assert tickers == ["C", "A", "B"]


# ── no forbidden imports test ─────────────────────────────────────────────────

class TestNoForbiddenImports:
    def test_no_forbidden_modules(self):
        import engine.strategies.base_strategy as mod
        import sys
        src = open(mod.__file__).read()
        forbidden_imports = [
            "import pandas", "import numpy", "import scipy",
            "import requests", "import httpx", "import aiohttp",
            "from openai", "from anthropic", "import litellm", "import ollama",
        ]
        for fi in forbidden_imports:
            assert fi not in src, f"Forbidden import found: {fi}"

    def test_no_cross_imports(self):
        import engine.strategies.base_strategy as mod
        src = open(mod.__file__).read()
        forbidden_mods = ["engine.operation", "engine.market_intel", "engine.news", "engine.regime"]
        for fm in forbidden_mods:
            assert f"import {fm}" not in src
            assert f"from {fm}" not in src
