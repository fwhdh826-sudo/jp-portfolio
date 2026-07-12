"""
test_expected_return_model.py — Card 8-1 テスト
stdlib-only, pytest only
"""
from __future__ import annotations

import pytest
from engine.frontier.expected_return_model import (
    AXIS_ALPHA_SCALE,
    AssetExpectedReturn,
    AssetMetaInput,
    ExpectedReturnInput,
    ExpectedReturnModel,
    ExpectedReturnResult,
    MarketIntelContext,
    _SIZE_PREMIUM,
    _clamp,
    _safe_float,
)

# ── フィクスチャ ──────────────────────────────────────────────────────────────

def _make_asset(
    ticker="7203",
    mean_return_3y=0.08,
    size_segment="large_cap",
    is_risk_on=False,
    is_defensive=False,
    is_energy=False,
    is_overseas=False,
) -> AssetMetaInput:
    return AssetMetaInput(
        ticker=ticker,
        mean_return_3y=mean_return_3y,
        size_segment=size_segment,
        is_risk_on=is_risk_on,
        is_defensive=is_defensive,
        is_energy=is_energy,
        is_overseas=is_overseas,
    )


def _make_model() -> ExpectedReturnModel:
    return ExpectedReturnModel()


def _six_axis(total: float = 50.0) -> dict:
    return {ax: {"total": total} for ax in (
        "value", "quality", "growth", "safety", "momentum", "shareholder_return"
    )}


def _minimal_input(
    assets=None,
    six_axis_scores=None,
    cross_axis_signals=None,
    regime="bull_calm",
    market_intel=None,
) -> ExpectedReturnInput:
    if assets is None:
        assets = (_make_asset(),)
    if six_axis_scores is None:
        six_axis_scores = {"7203": _six_axis()}
    if cross_axis_signals is None:
        cross_axis_signals = {"7203": {"size_quality": 60.0, "anti_junk": 70.0}}
    return ExpectedReturnInput(
        assets=assets,
        six_axis_scores=six_axis_scores,
        cross_axis_signals=cross_axis_signals,
        regime=regime,
        market_intel=market_intel,
    )


# ── _safe_float ───────────────────────────────────────────────────────────────

class TestSafeFloat:
    def test_normal_float(self):
        assert _safe_float(0.08) == pytest.approx(0.08)

    def test_zero_is_valid(self):
        assert _safe_float(0.0) == pytest.approx(0.0)

    def test_negative_float(self):
        assert _safe_float(-0.05) == pytest.approx(-0.05)

    def test_string_number(self):
        assert _safe_float("0.1") == pytest.approx(0.1)

    def test_nan_returns_default(self):
        import math
        assert _safe_float(math.nan) == pytest.approx(0.0)

    def test_inf_returns_default(self):
        import math
        assert _safe_float(math.inf) == pytest.approx(0.0)

    def test_none_returns_default(self):
        assert _safe_float(None) == pytest.approx(0.0)

    def test_custom_default(self):
        assert _safe_float(None, 99.0) == pytest.approx(99.0)


# ── AssetMetaInput ────────────────────────────────────────────────────────────

class TestAssetMetaInput:
    def test_basic_creation(self):
        a = _make_asset()
        assert a.ticker == "7203"
        assert a.size_segment == "large_cap"

    def test_mean_return_zero_is_valid(self):
        a = _make_asset(mean_return_3y=0.0)
        assert a.mean_return_3y == pytest.approx(0.0)

    def test_mean_return_negative(self):
        a = _make_asset(mean_return_3y=-0.05)
        assert a.mean_return_3y == pytest.approx(-0.05)

    def test_empty_ticker_raises(self):
        with pytest.raises(ValueError):
            AssetMetaInput(ticker="", mean_return_3y=0.08, size_segment="large_cap")

    def test_nan_mean_return_becomes_zero(self):
        import math
        a = AssetMetaInput(ticker="X", mean_return_3y=math.nan, size_segment="large_cap")
        assert a.mean_return_3y == pytest.approx(0.0)

    def test_frozen(self):
        a = _make_asset()
        with pytest.raises((AttributeError, TypeError)):
            a.ticker = "changed"  # type: ignore[misc]

    def test_bool_flags_default_false(self):
        a = AssetMetaInput(ticker="T", mean_return_3y=0.0, size_segment="mid_cap")
        assert a.is_risk_on is False
        assert a.is_defensive is False
        assert a.is_energy is False
        assert a.is_overseas is False

    def test_bool_flags_explicit(self):
        a = AssetMetaInput(ticker="T", mean_return_3y=0.0, size_segment="small_cap",
                           is_risk_on=True, is_energy=True)
        assert a.is_risk_on is True
        assert a.is_energy is True


