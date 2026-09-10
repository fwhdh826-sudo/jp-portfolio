"""P5-B005-B4-A §17-§19: Candidate Funnel は Phase A の fundamental field
（profitGrowth / epsGrowth / fiscalPeriodEnd / fundamentalsStatus）が
candidate record に付いても scoring / ranking / output を一切変えない。

growth component は reserved zero-weight のまま（GROWTH_SCORING_STATUS =
reserved_zero_weight）。P-14 replay identity も新 field を取り込まない。
"""
from __future__ import annotations

import copy

from data.candidate_funnel_engine import (
    COMPONENT_SOURCE_FIELDS,
    COMPONENT_WEIGHTS,
    build_candidate_funnel,
)
from data.candidate_funnel_run_evidence import REPLAY_CANDIDATE_FIELDS
from data.candidate_funnel_batch import join_candidates_with_prescreen

_PHASE_A_FIELDS = ("profitGrowth", "epsGrowth", "fiscalPeriodEnd", "fundamentalsStatus")


def _make_population(n=40):
    out = []
    for i in range(n):
        out.append(
            {
                "code": f"{1000 + i}",
                "name": f"銘柄{1000 + i}",
                "sector": ["a", "b", "c", "d", "e"][i % 5],
                "price": 800.0 + i * 13.0,
                "per": 6.0 + (i % 30) * 1.3,
                "pbr": 0.6 + (i % 20) * 0.2,
                "roe": -4.0 + (i % 25) * 1.1,
                "dividendYield": (i % 12) * 0.35,
                "sigma252d": 0.12 + (i % 18) * 0.012,
                "mom3m": -12.0 + (i % 40) * 1.1,
                "dataStatus": "ok" if i % 7 else "partial",
            }
        )
    return out


def _decorate_with_phase_a(population):
    """Phase A fundamental field を多様な値（null 含む）で付与する。"""
    decorated = copy.deepcopy(population)
    statuses = ["available", "partial", "missing", "stale", "invalid"]
    for i, rec in enumerate(decorated):
        if i % 4 == 0:
            rec["profitGrowth"] = None
            rec["epsGrowth"] = None
            rec["fiscalPeriodEnd"] = None
            rec["fundamentalsStatus"] = "missing"
        else:
            rec["profitGrowth"] = round(-30.0 + i * 3.7, 2)
            rec["epsGrowth"] = round(-25.0 + i * 2.9, 2)
            rec["fiscalPeriodEnd"] = "2026-03-31"
            rec["fundamentalsStatus"] = statuses[i % len(statuses)]
    return decorated


_CONTEXTS = (
    {"pipelinePath": "normal"},
    {"pipelinePath": "seed_fallback"},
    {"pipelinePath": "normal", "regime": "bear_crisis"},
)


def test_growth_component_is_reserved_zero_weight():
    assert COMPONENT_WEIGHTS["growth"] == 0.0
    assert COMPONENT_SOURCE_FIELDS["growth"] == ()
    assert {c for c, w in COMPONENT_WEIGHTS.items() if w > 0.0} == {"valuation", "quality"}


def test_funnel_output_is_identical_with_and_without_phase_a_fields():
    base_pop = _make_population(40)
    decorated_pop = _decorate_with_phase_a(base_pop)

    for ctx in _CONTEXTS:
        # calibration/engine 実行自体が入力を mutate しないことも証明したいので
        # 比較確立の前に独立 deep copy を使う（P3 test hardening）。
        without = build_candidate_funnel(copy.deepcopy(base_pop), dict(ctx))
        with_fields = build_candidate_funnel(copy.deepcopy(decorated_pop), dict(ctx))
        assert without == with_fields, f"funnel output changed for context {ctx}"

    # decorated_pop 自体が上記呼び出しで mutate されていないこと。
    assert decorated_pop == _decorate_with_phase_a(base_pop)


def test_phase_a_fields_do_not_appear_in_funnel_candidate_output():
    decorated_pop = _decorate_with_phase_a(_make_population(20))
    result = build_candidate_funnel(decorated_pop, {"pipelinePath": "normal"})
    for cand in result["candidates"]:
        for field in _PHASE_A_FIELDS:
            assert field not in cand


def test_p14_replay_candidate_fields_exclude_phase_a_fields():
    # §19: 新 optional field は P-14 baseline / perturbed market-record hashing を
    # 変えない。replay allowlist に入らないことで構造的に保証する。
    for field in _PHASE_A_FIELDS:
        assert field not in REPLAY_CANDIDATE_FIELDS


def test_prescreen_join_preserves_phase_a_fields_without_affecting_engine():
    # join は shallow copy で新 field を保持するが（下流 observability 用）、
    # engine 出力は不変（上の invariance テストが担保）。
    decorated = _decorate_with_phase_a(_make_population(5))
    joined, _stats = join_candidates_with_prescreen(decorated, {})
    assert any("profitGrowth" in c for c in joined)
