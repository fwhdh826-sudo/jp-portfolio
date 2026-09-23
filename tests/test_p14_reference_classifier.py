"""Synthetic-only semantic contracts for the pure P-14 classifier."""
from __future__ import annotations

import itertools

import pytest

from data.p14_reference_classifier import (
    CAUSE_UNRESOLVED,
    INTERNAL_CONFIDENCE_KEY,
    classify_cause,
    classify_reference_transition,
    explain_pair_order,
)


def candidate(code, tier="actionable", rank=1, **extra):
    row = {"code": code, "tier": tier}
    if rank is not ...:
        row["marketRank"] = rank
    row.update(extra)
    return row


def view(*rows):
    return {"candidates": list(rows)}


def classes(base, perturbed, n=3):
    return set(classify_reference_transition(view(*base), view(*perturbed), n=n).classes)


def test_stable_reference_ignores_nonmember_score_changes_and_array_permutations():
    base = [candidate("A", rank=1), candidate("B", rank=2), candidate("C", "deep_review", 3),
            candidate("D", "screened", 4, marketScore=1.0, rawCompositeScore=10.0)]
    perturbed = [candidate("D", "screened", 4, marketScore=99.0, rawCompositeScore=-4.0),
                 candidate("C", "deep_review", 3), candidate("A", rank=1), candidate("B", rank=2)]
    result = classify_reference_transition(view(*base), view(*perturbed))
    assert result.status == "SUPPORTED"
    assert result.classes == ("STABLE_REFERENCE",)
    assert result.base_shortlist_codes == result.perturbed_shortlist_codes == ("A", "B", "C")
    assert not result.membership_changed and not result.tier_changed and not result.order_changed
    assert not hasattr(result, "severity")


def test_order_only_transition_is_explicit():
    base = [candidate("A", rank=1), candidate("B", rank=2), candidate("C", rank=3)]
    perturbed = [candidate("B", rank=1), candidate("A", rank=2), candidate("C", rank=3)]
    result = classify_reference_transition(view(*base), view(*perturbed))
    assert result.classes == ("REFERENCE_ORDER_CHANGED_ONLY",)
    assert result.order_changed is True
    assert result.membership_changed is False
    assert result.tier_changed is False


def test_same_eligible_domain_replacement_does_not_pair_entries_and_exits():
    base = [candidate("A", rank=1), candidate("B", rank=2), candidate("C", rank=3), candidate("D", rank=4)]
    perturbed = [candidate("A", rank=1), candidate("C", rank=2), candidate("D", rank=3), candidate("B", rank=4)]
    result = classify_reference_transition(view(*base), view(*perturbed))
    assert "REFERENCE_MEMBER_REPLACED_SAME_ELIGIBLE_DOMAIN" in result.classes
    assert result.entered_reference_codes == ("D",)
    assert result.exited_reference_codes == ("B",)
    assert result.entered_eligible_codes == result.exited_eligible_codes == ()


def test_replacement_and_retained_order_transition_are_reported_concurrently():
    base = [candidate("A", rank=1), candidate("B", rank=2), candidate("C", rank=3), candidate("D", rank=4)]
    perturbed = [candidate("C", rank=1), candidate("A", rank=2), candidate("D", rank=3), candidate("B", rank=4)]
    result = classify_reference_transition(view(*base), view(*perturbed))
    assert "REFERENCE_MEMBER_REPLACED_SAME_ELIGIBLE_DOMAIN" in result.classes
    assert "REFERENCE_ORDER_CHANGED_CONCURRENTLY" in result.classes
    assert result.order_changed is True
    assert "REFERENCE_ORDER_CHANGED_ONLY" not in result.classes


