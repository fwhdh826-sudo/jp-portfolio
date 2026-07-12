"""
Card 3-4 — Regime Consensus テスト
Detection-only / Weighted Voting 実装を担保するテスト群。
"""
from __future__ import annotations

from datetime import datetime

import pytest

from backend.engine.regime.regime_consensus import (
    BASE_WEIGHTS,
    FALLBACK_REGIME,
    HMM_SURROGATE_WEIGHT,
    LLM_STUB_WEIGHT,
    LOW_CONFIDENCE_WEIGHT_FACTOR,
    MIN_VOTE_COUNT,
    REGIME_LABELS,
    SAFER_ORDER,
    ConsensusInput,
    ConsensusResult,
    _compute_effective_weights,
    compute_consensus,
    run_consensus,
)


# ── Fixtures / helpers ────────────────────────────────────────────────────────

def make_input(
    rule_based_regime: str = "bull_calm",
    hmm_regime: str = "bull_calm",
    hmm_confidence: float = 0.7,
    hmm_is_surrogate: bool = False,
    hmm_is_low_confidence: bool = False,
    hmm_confirmed: bool = True,
    llm_regime: str = "bull_calm",
    llm_confidence: float = 0.7,
    llm_is_stub: bool = True,
    llm_is_low_confidence: bool = False,
    llm_has_structural_change: bool = False,
    llm_structural_changes: list | None = None,
) -> ConsensusInput:
    return ConsensusInput(
        rule_based_regime=rule_based_regime,
        hmm_regime=hmm_regime,
        hmm_confidence=hmm_confidence,
        hmm_is_surrogate=hmm_is_surrogate,
        hmm_is_low_confidence=hmm_is_low_confidence,
        hmm_confirmed=hmm_confirmed,
        llm_regime=llm_regime,
        llm_confidence=llm_confidence,
        llm_is_stub=llm_is_stub,
        llm_is_low_confidence=llm_is_low_confidence,
        llm_has_structural_change=llm_has_structural_change,
        llm_structural_changes=llm_structural_changes if llm_structural_changes is not None else [],
    )


def make_rb_dict(regime: str = "bull_calm") -> dict:
    return {"regime": regime}


def make_hmm_dict(
    regime: str = "bull_calm",
    confidence: float = 0.7,
    is_surrogate: bool = False,
    is_low_confidence: bool = False,
    confirmed: bool = True,
) -> dict:
    return {
        "regime": regime,
        "confidence": confidence,
        "is_surrogate": is_surrogate,
        "is_low_confidence": is_low_confidence,
        "confirmed": confirmed,
    }


def make_llm_dict(
    regime: str = "bull_calm",
    confidence: float = 0.7,
    is_stub: bool = True,
    is_low_confidence: bool = False,
    has_structural_change: bool = False,
    structural_changes: list | None = None,
) -> dict:
    return {
        "regime": regime,
        "confidence": confidence,
        "is_stub": is_stub,
        "is_low_confidence": is_low_confidence,
        "has_structural_change": has_structural_change,
        "structural_changes": structural_changes if structural_changes is not None else [],
    }


# ── Constants ─────────────────────────────────────────────────────────────────

def test_base_weights_sum_to_one():
    assert abs(sum(BASE_WEIGHTS.values()) - 1.0) < 1e-9


def test_base_weights_keys():
    assert set(BASE_WEIGHTS.keys()) == {"rule_based", "hmm", "llm"}


def test_base_weights_values():
    assert BASE_WEIGHTS["rule_based"] == 0.4
    assert BASE_WEIGHTS["hmm"] == 0.3
    assert BASE_WEIGHTS["llm"] == 0.3


def test_hmm_surrogate_weight():
    assert HMM_SURROGATE_WEIGHT == 0.1


def test_llm_stub_weight():
    assert LLM_STUB_WEIGHT == 0.0


def test_low_confidence_weight_factor():
    assert LOW_CONFIDENCE_WEIGHT_FACTOR == 0.5


