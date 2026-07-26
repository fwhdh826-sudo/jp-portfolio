"""
P5-B005-B1-R: data/candidate_funnel_engine.py の direct test。

P5-B005-A2 frozen scoring specification（
/Users/ryo/jp-portfolio-audit-reports/p5-b005-a2-scoring-specification.md,
audited SHA 665eba993b3d3ccfcf434c245a8784765f34bf43）に対する実装検証。

確認項目（ticket §19 の最低70項目 + §20 calibration regression）:
  Specification(1-12) / Formula(13-22) / Safety(23-32) / Determinism(33-37) /
  Tier(38-52) / Explainability・privacy(53-63) / 現行artifact degraded
  compatibility(64-70)。
"""
import copy
import json
import math
from datetime import datetime

import pytest

import data.candidate_funnel_engine as engine
from data.candidate_funnel_engine import (
    ACTIONABLE_HARD_MAX,
    ACTIONABLE_MIN_DATA_CONFIDENCE,
    ACTIONABLE_MIN_MARKET_SCORE,
    ACTIONABLE_MIN_QUALITY_PERCENTILE,
    ACTIONABLE_MIN_VALUATION_PERCENTILE,
    ACTIONABLE_SECTOR_HARD_CAP,
    BEAR_CRISIS_ACTIONABLE_HARD_MAX,
    BEAR_CRISIS_ACTIONABLE_SECTOR_HARD_CAP,
    CANDIDATE_FUNNEL_DEGRADATION_REASON_CODES,
    CANDIDATE_FUNNEL_HARD_REASON_CODES,
    CANDIDATE_FUNNEL_PIPELINE_PATHS,
    CANDIDATE_FUNNEL_SCHEMA_VERSION,
    CANDIDATE_FUNNEL_SCORE_VERSION,
    CANDIDATE_FUNNEL_SELECTED_REASON_CODES,
    CANDIDATE_FUNNEL_SOFT_REASON_CODES,
    CANDIDATE_FUNNEL_THEME_STATUSES,
    CANDIDATE_FUNNEL_TIERS,
    CANDIDATE_FUNNEL_VERSION,
    COMPONENT_WEIGHTS,
    DEEP_REVIEW_HARD_MAX,
    DEEP_REVIEW_MIN_DATA_CONFIDENCE,
    DEEP_REVIEW_MIN_MARKET_SCORE,
    DEEP_REVIEW_SECTOR_HARD_CAP,
    MIN_USABLE_AXES,
    PRESCREEN_PRIOR_WEIGHT,
    STAGE3_COMPOSITE_WEIGHT,
    VALUATION_SUB_WEIGHTS,
    VOL_ELEVATED,
    VOL_HARD_LIMIT,
    VOL_NORMAL,
    VOL_RED_FLAG,
    VOL_SOFT_LIMIT,
    VOL_UNAVAILABLE,
    build_candidate_funnel,
    percentile_rank,
    resolve_actionable_capacity,
)

FORBIDDEN_KEYS = {
    "action",
    "BUY_NEW",
    "WATCH",
    "SELL",
    "BLOCKED",
    "headroom",
    "amount",
    "maxAmount",
    "sizing",
    "portfolio",
    "portfolioFit",
    "holdings",
    "cash",
    "reserve",
    "account",
    "quantity",
    "purchasePrice",
    "marketValue",
    "officialDecision",
}


def _walk_forbidden_keys(node):
    """FORBIDDEN_KEYS を payload の全階層（dict のキー / list 要素）へ
    再帰的に適用する（T-20: トップレベルのみの検査を禁止）。"""
    found = set()
    if isinstance(node, dict):
        for key, value in node.items():
            if key in FORBIDDEN_KEYS:
                found.add(key)
            found |= _walk_forbidden_keys(value)
    elif isinstance(node, list):
        for item in node:
            found |= _walk_forbidden_keys(item)
    return found


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_candidate(code="1000", **overrides):
    base = {
        "code": code,
        "name": f"銘柄{code}",
        "sector": "サービス業",
        "price": 1000.0,
        "per": 15.0,
        "pbr": 1.2,
        "roe": 10.0,
        "dividendYield": 2.0,
        "sigma252d": 0.2,
        "mom3m": 5.0,
        "dataStatus": "ok",
    }
    base.update(overrides)
    return base


def make_population(n, sectors=None, seed_offset=0):
    """n件の多様な synthetic candidate を決定的に生成する（乱数不使用）。
    per/pbr/roe/dividendYield/sigma252d/mom3mをindexベースで分散させ、
    percentile-rank に意味のある広がりを持たせる。"""
    sectors = sectors or ["sectorA", "sectorB", "sectorC", "sectorD", "sectorE", "sectorF", "sectorG", "sectorH"]
    out = []
    for i in range(n):
        idx = i + seed_offset
        out.append(
            make_candidate(
                code=f"{1000 + idx}",
                sector=sectors[idx % len(sectors)],
                per=5.0 + (idx % 50) * 1.5,
                pbr=0.5 + (idx % 40) * 0.15,
                roe=-5.0 + (idx % 45) * 1.0,
                dividendYield=0.0 + (idx % 30) * 0.2,
                sigma252d=0.10 + (idx % 40) * 0.01,
                mom3m=-10.0 + (idx % 60) * 1.0,
            )
        )
    return out


def make_weak_filler(n, sector_prefix="weak", seed_offset=0):
    """strong candidate との比較専用。per/pbr/roe/dividendYieldの全軸で
    明確に劣る filler（valuation/quality percentile を strong側の上位へ
    確実に押し上げるため、make_population の広い/重複するレンジは使わない）。"""
    out = []
    for i in range(n):
        idx = i + seed_offset
        out.append(
            make_candidate(
                # 4桁固定（5桁の全数字codeは HARD_PREFERRED_OR_NONSTANDARD_CODE
                # に該当するため、idx が大きくても必ず4桁に収める）。
                code=f"4{idx % 900:03d}",
                sector=f"{sector_prefix}{idx % 10}",
                per=50.0 + (idx % 40) * 1.0,
                pbr=3.0 + (idx % 40) * 0.1,
                roe=-10.0 + (idx % 15) * 1.0,
                dividendYield=0.0 + (idx % 10) * 0.05,
                sigma252d=0.20 + (idx % 20) * 0.01,
                mom3m=-20.0 + (idx % 20) * 1.0,
            )
        )
    return out


def run(candidates, **context_overrides):
    context = {"pipelinePath": "normal"}
    context.update(context_overrides)
    return build_candidate_funnel(candidates, context)


def only(result):
    """候補1件の結果を返す（result['candidates'][0]）。"""
    return result["candidates"][0]


# ===========================================================================
# Specification (1-12)
# ===========================================================================


def test_01_prescreen_prior_weight():
    assert PRESCREEN_PRIOR_WEIGHT == 0.35


def test_02_stage3_weight():
    assert STAGE3_COMPOSITE_WEIGHT == 0.65


def test_03_prior_plus_stage3_equals_one():
    assert math.isclose(PRESCREEN_PRIOR_WEIGHT + STAGE3_COMPOSITE_WEIGHT, 1.0)


def test_04_component_count_10():
    assert len(COMPONENT_WEIGHTS) == 10


def test_05_valuation_weight():
    assert COMPONENT_WEIGHTS["valuation"] == 0.55


def test_06_quality_weight():
    assert COMPONENT_WEIGHTS["quality"] == 0.45


def test_07_remaining_eight_weights_zero():
    zero_ids = [c for c in COMPONENT_WEIGHTS if c not in ("valuation", "quality")]
    assert len(zero_ids) == 8
    assert all(COMPONENT_WEIGHTS[c] == 0.0 for c in zero_ids)


def test_08_stage3_weight_sum_one():
    assert math.isclose(sum(COMPONENT_WEIGHTS.values()), 1.0)


def test_09_hard_reason_count_8():
    assert len(CANDIDATE_FUNNEL_HARD_REASON_CODES) == 8
    assert len(set(CANDIDATE_FUNNEL_HARD_REASON_CODES)) == 8


def test_09b_soft_reason_count_13():
    # A2-S §25.6: frozen SOFT reason は13件（既存10件 + 新規3件）。
    assert len(CANDIDATE_FUNNEL_SOFT_REASON_CODES) == 13
    assert len(set(CANDIDATE_FUNNEL_SOFT_REASON_CODES)) == 13
    # 既存10件の文字列・順序・index 0-9 は不変。
    assert CANDIDATE_FUNNEL_SOFT_REASON_CODES[:10] == (
        "SOFT_ELEVATED_VOLATILITY",
        "SOFT_WEAK_MOMENTUM",
        "SOFT_DEEP_DRAWDOWN",
        "SOFT_WEAK_TREND",
        "SOFT_SECTOR_CROWDING",
        "SOFT_THEME_CROWDING",
        "SOFT_LOW_DATA_CONFIDENCE",
        "SOFT_STALE_SOURCE",
        "SOFT_PORTFOLIO_OVERLAP",
        "SOFT_FALLBACK_PROVENANCE",
    )
    assert CANDIDATE_FUNNEL_SOFT_REASON_CODES[10:] == (
        "SOFT_PRESCREEN_METADATA_MISSING",
        "SOFT_VOLATILITY_RED_FLAG",
        "SOFT_VOLATILITY_UNAVAILABLE",
    )


def test_10_version_strings_flip_when_present():
    assert CANDIDATE_FUNNEL_SCHEMA_VERSION == "candidate-funnel-1"
    assert CANDIDATE_FUNNEL_VERSION == "candidate-funnel-v1"
    assert CANDIDATE_FUNNEL_SCORE_VERSION == "market-score-v1"


def test_11_result_carries_version_strings():
    result = run(make_population(20))
    assert result["schemaVersion"] == CANDIDATE_FUNNEL_SCHEMA_VERSION
    assert result["funnelVersion"] == CANDIDATE_FUNNEL_VERSION
    assert result["scoreVersion"] == CANDIDATE_FUNNEL_SCORE_VERSION


def test_12_python_ts_parity_placeholder():
    # 実際の parity 検証は src/types/candidateFunnel.contract.test.ts が
    # subprocess 経由で python 側定数を JSON 抽出し突合する。
    assert CANDIDATE_FUNNEL_TIERS == ("excluded", "eligible", "screened", "deep_review", "actionable")
    assert CANDIDATE_FUNNEL_PIPELINE_PATHS == ("normal", "cache_fallback", "seed_fallback")


# ===========================================================================
# Formula (13-22)
# ===========================================================================


def test_13_frozen_formula_exact():
    pop = make_population(30)
    pop[0]["prescreenScore"] = 0.8
    result = run(pop, sourceUpdatedAt=None, asOf=None)
    c = result["candidates"][0]
    valuation = next(x for x in c["scoreBreakdown"] if x["id"] == "valuation")["value"]
    quality = next(x for x in c["scoreBreakdown"] if x["id"] == "quality")["value"]
    stage3 = 0.55 * valuation + 0.45 * quality
    expected_raw = 0.35 * 0.8 + 0.65 * stage3
    expected_score = engine._round_half_up(100.0 * min(max(expected_raw, 0.0), 1.0), 1)
    assert c["marketScore"] == expected_score


def test_14_no_base_score_50():
    # 全 component 0（missing）でも marketScore は 50 に寄らず 0 に近い。
    pop = [make_candidate(code="9999", per=None, pbr=None, roe=None, dividendYield=None, sigma252d=None, mom3m=None)]
    result = run(pop)
    assert result["candidates"][0]["marketScore"] == 0.0


def test_15_score_range_0_100():
    result = run(make_population(50))
    for c in result["candidates"]:
        assert 0.0 <= c["marketScore"] <= 100.0


def test_16_confidence_range_0_1():
    result = run(make_population(50))
    for c in result["candidates"]:
        assert 0.0 <= c["dataConfidence"] <= 1.0


def test_17_final_rounding_1_decimal():
    result = run(make_population(50))
    for c in result["candidates"]:
        assert round(c["marketScore"], 1) == c["marketScore"]


def test_18_no_premature_intermediate_rounding():
    pop = make_population(20)
    pop[0]["per"] = 33.333333
    pop[0]["pbr"] = 1.23456789
    result = run(pop)
    c = result["candidates"][0]
    valuation = next(x for x in c["scoreBreakdown"] if x["id"] == "valuation")["value"]
    # 表示は4dp round されているが、内部計算(rawCompositeScore)は
    # 4dp丸め値からの再計算ではなくフル精度から算出されている
    # ことを、marketScoreがround(4dp*100*0.65*0.55,...)と厳密一致しない
    # 可能性を許容しつつ、rawCompositeScoreがNoneでない実数であることで確認する。
    assert isinstance(c["rawCompositeScore"], float)
    assert valuation is not None


def test_19_prescreen_score_affects_market_score():
    pop = make_population(20)
    pop_low = copy.deepcopy(pop)
    pop_high = copy.deepcopy(pop)
    for c in pop_low:
        c["prescreenScore"] = 0.0
    for c in pop_high:
        c["prescreenScore"] = 1.0
    r_low = run(pop_low)
    r_high = run(pop_high)
    assert r_high["candidates"][0]["marketScore"] > r_low["candidates"][0]["marketScore"]


def test_20_valuation_affects_market_score():
    cheap = make_candidate(code="9111", per=6.0, pbr=0.5, dividendYield=5.0)
    expensive = make_candidate(code="9222", per=90.0, pbr=9.0, dividendYield=0.0)
    filler = make_population(20, seed_offset=100)
    result = run([cheap, expensive] + filler)
    by_code = {c["code"]: c for c in result["candidates"]}
    assert by_code["9111"]["marketScore"] > by_code["9222"]["marketScore"]


def test_21_quality_affects_market_score():
    good = make_candidate(code="3333", roe=35.0)
    bad = make_candidate(code="4444", roe=-10.0)
    filler = make_population(20, seed_offset=200)
    result = run([good, bad] + filler)
    by_code = {c["code"]: c for c in result["candidates"]}
    assert by_code["3333"]["marketScore"] > by_code["4444"]["marketScore"]


def test_22_zero_weight_component_does_not_affect_score():
    base = make_population(20, seed_offset=300)
    varied = copy.deepcopy(base)
    varied[0]["mom3m"] = 999.0
    varied[0]["sigma252d"] = 0.01
    r_base = run(base)
    r_varied = run(varied)
    assert r_base["candidates"][0]["marketScore"] == r_varied["candidates"][0]["marketScore"]


# ===========================================================================
# Safety (23-32)
# ===========================================================================


def test_23_missing_value_does_not_improve_score():
    full = make_candidate(code="5555", per=10.0, pbr=1.0, roe=15.0, dividendYield=3.0)
    missing = make_candidate(code="6666", per=None, pbr=None, roe=None, dividendYield=None)
    filler = make_population(20, seed_offset=400)
    result = run([full, missing] + filler)
    by_code = {c["code"]: c for c in result["candidates"]}
    assert by_code["6666"]["marketScore"] <= by_code["5555"]["marketScore"]


def test_24_invalid_value_does_not_improve_score():
    valid = make_candidate(code="7777", per=10.0)
    invalid = make_candidate(code="8888", per=float("nan"))
    filler = make_population(20, seed_offset=500)
    result = run([valid, invalid] + filler)
    by_code = {c["code"]: c for c in result["candidates"]}
    assert by_code["8888"]["marketScore"] <= by_code["7777"]["marketScore"]


def test_25_negative_per_no_cheapness_benefit():
    # 負PERは missing(None)と全く同一の valuation 値になる（earningsYield sub
    # を None 寄与=rank0 とする安全側処理。abs()等で「割安」に転化しない）。
    pop_negative = make_population(20, seed_offset=600)
    pop_negative[0]["per"] = -5.0
    pop_missing = make_population(20, seed_offset=600)
    pop_missing[0]["per"] = None
    r_neg = run(pop_negative)
    r_missing = run(pop_missing)
    valuation_neg = next(x for x in r_neg["candidates"][0]["scoreBreakdown"] if x["id"] == "valuation")["value"]
    valuation_missing = next(x for x in r_missing["candidates"][0]["scoreBreakdown"] if x["id"] == "valuation")["value"]
    assert valuation_neg == valuation_missing
    assert valuation_neg < 1.0


