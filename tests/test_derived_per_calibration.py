"""P5-B005-B4-D1a-O: strict-derived PER migration calibration observability。

network に触れない。全 statement/handoff は明示的 fixture として注入する。

カバレッジ（ticket §25）:
  1. four availability classes
  2. dataConfidence transition matrix
  3. aggregate parity identities
  4. providerOnly/derivedOnly relative divergence = NOT_APPLICABLE
  5. bothValid divergence calculation
  6. strict-derived false-positive count
  7. numeric derived PER requires diagnostics.per=available
  8. provider fallback absent
  9. production candidate per remains provider authority
  10. production funnel result unchanged with calibration enabled
  11. mirror changes only canonical per
  12. tier decomposition
  13. unexplained hard gate
  14. mirror P-14 calculation
  15. aggregate evidence contains no raw statement/per-symbol financial data
  16. provider access count unchanged
  17. ROE authority unchanged
  18. growth reserved_zero_weight unchanged
  19. calibration evidence never written to data/ or public/data/
"""
from __future__ import annotations

import copy
import json
from datetime import date, datetime, timezone

import pytest

from data.candidate_fundamentals import (
    PER_AUTHORITY_DERIVED,
    PER_AUTHORITY_PROVIDER,
    PER_DIAG_AVAILABLE,
    PER_DIAG_EPS_NOT_POSITIVE,
    PER_DIAG_PRICE_UNAVAILABLE,
    PER_DIAG_ROW_LABEL_MISSING,
    PER_DIAG_SPLIT_GUARD_BLOCKED,
    PER_DIAG_STALE,
    FundamentalsEnricher,
    FundamentalsFetch,
    derive_fundamentals,
)
from data.candidate_funnel_engine import COMPONENT_SOURCE_FIELDS, COMPONENT_WEIGHTS, build_candidate_funnel
from data.derived_per_calibration import (
    build_derived_per_calibration_evidence,
    build_mirror_candidates,
    emit_derived_per_calibration_evidence,
)

OBSERVED = datetime(2026, 6, 30, tzinfo=timezone.utc)
FY0_END = date(2026, 3, 31)
FY1_END = date(2025, 3, 31)


# ---------------------------------------------------------------------------
# strict-derived PER contract（§2）と diagnostics（§5）
# ---------------------------------------------------------------------------


def _derive(**kw):
    base = dict(
        income_stmt={"Diluted EPS": [100.0, 90.0], "Net Income": [1e9, 9e8]},
        balance_sheet={},
        period_ends=[FY0_END, FY1_END],
        splits=[],
        splits_ok=True,
        price_last_close=2000.0,
        observed_at=OBSERVED,
    )
    base.update(kw)
    return derive_fundamentals(**base)


def test_strict_derived_per_available_is_price_over_fy0_eps():
    r = _derive()
    assert r.strict_derived_per == pytest.approx(20.0)  # 2000 / 100
    assert r.strict_derived_per_diag == PER_DIAG_AVAILABLE


def test_strict_derived_per_rejects_non_positive_eps():
    r = _derive(income_stmt={"Diluted EPS": [-5.0, 90.0]})
    assert r.strict_derived_per is None
    assert r.strict_derived_per_diag == PER_DIAG_EPS_NOT_POSITIVE


def test_strict_derived_per_no_provider_fallback_on_missing_row():
    # §8: Diluted 行が無く Basic も無い → provider PER へ fallback しない。
    r = _derive(income_stmt={"Net Income": [1e9, 9e8]})
    assert r.strict_derived_per is None
    assert r.strict_derived_per_diag == PER_DIAG_ROW_LABEL_MISSING


def test_strict_derived_per_split_guard_blocked_and_retrieval_failure_map_same():
    blocked = _derive(splits=[(date(2025, 12, 1), 2.0)])
    assert blocked.strict_derived_per is None
    assert blocked.strict_derived_per_diag == PER_DIAG_SPLIT_GUARD_BLOCKED
    retrieval_fail = _derive(splits_ok=False)
    assert retrieval_fail.strict_derived_per is None
    assert retrieval_fail.strict_derived_per_diag == PER_DIAG_SPLIT_GUARD_BLOCKED


