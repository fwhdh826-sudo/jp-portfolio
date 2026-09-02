#!/usr/bin/env python3
"""HOLDING-EVIDENCE-2A: holding_evidence.json artifact の Python 契約 validator。

stdlib のみ。src/domain/analysis/holdingEvidence.ts / src/types/holdingEvidence.ts の
frozen HE-1 構造契約を、cross-language drift を防ぐのに十分な精度で mirror する。

責務:
  - 生成された artifact を本番 data/holding_evidence.json へ atomic replace する前の
    構造検証（data/update_holding_evidence.py から呼ばれる）。
  - update-data.yml の pre-commit publication gate（public/data 側の strict 検証）。
  - Python / TypeScript parity fixture の Python 側 acceptance。

非責務:
  - TTL / freshness / identity join（runtime = holdingEvidence.ts の責務）。
  - BUY/SELL threshold の一切（この generator は evidence のみを所有する）。
"""
from __future__ import annotations

import json
import re
from typing import Any

SCHEMA_VERSION = "holding-evidence-1"
KIND = "holding_evidence"
MARKET = "TSE"

MIN_TECHNICAL_BARS = 75
# 財務諸表 source-age の実上限（FY0 period-end から）。これは "45 日" ではない。
STATEMENT_MAX_AGE_DAYS = 456
# de = not_applicable のときに HE-1 runtime が与える中立値（参照のみ。ここでは検証しない）。
NEUTRAL_DE = 1.5

FUNDAMENTALS_FIELDS = ("roe", "per", "pbr", "epsG", "cfOk", "de", "divG")
TECHNICALS_FIELDS = ("ma", "rsi", "macd", "vol", "mom3m")

# present のとき boolean を要求するフィールド（§4 STATUS TYPE PRECEDENCE）。
BOOLEAN_FIELDS = frozenset({"cfOk", "ma", "macd", "vol"})
# present のとき有限 number を要求するフィールド。
NUMERIC_FIELDS = frozenset(
    {"roe", "per", "pbr", "epsG", "de", "divG", "rsi", "mom3m"}
)

# not_applicable が契約上許容される唯一の required フィールド（§4 / HE-1 §8）。
NOT_APPLICABLE_FIELDS = frozenset({"de"})

# 現行 universe で de が本質的に適用不能なコード（東証33業種: 銀行業 等）。§14
DE_NOT_APPLICABLE_CODES = frozenset({"8306"})

FIELD_STATUSES = frozenset({"present", "missing", "not_applicable"})

STATUS_ENUM = FIELD_STATUSES

_CODE_RE = re.compile(r"^\d{3}[0-9A-HJ-NP-Z]$")

# src/utils/strictTimestamp.ts の DATE_TIME_RE と同一。permissive な datetime parse は
# 不可能な暦日（2026-02-30...）や 6 桁マイクロ秒 / +00:00 無 tz を通すため使わない。
_DATE_TIME_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$"
)

# 売買判断・注文を示す禁止キー（§28 / §33-3）。artifact は evidence のみを所有する。
FORBIDDEN_KEYS = frozenset(
    {
        "recommendedAction",
        "targetWeight",
        "rebalanceAmount",
        "orderQuantity",
        "officialDecision",
    }
)
# 文字列値中で禁止する standalone トークン。
_FORBIDDEN_TOKEN_RE = re.compile(r"\b(BUY|SELL|HOLD|WAIT)\b")


def _is_leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def _days_in_month(year: int, month: int) -> int:
    if month == 2:
        return 29 if _is_leap(year) else 28
    return 30 if month in (4, 6, 9, 11) else 31


def _valid_calendar_date(year: int, month: int, day: int) -> bool:
    return (
        1 <= year <= 9999
        and 1 <= month <= 12
        and 1 <= day <= _days_in_month(year, month)
    )