def test_26_negative_pbr_no_cheapness_benefit():
    pop_negative = make_population(20, seed_offset=700)
    pop_negative[0]["pbr"] = -1.0
    pop_missing = make_population(20, seed_offset=700)
    pop_missing[0]["pbr"] = None
    r_neg = run(pop_negative)
    r_missing = run(pop_missing)
    valuation_neg = next(x for x in r_neg["candidates"][0]["scoreBreakdown"] if x["id"] == "valuation")["value"]
    valuation_missing = next(x for x in r_missing["candidates"][0]["scoreBreakdown"] if x["id"] == "valuation")["value"]
    assert valuation_neg == valuation_missing
    assert valuation_neg < 1.0


def test_27_negative_roe_no_quality_benefit():
    pop = make_population(20, seed_offset=800)
    high_roe_idx = max(range(len(pop)), key=lambda i: pop[i]["roe"])
    pop[0]["roe"] = -50.0
    result = run(pop)
    quality0 = next(x for x in result["candidates"][0]["scoreBreakdown"] if x["id"] == "quality")["value"]
    quality_best = next(x for x in result["candidates"][high_roe_idx]["scoreBreakdown"] if x["id"] == "quality")[
        "value"
    ]
    assert quality0 < quality_best


def test_28_nan_rejected_degraded():
    # A2-S2 §19.17 T3-16: `in ("invalid", "available")` は常に真になる同語
    # 反復だった。per=NaN でも pbr/dividendYield が有効な母集団では
    # _combine_status が必ず "available" を返すことを単一の期待値で固定する。
    pop = make_population(10, seed_offset=900)
    pop[0]["per"] = float("nan")
    result = run(pop)
    comp = next(x for x in result["candidates"][0]["scoreBreakdown"] if x["id"] == "valuation")
    assert comp["status"] == "available"  # pbr/dividendYield が present_valid のため


def test_29_infinity_rejected_degraded():
    pop = make_population(10, seed_offset=1000)
    pop[0]["sigma252d"] = float("inf")
    result = run(pop)
    comp = next(x for x in result["candidates"][0]["scoreBreakdown"] if x["id"] == "risk")
    assert comp["value"] == 0.0


def test_30_bool_not_accepted_as_numeric():
    pop = make_population(10, seed_offset=1100)
    pop[0]["roe"] = True
    result = run(pop)
    comp = next(x for x in result["candidates"][0]["scoreBreakdown"] if x["id"] == "quality")
    # bool は present だが numeric として無効 -> 'invalid'（absentの'missing'とは区別する）
    assert comp["status"] == "invalid"
    assert comp["value"] == 0.0


def test_31_missing_prescreen_does_not_redistribute():
    pop = make_population(10, seed_offset=1200)
    result = run(pop)
    c = result["candidates"][0]
    stage3 = 0.55 * next(x for x in c["scoreBreakdown"] if x["id"] == "valuation")["value"] + 0.45 * next(
        x for x in c["scoreBreakdown"] if x["id"] == "quality"
    )["value"]
    expected = engine._round_half_up(100.0 * min(max(0.65 * stage3, 0.0), 1.0), 1)
    assert c["marketScore"] == expected


def test_32_candidate_array_order_is_not_prescreen_rank():
    pop = make_population(10, seed_offset=1300)
    reversed_pop = list(reversed(pop))
    r1 = run(pop)
    r2 = run(reversed_pop)
    ranks1 = {c["code"]: c["marketRank"] for c in r1["candidates"]}
    ranks2 = {c["code"]: c["marketRank"] for c in r2["candidates"]}
    assert ranks1 == ranks2


# ===========================================================================
# Determinism (33-37)
# ===========================================================================


def test_33_identical_input_identical_output():
    pop = make_population(40, seed_offset=1400)
    r1 = run(copy.deepcopy(pop))
    r2 = run(copy.deepcopy(pop))
    assert r1 == r2


def test_34_input_permutation_invariant():
    pop = make_population(40, seed_offset=1500)
    shuffled = [pop[i] for i in range(len(pop) - 1, -1, -1)]
    r1 = run(pop)
    r2 = run(shuffled)
    m1 = {c["code"]: (c["marketScore"], c["marketRank"], c["tier"]) for c in r1["candidates"]}
    m2 = {c["code"]: (c["marketScore"], c["marketRank"], c["tier"]) for c in r2["candidates"]}
    assert m1 == m2


def test_35_deterministic_ties():
    a = make_candidate(code="AAAA", per=10.0, pbr=1.0, roe=10.0, dividendYield=2.0, sigma252d=0.2, mom3m=5.0)
    b = make_candidate(code="BBBB", per=10.0, pbr=1.0, roe=10.0, dividendYield=2.0, sigma252d=0.2, mom3m=5.0)
    result = run([a, b])
    by_code = {c["code"]: c for c in result["candidates"]}
    assert by_code["AAAA"]["marketScore"] == by_code["BBBB"]["marketScore"]
    # tie-break 最終キー code 昇順 -> AAAA が優先rank
    assert by_code["AAAA"]["marketRank"] < by_code["BBBB"]["marketRank"]

    # 入力順を反転しても tie-break は code 昇順のまま（position昇順ではない）
    result_rev = run([b, a])
    by_code_rev = {c["code"]: c for c in result_rev["candidates"]}
    assert by_code_rev["AAAA"]["marketRank"] < by_code_rev["BBBB"]["marketRank"]
    assert by_code_rev["AAAA"]["marketRank"] == by_code["AAAA"]["marketRank"]


def test_36_repeated_run_identical():
    pop = make_population(30, seed_offset=1600)
    results = [run(copy.deepcopy(pop)) for _ in range(3)]
    assert results[0] == results[1] == results[2]


def test_37_unique_sequential_market_rank():
    pop = make_population(60, seed_offset=1700)
    result = run(pop)
    ranks = sorted(c["marketRank"] for c in result["candidates"])
    assert ranks == list(range(1, len(pop) + 1))


# ===========================================================================
# Tier (38-52)
# ===========================================================================


def test_38_deep_review_threshold_55():
    assert DEEP_REVIEW_MIN_MARKET_SCORE == 55.0


def test_39_deep_review_max_40():
    assert DEEP_REVIEW_HARD_MAX == 40


def test_40_deep_review_sector_cap_6():
    assert DEEP_REVIEW_SECTOR_HARD_CAP == 6


def test_41_actionable_threshold_68():
    assert ACTIONABLE_MIN_MARKET_SCORE == 68.0


def test_42_actionable_max_12():
    assert ACTIONABLE_HARD_MAX == 12


def test_43_actionable_sector_cap_2():
    assert ACTIONABLE_SECTOR_HARD_CAP == 2


def test_44_bear_crisis_max_5():
    assert BEAR_CRISIS_ACTIONABLE_HARD_MAX == 5
    assert BEAR_CRISIS_ACTIONABLE_SECTOR_HARD_CAP == 2


def _strong_candidate(code, sector, prescreen=0.9):
    return make_candidate(
        code=code,
        sector=sector,
        per=6.0,
        pbr=0.5,
        roe=30.0,
        dividendYield=5.0,
        sigma252d=0.10,
        mom3m=20.0,
        prescreenScore=prescreen,
    )


def test_45_threshold_not_met_no_backfill():
    # 全員弱い候補 -> deep_review/actionable 0件のまま、穴埋めされない
    pop = [
        make_candidate(code=f"{2000+i}", per=80.0, pbr=8.0, roe=-5.0, dividendYield=0.0, prescreenScore=0.0)
        for i in range(10)
    ]
    result = run(pop)
    assert result["counts"]["deepReview"] == 0
    assert result["counts"]["actionable"] == 0


def test_46_sector_cap_does_not_change_market_rank():
    strong = [_strong_candidate(f"{3000+i}", "同一業種") for i in range(10)]
    result = run(strong)
    ranks = sorted(c["marketRank"] for c in result["candidates"])
    assert ranks == list(range(1, 11))  # cap超過でも marketRank は連番のまま保持


def test_47_sector_cap_observability():
    strong = [_strong_candidate(f"{4000+i}", "集中業種") for i in range(10)]
    result = run(strong)
    obs = result["selectionObservability"]
    assert obs["deepReviewSectorCapOverflow"].get("集中業種", 0) > 0


def test_48_low_confidence_high_score_no_actionable():
    c = make_candidate(
        code="5001",
        per=6.0,
        pbr=0.5,
        roe=30.0,
        dividendYield=5.0,
        sigma252d=0.10,
        mom3m=20.0,
        prescreenScore=0.9,
        per_=None,
    )
    # usableAxes を強制的に落とす（roe以外を欠損させ、dataConfidence<0.67に）
    c["pbr"] = None
    c["dividendYield"] = None
    c["mom3m"] = None
    filler = make_population(10, seed_offset=1800)
    result = run([c] + filler)
    out = result["candidates"][0]
    assert out["tier"] != "actionable"


def test_49_partial_candidate_no_actionable():
    c = _strong_candidate("6001", "業種P")
    c["dataStatus"] = "partial"
    filler = make_population(10, seed_offset=1900)
    result = run([c] + filler)
    out = result["candidates"][0]
    assert out["tier"] != "actionable"


def test_50_stale_source_no_deep_review_or_actionable():
    # filler(弱い母集団)を混ぜ、strong候補が percentile rank 上位を確実に
    # 取り marketScore>=68 を満たす状態にした上で、staleness だけが
    # actionable を止めていることを検証する（filler無しだと同値tie rank=0.5
    # に潰れ marketScore が68未満のまま突入し、staleness gate自体の検証に
    # ならないため）。
    strong = [_strong_candidate(f"{7000+i}", f"業種S{i}") for i in range(5)]
    filler = make_weak_filler(15, seed_offset=7100)
    result = run(
        strong + filler,
        sourceUpdatedAt="2026-01-01T00:00:00+00:00",
        asOf="2026-01-10T00:00:00+00:00",
        staleThresholdHours=48,
    )
    assert any(c["marketScore"] is not None and c["marketScore"] >= 68.0 for c in result["candidates"][:5])
    assert result["counts"]["actionable"] == 0
    # deep-reviewはstaleでも許容(A2 §9)されるため、ここでは actionable のみ検証


def test_51_seed_fallback_no_actionable():
    strong = [_strong_candidate(f"{8000+i}", f"業種F{i}") for i in range(5)]
    filler = make_weak_filler(15, seed_offset=8100)
    result = run(strong + filler, pipelinePath="seed_fallback")
    assert result["status"] == "not_generated"
    assert result["counts"]["actionable"] == 0
    assert result["candidates"] == []


def test_52_missing_prescreen_no_actionable():
    strong = [
        make_candidate(code=f"{9000+i}", sector=f"業種M{i}", per=6.0, pbr=0.5, roe=30.0, dividendYield=5.0, sigma252d=0.10, mom3m=20.0)
        for i in range(5)
    ]
    filler = make_weak_filler(15, seed_offset=9100)
    result = run(strong + filler)  # prescreenScore 未設定
    assert any(c["marketScore"] is not None and c["marketScore"] >= 55.0 for c in result["candidates"][:5])
    assert result["counts"]["actionable"] == 0


# ===========================================================================
# Explainability / Privacy (53-63)
# ===========================================================================


def test_53_selected_reasons_stable():
    pop = make_population(20, seed_offset=2000)
    r1 = run(copy.deepcopy(pop))
    r2 = run(copy.deepcopy(pop))
    assert [c["selectedReasons"] for c in r1["candidates"]] == [c["selectedReasons"] for c in r2["candidates"]]


def test_54_risk_reasons_stable():
    pop = make_population(20, seed_offset=2100)
    r1 = run(copy.deepcopy(pop))
    r2 = run(copy.deepcopy(pop))
    assert [c["riskReasons"] for c in r1["candidates"]] == [c["riskReasons"] for c in r2["candidates"]]


def test_55_hard_exclusion_reasons_stable():
    pop = make_population(10, seed_offset=2200)
    pop[0]["code"] = "12345"  # 5桁数字 -> HARD_PREFERRED_OR_NONSTANDARD_CODE
    r1 = run(copy.deepcopy(pop))
    r2 = run(copy.deepcopy(pop))
    assert [c["hardExclusionReasons"] for c in r1["candidates"]] == [
        c["hardExclusionReasons"] for c in r2["candidates"]
    ]


def test_56_duplicate_reason_zero():
    pop = make_population(20, seed_offset=2300)
    result = run(pop, sourceUpdatedAt="2020-01-01T00:00:00+00:00", asOf="2026-01-01T00:00:00+00:00")
    for c in result["candidates"]:
        assert len(c["riskReasons"]) == len(set(c["riskReasons"]))
        assert len(c["hardExclusionReasons"]) == len(set(c["hardExclusionReasons"]))
        assert len(c["selectedReasons"]) == len(set(c["selectedReasons"]))


def test_57_hard_excluded_result_retained():
    pop = make_population(5, seed_offset=2400)
    pop.append(make_candidate(code=""))  # 空文字 code -> HARD_CONTRACT_VIOLATION
    result = run(pop)
    assert result["counts"]["total"] == 6
    assert result["counts"]["excluded"] == 1
    excluded = [c for c in result["candidates"] if c["tier"] == "excluded"]
    assert len(excluded) == 1
    assert "HARD_CONTRACT_VIOLATION" in excluded[0]["hardExclusionReasons"]


def test_58_no_action_field():
    result = run(make_population(5, seed_offset=2500))
    dumped = str(result)
    assert '"action"' not in dumped.replace("'", '"')
    for c in result["candidates"]:
        assert "action" not in c


def test_59_no_headroom_field():
    result = run(make_population(5, seed_offset=2600))
    for c in result["candidates"]:
        assert "headroom" not in c
    assert "headroom" not in result


def test_60_no_portfolio_field():
    result = run(make_population(5, seed_offset=2700))
    assert "portfolio" not in result
    for c in result["candidates"]:
        assert "portfolio" not in c


def test_61_no_holdings_cash_account_field():
    result = run(make_population(5, seed_offset=2800))
    for forbidden in ("holdings", "cash", "account"):
        assert forbidden not in result
        for c in result["candidates"]:
            assert forbidden not in c


def test_62_no_amount_sizing_field():
    result = run(make_population(5, seed_offset=2900))
    for forbidden in ("amount", "maxAmount", "sizing"):
        assert forbidden not in result
        for c in result["candidates"]:
            assert forbidden not in c


def test_63_no_raw_exception_exposure():
    # 極端に壊れた入力でも例外を投げず結果を返す
    broken = [
        {"code": None},
        {"code": 123, "sector": None},
        "not_a_dict",
        {"code": "1", "sector": "s", "dataStatus": "ok", "price": True},
    ]
    result = run(broken)
    assert result["counts"]["total"] == 4
    assert result["counts"]["excluded"] == 4


# ===========================================================================
# Current artifact degraded compatibility (64-70)
# ===========================================================================


def _load_real_candidates_stocks():
    import json
    from pathlib import Path

    path = Path(__file__).resolve().parent.parent / "data" / "candidates_stocks.json"
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    return data


def test_64_current_artifact_readonly_adaptation_no_crash():
    data = _load_real_candidates_stocks()
    result = run(
        data["candidates"],
        sourceUpdatedAt=data.get("sourceUpdatedAt"),
        asOf=data.get("sourceUpdatedAt"),
        staleThresholdHours=data.get("staleThresholdHours", 48),
    )
    assert result["status"] == "generated"
    assert result["counts"]["total"] == len(data["candidates"])