def test_min_vote_count():
    assert MIN_VOTE_COUNT == 2


def test_fallback_regime():
    assert FALLBACK_REGIME == "uncertain"


def test_regime_labels_complete():
    assert set(REGIME_LABELS) == {"bull_calm", "bull_volatile", "bear", "crisis", "uncertain"}


def test_safer_order_starts_with_crisis():
    assert SAFER_ORDER[0] == "crisis"


def test_safer_order_ends_with_bull_calm():
    assert SAFER_ORDER[-1] == "bull_calm"


# ── ConsensusInput validation ─────────────────────────────────────────────────

def test_input_invalid_rule_based_regime():
    with pytest.raises(ValueError, match="rule_based_regime"):
        make_input(rule_based_regime="invalid")


def test_input_invalid_hmm_regime():
    with pytest.raises(ValueError, match="hmm_regime"):
        make_input(hmm_regime="invalid")


def test_input_invalid_llm_regime():
    with pytest.raises(ValueError, match="llm_regime"):
        make_input(llm_regime="invalid")


def test_input_valid_construction():
    inp = make_input()
    assert inp.rule_based_regime == "bull_calm"
    assert inp.hmm_regime == "bull_calm"
    assert inp.llm_regime == "bull_calm"


# ── ConsensusResult validation ────────────────────────────────────────────────

def test_result_invalid_regime_raises():
    with pytest.raises(ValueError, match="Invalid regime"):
        ConsensusResult(
            regime="invalid",
            consensus=1.0,
            vote_count=3,
            votes={},
            weighted_consensus=1.0,
            effective_weights={},
            has_structural_change_override=False,
            structural_changes=[],
            is_fallback=False,
            disagree_layers=[],
            hmm_surrogate_adjusted=False,
            hmm_confirmed=True,
            checked_at=datetime(2026, 1, 1),
        )


# ── _compute_effective_weights ────────────────────────────────────────────────

def test_effective_weights_no_adjustment():
    inp = make_input(hmm_is_surrogate=False, llm_is_stub=False)
    w = _compute_effective_weights(inp)
    assert abs(sum(w.values()) - 1.0) < 1e-9
    assert abs(w["rule_based"] - 0.4) < 1e-9
    assert abs(w["hmm"] - 0.3) < 1e-9
    assert abs(w["llm"] - 0.3) < 1e-9


def test_effective_weights_hmm_surrogate():
    inp = make_input(hmm_is_surrogate=True, llm_is_stub=False)
    w = _compute_effective_weights(inp)
    assert abs(sum(w.values()) - 1.0) < 1e-9
    # hmm raw weight → 0.1, rule_based=0.4, llm=0.3 → total=0.8
    assert abs(w["hmm"] - 0.1 / 0.8) < 1e-9
    assert abs(w["rule_based"] - 0.4 / 0.8) < 1e-9


def test_effective_weights_llm_stub():
    inp = make_input(hmm_is_surrogate=False, llm_is_stub=True)
    w = _compute_effective_weights(inp)
    assert abs(sum(w.values()) - 1.0) < 1e-9
    # llm stub → weight=0.0; rule_based=0.4, hmm=0.3 → total=0.7
    assert w["llm"] == pytest.approx(0.0)
    assert w["rule_based"] == pytest.approx(0.4 / 0.7)
    assert w["hmm"] == pytest.approx(0.3 / 0.7)


def test_effective_weights_hmm_surrogate_and_llm_stub():
    inp = make_input(hmm_is_surrogate=True, llm_is_stub=True)
    w = _compute_effective_weights(inp)
    assert abs(sum(w.values()) - 1.0) < 1e-9
    # hmm=0.1, llm=0.0, rule_based=0.4 → total=0.5
    assert w["llm"] == pytest.approx(0.0)
    assert w["rule_based"] == pytest.approx(0.4 / 0.5)
    assert w["hmm"] == pytest.approx(0.1 / 0.5)


