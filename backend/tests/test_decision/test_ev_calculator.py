"""
test_ev_calculator.py — Card 5-7 EVCalculator テスト（69 tests）

EVは補助指標。売買判断は含まない。
six_axis_scores / axis_weights / cross_axis_signals / market_intel_dict は
すべて DI dict fixture として渡す。
"""
from __future__ import annotations

import inspect
from dataclasses import FrozenInstanceError, fields

import pytest

from backend.engine.decision.ev_calculator import (
    CROSS_AXIS_WEIGHTS,
    DEFAULT_AXIS_IDS,
    SIZE_PREMIUMS,
    EVCalculator,
    EVInput,
    EVResult,
    ReplaceEVInput,
    ReplaceEVResult,
)

# ── フィクスチャ ──────────────────────────────────────────────────────────────

_AXIS_WEIGHTS: dict = {
    "value":               0.20,
    "quality":             0.20,
    "growth":              0.15,
    "safety":              0.20,
    "momentum":            0.15,
    "shareholder_return":  0.10,
}

_FULL_SCORES: dict = {
    "value":              {"total": 65},
    "quality":            {"total": 72},
    "growth":             {"total": 58},
    "safety":             {"total": 70},
    "momentum":           {"total": 60},
    "shareholder_return": {"total": 55},
}

_NEUTRAL_SCORES: dict = {axis: {"total": 50} for axis in _AXIS_WEIGHTS}

_CALCULATOR = EVCalculator()

_BASE_INPUT = EVInput(
    ticker="7203",
    mu_hist=0.08,
    six_axis_scores=_FULL_SCORES,
    axis_weights=_AXIS_WEIGHTS,
    size_segment="mid_cap",
)


# ── TestEVInput ───────────────────────────────────────────────────────────────

class TestEVInput:
    def test_frozen(self):
        inp = EVInput(
            ticker="7203", mu_hist=0.08,
            six_axis_scores={}, axis_weights={}, size_segment="mid_cap",
        )
        with pytest.raises((FrozenInstanceError, TypeError)):
            inp.ticker = "9999"  # type: ignore[misc]

    def test_required_fields(self):
        inp = EVInput(
            ticker="7203", mu_hist=0.08,
            six_axis_scores={"value": {"total": 60}},
            axis_weights={"value": 1.0},
            size_segment="small_cap",
        )
        assert inp.ticker == "7203"
        assert inp.mu_hist == 0.08
        assert inp.size_segment == "small_cap"

    def test_optional_bool_defaults(self):
        inp = EVInput(
            ticker="7203", mu_hist=0.0,
            six_axis_scores={}, axis_weights={}, size_segment="large_cap",
        )
        assert inp.is_risk_on is False
        assert inp.is_defensive is False
        assert inp.is_energy is False
        assert inp.is_overseas is False

    def test_optional_dict_defaults_empty(self):
        inp = EVInput(
            ticker="7203", mu_hist=0.0,
            six_axis_scores={}, axis_weights={}, size_segment="large_cap",
        )
        assert inp.cross_axis_signals == {}
        assert inp.market_intel_dict == {}

    def test_explicit_flags(self):
        inp = EVInput(
            ticker="7203", mu_hist=0.0,
            six_axis_scores={}, axis_weights={}, size_segment="large_cap",
            is_risk_on=True, is_energy=True,
        )
        assert inp.is_risk_on is True
        assert inp.is_energy is True


# ── TestEVResult ──────────────────────────────────────────────────────────────