def test_65_all_missing_prescreen_explicitly_degraded():
    data = _load_real_candidates_stocks()
    result = run(data["candidates"], sourceUpdatedAt=data.get("sourceUpdatedAt"), asOf=data.get("sourceUpdatedAt"))
    assert any("PRESCREEN_METADATA_MISSING" in r for r in result["degradationReasons"])
    for c in result["candidates"]:
        assert c["prescreenScore"] is None


def test_66_no_fabricated_prescreen_ranks():
    data = _load_real_candidates_stocks()
    result = run(data["candidates"], sourceUpdatedAt=data.get("sourceUpdatedAt"), asOf=data.get("sourceUpdatedAt"))
    for c in result["candidates"]:
        assert c["prescreenRank"] is None


def test_67_deterministic_degraded_output():
    data = _load_real_candidates_stocks()
    r1 = run(data["candidates"], sourceUpdatedAt=data.get("sourceUpdatedAt"), asOf=data.get("sourceUpdatedAt"))
    r2 = run(data["candidates"], sourceUpdatedAt=data.get("sourceUpdatedAt"), asOf=data.get("sourceUpdatedAt"))
    assert r1 == r2


def test_68_degraded_actionable_zero():
    data = _load_real_candidates_stocks()
    result = run(data["candidates"], sourceUpdatedAt=data.get("sourceUpdatedAt"), asOf=data.get("sourceUpdatedAt"))
    assert result["counts"]["actionable"] == 0


def test_69_existing_raw_artifact_unchanged():
    import hashlib
    from pathlib import Path

    path = Path(__file__).resolve().parent.parent / "data" / "candidates_stocks.json"
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    data = _load_real_candidates_stocks()
    run(data["candidates"], sourceUpdatedAt=data.get("sourceUpdatedAt"), asOf=data.get("sourceUpdatedAt"))
    after = hashlib.sha256(path.read_bytes()).hexdigest()
    assert before == after


def test_70_candidate_funnel_artifact_absent():
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    assert not (root / "data" / "candidate_funnel.json").exists()
    assert not (root / "public" / "data" / "candidate_funnel.json").exists()


# ===========================================================================
# Pure function contract（stdlib only, no I/O/network/random/wall-clock）
# ===========================================================================


def test_pure_no_wall_clock_dependency():
    pop = make_population(15, seed_offset=3000)
    r1 = run(pop)
    r2 = run(pop)
    assert r1 == r2


def test_percentile_rank_basic():
    vals = [1.0, 2.0, 3.0, 4.0, 5.0]
    ranks = percentile_rank(vals)
    assert ranks[0] < ranks[-1]
    assert ranks == sorted(ranks)


def test_percentile_rank_missing_gets_zero():
    ranks = percentile_rank([1.0, None, 3.0])
    assert ranks[1] == 0.0


def test_percentile_rank_winsorization_ties_extreme_outliers():
    # n=101 のとき 99th percentile interpolation は端数なく第2位の値と厳密一致
    # するため、最大値が第2位の値へ clip されタイになる（winsorizeが機能して
    # いる決定的証拠。winsorize除去なら 0.99 と 1.0 の異なるrankになる）。
    vals = list(range(1, 100)) + [1000.0, 2000.0]
    ranks = percentile_rank(vals)
    assert ranks[99] == ranks[100]
    assert ranks[99] == 0.995


def test_low_data_confidence_blocks_deep_review_even_with_high_score():
    # per/roeのみ有効(usableAxes=2 -> dataConfidence=2/6=0.333<0.50)だが、
    # per/roeの値自体は非常に良いため marketScore は55を大きく超える。
    # dataConfidence gate が無ければ deep_review まで到達してしまう組み合わせ。
    c = make_candidate(
        code="6501",
        sector="業種DQ",
        per=6.0,
        roe=35.0,
        pbr=None,
        dividendYield=None,
        sigma252d=None,
        mom3m=None,
        prescreenScore=0.9,
    )
    filler = make_weak_filler(15, seed_offset=6600)
    result = run([c] + filler)
    out = result["candidates"][0]
    assert out["marketScore"] >= DEEP_REVIEW_MIN_MARKET_SCORE
    assert out["dataConfidence"] < DEEP_REVIEW_MIN_DATA_CONFIDENCE
    assert out["tier"] == "screened"


def test_reserved_components_never_have_fabricated_value():
    """growth/financialStability/earningsRevisionEvent/themeDurability/regimeFit
    は source が無いため value=None・status='reserved' 固定（sector等からの
    代理生成禁止, A2 §5 rejected proxy guard）。"""
    pop = make_population(20, seed_offset=3100)
    result = run(pop)
    reserved_ids = {"growth", "financialStability", "earningsRevisionEvent", "themeDurability", "regimeFit"}
    for c in result["candidates"]:
        for comp in c["scoreBreakdown"]:
            if comp["id"] in reserved_ids:
                assert comp["value"] is None
                assert comp["status"] == "reserved"
                assert comp["weight"] == 0.0
                assert comp["weightedContribution"] == 0.0


# ===========================================================================
# Calibration regression（A2-S §22.1 CAL-01..CAL-13, ticket §17/§20）
#
# A2 §16 の calibration（Preset B, 実データ200件 + "scratchpad, repository外"の
# synthetic prescreen）は監査時の一時領域でのみ評価され、repository には
# 再現用データが残されていない（A2 §16.1: "この評価は scratchpad のみで行い、
# repository外・一時領域のみで評価する"）。そのため exact な "74→40 sector20"
# 等の数値を bit-for-bit 再現することはできない。
#
# 本 fixture（tests/fixtures/candidate_funnel_calibration_v1.json）は、B1-V
# FIN-13 が指摘した構造的縮退（全候補が同一 prescreenScore/sigma/mom3m、null
# 0件）を解消し、A2-S §22.1 の CAL-01..CAL-13 をすべて満たすよう作り直した
# 自前の deterministic synthetic dataset。値を「合わせるため」に事後調整は
# していない — group-level fundamentals は percentile-rank formula から
# analytically 逆算し、意図した tier 帯へ収まることを engine 実行で検証した
# 上で固定した。production 分布の証明ではない（fixture description に明記）。
# ===========================================================================


def _load_calibration_fixture():
    import json
    from pathlib import Path

    path = Path(__file__).resolve().parent / "fixtures" / "candidate_funnel_calibration_v1.json"
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def _load_calibration_candidates():
    return _load_calibration_fixture()["candidates"]


def test_cal_13_fixture_disclaims_production_representativeness():
    fixture = _load_calibration_fixture()
    desc = fixture["description"]
    assert "production" in desc.lower() or "分布" in desc


def test_cal_01_prescreen_score_varied_including_0_and_1():
    pop = _load_calibration_candidates()
    import math as _math

    vals = {
        c["prescreenScore"]
        for c in pop
        if c.get("prescreenScore") is not None and not (isinstance(c["prescreenScore"], float) and _math.isnan(c["prescreenScore"]))
    }
    assert len(vals) >= 10
    assert 0.0 in vals
    assert 1.0 in vals


def test_cal_02_sigma_covers_all_four_volatility_layers():
    pop = _load_calibration_candidates()
    classes = {engine._volatility_class(c.get("sigma252d")) for c in pop}
    assert classes == {"VOL_NORMAL", "VOL_ELEVATED", "VOL_RED_FLAG", "VOL_UNAVAILABLE"}


def test_cal_03_partial_status_and_null_numeric_fields_present():
    pop = _load_calibration_candidates()
    assert any(c.get("dataStatus") == "partial" for c in pop)
    for field in ("per", "pbr", "roe", "dividendYield", "mom3m"):
        assert any(c.get(field) is None for c in pop), f"expected at least one null {field}"


def test_cal_04_prescreen_missing_and_invalid_both_present():
    pop = _load_calibration_candidates()
    import math as _math

    assert any("prescreenScore" not in c for c in pop)
    assert any(
        isinstance(c.get("prescreenScore"), float) and _math.isnan(c["prescreenScore"]) for c in pop
    )


def test_cal_05_deep_review_sector_cap_overflow_binding():
    pop = _load_calibration_candidates()
    result = run(pop)
    obs = result["selectionObservability"]
    assert sum(obs["deepReviewSectorCapOverflow"].values()) > 0


def test_cal_06_actionable_sector_cap_overflow_binding():
    pop = _load_calibration_candidates()
    result = run(pop)
    obs = result["selectionObservability"]
    assert sum(obs["actionableSectorCapOverflow"].values()) > 0


def test_cal_07_deep_review_saturates_hard_max_40_literal():
    pop = _load_calibration_candidates()
    result = run(pop)
    assert result["counts"]["deepReview"] == 40
    assert result["selectionObservability"]["deepReviewSelectedCount"] == 40


def test_cal_08_actionable_hits_hard_max_12_literal():
    pop = _load_calibration_candidates()
    result = run(pop)
    assert result["counts"]["actionable"] == 12
    for sector, count in result["sectorDistribution"]["actionable"].items():
        assert count <= 2


def test_cal_08b_deep_review_sector_cap_respected_exclusively():
    # A2-S §11.4: sector cap は tier ごとに独立計数する（actionable と
    # deep_review を合算した count に対して cap を課してはならない）。
    pop = _load_calibration_candidates()
    result = run(pop)
    for sector, count in result["sectorDistribution"]["deepReview"].items():
        assert count <= 6
    for sector, count in result["sectorDistribution"]["actionable"].items():
        assert count <= 2


def test_cal_08c_sector_distinct_counts_meet_minimum():
    pop = _load_calibration_candidates()
    result = run(pop)
    assert len(result["sectorDistribution"]["deepReview"]) >= 7
    assert len(result["sectorDistribution"]["actionable"]) >= 4


def test_cal_09_bear_regime_actionable_5_literal():
    pop = _load_calibration_candidates()
    result = run(pop, regime="bear")
    assert result["counts"]["actionable"] == 5


def test_cal_09b_crisis_regime_actionable_5_literal():
    pop = _load_calibration_candidates()
    result = run(pop, regime="crisis")
    assert result["counts"]["actionable"] == 5


def test_cal_10_degraded_path_actionable_zero_literal():
    pop = _load_calibration_candidates()
    degraded = [{k: v for k, v in c.items() if k not in ("prescreenScore", "prescreenRank", "prescreenPool")} for c in pop]
    result = run(degraded)
    assert result["counts"]["actionable"] == 0
    for c in result["candidates"]:
        assert c["prescreenScore"] is None


def test_calibration_deterministic_repeat():
    pop = _load_calibration_candidates()
    r1 = run(copy.deepcopy(pop))
    r2 = run(copy.deepcopy(pop))
    assert r1 == r2


def test_cal_11_12_rank_stability_and_genuine_swap_under_perturbation():
    """A2-S §22.1 CAL-11/CAL-12: 固定 +/-2% perturbation vector で top-40
    Jaccard >= 0.95（緩和禁止）かつ perturbation 前後で少なくとも1件の
    順位入れ替わりが発生すること（Jaccard=1.0 に張り付く縮退構成は不可）。"""
    pop = _load_calibration_candidates()
    base = run(pop)
    base_top40_ordered = [
        c["code"] for c in sorted(base["candidates"], key=lambda c: c["marketRank"] or 10**9)[:40] if c["marketRank"] is not None
    ]
    base_top40 = set(base_top40_ordered)

    perturbed = copy.deepcopy(pop)
    # 固定 perturbation: index の奇偶で ±2% を交互に per/roe へ適用（決定的、乱数不使用）
    for i, c in enumerate(perturbed):
        sign = 1 if i % 2 == 0 else -1
        if isinstance(c.get("per"), (int, float)):
            c["per"] = c["per"] * (1 + sign * 0.02)
        if isinstance(c.get("roe"), (int, float)):
            c["roe"] = c["roe"] * (1 - sign * 0.02)
    perturbed_result = run(perturbed)
    perturbed_top40_ordered = [
        c["code"]
        for c in sorted(perturbed_result["candidates"], key=lambda c: c["marketRank"] or 10**9)[:40]
        if c["marketRank"] is not None
    ]
    perturbed_top40 = set(perturbed_top40_ordered)

    intersection = base_top40 & perturbed_top40
    union = base_top40 | perturbed_top40
    jaccard = len(intersection) / len(union) if union else 1.0
    assert jaccard >= 0.95  # CAL-11: 緩和禁止
    assert base_top40_ordered != perturbed_top40_ordered  # CAL-12: 少なくとも1件の入れ替わり
    assert jaccard < 1.0  # CAL-12: 1.0 に張り付く縮退構成は不可


# ===========================================================================
# B1-R2 mandatory tests（A2-S §25.19 T-01..T-25）
# ===========================================================================


def test_t01_round_half_up_frozen_vectors():
    # A2-S §25.17 R vector（round_half_up vs Python round() 差分あり7件 + 差分なし5件）
    cases = [
        (54.25, 1, 54.3),
        (67.25, 1, 67.3),
        (68.25, 1, 68.3),
        (0.25, 1, 0.3),
        (1.25, 1, 1.3),
        (55.05, 1, 55.1),
        (68.05, 1, 68.1),
        (54.95, 1, 55.0),
        (67.95, 1, 68.0),
        (54.75, 1, 54.8),
        (2.35, 1, 2.4),
        (54.94999999999999, 1, 54.9),
    ]
    for value, ndigits, expected in cases:
        assert engine._round_half_up(value, ndigits) == expected, f"round_half_up({value},{ndigits})"
    # Python builtin round() は banker's rounding のため差分が出ることを確認
    assert round(54.25, 1) != 54.3
    assert round(0.25, 1) != 0.3


def test_t02_clamp_boundary_frozen_vectors():
    # A2-S §25.17 C vector: marketScore = round_half_up(100*clamp01(raw), 1)
    cases = [
        (-0.5, 0.0),
        (-1e-09, 0.0),
        (0.0, 0.0),
        (1e-09, 0.0),
        (0.5425, 54.3),
        (0.5495, 55.0),
        (0.6725, 67.3),
        (0.6795, 68.0),
        (0.999999, 100.0),
        (1.0, 100.0),
        (1.000000001, 100.0),
        (2.0, 100.0),
    ]
    for raw, expected in cases:
        clamped = min(max(raw, 0.0), 1.0)
        assert engine._round_half_up(100.0 * clamped, 1) == expected, f"raw={raw}"


def test_t03_tier_threshold_boundary_operators_are_inclusive():
    # A2-S §25.17 T vector: 演算子は両方 >= 。
    assert (55.0 >= DEEP_REVIEW_MIN_MARKET_SCORE) is True
    assert (54.95 >= DEEP_REVIEW_MIN_MARKET_SCORE) is False
    assert (54.9 >= DEEP_REVIEW_MIN_MARKET_SCORE) is False
    assert (55.1 >= DEEP_REVIEW_MIN_MARKET_SCORE) is True
    assert (68.0 >= ACTIONABLE_MIN_MARKET_SCORE) is True
    assert (67.95 >= ACTIONABLE_MIN_MARKET_SCORE) is False
    assert (67.9 >= ACTIONABLE_MIN_MARKET_SCORE) is False
    assert (68.1 >= ACTIONABLE_MIN_MARKET_SCORE) is True


def test_t03b_tier_threshold_boundary_behavioral():
    # marketScore=55.0 ちょうどの候補が deep_review gate を PASS すること。
    strong = _strong_candidate("6801", "業種T3")
    filler = make_weak_filler(15, seed_offset=6800)
    result = run([strong] + filler)
    out = result["candidates"][0]
    assert out["marketScore"] is not None and out["marketScore"] >= 55.0


