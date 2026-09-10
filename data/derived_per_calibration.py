#!/usr/bin/env python3
"""P5-B005-B4-D1a-O: strict-derived annual FY0 PER migration calibration
observability（PRE-MIGRATION、ephemeral、非公開、not_for_trading）。

この module は production の PER authority を切り替えない。

  public production authority : provider trailingPE（canonical key = "per"）
  strict-derived PER          : ephemeral な calibration mirror でのみ使用

責務:
  - build_candidates_stocks が RUNNER_TEMP へ書いた calibration handoff
    （per-symbol の provider-per availability + strict-derived PER + diagnostic）
    を読む。
  - BASELINE funnel（provider canonical per）と DERIVED MIRROR funnel
    （canonical per を strict-derived PER に置換、他は完全に同一入力）の
    2 評価を作る。
  - availability class 別集計 / PER diagnostic 集計 / bothValid divergence /
    dataConfidence parity / tier transition decomposition / mirror P-14 /
    top40・actionable movement を 1 つの machine-readable aggregate evidence
    document へまとめる。
  - evidence は RUNNER_TEMP のみへ書く。data/ ・ public/data/ ・ Pages ・
    main へは決して書かない（§19）。

新規 provider access は 0（§4）。全入力は既に fetch 済みの scalar。
mirror は production ranking / public artifact に一切影響しない（§3）。
"""
from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from data.candidate_fundamentals import (
    DERIVED_PER_CALIBRATION_HANDOFF_FILENAME,
    PER_AUTHORITY_DERIVED,
    PER_AUTHORITY_PROVIDER,
    PER_DIAG_AVAILABLE,
    PER_DIAG_KEYS,
)
from data.candidate_funnel_batch import (
    TOP_N_STABILITY,
    _jaccard,
    _perturb_candidates,
    _top_n_codes_ordered,
)
from data.candidate_funnel_engine import build_candidate_funnel

CALIBRATION_EVIDENCE_KIND = "derived_per_migration_calibration"
CALIBRATION_EVIDENCE_FILENAME = "derived_per_calibration_evidence.json"
CALIBRATION_EVIDENCE_SCHEMA = "derived-per-migration-calibration-1"

MIRROR_P14_JACCARD_MIN = 0.95  # §15（P-14 semantics は再定義しない）
TOP40_JACCARD_DECISION_MIN = 0.80  # §16
_FLOAT_TOL = 1e-9  # §9

# availability class（§1）
_BOTH_VALID = "bothValid"
_PROVIDER_ONLY = "providerOnly"
_DERIVED_ONLY = "derivedOnly"
_BOTH_NULL = "bothNull"

_TIER_OUT = {
    "excluded": "excluded",
    "eligible": "eligible",
    "screened": "screened",
    "deep_review": "deepReview",
    "actionable": "actionable",
}

_NUMERIC = (int, float)


def _finite(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, _NUMERIC):
        return None
    v = float(value)
    return v if math.isfinite(v) else None


def _usable_axes(cand: dict[str, Any], per_value: Any) -> int:
    """engine の dataConfidence usable-axis と同一規律（bool 除外・非有限除外）。"""
    axes = (
        per_value,
        cand.get("pbr"),
        cand.get("roe"),
        cand.get("dividendYield"),
        cand.get("sigma252d"),
        cand.get("mom3m"),
    )
    return sum(1 for v in axes if _finite(v) is not None)


def _data_confidence(cand: dict[str, Any], per_value: Any) -> float:
    """engine の A2 §6.5 dataConfidence を internal（未 round）で再現する。"""
    usable = _usable_axes(cand, per_value)
    status_factor = 1.0 if cand.get("dataStatus") == "ok" else 0.6
    return min(max((usable / 6.0) * status_factor, 0.0), 1.0)


def _status_factor(cand: dict[str, Any]) -> float:
    return 1.0 if cand.get("dataStatus") == "ok" else 0.6


def _percentile(sorted_vals: list[float], pct: float) -> Optional[float]:
    n = len(sorted_vals)
    if n == 0:
        return None
    if n == 1:
        return sorted_vals[0]
    idx = (pct / 100.0) * (n - 1)
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return sorted_vals[lo]
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (idx - lo)


def _availability_class(provider_valid: bool, derived_valid: bool) -> str:
    if provider_valid and derived_valid:
        return _BOTH_VALID
    if provider_valid and not derived_valid:
        return _PROVIDER_ONLY
    if derived_valid and not provider_valid:
        return _DERIVED_ONLY
    return _BOTH_NULL