def test_effective_weights_hmm_low_confidence():
    inp = make_input(hmm_is_surrogate=False, llm_is_stub=False, hmm_is_low_confidence=True)
    w = _compute_effective_weights(inp)
    assert abs(sum(w.values()) - 1.0) < 1e-9
    # hmm: 0.3 * 0.5 = 0.15; rule_based=0.4, llm=0.3 → total=0.85
    assert w["hmm"] == pytest.approx(0.15 / 0.85)


def test_effective_weights_llm_low_confidence_non_stub():
    """LLM low confidence (is_stub=False) reduces LLM weight."""
    inp = make_input(
        hmm_is_surrogate=False,
        llm_is_stub=False,
        llm_is_low_confidence=True,
    )
    w = _compute_effective_weights(inp)
    assert abs(sum(w.values()) - 1.0) < 1e-9
    # llm: 0.3 * 0.5 = 0.15; rule_based=0.4, hmm=0.3 → total=0.85
    assert w["llm"] == pytest.approx(0.15 / 0.85)


def test_effective_weights_llm_low_confidence_stub_no_reduction():
    """LLM stub + low_confidence: stub weight (0.0) は低信頼度の係数を適用しない。"""
    inp = make_input(
        hmm_is_surrogate=False,
        llm_is_stub=True,
        llm_is_low_confidence=True,
    )
    w = _compute_effective_weights(inp)
    # llm stub → 0.0; low_confidence factor not applied (already 0)
    assert w["llm"] == pytest.approx(0.0)
    assert abs(sum(w.values()) - 1.0) < 1e-9


# ── Majority voting — unanimous ───────────────────────────────────────────────

def test_unanimous_bull_calm():
    result = compute_consensus(make_input(
        rule_based_regime="bull_calm",
        hmm_regime="bull_calm",
        llm_regime="bull_calm",
    ))
    assert result.regime == "bull_calm"
    assert result.vote_count == 3
    assert result.is_fallback is False
    assert result.has_structural_change_override is False


def test_unanimous_crisis():
    result = compute_consensus(make_input(
        rule_based_regime="crisis",
        hmm_regime="crisis",
        llm_regime="crisis",
    ))
    assert result.regime == "crisis"
    assert result.vote_count == 3


def test_unanimous_consensus_value():
    result = compute_consensus(make_input(
        rule_based_regime="bear",
        hmm_regime="bear",
        llm_regime="bear",
    ))
    assert result.consensus == pytest.approx(1.0)


# ── Majority voting — 2-1 split ───────────────────────────────────────────────

def test_majority_2_1_rule_based_hmm():
    result = compute_consensus(make_input(
        rule_based_regime="bull_volatile",
        hmm_regime="bull_volatile",
        llm_regime="bear",
        llm_is_stub=False,
    ))
    assert result.regime == "bull_volatile"
    assert result.vote_count == 2
    assert result.is_fallback is False


def test_majority_2_1_rule_based_llm():
    result = compute_consensus(make_input(
        rule_based_regime="bear",
        hmm_regime="bull_calm",
        llm_regime="bear",
        llm_is_stub=False,
    ))
    assert result.regime == "bear"
    assert result.vote_count == 2


def test_majority_2_1_hmm_llm():
    result = compute_consensus(make_input(
        rule_based_regime="bull_calm",
        hmm_regime="bear",
        llm_regime="bear",
        llm_is_stub=False,
    ))
    assert result.regime == "bear"
    assert result.vote_count == 2


def test_majority_consensus_two_thirds():
    result = compute_consensus(make_input(
        rule_based_regime="bear",
        hmm_regime="bear",
        llm_regime="bull_calm",
        llm_is_stub=False,
    ))
    assert result.consensus == pytest.approx(2 / 3)


def test_majority_disagree_layers_correct():
    result = compute_consensus(make_input(
        rule_based_regime="bear",
        hmm_regime="bear",
        llm_regime="bull_calm",
        llm_is_stub=False,
    ))
    assert result.disagree_layers == ["llm"]