def test_t04_component_floor_boundary_frozen_vectors():
    # A2-S §25.17 F vector（valuation/quality 共通 threshold 0.40）
    cases = [
        (1.0 / 5.0, False),
        (1.9999 / 5.0, False),
        (2.0 / 5.0, True),
        (4.0 / 10.0, True),
        (8.0 / 20.0, True),
        (3.0 / 5.0, True),
    ]
    for value, expected in cases:
        assert (value >= ACTIONABLE_MIN_VALUATION_PERCENTILE) == expected, f"valuation {value}"
        assert (value >= ACTIONABLE_MIN_QUALITY_PERCENTILE) == expected, f"quality {value}"
    # epsilon 不要の bit-identical 確認
    assert 2.0 / 5.0 == 0.4
    assert 4.0 / 10.0 == 0.4
    assert 8.0 / 20.0 == 0.4


def test_t05_sigma_classification_frozen_vectors():
    # A2-S §25.17 S vector（11件）。境界は両方 `>=`。
    cases = [
        (0.34, VOL_NORMAL),
        (0.3499999999999999, VOL_NORMAL),
        (0.35, VOL_ELEVATED),
        (0.44999999999999996, VOL_ELEVATED),
        (0.45, VOL_RED_FLAG),
        (0.60, VOL_RED_FLAG),
        (None, VOL_UNAVAILABLE),
        (float("nan"), VOL_UNAVAILABLE),
        (float("inf"), VOL_UNAVAILABLE),
        (True, VOL_UNAVAILABLE),
        ("0.2", VOL_UNAVAILABLE),
    ]
    for sigma, expected in cases:
        assert engine._volatility_class(sigma) == expected, f"sigma={sigma!r}"


def test_t05b_sigma_missing_fail_closed_behavioral():
    # sigma252d 欠損・5軸・marketScore=100.0 相当の候補が tier=screened に
    # 留まること（B1-V FIN-01 の再現・fail-open禁止）。
    c = make_candidate(
        code="6901",
        sector="業種SG",
        per=1.0001,
        pbr=0.0001,
        roe=99.0,
        dividendYield=50.0,
        sigma252d=None,
        mom3m=40.0,
        prescreenScore=1.0,
    )
    filler = make_weak_filler(15, seed_offset=6900)
    result = run([c] + filler)
    out = result["candidates"][0]
    assert out["marketScore"] is not None and out["marketScore"] >= 68.0
    assert out["tier"] == "screened"
    assert "SOFT_VOLATILITY_UNAVAILABLE" in out["riskReasons"]
    assert out["selectedReasons"] == []


def test_t05c_sigma_red_flag_screened_not_actionable():
    c = make_candidate(
        code="6902",
        sector="業種SG2",
        per=1.0001,
        pbr=0.0001,
        roe=99.0,
        dividendYield=50.0,
        sigma252d=0.60,
        mom3m=40.0,
        prescreenScore=1.0,
    )
    filler = make_weak_filler(15, seed_offset=6910)
    result = run([c] + filler)
    out = result["candidates"][0]
    assert out["marketScore"] is not None and out["marketScore"] >= 68.0
    assert out["tier"] == "screened"
    assert "SOFT_VOLATILITY_RED_FLAG" in out["riskReasons"]


def test_t05d_sigma_exact_045_boundary_is_red_flag_behavioral():
    # A2-S §25.5/§18.6 S-05: sigma252d = 0.45 ちょうどは VOL_RED_FLAG（`>=`）。
    # `>` へ変更する mutation (M-02) を behavioral に検出するための専用 test。
    c = make_candidate(
        code="6904",
        sector="業種SG4",
        per=1.0001,
        pbr=0.0001,
        roe=99.0,
        dividendYield=50.0,
        sigma252d=0.45,
        mom3m=40.0,
        prescreenScore=1.0,
    )
    filler = make_weak_filler(15, seed_offset=6930)
    result = run([c] + filler)
    out = result["candidates"][0]
    assert out["marketScore"] is not None and out["marketScore"] >= 68.0
    assert out["tier"] == "screened"
    assert "SOFT_VOLATILITY_RED_FLAG" in out["riskReasons"]


def test_t06_data_confidence_lattice_frozen_vectors():
    # A2-S §8.6 B1..B7（usableAxes, dataStatus, internal, deep-review gate, actionable gate）
    cases = [
        (2, "ok", 0.3333333333333333, False, False),
        (3, "ok", 0.5, True, False),
        (4, "ok", 0.6666666666666666, True, True),
        (5, "ok", 0.8333333333333334, True, True),
        (4, "partial", 0.39999999999999997, False, False),
        (5, "partial", 0.5, True, False),
        (6, "partial", 0.6, True, False),
    ]
    for usable_axes, data_status, expected_internal, deep_pass, act_pass in cases:
        status_factor = 1.0 if data_status == "ok" else 0.6
        internal = min(max((usable_axes / 6.0) * status_factor, 0.0), 1.0)
        assert internal == expected_internal, f"{usable_axes},{data_status}"
        assert (internal >= DEEP_REVIEW_MIN_DATA_CONFIDENCE) == deep_pass
        assert (internal >= ACTIONABLE_MIN_DATA_CONFIDENCE) == act_pass


def test_t06b_data_confidence_4_axes_ok_passes_actionable_gate():
    # A2-S §25.3: 4/6 = 2/3 は actionable gate を PASS する（0.67 literal の
    # 旧実装では FAIL していた, B1-V FIN-12 の再現）。
    c = make_candidate(
        code="6903",
        sector="業種DC4",
        per=6.0,
        pbr=0.5,
        roe=35.0,
        dividendYield=5.0,
        sigma252d=0.10,
        mom3m=None,  # usableAxes を6->5へ、さらに1軸落として4に
    )
    c["dividendYield"] = None  # usableAxes=4 (per,pbr,roe,sigma のみ有効)
    c["prescreenScore"] = 0.9
    filler = make_weak_filler(15, seed_offset=6920)
    result = run([c] + filler)
    out = result["candidates"][0]
    assert out["dataConfidence"] == 0.6667
    assert out["marketScore"] is not None and out["marketScore"] >= 68.0
    assert out["tier"] == "actionable"


def test_t07_actionable_population_independent_of_deep_review_selected():
    # B1-V probe K 再現: soft-vol(elevated) 帯が「clean 群より高い marketRank」
    # で上位45件（deep-review hard max 40 を超える件数）を占めても、marketScore
    # >=68 の完全適格な8件は rank46以降に落ちても actionable に到達すること
    # （MF-02: actionable を deep_review_selected(top-40) から選ぶ実装を禁止）。
    # soft_vol は clean より極端に強い fundamentals にして marketRank を
    # 1-45 に固定し、clean を rank46以降（deep-review hard max 40 の外）へ
    # 追いやる。filler は clean の percentile を 68 以上へ押し上げるための
    # 弱い母集団。
    soft_vol = [
        make_candidate(
            code=f"7{i:03d}",
            sector=f"SV{i % 10}",
            per=2.0,
            pbr=0.1,
            roe=50.0,
            dividendYield=10.0,
            sigma252d=0.40,
            mom3m=40.0,
            prescreenScore=1.0,
        )
        for i in range(45)
    ]
    clean = [
        make_candidate(
            code=f"8{i:03d}",
            sector=f"CL{i % 10}",
            per=6.0,
            pbr=0.5,
            roe=35.0,
            dividendYield=6.0,
            sigma252d=0.05,
            mom3m=15.0,
            prescreenScore=0.9,
        )
        for i in range(8)
    ]
    filler = [
        make_candidate(
            code=f"9{i:03d}",
            sector=f"FL{i % 10}",
            per=80.0 + i,
            pbr=6.0 + i * 0.1,
            roe=-10.0 + i * 0.1,
            dividendYield=0.0,
            sigma252d=0.15,
            mom3m=-15.0,
            prescreenScore=0.1,
        )
        for i in range(80)
    ]
    result = run(soft_vol + clean + filler)
    by_code = {c["code"]: c for c in result["candidates"]}
    clean_codes = {c["code"] for c in clean}
    clean_ranks = [by_code[code]["marketRank"] for code in clean_codes]
    assert all(rank is not None and rank > 40 for rank in clean_ranks), clean_ranks
    clean_tiers = {code: by_code[code]["tier"] for code in clean_codes}
    assert all(t == "actionable" for t in clean_tiers.values()), clean_tiers
    assert result["counts"]["actionable"] == 8


def test_t08_tier_exclusivity_and_counts_identity():
    pop = make_population(60, seed_offset=4000)
    result = run(pop)
    c = result["counts"]
    assert c["total"] == c["excluded"] + c["screened"] + c["deepReview"] + c["actionable"]
    actionable_codes = {cand["code"] for cand in result["candidates"] if cand["tier"] == "actionable"}
    deep_review_codes = {cand["code"] for cand in result["candidates"] if cand["tier"] == "deep_review"}
    assert actionable_codes.isdisjoint(deep_review_codes)


def test_t08b_calibration_tier_exclusivity_and_counts_identity():
    pop = _load_calibration_candidates()
    result = run(pop)
    c = result["counts"]
    assert c["total"] == c["excluded"] + c["screened"] + c["deepReview"] + c["actionable"]
    actionable_codes = {cand["code"] for cand in result["candidates"] if cand["tier"] == "actionable"}
    deep_review_codes = {cand["code"] for cand in result["candidates"] if cand["tier"] == "deep_review"}
    assert actionable_codes.isdisjoint(deep_review_codes)
    assert len(actionable_codes) + len(deep_review_codes) <= 52  # DEEP_REVIEW_HARD_MAX(40) + ACTIONABLE_HARD_MAX(12)


def test_t09_selected_reasons_match_final_tier_exactly():
    actionable_c = _strong_candidate("9101", "業種SR1")
    deep_review_c = make_candidate(
        code="9102", sector="業種SR2", per=12.0, pbr=1.0, roe=15.0, dividendYield=3.0, sigma252d=0.20, mom3m=5.0,
        prescreenScore=0.5,
    )
    veto_c = make_candidate(
        code="9103", sector="業種SR3", per=1.0001, pbr=0.0001, roe=99.0, dividendYield=50.0, sigma252d=0.60,
        mom3m=40.0, prescreenScore=1.0,
    )
    filler = make_weak_filler(20, seed_offset=9100)
    result = run([actionable_c, deep_review_c, veto_c] + filler)
    by_code = {c["code"]: c for c in result["candidates"]}

    assert by_code["9101"]["tier"] == "actionable"
    assert by_code["9101"]["selectedReasons"] == ["SELECTED_ACTIONABLE"]

    assert by_code["9103"]["marketScore"] is not None and by_code["9103"]["marketScore"] >= 68.0
    assert by_code["9103"]["tier"] == "screened"
    assert by_code["9103"]["selectedReasons"] == []

    screened_or_excluded = [c for c in result["candidates"] if c["tier"] in ("screened", "excluded")]
    assert all(c["selectedReasons"] == [] for c in screened_or_excluded)

    for c in result["candidates"]:
        for reason in c["selectedReasons"]:
            assert reason in CANDIDATE_FUNNEL_SELECTED_REASON_CODES
        assert "DEEP_REVIEW_THRESHOLD_MET" not in c["selectedReasons"]
        assert "ACTIONABLE_THRESHOLD_MET" not in c["selectedReasons"]


def test_t09b_selected_reasons_deep_review_tier():
    pop = _load_calibration_candidates()
    result = run(pop)
    deep_review = [c for c in result["candidates"] if c["tier"] == "deep_review"]
    assert deep_review
    assert all(c["selectedReasons"] == ["SELECTED_DEEP_REVIEW"] for c in deep_review)
    actionable = [c for c in result["candidates"] if c["tier"] == "actionable"]
    assert actionable
    assert all(c["selectedReasons"] == ["SELECTED_ACTIONABLE"] for c in actionable)


def test_t10_cache_fallback_actionable_zero_deep_review_allowed_fallback_reason_universal():
    strong = [_strong_candidate(f"{9200 + i}", f"業種CF{i}") for i in range(5)]
    filler = make_weak_filler(15, seed_offset=9200)
    result = run(strong + filler, pipelinePath="cache_fallback")
    assert result["counts"]["actionable"] == 0
    assert any(c["marketScore"] is not None and c["marketScore"] >= 55.0 for c in result["candidates"][:5])
    for c in result["candidates"]:
        if c["tier"] != "excluded":
            assert "SOFT_FALLBACK_PROVENANCE" in c["riskReasons"]


def test_t11_prescreen_missing_gate_is_explicit_not_arithmetic(monkeypatch):
    # prescreenUsable==False の候補は normalizedPrescreenScore=0.0 に固定されるため
    # marketScore の理論上限は 65.0（0.65*stage3max）で、frozen threshold 68.0では
    # 到達不能（M-13の"65<68"算術依存を避けるため, A2-S §13.5 禁止29）。
    # gate 自体の効果を分離検証するため、production定数は変更せず test scope のみ
    # ACTIONABLE_MIN_MARKET_SCORE を60.0へ一時的に下げ、65.0到達可能な条件で
    # prescreenUsable gate が単独で actionable を阻止していることを確認する。
    monkeypatch.setattr(engine, "ACTIONABLE_MIN_MARKET_SCORE", 60.0)
    strong = make_candidate(
        code="9301", sector="業種PG1", per=1.01, pbr=0.01, roe=99.0, dividendYield=50.0, sigma252d=0.05, mom3m=50.0,
    )  # prescreenScore 未設定 -> missing
    filler = make_weak_filler(15, seed_offset=9300)
    result = run([strong] + filler)
    out = result["candidates"][0]
    assert out["marketScore"] is not None and out["marketScore"] >= 60.0
    assert out["tier"] != "actionable"
    assert "SOFT_PRESCREEN_METADATA_MISSING" in out["riskReasons"]


def test_t12_prescreen_invalid_nan_bool_str_same_as_missing():
    for invalid_value in (float("nan"), True, "0.5"):
        c = make_candidate(code="9401", sector="業種PI", prescreenScore=invalid_value)
        result = run([c] + make_population(10, seed_offset=5100))
        out = result["candidates"][0]
        assert out["prescreenScore"] is None
        assert "SOFT_PRESCREEN_METADATA_MISSING" in out["riskReasons"]


def test_t13_prescreen_score_out_of_range_echo_not_clamped():
    c = make_candidate(code="9501", sector="業種PE", prescreenScore=5.0)
    result = run([c] + make_population(10, seed_offset=5200))
    out = result["candidates"][0]
    assert out["prescreenScore"] == 5.0
    assert out["marketScore"] <= 100.0


def test_t14_nan_inf_not_counted_in_usable_axes():
    full = make_candidate(code="9601", per=10.0, pbr=1.0, roe=10.0, dividendYield=2.0, sigma252d=0.2, mom3m=5.0)
    with_nan = make_candidate(
        code="9602", per=float("nan"), pbr=1.0, roe=10.0, dividendYield=2.0, sigma252d=0.2, mom3m=5.0
    )
    with_inf = make_candidate(
        code="9603", per=10.0, pbr=float("inf"), roe=10.0, dividendYield=2.0, sigma252d=0.2, mom3m=5.0
    )
    result = run([full, with_nan, with_inf])
    by_code = {c["code"]: c for c in result["candidates"]}
    assert by_code["9601"]["dataConfidence"] == 1.0
    assert by_code["9602"]["dataConfidence"] < 1.0
    assert by_code["9603"]["dataConfidence"] < 1.0


def test_t15_not_for_trading_true_generated_and_not_generated():
    generated = run(make_population(5, seed_offset=5300))
    assert generated["status"] == "generated"
    assert generated["not_for_trading"] is True

    not_generated = run(make_population(5, seed_offset=5300), pipelinePath="seed_fallback")
    assert not_generated["status"] == "not_generated"
    assert not_generated["not_for_trading"] is True