def test_member_leaves_eligible_domain_and_is_not_relabelled_as_benign_replacement():
    base = [candidate("A", rank=1), candidate("B", rank=2), candidate("C", rank=3), candidate("D", "deep_review", 4)]
    perturbed = [candidate("A", rank=1), candidate("B", rank=2), candidate("C", "screened", 3), candidate("D", "deep_review", 4)]
    result = classify_reference_transition(view(*base), view(*perturbed))
    assert result.classes == ("REFERENCE_MEMBER_LEFT_ELIGIBLE_TIERS",)
    assert result.exited_reference_codes == ("C",)
    assert result.entered_reference_codes == ("D",)
    assert result.exited_eligible_codes == ("C",)
    assert "REFERENCE_MEMBER_REPLACED_SAME_ELIGIBLE_DOMAIN" not in result.classes


def test_member_enters_eligible_domain_and_displaces_an_existing_member():
    base = [candidate("A", rank=1), candidate("B", rank=2), candidate("C", rank=3), candidate("E", "screened", 4)]
    perturbed = [candidate("A", rank=1), candidate("B", rank=2), candidate("E", "actionable", 3), candidate("C", rank=4)]
    result = classify_reference_transition(view(*base), view(*perturbed))
    assert "REFERENCE_MEMBER_ENTERED_ELIGIBLE_TIERS" in result.classes
    assert result.entered_eligible_codes == ("E",)
    assert result.entered_reference_codes == ("E",)
    assert result.exited_reference_codes == ("C",)
    assert "REFERENCE_MEMBER_REPLACED_SAME_ELIGIBLE_DOMAIN" not in result.classes


@pytest.mark.parametrize(("old_tier", "new_tier", "direction"), [
    ("deep_review", "actionable", "promotion"),
    ("actionable", "deep_review", "demotion"),
])
def test_tier_transition_inside_eligible_domain_preserves_direction(old_tier, new_tier, direction):
    base = [candidate("A", rank=1), candidate("B", old_tier, 2), candidate("C", rank=3)]
    perturbed = [candidate("A", rank=1), candidate("B", new_tier, 2), candidate("C", rank=3)]
    result = classify_reference_transition(view(*base), view(*perturbed))
    assert "REFERENCE_MEMBER_TIER_CHANGED_WITHIN_ELIGIBLE_DOMAIN" in result.classes
    transition = next(item for item in result.transitions if item.code == "B")
    assert transition.tier_direction == direction
    assert transition.as_dict()["tierDirection"] == direction


def test_membership_and_tier_transition_both_remain_visible():
    base = [candidate("A", rank=1), candidate("B", "deep_review", 2), candidate("C", rank=3), candidate("D", rank=4)]
    perturbed = [candidate("A", rank=1), candidate("B", "actionable", 2), candidate("D", rank=3), candidate("C", rank=4)]
    result = classify_reference_transition(view(*base), view(*perturbed))
    assert "REFERENCE_MEMBER_REPLACED_SAME_ELIGIBLE_DOMAIN" in result.classes
    assert "REFERENCE_MEMBER_TIER_CHANGED_WITHIN_ELIGIBLE_DOMAIN" in result.classes
    assert "REFERENCE_MEMBERSHIP_AND_TIER_CHANGED" in result.classes


def test_multiple_replacements_are_counted_without_arbitrary_pairing():
    base = [candidate("A", rank=1), candidate("B", rank=2), candidate("C", rank=3),
            candidate("D", rank=4), candidate("E", rank=5), candidate("F", rank=6)]
    perturbed = [candidate("D", rank=1), candidate("E", rank=2), candidate("F", rank=3),
                 candidate("A", rank=4), candidate("B", rank=5), candidate("C", rank=6)]
    result = classify_reference_transition(view(*base), view(*perturbed))
    assert "MULTIPLE_REFERENCE_MEMBER_REPLACEMENTS" in result.classes
    assert result.exited_reference_codes == ("A", "B", "C")
    assert result.entered_reference_codes == ("D", "E", "F")
    assert result.classes.count("REFERENCE_MEMBER_REPLACED_SAME_ELIGIBLE_DOMAIN") == 1


