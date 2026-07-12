"""
Tests for backend/engine/snapshot/regime_state_schema.py — Card 3-8
"""
from __future__ import annotations

import math
from datetime import date

import pytest

from backend.engine.snapshot.regime_state_schema import (
    SCHEMA_VERSION,
    build_regime_state_dict,
)
from backend.engine.shadow.shadow_mode import (
    ShadowAuditInput,
    make_default_scenarios,
    run_shadow_audit,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

FIXED_DATE = date(2026, 5, 3)


def _run_default():
    inp = ShadowAuditInput(scenarios=make_default_scenarios(), run_date=FIXED_DATE)
    return run_shadow_audit(inp)


def _get_regime_result(name: str):
    result = _run_default()
    for r in result.results:
        if r.scenario_name == name:
            return r.regime_result
    raise KeyError(name)


# ── Schema version ────────────────────────────────────────────────────────────

class TestSchemaVersion:
    def test_schema_version_constant(self):
        assert SCHEMA_VERSION == "3.8"

    def test_schema_version_in_regime_state(self):
        rr = _get_regime_result("S1_bull_calm_normal")
        d = build_regime_state_dict(rr)
        assert d["regime_state"]["schema_version"] == "3.8"

    def test_schema_version_not_at_top_level(self):
        rr = _get_regime_result("S1_bull_calm_normal")
        d = build_regime_state_dict(rr)
        assert "schema_version" not in d  # inside regime_state, not at top


# ── Top-level structure ───────────────────────────────────────────────────────

class TestTopLevelStructure:
    def test_has_regime_state_key(self):
        rr = _get_regime_result("S1_bull_calm_normal")
        d = build_regime_state_dict(rr)
        assert "regime_state" in d

    def test_has_metadata_key(self):
        rr = _get_regime_result("S1_bull_calm_normal")
        d = build_regime_state_dict(rr)
        assert "_metadata" in d

    def test_metadata_parallel_to_regime_state(self):
        # _metadata and regime_state are both top-level keys
        rr = _get_regime_result("S1_bull_calm_normal")
        d = build_regime_state_dict(rr)
        assert set(d.keys()) == {"regime_state", "_metadata"}

    def test_regime_state_is_dict(self):
        rr = _get_regime_result("S1_bull_calm_normal")
        d = build_regime_state_dict(rr)
        assert isinstance(d["regime_state"], dict)

    def test_metadata_is_dict(self):
        rr = _get_regime_result("S1_bull_calm_normal")
        d = build_regime_state_dict(rr)
        assert isinstance(d["_metadata"], dict)


# ── P1-F: consensus key name maintained (方針B) ───────────────────────────────

class TestP1FConsensusKeyName:
    def test_consensus_key_exists(self):
        rr = _get_regime_result("S1_bull_calm_normal")
        d = build_regime_state_dict(rr)
        assert "consensus" in d["regime_state"]

    def test_raw_consensus_coexists(self):
        rr = _get_regime_result("S1_bull_calm_normal")
        d = build_regime_state_dict(rr)
        assert "raw_consensus" in d["regime_state"]

    def test_consensus_not_renamed_to_display_consensus(self):
        # 方針B: consensus キー名を維持 (display_consensus に改名しない)
        rr = _get_regime_result("S4_override_structural")
        d = build_regime_state_dict(rr)
        assert "consensus" in d["regime_state"]
        assert "display_consensus" not in d["regime_state"]


# ── _metadata.p1f_consensus_semantics ────────────────────────────────────────

class TestP1FMetadata:
    def test_p1f_semantics_key_in_metadata(self):
        rr = _get_regime_result("S1_bull_calm_normal")
        d = build_regime_state_dict(rr)
        assert "p1f_consensus_semantics" in d["_metadata"]

    def test_p1f_semantics_has_required_fields(self):
        rr = _get_regime_result("S1_bull_calm_normal")
        p1f = build_regime_state_dict(rr)["_metadata"]["p1f_consensus_semantics"]
        assert "raw_consensus" in p1f
        assert "display_consensus" in p1f
        assert "confidence" in p1f
        assert "is_override" in p1f
        assert "semantics_diverge" in p1f

    def test_p1f_no_diverge_non_override(self):
        # S1: no override → semantics_diverge=False
        rr = _get_regime_result("S1_bull_calm_normal")
        p1f = build_regime_state_dict(rr)["_metadata"]["p1f_consensus_semantics"]
        assert p1f["semantics_diverge"] is False
        assert p1f["is_override"] is False

    def test_p1f_diverge_s4_override(self):
        # S4: override → semantics_diverge=True (raw_consensus=1/3, display≠1/3)
        rr = _get_regime_result("S4_override_structural")
        p1f = build_regime_state_dict(rr)["_metadata"]["p1f_consensus_semantics"]
        assert p1f["is_override"] is True
        assert p1f["semantics_diverge"] is True

    def test_p1f_raw_consensus_is_vote_fraction_non_override(self):
        # S1: 3/3 一致 → raw=display=1.0
        rr = _get_regime_result("S1_bull_calm_normal")
        p1f = build_regime_state_dict(rr)["_metadata"]["p1f_consensus_semantics"]
        assert math.isclose(p1f["raw_consensus"], p1f["display_consensus"], abs_tol=1e-9)

    def test_p1f_raw_consensus_s4_is_one_third(self):
        rr = _get_regime_result("S4_override_structural")
        p1f = build_regime_state_dict(rr)["_metadata"]["p1f_consensus_semantics"]
        assert math.isclose(p1f["raw_consensus"], 1 / 3, abs_tol=1e-9)

    def test_p1j_semantics_diverge_is_override_not_float_compare(self):
        # P1-J 修正: semantics_diverge = is_override (float 等価比較を使わない)
        # is_override=True ならば raw_consensus と display_consensus の float 値が
        # 仮に近くても semantics_diverge=True になることを意図する。
        # 検証: is_override=True の全シナリオで semantics_diverge=True。
        for name in ("S4_override_structural", "S8_override_crisis"):
            rr = _get_regime_result(name)
            p1f = build_regime_state_dict(rr)["_metadata"]["p1f_consensus_semantics"]
            assert p1f["is_override"] is True, f"{name}: expected is_override=True"
            assert p1f["semantics_diverge"] is True, (
                f"{name}: semantics_diverge must be True when is_override=True, "
                "regardless of float proximity of raw/display consensus"
            )

    def test_p1j_semantics_diverge_false_for_all_non_override_scenarios(self):
        # P1-J 修正: is_override=False の全シナリオで semantics_diverge=False
        non_override = ("S1_bull_calm_normal", "S2_bear_two_thirds", "S3_crisis_rule_based",
                        "S5_fallback_all_disagree", "S6_hmm_surrogate_weight",
                        "S7_llm_stub_weight_zero", "S9_hmm_low_confidence")
        for name in non_override:
            rr = _get_regime_result(name)
            p1f = build_regime_state_dict(rr)["_metadata"]["p1f_consensus_semantics"]
            assert p1f["is_override"] is False, f"{name}: expected is_override=False"
            assert p1f["semantics_diverge"] is False, f"{name}: semantics_diverge must be False when is_override=False"


# ── S8: is_override=True AND is_crisis=True schema coexistence ────────────────

class TestS8OverrideCrisisSchema:
    def test_s8_regime_state_has_is_override_true(self):
        rr = _get_regime_result("S8_override_crisis")
        d = build_regime_state_dict(rr)
        assert d["regime_state"]["is_override"] is True

    def test_s8_regime_state_has_is_crisis_true(self):
        rr = _get_regime_result("S8_override_crisis")
        d = build_regime_state_dict(rr)
        assert d["regime_state"]["is_crisis"] is True

    def test_s8_is_override_and_is_crisis_coexist(self):
        # Schema can hold is_override=True AND is_crisis=True simultaneously
        rr = _get_regime_result("S8_override_crisis")
        d = build_regime_state_dict(rr)
        rs = d["regime_state"]
        assert rs["is_override"] is True and rs["is_crisis"] is True

    def test_s8_regime_is_crisis(self):
        rr = _get_regime_result("S8_override_crisis")
        d = build_regime_state_dict(rr)
        assert d["regime_state"]["current_regime"] == "crisis"

    def test_s8_schema_version_present(self):
        rr = _get_regime_result("S8_override_crisis")
        d = build_regime_state_dict(rr)
        assert d["regime_state"]["schema_version"] == "3.8"

    def test_s8_p1f_semantics_diverge_true(self):
        rr = _get_regime_result("S8_override_crisis")
        p1f = build_regime_state_dict(rr)["_metadata"]["p1f_consensus_semantics"]
        assert p1f["semantics_diverge"] is True

    def test_s8_raw_consensus_one_third(self):
        rr = _get_regime_result("S8_override_crisis")
        p1f = build_regime_state_dict(rr)["_metadata"]["p1f_consensus_semantics"]
        assert math.isclose(p1f["raw_consensus"], 1 / 3, abs_tol=1e-9)


# ── S9: HMM low_confidence / layer_reliability in schema ─────────────────────

class TestS9HmmLowConfidenceSchema:
    def test_s9_layer_reliability_in_schema(self):
        rr = _get_regime_result("S9_hmm_low_confidence")
        d = build_regime_state_dict(rr)
        assert "layer_reliability" in d["regime_state"]

    def test_s9_hmm_layer_reliability_present(self):
        rr = _get_regime_result("S9_hmm_low_confidence")
        lr = build_regime_state_dict(rr)["regime_state"]["layer_reliability"]
        assert "hmm" in lr

    def test_s9_hmm_is_low_confidence_true_in_schema(self):
        rr = _get_regime_result("S9_hmm_low_confidence")
        lr = build_regime_state_dict(rr)["regime_state"]["layer_reliability"]
        assert lr["hmm"]["is_low_confidence"] is True

    def test_s9_hmm_effective_weight_less_than_s6(self):
        # S9: surrogate + low_confidence → normalized weight < S6 surrogate-only weight (0.2)
        s9 = _get_regime_result("S9_hmm_low_confidence")
        s6 = _get_regime_result("S6_hmm_surrogate_weight")
        w9 = build_regime_state_dict(s9)["regime_state"]["layer_reliability"]["hmm"]["effective_weight"]
        w6 = build_regime_state_dict(s6)["regime_state"]["layer_reliability"]["hmm"]["effective_weight"]
        assert w9 < w6

    def test_s9_layer_reliability_has_all_three_layers(self):
        rr = _get_regime_result("S9_hmm_low_confidence")
        lr = build_regime_state_dict(rr)["regime_state"]["layer_reliability"]
        assert set(lr.keys()) == {"rule_based", "hmm", "llm"}

    def test_s9_regime_is_bear(self):
        rr = _get_regime_result("S9_hmm_low_confidence")
        d = build_regime_state_dict(rr)
        assert d["regime_state"]["current_regime"] == "bear"

    def test_s9_is_override_false_in_schema(self):
        rr = _get_regime_result("S9_hmm_low_confidence")
        d = build_regime_state_dict(rr)
        assert d["regime_state"]["is_override"] is False


# ── regime_state fields completeness ─────────────────────────────────────────

class TestRegimeStateFieldsCompleteness:
    def test_required_fields_present(self):
        rr = _get_regime_result("S1_bull_calm_normal")
        rs = build_regime_state_dict(rr)["regime_state"]
        for field in [
            "schema_version", "timestamp", "current_regime",
            "consensus", "raw_consensus", "confidence",
            "is_override", "is_crisis",
            "votes", "layer_reliability", "structural_changes",
            "vote_count", "is_fallback", "disagree_layers",
            "hmm_confirmed", "hmm_is_surrogate", "llm_is_stub",
            "market_data_snapshot", "run_date",
            "regime_changed_at", "previous_regime", "duration_hours",
        ]:
            assert field in rs, f"Missing field: {field!r}"

    def test_votes_has_three_layers(self):
        rr = _get_regime_result("S1_bull_calm_normal")
        votes = build_regime_state_dict(rr)["regime_state"]["votes"]
        assert set(votes.keys()) == {"rule_based", "hmm", "llm"}