class TestEVResult:
    def _make(self) -> EVResult:
        return _CALCULATOR.calc_ev(_BASE_INPUT)

    def test_frozen(self):
        r = self._make()
        with pytest.raises((FrozenInstanceError, TypeError)):
            r.ticker = "9999"  # type: ignore[misc]

    def test_fields_exist(self):
        r = self._make()
        assert hasattr(r, "ticker")
        assert hasattr(r, "mu_hist")
        assert hasattr(r, "alpha_score")
        assert hasattr(r, "alpha_cross")
        assert hasattr(r, "size_premium")
        assert hasattr(r, "alpha_market")
        assert hasattr(r, "ev_fund")
        assert hasattr(r, "ev_final")

    def test_ev_fund_composition(self):
        r = self._make()
        expected = r.mu_hist + r.alpha_score + r.alpha_cross + r.size_premium
        assert abs(r.ev_fund - expected) < 1e-12

    def test_ev_final_composition(self):
        r = self._make()
        expected = r.ev_fund + r.alpha_market
        assert abs(r.ev_final - expected) < 1e-12

    def test_ticker_preserved(self):
        r = self._make()
        assert r.ticker == "7203"


# ── TestReplaceEVInput ────────────────────────────────────────────────────────

class TestReplaceEVInput:
    def _make_result(self, ticker: str, ev_final: float) -> EVResult:
        return EVResult(
            ticker=ticker, mu_hist=0.08,
            alpha_score=0.0, alpha_cross=0.0, size_premium=0.005,
            alpha_market=0.0,
            ev_fund=ev_final, ev_final=ev_final,
        )

    def test_frozen(self):
        r_inp = ReplaceEVInput(
            candidate=self._make_result("7203", 0.09),
            incumbent=self._make_result("9984", 0.07),
            transaction_cost=0.003,
        )
        with pytest.raises((FrozenInstanceError, TypeError)):
            r_inp.transaction_cost = 0.0  # type: ignore[misc]

    def test_fields(self):
        r_inp = ReplaceEVInput(
            candidate=self._make_result("7203", 0.09),
            incumbent=self._make_result("9984", 0.07),
            transaction_cost=0.003,
        )
        assert r_inp.transaction_cost == 0.003
        assert r_inp.candidate.ticker == "7203"
        assert r_inp.incumbent.ticker == "9984"


# ── TestReplaceEVResult ───────────────────────────────────────────────────────

class TestReplaceEVResult:
    def _make(self) -> ReplaceEVResult:
        c = EVResult(ticker="7203", mu_hist=0.08, alpha_score=0.0, alpha_cross=0.0,
                     size_premium=0.005, alpha_market=0.0, ev_fund=0.085, ev_final=0.085)
        i = EVResult(ticker="9984", mu_hist=0.07, alpha_score=0.0, alpha_cross=0.0,
                     size_premium=0.005, alpha_market=0.0, ev_fund=0.075, ev_final=0.075)
        return _CALCULATOR.calc_replace_ev(ReplaceEVInput(candidate=c, incumbent=i,
                                                          transaction_cost=0.003))

    def test_frozen(self):
        r = self._make()
        with pytest.raises((FrozenInstanceError, TypeError)):
            r.replace_ev = 0.0  # type: ignore[misc]

    def test_fields(self):
        r = self._make()
        assert hasattr(r, "candidate_ticker")
        assert hasattr(r, "incumbent_ticker")
        assert hasattr(r, "candidate_ev_final")
        assert hasattr(r, "incumbent_ev_final")
        assert hasattr(r, "transaction_cost")
        assert hasattr(r, "replace_ev")

    def test_no_is_beneficial_field(self):
        r = self._make()
        assert not hasattr(r, "is_beneficial"), \
            "is_beneficial フィールドは売買判断につながるため禁止"

    def test_replace_ev_arithmetic(self):
        r = self._make()
        expected = 0.085 - 0.075 - 0.003
        assert abs(r.replace_ev - expected) < 1e-12


# ── TestEVCalculatorConstants ─────────────────────────────────────────────────

class TestEVCalculatorConstants:
    def test_size_premiums_keys(self):
        assert set(SIZE_PREMIUMS.keys()) == {"small_cap", "mid_cap", "large_cap"}

    def test_size_premiums_values(self):
        assert SIZE_PREMIUMS["small_cap"] == 0.012
        assert SIZE_PREMIUMS["mid_cap"]   == 0.005
        assert SIZE_PREMIUMS["large_cap"] == 0.000

    def test_default_axis_ids_count(self):
        assert len(DEFAULT_AXIS_IDS) == 6

    def test_default_axis_ids_content(self):
        assert set(DEFAULT_AXIS_IDS) == {
            "value", "quality", "growth", "safety", "momentum", "shareholder_return"
        }


