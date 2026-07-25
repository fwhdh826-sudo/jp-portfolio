#!/usr/bin/env python3
"""
P5-B005-B1-R2: market-wide candidate funnel pure engine。

P5-B005-A2（`/Users/ryo/jp-portfolio-audit-reports/p5-b005-a2-scoring-specification.md`,
audited SHA 665eba993b3d3ccfcf434c245a8784765f34bf43）で FROZEN された scoring
specification を、P5-B005-A2-S Frozen Specification Supplement
（`/Users/ryo/jp-portfolio-audit-reports/p5-b005-a2-s-scoring-specification-supplement.md`,
§25 が唯一の実装 authority）に従い限定修正した実装。A2-S が supersede しない
A2 条項はそのまま有効。

契約:
  - stdlib only（file I/O 0, network 0, yfinance 0, pandas 0, numpy 0,
    datetime.now 0, random 0, environment variables 0, global mutable
    state 0, portfolio data 0）。
  - build_candidate_funnel(candidates, context) は同じ入力・contextから
    常に同じ結果を返す pure function。generatedAt 等の内部生成は行わない
    （必要な時刻情報は caller が context.asOf として明示的に渡す）。

honesty boundary:
  現行 candidates_stocks.json の入力フィールド（code/name/sector/price/per/
  pbr/roe/dividendYield/sigma252d/mom3m/dataStatus + 将来の prescreenScore/
  prescreenRank/prescreenPool）で active にできる Stage 3 component は
  valuation / quality のみ。他 8 component は reserved zero-weight として
  保持し、値を捏造しない。8 HARD_* reason のうち、この engine の入力契約
  （§8 input contract）で直接計算可能なのは HARD_CONTRACT_VIOLATION（schema
  違反の総称。duplicate candidate code を含む, A2-S §17）と
  HARD_PREFERRED_OR_NONSTANDARD_CODE（5桁 code）の2件のみ。
  残り6件は market_segment / instrument type / history_days / adv20_jpy /
  raw OHLCV series を要求するが、この engine の入力契約には存在しないため
  構造的に到達不能（reserved, never triggered）。フィールド未接続を理由に
  代理指標を発明しない（禁止 proxy: momentum→growth, sigma→financialStability,
  sector→theme 等）。
"""
from __future__ import annotations

import math
from bisect import bisect_left, bisect_right
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

# ---------------------------------------------------------------------------
# Version strings（A2 §17 Frozen Specification Block）
# ---------------------------------------------------------------------------

CANDIDATE_FUNNEL_SCHEMA_VERSION = "candidate-funnel-1"
CANDIDATE_FUNNEL_VERSION = "candidate-funnel-v1"
CANDIDATE_FUNNEL_SCORE_VERSION = "market-score-v1"

# ---------------------------------------------------------------------------
# Prior / Stage3 composite split（A2 §3.2）
# ---------------------------------------------------------------------------

PRESCREEN_PRIOR_WEIGHT = 0.35
STAGE3_COMPOSITE_WEIGHT = 0.65

# ---------------------------------------------------------------------------
# 10 component weights（A2 §4。順序は A2 §4 表の #1-10 と一致、TS parity 対象）
#
# A2-S §25.15: このtableがstage3Composite算出の唯一のauthorityである。
# score計算内に 0.55/0.45 のリテラル直書きを行うことを禁止する。
# ---------------------------------------------------------------------------

COMPONENT_WEIGHTS: dict[str, float] = {
    "valuation": 0.55,
    "quality": 0.45,
    "growth": 0.0,
    "momentum": 0.0,
    "financialStability": 0.0,
    "earningsRevisionEvent": 0.0,
    "themeDurability": 0.0,
    "regimeFit": 0.0,
    "risk": 0.0,
    "dataConfidence": 0.0,
}
COMPONENT_IDS: tuple[str, ...] = tuple(COMPONENT_WEIGHTS.keys())

# valuation の sub-metric weight（A2 §17 valuationSubWeights。合計1.0）。
# A2-S §25.15: このtableがvaluation算出の唯一のauthorityである。
# score計算内に "/3.0" のリテラル直書きを行うことを禁止する。
VALUATION_SUB_WEIGHTS: dict[str, float] = {
    "earningsYield": 1.0 / 3.0,
    "bookYield": 1.0 / 3.0,
    "dividendYield": 1.0 / 3.0,
}

# A2-S §25.15 必須 import-time assertion（fail-fast）。
assert len(COMPONENT_WEIGHTS) == 10
assert sum(COMPONENT_WEIGHTS.values()) == 1.0
assert PRESCREEN_PRIOR_WEIGHT + STAGE3_COMPOSITE_WEIGHT == 1.0
assert {c for c, w in COMPONENT_WEIGHTS.items() if w > 0.0} == {"valuation", "quality"}
assert len(VALUATION_SUB_WEIGHTS) == 3
assert math.isclose(sum(VALUATION_SUB_WEIGHTS.values()), 1.0, rel_tol=0.0, abs_tol=1e-12)

# 真に source が無い5 component（A2 §2.3 RESERVED_ZERO_WEIGHT）。
# value は捏造せず常に None。
RESERVED_COMPONENT_IDS: tuple[str, ...] = (
    "growth",
    "financialStability",
    "earningsRevisionEvent",
    "themeDurability",
    "regimeFit",
)
# source はあるが score weight 0（A2 §2.3 ACTIVE→zero）。observability value を持つ。
ACTIVE_ZERO_WEIGHT_COMPONENT_IDS: tuple[str, ...] = ("momentum", "risk", "dataConfidence")
ACTIVE_POSITIVE_WEIGHT_COMPONENT_IDS: tuple[str, ...] = ("valuation", "quality")

COMPONENT_SOURCE_FIELDS: dict[str, tuple[str, ...]] = {
    "valuation": ("per", "pbr", "dividendYield"),
    "quality": ("roe",),
    "growth": (),
    "momentum": ("mom3m",),
    "financialStability": (),
    "earningsRevisionEvent": (),
    "themeDurability": (),
    "regimeFit": (),
    "risk": ("sigma252d",),
    "dataConfidence": ("per", "pbr", "roe", "dividendYield", "sigma252d", "mom3m", "dataStatus"),
}