# ── MarketIntelContext ────────────────────────────────────────────────────────

class TestMarketIntelContext:
    def test_basic(self):
        m = MarketIntelContext(sentiment_score=60.0, keywords=("円安",))
        assert m.sentiment_score == pytest.approx(60.0)
        assert "円安" in m.keywords

    def test_clamp_above_100(self):
        m = MarketIntelContext(sentiment_score=150.0)
        assert m.sentiment_score == pytest.approx(100.0)

    def test_clamp_below_zero(self):
        m = MarketIntelContext(sentiment_score=-10.0)
        assert m.sentiment_score == pytest.approx(0.0)

    def test_list_keywords_converted_to_tuple(self):
        m = MarketIntelContext(sentiment_score=50.0, keywords=["資源高", "円安"])  # type: ignore[arg-type]
        assert isinstance(m.keywords, tuple)
        assert "資源高" in m.keywords

    def test_empty_keywords_default(self):
        m = MarketIntelContext(sentiment_score=50.0)
        assert m.keywords == ()

    def test_frozen(self):
        m = MarketIntelContext(sentiment_score=50.0)
        with pytest.raises((AttributeError, TypeError)):
            m.sentiment_score = 99.0  # type: ignore[misc]


# ── ExpectedReturnInput ───────────────────────────────────────────────────────

class TestExpectedReturnInput:
    def test_list_assets_converted_to_tuple(self):
        inp = ExpectedReturnInput(
            assets=[_make_asset()],  # type: ignore[arg-type]
            six_axis_scores={},
            cross_axis_signals={},
            regime="bull_calm",
        )
        assert isinstance(inp.assets, tuple)

    def test_invalid_context_becomes_empty_dict(self):
        inp = ExpectedReturnInput(
            assets=(_make_asset(),),
            six_axis_scores={},
            cross_axis_signals={},
            regime="bull_calm",
            context="not_a_dict",  # type: ignore[arg-type]
        )
        assert inp.context == {}

    def test_invalid_six_axis_scores_becomes_empty_dict(self):
        inp = ExpectedReturnInput(
            assets=(_make_asset(),),
            six_axis_scores=None,  # type: ignore[arg-type]
            cross_axis_signals={},
            regime="bull_calm",
        )
        assert inp.six_axis_scores == {}

    def test_invalid_cross_axis_signals_becomes_empty_dict(self):
        inp = ExpectedReturnInput(
            assets=(_make_asset(),),
            six_axis_scores={},
            cross_axis_signals=None,  # type: ignore[arg-type]
            regime="bull_calm",
        )
        assert inp.cross_axis_signals == {}

    def test_market_intel_none_by_default(self):
        inp = _minimal_input()
        assert inp.market_intel is None


# ── AssetExpectedReturn ───────────────────────────────────────────────────────

class TestAssetExpectedReturn:
    def _make(self, **kw):
        defaults = dict(
            ticker="7203",
            expected_return=0.10,
            mu_hist=0.08,
            alpha_score=0.002,
            alpha_cross=0.003,
            size_premium=0.000,
            alpha_market=0.000,
            diagnostics=("observation: x",),
        )
        defaults.update(kw)
        return AssetExpectedReturn(**defaults)

    def test_to_dict_keys(self):
        d = self._make().to_dict()
        assert set(d.keys()) == {
            "ticker", "expected_return", "mu_hist",
            "alpha_score", "alpha_cross", "size_premium", "alpha_market", "diagnostics",
        }

    def test_to_dict_diagnostics_is_list(self):
        d = self._make().to_dict()
        assert isinstance(d["diagnostics"], list)

    def test_frozen(self):
        obj = self._make()
        with pytest.raises((AttributeError, TypeError)):
            obj.ticker = "X"  # type: ignore[misc]


# ── ExpectedReturnResult ──────────────────────────────────────────────────────