# ── TestCalcAlphaScore ────────────────────────────────────────────────────────

class TestCalcAlphaScore:
    def test_all_50_gives_zero(self):
        alpha = _CALCULATOR._calc_alpha_score(_NEUTRAL_SCORES, _AXIS_WEIGHTS)
        assert abs(alpha) < 1e-12

    def test_all_100_gives_positive(self):
        scores = {axis: {"total": 100} for axis in _AXIS_WEIGHTS}
        alpha = _CALCULATOR._calc_alpha_score(scores, _AXIS_WEIGHTS)
        assert alpha > 0.0
        # sum(weight) = 1.0 → alpha = 1.0 * 0.001 = 0.001
        assert abs(alpha - 0.001) < 1e-12

    def test_all_0_gives_negative(self):
        scores = {axis: {"total": 0} for axis in _AXIS_WEIGHTS}
        alpha = _CALCULATOR._calc_alpha_score(scores, _AXIS_WEIGHTS)
        assert alpha < 0.0
        assert abs(alpha - (-0.001)) < 1e-12

    def test_missing_axis_defaults_50(self):
        # quality 欠損 → score_total=50 → 貢献 0
        scores = {k: v for k, v in _FULL_SCORES.items() if k != "quality"}
        alpha_with    = _CALCULATOR._calc_alpha_score(_FULL_SCORES,  _AXIS_WEIGHTS)
        alpha_without = _CALCULATOR._calc_alpha_score(scores, _AXIS_WEIGHTS)
        # quality score=72 の貢献: (72-50)/50 * 0.001 * 0.20 = 0.000088
        # 欠損→50 なら貢献=0
        assert alpha_with != alpha_without

    def test_empty_axis_weights_gives_zero(self):
        alpha = _CALCULATOR._calc_alpha_score(_FULL_SCORES, {})
        assert abs(alpha) < 1e-12

    def test_weight_proportional(self):
        scores = {"value": {"total": 100}}
        alpha_w1 = _CALCULATOR._calc_alpha_score(scores, {"value": 0.20})
        alpha_w2 = _CALCULATOR._calc_alpha_score(scores, {"value": 0.40})
        assert abs(alpha_w2 - alpha_w1 * 2) < 1e-12

    def test_symmetry(self):
        scores_high = {axis: {"total": 80} for axis in _AXIS_WEIGHTS}
        scores_low  = {axis: {"total": 20} for axis in _AXIS_WEIGHTS}
        alpha_high = _CALCULATOR._calc_alpha_score(scores_high, _AXIS_WEIGHTS)
        alpha_low  = _CALCULATOR._calc_alpha_score(scores_low,  _AXIS_WEIGHTS)
        assert abs(alpha_high + alpha_low) < 1e-12

    def test_missing_total_key_defaults_50(self):
        # "total" キーなし → fallback 50 → 貢献 0
        scores = {"value": {}}  # "total" キーなし
        alpha = _CALCULATOR._calc_alpha_score(scores, {"value": 1.0})
        assert abs(alpha) < 1e-12


# ── TestCalcAlphaCross ────────────────────────────────────────────────────────

class TestCalcAlphaCross:
    def test_empty_gives_zero(self):
        assert abs(_CALCULATOR._calc_alpha_cross({})) < 1e-12

    def test_size_quality_only(self):
        alpha = _CALCULATOR._calc_alpha_cross({"size_quality": 100})
        assert abs(alpha - 0.005) < 1e-12

    def test_anti_junk_only(self):
        alpha = _CALCULATOR._calc_alpha_cross({"anti_junk": 100})
        assert abs(alpha - 0.003) < 1e-12

    def test_both_signals(self):
        alpha = _CALCULATOR._calc_alpha_cross({"size_quality": 100, "anti_junk": 100})
        assert abs(alpha - 0.008) < 1e-12

    def test_negative_signals(self):
        alpha = _CALCULATOR._calc_alpha_cross({"size_quality": -100, "anti_junk": -100})
        assert abs(alpha - (-0.008)) < 1e-12