def _index_by_code(result: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for c in result.get("candidates", []):
        if isinstance(c, dict) and isinstance(c.get("code"), str) and c["code"] != "":
            out[c["code"]] = c
    return out


def build_mirror_candidates(
    joined_candidates: list[Any], handoff_by_code: dict[str, dict[str, Any]]
) -> list[Any]:
    """§8: BASELINE と同一入力から canonical `per` のみを strict-derived PER
    に置き換えた DERIVED MIRROR 入力を作る。他フィールドは一切変えない。"""
    mirror: list[Any] = []
    for c in joined_candidates:
        if not isinstance(c, dict):
            mirror.append(c)
            continue
        nc = dict(c)
        code = c.get("code")
        entry = handoff_by_code.get(code) if isinstance(code, str) else None
        if entry is not None:
            nc["per"] = entry.get("strictDerivedPer") if entry.get("strictDerivedPerValid") else None
        mirror.append(nc)
    return mirror


def build_derived_per_calibration_evidence(
    *,
    handoff: dict[str, Any],
    joined_candidates: list[Any],
    context: dict[str, Any],
    baseline_result: dict[str, Any],
    now: datetime,
    run_identity: Optional[dict[str, Any]] = None,
    build_funnel_fn: Callable[[list[Any], dict[str, Any]], dict[str, Any]] = build_candidate_funnel,
) -> dict[str, Any]:
    """1 つの aggregate calibration evidence document を作る（per-symbol raw 値・
    raw financial statement は含めない、§18）。"""
    entries = [
        e
        for e in (handoff.get("entries") or [])
        if isinstance(e, dict) and isinstance(e.get("code"), str) and e["code"] != ""
    ]
    handoff_by_code = {e["code"]: e for e in entries}
    jc_by_code: dict[str, dict[str, Any]] = {}
    for c in joined_candidates:
        if isinstance(c, dict) and isinstance(c.get("code"), str):
            jc_by_code.setdefault(c["code"], c)

    mirror_candidates = build_mirror_candidates(joined_candidates, handoff_by_code)
    mirror_result = build_funnel_fn(mirror_candidates, dict(context))

    base_idx = _index_by_code(baseline_result)
    mirror_idx = _index_by_code(mirror_result)

    base_top = _top_n_codes_ordered(baseline_result, TOP_N_STABILITY)
    mirror_top = _top_n_codes_ordered(mirror_result, TOP_N_STABILITY)
    base_top_set, mirror_top_set = set(base_top), set(mirror_top)
    base_actionable = {
        c["code"] for c in baseline_result.get("candidates", []) if c.get("tier") == "actionable"
    }
    mirror_actionable = {
        c["code"] for c in mirror_result.get("candidates", []) if c.get("tier") == "actionable"
    }

    # ── availability class + PER diagnostic + false-positive gate ──────────
    class_counts = {_BOTH_VALID: 0, _PROVIDER_ONLY: 0, _DERIVED_ONLY: 0, _BOTH_NULL: 0}
    per_diag_counts = {k: 0 for k in PER_DIAG_KEYS}
    false_positive = 0
    numeric_without_available = 0
    class_by_code: dict[str, str] = {}

    both_valid_rel_diffs: list[float] = []

    for e in entries:
        code = e["code"]
        provider_per = _finite(e.get("providerPer"))
        provider_valid = bool(e.get("providerPerValid"))
        derived_per = _finite(e.get("strictDerivedPer"))
        derived_valid = bool(e.get("strictDerivedPerValid"))
        diag = e.get("strictDerivedPerDiag")
        if diag not in per_diag_counts:
            diag = "enrichFailed"
        per_diag_counts[diag] += 1

        # §10 false-positive hard gate: numeric strict-derived PER なのに
        # frozen strict-derived authority contract が pass していない。
        if derived_per is not None and (not derived_valid or diag != PER_DIAG_AVAILABLE):
            false_positive += 1
        if derived_per is not None and diag != PER_DIAG_AVAILABLE:
            numeric_without_available += 1

        klass = _availability_class(provider_valid, derived_valid)
        class_counts[klass] += 1
        class_by_code[code] = klass

        # §11: bothValid かつ provider finite・>0 のときだけ relative divergence。
        if klass == _BOTH_VALID and provider_per is not None and provider_per > 0 and derived_per is not None:
            both_valid_rel_diffs.append(abs((derived_per - provider_per) / provider_per))

    both_valid_rel_diffs.sort()
    divergence = {
        "comparablePairs": len(both_valid_rel_diffs),
        "medianAbsRelDiff": _percentile(both_valid_rel_diffs, 50),
        "p75AbsRelDiff": _percentile(both_valid_rel_diffs, 75),
        "p90AbsRelDiff": _percentile(both_valid_rel_diffs, 90),
        "p95AbsRelDiff": _percentile(both_valid_rel_diffs, 95),
        "maxAbsRelDiff": both_valid_rel_diffs[-1] if both_valid_rel_diffs else None,
        "countAbsRelDiffGt1": sum(1 for d in both_valid_rel_diffs if d > 1.0),
        "note": "NOT_APPLICABLE for derivedOnly/providerOnly (no pair)",
    }

    # ── dataConfidence parity（§9）──────────────────────────────────────
    dc_increase = dc_decrease = dc_unchanged = dc_unexpected = 0
    score_delta_abs: list[float] = []
    base_usable_lt4 = mirror_usable_lt4 = 0
    dc_delta_by_code: dict[str, float] = {}
    score_delta_by_code: dict[str, float] = {}

    for e in entries:
        code = e["code"]
        cand = jc_by_code.get(code)
        if cand is None:
            continue
        klass = class_by_code[code]
        provider_per_input = cand.get("per")
        derived_per_input = e.get("strictDerivedPer") if e.get("strictDerivedPerValid") else None

        dc_base = _data_confidence(cand, provider_per_input)
        dc_mirror = _data_confidence(cand, derived_per_input)
        dc_delta = dc_mirror - dc_base
        dc_delta_by_code[code] = dc_delta

        if _usable_axes(cand, provider_per_input) < 4:
            base_usable_lt4 += 1
        if _usable_axes(cand, derived_per_input) < 4:
            mirror_usable_lt4 += 1

        sf = _status_factor(cand)
        step = sf / 6.0
        if klass == _DERIVED_ONLY:
            expected = step
        elif klass == _PROVIDER_ONLY:
            expected = -step
        else:  # bothValid / bothNull
            expected = 0.0

        if abs(dc_delta - expected) > _FLOAT_TOL:
            dc_unexpected += 1
        if dc_delta > _FLOAT_TOL:
            dc_increase += 1
        elif dc_delta < -_FLOAT_TOL:
            dc_decrease += 1
        else:
            dc_unchanged += 1

        b = base_idx.get(code)
        mrec = mirror_idx.get(code)
        if b is not None and mrec is not None:
            bs = _finite(b.get("marketScore"))
            ms = _finite(mrec.get("marketScore"))
            if bs is not None and ms is not None:
                score_delta_by_code[code] = ms - bs
                score_delta_abs.append(abs(ms - bs))

    parity = {
        "bothValidCount": class_counts[_BOTH_VALID],
        "providerOnlyCount": class_counts[_PROVIDER_ONLY],
        "derivedOnlyCount": class_counts[_DERIVED_ONLY],
        "bothNullCount": class_counts[_BOTH_NULL],
        "dcIncreaseCount": dc_increase,
        "dcDecreaseCount": dc_decrease,
        "dcUnchangedCount": dc_unchanged,
        "unexpectedDcDeltaCount": dc_unexpected,
        "dcIncreaseMatchesDerivedOnly": dc_increase == class_counts[_DERIVED_ONLY],
        "dcDecreaseMatchesProviderOnly": dc_decrease == class_counts[_PROVIDER_ONLY],
        "dcUnchangedMatchesBothValidPlusBothNull": dc_unchanged
        == class_counts[_BOTH_VALID] + class_counts[_BOTH_NULL],
    }

    # ── tier transition decomposition（§14 / §16）───────────────────────
    transition_matrix: dict[str, int] = {}
    decomposition = {
        "valuationDriven": 0,
        "confidenceDriven": 0,
        "combined": 0,
        "unexplained": 0,
    }
    tier_changed = 0
    for code, b in base_idx.items():
        mrec = mirror_idx.get(code)
        if mrec is None:
            continue
        bt = _TIER_OUT.get(b.get("tier"), b.get("tier"))
        mt = _TIER_OUT.get(mrec.get("tier"), mrec.get("tier"))
        top_changed = (code in base_top_set) != (code in mirror_top_set)
        if bt == mt and not top_changed:
            continue
        if bt != mt:
            tier_changed += 1
            key = f"{bt}->{mt}"
            transition_matrix[key] = transition_matrix.get(key, 0) + 1

        klass = class_by_code.get(code, _BOTH_NULL)
        dc_delta = dc_delta_by_code.get(code, 0.0)
        score_delta = score_delta_by_code.get(code, 0.0)
        cand = jc_by_code.get(code, {})
        sf = _status_factor(cand) if isinstance(cand, dict) else 1.0
        step = sf / 6.0

        if abs(dc_delta) <= _FLOAT_TOL:
            if klass in (_BOTH_VALID, _BOTH_NULL):
                decomposition["valuationDriven"] += 1
            else:
                decomposition["unexplained"] += 1
        else:
            expected = step if klass == _DERIVED_ONLY else (-step if klass == _PROVIDER_ONLY else None)
            if expected is not None and abs(dc_delta - expected) <= _FLOAT_TOL:
                if abs(score_delta) <= _FLOAT_TOL:
                    decomposition["confidenceDriven"] += 1
                else:
                    decomposition["combined"] += 1
            else:
                decomposition["unexplained"] += 1

    # ── rank / score mirror metrics（§13）──────────────────────────────
    base_ranks = {
        c["code"]: c["marketRank"]
        for c in baseline_result.get("candidates", [])
        if isinstance(c.get("marketRank"), int)
    }
    mirror_ranks = {
        c["code"]: c["marketRank"]
        for c in mirror_result.get("candidates", [])
        if isinstance(c.get("marketRank"), int)
    }
    common_ranked = [c for c in base_ranks if c in mirror_ranks]
    spearman: Optional[float] = None
    if len(common_ranked) > 1:
        d2 = sum((base_ranks[c] - mirror_ranks[c]) ** 2 for c in common_ranked)
        nn = len(common_ranked)
        spearman = 1.0 - (6.0 * d2) / (nn * (nn * nn - 1))

    score_delta_abs.sort()
    rank_metrics = {
        "top40Jaccard": _jaccard(base_top_set, mirror_top_set),
        "actionableJaccard": _jaccard(base_actionable, mirror_actionable),
        "spearmanRankCorrelation": spearman,
        "top40EntrantCount": len(mirror_top_set - base_top_set),
        "top40LeaverCount": len(base_top_set - mirror_top_set),
        "actionableEntrantCount": len(mirror_actionable - base_actionable),
        "actionableLeaverCount": len(base_actionable - mirror_actionable),
        "marketScoreDeltaMedianAbs": _percentile(score_delta_abs, 50),
        "marketScoreDeltaP90Abs": _percentile(score_delta_abs, 90),
        "marketScoreDeltaMaxAbs": score_delta_abs[-1] if score_delta_abs else None,
        "usableAxesLt4BaselineCount": base_usable_lt4,
        "usableAxesLt4MirrorCount": mirror_usable_lt4,
        "usableAxesLt4Delta": mirror_usable_lt4 - base_usable_lt4,
        "tierChangedCount": tier_changed,
        "tierTransitionMatrix": transition_matrix,
    }

    # ── derivedOnly / providerOnly impact（§12。任意 zero-gate は課さない）──
    derived_only_codes = {c for c, k in class_by_code.items() if k == _DERIVED_ONLY}
    provider_only_codes = {c for c, k in class_by_code.items() if k == _PROVIDER_ONLY}
    impact = {
        "derivedOnlyCount": len(derived_only_codes),
        "derivedOnlyTop40Count": len(derived_only_codes & mirror_top_set),
        "derivedOnlyActionableCount": len(derived_only_codes & mirror_actionable),
        "derivedOnlyTop40Entrants": len(derived_only_codes & (mirror_top_set - base_top_set)),
        "derivedOnlyActionableEntrants": len(derived_only_codes & (mirror_actionable - base_actionable)),
        "providerOnlyCount": len(provider_only_codes),
        "providerOnlyTop40Leavers": len(provider_only_codes & (base_top_set - mirror_top_set)),
        "providerOnlyActionableLeavers": len(provider_only_codes & (base_actionable - mirror_actionable)),
    }

    # ── mirror P-14（§15。P-14 semantics は再定義しない）────────────────
    perturbed_mirror = _perturb_candidates(mirror_candidates)
    perturbed_mirror_result = build_funnel_fn(perturbed_mirror, dict(context))
    mirror_p14_jaccard = _jaccard(
        set(_top_n_codes_ordered(mirror_result, TOP_N_STABILITY)),
        set(_top_n_codes_ordered(perturbed_mirror_result, TOP_N_STABILITY)),
    )

    # ── top40 decision rule（§16）──────────────────────────────────────
    top40_jaccard = rank_metrics["top40Jaccard"]
    top40_movers = (base_top_set ^ mirror_top_set)
    availability_moves = len(
        {c for c in top40_movers if class_by_code.get(c) in (_PROVIDER_ONLY, _DERIVED_ONLY)}
    )
    both_valid_moves = len({c for c in top40_movers if class_by_code.get(c) == _BOTH_VALID})
    both_null_moves = len({c for c in top40_movers if class_by_code.get(c) == _BOTH_NULL})
    unexplained_top40 = len({c for c in top40_movers if c not in class_by_code})
    top40_rule = {
        "jaccard": top40_jaccard,
        "decisionThreshold": TOP40_JACCARD_DECISION_MIN,
        "belowThreshold": top40_jaccard < TOP40_JACCARD_DECISION_MIN,
        "movementDecomposition": {
            "availabilityMovement": availability_moves,
            "bothValidNumericMovement": both_valid_moves,
            "bothNullCrossSectionalMovement": both_null_moves,
            "unexplainedMovement": unexplained_top40,
        },
    }

    aborted = bool(handoff.get("aborted"))
    evidence = {
        "schemaVersion": CALIBRATION_EVIDENCE_SCHEMA,
        "kind": CALIBRATION_EVIDENCE_KIND,
        "not_for_trading": True,
        "generatedAt": now.astimezone(timezone.utc).isoformat()
        if now.tzinfo
        else now.replace(tzinfo=timezone.utc).isoformat(),
        "runIdentity": run_identity,
        "perAuthority": PER_AUTHORITY_PROVIDER,
        "mirrorAuthority": PER_AUTHORITY_DERIVED,
        "providerAccessDelta": 0,
        "publicPerAuthorityChanged": False,
        "productionRankingChanged": False,
        "calibratedSymbolCount": len(entries),
        "availabilityClassCounts": class_counts,
        "perDiagnosticCounts": per_diag_counts,
        "perDiagnosticSumEqualsCalibrated": sum(per_diag_counts.values()) == len(entries),
        "falsePositiveDerivedPerCount": false_positive,
        "numericDerivedPerWithoutAvailableDiagCount": numeric_without_available,
        "bothValidDivergence": divergence,
        "dataConfidenceParity": parity,
        "tierTransitionDecomposition": decomposition,
        "unexplainedTransitionCount": decomposition["unexplained"],
        "rankScoreMirrorMetrics": rank_metrics,
        "derivedOnlyProviderOnlyImpact": impact,
        "mirrorP14Jaccard": mirror_p14_jaccard,
        "mirrorP14JaccardMin": MIRROR_P14_JACCARD_MIN,
        "top40DecisionRule": top40_rule,
        "abort": {"fundamentalsAborted": aborted, "abortReason": handoff.get("abortReason")},
        "structuralStatus": {
            "baselineStatus": baseline_result.get("status"),
            "mirrorStatus": mirror_result.get("status"),
            "structuralMirrorGenerated": mirror_result.get("status") == "generated",
            "actionableMirrorCount": len(mirror_actionable),
        },
        "acceptanceGateSnapshot": {
            "falsePositiveDerivedPerCountZero": false_positive == 0,
            "unexpectedDcDeltaCountZero": dc_unexpected == 0,
            "unexplainedTransitionCountZero": decomposition["unexplained"] == 0,
            "mirrorP14JaccardPass": mirror_p14_jaccard >= MIRROR_P14_JACCARD_MIN,
            "structuralMirrorGenerated": mirror_result.get("status") == "generated",
            "abortFalse": not aborted,
        },
    }
    return evidence


def emit_derived_per_calibration_evidence(evidence: dict[str, Any]) -> Optional[Path]:
    """aggregate evidence を 1 行 log へ、RUNNER_TEMP があれば ephemeral file へ
    書く。data/ ・ public/data/ ・ Pages ・ main へは決して書かない（§19）。"""
    print(
        "  derived PER migration calibration evidence: "
        + json.dumps(evidence, ensure_ascii=False, default=str)
    )
    runner_temp = os.environ.get("RUNNER_TEMP")
    if not runner_temp:
        return None
    try:
        out_path = Path(runner_temp) / CALIBRATION_EVIDENCE_FILENAME
        out_path.write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
        )
        return out_path
    except OSError:
        return None


