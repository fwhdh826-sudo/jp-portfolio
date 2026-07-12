"""
test_unified_view.py — Card 7-8
Phase 7: UnifiedViewBuilder / AccountHoldingInfo / AccountSummary /
          UnifiedViewInput / UnifiedViewResult のテスト。

6 口座統合ビュー。calculation-only / observation / not an order。
combined_ideal_pf は持たない。差分・rebalance_order は持たない。
"""
import math
import pytest

from engine.portfolio.unified_view import (
    KNOWN_ASSET_CLASSES,
    FUND_ASSET_CLASSES,
    AccountHoldingInfo,
    AccountSummary,
    UnifiedViewInput,
    UnifiedViewResult,
    UnifiedViewBuilder,
)


# ── helpers ───────────────────────────────────────────────────────────────────

BUILDER = UnifiedViewBuilder()


def _holding(account_id="sbi_tokutei", ticker_or_code="7203",
             current_weight=0.1, asset_class="domestic_equity"):
    return AccountHoldingInfo(
        account_id=account_id,
        ticker_or_code=ticker_or_code,
        current_weight=current_weight,
        asset_class=asset_class,
    )


def _build(equity_pf=(), fund_pf=(), holdings=(), cash_weight=0.0, regime="bull"):
    return BUILDER.build(UnifiedViewInput(
        equity_constrained_pf=tuple(equity_pf),
        fund_pf=tuple(fund_pf),
        account_holdings=tuple(holdings),
        cash_weight=cash_weight,
        regime=regime,
    ))


# ════════════════════════════════════════════════════════════════════════════
# 1. Module / constants
# ════════════════════════════════════════════════════════════════════════════

class TestModuleConstants:
    def test_known_asset_classes_contains_domestic_equity(self):
        assert "domestic_equity" in KNOWN_ASSET_CLASSES

    def test_known_asset_classes_contains_domestic_fund(self):
        assert "domestic_fund" in KNOWN_ASSET_CLASSES

    def test_known_asset_classes_contains_overseas_fund(self):
        assert "overseas_fund" in KNOWN_ASSET_CLASSES

    def test_known_asset_classes_contains_cash(self):
        assert "cash" in KNOWN_ASSET_CLASSES

    def test_fund_asset_classes_subset(self):
        assert FUND_ASSET_CLASSES <= KNOWN_ASSET_CLASSES

    def test_stdlib_only_no_numpy(self):
        import engine.portfolio.unified_view as m
        src = open(m.__file__).read()
        assert "import numpy" not in src
        assert "import pandas" not in src
        assert "import scipy" not in src

    def test_no_http_import(self):
        import engine.portfolio.unified_view as m
        src = open(m.__file__).read()
        assert "requests" not in src
        assert "httpx" not in src

    def test_no_fund_short_term_risk_import(self):
        import engine.portfolio.unified_view as m
        src = open(m.__file__).read()
        assert "import fund_short_term_risk" not in src
        assert "from engine.behavioral.fund_short_term_risk" not in src


# ════════════════════════════════════════════════════════════════════════════
# 2. AccountHoldingInfo
# ════════════════════════════════════════════════════════════════════════════

class TestAccountHoldingInfo:
    def test_frozen(self):
        h = _holding()
        with pytest.raises((AttributeError, TypeError)):
            h.account_id = "x"  # type: ignore[misc]

    def test_account_id_stored(self):
        h = _holding(account_id="sbi_nisa")
        assert h.account_id == "sbi_nisa"

    def test_ticker_or_code_stored(self):
        h = _holding(ticker_or_code="7203")
        assert h.ticker_or_code == "7203"

    def test_current_weight_stored(self):
        h = _holding(current_weight=0.25)
        assert h.current_weight == pytest.approx(0.25)

    def test_negative_weight_clamped(self):
        h = AccountHoldingInfo("a", "X", -0.5, "domestic_equity")
        assert h.current_weight == 0.0

    def test_none_weight_clamped(self):
        h = AccountHoldingInfo("a", "X", None, "domestic_equity")  # type: ignore[arg-type]
        assert h.current_weight == 0.0

    def test_asset_class_stored(self):
        h = _holding(asset_class="overseas_fund")
        assert h.asset_class == "overseas_fund"

    def test_no_action_field(self):
        h = _holding()
        assert not hasattr(h, "action")

    def test_no_recommendation_field(self):
        h = _holding()
        assert not hasattr(h, "recommendation")

    def test_no_verdict_field(self):
        h = _holding()
        assert not hasattr(h, "verdict")

    def test_no_is_buy_field(self):
        h = _holding()
        assert not hasattr(h, "is_buy")

    def test_no_order_field(self):
        h = _holding()
        assert not hasattr(h, "order")