def test_strict_derived_per_stale_statement():
    old = datetime(2028, 6, 30, tzinfo=timezone.utc)
    r = _derive(observed_at=old)
    assert r.strict_derived_per is None
    assert r.strict_derived_per_diag == PER_DIAG_STALE


def test_strict_derived_per_price_unavailable():
    r = _derive(price_last_close=None)
    assert r.strict_derived_per_diag == PER_DIAG_PRICE_UNAVAILABLE
    r2 = _derive(price_last_close=-3.0)
    assert r2.strict_derived_per_diag == PER_DIAG_PRICE_UNAVAILABLE


def test_no_false_positive_numeric_per_without_available_diag():
    # §10: numeric strict-derived PER が出るのは diag==available のときだけ。
    for kw in (
        {"income_stmt": {"Diluted EPS": [-5.0, 90.0]}},
        {"splits": [(date(2025, 12, 1), 2.0)]},
        {"splits_ok": False},
        {"price_last_close": 0.0},
        {"observed_at": datetime(2028, 6, 30, tzinfo=timezone.utc)},
    ):
        r = _derive(**kw)
        if r.strict_derived_per is not None:
            assert r.strict_derived_per_diag == PER_DIAG_AVAILABLE


# ---------------------------------------------------------------------------
# enricher: diagnostics.per + calibration handoff + perAuthority
# ---------------------------------------------------------------------------


def _fetch_ok(code):
    return FundamentalsFetch(
        income_stmt={"Diluted EPS": [100.0, 90.0], "Net Income": [1e9, 9e8]},
        balance_sheet={"Stockholders Equity": [5e9]},
        period_ends=[FY0_END, FY1_END],
        splits=[],
        splits_ok=True,
    )


def test_meta_per_authority_is_provider_and_diagnostics_per_is_total():
    enr = FundamentalsEnricher(_fetch_ok, now=OBSERVED)
    items = [{"code": c, "per": 12.0, "roe": 8.0, "price": 2000.0} for c in ("1", "2", "3")]
    for it in items:
        enr.enrich(it, it["code"])
    meta = enr.meta(["1", "2", "3"])
    assert meta["perAuthority"] == PER_AUTHORITY_PROVIDER
    assert meta["perAuthority"] != PER_AUTHORITY_DERIVED
    per_diag = meta["diagnostics"]["per"]
    assert sum(per_diag.values()) == 3
    assert per_diag[PER_DIAG_AVAILABLE] == 3
    # growth diagnostics 契約は不変
    assert sum(meta["diagnostics"]["profitGrowth"].values()) == 3
    assert sum(meta["diagnostics"]["epsGrowth"].values()) == 3


def test_calibration_handoff_has_no_raw_statement_fields():
    enr = FundamentalsEnricher(_fetch_ok, now=OBSERVED)
    it = {"code": "7203", "per": 12.0, "roe": 8.0, "price": 2000.0}
    enr.enrich(it, "7203")
    payload = enr.calibration_handoff_payload(["7203"])
    assert payload["perAuthority"] == PER_AUTHORITY_PROVIDER
    assert payload["not_for_trading"] is True
    entry = payload["entries"][0]
    assert set(entry) == {
        "code",
        "providerPer",
        "providerPerValid",
        "strictDerivedPer",
        "strictDerivedPerValid",
        "strictDerivedPerDiag",
    }
    blob = json.dumps(payload)
    for banned in ("Diluted EPS", "Net Income", "Stockholders Equity", "income_stmt"):
        assert banned not in blob


def test_handoff_written_only_under_runner_temp(tmp_path, monkeypatch):
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    enr = FundamentalsEnricher(_fetch_ok, now=OBSERVED)
    it = {"code": "7203", "per": 12.0, "roe": 8.0, "price": 2000.0}
    enr.enrich(it, "7203")
    out = enr.emit_calibration_handoff(["7203"])
    assert out is not None and out.parent == tmp_path
    monkeypatch.delenv("RUNNER_TEMP")
    assert enr.emit_calibration_handoff(["7203"]) is None


