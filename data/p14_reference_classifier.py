"""Pure P-14 reference-transition, rank-explanation, and cause contracts.

No final severity is selected here. Engine order is accepted as marketRank
when available; this module never imports or executes ranking code.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from data.p14_observation import (
    ELIGIBLE_TIERS,
    MISSING,
    ObservationContractError,
    diagnostic_prescreen_rank,
    is_exact_int,
    require_positive_int,
)

CLASSIFIER_VERSION = "p14-reference-classifier-1"
CAUSE_UNRESOLVED = "CAUSE_UNRESOLVED"
PUBLIC_CONFIDENCE_KEY = "dataConfidence"
INTERNAL_CONFIDENCE_KEY = "internalDataConfidence"

_CLASS_ORDER = (
    "REFERENCE_ORDER_CHANGED_ONLY",
    "REFERENCE_MEMBER_REPLACED_SAME_ELIGIBLE_DOMAIN",
    "REFERENCE_MEMBER_LEFT_ELIGIBLE_TIERS",
    "REFERENCE_MEMBER_ENTERED_ELIGIBLE_TIERS",
    "REFERENCE_MEMBER_TIER_CHANGED_WITHIN_ELIGIBLE_DOMAIN",
    "REFERENCE_MEMBERSHIP_AND_TIER_CHANGED",
    "MULTIPLE_REFERENCE_MEMBER_REPLACEMENTS",
    "EMPTY_ELIGIBLE_POPULATION",
    "ELIGIBLE_POPULATION_SMALLER_THAN_N",
)


@dataclass(frozen=True, slots=True)
class CandidateTransition:
    code: str
    base_tier: str | None
    perturbed_tier: str | None
    base_eligible_rank: int | None
    perturbed_eligible_rank: int | None
    tier_direction: str | None
    in_base_shortlist: bool
    in_perturbed_shortlist: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "baseTier": self.base_tier,
            "perturbedTier": self.perturbed_tier,
            "baseEligibleRank": self.base_eligible_rank,
            "perturbedEligibleRank": self.perturbed_eligible_rank,
            "tierDirection": self.tier_direction,
            "inBaseShortlist": self.in_base_shortlist,
            "inPerturbedShortlist": self.in_perturbed_shortlist,
        }


@dataclass(frozen=True, slots=True)
class ClassificationResult:
    status: str
    classes: tuple[str, ...]
    violations: tuple[str, ...]
    base_population: int | None
    perturbed_population: int | None
    base_shortlist_codes: tuple[str, ...]
    perturbed_shortlist_codes: tuple[str, ...]
    entered_reference_codes: tuple[str, ...]
    exited_reference_codes: tuple[str, ...]
    entered_eligible_codes: tuple[str, ...]
    exited_eligible_codes: tuple[str, ...]
    membership_changed: bool | None
    tier_changed: bool | None
    order_changed: bool | None
    transitions: tuple[CandidateTransition, ...]
    missing_codes: tuple[str, ...] = ()
    added_codes: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "status": self.status,
            "classes": list(self.classes),
            "violations": list(self.violations),
            "transitions": [transition.as_dict() for transition in self.transitions],
        }
        if self.status == "SUPPORTED":
            result.update({
                "population": {"base": self.base_population, "perturbed": self.perturbed_population},
                "baseShortlistCodes": list(self.base_shortlist_codes),
                "perturbedShortlistCodes": list(self.perturbed_shortlist_codes),
                "enteredReferenceCodes": list(self.entered_reference_codes),
                "exitedReferenceCodes": list(self.exited_reference_codes),
                "enteredEligibleCodes": list(self.entered_eligible_codes),
                "exitedEligibleCodes": list(self.exited_eligible_codes),
                "membershipChanged": self.membership_changed,
                "tierChanged": self.tier_changed,
                "orderChanged": self.order_changed,
            })
        if self.status == "INTEGRITY_FAILURE":
            result["universeDifference"] = {
                "missingCodes": list(self.missing_codes),
                "addedCodes": list(self.added_codes),
            }
        return result


@dataclass(frozen=True, slots=True)
class RankingExplanation:
    status: str
    deciding_key: str
    expected_first_code: str | None
    observed_first_code: str | None
    raw_composite_score_diagnostic: tuple[tuple[str, int | float | None], ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "decidingKey": self.deciding_key,
            "expectedFirstCode": self.expected_first_code,
            "observedFirstCode": self.observed_first_code,
            "rawCompositeScore": [
                {"code": code, "value": value, "authority": "DIAGNOSTIC_ONLY"}
                for code, value in self.raw_composite_score_diagnostic
            ],
        }


@dataclass(frozen=True, slots=True)
class CauseClassification:
    status: str
    cause_class: str | None

    def as_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {"status": self.status}
        if self.cause_class is not None:
            value["causeClass"] = self.cause_class
        return value


def _rows(view: Any, side: str) -> list[Any]:
    if type(view) is dict:
        rows = view.get("candidates")
    else:
        rows = view
    if not isinstance(rows, (list, tuple)):
        raise ObservationContractError(f"{side} candidate view must be an array")
    return list(rows)


def _integrity_violations(rows: list[Any], side: str) -> tuple[str, ...]:
    violations: set[str] = set()
    codes: set[str] = set()
    eligible_ranks: set[int] = set()
    for row in rows:
        if type(row) is not dict:
            violations.add("INVALID_CANDIDATE_RECORD")
            continue
        code = row.get("code")
        if type(code) is not str or code == "":
            violations.add("INVALID_CODE")
        elif code in codes:
            violations.add("DUPLICATE_CODE")
        else:
            codes.add(code)
        tier = row.get("tier")
        if type(tier) is not str or tier not in {"actionable", "deep_review", "screened", "excluded"}:
            violations.add("INVALID_TIER")
            continue
        rank_present = "marketRank" in row
        rank = row.get("marketRank")
        if tier in ELIGIBLE_TIERS and (not rank_present or rank is None):
            violations.add("REQUIRED_MARKET_RANK_MISSING")
            continue
        if rank is None:
            continue
        if not is_exact_int(rank):
            violations.add("INVALID_MARKET_RANK_TYPE")
            continue
        if rank <= 0:
            violations.add("INVALID_MARKET_RANK_VALUE")
            continue
        if rank in eligible_ranks:
            violations.add("DUPLICATE_MARKET_RANK")
        eligible_ranks.add(rank)
        if "sector" in row and row["sector"] is not None and type(row["sector"]) is not str:
            violations.add("INVALID_SECTOR_TYPE")
        raw_prescreen_rank = row.get("prescreenRank")
        if tier in ELIGIBLE_TIERS and type(raw_prescreen_rank) is float and not math.isfinite(raw_prescreen_rank):
            violations.add("NONFINITE_PRESCREEN_RANK")
        if tier in ELIGIBLE_TIERS and is_exact_int(raw_prescreen_rank) and raw_prescreen_rank > 0:
            try:
                converted_rank = float(raw_prescreen_rank)
            except OverflowError:
                violations.add("UNREPRESENTABLE_PRESCREEN_RANK_TIEBREAK")
            else:
                if not math.isfinite(converted_rank):
                    violations.add("UNREPRESENTABLE_PRESCREEN_RANK_TIEBREAK")
        if INTERNAL_CONFIDENCE_KEY in row and row[INTERNAL_CONFIDENCE_KEY] is not None:
            if not _finite_numeric(row[INTERNAL_CONFIDENCE_KEY]):
                violations.add("INVALID_INTERNAL_CONFIDENCE_AUTHORITY")
    return tuple(sorted(violations))


def _eligible_rank_map(rows: list[dict[str, Any]]) -> dict[str, int]:
    eligible = [row for row in rows if row["tier"] in ELIGIBLE_TIERS]
    eligible.sort(key=lambda row: (row["marketRank"], row["code"]))
    return {row["code"]: index for index, row in enumerate(eligible, start=1)}


def _shortlist(rows: list[dict[str, Any]], n: int) -> list[dict[str, Any]]:
    eligible = [row for row in rows if row["tier"] in ELIGIBLE_TIERS]
    eligible.sort(key=lambda row: (row["marketRank"], row["code"]))
    return eligible[:n]


def _prescreen_rank_state(row: Mapping[str, Any]) -> tuple[str, float | None]:
    projection = diagnostic_prescreen_rank(row)
    if projection["prescreenRankTiebreakState"] == MISSING:
        return (MISSING, None)
    return ("VALID", projection["prescreenRankTiebreak"])


def _finite_numeric(value: Any) -> bool:
    return type(value) in (int, float) and (type(value) is not float or math.isfinite(value))


def classify_reference_transition(
    base_view: Any,
    perturbed_view: Any,
    *,
    n: int = 3,
) -> ClassificationResult:
    """Classify deterministic v2 semantic transitions from hand-authored views."""
    require_positive_int(n, "n")
    base_input = _rows(base_view, "base")
    perturbed_input = _rows(perturbed_view, "perturbed")
    base_violations = set(_integrity_violations(base_input, "base"))
    perturbed_violations = set(_integrity_violations(perturbed_input, "perturbed"))
    violations = tuple(sorted(base_violations | perturbed_violations))
    if violations:
        return ClassificationResult(
            status="INTEGRITY_FAILURE",
            classes=(),
            violations=violations,
            base_population=None,
            perturbed_population=None,
            base_shortlist_codes=(),
            perturbed_shortlist_codes=(),
            entered_reference_codes=(),
            exited_reference_codes=(),
            entered_eligible_codes=(),
            exited_eligible_codes=(),
            membership_changed=None,
            tier_changed=None,
            order_changed=None,
            transitions=(),
        )

    base = list(base_input)  # validation above guarantees records and scalar identities
    perturbed = list(perturbed_input)
    base_by_code = {row["code"]: row for row in base}
    perturbed_by_code = {row["code"]: row for row in perturbed}
    base_codes = set(base_by_code)
    perturbed_codes = set(perturbed_by_code)
    missing_codes = tuple(sorted(base_codes - perturbed_codes))
    added_codes = tuple(sorted(perturbed_codes - base_codes))
    if missing_codes or added_codes:
        return ClassificationResult(
            status="INTEGRITY_FAILURE",
            classes=(),
            violations=("CANDIDATE_UNIVERSE_MISMATCH",),
            base_population=None,
            perturbed_population=None,
            base_shortlist_codes=(),
            perturbed_shortlist_codes=(),
            entered_reference_codes=(),
            exited_reference_codes=(),
            entered_eligible_codes=(),
            exited_eligible_codes=(),
            membership_changed=None,
            tier_changed=None,
            order_changed=None,
            transitions=(),
            missing_codes=missing_codes,
            added_codes=added_codes,
        )

    contradiction_codes: set[str] = set()
    for code in sorted(base_codes):
        before = base_by_code[code]
        after = perturbed_by_code[code]
        internal_confidence_before = before.get(INTERNAL_CONFIDENCE_KEY)
        internal_confidence_after = after.get(INTERNAL_CONFIDENCE_KEY)
        if internal_confidence_before is not None and internal_confidence_after is not None:
            confidence_before = internal_confidence_before
            confidence_after = internal_confidence_after
        else:
            confidence_before = before.get(PUBLIC_CONFIDENCE_KEY)
            confidence_after = after.get(PUBLIC_CONFIDENCE_KEY)
        if confidence_before is not None and confidence_after is not None:
            if confidence_before != confidence_after:
                contradiction_codes.add("INVARIANT_CONFIDENCE_CHANGED")

        rank_before = _prescreen_rank_state(before)
        rank_after = _prescreen_rank_state(after)
        if rank_before != rank_after:
            contradiction_codes.add("INVARIANT_PRESCREEN_RANK_CHANGED")

        if "sector" in before and "sector" in after and before["sector"] != after["sector"]:
            contradiction_codes.add("INVARIANT_SECTOR_CHANGED")

    if contradiction_codes:
        return ClassificationResult(
            status="CONTRADICTORY",
            classes=(),
            violations=tuple(sorted(contradiction_codes)),
            base_population=None,
            perturbed_population=None,
            base_shortlist_codes=(),
            perturbed_shortlist_codes=(),
            entered_reference_codes=(),
            exited_reference_codes=(),
            entered_eligible_codes=(),
            exited_eligible_codes=(),
            membership_changed=None,
            tier_changed=None,
            order_changed=None,
            transitions=(),
        )

    base_eligible_rank = _eligible_rank_map(base)
    perturbed_eligible_rank = _eligible_rank_map(perturbed)
    base_shortlist_rows = _shortlist(base, n)
    perturbed_shortlist_rows = _shortlist(perturbed, n)
    base_shortlist = [row["code"] for row in base_shortlist_rows]
    perturbed_shortlist = [row["code"] for row in perturbed_shortlist_rows]
    base_short_set = set(base_shortlist)
    perturbed_short_set = set(perturbed_shortlist)
    entered_reference = tuple(sorted(perturbed_short_set - base_short_set))
    exited_reference = tuple(sorted(base_short_set - perturbed_short_set))
    # Set-level eligible entry/exit is scoped to reference-shortlist membership.
    entered_eligible = tuple(
        code for code in sorted(base_codes)
        if code in entered_reference
        and base_by_code[code]["tier"] not in ELIGIBLE_TIERS
        and perturbed_by_code[code]["tier"] in ELIGIBLE_TIERS
    )
    exited_eligible = tuple(
        code for code in sorted(base_codes)
        if code in exited_reference
        and base_by_code[code]["tier"] in ELIGIBLE_TIERS
        and perturbed_by_code[code]["tier"] not in ELIGIBLE_TIERS
    )
    membership_changed = base_short_set != perturbed_short_set
    retained = base_short_set & perturbed_short_set
    tier_changed = any(
        base_by_code[code]["tier"] != perturbed_by_code[code]["tier"]
        and base_by_code[code]["tier"] in ELIGIBLE_TIERS
        and perturbed_by_code[code]["tier"] in ELIGIBLE_TIERS
        for code in retained
    )
    base_retained_order = [code for code in base_shortlist if code in retained]
    perturbed_retained_order = [code for code in perturbed_shortlist if code in retained]
    order_changed = base_retained_order != perturbed_retained_order

    exited_still_eligible = set(exited_reference) & set(perturbed_eligible_rank)
    entered_already_eligible = set(entered_reference) & set(base_eligible_rank)
    same_domain_replacement = bool(exited_still_eligible and entered_already_eligible)
    classes: set[str] = set()
    if same_domain_replacement:
        classes.add("REFERENCE_MEMBER_REPLACED_SAME_ELIGIBLE_DOMAIN")
    if exited_eligible:
        classes.add("REFERENCE_MEMBER_LEFT_ELIGIBLE_TIERS")
    if entered_eligible:
        classes.add("REFERENCE_MEMBER_ENTERED_ELIGIBLE_TIERS")
    if tier_changed:
        classes.add("REFERENCE_MEMBER_TIER_CHANGED_WITHIN_ELIGIBLE_DOMAIN")
    if membership_changed and tier_changed:
        classes.add("REFERENCE_MEMBERSHIP_AND_TIER_CHANGED")
    if min(len(entered_reference), len(exited_reference)) > 1:
        classes.add("MULTIPLE_REFERENCE_MEMBER_REPLACEMENTS")
    if order_changed:
        if membership_changed or tier_changed:
            classes.add("REFERENCE_ORDER_CHANGED_CONCURRENTLY")
        else:
            classes.add("REFERENCE_ORDER_CHANGED_ONLY")
    base_population = len(base_eligible_rank)
    perturbed_population = len(perturbed_eligible_rank)
    if base_population == 0 or perturbed_population == 0:
        classes.add("EMPTY_ELIGIBLE_POPULATION")
    if base_population < n or perturbed_population < n:
        classes.add("ELIGIBLE_POPULATION_SMALLER_THAN_N")

    transitions = tuple(
        CandidateTransition(
            code=code,
            base_tier=base_by_code[code]["tier"],
            perturbed_tier=perturbed_by_code[code]["tier"],
            base_eligible_rank=base_eligible_rank.get(code),
            perturbed_eligible_rank=perturbed_eligible_rank.get(code),
            tier_direction=(
                "promotion" if base_by_code[code]["tier"] == "deep_review" and perturbed_by_code[code]["tier"] == "actionable"
                else "demotion" if base_by_code[code]["tier"] == "actionable" and perturbed_by_code[code]["tier"] == "deep_review"
                else None
            ),
            in_base_shortlist=code in base_short_set,
            in_perturbed_shortlist=code in perturbed_short_set,
        )
        for code in sorted(base_codes)
    )
    if not classes:
        classes.add("STABLE_REFERENCE")
    ordered_classes = tuple(sorted(classes, key=lambda value: (_CLASS_ORDER.index(value) if value in _CLASS_ORDER else len(_CLASS_ORDER), value)))
    return ClassificationResult(
        status="SUPPORTED",
        classes=ordered_classes,
        violations=(),
        base_population=base_population,
        perturbed_population=perturbed_population,
        base_shortlist_codes=tuple(base_shortlist),
        perturbed_shortlist_codes=tuple(perturbed_shortlist),
        entered_reference_codes=entered_reference,
        exited_reference_codes=exited_reference,
        entered_eligible_codes=entered_eligible,
        exited_eligible_codes=exited_eligible,
        membership_changed=membership_changed,
        tier_changed=tier_changed,
        order_changed=order_changed,
        transitions=transitions,
    )


def _observed_order(left: Mapping[str, Any], right: Mapping[str, Any]) -> tuple[str, str] | None:
    left_rank = left.get("marketRank")
    right_rank = right.get("marketRank")
    if not is_exact_int(left_rank) or left_rank <= 0 or not is_exact_int(right_rank) or right_rank <= 0:
        return None
    left_code, right_code = left.get("code"), right.get("code")
    if type(left_code) is not str or type(right_code) is not str or left_code == right_code:
        return None
    if left_rank == right_rank:
        return None
    return (left_code, right_code) if left_rank < right_rank else (right_code, left_code)


def explain_pair_order(left: Mapping[str, Any], right: Mapping[str, Any]) -> RankingExplanation:
    """Explain a pair using only the frozen authority chain and observed rank."""
    left_code, right_code = left.get("code"), right.get("code")
    if (
        type(left_code) is not str or not left_code
        or type(right_code) is not str or not right_code
        or left_code == right_code
    ):
        raise ObservationContractError("ranking comparison requires distinct exact nonempty codes")
    for row in (left, right):
        rank = row.get("marketRank")
        if rank is not None:
            require_positive_int(rank, "marketRank")
    if left.get("marketRank") is not None and left.get("marketRank") == right.get("marketRank"):
        raise ObservationContractError("ranking comparison cannot explain duplicate marketRank")
    for row in (left, right):
        for field in ("marketScore", INTERNAL_CONFIDENCE_KEY, "rawCompositeScore"):
            if field in row and row[field] is not None and not _finite_numeric(row[field]):
                raise ObservationContractError(f"{field} must be a finite exact numeric value")
    observed = _observed_order(left, right)
    observed_first = observed[0] if observed else None
    raw_values: list[tuple[str, int | float | None]] = []
    for row in (left, right):
        raw = row.get("rawCompositeScore")
        if raw is not None and not _finite_numeric(raw):
            raise ObservationContractError("rawCompositeScore diagnostic must be finite or null")
        raw_values.append((row["code"], raw))

    def unavailable() -> RankingExplanation:
        return RankingExplanation("UNAVAILABLE", "UNAVAILABLE", None, observed_first, tuple(raw_values))

    left_score, right_score = left.get("marketScore"), right.get("marketScore")
    if not _finite_numeric(left_score) or not _finite_numeric(right_score):
        return unavailable()
    if left_score != right_score:
        key = "roundedMarketScore"
        expected_first = left_code if left_score > right_score else right_code
    else:
        left_conf = left.get(INTERNAL_CONFIDENCE_KEY)
        right_conf = right.get(INTERNAL_CONFIDENCE_KEY)
        if not _finite_numeric(left_conf) or not _finite_numeric(right_conf):
            return unavailable()
        if left_conf != right_conf:
            key = "internalDataConfidence"
            expected_first = left_code if left_conf > right_conf else right_code
        else:
            left_tie = diagnostic_prescreen_rank(left)
            right_tie = diagnostic_prescreen_rank(right)
            left_state = left_tie["prescreenRankTiebreakState"]
            right_state = right_tie["prescreenRankTiebreakState"]
            left_value = left_tie.get("prescreenRankTiebreak")
            right_value = right_tie.get("prescreenRankTiebreak")
            if left_state != right_state or left_value != right_value:
                key = "prescreenRankTiebreak"
                left_order = math.inf if left_state == MISSING else left_value
                right_order = math.inf if right_state == MISSING else right_value
                expected_first = left_code if left_order < right_order else right_code
            else:
                key = "exactCode"
                expected_first = min(left_code, right_code)

    if observed is None:
        return RankingExplanation("UNAVAILABLE", key, expected_first, None, tuple(raw_values))
    status = "SUPPORTED" if observed_first == expected_first else "CONTRADICTORY"
    return RankingExplanation(status, key, expected_first, observed_first, tuple(raw_values))


def classify_cause(cause_evidence: Any) -> CauseClassification:
    """Accept an explicitly exact cause; otherwise preserve CAUSE_UNRESOLVED."""
    if type(cause_evidence) is not dict:
        return CauseClassification(CAUSE_UNRESOLVED, None)
    state = cause_evidence.get("state")
    if state == "CONTRADICTORY":
        return CauseClassification("CONTRADICTORY", None)
    cause_class = cause_evidence.get("causeClass")
    if state == "EXACT" and type(cause_class) is str and cause_class:
        return CauseClassification("KNOWN_CAUSE", cause_class)
    return CauseClassification(CAUSE_UNRESOLVED, None)