# ════════════════════════════════════════════════════════════════════════════
# 3. UnifiedViewInput
# ════════════════════════════════════════════════════════════════════════════

class TestUnifiedViewInput:
    def test_frozen(self):
        vi = UnifiedViewInput(equity_constrained_pf=(), fund_pf=(), account_holdings=())
        with pytest.raises((AttributeError, TypeError)):
            vi.regime = "bear"  # type: ignore[misc]

    def test_list_equity_pf_converted_to_tuple(self):
        vi = UnifiedViewInput(
            equity_constrained_pf=[("A", 1.0)],  # type: ignore[arg-type]
            fund_pf=(),
            account_holdings=(),
        )
        assert isinstance(vi.equity_constrained_pf, tuple)

    def test_list_fund_pf_converted_to_tuple(self):
        vi = UnifiedViewInput(
            equity_constrained_pf=(),
            fund_pf=[("F1", 1.0)],  # type: ignore[arg-type]
            account_holdings=(),
        )
        assert isinstance(vi.fund_pf, tuple)

    def test_list_holdings_converted_to_tuple(self):
        vi = UnifiedViewInput(
            equity_constrained_pf=(),
            fund_pf=(),
            account_holdings=[_holding()],  # type: ignore[arg-type]
        )
        assert isinstance(vi.account_holdings, tuple)

    def test_cash_weight_defaults_to_zero(self):
        vi = UnifiedViewInput(equity_constrained_pf=(), fund_pf=(), account_holdings=())
        assert vi.cash_weight == 0.0

    def test_cash_weight_negative_clamped(self):
        vi = UnifiedViewInput(equity_constrained_pf=(), fund_pf=(), account_holdings=(), cash_weight=-0.1)
        assert vi.cash_weight == 0.0

    def test_regime_defaults_to_uncertain(self):
        vi = UnifiedViewInput(equity_constrained_pf=(), fund_pf=(), account_holdings=())
        assert vi.regime == "uncertain"

    def test_context_defaults_empty(self):
        vi = UnifiedViewInput(equity_constrained_pf=(), fund_pf=(), account_holdings=())
        assert vi.context == {}

    def test_no_combined_ideal_pf_field(self):
        vi = UnifiedViewInput(equity_constrained_pf=(), fund_pf=(), account_holdings=())
        assert not hasattr(vi, "combined_ideal_pf")


# ════════════════════════════════════════════════════════════════════════════
# 4. AccountSummary
# ════════════════════════════════════════════════════════════════════════════

class TestAccountSummary:
    def test_frozen(self):
        s = AccountSummary("sbi", 0.5, ())
        with pytest.raises((AttributeError, TypeError)):
            s.account_id = "x"  # type: ignore[misc]

    def test_has_account_id(self):
        s = AccountSummary("sbi_nisa", 0.3, ())
        assert s.account_id == "sbi_nisa"

    def test_has_total_current_weight(self):
        s = AccountSummary("sbi", 0.45, ())
        assert s.total_current_weight == pytest.approx(0.45)

    def test_has_asset_class_breakdown(self):
        s = AccountSummary("sbi", 0.5, (("domestic_equity", 0.5),))
        assert s.asset_class_breakdown == (("domestic_equity", 0.5),)


# ════════════════════════════════════════════════════════════════════════════
# 5. UnifiedViewResult
# ════════════════════════════════════════════════════════════════════════════

