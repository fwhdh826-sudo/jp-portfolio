"""
test_splitter.py — Card 7-7
Phase 7: PortfolioSplitter / SplitInput / SplitResult のテスト。
"""
import math
import pytest

from engine.portfolio.splitter import (
    SplitInput,
    SplitResult,
    PortfolioSplitter,
)


# ── helpers ───────────────────────────────────────────────────────────────────

def _make_input(pf, equity=None, fund=None):
    return SplitInput(
        aggregated_ideal_pf=tuple(pf),
        equity_universe=frozenset(equity or []),
        fund_universe=frozenset(fund or []),
    )


def _weight_sum(pf_tuple):
    return sum(w for _, w in pf_tuple)


SPLITTER = PortfolioSplitter()


# ════════════════════════════════════════════════════════════════════════════
# 1. Module constants / imports
# ════════════════════════════════════════════════════════════════════════════

class TestModuleImports:
    def test_split_input_importable(self):
        assert SplitInput is not None

    def test_split_result_importable(self):
        assert SplitResult is not None

    def test_portfolio_splitter_importable(self):
        assert PortfolioSplitter is not None

    def test_stdlib_only_no_numpy(self):
        import engine.portfolio.splitter as m
        src = open(m.__file__).read()
        assert "import numpy" not in src
        assert "import pandas" not in src
        assert "import scipy" not in src

    def test_no_http_import(self):
        import engine.portfolio.splitter as m
        src = open(m.__file__).read()
        assert "requests" not in src
        assert "httpx" not in src
        assert "urllib.request" not in src


# ════════════════════════════════════════════════════════════════════════════
# 2. SplitInput
# ════════════════════════════════════════════════════════════════════════════

class TestSplitInput:
    def test_frozen(self):
        si = _make_input([("A", 0.5)], equity=["A"])
        with pytest.raises((AttributeError, TypeError)):
            si.aggregated_ideal_pf = ()  # type: ignore[misc]

    def test_aggregated_ideal_pf_is_tuple(self):
        si = _make_input([("A", 0.5)], equity=["A"])
        assert isinstance(si.aggregated_ideal_pf, tuple)

    def test_list_aggregated_converted_to_tuple(self):
        si = SplitInput(
            aggregated_ideal_pf=[("A", 0.5), ("B", 0.5)],  # type: ignore[arg-type]
            equity_universe=frozenset(["A"]),
            fund_universe=frozenset(["B"]),
        )
        assert isinstance(si.aggregated_ideal_pf, tuple)

    def test_equity_universe_set_to_frozenset(self):
        si = SplitInput(
            aggregated_ideal_pf=(("A", 1.0),),
            equity_universe={"A"},  # type: ignore[arg-type]
            fund_universe=frozenset(),
        )
        assert isinstance(si.equity_universe, frozenset)

    def test_fund_universe_set_to_frozenset(self):
        si = SplitInput(
            aggregated_ideal_pf=(("F1", 1.0),),
            equity_universe=frozenset(),
            fund_universe={"F1"},  # type: ignore[arg-type]
        )
        assert isinstance(si.fund_universe, frozenset)

    def test_accepts_frozenset_directly(self):
        si = _make_input([("A", 1.0)], equity=["A"])
        assert isinstance(si.equity_universe, frozenset)
        assert isinstance(si.fund_universe, frozenset)

    def test_no_action_field(self):
        si = _make_input([("A", 1.0)], equity=["A"])
        assert not hasattr(si, "action")

    def test_no_recommendation_field(self):
        si = _make_input([("A", 1.0)], equity=["A"])
        assert not hasattr(si, "recommendation")

    def test_no_verdict_field(self):
        si = _make_input([("A", 1.0)], equity=["A"])
        assert not hasattr(si, "verdict")


# ════════════════════════════════════════════════════════════════════════════
# 3. SplitResult
# ════════════════════════════════════════════════════════════════════════════

