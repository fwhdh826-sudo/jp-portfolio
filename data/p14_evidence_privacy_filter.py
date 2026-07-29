#!/usr/bin/env python3
"""Privacy boundary for P-14 evidence bundles.

The bundle is intentionally public-market-data-only.  This module reuses the
candidate-funnel forbidden-key authority, records environment-variable
presence without values, normalizes private absolute paths, and scans every
regular file for token-shaped secrets.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable

from data.candidate_funnel_privacy_smoke import FORBIDDEN_KEYS

PRIVACY_VERSION = "p14-evidence-privacy-1"
ALLOWED_INPUT_DATA_FILES = frozenset(
    {
        "candidates_stocks.json",
        "prescreen_metadata.json",
        "regime_state.json",
        "candidate_funnel_previous.json",
    }
)
SENSITIVE_NAME_MARKERS = (
    "TOKEN",
    "SECRET",
    "KEY",
    "PASSWORD",
    "CREDENTIAL",
    "COOKIE",
    "AUTH",
)
SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
)
PRIVATE_PATH_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"/Users/[^/\s\"']+(?:/[^/\s\"']+)*"),
    re.compile(r"/home/[^/\s\"']+(?:/[^/\s\"']+)*"),
)


class PrivacyViolation(RuntimeError):
    """Raised when public evidence would contain forbidden/private material."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def recursive_forbidden_keys(node: Any, prefix: str = "$") -> list[dict[str, str]]:
    """Return exact-key violations at any JSON depth (never substring-match)."""
    found: list[dict[str, str]] = []
    if isinstance(node, dict):
        for key, value in node.items():
            child = f"{prefix}.{key}"
            if key in FORBIDDEN_KEYS:
                found.append({"path": child, "key": key})
            found.extend(recursive_forbidden_keys(value, child))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            found.extend(recursive_forbidden_keys(value, f"{prefix}[{index}]"))
    return found


def normalize_private_paths(value: Any) -> Any:
    """Return a deep sanitized copy with private homes represented as ``<HOME>``."""
    if isinstance(value, dict):
        return {key: normalize_private_paths(child) for key, child in value.items()}
    if isinstance(value, list):
        return [normalize_private_paths(child) for child in value]
    if isinstance(value, str):
        normalized = value
        for pattern in PRIVATE_PATH_PATTERNS:
            normalized = pattern.sub("<HOME>", normalized)
        return normalized
    return value


def environment_presence(
    names: Iterable[str] | None = None,
    environ: dict[str, str] | None = None,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Record names and presence only; environment values are never returned."""
    source = os.environ if environ is None else environ
    selected = sorted(set(source if names is None else names))
    variables = [{"name": name, "present": name in source} for name in selected]
    redacted = sorted(
        name for name in selected if any(marker in name.upper() for marker in SENSITIVE_NAME_MARKERS)
    )
    return variables, redacted


def _token_hits(text: str, label: str) -> list[dict[str, str]]:
    hits: list[dict[str, str]] = []
    for pattern in SECRET_PATTERNS:
        if pattern.search(text):
            hits.append({"path": label, "kind": "secret-token-pattern", "pattern": pattern.pattern})
    return hits


def scan_json_payload(payload: Any, label: str) -> list[dict[str, str]]:
    violations = recursive_forbidden_keys(payload)
    violations.extend(_token_hits(canonical_json(payload), label))
    return violations


def scan_bundle(bundle_root: Path) -> dict[str, Any]:
    """Scan a completed/provisional bundle and return a machine-readable report."""
    root = bundle_root.resolve()
    violations: list[dict[str, str]] = []
    scanned = 0
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        if relative in {"manifest.json", "manifest.sha256"}:
            continue
        scanned += 1
        raw = path.read_bytes()
        text = raw.decode("utf-8", errors="replace")
        violations.extend(_token_hits(text, relative))
        for pattern in PRIVATE_PATH_PATTERNS:
            if pattern.search(text):
                violations.append(
                    {"path": relative, "kind": "private-absolute-path", "pattern": pattern.pattern}
                )
        if path.suffix == ".json":
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                violations.append({"path": relative, "kind": "invalid-json"})
            else:
                for item in recursive_forbidden_keys(payload):
                    violations.append(
                        {
                            "path": f"{relative}:{item['path']}",
                            "kind": "forbidden-key",
                            "key": item["key"],
                        }
                    )

    input_dir = root / "snapshots"
    if input_dir.exists():
        for path in input_dir.glob("*/inputs/data/*"):
            if path.is_file() and path.name not in ALLOWED_INPUT_DATA_FILES:
                violations.append(
                    {"path": path.relative_to(root).as_posix(), "kind": "non-allowlisted-input"}
                )
    return {
        "filterVersion": PRIVACY_VERSION,
        "forbiddenKeysSource": "data.candidate_funnel_privacy_smoke.FORBIDDEN_KEYS",
        "scannedFiles": scanned,
        "violations": violations,
        "passed": not violations,
    }


def pip_freeze() -> list[str]:
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pip", "freeze"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return ["unavailable"]
    return result.stdout.splitlines()


def assert_private_paths_normalized(value: Any) -> None:
    text = canonical_json(value)
    if any(pattern.search(text) for pattern in PRIVATE_PATH_PATTERNS):
        raise PrivacyViolation("private absolute path remained after normalization")


def write_minimal_failure_bundle(bundle_root: Path, violations: list[dict[str, str]]) -> None:
    """Privacy failures upload only a minimal report, never captured data."""
    root = bundle_root.resolve()
    if root.exists():
        for child in sorted(root.rglob("*"), reverse=True):
            if child.is_file() or child.is_symlink():
                child.unlink()
            elif child.is_dir():
                child.rmdir()
    report_path = root / "validation" / "privacy-report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "filterVersion": PRIVACY_VERSION,
        "passed": False,
        "violations": violations,
        "dataFilesUploaded": False,
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
