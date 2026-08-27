#!/usr/bin/env python3
"""Single writer for the frozen five-member P-14 formal corpus registry."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from data.p14_evidence_privacy_filter import recursive_forbidden_keys, scan_bundle
from data.p14_legacy_replay import assert_corpus_append_only

SCHEMA_VERSION = "p14-evidence-corpus-index-2"
LEGACY_SCHEMA_VERSION = "p14-evidence-corpus-index-1"
ACCEPTANCE_VERSION = "p14-evidence-acceptance-1"
EXPECTED_GIT_SHA = "8cfa55680a643415f18c6df8eb5ff2d767a0b77f"
ASSIGNMENT_CONTRACT = "p14-prescreen-rank-code-v1"
EXPECTED_MEMBER_IDS = (
    "real-20260730-758846f07e",
    "real-20260731-e6992c40c1",
    "real-20260805-51e6a8a2e6",
    "reeval-current-dev-committed-20260726",
    "reeval-historical-real-20260714-cache",
)
EXPECTED_MARKET_HASHES = {
    "real-20260730-758846f07e": "758846f07e3984cf1c484d2b77c1f3e5df553f38272b58c766f9c4aa2faf8997",
    "real-20260731-e6992c40c1": "e6992c40c1285c611f2f92375ad7df3a7b05374cb7e7f88b8ef9058bd49484c2",
    "real-20260805-51e6a8a2e6": "51e6a8a2e6290de9d09e53b51b854c4888d92378640362c9763f80918644f9ad",
    "reeval-current-dev-committed-20260726": "ea1686f5927b9880b64aedafb6f18c5d3d1c3089cb451a39d4f966ca598945fd",
    "reeval-historical-real-20260714-cache": "c9b4a0e3e5bcfafcc8670f50324c3b94d6953bf19500faec355784e63bedfd15",
}
ACCEPTANCE_REPORTS = {
    "real-20260730-758846f07e": "p5-b005-c-p14-e2-a1-evidence-preservation-authority.md",
    "real-20260731-e6992c40c1": "p5-b005-c-p14-e3-r1-second-real-snapshot-run-30588177810.md",
    "real-20260805-51e6a8a2e6": "p14-snapshot3-real-evidence-acceptance.md",
    "reeval-current-dev-committed-20260726": "p14-e4-r2-i1-v-independent-adversarial-audit.md",
    "reeval-historical-real-20260714-cache": "p14-e4-r2-i1-v-independent-adversarial-audit.md",
}
HEX64 = re.compile(r"[0-9a-f]{64}")


class CorpusRegistrationError(RuntimeError):
    """Raised before mutation when a formal binding is invalid."""


@dataclass(frozen=True)
class MemberEvidence:
    bundle: Path
    offline_validation: Path


def _load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CorpusRegistrationError(f"invalid JSON: {path.name}") from exc
    if not isinstance(value, dict):
        raise CorpusRegistrationError(f"JSON object required: {path.name}")
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = payload.get("acceptedSnapshots")
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise CorpusRegistrationError("acceptedSnapshots must be an object array")
    return rows


def derived_counts(rows: Iterable[dict[str, Any]]) -> dict[str, int]:
    """Derive every count; distinctCount is the accepted market-hash set size."""
    accepted = [row for row in rows if row.get("accepted") is True]
    hashes = {
        row.get("marketContentHash")
        for row in accepted
        if isinstance(row.get("marketContentHash"), str)
    }
    return {
        "memberCount": len(accepted),
        "distinctCount": len(hashes),
        "realCapturedSameRunCount": sum(
            row.get("evidenceClass") == "real_captured_same_run" for row in accepted
        ),
        "realReconstructedCount": sum(
            row.get("evidenceClass") == "real_reconstructed" for row in accepted
        ),
    }


def _validate_source_index(payload: dict[str, Any]) -> None:
    if payload.get("schemaVersion") not in {LEGACY_SCHEMA_VERSION, SCHEMA_VERSION}:
        raise CorpusRegistrationError("unsupported corpus schemaVersion")
    if "snapshots" in payload or "entries" in payload:
        raise CorpusRegistrationError("formal metadata array must be named registrations")
    counts = derived_counts(_rows(payload))
    for key in ("distinctCount", "realCapturedSameRunCount"):
        if payload.get(key) != counts[key]:
            raise CorpusRegistrationError("stale corpus index: derived count mismatch")
    if payload.get("schemaVersion") == SCHEMA_VERSION:
        for key in ("memberCount", "realReconstructedCount"):
            if payload.get(key) != counts[key]:
                raise CorpusRegistrationError("stale corpus index: derived count mismatch")


def _relative(path: Path, root: Path, label: str) -> str:
    try:
        value = path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError as exc:
        raise CorpusRegistrationError(f"{label} must be below its canonical root") from exc
    if value.startswith("/") or value.startswith("../"):
        raise CorpusRegistrationError(f"{label} must be relative")
    return value


def _snapshot(bundle: Path) -> tuple[str, Path]:
    snapshots = sorted(path for path in (bundle / "snapshots").glob("*") if path.is_dir())
    if len(snapshots) != 1:
        raise CorpusRegistrationError("bundle must contain exactly one snapshot")
    snapshot_id = snapshots[0].name
    if snapshot_id not in EXPECTED_MEMBER_IDS:
        raise CorpusRegistrationError("non-canonical member ID")
    return snapshot_id, snapshots[0]


def _p14_observation(snapshot: Path, snapshot_id: str) -> dict[str, Any]:
    quality = _load_json(snapshot / "outputs/quality-report.json")
    gates = quality.get("qualityGate", {}).get("gates", [])
    p14 = next((gate for gate in gates if isinstance(gate, dict) and gate.get("id") == "P-14"), None)
    if not isinstance(p14, dict) or p14.get("status") not in {"PASS", "FAIL"}:
        raise CorpusRegistrationError("P-14 observation missing")
    try:
        permutations = json.loads(
            (snapshot / "metrics/input-order-permutations.json").read_text(encoding="utf-8")
        )
    except (OSError, json.JSONDecodeError) as exc:
        raise CorpusRegistrationError("invalid P-14 permutations") from exc
    if not isinstance(permutations, list) or not permutations:
        raise CorpusRegistrationError("P-14 permutations missing")
    original = next(
        (row for row in permutations if isinstance(row, dict) and row.get("case") == "original-order"),
        None,
    )
    if not isinstance(original, dict):
        raise CorpusRegistrationError("original-order P-14 result missing")
    if original.get("jaccard") != p14.get("value") or original.get("verdict") != p14.get("status"):
        raise CorpusRegistrationError("P-14 report mismatch")
    return {
        "jaccard": original.get("jaccard"),
        "retention": original.get("retention"),
        "swapCount": original.get("swapCount"),
        "verdict": original.get("verdict"),
        "permutationVerdictChanges": sum(
            row.get("verdictChangedFromOriginal") is True
            for row in permutations
            if isinstance(row, dict)
        ),
        "classification": (
            "EXPECTED_REAL_DATA_OBSERVATION"
            if snapshot_id == "real-20260805-51e6a8a2e6"
            else "NORMAL"
        ),
    }


def _two_party(manifest: dict[str, Any], bundle: Path, report: dict[str, Any], legacy: bool) -> dict[str, Any]:
    status = _load_json(bundle / "validation/status.json")
    acceptance = manifest.get("acceptance")
    validation = manifest.get("validation")
    party1_ok = (
        status.get("accepted") is True
        and status.get("phase") == "ci-validation-complete"
        and isinstance(validation, dict)
        and validation.get("ciAccepted") is True
        and isinstance(acceptance, dict)
        and acceptance.get("accepted") is True
        and status.get("criteriaVersion") == ACCEPTANCE_VERSION
    )
    criteria = report.get("criteria")
    expected_count = 52 if legacy else 25
    party2_ok = (
        report.get("criteriaVersion") == ACCEPTANCE_VERSION
        and report.get("mode") == "offline"
        and report.get("accepted") is True
        and report.get("failedCriteria") == []
        and report.get("distinctIncrement") == 1
        and isinstance(criteria, list)
        and len(criteria) == expected_count
        and all(isinstance(item, dict) and item.get("passed") is True for item in criteria)
    )
    if not party1_ok or not party2_ok:
        raise CorpusRegistrationError("wrong E4-TWO-PARTY state")
    return {
        "party1": {"phase": "ci-validation-complete", "accepted": True,
                   "criteriaVersion": ACCEPTANCE_VERSION},
        "party2": {"accepted": True, "failedCriteria": [], "distinctIncrement": 1,
                   "criteriaCount": expected_count},
    }


def _archive_identity(bundle: Path, corpus_root: Path) -> tuple[str, int]:
    archive = corpus_root / f"{bundle.name}.tar.gz"
    sha_sidecar = corpus_root / f"{bundle.name}.archive.sha256"
    bytes_sidecar = corpus_root / f"{bundle.name}.archive.bytes"
    if not archive.is_file() or not sha_sidecar.is_file() or not bytes_sidecar.is_file():
        raise CorpusRegistrationError("canonical archive or sidecar missing")
    actual_sha = _sha256(archive)
    sidecar_sha = sha_sidecar.read_text(encoding="utf-8").strip().split()[0]
    try:
        sidecar_bytes = int(bytes_sidecar.read_text(encoding="utf-8").strip().split()[0])
    except (OSError, ValueError, IndexError) as exc:
        raise CorpusRegistrationError("invalid archive bytes sidecar") from exc
    if actual_sha != sidecar_sha or archive.stat().st_size != sidecar_bytes:
        raise CorpusRegistrationError("archive hash mismatch")
    return actual_sha, sidecar_bytes


def _member_from_evidence(
    spec: MemberEvidence, corpus_root: Path, audit_root: Path
) -> tuple[dict[str, Any], dict[str, Any]]:
    bundle = spec.bundle.resolve()
    if not bundle.is_dir() or not spec.offline_validation.is_file():
        raise CorpusRegistrationError("member evidence missing")
    _relative(bundle, corpus_root, "evidencePath")
    manifest = _load_json(bundle / "manifest.json")
    snapshot_id, snapshot = _snapshot(bundle)
    legacy = manifest.get("captureMode") == "legacy-replay"
    member_type = "real_reconstructed" if legacy else "real_captured_same_run"
    report = _load_json(spec.offline_validation)
    observation = _p14_observation(snapshot, snapshot_id)
    if manifest.get("marketContentHash") != EXPECTED_MARKET_HASHES[snapshot_id]:
        raise CorpusRegistrationError("wrong canonical market hash")
    if report.get("marketContentHash") != manifest.get("marketContentHash"):
        raise CorpusRegistrationError("offline report market hash mismatch")
    if report.get("inputBundleHash") != manifest.get("inputBundleHash"):
        raise CorpusRegistrationError("offline report bundle hash mismatch")
    if manifest.get("gitSha") != EXPECTED_GIT_SHA:
        raise CorpusRegistrationError("wrong audited target SHA")
    if manifest.get("assignmentContract") != ASSIGNMENT_CONTRACT:
        raise CorpusRegistrationError("wrong assignment contract")
    two_party = _two_party(manifest, bundle, report, legacy)
    privacy = scan_bundle(bundle)
    if privacy.get("passed") is not True or privacy.get("violations") != []:
        raise CorpusRegistrationError("privacy failure")
    archive_sha, archive_bytes = _archive_identity(bundle, corpus_root)
    report_relative = ACCEPTANCE_REPORTS[snapshot_id]
    acceptance_report = audit_root / report_relative
    if not acceptance_report.is_file():
        raise CorpusRegistrationError("acceptance report missing")
    row: dict[str, Any] = {
        "snapshotId": snapshot_id,
        "bundleId": bundle.name,
        "evidenceClass": member_type,
        "accepted": True,
        "marketContentHash": manifest["marketContentHash"],
        "inputBundleHash": manifest["inputBundleHash"],
        "gitSha": manifest["gitSha"],
        "assignmentContract": manifest["assignmentContract"],
        "jaccard": observation["jaccard"],
        "retention": observation["retention"],
        "swapCount": observation["swapCount"],
        "verdict": observation["verdict"],
        "permutationVerdictChanges": observation["permutationVerdictChanges"],
        "deterministic": True,
    }
    if legacy:
        source = manifest.get("legacySource")
        deviations = manifest.get("legacyDeviations")
        if not isinstance(source, dict) or not isinstance(deviations, dict):
            raise CorpusRegistrationError("legacy source identity missing")
        row.update(
            {
                "prescreenBytesReconstructed": deviations.get("prescreenBytesReconstructed"),
                "legacySourceSnapshotId": source.get("legacySnapshotId"),
                "replayExecutionId": source.get("replayExecutionId"),
            }
        )
        if (
            row["legacySourceSnapshotId"] != snapshot_id.removeprefix("reeval-")
            or row["replayExecutionId"] != "r01"
        ):
            raise CorpusRegistrationError("wrong legacy registration identity")
        if row["permutationVerdictChanges"] != 0:
            raise CorpusRegistrationError("pre-O2 result entered formal corpus")
    registration = {
        "snapshotId": snapshot_id,
        "bundleId": bundle.name,
        "memberType": member_type,
        "evidencePath": _relative(bundle, corpus_root, "evidencePath"),
        "archiveSha256": archive_sha,
        "archiveBytes": archive_bytes,
        "acceptanceReport": {"path": report_relative, "sha256": _sha256(acceptance_report)},
        "twoParty": two_party,
        "privacy": {"passed": True, "violations": 0},
        "p14Observation": {
            "verdict": observation["verdict"],
            "classification": observation["classification"],
        },
        "registrationState": "REGISTERED",
    }
    return row, registration


def verify_payload(payload: dict[str, Any], *, corpus_root: Path, audit_root: Path) -> None:
    """Fail closed unless all S1 I-01..I-18 invariants hold."""
    if payload.get("schemaVersion") != SCHEMA_VERSION:
        raise CorpusRegistrationError("schemaVersion is not formal v2")
    if "snapshots" in payload or "entries" in payload:
        raise CorpusRegistrationError("formal metadata array must be named registrations")
    rows = _rows(payload)
    registrations = payload.get("registrations")
    if not isinstance(registrations, list) or not all(isinstance(item, dict) for item in registrations):
        raise CorpusRegistrationError("registrations must be an object array")
    ids = [row.get("snapshotId") for row in rows]
    registration_ids = [item.get("snapshotId") for item in registrations]
    if ids != list(EXPECTED_MEMBER_IDS) or registration_ids != list(EXPECTED_MEMBER_IDS):
        raise CorpusRegistrationError("formal corpus member set or order mismatch")
    if len(ids) != len(set(ids)):
        raise CorpusRegistrationError("duplicate member ID")
    hashes = [row.get("marketContentHash") for row in rows]
    if any(not isinstance(value, str) or HEX64.fullmatch(value) is None for value in hashes):
        raise CorpusRegistrationError("missing or invalid market hash")
    if len(hashes) != len(set(hashes)):
        raise CorpusRegistrationError("duplicate source identity")
    for row in rows:
        snapshot_id = row.get("snapshotId")
        if row.get("marketContentHash") != EXPECTED_MARKET_HASHES.get(snapshot_id):
            raise CorpusRegistrationError("wrong canonical market hash")
    if any(row.get("accepted") is not True for row in rows):
        raise CorpusRegistrationError("unaccepted member")
    if any(row.get("gitSha") != EXPECTED_GIT_SHA for row in rows):
        raise CorpusRegistrationError("wrong audited target SHA")
    if any(row.get("assignmentContract") != ASSIGNMENT_CONTRACT for row in rows):
        raise CorpusRegistrationError("wrong assignment contract")
    counts = derived_counts(rows)
    if any(payload.get(key) != value for key, value in counts.items()):
        raise CorpusRegistrationError("stale corpus index: derived count mismatch")
    if counts != {
        "memberCount": 5,
        "distinctCount": 5,
        "realCapturedSameRunCount": 3,
        "realReconstructedCount": 2,
    }:
        raise CorpusRegistrationError("formal corpus count invariant failed")
    if set(ids) != set(registration_ids) or len(registration_ids) != len(set(registration_ids)):
        raise CorpusRegistrationError("registration binding is not bijective")
    for row, registration in zip(rows, registrations, strict=True):
        if registration.get("snapshotId") != row.get("snapshotId"):
            raise CorpusRegistrationError("registration ordering mismatch")
        if registration.get("registrationState") != "REGISTERED":
            raise CorpusRegistrationError("unregistered member")
        if registration.get("privacy") != {"passed": True, "violations": 0}:
            raise CorpusRegistrationError("privacy failure")
        evidence_path = registration.get("evidencePath")
        if (
            not isinstance(evidence_path, str)
            or Path(evidence_path).is_absolute()
            or ".." in Path(evidence_path).parts
        ):
            raise CorpusRegistrationError("absolute or escaping evidencePath")
        if (
            registration.get("bundleId") != row.get("bundleId")
            or evidence_path != row.get("bundleId")
        ):
            raise CorpusRegistrationError("canonical source identity mismatch")
        report = registration.get("acceptanceReport")
        if not isinstance(report, dict) or not isinstance(report.get("path"), str):
            raise CorpusRegistrationError("acceptance report binding missing")
        if report["path"] != ACCEPTANCE_REPORTS[row["snapshotId"]]:
            raise CorpusRegistrationError("wrong acceptance report binding")
        report_path = audit_root / report["path"]
        if not report_path.is_file() or report.get("sha256") != _sha256(report_path):
            raise CorpusRegistrationError("acceptance report binding mismatch")
        if not (corpus_root / evidence_path).is_dir():
            raise CorpusRegistrationError("canonical evidencePath missing")
        archive = corpus_root / f"{registration.get('bundleId')}.tar.gz"
        if (
            not archive.is_file()
            or registration.get("archiveSha256") != _sha256(archive)
            or registration.get("archiveBytes") != archive.stat().st_size
        ):
            raise CorpusRegistrationError("archive hash mismatch")
        expected_criteria = 52 if row.get("evidenceClass") == "real_reconstructed" else 25
        expected_party1 = {
            "phase": "ci-validation-complete",
            "accepted": True,
            "criteriaVersion": ACCEPTANCE_VERSION,
        }
        expected_party2 = {
            "accepted": True,
            "failedCriteria": [],
            "distinctIncrement": 1,
            "criteriaCount": expected_criteria,
        }
        two_party = registration.get("twoParty")
        if (
            not isinstance(two_party, dict)
            or two_party.get("party1") != expected_party1
            or two_party.get("party2") != expected_party2
        ):
            raise CorpusRegistrationError("wrong E4-TWO-PARTY state")
        if row.get("evidenceClass") == "real_reconstructed" and (
            row.get("legacySourceSnapshotId") != row["snapshotId"].removeprefix("reeval-")
            or row.get("replayExecutionId") != "r01"
            or row.get("permutationVerdictChanges") != 0
        ):
            raise CorpusRegistrationError("pre-O2 result entered formal corpus")
    if rows[2].get("verdict") != "FAIL" or rows[2].get("accepted") is not True:
        raise CorpusRegistrationError("Snapshot #3 acceptance/observation separation failed")
    if registrations[2].get("p14Observation") != {
        "verdict": "FAIL",
        "classification": "EXPECTED_REAL_DATA_OBSERVATION",
    }:
        raise CorpusRegistrationError("Snapshot #3 classification mismatch")
    if recursive_forbidden_keys(payload):
        raise CorpusRegistrationError("privacy forbidden key in index")
    serialized = json.dumps(payload, ensure_ascii=False)
    if re.search(r"/(?:Users|home)/", serialized) or re.search(
        r"gh[pousr]_[A-Za-z0-9]{36,}", serialized
    ):
        raise CorpusRegistrationError("private path or token in index")


def register(
    *,
    corpus_index: Path,
    evidence: Iterable[MemberEvidence],
    corpus_root: Path,
    audit_root: Path,
    before_replace: Callable[[dict[str, Any]], None] | None = None,
) -> bool:
    """Atomically migrate/register the exact member set; return False on a byte no-op."""
    before = corpus_index.read_bytes()
    current = _load_json(corpus_index)
    _validate_source_index(current)
    candidate_rows: dict[str, dict[str, Any]] = {}
    candidate_registrations: dict[str, dict[str, Any]] = {}
    for spec in evidence:
        row, registration = _member_from_evidence(spec, corpus_root, audit_root)
        snapshot_id = row["snapshotId"]
        if snapshot_id in candidate_rows:
            raise CorpusRegistrationError("duplicate member ID")
        candidate_rows[snapshot_id] = row
        candidate_registrations[snapshot_id] = registration
    for row in _rows(current):
        supplied = candidate_rows.get(row.get("snapshotId"))
        if supplied is None:
            raise CorpusRegistrationError("member missing")
        if row != supplied:
            raise CorpusRegistrationError("P14_E4_R1_CORPUS_CONFLICT: existing entry changed")
    if set(candidate_rows) != set(EXPECTED_MEMBER_IDS):
        raise CorpusRegistrationError("member missing")
    rows = [candidate_rows[snapshot_id] for snapshot_id in EXPECTED_MEMBER_IDS]
    registrations = [candidate_registrations[snapshot_id] for snapshot_id in EXPECTED_MEMBER_IDS]
    updated = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": current.get("generatedAt"),
        **derived_counts(rows),
        "acceptedSnapshots": rows,
        "registrations": registrations,
    }
    if current == updated:
        verify_payload(updated, corpus_root=corpus_root, audit_root=audit_root)
        return False
    updated["generatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    verify_payload(updated, corpus_root=corpus_root, audit_root=audit_root)
    after = _json_bytes(updated)
    assert_corpus_append_only(before, after)
    if before_replace is not None:
        before_replace(updated)
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=f".{corpus_index.name}.",
            suffix=".tmp",
            dir=corpus_index.parent,
            delete=False,
        ) as handle:
            temporary_name = handle.name
            handle.write(after)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, corpus_index)
    except Exception:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)
        raise
    return True


def verify_index(corpus_index: Path, *, corpus_root: Path, audit_root: Path) -> None:
    verify_payload(_load_json(corpus_index), corpus_root=corpus_root, audit_root=audit_root)


def _repo_head(repo_root: Path) -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def main(argv: list[str] | tuple[str, ...] = ()) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus-index", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, action="append", default=[])
    parser.add_argument("--offline-validation", type=Path, action="append", default=[])
    parser.add_argument("--legacy", action="store_true")
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--corpus-root", type=Path)
    parser.add_argument("--audit-root", type=Path)
    parser.add_argument("--repo-root", type=Path)
    args = parser.parse_args(argv)
    corpus_index = args.corpus_index.resolve()
    corpus_root = (args.corpus_root or corpus_index.parent).resolve()
    audit_root = (args.audit_root or corpus_root.parent).resolve()
    try:
        if args.verify:
            if args.bundle or args.offline_validation or args.legacy:
                parser.error("--verify does not accept registration inputs")
            verify_index(corpus_index, corpus_root=corpus_root, audit_root=audit_root)
            print(json.dumps({"verified": True, **derived_counts(_rows(_load_json(corpus_index)))}))
            return 0
        if len(args.bundle) != len(args.offline_validation) or not args.bundle:
            parser.error("registration requires matching --bundle and --offline-validation values")
        if args.repo_root is not None and _repo_head(args.repo_root.resolve()) != EXPECTED_GIT_SHA:
            raise CorpusRegistrationError("wrong audited target SHA")
        specs = [
            MemberEvidence(bundle.resolve(), report.resolve())
            for bundle, report in zip(args.bundle, args.offline_validation, strict=True)
        ]
        changed = register(
            corpus_index=corpus_index,
            evidence=specs,
            corpus_root=corpus_root,
            audit_root=audit_root,
        )
        print(json.dumps({"registered": changed, **derived_counts(_rows(_load_json(corpus_index)))}))
        return 0
    except (
        CorpusRegistrationError,
        OSError,
        ValueError,
        TypeError,
        subprocess.SubprocessError,
    ) as exc:
        print(json.dumps({"registered": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