def test_empty_eligible_population_is_explicit_for_empty_and_asymmetric_sides():
    empty = classify_reference_transition(view(), view())
    assert "EMPTY_ELIGIBLE_POPULATION" in empty.classes
    assert "ELIGIBLE_POPULATION_SMALLER_THAN_N" in empty.classes
    assert "STABLE_REFERENCE" not in empty.classes

    base = [candidate("A", rank=1), candidate("B", rank=2), candidate("C", rank=3)]
    no_eligible = [candidate("A", "screened", 1), candidate("B", "excluded", 2), candidate("C", "screened", 3)]
    collapse = classify_reference_transition(view(*base), view(*no_eligible))
    assert "EMPTY_ELIGIBLE_POPULATION" in collapse.classes
    assert "REFERENCE_MEMBER_LEFT_ELIGIBLE_TIERS" in collapse.classes
    appearance = classify_reference_transition(view(*no_eligible), view(*base))
    assert "EMPTY_ELIGIBLE_POPULATION" in appearance.classes
    assert "REFERENCE_MEMBER_ENTERED_ELIGIBLE_TIERS" in appearance.classes


def test_population_smaller_than_n_is_not_a_vacuous_stable_result():
    rows = [candidate("A", rank=1), candidate("B", "deep_review", 2)]
    result = classify_reference_transition(view(*rows), view(*rows))
    assert result.base_population == result.perturbed_population == 2
    assert result.classes == ("ELIGIBLE_POPULATION_SMALLER_THAN_N",)


@pytest.mark.parametrize(("rank", "expected"), [
    (True, "INVALID_MARKET_RANK_TYPE"),
    (1.0, "INVALID_MARKET_RANK_TYPE"),
    ("1", "INVALID_MARKET_RANK_TYPE"),
    (0, "INVALID_MARKET_RANK_VALUE"),
    (-1, "INVALID_MARKET_RANK_VALUE"),
    (None, "REQUIRED_MARKET_RANK_MISSING"),
    (..., "REQUIRED_MARKET_RANK_MISSING"),
])
def test_mf_a10_rank_variants_have_independent_integrity_expectations(rank, expected):
    bad = candidate("A", rank=rank)
    if rank is ...:
        bad.pop("marketRank", None)
    good = candidate("A", rank=1)
    result = classify_reference_transition(view(bad), view(good))
    assert result.status == "INTEGRITY_FAILURE"
    assert result.violations == (expected,)
    assert result.classes == ()
    assert result.transitions == ()
    assert result.membership_changed is None
    assert result.order_changed is None
    value = result.as_dict()
    assert "population" not in value
    assert "membershipChanged" not in value and "orderChanged" not in value
    assert value["classes"] == [] and value["transitions"] == []


def test_mf_a10_duplicate_code_and_duplicate_market_rank_are_integrity_failures():
    duplicate_code = classify_reference_transition(
        view(candidate("A", rank=1), candidate("A", rank=2)),
        view(candidate("A", rank=1), candidate("B", rank=2)),
    )
    assert duplicate_code.status == "INTEGRITY_FAILURE"
    assert duplicate_code.violations == ("DUPLICATE_CODE",)
    assert duplicate_code.classes == ()

    duplicate_rank = classify_reference_transition(
        view(candidate("A", rank=1), candidate("B", rank=1)),
        view(candidate("A", rank=1), candidate("B", rank=2)),
    )
    assert duplicate_rank.status == "INTEGRITY_FAILURE"
    assert duplicate_rank.violations == ("DUPLICATE_MARKET_RANK",)


def test_mf_a10_candidate_universe_difference_reports_exact_code_sets():
    result = classify_reference_transition(
        view(candidate("A", rank=1), candidate("B", rank=2)),
        view(candidate("A", rank=1), candidate("C", rank=2)),
    )
    assert result.status == "INTEGRITY_FAILURE"
    assert result.violations == ("CANDIDATE_UNIVERSE_MISMATCH",)
    assert result.missing_codes == ("B",)
    assert result.added_codes == ("C",)
    assert result.classes == () and result.transitions == ()