def is_strict_timestamp(value: Any) -> bool:
    """TS parseStrictTimestamp（date-time / tz 明示のみ）と等価な受理判定。"""
    if not isinstance(value, str) or not value:
        return False
    match = _DATE_TIME_RE.match(value)
    if not match:
        return False
    year, month, day, hour, minute, second = (int(match.group(i)) for i in range(1, 7))
    if not _valid_calendar_date(year, month, day):
        return False
    if hour > 23 or minute > 59 or second > 59:
        return False
    zone = match.group(8)
    if zone != "Z":
        offset_hour = int(zone[1:3])
        offset_minute = int(zone[4:6])
        if offset_hour > 23 or offset_minute > 59:
            return False
    return True


def is_canonical_timestamp(value: Any) -> bool:
    """厳密 canonical: YYYY-MM-DDTHH:MM:SS.mmmZ（ミリ秒 3 桁 + 終端 Z）。"""
    if not is_strict_timestamp(value):
        return False
    return bool(re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", value))


def _is_real_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_finite_number(value: Any) -> bool:
    if not _is_real_number(value):
        return False
    return value == value and value not in (float("inf"), float("-inf"))


def _check_field(errors: list[str], path: str, field: Any, key: str) -> None:
    if not isinstance(field, dict):
        errors.append(f"{path}: field must be an object")
        return
    if set(field.keys()) != {"v", "status"}:
        errors.append(f"{path}: field keys must be exactly {{v, status}}, got {sorted(field.keys())}")
        return
    status = field["status"]
    if status not in FIELD_STATUSES:
        errors.append(f"{path}: invalid status {status!r}")
        return
    value = field["v"]
    if status in ("missing", "not_applicable"):
        if value is not None:
            errors.append(f"{path}: status={status} requires v is null")
        if status == "not_applicable" and key not in NOT_APPLICABLE_FIELDS:
            errors.append(f"{path}: not_applicable is only legal for {sorted(NOT_APPLICABLE_FIELDS)}")
        return
    # status == present
    if key in BOOLEAN_FIELDS:
        if not isinstance(value, bool):
            errors.append(f"{path}: present boolean field requires v is bool")
    else:
        if not _is_finite_number(value) or isinstance(value, bool):
            errors.append(f"{path}: present numeric field requires v is a finite number")


def _check_field_map(errors: list[str], path: str, fields: Any, keys: tuple[str, ...]) -> None:
    if not isinstance(fields, dict):
        errors.append(f"{path}: fields must be an object")
        return
    if set(fields.keys()) != set(keys):
        errors.append(f"{path}: fields keys must be exactly {sorted(keys)}, got {sorted(fields.keys())}")
        return
    for key in keys:
        _check_field(errors, f"{path}.{key}", fields[key], key)


def _check_group(
    errors: list[str], path: str, group: Any, keys: tuple[str, ...], is_technicals: bool
) -> None:
    if not isinstance(group, dict):
        errors.append(f"{path}: group must be an object")
        return
    if not is_strict_timestamp(group.get("asOf")):
        errors.append(f"{path}.asOf: not a strict canonical timestamp")
    source = group.get("source")
    if not isinstance(source, str) or not source:
        errors.append(f"{path}.source: must be a non-empty string")
    if is_technicals:
        bars = group.get("bars")
        if isinstance(bars, bool) or not isinstance(bars, int) or bars < 0:
            errors.append(f"{path}.bars: must be a finite non-negative integer")
        expected_extra = {"asOf", "source", "bars", "fields"}
    else:
        expected_extra = {"asOf", "source", "fields"}
    if isinstance(group, dict) and set(group.keys()) != expected_extra:
        errors.append(f"{path}: group keys must be exactly {sorted(expected_extra)}, got {sorted(group.keys())}")
    _check_field_map(errors, f"{path}.fields", group.get("fields"), keys)


def _check_entry(errors: list[str], index: int, entry: Any) -> None:
    path = f"entries[{index}]"
    if not isinstance(entry, dict):
        errors.append(f"{path}: entry must be an object")
        return
    if set(entry.keys()) != {"code", "ticker", "market", "fundamentals", "technicals"}:
        errors.append(f"{path}: entry keys must be exactly {{code, ticker, market, fundamentals, technicals}}")
    code = entry.get("code")
    if not isinstance(code, str) or not _CODE_RE.match(code):
        errors.append(f"{path}.code: not a canonical JP stock code")
        code = None
    ticker = entry.get("ticker")
    if code is not None and ticker != f"{code}.T":
        errors.append(f"{path}.ticker: must equal code + '.T'")
    if entry.get("market") != MARKET:
        errors.append(f"{path}.market: must be {MARKET!r}")
    _check_group(errors, f"{path}.fundamentals", entry.get("fundamentals"), FUNDAMENTALS_FIELDS, False)
    _check_group(errors, f"{path}.technicals", entry.get("technicals"), TECHNICALS_FIELDS, True)


def _walk_forbidden(errors: list[str], node: Any, path: str) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            if key in FORBIDDEN_KEYS:
                errors.append(f"{path}: forbidden trading-decision key {key!r}")
            _walk_forbidden(errors, value, f"{path}.{key}")
    elif isinstance(node, list):
        for i, value in enumerate(node):
            _walk_forbidden(errors, value, f"{path}[{i}]")
    elif isinstance(node, str):
        if _FORBIDDEN_TOKEN_RE.search(node):
            errors.append(f"{path}: forbidden trading-decision token in string value")


def validate_holding_evidence_artifact(obj: Any) -> tuple[bool, list[str]]:
    """artifact object を構造検証する。 (ok, errors) を返す。throw しない。"""
    errors: list[str] = []
    try:
        if not isinstance(obj, dict):
            return False, ["root: artifact must be an object"]
        if obj.get("schemaVersion") != SCHEMA_VERSION:
            errors.append(f"root.schemaVersion: must be {SCHEMA_VERSION!r}")
        if obj.get("not_for_trading") is not True:
            errors.append("root.not_for_trading: must be boolean true")

        meta = obj.get("_meta")
        if not isinstance(meta, dict):
            errors.append("_meta: must be an object")
        else:
            if meta.get("kind") != KIND:
                errors.append(f"_meta.kind: must be {KIND!r}")
            if meta.get("schemaVersion") != SCHEMA_VERSION:
                errors.append(f"_meta.schemaVersion: must be {SCHEMA_VERSION!r}")
            if meta.get("not_for_trading") is not True:
                errors.append("_meta.not_for_trading: must be boolean true")
            if not is_strict_timestamp(meta.get("generatedAt")):
                errors.append("_meta.generatedAt: not a strict canonical timestamp")

        entries = obj.get("entries")
        if not isinstance(entries, list):
            errors.append("entries: must be a list")
        else:
            for index, entry in enumerate(entries):
                _check_entry(errors, index, entry)

        _walk_forbidden(errors, obj, "root")
    except Exception as exc:  # noqa: BLE001 - validator は決して throw しない
        return False, [f"validator exception: {exc!r}"]
    return (not errors), errors


def load_strict_json(path: str) -> Any:
    """NaN / Infinity を拒否して JSON をロードする。"""
    def _reject(constant: str) -> Any:
        raise ValueError(f"non-standard JSON constant: {constant}")

    with open(path, encoding="utf-8") as source:
        return json.load(source, parse_constant=_reject)


def validate_file(path: str) -> tuple[bool, list[str]]:
    try:
        obj = load_strict_json(path)
    except Exception as exc:  # noqa: BLE001
        return False, [f"{path}: {exc}"]
    return validate_holding_evidence_artifact(obj)


if __name__ == "__main__":
    import sys

    target = sys.argv[1] if len(sys.argv) > 1 else "data/holding_evidence.json"
    ok, problems = validate_file(target)
    if ok:
        print(f"holding_evidence contract ok: {target}")
        sys.exit(0)
    print(f"holding_evidence contract FAILED: {target}", file=sys.stderr)
    for problem in problems:
        print(f"  - {problem}", file=sys.stderr)
    sys.exit(1)