# ── TestCalcSizePremium ───────────────────────────────────────────────────────

class TestCalcSizePremium:
    def test_small_cap(self):
        assert _CALCULATOR._calc_size_premium("small_cap") == 0.012

    def test_mid_cap(self):
        assert _CALCULATOR._calc_size_premium("mid_cap") == 0.005

    def test_large_cap(self):
        assert _CALCULATOR._calc_size_premium("large_cap") == 0.000

    def test_unknown_segment_gives_zero(self):
        assert _CALCULATOR._calc_size_premium("mega_cap") == 0.0
        assert _CALCULATOR._calc_size_premium("") == 0.0


# ── TestCalcAlphaMarket ───────────────────────────────────────────────────────

class TestCalcAlphaMarket:
    def test_empty_dict_gives_zero(self):
        assert abs(_CALCULATOR._calc_alpha_market({}, False, False, False, False)) < 1e-12

    def test_sentiment_high_risk_on(self):
        intel = {"sentiment": {"score": 75}}
        alpha = _CALCULATOR._calc_alpha_market(intel, True, False, False, False)
        assert abs(alpha - 0.005) < 1e-12

    def test_sentiment_high_not_risk_on(self):
        intel = {"sentiment": {"score": 75}}
        alpha = _CALCULATOR._calc_alpha_market(intel, False, False, False, False)
        assert abs(alpha) < 1e-12

    def test_sentiment_low_defensive(self):
        intel = {"sentiment": {"score": 20}}
        alpha = _CALCULATOR._calc_alpha_market(intel, False, True, False, False)
        assert abs(alpha - 0.003) < 1e-12

    def test_sentiment_low_not_defensive(self):
        intel = {"sentiment": {"score": 20}}
        alpha = _CALCULATOR._calc_alpha_market(intel, False, False, False, False)
        assert abs(alpha - (-0.003)) < 1e-12

    def test_energy_keyword(self):
        intel = {"sentiment": {"score": 50}, "keywords": [{"tag": "資源高"}]}
        alpha = _CALCULATOR._calc_alpha_market(intel, False, False, True, False)
        assert abs(alpha - 0.004) < 1e-12

    def test_overseas_keyword(self):
        intel = {"sentiment": {"score": 50}, "keywords": [{"tag": "円安"}]}
        alpha = _CALCULATOR._calc_alpha_market(intel, False, False, False, True)
        assert abs(alpha - 0.002) < 1e-12

    def test_combined_keywords_and_sentiment(self):
        intel = {
            "sentiment": {"score": 75},
            "keywords": [{"tag": "資源高"}, {"tag": "円安"}],
        }
        alpha = _CALCULATOR._calc_alpha_market(intel, True, False, True, True)
        # risk_on: +0.005, energy: +0.004, overseas: +0.002
        assert abs(alpha - 0.011) < 1e-12

    def test_sentiment_missing_defaults_50(self):
        # sentiment キーなし → score=50 → 高/低どちらも発動しない
        intel = {"keywords": []}
        alpha = _CALCULATOR._calc_alpha_market(intel, True, True, False, False)
        assert abs(alpha) < 1e-12


# ── TestExtractKeywordTags ────────────────────────────────────────────────────