def load_handoff(path: Optional[Path] = None) -> Optional[dict[str, Any]]:
    """RUNNER_TEMP の calibration handoff を読む。無ければ None（異常ではない —
    fundamentals shadow channel を回さなかった run）。"""
    if path is None:
        runner_temp = os.environ.get("RUNNER_TEMP")
        if not runner_temp:
            return None
        path = Path(runner_temp) / DERIVED_PER_CALIBRATION_HANDOFF_FILENAME
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(raw, dict) or not isinstance(raw.get("entries"), list):
        return None
    return raw


def run_derived_per_calibration(
    *,
    joined_candidates: list[Any],
    context: dict[str, Any],
    baseline_result: dict[str, Any],
    now: datetime,
    run_identity: Optional[dict[str, Any]] = None,
    handoff_path: Optional[Path] = None,
    build_funnel_fn: Callable[[list[Any], dict[str, Any]], dict[str, Any]] = build_candidate_funnel,
) -> Optional[dict[str, Any]]:
    """calibration mirror を回して evidence を emit する。handoff が無い場合は
    None。いかなる例外でも production pipeline を止めない（呼び出し元も握る）。"""
    handoff = load_handoff(handoff_path)
    if handoff is None:
        return None
    evidence = build_derived_per_calibration_evidence(
        handoff=handoff,
        joined_candidates=joined_candidates,
        context=context,
        baseline_result=baseline_result,
        now=now,
        run_identity=run_identity,
        build_funnel_fn=build_funnel_fn,
    )
    emit_derived_per_calibration_evidence(evidence)
    return evidence


