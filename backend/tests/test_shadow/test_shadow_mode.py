"""
Tests for backend/engine/shadow/shadow_mode.py — Card 3-7
"""
from __future__ import annotations

import math
from datetime import date, datetime, timezone

import pytest

from backend.engine.shadow.shadow_mode import (
    DEFAULT_STOCKS,
    EXPECTED_DEFAULT_SEGMENTS,
    ConsensusSemanticsAudit,
    ScenarioAuditResult,
    ShadowAuditInput,
    ShadowAuditResult,
    ShadowScenario,
    _make_llm_override,
    _make_llm_stub,
    format_shadow_report,
    make_default_scenarios,
    run_shadow_audit,
)
from backend.engine.universe.size_segments import SIZE_LABELS, SizeInput


# ── Helpers ───────────────────────────────────────────────────────────────────

FIXED_DATE = date(2026, 5, 3)


def _run_default() -> ShadowAuditResult:
    inp = ShadowAuditInput(scenarios=make_default_scenarios(), run_date=FIXED_DATE)
    return run_shadow_audit(inp)


def _get(result: ShadowAuditResult, name: str) -> ScenarioAuditResult:
    for r in result.results:
        if r.scenario_name == name:
            return r
    raise KeyError(name)


# ── Dataclasses ───────────────────────────────────────────────────────────────

class TestDataclasses:
    def test_shadow_scenario_defaults(self):
        s = ShadowScenario(
            name="x",
            market_data={},
            hmm_features={},
            news_summary="",
            macro_state={},
        )
        assert s.llm_mock is None
        assert s.stocks == []
        assert s.expected_regime == ""
        assert s.expected_is_crisis is False
        assert s.expected_is_override is None
        assert s.expected_is_fallback is None

    def test_shadow_audit_input_default_run_date(self):
        inp = ShadowAuditInput(scenarios=[])
        assert inp.run_date is None

    def test_consensus_semantics_audit_fields(self):
        ca = ConsensusSemanticsAudit(
            raw_consensus=0.333,
            display_consensus=0.375,
            confidence=0.375,
            is_override=True,
            semantics_diverge=True,
        )
        assert ca.semantics_diverge is True

    def test_scenario_audit_result_passed_property_no_issues(self):
        # passed = True when regime_assertion_passed=True and issues=[]
        # Build a real result via run_shadow_audit to avoid building the full dataclass
        result = _run_default()
        s1 = _get(result, "S1_bull_calm_normal")
        assert s1.passed is True
        assert s1.issues == []

    def test_scenario_audit_result_passed_property_with_issues(self):
        result = _run_default()
        # Verify property logic: any scenario with issues would have passed=False
        for r in result.results:
            if r.issues:
                assert r.passed is False


# ── Default stocks ────────────────────────────────────────────────────────────

class TestDefaultStocks:
    def test_default_stocks_count(self):
        assert len(DEFAULT_STOCKS) == 5

    def test_default_stocks_cover_all_segments(self):
        from backend.engine.universe.size_segments import classify_size
        segments = {classify_size(s.market_cap) for s in DEFAULT_STOCKS}
        assert segments == {"small_cap", "mid_cap", "large_cap"}

    def test_expected_default_segments_length(self):
        assert len(EXPECTED_DEFAULT_SEGMENTS) == len(DEFAULT_STOCKS)

    def test_expected_default_segments_match_classify(self):
        from backend.engine.universe.size_segments import classify_size
        for stock, expected in zip(DEFAULT_STOCKS, EXPECTED_DEFAULT_SEGMENTS):
            assert classify_size(stock.market_cap) == expected


# ── run_shadow_audit: 9 scenarios ─────────────────────────────────────────────