class TestSplitResult:
    def _make_result(self, **kwargs):
        defaults = dict(
            equity_ideal_pf=(("A", 1.0),),
            fund_ideal_pf=(),
            unclassified_tickers=(),
            diagnostics=(),
        )
        defaults.update(kwargs)
        return SplitResult(**defaults)

    def test_frozen(self):
        r = self._make_result()
        with pytest.raises((AttributeError, TypeError)):
            r.equity_ideal_pf = ()  # type: ignore[misc]

    def test_has_equity_ideal_pf(self):
        r = self._make_result()
        assert hasattr(r, "equity_ideal_pf")

    def test_has_fund_ideal_pf(self):
        r = self._make_result()
        assert hasattr(r, "fund_ideal_pf")

    def test_has_unclassified_tickers(self):
        r = self._make_result()
        assert hasattr(r, "unclassified_tickers")

    def test_diagnostics_defaults_empty(self):
        r = SplitResult(
            equity_ideal_pf=(),
            fund_ideal_pf=(),
            unclassified_tickers=(),
        )
        assert r.diagnostics == ()

    def test_no_action_field(self):
        r = self._make_result()
        assert not hasattr(r, "action")

    def test_no_recommendation_field(self):
        r = self._make_result()
        assert not hasattr(r, "recommendation")

    def test_no_is_buy_field(self):
        r = self._make_result()
        assert not hasattr(r, "is_buy")

    def test_no_is_sell_field(self):
        r = self._make_result()
        assert not hasattr(r, "is_sell")

    def test_no_verdict_field(self):
        r = self._make_result()
        assert not hasattr(r, "verdict")

    def test_no_order_field(self):
        r = self._make_result()
        assert not hasattr(r, "order")

    def test_to_dict_is_dict(self):
        r = self._make_result()
        assert isinstance(r.to_dict(), dict)

    def test_to_dict_keys(self):
        r = self._make_result()
        d = r.to_dict()
        assert set(d.keys()) == {
            "equity_ideal_pf", "fund_ideal_pf",
            "unclassified_tickers", "diagnostics",
        }

    def test_to_dict_equity_is_dict(self):
        r = self._make_result(equity_ideal_pf=(("A", 0.6), ("B", 0.4)))
        d = r.to_dict()
        assert isinstance(d["equity_ideal_pf"], dict)
        assert "A" in d["equity_ideal_pf"]

    def test_to_dict_unclassified_is_list(self):
        r = self._make_result(unclassified_tickers=("X",))
        d = r.to_dict()
        assert isinstance(d["unclassified_tickers"], list)


# ════════════════════════════════════════════════════════════════════════════
# 4. PortfolioSplitter — classification
# ════════════════════════════════════════════════════════════════════════════

class TestSplitClassification:
    def test_all_equity(self):
        si = _make_input([("A", 0.6), ("B", 0.4)], equity=["A", "B"])
        r = SPLITTER.split(si)
        tickers = {t for t, _ in r.equity_ideal_pf}
        assert tickers == {"A", "B"}
        assert r.fund_ideal_pf == ()
        assert r.unclassified_tickers == ()

    def test_all_fund(self):
        si = _make_input([("F1", 0.7), ("F2", 0.3)], fund=["F1", "F2"])
        r = SPLITTER.split(si)
        assert r.equity_ideal_pf == ()
        tickers = {t for t, _ in r.fund_ideal_pf}
        assert tickers == {"F1", "F2"}
        assert r.unclassified_tickers == ()

    def test_mixed_equity_and_fund(self):
        si = _make_input(
            [("A", 0.5), ("F1", 0.5)],
            equity=["A"], fund=["F1"],
        )
        r = SPLITTER.split(si)
        assert any(t == "A" for t, _ in r.equity_ideal_pf)
        assert any(t == "F1" for t, _ in r.fund_ideal_pf)

    def test_unclassified_ticker(self):
        si = _make_input([("X", 0.5), ("A", 0.5)], equity=["A"])
        r = SPLITTER.split(si)
        assert "X" in r.unclassified_tickers
        assert "A" not in r.unclassified_tickers

    def test_equity_priority_when_in_both(self):
        # P2-7U: ticker in both → equity wins
        si = _make_input([("DUAL", 1.0)], equity=["DUAL"], fund=["DUAL"])
        r = SPLITTER.split(si)
        assert any(t == "DUAL" for t, _ in r.equity_ideal_pf)
        assert not any(t == "DUAL" for t, _ in r.fund_ideal_pf)

    def test_equity_priority_generates_diagnostic(self):
        si = _make_input([("DUAL", 1.0)], equity=["DUAL"], fund=["DUAL"])
        r = SPLITTER.split(si)
        assert any("P2-7U" in d and "DUAL" in d for d in r.diagnostics)

    def test_unclassified_generates_diagnostic(self):
        si = _make_input([("X", 1.0)], equity=["A"])
        r = SPLITTER.split(si)
        assert any("X" in d and "unclassified" in d for d in r.diagnostics)

    def test_no_diagnostic_for_normal_equity(self):
        si = _make_input([("A", 0.6), ("B", 0.4)], equity=["A", "B"])
        r = SPLITTER.split(si)
        assert len(r.diagnostics) == 0

    def test_multiple_unclassified(self):
        si = _make_input([("X", 0.3), ("Y", 0.3), ("A", 0.4)], equity=["A"])
        r = SPLITTER.split(si)
        assert "X" in r.unclassified_tickers
        assert "Y" in r.unclassified_tickers