@pytest.mark.parametrize(("field", "before", "after", "expected"), [
    (INTERNAL_CONFIDENCE_KEY, 0.81, 0.82, "INVARIANT_CONFIDENCE_CHANGED"),
    ("prescreenRank", 4, 5, "INVARIANT_PRESCREEN_RANK_CHANGED"),
    ("sector", "industry-a", "industry-b", "INVARIANT_SECTOR_CHANGED"),
])
def test_mf_a10_invariant_changes_are_contradictory(field, before, after, expected):
    base = candidate("A", rank=1, **{field: before})
    perturbed = candidate("A", rank=1, **{field: after})
    result = classify_reference_transition(view(base), view(perturbed))
    assert result.status == "CONTRADICTORY"
    assert result.violations == (expected,)
    assert result.classes == () and result.transitions == ()
    assert result.membership_changed is None
    value = result.as_dict()
    assert "population" not in value
    assert "membershipChanged" not in value and "orderChanged" not in value
    assert value["classes"] == [] and value["transitions"] == []


def test_unavailable_internal_confidence_is_not_misreported_as_contradictory():
    base = candidate("A", rank=1, internalDataConfidence=0.9)
    perturbed = candidate("A", rank=1)
    result = classify_reference_transition(view(base), view(perturbed))
    assert result.status == "SUPPORTED"
    assert result.classes == ("ELIGIBLE_POPULATION_SMALLER_THAN_N",)


def test_absent_and_invalid_prescreen_ranks_that_both_collapse_to_missing_are_not_contradictory():
    base = candidate("A", rank=1)
    perturbed = candidate("A", rank=1, prescreenRank=None)
    assert classify_reference_transition(view(base), view(perturbed)).status == "SUPPORTED"
    base = candidate("A", rank=1, prescreenRank=None)
    perturbed = candidate("A", rank=1, prescreenRank="invalid")
    result = classify_reference_transition(view(base), view(perturbed))
    assert result.status == "SUPPORTED"


def test_invalid_internal_authority_is_an_integrity_failure():
    bad = candidate("A", rank=1, internalDataConfidence=True)
    result = classify_reference_transition(view(bad), view(candidate("A", rank=1, internalDataConfidence=True)))
    assert result.status == "INTEGRITY_FAILURE"
    assert result.violations == ("INVALID_INTERNAL_CONFIDENCE_AUTHORITY",)


def test_classifier_is_invariant_to_candidate_array_permutation():
    base = [candidate("A", rank=1), candidate("B", rank=2), candidate("C", rank=3), candidate("D", rank=4)]
    perturbed = [candidate("C", rank=1), candidate("A", rank=2), candidate("D", rank=3), candidate("B", rank=4)]
    expected = classify_reference_transition(view(*base), view(*perturbed))
    for base_order in itertools.permutations(base):
        for perturbed_order in itertools.permutations(perturbed):
            assert classify_reference_transition(view(*base_order), view(*perturbed_order)) == expected


def ranking_row(code, rank, score, *, confidence=..., prescreen_rank=None, raw=0.0, public_confidence=None):
    row = {"code": code, "marketRank": rank, "marketScore": score,
           "prescreenRank": prescreen_rank, "rawCompositeScore": raw}
    if confidence is not ...:
        row[INTERNAL_CONFIDENCE_KEY] = confidence
    if public_confidence is not None:
        row["dataConfidence"] = public_confidence
    return row