class TestExpectedReturnResult:
    def _make_result(self):
        asset = AssetExpectedReturn(
            ticker="7203",
            expected_return=0.10,
            mu_hist=0.08,
            alpha_score=0.002,
            alpha_cross=0.003,
            size_premium=0.000,
            alpha_market=0.000,
            diagnostics=("observation: test",),
        )
        return ExpectedReturnResult(
            per_asset=(asset,),
            regime_used="bull_calm",
            market_intel_used=False,
            diagnostics=(),
        )

    def test_get_expected_return_found(self):
        result = self._make_result()
        val = result.get_expected_return("7203")
        assert val is not None
        assert val == pytest.approx(0.10)

    def test_get_expected_return_not_found(self):
        result = self._make_result()
        assert result.get_expected_return("9999") is None

    def test_to_dict_structure(self):
        d = self._make_result().to_dict()
        assert "per_asset" in d
        assert "regime_used" in d
        assert "market_intel_used" in d
        assert "diagnostics" in d
        assert isinstance(d["per_asset"], list)


# ── ExpectedReturnModel.calculate ─────────────────────────────────────────────

class TestCalculateBasic:
    def test_returns_result_type(self):
        model = _make_model()
        result = model.calculate(_minimal_input())
        assert isinstance(result, ExpectedReturnResult)

    def test_one_asset_in_result(self):
        model = _make_model()
        result = model.calculate(_minimal_input())
        assert len(result.per_asset) == 1

    def test_regime_used_passed_through(self):
        model = _make_model()
        result = model.calculate(_minimal_input(regime="bear"))
        assert result.regime_used == "bear"

    def test_unknown_regime_fallback_to_uncertain(self):
        model = _make_model()
        result = model.calculate(_minimal_input(regime="INVALID_REGIME"))
        assert result.regime_used == "uncertain"
        diag_text = " ".join(result.diagnostics)
        assert "uncertain" in diag_text

    def test_market_intel_used_false_when_none(self):
        model = _make_model()
        result = model.calculate(_minimal_input(market_intel=None))
        assert result.market_intel_used is False

    def test_market_intel_used_true_when_provided(self):
        model = _make_model()
        intel = MarketIntelContext(sentiment_score=50.0)
        result = model.calculate(_minimal_input(market_intel=intel))
        assert result.market_intel_used is True

    def test_multiple_assets(self):
        model = _make_model()
        assets = (
            _make_asset(ticker="7203"),
            _make_asset(ticker="6758", size_segment="mid_cap"),
        )
        inp = ExpectedReturnInput(
            assets=assets,
            six_axis_scores={
                "7203": _six_axis(60.0),
                "6758": _six_axis(40.0),
            },
            cross_axis_signals={
                "7203": {"size_quality": 50.0, "anti_junk": 50.0},
                "6758": {"size_quality": 50.0, "anti_junk": 50.0},
            },
            regime="bull_calm",
        )
        result = model.calculate(inp)
        assert len(result.per_asset) == 2


# ── alpha_score 計算 ──────────────────────────────────────────────────────────

class TestAlphaScore:
    def test_neutral_score_50_gives_zero_alpha(self):
        model = _make_model()
        inp = _minimal_input(six_axis_scores={"7203": _six_axis(50.0)})
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_score == pytest.approx(0.0, abs=1e-9)

    def test_high_scores_positive_alpha(self):
        model = _make_model()
        inp = _minimal_input(six_axis_scores={"7203": _six_axis(100.0)})
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_score > 0.0

    def test_low_scores_negative_alpha(self):
        model = _make_model()
        inp = _minimal_input(six_axis_scores={"7203": _six_axis(0.0)})
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_score < 0.0

    def test_max_alpha_score_approx_axis_alpha_scale(self):
        model = _make_model()
        inp = _minimal_input(six_axis_scores={"7203": _six_axis(100.0)})
        result = model.calculate(inp)
        assert abs(result.per_asset[0].alpha_score) <= AXIS_ALPHA_SCALE + 1e-9

    def test_missing_axis_uses_neutral_fallback(self):
        model = _make_model()
        partial = {"value": {"total": 80.0}}  # 5 axes missing
        inp = _minimal_input(six_axis_scores={"7203": partial})
        result = model.calculate(inp)
        diags = " ".join(result.per_asset[0].diagnostics)
        assert "neutral fallback" in diags

    def test_missing_ticker_uses_all_neutral(self):
        model = _make_model()
        inp = _minimal_input(six_axis_scores={})  # no scores for 7203
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_score == pytest.approx(0.0, abs=1e-9)

    def test_score_clamped_above_100(self):
        model = _make_model()
        inp = _minimal_input(six_axis_scores={"7203": _six_axis(999.0)})
        result = model.calculate(inp)
        # should be same as score=100
        inp2 = _minimal_input(six_axis_scores={"7203": _six_axis(100.0)})
        result2 = model.calculate(inp2)
        assert result.per_asset[0].alpha_score == pytest.approx(result2.per_asset[0].alpha_score)

    def test_score_clamped_below_zero(self):
        model = _make_model()
        inp = _minimal_input(six_axis_scores={"7203": _six_axis(-999.0)})
        result = model.calculate(inp)
        inp2 = _minimal_input(six_axis_scores={"7203": _six_axis(0.0)})
        result2 = model.calculate(inp2)
        assert result.per_asset[0].alpha_score == pytest.approx(result2.per_asset[0].alpha_score)


