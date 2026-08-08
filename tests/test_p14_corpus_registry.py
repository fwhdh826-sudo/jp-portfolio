"""E4-CORPUS-T-01..20: frozen formal corpus registry contract."""
from __future__ import annotations

import copy
import hashlib
import json
import re
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


def _make_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    audit_root = tmp_path / "audit"
    corpus_root = audit_root / "p14-e2-snapshots"
    corpus_root.mkdir(parents=True)
    report_names = {member_id: f"reports/{index}.md"
                    for index, member_id in enumerate(registry.EXPECTED_MEMBER_IDS, 1)}
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
    """E4-CORPUS-T-13."""
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
    """E4-CORPUS-T-16: P3-01 recurrence guard."""
    fragments = ("/private/" + "tmp/", "/" + "Users/", "/opt/" + "homebrew/")
    interpreter = re.compile(r"(?:python(?:3(?:\.11)?)?|pypy3)(?:[\"'])")
    offenders = []
    for path in sorted(Path(__file__).parent.glob("test_p14_*.py")):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if any(fragment in line for fragment in fragments) and interpreter.search(line):
                offenders.append(f"{path.name}:{number}")
    assert offenders == []


def test_append_only_is_preserved(formal_corpus: dict[str, object]) -> None:
    """E4-CORPUS-T-17."""
    assert_corpus_append_only(formal_corpus["initial"], formal_corpus["index"].read_bytes())
    original = json.loads(formal_corpus["initial"])["acceptedSnapshots"]
    assert formal_corpus["payload"]["acceptedSnapshots"][:2] == original


def test_partial_registration_leaves_index_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """E4-CORPUS-T-18."""
    environment = _make_environment(tmp_path, monkeypatch)
    before = environment["index"].read_bytes()
    def fail_before_replace(_payload: dict[str, object]) -> None:
        raise RuntimeError("injected third-append failure")
    with pytest.raises(RuntimeError, match="injected"):
        registry.register(corpus_index=environment["index"], evidence=environment["evidence"],
                          corpus_root=environment["corpus_root"], audit_root=environment["audit_root"],
                          before_replace=fail_before_replace)
    assert environment["index"].read_bytes() == before


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