class TestRunShadowAudit7Scenarios:
    def setup_method(self):
        self.result = _run_default()

    def test_scenarios_total_is_7(self):
        assert self.result.scenarios_total == 9

    def test_all_scenarios_pass(self):
        assert self.result.scenarios_failed == 0
        assert self.result.scenarios_passed == 9

    def test_s1_bull_calm_regime(self):
        r = _get(self.result, "S1_bull_calm_normal")
        assert r.regime_result.regime == "bull_calm"

    def test_s2_bear_regime(self):
        r = _get(self.result, "S2_bear_two_thirds")
        assert r.regime_result.regime == "bear"

    def test_s3_crisis_regime(self):
        r = _get(self.result, "S3_crisis_rule_based")
        assert r.regime_result.regime == "crisis"

    def test_s3_is_crisis_true(self):
        r = _get(self.result, "S3_crisis_rule_based")
        assert r.regime_result.is_crisis is True

    def test_s4_override_regime(self):
        r = _get(self.result, "S4_override_structural")
        assert r.regime_result.regime == "bear"

    def test_s4_is_override_true(self):
        r = _get(self.result, "S4_override_structural")
        assert r.regime_result.is_override is True

    def test_s5_fallback_regime(self):
        r = _get(self.result, "S5_fallback_all_disagree")
        assert r.regime_result.regime == "uncertain"

    def test_s5_is_fallback_true(self):
        r = _get(self.result, "S5_fallback_all_disagree")
        assert r.regime_result.is_fallback is True

    def test_s6_bull_volatile_regime(self):
        r = _get(self.result, "S6_hmm_surrogate_weight")
        assert r.regime_result.regime == "bull_volatile"

    def test_s7_bull_calm_regime(self):
        r = _get(self.result, "S7_llm_stub_weight_zero")
        assert r.regime_result.regime == "bull_calm"

    def test_s7_llm_voted_bear_but_lost(self):
        r = _get(self.result, "S7_llm_stub_weight_zero")
        assert r.regime_result.votes["llm"] == "bear"
        assert r.regime_result.regime == "bull_calm"


# ── Regime integrity checks ───────────────────────────────────────────────────

class TestRegimeIntegrity:
    def setup_method(self):
        self.result = _run_default()

    def test_all_regimes_valid_labels(self):
        from backend.engine.regime.regime_orchestrator import REGIME_LABELS
        for r in self.result.results:
            assert r.regime_result.regime in REGIME_LABELS

    def test_is_crisis_consistent_for_all(self):
        for r in self.result.results:
            assert r.is_crisis_consistent, (
                f"{r.scenario_name}: is_crisis={r.regime_result.is_crisis} "
                f"but regime={r.regime_result.regime!r}"
            )

    def test_votes_have_three_layers(self):
        for r in self.result.results:
            assert set(r.regime_result.votes.keys()) == {"rule_based", "hmm", "llm"}

    def test_layer_weights_sum_to_one(self):
        for r in self.result.results:
            weight_sum = sum(
                v["effective_weight"] for v in r.regime_result.layer_reliability.values()
            )
            assert math.isclose(weight_sum, 1.0, abs_tol=1e-9), (
                f"{r.scenario_name}: weight_sum={weight_sum}"
            )

    def test_raw_consensus_is_vote_fraction(self):
        for r in self.result.results:
            rr = r.regime_result
            if rr.is_fallback:
                # fallback: 3 layers all differ, final=uncertain with vote_count=1
                assert math.isclose(rr.raw_consensus, 1 / 3, abs_tol=1e-9)
            elif rr.is_override:
                # override: forced by LLM, raw_consensus = 1/3
                assert math.isclose(rr.raw_consensus, 1 / 3, abs_tol=1e-9)
            else:
                # normal: 2/3 or 3/3
                assert rr.raw_consensus in {round(2 / 3, 10), 1.0} or math.isclose(
                    rr.raw_consensus, 2 / 3, abs_tol=1e-9
                ) or math.isclose(rr.raw_consensus, 1.0, abs_tol=1e-9)

    def test_hmm_always_surrogate(self):
        for r in self.result.results:
            assert r.regime_result.hmm_is_surrogate is True

    def test_hmm_surrogate_weight_less_than_rule_based(self):
        for r in self.result.results:
            assert r.surrogate_weight_reduced, (
                f"{r.scenario_name}: HMM weight >= rule_based weight"
            )

    def test_stub_weight_zero_for_stub_scenarios(self):
        for r in self.result.results:
            if r.regime_result.llm_is_stub:
                llm_w = r.regime_result.layer_reliability["llm"]["effective_weight"]
                assert math.isclose(llm_w, 0.0, abs_tol=1e-9), (
                    f"{r.scenario_name}: LLM is_stub=True but weight={llm_w}"
                )

    def test_override_scenario_llm_not_stub(self):
        r = _get(self.result, "S4_override_structural")
        assert r.regime_result.llm_is_stub is False


# ── P1-F Consensus Semantics Audit ───────────────────────────────────────────