# ── All 3 disagree → fallback ─────────────────────────────────────────────────

def test_all_disagree_fallback():
    result = compute_consensus(make_input(
        rule_based_regime="crisis",
        hmm_regime="bear",
        llm_regime="bull_calm",
        llm_is_stub=False,
    ))
    assert result.regime == FALLBACK_REGIME
    assert result.is_fallback is True


def test_all_disagree_vote_count_one():
    result = compute_consensus(make_input(
        rule_based_regime="crisis",
        hmm_regime="bear",
        llm_regime="bull_volatile",
        llm_is_stub=False,
    ))
    assert result.vote_count == 1


def test_all_disagree_consensus_approx_one_third():
    result = compute_consensus(make_input(
        rule_based_regime="crisis",
        hmm_regime="bear",
        llm_regime="bull_calm",
        llm_is_stub=False,
    ))
    assert result.consensus == pytest.approx(1 / 3)


def test_all_disagree_disagree_layers_has_entries():
    result = compute_consensus(make_input(
        rule_based_regime="crisis",
        hmm_regime="bear",
        llm_regime="bull_calm",
        llm_is_stub=False,
    ))
    # fallback regime is "uncertain"; all 3 voted differently
    assert len(result.disagree_layers) > 0


# ── structural_change_override ────────────────────────────────────────────────

def test_structural_change_override_fires_when_not_stub():
    """llm_has_structural_change=True, is_stub=False → override fires."""
    result = compute_consensus(make_input(
        rule_based_regime="bull_calm",
        hmm_regime="bull_calm",
        llm_regime="crisis",
        llm_is_stub=False,
        llm_has_structural_change=True,
        llm_structural_changes=["financial_crisis_signs"],
    ))
    assert result.has_structural_change_override is True
    assert result.regime == "crisis"
    assert "financial_crisis_signs" in result.structural_changes


def test_structural_change_override_suppressed_when_stub():
    """llm_has_structural_change=True, is_stub=True → override suppressed."""
    result = compute_consensus(make_input(
        rule_based_regime="bull_calm",
        hmm_regime="bull_calm",
        llm_regime="crisis",
        llm_is_stub=True,
        llm_has_structural_change=True,
        llm_structural_changes=["financial_crisis_signs"],
    ))
    assert result.has_structural_change_override is False
    assert result.regime == "bull_calm"  # majority wins (2/3: rule_based + hmm)


def test_structural_change_override_no_fire_empty_structural_changes():
    """structural_changes=[] でも is_stub=False なら override は条件次第で発動。"""
    result = compute_consensus(make_input(
        rule_based_regime="bull_calm",
        hmm_regime="bull_calm",
        llm_regime="crisis",
        llm_is_stub=False,
        llm_has_structural_change=False,
        llm_structural_changes=[],
    ))
    assert result.has_structural_change_override is False


def test_structural_change_override_overrides_majority():
    """Override は 2-1 多数決を無視して LLM regime を採用する。"""
    result = compute_consensus(make_input(
        rule_based_regime="bull_calm",
        hmm_regime="bull_calm",
        llm_regime="crisis",
        llm_is_stub=False,
        llm_has_structural_change=True,
        llm_structural_changes=["geopolitical_risk"],
    ))
    assert result.regime == "crisis"
    assert result.has_structural_change_override is True


def test_structural_change_override_structural_changes_preserved():
    changes = ["financial_crisis_signs", "major_policy_change"]
    result = compute_consensus(make_input(
        rule_based_regime="bear",
        hmm_regime="bear",
        llm_regime="crisis",
        llm_is_stub=False,
        llm_has_structural_change=True,
        llm_structural_changes=changes,
    ))
    assert set(result.structural_changes) == set(changes)