# ── alpha_cross 計算 ──────────────────────────────────────────────────────────

class TestAlphaCross:
    def test_full_scores(self):
        model = _make_model()
        inp = _minimal_input(cross_axis_signals={"7203": {"size_quality": 100.0, "anti_junk": 100.0}})
        result = model.calculate(inp)
        # 100/100 * 0.005 + 100/100 * 0.003 = 0.008
        assert result.per_asset[0].alpha_cross == pytest.approx(0.008)

    def test_zero_scores(self):
        model = _make_model()
        inp = _minimal_input(cross_axis_signals={"7203": {"size_quality": 0.0, "anti_junk": 0.0}})
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_cross == pytest.approx(0.0)

    def test_missing_ticker_gives_zero_and_diagnostic(self):
        model = _make_model()
        inp = _minimal_input(cross_axis_signals={})
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_cross == pytest.approx(0.0)
        diags = " ".join(result.per_asset[0].diagnostics)
        assert "cross_axis_signals" in diags

    def test_partial_cross_keys(self):
        model = _make_model()
        inp = _minimal_input(cross_axis_signals={"7203": {"size_quality": 50.0}})  # anti_junk missing
        result = model.calculate(inp)
        # anti_junk defaults to 0.0
        assert result.per_asset[0].alpha_cross == pytest.approx(50.0 / 100.0 * 0.005)


# ── size_premium 計算 ─────────────────────────────────────────────────────────

class TestSizePremium:
    def test_small_cap(self):
        model = _make_model()
        assets = (_make_asset(size_segment="small_cap"),)
        inp = _minimal_input(assets=assets)
        result = model.calculate(inp)
        assert result.per_asset[0].size_premium == pytest.approx(_SIZE_PREMIUM["small_cap"])

    def test_mid_cap(self):
        model = _make_model()
        assets = (_make_asset(size_segment="mid_cap"),)
        inp = _minimal_input(assets=assets)
        result = model.calculate(inp)
        assert result.per_asset[0].size_premium == pytest.approx(_SIZE_PREMIUM["mid_cap"])

    def test_large_cap(self):
        model = _make_model()
        assets = (_make_asset(size_segment="large_cap"),)
        inp = _minimal_input(assets=assets)
        result = model.calculate(inp)
        assert result.per_asset[0].size_premium == pytest.approx(0.000)

    def test_unknown_size_segment_zero_and_diagnostic(self):
        model = _make_model()
        assets = (_make_asset(size_segment="unknown"),)
        inp = _minimal_input(assets=assets)
        result = model.calculate(inp)
        assert result.per_asset[0].size_premium == pytest.approx(0.0)
        diags = " ".join(result.per_asset[0].diagnostics)
        assert "unknown size_segment" in diags


# ── alpha_market 計算 ─────────────────────────────────────────────────────────

