#!/usr/bin/env python3
"""candidate_funnel.json のprivacy/schema smoke guard（P5-B005-B2）。

data/candidates_stocks_privacy_smoke.py と同じ規律（exact-key検査、
fail-closed、data/public両方を検査）を、より深いnested構造を持つ
candidate_funnel.json向けに適用する。substring一致ではなくexact-key一致で
forbidden fieldを検査する（値文字列に禁止語を含むだけの誤検出を避ける）。

data/candidates_stocks_privacy_smoke.py との統合ではなく独立moduleにした
理由: 対象schemaの形状（top-level 12 key + _meta、candidate 18 key、
scoreBreakdown入れ子等）が全く異なり、共有すると両方のexact-key契約が
弱くなるため。
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from data.candidate_funnel_engine import (
    CANDIDATE_FUNNEL_DATA_STATUSES,
    CANDIDATE_FUNNEL_HARD_REASON_CODES,
    CANDIDATE_FUNNEL_PRESCREEN_POOLS,
    CANDIDATE_FUNNEL_SCHEMA_VERSION,
    CANDIDATE_FUNNEL_SCORE_VERSION,
    CANDIDATE_FUNNEL_SELECTED_REASON_CODES,
    CANDIDATE_FUNNEL_SOFT_REASON_CODES,
    CANDIDATE_FUNNEL_STATUSES,
    CANDIDATE_FUNNEL_THEME_STATUSES,
    CANDIDATE_FUNNEL_TIERS,
    CANDIDATE_FUNNEL_VERSION,
    COMPONENT_IDS,
)

DEFAULT_PATHS: tuple[str, ...] = (
    "data/candidate_funnel.json",
    "public/data/candidate_funnel.json",
)

ROOT_ALLOWED_KEYS = {
    "schemaVersion", "funnelVersion", "scoreVersion", "not_for_trading", "status",
    "degradationReasons", "counts", "candidates", "excludedSummary",
    "sectorDistribution", "scoreDistribution", "selectionObservability", "_meta",
}
COUNTS_ALLOWED_KEYS = {"total", "excluded", "screened", "deepReview", "actionable"}
CANDIDATE_ALLOWED_KEYS = {
    "code", "name", "sector", "prescreenScore", "prescreenRank", "prescreenPool",
    "scoreBreakdown", "rawCompositeScore", "dataConfidence", "marketScore",
    "marketRank", "tier", "selectedReasons", "riskReasons", "hardExclusionReasons",
    "themes", "themeStatus", "dataStatus",
}
SCORE_COMPONENT_ALLOWED_KEYS = {"id", "value", "weight", "weightedContribution", "status", "sourceFields"}
META_ALLOWED_KEYS = {
    "kind", "not_for_trading", "generatedAt", "asOf", "sourceUpdatedAt",
    "pipelinePath", "regimeRequested", "join", "qualityGate",
}

# P5-B005-B2-R1: current-run provenance検査対象のquality gate id。
# candidate_funnel_batch.pyのcompute_quality_report()がP-01..P-15を毎回
# 生成する（frozen — batch側の定義を唯一のauthorityとして参照する）。
QUALITY_GATE_REQUIRED_IDS = frozenset(f"P-{i:02d}" for i in range(1, 16))

# P5-B005-B2 §7/§11: recursiveに（トップレベルのみでなく全階層へ）exact-key検査
# する禁止field。portfolio/holdings/cash/headroom/amount/officialDecision等、
# B2が絶対に出力してはならない値。substringではなくkey名の完全一致で検査する
# （値文字列に禁止語を含むだけの誤検出を避ける）。
FORBIDDEN_KEYS = {
    "portfolioFit", "portfolio", "holdings", "cash", "reserve", "amount",
    "maxAmount", "sizing", "headroom", "quantity", "purchasePrice",
    "marketValue", "officialDecision", "action", "BUY_NEW", "WATCH", "SELL",
    "account", "accountType", "broker", "nisa", "csv", "blockedReasons",
    "normalizedPrescreenScore", "eval", "pnlPct", "purchase_date", "acquiredAt",
}


def _is_valid_iso_timestamp(value: str) -> bool:
    """ISO8601形式（Python 3.11+ datetime.fromisoformatが受理する形式。
    'Z' suffixも許容する）としてparse可能かどうかを返す。"""
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def _recursive_forbidden_keys(node: Any) -> set[str]:
    """任意の深さのdict keyを走査し、FORBIDDEN_KEYSに含まれるkey名を集める
    （exact match。値の中身は見ない）。"""
    found: set[str] = set()
    if isinstance(node, dict):
        for k, v in node.items():
            if k in FORBIDDEN_KEYS:
                found.add(k)
            found |= _recursive_forbidden_keys(v)
    elif isinstance(node, list):
        for item in node:
            found |= _recursive_forbidden_keys(item)
    return found


def check_candidate_funnel_payload(payload: Any, label: str) -> list[str]:
    """1ファイル分のpayloadを検査し、違反理由のlistを返す（空=違反なし）。"""
    if not isinstance(payload, dict):
        return [f"{label}: payload is not a dict"]

    violations: list[str] = []

    unexpected_root = sorted(set(payload) - ROOT_ALLOWED_KEYS)
    if unexpected_root:
        violations.append(f"{label}: unexpected root keys {unexpected_root}")

    if payload.get("schemaVersion") != CANDIDATE_FUNNEL_SCHEMA_VERSION:
        violations.append(f"{label}: schemaVersion mismatch (got {payload.get('schemaVersion')!r})")
    if payload.get("funnelVersion") != CANDIDATE_FUNNEL_VERSION:
        violations.append(f"{label}: funnelVersion mismatch (got {payload.get('funnelVersion')!r})")
    if payload.get("scoreVersion") != CANDIDATE_FUNNEL_SCORE_VERSION:
        violations.append(f"{label}: scoreVersion mismatch (got {payload.get('scoreVersion')!r})")

    if payload.get("not_for_trading") is not True:
        violations.append(f"{label}: not_for_trading is not True")
    if payload.get("status") not in CANDIDATE_FUNNEL_STATUSES:
        violations.append(f"{label}: status {payload.get('status')!r} not in {CANDIDATE_FUNNEL_STATUSES}")

    counts = payload.get("counts")
    if not isinstance(counts, dict):
        violations.append(f"{label}: counts is not a dict")
    else:
        unexpected_counts = sorted(set(counts) - COUNTS_ALLOWED_KEYS)
        if unexpected_counts:
            violations.append(f"{label}: unexpected counts keys {unexpected_counts}")

    meta = payload.get("_meta")
    if not isinstance(meta, dict):
        violations.append(f"{label}: _meta is not a dict")
    else:
        unexpected_meta = sorted(set(meta) - META_ALLOWED_KEYS)
        if unexpected_meta:
            violations.append(f"{label}: unexpected _meta keys {unexpected_meta}")
        if meta.get("not_for_trading") is not True:
            violations.append(f"{label}: _meta.not_for_trading is not True")
        if meta.get("kind") != "candidate_funnel":
            violations.append(f"{label}: _meta.kind is not 'candidate_funnel'")

        # P5-B005-B2-R1 current-run provenance: workflow greenが「今回のrunで
        # 生成されたartifact」を意味することの最終防衛線。batch側は
        # overallPass=True かつ hardFailIds=[] の場合のみpublishするが
        # （run_batch()のfail-closed契約）、このsmokeはcommit直前の独立した
        # 検査として同じ契約を再確認する（batch側の契約が将来壊れても
        # smokeが単独で検出できるようにする）。
        generated_at = meta.get("generatedAt")
        if not isinstance(generated_at, str) or not _is_valid_iso_timestamp(generated_at):
            violations.append(f"{label}: _meta.generatedAt is not a valid timestamp (got {generated_at!r})")

        quality_gate = meta.get("qualityGate")
        if not isinstance(quality_gate, dict):
            violations.append(f"{label}: _meta.qualityGate is not a dict")
        else:
            if quality_gate.get("overallPass") is not True:
                violations.append(f"{label}: _meta.qualityGate.overallPass is not True")
            hard_fail_ids = quality_gate.get("hardFailIds")
            if hard_fail_ids != []:
                violations.append(f"{label}: _meta.qualityGate.hardFailIds is not empty (got {hard_fail_ids!r})")
            gates = quality_gate.get("gates")
            gate_ids = {g.get("id") for g in gates if isinstance(g, dict)} if isinstance(gates, list) else set()
            missing_gate_ids = sorted(QUALITY_GATE_REQUIRED_IDS - gate_ids)
            if missing_gate_ids:
                violations.append(f"{label}: _meta.qualityGate.gates missing required ids {missing_gate_ids}")

    candidates = payload.get("candidates")
    if not isinstance(candidates, list):
        violations.append(f"{label}: candidates is not a list")
        candidates = []

    for c in candidates:
        if not isinstance(c, dict):
            violations.append(f"{label}: candidate entry is not a dict")
            continue
        unexpected_candidate = sorted(set(c) - CANDIDATE_ALLOWED_KEYS)
        if unexpected_candidate:
            violations.append(f"{label}: unexpected/forbidden keys {unexpected_candidate} in candidate {c.get('code')!r}")
        if c.get("tier") not in CANDIDATE_FUNNEL_TIERS:
            violations.append(f"{label}: candidate {c.get('code')!r} invalid tier {c.get('tier')!r}")
        if c.get("themeStatus") not in CANDIDATE_FUNNEL_THEME_STATUSES:
            violations.append(f"{label}: candidate {c.get('code')!r} invalid themeStatus")
        if c.get("themes") != []:
            violations.append(f"{label}: candidate {c.get('code')!r} themes must be [] in v1")
        if c.get("prescreenPool") is not None and c.get("prescreenPool") not in CANDIDATE_FUNNEL_PRESCREEN_POOLS:
            violations.append(f"{label}: candidate {c.get('code')!r} invalid prescreenPool")
        if c.get("dataStatus") is not None and c.get("dataStatus") not in CANDIDATE_FUNNEL_DATA_STATUSES:
            violations.append(f"{label}: candidate {c.get('code')!r} invalid dataStatus")
        for r in c.get("selectedReasons") or []:
            if r not in CANDIDATE_FUNNEL_SELECTED_REASON_CODES:
                violations.append(f"{label}: candidate {c.get('code')!r} invalid selectedReasons {r!r}")
        for r in c.get("riskReasons") or []:
            if r not in CANDIDATE_FUNNEL_SOFT_REASON_CODES:
                violations.append(f"{label}: candidate {c.get('code')!r} invalid riskReasons {r!r}")
        for r in c.get("hardExclusionReasons") or []:
            if r not in CANDIDATE_FUNNEL_HARD_REASON_CODES:
                violations.append(f"{label}: candidate {c.get('code')!r} invalid hardExclusionReasons {r!r}")

        breakdown = c.get("scoreBreakdown")
        if not isinstance(breakdown, list) or len(breakdown) != len(COMPONENT_IDS):
            violations.append(f"{label}: candidate {c.get('code')!r} scoreBreakdown malformed")
        else:
            for comp in breakdown:
                if not isinstance(comp, dict):
                    violations.append(f"{label}: candidate {c.get('code')!r} scoreBreakdown entry not a dict")
                    continue
                unexpected_comp = sorted(set(comp) - SCORE_COMPONENT_ALLOWED_KEYS)
                if unexpected_comp:
                    violations.append(f"{label}: candidate {c.get('code')!r} unexpected scoreBreakdown keys {unexpected_comp}")

    forbidden_found = _recursive_forbidden_keys(payload)
    if forbidden_found:
        violations.append(f"{label}: forbidden keys found (recursive) {sorted(forbidden_found)}")

    return violations


def check_candidate_funnel_files(
    paths: tuple[str, ...] = DEFAULT_PATHS, *, allow_missing: bool = False
) -> list[str]:
    """複数ファイルを検査し、全違反理由のlistを返す（空=全ファイルok）。
    data/publicの両方が読める場合はbyte-identicalであることも確認する。

    default（allow_missing=False）はfail-closed: 全fileが不在の場合も
    violationとする——workflow上でこのsmokeがexit 0を返すことは「今回の
    runでcandidate_funnel.jsonが実際にpublishされた」ことの唯一の証明で
    あり、これをcommit直前の最終防衛線として保証する（batch側のhard gate
    FAILがworkflowへ伝播しない旧経路の再発防止）。ローカルでの導入前検査
    （まだ一度もbatchが成功していない新規環境でのsmoke単体動作確認）用途
    のみ、呼び出し元が明示的に allow_missing=True（CLIでは--allow-missing）
    を指定できる。full_batch.ymlではこのflagを使用しない。

    一部のfileだけが存在する（data/publicの一方のみ）状態は、
    allow_missingの値に関わらず、atomic publish_artifact()のペア保証が
    破られていることを意味するため常にviolationとする。"""
    violations: list[str] = []
    texts: list[tuple[str, str]] = []
    missing_paths: list[str] = []
    for p in paths:
        path = Path(p)
        if not path.exists():
            missing_paths.append(p)
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as e:
            violations.append(f"{p}: failed to read ({e!r})")
            continue
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as e:
            violations.append(f"{p}: failed to parse JSON ({e!r})")
            continue
        texts.append((p, text))
        violations.extend(check_candidate_funnel_payload(payload, p))

    if missing_paths and len(missing_paths) != len(paths):
        violations.append(
            f"partial publish detected: missing {missing_paths} while others exist "
            "(data/public pair guarantee violated)"
        )
    elif missing_paths and len(missing_paths) == len(paths) and not allow_missing:
        violations.append(
            f"all candidate_funnel.json paths missing {missing_paths} "
            "(no artifact was published this run; pass --allow-missing only for "
            "local pre-deployment inspection, never in full_batch.yml)"
        )

    if len(texts) == len(paths) and len(texts) > 1:
        first_text = texts[0][1]
        for label, text in texts[1:]:
            if text != first_text:
                violations.append(f"{label}: not byte-identical to {texts[0][0]}")

    return violations


def main(argv: list[str] | tuple[str, ...] = ()) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--paths", nargs="*", default=None)
    parser.add_argument(
        "--allow-missing",
        action="store_true",
        help=(
            "data/public両方不在をfail扱いにしない。ローカルの導入前検査専用"
            "（full_batch.ymlでは使用禁止 — 今回のrunでartifactが実際に"
            "publishされたことを保証できなくなる）。"
        ),
    )
    args = parser.parse_args(argv)

    paths = tuple(args.paths) if args.paths else DEFAULT_PATHS
    violations = check_candidate_funnel_files(paths, allow_missing=args.allow_missing)
    if violations:
        for v in violations:
            print(f"FAIL candidate_funnel smoke: {v}", file=sys.stderr)
        print("candidate_funnel smoke FAIL", file=sys.stderr)
        return 1
    print("candidate_funnel smoke ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
