"""P14-O2-V F-P1-01..08 adversarial coverage closure."""
from __future__ import annotations

import copy

import pytest

import data.candidate_funnel_batch as batch


def _candidate(code: object, *, rank: int = 7, name: str | None = None) -> dict:
    return {
        "code": code,
        "name": name if name is not None else f"name-{code}",
        "sector": "test-sector",
        "price": 1000.0,
        "per": 10.0,
        "pbr": 1.0,
        "roe": 10.0,
        "dividendYield": 2.0,
        "sigma252d": 0.2,
        "mom3m": 5.0,
        "dataStatus": "ok",
        "prescreenRank": rank,
    }


def test_fu1_f_p1_01_case_sensitive_exact_code_tie_break():
    candidates = [_candidate("a"), _candidate("A"), _candidate("B")]
    before = copy.deepcopy(candidates)

    signs = batch._p14_canonical_sign_by_code(candidates)
    perturbed = batch._perturb_candidates(candidates)
    by_code = {candidate["code"]: candidate for candidate in perturbed}

    assert signs == {"A": 1, "B": -1, "a": 1}
    assert by_code["A"]["per"] == pytest.approx(10.2)
    assert by_code["B"]["per"] == pytest.approx(9.8)
    assert by_code["a"]["per"] == pytest.approx(10.2)
    assert [candidate["code"] for candidate in perturbed] == ["a", "A", "B"]
    assert candidates == before


def test_fu1_f_p1_02_whitespace_padding_is_distinct_exact_code_identity():
    candidates = [_candidate("A"), _candidate(" A"), _candidate("B")]
    before = copy.deepcopy(candidates)

    signs = batch._p14_canonical_sign_by_code(candidates)
    perturbed = batch._perturb_candidates(candidates)
    by_code = {candidate["code"]: candidate for candidate in perturbed}

    assert signs == {" A": 1, "A": -1, "B": 1}
    assert by_code[" A"]["per"] == pytest.approx(10.2)
    assert by_code["A"]["per"] == pytest.approx(9.8)
    assert by_code["B"]["per"] == pytest.approx(10.2)
    assert [candidate["code"] for candidate in perturbed] == ["A", " A", "B"]
    assert candidates == before


def test_fu1_f_p1_03_odd_duplicate_group_consumes_no_ordinal():
    candidates = [
        _candidate("DUP", rank=1),
        _candidate("DUP", rank=2),
        _candidate("DUP", rank=3),
        _candidate("A", rank=4),
        _candidate("B", rank=5),
        _candidate("C", rank=6),
    ]

    signs = batch._p14_canonical_sign_by_code(candidates)
    perturbed = batch._perturb_candidates(candidates)
    by_code = {
        candidate["code"]: candidate
        for candidate in perturbed
        if candidate["code"] != "DUP"
    }

    assert signs == {"A": 1, "B": -1, "C": 1}
    assert [candidate["per"] for candidate in perturbed[:3]] == [10.0, 10.0, 10.0]
    assert by_code["A"]["per"] == pytest.approx(10.2)
    assert by_code["B"]["per"] == pytest.approx(9.8)
    assert by_code["C"]["per"] == pytest.approx(10.2)
    assert "DUP" not in signs