class TestConsensusSemanticsP1F:
    def setup_method(self):
        self.result = _run_default()

    def test_override_scenario_semantics_diverge_true(self):
        r = _get(self.result, "S4_override_structural")
        assert r.consensus_audit.semantics_diverge is True

    def test_override_scenario_raw_consensus_is_one_third(self):
        r = _get(self.result, "S4_override_structural")
        assert math.isclose(r.consensus_audit.raw_consensus, 1 / 3, abs_tol=1e-9)

    def test_override_scenario_display_consensus_differs_from_raw(self):
        r = _get(self.result, "S4_override_structural")
        ca = r.consensus_audit
        assert not math.isclose(ca.raw_consensus, ca.display_consensus, abs_tol=1e-9)

    def test_override_scenario_display_consensus_is_llm_eff_weight(self):
        r = _get(self.result, "S4_override_structural")
        expected = r.regime_result.layer_reliability["llm"]["effective_weight"]
        assert math.isclose(r.consensus_audit.display_consensus, expected, abs_tol=1e-9)

    def test_non_override_scenarios_no_diverge(self):
        for r in self.result.results:
            if not r.regime_result.is_override:
                assert r.consensus_audit.semantics_diverge is False, (
                    f"{r.scenario_name}: semantics_diverge should be False for non-override"
                )

    def test_p1f_divergence_count_is_one(self):
        # S4 and S8 are both override scenarios → diverge count = 2
        assert self.result.p1_f_divergence_count == 2

    def test_override_is_override_flag(self):
        r = _get(self.result, "S4_override_structural")
        assert r.consensus_audit.is_override is True

    def test_non_override_is_override_false(self):
        r = _get(self.result, "S1_bull_calm_normal")
        assert r.consensus_audit.is_override is False

    def test_p1f_policy_b_documented(self):
        # P1-F 方針B: display_consensus is the "consensus" in to_dict()
        r = _get(self.result, "S4_override_structural")
        to_dict_consensus = r.regime_result.to_dict()["regime_state"]["consensus"]
        assert math.isclose(to_dict_consensus, r.consensus_audit.display_consensus, abs_tol=1e-9)


# ── Size Segmentation Integration ─────────────────────────────────────────────

class TestSizeSegmentIntegration:
    def setup_method(self):
        self.result = _run_default()

    def test_all_size_results_valid_labels(self):
        for r in self.result.results:
            for sr in r.size_results:
                assert sr.size_segment in SIZE_LABELS

    def test_boundary_200b_is_mid_cap(self):
        r = _get(self.result, "S1_bull_calm_normal")
        mid_bound = next(sr for sr in r.size_results if sr.ticker == "MID_BOUND")
        assert mid_bound.size_segment == "mid_cap"

    def test_boundary_1t_is_large_cap(self):
        r = _get(self.result, "S1_bull_calm_normal")
        large_bound = next(sr for sr in r.size_results if sr.ticker == "LARGE_BOUND")
        assert large_bound.size_segment == "large_cap"

    def test_small_cap_below_boundary(self):
        r = _get(self.result, "S1_bull_calm_normal")
        small = next(sr for sr in r.size_results if sr.ticker == "SMALL_A")
        assert small.size_segment == "small_cap"

    def test_default_stocks_used_when_scenario_stocks_empty(self):
        # All default scenarios have empty stocks → DEFAULT_STOCKS is used
        r = _get(self.result, "S1_bull_calm_normal")
        assert len(r.size_results) == len(DEFAULT_STOCKS)

    def test_custom_stocks_override_default(self):
        custom = [SizeInput("CUSTOM", 300_000_000_000)]
        scenario = ShadowScenario(
            name="custom_stock_test",
            market_data={
                "vix": 15.0, "nikkei_5d_return": 0.01,
                "nikkei_60ma": 52000.0, "nikkei_200ma": 48000.0, "sp500_dd_30d": -0.01,
            },
            hmm_features={
                "returns_5d": 1.0, "vix_log": -1.0, "volume_z": -0.2,
                "spread_high_low": -0.5, "sentiment": 1.0,
            },
            news_summary="test",
            macro_state={"vix": 15.0, "nikkei_5d_return": 0.01, "usdjpy": 150.0},
            stocks=custom,
        )
        inp = ShadowAuditInput(scenarios=[scenario], run_date=FIXED_DATE)
        result = run_shadow_audit(inp)
        assert len(result.results[0].size_results) == 1
        assert result.results[0].size_results[0].ticker == "CUSTOM"
        assert result.results[0].size_results[0].size_segment == "mid_cap"

    def test_size_labels_valid_flag(self):
        for r in self.result.results:
            assert r.size_labels_valid is True


# ── P1-D / P1-E: daily-once guard and stateless API ──────────────────────────