# ════════════════════════════════════════════════════════════════════════════
# 5. PortfolioSplitter — renormalization
# ════════════════════════════════════════════════════════════════════════════

class TestSplitRenormalization:
    def test_equity_weights_sum_to_1(self):
        si = _make_input([("A", 0.3), ("B", 0.7)], equity=["A", "B"])
        r = SPLITTER.split(si)
        assert math.isclose(_weight_sum(r.equity_ideal_pf), 1.0, abs_tol=1e-9)

    def test_fund_weights_sum_to_1(self):
        si = _make_input([("F1", 0.2), ("F2", 0.8)], fund=["F1", "F2"])
        r = SPLITTER.split(si)
        assert math.isclose(_weight_sum(r.fund_ideal_pf), 1.0, abs_tol=1e-9)

    def test_equity_and_fund_renormalized_independently(self):
        # equity: A=0.3, fund: F1=0.7 → each renormalizes to 1.0 independently
        si = _make_input(
            [("A", 0.3), ("F1", 0.7)],
            equity=["A"], fund=["F1"],
        )
        r = SPLITTER.split(si)
        assert math.isclose(_weight_sum(r.equity_ideal_pf), 1.0, abs_tol=1e-9)
        assert math.isclose(_weight_sum(r.fund_ideal_pf), 1.0, abs_tol=1e-9)
        # equity: A=1.0, fund: F1=1.0 (each is 100% of its subset)
        assert math.isclose(dict(r.equity_ideal_pf)["A"], 1.0, abs_tol=1e-9)
        assert math.isclose(dict(r.fund_ideal_pf)["F1"], 1.0, abs_tol=1e-9)

    def test_empty_equity_returns_empty_tuple(self):
        si = _make_input([("F1", 1.0)], fund=["F1"])
        r = SPLITTER.split(si)
        assert r.equity_ideal_pf == ()

    def test_empty_fund_returns_empty_tuple(self):
        si = _make_input([("A", 1.0)], equity=["A"])
        r = SPLITTER.split(si)
        assert r.fund_ideal_pf == ()

    def test_all_zero_equity_weight_equal_weight_fallback(self):
        si = _make_input([("A", 0.0), ("B", 0.0)], equity=["A", "B"])
        r = SPLITTER.split(si)
        weights = dict(r.equity_ideal_pf)
        assert math.isclose(weights["A"], 0.5, abs_tol=1e-9)
        assert math.isclose(weights["B"], 0.5, abs_tol=1e-9)

    def test_all_zero_fund_weight_equal_weight_fallback(self):
        si = _make_input([("F1", 0.0), ("F2", 0.0)], fund=["F1", "F2"])
        r = SPLITTER.split(si)
        weights = dict(r.fund_ideal_pf)
        assert math.isclose(weights["F1"], 0.5, abs_tol=1e-9)
        assert math.isclose(weights["F2"], 0.5, abs_tol=1e-9)


# ════════════════════════════════════════════════════════════════════════════
# 6. PortfolioSplitter — ordering
# ════════════════════════════════════════════════════════════════════════════