# ---------------------------------------------------------------------------
# Normalization（A2 §8）
# ---------------------------------------------------------------------------

WINSORIZE_LOWER_PCT = 0.01
WINSORIZE_UPPER_PCT = 0.99

MIN_USABLE_AXES = 4

# ---------------------------------------------------------------------------
# Exact tier thresholds / hard maxima / sector caps（A2 §9・§10・§17,
# ACTIONABLE_MIN_DATA_CONFIDENCE は A2-S §25.3 により 2/3 へ確定）
# ---------------------------------------------------------------------------

DEEP_REVIEW_MIN_MARKET_SCORE = 55.0
DEEP_REVIEW_MIN_DATA_CONFIDENCE = 0.50
DEEP_REVIEW_HARD_MAX = 40
DEEP_REVIEW_SECTOR_HARD_CAP = 6

ACTIONABLE_MIN_MARKET_SCORE = 68.0
ACTIONABLE_MIN_DATA_CONFIDENCE = 2.0 / 3.0  # A2-S §25.3: literal 0.67 禁止
ACTIONABLE_HARD_MAX = 12
ACTIONABLE_SECTOR_HARD_CAP = 2
ACTIONABLE_MIN_VALUATION_PERCENTILE = 0.40
ACTIONABLE_MIN_QUALITY_PERCENTILE = 0.40

BEAR_CRISIS_ACTIONABLE_HARD_MAX = 5
BEAR_CRISIS_ACTIONABLE_SECTOR_HARD_CAP = 2

VOL_HARD_LIMIT = 0.45
VOL_SOFT_LIMIT = 0.35

# A2-S §25.5 volatilityClass 3値分類（+ UNAVAILABLE）。
VOL_NORMAL = "VOL_NORMAL"
VOL_ELEVATED = "VOL_ELEVATED"
VOL_RED_FLAG = "VOL_RED_FLAG"
VOL_UNAVAILABLE = "VOL_UNAVAILABLE"

SECTOR_CAP_RELAXATION = False

# ---------------------------------------------------------------------------
# Enums（A2 §17 / TS parity 対象）
# ---------------------------------------------------------------------------

CANDIDATE_FUNNEL_TIERS: tuple[str, ...] = ("excluded", "eligible", "screened", "deep_review", "actionable")
CANDIDATE_FUNNEL_PIPELINE_PATHS: tuple[str, ...] = ("normal", "cache_fallback", "seed_fallback")
CANDIDATE_FUNNEL_COMPONENT_STATUSES: tuple[str, ...] = ("available", "missing", "invalid", "reserved", "vetoed")
CANDIDATE_FUNNEL_PRESCREEN_POOLS: tuple[str, ...] = ("main", "newcomer")
CANDIDATE_FUNNEL_DATA_STATUSES: tuple[str, ...] = ("ok", "partial")
CANDIDATE_FUNNEL_REGIMES: tuple[str, ...] = ("bull_calm", "bull_volatile", "uncertain", "bear", "crisis")
CANDIDATE_FUNNEL_STATUSES: tuple[str, ...] = ("generated", "not_generated")

CANDIDATE_FUNNEL_HARD_REASON_CODES: tuple[str, ...] = (
    "HARD_NOT_PRIME_DOMESTIC",
    "HARD_NON_EQUITY_INSTRUMENT",
    "HARD_PREFERRED_OR_NONSTANDARD_CODE",
    "HARD_INSUFFICIENT_HISTORY",
    "HARD_BELOW_MAIN_FLOOR",
    "HARD_NONFINITE_SERIES",
    "HARD_CONTRACT_VIOLATION",
    "HARD_NO_TRADABLE_SERIES",
)

# A2-S §25.6: SOFT reason は frozen 13件。index 0-9 は A2 §14 と完全に同一
# （文字列・順序・意味とも不変）。index 10-12 は A2-S で追加。
CANDIDATE_FUNNEL_SOFT_REASON_CODES: tuple[str, ...] = (
    "SOFT_ELEVATED_VOLATILITY",  # 0
    "SOFT_WEAK_MOMENTUM",  # 1
    "SOFT_DEEP_DRAWDOWN",  # 2  v1 inactive
    "SOFT_WEAK_TREND",  # 3  v1 inactive
    "SOFT_SECTOR_CROWDING",  # 4
    "SOFT_THEME_CROWDING",  # 5  v1 inactive
    "SOFT_LOW_DATA_CONFIDENCE",  # 6
    "SOFT_STALE_SOURCE",  # 7
    "SOFT_PORTFOLIO_OVERLAP",  # 8  v1 inactive（frontend 専用）
    "SOFT_FALLBACK_PROVENANCE",  # 9
    "SOFT_PRESCREEN_METADATA_MISSING",  # 10 A2 §3.2/§9 の記載漏れを復帰
    "SOFT_VOLATILITY_RED_FLAG",  # 11 新規（σ >= 0.45）
    "SOFT_VOLATILITY_UNAVAILABLE",  # 12 新規（σ が有限実数でない）
)

# A2-S §25.12: selectedReasons exact enum（2件のみ）。
CANDIDATE_FUNNEL_SELECTED_REASON_CODES: tuple[str, ...] = (
    "SELECTED_DEEP_REVIEW",
    "SELECTED_ACTIONABLE",
)

# A2-S §25.14: theme output status enum。v1 では "unavailable" のみ出力。
CANDIDATE_FUNNEL_THEME_STATUSES: tuple[str, ...] = ("unavailable", "available")

# A2-S §25.14: dataset-level degradationReasons の code 集合（順序= index 昇順）。
CANDIDATE_FUNNEL_DEGRADATION_REASON_CODES: tuple[str, ...] = (
    "SEED_FALLBACK_PIPELINE_PATH",
    "CACHE_FALLBACK_PROVENANCE",
    "STALE_SOURCE",
    "PRESCREEN_FALLBACK_USED",
    "PRESCREEN_METADATA_MISSING",
    "DUPLICATE_CANDIDATE_CODE",
)