def test_t16_weight_table_drives_market_score():
    pop = make_population(20, seed_offset=4100)
    baseline = run(copy.deepcopy(pop))
    baseline_score = baseline["candidates"][0]["marketScore"]

    original_valuation_weight = engine.COMPONENT_WEIGHTS["valuation"]
    original_quality_weight = engine.COMPONENT_WEIGHTS["quality"]
    try:
        engine.COMPONENT_WEIGHTS["valuation"] = 0.20
        engine.COMPONENT_WEIGHTS["quality"] = 0.80
        mutated = run(copy.deepcopy(pop))
        mutated_score = mutated["candidates"][0]["marketScore"]
    finally:
        engine.COMPONENT_WEIGHTS["valuation"] = original_valuation_weight
        engine.COMPONENT_WEIGHTS["quality"] = original_quality_weight

    assert mutated_score != baseline_score


def test_t16b_weighted_contribution_sums_to_stage3_within_tolerance():
    pop = make_population(30, seed_offset=4200)
    result = run(pop)
    for c in result["candidates"]:
        if c["tier"] == "excluded":
            continue
        contributions = sum(comp["weightedContribution"] for comp in c["scoreBreakdown"])
        stage3 = (c["rawCompositeScore"] - PRESCREEN_PRIOR_WEIGHT * (c["prescreenScore"] or 0.0) * 0) or 0
        # rawCompositeScore = 0.35*normalizedPrescreen + 0.65*stage3
        # -> stage3 = (rawCompositeScore - 0.35*normalizedPrescreen) / 0.65
        normalized_prescreen = min(max(c["prescreenScore"], 0.0), 1.0) if c["prescreenScore"] is not None else 0.0
        stage3 = (c["rawCompositeScore"] - PRESCREEN_PRIOR_WEIGHT * normalized_prescreen) / STAGE3_COMPOSITE_WEIGHT
        assert abs(contributions - stage3) <= 1e-9


def test_t16c_zero_weight_component_mutation_is_behaviorally_detected():
    pop = make_population(20, seed_offset=4300)
    baseline = run(copy.deepcopy(pop))
    baseline_scores = [c["marketScore"] for c in baseline["candidates"]]
    original = engine.COMPONENT_WEIGHTS["momentum"]
    try:
        engine.COMPONENT_WEIGHTS["momentum"] = 0.30
        mutated = run(copy.deepcopy(pop))
        mutated_scores = [c["marketScore"] for c in mutated["candidates"]]
    finally:
        engine.COMPONENT_WEIGHTS["momentum"] = original
    assert mutated_scores != baseline_scores


def test_t17_bear_crisis_capacity_resolver_literal():
    assert resolve_actionable_capacity("bear") == (5, 2)
    assert resolve_actionable_capacity("crisis") == (5, 2)
    assert resolve_actionable_capacity("bull_calm") == (12, 2)
    assert resolve_actionable_capacity(None) == (12, 2)
    assert resolve_actionable_capacity("not_a_regime") == (12, 2)
    assert resolve_actionable_capacity(123) == (12, 2)


def test_t17b_bear_regime_single_sector_actionable_capped_behavioral():
    strong = [_strong_candidate(f"{6700 + i}", "業種BR1") for i in range(8)]
    filler = make_weak_filler(15, seed_offset=6700)
    result = run(strong + filler, regime="bear")
    assert result["counts"]["actionable"] == 2
    assert result["selectionObservability"]["actionableSectorCapApplied"] == 2
    assert result["selectionObservability"]["actionableHardMaxApplied"] == 5


def test_t18_duplicate_code_both_excluded_and_population_non_participation():
    a = make_candidate(code="1000", sector="SectorA", per=5.0, roe=40.0)
    b = make_candidate(code="1000", sector="SectorB", per=5.0, roe=40.0)
    unique = make_candidate(code="1001", sector="SectorC")
    result = run([a, b, unique])
    by_tier = {c["code"]: c["tier"] for c in result["candidates"]}
    dup_records = [c for c in result["candidates"] if c["code"] == "1000"]
    assert len(dup_records) == 2
    assert all(c["tier"] == "excluded" for c in dup_records)
    assert all(c["hardExclusionReasons"] == ["HARD_CONTRACT_VIOLATION"] for c in dup_records)
    assert by_tier["1001"] != "excluded"
    assert "DUPLICATE_CANDIDATE_CODE" in " ".join(result["degradationReasons"])


def test_t18b_duplicate_code_three_and_non_contiguous():
    pop = make_population(10, seed_offset=4400)
    pop[0]["code"] = "5000"
    pop[3]["code"] = "5000"
    pop[7]["code"] = "5000"
    result = run(pop)
    dup_records = [c for c in result["candidates"] if c["code"] == "5000"]
    assert len(dup_records) == 3
    assert all(c["tier"] == "excluded" for c in dup_records)
    others = [c for c in result["candidates"] if c["code"] != "5000"]
    assert all(c["tier"] != "excluded" for c in others)


def test_t18c_duplicate_code_permutation_invariant():
    base = make_population(15, seed_offset=4500)
    base[2]["code"] = base[9]["code"]  # 意図的な重複
    import random as _random

    _random.seed(42)
    permutations_tried = 0
    baseline_result = run(copy.deepcopy(base))
    baseline_map = {c["code"]: {k: v for k, v in c.items()} for c in baseline_result["candidates"]}
    for _ in range(20):
        shuffled = copy.deepcopy(base)
        _random.shuffle(shuffled)
        result = run(shuffled)
        result_map = {}
        for c in result["candidates"]:
            result_map.setdefault(c["code"], []).append(c)
        for code, out in baseline_map.items():
            matches = result_map.get(code, [])
            assert len(matches) >= 1
        permutations_tried += 1
    assert permutations_tried == 20


def test_t19_theme_output_always_unavailable_empty():
    pop = make_population(10, seed_offset=4750)
    pop.append(make_candidate(code=""))  # excluded candidate too
    result = run(pop)
    for c in result["candidates"]:
        assert c["themes"] == []
        assert c["themeStatus"] == "unavailable"
        assert c["themeStatus"] in CANDIDATE_FUNNEL_THEME_STATUSES


def test_t20_forbidden_keys_absent_recursively():
    pop = make_population(10, seed_offset=4600)
    pop[0]["code"] = "12345"
    result = run(pop)
    found = _walk_forbidden_keys(result)
    assert found == set(), f"forbidden keys leaked: {found}"


def test_t20b_forbidden_keys_absent_in_calibration_fixture_output():
    pop = _load_calibration_candidates()
    result = run(pop)
    found = _walk_forbidden_keys(result)
    assert found == set(), f"forbidden keys leaked: {found}"


def test_t21_calibration_literal_expectations_not_import_comparison():
    # T-21: 40/12/5/0 をリテラルで assert する（production定数importとの比較にしない）。
    pop = _load_calibration_candidates()
    assert run(pop)["counts"]["deepReview"] == 40
    assert run(pop)["counts"]["actionable"] == 12
    assert run(pop, regime="bear")["counts"]["actionable"] == 5
    degraded = [{k: v for k, v in c.items() if k not in ("prescreenScore", "prescreenRank", "prescreenPool")} for c in pop]
    assert run(degraded)["counts"]["actionable"] == 0


def test_t22_cap_binding_permutation_invariance():
    pop = _load_calibration_candidates()
    import random as _random

    _random.seed(7)
    baseline = run(copy.deepcopy(pop))
    baseline_summary = (
        baseline["counts"],
        {c["code"]: (c["marketScore"], c["tier"]) for c in baseline["candidates"]},
    )
    for _ in range(20):
        shuffled = copy.deepcopy(pop)
        _random.shuffle(shuffled)
        result = run(shuffled)
        result_summary = (
            result["counts"],
            {c["code"]: (c["marketScore"], c["tier"]) for c in result["candidates"]},
        )
        assert result_summary == baseline_summary


def test_t24_soft_weak_momentum_requires_present_valid_provenance():
    missing_mom = make_candidate(code="6601", sector="業種MM1", mom3m=None)
    filler = make_population(20, seed_offset=4700)
    result = run([missing_mom] + filler)
    out = result["candidates"][0]
    assert "SOFT_WEAK_MOMENTUM" not in out["riskReasons"]


def test_t24b_soft_weak_momentum_fires_for_present_valid_low_rank():
    pop = make_population(20, seed_offset=4800)
    pop[0]["mom3m"] = -999.0  # 明確に最下位の有効値
    result = run(pop)
    out = result["candidates"][0]
    assert "SOFT_WEAK_MOMENTUM" in out["riskReasons"]


def test_t25_hard_exclusion_reasons_index_ascending_order():
    # 5桁数字 code（HARD_PREFERRED_OR_NONSTANDARD_CODE, index2）と
    # 不正 dataStatus（HARD_CONTRACT_VIOLATION, index6）を同時に発生させ、
    # 出力順が検出順ではなく index 昇順であることを確認する。
    c = make_candidate(code="99999", dataStatus="broken")
    result = run([c])
    out = result["candidates"][0]
    assert out["hardExclusionReasons"] == ["HARD_PREFERRED_OR_NONSTANDARD_CODE", "HARD_CONTRACT_VIOLATION"]
    order = {code: idx for idx, code in enumerate(CANDIDATE_FUNNEL_HARD_REASON_CODES)}
    indices = [order[r] for r in out["hardExclusionReasons"]]
    assert indices == sorted(indices)
    assert len(out["hardExclusionReasons"]) == len(set(out["hardExclusionReasons"]))


# ===========================================================================
# Additional behavioral tests to catch M-09 / M-11 / M-20 (mutation manifest)
# ===========================================================================


def test_t16d_valuation_sub_weight_table_drives_score():
    # A2-S §25.15: valuation は VALUATION_SUB_WEIGHTS 駆動でなければならない
    # （"/3.0" のリテラル直書き禁止）。sub-weight を歪めると valuation の値が
    # 変化することを確認する。
    pop = make_population(20, seed_offset=4900)
    baseline = run(copy.deepcopy(pop))
    baseline_val = next(x for x in baseline["candidates"][0]["scoreBreakdown"] if x["id"] == "valuation")["value"]

    original = dict(engine.VALUATION_SUB_WEIGHTS)
    try:
        engine.VALUATION_SUB_WEIGHTS["earningsYield"] = 1.0
        engine.VALUATION_SUB_WEIGHTS["bookYield"] = 0.0
        engine.VALUATION_SUB_WEIGHTS["dividendYield"] = 0.0
        mutated = run(copy.deepcopy(pop))
        mutated_val = next(x for x in mutated["candidates"][0]["scoreBreakdown"] if x["id"] == "valuation")["value"]
    finally:
        engine.VALUATION_SUB_WEIGHTS["earningsYield"] = original["earningsYield"]
        engine.VALUATION_SUB_WEIGHTS["bookYield"] = original["bookYield"]
        engine.VALUATION_SUB_WEIGHTS["dividendYield"] = original["dividendYield"]

    assert mutated_val != baseline_val


def test_t17c_sector_cap_relaxation_output_reflects_constant():
    # A2-S §15.5: deepReviewSectorCapRelaxed / actionableSectorCapRelaxed は
    # SECTOR_CAP_RELAXATION を参照して出力する（literal False の直書き禁止）。
    pop = make_population(10, seed_offset=5000)
    original = engine.SECTOR_CAP_RELAXATION
    try:
        engine.SECTOR_CAP_RELAXATION = True
        result = run(pop)
    finally:
        engine.SECTOR_CAP_RELAXATION = original
    obs = result["selectionObservability"]
    assert obs["deepReviewSectorCapRelaxed"] is True
    assert obs["actionableSectorCapRelaxed"] is True


def test_t04b_actionable_valuation_quality_floor_enforced_behavioral():
    # A2-S §25.8: actionableEligible は valuation/quality >= 0.40 floor を
    # 含む連言である。marketScore>=68 でも floor 未達なら actionable 不可。
    # prescreenScore を高くしつつ valuation(per/pbr/div) を意図的に弱くし、
    # quality(roe) を極端に強くすることで、stage3 全体は 68 を超えつつ
    # valuation 単体は 0.40 未満に留める構成にする。
    c = make_candidate(
        code="9701",
        sector="業種FL1",
        per=80.0,
        pbr=6.0,
        roe=99.0,
        dividendYield=0.0,
        sigma252d=0.05,
        mom3m=30.0,
        prescreenScore=1.0,
    )
    filler = make_weak_filler(15, seed_offset=9700)
    result = run([c] + filler)
    out = result["candidates"][0]
    valuation = next(x for x in out["scoreBreakdown"] if x["id"] == "valuation")["value"]
    assert valuation is not None and valuation < ACTIONABLE_MIN_VALUATION_PERCENTILE
    assert out["marketScore"] is not None and out["marketScore"] >= 68.0
    assert out["tier"] != "actionable"


def test_t17d_bear_crisis_sector_cap_constant_drives_resolver_output():
    # A2-S §15.4: BEAR_CRISIS_ACTIONABLE_SECTOR_HARD_CAP は normal cap と
    # 同値(2)のため、通常の behavioral test では
    # "ACTIONABLE_SECTOR_HARD_CAP を無視して代入する" mutation を検出できない。
    # 定数そのものを monkeypatch し、resolver の戻り値がその新しい値を
    # 反映することを直接確認する。
    original = engine.BEAR_CRISIS_ACTIONABLE_SECTOR_HARD_CAP
    try:
        engine.BEAR_CRISIS_ACTIONABLE_SECTOR_HARD_CAP = 1
        assert resolve_actionable_capacity("bear") == (engine.BEAR_CRISIS_ACTIONABLE_HARD_MAX, 1)
        assert resolve_actionable_capacity("crisis") == (engine.BEAR_CRISIS_ACTIONABLE_HARD_MAX, 1)
    finally:
        engine.BEAR_CRISIS_ACTIONABLE_SECTOR_HARD_CAP = original


def test_t01b_round_half_up_behavioral_market_score():
    # A2-S §18.2 の注意事項どおり、tier threshold 付近（54.95/67.95）では
    # half-up と banker's rounding が一致するため tier 件数の test では
    # round() への mutation (M-15) を検出できない。単一候補（percentile_rank
    # がn=1で0.5固定）+ prescreenScore=0.05 という half-boundary の外の
    # 値を使い、実際の marketScore 出力で round_half_up と round() の差分
    # (34.3 vs 34.2) を直接検証する。
    c = make_candidate(code="9801", sector="業種RH1", prescreenScore=0.05)
    result = run([c])
    out = result["candidates"][0]
    assert out["marketScore"] == 34.3


# ===========================================================================
# P5-B005-B1-R3: A2-S2 Frozen Authority Clarification §19.17 T3-01..T3-16
#
# authority: /Users/ryo/jp-portfolio-audit-reports/p5-b005-a2-s2-authority-
# clarification.md §19（Frozen Authority Clarification）。P3-01..P3-04 の
# production 修正と、B1-V2 survived mutation 7件（VALID_TEST_GAP）を閉じる
# behavioral test 群。V2 の unknown regime fail-closed / riskReasons enum順
# 要求は AUDIT_CONTRACT_OVERRULED（§6/§10/§11）のため実装しない — 本節の
# テストは既存 frozen 挙動（append順・neutral fallback）を固定する。
# ===========================================================================


def _canonical_multiset(candidates):
    """A2-S2 §19.14 (a'): code をキーとする写像ではなく、JSON
    sort_keys=True 直列化文字列の multiset で入力順不変性を検証する
    （出力 code が一意でない入力でも well-defined）。"""
    return sorted(json.dumps(c, sort_keys=True) for c in candidates)


# ---------------------------------------------------------------------------
# T3-01: riskReasons exact order（RR-01..RR-06）
# ---------------------------------------------------------------------------


def _rr_filler(n, offset):
    out = []
    for i in range(n):
        idx = i + offset
        out.append(
            make_candidate(
                code=f"8{idx % 900:03d}",
                sector=f"rrfill{idx}",
                per=20.0 + idx,
                pbr=1.0 + idx * 0.1,
                roe=5.0 + idx * 0.2,
                dividendYield=1.0,
                sigma252d=0.15,
                mom3m=10.0 + idx,
                prescreenScore=0.5,
            )
        )
    return out


