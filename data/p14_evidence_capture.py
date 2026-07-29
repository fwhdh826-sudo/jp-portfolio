#!/usr/bin/env python3
"""Build a self-contained same-run P-14 evidence bundle.

This command is evidence-only.  It never publishes candidate artifacts and it
refuses to place its output inside the repository worktree.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import locale
import math
import os
import platform
import random
import shutil
import statistics
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from data import candidate_funnel_batch as batch
from data import candidate_funnel_engine as engine
from data.p14_evidence_privacy_filter import (
    PRIVACY_VERSION,
    PrivacyViolation,
    assert_private_paths_normalized,
    environment_presence,
    normalize_private_paths,
    pip_freeze,
    scan_bundle,
    write_minimal_failure_bundle,
)

BUNDLE_SCHEMA_VERSION = "p14-evidence-bundle-1"
ACCEPTANCE_VERSION = "p14-evidence-acceptance-1"
REPOSITORY = "fwhdh826-sudo/jp-portfolio"
WORKFLOW = "p14_evidence_capture.yml"
PERMUTATION_CASES = (
    "original-order",
    "reverse-order",
    "code-ascending",
    "code-descending",
    "market-rank-ascending",
    "seeded-shuffle-101",
    "seeded-shuffle-202",
    "seeded-shuffle-303",
)
ANALYTICAL_CASES = (
    "per-only-plus-2pct",
    "per-only-minus-2pct",
    "roe-only-plus-2pct",
    "roe-only-minus-2pct",
    "production-simultaneous",
    "inverse-simultaneous",
)
MULTI_K = (10, 20, 30, 35, 40, 45, 50)
GENERATOR_PATHS = (
    "data/candidate_funnel_engine.py",
    "data/candidate_funnel_batch.py",
    "data/build_candidates_stocks.py",
)
FROZEN_TEST_MAPPING = (
    ("T-01", "test_manifest_covers_every_bundle_file_exactly_once"),
    ("T-02", "test_manifest_hashes_match_recomputed_bytes"),
    ("T-03", "test_inputs_are_byte_identical_to_source_files"),
    ("T-04", "test_generator_sha256_matches_checked_out_blobs"),
    ("T-05", "test_run_identity_records_run_id_attempt_and_token"),
    ("T-06", "test_five_reruns_are_hash_identical"),
    ("T-07", "test_full_rank_vector_length_equals_population"),
    ("T-08", "test_eight_frozen_permutation_cases_present_with_verdicts"),
    ("T-09", "test_quality_report_saved_even_when_overall_pass_false"),
    ("T-10", "test_p14_parameters_read_from_module_constants_not_literals"),
    ("T-11", "test_environment_json_records_timezone_utc_and_hashseed_zero"),
    ("T-12", "test_capture_never_writes_inside_repository_worktree"),
    ("T-13", "test_market_content_hash_ignores_timestamps_and_run_token"),
    ("T-14", "test_duplicate_market_content_hash_is_rejected_as_not_distinct"),
    ("T-15", "test_missing_prescreen_metadata_is_rejected"),
    ("T-16", "test_missing_candidates_input_is_rejected"),
    ("T-17", "test_generator_sha_mismatch_is_rejected"),
    (
        "T-18",
        "test_prescreen_generated_at_not_equal_candidates_updated_at_is_rejected",
    ),
    ("T-19", "test_incomplete_bundle_missing_any_required_path_is_rejected"),
    (
        "T-20",
        "test_assignment_contract_other_than_p14_prescreen_rank_code_v1_is_rejected",
    ),
    ("T-21", "test_missing_source_timestamps_are_rejected"),
    ("T-22", "test_non_normal_pipeline_path_is_rejected"),
    ("T-23", "test_forbidden_keys_anywhere_in_bundle_are_rejected"),
    ("T-24", "test_secret_values_and_token_patterns_are_never_written"),
    ("T-25", "test_environment_records_variable_names_without_values"),
    ("T-26", "test_only_allowlisted_public_input_files_are_bundled"),
    ("T-27", "test_capture_module_does_not_import_sbi_or_backend_modules"),
    ("T-28", "test_absolute_home_paths_are_normalized"),
    ("T-29", "test_workflow_has_workflow_dispatch_only_no_schedule_no_push"),
    ("T-30", "test_workflow_declares_contents_read_permission"),
    ("T-31", "test_workflow_has_no_git_commit_push_or_publish_step"),
    ("T-32", "test_upload_artifact_uses_if_always_and_retention_90"),
    ("T-33", "test_validate_step_is_blocking_no_or_true"),
    ("T-34", "test_full_batch_yml_is_unmodified_by_this_feature"),
)
JST = timezone(timedelta(hours=9))


class CaptureError(RuntimeError):
    """Fail-closed evidence capture error."""


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sanitized = normalize_private_paths(value)
    assert_private_paths_normalized(sanitized)
    path.write_text(json.dumps(sanitized, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _parse_timestamp(value: Any) -> datetime:
    if not isinstance(value, str):
        raise CaptureError(f"timestamp is not a string: {value!r}")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise CaptureError(f"invalid ISO timestamp: {value!r}") from exc
    if parsed.tzinfo is None:
        raise CaptureError(f"timestamp lacks timezone: {value!r}")
    return parsed


def _git_output(repo_root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _ranked(result: dict[str, Any]) -> list[dict[str, Any]]:
    rows = [
        row
        for row in result.get("candidates", [])
        if isinstance(row, dict) and row.get("marketRank") is not None
    ]
    return sorted(rows, key=lambda row: (row["marketRank"], row.get("code", "")))


def _top_codes(result: dict[str, Any], k: int) -> list[str]:
    return [row["code"] for row in _ranked(result)[:k]]


def _set_metrics(base: dict[str, Any], perturbed: dict[str, Any], k: int) -> dict[str, Any]:
    base_top = _top_codes(base, k)
    perturbed_top = _top_codes(perturbed, k)
    left, right = set(base_top), set(perturbed_top)
    union = left | right
    intersection = left & right
    jaccard = len(intersection) / len(union) if union else 1.0
    return {
        "k": k,
        "baseTop": base_top,
        "perturbedTop": perturbed_top,
        "intersection": sorted(intersection),
        "union": sorted(union),
        "jaccard": jaccard,
        "retention": len(intersection) / len(left) if left else 1.0,
        "swapCount": len(left - right),
        "exited": sorted(left - right),
        "entered": sorted(right - left),
    }


def _rank_hash(result: dict[str, Any]) -> str:
    vector = [
        {
            "code": row.get("code"),
            "marketRank": row.get("marketRank"),
            "rawCompositeScore": row.get("rawCompositeScore"),
            "marketScore": row.get("marketScore"),
        }
        for row in _ranked(result)
    ]
    return sha256_bytes(canonical_bytes(vector))


def _full_rank_vector(
    joined: list[Any],
    perturbed_inputs: list[Any],
    base: dict[str, Any],
    perturbed: dict[str, Any],
) -> list[dict[str, Any]]:
    base_by_code = {row["code"]: row for row in _ranked(base)}
    perturbed_by_code = {row["code"]: row for row in _ranked(perturbed)}
    perturbed_input_by_code = {
        row.get("code"): row for row in perturbed_inputs if isinstance(row, dict)
    }
    signs = batch._p14_canonical_sign_by_code(joined)
    vector: list[dict[str, Any]] = []
    for input_index, source in enumerate(joined):
        if not isinstance(source, dict):
            continue
        code = source.get("code")
        if code not in base_by_code or code not in perturbed_by_code:
            continue
        before, after = base_by_code[code], perturbed_by_code[code]
        perturbed_source = perturbed_input_by_code.get(code, {})
        vector.append(
            {
                "inputIndex": input_index,
                "code": code,
                "name": before.get("name"),
                "assignmentSign": signs.get(code),
                "assignmentContract": batch.P14_ASSIGNMENT_CONTRACT,
                "basePER": source.get("per"),
                "perturbedPER": perturbed_source.get("per"),
                "baseROE": source.get("roe"),
                "perturbedROE": perturbed_source.get("roe"),
                "baseRank": before.get("marketRank"),
                "perturbedRank": after.get("marketRank"),
                "baseRawScore": before.get("rawCompositeScore"),
                "perturbedRawScore": after.get("rawCompositeScore"),
                "baseRoundedScore": before.get("marketScore"),
                "perturbedRoundedScore": after.get("marketScore"),
                "rankDisplacement": after.get("marketRank") - before.get("marketRank"),
            }
        )
    return sorted(vector, key=lambda row: (row["baseRank"], row["code"]))


def _boundary(vector: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "ranks30To50": [
            row
            for row in vector
            if 30 <= row["baseRank"] <= 50 or 30 <= row["perturbedRank"] <= 50
        ]
    }


def _correlation(base: dict[str, Any], perturbed: dict[str, Any]) -> dict[str, Any]:
    base_ranks = {row["code"]: row["marketRank"] for row in _ranked(base)}
    perturbed_ranks = {row["code"]: row["marketRank"] for row in _ranked(perturbed)}
    codes = sorted(base_ranks.keys() & perturbed_ranks.keys())
    n = len(codes)
    deltas = [perturbed_ranks[code] - base_ranks[code] for code in codes]
    d2 = sum(delta * delta for delta in deltas)
    spearman = 1.0 if n < 2 else 1 - 6 * d2 / (n * (n * n - 1))
    concordant = 0
    discordant = 0
    for index, left in enumerate(codes):
        for right in codes[index + 1 :]:
            product = (base_ranks[left] - base_ranks[right]) * (
                perturbed_ranks[left] - perturbed_ranks[right]
            )
            concordant += product > 0
            discordant += product < 0
    pairs = n * (n - 1) // 2
    absolute = [abs(delta) for delta in deltas]
    return {
        "population": n,
        "spearman": spearman,
        "kendallTauA": (concordant - discordant) / pairs if pairs else 1.0,
        "meanAbsoluteRankDisplacement": statistics.fmean(absolute) if absolute else 0.0,
        "medianRankDisplacement": statistics.median(absolute) if absolute else 0.0,
        "maximumRankDisplacement": max(absolute, default=0),
    }


def _all_percent(candidates: list[Any], field: str, percent: float) -> list[Any]:
    output: list[Any] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            output.append(candidate)
            continue
        row = dict(candidate)
        value = row.get(field)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            row[field] = value * (1 + percent)
        output.append(row)
    return output


def _inverse_simultaneous(candidates: list[Any]) -> list[Any]:
    signs = batch._p14_canonical_sign_by_code(candidates)
    output: list[Any] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            output.append(candidate)
            continue
        row = dict(candidate)
        sign = signs.get(row.get("code"))
        if sign is not None:
            if isinstance(row.get("per"), (int, float)) and not isinstance(row["per"], bool):
                row["per"] *= 1 - sign * batch.PERTURBATION_PCT
            if isinstance(row.get("roe"), (int, float)) and not isinstance(row["roe"], bool):
                row["roe"] *= 1 + sign * batch.PERTURBATION_PCT
        output.append(row)
    return output


def _permutation_inputs(
    joined: list[Any], base: dict[str, Any]
) -> list[tuple[str, list[Any], dict[str, Any]]]:
    base_ranks = {row["code"]: row["marketRank"] for row in _ranked(base)}
    cases: list[tuple[str, list[Any], dict[str, Any]]] = [
        ("original-order", list(joined), {"kind": "identity"}),
        ("reverse-order", list(reversed(joined)), {"kind": "reverse"}),
        (
            "code-ascending",
            sorted(joined, key=lambda row: row.get("code", "") if isinstance(row, dict) else ""),
            {"kind": "sort", "field": "code", "direction": "ascending"},
        ),
        (
            "code-descending",
            sorted(
                joined,
                key=lambda row: row.get("code", "") if isinstance(row, dict) else "",
                reverse=True,
            ),
            {"kind": "sort", "field": "code", "direction": "descending"},
        ),
        (
            "market-rank-ascending",
            sorted(
                joined,
                key=lambda row: base_ranks.get(row.get("code"), math.inf)
                if isinstance(row, dict)
                else math.inf,
            ),
            {"kind": "sort", "field": "baseMarketRank", "direction": "ascending"},
        ),
    ]
    for seed in (101, 202, 303):
        shuffled = list(joined)
        random.Random(seed).shuffle(shuffled)
        cases.append(
            (f"seeded-shuffle-{seed}", shuffled, {"kind": "seededShuffle", "seed": seed})
        )
    return cases


def compute_input_hashes(
    candidates_bytes: bytes,
    prescreen_bytes: bytes,
    regime_bytes: bytes,
    joined_candidates: list[Any],
) -> tuple[str, str, str, str]:
    joined_hash = sha256_bytes(canonical_bytes({"candidates": joined_candidates}))
    input_bundle_hash = sha256_bytes(
        canonical_bytes(
            {
                "candidates": sha256_bytes(candidates_bytes),
                "prescreen": sha256_bytes(prescreen_bytes),
                "regime": sha256_bytes(regime_bytes),
                "joined": joined_hash,
            }
        )
    )
    market_records = [
        {
            key: row.get(key)
            for key in (
                "code",
                "name",
                "sector",
                "dataStatus",
                "per",
                "pbr",
                "roe",
                "price",
                "mom3m",
                "sigma252d",
                "dividendYield",
                "screenReasons",
                "prescreenScore",
                "prescreenRank",
                "prescreenPool",
            )
        }
        for row in joined_candidates
        if isinstance(row, dict)
    ]
    candidates_payload = json.loads(candidates_bytes)
    regime_payload = json.loads(regime_bytes)
    market_content_hash = sha256_bytes(
        canonical_bytes(
            {
                "records": market_records,
                "regime": regime_payload.get("regime_state", {}).get("current_regime"),
                "pipelinePath": candidates_payload.get("_meta", {}).get("pipelinePath"),
            }
        )
    )
    codes = sorted(
        {
            row.get("code")
            for row in joined_candidates
            if isinstance(row, dict) and isinstance(row.get("code"), str)
        }
    )
    candidate_population_hash = sha256_bytes(canonical_bytes(codes))
    prescreen_semantic_hash = sha256_bytes(
        canonical_bytes(
            [
                (
                    row.get("code"),
                    row.get("prescreenScore"),
                    row.get("prescreenRank"),
                    row.get("prescreenPool"),
                )
                for row in joined_candidates
                if isinstance(row, dict)
            ]
        )
    )
    return (
        input_bundle_hash,
        market_content_hash,
        candidate_population_hash,
        prescreen_semantic_hash,
    )


def _line_count(raw: bytes) -> int:
    return raw.count(b"\n")


def _role(relative: str) -> str:
    if "/inputs/" in relative:
        return "input"
    if "/outputs/" in relative:
        return "output"
    if any(part in relative for part in ("/metrics/", "/ranks/", "/reruns/", "/permutations/")):
        return "metric"
    if "/logs/" in relative:
        return "log"
    if "validation/" in relative:
        return "validation"
    return "output"


def finalize_manifest(bundle_root: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    """Inventory all regular files except the two manifest files, then self-hash."""
    files: list[dict[str, Any]] = []
    for path in sorted(item for item in bundle_root.rglob("*") if item.is_file()):
        relative = path.relative_to(bundle_root).as_posix()
        if relative in {"manifest.json", "manifest.sha256"}:
            continue
        raw = path.read_bytes()
        files.append(
            {
                "path": relative,
                "sha256": sha256_bytes(raw),
                "bytes": len(raw),
                "lines": _line_count(raw),
                "role": _role(relative),
            }
        )
    manifest = dict(manifest)
    manifest["files"] = files
    manifest["fileCount"] = len(files)
    manifest["totalBytes"] = sum(item["bytes"] for item in files)
    write_json(bundle_root / "manifest.json", manifest)
    digest = sha256_file(bundle_root / "manifest.json")
    (bundle_root / "manifest.sha256").write_text(f"{digest}  manifest.json\n", encoding="utf-8")
    return manifest


def _copy_sources(repo_root: Path, snapshot_root: Path) -> dict[str, str]:
    hashes: dict[str, str] = {}
    package_dir = snapshot_root / "inputs" / "production_code" / "data"
    package_dir.mkdir(parents=True, exist_ok=True)
    (package_dir / "__init__.py").write_text("", encoding="utf-8")
    direct_dir = snapshot_root / "inputs" / "production_code"
    for relative in GENERATOR_PATHS:
        source = repo_root / relative
        raw = source.read_bytes()
        hashes[relative] = sha256_bytes(raw)
        try:
            sanitized = normalize_private_paths(raw.decode("utf-8")).encode("utf-8")
        except UnicodeDecodeError as exc:
            raise CaptureError(f"generator source is not UTF-8: {relative}") from exc
        (direct_dir / Path(relative).name).write_bytes(sanitized)
        (package_dir / Path(relative).name).write_bytes(sanitized)
    return hashes


def _source_manifest(snapshot_root: Path) -> None:
    paths = sorted(path for path in (snapshot_root / "inputs").rglob("*") if path.is_file())
    content = "".join(
        f"{sha256_file(path)}  {path.relative_to(snapshot_root).as_posix()}\n" for path in paths
    )
    (snapshot_root / "source-manifest.sha256").write_text(content, encoding="utf-8")


def _environment(run_identity: dict[str, Any]) -> dict[str, Any]:
    variable_names, redacted_names = environment_presence()
    payload = {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "runnerOs": run_identity["runnerOs"],
        "runnerArch": run_identity["runnerArch"],
        "pythonVersion": platform.python_version(),
        "pipFreeze": pip_freeze(),
        "locale": locale.setlocale(locale.LC_ALL, None),
        "timezone": os.environ.get("TZ", ""),
        "pythonHashSeed": os.environ.get("PYTHONHASHSEED", ""),
        "variableNames": variable_names,
        "redactedVariableNames": redacted_names,
    }
    return normalize_private_paths(payload)


def build_bundle(
    *,
    out_parent: Path,
    repo_root: Path,
    run_identity: dict[str, Any],
    candidates_path: Path,
    prescreen_path: Path,
    regime_path: Path,
    previous_path: Path | None,
) -> Path:
    repo = repo_root.resolve()
    parent = out_parent.resolve()
    if parent == repo or repo in parent.parents:
        raise CaptureError("bundle output must be outside repository worktree")
    if not candidates_path.is_file():
        raise CaptureError(f"missing candidates input: {candidates_path}")
    if not prescreen_path.is_file():
        raise CaptureError(f"missing prescreen input: {prescreen_path}")
    if not regime_path.is_file():
        raise CaptureError(f"missing regime input: {regime_path}")

    candidates_bytes = candidates_path.read_bytes()
    prescreen_bytes = prescreen_path.read_bytes()
    regime_bytes = regime_path.read_bytes()
    candidates_payload = json.loads(candidates_bytes)
    prescreen_payload = json.loads(prescreen_bytes)
    regime_payload = json.loads(regime_bytes)
    candidates_updated_at = candidates_payload.get("updatedAt")
    capture_day = _parse_timestamp(candidates_updated_at).astimezone(JST).strftime("%Y%m%d")
    bundle_id = (
        f"p14-evidence-{capture_day}-{run_identity['runId']}-{run_identity['runAttempt']}"
    )
    bundle_root = parent / bundle_id
    if bundle_root.exists():
        raise CaptureError(f"bundle already exists: {bundle_id}")
    bundle_root.mkdir(parents=True)

    try:
        prescreen_index, duplicate_codes = batch.build_prescreen_index(prescreen_payload)
        candidates = candidates_payload.get("candidates", [])
        joined, join_stats = batch.join_candidates_with_prescreen(candidates, prescreen_index)
        regime = batch.read_current_regime(regime_path)
        context = batch.build_context(candidates_payload, regime, datetime.now(timezone.utc))
        previous = (
            batch.load_previous_artifact(previous_path)
            if previous_path is not None
            else None
        )

        input_hash, market_hash, population_hash, prescreen_hash = compute_input_hashes(
            candidates_bytes, prescreen_bytes, regime_bytes, joined
        )
        snapshot_id = f"real-{capture_day}-{market_hash[:10]}"
        snapshot_root = bundle_root / "snapshots" / snapshot_id
        input_data = snapshot_root / "inputs" / "data"
        input_data.mkdir(parents=True)
        (input_data / "candidates_stocks.json").write_bytes(candidates_bytes)
        (input_data / "prescreen_metadata.json").write_bytes(prescreen_bytes)
        (input_data / "regime_state.json").write_bytes(regime_bytes)
        if previous_path is not None and previous_path.is_file():
            (input_data / "candidate_funnel_previous.json").write_bytes(
                previous_path.read_bytes()
            )
        write_json(snapshot_root / "inputs" / "joined_candidates.json", {"candidates": joined})
        configuration = {
            "context": context,
            "productionThreshold": batch.RANK_STABILITY_JACCARD_MIN,
            "productionTopK": batch.TOP_N_STABILITY,
            "productionPerturbationPct": batch.PERTURBATION_PCT,
            "assignmentContract": batch.P14_ASSIGNMENT_CONTRACT,
            "schemaVersion": engine.CANDIDATE_FUNNEL_SCHEMA_VERSION,
            "funnelVersion": engine.CANDIDATE_FUNNEL_VERSION,
            "scoreVersion": engine.CANDIDATE_FUNNEL_SCORE_VERSION,
        }
        write_json(snapshot_root / "inputs" / "configuration.json", configuration)
        write_json(snapshot_root / "inputs" / "run-identity.json", run_identity)
        generator_hashes = _copy_sources(repo, snapshot_root)

        base_first: dict[str, Any] | None = None
        perturbed_first: dict[str, Any] | None = None
        vector_first: list[dict[str, Any]] | None = None
        reruns: list[dict[str, Any]] = []
        for number in range(1, 6):
            base_result = engine.build_candidate_funnel(joined, context)
            perturbed_inputs = batch._perturb_candidates(joined)
            perturbed_result = engine.build_candidate_funnel(perturbed_inputs, context)
            vector = _full_rank_vector(joined, perturbed_inputs, base_result, perturbed_result)
            production = _set_metrics(base_result, perturbed_result, batch.TOP_N_STABILITY)
            production.update(
                {
                    "threshold": batch.RANK_STABILITY_JACCARD_MIN,
                    "verdict": (
                        "PASS"
                        if production["jaccard"] >= batch.RANK_STABILITY_JACCARD_MIN
                        else "FAIL"
                    ),
                    "assignmentContract": batch.P14_ASSIGNMENT_CONTRACT,
                    "assignmentNote": batch.P14_ASSIGNMENT_NOTE,
                }
            )
            metrics = {
                "productionP14": production,
                "baseVectorSha256": _rank_hash(base_result),
                "perturbedVectorSha256": _rank_hash(perturbed_result),
            }
            write_json(
                snapshot_root / "outputs" / f"run-{number}" / "base-engine.json", base_result
            )
            write_json(
                snapshot_root / "outputs" / f"run-{number}" / "perturbed-engine.json",
                perturbed_result,
            )
            write_json(
                snapshot_root / "ranks" / f"run-{number}-full-rank-vector.json", vector
            )
            write_json(snapshot_root / "metrics" / f"run-{number}-metrics.json", metrics)
            reruns.append(
                {
                    "run": number,
                    "assignmentMapSha256": sha256_bytes(
                        canonical_bytes(batch._p14_canonical_sign_by_code(joined))
                    ),
                    "baseRankSha256": _rank_hash(base_result),
                    "perturbedRankSha256": _rank_hash(perturbed_result),
                    "metricsSha256": sha256_bytes(canonical_bytes(metrics)),
                    "verdict": production["verdict"],
                }
            )
            if base_first is None:
                base_first, perturbed_first, vector_first = (
                    base_result,
                    perturbed_result,
                    vector,
                )
        assert base_first is not None and perturbed_first is not None and vector_first is not None
        write_json(snapshot_root / "reruns" / "five-reruns.json", reruns)

        quality = batch.compute_quality_report(
            candidates_stocks_payload=candidates_payload,
            joined_candidates=joined,
            join_stats=join_stats,
            prescreen_duplicate_codes=duplicate_codes,
            engine_result=base_first,
            context=context,
            previous_artifact=previous,
        )
        quality_report = {
            "context": context,
            "joinStats": join_stats,
            "prescreenDuplicateCodes": duplicate_codes,
            "qualityGate": quality,
            "engineStatus": base_first.get("status"),
        }
        write_json(snapshot_root / "outputs" / "quality-report.json", quality_report)

        production_metrics = _set_metrics(
            base_first, perturbed_first, batch.TOP_N_STABILITY
        )
        production_metrics["threshold"] = batch.RANK_STABILITY_JACCARD_MIN
        production_metrics["verdict"] = (
            "PASS"
            if production_metrics["jaccard"] >= batch.RANK_STABILITY_JACCARD_MIN
            else "FAIL"
        )
        write_json(snapshot_root / "perturbations" / "production-vector.json", vector_first)
        write_json(snapshot_root / "metrics" / "multi-k.json", [
            _set_metrics(base_first, perturbed_first, k) for k in MULTI_K
        ])
        write_json(
            snapshot_root / "metrics" / "correlation.json",
            _correlation(base_first, perturbed_first),
        )
        write_json(
            snapshot_root / "metrics" / "boundary-ranks-30-50.json",
            _boundary(vector_first),
        )

        transforms: dict[str, Callable[[list[Any]], list[Any]]] = {
            "per-only-plus-2pct": lambda rows: _all_percent(
                rows, "per", batch.PERTURBATION_PCT
            ),
            "per-only-minus-2pct": lambda rows: _all_percent(
                rows, "per", -batch.PERTURBATION_PCT
            ),
            "roe-only-plus-2pct": lambda rows: _all_percent(
                rows, "roe", batch.PERTURBATION_PCT
            ),
            "roe-only-minus-2pct": lambda rows: _all_percent(
                rows, "roe", -batch.PERTURBATION_PCT
            ),
            "production-simultaneous": batch._perturb_candidates,
            "inverse-simultaneous": _inverse_simultaneous,
        }
        decomposition: list[dict[str, Any]] = []
        for name in ANALYTICAL_CASES:
            transformed = transforms[name](joined)
            result = engine.build_candidate_funnel(transformed, context)
            vector = _full_rank_vector(joined, transformed, base_first, result)
            write_json(snapshot_root / "ranks" / f"analytical-{name}.json", vector)
            decomposition.append({"case": name, **_set_metrics(base_first, result, 40)})
        write_json(snapshot_root / "perturbations" / "decomposition.json", decomposition)

        base_rank_map = {row["code"]: row["marketRank"] for row in _ranked(base_first)}
        base_assignment = batch._p14_canonical_sign_by_code(joined)
        permutation_summary: list[dict[str, Any]] = []
        original_verdict = production_metrics["verdict"]
        for name, ordered, definition in _permutation_inputs(joined, base_first):
            perm_base = engine.build_candidate_funnel(ordered, context)
            perm_perturbed_inputs = batch._perturb_candidates(ordered)
            perm_perturbed = engine.build_candidate_funnel(perm_perturbed_inputs, context)
            vector = _full_rank_vector(ordered, perm_perturbed_inputs, perm_base, perm_perturbed)
            metrics = _set_metrics(perm_base, perm_perturbed, 40)
            verdict = (
                "PASS"
                if metrics["jaccard"] >= batch.RANK_STABILITY_JACCARD_MIN
                else "FAIL"
            )
            row = {
                "case": name,
                "definition": definition,
                **metrics,
                "verdict": verdict,
                "assignmentMismatch": batch._p14_canonical_sign_by_code(ordered)
                != base_assignment,
                "rankVectorMismatch": {
                    candidate["code"]: candidate["marketRank"]
                    for candidate in _ranked(perm_base)
                }
                != base_rank_map,
                "top40Mismatch": set(_top_codes(perm_base, 40))
                != set(_top_codes(base_first, 40)),
                "jaccardMismatch": metrics["jaccard"] != production_metrics["jaccard"],
                "verdictChangedFromOriginal": verdict != original_verdict,
            }
            case_root = snapshot_root / "permutations" / name
            write_json(
                case_root / "permutation.json",
                {
                    "definition": definition,
                    "orderedCodes": [
                        item.get("code") for item in ordered if isinstance(item, dict)
                    ],
                },
            )
            write_json(case_root / "production-p14.json", row)
            write_json(case_root / "full-rank-vector.json", vector)
            write_json(case_root / "boundary-ranks-30-50.json", _boundary(vector))
            permutation_summary.append(row)
        write_json(
            snapshot_root / "metrics" / "input-order-permutations.json",
            permutation_summary,
        )

        write_json(
            snapshot_root / "logs" / "commands.json",
            [
                "python3 -m data.build_candidates_stocks --run-token <RUN_TOKEN>",
                "python3 data/update_regime_state.py",
                "python3 -m data.p14_evidence_capture --out <RUNNER_TEMP>",
                "python3 -m data.p14_evidence_validate --bundle <BUNDLE> --ci",
            ],
        )
        (snapshot_root / "logs" / "capture-stdout.log").write_text(
            "capture completed; provider stdout is retained in GitHub Actions run logs\n",
            encoding="utf-8",
        )
        (snapshot_root / "logs" / "capture-stderr.log").write_text("", encoding="utf-8")
        (snapshot_root / "logs" / "gate-summary.txt").write_text(
            "\n".join(
                f"{gate['id']} {gate['status']} {gate['value']}"
                for gate in quality["gates"]
            )
            + "\n",
            encoding="utf-8",
        )
        write_json(
            snapshot_root / "validation" / "source-hash-check.json",
            {
                "generatorSha256": generator_hashes,
                "inputSha256": {
                    "candidates": sha256_bytes(candidates_bytes),
                    "prescreen": sha256_bytes(prescreen_bytes),
                    "regime": sha256_bytes(regime_bytes),
                },
            },
        )
        write_json(
            snapshot_root / "snapshot.json",
            {
                "snapshotId": snapshot_id,
                "evidenceClass": "real_captured_same_run",
                "accepted": True,
                "rerunCount": 5,
                "marketContentHash": market_hash,
                "assignmentContract": batch.P14_ASSIGNMENT_CONTRACT,
            },
        )
        _source_manifest(snapshot_root)

        environment = _environment(run_identity)
        write_json(bundle_root / "environment.json", environment)
        provenance = {
            "repository": REPOSITORY,
            "runIdentity": run_identity,
            "externalAcquisition": {
                "jpxSource": candidates_payload.get("_meta", {})
                .get("universeProvenance", {})
                .get("jpxSource"),
                "provider": "JPX public HTTPS + yfinance public bulk OHLCV",
                "credentialsUsed": False,
                "pipelinePath": candidates_payload.get("_meta", {}).get("pipelinePath"),
                "jpxFallbackUsed": candidates_payload.get("_meta", {})
                .get("universeProvenance", {})
                .get("jpxFallbackUsed"),
                "shortlistFallbackUsed": candidates_payload.get("_meta", {})
                .get("universeProvenance", {})
                .get("shortlistFallbackUsed"),
            },
        }
        write_json(bundle_root / "provenance.json", provenance)

        privacy_report = scan_bundle(bundle_root)
        privacy_report["redactedVariableNames"] = environment["redactedVariableNames"]
        write_json(bundle_root / "validation" / "privacy-report.json", privacy_report)
        if not privacy_report["passed"]:
            violations = privacy_report["violations"]
            write_minimal_failure_bundle(bundle_root, violations)
            raise PrivacyViolation(f"privacy violations: {violations}")
        write_json(
            bundle_root / "validation" / "status.json",
            {
                "accepted": False,
                "phase": "pending-independent-ci-validation",
                "criteriaVersion": ACCEPTANCE_VERSION,
                "failedCriteria": [],
            },
        )
        write_json(
            bundle_root / "validation" / "acceptance-report.json",
            {
                "criteriaVersion": ACCEPTANCE_VERSION,
                "mode": "capture",
                "accepted": False,
                "note": "pending validator; workflow result alone is not authority",
            },
        )

        created_at = datetime.now(timezone.utc)
        git_sha = run_identity["gitSha"]
        source_timestamps = {
            "candidatesUpdatedAt": candidates_updated_at,
            "candidatesSourceUpdatedAt": candidates_payload.get("sourceUpdatedAt"),
            "prescreenGeneratedAt": prescreen_payload.get("generatedAt"),
            "regimeGeneratedAt": regime_payload.get("_meta", {}).get("generatedAt"),
            "marketAsOf": candidates_payload.get("sourceUpdatedAt"),
        }
        manifest: dict[str, Any] = {
            "schemaVersion": BUNDLE_SCHEMA_VERSION,
            "bundleId": bundle_id,
            "createdAt": created_at.isoformat(),
            "createdAtJst": created_at.astimezone(JST).isoformat(),
            "assignmentContract": batch.P14_ASSIGNMENT_CONTRACT,
            "assignmentNote": batch.P14_ASSIGNMENT_NOTE,
            "p14Parameters": {
                "threshold": batch.RANK_STABILITY_JACCARD_MIN,
                "topK": batch.TOP_N_STABILITY,
                "perturbationPct": batch.PERTURBATION_PCT,
            },
            "versions": {
                "candidatesSchemaVersion": candidates_payload.get("schemaVersion"),
                "prescreenSchemaVersion": prescreen_payload.get("schemaVersion"),
                "schemaVersion": engine.CANDIDATE_FUNNEL_SCHEMA_VERSION,
                "funnelVersion": engine.CANDIDATE_FUNNEL_VERSION,
                "scoreVersion": engine.CANDIDATE_FUNNEL_SCORE_VERSION,
            },
            "repository": REPOSITORY,
            "frozenTests": [
                {"id": test_id, "function": function}
                for test_id, function in FROZEN_TEST_MAPPING
            ],
            "gitRef": run_identity["gitRef"],
            "gitRefType": run_identity["gitRefType"],
            "gitSha": git_sha,
            "runIdentity": run_identity,
            "generatorSha256": generator_hashes,
            "configurationSha256": sha256_bytes(canonical_bytes(configuration)),
            "inputHashes": {
                "candidates": sha256_bytes(candidates_bytes),
                "prescreen": sha256_bytes(prescreen_bytes),
                "regime": sha256_bytes(regime_bytes),
                "joined": sha256_bytes(canonical_bytes({"candidates": joined})),
            },
            "inputBundleHash": input_hash,
            "marketContentHash": market_hash,
            "candidatePopulationHash": population_hash,
            "prescreenSemanticHash": prescreen_hash,
            "sourceTimestamps": source_timestamps,
            "pipelinePath": candidates_payload.get("_meta", {}).get("pipelinePath"),
            "shortlistId": prescreen_payload.get("shortlistId"),
            "population": len(joined),
            "outputHashes": {
                "base": reruns[0]["baseRankSha256"],
                "perturbed": reruns[0]["perturbedRankSha256"],
            },
            "rerunHashes": [
                {
                    "base": item["baseRankSha256"],
                    "perturbed": item["perturbedRankSha256"],
                    "metrics": item["metricsSha256"],
                }
                for item in reruns
            ],
            "permutationHashes": {
                item["case"]: sha256_bytes(canonical_bytes(item))
                for item in permutation_summary
            },
            "privacy": {
                "filterVersion": PRIVACY_VERSION,
                "forbiddenKeysSource": (
                    "data.candidate_funnel_privacy_smoke.FORBIDDEN_KEYS"
                ),
                "redactedVariableNames": environment["redactedVariableNames"],
                "violations": [],
            },
            "validation": {
                "ciAccepted": False,
                "offlineRequired": True,
                "twoPartyRule": True,
            },
            "acceptance": {
                "accepted": False,
                "criteriaVersion": ACCEPTANCE_VERSION,
                "failedCriteria": [],
            },
        }
        finalize_manifest(bundle_root, manifest)
        return bundle_root
    except PrivacyViolation:
        raise
    except Exception as exc:
        write_minimal_failure_bundle(
            bundle_root,
            [
                {
                    "kind": "capture-error",
                    "exceptionType": type(exc).__name__,
                    "dataFilesUploaded": False,
                }
            ],
        )
        raise


def _run_identity_from_environment() -> dict[str, Any]:
    required = (
        "GITHUB_RUN_ID",
        "GITHUB_RUN_ATTEMPT",
        "GITHUB_SHA",
        "GITHUB_REF",
        "GITHUB_REF_TYPE",
        "GITHUB_EVENT_NAME",
        "P14_RUN_TOKEN",
        "P14_STARTED_AT",
    )
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise CaptureError(f"missing run identity environment variables: {missing}")
    return {
        "runId": os.environ["GITHUB_RUN_ID"],
        "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"],
        "runToken": os.environ["P14_RUN_TOKEN"],
        "workflow": WORKFLOW,
        "event": os.environ["GITHUB_EVENT_NAME"],
        "startedAt": os.environ["P14_STARTED_AT"],
        "runnerOs": os.environ.get("RUNNER_OS", platform.system()),
        "runnerArch": os.environ.get("RUNNER_ARCH", platform.machine()),
        "timezone": os.environ.get("TZ", ""),
        "locale": locale.setlocale(locale.LC_ALL, None),
        "pythonVersion": platform.python_version(),
        "pythonHashSeed": os.environ.get("PYTHONHASHSEED", ""),
        "gitRef": os.environ["GITHUB_REF"],
        "gitRefType": os.environ["GITHUB_REF_TYPE"],
        "gitSha": os.environ["GITHUB_SHA"],
    }


def main(argv: list[str] | tuple[str, ...] = ()) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).parents[1])
    parser.add_argument("--candidates", type=Path, default=batch.CANDIDATES_STOCKS_PATH)
    parser.add_argument("--prescreen", type=Path, default=batch.PRESCREEN_METADATA_PATH)
    parser.add_argument("--regime", type=Path, default=batch.REGIME_STATE_PATH)
    parser.add_argument("--previous", type=Path, default=batch.DATA_OUTPUT_PATH)
    args = parser.parse_args(argv)
    try:
        bundle = build_bundle(
            out_parent=args.out,
            repo_root=args.repo_root,
            run_identity=_run_identity_from_environment(),
            candidates_path=args.candidates,
            prescreen_path=args.prescreen,
            regime_path=args.regime,
            previous_path=args.previous,
        )
    except (CaptureError, PrivacyViolation, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"P14 evidence capture failed: {exc}", file=sys.stderr)
        return 1
    print(bundle)
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with Path(github_output).open("a", encoding="utf-8") as handle:
            handle.write(f"bundle_path={bundle}\n")
            handle.write(f"bundle_id={bundle.name}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