# B1 入力契約（§8）で構造的に到達不能な HARD_* reason（market_segment /
# instrument type / history_days / adv20_jpy / raw OHLCV series が
# 存在しないため）。定数として保持するが、この engine からは発火しない。
_HARD_REASONS_UNREACHABLE_IN_B1: tuple[str, ...] = (
    "HARD_NOT_PRIME_DOMESTIC",
    "HARD_NON_EQUITY_INSTRUMENT",
    "HARD_INSUFFICIENT_HISTORY",
    "HARD_BELOW_MAIN_FLOOR",
    "HARD_NONFINITE_SERIES",
    "HARD_NO_TRADABLE_SERIES",
)


# ---------------------------------------------------------------------------
# 数値検証（A2 §6.1・ticket §8 Validation）
# ---------------------------------------------------------------------------


def _classify_numeric_field(raw: Any) -> tuple[float | None, str]:
    """1つの数値フィールド（per/pbr/roe/dividendYield/sigma252d/mom3m）を
    (sanitized value, provenance) へ分類する。

    provenance: 'absent'（キー無し/None） | 'present_valid'（有限数値） |
    'present_invalid'（bool/NaN/Inf/非数値型 — 値として認めない）。
    bool は int の subclass だが numeric として認めない（ticket §8）。
    """
    if raw is None:
        return None, "absent"
    if isinstance(raw, bool):
        return None, "present_invalid"
    if isinstance(raw, (int, float)):
        v = float(raw)
        if not math.isfinite(v):
            return None, "present_invalid"
        return v, "present_valid"
    return None, "present_invalid"


def _combine_status(provenances: list[str]) -> str:
    """component 内の複数 sub-field provenance から component status を導出。
    1件でも present_valid があれば available（他が missing/invalid でも
    固定重み平均で寄与するため）。"""
    if any(p == "present_valid" for p in provenances):
        return "available"
    if any(p == "present_invalid" for p in provenances):
        return "invalid"
    return "missing"


def _volatility_class(sigma_raw: Any) -> str:
    """A2-S §25.5: sigma252d の3値分類（+ UNAVAILABLE）を frozen pseudocode
    どおりに実装する。bool は数値として認めない（isinstance bool 判定を
    数値判定より先に評価する）。境界は両方とも `>=`。"""
    if isinstance(sigma_raw, bool):
        return VOL_UNAVAILABLE
    if not isinstance(sigma_raw, (int, float)):
        return VOL_UNAVAILABLE
    if not math.isfinite(float(sigma_raw)):
        return VOL_UNAVAILABLE
    s = float(sigma_raw)
    if s >= VOL_HARD_LIMIT:
        return VOL_RED_FLAG
    if s >= VOL_SOFT_LIMIT:
        return VOL_ELEVATED
    return VOL_NORMAL


def resolve_actionable_capacity(regime: Any) -> tuple[int, int]:
    """A2-S §25.7: regime に基づく actionable (hard_max, sector_cap) の
    唯一の解決経路。選抜処理・observability の両方が必ずこの関数の
    戻り値のみを使用すること（定数の直接参照を禁止）。

    regime が bear/crisis のいずれでもない場合（None・未知文字列・
    非文字列を含む）は neutral 値 (12, 2) を返す。
    """
    if regime in ("bear", "crisis"):
        return (BEAR_CRISIS_ACTIONABLE_HARD_MAX, BEAR_CRISIS_ACTIONABLE_SECTOR_HARD_CAP)
    return (ACTIONABLE_HARD_MAX, ACTIONABLE_SECTOR_HARD_CAP)


def _prescreen_usable(raw: dict[str, Any]) -> bool:
    """A2-S §25.11: prescreenUsable(raw) の frozen 定義。missing と invalid
    を同一に扱うための単一 gate。"""
    if "prescreenScore" not in raw:
        return False
    v = raw.get("prescreenScore")
    if isinstance(v, bool):
        return False
    if not isinstance(v, (int, float)):
        return False
    return math.isfinite(float(v))


# ---------------------------------------------------------------------------
# Cross-sectional winsorized percentile-rank
# （jpx_cheap_prescreen.py::percentile_rank と同一規律。stdlib のみで再実装）
# ---------------------------------------------------------------------------


def _percentile_linear(sorted_vals: list[float], pct: float) -> float:
    """numpy.percentile(kind='linear') 相当。sorted_vals は昇順ソート済み。"""
    n = len(sorted_vals)
    if n == 1:
        return sorted_vals[0]
    idx = (pct / 100.0) * (n - 1)
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return sorted_vals[lo]
    frac = idx - lo
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * frac


def percentile_rank(values: list[float | None]) -> list[float]:
    """pool内 percentile rank（0〜1、値が大きいほど1に近い）。

    winsorize（1%/99%、finite値のみで算出・clip）後に mid-rank を計算する。
    None/NaN/Inf は最低順位 0.0（安全側）。finite が0件なら全0.0、1件なら0.5。
    """
    n = len(values)
    finite_idx = [i for i, v in enumerate(values) if v is not None and math.isfinite(v)]
    ranks = [0.0] * n
    if not finite_idx:
        return ranks
    finite_vals = [values[i] for i in finite_idx]  # type: ignore[misc]
    if len(finite_vals) == 1:
        ranks[finite_idx[0]] = 0.5
        return ranks

    sorted_finite = sorted(finite_vals)
    lower = _percentile_linear(sorted_finite, WINSORIZE_LOWER_PCT * 100)
    upper = _percentile_linear(sorted_finite, WINSORIZE_UPPER_PCT * 100)
    winsorized = [min(max(v, lower), upper) for v in finite_vals]

    sorted_w = sorted(winsorized)
    N = len(winsorized)
    for pos, orig_idx in enumerate(finite_idx):
        v = winsorized[pos]
        count_less = bisect_left(sorted_w, v)
        count_leq = bisect_right(sorted_w, v)
        count_equal = count_leq - count_less
        ranks[orig_idx] = (count_less + 0.5 * (count_equal - 1)) / (N - 1)
    return ranks


def _round_half_up(value: float, ndigits: int) -> float:
    """A2-S §25.17: round-half-to-even（Python 組み込み round()）は
    使用禁止。通常の round-half-up を使う。marketScore は clamp01 済みで
    常に非負のため floor+0.5 方式で安全。"""
    factor = 10**ndigits
    return math.floor(value * factor + 0.5) / factor