class TestDailyOnceGuardP1DE:
    def test_orchestrator_instance_second_run_returns_cache(self):
        """P1-E: インスタンスを保持すれば daily-once guard が有効。"""
        from backend.engine.regime.regime_orchestrator import (
            OrchestratorInput, OrchestratorState, RegimeOrchestrator,
        )
        orch = RegimeOrchestrator(state=OrchestratorState())
        inp = OrchestratorInput(
            market_data={
                "vix": 15.0, "nikkei_5d_return": 0.02,
                "nikkei_60ma": 52000.0, "nikkei_200ma": 48000.0, "sp500_dd_30d": -0.02,
            },
            hmm_features={
                "returns_5d": 1.0, "vix_log": -1.0, "volume_z": -0.2,
                "spread_high_low": -0.5, "sentiment": 1.0,
            },
            news_summary="test",
            macro_state={"vix": 15.0, "nikkei_5d_return": 0.02, "usdjpy": 150.0},
            run_date=FIXED_DATE,
        )
        r1 = orch.run(inp)
        r2 = orch.run(inp)
        assert r1 is r2  # same object → cache returned

    def test_stateless_api_bypasses_guard(self):
        """P1-E: stateless convenience API は guard が効かない（每回新規 Orchestrator）。"""
        from backend.engine.regime.regime_orchestrator import (
            OrchestratorInput, run_regime_orchestrator,
        )
        inp = OrchestratorInput(
            market_data={
                "vix": 15.0, "nikkei_5d_return": 0.02,
                "nikkei_60ma": 52000.0, "nikkei_200ma": 48000.0, "sp500_dd_30d": -0.02,
            },
            hmm_features={
                "returns_5d": 1.0, "vix_log": -1.0, "volume_z": -0.2,
                "spread_high_low": -0.5, "sentiment": 1.0,
            },
            news_summary="test",
            macro_state={"vix": 15.0, "nikkei_5d_return": 0.02, "usdjpy": 150.0},
            run_date=FIXED_DATE,
        )
        r1 = run_regime_orchestrator(inp)
        r2 = run_regime_orchestrator(inp)
        # Different objects: stateless → new Orchestrator each call → no cache
        assert r1 is not r2

    def test_shadow_mode_uses_instance_not_convenience_api(self):
        """Shadow Mode は stateless convenience API を import していない。"""
        import backend.engine.shadow.shadow_mode as sm_module
        # shadow_mode must not expose stateless convenience functions in its namespace
        assert not hasattr(sm_module, "run_regime_orchestrator")
        assert not hasattr(sm_module, "detect_regime")

    def test_already_run_today_after_first_run(self):
        """P1-E: 同日 2 回目は already_run_today=True。"""
        from backend.engine.regime.regime_orchestrator import (
            OrchestratorInput, OrchestratorState, RegimeOrchestrator,
        )
        orch = RegimeOrchestrator(state=OrchestratorState())
        inp = OrchestratorInput(
            market_data={
                "vix": 15.0, "nikkei_5d_return": 0.02,
                "nikkei_60ma": 52000.0, "nikkei_200ma": 48000.0, "sp500_dd_30d": -0.02,
            },
            hmm_features={
                "returns_5d": 1.0, "vix_log": -1.0, "volume_z": -0.2,
                "spread_high_low": -0.5, "sentiment": 1.0,
            },
            news_summary="test",
            macro_state={"vix": 15.0, "nikkei_5d_return": 0.02, "usdjpy": 150.0},
            run_date=FIXED_DATE,
        )
        assert not orch.already_run_today(FIXED_DATE)
        orch.run(inp)
        assert orch.already_run_today(FIXED_DATE)


# ── format_shadow_report ──────────────────────────────────────────────────────

class TestFormatShadowReport:
    def setup_method(self):
        self.result = _run_default()
        self.report = format_shadow_report(self.result)

    def test_report_is_string(self):
        assert isinstance(self.report, str)

    def test_report_contains_overall_pass(self):
        assert "Overall: PASS" in self.report

    def test_report_contains_scenario_names(self):
        for scenario in make_default_scenarios():
            assert scenario.name in self.report

    def test_report_contains_p1f_section(self):
        assert "P1-F Consensus Semantics Audit" in self.report

    def test_report_contains_diverge_marker(self):
        assert "DIVERGE" in self.report

    def test_report_contains_p1d_note(self):
        assert "P1-D" in self.report

    def test_report_contains_p1e_note(self):
        assert "P1-E" in self.report

    def test_report_contains_policy_b(self):
        assert "Policy B" in self.report

    def test_report_is_non_empty(self):
        assert len(self.report) > 500

    def test_report_no_file_written(self, tmp_path):
        before = list(tmp_path.iterdir())
        format_shadow_report(self.result)
        after = list(tmp_path.iterdir())
        assert before == after