class TestExtractKeywordTags:
    def test_format1_dict_tag(self):
        intel = {"keywords": [{"tag": "資源高"}, {"tag": "円安"}]}
        tags = _CALCULATOR._extract_keyword_tags(intel)
        assert "資源高" in tags
        assert "円安" in tags

    def test_format2_str_list(self):
        intel = {"keywords": ["資源高", "円安"]}
        tags = _CALCULATOR._extract_keyword_tags(intel)
        assert "資源高" in tags
        assert "円安" in tags

    def test_format3_active_keywords_dict_tag(self):
        intel = {"active_keywords": [{"tag": "資源高"}]}
        tags = _CALCULATOR._extract_keyword_tags(intel)
        assert "資源高" in tags

    def test_format4_active_keywords_str_list(self):
        intel = {"active_keywords": ["資源高", "円安"]}
        tags = _CALCULATOR._extract_keyword_tags(intel)
        assert "資源高" in tags
        assert "円安" in tags

    def test_both_keys_merged(self):
        intel = {
            "keywords":        [{"tag": "資源高"}],
            "active_keywords": [{"tag": "円安"}],
        }
        tags = _CALCULATOR._extract_keyword_tags(intel)
        assert "資源高" in tags
        assert "円安" in tags
        assert len(tags) == 2

    def test_deduplication(self):
        intel = {
            "keywords":        ["資源高", "円安"],
            "active_keywords": ["資源高"],
        }
        tags = _CALCULATOR._extract_keyword_tags(intel)
        assert tags.count("資源高") == 1

    def test_empty_string_excluded(self):
        intel = {"keywords": ["", "資源高", ""]}
        tags = _CALCULATOR._extract_keyword_tags(intel)
        assert "" not in tags
        assert "資源高" in tags

    def test_missing_tag_key_no_error(self):
        intel = {"keywords": [{"name": "資源高"}]}  # "tag" キーなし
        tags = _CALCULATOR._extract_keyword_tags(intel)
        assert "" not in tags

    def test_unknown_item_type_ignored(self):
        intel = {"keywords": [42, None, {"tag": "資源高"}]}
        tags = _CALCULATOR._extract_keyword_tags(intel)
        assert "資源高" in tags
        assert len(tags) == 1

    def test_returns_tuple(self):
        tags = _CALCULATOR._extract_keyword_tags({"keywords": ["資源高"]})
        assert isinstance(tags, tuple)

    def test_empty_dict_gives_empty_tuple(self):
        tags = _CALCULATOR._extract_keyword_tags({})
        assert tags == ()

    def test_non_list_value_ignored(self):
        intel = {"keywords": "資源高"}  # list でない
        tags = _CALCULATOR._extract_keyword_tags(intel)
        assert tags == ()

    def test_deterministic_order(self):
        intel = {"keywords": ["円安", "資源高"]}
        t1 = _CALCULATOR._extract_keyword_tags(intel)
        t2 = _CALCULATOR._extract_keyword_tags(intel)
        assert t1 == t2


# ── TestCalcEVFund ────────────────────────────────────────────────────────────

class TestCalcEVFund:
    def test_basic(self):
        result = _CALCULATOR.calc_ev(_BASE_INPUT)
        assert isinstance(result, EVResult)

    def test_zero_alpha_ev_fund_equals_mu_hist_plus_size_premium(self):
        inp = EVInput(
            ticker="7203", mu_hist=0.08,
            six_axis_scores=_NEUTRAL_SCORES,
            axis_weights=_AXIS_WEIGHTS,
            size_segment="mid_cap",
        )
        r = _CALCULATOR.calc_ev(inp)
        expected = 0.08 + 0.0 + 0.0 + 0.005  # mu + score_alpha=0 + cross=0 + mid_cap
        assert abs(r.ev_fund - expected) < 1e-12

    def test_all_50_scores_alpha_score_zero(self):
        inp = EVInput(
            ticker="7203", mu_hist=0.08,
            six_axis_scores=_NEUTRAL_SCORES,
            axis_weights=_AXIS_WEIGHTS,
            size_segment="large_cap",
        )
        r = _CALCULATOR.calc_ev(inp)
        assert abs(r.alpha_score) < 1e-12

    def test_composition_check(self):
        r = _CALCULATOR.calc_ev(_BASE_INPUT)
        assert abs(r.ev_fund - (r.mu_hist + r.alpha_score + r.alpha_cross + r.size_premium)) < 1e-12

    def test_alpha_score_contribution(self):
        inp_neutral = EVInput(
            ticker="7203", mu_hist=0.08,
            six_axis_scores=_NEUTRAL_SCORES,
            axis_weights=_AXIS_WEIGHTS,
            size_segment="large_cap",
        )
        inp_high = EVInput(
            ticker="7203", mu_hist=0.08,
            six_axis_scores={axis: {"total": 100} for axis in _AXIS_WEIGHTS},
            axis_weights=_AXIS_WEIGHTS,
            size_segment="large_cap",
        )
        r_neutral = _CALCULATOR.calc_ev(inp_neutral)
        r_high    = _CALCULATOR.calc_ev(inp_high)
        assert r_high.ev_fund > r_neutral.ev_fund

    def test_cross_axis_contribution(self):
        inp_no_cross   = EVInput(
            ticker="7203", mu_hist=0.08,
            six_axis_scores=_NEUTRAL_SCORES, axis_weights=_AXIS_WEIGHTS,
            size_segment="large_cap",
        )
        inp_with_cross = EVInput(
            ticker="7203", mu_hist=0.08,
            six_axis_scores=_NEUTRAL_SCORES, axis_weights=_AXIS_WEIGHTS,
            size_segment="large_cap",
            cross_axis_signals={"size_quality": 100, "anti_junk": 100},
        )
        r_no   = _CALCULATOR.calc_ev(inp_no_cross)
        r_with = _CALCULATOR.calc_ev(inp_with_cross)
        assert r_with.ev_fund > r_no.ev_fund


