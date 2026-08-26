#!/usr/bin/env python3
"""OPS-P14-2: candidate_funnel_batch実運用run（full_batch.yml `update-data`
job）が同一run内で実際に読んだ入力を、P14 PASS/FAILを問わず保全する。

`data/p14_evidence_capture.py`（手動workflow_dispatch専用の別corpus、
INV-1でgitSha 8cfa5568にpin済み）とは独立の運用store。あちらを変更・
拡張しない。目的も異なる: あちらは on-demand で fresh market data を
再取得して calibration corpus を作る研究tool、こちらは scheduled production
runのexact same-run inputを毎回（PASS/FAILどちらでも）保全する運用tool。

honesty: このmoduleはevidenceの読み取り・記録のみを行う。
candidate_funnel_batch.py の metric/threshold/gate/publish判定を一切
変更しない — 既存のpure functionをread-onlyで再利用するだけ。
P-14はdeterministic（診断OPS-P14-1で反復/順序shuffle/hashseed/asOf/regime
の5次元にわたり実証済み）であるため、production runが読んだのと同じ
実input file（この評価stepの実行時点でまだdisk上に残っている同一run生成物）
に対する2回目のpure function呼出しはbit-exactに同一結果を返す。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from data import candidate_funnel_batch as batch
from data.candidate_funnel_engine import build_candidate_funnel
from data.p14_evidence_privacy_filter import scan_bundle, write_minimal_failure_bundle

SCHEMA_VERSION = "candidate-funnel-run-evidence-1"
WORKFLOW = "full_batch.yml"


class EvidenceCaptureError(RuntimeError):
    """evidence capture固有のfail-closed error（呼び出し元のgate判定とは無関係）。"""


def _sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8"
    )


def _file_hash(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"present": False, "sha256": None, "bytes": None}
    raw = path.read_bytes()
    return {"present": True, "sha256": _sha256_bytes(raw), "bytes": len(raw)}


def _top_n(result: dict[str, Any], n: int) -> list[dict[str, Any]]:
    rows = [
        c
        for c in result.get("candidates", [])
        if isinstance(c, dict) and c.get("marketRank") is not None
    ]
    rows.sort(key=lambda c: (c["marketRank"], c.get("code", "")))
    return [
        {
            "code": row.get("code"),
            "marketRank": row.get("marketRank"),
            "marketScore": row.get("marketScore"),
            "rawCompositeScore": row.get("rawCompositeScore"),
        }
        for row in rows[:n]
    ]


def _find_gate(gates: list[dict[str, Any]], gate_id: str) -> dict[str, Any] | None:
    for gate in gates:
        if gate.get("id") == gate_id:
            return gate
    return None


def build_evidence(
    *,
    run_identity: dict[str, Any],
    candidates_path: Path,
    prescreen_path: Path,
    regime_path: Path,
    previous_path: Path,
    batch_status: str,
    smoke_status: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    """PASS/FAIL問わず1 candidate_funnel runのevidenceを構築する
    (pure — file書き込みはしない)。real production run（full_batch.yml）が
    同一process内で読んだのと同じ実input file群を、そのままread-onlyで
    再度読み込む。"""
    if now is None:
        now = datetime.now(timezone.utc)

    evidence: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": now.isoformat(),
        "runIdentity": run_identity,
        "inputHashes": {
            "candidatesStocks": _file_hash(candidates_path),
            "prescreenMetadata": _file_hash(prescreen_path),
            "regimeState": _file_hash(regime_path),
            "previousArtifact": _file_hash(previous_path),
        },
        "p14Parameters": {
            "threshold": batch.RANK_STABILITY_JACCARD_MIN,
            "topK": batch.TOP_N_STABILITY,
            "perturbationPct": batch.PERTURBATION_PCT,
            "assignmentContract": batch.P14_ASSIGNMENT_CONTRACT,
        },
        "publish": {
            "batchStatus": batch_status or None,
            "smokeStatus": smoke_status or None,
        },
    }

    try:
        candidates_stocks_payload = batch.load_candidates_stocks(candidates_path)
    except batch.CandidateFunnelBatchError as exc:
        evidence["captureStatus"] = "input_unavailable"
        evidence["captureError"] = str(exc)
        return evidence

    prescreen_payload = batch.load_prescreen_metadata(prescreen_path)
    regime = batch.read_current_regime(regime_path)
    previous_artifact = batch.load_previous_artifact(previous_path)

    evidence["asOf"] = candidates_stocks_payload.get("sourceUpdatedAt")
    evidence["candidatesUpdatedAt"] = candidates_stocks_payload.get("updatedAt")

    prescreen_index, prescreen_duplicate_codes = batch.build_prescreen_index(prescreen_payload)
    candidates = candidates_stocks_payload.get("candidates", [])
    joined_candidates, join_stats = batch.join_candidates_with_prescreen(candidates, prescreen_index)
    context = batch.build_context(candidates_stocks_payload, regime, now)
    engine_result = build_candidate_funnel(joined_candidates, context)

    quality_report = batch.compute_quality_report(
        candidates_stocks_payload=candidates_stocks_payload,
        joined_candidates=joined_candidates,
        join_stats=join_stats,
        prescreen_duplicate_codes=prescreen_duplicate_codes,
        engine_result=engine_result,
        context=context,
        previous_artifact=previous_artifact,
    )

    evidence["captureStatus"] = "captured"
    evidence["engineStatus"] = engine_result.get("status")
    evidence["joinStats"] = join_stats
    evidence["qualityGate"] = quality_report

    if engine_result.get("status") == "generated":
        jaccard, perturbed_result = batch.compute_rank_stability(joined_candidates, context, engine_result)
        base_top = _top_n(engine_result, batch.TOP_N_STABILITY)
        perturbed_top = _top_n(perturbed_result, batch.TOP_N_STABILITY)
        base_codes = {row["code"] for row in base_top}
        perturbed_codes = {row["code"] for row in perturbed_top}
        p14_gate = _find_gate(quality_report["gates"], "P-14")
        evidence["p14"] = {
            "jaccard": jaccard,
            "swapCount": len(base_codes - perturbed_codes),
            "verdict": p14_gate["status"] if p14_gate else None,
            "baseTop40": base_top,
            "perturbedTop40": perturbed_top,
        }
    else:
        evidence["p14"] = {
            "status": "N/A",
            "note": f"engineStatus={engine_result.get('status')}のためP-14評価対象外",
        }

    evidence["p13"] = _find_gate(quality_report["gates"], "P-13")
    evidence["p15"] = _find_gate(quality_report["gates"], "P-15")
    evidence["publish"]["overallPass"] = quality_report.get("overallPass")
    evidence["publish"]["hardFailIds"] = quality_report.get("hardFailIds")

    return evidence


def write_bundle(bundle_root: Path, evidence: dict[str, Any]) -> None:
    """evidence.json + 自己hash manifest + privacy scanを書き出す。
    privacy violation検出時はbundleを最小failure reportへ置換する
    （機密dataを絶対にuploadしない）。"""
    _write_json(bundle_root / "evidence.json", evidence)

    files: list[dict[str, Any]] = []
    for path in sorted(item for item in bundle_root.rglob("*") if item.is_file()):
        relative = path.relative_to(bundle_root).as_posix()
        if relative in {"manifest.json", "manifest.sha256"}:
            continue
        raw = path.read_bytes()
        files.append({"path": relative, "sha256": _sha256_bytes(raw), "bytes": len(raw)})
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "bundleId": bundle_root.name,
        "files": files,
        "fileCount": len(files),
        "totalBytes": sum(item["bytes"] for item in files),
    }
    _write_json(bundle_root / "manifest.json", manifest)
    digest = _sha256_bytes((bundle_root / "manifest.json").read_bytes())
    (bundle_root / "manifest.sha256").write_text(f"{digest}  manifest.json\n", encoding="utf-8")

    privacy_report = scan_bundle(bundle_root)
    _write_json(bundle_root / "validation" / "privacy-report.json", privacy_report)
    if not privacy_report["passed"]:
        write_minimal_failure_bundle(bundle_root, privacy_report["violations"])
        raise EvidenceCaptureError(f"privacy violations detected: {privacy_report['violations']}")


def _run_identity_from_environment() -> dict[str, Any]:
    required = (
        "GITHUB_RUN_ID",
        "GITHUB_RUN_ATTEMPT",
        "GITHUB_SHA",
        "GITHUB_REF",
        "GITHUB_REF_TYPE",
        "GITHUB_EVENT_NAME",
    )
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise EvidenceCaptureError(f"missing run identity environment variables: {missing}")
    return {
        "runId": os.environ["GITHUB_RUN_ID"],
        "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"],
        "workflow": WORKFLOW,
        "event": os.environ["GITHUB_EVENT_NAME"],
        "gitSha": os.environ["GITHUB_SHA"],
        "gitRef": os.environ["GITHUB_REF"],
        "gitRefType": os.environ["GITHUB_REF_TYPE"],
        "runnerOs": os.environ.get("RUNNER_OS", platform.system()),
    }


def main(argv: list[str] | tuple[str, ...] = ()) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--previous", type=Path, required=True)
    parser.add_argument("--candidates", type=Path, default=batch.CANDIDATES_STOCKS_PATH)
    parser.add_argument("--prescreen", type=Path, default=batch.PRESCREEN_METADATA_PATH)
    parser.add_argument("--regime", type=Path, default=batch.REGIME_STATE_PATH)
    parser.add_argument("--batch-status", default="")
    parser.add_argument("--smoke-status", default="")
    args = parser.parse_args(argv)

    try:
        run_identity = _run_identity_from_environment()
        evidence = build_evidence(
            run_identity=run_identity,
            candidates_path=args.candidates,
            prescreen_path=args.prescreen,
            regime_path=args.regime,
            previous_path=args.previous,
            batch_status=args.batch_status,
            smoke_status=args.smoke_status,
        )
        bundle_id = f"candidate-funnel-evidence-{run_identity['runId']}-{run_identity['runAttempt']}"
        bundle_root = args.out / bundle_id
        write_bundle(bundle_root, evidence)
    except Exception as exc:  # noqa: BLE001 — このstepはnon-blocking(workflow側でcontinue-on-error)。
        # 例外を握り潰さず記録したうえでnon-zero exitのみ返す（job全体の
        # fail-closed判定には一切関与しない — それは既存のEnforce stepの責務）。
        print(f"candidate_funnel run evidence capture failed (non-blocking): {exc}", file=sys.stderr)
        return 1

    print(bundle_root)
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with Path(github_output).open("a", encoding="utf-8") as handle:
            handle.write(f"bundle_path={bundle_root}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