class TestSplitOrdering:
    def test_equity_sorted_weight_desc(self):
        si = _make_input([("A", 0.3), ("B", 0.7)], equity=["A", "B"])
        r = SPLITTER.split(si)
        weights = [w for _, w in r.equity_ideal_pf]
        assert weights == sorted(weights, reverse=True)

    def test_equity_ticker_asc_on_equal_weight(self):
        # After renorm both are 0.5 each
        si = _make_input([("B", 0.5), ("A", 0.5)], equity=["A", "B"])
        r = SPLITTER.split(si)
        tickers = [t for t, _ in r.equity_ideal_pf]
        assert tickers == ["A", "B"]

    def test_fund_sorted_weight_desc(self):
        si = _make_input([("F1", 0.2), ("F2", 0.3), ("F3", 0.5)], fund=["F1", "F2", "F3"])
        r = SPLITTER.split(si)
        weights = [w for _, w in r.fund_ideal_pf]
        assert weights == sorted(weights, reverse=True)

    def test_fund_ticker_asc_on_equal_weight(self):
        si = _make_input([("F2", 0.5), ("F1", 0.5)], fund=["F1", "F2"])
        r = SPLITTER.split(si)
        tickers = [t for t, _ in r.fund_ideal_pf]
        assert tickers == ["F1", "F2"]


# ════════════════════════════════════════════════════════════════════════════
# 7. PortfolioSplitter — edge cases
# ════════════════════════════════════════════════════════════════════════════

class TestSplitEdgeCases:
    def test_empty_aggregated_ideal_pf(self):
        si = _make_input([], equity=["A"], fund=["F1"])
        r = SPLITTER.split(si)
        assert r.equity_ideal_pf == ()
        assert r.fund_ideal_pf == ()
        assert r.unclassified_tickers == ()

    def test_all_unclassified(self):
        si = _make_input([("X", 0.5), ("Y", 0.5)])
        r = SPLITTER.split(si)
        assert r.equity_ideal_pf == ()
        assert r.fund_ideal_pf == ()
        assert len(r.unclassified_tickers) == 2

    def test_negative_weight_clamped_to_zero(self):
        si = _make_input([("A", -0.5), ("B", 1.0)], equity=["A", "B"])
        r = SPLITTER.split(si)
        weights = dict(r.equity_ideal_pf)
        assert weights["A"] == pytest.approx(0.0, abs=1e-9)
        assert weights["B"] == pytest.approx(1.0, abs=1e-9)

    def test_none_weight_clamped_to_zero(self):
        si = SplitInput(
            aggregated_ideal_pf=(("A", None), ("B", 0.5)),  # type: ignore[arg-type]
            equity_universe=frozenset(["A", "B"]),
            fund_universe=frozenset(),
        )
        r = SPLITTER.split(si)
        weights = dict(r.equity_ideal_pf)
        assert weights["A"] == pytest.approx(0.0, abs=1e-9)

    def test_nan_weight_clamped_to_zero(self):
        si = SplitInput(
            aggregated_ideal_pf=(("A", float("nan")), ("B", 0.5)),
            equity_universe=frozenset(["A", "B"]),
            fund_universe=frozenset(),
        )
        r = SPLITTER.split(si)
        weights = dict(r.equity_ideal_pf)
        assert weights["A"] == pytest.approx(0.0, abs=1e-9)

    def test_inf_weight_clamped_to_zero(self):
        si = SplitInput(
            aggregated_ideal_pf=(("A", float("inf")), ("B", 0.5)),
            equity_universe=frozenset(["A", "B"]),
            fund_universe=frozenset(),
        )
        r = SPLITTER.split(si)
        weights = dict(r.equity_ideal_pf)
        assert weights["A"] == pytest.approx(0.0, abs=1e-9)

    def test_empty_equity_universe(self):
        si = _make_input([("F1", 1.0)], fund=["F1"])
        r = SPLITTER.split(si)
        assert r.equity_ideal_pf == ()

    def test_empty_fund_universe(self):
        si = _make_input([("A", 1.0)], equity=["A"])
        r = SPLITTER.split(si)
        assert r.fund_ideal_pf == ()

    def test_single_ticker_equity_weight_is_1(self):
        si = _make_input([("A", 0.42)], equity=["A"])
        r = SPLITTER.split(si)
        assert math.isclose(dict(r.equity_ideal_pf)["A"], 1.0, abs_tol=1e-9)

    def test_single_ticker_fund_weight_is_1(self):
        si = _make_input([("F1", 0.87)], fund=["F1"])
        r = SPLITTER.split(si)
        assert math.isclose(dict(r.fund_ideal_pf)["F1"], 1.0, abs_tol=1e-9)


