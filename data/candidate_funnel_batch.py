#!/usr/bin/env python3
"""
P5-B005-B2: candidate funnel batch / join / artifact / production-distribution
quality gate。

B1（`data/candidate_funnel_engine.py`, frozen pure engine）を、既存の
whole-market candidate batch（`data/build_candidates_stocks.py` が生成する
`data/candidates_stocks.json`）へ接続する。

責務（B2、frozen — 変更しない）:
  1. prescreen metadata（`data/prescreen_metadata.json`。
     `data.build_candidates_stocks.write_prescreen_metadata` が同一run内で
     生成する、re-fetchしない唯一の永続化先）を candidate へ code join する。
  2. `data.candidate_funnel_engine.build_candidate_funnel()` を呼び出す
     （score/tier計算はこのengine以外で一切行わない）。
  3. `data/candidate_funnel.json` / `public/data/candidate_funnel.json` を
     atomic・fail-closedで生成する。
  4. A2-S §22.2/§25.20 の production-distribution calibration gate
     （P-01..P-15）を実データに対して実行する。

非責務（実装しない）:
  - frontend/store/UIへの接続。
  - portfolioFit・holdings・cash・headroom・SAFE_MODEによるscore変更。
  - BUY_NEW・自動売買・officialDecision。

honesty: このmoduleはjoin・gate・publishのみを行う。score/tier計算・
weight/threshold/reason codeの定義は一切持たない（すべて
candidate_funnel_engine.pyのfrozen定数を唯一のauthorityとして参照する）。
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from data.candidate_funnel_engine import (
    CANDIDATE_FUNNEL_DATA_STATUSES,
    CANDIDATE_FUNNEL_HARD_REASON_CODES,
    CANDIDATE_FUNNEL_PRESCREEN_POOLS,
    CANDIDATE_FUNNEL_REGIMES,
    CANDIDATE_FUNNEL_SCHEMA_VERSION,
    CANDIDATE_FUNNEL_SCORE_VERSION,
    CANDIDATE_FUNNEL_SELECTED_REASON_CODES,
    CANDIDATE_FUNNEL_SOFT_REASON_CODES,
    CANDIDATE_FUNNEL_STATUSES,
    CANDIDATE_FUNNEL_THEME_STATUSES,
    CANDIDATE_FUNNEL_TIERS,
    CANDIDATE_FUNNEL_VERSION,
    build_candidate_funnel,
)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).parent.parent
CANDIDATES_STOCKS_PATH = REPO_ROOT / "data" / "candidates_stocks.json"
PRESCREEN_METADATA_PATH = REPO_ROOT / "data" / "prescreen_metadata.json"
REGIME_STATE_PATH = REPO_ROOT / "public" / "data" / "regime_state.json"
DATA_OUTPUT_PATH = REPO_ROOT / "data" / "candidate_funnel.json"
PUBLIC_OUTPUT_PATH = REPO_ROOT / "public" / "data" / "candidate_funnel.json"

ARTIFACT_META_KIND = "candidate_funnel"

# ---------------------------------------------------------------------------
# A2-S §22.2/§25.20 production-distribution gate thresholds（frozen。
# calibration結果に合わせて緩和しない — A2-S 禁止36）。
# ---------------------------------------------------------------------------

JOIN_RATE_MIN = 0.95  # P-02
UNMATCHED_CODE_RATE_WARN = 0.05  # P-03 記録・調査閾値（非blocking）
MARKET_SCORE_IQR_MIN = 10.0  # P-07
MARKET_SCORE_RANGE_MIN = 40.0  # P-07
DEEP_REVIEW_SECTOR_BREADTH_MIN = 7  # P-10
ACTIONABLE_SECTOR_BREADTH_MIN = 4  # P-10
RANK_STABILITY_JACCARD_MIN = 0.95  # P-14
RANK_DRIFT_WARN_MAX = 0.80  # P-15（warning threshold, non-blocking）
TOP_N_STABILITY = 40
PERTURBATION_PCT = 0.02
P14_ASSIGNMENT_CONTRACT = "p14-prescreen-rank-code-v1"
P14_ASSIGNMENT_NOTE = (
    "assignment=p14-prescreen-rank-code-v1; identity=exact-string-code; "
    "invalid-or-duplicate-identities-do-not-consume-ordinal"
)

# A2-S §25.6: v1では構造的に発火しないはずのSOFT reason（新規/一部を除く）。
# index対応: SOFT_DEEP_DRAWDOWN(2) / SOFT_WEAK_TREND(3) / SOFT_THEME_CROWDING(5) /
# SOFT_PORTFOLIO_OVERLAP(8) — engineのdocstringで "v1 inactive" と明記されている4件。
INACTIVE_V1_SOFT_REASONS: tuple[str, ...] = (
    "SOFT_DEEP_DRAWDOWN",
    "SOFT_WEAK_TREND",
    "SOFT_THEME_CROWDING",
    "SOFT_PORTFOLIO_OVERLAP",
)


class CandidateFunnelBatchError(RuntimeError):
    """fail-closed abort。呼び出し元（main）はこれをexit 1へ変換し、
    既存artifact（あれば）を一切変更せずに保持する。"""


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------


def load_candidates_stocks(path: Path = CANDIDATES_STOCKS_PATH) -> dict[str, Any]:
    """candidates_stocks.jsonを読み込む。不在・破損時はfail-closedで例外を送出する
    （funnelはcandidateの唯一のsourceを欠いたまま生成してはならない）。"""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise CandidateFunnelBatchError(f"failed to read/parse {path}: {e!r}") from e
    if not isinstance(raw, dict) or not isinstance(raw.get("candidates"), list):
        raise CandidateFunnelBatchError(f"{path}: invalid candidates_stocks schema")
    return raw


def load_prescreen_metadata(path: Path = PRESCREEN_METADATA_PATH) -> dict[str, Any] | None:
    """prescreen_metadata.jsonを読み込む。不在（whole-market provider未経由の
    legacy/seed実行等）はNoneを返す — これは異常ではなく「今回のrunでは
    prescreen joinの母集団が存在しない」ことを意味し、後続のjoinは
    0件matchとして安全に扱われる（P-02 join率gateがfail-closedで検出する）。
    破損（存在するが不正）はfail-closedで例外を送出する（silent quiet
    degradationにしない）。"""
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise CandidateFunnelBatchError(f"failed to read/parse {path}: {e!r}") from e
    if not isinstance(raw, dict) or not isinstance(raw.get("entries"), list):
        raise CandidateFunnelBatchError(f"{path}: invalid prescreen_metadata schema")
    return raw


def read_current_regime(path: Path = REGIME_STATE_PATH) -> str | None:
    """regime_state.jsonからcurrent_regimeを読む。不在・破損・未知値は
    すべてNone（engineのneutral fallback、A2-S §25.7）を返す — 例外は
    送出しない（regime_wiring.read_is_crisisと同じ規律）。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        regime = data["regime_state"]["current_regime"]
    except (FileNotFoundError, OSError, json.JSONDecodeError, KeyError, TypeError):
        return None
    if regime not in CANDIDATE_FUNNEL_REGIMES:
        return None
    return regime