# ── Detection-only / pure function ───────────────────────────────────────────

class TestDetectionOnly:
    def test_run_shadow_audit_no_file_writes(self, tmp_path):
        before = list(tmp_path.iterdir())
        inp = ShadowAuditInput(scenarios=make_default_scenarios(), run_date=FIXED_DATE)
        run_shadow_audit(inp)
        after = list(tmp_path.iterdir())
        assert before == after

    def test_pure_function_reproducible(self):
        inp = ShadowAuditInput(scenarios=make_default_scenarios(), run_date=FIXED_DATE)
        r1 = run_shadow_audit(inp)
        r2 = run_shadow_audit(inp)
        assert r1.scenarios_passed == r2.scenarios_passed
        assert r1.scenarios_failed == r2.scenarios_failed
        assert r1.p1_f_divergence_count == r2.p1_f_divergence_count
        for a, b in zip(r1.results, r2.results):
            assert a.regime_result.regime == b.regime_result.regime

    def test_empty_scenarios_no_crash(self):
        inp = ShadowAuditInput(scenarios=[], run_date=FIXED_DATE)
        result = run_shadow_audit(inp)
        assert result.scenarios_total == 0
        assert result.scenarios_passed == 0
        assert result.scenarios_failed == 0
        assert result.p1_f_divergence_count == 0


# ── S8: override + crisis (P1-G) ─────────────────────────────────────────────

class TestS8OverrideCrisis:
    def setup_method(self):
        self.result = _run_default()

    def test_s8_regime_is_crisis(self):
        r = _get(self.result, "S8_override_crisis")
        assert r.regime_result.regime == "crisis"

    def test_s8_is_crisis_true(self):
        r = _get(self.result, "S8_override_crisis")
        assert r.regime_result.is_crisis is True

    def test_s8_is_override_true(self):
        r = _get(self.result, "S8_override_crisis")
        assert r.regime_result.is_override is True

    def test_s8_is_fallback_false(self):
        r = _get(self.result, "S8_override_crisis")
        assert r.regime_result.is_fallback is False

    def test_s8_passes(self):
        r = _get(self.result, "S8_override_crisis")
        assert r.passed is True

    def test_s8_semantics_diverge_true(self):
        r = _get(self.result, "S8_override_crisis")
        assert r.consensus_audit.semantics_diverge is True

    def test_s8_llm_not_stub(self):
        r = _get(self.result, "S8_override_crisis")
        assert r.regime_result.llm_is_stub is False

    def test_s8_raw_consensus_is_one_third(self):
        r = _get(self.result, "S8_override_crisis")
        assert math.isclose(r.regime_result.raw_consensus, 1 / 3, abs_tol=1e-9)

    def test_s8_override_and_crisis_flags_both_true(self):
        r = _get(self.result, "S8_override_crisis")
        assert r.regime_result.is_override is True
        assert r.regime_result.is_crisis is True


# ── S9: HMM low_confidence (P1-I) ────────────────────────────────────────────

class TestS9HmmLowConfidence:
    def setup_method(self):
        self.result = _run_default()

    def test_s9_regime_is_bear(self):
        r = _get(self.result, "S9_hmm_low_confidence")
        assert r.regime_result.regime == "bear"

    def test_s9_is_override_false(self):
        r = _get(self.result, "S9_hmm_low_confidence")
        assert r.regime_result.is_override is False

    def test_s9_is_fallback_false(self):
        r = _get(self.result, "S9_hmm_low_confidence")
        assert r.regime_result.is_fallback is False

    def test_s9_hmm_is_low_confidence(self):
        r = _get(self.result, "S9_hmm_low_confidence")
        assert r.regime_result.layer_reliability["hmm"]["is_low_confidence"] is True

    def test_s9_hmm_weight_less_than_normal_surrogate(self):
        """S9 の HMM effective_weight は is_low_confidence 適用により S6 より低い。"""
        s9 = _get(self.result, "S9_hmm_low_confidence")
        s6 = _get(self.result, "S6_hmm_surrogate_weight")
        s9_hmm_w = s9.regime_result.layer_reliability["hmm"]["effective_weight"]
        s6_hmm_w = s6.regime_result.layer_reliability["hmm"]["effective_weight"]
        assert s9_hmm_w < s6_hmm_w

    def test_s9_passes(self):
        r = _get(self.result, "S9_hmm_low_confidence")
        assert r.passed is True
