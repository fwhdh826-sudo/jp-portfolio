"""E4-CORPUS-T-01..20: frozen formal corpus registry contract."""
from __future__ import annotations

import ast
import builtins
import copy
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from data import p14_corpus_register as registry
from data.p14_legacy_replay import assert_corpus_append_only

OBSERVATIONS = {
    "real-20260730-758846f07e": (1.0, 1.0, 0, "PASS"),
    "real-20260731-e6992c40c1": (0.9512195121951219, 0.975, 1, "PASS"),
    "real-20260805-51e6a8a2e6": (0.9047619047619048, 0.95, 2, "FAIL"),
    "reeval-current-dev-committed-20260726": (0.9512195121951219, 0.975, 1, "PASS"),
    "reeval-historical-real-20260714-cache": (0.8604651162790697, 0.925, 3, "FAIL"),
}


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _tree_state(root: Path) -> dict[str, tuple[bytes, int]]:
    return {
        path.relative_to(root).as_posix(): (path.read_bytes(), path.stat().st_mtime_ns)
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def _is_sys_executable(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Name)
        and node.value.id == "sys"
        and node.attr == "executable"
    )


def _is_portable_interpreter_default(node: ast.AST) -> bool:
    if _is_sys_executable(node):
        return True
    if not isinstance(node, ast.BoolOp) or not isinstance(node.op, ast.Or):
        return False
    if len(node.values) < 2 or not _is_sys_executable(node.values[-1]):
        return False
    for value in node.values[:-1]:
        if not (
            isinstance(value, ast.Call)
            and isinstance(value.func, ast.Attribute)
            and isinstance(value.func.value, ast.Name)
            and value.func.value.id == "shutil"
            and value.func.attr == "which"
            and len(value.args) == 1
            and isinstance(value.args[0], ast.Constant)
            and isinstance(value.args[0].value, str)
            and not Path(value.args[0].value).is_absolute()
        ):
            return False
    return True


def _is_p14_python_env_get(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "get"
        and isinstance(node.func.value, ast.Attribute)
        and node.func.value.attr == "environ"
        and isinstance(node.func.value.value, ast.Name)
        and node.func.value.value.id == "os"
        and bool(node.args)
        and isinstance(node.args[0], ast.Constant)
        and node.args[0].value == "P14_PY311"
    )


def _p14_python_default(node: ast.Call) -> ast.AST | None:
    if len(node.args) >= 2:
        return node.args[1]
    return next((item.value for item in node.keywords if item.arg == "default"), None)


def _is_absolute_interpreter_literal(value: str) -> bool:
    if not Path(value).is_absolute():
        return False
    interpreter = re.compile(r"(?:python(?:\d+(?:\.\d+)*)?|pypy\d*)", re.IGNORECASE)
    parts = Path(value).parts
    if any(interpreter.fullmatch(part) for part in parts):
        return True
    return Path(value).name == "bin" and re.search(r"py(?:thon)?\d", value, re.IGNORECASE) is not None


def _semantic_interpreter_offenders(tree: ast.AST) -> list[tuple[int, str]]:
    offenders: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if _is_p14_python_env_get(node):
            default = _p14_python_default(node)
            if default is None or not _is_portable_interpreter_default(default):
                offenders.append((node.lineno, "P14_PY311-default"))
        if (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and _is_absolute_interpreter_literal(node.value)
        ):
            offenders.append((node.lineno, "absolute-interpreter"))
    return offenders


def _structural_interpreter_offenders(source: str) -> list[int]:
    fragments = ("/private/" + "tmp/", "/" + "Users/", "/opt/" + "homebrew/")
    interpreter = re.compile(r"(?:python(?:3(?:\.11)?)?|pypy3)(?:[\"'])")
    return [
        number
        for number, line in enumerate(source.splitlines(), 1)
        if any(fragment in line for fragment in fragments) and interpreter.search(line)
    ]