# ── TestCalcEVFinal ───────────────────────────────────────────────────────────

class TestCalcEVFinal:
    def test_without_market_ev_final_equals_ev_fund(self):
        r = _CALCULATOR.calc_ev(_BASE_INPUT)
        assert abs(r.ev_final - r.ev_fund) < 1e-12

    def test_with_market_intel(self):
        inp = EVInput(
            ticker="7203", mu_hist=0.08,
            six_axis_scores=_NEUTRAL_SCORES,
            axis_weights=_AXIS_WEIGHTS,
            size_segment="mid_cap",
            is_risk_on=True,
            market_intel_dict={"sentiment": {"score": 80}},
        )
        r = _CALCULATOR.calc_ev(inp)
        assert abs(r.alpha_market - 0.005) < 1e-12

    def test_market_adds_alpha(self):
        inp_no_market   = _BASE_INPUT
        inp_with_market = EVInput(
            ticker="7203", mu_hist=0.08,
            six_axis_scores=_FULL_SCORES,
            axis_weights=_AXIS_WEIGHTS,
            size_segment="mid_cap",
            is_risk_on=True,
            market_intel_dict={"sentiment": {"score": 80}},
        )
        r_no   = _CALCULATOR.calc_ev(inp_no_market)
        r_with = _CALCULATOR.calc_ev(inp_with_market)
        assert r_with.ev_final > r_no.ev_final

    def test_composition_ev_final(self):
        r = _CALCULATOR.calc_ev(_BASE_INPUT)
        assert abs(r.ev_final - (r.ev_fund + r.alpha_market)) < 1e-12

    def test_ticker_in_result(self):
        r = _CALCULATOR.calc_ev(_BASE_INPUT)
        assert r.ticker == _BASE_INPUT.ticker


# ── TestCalcReplaceEV ─────────────────────────────────────────────────────────

