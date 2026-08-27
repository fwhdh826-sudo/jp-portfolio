#!/usr/bin/env python3
"""OPS-P14-2/3: candidate_funnel_batch実運用run（full_batch.yml `update-data`
job）が同一run内で実際に読んだ入力を、P14 PASS/FAILを問わず保全する。

OPS-P14-3 adds a backward-compatible v2 payload containing privacy-clean raw
replay input, full ordered base/perturbed vectors, and a boundary-outside band.
It enables exact P14 and replacement-metric offline recomputation without
changing production scoring, thresholds, ranking, or publication semantics.

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
from data.p14_evidence_privacy_filter import (
    assert_private_paths_normalized,
    normalize_private_paths,
    scan_bundle,
    write_minimal_failure_bundle,
)

LEGACY_SCHEMA_VERSION = "candidate-funnel-run-evidence-1"
SCHEMA_VERSION = "candidate-funnel-run-evidence-2"
REPLAY_SCHEMA_VERSION = "candidate-funnel-p14-replay-1"
WORKFLOW = "full_batch.yml"
BOUNDARY_OUTSIDE_BAND_SIZE = 10

# candidate_funnel_engine が読む public-market fields と prescreen join fields の
# exact allowlist。source payloadを丸ごと複製せず、scoring/replacement metricの
# offline再計算に必要な値だけを保存する（private/local/portfolio fieldは入らない）。
REPLAY_CANDIDATE_FIELDS = (
    "code",
    "name",
    "sector",
    "price",
    "per",
    "pbr",
    "roe",
    "dividendYield",
    "sigma252d",
    "mom3m",
    "dataStatus",
    "prescreenScore",
    "prescreenRank",
    "prescreenPool",
)


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


def _replay_candidate_input(joined_candidates: list[Any]) -> list[Any]:
    """Return the complete privacy-clean scoring input, preserving row order."""
    replay_input: list[Any] = []
    for candidate in joined_candidates:
        if not isinstance(candidate, dict):
            # Invalid rows are part of the engine contract and must remain replayable.
            replay_input.append(candidate)
            continue
        replay_input.append(
            {field: candidate[field] for field in REPLAY_CANDIDATE_FIELDS if field in candidate}
        )
    normalized = normalize_private_paths(replay_input)
    assert_private_paths_normalized(normalized)
    return normalized


def _full_rank_vector(result: dict[str, Any]) -> list[dict[str, Any]]:
    """Return every ranked row in exact marketRank/code order, not only Top40."""
    rows = [
        candidate
        for candidate in result.get("candidates", [])
        if isinstance(candidate, dict) and candidate.get("marketRank") is not None
    ]
    rows.sort(key=lambda candidate: (candidate["marketRank"], candidate.get("code", "")))
    return [
        {
            "code": row.get("code"),
            "prescreenScore": row.get("prescreenScore"),
            "prescreenRank": row.get("prescreenRank"),
            "prescreenPool": row.get("prescreenPool"),
            "marketRank": row.get("marketRank"),
            "marketScore": row.get("marketScore"),
            "rawCompositeScore": row.get("rawCompositeScore"),
        }
        for row in rows
    ]


def _jaccard_from_vectors(
    base_vector: list[dict[str, Any]], perturbed_vector: list[dict[str, Any]], top_k: int
) -> tuple[float, int]:
    base = {row.get("code") for row in base_vector[:top_k]}
    perturbed = {row.get("code") for row in perturbed_vector[:top_k]}
    union = base | perturbed
    return ((len(base & perturbed) / len(union)) if union else 1.0, len(base - perturbed))


def _replay_payload(
    joined_candidates: list[Any],
    context: dict[str, Any],
    engine_result: dict[str, Any],
    perturbed_result: dict[str, Any],
) -> dict[str, Any]:
    clean_candidates = _replay_candidate_input(joined_candidates)
    clean_context = normalize_private_paths(context)
    assert_private_paths_normalized(clean_context)
    base_vector = _full_rank_vector(engine_result)
    perturbed_vector = _full_rank_vector(perturbed_result)
    top_k = batch.TOP_N_STABILITY
    band_end = top_k + BOUNDARY_OUTSIDE_BAND_SIZE
    return {
        "schemaVersion": REPLAY_SCHEMA_VERSION,
        "joinedCandidateInput": clean_candidates,
        "context": clean_context,
        "baseFullOrderedRankVector": base_vector,
        "perturbedFullOrderedRankVector": perturbed_vector,
        "boundaryOutsideBand": {
            "topK": top_k,
            "size": BOUNDARY_OUTSIDE_BAND_SIZE,
            "base": base_vector[top_k:band_end],
            "perturbed": perturbed_vector[top_k:band_end],
        },
    }


def replay_p14(evidence: dict[str, Any]) -> dict[str, Any]:
    """Offline replay and integrity verification for v2; accept v1 read-only.

    The result is deliberately RED (``passed=False``) for any input-hash,
    rank-vector, metric, or verdict mismatch. Legacy OPS-P14-2 v1 evidence stays
    readable/compatible but correctly reports that raw offline replay is absent.
    """
    schema_version = evidence.get("schemaVersion")
    if schema_version == LEGACY_SCHEMA_VERSION:
        return {
            "passed": True,
            "compatible": True,
            "replayable": False,
            "schemaVersion": schema_version,
            "errors": [],
        }

    errors: list[str] = []
    replay = evidence.get("replay")
    if schema_version != SCHEMA_VERSION:
        errors.append("unsupported evidence schema")
    if not isinstance(replay, dict) or replay.get("schemaVersion") != REPLAY_SCHEMA_VERSION:
        errors.append("missing replay payload")
        replay = {}

    joined = replay.get("joinedCandidateInput")
    context = replay.get("context")
    hashes = evidence.get("inputHashes")
    if not isinstance(joined, list) or not isinstance(context, dict) or not isinstance(hashes, dict):
        errors.append("invalid replay input")
    else:
        joined_hash = hashes.get("joinedCandidateInput")
        context_hash = hashes.get("replayContext")
        if not isinstance(joined_hash, dict) or joined_hash.get("sha256") != _sha256_bytes(
            _canonical_bytes(joined)
        ):
            errors.append("joined candidate input hash mismatch")
        if not isinstance(context_hash, dict) or context_hash.get("sha256") != _sha256_bytes(
            _canonical_bytes(context)
        ):
            errors.append("context input hash mismatch")

    params = evidence.get("p14Parameters")
    expected_params = {
        "threshold": batch.RANK_STABILITY_JACCARD_MIN,
        "topK": batch.TOP_N_STABILITY,
        "perturbationPct": batch.PERTURBATION_PCT,
        "assignmentContract": batch.P14_ASSIGNMENT_CONTRACT,
    }
    if params != expected_params:
        errors.append("P14 frozen parameters mismatch")

    recomputed_jaccard: float | None = None
    recomputed_swap_count: int | None = None
    recomputed_verdict: str | None = None
    if not errors:
        base_result = build_candidate_funnel(joined, context)
        _reported_jaccard, perturbed_result = batch.compute_rank_stability(
            joined, context, base_result
        )
        base_vector = _full_rank_vector(base_result)
        perturbed_vector = _full_rank_vector(perturbed_result)
        recomputed_jaccard, recomputed_swap_count = _jaccard_from_vectors(
            base_vector, perturbed_vector, batch.TOP_N_STABILITY
        )
        recomputed_verdict = (
            "PASS"
            if recomputed_jaccard >= batch.RANK_STABILITY_JACCARD_MIN
            else "FAIL"
        )
        if replay.get("baseFullOrderedRankVector") != base_vector:
            errors.append("base rank vector mismatch")
        if replay.get("perturbedFullOrderedRankVector") != perturbed_vector:
            errors.append("perturbed rank vector mismatch")
        expected_boundary = {
            "topK": batch.TOP_N_STABILITY,
            "size": BOUNDARY_OUTSIDE_BAND_SIZE,
            "base": base_vector[
                batch.TOP_N_STABILITY : batch.TOP_N_STABILITY + BOUNDARY_OUTSIDE_BAND_SIZE
            ],
            "perturbed": perturbed_vector[
                batch.TOP_N_STABILITY : batch.TOP_N_STABILITY + BOUNDARY_OUTSIDE_BAND_SIZE
            ],
        }
        if replay.get("boundaryOutsideBand") != expected_boundary:
            errors.append("boundary outside band mismatch")
        if _reported_jaccard != recomputed_jaccard:
            errors.append("production P14 metric mismatch")
        p14 = evidence.get("p14") if isinstance(evidence.get("p14"), dict) else {}
        if p14.get("jaccard") != recomputed_jaccard:
            errors.append("P14 jaccard mismatch")
        if p14.get("swapCount") != recomputed_swap_count:
            errors.append("P14 swap count mismatch")
        if p14.get("verdict") != recomputed_verdict:
            errors.append("P14 verdict mismatch")

    return {
        "passed": not errors,
        "compatible": not errors,
        "replayable": True,
        "schemaVersion": schema_version,
        "errors": errors,
        "jaccard": recomputed_jaccard,
        "swapCount": recomputed_swap_count,
        "verdict": recomputed_verdict,
    }


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
        replay = _replay_payload(joined_candidates, context, engine_result, perturbed_result)
        base_vector = replay["baseFullOrderedRankVector"]
        perturbed_vector = replay["perturbedFullOrderedRankVector"]
        _exact_jaccard, swap_count = _jaccard_from_vectors(
            base_vector, perturbed_vector, batch.TOP_N_STABILITY
        )
        p14_gate = _find_gate(quality_report["gates"], "P-14")
        evidence["p14"] = {
            "jaccard": jaccard,
            "swapCount": swap_count,
            "verdict": p14_gate["status"] if p14_gate else None,
            "baseTop40": base_vector[: batch.TOP_N_STABILITY],
            "perturbedTop40": perturbed_vector[: batch.TOP_N_STABILITY],
        }
        evidence["replay"] = replay
        joined_bytes = _canonical_bytes(replay["joinedCandidateInput"])
        context_bytes = _canonical_bytes(replay["context"])
        evidence["inputHashes"]["joinedCandidateInput"] = {
            "present": True,
            "sha256": _sha256_bytes(joined_bytes),
            "bytes": len(joined_bytes),
            "encoding": "canonical-json",
        }
        evidence["inputHashes"]["replayContext"] = {
            "present": True,
            "sha256": _sha256_bytes(context_bytes),
            "bytes": len(context_bytes),
            "encoding": "canonical-json",
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
    # GitHub runner paths (for example /home/runner/work/...) are operational
    # metadata, not privacy violations. Normalize them before the strict scan;
    # forbidden keys and token-shaped secrets remain untouched and fail closed.
    normalized_evidence = normalize_private_paths(evidence)
    assert_private_paths_normalized(normalized_evidence)
    _write_json(bundle_root / "evidence.json", normalized_evidence)

    files: list[dict[str, Any]] = []
    for path in sorted(item for item in bundle_root.rglob("*") if item.is_file()):
        relative = path.relative_to(bundle_root).as_posix()
        if relative in {"manifest.json", "manifest.sha256"}:
            continue
        raw = path.read_bytes()
        files.append({"path": relative, "sha256": _sha256_bytes(raw), "bytes": len(raw)})
    manifest = {
        "schemaVersion": normalized_evidence.get("schemaVersion", SCHEMA_VERSION),
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