def test_fu1_f_p1_04_exact_jaccard_boundary_passes(monkeypatch):
    joined_candidates = [
        _candidate(str(index), rank=index)
        for index in range(1, 9)
    ]
    engine_candidates = [
        {
            "code": candidate["code"],
            "tier": "actionable",
            "prescreenScore": 0.5,
            "dataConfidence": 1.0,
            "marketScore": float((index - 1) * 10),
            "marketRank": index,
            "riskReasons": [],
            "hardExclusionReasons": [],
        }
        for index, candidate in enumerate(joined_candidates, start=1)
    ]
    sectors = {f"sector-{index}": 1 for index in range(1, 8)}
    engine_result = {
        "status": "generated",
        "candidates": engine_candidates,
        "counts": {"deepReview": 8, "actionable": 8},
        "sectorDistribution": {
            "deepReview": sectors,
            "actionable": {key: value for key, value in list(sectors.items())[:4]},
        },
        "selectionObservability": {
            "sourceStale": False,
            "deepReviewSectorCapOverflow": 0,
            "actionableSectorCapOverflow": 0,
            "deepReviewEligibleCount": 8,
            "deepReviewSelectedCount": 8,
            "actionableEligibleCount": 8,
            "actionableSelectedCount": 8,
        },
    }
    monkeypatch.setattr(
        batch,
        "compute_degraded_path_actionable",
        lambda candidates, context: (0, {}),
    )
    monkeypatch.setattr(
        batch,
        "compute_rank_stability",
        lambda candidates, context, result: (0.95, {}),
    )

    report = batch.compute_quality_report(
        candidates_stocks_payload={"candidates": joined_candidates},
        joined_candidates=joined_candidates,
        join_stats={
            "candidateCount": 8,
            "joinRate": 1.0,
            "unmatchedCandidateRate": 0.0,
        },
        prescreen_duplicate_codes=[],
        engine_result=engine_result,
        context={"pipelinePath": "normal"},
        previous_artifact=None,
    )
    gate = next(gate for gate in report["gates"] if gate["id"] == "P-14")

    assert gate["value"] == 0.95
    assert gate["threshold"] == ">= 0.95"
    assert gate["status"] == "PASS"
    assert "P-14" not in report["hardFailIds"]
    assert report["overallPass"] is True


def test_fu1_f_p1_05_code_not_name_controls_tie_break():
    candidates = [
        _candidate("C", name="omega"),
        _candidate("A", name="beta"),
        _candidate("D", name="gamma"),
        _candidate("B", name="alpha"),
    ]

    signs = batch._p14_canonical_sign_by_code(candidates)
    perturbed = batch._perturb_candidates(candidates)
    by_code = {candidate["code"]: candidate for candidate in perturbed}

    assert signs == {"A": 1, "B": -1, "C": 1, "D": -1}
    assert by_code["A"]["per"] == pytest.approx(10.2)
    assert by_code["B"]["per"] == pytest.approx(9.8)
    assert by_code["C"]["per"] == pytest.approx(10.2)
    assert by_code["D"]["per"] == pytest.approx(9.8)
    assert [candidate["code"] for candidate in perturbed] == ["C", "A", "D", "B"]


def test_fu1_f_p1_06_whitespace_only_code_is_valid_identity():
    candidates = [_candidate("A"), _candidate(" "), _candidate("B")]

    signs = batch._p14_canonical_sign_by_code(candidates)
    perturbed = batch._perturb_candidates(candidates)
    by_code = {candidate["code"]: candidate for candidate in perturbed}

    assert signs == {" ": 1, "A": -1, "B": 1}
    assert by_code[" "]["per"] == pytest.approx(10.2)
    assert by_code["A"]["per"] == pytest.approx(9.8)
    assert by_code["B"]["per"] == pytest.approx(10.2)
    assert [candidate["code"] for candidate in perturbed] == ["A", " ", "B"]


def test_fu1_f_p1_07_nfkc_equivalent_codes_remain_distinct():
    candidates = [_candidate("Ａ"), _candidate("A"), _candidate("B")]
    before = copy.deepcopy(candidates)

    signs = batch._p14_canonical_sign_by_code(candidates)
    perturbed = batch._perturb_candidates(candidates)
    by_code = {candidate["code"]: candidate for candidate in perturbed}

    assert signs == {"A": 1, "B": -1, "Ａ": 1}
    assert by_code["A"]["per"] == pytest.approx(10.2)
    assert by_code["B"]["per"] == pytest.approx(9.8)
    assert by_code["Ａ"]["per"] == pytest.approx(10.2)
    assert [candidate["code"] for candidate in perturbed] == ["Ａ", "A", "B"]
    assert candidates == before


def test_fu1_f_p1_08_leading_zero_codes_remain_distinct():
    candidates = [_candidate("10"), _candidate("0010"), _candidate("20")]
    before = copy.deepcopy(candidates)

    signs = batch._p14_canonical_sign_by_code(candidates)
    perturbed = batch._perturb_candidates(candidates)
    by_code = {candidate["code"]: candidate for candidate in perturbed}

    assert signs == {"0010": 1, "10": -1, "20": 1}
    assert by_code["0010"]["per"] == pytest.approx(10.2)
    assert by_code["10"]["per"] == pytest.approx(9.8)
    assert by_code["20"]["per"] == pytest.approx(10.2)
    assert [candidate["code"] for candidate in perturbed] == ["10", "0010", "20"]
    assert candidates == before