class TestAlphaMarket:
    def test_no_market_intel_zero(self):
        model = _make_model()
        result = model.calculate(_minimal_input(market_intel=None))
        assert result.per_asset[0].alpha_market == pytest.approx(0.0)
        diags = " ".join(result.per_asset[0].diagnostics)
        assert "P2-7F" in diags

    def test_high_sentiment_risk_on(self):
        model = _make_model()
        assets = (_make_asset(is_risk_on=True),)
        intel = MarketIntelContext(sentiment_score=80.0)
        inp = _minimal_input(assets=assets, market_intel=intel)
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_market == pytest.approx(0.005)

    def test_high_sentiment_not_risk_on(self):
        model = _make_model()
        assets = (_make_asset(is_risk_on=False),)
        intel = MarketIntelContext(sentiment_score=80.0)
        inp = _minimal_input(assets=assets, market_intel=intel)
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_market == pytest.approx(0.0)

    def test_low_sentiment_defensive(self):
        model = _make_model()
        assets = (_make_asset(is_defensive=True),)
        intel = MarketIntelContext(sentiment_score=20.0)
        inp = _minimal_input(assets=assets, market_intel=intel)
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_market == pytest.approx(0.003)

    def test_low_sentiment_non_defensive(self):
        model = _make_model()
        assets = (_make_asset(is_defensive=False),)
        intel = MarketIntelContext(sentiment_score=20.0)
        inp = _minimal_input(assets=assets, market_intel=intel)
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_market == pytest.approx(-0.003)

    def test_energy_keyword_energy_asset(self):
        model = _make_model()
        assets = (_make_asset(is_energy=True),)
        intel = MarketIntelContext(sentiment_score=50.0, keywords=("資源高",))
        inp = _minimal_input(assets=assets, market_intel=intel)
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_market == pytest.approx(0.004)

    def test_energy_keyword_non_energy_asset(self):
        model = _make_model()
        assets = (_make_asset(is_energy=False),)
        intel = MarketIntelContext(sentiment_score=50.0, keywords=("資源高",))
        inp = _minimal_input(assets=assets, market_intel=intel)
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_market == pytest.approx(0.0)

    def test_yen_weak_keyword_overseas_asset(self):
        model = _make_model()
        assets = (_make_asset(is_overseas=True),)
        intel = MarketIntelContext(sentiment_score=50.0, keywords=("円安",))
        inp = _minimal_input(assets=assets, market_intel=intel)
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_market == pytest.approx(0.002)

    def test_yen_weak_keyword_domestic_asset(self):
        model = _make_model()
        assets = (_make_asset(is_overseas=False),)
        intel = MarketIntelContext(sentiment_score=50.0, keywords=("円安",))
        inp = _minimal_input(assets=assets, market_intel=intel)
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_market == pytest.approx(0.0)

    def test_combined_overlays(self):
        model = _make_model()
        assets = (_make_asset(is_energy=True, is_overseas=True),)
        intel = MarketIntelContext(sentiment_score=50.0, keywords=("資源高", "円安"))
        inp = _minimal_input(assets=assets, market_intel=intel)
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_market == pytest.approx(0.004 + 0.002)

    def test_keyword_partial_match_not_counted(self):
        # P1-8B: exact match only — "資源高騰" is NOT "資源高"
        model = _make_model()
        assets = (_make_asset(is_energy=True),)
        intel = MarketIntelContext(sentiment_score=50.0, keywords=("資源高騰",))
        inp = _minimal_input(assets=assets, market_intel=intel)
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_market == pytest.approx(0.0)

    def test_boundary_sentiment_70_not_high(self):
        # > 70 triggers, == 70 does not
        model = _make_model()
        assets = (_make_asset(is_risk_on=True),)
        intel = MarketIntelContext(sentiment_score=70.0)
        inp = _minimal_input(assets=assets, market_intel=intel)
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_market == pytest.approx(0.0)

    def test_boundary_sentiment_71_is_high(self):
        model = _make_model()
        assets = (_make_asset(is_risk_on=True),)
        intel = MarketIntelContext(sentiment_score=71.0)
        inp = _minimal_input(assets=assets, market_intel=intel)
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_market == pytest.approx(0.005)

    def test_boundary_sentiment_30_not_low(self):
        # < 30 triggers, == 30 does not
        model = _make_model()
        assets = (_make_asset(is_defensive=False),)
        intel = MarketIntelContext(sentiment_score=30.0)
        inp = _minimal_input(assets=assets, market_intel=intel)
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_market == pytest.approx(0.0)

    def test_boundary_sentiment_29_is_low(self):
        model = _make_model()
        assets = (_make_asset(is_defensive=False),)
        intel = MarketIntelContext(sentiment_score=29.0)
        inp = _minimal_input(assets=assets, market_intel=intel)
        result = model.calculate(inp)
        assert result.per_asset[0].alpha_market == pytest.approx(-0.003)


# ── expected_return 加算検証 ──────────────────────────────────────────────────