class TestUnifiedViewResult:
    def _make(self, **kw):
        defaults = dict(
            equity_constrained_pf=(("A", 1.0),),
            fund_pf=(("F1", 1.0),),
            account_summaries=(),
            asset_class_weights=(),
            total_equity_weight=0.0,
            total_fund_weight=0.0,
            total_cash_weight=0.0,
            diagnostics=(),
        )
        defaults.update(kw)
        return UnifiedViewResult(**defaults)

    def test_frozen(self):
        r = self._make()
        with pytest.raises((AttributeError, TypeError)):
            r.regime = "bear"  # type: ignore[misc]

    def test_has_equity_constrained_pf(self):
        r = self._make()
        assert hasattr(r, "equity_constrained_pf")

    def test_has_fund_pf(self):
        r = self._make()
        assert hasattr(r, "fund_pf")

    def test_has_account_summaries(self):
        r = self._make()
        assert hasattr(r, "account_summaries")

    def test_has_asset_class_weights(self):
        r = self._make()
        assert hasattr(r, "asset_class_weights")

    def test_has_total_equity_weight(self):
        r = self._make()
        assert hasattr(r, "total_equity_weight")

    def test_has_total_fund_weight(self):
        r = self._make()
        assert hasattr(r, "total_fund_weight")

    def test_has_total_cash_weight(self):
        r = self._make()
        assert hasattr(r, "total_cash_weight")

    def test_no_combined_ideal_pf(self):
        r = self._make()
        assert not hasattr(r, "combined_ideal_pf")

    def test_no_rebalance_order(self):
        r = self._make()
        assert not hasattr(r, "rebalance_order")

    def test_no_delta(self):
        r = self._make()
        assert not hasattr(r, "delta")

    def test_no_diff(self):
        r = self._make()
        assert not hasattr(r, "diff")

    def test_no_action(self):
        r = self._make()
        assert not hasattr(r, "action")

    def test_no_recommendation(self):
        r = self._make()
        assert not hasattr(r, "recommendation")

    def test_no_verdict(self):
        r = self._make()
        assert not hasattr(r, "verdict")

    def test_no_is_buy(self):
        r = self._make()
        assert not hasattr(r, "is_buy")

    def test_no_is_sell(self):
        r = self._make()
        assert not hasattr(r, "is_sell")

    def test_no_order(self):
        r = self._make()
        assert not hasattr(r, "order")

    def test_to_dict_keys(self):
        r = self._make()
        d = r.to_dict()
        assert set(d.keys()) == {
            "equity_constrained_pf", "fund_pf", "account_summaries",
            "asset_class_weights", "total_equity_weight", "total_fund_weight",
            "total_cash_weight", "diagnostics",
        }

    def test_to_dict_equity_pf_is_dict(self):
        r = self._make(equity_constrained_pf=(("A", 0.6), ("B", 0.4)))
        assert isinstance(r.to_dict()["equity_constrained_pf"], dict)

    def test_to_dict_fund_pf_is_dict(self):
        r = self._make()
        assert isinstance(r.to_dict()["fund_pf"], dict)

    def test_to_dict_account_summaries_is_list(self):
        r = self._make()
        assert isinstance(r.to_dict()["account_summaries"], list)

    def test_to_dict_asset_class_weights_is_dict(self):
        r = self._make()
        assert isinstance(r.to_dict()["asset_class_weights"], dict)

    def test_to_dict_json_serializable(self):
        import json
        r = self._make()
        json.dumps(r.to_dict())


# ════════════════════════════════════════════════════════════════════════════
# 6. UnifiedViewBuilder.build() — basic
# ════════════════════════════════════════════════════════════════════════════

class TestBuildBasic:
    def test_empty_inputs_no_crash(self):
        r = _build()
        assert r.account_summaries == ()
        assert r.asset_class_weights == ()
        assert r.total_equity_weight == 0.0
        assert r.total_fund_weight == 0.0
        assert r.total_cash_weight == 0.0

    def test_equity_pf_passed_through(self):
        pf = (("A", 0.6), ("B", 0.4))
        r = _build(equity_pf=pf)
        assert r.equity_constrained_pf == pf

    def test_fund_pf_passed_through(self):
        pf = (("F1", 0.7), ("F2", 0.3))
        r = _build(fund_pf=pf)
        assert r.fund_pf == pf

    def test_cash_weight_passed_through(self):
        r = _build(cash_weight=0.05)
        assert math.isclose(r.total_cash_weight, 0.05, abs_tol=1e-9)

    def test_cash_weight_zero_default(self):
        r = _build()
        assert r.total_cash_weight == 0.0