# ---------------------------------------------------------------------------
# calibration mirror / evidence
# ---------------------------------------------------------------------------


def _population(n=40):
    out = []
    for i in range(n):
        out.append(
            {
                "code": f"{1000 + i}",
                "name": f"n{i}",
                "sector": ["a", "b", "c", "d", "e", "f", "g"][i % 7],
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


def _handoff_for(pop):
    """i%5: 0=providerOnly, 1=derivedOnly, 2=bothNull, else bothValid."""
    entries = []
    for i, c in enumerate(pop):
        code = c["code"]
        if i % 5 == 0:
            entries.append(
                {
                    "code": code,
                    "providerPer": c["per"],
                    "providerPerValid": True,
                    "strictDerivedPer": None,
                    "strictDerivedPerValid": False,
                    "strictDerivedPerDiag": "splitGuardBlocked",
                }
            )
        elif i % 5 == 1:
            c["per"] = None  # provider invalid → derivedOnly
            entries.append(
                {
                    "code": code,
                    "providerPer": None,
                    "providerPerValid": False,
                    "strictDerivedPer": 11.0 + i,
                    "strictDerivedPerValid": True,
                    "strictDerivedPerDiag": "available",
                }
            )
        elif i % 5 == 2:
            c["per"] = None
            entries.append(
                {
                    "code": code,
                    "providerPer": None,
                    "providerPerValid": False,
                    "strictDerivedPer": None,
                    "strictDerivedPerValid": False,
                    "strictDerivedPerDiag": "rowLabelMissing",
                }
            )
        else:
            entries.append(
                {
                    "code": code,
                    "providerPer": c["per"],
                    "providerPerValid": True,
                    "strictDerivedPer": c["per"] * (1.0 + 0.03 * (i % 4)),
                    "strictDerivedPerValid": True,
                    "strictDerivedPerDiag": "available",
                }
            )
    return {"entries": entries, "aborted": False, "abortReason": None}


CTX = {"pipelinePath": "normal"}


def _evidence(pop=None):
    pop = pop if pop is not None else _population()
    handoff = _handoff_for(pop)
    baseline = build_candidate_funnel(copy.deepcopy(pop), dict(CTX))
    return build_derived_per_calibration_evidence(
        handoff=handoff,
        joined_candidates=pop,
        context=dict(CTX),
        baseline_result=baseline,
        now=OBSERVED,
    ), handoff, baseline, pop


def test_four_availability_classes_and_parity_identities():
    ev, handoff, _b, _p = _evidence()
    cc = ev["availabilityClassCounts"]
    assert set(cc) == {"bothValid", "providerOnly", "derivedOnly", "bothNull"}
    assert sum(cc.values()) == len(handoff["entries"])
    parity = ev["dataConfidenceParity"]
    assert parity["dcIncreaseMatchesDerivedOnly"] is True
    assert parity["dcDecreaseMatchesProviderOnly"] is True
    assert parity["dcUnchangedMatchesBothValidPlusBothNull"] is True
    assert parity["unexpectedDcDeltaCount"] == 0


def test_divergence_only_for_bothvalid_pairs():
    ev, _h, _b, _p = _evidence()
    div = ev["bothValidDivergence"]
    assert div["comparablePairs"] <= ev["availabilityClassCounts"]["bothValid"]
    assert "NOT_APPLICABLE" in div["note"]
    assert div["medianAbsRelDiff"] is not None
    assert div["countAbsRelDiffGt1"] >= 0


def test_false_positive_gate_and_numeric_requires_available():
    ev, _h, _b, _p = _evidence()
    assert ev["falsePositiveDerivedPerCount"] == 0
    assert ev["numericDerivedPerWithoutAvailableDiagCount"] == 0
    assert ev["perDiagnosticSumEqualsCalibrated"] is True


def test_false_positive_detected_when_contract_violated():
    pop = _population()
    handoff = _handoff_for(pop)
    handoff["entries"][3]["strictDerivedPer"] = 15.0
    handoff["entries"][3]["strictDerivedPerValid"] = False
    handoff["entries"][3]["strictDerivedPerDiag"] = "splitGuardBlocked"
    baseline = build_candidate_funnel(copy.deepcopy(pop), dict(CTX))
    ev = build_derived_per_calibration_evidence(
        handoff=handoff, joined_candidates=pop, context=dict(CTX), baseline_result=baseline, now=OBSERVED
    )
    assert ev["falsePositiveDerivedPerCount"] == 1


def test_mirror_changes_only_canonical_per():
    pop = _population()
    handoff = _handoff_for(pop)
    by_code = {e["code"]: e for e in handoff["entries"]}
    mirror = build_mirror_candidates(pop, by_code)
    for orig, mir in zip(pop, mirror):
        for k in orig:
            if k == "per":
                continue
            assert mir[k] == orig[k]


def test_tier_decomposition_and_unexplained_gate():
    ev, _h, _b, _p = _evidence()
    decomp = ev["tierTransitionDecomposition"]
    assert set(decomp) == {"valuationDriven", "confidenceDriven", "combined", "unexplained"}
    assert ev["unexplainedTransitionCount"] == decomp["unexplained"]
    assert ev["unexplainedTransitionCount"] == 0


def test_mirror_p14_is_computed_and_high():
    ev, _h, _b, _p = _evidence()
    assert 0.0 <= ev["mirrorP14Jaccard"] <= 1.0
    assert ev["mirrorP14Jaccard"] >= ev["mirrorP14JaccardMin"]


def test_production_funnel_unchanged_with_calibration_enabled():
    # §10: calibration mirror は baseline funnel を一切変えない（pure、副作用なし）。
    pop = _population()
    before = build_candidate_funnel(copy.deepcopy(pop), dict(CTX))
    _ev, _h, _b, pop_after = _evidence(pop)
    after = build_candidate_funnel(copy.deepcopy(pop_after), dict(CTX))
    # pop の per は fixture が derivedOnly/bothNull 行で None にするため、
    # baseline を同じ pop_after から取り直して比較する。
    assert after == _b


def test_evidence_has_no_per_symbol_or_raw_financial_data():
    ev, _h, _b, pop = _evidence()
    blob = json.dumps(ev, default=str)
    assert "Diluted EPS" not in blob and "income_stmt" not in blob
    for c in pop:
        assert f'"{c["code"]}"' not in blob  # per-symbol code は aggregate に出さない
    assert ev["providerAccessDelta"] == 0
    assert ev["perAuthority"] == PER_AUTHORITY_PROVIDER
    assert ev["mirrorAuthority"] == PER_AUTHORITY_DERIVED
    assert ev["not_for_trading"] is True


def test_roe_and_growth_authority_unchanged():
    assert COMPONENT_WEIGHTS["growth"] == 0.0
    assert COMPONENT_WEIGHTS["quality"] == 0.45  # ROE authority weight 不変
    assert COMPONENT_SOURCE_FIELDS["growth"] == ()
    assert COMPONENT_SOURCE_FIELDS["quality"] == ("roe",)


def test_emit_evidence_only_under_runner_temp(tmp_path, monkeypatch):
    ev, _h, _b, _p = _evidence()
    monkeypatch.delenv("RUNNER_TEMP", raising=False)
    assert emit_derived_per_calibration_evidence(ev) is None
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    out = emit_derived_per_calibration_evidence(ev)
    assert out is not None and out.parent == tmp_path
    # data/ ・ public/data/ には決して現れない
    assert "data" not in out.parts[:-1] or str(tmp_path) in str(out)


def test_abort_state_is_surfaced():
    pop = _population()
    handoff = _handoff_for(pop)
    handoff["aborted"] = True
    handoff["abortReason"] = "provider_rate_limited: X"
    baseline = build_candidate_funnel(copy.deepcopy(pop), dict(CTX))
    ev = build_derived_per_calibration_evidence(
        handoff=handoff, joined_candidates=pop, context=dict(CTX), baseline_result=baseline, now=OBSERVED
    )
    assert ev["abort"]["fundamentalsAborted"] is True
    assert ev["acceptanceGateSnapshot"]["abortFalse"] is False