def load_previous_artifact(path: Path = DATA_OUTPUT_PATH) -> dict[str, Any] | None:
    """P-15用: 前回artifactを読む。不在・破損はNone（baseline無し扱い、
    P-15は「記録」項目でありbaseline無しはfailureではない）。"""
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return raw if isinstance(raw, dict) else None


# ---------------------------------------------------------------------------
# Join contract（A2-S authority hierarchy §12 candidate identity: codeは
# canonical文字列identityとして扱う。numeric coercion禁止、str()生成禁止）
# ---------------------------------------------------------------------------


def build_prescreen_index(
    prescreen_payload: dict[str, Any] | None,
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """prescreen_metadata payloadから code -> {prescreenScore/Rank/Pool} の
    indexを組み立てる。

    戻り値: (index, duplicate_codes)。duplicate_codesが非空の場合、
    重複したcodeはindexに一切含まれない（dedupe/先勝ち/後勝ち禁止 —
    A2-S 禁止19の精神をprescreen側の join 前処理にも適用する）。
    呼び出し元はduplicate_codesが非空ならfail-closedで扱うこと。"""
    if prescreen_payload is None:
        return {}, []
    entries = prescreen_payload.get("entries")
    if not isinstance(entries, list):
        return {}, []

    code_counts: dict[str, int] = {}
    for e in entries:
        if not isinstance(e, dict):
            continue
        code = e.get("code")
        if isinstance(code, str) and code != "":
            code_counts[code] = code_counts.get(code, 0) + 1
    duplicate_codes = sorted(c for c, n in code_counts.items() if n > 1)
    duplicate_set = set(duplicate_codes)

    index: dict[str, dict[str, Any]] = {}
    for e in entries:
        if not isinstance(e, dict):
            continue
        code = e.get("code")
        if not isinstance(code, str) or code == "" or code in duplicate_set:
            continue
        index[code] = {
            "prescreenScore": e.get("prescreenScore"),
            "prescreenRank": e.get("prescreenRank"),
            "prescreenPool": e.get("prescreenPool"),
        }
    return index, duplicate_codes


def compute_candidate_duplicate_codes(candidates: list[Any]) -> list[str]:
    """candidates_stocks.candidates側のduplicate code検出（P-04）。
    join実装ではなく上流enrichment/publishの欠陥を示す。"""
    code_counts: dict[str, int] = {}
    for c in candidates:
        if isinstance(c, dict):
            code = c.get("code")
            if isinstance(code, str) and code != "":
                code_counts[code] = code_counts.get(code, 0) + 1
    return sorted(c for c, n in code_counts.items() if n > 1)


def join_candidates_with_prescreen(
    candidates: list[Any], prescreen_index: dict[str, dict[str, Any]]
) -> tuple[list[Any], dict[str, Any]]:
    """candidateへprescreen metadataをcode joinする。

    規律:
      - joinはcandidate['code']が文字列である場合のみ試みる（数値化・str()
        変換は一切行わない — 入力側のcode型が不正なcandidateはengine側の
        HARD_CONTRACT_VIOLATIONへそのまま渡す）。
      - name/index/sector/fuzzy joinは行わない（code完全一致のみ）。
      - candidate側のduplicate codeはdedupeしない。両方に等しくprescreenを
        joinしたうえでそのままengineへ渡す（engineがHARD_CONTRACT_VIOLATION
        + DUPLICATE_CANDIDATE_CODEで自律的にexcluded化する。A2-S §25.16）。
      - unmatched candidateはprescreenScore等を一切追加しない（キー自体を
        追加しない）→ engineが SOFT_PRESCREEN_METADATA_MISSING で
        frozen既定どおりに扱う。

    戻り値: (joined_candidates, join_stats)。joined_candidatesは入力
    candidatesの各要素をshallow copyした新しいlist（入力は変更しない）。"""
    joined: list[Any] = []
    matched_count = 0
    candidate_codes_seen: set[str] = set()

    for c in candidates:
        if not isinstance(c, dict):
            joined.append(c)
            continue
        new_c = dict(c)
        code = c.get("code")
        if isinstance(code, str):
            candidate_codes_seen.add(code)
        match = prescreen_index.get(code) if isinstance(code, str) else None
        if match is not None:
            new_c["prescreenScore"] = match["prescreenScore"]
            new_c["prescreenRank"] = match["prescreenRank"]
            new_c["prescreenPool"] = match["prescreenPool"]
            matched_count += 1
        joined.append(new_c)

    unmatched_prescreen_codes = sorted(set(prescreen_index) - candidate_codes_seen)
    total = len(candidates)
    join_stats = {
        "candidateCount": total,
        "prescreenCount": len(prescreen_index),
        "joinedCount": matched_count,
        "unmatchedCandidateCount": total - matched_count,
        "unmatchedPrescreenCount": len(unmatched_prescreen_codes),
        "joinRate": (matched_count / total) if total else 0.0,
        "unmatchedCandidateRate": ((total - matched_count) / total) if total else 0.0,
    }
    return joined, join_stats


# ---------------------------------------------------------------------------
# Context contract（B1 engineへ渡すcontext。caller-supplied asOf以外は
# candidates_stocks.json由来の値をそのままechoする。malformed値を
# batch側でnormalへsilent coercionしない）
# ---------------------------------------------------------------------------


def build_context(
    candidates_stocks_payload: dict[str, Any], regime: str | None, now: datetime
) -> dict[str, Any]:
    meta = candidates_stocks_payload.get("_meta")
    meta = meta if isinstance(meta, dict) else {}
    provenance = meta.get("universeProvenance")
    provenance = provenance if isinstance(provenance, dict) else {}

    return {
        # meta.pipelinePath は whole-market provider経由のrunにのみ存在する。
        # 存在しない（seed_list default provider使用時）場合はNoneをそのまま
        # 渡す — "normal"への silent coercion は禁止（A2-S2 §19.15 PP-07: None
        # は screened 上限のfail-closed動作になる、これはfrozen仕様どおり）。
        "pipelinePath": meta.get("pipelinePath"),
        "regime": regime,
        "sourceUpdatedAt": candidates_stocks_payload.get("sourceUpdatedAt"),
        "asOf": now.isoformat(),
        "staleThresholdHours": candidates_stocks_payload.get("staleThresholdHours"),
        "prescreenFallbackUsed": bool(provenance.get("shortlistFallbackUsed", False)),
    }


# ---------------------------------------------------------------------------
# Quality gate computations（P-01..P-15、A2-S §22.2/§25.20 exact）
# ---------------------------------------------------------------------------


def _percentile(sorted_vals: list[float], pct: float) -> float | None:
    """numpy.percentile(kind='linear')相当。engine内部のwinsorized rankとは
    独立の、報告専用の記述統計（scoring authorityではない）。"""
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
    frac = idx - lo
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * frac


def _non_excluded_candidates(engine_result: dict[str, Any]) -> list[dict[str, Any]]:
    return [c for c in engine_result.get("candidates", []) if c.get("tier") != "excluded"]


def compute_market_score_stats(engine_result: dict[str, Any]) -> dict[str, Any]:
    vals = sorted(
        c["marketScore"] for c in _non_excluded_candidates(engine_result) if isinstance(c.get("marketScore"), (int, float))
    )
    if not vals:
        return {"count": 0, "min": None, "max": None, "range": None, "p25": None, "p75": None, "iqr": None, "median": None}
    p25 = _percentile(vals, 25)
    p75 = _percentile(vals, 75)
    return {
        "count": len(vals),
        "min": vals[0],
        "max": vals[-1],
        "range": vals[-1] - vals[0],
        "p25": p25,
        "p75": p75,
        "iqr": (p75 - p25) if (p25 is not None and p75 is not None) else None,
        "median": _percentile(vals, 50),
    }


def _usable_axes_count(raw: Any) -> int:
    """engineの_classify_numeric_fieldと同一規律（bool除外・非有限除外）で
    per/pbr/roe/dividendYield/sigma252d/mom3mのusableAxes数を再現する
    （報告専用。scoring authorityはengine内部のまま変更しない）。"""
    if not isinstance(raw, dict):
        return 0
    count = 0
    for field in ("per", "pbr", "roe", "dividendYield", "sigma252d", "mom3m"):
        v = raw.get(field)
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            continue
        if math.isfinite(float(v)):
            count += 1
    return count


def compute_data_confidence_stats(engine_result: dict[str, Any], joined_candidates: list[Any]) -> dict[str, Any]:
    """P-06: dataConfidence分布 + usableAxes<=4件数（A2-S §22.2「4軸以下の件数」）。
    usableAxesはengine出力からは正確に復元できない（valuationがper/pbr/dividendYield
    3件を1つのcombined statusへ畳み込むため）ので、joined_candidates（engineへの
    入力そのもの、engine_result['candidates']と位置対応）から直接再計算する。"""
    non_excluded_indices = [i for i, c in enumerate(engine_result.get("candidates", [])) if c.get("tier") != "excluded"]
    vals = sorted(
        engine_result["candidates"][i]["dataConfidence"]
        for i in non_excluded_indices
        if isinstance(engine_result["candidates"][i].get("dataConfidence"), (int, float))
    )
    at_or_below_4_axes = sum(
        1 for i in non_excluded_indices if i < len(joined_candidates) and _usable_axes_count(joined_candidates[i]) <= 4
    )
    if not vals:
        return {"count": 0, "min": None, "p25": None, "median": None, "p75": None, "max": None, "atOrBelow4AxesCount": at_or_below_4_axes}
    return {
        "count": len(vals),
        "min": vals[0],
        "p25": _percentile(vals, 25),
        "median": _percentile(vals, 50),
        "p75": _percentile(vals, 75),
        "max": vals[-1],
        "atOrBelow4AxesCount": at_or_below_4_axes,
    }


def compute_reason_code_distribution(
    engine_result: dict[str, Any],
) -> tuple[dict[str, int], dict[str, int], list[str]]:
    soft_counts = {code: 0 for code in CANDIDATE_FUNNEL_SOFT_REASON_CODES}
    hard_counts = {code: 0 for code in CANDIDATE_FUNNEL_HARD_REASON_CODES}
    for c in engine_result.get("candidates", []):
        for r in c.get("riskReasons") or []:
            if r in soft_counts:
                soft_counts[r] += 1
        for r in c.get("hardExclusionReasons") or []:
            if r in hard_counts:
                hard_counts[r] += 1
    inactive_nonzero = [code for code in INACTIVE_V1_SOFT_REASONS if soft_counts.get(code, 0) > 0]
    return soft_counts, hard_counts, inactive_nonzero


def _p14_canonical_sign_by_code(candidates: list[Any]) -> dict[str, int]:
    """P-14のperturbation signをsemantic identityから決定する。

    valid unique codeだけを、valid prescreenRank昇順・exact code昇順で
    canonicalizeする。missing/invalid rankはvalid rankの後でcode昇順。
    duplicate/invalid identityはsignを持たずordinalも消費しない。
    """
    code_counts: dict[str, int] = {}
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        code = candidate.get("code")
        if isinstance(code, str) and code != "":
            code_counts[code] = code_counts.get(code, 0) + 1

    eligible: list[tuple[tuple[int, int, str], str]] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        code = candidate.get("code")
        if not isinstance(code, str) or code == "" or code_counts.get(code) != 1:
            continue
        rank = candidate.get("prescreenRank")
        rank_is_valid = isinstance(rank, int) and not isinstance(rank, bool) and rank > 0
        canonical_key = (0, rank, code) if rank_is_valid else (1, 0, code)
        eligible.append((canonical_key, code))

    eligible.sort(key=lambda item: item[0])
    return {
        code: (1 if canonical_ordinal % 2 == 0 else -1)
        for canonical_ordinal, (_key, code) in enumerate(eligible)
    }


def _perturb_candidates(candidates: list[Any]) -> list[Any]:
    """A2-S §22.1 CAL-11/12と同一の固定perturbation vector
    （canonical ordinal偶奇で±2%をper/roeへ交互適用、乱数不使用・
    決定的）を、実データ（joined candidates）のpresentation orderを
    変えずに適用する。"""
    sign_by_code = _p14_canonical_sign_by_code(candidates)
    perturbed: list[Any] = []
    for c in candidates:
        if not isinstance(c, dict):
            perturbed.append(c)
            continue
        nc = dict(c)
        code = c.get("code")
        sign = sign_by_code.get(code) if isinstance(code, str) else None
        if sign is None:
            perturbed.append(nc)
            continue
        per = nc.get("per")
        if isinstance(per, (int, float)) and not isinstance(per, bool):
            nc["per"] = per * (1 + sign * PERTURBATION_PCT)
        roe = nc.get("roe")
        if isinstance(roe, (int, float)) and not isinstance(roe, bool):
            nc["roe"] = roe * (1 - sign * PERTURBATION_PCT)
        perturbed.append(nc)
    return perturbed


def _top_n_codes_ordered(result: dict[str, Any], n: int = TOP_N_STABILITY) -> list[str]:
    ranked = [c for c in result.get("candidates", []) if c.get("marketRank") is not None]
    ranked.sort(key=lambda c: c["marketRank"])
    return [c["code"] for c in ranked[:n]]


def _jaccard(a: set[str], b: set[str]) -> float:
    union = a | b
    if not union:
        return 1.0
    return len(a & b) / len(union)


def compute_degraded_path_actionable(joined_candidates: list[Any], context: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """P-13: 実際のjoined候補集団に対し、context.pipelinePathを'cache_fallback'
    へ強制したmirror runを実行しactionable件数を確認する。P-14の±2%
    perturbation mirrorと同じ考え方——今回のrunが偶然normalであっても、
    実データに対する具体的な証拠を毎回得る（vacuous passを避ける）。"""
    degraded_context = dict(context)
    degraded_context["pipelinePath"] = "cache_fallback"
    degraded_result = build_candidate_funnel(joined_candidates, degraded_context)
    return degraded_result.get("counts", {}).get("actionable", 0), degraded_result


def compute_rank_stability(
    joined_candidates: list[Any], context: dict[str, Any], engine_result: dict[str, Any]
) -> tuple[float, dict[str, Any]]:
    """P-14: ±2% perturbationでのtop-40 Jaccard安定性（B1 CAL-11/12と同一
    perturbation式を実データへ適用する production mirror）。"""
    perturbed_candidates = _perturb_candidates(joined_candidates)
    perturbed_result = build_candidate_funnel(perturbed_candidates, context)
    base_top = set(_top_n_codes_ordered(engine_result))
    perturbed_top = set(_top_n_codes_ordered(perturbed_result))
    return _jaccard(base_top, perturbed_top), perturbed_result


def compute_rank_drift_vs_previous(
    engine_result: dict[str, Any], previous_artifact: dict[str, Any] | None
) -> float | None:
    """P-15: 前回artifactとのtop-40 Jaccard rank drift。baseline無し（初回run
    または前回status!=generated）はNone（記録項目でありfailureではない）。"""
    if not previous_artifact or previous_artifact.get("status") != "generated":
        return None
    current_top = set(_top_n_codes_ordered(engine_result))
    previous_top = set(_top_n_codes_ordered(previous_artifact))
    return _jaccard(current_top, previous_top)


def compute_quality_report(
    *,
    candidates_stocks_payload: dict[str, Any],
    joined_candidates: list[Any],
    join_stats: dict[str, Any],
    prescreen_duplicate_codes: list[str],
    engine_result: dict[str, Any],
    context: dict[str, Any],
    previous_artifact: dict[str, Any] | None,
) -> dict[str, Any]:
    """A2-S §22.2/§25.20 P-01..P-15を実データに対して評価する。
    thresholdは一切緩和しない（A2-S 禁止36）。synthetic fixtureをここでの
    evidenceとして使わない — 呼び出し元は常に実candidates_stocks.jsonを渡す。"""
    gates: list[dict[str, Any]] = []
    hard_fail_ids: list[str] = []

    def _gate(gate_id: str, metric: str, value: Any, threshold: str, status: str, note: str = "") -> None:
        gates.append({"id": gate_id, "metric": metric, "value": value, "threshold": threshold, "status": status, "note": note})
        if status == "FAIL":
            hard_fail_ids.append(gate_id)

    status = engine_result.get("status")
    candidate_count = join_stats["candidateCount"]

    # P-01: candidate総数（記録）
    _gate("P-01", "candidate総数", candidate_count, "記録", "RECORD")

    if status != "generated":
        # not_generated（seed_fallback等）: engine自体がfrozen仕様どおり
        # funnelを生成しない選択をしているため、P-02以降は評価不能(N/A)。
        # publishはしない（overallPass=False）— data/build_candidates_stocks.py
        # のstale-fallback guard（新結果がempty相当かつ既存fileがfreshなら
        # 上書きしない）と同じ規律: 既存の正常なartifactを"not_generated"の
        # 空artifactで置き換えることは、honestyを損なう（B1-Vの degraded
        # path failure policy: seed fallback → 前回良好artifactを保持）。
        for gate_id, metric in [
            ("P-02", "prescreen join率"), ("P-03", "unmatched candidate率"),
            ("P-04", "duplicate code率"), ("P-05", "missing prescreen率"),
            ("P-06", "dataConfidence分布"), ("P-07", "marketScore分布"),
            ("P-08", "deep-review件数"), ("P-09", "actionable件数"),
            ("P-10", "sector breadth"), ("P-11", "cap overflow"),
            ("P-12", "reason code分布"), ("P-13", "degraded path actionable"),
            ("P-14", "rank stability Jaccard"), ("P-15", "rank drift vs previous"),
        ]:
            _gate(gate_id, metric, None, "N/A", "N/A", note=f"status={status}のため評価対象外")
        return {
            "gates": gates,
            "overallPass": False,
            "hardFailIds": [],
            "notes": [
                f"status={status}（not_generated）のため新規artifactをpublishしない"
                "（既存artifactがあればそのまま保持、frozenなdegraded path failure policy）",
            ],
        }

    # P-02: prescreen join率 >= 0.95
    join_rate = join_stats["joinRate"]
    _gate("P-02", "prescreen join率", join_rate, f">= {JOIN_RATE_MIN}", "PASS" if join_rate >= JOIN_RATE_MIN else "FAIL")

    # P-03: unmatched candidate率（記録・調査閾値0.05）
    unmatched_rate = join_stats["unmatchedCandidateRate"]
    _gate(
        "P-03", "unmatched candidate率", unmatched_rate, f"記録（> {UNMATCHED_CODE_RATE_WARN} で要調査）",
        "WARN" if unmatched_rate > UNMATCHED_CODE_RATE_WARN else "RECORD",
    )

    # P-04: candidate側 duplicate code率 == 0
    candidate_dup_codes = compute_candidate_duplicate_codes(candidates_stocks_payload.get("candidates", []))
    dup_rate = (len(candidate_dup_codes) / candidate_count) if candidate_count else 0.0
    _gate("P-04", "duplicate code率（candidate側）", dup_rate, "== 0", "PASS" if not candidate_dup_codes else "FAIL", note=str(candidate_dup_codes))

    # 補足gate（P-04と独立）: prescreen側duplicateはfail-closed（A2-S authority
    # hierarchy §12の精神 — dedupe/先勝ち/後勝ちで安全に扱えない場合は publish しない）。
    _gate(
        "PRESCREEN_DUPLICATE", "duplicate code（prescreen側）", len(prescreen_duplicate_codes), "== 0",
        "PASS" if not prescreen_duplicate_codes else "FAIL", note=str(prescreen_duplicate_codes),
    )

    # P-05: missing prescreen率（engine出力のprescreenScore is Noneベース。P-02/P-03と整合すること）
    non_excluded = _non_excluded_candidates(engine_result)
    missing_prescreen_count = sum(1 for c in non_excluded if c.get("prescreenScore") is None)
    missing_prescreen_rate = (missing_prescreen_count / len(non_excluded)) if non_excluded else 0.0
    _gate("P-05", "missing prescreen率（engine出力ベース）", missing_prescreen_rate, "記録。P-02と整合", "RECORD")

    # P-06: dataConfidence分布（記録）
    dc_stats = compute_data_confidence_stats(engine_result, joined_candidates)
    _gate("P-06", "dataConfidence分布", dc_stats, "記録", "RECORD")

    # P-07: marketScore分布 IQR>=10.0 かつ range>=40.0
    ms_stats = compute_market_score_stats(engine_result)
    iqr = ms_stats["iqr"]
    rng = ms_stats["range"]
    p07_pass = iqr is not None and rng is not None and iqr >= MARKET_SCORE_IQR_MIN and rng >= MARKET_SCORE_RANGE_MIN
    _gate("P-07", "marketScore分布(IQR/range)", ms_stats, f"IQR>={MARKET_SCORE_IQR_MIN} かつ range>={MARKET_SCORE_RANGE_MIN}", "PASS" if p07_pass else "FAIL")

    # P-08: deep-review件数（0ならgate fail）
    deep_review_count = engine_result.get("counts", {}).get("deepReview", 0)
    _gate("P-08", "deep-review件数", deep_review_count, "> 0", "PASS" if deep_review_count > 0 else "FAIL")

    # P-09: actionable件数（記録。0ならreason code分布で説明できること = 非blocking）
    actionable_count = engine_result.get("counts", {}).get("actionable", 0)
    soft_counts, hard_counts, inactive_nonzero = compute_reason_code_distribution(engine_result)
    _gate(
        "P-09", "actionable件数", actionable_count, "記録。0の場合はreason分布で説明可能なこと",
        "WARN" if actionable_count == 0 else "RECORD",
    )

    # P-10: sector breadth（deep-review>=7、actionable>=4）
    sector_dist = engine_result.get("sectorDistribution", {})
    deep_sector_breadth = len(sector_dist.get("deepReview", {}))
    actionable_sector_breadth = len(sector_dist.get("actionable", {}))
    p10_pass = deep_sector_breadth >= DEEP_REVIEW_SECTOR_BREADTH_MIN and actionable_sector_breadth >= ACTIONABLE_SECTOR_BREADTH_MIN
    _gate(
        "P-10", "sector breadth(deepReview/actionable)",
        {"deepReview": deep_sector_breadth, "actionable": actionable_sector_breadth},
        f"deepReview>={DEEP_REVIEW_SECTOR_BREADTH_MIN} かつ actionable>={ACTIONABLE_SECTOR_BREADTH_MIN}",
        "PASS" if p10_pass else "FAIL",
    )

    # P-11: cap overflow件数（記録）
    obs = engine_result.get("selectionObservability", {})
    cap_overflow = {
        "deepReviewSectorCapOverflow": obs.get("deepReviewSectorCapOverflow"),
        "actionableSectorCapOverflow": obs.get("actionableSectorCapOverflow"),
        "deepReviewEligibleMinusSelected": obs.get("deepReviewEligibleCount", 0) - obs.get("deepReviewSelectedCount", 0),
        "actionableEligibleMinusSelected": obs.get("actionableEligibleCount", 0) - obs.get("actionableSelectedCount", 0),
    }
    _gate("P-11", "cap overflow", cap_overflow, "記録", "RECORD")

    # P-12: reason code分布（記録。v1 inactive 4件が0件であること）
    _gate(
        "P-12", "reason code分布(soft/hard)", {"soft": soft_counts, "hard": hard_counts},
        "記録。v1 inactive 4件は0件であること", "PASS" if not inactive_nonzero else "FAIL",
        note=f"non-zero inactive reasons: {inactive_nonzero}" if inactive_nonzero else "",
    )

    # P-13: degraded path actionable == 0
    # 今回のrunが実際にdegraded pathか（pipelinePath!='normal'/prescreen fallback/
    # stale）を確認するだけでは、通常運用日には毎回vacuousにPASSしてしまい実データに
    # 対する証拠にならない。P-14の±2% perturbation mirrorと同じ厳密さで、実際の
    # joined候補集団に対してpipelinePath='cache_fallback'を強制したmirror runを
    # 毎回実行し、そのactionable件数が実際に0であることを直接確認する。
    pipeline_path = context.get("pipelinePath")
    is_degraded = pipeline_path != "normal" or bool(context.get("prescreenFallbackUsed")) or bool(obs.get("sourceStale"))
    degraded_mirror_actionable, _degraded_mirror_result = compute_degraded_path_actionable(joined_candidates, context)
    p13_pass = degraded_mirror_actionable == 0 and ((not is_degraded) or actionable_count == 0)
    _gate(
        "P-13", "degraded path actionable",
        {"currentRunActionable": actionable_count, "cacheFallbackMirrorActionable": degraded_mirror_actionable},
        "現在runがdegradedならactionable==0、かつcache_fallback mirrorでactionable==0",
        "PASS" if p13_pass else "FAIL", note=f"is_degraded={is_degraded}",
    )

    # P-14: rank stability Jaccard（±2% perturbation）>= 0.95
    jaccard_14, _perturbed_result = compute_rank_stability(joined_candidates, context, engine_result)
    _gate(
        "P-14",
        "rank stability Jaccard(±2%)",
        jaccard_14,
        f">= {RANK_STABILITY_JACCARD_MIN}",
        "PASS" if jaccard_14 >= RANK_STABILITY_JACCARD_MIN else "FAIL",
        note=P14_ASSIGNMENT_NOTE,
    )

    # P-15: rank drift vs previous artifact（記録。< 0.80で警告のみ）
    drift_15 = compute_rank_drift_vs_previous(engine_result, previous_artifact)
    if drift_15 is None:
        _gate("P-15", "rank drift vs previous", None, "記録", "RECORD", note="baseline無し（初回run or 前回not_generated）")
    else:
        _gate("P-15", "rank drift vs previous", drift_15, f"記録。< {RANK_DRIFT_WARN_MAX} で要調査", "WARN" if drift_15 < RANK_DRIFT_WARN_MAX else "RECORD")

    overall_pass = not hard_fail_ids
    return {"gates": gates, "overallPass": overall_pass, "hardFailIds": hard_fail_ids, "notes": []}


# ---------------------------------------------------------------------------
# Artifact構築 / atomic publish
# ---------------------------------------------------------------------------


def build_artifact_payload(
    *,
    engine_result: dict[str, Any],
    join_stats: dict[str, Any],
    context: dict[str, Any],
    quality_report: dict[str, Any],
    now: datetime,
) -> dict[str, Any]:
    """engineの出力（frozen、無変更）+ `_meta`（batch provenance/join/quality
    gate結果）でartifactを組み立てる。engine自身の12 top-level keyは一切
    変更・追加しない（TS contract / parity testの対象はengine出力のみ）。"""
    meta = {
        "kind": ARTIFACT_META_KIND,
        "not_for_trading": True,
        "generatedAt": now.isoformat(),
        "asOf": context.get("asOf"),
        "sourceUpdatedAt": context.get("sourceUpdatedAt"),
        "pipelinePath": context.get("pipelinePath"),
        "regimeRequested": context.get("regime"),
        "join": join_stats,
        "qualityGate": quality_report,
    }
    return {**engine_result, "_meta": meta}


def validate_artifact_schema(artifact: dict[str, Any]) -> list[str]:
    """publish前のschema validation（B1 engine output + _meta wrapper）。
    B1 engineのfrozen shapeそのものを再定義しない — 既知のenum/必須keyのみ
    軽量に確認する（詳細なkey集合exactnessはcandidate_funnel_privacy_smoke
    が担当する）。"""
    violations: list[str] = []
    if artifact.get("schemaVersion") != CANDIDATE_FUNNEL_SCHEMA_VERSION:
        violations.append("schemaVersion mismatch")
    if artifact.get("funnelVersion") != CANDIDATE_FUNNEL_VERSION:
        violations.append("funnelVersion mismatch")
    if artifact.get("scoreVersion") != CANDIDATE_FUNNEL_SCORE_VERSION:
        violations.append("scoreVersion mismatch")
    if artifact.get("not_for_trading") is not True:
        violations.append("not_for_trading is not True")
    if artifact.get("status") not in CANDIDATE_FUNNEL_STATUSES:
        violations.append("status not in allowed enum")
    if not isinstance(artifact.get("candidates"), list):
        violations.append("candidates is not a list")
    if not isinstance(artifact.get("_meta"), dict):
        violations.append("_meta is not a dict")
    for c in artifact.get("candidates", []):
        if not isinstance(c, dict):
            violations.append("candidate entry is not a dict")
            continue
        code = c.get("code")
        if not isinstance(code, str) or code == "":
            violations.append(f"candidate {code!r} has invalid exact-string code")
        if c.get("tier") not in CANDIDATE_FUNNEL_TIERS:
            violations.append(f"candidate {c.get('code')!r} has invalid tier {c.get('tier')!r}")
        if c.get("prescreenPool") is not None and c.get("prescreenPool") not in CANDIDATE_FUNNEL_PRESCREEN_POOLS:
            violations.append(f"candidate {c.get('code')!r} has invalid prescreenPool")
        if c.get("dataStatus") is not None and c.get("dataStatus") not in CANDIDATE_FUNNEL_DATA_STATUSES:
            violations.append(f"candidate {c.get('code')!r} has invalid dataStatus")
        if c.get("themeStatus") not in CANDIDATE_FUNNEL_THEME_STATUSES:
            violations.append(f"candidate {c.get('code')!r} has invalid themeStatus")
        for r in c.get("selectedReasons") or []:
            if r not in CANDIDATE_FUNNEL_SELECTED_REASON_CODES:
                violations.append(f"candidate {c.get('code')!r} has invalid selectedReasons {r!r}")
        for r in c.get("riskReasons") or []:
            if r not in CANDIDATE_FUNNEL_SOFT_REASON_CODES:
                violations.append(f"candidate {c.get('code')!r} has invalid riskReasons {r!r}")
        for r in c.get("hardExclusionReasons") or []:
            if r not in CANDIDATE_FUNNEL_HARD_REASON_CODES:
                violations.append(f"candidate {c.get('code')!r} has invalid hardExclusionReasons {r!r}")
    return violations


def atomic_write_text(path: Path, text: str) -> None:
    """同一ディレクトリの一時fileへ書き切ってからatomic replaceする
    （half-written JSONをpublishしない）。単一fileのみのatomicity。
    data/public 2fileをペアとして扱う場合はpublish_artifact()を使うこと。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(path.name + ".tmp")
    try:
        tmp_path.write_text(text, encoding="utf-8")
        tmp_path.replace(path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def publish_artifact(
    artifact: dict[str, Any],
    data_path: Path = DATA_OUTPUT_PATH,
    public_path: Path = PUBLIC_OUTPUT_PATH,
) -> None:
    """data/public両方へ同一シリアライズ結果をpairとしてatomic writeする
    （byte-for-byte一致を保証するため、シリアライズは1回だけ行う）。

    2fileをペアで扱う: 両方のtmp fileを先に書き切ってから両方をreplaceし、
    2件目のreplaceが失敗した場合は1件目を書き換え前の内容へrollbackする。
    バックアップ読み込み・各write/replace・rollback自体のいずれの段階で
    例外が発生してもtmp fileを孤立させず、rollback自体が失敗した場合も
    元の例外を握り潰さない（`raise ... from`で両方を保持する）。
    プロセスが2回のos.replace呼び出しの間でkillされる極端なcaseのみが
    対処範囲外として残る（ephemeral CI runでは次回runが自己修復する）。"""
    text = json.dumps(artifact, ensure_ascii=False, indent=2)

    data_path.parent.mkdir(parents=True, exist_ok=True)
    public_path.parent.mkdir(parents=True, exist_ok=True)
    data_tmp = data_path.with_name(data_path.name + ".tmp")
    public_tmp = public_path.with_name(public_path.name + ".tmp")

    def _cleanup_tmps() -> None:
        data_tmp.unlink(missing_ok=True)
        public_tmp.unlink(missing_ok=True)

    try:
        data_backup = data_path.read_bytes() if data_path.exists() else None
    except BaseException:
        _cleanup_tmps()
        raise

    try:
        data_tmp.write_text(text, encoding="utf-8")
        public_tmp.write_text(text, encoding="utf-8")
    except BaseException:
        _cleanup_tmps()
        raise

    try:
        data_tmp.replace(data_path)
    except BaseException:
        _cleanup_tmps()
        raise

    try:
        public_tmp.replace(public_path)
    except BaseException as public_replace_error:
        try:
            if data_backup is None:
                data_path.unlink(missing_ok=True)
            else:
                data_path.write_bytes(data_backup)
        except BaseException as rollback_error:
            raise RuntimeError(
                f"public replace failed ({public_replace_error!r}) AND rollback of the data "
                f"copy also failed ({rollback_error!r}); data/public may now be inconsistent "
                "and require manual inspection"
            ) from public_replace_error
        finally:
            public_tmp.unlink(missing_ok=True)
        raise


# ---------------------------------------------------------------------------
# Main entrypoint
# ---------------------------------------------------------------------------


def run_batch(
    *,
    candidates_stocks_path: Path = CANDIDATES_STOCKS_PATH,
    prescreen_metadata_path: Path = PRESCREEN_METADATA_PATH,
    regime_state_path: Path = REGIME_STATE_PATH,
    previous_artifact_path: Path = DATA_OUTPUT_PATH,
    now: datetime | None = None,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """join→context構築→build_candidate_funnel()呼出→quality gate計算を行う
    純粋寄りのオーケストレーション関数（file書き込みはしない — publishは
    呼び出し元がgate結果を見てから明示的に行う）。

    戻り値: (artifact_or_None, report)。artifactはoverallPass=Trueの場合のみ
    非None（fail-closed — 呼び出し元はoverallPass=Falseの場合、artifactが
    Noneであっても内容を絶対にpublishしてはならない）。"""
    if now is None:
        now = datetime.now(timezone.utc)

    candidates_stocks_payload = load_candidates_stocks(candidates_stocks_path)
    prescreen_payload = load_prescreen_metadata(prescreen_metadata_path)
    regime = read_current_regime(regime_state_path)
    previous_artifact = load_previous_artifact(previous_artifact_path)

    prescreen_index, prescreen_duplicate_codes = build_prescreen_index(prescreen_payload)
    candidates = candidates_stocks_payload.get("candidates", [])
    joined_candidates, join_stats = join_candidates_with_prescreen(candidates, prescreen_index)

    context = build_context(candidates_stocks_payload, regime, now)

    engine_result = build_candidate_funnel(joined_candidates, context)

    quality_report = compute_quality_report(
        candidates_stocks_payload=candidates_stocks_payload,
        joined_candidates=joined_candidates,
        join_stats=join_stats,
        prescreen_duplicate_codes=prescreen_duplicate_codes,
        engine_result=engine_result,
        context=context,
        previous_artifact=previous_artifact,
    )

    report = {
        "context": context,
        "joinStats": join_stats,
        "prescreenDuplicateCodes": prescreen_duplicate_codes,
        "qualityGate": quality_report,
        "engineStatus": engine_result.get("status"),
    }

    if not quality_report["overallPass"]:
        return None, report

    artifact = build_artifact_payload(
        engine_result=engine_result,
        join_stats=join_stats,
        context=context,
        quality_report=quality_report,
        now=now,
    )
    schema_violations = validate_artifact_schema(artifact)
    if schema_violations:
        report["schemaViolations"] = schema_violations
        return None, report

    return artifact, report


def main(argv: list[str] | tuple[str, ...] = ()) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="publishせずgate結果のみ表示する")
    args = parser.parse_args(argv)

    try:
        artifact, report = run_batch()
    except CandidateFunnelBatchError as e:
        print(f"FAIL candidate_funnel batch: {e}", file=sys.stderr)
        return 1

    for gate in report["qualityGate"]["gates"]:
        print(f"  [{gate['status']}] {gate['id']} {gate['metric']} = {gate['value']} (threshold: {gate['threshold']})")

    if not report["qualityGate"]["overallPass"]:
        print(
            f"FAIL candidate_funnel batch: quality gate failed ({report['qualityGate']['hardFailIds']}); "
            "no new artifact will be published",
            file=sys.stderr,
        )
        return 1

    if "schemaViolations" in report:
        print(f"FAIL candidate_funnel batch: schema violations {report['schemaViolations']}", file=sys.stderr)
        return 1

    if args.dry_run:
        print("candidate_funnel batch dry-run ok (gates PASS, artifact not published)")
        return 0

    publish_artifact(artifact)
    print(f"  → {DATA_OUTPUT_PATH}")
    print(f"  → {PUBLIC_OUTPUT_PATH}")
    print("candidate_funnel batch ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