# ════════════════════════════════════════════════════════════════════════════
# 7. UnifiedViewBuilder.build() — account aggregation
# ════════════════════════════════════════════════════════════════════════════

class TestAccountAggregation:
    def test_one_account_one_holding(self):
        h = _holding("sbi", "7203", 0.3, "domestic_equity")
        r = _build(holdings=[h])
        assert len(r.account_summaries) == 1
        assert r.account_summaries[0].account_id == "sbi"
        assert math.isclose(r.account_summaries[0].total_current_weight, 0.3, abs_tol=1e-9)

    def test_one_account_multiple_holdings_summed(self):
        holdings = [
            _holding("sbi", "7203", 0.3, "domestic_equity"),
            _holding("sbi", "6758", 0.2, "domestic_equity"),
        ]
        r = _build(holdings=holdings)
        summary = {s.account_id: s for s in r.account_summaries}
        assert math.isclose(summary["sbi"].total_current_weight, 0.5, abs_tol=1e-9)

    def test_multiple_accounts_independent(self):
        holdings = [
            _holding("sbi_tokutei", "7203", 0.3, "domestic_equity"),
            _holding("rakuten_tokutei", "6758", 0.2, "domestic_equity"),
        ]
        r = _build(holdings=holdings)
        assert len(r.account_summaries) == 2

    def test_account_summaries_sorted_by_account_id(self):
        holdings = [
            _holding("sbi_tokutei", "A", 0.3, "domestic_equity"),
            _holding("rakuten_tokutei", "B", 0.2, "domestic_equity"),
        ]
        r = _build(holdings=holdings)
        ids = [s.account_id for s in r.account_summaries]
        assert ids == sorted(ids)

    def test_duplicate_ticker_same_account_summed(self):
        # 複数ロット保有: same account_id + same ticker_or_code → 合算（P2-7X）
        holdings = [
            _holding("sbi", "7203", 0.10, "domestic_equity"),
            _holding("sbi", "7203", 0.05, "domestic_equity"),
        ]
        r = _build(holdings=holdings)
        summary = {s.account_id: s for s in r.account_summaries}
        assert math.isclose(summary["sbi"].total_current_weight, 0.15, abs_tol=1e-9)

    def test_account_asset_class_breakdown(self):
        holdings = [
            _holding("sbi", "7203", 0.3, "domestic_equity"),
            _holding("sbi", "F1", 0.2, "domestic_fund"),
        ]
        r = _build(holdings=holdings)
        summary = {s.account_id: s for s in r.account_summaries}
        bd = dict(summary["sbi"].asset_class_breakdown)
        assert math.isclose(bd["domestic_equity"], 0.3, abs_tol=1e-9)
        assert math.isclose(bd["domestic_fund"], 0.2, abs_tol=1e-9)

    def test_account_breakdown_sorted_weight_desc(self):
        holdings = [
            _holding("sbi", "F1", 0.1, "domestic_fund"),
            _holding("sbi", "7203", 0.4, "domestic_equity"),
        ]
        r = _build(holdings=holdings)
        bd_weights = [w for _, w in r.account_summaries[0].asset_class_breakdown]
        assert bd_weights == sorted(bd_weights, reverse=True)


# ════════════════════════════════════════════════════════════════════════════
# 8. UnifiedViewBuilder.build() — asset class aggregation
# ════════════════════════════════════════════════════════════════════════════