class TestExpectedReturnAdditive:
    def test_components_sum_to_expected_return(self):
        model = _make_model()
        assets = (_make_asset(size_segment="small_cap", is_energy=True),)
        intel = MarketIntelContext(sentiment_score=50.0, keywords=("資源高",))
        inp = ExpectedReturnInput(
            assets=assets,
            six_axis_scores={"7203": _six_axis(70.0)},
            cross_axis_signals={"7203": {"size_quality": 60.0, "anti_junk": 50.0}},
            regime="bull_calm",
            market_intel=intel,
        )
        result = model.calculate(inp)
        a = result.per_asset[0]
        total = a.mu_hist + a.alpha_score + a.alpha_cross + a.size_premium + a.alpha_market
        assert a.expected_return == pytest.approx(total)

    def test_expected_return_not_clamped(self):
        # P2-8A: no clamping — very high mu_hist passes through
        model = _make_model()
        assets = (_make_asset(mean_return_3y=10.0),)  # unrealistically large
        inp = _minimal_input(assets=assets)
        result = model.calculate(inp)
        assert result.per_asset[0].expected_return > 1.0

    def test_mu_hist_zero_valid(self):
        model = _make_model()
        assets = (_make_asset(mean_return_3y=0.0),)
        inp = _minimal_input(assets=assets)
        result = model.calculate(inp)
        # mu_hist=0.0, alpha adjustments should still apply
        assert result.per_asset[0].mu_hist == pytest.approx(0.0)


# ── diagnostics 検証 ──────────────────────────────────────────────────────────

class TestDiagnostics:
    def test_mandatory_observation_disclaimer_present(self):
        model = _make_model()
        result = model.calculate(_minimal_input())
        all_diags = " ".join(result.per_asset[0].diagnostics)
        assert "calculation-only, not an order, not a recommendation" in all_diags

    def test_all_diagnostics_start_with_observation(self):
        model = _make_model()
        intel = MarketIntelContext(sentiment_score=50.0)
        result = model.calculate(_minimal_input(market_intel=intel))
        for d in result.per_asset[0].diagnostics:
            assert d.startswith("observation:"), f"bad diag: {d!r}"

    def test_unknown_regime_diag_in_result(self):
        model = _make_model()
        result = model.calculate(_minimal_input(regime="BOGUS"))
        assert any("uncertain" in d for d in result.diagnostics)

    def test_p2_7f_marker_in_no_market_intel(self):
        model = _make_model()
        result = model.calculate(_minimal_input(market_intel=None))
        diags = " ".join(result.per_asset[0].diagnostics)
        assert "P2-7F" in diags

    def test_cross_diag_when_missing(self):
        model = _make_model()
        inp = _minimal_input(cross_axis_signals={})
        result = model.calculate(inp)
        diags = " ".join(result.per_asset[0].diagnostics)
        assert "cross_axis_signals" in diags

    def test_size_diag_when_unknown(self):
        model = _make_model()
        assets = (_make_asset(size_segment="UNKNOWN"),)
        inp = _minimal_input(assets=assets)
        result = model.calculate(inp)
        diags = " ".join(result.per_asset[0].diagnostics)
        assert "unknown size_segment" in diags


# ── get_expected_return インタフェース（P1-8C） ────────────────────────────────

class TestGetExpectedReturn:
    def test_known_ticker(self):
        model = _make_model()
        result = model.calculate(_minimal_input())
        val = result.get_expected_return("7203")
        assert val is not None
        assert isinstance(val, float)

    def test_unknown_ticker_returns_none(self):
        model = _make_model()
        result = model.calculate(_minimal_input())
        assert result.get_expected_return("XXXX") is None


# ── 全レジーム動作確認 ────────────────────────────────────────────────────────

class TestAllRegimes:
    @pytest.mark.parametrize("regime", [
        "bull_calm", "bull_volatile", "bear", "crisis", "uncertain"
    ])
    def test_valid_regime_used(self, regime: str):
        model = _make_model()
        result = model.calculate(_minimal_input(regime=regime))
        assert result.regime_used == regime

    def test_unknown_regime_becomes_uncertain(self):
        model = _make_model()
        result = model.calculate(_minimal_input(regime="sideways"))
        assert result.regime_used == "uncertain"


# ── to_dict 統合検証 ──────────────────────────────────────────────────────────

class TestToDictIntegration:
    def test_result_to_dict_serializable(self):
        import json
        model = _make_model()
        result = model.calculate(_minimal_input())
        d = result.to_dict()
        serialized = json.dumps(d)
        assert "7203" in serialized

    def test_asset_to_dict_values_match(self):
        model = _make_model()
        result = model.calculate(_minimal_input())
        a = result.per_asset[0]
        d = a.to_dict()
        assert d["ticker"] == a.ticker
        assert d["expected_return"] == pytest.approx(a.expected_return)
        assert d["mu_hist"] == pytest.approx(a.mu_hist)
