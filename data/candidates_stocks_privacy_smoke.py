#!/usr/bin/env python3
"""candidates_stocks.json のprivacy/schema smoke guard。

P4.5-A010/A010-1a: 個人資産・実額・口座種別を含めない方針のguard。
P5-B004c-3: 従来.github/workflows/full_batch.ymlにinline heredocとして
存在していたcheckを、テスト可能な関数へ抽出しfail-closed化したもの。
違反が1件でもあればmain()はexit 1を返す（旧実装はWARNのみでexit 0
継続していた=B004d production接続前に閉じるべきgapだった）。

data/candidates_stocks.json と public/data/candidates_stocks.json の
両方を検査する（片方だけ壊れているケースも検出する）。
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "candidates-stocks-1"
ALLOWED_STATUS = ("ok", "partial", "empty")
PIPELINE_CONTRACT = "jpx_whole_market_candidates_v1"
ALLOWED_PIPELINE_PATHS = ("normal", "cache_fallback", "seed_fallback")
WHOLE_MARKET_MIN_COUNT = 50
PUBLISH_MAX_COUNT = 200
SEED_FALLBACK_COUNT = 41
SHORTLIST_MAX_COUNT = 300
SHORTLIST_SUCCESS_RATIO_MIN = 0.70
ENRICHMENT_SUCCESS_RATIO_MIN = 0.90

ROOT_ALLOWED_KEYS = {
    "schemaVersion", "updatedAt", "sourceUpdatedAt", "staleThresholdHours",
    "_meta", "candidates", "missing", "status",
}
META_ALLOWED_KEYS = {
    "kind", "source", "not_for_trading", "universe", "note", "counts",
    "universeProvenance", "pipelineContract", "pipelinePath", "runToken",
}
COUNTS_ALLOWED_KEYS = {
    "universeCount", "publishedCount", "truncatedCount", "failedTotalCount",
}
PROVENANCE_ALLOWED_KEYS = {
    "pipelinePath", "jpxSource", "jpxFallbackUsed", "jpxEligibleCount",
    "shortlistId", "shortlistCount", "shortlistSuccessRatio",
    "shortlistFallbackUsed", "shortlistFallbackReason",
    "shortlistBypassSeedListV1", "sectorCapRelaxed", "sectorCapRelaxedCount",
}
CANDIDATE_ALLOWED_KEYS = {
    "code", "name", "sector", "price", "per", "pbr", "roe",
    "dividendYield", "sigma252d", "mom3m", "screenReasons", "dataStatus",
}
PRODUCTION_REQUIRED_ROOT_KEYS = ROOT_ALLOWED_KEYS
PRODUCTION_REQUIRED_META_KEYS = META_ALLOWED_KEYS - {"runToken"}

# P4.5-A010/A010-1a: 個人資産・実額・口座種別を含めない方針のguard
FORBIDDEN_KEYS = {
    "eval", "pnlPct", "purchase_date", "acquiredAt", "account",
    "accountType", "holdings", "cash", "reserve", "amount",
    "maxAmount", "sizing", "headroom", "score", "action", "portfolio",
    "quantity", "purchasePrice", "marketValue", "broker", "nisa", "csv",
}

DEFAULT_PATHS: tuple[str, ...] = (
    "data/candidates_stocks.json",
    "public/data/candidates_stocks.json",
)


def check_candidates_stocks_payload(payload: Any, label: str) -> list[str]:
    """1ファイル分のpayloadを検査し、違反理由のlistを返す（空=違反なし）。"""
    if not isinstance(payload, dict):
        return [f"{label}: payload is not a dict"]

    violations: list[str] = []

    unexpected_root = sorted(set(payload) - ROOT_ALLOWED_KEYS)
    if unexpected_root:
        violations.append(f"{label}: unexpected root keys {unexpected_root}")

    if payload.get("schemaVersion") != SCHEMA_VERSION:
        violations.append(
            f"{label}: schemaVersion != {SCHEMA_VERSION!r} "
            f"(got {payload.get('schemaVersion')!r})"
        )

    candidates = payload.get("candidates")
    if not isinstance(candidates, list):
        violations.append(f"{label}: candidates is not a list")
        candidates = []

    meta = payload.get("_meta")
    if not isinstance(meta, dict):
        violations.append(f"{label}: _meta is not a dict")
        meta = {}
    else:
        unexpected_meta = sorted(set(meta) - META_ALLOWED_KEYS)
        if unexpected_meta:
            violations.append(f"{label}: unexpected _meta keys {unexpected_meta}")

        counts = meta.get("counts")
        if isinstance(counts, dict):
            unexpected_counts = sorted(set(counts) - COUNTS_ALLOWED_KEYS)
            if unexpected_counts:
                violations.append(
                    f"{label}: unexpected _meta.counts keys {unexpected_counts}"
                )

        provenance = meta.get("universeProvenance")
        if isinstance(provenance, dict):
            unexpected_provenance = sorted(
                set(provenance) - PROVENANCE_ALLOWED_KEYS
            )
            if unexpected_provenance:
                violations.append(
                    f"{label}: unexpected _meta.universeProvenance keys "
                    f"{unexpected_provenance}"
                )

    if meta.get("not_for_trading") is not True:
        violations.append(f"{label}: _meta.not_for_trading is not True")

    if payload.get("status") not in ALLOWED_STATUS:
        violations.append(
            f"{label}: status {payload.get('status')!r} not in {ALLOWED_STATUS}"
        )

    for c in candidates:
        if not isinstance(c, dict):
            violations.append(f"{label}: candidate entry is not a dict")
            continue
        unexpected_candidate = sorted(set(c) - CANDIDATE_ALLOWED_KEYS)
        if unexpected_candidate:
            violations.append(
                f"{label}: forbidden/unexpected keys {unexpected_candidate} "
                f"in candidate {c.get('code')!r}"
            )
        if "screenReasons" in c and (
            not isinstance(c["screenReasons"], list)
            or not all(isinstance(reason, str) for reason in c["screenReasons"])
        ):
            violations.append(
                f"{label}: candidate {c.get('code')!r} screenReasons must be a list of strings"
            )

    missing = payload.get("missing")
    if missing is not None and (
        not isinstance(missing, list)
        or not all(isinstance(code, str) for code in missing)
    ):
        violations.append(f"{label}: missing must be a list of strings")

    return violations


def _parse_iso(raw: Any) -> datetime | None:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(timezone.utc)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def check_production_candidates_stocks_payload(
    payload: Any,
    label: str,
    run_started_at: str | None = None,
    expected_run_token: str | None = None,
    checked_at: datetime | None = None,
) -> list[str]:
    """whole-market production成果物のE2E契約を検証する。

    schema/privacyに加え、provenance、明示的fallback種別、件数、内部count
    整合、今回runでのfreshnessをfail-closedで確認する。
    """
    violations = check_candidates_stocks_payload(payload, label)
    if not isinstance(payload, dict):
        return violations

    meta = payload.get("_meta")
    if not isinstance(meta, dict):
        meta = {}

    if meta.get("kind") != "candidates_stocks":
        violations.append(f"{label}: _meta.kind is not 'candidates_stocks'")
    missing_root_keys = sorted(PRODUCTION_REQUIRED_ROOT_KEYS - set(payload))
    if missing_root_keys:
        violations.append(f"{label}: missing production root keys {missing_root_keys}")
    missing_meta_keys = sorted(PRODUCTION_REQUIRED_META_KEYS - set(meta))
    if missing_meta_keys:
        violations.append(f"{label}: missing production _meta keys {missing_meta_keys}")
    if not isinstance(meta.get("source"), str) or not meta.get("source"):
        violations.append(f"{label}: _meta.source must be a non-empty string")
    if not isinstance(meta.get("note"), str) or not meta.get("note"):
        violations.append(f"{label}: _meta.note must be a non-empty string")
    if payload.get("staleThresholdHours") != 48:
        violations.append(f"{label}: staleThresholdHours must be 48")
    if meta.get("pipelineContract") != PIPELINE_CONTRACT:
        violations.append(
            f"{label}: _meta.pipelineContract != {PIPELINE_CONTRACT!r}"
        )

    if expected_run_token is not None and meta.get("runToken") != expected_run_token:
        violations.append(f"{label}: _meta.runToken does not match expected current run token")
    if "runToken" in meta and (
        not isinstance(meta["runToken"], str) or not meta["runToken"].strip()
    ):
        violations.append(f"{label}: _meta.runToken must be a non-empty string")

    pipeline_path = meta.get("pipelinePath")
    if pipeline_path not in ALLOWED_PIPELINE_PATHS:
        violations.append(
            f"{label}: _meta.pipelinePath {pipeline_path!r} not in "
            f"{ALLOWED_PIPELINE_PATHS}"
        )

    candidates = payload.get("candidates")
    if not isinstance(candidates, list):
        candidates = []
    candidate_count = len(candidates)
    if candidate_count > PUBLISH_MAX_COUNT:
        violations.append(
            f"{label}: published candidates {candidate_count} exceeds {PUBLISH_MAX_COUNT}"
        )

    statuses = [c.get("dataStatus") for c in candidates if isinstance(c, dict)]
    invalid_statuses = sorted(
        {repr(status) for status in statuses if status not in ("ok", "partial")}
    )
    if invalid_statuses:
        violations.append(f"{label}: invalid candidate dataStatus values {invalid_statuses}")
    ok_count = statuses.count("ok")
    expected_status = (
        "empty" if candidate_count == 0 or ok_count == 0
        else "ok" if ok_count == candidate_count
        else "partial"
    )
    if payload.get("status") != expected_status:
        violations.append(
            f"{label}: status {payload.get('status')!r} is inconsistent with "
            f"candidate dataStatus distribution (expected {expected_status!r})"
        )
    if candidate_count == 0 or ok_count * 100 < candidate_count * 90:
        ratio = ok_count / candidate_count if candidate_count else 0.0
        violations.append(
            f"{label}: published enrichment success ratio {ratio:.4f} below "
            f"{ENRICHMENT_SUCCESS_RATIO_MIN:.2f} ({ok_count}/{candidate_count})"
        )

    counts = meta.get("counts")
    if not isinstance(counts, dict):
        violations.append(f"{label}: _meta.counts is not a dict")
        counts = {}
    if counts.get("publishedCount") != candidate_count:
        violations.append(f"{label}: counts.publishedCount does not match candidates length")
    for count_key in COUNTS_ALLOWED_KEYS:
        count_value = counts.get(count_key)
        if not _is_int(count_value) or count_value < 0:
            violations.append(f"{label}: counts.{count_key} is invalid")
    universe_count = counts.get("universeCount")
    truncated_count = counts.get("truncatedCount")
    if _is_int(universe_count) and universe_count < candidate_count:
        violations.append(f"{label}: counts.universeCount is smaller than publishedCount")
    if not _is_int(truncated_count) or truncated_count < 0:
        pass
    elif _is_int(universe_count) and universe_count - candidate_count != truncated_count:
        violations.append(
            f"{label}: counts.truncatedCount is inconsistent with universeCount-publishedCount"
        )
    failed_total = counts.get("failedTotalCount")

    missing = payload.get("missing")
    if not isinstance(missing, list):
        violations.append(f"{label}: missing is not a list")
        missing = []
    missing_strings = [code for code in missing if isinstance(code, str)]

    candidate_codes: list[str] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        missing_candidate_keys = sorted(CANDIDATE_ALLOWED_KEYS - set(candidate))
        if missing_candidate_keys:
            violations.append(
                f"{label}: candidate {candidate.get('code')!r} missing required keys "
                f"{missing_candidate_keys}"
            )
        for required_key in ("code", "name", "sector"):
            if required_key not in candidate:
                continue
            if not isinstance(candidate[required_key], str) or not candidate[required_key]:
                violations.append(
                    f"{label}: candidate {candidate.get('code')!r} {required_key} "
                    "must be a non-empty string"
                )
        code = candidate.get("code")
        if isinstance(code, str):
            candidate_codes.append(code)
        for numeric_key in (
            "price", "per", "pbr", "roe", "dividendYield", "sigma252d", "mom3m"
        ):
            value = candidate.get(numeric_key)
            if value is not None and not _is_number(value):
                violations.append(
                    f"{label}: candidate {code!r} {numeric_key} must be finite number or null"
                )
        has_any_market_data = any(
            candidate.get(numeric_key) is not None
            for numeric_key in (
                "price", "per", "pbr", "roe", "dividendYield", "sigma252d", "mom3m"
            )
        )
        if candidate.get("dataStatus") == "ok" and not has_any_market_data:
            violations.append(
                f"{label}: candidate {code!r} dataStatus ok has no enriched market data"
            )
        if candidate.get("dataStatus") == "partial" and has_any_market_data:
            violations.append(
                f"{label}: candidate {code!r} dataStatus partial has enriched market data"
            )

    duplicate_codes = sorted(
        {code for code in candidate_codes if candidate_codes.count(code) > 1}
    )
    if duplicate_codes:
        violations.append(f"{label}: duplicate candidate codes {duplicate_codes}")

    expected_missing = [
        candidate.get("code")
        for candidate in candidates
        if isinstance(candidate, dict) and candidate.get("dataStatus") == "partial"
    ]
    if missing_strings != expected_missing or len(missing_strings) != len(missing):
        violations.append(
            f"{label}: missing does not exactly match partial candidate codes"
        )

    if _is_int(failed_total) and _is_int(truncated_count):
        minimum_failed = len(expected_missing)
        maximum_failed = minimum_failed + truncated_count
        if not minimum_failed <= failed_total <= maximum_failed:
            violations.append(
                f"{label}: counts.failedTotalCount is inconsistent; builder semantics require "
                f"{minimum_failed}..{maximum_failed}"
            )
    if _is_int(universe_count) and universe_count > 0 and _is_int(failed_total):
        total_ok = universe_count - failed_total
        if total_ok < 0 or total_ok * 100 < universe_count * 90:
            ratio = total_ok / universe_count
            violations.append(
                f"{label}: total enrichment success ratio {ratio:.4f} below "
                f"{ENRICHMENT_SUCCESS_RATIO_MIN:.2f} ({total_ok}/{universe_count})"
            )

    provenance = meta.get("universeProvenance")
    if not isinstance(provenance, dict):
        violations.append(f"{label}: _meta.universeProvenance is not a dict")
        provenance = {}
    required_provenance = {
        "pipelinePath", "jpxSource", "jpxFallbackUsed", "jpxEligibleCount",
        "shortlistId", "shortlistCount", "shortlistSuccessRatio",
        "shortlistFallbackUsed", "shortlistFallbackReason",
        "shortlistBypassSeedListV1", "sectorCapRelaxed",
        "sectorCapRelaxedCount",
    }
    missing_provenance = sorted(required_provenance - set(provenance))
    if missing_provenance:
        violations.append(f"{label}: missing provenance keys {missing_provenance}")
    if provenance.get("pipelinePath") != pipeline_path:
        violations.append(f"{label}: provenance pipelinePath does not match _meta")

    for boolean_key in (
        "jpxFallbackUsed", "shortlistFallbackUsed", "shortlistBypassSeedListV1",
        "sectorCapRelaxed",
    ):
        if not isinstance(provenance.get(boolean_key), bool):
            violations.append(f"{label}: provenance {boolean_key} must be boolean")
    for integer_key in (
        "jpxEligibleCount", "shortlistCount", "sectorCapRelaxedCount",
    ):
        value = provenance.get(integer_key)
        if not _is_int(value) or value < 0:
            violations.append(f"{label}: provenance {integer_key} is invalid")
    shortlist_ratio = provenance.get("shortlistSuccessRatio")
    if not _is_number(shortlist_ratio) or not 0 <= shortlist_ratio <= 1:
        violations.append(f"{label}: provenance shortlistSuccessRatio is invalid")
    for string_key in ("jpxSource", "shortlistId"):
        value = provenance.get(string_key)
        if not isinstance(value, str) or not value:
            violations.append(f"{label}: provenance {string_key} must be non-empty string")

    universe = meta.get("universe")
    bypass = provenance.get("shortlistBypassSeedListV1")
    jpx_fallback = provenance.get("jpxFallbackUsed")
    shortlist_fallback = provenance.get("shortlistFallbackUsed")
    fallback_reason = provenance.get("shortlistFallbackReason")
    if shortlist_fallback is True:
        if not isinstance(fallback_reason, str) or not fallback_reason.strip():
            violations.append(
                f"{label}: shortlist fallback requires non-empty shortlistFallbackReason"
            )
    elif shortlist_fallback is False and fallback_reason is not None:
        violations.append(
            f"{label}: shortlistFallbackReason must be null when shortlist fallback is false"
        )

    sector_cap_relaxed = provenance.get("sectorCapRelaxed")
    sector_cap_relaxed_count = provenance.get("sectorCapRelaxedCount")
    if sector_cap_relaxed is False and sector_cap_relaxed_count != 0:
        violations.append(f"{label}: sectorCapRelaxedCount must be 0 when not relaxed")
    if sector_cap_relaxed is True and (
        not _is_int(sector_cap_relaxed_count) or sector_cap_relaxed_count <= 0
    ):
        violations.append(f"{label}: relaxed sector cap requires positive relaxed count")

    if pipeline_path == "normal":
        if universe != "jpx_cheap_prescreen_v1":
            violations.append(f"{label}: normal path must use jpx_cheap_prescreen_v1")
        if not WHOLE_MARKET_MIN_COUNT <= candidate_count <= PUBLISH_MAX_COUNT:
            violations.append(f"{label}: normal path candidate count outside 50..200")
        if jpx_fallback is not False or shortlist_fallback is not False or bypass is not False:
            violations.append(f"{label}: normal path has fallback provenance")
        if provenance.get("shortlistId") != "jpx_cheap_prescreen_v1":
            violations.append(f"{label}: normal path shortlistId is invalid")
        if not _is_int(provenance.get("jpxEligibleCount")) or provenance.get("jpxEligibleCount") <= 0:
            violations.append(f"{label}: normal path jpxEligibleCount must be positive")
        if _is_number(shortlist_ratio) and shortlist_ratio < SHORTLIST_SUCCESS_RATIO_MIN:
            violations.append(f"{label}: normal path shortlistSuccessRatio below 0.70")
    elif pipeline_path == "cache_fallback":
        if universe != "jpx_cheap_prescreen_v1":
            violations.append(f"{label}: cache_fallback must use jpx_cheap_prescreen_v1")
        if not WHOLE_MARKET_MIN_COUNT <= candidate_count <= PUBLISH_MAX_COUNT:
            violations.append(f"{label}: cache_fallback candidate count outside 50..200")
        if not (jpx_fallback is True or shortlist_fallback is True) or bypass is not False:
            violations.append(f"{label}: cache_fallback provenance is inconsistent")
        if provenance.get("shortlistId") != "jpx_cheap_prescreen_v1":
            violations.append(f"{label}: cache_fallback shortlistId is invalid")
    elif pipeline_path == "seed_fallback":
        if universe != "seed_list_v1" or candidate_count != SEED_FALLBACK_COUNT:
            violations.append(f"{label}: seed_fallback must publish seed_list_v1/41")
        if bypass is not True or shortlist_fallback is not True:
            violations.append(f"{label}: seed_fallback bypass provenance is inconsistent")
        if provenance.get("shortlistId") != "seed_list_v1_bypass":
            violations.append(f"{label}: seed_fallback shortlistId is invalid")
        if provenance.get("shortlistCount") != 0:
            violations.append(f"{label}: seed_fallback shortlistCount must be 0")
        if provenance.get("shortlistSuccessRatio") != 0.0:
            violations.append(f"{label}: seed_fallback shortlistSuccessRatio must be 0")
        if sector_cap_relaxed is not False or sector_cap_relaxed_count != 0:
            violations.append(f"{label}: seed_fallback sector cap provenance is invalid")

    shortlist_count = provenance.get("shortlistCount")
    jpx_eligible_count = provenance.get("jpxEligibleCount")
    if pipeline_path in ("normal", "cache_fallback"):
        if not _is_int(universe_count) or not WHOLE_MARKET_MIN_COUNT <= universe_count <= SHORTLIST_MAX_COUNT:
            violations.append(f"{label}: whole-market universeCount outside 50..300")
        if shortlist_count != universe_count:
            violations.append(f"{label}: provenance shortlistCount does not match universeCount")
        if _is_int(universe_count) and candidate_count != min(universe_count, PUBLISH_MAX_COUNT):
            violations.append(f"{label}: publishedCount does not match builder publish cap semantics")
        if _is_int(jpx_eligible_count) and _is_int(shortlist_count) and jpx_eligible_count < shortlist_count:
            violations.append(f"{label}: jpxEligibleCount is smaller than shortlistCount")
    elif pipeline_path == "seed_fallback":
        if universe_count != SEED_FALLBACK_COUNT or truncated_count != 0:
            violations.append(f"{label}: seed_fallback counts must be universe=41/truncated=0")

    updated_at = _parse_iso(payload.get("updatedAt"))
    source_updated_at = _parse_iso(payload.get("sourceUpdatedAt"))
    if updated_at is None or source_updated_at is None:
        violations.append(
            f"{label}: updatedAt/sourceUpdatedAt must be valid timezone-aware timestamps"
        )
    if checked_at is None:
        checked_at = datetime.now(timezone.utc)
    elif checked_at.tzinfo is None or checked_at.utcoffset() is None:
        checked_at = checked_at.replace(tzinfo=timezone.utc)
    else:
        checked_at = checked_at.astimezone(timezone.utc)
    for timestamp_name, timestamp_value in (
        ("updatedAt", updated_at), ("sourceUpdatedAt", source_updated_at),
    ):
        if timestamp_value is not None and timestamp_value > checked_at:
            violations.append(f"{label}: {timestamp_name} is in the future")
    if run_started_at is not None:
        run_start = _parse_iso(run_started_at)
        if run_start is None:
            violations.append(f"{label}: run_started_at is not a valid timestamp")
        else:
            if updated_at is None or updated_at <= run_start:
                violations.append(f"{label}: updatedAt was not produced by current run")
            if source_updated_at is None or source_updated_at <= run_start:
                violations.append(f"{label}: sourceUpdatedAt was not produced by current run")

    return violations


def check_candidates_stocks_files(
    paths: tuple[str, ...] = DEFAULT_PATHS,
    *,
    production: bool = False,
    run_started_at: str | None = None,
    expected_run_token: str | None = None,
    checked_at: datetime | None = None,
) -> list[str]:
    """複数ファイルを検査し、全違反理由のlistを返す（空=全ファイルok）。
    ファイル自体が読めない/JSON不正な場合もviolationとして報告する
    （旧inline実装のtry/exceptと同様、読み込み失敗もguard対象）。"""
    violations: list[str] = []
    parsed_payloads: list[tuple[str, Any]] = []
    for p in paths:
        path = Path(p)
        try:
            payload = json.loads(path.read_text())
        except Exception as e:  # noqa: BLE001 - 読み込み失敗自体がguard対象
            violations.append(f"{p}: failed to read/parse ({e!r})")
            continue
        parsed_payloads.append((p, payload))
        if production:
            violations.extend(
                check_production_candidates_stocks_payload(
                    payload,
                    p,
                    run_started_at,
                    expected_run_token,
                    checked_at,
                )
            )
        else:
            violations.extend(check_candidates_stocks_payload(payload, p))
    if production and len(parsed_payloads) == len(paths) and len(parsed_payloads) > 1:
        first_payload = parsed_payloads[0][1]
        if any(payload != first_payload for _label, payload in parsed_payloads[1:]):
            violations.append("candidates_stocks data/public artifacts are not identical")
    return violations


def main(argv: list[str] | tuple[str, ...] = ()) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--production", action="store_true")
    parser.add_argument("--run-started-at")
    parser.add_argument("--expected-run-token")
    args = parser.parse_args(argv)
    if args.production and (not args.run_started_at or not args.expected_run_token):
        parser.error(
            "--production requires --run-started-at and --expected-run-token"
        )

    violations = check_candidates_stocks_files(
        production=args.production,
        run_started_at=args.run_started_at,
        expected_run_token=args.expected_run_token,
    )
    if violations:
        for v in violations:
            print(f"FAIL candidates_stocks smoke: {v}", file=sys.stderr)
        print("candidates_stocks smoke FAIL", file=sys.stderr)
        return 1
    print("candidates_stocks smoke ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