def test_ranking_authority_market_score_decides_before_later_fields():
    left = ranking_row("A", 1, 90.0, confidence=0.2, prescreen_rank=99, raw=-100.0)
    right = ranking_row("B", 2, 89.0, confidence=0.9, prescreen_rank=1, raw=100.0)
    result = explain_pair_order(left, right)
    assert result.status == "SUPPORTED"
    assert result.deciding_key == "roundedMarketScore"
    assert result.expected_first_code == result.observed_first_code == "A"


def test_internal_confidence_authority_is_used_instead_of_public_rounded_confidence():
    left = ranking_row("A", 2, 90.0, confidence=0.75, public_confidence=0.9999)
    right = ranking_row("B", 1, 90.0, confidence=0.80, public_confidence=0.0001)
    result = explain_pair_order(left, right)
    assert result.status == "SUPPORTED"
    assert result.deciding_key == "internalDataConfidence"
    assert result.expected_first_code == "B" and result.observed_first_code == "B"


def test_missing_internal_authority_does_not_name_a_later_deciding_key():
    left = ranking_row("A", 1, 90.0, confidence=..., prescreen_rank=1, public_confidence=0.1)
    right = ranking_row("B", 2, 90.0, confidence=..., prescreen_rank=2, public_confidence=0.9)
    result = explain_pair_order(left, right)
    assert result.status == "UNAVAILABLE"
    assert result.deciding_key == "UNAVAILABLE"
    assert result.expected_first_code is None


def test_prescreen_tiebreak_missing_sorts_after_valid_and_exact_code_is_final_key():
    valid = ranking_row("Z", 1, 90.0, confidence=0.5, prescreen_rank=4)
    missing = ranking_row("A", 2, 90.0, confidence=0.5, prescreen_rank=None)
    result = explain_pair_order(valid, missing)
    assert result.status == "SUPPORTED"
    assert result.deciding_key == "prescreenRankTiebreak"
    assert result.expected_first_code == "Z"

    left = ranking_row("A", 1, 90.0, confidence=0.5, prescreen_rank=4)
    right = ranking_row("B", 2, 90.0, confidence=0.5, prescreen_rank=4)
    code_result = explain_pair_order(left, right)
    assert code_result.deciding_key == "exactCode"
    assert code_result.expected_first_code == "A"


def test_raw_composite_score_is_always_diagnostic_only_and_never_a_deciding_key():
    left = ranking_row("A", 1, 90.0, confidence=0.8, raw=-999.0)
    right = ranking_row("B", 2, 89.0, confidence=0.1, raw=999.0)
    result = explain_pair_order(left, right)
    assert result.deciding_key == "roundedMarketScore"
    diagnostic = result.as_dict()["rawCompositeScore"]
    assert [item["value"] for item in diagnostic] == [-999.0, 999.0]
    assert all(item["authority"] == "DIAGNOSTIC_ONLY" for item in diagnostic)


def test_ranking_chain_contradiction_is_reported_without_reordering():
    left = ranking_row("A", 2, 90.0, confidence=0.7)
    right = ranking_row("B", 1, 89.0, confidence=0.9)
    result = explain_pair_order(left, right)
    assert result.status == "CONTRADICTORY"
    assert result.deciding_key == "roundedMarketScore"
    assert result.expected_first_code == "A"
    assert result.observed_first_code == "B"


def test_known_cause_requires_explicit_exact_cause_and_unknown_remains_unresolved():
    known = classify_cause({"state": "EXACT", "causeClass": "SECTOR_CAP"})
    assert known.status == "KNOWN_CAUSE" and known.cause_class == "SECTOR_CAP"
    assert classify_cause(None).status == CAUSE_UNRESOLVED
    assert classify_cause({"state": "UNAVAILABLE", "causeClass": "CAPACITY"}).status == CAUSE_UNRESOLVED
    assert classify_cause({"state": "UNKNOWN", "causeClass": "FUTURE"}).status == CAUSE_UNRESOLVED
    assert classify_cause({"state": "CONTRADICTORY", "causeClass": "CAPACITY"}).status == "CONTRADICTORY"