def test_no_override_structural_changes_empty_in_result():
    """Override なし・llm_is_stub=True なら structural_changes は空リスト。"""
    result = compute_consensus(make_input(
        rule_based_regime="bull_calm",
        hmm_regime="bull_calm",
        llm_regime="crisis",
        llm_is_stub=True,
        llm_has_structural_change=True,
        llm_structural_changes=["financial_crisis_signs"],
    ))
    assert result.structural_changes == []


# ── hmm_surrogate_adjusted / hmm_confirmed pass-through ──────────────────────

def test_hmm_surrogate_adjusted_true_when_surrogate():
    result = compute_consensus(make_input(hmm_is_surrogate=True))
    assert result.hmm_surrogate_adjusted is True


def test_hmm_surrogate_adjusted_false_when_not_surrogate():
    result = compute_consensus(make_input(hmm_is_surrogate=False))
    assert result.hmm_surrogate_adjusted is False


def test_hmm_confirmed_pass_through_true():
    result = compute_consensus(make_input(hmm_confirmed=True))
    assert result.hmm_confirmed is True


def test_hmm_confirmed_pass_through_false():
    result = compute_consensus(make_input(hmm_confirmed=False))
    assert result.hmm_confirmed is False


# ── votes dict ────────────────────────────────────────────────────────────────

def test_votes_keys():
    result = compute_consensus(make_input())
    assert set(result.votes.keys()) == {"rule_based", "hmm", "llm"}


def test_votes_values_match_input():
    result = compute_consensus(make_input(
        rule_based_regime="crisis",
        hmm_regime="bear",
        llm_regime="uncertain",
        llm_is_stub=False,
    ))
    assert result.votes["rule_based"] == "crisis"
    assert result.votes["hmm"] == "bear"
    assert result.votes["llm"] == "uncertain"


# ── effective_weights normalization ───────────────────────────────────────────

def test_effective_weights_sum_to_one():
    result = compute_consensus(make_input())
    assert abs(sum(result.effective_weights.values()) - 1.0) < 1e-9


def test_effective_weights_keys():
    result = compute_consensus(make_input())
    assert set(result.effective_weights.keys()) == {"rule_based", "hmm", "llm"}


def test_effective_weights_llm_stub_is_zero():
    result = compute_consensus(make_input(llm_is_stub=True))
    assert result.effective_weights["llm"] == pytest.approx(0.0)


def test_effective_weights_hmm_surrogate_reduced():
    result = compute_consensus(make_input(hmm_is_surrogate=True, llm_is_stub=False))
    assert result.effective_weights["hmm"] < BASE_WEIGHTS["hmm"]


# ── weighted_consensus ────────────────────────────────────────────────────────

def test_weighted_consensus_in_range():
    result = compute_consensus(make_input())
    assert 0.0 <= result.weighted_consensus <= 1.0


def test_weighted_consensus_unanimous_is_one():
    result = compute_consensus(make_input(
        rule_based_regime="bull_calm",
        hmm_regime="bull_calm",
        llm_regime="bull_calm",
        llm_is_stub=False,
    ))
    assert result.weighted_consensus == pytest.approx(1.0)


# ── checked_at ────────────────────────────────────────────────────────────────

def test_checked_at_is_datetime():
    result = compute_consensus(make_input())
    assert isinstance(result.checked_at, datetime)


def test_checked_at_is_utc():
    from datetime import timezone
    result = compute_consensus(make_input())
    assert result.checked_at.tzinfo == timezone.utc


# ── Detection-only 担保 ───────────────────────────────────────────────────────

def test_no_forbidden_fields():
    result = compute_consensus(make_input())
    forbidden = {"order", "trade", "execute", "action"}
    assert set(vars(result)).isdisjoint(forbidden)


def test_no_side_effects():
    inp = make_input()
    results = [compute_consensus(inp).regime for _ in range(5)]
    assert len(set(results)) == 1


# ── run_consensus dict API ────────────────────────────────────────────────────