class TestAssetClassAggregation:
    def test_domestic_equity_summed(self):
        holdings = [
            _holding("sbi", "7203", 0.3, "domestic_equity"),
            _holding("rakuten", "6758", 0.2, "domestic_equity"),
        ]
        r = _build(holdings=holdings)
        ac = dict(r.asset_class_weights)
        assert math.isclose(ac["domestic_equity"], 0.5, abs_tol=1e-9)

    def test_domestic_fund_summed(self):
        holdings = [
            _holding("sbi_nisa", "F1", 0.2, "domestic_fund"),
            _holding("rakuten_nisa", "F2", 0.1, "domestic_fund"),
        ]
        r = _build(holdings=holdings)
        ac = dict(r.asset_class_weights)
        assert math.isclose(ac["domestic_fund"], 0.3, abs_tol=1e-9)

    def test_overseas_fund_summed(self):
        holdings = [
            _holding("sbi_nisa", "SP500", 0.15, "overseas_fund"),
            _holding("rakuten_ideco", "MSCI", 0.10, "overseas_fund"),
        ]
        r = _build(holdings=holdings)
        ac = dict(r.asset_class_weights)
        assert math.isclose(ac["overseas_fund"], 0.25, abs_tol=1e-9)

    def test_cash_in_holdings_captured(self):
        holdings = [_holding("sbi", "CASH", 0.05, "cash")]
        r = _build(holdings=holdings)
        ac = dict(r.asset_class_weights)
        assert math.isclose(ac["cash"], 0.05, abs_tol=1e-9)

    def test_asset_class_weights_sorted_weight_desc(self):
        holdings = [
            _holding("sbi", "F1", 0.1, "domestic_fund"),
            _holding("sbi", "7203", 0.5, "domestic_equity"),
            _holding("sbi", "SP500", 0.2, "overseas_fund"),
        ]
        r = _build(holdings=holdings)
        weights = [w for _, w in r.asset_class_weights]
        assert weights == sorted(weights, reverse=True)

    def test_unknown_asset_class_treated_as_unclassified(self):
        holdings = [_holding("sbi", "BONDS", 0.1, "bonds")]
        r = _build(holdings=holdings)
        ac = dict(r.asset_class_weights)
        assert "unclassified" in ac
        assert "bonds" not in ac

    def test_unknown_asset_class_generates_diagnostic(self):
        holdings = [_holding("sbi", "BONDS", 0.1, "bonds")]
        r = _build(holdings=holdings)
        assert any("unknown asset_class" in d and "bonds" in d for d in r.diagnostics)

    def test_unknown_asset_class_diagnostic_once_per_class(self):
        holdings = [
            _holding("sbi", "B1", 0.1, "bonds"),
            _holding("sbi", "B2", 0.1, "bonds"),
        ]
        r = _build(holdings=holdings)
        bond_diagnostics = [d for d in r.diagnostics if "bonds" in d]
        assert len(bond_diagnostics) == 1

    def test_explicit_unclassified_no_diagnostic(self):
        holdings = [_holding("sbi", "X", 0.1, "unclassified")]
        r = _build(holdings=holdings)
        assert not any("unknown asset_class" in d for d in r.diagnostics)


# ════════════════════════════════════════════════════════════════════════════
# 9. UnifiedViewBuilder.build() — total weights
# ════════════════════════════════════════════════════════════════════════════

class TestTotalWeights:
    def test_total_equity_weight(self):
        holdings = [
            _holding("sbi", "7203", 0.4, "domestic_equity"),
            _holding("rakuten", "6758", 0.3, "domestic_equity"),
        ]
        r = _build(holdings=holdings)
        assert math.isclose(r.total_equity_weight, 0.7, abs_tol=1e-9)

    def test_total_fund_weight_includes_domestic_and_overseas(self):
        holdings = [
            _holding("sbi_nisa", "F1", 0.2, "domestic_fund"),
            _holding("sbi_nisa", "SP500", 0.15, "overseas_fund"),
        ]
        r = _build(holdings=holdings)
        assert math.isclose(r.total_fund_weight, 0.35, abs_tol=1e-9)

    def test_total_cash_weight_is_di_passthrough(self):
        r = _build(cash_weight=0.08)
        assert math.isclose(r.total_cash_weight, 0.08, abs_tol=1e-9)

    def test_total_equity_zero_when_no_equity_holdings(self):
        holdings = [_holding("sbi", "F1", 0.3, "domestic_fund")]
        r = _build(holdings=holdings)
        assert r.total_equity_weight == 0.0

    def test_total_fund_zero_when_no_fund_holdings(self):
        holdings = [_holding("sbi", "7203", 0.3, "domestic_equity")]
        r = _build(holdings=holdings)
        assert r.total_fund_weight == 0.0


# ════════════════════════════════════════════════════════════════════════════
# 10. Diagnostics
# ════════════════════════════════════════════════════════════════════════════