# ---------------------------------------------------------------------------
# Hard exclusion（A2 §13。8件 exact。B1 入力契約で到達可能なのは2件のみ）
# ---------------------------------------------------------------------------


def _hard_reasons_for_candidate(raw: dict[str, Any]) -> list[str]:
    """1候補分の入力を検証し、該当する HARD_* reason（順不同なし・重複なし）
    を返す。空リスト = hard exclusion 無し（score/tier 計算へ進む）。

    schema violation（HARD_CONTRACT_VIOLATION）:
      - code が非空文字列でない
      - sector が文字列でない（空文字列 sector 自体は有効, A2 §10）
      - dataStatus が {'ok','partial'} 以外（欠損含む — statusFactor を
        安全に決定できないため fail-closed。numeric field の欠損とは扱いが
        異なる: dataStatus は dataConfidence 式の直接入力で明示的な
        missing-value 代替式が A2 に無い）
      - price が与えられているが bool / 非有限 / 0以下（ticket §8「異常price
        はhard reason」。price 欠損自体は異常ではないため対象外）

    HARD_PREFERRED_OR_NONSTANDARD_CODE:
      - code が有効な文字列かつ 5桁の数字のみ（優先株等, A2 §13 #3）

    duplicate candidate code は本関数の対象外（build_candidate_funnel 内で
    per-record 判定後の population に対して別途 A2-S §25.16 のとおり判定する）。
    """
    reasons: list[str] = []

    code = raw.get("code")
    code_valid = isinstance(code, str) and code != ""
    sector = raw.get("sector")
    sector_valid = isinstance(sector, str)
    data_status = raw.get("dataStatus")
    data_status_valid = data_status in CANDIDATE_FUNNEL_DATA_STATUSES

    if not code_valid or not sector_valid or not data_status_valid:
        reasons.append("HARD_CONTRACT_VIOLATION")

    price_raw = raw.get("price")
    if price_raw is not None:
        if isinstance(price_raw, bool):
            reasons.append("HARD_CONTRACT_VIOLATION")
        elif isinstance(price_raw, (int, float)):
            price_f = float(price_raw)
            if not math.isfinite(price_f) or price_f <= 0:
                reasons.append("HARD_CONTRACT_VIOLATION")
        else:
            reasons.append("HARD_CONTRACT_VIOLATION")

    if code_valid and code.isdigit() and len(code) == 5:
        reasons.append("HARD_PREFERRED_OR_NONSTANDARD_CODE")

    seen: set[str] = set()
    deduped: list[str] = []
    for r in reasons:
        if r not in seen:
            seen.add(r)
            deduped.append(r)
    return deduped


def _ordered_hard_reasons(reasons: list[str]) -> list[str]:
    """A2-S §25.13: hardExclusionReasons の出力順は検出順ではなく
    CANDIDATE_FUNNEL_HARD_REASON_CODES の index 昇順。重複を排除する。"""
    order = {code: idx for idx, code in enumerate(CANDIDATE_FUNNEL_HARD_REASON_CODES)}
    return sorted(set(reasons), key=lambda r: order.get(r, len(CANDIDATE_FUNNEL_HARD_REASON_CODES)))


# ---------------------------------------------------------------------------
# Context 解析（context は caller-supplied。engine 内で時刻を生成しない）
# ---------------------------------------------------------------------------


def _parse_iso(raw: Any) -> datetime | None:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


_STALE_THRESHOLD_HOURS_DEFAULT = 48.0  # A2 §14 #8: frozen threshold value


def _resolve_stale_threshold_hours(raw: Any) -> float:
    """A2-S2 §19.7 P3-03: staleThresholdHours の定義域は int/float かつ非
    bool かつ math.isfinite かつ >= 0 のみ。それ以外（欠損・None・bool・
    NaN・±Inf・負値・文字列・list 等）は frozen default 48.0 を使う
    （invalid override で stale gate を無効化しない）。"""
    if isinstance(raw, bool):
        return _STALE_THRESHOLD_HOURS_DEFAULT
    if isinstance(raw, (int, float)):
        v = float(raw)
        if math.isfinite(v) and v >= 0:
            return v
    return _STALE_THRESHOLD_HOURS_DEFAULT


def _resolve_is_stale(source_updated_at: Any, as_of: Any, stale_threshold_hours: Any) -> bool:
    """sourceUpdatedAt / asOf のいずれかが欠損・不正なら判定不能として
    False（stale ではない）を返す（不明を stale と断定しない安全側）。"""
    src_dt = _parse_iso(source_updated_at)
    asof_dt = _parse_iso(as_of)
    if src_dt is None or asof_dt is None:
        return False
    threshold = _resolve_stale_threshold_hours(stale_threshold_hours)
    age_hours = (asof_dt - src_dt).total_seconds() / 3600.0
    return age_hours > threshold


# ---------------------------------------------------------------------------
# Tier selection helper（sector hard cap + hard maximum, no backfill）
# ---------------------------------------------------------------------------


def _select_with_cap(
    pool: list[int],
    hard_max: int,
    sector_cap: int,
    sector_of: Any,
    rank_of: Any,
) -> tuple[set[int], dict[str, int], set[int]]:
    """rank_of 昇順（=marketRank昇順=品質順）で pool を走査し、sector_cap /
    hard_max を満たす限り選抜する。backfill は行わない
    （A2 §10: threshold未達 candidate で穴埋めしない）。

    戻り値: (selected集合, sector別overflow件数, sector capにより
    skipされたindex集合 — SOFT_SECTOR_CROWDING付与用)。"""
    pool_sorted = sorted(pool, key=rank_of)
    selected: set[int] = set()
    sector_counts: dict[str, int] = {}
    sector_overflow: dict[str, int] = {}
    skipped_sector_cap: set[int] = set()
    for k in pool_sorted:
        if len(selected) >= hard_max:
            break
        sec = sector_of(k)
        if sector_counts.get(sec, 0) >= sector_cap:
            sector_overflow[sec] = sector_overflow.get(sec, 0) + 1
            skipped_sector_cap.add(k)
            continue
        selected.add(k)
        sector_counts[sec] = sector_counts.get(sec, 0) + 1
    return selected, sector_overflow, skipped_sector_cap