def make_layer_results(
    rb_regime: str = "bull_calm",
    hmm_regime: str = "bull_calm",
    hmm_is_surrogate: bool = True,
    hmm_confirmed: bool = False,
    llm_regime: str = "bull_calm",
    llm_is_stub: bool = True,
    llm_has_structural_change: bool = False,
) -> dict:
    return {
        "rule_based": make_rb_dict(rb_regime),
        "hmm": make_hmm_dict(
            regime=hmm_regime,
            is_surrogate=hmm_is_surrogate,
            confirmed=hmm_confirmed,
        ),
        "llm": make_llm_dict(
            regime=llm_regime,
            is_stub=llm_is_stub,
            has_structural_change=llm_has_structural_change,
        ),
    }


def test_dict_interface_required_keys():
    result = run_consensus(make_layer_results())
    expected = {
        "regime", "consensus", "vote_count", "votes",
        "weighted_consensus", "effective_weights",
        "has_structural_change_override", "structural_changes",
        "is_fallback", "disagree_layers",
        "hmm_surrogate_adjusted", "hmm_confirmed", "checked_at",
    }
    assert expected.issubset(result.keys())


def test_dict_interface_regime_valid():
    result = run_consensus(make_layer_results())
    assert result["regime"] in REGIME_LABELS


def test_dict_interface_checked_at_isoformat():
    result = run_consensus(make_layer_results())
    assert isinstance(result["checked_at"], str)
    assert "T" in result["checked_at"]
    assert "+00:00" in result["checked_at"]


def test_dict_interface_effective_weights_sum():
    result = run_consensus(make_layer_results())
    assert abs(sum(result["effective_weights"].values()) - 1.0) < 1e-9


def test_dict_interface_votes_is_dict():
    result = run_consensus(make_layer_results())
    assert isinstance(result["votes"], dict)


def test_dict_interface_is_fallback_bool():
    result = run_consensus(make_layer_results())
    assert isinstance(result["is_fallback"], bool)


def test_dict_interface_structural_change_override():
    layer_results = {
        "rule_based": make_rb_dict("bull_calm"),
        "hmm": make_hmm_dict(regime="bull_calm"),
        "llm": make_llm_dict(
            regime="crisis",
            is_stub=False,
            has_structural_change=True,
            structural_changes=["geopolitical_risk"],
        ),
    }
    result = run_consensus(layer_results)
    assert result["has_structural_change_override"] is True
    assert result["regime"] == "crisis"


def test_dict_interface_no_override_when_stub():
    layer_results = {
        "rule_based": make_rb_dict("bull_calm"),
        "hmm": make_hmm_dict(regime="bull_calm"),
        "llm": make_llm_dict(
            regime="crisis",
            is_stub=True,
            has_structural_change=True,
            structural_changes=["geopolitical_risk"],
        ),
    }
    result = run_consensus(layer_results)
    assert result["has_structural_change_override"] is False
    assert result["regime"] == "bull_calm"


# ── Typical real-world scenario ───────────────────────────────────────────────

def test_typical_stub_scenario():
    """
    実運用想定: HMM surrogate + LLM stub の初期状態。
    rule_based が支配的 weight を持ち、その regime が採用される。
    """
    layer_results = {
        "rule_based": make_rb_dict("bear"),
        "hmm": make_hmm_dict(regime="bear", is_surrogate=True),
        "llm": make_llm_dict(regime="uncertain", is_stub=True),
    }
    result = run_consensus(layer_results)
    # bear: rule_based (0.4/0.5 normalized) + hmm (0.1/0.5 normalized) = 2 votes
    assert result["regime"] == "bear"
    assert result["is_fallback"] is False
    assert result["hmm_surrogate_adjusted"] is True


def test_all_layers_uncertain_gives_uncertain():
    result = compute_consensus(make_input(
        rule_based_regime="uncertain",
        hmm_regime="uncertain",
        llm_regime="uncertain",
    ))
    assert result.regime == "uncertain"
    assert result.vote_count == 3