class TestDiagnostics:
    def test_all_diagnostics_observation_prefix(self):
        holdings = [_holding("sbi", "X", 0.1, "unknown_class")]
        r = _build(holdings=holdings)
        for d in r.diagnostics:
            assert d.startswith("observation:")

    def test_no_diagnostics_for_normal_build(self):
        holdings = [
            _holding("sbi_tokutei", "7203", 0.3, "domestic_equity"),
            _holding("sbi_nisa", "F1", 0.2, "domestic_fund"),
        ]
        r = _build(holdings=holdings)
        assert len(r.diagnostics) == 0


# ════════════════════════════════════════════════════════════════════════════
# 11. End-to-end
# ════════════════════════════════════════════════════════════════════════════

class TestEndToEnd:
    def test_e2e_6_accounts(self):
        holdings = [
            AccountHoldingInfo("sbi_tokutei",    "7203",    0.25, "domestic_equity"),
            AccountHoldingInfo("sbi_tokutei",    "6758",    0.15, "domestic_equity"),
            AccountHoldingInfo("sbi_nisa",       "253710",  0.20, "domestic_fund"),
            AccountHoldingInfo("rakuten_tokutei","9984",    0.10, "domestic_equity"),
            AccountHoldingInfo("rakuten_nisa",   "SP500",   0.15, "overseas_fund"),
            AccountHoldingInfo("rakuten_ideco",  "index_f", 0.10, "domestic_fund"),
        ]
        equity_pf = (("7203", 0.5), ("6758", 0.3), ("9984", 0.2))
        fund_pf = (("253710", 0.6), ("index_f", 0.4))

        r = _build(equity_pf=equity_pf, fund_pf=fund_pf, holdings=holdings, cash_weight=0.05)

        # Pass-through
        assert r.equity_constrained_pf == equity_pf
        assert r.fund_pf == fund_pf

        # 6 accounts → 5 unique accounts (sbi_tokutei has 2 holdings)
        account_ids = {s.account_id for s in r.account_summaries}
        assert account_ids == {
            "sbi_tokutei", "sbi_nisa", "rakuten_tokutei", "rakuten_nisa", "rakuten_ideco"
        }

        # sbi_tokutei total = 0.25 + 0.15 = 0.40
        sbi_t = {s.account_id: s for s in r.account_summaries}["sbi_tokutei"]
        assert math.isclose(sbi_t.total_current_weight, 0.40, abs_tol=1e-9)

        # total_equity_weight = 0.25 + 0.15 + 0.10 = 0.50
        assert math.isclose(r.total_equity_weight, 0.50, abs_tol=1e-9)

        # total_fund_weight = 0.20 + 0.15 + 0.10 = 0.45
        assert math.isclose(r.total_fund_weight, 0.45, abs_tol=1e-9)

        # total_cash_weight
        assert math.isclose(r.total_cash_weight, 0.05, abs_tol=1e-9)

        # No diagnostics (all asset_classes known)
        assert len(r.diagnostics) == 0

    def test_e2e_equity_only(self):
        holdings = [_holding("sbi", "7203", 0.5, "domestic_equity")]
        r = _build(equity_pf=(("7203", 1.0),), fund_pf=(), holdings=holdings)
        assert r.total_equity_weight == pytest.approx(0.5)
        assert r.total_fund_weight == 0.0

    def test_e2e_fund_only(self):
        holdings = [_holding("sbi_nisa", "F1", 0.4, "domestic_fund")]
        r = _build(equity_pf=(), fund_pf=(("F1", 1.0),), holdings=holdings)
        assert r.total_equity_weight == 0.0
        assert math.isclose(r.total_fund_weight, 0.4, abs_tol=1e-9)

    def test_e2e_to_dict_json_serializable(self):
        import json
        holdings = [
            AccountHoldingInfo("sbi", "7203", 0.4, "domestic_equity"),
            AccountHoldingInfo("sbi_nisa", "F1", 0.3, "domestic_fund"),
        ]
        r = _build(
            equity_pf=(("7203", 1.0),),
            fund_pf=(("F1", 1.0),),
            holdings=holdings,
            cash_weight=0.05,
        )
        d = r.to_dict()
        json.dumps(d)
        assert "7203" in d["equity_constrained_pf"]
        assert "F1" in d["fund_pf"]
        assert len(d["account_summaries"]) == 2
        assert "domestic_equity" in d["asset_class_weights"]