def _reconstruct_batch_inputs(now: datetime) -> Optional[dict[str, Any]]:
    """production batch と同一の loader / join / context 構築を read-only で
    再現する（batch module は import するだけで一切変更しない）。candidate
    funnel 生成本体（publish / gate）とは独立した観測専用経路。"""
    from data.candidate_funnel_batch import (
        CANDIDATES_STOCKS_PATH,
        PRESCREEN_METADATA_PATH,
        REGIME_STATE_PATH,
        build_context,
        build_prescreen_index,
        join_candidates_with_prescreen,
        load_candidates_stocks,
        load_prescreen_metadata,
        read_current_regime,
    )

    payload = load_candidates_stocks(CANDIDATES_STOCKS_PATH)
    prescreen_payload = load_prescreen_metadata(PRESCREEN_METADATA_PATH)
    regime = read_current_regime(REGIME_STATE_PATH)
    prescreen_index, _dupes = build_prescreen_index(prescreen_payload)
    joined, _stats = join_candidates_with_prescreen(payload.get("candidates", []), prescreen_index)
    context = build_context(payload, regime, now)
    return {"joined_candidates": joined, "context": context}


def main(argv: list[str] | tuple[str, ...] = ()) -> int:
    """独立 CLI（full_batch.yml から candidate funnel 生成後に呼ばれる）。
    calibration observability は non-blocking —— どんな失敗でも exit 0。"""
    now = datetime.now(timezone.utc)
    try:
        inputs = _reconstruct_batch_inputs(now)
        if inputs is None:
            print("  derived PER calibration: batch inputs unavailable; skipped")
            return 0
        baseline_result = build_candidate_funnel(inputs["joined_candidates"], inputs["context"])
        evidence = run_derived_per_calibration(
            joined_candidates=inputs["joined_candidates"],
            context=inputs["context"],
            baseline_result=baseline_result,
            now=now,
            run_identity={
                "asOf": inputs["context"].get("asOf"),
                "sourceUpdatedAt": inputs["context"].get("sourceUpdatedAt"),
                "pipelinePath": inputs["context"].get("pipelinePath"),
            },
        )
        if evidence is None:
            print("  derived PER calibration: no handoff present; skipped")
    except Exception as e:  # noqa: BLE001 - observability は production を止めない
        print(f"  ⚠ derived PER calibration skipped: {type(e).__name__}: {e}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