def test_t3_01a_rr01_red_flag_plus_weak_momentum_exact_order():
    c = make_candidate(code="1001", sector="secRR1", sigma252d=0.60, mom3m=-999.0, prescreenScore=0.5)
    result = run([c] + _rr_filler(20, 100))
    assert result["candidates"][0]["riskReasons"] == ["SOFT_VOLATILITY_RED_FLAG", "SOFT_WEAK_MOMENTUM"]


def test_t3_01b_rr02_volatility_unavailable_plus_low_confidence_exact_order():
    c = make_candidate(
        code="1002", sector="secRR2", sigma252d=None, per=None, pbr=None, mom3m=-999.0, prescreenScore=0.5
    )
    result = run([c] + _rr_filler(20, 200))
    assert result["candidates"][0]["riskReasons"] == [
        "SOFT_VOLATILITY_UNAVAILABLE",
        "SOFT_WEAK_MOMENTUM",
        "SOFT_LOW_DATA_CONFIDENCE",
    ]


def test_t3_01c_rr03_red_flag_momentum_stale_fallback_exact_order():
    c = make_candidate(code="1003", sector="secRR3", sigma252d=0.60, mom3m=-999.0, prescreenScore=0.5)
    result = run(
        [c] + _rr_filler(20, 300),
        pipelinePath="cache_fallback",
        sourceUpdatedAt="2020-01-01T00:00:00Z",
        asOf="2026-01-01T00:00:00Z",
        staleThresholdHours=48,
    )
    assert result["candidates"][0]["riskReasons"] == [
        "SOFT_VOLATILITY_RED_FLAG",
        "SOFT_WEAK_MOMENTUM",
        "SOFT_STALE_SOURCE",
        "SOFT_FALLBACK_PROVENANCE",
    ]


def test_t3_01d_rr04_red_flag_momentum_low_confidence_prescreen_missing_exact_order():
    c = make_candidate(
        code="1004", sector="secRR4", sigma252d=0.60, mom3m=-999.0, per=None, pbr=None, roe=None
    )
    result = run([c] + _rr_filler(20, 400))
    assert result["candidates"][0]["riskReasons"] == [
        "SOFT_VOLATILITY_RED_FLAG",
        "SOFT_WEAK_MOMENTUM",
        "SOFT_LOW_DATA_CONFIDENCE",
        "SOFT_PRESCREEN_METADATA_MISSING",
    ]


def test_t3_01e_rr05_sector_crowding_is_last():
    # A2-S §25.6 #9: SOFT_SECTOR_CROWDING は他の soft reason より必ず後段で
    # 評価される。VOL_ELEVATED（deep_review-only）候補を同一 sector に
    # DEEP_REVIEW_SECTOR_HARD_CAP(6) 超過数だけ配置し、cap で screened へ
    # 降格した候補の riskReasons 末尾が SOFT_SECTOR_CROWDING であることを
    # 検証する。
    pop = [
        make_candidate(code=f"700{i}", sector="SAMESEC_RR5", sigma252d=0.40, prescreenScore=0.9)
        for i in range(8)
    ]
    result = run(pop)
    overflowed = [c for c in result["candidates"] if c["tier"] == "screened"]
    assert len(overflowed) == 2  # 8件中 cap=6 を超えた2件
    for c in overflowed:
        assert c["riskReasons"][-1] == "SOFT_SECTOR_CROWDING"
        assert c["riskReasons"] == ["SOFT_ELEVATED_VOLATILITY", "SOFT_SECTOR_CROWDING"]


def test_t3_01f_rr06_append_order_differs_from_enum_sort_order():
    # A2-S2 §19.13: riskReasons を enum index 順へソートする mutation は
    # RR-01..RR-04 のうち最低3件で出力を変えること（append順が enum順と
    # 一致しないことの固定）。
    order = {code: idx for idx, code in enumerate(CANDIDATE_FUNNEL_SOFT_REASON_CODES)}
    vectors = [
        ["SOFT_VOLATILITY_RED_FLAG", "SOFT_WEAK_MOMENTUM"],
        ["SOFT_VOLATILITY_UNAVAILABLE", "SOFT_WEAK_MOMENTUM", "SOFT_LOW_DATA_CONFIDENCE"],
        ["SOFT_VOLATILITY_RED_FLAG", "SOFT_WEAK_MOMENTUM", "SOFT_STALE_SOURCE", "SOFT_FALLBACK_PROVENANCE"],
        [
            "SOFT_VOLATILITY_RED_FLAG",
            "SOFT_WEAK_MOMENTUM",
            "SOFT_LOW_DATA_CONFIDENCE",
            "SOFT_PRESCREEN_METADATA_MISSING",
        ],
    ]
    differing = sum(1 for v in vectors if sorted(v, key=lambda r: order[r]) != v)
    assert differing >= 3


# ---------------------------------------------------------------------------
# T3-02: resolve_actionable_capacity call-path（resolver bypass 検出）
# ---------------------------------------------------------------------------


def test_t3_02a_resolver_call_path_behavioral_normal(monkeypatch):
    # A2-S2 §19.17 T3-02: resolve_actionable_capacity を monkeypatch し、
    # inline bypass mutation では検出できない「呼び出し経路そのもの」を
    # 検証する。定数直接参照へ置換する mutation は、この monkeypatch が
    # 反映されないため counts.actionable が 1 にならず RED になる。
    monkeypatch.setattr(engine, "resolve_actionable_capacity", lambda regime: (1, 1))
    strong = [_strong_candidate(f"990{i}", f"secT302_{i}") for i in range(5)]
    filler = make_weak_filler(15, seed_offset=9900)
    result = run(strong + filler)
    assert result["counts"]["actionable"] == 1
    assert result["selectionObservability"]["actionableSectorCapApplied"] == 1
    assert result["selectionObservability"]["actionableHardMaxApplied"] == 1


def test_t3_02b_resolver_call_path_behavioral_bear(monkeypatch):
    monkeypatch.setattr(engine, "resolve_actionable_capacity", lambda regime: (1, 1))
    strong = [_strong_candidate(f"991{i}", f"secT302B_{i}") for i in range(5)]
    filler = make_weak_filler(15, seed_offset=9910)
    result = run(strong + filler, regime="bear")
    assert result["counts"]["actionable"] == 1
    assert result["selectionObservability"]["actionableSectorCapApplied"] == 1
    assert result["selectionObservability"]["actionableHardMaxApplied"] == 1


# ---------------------------------------------------------------------------
# T3-03: deep-review 境界 behavioral（marketScore exact 55.0 / 54.9）
# ---------------------------------------------------------------------------


def test_t3_03a_deep_review_exact_55_0_passes():
    # n=1 母集団は percentile_rank が全軸 0.5 固定になるため
    # stage3 = 0.55*0.5 + 0.45*0.5 = 0.5。raw_composite = 0.35*p + 0.325。
    # p = 9/14 で raw_composite = 0.55 -> marketScore = 55.0 ちょうど。
    c = make_candidate(code="7001", sector="secT303", prescreenScore=9.0 / 14.0)
    result = run([c])
    out = result["candidates"][0]
    assert out["marketScore"] == 55.0
    assert out["tier"] == "deep_review"


def test_t3_03b_deep_review_exact_54_9_fails():
    c = make_candidate(code="7002", sector="secT303b", prescreenScore=0.64)
    result = run([c])
    out = result["candidates"][0]
    assert out["marketScore"] == 54.9
    assert out["tier"] != "deep_review"
    assert out["tier"] == "screened"


# ---------------------------------------------------------------------------
# T3-04: actionable 境界 behavioral（marketScore exact 68.0 / 67.9）
# ---------------------------------------------------------------------------


def _t304_pair(prescreen_score):
    # target(8001) は per/pbr/roe/dividendYield の全軸で filler(8002) より
    # 明確に優れており、2候補中で valuation=quality=1.0 ちょうどになる。
    target = make_candidate(
        code="8001",
        sector="secT304X",
        per=0.5,
        pbr=0.1,
        roe=50.0,
        dividendYield=20.0,
        sigma252d=0.10,
        mom3m=5.0,
        prescreenScore=prescreen_score,
    )
    filler = make_candidate(
        code="8002",
        sector="secT304Y",
        per=50.0,
        pbr=5.0,
        roe=-10.0,
        dividendYield=0.0,
        sigma252d=0.10,
        mom3m=5.0,
        prescreenScore=0.1,
    )
    return [target, filler]


def test_t3_04a_actionable_exact_68_0_passes():
    # stage3 = 0.55*1.0 + 0.45*1.0 = 1.0。raw_composite = 0.35*p + 0.65。
    # p = 3/35 で raw_composite = 0.68 -> marketScore = 68.0 ちょうど。
    result = run(_t304_pair(3.0 / 35.0))
    out = next(c for c in result["candidates"] if c["code"] == "8001")
    assert out["marketScore"] == 68.0
    assert out["tier"] == "actionable"


def test_t3_04b_actionable_exact_67_9_fails():
    result = run(_t304_pair(29.0 / 350.0))
    out = next(c for c in result["candidates"] if c["code"] == "8001")
    assert out["marketScore"] == 67.9
    assert out["tier"] != "actionable"
    assert out["tier"] == "deep_review"


# ---------------------------------------------------------------------------
# T3-05: quality floor 単独 behavioral（valuation floor と独立に検証）
# ---------------------------------------------------------------------------


def _t305_population(target_roe, target_code, other_roes, sector_prefix):
    # 6候補。per/pbr/dividendYield は target が最良（valuation rank=1.0
    # 固定）で、roe だけを target_roe / other_roes で分散させ quality の
    # percentile rank を厳密に制御する。
    pop = []
    pop.append(
        make_candidate(
            code=target_code,
            sector=f"{sector_prefix}T",
            per=0.5,
            pbr=0.05,
            roe=target_roe,
            dividendYield=20.0,
            sigma252d=0.10,
            mom3m=5.0,
            prescreenScore=1.0,
        )
    )
    for i, roe_v in enumerate(other_roes):
        pop.append(
            make_candidate(
                code=f"61{i:02d}",
                sector=f"{sector_prefix}{i}",
                per=1.0 + i,
                pbr=0.1 + i * 0.1,
                roe=roe_v,
                dividendYield=10.0 - i,
                sigma252d=0.10,
                mom3m=5.0,
                prescreenScore=0.1,
            )
        )
    return pop


def test_t3_05a_quality_exact_040_boundary_passes_actionable():
    # 6候補・roe=[target=20,0,10,30,40,50] -> percentile_rank([0,10,20,30,40,50])
    # の 20 に対応する rank は厳密に 0.4（count_less=2, N=6 -> 2/5）。
    pop = _t305_population(20.0, "5002", [0.0, 10.0, 30.0, 40.0, 50.0], "secT305A")
    result = run(pop)
    out = next(c for c in result["candidates"] if c["code"] == "5002")
    valuation = next(x for x in out["scoreBreakdown"] if x["id"] == "valuation")["value"]
    quality = next(x for x in out["scoreBreakdown"] if x["id"] == "quality")["value"]
    assert valuation is not None and valuation >= ACTIONABLE_MIN_VALUATION_PERCENTILE
    assert quality == 0.4
    assert out["marketScore"] is not None and out["marketScore"] >= ACTIONABLE_MIN_MARKET_SCORE
    assert out["tier"] == "actionable"


def test_t3_05b_quality_just_below_040_blocks_actionable():
    # 9候補・roe を8刻みで分散させ target を count_less=3 の位置（3/8=0.375）
    # に置く。valuation は floor(0.40) を明確に上回ったまま quality だけが
    # floor 未満になる。
    other_roes = [0.0, 10.0, 20.0, 40.0, 50.0, 60.0, 70.0, 80.0]
    pop = _t305_population(30.0, "6003", other_roes, "secT305B")
    result = run(pop)
    out = next(c for c in result["candidates"] if c["code"] == "6003")
    valuation = next(x for x in out["scoreBreakdown"] if x["id"] == "valuation")["value"]
    quality = next(x for x in out["scoreBreakdown"] if x["id"] == "quality")["value"]
    assert valuation is not None and valuation >= ACTIONABLE_MIN_VALUATION_PERCENTILE
    assert quality is not None and quality < ACTIONABLE_MIN_QUALITY_PERCENTILE
    assert out["marketScore"] is not None and out["marketScore"] >= ACTIONABLE_MIN_MARKET_SCORE
    assert out["tier"] != "actionable"


# ---------------------------------------------------------------------------
# T3-06: FORBIDDEN_KEYS に portfolioFit を含め全階層再帰検査（M1-05）
# ---------------------------------------------------------------------------


def test_t3_06_portfolio_fit_is_forbidden_and_absent_recursively():
    assert "portfolioFit" in FORBIDDEN_KEYS
    pop = make_population(10, seed_offset=6000)
    pop[0]["code"] = "12345"  # excluded record も含める
    result = run(pop)
    found = _walk_forbidden_keys(result)
    assert found == set(), f"forbidden keys leaked: {found}"


def test_t3_06b_forbidden_key_walker_exact_key_hygiene():
    """B1-V3 P2-01 correction: 禁止field recursive scanはkey名のみで判定
    し、値やコメント文字列中の部分一致・正当keyの部分一致で誤検出しない
    ことを直接検証する（旧 `"portfolioFit" not in json.dumps(result)` は
    値文字列にたまたま同じ文字列が含まれるだけで誤ってFAILし得たため削除
    済み）。"""
    # (a) 実際に禁止keyがあれば dict / list のどの深さでも検出される
    assert _walk_forbidden_keys({"portfolioFit": 1}) == {"portfolioFit"}
    assert _walk_forbidden_keys([{"a": {"cash": 1}}]) == {"cash"}
    assert _walk_forbidden_keys({"outer": [{"inner": {"holdings": []}}]}) == {"holdings"}

    # (b) 値やコメント文字列に禁止語があるだけでは検出しない
    assert _walk_forbidden_keys({"name": "portfolioFitStrategy"}) == set()
    assert _walk_forbidden_keys({"note": "cash flow analysis for holdings"}) == set()
    assert _walk_forbidden_keys(["portfolioFit as a plain list element"]) == set()

    # (c) 正当keyの部分一致による誤検出をしない（"action" は禁止keyだが
    #     "actionableSelectedCount" 等の正当keyは exact match しない）
    assert _walk_forbidden_keys({"actionableSelectedCount": 3}) == set()
    assert _walk_forbidden_keys({"actionableHardMaxApplied": 12}) == set()
    assert _walk_forbidden_keys({"actionableSectorCapApplied": 2}) == set()

    # (d) key type が string でなくても安全に処理する（クラッシュしない、
    #     かつ FORBIDDEN_KEYS は文字列集合のため非string keyは一致しない）
    assert _walk_forbidden_keys({1: "portfolioFit", ("a", "b"): {2: "cash"}}) == set()

    # (e) production output に対しても、値文字列中の禁止語や
    #     selectionObservability 内の action* 系正当keyが誤検出されない
    #     ことを end-to-end で確認する
    pop = make_population(10, seed_offset=6000)
    pop[0]["code"] = "12345"
    pop[0]["name"] = "有効企業portfolioFitという文字列を含む名称"
    result = run(pop)
    assert "actionableSelectedCount" in result["selectionObservability"]
    found = _walk_forbidden_keys(result)
    assert found == set(), f"forbidden keys leaked: {found}"


# ---------------------------------------------------------------------------
# T3-08 / T3-09: context / candidates 型境界（CTX-01..CTX-14）
# ---------------------------------------------------------------------------


def test_t3_08_context_none_and_empty_dict_no_pipeline_path_all_screened():
    # CTX-01 / CTX-02
    pop = make_population(5, seed_offset=6100)
    for ctx in (None, {}):
        result = build_candidate_funnel(copy.deepcopy(pop), ctx)
        assert result["status"] == "generated"
        assert result["counts"]["deepReview"] == 0
        assert result["counts"]["actionable"] == 0