class TestCalcReplaceEV:
    def _make_ev_result(self, ticker: str, ev_final: float) -> EVResult:
        return EVResult(
            ticker=ticker, mu_hist=0.08,
            alpha_score=0.0, alpha_cross=0.0,
            size_premium=0.005, alpha_market=0.0,
            ev_fund=ev_final, ev_final=ev_final,
        )

    def test_candidate_better(self):
        c = self._make_ev_result("7203", 0.09)
        i = self._make_ev_result("9984", 0.07)
        r = _CALCULATOR.calc_replace_ev(ReplaceEVInput(candidate=c, incumbent=i, transaction_cost=0.003))
        expected = 0.09 - 0.07 - 0.003
        assert abs(r.replace_ev - expected) < 1e-12

    def test_incumbent_better(self):
        c = self._make_ev_result("7203", 0.06)
        i = self._make_ev_result("9984", 0.09)
        r = _CALCULATOR.calc_replace_ev(ReplaceEVInput(candidate=c, incumbent=i, transaction_cost=0.003))
        assert r.replace_ev < 0.0

    def test_zero_cost(self):
        c = self._make_ev_result("7203", 0.09)
        i = self._make_ev_result("9984", 0.07)
        r = _CALCULATOR.calc_replace_ev(ReplaceEVInput(candidate=c, incumbent=i, transaction_cost=0.0))
        expected = 0.09 - 0.07
        assert abs(r.replace_ev - expected) < 1e-12

    def test_cost_dominates(self):
        c = self._make_ev_result("7203", 0.08)
        i = self._make_ev_result("9984", 0.07)
        r = _CALCULATOR.calc_replace_ev(ReplaceEVInput(candidate=c, incumbent=i, transaction_cost=0.05))
        assert r.replace_ev < 0.0

    def test_fields_check(self):
        c = self._make_ev_result("7203", 0.09)
        i = self._make_ev_result("9984", 0.07)
        r = _CALCULATOR.calc_replace_ev(ReplaceEVInput(candidate=c, incumbent=i, transaction_cost=0.003))
        assert r.candidate_ticker == "7203"
        assert r.incumbent_ticker == "9984"
        assert r.candidate_ev_final == 0.09
        assert r.incumbent_ev_final == 0.07
        assert r.transaction_cost == 0.003

    def test_replace_ev_no_judgment_field(self):
        c = self._make_ev_result("7203", 0.09)
        i = self._make_ev_result("9984", 0.07)
        r = _CALCULATOR.calc_replace_ev(ReplaceEVInput(candidate=c, incumbent=i, transaction_cost=0.003))
        assert not hasattr(r, "is_beneficial")
        assert not hasattr(r, "action")
        assert not hasattr(r, "recommendation")


# ── TestEdgeCases ─────────────────────────────────────────────────────────────

class TestEdgeCases:
    def test_negative_mu_hist(self):
        inp = EVInput(
            ticker="7203", mu_hist=-0.05,
            six_axis_scores=_NEUTRAL_SCORES,
            axis_weights=_AXIS_WEIGHTS,
            size_segment="large_cap",
        )
        r = _CALCULATOR.calc_ev(inp)
        assert r.ev_fund < 0.0

    def test_extreme_score_100_all_axes(self):
        inp = EVInput(
            ticker="7203", mu_hist=0.08,
            six_axis_scores={axis: {"total": 100} for axis in _AXIS_WEIGHTS},
            axis_weights=_AXIS_WEIGHTS,
            size_segment="large_cap",
        )
        r = _CALCULATOR.calc_ev(inp)
        assert r.alpha_score > 0.0

    def test_extreme_score_0_all_axes(self):
        inp = EVInput(
            ticker="7203", mu_hist=0.08,
            six_axis_scores={axis: {"total": 0} for axis in _AXIS_WEIGHTS},
            axis_weights=_AXIS_WEIGHTS,
            size_segment="large_cap",
        )
        r = _CALCULATOR.calc_ev(inp)
        assert r.alpha_score < 0.0

    def test_cross_axis_zero_default(self):
        r = _CALCULATOR.calc_ev(_BASE_INPUT)
        assert abs(r.alpha_cross) < 1e-12

    def test_no_forbidden_imports(self):
        import backend.engine.decision.ev_calculator as mod
        import_lines = [
            line.strip()
            for line in inspect.getsource(mod).splitlines()
            if line.strip().startswith(("import ", "from "))
        ]
        src_imports = "\n".join(import_lines)
        forbidden = [
            "import requests", "import httpx", "import aiohttp",
            "import urllib.request", "import openai", "import anthropic",
            "import litellm", "import ollama", "import pandas", "import numpy",
            "from backend.engine.regime",
            "from backend.engine.operation",
            "from backend.engine.market_intel",
            "from backend.engine.news",
            "from backend.engine.scoring",
        ]
        for item in forbidden:
            assert item not in src_imports, f"禁止 import が含まれている: {item}"
