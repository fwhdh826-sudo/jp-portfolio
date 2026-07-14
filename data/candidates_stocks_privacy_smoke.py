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

import json
import sys
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "candidates-stocks-1"
ALLOWED_STATUS = ("ok", "partial", "empty")

# P4.5-A010/A010-1a: 個人資産・実額・口座種別を含めない方針のguard
FORBIDDEN_KEYS = {
    "eval", "pnlPct", "purchase_date", "acquiredAt", "account",
    "accountType", "holdings", "cash", "reserve", "amount",
    "maxAmount", "sizing", "headroom", "score", "action",
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

    if payload.get("schemaVersion") != SCHEMA_VERSION:
        violations.append(
            f"{label}: schemaVersion != {SCHEMA_VERSION!r} "
            f"(got {payload.get('schemaVersion')!r})"
        )

    candidates = payload.get("candidates")
    if not isinstance(candidates, list):
        violations.append(f"{label}: candidates is not a list")
        candidates = []

    if payload.get("_meta", {}).get("not_for_trading") is not True:
        violations.append(f"{label}: _meta.not_for_trading is not True")

    if payload.get("status") not in ALLOWED_STATUS:
        violations.append(
            f"{label}: status {payload.get('status')!r} not in {ALLOWED_STATUS}"
        )

    for c in candidates:
        if not isinstance(c, dict):
            violations.append(f"{label}: candidate entry is not a dict")
            continue
        leaked = FORBIDDEN_KEYS & set(c.keys())
        if leaked:
            violations.append(
                f"{label}: forbidden keys {sorted(leaked)} in candidate {c.get('code')!r}"
            )

    return violations


def check_candidates_stocks_files(paths: tuple[str, ...] = DEFAULT_PATHS) -> list[str]:
    """複数ファイルを検査し、全違反理由のlistを返す（空=全ファイルok）。
    ファイル自体が読めない/JSON不正な場合もviolationとして報告する
    （旧inline実装のtry/exceptと同様、読み込み失敗もguard対象）。"""
    violations: list[str] = []
    for p in paths:
        path = Path(p)
        try:
            payload = json.loads(path.read_text())
        except Exception as e:  # noqa: BLE001 - 読み込み失敗自体がguard対象
            violations.append(f"{p}: failed to read/parse ({e!r})")
            continue
        violations.extend(check_candidates_stocks_payload(payload, p))
    return violations


def main() -> int:
    violations = check_candidates_stocks_files()
    if violations:
        for v in violations:
            print(f"FAIL candidates_stocks smoke: {v}", file=sys.stderr)
        print("candidates_stocks smoke FAIL", file=sys.stderr)
        return 1
    print("candidates_stocks smoke ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