class _MidWriteFailure:
    def __init__(self, handle: object, faulted_paths: list[Path]) -> None:
        self._handle = handle
        self._faulted_paths = faulted_paths

    def __enter__(self) -> "_MidWriteFailure":
        self._handle.__enter__()
        return self

    def __exit__(self, *args: object) -> object:
        return self._handle.__exit__(*args)

    def __getattr__(self, name: str) -> object:
        return getattr(self._handle, name)

    def write(self, payload: bytes) -> int:
        midpoint = max(1, len(payload) // 2)
        self._handle.write(payload[:midpoint])
        self._handle.flush()
        self._faulted_paths.append(Path(self._handle.name))
        raise OSError("injected mid-write failure")


def _make_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    audit_root = tmp_path / "audit"
    corpus_root = audit_root / "p14-e2-snapshots"
    corpus_root.mkdir(parents=True)
    report_names = dict(registry.ACCEPTANCE_REPORTS)
    monkeypatch.setattr(registry, "ACCEPTANCE_REPORTS", report_names)
    evidence: list[registry.MemberEvidence] = []
    rows: list[dict[str, object]] = []
    for index, member_id in enumerate(registry.EXPECTED_MEMBER_IDS, 1):
        legacy = member_id.startswith("reeval-")
        bundle = corpus_root / f"canonical-bundle-{index}"
        snapshot = bundle / "snapshots" / member_id
        jaccard, retention, swap_count, verdict = OBSERVATIONS[member_id]
        input_hash = _digest(f"input-{member_id}".encode())
        manifest: dict[str, object] = {
            "bundleId": bundle.name,
            "marketContentHash": registry.EXPECTED_MARKET_HASHES[member_id],
            "inputBundleHash": input_hash,
            "gitSha": registry.EXPECTED_GIT_SHA,
            "assignmentContract": registry.ASSIGNMENT_CONTRACT,
            "validation": {"ciAccepted": True, "offlineRequired": True, "twoPartyRule": True},
            "acceptance": {"accepted": True, "criteriaVersion": registry.ACCEPTANCE_VERSION,
                           "failedCriteria": []},
        }
        if legacy:
            manifest.update({
                "captureMode": "legacy-replay",
                "legacySource": {
                    "legacySnapshotId": member_id.removeprefix("reeval-"),
                    "replayExecutionId": "r01",
                },
                "legacyDeviations": {"prescreenBytesReconstructed": True},
            })
        _write_json(bundle / "manifest.json", manifest)
        _write_json(bundle / "validation/status.json", {
            "accepted": True, "phase": "ci-validation-complete",
            "criteriaVersion": registry.ACCEPTANCE_VERSION,
        })
        _write_json(snapshot / "outputs/quality-report.json", {
            "qualityGate": {"gates": [{"id": "P-14", "value": jaccard, "status": verdict}]}
        })
        _write_json(snapshot / "metrics/input-order-permutations.json", [{
            "case": "original-order", "jaccard": jaccard, "retention": retention,
            "swapCount": swap_count, "verdict": verdict, "verdictChangedFromOriginal": False,
        }])
        _write_json(bundle / "validation/privacy-report.json", {"passed": True, "violations": []})
        report_path = audit_root / report_names[member_id]
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(f"ACCEPTED {member_id}\n", encoding="utf-8")
        offline = corpus_root / f"{bundle.name}.offline-validation.json"
        _write_json(offline, {
            "criteriaVersion": registry.ACCEPTANCE_VERSION,
            "mode": "offline", "accepted": True, "validCapture": True,
            "snapshotVerdict": "accepted", "duplicate": False, "duplicateOf": None,
            "distinctIncrement": 1,
            "marketContentHash": registry.EXPECTED_MARKET_HASHES[member_id],
            "inputBundleHash": input_hash,
            "criteria": [{"id": f"C-{number:02d}", "passed": True}
                         for number in range(1, 53 if legacy else 26)],
            "failedCriteria": [],
        })
        archive = corpus_root / f"{bundle.name}.tar.gz"
        archive.write_bytes(f"archive:{member_id}".encode())
        (corpus_root / f"{bundle.name}.archive.sha256").write_text(
            f"{_digest(archive.read_bytes())}  {archive.name}\n", encoding="utf-8"
        )
        (corpus_root / f"{bundle.name}.archive.bytes").write_text(
            f"{archive.stat().st_size}\n", encoding="utf-8"
        )
        spec = registry.MemberEvidence(bundle, offline)
        evidence.append(spec)
        row, _registration = registry._member_from_evidence(spec, corpus_root, audit_root)
        rows.append(row)
    index = corpus_root / "corpus-index.json"
    _write_json(index, {
        "schemaVersion": registry.LEGACY_SCHEMA_VERSION,
        "generatedAt": "2026-07-30T22:50:23Z",
        "distinctCount": 2,
        "realCapturedSameRunCount": 2,
        "acceptedSnapshots": rows[:2],
    })
    initial = index.read_bytes()
    return {"audit_root": audit_root, "corpus_root": corpus_root, "index": index,
            "evidence": evidence, "initial": initial}


@pytest.fixture
def formal_corpus(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    environment = _make_environment(tmp_path, monkeypatch)
    assert registry.register(
        corpus_index=environment["index"], evidence=environment["evidence"],
        corpus_root=environment["corpus_root"], audit_root=environment["audit_root"],
    ) is True
    environment["payload"] = json.loads(environment["index"].read_text(encoding="utf-8"))
    return environment


def _verify(payload: dict[str, object], environment: dict[str, object]) -> None:
    registry.verify_payload(payload, corpus_root=environment["corpus_root"],
                            audit_root=environment["audit_root"])


def test_corpus_has_exactly_five_canonical_members(
    formal_corpus: dict[str, object], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """E4-CORPUS-T-01: canonical set, missing-member, and unaccepted controls."""
    payload = formal_corpus["payload"]
    assert [row["snapshotId"] for row in payload["acceptedSnapshots"]] == list(
        registry.EXPECTED_MEMBER_IDS
    )
    environment = _make_environment(tmp_path / "missing", monkeypatch)
    with pytest.raises(registry.CorpusRegistrationError, match="member missing"):
        registry.register(corpus_index=environment["index"], evidence=environment["evidence"][:-1],
                          corpus_root=environment["corpus_root"], audit_root=environment["audit_root"])
    mutated = copy.deepcopy(payload)
    mutated["acceptedSnapshots"][0]["accepted"] = False
    with pytest.raises(registry.CorpusRegistrationError, match="unaccepted"):
        _verify(mutated, formal_corpus)


def test_real_captured_same_run_count_is_three(formal_corpus: dict[str, object]) -> None:
    """E4-CORPUS-T-02."""
    payload = formal_corpus["payload"]
    assert registry.derived_counts(payload["acceptedSnapshots"])["realCapturedSameRunCount"] == 3
    assert payload["realCapturedSameRunCount"] == 3


def test_real_reconstructed_count_is_two(formal_corpus: dict[str, object]) -> None:
    """E4-CORPUS-T-03."""
    payload = formal_corpus["payload"]
    assert registry.derived_counts(payload["acceptedSnapshots"])["realReconstructedCount"] == 2
    assert payload["realReconstructedCount"] == 2


def test_distinct_and_member_counts_are_five(formal_corpus: dict[str, object]) -> None:
    """E4-CORPUS-T-04: distinctCount is not len(rows) when a duplicate row exists."""
    payload = formal_corpus["payload"]
    assert payload["distinctCount"] == payload["memberCount"] == 5
    duplicate_fixture = copy.deepcopy(payload["acceptedSnapshots"])
    duplicate_fixture.append({**duplicate_fixture[-1], "snapshotId": "duplicate-observation"})
    counts = registry.derived_counts(duplicate_fixture)
    assert counts["memberCount"] == 6
    assert counts["distinctCount"] == 5


def test_member_ids_are_unique(formal_corpus: dict[str, object]) -> None:
    """E4-CORPUS-T-05: duplicate member ID is fail-closed."""
    mutated = copy.deepcopy(formal_corpus["payload"])
    mutated["acceptedSnapshots"][1]["snapshotId"] = mutated["acceptedSnapshots"][0]["snapshotId"]
    with pytest.raises(registry.CorpusRegistrationError):
        _verify(mutated, formal_corpus)


def test_hash_integrity_of_every_member(formal_corpus: dict[str, object]) -> None:
    """E4-CORPUS-T-06: missing/wrong/duplicate hash and wrong SHA controls."""
    payload = formal_corpus["payload"]
    assert all(re.fullmatch(r"[0-9a-f]{64}", row["marketContentHash"])
               for row in payload["acceptedSnapshots"])
    for field, value, message in (
        ("marketContentHash", "", "market hash"),
        ("gitSha", "0" * 40, "audited target"),
    ):
        mutated = copy.deepcopy(payload)
        mutated["acceptedSnapshots"][0][field] = value
        with pytest.raises(registry.CorpusRegistrationError, match=message):
            _verify(mutated, formal_corpus)
    mutated = copy.deepcopy(payload)
    mutated["acceptedSnapshots"][1]["marketContentHash"] = mutated["acceptedSnapshots"][0]["marketContentHash"]
    with pytest.raises(registry.CorpusRegistrationError, match="duplicate source"):
        _verify(mutated, formal_corpus)
    mutated = copy.deepcopy(payload)
    mutated["registrations"][0]["archiveSha256"] = "0" * 64
    with pytest.raises(registry.CorpusRegistrationError, match="archive hash"):
        _verify(mutated, formal_corpus)
    mutated = copy.deepcopy(payload)
    mutated["acceptedSnapshots"][0]["marketContentHash"] = "a" * 64
    with pytest.raises(registry.CorpusRegistrationError, match="canonical market hash"):
        _verify(mutated, formal_corpus)


def test_acceptance_report_binding_is_bijective(formal_corpus: dict[str, object]) -> None:
    """E4-CORPUS-T-07: wrong report and duplicate binding controls."""
    payload = formal_corpus["payload"]
    assert {row["snapshotId"] for row in payload["acceptedSnapshots"]} == {
        row["snapshotId"] for row in payload["registrations"]
    }
    mutated = copy.deepcopy(payload)
    mutated["registrations"][0]["acceptanceReport"]["sha256"] = "0" * 64
    with pytest.raises(registry.CorpusRegistrationError, match="acceptance report"):
        _verify(mutated, formal_corpus)
    mutated = copy.deepcopy(payload)
    mutated["registrations"][0]["acceptanceReport"] = copy.deepcopy(
        mutated["registrations"][1]["acceptanceReport"]
    )
    with pytest.raises(registry.CorpusRegistrationError, match="acceptance report"):
        _verify(mutated, formal_corpus)


def test_snapshot3_accepted_despite_p14_fail(formal_corpus: dict[str, object]) -> None:
    """E4-CORPUS-T-08."""
    row = formal_corpus["payload"]["acceptedSnapshots"][2]
    registration = formal_corpus["payload"]["registrations"][2]
    assert row["accepted"] is True and row["verdict"] == "FAIL"
    assert registration["p14Observation"] == {
        "verdict": "FAIL", "classification": "EXPECTED_REAL_DATA_OBSERVATION"
    }


def test_legacy_a_binding(formal_corpus: dict[str, object]) -> None:
    """E4-CORPUS-T-09."""
    row = formal_corpus["payload"]["acceptedSnapshots"][3]
    assert row["marketContentHash"] == registry.EXPECTED_MARKET_HASHES[row["snapshotId"]]
    assert row["legacySourceSnapshotId"] == "current-dev-committed-20260726"
    assert row["replayExecutionId"] == "r01" and row["permutationVerdictChanges"] == 0
    mutated = copy.deepcopy(formal_corpus["payload"])
    mutated["acceptedSnapshots"][3]["permutationVerdictChanges"] = 2
    with pytest.raises(registry.CorpusRegistrationError, match="pre-O2"):
        _verify(mutated, formal_corpus)


def test_legacy_b_binding(formal_corpus: dict[str, object]) -> None:
    """E4-CORPUS-T-10."""
    row = formal_corpus["payload"]["acceptedSnapshots"][4]
    assert row["jaccard"] == 0.8604651162790697 and row["verdict"] == "FAIL"
    assert row["legacySourceSnapshotId"] == "historical-real-20260714-cache"
    assert row["replayExecutionId"] == "r01" and row["permutationVerdictChanges"] == 0


def test_two_party_authority_is_enforced(
    formal_corpus: dict[str, object], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """E4-CORPUS-T-11: party 1 four-way conjunction and party 2 are both required."""
    for row, registration in zip(formal_corpus["payload"]["acceptedSnapshots"],
                                 formal_corpus["payload"]["registrations"], strict=True):
        assert registration["twoParty"]["party1"]["phase"] == "ci-validation-complete"
        assert registration["twoParty"]["party2"]["criteriaCount"] == (
            52 if row["evidenceClass"] == "real_reconstructed" else 25
        )
    controls = (
        ("status", "accepted", False),
        ("status", "phase", "pending-independent-ci-validation"),
        ("status", "criteriaVersion", "wrong-version"),
        ("validation", "ciAccepted", False),
        ("acceptance", "accepted", False),
        ("offline", "accepted", False),
    )
    for index, (section, key, value) in enumerate(controls):
        environment = _make_environment(tmp_path / f"two-party-{index}", monkeypatch)
        spec = environment["evidence"][3]
        if section == "status":
            target = spec.bundle / "validation/status.json"
            document = json.loads(target.read_text(encoding="utf-8"))
            document[key] = value
        elif section == "offline":
            target = spec.offline_validation
            document = json.loads(target.read_text(encoding="utf-8"))
            document[key] = value
        else:
            target = spec.bundle / "manifest.json"
            document = json.loads(target.read_text(encoding="utf-8"))
            document[section][key] = value
        _write_json(target, document)
        with pytest.raises(registry.CorpusRegistrationError, match="TWO-PARTY"):
            registry.register(corpus_index=environment["index"], evidence=environment["evidence"],
                              corpus_root=environment["corpus_root"],
                              audit_root=environment["audit_root"])


def test_registration_is_idempotent(formal_corpus: dict[str, object]) -> None:
    """E4-CORPUS-T-12: second registration is a byte-identical no-op."""
    before = formal_corpus["index"].read_bytes()
    assert registry.register(corpus_index=formal_corpus["index"], evidence=formal_corpus["evidence"],
                             corpus_root=formal_corpus["corpus_root"],
                             audit_root=formal_corpus["audit_root"]) is False
    assert formal_corpus["index"].read_bytes() == before


def test_stale_index_is_rejected(formal_corpus: dict[str, object]) -> None:
    """E4-CORPUS-T-13: function and CLI verification are read-only."""
    payload = formal_corpus["payload"]
    assert payload["schemaVersion"] == registry.SCHEMA_VERSION
    mutated = copy.deepcopy(payload)
    mutated["distinctCount"] = 4
    with pytest.raises(registry.CorpusRegistrationError, match="stale corpus"):
        _verify(mutated, formal_corpus)
    before = formal_corpus["index"].read_bytes()
    registry.verify_index(formal_corpus["index"], corpus_root=formal_corpus["corpus_root"],
                          audit_root=formal_corpus["audit_root"])
    assert formal_corpus["index"].read_bytes() == before
    index = formal_corpus["index"]
    corpus_root = formal_corpus["corpus_root"]
    audit_root = formal_corpus["audit_root"]
    before_bytes = index.read_bytes()
    before_sha256 = _digest(before_bytes)
    before_mtime_ns = index.stat().st_mtime_ns
    before_semantic = json.loads(before_bytes)
    before_tree = _tree_state(corpus_root)
    checkout_root = Path(__file__).resolve().parents[1]
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(
        item for item in (str(checkout_root), environment.get("PYTHONPATH")) if item
    )
    completed = subprocess.run(
        [
            sys.executable,
            "data/p14_corpus_register.py",
            "--corpus-index", str(index),
            "--corpus-root", str(corpus_root),
            "--audit-root", str(audit_root),
            "--verify",
        ],
        cwd=checkout_root,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout)["verified"] is True
    after_bytes = index.read_bytes()
    assert after_bytes == before_bytes
    assert _digest(after_bytes) == before_sha256
    assert index.stat().st_mtime_ns == before_mtime_ns
    assert json.loads(after_bytes) == before_semantic
    assert _tree_state(corpus_root) == before_tree


def test_privacy_of_index_and_members(formal_corpus: dict[str, object]) -> None:
    """E4-CORPUS-T-14: privacy failure and absolute path controls."""
    payload = formal_corpus["payload"]
    assert all(item["privacy"] == {"passed": True, "violations": 0}
               for item in payload["registrations"])
    mutated = copy.deepcopy(payload)
    mutated["registrations"][0]["privacy"]["passed"] = False
    with pytest.raises(registry.CorpusRegistrationError, match="privacy"):
        _verify(mutated, formal_corpus)
    mutated = copy.deepcopy(payload)
    mutated["registrations"][0]["evidencePath"] = "/" + "Users/private/evidence"
    with pytest.raises(registry.CorpusRegistrationError, match="absolute"):
        _verify(mutated, formal_corpus)


def test_registration_is_checkout_independent(
    formal_corpus: dict[str, object], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """E4-CORPUS-T-15: no branch/current-checkout assumption affects verification."""
    monkeypatch.chdir(tmp_path)
    registry.verify_index(formal_corpus["index"], corpus_root=formal_corpus["corpus_root"],
                          audit_root=formal_corpus["audit_root"])


def test_no_machine_local_interpreter_path_in_p14_tests() -> None:
    """E4-CORPUS-T-16: semantic and split-representation recurrence guards."""
    private_tmp = "/private/" + "tmp/"
    rejected_defaults = {
        "R2": '"/' + 'tmp/p14-corpus-py311/bin/python"',
        "R3": '"/var/' + 'folders/example/T/p14-py311/bin/python3.11"',
        "R4": '"/usr/' + 'local/opt/python@3.11/bin/python3.11"',
        "R6": f'"{private_tmp}py312/bin/python3.12"',
        "R7": f'Path("{private_tmp}p14-py311/bin") / "python3.11"',
    }
    for probe_id, expression in rejected_defaults.items():
        tree = ast.parse(expression, mode="eval")
        assert _semantic_interpreter_offenders(tree), probe_id

    split_rejected = {
        "SPLIT-01": f'Path("{private_tmp}p14-py311") / "bin" / "python3.11"',
        "SPLIT-02": f'Path("{private_tmp}p14-e4-r2-i1-r1-py311") / "bin/python"',
        "SPLIT-03": f'Path("{private_tmp}p14-py311") / "bin/python3.11"',
        "SPLIT-04": f'Path("{private_tmp}") / "p14-py311" / "bin/python3.11"',
    }
    for probe_id, expression in split_rejected.items():
        tree = ast.parse(expression, mode="eval")
        assert _semantic_interpreter_offenders(tree) == [], probe_id
        assert _structural_interpreter_offenders(expression), probe_id

    legitimate_defaults = {
        "L1": "sys.executable",
        "L2": 'os.environ.get("P14_PY311", sys.executable)',
        "L3": 'shutil.which("python3.11") or sys.executable',
    }
    for probe_id, expression in legitimate_defaults.items():
        tree = ast.parse(expression, mode="eval")
        assert _semantic_interpreter_offenders(tree) == [], probe_id
        assert _structural_interpreter_offenders(expression) == [], probe_id

    semantic_offenders: list[str] = []
    structural_offenders: list[str] = []
    for path in sorted(Path(__file__).parent.glob("test_p14_*.py")):
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
        semantic_offenders.extend(
            f"{path.name}:{number}:{kind}"
            for number, kind in _semantic_interpreter_offenders(tree)
        )
        structural_offenders.extend(
            f"{path.name}:{number}:split-interpreter"
            for number in _structural_interpreter_offenders(source)
        )
    assert semantic_offenders == []
    assert structural_offenders == []


def test_append_only_is_preserved(formal_corpus: dict[str, object]) -> None:
    """E4-CORPUS-T-17."""
    assert_corpus_append_only(formal_corpus["initial"], formal_corpus["index"].read_bytes())
    original = json.loads(formal_corpus["initial"])["acceptedSnapshots"]
    assert formal_corpus["payload"]["acceptedSnapshots"][:2] == original


def test_partial_registration_leaves_index_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """E4-CORPUS-T-18: a mid-write fault cannot alter the destination."""
    environment = _make_environment(tmp_path, monkeypatch)
    index = environment["index"]
    before = index.read_bytes()
    before_semantic = json.loads(before)
    before_stat = index.stat()
    temporary_pattern = f".{index.name}.*.tmp"
    temporary_before = {path.name for path in index.parent.glob(temporary_pattern)}
    faulted_paths: list[Path] = []
    original_named_temporary_file = registry.tempfile.NamedTemporaryFile
    original_path_open = Path.open
    original_builtin_open = builtins.open

    def faulting_named_temporary_file(*args: object, **kwargs: object) -> _MidWriteFailure:
        return _MidWriteFailure(original_named_temporary_file(*args, **kwargs), faulted_paths)

    def faulting_path_open(
        path: Path, mode: str = "r", buffering: int = -1, encoding: str | None = None,
        errors: str | None = None, newline: str | None = None,
    ) -> object:
        handle = original_path_open(path, mode, buffering, encoding, errors, newline)
        if path == index and "w" in mode and "b" in mode:
            return _MidWriteFailure(handle, faulted_paths)
        return handle

    def faulting_builtin_open(file: object, mode: str = "r", *args: object, **kwargs: object) -> object:
        handle = original_builtin_open(file, mode, *args, **kwargs)
        try:
            is_destination = Path(file) == index
        except TypeError:
            is_destination = False
        if is_destination and "w" in mode and "b" in mode:
            return _MidWriteFailure(handle, faulted_paths)
        return handle

    monkeypatch.setattr(registry.tempfile, "NamedTemporaryFile", faulting_named_temporary_file)
    monkeypatch.setattr(Path, "open", faulting_path_open)
    monkeypatch.setattr(builtins, "open", faulting_builtin_open)
    with pytest.raises(OSError, match="injected mid-write failure"):
        registry.register(corpus_index=environment["index"], evidence=environment["evidence"],
                          corpus_root=environment["corpus_root"], audit_root=environment["audit_root"])
    after = index.read_bytes()
    assert faulted_paths and faulted_paths[0] != index
    assert after == before
    assert json.loads(after) == before_semantic
    assert index.stat().st_ino == before_stat.st_ino
    assert {path.name for path in index.parent.glob(temporary_pattern)} == temporary_before == set()


def test_registrar_does_not_import_e1_output_summaries() -> None:
    """E4-CORPUS-T-19."""
    source = Path(registry.__file__).read_text(encoding="utf-8")
    forbidden_name = "E1_OUTPUT" + "_SUMMARIES"
    assert forbidden_name not in source


def test_new_array_is_named_registrations(formal_corpus: dict[str, object]) -> None:
    """E4-CORPUS-T-20."""
    payload = formal_corpus["payload"]
    assert "registrations" in payload
    assert "snapshots" not in payload and "entries" not in payload