def _empty_score_breakdown() -> list[dict[str, Any]]:
    """hard-excluded candidate用。全component を value=None で返す
    （データが構造的に検証不能なため、値を計算せず捏造もしない）。
    A2-S §25.15: reserved 5 component の status は "reserved"、
    ACTIVE 5 component（active-zero + active-positive）の status は
    "invalid"（値が検証不能なため）。"""
    breakdown = []
    for cid in COMPONENT_IDS:
        status = "reserved" if cid in RESERVED_COMPONENT_IDS else "invalid"
        breakdown.append(
            {
                "id": cid,
                "value": None,
                "weight": COMPONENT_WEIGHTS[cid],
                "weightedContribution": 0.0,
                "status": status,
                "sourceFields": list(COMPONENT_SOURCE_FIELDS[cid]),
            }
        )
    return breakdown


def _not_generated_result(degradation_reasons: list[str]) -> dict[str, Any]:
    return {
        "schemaVersion": CANDIDATE_FUNNEL_SCHEMA_VERSION,
        "funnelVersion": CANDIDATE_FUNNEL_VERSION,
        "scoreVersion": CANDIDATE_FUNNEL_SCORE_VERSION,
        "not_for_trading": True,
        "status": "not_generated",
        "degradationReasons": degradation_reasons,
        "counts": {"total": 0, "excluded": 0, "screened": 0, "deepReview": 0, "actionable": 0},
        "candidates": [],
        "excludedSummary": {"total": 0, "byReason": {}},
        "sectorDistribution": {"screened": {}, "deepReview": {}, "actionable": {}},
        "scoreDistribution": {"count": 0, "min": None, "max": None, "mean": None, "median": None},
        "selectionObservability": {
            "regimeApplied": None,
            "actionableHardMaxApplied": None,
            "actionableSectorCapApplied": None,
            "deepReviewHardMaxApplied": None,
            "deepReviewSectorCapApplied": None,
            "deepReviewSectorCapRelaxed": SECTOR_CAP_RELAXATION,
            "actionableSectorCapRelaxed": SECTOR_CAP_RELAXATION,
            "deepReviewSectorCapOverflow": {},
            "actionableSectorCapOverflow": {},
            "deepReviewEligibleCount": 0,
            "deepReviewSelectedCount": 0,
            "actionableEligibleCount": 0,
            "actionableSelectedCount": 0,
            "sourceStale": False,
            "fallbackProvenance": False,
        },
    }


# ---------------------------------------------------------------------------
# Main entrypoint
# ---------------------------------------------------------------------------