# ════════════════════════════════════════════════════════════════════════════
# 8. Design principles — no judgment fields
# ════════════════════════════════════════════════════════════════════════════

class TestNoJudgmentFields:
    def test_split_result_no_is_hold(self):
        r = SPLITTER.split(_make_input([("A", 1.0)], equity=["A"]))
        assert not hasattr(r, "is_hold")

    def test_split_result_no_is_recommended(self):
        r = SPLITTER.split(_make_input([("A", 1.0)], equity=["A"]))
        assert not hasattr(r, "is_recommended")

    def test_split_result_no_trade_order(self):
        r = SPLITTER.split(_make_input([("A", 1.0)], equity=["A"]))
        assert not hasattr(r, "trade_order")

    def test_split_result_no_rebalance_order(self):
        r = SPLITTER.split(_make_input([("A", 1.0)], equity=["A"]))
        assert not hasattr(r, "rebalance_order")

    def test_diagnostics_observation_prefix(self):
        si = _make_input([("DUAL", 1.0)], equity=["DUAL"], fund=["DUAL"])
        r = SPLITTER.split(si)
        for d in r.diagnostics:
            assert d.startswith("observation:")

    def test_unclassified_diagnostic_observation_prefix(self):
        si = _make_input([("X", 1.0)])
        r = SPLITTER.split(si)
        for d in r.diagnostics:
            assert d.startswith("observation:")


# ════════════════════════════════════════════════════════════════════════════
# 9. End-to-end realistic scenario
# ════════════════════════════════════════════════════════════════════════════

class TestEndToEnd:
    def test_realistic_mixed_portfolio(self):
        # 3 equity, 2 fund, 1 unclassified, 1 dual
        pf = [
            ("7203", 0.25),   # Toyota — equity
            ("6758", 0.20),   # Sony — equity
            ("9984", 0.15),   # SoftBank — equity
            ("253710", 0.15), # 投信A — fund
            ("64311028", 0.10),  # 投信B — fund
            ("DUAL", 0.10),   # both → equity priority
            ("UNKNOWN", 0.05),  # unclassified
        ]
        eq_universe = frozenset(["7203", "6758", "9984", "DUAL"])
        fund_universe = frozenset(["253710", "64311028", "DUAL"])

        si = SplitInput(
            aggregated_ideal_pf=tuple(pf),
            equity_universe=eq_universe,
            fund_universe=fund_universe,
        )
        r = SPLITTER.split(si)

        # Equity: 7203, 6758, 9984, DUAL
        equity_tickers = {t for t, _ in r.equity_ideal_pf}
        assert equity_tickers == {"7203", "6758", "9984", "DUAL"}

        # Fund: 253710, 64311028
        fund_tickers = {t for t, _ in r.fund_ideal_pf}
        assert fund_tickers == {"253710", "64311028"}

        # Unclassified: UNKNOWN
        assert r.unclassified_tickers == ("UNKNOWN",)

        # Weights sum to 1.0 each
        assert math.isclose(_weight_sum(r.equity_ideal_pf), 1.0, abs_tol=1e-9)
        assert math.isclose(_weight_sum(r.fund_ideal_pf), 1.0, abs_tol=1e-9)

        # DUAL diagnostic present (P2-7U)
        assert any("DUAL" in d and "P2-7U" in d for d in r.diagnostics)

        # Equity ordering: weight desc
        eq_weights = [w for _, w in r.equity_ideal_pf]
        assert eq_weights == sorted(eq_weights, reverse=True)