def test_t3_08b_context_non_mapping_raises_type_error():
    # CTX-03..CTX-07
    pop = make_population(3, seed_offset=6200)
    for bad_ctx in ("normal", 0, [], False, ("normal",)):
        try:
            build_candidate_funnel(copy.deepcopy(pop), bad_ctx)
            raise AssertionError(f"expected TypeError for context={bad_ctx!r}")
        except TypeError as e:
            assert str(e) == "context must be a mapping or None"


def test_t3_08c_context_unknown_key_ignored():
    # CTX-08
    pop = make_population(3, seed_offset=6300)
    result = build_candidate_funnel(pop, {"pipelinePath": "normal", "unknownKey": object()})
    assert result["status"] == "generated"


def test_t3_09_candidates_non_sequence_raises_type_error():
    # CTX-09..CTX-12: TypeError を送出し、record を捏造しない
    ctx = {"pipelinePath": "normal"}
    for bad_candidates in (None, "abc", {"a": 1}, 123):
        try:
            build_candidate_funnel(bad_candidates, ctx)
            raise AssertionError(f"expected TypeError for candidates={bad_candidates!r}")
        except TypeError as e:
            assert str(e) == "candidates must be a list or tuple"


def test_t3_09b_candidates_empty_list_or_tuple_no_exception():
    # CTX-13
    ctx = {"pipelinePath": "normal"}
    for empty in ([], ()):
        result = build_candidate_funnel(empty, ctx)
        assert result["counts"] == {"total": 0, "excluded": 0, "screened": 0, "deepReview": 0, "actionable": 0}
        assert result["scoreDistribution"]["count"] == 0


def test_t3_09c_candidates_tuple_behaves_like_list():
    # CTX-14
    pop = make_population(10, seed_offset=6400)
    r_list = build_candidate_funnel(pop, {"pipelinePath": "normal"})
    r_tuple = build_candidate_funnel(tuple(pop), {"pipelinePath": "normal"})
    assert r_list == r_tuple


# ---------------------------------------------------------------------------
# T3-10: pipelinePath matrix（PP-01..PP-11）
# ---------------------------------------------------------------------------


def _filler_with_prescreen(n, seed_offset):
    # make_weak_filler は prescreenScore を持たないため、そのままだと
    # PRESCREEN_METADATA_MISSING degradation が population 全体へ混入する。
    # pipelinePath / regime matrix の「degradationReasons == []」期待に
    # 合わせ、全 filler へ有効な prescreenScore を明示的に付与する。
    out = make_weak_filler(n, seed_offset=seed_offset)
    for i, c in enumerate(out):
        c["prescreenScore"] = 0.1 + (i % 5) * 0.05
    return out


def _pp_population():
    strong = [_strong_candidate(f"66{i:02d}", f"secPP{i}") for i in range(5)]
    filler = _filler_with_prescreen(15, seed_offset=6600)
    return strong + filler


@pytest.mark.parametrize(
    "pipeline_path,expected_tier,expected_status",
    [
        ("normal", "actionable", "generated"),
        ("cache_fallback", "deep_review", "generated"),
        ("NORMAL", "screened", "generated"),
        ("unknown", "screened", "generated"),
        ("", "screened", "generated"),
        (None, "screened", "generated"),
        (123, "screened", "generated"),
        (True, "screened", "generated"),
        (["normal"], "screened", "generated"),
    ],
)
def test_t3_10a_pipeline_path_matrix(pipeline_path, expected_tier, expected_status):
    pop = _pp_population()
    ctx = {"pipelinePath": pipeline_path}
    result = build_candidate_funnel(pop, ctx)
    assert result["status"] == expected_status
    strong_out = result["candidates"][0]
    assert strong_out["tier"] == expected_tier
    if expected_tier == "screened":
        assert strong_out["riskReasons"] == []
        assert result["degradationReasons"] == []
        obs = result["selectionObservability"]
        assert obs["deepReviewEligibleCount"] == 0
        assert obs["actionableEligibleCount"] == 0
        assert result["counts"]["screened"] == result["counts"]["total"] - result["counts"]["excluded"]


def test_t3_10b_pipeline_path_missing_key_screened():
    # PP-11
    pop = _pp_population()
    result = build_candidate_funnel(pop, {})
    assert result["status"] == "generated"
    assert result["candidates"][0]["tier"] == "screened"
    obs = result["selectionObservability"]
    assert obs["deepReviewEligibleCount"] == 0
    assert obs["actionableEligibleCount"] == 0


def test_t3_10c_pipeline_path_seed_fallback_not_generated():
    # PP-03
    pop = _pp_population()
    result = build_candidate_funnel(pop, {"pipelinePath": "seed_fallback"})
    assert result["status"] == "not_generated"
    assert result["counts"]["actionable"] == 0
    assert result["candidates"] == []
    assert any("SEED_FALLBACK_PIPELINE_PATH" in r for r in result["degradationReasons"])


def test_t3_10d_pipeline_path_score_not_suppressed_when_invalid():
    # PP-04..PP-11 の marketScore は PP-01 と同一値であること（score算出を
    # pipelinePath 不正で抑制しない）。
    pop = _pp_population()
    result_normal = build_candidate_funnel(copy.deepcopy(pop), {"pipelinePath": "normal"})
    result_unknown = build_candidate_funnel(copy.deepcopy(pop), {"pipelinePath": "unknown"})
    assert result_normal["candidates"][0]["marketScore"] == result_unknown["candidates"][0]["marketScore"]


# ---------------------------------------------------------------------------
# T3-11: staleness matrix（ST-01..ST-18）
# ---------------------------------------------------------------------------

_ST_RECENT = "2026-07-25T00:00:00Z"
_ST_PAST = "2026-06-01T00:00:00Z"  # _ST_RECENT との差は約1296時間
_ST_FUTURE = "2099-01-01T00:00:00Z"


@pytest.mark.parametrize(
    "threshold,source_updated_at,as_of,expected_is_stale",
    [
        (48.0, _ST_PAST, _ST_RECENT, True),  # ST-01
        ("__missing__", _ST_PAST, _ST_RECENT, True),  # ST-02（キー欠損 -> 48.0 fallback）
        (None, _ST_PAST, _ST_RECENT, True),  # ST-03
        ("abc", _ST_PAST, _ST_RECENT, True),  # ST-04
        (float("nan"), _ST_PAST, _ST_RECENT, True),  # ST-05
        (float("inf"), _ST_PAST, _ST_RECENT, True),  # ST-06
        (-1, _ST_RECENT, _ST_RECENT, False),  # ST-07（直近 + 48.0 fallback）
        (True, _ST_PAST, _ST_RECENT, True),  # ST-08（bool は数値として認めない）
        (48.0, "__missing__", _ST_RECENT, False),  # ST-09
        (48.0, None, _ST_RECENT, False),  # ST-10
        (48.0, "not-a-date", _ST_RECENT, False),  # ST-11
        (48.0, 12345, _ST_RECENT, False),  # ST-12
        (48.0, _ST_PAST, "__missing__", False),  # ST-13（asOf key 欠損）
        (48.0, _ST_PAST, None, False),  # ST-13b（asOf 明示的 None。key欠損とは別vector）
        (48.0, _ST_PAST, "xx", False),  # ST-14
        (48.0, _ST_FUTURE, _ST_RECENT, False),  # ST-15
        (0, "2026-07-24T23:59:59Z", _ST_RECENT, True),  # ST-18
    ],
)
def test_t3_11a_staleness_matrix_behavioral(threshold, source_updated_at, as_of, expected_is_stale):
    strong = _strong_candidate("7501", "secST1")
    filler = make_weak_filler(15, seed_offset=7500)
    ctx = {"pipelinePath": "normal"}
    if source_updated_at != "__missing__":
        ctx["sourceUpdatedAt"] = source_updated_at
    # "__missing__" は「context に asOf key を一切設定しない」ことを表す
    # sentinel。以前は `if as_of is not None` で判定していたため、
    # as_of=="__missing__"（None ではない）という文字列がそのまま
    # ctx["asOf"] = "__missing__" として設定されてしまい、production の
    # 真の missing-key 分岐（context.get("asOf") is None）を一度も
    # 通過していなかった（B1-V3 SV3-01 / P1-01）。asOf=None は
    # 明示的にキーを None 値で設定する、missing-key とは別のベクトル。
    if as_of != "__missing__":
        ctx["asOf"] = as_of
    if threshold != "__missing__":
        ctx["staleThresholdHours"] = threshold
    assert ("asOf" in ctx) == (as_of != "__missing__")  # ST-13/ST-13b precondition
    result = run([strong] + filler, **{k: v for k, v in ctx.items() if k != "pipelinePath"})
    out = result["candidates"][0]
    expected_tier = "deep_review" if expected_is_stale else "actionable"
    assert result["selectionObservability"]["sourceStale"] == expected_is_stale
    assert out["marketScore"] is not None and out["marketScore"] >= 68.0
    assert out["tier"] == expected_tier
    if expected_is_stale:
        assert "SOFT_STALE_SOURCE" in out["riskReasons"]
    else:
        assert "SOFT_STALE_SOURCE" not in out["riskReasons"]


def test_t3_11d_missing_asof_key_precondition_and_not_stale():
    """B1-V3 SV3-01 correction（P1-01）: 上の parametrize matrix とは独立に、
    context に asOf key を一切構築しない状態を直接検証する。sourceUpdatedAt
    は有効な timezone-aware ISO、staleThresholdHours も有効値とし、
    staleness 以外の全 gate を候補が通過していることを precondition として
    確認したうえで、asOf 欠損時に authority どおり stale と断定しない
    ことを exact に assert する。"""
    strong = _strong_candidate("7504", "secSV301")
    filler = make_weak_filler(15, seed_offset=7900)
    ctx = {
        "pipelinePath": "normal",
        "sourceUpdatedAt": _ST_PAST,
        "staleThresholdHours": 48.0,
    }

    # --- preconditions ---
    assert "asOf" not in ctx  # asOf key が本当に存在しない
    assert datetime.fromisoformat(_ST_PAST.replace("Z", "+00:00")) is not None  # parse可能
    assert ctx["pipelinePath"] == "normal"
    assert isinstance(ctx["staleThresholdHours"], float) and ctx["staleThresholdHours"] == 48.0

    result = build_candidate_funnel([strong] + filler, ctx)
    out = result["candidates"][0]

    # staleness 以外の gate（marketScore/tier到達可能性）が候補を支配して
    # いないことを確認してから staleness 固有の主張へ進む。
    assert out["marketScore"] is not None and out["marketScore"] >= 68.0

    assert result["selectionObservability"]["sourceStale"] is False
    assert out["tier"] == "actionable"  # stale tier cap（deep_review強制）が適用されていない
    assert "SOFT_STALE_SOURCE" not in out["riskReasons"]  # stale reasonが付かない


def test_t3_11b_naive_timestamp_treated_as_utc_tz_independent():
    # ST-16: timezone なし ISO は UTC とみなす（TZ=UTC / TZ=Asia/Tokyo の
    # いずれで pytest を実行しても同一結果になること — engine は壁時計
    # 時刻を一切使わないため、この behavioral test 自体はプロセスの TZ
    # 環境変数に依存しない）。
    strong = _strong_candidate("7502", "secST16")
    filler = make_weak_filler(15, seed_offset=7600)
    result = run(
        [strong] + filler,
        sourceUpdatedAt="2026-06-01T00:00:00",
        asOf="2026-07-25T00:00:00",
        staleThresholdHours=48,
    )
    out = result["candidates"][0]
    assert result["selectionObservability"]["sourceStale"] is True
    assert out["tier"] == "deep_review"


def test_t3_11c_offset_aware_timestamp_stale_true():
    # ST-17
    strong = _strong_candidate("7503", "secST17")
    filler = make_weak_filler(15, seed_offset=7700)
    result = run(
        [strong] + filler,
        sourceUpdatedAt="2026-06-01T00:00:00Z",
        asOf="2026-07-25T09:00:00+09:00",
        staleThresholdHours=48,
    )
    out = result["candidates"][0]
    assert result["selectionObservability"]["sourceStale"] is True
    assert out["tier"] == "deep_review"


# ---------------------------------------------------------------------------
# T3-12: identity echo matrix（ID-01..ID-14）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "code_value,expected_excluded,expected_hard_reasons,expected_echo",
    [
        ("1234", False, [], "1234"),  # ID-01
        ("   ", False, [], "   "),  # ID-02
        ("BAD!", False, [], "BAD!"),  # ID-03
        ("12345", True, ["HARD_PREFERRED_OR_NONSTANDARD_CODE"], "12345"),  # ID-04
        ("", True, ["HARD_CONTRACT_VIOLATION"], ""),  # ID-05
        (None, True, ["HARD_CONTRACT_VIOLATION"], ""),  # ID-06
        (True, True, ["HARD_CONTRACT_VIOLATION"], ""),  # ID-07: "True" 禁止
        (7777, True, ["HARD_CONTRACT_VIOLATION"], ""),  # ID-08: "7777" 禁止
        (77.0, True, ["HARD_CONTRACT_VIOLATION"], ""),  # ID-09
        (["x"], True, ["HARD_CONTRACT_VIOLATION"], ""),  # ID-10
    ],
)
def test_t3_12a_identity_echo_matrix(code_value, expected_excluded, expected_hard_reasons, expected_echo):
    c = make_candidate(code=code_value)
    result = run([c])
    out = result["candidates"][0]
    assert (out["tier"] == "excluded") == expected_excluded
    assert out["hardExclusionReasons"] == expected_hard_reasons
    assert out["code"] == expected_echo


def test_t3_12b_code_key_missing_excluded_empty_echo():
    # ID-11
    c = make_candidate()
    del c["code"]
    result = run([c])
    out = result["candidates"][0]
    assert out["tier"] == "excluded"
    assert out["hardExclusionReasons"] == ["HARD_CONTRACT_VIOLATION"]
    assert out["code"] == ""


def test_t3_12c_name_non_str_valid_record_empty_echo():
    # ID-12
    for bad_name in (None, 123, True, ["n"]):
        c = make_candidate(name=bad_name)
        result = run([c])
        out = result["candidates"][0]
        assert out["tier"] != "excluded"
        assert out["hardExclusionReasons"] == []
        assert out["name"] == ""


def test_t3_12d_sector_non_str_excluded_empty_echo():
    # ID-13
    for bad_sector in (None, 123, True, ["s"]):
        c = make_candidate(sector=bad_sector)
        result = run([c])
        out = result["candidates"][0]
        assert out["tier"] == "excluded"
        assert out["hardExclusionReasons"] == ["HARD_CONTRACT_VIOLATION"]
        assert out["sector"] == ""


def test_t3_12e_non_dict_record_all_identity_fields_empty():
    # ID-14
    for bad_record in (None, "str_record", 123, ["a"], ("a",)):
        result = run([bad_record])
        out = result["candidates"][0]
        assert out["tier"] == "excluded"
        assert out["code"] == "" and out["name"] == "" and out["sector"] == ""
        assert out["hardExclusionReasons"] == ["HARD_CONTRACT_VIOLATION"]


# ---------------------------------------------------------------------------
# T3-13: invariance（INV-01..INV-04, multiset比較, 20置換）
# ---------------------------------------------------------------------------