def build_candidate_funnel(candidates: list[Any], context: dict[str, Any] | None = None) -> dict[str, Any]:
    """frozen scoring specification（A2 + A2-S §25）に従い candidate funnel
    を決定的に構築する pure function。file I/O・network・乱数・壁時計時刻を
    一切使用しない。同一 (candidates, context) から常に同一の結果を返す。

    candidates: dict のリスト。最低限 code/name/sector/price/per/pbr/roe/
      dividendYield/sigma252d/mom3m/dataStatus を持つ（prescreenScore/
      prescreenRank/prescreenPool は任意 — 現行 candidates_stocks.json には
      存在しないため、欠損時は degraded compatibility として扱う）。

    context: dataset-level 情報（すべて任意、caller-supplied）。
      pipelinePath: 'normal'|'cache_fallback'|'seed_fallback'（既定 'normal'）
      regime: 'bull_calm'|'bull_volatile'|'uncertain'|'bear'|'crisis'|None
      sourceUpdatedAt / asOf: ISO8601文字列。staleness判定に使う
        （どちらか欠損なら stale と断定しない）。
      staleThresholdHours: 既定 48.0（candidates_stocks.json既定値と同一）。
      prescreenFallbackUsed: bool。prescreen 側が fallback cache だった場合。

    raises:
      TypeError: candidates が list/tuple でない、または context が None でも
        Mapping でもない場合（A2-S2 §19.7/§19.8 frozen exception policy。
        引数そのものの型契約違反のみが例外を許容される唯一のケース）。
    """
    if not isinstance(candidates, (list, tuple)):
        raise TypeError("candidates must be a list or tuple")
    if context is not None and not isinstance(context, Mapping):
        raise TypeError("context must be a mapping or None")
    context = {} if context is None else context
    pipeline_path = context.get("pipelinePath")

    if pipeline_path == "seed_fallback":
        return _not_generated_result(
            ["SEED_FALLBACK_PIPELINE_PATH: pipelinePath=seed_fallback; funnel generation skipped per frozen spec §9/§17 tierMaxByCondition.seedFallback"]
        )

    regime = context.get("regime")
    if regime not in CANDIDATE_FUNNEL_REGIMES:
        regime = None
    stale_threshold_hours = context.get("staleThresholdHours", 48.0)
    source_updated_at = context.get("sourceUpdatedAt")
    as_of = context.get("asOf")
    prescreen_fallback_used = bool(context.get("prescreenFallbackUsed", False))

    is_stale = _resolve_is_stale(source_updated_at, as_of, stale_threshold_hours)
    is_cache_fallback = pipeline_path == "cache_fallback"

    n = len(candidates)

    # --- Step 1a: per-record schema hard reason（duplicate 判定より先） ---
    hard_reasons_list: list[list[str]] = []
    for raw in candidates:
        if not isinstance(raw, dict):
            hard_reasons_list.append(["HARD_CONTRACT_VIOLATION"])
        else:
            hard_reasons_list.append(_hard_reasons_for_candidate(raw))

    # --- Step 1b: duplicate candidate code（A2-S §25.16）。schema 違反を
    # 既に持つレコードは対象外。残ったレコードの code が >=2 回出現したら
    # 全レコードへ HARD_CONTRACT_VIOLATION（dedupe/先勝ち/後勝ち禁止）。
    pass1_valid = [i for i in range(n) if not hard_reasons_list[i]]
    code_counts: dict[Any, int] = {}
    for i in pass1_valid:
        code = candidates[i].get("code")
        code_counts[code] = code_counts.get(code, 0) + 1
    duplicated_codes = {c for c, cnt in code_counts.items() if cnt >= 2}
    duplicate_indices: list[int] = []
    if duplicated_codes:
        for i in pass1_valid:
            if candidates[i].get("code") in duplicated_codes:
                hard_reasons_list[i].append("HARD_CONTRACT_VIOLATION")
                duplicate_indices.append(i)

    valid_indices = [i for i in range(n) if not hard_reasons_list[i]]
    m = len(valid_indices)

    per_vals: list[float | None] = []
    per_prov: list[str] = []
    pbr_vals: list[float | None] = []
    pbr_prov: list[str] = []
    roe_vals: list[float | None] = []
    roe_prov: list[str] = []
    div_vals: list[float | None] = []
    div_prov: list[str] = []
    sigma_vals: list[float | None] = []
    sigma_prov: list[str] = []
    mom_vals: list[float | None] = []
    mom_prov: list[str] = []
    vol_class_list: list[str] = []

    for i in valid_indices:
        raw = candidates[i]
        v, p = _classify_numeric_field(raw.get("per"))
        per_vals.append(v)
        per_prov.append(p)
        v, p = _classify_numeric_field(raw.get("pbr"))
        pbr_vals.append(v)
        pbr_prov.append(p)
        v, p = _classify_numeric_field(raw.get("roe"))
        roe_vals.append(v)
        roe_prov.append(p)
        v, p = _classify_numeric_field(raw.get("dividendYield"))
        div_vals.append(v)
        div_prov.append(p)
        v, p = _classify_numeric_field(raw.get("sigma252d"))
        sigma_vals.append(v)
        sigma_prov.append(p)
        v, p = _classify_numeric_field(raw.get("mom3m"))
        mom_vals.append(v)
        mom_prov.append(p)
        vol_class_list.append(_volatility_class(raw.get("sigma252d")))

    # --- valuation sub-metrics（A2 §6.1・A2-S §25.15 table 駆動） ---
    earnings_yield: list[float | None] = [(1.0 / v) if (v is not None and v > 0) else None for v in per_vals]
    book_yield: list[float | None] = [(1.0 / v) if (v is not None and v > 0) else None for v in pbr_vals]
    div_yield: list[float | None] = [v if (v is not None and v >= 0) else None for v in div_vals]

    r_ey = percentile_rank(earnings_yield)
    r_by = percentile_rank(book_yield)
    r_div = percentile_rank(div_yield)
    valuation_vals = [
        VALUATION_SUB_WEIGHTS["earningsYield"] * r_ey[k]
        + VALUATION_SUB_WEIGHTS["bookYield"] * r_by[k]
        + VALUATION_SUB_WEIGHTS["dividendYield"] * r_div[k]
        for k in range(m)
    ]

    # --- quality（A2 §6.1） ---
    quality_vals = percentile_rank(roe_vals)

    # --- momentum / risk observability（weight 0, A2 §4） ---
    r_mom = percentile_rank(mom_vals)
    r_risk = percentile_rank([(-v if v is not None else None) for v in sigma_vals])

    # --- prescreen prior（A2 §6.2、missing/invalid 統一は A2-S §25.11） ---
    normalized_prescreen: list[float] = []
    prescreen_usable_flags: list[bool] = []
    prescreen_score_out: list[float | None] = []
    prescreen_rank_out: list[int | None] = []
    prescreen_rank_tiebreak: list[float] = []
    prescreen_pool_out: list[str | None] = []
    for i in valid_indices:
        raw = candidates[i]
        usable = _prescreen_usable(raw)
        prescreen_usable_flags.append(usable)
        if usable:
            score_f = float(raw.get("prescreenScore"))
            normalized_prescreen.append(min(max(score_f, 0.0), 1.0))
            prescreen_score_out.append(score_f)
        else:
            normalized_prescreen.append(0.0)
            prescreen_score_out.append(None)

        raw_rank = raw.get("prescreenRank")
        if isinstance(raw_rank, int) and not isinstance(raw_rank, bool) and raw_rank > 0:
            prescreen_rank_out.append(raw_rank)
            prescreen_rank_tiebreak.append(float(raw_rank))
        else:
            prescreen_rank_out.append(None)
            prescreen_rank_tiebreak.append(math.inf)

        raw_pool = raw.get("prescreenPool")
        prescreen_pool_out.append(raw_pool if raw_pool in CANDIDATE_FUNNEL_PRESCREEN_POOLS else None)

    # --- dataConfidence（A2 §6.5。gate 比較は internal 値, A2-S §25.3） ---
    data_confidence_vals: list[float] = []
    usable_axes_list: list[int] = []
    data_status_list: list[str] = []
    for k, i in enumerate(valid_indices):
        raw = candidates[i]
        usable = sum(
            1
            for v in (per_vals[k], pbr_vals[k], roe_vals[k], div_vals[k], sigma_vals[k], mom_vals[k])
            if v is not None
        )
        usable_axes_list.append(usable)
        data_status = raw.get("dataStatus")
        data_status_list.append(data_status)
        status_factor = 1.0 if data_status == "ok" else 0.6
        dc = min(max((usable / 6.0) * status_factor, 0.0), 1.0)
        data_confidence_vals.append(dc)

    # --- Stage3 composite / rawComposite / marketScore
    #     （A2 §6.3-6.6、stage3 は A2-S §25.15 table 駆動） ---
    component_values_full: list[dict[str, float | None]] = []
    for k in range(m):
        component_values_full.append(
            {
                "valuation": valuation_vals[k],
                "quality": quality_vals[k],
                "growth": None,
                "momentum": r_mom[k],
                "financialStability": None,
                "earningsRevisionEvent": None,
                "themeDurability": None,
                "regimeFit": None,
                "risk": r_risk[k],
                "dataConfidence": data_confidence_vals[k],
            }
        )
    stage3 = [
        sum(
            COMPONENT_WEIGHTS[cid] * component_values_full[k][cid]
            for cid in COMPONENT_IDS
            if component_values_full[k][cid] is not None
        )
        for k in range(m)
    ]
    raw_composite = [
        PRESCREEN_PRIOR_WEIGHT * normalized_prescreen[k] + STAGE3_COMPOSITE_WEIGHT * stage3[k] for k in range(m)
    ]
    market_score = [_round_half_up(100.0 * min(max(rc, 0.0), 1.0), 1) for rc in raw_composite]

    # --- 決定的 tie-break chain（A2 §15。duplicate code 除外後は code 一意） ---
    codes = [candidates[valid_indices[k]].get("code") for k in range(m)]
    order = sorted(
        range(m),
        key=lambda k: (-market_score[k], -data_confidence_vals[k], prescreen_rank_tiebreak[k], codes[k]),
    )
    market_rank = [0] * m
    for rank_pos, k in enumerate(order):
        market_rank[k] = rank_pos + 1

    # --- tier eligibility gate（A2-S §25.8 conjunction, fail-closed） ---
    deep_review_eligible = [
        vol_class_list[k] in (VOL_NORMAL, VOL_ELEVATED)
        and market_score[k] >= DEEP_REVIEW_MIN_MARKET_SCORE
        and data_confidence_vals[k] >= DEEP_REVIEW_MIN_DATA_CONFIDENCE
        and pipeline_path in ("normal", "cache_fallback")
        for k in range(m)
    ]
    actionable_eligible = [
        deep_review_eligible[k]
        and vol_class_list[k] == VOL_NORMAL
        and market_score[k] >= ACTIONABLE_MIN_MARKET_SCORE
        and data_confidence_vals[k] >= ACTIONABLE_MIN_DATA_CONFIDENCE
        and valuation_vals[k] >= ACTIONABLE_MIN_VALUATION_PERCENTILE
        and quality_vals[k] >= ACTIONABLE_MIN_QUALITY_PERCENTILE
        and pipeline_path == "normal"
        and not is_stale
        and prescreen_usable_flags[k]
        and not prescreen_fallback_used
        for k in range(m)
    ]

    sectors = [candidates[valid_indices[k]].get("sector") or "" for k in range(m)]

    def _sector_of(k: int) -> str:
        return sectors[k]

    def _rank_of(k: int) -> int:
        return market_rank[k]

    # --- Step 8（A2-S §25.9）: actionable を先に選抜する。
    #     母集団は actionable_eligible の全件（deep_review_selected ではない）。
    actionable_hard_max, actionable_sector_cap = resolve_actionable_capacity(regime)
    actionable_pool = [k for k in range(m) if actionable_eligible[k]]
    actionable_selected, ac_sector_overflow, ac_skipped_sector_cap = _select_with_cap(
        actionable_pool, actionable_hard_max, actionable_sector_cap, _sector_of, _rank_of
    )

    # --- Step 9: deep-review は actionable 選抜後の残余から選抜する。 ---
    deep_review_pool = [k for k in range(m) if deep_review_eligible[k] and k not in actionable_selected]
    deep_review_selected, dr_sector_overflow, dr_skipped_sector_cap = _select_with_cap(
        deep_review_pool, DEEP_REVIEW_HARD_MAX, DEEP_REVIEW_SECTOR_HARD_CAP, _sector_of, _rank_of
    )

    deep_review_eligible_count = sum(1 for k in range(m) if deep_review_eligible[k])

    # --- Step 10: tier（排他）。 ---
    tiers = ["screened"] * m
    for k in deep_review_selected:
        tiers[k] = "deep_review"
    for k in actionable_selected:
        tiers[k] = "actionable"

    # --- Step 11: reason 生成（tier 確定後。A2-S §25.6/§25.12）。 ---
    risk_reasons: list[list[str]] = [[] for _ in range(m)]
    selected_reasons: list[list[str]] = [[] for _ in range(m)]
    for k in range(m):
        if vol_class_list[k] == VOL_RED_FLAG:
            risk_reasons[k].append("SOFT_VOLATILITY_RED_FLAG")
        if vol_class_list[k] == VOL_UNAVAILABLE:
            risk_reasons[k].append("SOFT_VOLATILITY_UNAVAILABLE")
        if vol_class_list[k] == VOL_ELEVATED:
            risk_reasons[k].append("SOFT_ELEVATED_VOLATILITY")
        if mom_prov[k] == "present_valid" and r_mom[k] < 0.25:
            risk_reasons[k].append("SOFT_WEAK_MOMENTUM")
        if usable_axes_list[k] < MIN_USABLE_AXES or data_status_list[k] != "ok":
            risk_reasons[k].append("SOFT_LOW_DATA_CONFIDENCE")
        if is_stale:
            risk_reasons[k].append("SOFT_STALE_SOURCE")
        if is_cache_fallback or prescreen_fallback_used:
            risk_reasons[k].append("SOFT_FALLBACK_PROVENANCE")
        if not prescreen_usable_flags[k]:
            risk_reasons[k].append("SOFT_PRESCREEN_METADATA_MISSING")
        if k in ac_skipped_sector_cap or k in dr_skipped_sector_cap:
            risk_reasons[k].append("SOFT_SECTOR_CROWDING")

        if tiers[k] == "actionable":
            selected_reasons[k] = ["SELECTED_ACTIONABLE"]
        elif tiers[k] == "deep_review":
            selected_reasons[k] = ["SELECTED_DEEP_REVIEW"]

    # --- scoreBreakdown（10 component, fixed order） ---
    candidate_results: list[dict[str, Any]] = [None] * n  # type: ignore[list-item]

    for k, i in enumerate(valid_indices):
        raw = candidates[i]
        risk_status = "vetoed" if vol_class_list[k] == VOL_RED_FLAG else _combine_status([sigma_prov[k]])
        breakdown = []
        for cid in COMPONENT_IDS:
            full_value = component_values_full[k][cid]
            if cid == "valuation":
                status = _combine_status([per_prov[k], pbr_prov[k], div_prov[k]])
            elif cid == "quality":
                status = _combine_status([roe_prov[k]])
            elif cid == "momentum":
                status = _combine_status([mom_prov[k]])
            elif cid == "risk":
                status = risk_status
            elif cid == "dataConfidence":
                status = "available"
            else:
                status = "reserved"
            breakdown.append(
                {
                    "id": cid,
                    "value": _round_half_up(full_value, 4) if full_value is not None else None,
                    "weight": COMPONENT_WEIGHTS[cid],
                    "weightedContribution": (COMPONENT_WEIGHTS[cid] * full_value) if full_value is not None else 0.0,
                    "status": status,
                    "sourceFields": list(COMPONENT_SOURCE_FIELDS[cid]),
                }
            )

        candidate_results[i] = {
            "code": raw.get("code"),
            "name": raw.get("name") if isinstance(raw.get("name"), str) else "",
            "sector": sectors[k],
            "prescreenScore": prescreen_score_out[k],
            "prescreenRank": prescreen_rank_out[k],
            "prescreenPool": prescreen_pool_out[k],
            "scoreBreakdown": breakdown,
            "rawCompositeScore": raw_composite[k],
            "dataConfidence": _round_half_up(data_confidence_vals[k], 4),
            "marketScore": market_score[k],
            "marketRank": market_rank[k],
            "tier": tiers[k],
            "selectedReasons": selected_reasons[k],
            "riskReasons": risk_reasons[k],
            "hardExclusionReasons": [],
            "themes": [],
            "themeStatus": "unavailable",
            "dataStatus": data_status_list[k] if data_status_list[k] in CANDIDATE_FUNNEL_DATA_STATUSES else None,
        }

    for i in range(n):
        if candidate_results[i] is not None:
            continue
        raw = candidates[i] if isinstance(candidates[i], dict) else {}
        data_status = raw.get("dataStatus")
        candidate_results[i] = {
            "code": raw.get("code") if isinstance(raw.get("code"), str) else "",
            "name": raw.get("name") if isinstance(raw.get("name"), str) else "",
            "sector": raw.get("sector") if isinstance(raw.get("sector"), str) else "",
            "prescreenScore": None,
            "prescreenRank": None,
            "prescreenPool": None,
            "scoreBreakdown": _empty_score_breakdown(),
            "rawCompositeScore": None,
            "dataConfidence": None,
            "marketScore": None,
            "marketRank": None,
            "tier": "excluded",
            "selectedReasons": [],
            "riskReasons": [],
            "hardExclusionReasons": _ordered_hard_reasons(hard_reasons_list[i]),
            "themes": [],
            "themeStatus": "unavailable",
            "dataStatus": data_status if data_status in CANDIDATE_FUNNEL_DATA_STATUSES else None,
        }

    # --- dataset-level aggregation ---
    excluded_by_reason: dict[str, int] = {}
    for i in range(n):
        for r in hard_reasons_list[i]:
            excluded_by_reason[r] = excluded_by_reason.get(r, 0) + 1

    counts = {
        "total": n,
        "excluded": n - m,
        "screened": sum(1 for t in tiers if t == "screened"),
        "deepReview": sum(1 for t in tiers if t == "deep_review"),
        "actionable": sum(1 for t in tiers if t == "actionable"),
    }

    def _sector_counts(tier_name: str) -> dict[str, int]:
        out: dict[str, int] = {}
        for k in range(m):
            if tiers[k] == tier_name:
                out[sectors[k]] = out.get(sectors[k], 0) + 1
        return out

    scored = [market_score[k] for k in range(m)]
    if scored:
        sorted_scored = sorted(scored)
        cnt = len(sorted_scored)
        mid = cnt // 2
        median = sorted_scored[mid] if cnt % 2 == 1 else (sorted_scored[mid - 1] + sorted_scored[mid]) / 2.0
        score_distribution = {
            "count": cnt,
            "min": sorted_scored[0],
            "max": sorted_scored[-1],
            "mean": sum(sorted_scored) / cnt,
            "median": median,
        }
    else:
        score_distribution = {"count": 0, "min": None, "max": None, "mean": None, "median": None}

    degradation_reasons: list[str] = []
    if is_cache_fallback:
        degradation_reasons.append("CACHE_FALLBACK_PROVENANCE: pipelinePath=cache_fallback")
    if is_stale:
        degradation_reasons.append("STALE_SOURCE: sourceUpdatedAt exceeds staleThresholdHours")
    if prescreen_fallback_used:
        degradation_reasons.append("PRESCREEN_FALLBACK_USED: prescreen result was cache_fallback/last-good")
    missing_prescreen_count = sum(1 for k in range(m) if not prescreen_usable_flags[k])
    if missing_prescreen_count > 0:
        degradation_reasons.append(
            f"PRESCREEN_METADATA_MISSING: {missing_prescreen_count}/{m} valid candidates missing usable prescreenScore"
        )
    if duplicate_indices:
        degradation_reasons.append(
            f"DUPLICATE_CANDIDATE_CODE: {len(duplicated_codes)} duplicate code(s), {len(duplicate_indices)} record(s) excluded"
        )

    result = {
        "schemaVersion": CANDIDATE_FUNNEL_SCHEMA_VERSION,
        "funnelVersion": CANDIDATE_FUNNEL_VERSION,
        "scoreVersion": CANDIDATE_FUNNEL_SCORE_VERSION,
        "not_for_trading": True,
        "status": "generated",
        "degradationReasons": degradation_reasons,
        "counts": counts,
        "candidates": candidate_results,
        "excludedSummary": {"total": n - m, "byReason": excluded_by_reason},
        "sectorDistribution": {
            "screened": _sector_counts("screened"),
            "deepReview": _sector_counts("deep_review"),
            "actionable": _sector_counts("actionable"),
        },
        "scoreDistribution": score_distribution,
        "selectionObservability": {
            "regimeApplied": regime,
            "actionableHardMaxApplied": actionable_hard_max,
            "actionableSectorCapApplied": actionable_sector_cap,
            "deepReviewHardMaxApplied": DEEP_REVIEW_HARD_MAX,
            "deepReviewSectorCapApplied": DEEP_REVIEW_SECTOR_HARD_CAP,
            "deepReviewSectorCapRelaxed": SECTOR_CAP_RELAXATION,
            "actionableSectorCapRelaxed": SECTOR_CAP_RELAXATION,
            "deepReviewSectorCapOverflow": dr_sector_overflow,
            "actionableSectorCapOverflow": ac_sector_overflow,
            "deepReviewEligibleCount": deep_review_eligible_count,
            "deepReviewSelectedCount": len(deep_review_selected),
            "actionableEligibleCount": len(actionable_pool),
            "actionableSelectedCount": len(actionable_selected),
            "sourceStale": is_stale,
            "fallbackProvenance": is_cache_fallback or prescreen_fallback_used,
        },
    }
    return result