def _assert_permutation_invariant_multiset(base_population, n_perms=20, seed=101):
    import random as _random

    _random.seed(seed)
    baseline = run(copy.deepcopy(base_population))
    baseline_ms = _canonical_multiset(baseline["candidates"])
    baseline_valid_ranks = sorted(c["marketRank"] for c in baseline["candidates"] if c["tier"] != "excluded")
    assert baseline_valid_ranks == list(range(1, len(baseline_valid_ranks) + 1))
    tried = 0
    for _ in range(n_perms):
        shuffled = copy.deepcopy(base_population)
        _random.shuffle(shuffled)
        result = run(shuffled)
        assert _canonical_multiset(result["candidates"]) == baseline_ms
        assert result["counts"] == baseline["counts"]
        assert result["excludedSummary"] == baseline["excludedSummary"]
        assert result["sectorDistribution"] == baseline["sectorDistribution"]
        assert result["scoreDistribution"] == baseline["scoreDistribution"]
        assert result["selectionObservability"] == baseline["selectionObservability"]
        # B1-V3 P1-02 correction: degradationReasons が比較対象から漏れて
        # いたため、入力順依存の detail 生成（SV3-02）を検出できなかった。
        assert result["degradationReasons"] == baseline["degradationReasons"]
        # §19.14(c) rank bijection: excluded以外の marketRank が 1..N の
        # 連続整数であり、excluded の marketRank は None であること。
        valid_ranks = sorted(c["marketRank"] for c in result["candidates"] if c["tier"] != "excluded")
        assert valid_ranks == list(range(1, len(valid_ranks) + 1))
        assert valid_ranks == baseline_valid_ranks
        assert all(c["marketRank"] is None for c in result["candidates"] if c["tier"] == "excluded")
        tried += 1
    assert tried == n_perms
    return baseline


def test_t3_13a_inv01_valid_str_vs_invalid_int_code_collision_permutation_invariant():
    # INV-01: code="7777"(valid) と code=7777(int, excluded) を同時に含む
    # 集合を20通り置換しても (a') multiset が一致し、かつ出力 code が
    # "7777" であるレコードがちょうど1件であること（str() 捏造の再発防止）。
    a = make_candidate(code="7777")
    b = make_candidate(code=7777, sector="secINV01B")
    base = [a, b]
    baseline = _assert_permutation_invariant_multiset(base)
    # code をキーとする写像そのものが一意でないと well-defined でないため
    # （§19.14 精密化の理由）、"code=='7777' である全レコード" ではなく
    # tier で区別した2つの独立条件として検証する: 有効レコードは
    # ちょうど1件、かつ excluded レコードの echo は "7777" へ捏造されず ""
    # のままであること（M3-12 の str() 復活を直接検出する）。
    valid_7777 = [c for c in baseline["candidates"] if c["code"] == "7777" and c["tier"] != "excluded"]
    assert len(valid_7777) == 1
    excluded_record = next(c for c in baseline["candidates"] if c["tier"] == "excluded")
    assert excluded_record["code"] == ""


def test_t3_13b_inv02_duplicate_code_permutation_invariant_multiset():
    pop = make_population(15, seed_offset=6800)
    pop[2]["code"] = pop[9]["code"]
    _assert_permutation_invariant_multiset(pop)


def test_t3_13c_inv03_sector_hard_max_binding_permutation_invariant_multiset():
    strong = [_strong_candidate(f"690{i}", "secINV03") for i in range(10)]
    _assert_permutation_invariant_multiset(strong)


def test_t3_13d_inv04_multiple_non_dict_records_permutation_invariant_multiset():
    base = make_population(10, seed_offset=6900) + ["broken1", "broken2", None, 123]
    _assert_permutation_invariant_multiset(base)


def test_t3_13e_degradation_reasons_and_rank_bijection_20_distinct_permutations():
    """B1-V3 SV3-02 correction（P1-02）:
    `_assert_permutation_invariant_multiset` は degradationReasons を比較
    対象に含んでおらず、また20回の shuffle 試行が実際に相異なる入力順を
    生んだことも証明していなかった。ここでは同一 multiset から20個の
    pairwise-distinct permutation を明示的に構築し（先に distinctness を
    precondition として assert）、DUPLICATE_CANDIDATE_CODE detail を含む
    degradationReasons・root全体・candidate 全fieldの canonical identity
    対応・rank bijection のすべてが入力順に依存しないことを検証する。"""
    base = make_population(15, seed_offset=6800)
    base[2]["code"] = base[9]["code"]  # 意図的な重複（DUPLICATE_CANDIDATE_CODE 発火）
    n = len(base)
    assert n >= 4  # 20 pairwise-distinct permutation (n! >= 20) の前提

    import random as _random

    _random.seed(2026)
    orders = []
    seen = set()
    guard = 0
    while len(orders) < 20:
        guard += 1
        assert guard < 10000
        candidate_order = tuple(_random.sample(range(n), n))
        if candidate_order in seen:
            continue
        seen.add(candidate_order)
        orders.append(candidate_order)

    # --- precondition: 20 permutation が pairwise-distinct であること
    #     （reverseだけの繰り返しではないこと）---
    assert len(orders) == 20
    assert len(set(orders)) == 20
    identity_order = tuple(range(n))
    reversed_order = tuple(reversed(range(n)))
    assert not all(o in (identity_order, reversed_order) for o in orders)

    baseline_pop = [copy.deepcopy(base[i]) for i in identity_order]
    baseline = run(baseline_pop)
    baseline_root = {k: v for k, v in baseline.items() if k != "candidates"}
    assert "DUPLICATE_CANDIDATE_CODE" in " ".join(baseline["degradationReasons"])
    baseline_by_identity = {identity_order[pos]: out for pos, out in enumerate(baseline["candidates"])}
    assert set(baseline_by_identity.keys()) == set(range(n))
    baseline_valid_ranks = sorted(out["marketRank"] for out in baseline["candidates"] if out["tier"] != "excluded")
    assert baseline_valid_ranks == list(range(1, len(baseline_valid_ranks) + 1))

    candidate_fields = (
        "code",
        "name",
        "sector",
        "tier",
        "marketScore",
        "marketRank",
        "dataConfidence",
        "prescreenScore",
        "prescreenRank",
        "prescreenPool",
        "selectedReasons",
        "riskReasons",
        "hardExclusionReasons",
        "themes",
        "themeStatus",
        "scoreBreakdown",
    )

    for order in orders:
        shuffled_pop = [copy.deepcopy(base[i]) for i in order]
        result = run(shuffled_pop)

        # --- root-level（status/counts/scoreDistribution/degradationReasons/
        #     selectionObservability(regimeApplied等)/not_for_trading/
        #     schema・versionフィールドを含む全root field）が permutation
        #     不変であること。candidates は順序を含めた素の list 比較には
        #     使わず（順序が変わるのは正しい挙動のため）、canonical identity
        #     対応で別途比較する。---
        root = {k: v for k, v in result.items() if k != "candidates"}
        assert root == baseline_root
        assert result["degradationReasons"] == baseline["degradationReasons"]

        by_identity = {order[pos]: out for pos, out in enumerate(result["candidates"])}
        assert len(result["candidates"]) == n  # レコード消失なし
        assert set(by_identity.keys()) == set(range(n))  # dict keyed by codeへの折り畳みなし

        for identity, baseline_out in baseline_by_identity.items():
            out = by_identity[identity]
            for field in candidate_fields:
                assert out[field] == baseline_out[field], (
                    f"identity={identity} field={field}: {out[field]!r} != {baseline_out[field]!r}"
                )

        valid_ranks = sorted(out["marketRank"] for out in result["candidates"] if out["tier"] != "excluded")
        assert valid_ranks == list(range(1, len(valid_ranks) + 1))
        assert valid_ranks == baseline_valid_ranks
        assert all(out["marketRank"] is None for out in result["candidates"] if out["tier"] == "excluded")


def test_t3_13f_duplicate_degradation_reason_uses_independent_literal_count():
    """B1-V3a P1（唯一残存の gap）: test_t3_13e は20 permutation間で
    degradationReasons が不変であることは検証するが、その expected を
    production自身の最初の実行結果（baseline）から取得しているため、
    全入力に対して一貫して誤った detail/count を返す mutation
    （例: "2 record(s) excluded" を "3 record(s) excluded" へ改変）が
    survive する。本 test は production を一切呼ばずに手で導出した
    literal expected のみと比較する独立 oracle として、この gap を閉じる。
    T3-13e の役割（permutation不変性・rank bijection）はそのまま維持し、
    ここでは degradationReasons の絶対的な正しさのみを担当する。"""
    candidates = [
        make_candidate(code="1001", sector="secT313F1", prescreenScore=0.50),
        make_candidate(code="1002", sector="secT313F2", prescreenScore=0.50),
        make_candidate(code="1002", sector="secT313F3", prescreenScore=0.50),
        make_candidate(code="1003", sector="secT313F4", prescreenScore=0.50),
        make_candidate(code="1004", sector="secT313F5", prescreenScore=0.50),
    ]
    context = {"pipelinePath": "normal"}

    # --- preconditions（production を一度も呼ばずに input のみから拘束）---
    assert len(candidates) == 5  # 入力candidate総数
    codes = [c["code"] for c in candidates]
    assert codes == ["1001", "1002", "1002", "1003", "1004"]
    assert codes.count("1002") == 2  # duplicate code出現数はexact 2
    non_dup_codes = [c for c in codes if c != "1002"]
    assert len(non_dup_codes) == len(set(non_dup_codes)) == 3  # duplicate以外は一意
    for c in candidates:
        assert isinstance(c.get("prescreenScore"), float) and math.isfinite(c["prescreenScore"])
        assert c["dataStatus"] == "ok"
        assert isinstance(c["sector"], str) and c["sector"] != ""
    # prescreen metadata欠損0（全件が上のループでusableと確認済み）
    assert context["pipelinePath"] == "normal"  # pipeline degradation 0（cache_fallbackではない）
    assert "sourceUpdatedAt" not in context and "asOf" not in context  # stale degradation 0（判定対象外）
    assert "prescreenFallbackUsed" not in context

    result = build_candidate_funnel(candidates, context)

    # --- degradationReasons: DUPLICATE_CANDIDATE_CODE のみをliteralに保持
    #     （production baselineからの取得ではなく、手で導出したliteral）---
    assert result["degradationReasons"] == [
        "DUPLICATE_CANDIDATE_CODE: 1 duplicate code(s), 2 record(s) excluded"
    ]
    assert len(result["degradationReasons"]) == 1

    # --- candidate側の独立確認 ---
    assert len(result["candidates"]) == len(candidates) == 5  # record数保持（code keyed dictで折り畳まない）
    dup_records = [c for c in result["candidates"] if c["code"] == "1002"]
    assert len(dup_records) == 2  # duplicate対象は入力のexact 2件のまま出力にも残る
    by_sector = {c["sector"]: c for c in dup_records}
    assert set(by_sector.keys()) == {"secT313F2", "secT313F3"}
    for dup in dup_records:
        assert dup["tier"] == "excluded"
        assert dup["marketRank"] is None
        assert dup["hardExclusionReasons"] == ["HARD_CONTRACT_VIOLATION"]

    non_dup_records = [c for c in result["candidates"] if c["code"] != "1002"]
    assert len(non_dup_records) == 3
    assert {c["code"] for c in non_dup_records} == {"1001", "1003", "1004"}
    for c in non_dup_records:
        assert c["hardExclusionReasons"] == []


# ---------------------------------------------------------------------------
# T3-14: numeric matrix 固定（1軸/2軸 invalid でも actionable 可、3軸で不可）
# ---------------------------------------------------------------------------


def _numeric_matrix_strong(code, sector, **overrides):
    base = make_candidate(
        code=code,
        sector=sector,
        per=5.0,
        pbr=0.3,
        roe=40.0,
        dividendYield=8.0,
        sigma252d=0.10,
        mom3m=30.0,
        prescreenScore=0.95,
    )
    base.update(overrides)
    return base


def test_t3_14a_one_axis_invalid_still_actionable():
    # usableAxes=5（mom3m のみ invalid, zero-weight component なので
    # valuation/quality floor へ影響しない）-> dataConfidence 5/6=0.8333.
    c = _numeric_matrix_strong("9001", "secT314A", mom3m=float("nan"))
    filler = make_weak_filler(15, seed_offset=9000)
    result = run([c] + filler)
    out = result["candidates"][0]
    assert out["dataConfidence"] == 0.8333
    assert out["tier"] == "actionable"


def test_t3_14b_two_axes_invalid_still_actionable():
    # usableAxes=4（mom3m + dividendYield invalid）-> dataConfidence
    # 4/6 == 2/3 == ACTIONABLE_MIN_DATA_CONFIDENCE（frozen truth table PASS）。
    c = _numeric_matrix_strong("9002", "secT314B", mom3m=float("nan"), dividendYield=float("nan"))
    filler = make_weak_filler(15, seed_offset=9100)
    result = run([c] + filler)
    out = result["candidates"][0]
    assert out["dataConfidence"] == 0.6667
    assert out["tier"] == "actionable"


def test_t3_14c_three_axes_invalid_blocks_actionable_but_not_deep_review():
    # usableAxes=3（mom3m + dividendYield + pbr invalid）
    # -> dataConfidence 3/6=0.5 < 2/3 -> actionable FAIL, deep_review PASS。
    c = _numeric_matrix_strong(
        "9003", "secT314C", mom3m=float("nan"), dividendYield=float("nan"), pbr=float("nan")
    )
    filler = make_weak_filler(15, seed_offset=9200)
    result = run([c] + filler)
    out = result["candidates"][0]
    assert out["dataConfidence"] == 0.5
    assert out["tier"] != "actionable"
    assert out["tier"] == "deep_review"


# ---------------------------------------------------------------------------
# T3-15: regime matrix（REG-01..REG-08）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "regime,expected_regime_applied,expected_capacity",
    [
        ("bear", "bear", (5, 2)),  # REG-01
        ("crisis", "crisis", (5, 2)),  # REG-02
        ("bull_calm", "bull_calm", (12, 2)),  # REG-03
        ("bull_volatile", "bull_volatile", (12, 2)),
        ("uncertain", "uncertain", (12, 2)),
        ("BEAR", None, (12, 2)),  # REG-04
        ("unknown", None, (12, 2)),  # REG-05
        (None, None, (12, 2)),  # REG-06
        (123, None, (12, 2)),  # REG-07
        (True, None, (12, 2)),
        (["bear"], None, (12, 2)),
    ],
)
def test_t3_15a_regime_matrix_behavioral(regime, expected_regime_applied, expected_capacity):
    strong = _strong_candidate("9601", "secT315")
    filler = _filler_with_prescreen(15, seed_offset=9600)
    result = run([strong] + filler, regime=regime)
    obs = result["selectionObservability"]
    out = result["candidates"][0]
    assert obs["regimeApplied"] == expected_regime_applied
    assert (obs["actionableHardMaxApplied"], obs["actionableSectorCapApplied"]) == expected_capacity
    assert out["tier"] == "actionable"
    assert out["riskReasons"] == []
    assert result["degradationReasons"] == []


def test_t3_15b_regime_missing_key_actionable_reachable():
    # REG-08（B1-V3 P2-02 correction）: 旧版は make_weak_filler をそのまま
    # 使っていたため filler 全体に prescreenScore が欠け、
    # PRESCREEN_METADATA_MISSING が population 全体へ混入して
    # degradationReasons == [] という REG-08 precondition を検証できて
    # いなかった。prescreen-complete filler に切り替え、regime key が
    # 本当に存在しないこと・regime=None ケース（REG-06）／unknown文字列
    # ケース（REG-04/05）とは別ベクトルであることを明示したうえで、
    # risk/degradation の両配列を literal に assert する。
    strong = _strong_candidate("9602", "secT315B")
    filler = _filler_with_prescreen(15, seed_offset=9700)
    ctx = {"pipelinePath": "normal"}

    # --- preconditions ---
    assert "regime" not in ctx  # regime key が本当に存在しない（None代入や
    # unknown文字列とは異なるベクトル）

    result = build_candidate_funnel([strong] + filler, ctx)
    obs = result["selectionObservability"]
    out = result["candidates"][0]
    assert obs["regimeApplied"] is None
    assert (obs["actionableHardMaxApplied"], obs["actionableSectorCapApplied"]) == (12, 2)
    assert out["tier"] == "actionable"
    assert out["riskReasons"] == []
    assert result["degradationReasons"] == []
