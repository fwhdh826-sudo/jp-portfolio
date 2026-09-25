"""P5-B005-B2: candidate funnel batch / join / artifact / production-distribution
quality gate のテスト。

data.candidate_funnel_batch は data/candidates_stocks.json + data/prescreen_metadata.json
を code join し、data.candidate_funnel_engine.build_candidate_funnel() （frozen、
このテストでは一切変更しない）を呼び出して data/candidate_funnel.json /
public/data/candidate_funnel.json を生成する。

このテストファイルはjoin/artifact/P-01..P-15 gateを検証する。閾値は
A2-S §22.2/§25.20 のリテラル値をテスト側にも直接書く（production定数の
import一致検査ではなく、独立した期待値として固定する）。
"""
from __future__ import annotations

import copy
import ast
import hashlib
import inspect
import json
import subprocess
import types
from datetime import datetime, timezone
from pathlib import Path

import pytest

import data.candidate_funnel_batch as batch

II_B_BASE = "1d12bcdc9a3676d56a2625483f6fbb98ce3621e3"


@pytest.fixture
def pre_ii_b():
    """Independent audited source oracle, not a second copy of II-B logic."""
    source = subprocess.check_output(
        ["git", "show", f"{II_B_BASE}:data/candidate_funnel_batch.py"], cwd=batch.REPO_ROOT,
    )
    assert hashlib.sha256(source).hexdigest() == "9e9b136912b555296bc630fcf15183072efebd560be7696ff63dbe1f47b597dd"
    module = types.ModuleType("pre_ii_b_batch")
    module.__file__ = batch.__file__
    exec(compile(source, "audited-pre-ii-b-batch", "exec"), module.__dict__)
    return module


def _ii_b_result():
    rows = []
    for index in range(60):
        rows.append({
            "code": str(1000 + index), "name": f"row {index}", "sector": f"S{index % 8}",
            "tier": "actionable" if index < 12 else "deep_review" if index < 40 else "screened",
            "marketRank": index + 1, "marketScore": 100.0 - index * 1.5,
            "rawCompositeScore": 1.0 - index / 60,
            "dataConfidence": 1.0, "dataStatus": "ok", "prescreenScore": 100 - index,
            "prescreenRank": index + 1, "prescreenPool": "main",
            "themeStatus": "unavailable", "themes": [], "selectedReasons": [],
            "riskReasons": [], "hardExclusionReasons": [],
        })
    return {
        "schemaVersion": "candidate-funnel-1", "funnelVersion": "candidate-funnel-v1",
        "scoreVersion": "market-score-v1", "not_for_trading": True, "status": "generated",
        "degradationReasons": [], "counts": {"total": 60, "screened": 60, "deepReview": 40, "actionable": 12},
        "candidates": rows, "excludedSummary": {"total": 0, "byReason": {}},
        "sectorDistribution": {"deepReview": {f"S{i}": 5 for i in range(8)}, "actionable": {f"S{i}": 1 for i in range(8)}},
        "scoreDistribution": {},
        "selectionObservability": {
            "regimeApplied": "bull_calm", "actionableHardMaxApplied": 12,
            "actionableSectorCapApplied": 2, "deepReviewHardMaxApplied": 40,
            "deepReviewSectorCapApplied": 6, "deepReviewSectorCapRelaxed": False,
            "actionableSectorCapRelaxed": False, "deepReviewSectorCapOverflow": {},
            "actionableSectorCapOverflow": {}, "deepReviewEligibleCount": 40,
            "deepReviewSelectedCount": 40, "actionableEligibleCount": 12,
            "actionableSelectedCount": 12, "sourceStale": False, "fallbackProvenance": False,
        },
    }


def _ii_b_inputs(tmp_path):
    payload = _candidates_stocks_payload([_candidate(str(1000 + i), sector=f"S{i % 8}") for i in range(60)])
    paths = {
        "candidates_stocks_path": tmp_path / "candidates.json",
        "prescreen_metadata_path": tmp_path / "prescreen.json",
        "regime_state_path": tmp_path / "regime.json",
        "previous_artifact_path": tmp_path / "previous.json",
    }
    _write_json(paths["candidates_stocks_path"], payload)
    _write_json(paths["prescreen_metadata_path"], _prescreen_payload([
        _prescreen_entry(str(1000 + i), score=100 - i, rank=i + 1) for i in range(60)
    ]))
    _write_json(paths["regime_state_path"], {"regime_state": {"current_regime": "bull_calm"}})
    return {**paths, "now": NOW}


def _ii_b_stub(monkeypatch, module, outcome="PASS"):
    base = _ii_b_result()
    perturbed = copy.deepcopy(base)
    if outcome == "WARN":
        perturbed["candidates"][0]["marketRank"] = 2
        perturbed["candidates"][1]["marketRank"] = 1
    elif outcome == "FAIL":
        perturbed["candidates"][0]["tier"] = "deep_review"
    elif outcome == "NOT_GENERATED":
        base["status"] = "not_generated"
    calls = []

    def engine(inputs, context):
        calls.append((inputs, context))
        return base if len(calls) == 1 else perturbed

    monkeypatch.setattr(module, "build_candidate_funnel", engine)
    monkeypatch.setattr(module, "compute_degraded_path_actionable", lambda *args: (0, {}))
    return base, perturbed, calls


def _ii_b_session(tmp_path, **kwargs):
    run = {
        "repository": "fwhdh826-sudo/jp-portfolio", "workflow": "full_batch.yml",
        "job": "update-data", "runId": "12345", "runAttempt": "2", "event": "schedule",
        "gitRef": "refs/heads/main", "gitRefType": "branch", "gitSha": "1" * 40,
    }
    blocks, receipts = [], []
    session = batch.P14CaptureSession(
        batch.P14CaptureConfig(tmp_path / "handoff", batch.canonical_json_bytes(run)),
        reference_sink=kwargs.get("reference_sink", blocks.append), receipt_sink=receipts.append,
    )
    return session, blocks, receipts


def _public_bytes(value):
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")


def _key_paths(value, prefix=()):
    if isinstance(value, dict):
        return {(prefix + (key,)) for key in value} | set().union(*(_key_paths(child, prefix + (key,)) for key, child in value.items()), set())
    if isinstance(value, list):
        return set().union(*(_key_paths(child, prefix + (index,)) for index, child in enumerate(value)), set())
    return set()


@pytest.mark.parametrize("outcome", ["PASS", "WARN", "FAIL", "NOT_GENERATED"])
@pytest.mark.parametrize("enabled", [False, True])
def test_ii_b_public_bytes_match_audited_base(tmp_path, monkeypatch, pre_ii_b, outcome, enabled):
    inputs = _ii_b_inputs(tmp_path)
    _ii_b_stub(monkeypatch, pre_ii_b, outcome)
    expected = pre_ii_b.run_batch(**inputs)
    base, perturbed, engine_calls = _ii_b_stub(monkeypatch, batch, outcome)
    session, blocks, receipts = _ii_b_session(tmp_path)
    actual = batch.run_batch(**inputs, **({"p14_capture": session} if enabled else {}))
    assert actual == expected
    assert _public_bytes(actual) == _public_bytes(expected)
    assert _key_paths(actual[0]) == _key_paths(expected[0])
    assert len(engine_calls) == (1 if outcome == "NOT_GENERATED" else 2)
    if enabled:
        assert len(receipts) == 1
        receipt = json.loads(receipts[0])
        assert receipt["report"] == actual[1]
        assert receipt["terminalStatus"] == {
            "PASS": "BATCH_READY", "WARN": "BATCH_READY",
            "FAIL": "QUALITY_GATE_FAILED", "NOT_GENERATED": "NOT_GENERATED",
        }[outcome]
        if outcome in {"PASS", "WARN"}:
            assert session.transport_status == "READY"
            assert blocks[-1] == "p14_transport_status=READY\n"
            parts = batch.handoff.read_handoff_parts(session.config.root, session.binding, session.producer_reference)
            assert parts.receipt_bytes == receipts[0]
            actual[0]["candidates"][0]["code"] = "changed"
            actual[0]["_meta"]["qualityGate"]["notes"].append("changed")
            assert base["candidates"][0]["code"] == "1000"
            assert actual[1]["qualityGate"]["notes"] == []
            assert json.loads(parts.observation_bytes)["base"]["candidates"][0]["code"] == "1000"
        else:
            assert session.producer_reference is None
            assert blocks == []


def test_ii_b_seam_reuses_same_objects_and_one_perturbation(tmp_path, monkeypatch):
    inputs = _ii_b_inputs(tmp_path)
    base, perturbed, calls = _ii_b_stub(monkeypatch, batch)
    session, _, _ = _ii_b_session(tmp_path)
    events = []
    perturb = batch._perturb_candidates
    construct = batch._p14_observation_bytes
    evaluate = batch.compute_p14_release_evidence

    def perturb_spy(values):
        events.append("perturb")
        return perturb(values)

    def construct_spy(binding, left, right):
        assert left is base and right is perturbed
        events.append("canonical")
        return construct(binding, left, right)

    def evaluate_spy(left, right):
        assert left is base and right is perturbed
        events.append("v1")
        return evaluate(left, right)

    monkeypatch.setattr(batch, "_perturb_candidates", perturb_spy)
    monkeypatch.setattr(batch, "_p14_observation_bytes", construct_spy)
    monkeypatch.setattr(batch, "compute_p14_release_evidence", evaluate_spy)
    batch.run_batch(**inputs, p14_capture=session)
    assert events == ["perturb", "canonical", "v1"]
    assert len(calls) == 2
    assert calls[0][0] is not calls[1][0]


@pytest.mark.parametrize("outcome", ["PASS", "WARN", "FAIL"])
@pytest.mark.parametrize("failure", ["handoff", "type", "value", "attribute", "malformed_row", "malformed_container"])
def test_ii_b_producer_failure_preserves_v1(tmp_path, monkeypatch, pre_ii_b, outcome, failure):
    inputs = _ii_b_inputs(tmp_path)
    _ii_b_stub(monkeypatch, pre_ii_b, outcome)
    expected = pre_ii_b.run_batch(**inputs)
    base, perturbed, calls = _ii_b_stub(monkeypatch, batch, outcome)
    session, blocks, receipts = _ii_b_session(tmp_path)
    builder = batch.handoff.build_observation_bytes
    perturb = batch._perturb_candidates
    evaluate = batch.compute_p14_release_evidence
    events = []

    def broken(**kwargs):
        events.append("construct")
        if failure == "malformed_row":
            kwargs["base"]["candidates"][0] = []
        elif failure == "malformed_container":
            kwargs["base"]["candidates"] = 1
        else:
            raise {"handoff": batch.handoff.HandoffError("HANDOFF_MALFORMED"), "type": TypeError(), "value": ValueError(), "attribute": AttributeError()}[failure]
        return builder(**kwargs)  # Actual II-A raw producer exceptions (NOTE-R2-01).

    def perturb_spy(values):
        events.append("perturb")
        return perturb(values)

    def evaluate_spy(left, right):
        assert left is base and right is perturbed
        events.append("v1")
        return evaluate(left, right)

    monkeypatch.setattr(batch.handoff, "build_observation_bytes", broken)
    monkeypatch.setattr(batch, "_perturb_candidates", perturb_spy)
    monkeypatch.setattr(batch, "compute_p14_release_evidence", evaluate_spy)
    actual = batch.run_batch(**inputs, p14_capture=session)
    assert events == ["perturb", "construct", "v1"]
    assert len(calls) == 2
    assert _public_bytes(actual) == _public_bytes(expected)
    assert session.transport_status == "CANONICAL_CONSTRUCTION_FAILED"
    assert session.observation_bytes is None and session.observation_digest is None
    assert session.producer_reference is None and blocks == []
    assert len(receipts) == 1
    receipt = json.loads(receipts[0])
    assert receipt["observationDigest"] is None
    assert receipt["transportStatus"] == "CANONICAL_CONSTRUCTION_FAILED"
    assert not session.config.root.exists()


def test_ii_b_disabled_tripwires(tmp_path, monkeypatch, pre_ii_b):
    inputs = _ii_b_inputs(tmp_path)
    _ii_b_stub(monkeypatch, pre_ii_b)
    expected = pre_ii_b.run_batch(**inputs)
    _ii_b_stub(monkeypatch, batch)

    def forbidden(*args, **kwargs):
        pytest.fail("disabled mode entered new ownership/transport work")

    for name in ("_p14_observation_bytes", "_p14_privacy_check", "_p14_digest_binding", "content_digest", "canonical_json_bytes"):
        monkeypatch.setattr(batch, name, forbidden)
    for name in ("claim_attempt", "build_capture_input_bytes", "build_batch_receipt_bytes", "make_producer_reference", "write_handoff_parts"):
        monkeypatch.setattr(batch.handoff, name, forbidden)
    monkeypatch.setattr(batch.copy, "deepcopy", forbidden)
    assert _public_bytes(batch.run_batch(**inputs)) == _public_bytes(expected)


def test_ii_b_schema_violations_terminal_receipt(tmp_path, monkeypatch, pre_ii_b):
    inputs = _ii_b_inputs(tmp_path)
    for module in (pre_ii_b, batch):
        _ii_b_stub(monkeypatch, module)
        monkeypatch.setattr(module, "validate_artifact_schema", lambda value: ["schemaVersion mismatch"])
    expected = pre_ii_b.run_batch(**inputs)
    session, blocks, receipts = _ii_b_session(tmp_path)
    actual = batch.run_batch(**inputs, p14_capture=session)
    assert actual == expected and actual[0] is None
    receipt = json.loads(receipts[0])
    assert receipt["terminalStatus"] == "SCHEMA_VIOLATIONS"
    assert receipt["artifactAvailable"] is False
    assert receipt["report"]["qualityGate"]["overallPass"] is True
    assert receipt["report"]["schemaViolations"] == ["schemaVersion mismatch"]
    assert session.producer_reference is None and blocks == []


@pytest.mark.parametrize("failure", ["input", "engine", "v1"])
def test_ii_b_escaping_exceptions_are_not_swallowed(tmp_path, monkeypatch, failure):
    inputs = _ii_b_inputs(tmp_path)
    _ii_b_stub(monkeypatch, batch)
    session, blocks, receipts = _ii_b_session(tmp_path)
    error = batch.CandidateFunnelBatchError("original") if failure == "input" else RuntimeError("original")

    def broken(*args, **kwargs):
        raise error

    monkeypatch.setattr(batch, {"input": "load_candidates_stocks", "engine": "build_candidate_funnel", "v1": "compute_p14_release_evidence"}[failure], broken)
    with pytest.raises(type(error)) as caught:
        batch.run_batch(**inputs, p14_capture=session)
    assert caught.value is error
    assert len(receipts) == 1
    receipt = json.loads(receipts[0])
    assert receipt["terminalStatus"] == ("BATCH_INPUT_ERROR" if failure == "input" else "BATCH_EXCEPTION")
    assert receipt["reportState"] == "UNAVAILABLE"
    assert session.producer_reference is None and blocks == []


@pytest.mark.parametrize("operation", ["capture", "receipt", "claim", "write", "reference", "sink_first", "sink_ready"])
def test_ii_b_transport_failure_is_independent_of_release(tmp_path, monkeypatch, pre_ii_b, operation):
    inputs = _ii_b_inputs(tmp_path)
    _ii_b_stub(monkeypatch, pre_ii_b)
    expected = pre_ii_b.run_batch(**inputs)
    _, _, calls = _ii_b_stub(monkeypatch, batch)
    session, blocks, receipts = _ii_b_session(tmp_path)
    perturb_calls = []
    perturb = batch._perturb_candidates

    def perturb_spy(values):
        perturb_calls.append(1)
        return perturb(values)

    def broken(*args, **kwargs):
        raise OSError("must not escape transport")

    monkeypatch.setattr(batch, "_perturb_candidates", perturb_spy)
    names = {"capture": "build_capture_input_bytes", "receipt": "build_batch_receipt_bytes", "claim": "claim_attempt", "write": "write_handoff_parts", "reference": "make_producer_reference"}
    if operation in names:
        monkeypatch.setattr(batch.handoff, names[operation], broken)
    else:
        def failing_sink(block):
            if operation == "sink_first" or "p14_transport_status=READY" in block:
                raise OSError("output unavailable")
            blocks.append(block)
        session.reference_sink = failing_sink
    actual = batch.run_batch(**inputs, p14_capture=session)
    assert _public_bytes(actual) == _public_bytes(expected)
    assert perturb_calls == [1] and len(calls) == 2
    assert session.transport_status != "READY"
    assert session.producer_reference is None
    assert not any("p14_transport_status=READY" in block for block in blocks)


def test_ii_b_raw_input_identity_uses_loaded_bytes_once(tmp_path, monkeypatch):
    inputs = _ii_b_inputs(tmp_path)
    _ii_b_stub(monkeypatch, batch)
    path = inputs["regime_state_path"]
    original = b'{\r\n"regime_state":{"current_regime":"bull_calm"}\r\n}\r\n'
    path.write_bytes(original)
    reads = []
    read = Path.read_bytes

    def read_spy(candidate):
        if candidate == path:
            reads.append(candidate)
        return read(candidate)

    monkeypatch.setattr(Path, "read_bytes", read_spy)
    session, _, _ = _ii_b_session(tmp_path)
    batch.run_batch(**inputs, p14_capture=session)
    assert reads == [path]
    raw = session.raw_files["regimeState"]
    assert raw.sha256 == hashlib.sha256(original).hexdigest()
    assert raw.bytes == len(original)
    assert session.raw_files["previousArtifact"].present is False
    assert json.loads(session.capture_input_bytes)["context"]["regime"] == "bull_calm"


def test_ii_b_source_observer_failure_does_not_change_loaders(tmp_path, monkeypatch, pre_ii_b):
    inputs = _ii_b_inputs(tmp_path)
    _ii_b_stub(monkeypatch, pre_ii_b)
    expected = pre_ii_b.run_batch(**inputs)
    _ii_b_stub(monkeypatch, batch)
    session, blocks, _ = _ii_b_session(tmp_path)
    original = batch.content_digest

    def failed_hash(payload):
        if payload == inputs["candidates_stocks_path"].read_bytes():
            raise ValueError("observer failure")
        return original(payload)

    monkeypatch.setattr(batch, "content_digest", failed_hash)
    assert _public_bytes(batch.run_batch(**inputs, p14_capture=session)) == _public_bytes(expected)
    assert session.transport_status == "INPUT_IDENTITY_UNAVAILABLE"
    assert session.producer_reference is None and blocks == []


@pytest.mark.parametrize("failure", ["snapshot", "ownership"])
def test_ii_b_optional_acquisition_failure_preserves_v1(tmp_path, monkeypatch, pre_ii_b, failure):
    inputs = _ii_b_inputs(tmp_path)
    _ii_b_stub(monkeypatch, pre_ii_b)
    expected = pre_ii_b.run_batch(**inputs)
    _, _, calls = _ii_b_stub(monkeypatch, batch)
    session, blocks, _ = _ii_b_session(tmp_path)
    if failure == "snapshot":
        read = Path.read_bytes

        def failed_read(path):
            if path == inputs["candidates_stocks_path"]:
                raise OSError("snapshot wrapper unavailable")
            return read(path)

        monkeypatch.setattr(Path, "read_bytes", failed_read)
    else:
        def failed_copy(value):
            raise TypeError("ownership construction unavailable")
        monkeypatch.setattr(batch.copy, "deepcopy", failed_copy)
    assert _public_bytes(batch.run_batch(**inputs, p14_capture=session)) == _public_bytes(expected)
    assert len(calls) == 2
    assert session.transport_status == ("INPUT_IDENTITY_UNAVAILABLE" if failure == "snapshot" else "CANONICAL_CONSTRUCTION_FAILED")
    assert session.producer_reference is None and blocks == []


def test_p14_phase_ii_batch_import_contract(pre_ii_b):
    expected_scopes = {
        "<module>": {"DATA_OUTPUT_PATH", "TOP_N_STABILITY", "_jaccard", "_perturb_candidates", "_top_n_codes_ordered"},
        "_reconstruct_batch_inputs": {
            "CANDIDATES_STOCKS_PATH", "PRESCREEN_METADATA_PATH", "REGIME_STATE_PATH",
            "build_context", "build_prescreen_index", "join_candidates_with_prescreen",
            "load_candidates_stocks", "load_prescreen_metadata", "read_current_regime",
        },
    }
    source = (batch.REPO_ROOT / "data/derived_per_calibration.py").read_text()
    tree = ast.parse(source)
    records = {}

    def imports(node, scope="<module>"):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            scope = node.name
        if isinstance(node, ast.ImportFrom) and node.module == "data.candidate_funnel_batch":
            assert all(alias.asname is None for alias in node.names)
            records[scope] = {alias.name for alias in node.names}
            namespace = {}
            exec(compile(ast.Module(body=[node], type_ignores=[]), "batch-import-probe", "exec"), namespace)
            for alias in node.names:
                assert namespace[alias.name] is getattr(batch, alias.name)
        for child in ast.iter_child_nodes(node):
            imports(child, scope)

    imports(tree)
    assert records == expected_scopes
    assert sum(map(len, records.values())) == 14
    expected_consumers = {
        "candidate_funnel_run_evidence": "CANDIDATES_STOCKS_PATH CandidateFunnelBatchError P14_ASSIGNMENT_CONTRACT P14_RELEASE_POLICY_VERSION PERTURBATION_PCT PRESCREEN_METADATA_PATH RANK_STABILITY_JACCARD_MIN REGIME_STATE_PATH TOP_N_STABILITY build_context build_prescreen_index compute_p14_release_evidence compute_quality_report compute_rank_stability join_candidates_with_prescreen load_candidates_stocks load_prescreen_metadata load_previous_artifact read_current_regime",
        "p14_evidence_capture": "CANDIDATES_STOCKS_PATH DATA_OUTPUT_PATH P14_ASSIGNMENT_CONTRACT P14_ASSIGNMENT_NOTE PERTURBATION_PCT PRESCREEN_METADATA_PATH RANK_STABILITY_JACCARD_MIN REGIME_STATE_PATH TOP_N_STABILITY _p14_canonical_sign_by_code _perturb_candidates build_context build_prescreen_index compute_quality_report join_candidates_with_prescreen load_previous_artifact read_current_regime",
        "p14_evidence_validate": "P14_ASSIGNMENT_CONTRACT P14_ASSIGNMENT_NOTE PERTURBATION_PCT RANK_STABILITY_JACCARD_MIN TOP_N_STABILITY _p14_canonical_sign_by_code",
        "p14_legacy_replay": "P14_ASSIGNMENT_CONTRACT P14_ASSIGNMENT_NOTE PERTURBATION_PCT _p14_canonical_sign_by_code _perturb_candidates",
    }
    names = set().union(*expected_scopes.values())
    for module, expected in expected_consumers.items():
        consumer_tree = ast.parse((batch.REPO_ROOT / f"data/{module}.py").read_text())
        aliases = {alias.asname or alias.name for node in ast.walk(consumer_tree) if isinstance(node, ast.ImportFrom) and node.module == "data" for alias in node.names if alias.name == "candidate_funnel_batch"}
        assert aliases == {"batch"}
        used = {node.attr for node in ast.walk(consumer_tree) if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in aliases}
        assert used == set(expected.split())
        names.update(used)
        # Bind every actual consumer call shape without executing its workflow.
        for node in ast.walk(consumer_tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id in aliases:
                assert not any(isinstance(arg, ast.Starred) for arg in node.args)
                assert not any(keyword.arg is None for keyword in node.keywords)
                inspect.signature(getattr(batch, node.func.attr)).bind(
                    *([None] * len(node.args)), **{keyword.arg: None for keyword in node.keywords},
                )
    for name in names:
        current, original = getattr(batch, name), getattr(pre_ii_b, name)
        if inspect.isfunction(original):
            before, after = inspect.signature(original), inspect.signature(current)
            for key, parameter in before.parameters.items():
                assert key in after.parameters
                assert after.parameters[key].kind == parameter.kind
                assert after.parameters[key].default == parameter.default
            for key in after.parameters.keys() - before.parameters.keys():
                assert after.parameters[key].kind == inspect.Parameter.KEYWORD_ONLY
                assert after.parameters[key].default is None
        elif not inspect.isclass(original):
            assert current == original
    for name in ("_perturb_candidates", "_p14_canonical_sign_by_code", "_jaccard", "_top_n_codes_ordered", "compute_rank_stability", "compute_p14_release_evidence"):
        old_tree = ast.parse(subprocess.check_output(["git", "show", f"{II_B_BASE}:data/candidate_funnel_batch.py"], cwd=batch.REPO_ROOT, text=True))
        old = next(node for node in old_tree.body if isinstance(node, ast.FunctionDef) and node.name == name)
        new = ast.parse(inspect.getsource(getattr(batch, name))).body[0]
        assert ast.dump(old) == ast.dump(new)
    from data import candidate_funnel_run_evidence as evidence
    assert batch.REPLAY_CANDIDATE_FIELDS == evidence.REPLAY_CANDIDATE_FIELDS


@pytest.mark.parametrize("regime", ["bull_calm", None])
def test_ii_b_derived_per_controlled_lazy_import_runtime(tmp_path, monkeypatch, regime):
    from data import derived_per_calibration as derived
    inputs = _ii_b_inputs(tmp_path)
    for name, key in (("CANDIDATES_STOCKS_PATH", "candidates_stocks_path"), ("PRESCREEN_METADATA_PATH", "prescreen_metadata_path"), ("REGIME_STATE_PATH", "regime_state_path")):
        monkeypatch.setattr(batch, name, inputs[key])
    _write_json(inputs["regime_state_path"], {"regime_state": {"current_regime": regime}})
    calls = []
    for name in ("load_candidates_stocks", "load_prescreen_metadata", "read_current_regime", "build_prescreen_index", "join_candidates_with_prescreen", "build_context"):
        original = getattr(batch, name)

        def spy(*args, _name=name, _original=original, **kwargs):
            calls.append(_name)
            return _original(*args, **kwargs)

        monkeypatch.setattr(batch, name, spy)
    monkeypatch.setattr(batch, "build_candidate_funnel", lambda *args: pytest.fail("helper must not execute engine"))
    value = derived._reconstruct_batch_inputs(NOW)
    assert calls == ["load_candidates_stocks", "load_prescreen_metadata", "read_current_regime", "build_prescreen_index", "join_candidates_with_prescreen", "build_context"]
    assert value["regime"] == regime
    assert value["source_context"]["asOf"] == NOW.isoformat()
    assert len(value["joined_candidates"]) == 60
    assert value["joined_candidates"][0]["prescreenRank"] == 1
    inputs["candidates_stocks_path"].write_text("{", encoding="utf-8")
    with pytest.raises(batch.CandidateFunnelBatchError):
        derived._reconstruct_batch_inputs(NOW)


def _ii_b_enable_environment(monkeypatch, tmp_path):
    values = {
        "P14_HANDOFF_MODE": "enabled", "P14_HANDOFF_DIR": str(tmp_path / "handoff"),
        "GITHUB_OUTPUT": str(tmp_path / "runner-output"),
        "GITHUB_REPOSITORY": "fwhdh826-sudo/jp-portfolio", "GITHUB_JOB": "update-data",
        "GITHUB_RUN_ID": "12345", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_EVENT_NAME": "schedule",
        "GITHUB_REF": "refs/heads/main", "GITHUB_REF_TYPE": "branch", "GITHUB_SHA": "1" * 40,
    }
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    return values


@pytest.mark.parametrize("mode", [None, "disabled", "invalid", " enabled", "enabled"])
def test_ii_b_main_dormant_or_invalid_config_is_v1_compatible(tmp_path, monkeypatch, pre_ii_b, capsys, mode):
    inputs = _ii_b_inputs(tmp_path)
    _ii_b_stub(monkeypatch, pre_ii_b)
    expected = pre_ii_b.run_batch(**inputs)
    published = []
    calls = []
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
    if mode is None:
        monkeypatch.delenv("P14_HANDOFF_MODE", raising=False)
    else:
        monkeypatch.setenv("P14_HANDOFF_MODE", mode)

    def run(**kwargs):
        calls.append(kwargs)
        return expected

    def forbidden(*args, **kwargs):
        pytest.fail("disabled or invalid configuration constructed a session")

    monkeypatch.setattr(batch, "P14CaptureSession", forbidden)
    monkeypatch.setattr(batch, "run_batch", run)
    monkeypatch.setattr(batch, "publish_artifact", published.append)
    assert batch.main(()) == 0
    assert calls == [{}]
    assert published == [expected[0]]
    output = capsys.readouterr()
    if mode in (None, "disabled"):
        assert output.err == ""
    else:
        assert output.err == "P14 transport: CAPTURE_CONFIGURATION_INVALID\n"
    assert not (tmp_path / "handoff").exists()


@pytest.mark.parametrize("outcome", ["PASS", "WARN", "FAIL", "NOT_GENERATED"])
def test_ii_b_main_enabled_harness_preserves_publication_gate(tmp_path, monkeypatch, pre_ii_b, capsys, outcome):
    inputs = _ii_b_inputs(tmp_path)
    _ii_b_stub(monkeypatch, pre_ii_b, outcome)
    expected = pre_ii_b.run_batch(**inputs)
    _ii_b_stub(monkeypatch, batch, outcome)
    _ii_b_enable_environment(monkeypatch, tmp_path)
    run = batch.run_batch
    sessions, published = [], []

    def controlled_run(**kwargs):
        sessions.append(kwargs["p14_capture"])
        return run(**inputs, **kwargs)

    monkeypatch.setattr(batch, "run_batch", controlled_run)
    monkeypatch.setattr(batch, "publish_artifact", published.append)
    assert batch.main(()) == (0 if expected[0] is not None else 1)
    session = sessions[0]
    assert json.loads(session.receipt_bytes)["report"] == expected[1]
    if expected[0] is not None:
        assert _public_bytes(published[0]) == _public_bytes(expected[0])
        output = (tmp_path / "runner-output").read_text()
        assert output.endswith("p14_transport_status=READY\n")
        assert output.count("p14_transport_status=") == 1
        assert len(output.splitlines()) == 11
        assert session.producer_reference.executed_git_sha != "1" * 40
        assert json.loads(session.observation_bytes)["runIdentity"]["gitSha"] == "1" * 40
    else:
        assert published == []
        assert not (tmp_path / "runner-output").exists()
    capsys.readouterr()


def test_ii_b_main_output_failure_is_transport_only(tmp_path, monkeypatch, capsys):
    inputs = _ii_b_inputs(tmp_path)
    _ii_b_stub(monkeypatch, batch)
    _ii_b_enable_environment(monkeypatch, tmp_path)
    monkeypatch.setenv("GITHUB_OUTPUT", str(tmp_path / "absent-parent" / "output"))
    run = batch.run_batch
    sessions, published = [], []

    def controlled_run(**kwargs):
        sessions.append(kwargs["p14_capture"])
        return run(**inputs, **kwargs)

    monkeypatch.setattr(batch, "run_batch", controlled_run)
    monkeypatch.setattr(batch, "publish_artifact", published.append)
    assert batch.main(()) == 0
    assert len(published) == 1
    assert sessions[0].producer_reference is None
    assert sessions[0].transport_status == "HANDOFF_WRITE_FAILED"
    assert capsys.readouterr().err == "P14 transport: HANDOFF_WRITE_FAILED\n"


def test_ii_b_main_input_failure_finalizes_and_preserves_exit(tmp_path, monkeypatch, capsys):
    inputs = _ii_b_inputs(tmp_path)
    inputs["candidates_stocks_path"].write_text("{", encoding="utf-8")
    _ii_b_enable_environment(monkeypatch, tmp_path)
    run = batch.run_batch
    sessions = []

    def controlled_run(**kwargs):
        sessions.append(kwargs["p14_capture"])
        return run(**inputs, **kwargs)

    monkeypatch.setattr(batch, "run_batch", controlled_run)
    monkeypatch.setattr(batch, "publish_artifact", lambda *args: pytest.fail("input error cannot publish"))
    assert batch.main(()) == 1
    assert json.loads(sessions[0].receipt_bytes)["terminalStatus"] == "BATCH_INPUT_ERROR"
    assert not (tmp_path / "runner-output").exists()
    assert "P14 transport: P14_NOT_EVALUATED" in capsys.readouterr().err


def test_ii_b_non_p14_gate_failure_receipt(tmp_path, monkeypatch):
    inputs = _ii_b_inputs(tmp_path)
    base, _, _ = _ii_b_stub(monkeypatch, batch)
    base["sectorDistribution"]["deepReview"] = {"S0": 40}
    session, blocks, receipts = _ii_b_session(tmp_path)
    artifact, report = batch.run_batch(**inputs, p14_capture=session)
    assert artifact is None and report["qualityGate"]["hardFailIds"] == ["P-10"]
    assert json.loads(receipts[0])["terminalStatus"] == "QUALITY_GATE_FAILED"
    assert json.loads(receipts[0])["report"] == report
    assert session.producer_reference is None and blocks == []


def test_ii_b_unverifiable_report_uses_minimal_failure_receipt(tmp_path, monkeypatch, pre_ii_b):
    inputs = _ii_b_inputs(tmp_path)
    old_base, _, _ = _ii_b_stub(monkeypatch, pre_ii_b)
    old_base["selectionObservability"]["deepReviewSectorCapOverflow"] = {"S0": 0}
    expected = pre_ii_b.run_batch(**inputs)
    base, _, _ = _ii_b_stub(monkeypatch, batch)
    base["selectionObservability"]["deepReviewSectorCapOverflow"] = {"S0": 0}
    session, blocks, receipts = _ii_b_session(tmp_path)

    def failed_observation(*args):
        raise TypeError("no observation sector authority")

    monkeypatch.setattr(batch, "_p14_observation_bytes", failed_observation)
    assert batch.run_batch(**inputs, p14_capture=session) == expected
    receipt = json.loads(receipts[0])
    assert receipt["terminalStatus"] == "BATCH_READY"
    assert receipt["reportState"] == "UNAVAILABLE" and receipt["report"] is None
    assert receipt["observationDigest"] is None
    assert receipt["transportStatus"] == "CANONICAL_CONSTRUCTION_FAILED"
    assert session.producer_reference is None and blocks == []


def test_ii_b_duplicate_attempt_cannot_emit_second_reference(tmp_path, monkeypatch):
    inputs = _ii_b_inputs(tmp_path)
    _ii_b_stub(monkeypatch, batch)
    first, _, _ = _ii_b_session(tmp_path)
    expected = batch.run_batch(**inputs, p14_capture=first)
    _ii_b_stub(monkeypatch, batch)
    second, blocks, receipts = _ii_b_session(tmp_path)
    assert batch.run_batch(**inputs, p14_capture=second) == expected
    assert second.transport_status == "HANDOFF_WRITE_FAILED"
    assert second.producer_reference is None and blocks == []
    assert json.loads(receipts[0])["transportStatus"] == "HANDOFF_WRITE_FAILED"
    assert batch.handoff.read_handoff_parts(first.config.root, first.binding, first.producer_reference).receipt_bytes == first.receipt_bytes


def test_ii_b_rank_vectors_boundary_and_bidirectional_ownership(tmp_path, monkeypatch, pre_ii_b):
    from data.p14_observation import project_rank_vector
    inputs = _ii_b_inputs(tmp_path)
    base, perturbed, _ = _ii_b_stub(monkeypatch, batch)
    session, _, receipts = _ii_b_session(tmp_path)
    artifact, report = batch.run_batch(**inputs, p14_capture=session)
    assert artifact is not None
    observation = json.loads(session.observation_bytes)
    expected_vectors = [{
        "code": str(1000 + i), "prescreenScore": 100 - i, "prescreenRank": i + 1,
        "prescreenPool": "main", "marketRank": i + 1, "marketScore": 100.0 - i * 1.5,
        "rawCompositeScore": 1.0 - i / 60,
    } for i in range(60)]
    for side in ("base", "perturbed"):
        assert project_rank_vector(observation[side]["candidates"]) == expected_vectors
        assert [row["artifactIndex"] for row in observation[side]["candidates"]] == list(range(60))
    assert batch._top_n_codes_ordered(base, 40) == [str(1000 + i) for i in range(40)]
    assert [row["code"] for row in expected_vectors[39:50]] == [str(i) for i in range(1039, 1050)]
    before = _public_bytes(artifact)
    base["candidates"][0]["name"] = "engine mutation"
    perturbed["candidates"][0]["sector"] = "perturbed mutation"
    report["qualityGate"]["notes"].append("report mutation")
    decoded_receipt = json.loads(receipts[0])
    decoded_receipt["report"]["qualityGate"]["notes"].append("receipt mutation")
    observation["base"]["candidates"][0]["code"] = "decode mutation"
    assert _public_bytes(artifact) == before
    assert json.loads(receipts[0])["report"]["qualityGate"]["notes"] == []
    assert json.loads(session.observation_bytes)["base"]["candidates"][0]["code"] == "1000"
    # Exercise the actual, unchanged public writer in temporary storage too.
    pre_ii_b.publish_artifact(artifact, tmp_path / "old-data", tmp_path / "old-public")
    batch.publish_artifact(artifact, tmp_path / "new-data", tmp_path / "new-public")
    assert (tmp_path / "old-data").read_bytes() == (tmp_path / "new-data").read_bytes() == before
    assert (tmp_path / "old-public").read_bytes() == (tmp_path / "new-public").read_bytes() == before


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

NOW = datetime(2026, 7, 26, 10, 0, 0, tzinfo=timezone.utc)


def _candidate(code, sector="SecA", per=10.0, pbr=1.0, roe=10.0, div=2.0, sigma=0.2, mom=5.0, status="ok"):
    return {
        "code": code, "name": f"n{code}", "sector": sector, "price": 1000.0,
        "per": per, "pbr": pbr, "roe": roe, "dividendYield": div,
        "sigma252d": sigma, "mom3m": mom, "dataStatus": status,
    }


def _candidates_stocks_payload(
    candidates,
    *,
    pipeline_path="normal",
    stale_threshold_hours=48,
    source_updated_at="2026-07-25T00:00:00+00:00",
    shortlist_fallback_used=False,
    include_meta_pipeline_path=True,
):
    meta = {"universeProvenance": {"shortlistFallbackUsed": shortlist_fallback_used}}
    if include_meta_pipeline_path:
        meta["pipelinePath"] = pipeline_path
    return {
        "schemaVersion": "candidates-stocks-1",
        "updatedAt": source_updated_at,
        "sourceUpdatedAt": source_updated_at,
        "staleThresholdHours": stale_threshold_hours,
        "_meta": meta,
        "candidates": candidates,
        "missing": [],
        "status": "ok",
    }


def _prescreen_entry(code, score=0.5, rank=1, pool="main"):
    return {"code": code, "prescreenScore": score, "prescreenRank": rank, "prescreenPool": pool}


def _prescreen_payload(entries, pipeline_path="normal", duplicate_codes=None):
    return {
        "schemaVersion": "prescreen-metadata-1",
        "generatedAt": "2026-07-25T00:00:00+00:00",
        "not_for_trading": True,
        "shortlistId": "jpx_cheap_prescreen_v1",
        "pipelinePath": pipeline_path,
        "duplicateCodes": duplicate_codes or [],
        "entries": entries,
    }


def _write_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _load_calibration_fixture():
    path = Path(__file__).resolve().parent / "fixtures" / "candidate_funnel_calibration_v1.json"
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def _calibration_split(*, canonical_p14_order=False):
    """B1 calibration fixtureをB2向けに分解する: candidates_stocks側
    （prescreenScore/prescreenRankを持たない生candidate）と、それを
    再現するprescreen entries。B1 fixtureは変更しない（読むだけ）。"""
    candidates = copy.deepcopy(_load_calibration_fixture()["candidates"])
    stripped = []
    entries = []
    for index, c in enumerate(candidates):
        score = c.pop("prescreenScore", None)
        rank = c.pop("prescreenRank", None)
        stripped.append(c)
        if score is not None:
            # synthetic calibration v2は旧raw-index perturbation用に作られた
            # supporting fixture。artifact/publish regressionではfixture fileを
            # 変更せず、normal producerと同じcanonical rank sequenceを与える。
            if canonical_p14_order:
                rank = index + 1
            entries.append({"code": c["code"], "prescreenScore": score, "prescreenRank": rank, "prescreenPool": None})
    return stripped, entries


# ===========================================================================
# Join tests
# ===========================================================================


def test_join_complete_all_candidates_matched():
    candidates = [_candidate("1001"), _candidate("1002"), _candidate("1003")]
    index, dup = batch.build_prescreen_index(_prescreen_payload([
        _prescreen_entry("1001", 0.9, 1), _prescreen_entry("1002", 0.5, 2), _prescreen_entry("1003", 0.1, 3),
    ]))
    assert dup == []
    joined, stats = batch.join_candidates_with_prescreen(candidates, index)
    assert stats["joinRate"] == 1.0
    assert stats["unmatchedCandidateCount"] == 0
    for c in joined:
        assert c["prescreenScore"] is not None
        assert c["prescreenRank"] is not None


def test_join_partial_some_candidates_unmatched():
    candidates = [_candidate("1001"), _candidate("1002"), _candidate("1003")]
    index, _dup = batch.build_prescreen_index(_prescreen_payload([_prescreen_entry("1001", 0.9, 1)]))
    joined, stats = batch.join_candidates_with_prescreen(candidates, index)
    assert stats["joinedCount"] == 1
    assert stats["unmatchedCandidateCount"] == 2
    joined_by_code = {c["code"]: c for c in joined}
    assert "prescreenScore" in joined_by_code["1001"]
    assert "prescreenScore" not in joined_by_code["1002"]
    assert "prescreenScore" not in joined_by_code["1003"]


def test_join_threshold_boundary_exactly_095_passes():
    candidates = [_candidate(f"{i:04d}") for i in range(200)]
    entries = [_prescreen_entry(f"{i:04d}", score=0.5, rank=i + 1) for i in range(190)]  # 190/200 = 0.95
    index, _dup = batch.build_prescreen_index(_prescreen_payload(entries))
    _joined, stats = batch.join_candidates_with_prescreen(candidates, index)
    assert stats["joinRate"] == pytest.approx(0.95)
    assert stats["joinRate"] >= 0.95


def test_join_below_threshold_fails():
    candidates = [_candidate(f"{i:04d}") for i in range(200)]
    entries = [_prescreen_entry(f"{i:04d}", score=0.5, rank=i + 1) for i in range(189)]  # 189/200 = 0.945
    index, _dup = batch.build_prescreen_index(_prescreen_payload(entries))
    _joined, stats = batch.join_candidates_with_prescreen(candidates, index)
    assert stats["joinRate"] < 0.95


def test_join_candidate_side_duplicate_code_passed_through_to_engine():
    """candidate側duplicateはjoin側でdedupeしない — 両方に等しくjoinし、
    engine（B1 frozen）へそのまま渡す。engineが自律的にHARD_CONTRACT_VIOLATION
    + DUPLICATE_CANDIDATE_CODEで除外する。"""
    candidates = [_candidate("9999"), _candidate("9999"), _candidate("1000")]
    index, _dup = batch.build_prescreen_index(_prescreen_payload([
        _prescreen_entry("9999", 0.9, 1), _prescreen_entry("1000", 0.5, 2),
    ]))
    joined, stats = batch.join_candidates_with_prescreen(candidates, index)
    assert stats["joinedCount"] == 3  # 両方の9999 + 1000
    assert joined[0]["prescreenScore"] == 0.9
    assert joined[1]["prescreenScore"] == 0.9
    result = batch.build_candidate_funnel(joined, {"pipelinePath": "normal"})
    dup_candidates = [c for c in result["candidates"] if c["code"] == "9999"]
    assert len(dup_candidates) == 2
    for c in dup_candidates:
        assert c["tier"] == "excluded"
        assert "HARD_CONTRACT_VIOLATION" in c["hardExclusionReasons"]


def test_join_prescreen_side_duplicate_excluded_from_index_and_fails_gate():
    payload = _prescreen_payload([
        _prescreen_entry("2000", 0.9, 1), _prescreen_entry("2000", 0.1, 2), _prescreen_entry("3000", 0.5, 3),
    ])
    index, dup = batch.build_prescreen_index(payload)
    assert dup == ["2000"]
    assert "2000" not in index  # 重複codeはdedupe/先勝ち/後勝ちせず一切joinしない
    assert "3000" in index

    candidates = [_candidate("2000"), _candidate("3000")]
    joined, _stats = batch.join_candidates_with_prescreen(candidates, index)
    joined_by_code = {c["code"]: c for c in joined}
    assert "prescreenScore" not in joined_by_code["2000"]
    assert joined_by_code["3000"]["prescreenScore"] == 0.5


def test_join_numeric_string_code_collision_no_coercion():
    """codeは文字列identityとして扱う。数値codeがprescreen entryに
    紛れ込んでいても、str()変換等のcoercionでcandidate側の文字列codeと
    一致させてはならない。"""
    payload = _prescreen_payload([{"code": 7777, "prescreenScore": 0.9, "prescreenRank": 1, "prescreenPool": "main"}])
    index, _dup = batch.build_prescreen_index(payload)
    assert index == {}  # int codeは文字列でないため一切indexへ入らない

    candidates = [_candidate("7777")]
    joined, stats = batch.join_candidates_with_prescreen(candidates, index)
    assert stats["joinedCount"] == 0
    assert "prescreenScore" not in joined[0]


def test_join_unmatched_candidate_gets_no_prescreen_keys():
    candidates = [_candidate("5000")]
    index = {}
    joined, stats = batch.join_candidates_with_prescreen(candidates, index)
    assert stats["unmatchedCandidateCount"] == 1
    assert "prescreenScore" not in joined[0]
    assert "prescreenRank" not in joined[0]
    assert "prescreenPool" not in joined[0]


def test_join_unmatched_prescreen_recorded_not_erroring():
    candidates = [_candidate("6000")]
    payload = _prescreen_payload([_prescreen_entry("6000", 0.9, 1), _prescreen_entry("6001", 0.5, 2)])
    index, _dup = batch.build_prescreen_index(payload)
    _joined, stats = batch.join_candidates_with_prescreen(candidates, index)
    assert stats["unmatchedPrescreenCount"] == 1


def test_join_input_order_invariance():
    candidates = [_candidate("A1"), _candidate("A2"), _candidate("A3")]
    payload = _prescreen_payload([_prescreen_entry("A1", 0.1, 3), _prescreen_entry("A2", 0.5, 2), _prescreen_entry("A3", 0.9, 1)])
    index, _dup = batch.build_prescreen_index(payload)

    joined_forward, stats_forward = batch.join_candidates_with_prescreen(candidates, index)
    joined_reversed, stats_reversed = batch.join_candidates_with_prescreen(list(reversed(candidates)), index)

    by_code_forward = {c["code"]: (c.get("prescreenScore"), c.get("prescreenRank")) for c in joined_forward}
    by_code_reversed = {c["code"]: (c.get("prescreenScore"), c.get("prescreenRank")) for c in joined_reversed}
    assert by_code_forward == by_code_reversed
    assert stats_forward["joinRate"] == stats_reversed["joinRate"]


def test_join_fallback_path_missing_prescreen_metadata_file(tmp_path):
    index, dup = batch.build_prescreen_index(None)
    assert index == {}
    assert dup == []
    candidates = [_candidate("7000")]
    joined, stats = batch.join_candidates_with_prescreen(candidates, index)
    assert stats["joinRate"] == 0.0
    assert "prescreenScore" not in joined[0]


def test_join_reproduces_b1_engine_output_for_calibration_fixture():
    """B2のjoinがB1 fixtureの直接投入と同一のengine結果を再現することを
    確認する（joinがscoreの値そのものを変えていないことのintegration test）。"""
    original_candidates = _load_calibration_fixture()["candidates"]
    stripped_candidates, prescreen_entries = _calibration_split()

    direct_result = batch.build_candidate_funnel(copy.deepcopy(original_candidates), {"pipelinePath": "normal"})

    index, dup = batch.build_prescreen_index(_prescreen_payload(prescreen_entries))
    assert dup == []
    joined, _stats = batch.join_candidates_with_prescreen(stripped_candidates, index)
    joined_result = batch.build_candidate_funnel(joined, {"pipelinePath": "normal"})

    assert direct_result == joined_result


# ===========================================================================
# Context contract
# ===========================================================================


def test_context_pipeline_path_not_coerced_to_normal_when_missing():
    payload = _candidates_stocks_payload([], include_meta_pipeline_path=False)
    ctx = batch.build_context(payload, None, NOW)
    assert ctx["pipelinePath"] is None  # "normal"へのsilent coercion禁止


def test_context_echoes_stale_threshold_and_source_updated_at():
    payload = _candidates_stocks_payload([], stale_threshold_hours=72, source_updated_at="2026-01-01T00:00:00+00:00")
    ctx = batch.build_context(payload, "bull_calm", NOW)
    assert ctx["staleThresholdHours"] == 72
    assert ctx["sourceUpdatedAt"] == "2026-01-01T00:00:00+00:00"
    assert ctx["regime"] == "bull_calm"
    assert ctx["asOf"] == NOW.isoformat()


def test_context_prescreen_fallback_used_reflects_provenance():
    payload = _candidates_stocks_payload([], shortlist_fallback_used=True)
    ctx = batch.build_context(payload, None, NOW)
    assert ctx["prescreenFallbackUsed"] is True


def test_read_current_regime_missing_file_returns_none(tmp_path):
    assert batch.read_current_regime(tmp_path / "does_not_exist.json") is None


def test_read_current_regime_unknown_value_returns_none(tmp_path):
    p = tmp_path / "regime_state.json"
    _write_json(p, {"regime_state": {"current_regime": "not_a_real_regime"}})
    assert batch.read_current_regime(p) is None


def test_read_current_regime_valid_value(tmp_path):
    p = tmp_path / "regime_state.json"
    _write_json(p, {"regime_state": {"current_regime": "bear"}})
    assert batch.read_current_regime(p) == "bear"


# ===========================================================================
# Artifact tests
# ===========================================================================

_EXPECTED_CANDIDATE_KEYS = {
    "code", "name", "sector", "prescreenScore", "prescreenRank", "prescreenPool",
    "scoreBreakdown", "rawCompositeScore", "dataConfidence", "marketScore",
    "marketRank", "tier", "selectedReasons", "riskReasons", "hardExclusionReasons",
    "themes", "themeStatus", "dataStatus",
}
_EXPECTED_ROOT_KEYS = {
    "schemaVersion", "funnelVersion", "scoreVersion", "not_for_trading", "status",
    "degradationReasons", "counts", "candidates", "excludedSummary",
    "sectorDistribution", "scoreDistribution", "selectionObservability", "_meta",
}


def _run_calibration_batch(tmp_path):
    stripped_candidates, prescreen_entries = _calibration_split(
        canonical_p14_order=True
    )
    cs_payload = _candidates_stocks_payload(stripped_candidates)
    cs_path = tmp_path / "candidates_stocks.json"
    _write_json(cs_path, cs_payload)
    prescreen_path = tmp_path / "prescreen_metadata.json"
    _write_json(prescreen_path, _prescreen_payload(prescreen_entries))
    regime_path = tmp_path / "regime_state.json"
    _write_json(regime_path, {"regime_state": {"current_regime": "bull_calm"}})
    return batch.run_batch(
        candidates_stocks_path=cs_path,
        prescreen_metadata_path=prescreen_path,
        regime_state_path=regime_path,
        previous_artifact_path=tmp_path / "candidate_funnel.json",
        now=NOW,
    )


def test_artifact_exact_root_shape(tmp_path):
    artifact, report = _run_calibration_batch(tmp_path)
    assert report["qualityGate"]["overallPass"] is True
    assert artifact is not None
    assert set(artifact.keys()) == _EXPECTED_ROOT_KEYS


def test_artifact_exact_candidate_shape(tmp_path):
    artifact, _report = _run_calibration_batch(tmp_path)
    assert len(artifact["candidates"]) > 0
    for c in artifact["candidates"]:
        assert set(c.keys()) == _EXPECTED_CANDIDATE_KEYS


def test_artifact_not_for_trading_true():
    engine_result = batch.build_candidate_funnel([], {"pipelinePath": "seed_fallback"})
    artifact = batch.build_artifact_payload(
        engine_result=engine_result, join_stats={"candidateCount": 0}, context={"asOf": NOW.isoformat()},
        quality_report={"gates": [], "overallPass": True}, now=NOW,
    )
    assert artifact["not_for_trading"] is True
    assert artifact["status"] == "not_generated"


def test_artifact_atomic_write_no_tmp_file_left(tmp_path):
    artifact, _report = _run_calibration_batch(tmp_path)
    data_path = tmp_path / "out" / "candidate_funnel.json"
    public_path = tmp_path / "public_out" / "candidate_funnel.json"
    batch.publish_artifact(artifact, data_path=data_path, public_path=public_path)
    assert data_path.exists()
    assert public_path.exists()
    assert not data_path.with_name(data_path.name + ".tmp").exists()
    assert not public_path.with_name(public_path.name + ".tmp").exists()


def test_artifact_data_public_byte_equality(tmp_path):
    artifact, _report = _run_calibration_batch(tmp_path)
    data_path = tmp_path / "out" / "candidate_funnel.json"
    public_path = tmp_path / "public_out" / "candidate_funnel.json"
    batch.publish_artifact(artifact, data_path=data_path, public_path=public_path)
    assert data_path.read_bytes() == public_path.read_bytes()


def test_publish_artifact_rolls_back_data_copy_when_public_replace_fails(tmp_path, monkeypatch):
    """2fileをペアとして扱う: public側のreplaceが失敗したら、既にreplace済みの
    data側を書き換え前の内容へrollbackし、data/publicが不整合な状態
    （一方だけ新artifact）を残さないことを確認する。"""
    from pathlib import Path

    artifact, _report = _run_calibration_batch(tmp_path)
    data_path = tmp_path / "out" / "candidate_funnel.json"
    public_path = tmp_path / "public_out" / "candidate_funnel.json"
    data_path.parent.mkdir(parents=True)
    public_path.parent.mkdir(parents=True)
    data_path.write_text('{"sentinel": "previous-good-data"}', encoding="utf-8")
    public_path.write_text('{"sentinel": "previous-good-public"}', encoding="utf-8")

    original_replace = Path.replace

    def _flaky_replace(self, target):
        if self == public_path.with_name(public_path.name + ".tmp"):
            raise OSError("simulated failure writing public copy")
        return original_replace(self, target)

    monkeypatch.setattr(Path, "replace", _flaky_replace)

    with pytest.raises(OSError):
        batch.publish_artifact(artifact, data_path=data_path, public_path=public_path)

    assert data_path.read_text(encoding="utf-8") == '{"sentinel": "previous-good-data"}'
    assert public_path.read_text(encoding="utf-8") == '{"sentinel": "previous-good-public"}'
    assert not data_path.with_name(data_path.name + ".tmp").exists()
    assert not public_path.with_name(public_path.name + ".tmp").exists()


def test_publish_artifact_first_publish_rolls_back_to_absent_on_public_failure(tmp_path, monkeypatch):
    """既存artifactが無い（初回publish）場合、public側replace失敗時は
    data側もrollbackしファイル自体が存在しない状態へ戻す（half-writtenな
    data側だけが新規出現する状態を残さない）。"""
    from pathlib import Path

    artifact, _report = _run_calibration_batch(tmp_path)
    data_path = tmp_path / "out" / "candidate_funnel.json"
    public_path = tmp_path / "public_out" / "candidate_funnel.json"

    original_replace = Path.replace

    def _flaky_replace(self, target):
        if self == public_path.with_name(public_path.name + ".tmp"):
            raise OSError("simulated failure writing public copy")
        return original_replace(self, target)

    monkeypatch.setattr(Path, "replace", _flaky_replace)

    with pytest.raises(OSError):
        batch.publish_artifact(artifact, data_path=data_path, public_path=public_path)

    assert not data_path.exists()
    assert not public_path.exists()


def test_publish_artifact_cleans_up_data_tmp_when_first_replace_fails(tmp_path, monkeypatch):
    """1件目（data側）のreplace自体が失敗した場合も、data_tmp/public_tmpの
    どちらも孤立させない。"""
    from pathlib import Path

    artifact, _report = _run_calibration_batch(tmp_path)
    data_path = tmp_path / "out" / "candidate_funnel.json"
    public_path = tmp_path / "public_out" / "candidate_funnel.json"

    original_replace = Path.replace

    def _flaky_replace(self, target):
        if self == data_path.with_name(data_path.name + ".tmp"):
            raise OSError("simulated failure writing data copy")
        return original_replace(self, target)

    monkeypatch.setattr(Path, "replace", _flaky_replace)

    with pytest.raises(OSError):
        batch.publish_artifact(artifact, data_path=data_path, public_path=public_path)

    assert not data_path.exists()
    assert not public_path.exists()
    assert not data_path.with_name(data_path.name + ".tmp").exists()
    assert not public_path.with_name(public_path.name + ".tmp").exists()


def test_publish_artifact_surfaces_both_errors_when_rollback_itself_fails(tmp_path, monkeypatch):
    """public側replace失敗 かつ rollback（data側復元）自体も失敗する
    最悪caseで、元のpublic replace failureをraise ... fromで保持したまま
    RuntimeErrorとして明示的に報告する（例外を握り潰して正常終了しない）。"""
    from pathlib import Path

    artifact, _report = _run_calibration_batch(tmp_path)
    data_path = tmp_path / "out" / "candidate_funnel.json"
    public_path = tmp_path / "public_out" / "candidate_funnel.json"
    data_path.parent.mkdir(parents=True)
    public_path.parent.mkdir(parents=True)
    data_path.write_text('{"sentinel": "previous-good-data"}', encoding="utf-8")
    public_path.write_text('{"sentinel": "previous-good-public"}', encoding="utf-8")

    original_replace = Path.replace

    def _flaky_replace(self, target):
        if self == public_path.with_name(public_path.name + ".tmp"):
            raise OSError("simulated failure writing public copy")
        return original_replace(self, target)

    def _flaky_write_bytes(self, data):
        if self == data_path:
            raise OSError("simulated failure during rollback write")
        return original_write_bytes(self, data)

    original_write_bytes = Path.write_bytes
    monkeypatch.setattr(Path, "replace", _flaky_replace)
    monkeypatch.setattr(Path, "write_bytes", _flaky_write_bytes)

    with pytest.raises(RuntimeError) as excinfo:
        batch.publish_artifact(artifact, data_path=data_path, public_path=public_path)

    assert "public replace failed" in str(excinfo.value)
    assert "rollback" in str(excinfo.value)
    assert excinfo.value.__cause__ is not None  # 元のpublic replace failureを保持
    assert not public_path.with_name(public_path.name + ".tmp").exists()


def test_artifact_deterministic_repeat(tmp_path):
    artifact1, _r1 = _run_calibration_batch(tmp_path)
    artifact2, _r2 = _run_calibration_batch(tmp_path)
    assert artifact1 == artifact2


def test_no_publish_on_gate_failure_leaves_existing_artifact_untouched(tmp_path):
    data_path = tmp_path / "candidate_funnel.json"
    public_path = tmp_path / "candidate_funnel_public.json"
    data_path.write_text('{"sentinel": true}', encoding="utf-8")
    public_path.write_text('{"sentinel": true}', encoding="utf-8")

    # join率0（prescreen不在）で必ずgate失敗するcandidates_stocks
    cs_path = tmp_path / "candidates_stocks.json"
    _write_json(cs_path, _candidates_stocks_payload([_candidate("1")]))
    artifact, report = batch.run_batch(
        candidates_stocks_path=cs_path,
        prescreen_metadata_path=tmp_path / "does_not_exist.json",
        regime_state_path=tmp_path / "does_not_exist_regime.json",
        previous_artifact_path=data_path,
        now=NOW,
    )
    assert artifact is None
    assert report["qualityGate"]["overallPass"] is False
    # 呼び出し元（main相当）はartifact is Noneのためpublish_artifactを呼ばない。
    assert data_path.read_text(encoding="utf-8") == '{"sentinel": true}'
    assert public_path.read_text(encoding="utf-8") == '{"sentinel": true}'


def test_malformed_json_candidates_stocks_raises_fail_closed(tmp_path):
    cs_path = tmp_path / "candidates_stocks.json"
    cs_path.write_text("{not valid json", encoding="utf-8")
    with pytest.raises(batch.CandidateFunnelBatchError):
        batch.load_candidates_stocks(cs_path)


def test_malformed_json_prescreen_metadata_raises_fail_closed(tmp_path):
    p = tmp_path / "prescreen_metadata.json"
    p.write_text("{not valid json", encoding="utf-8")
    with pytest.raises(batch.CandidateFunnelBatchError):
        batch.load_prescreen_metadata(p)


# ===========================================================================
# P-01..P-15 quality gate tests
# ===========================================================================


def _build_report_for(candidates_stocks_candidates, prescreen_entries, context_overrides=None, previous_artifact=None):
    cs_payload = _candidates_stocks_payload(candidates_stocks_candidates)
    index, dup = batch.build_prescreen_index(_prescreen_payload(prescreen_entries))
    joined, join_stats = batch.join_candidates_with_prescreen(candidates_stocks_candidates, index)
    context = batch.build_context(cs_payload, None, NOW)
    if context_overrides:
        context.update(context_overrides)
    engine_result = batch.build_candidate_funnel(joined, context)
    report = batch.compute_quality_report(
        candidates_stocks_payload=cs_payload,
        joined_candidates=joined,
        join_stats=join_stats,
        prescreen_duplicate_codes=dup,
        engine_result=engine_result,
        context=context,
        previous_artifact=previous_artifact,
    )
    return report, engine_result


def _gate(report, gate_id):
    return next(g for g in report["gates"] if g["id"] == gate_id)


def test_p02_join_rate_exact_boundary_pass():
    candidates = [_candidate(f"{i:04d}") for i in range(200)]
    entries = [_prescreen_entry(f"{i:04d}") for i in range(190)]
    report, _ = _build_report_for(candidates, entries)
    assert _gate(report, "P-02")["status"] == "PASS"


def test_p02_join_rate_just_below_fails():
    candidates = [_candidate(f"{i:04d}") for i in range(200)]
    entries = [_prescreen_entry(f"{i:04d}") for i in range(189)]
    report, _ = _build_report_for(candidates, entries)
    assert _gate(report, "P-02")["status"] == "FAIL"


def test_p04_no_duplicate_passes():
    candidates = [_candidate("1"), _candidate("2")]
    report, _ = _build_report_for(candidates, [])
    assert _gate(report, "P-04")["status"] == "PASS"


def test_p04_candidate_duplicate_fails():
    candidates = [_candidate("1"), _candidate("1"), _candidate("2")]
    report, _ = _build_report_for(candidates, [])
    assert _gate(report, "P-04")["status"] == "FAIL"


def test_prescreen_duplicate_gate_fails_when_prescreen_has_duplicate_code():
    candidates = [_candidate("1"), _candidate("2")]
    entries = [_prescreen_entry("1", 0.9, 1), _prescreen_entry("1", 0.1, 2)]
    report, _ = _build_report_for(candidates, entries)
    assert _gate(report, "PRESCREEN_DUPLICATE")["status"] == "FAIL"


def test_p07_iqr_and_range_pass_with_calibration_fixture(tmp_path):
    _artifact, report = _run_calibration_batch(tmp_path)
    gate = _gate(report["qualityGate"], "P-07")
    assert gate["status"] == "PASS"
    assert gate["value"]["iqr"] >= 10.0
    assert gate["value"]["range"] >= 40.0


def test_p07_degenerate_population_fails():
    # 全候補が同一のper/pbr/roe/dividendYield/sigma/mom -> marketScoreが縮退
    candidates = [_candidate(f"{i:04d}", per=10.0, pbr=1.0, roe=10.0, div=2.0, sigma=0.2, mom=5.0) for i in range(20)]
    entries = [_prescreen_entry(f"{i:04d}", score=0.5, rank=i + 1) for i in range(20)]
    report, _ = _build_report_for(candidates, entries)
    gate = _gate(report, "P-07")
    assert gate["status"] == "FAIL"


def test_p08_deep_review_zero_fails():
    # 極端に低いscoreのみ -> deep_review到達候補ゼロ
    candidates = [_candidate(f"{i:04d}", per=1000.0, pbr=100.0, roe=-90.0, div=0.0, sigma=0.6, mom=-90.0) for i in range(20)]
    entries = [_prescreen_entry(f"{i:04d}", score=0.01, rank=i + 1) for i in range(20)]
    report, _ = _build_report_for(candidates, entries)
    assert _gate(report, "P-08")["status"] == "FAIL"


def test_p08_deep_review_positive_passes_with_calibration_fixture(tmp_path):
    _artifact, report = _run_calibration_batch(tmp_path)
    assert _gate(report["qualityGate"], "P-08")["status"] == "PASS"


def test_p10_sector_breadth_fails_with_single_sector():
    candidates = [_candidate(f"{i:04d}", sector="OnlySector", per=3.0, pbr=0.3, roe=40.0, div=6.0, sigma=0.1, mom=30.0) for i in range(30)]
    entries = [_prescreen_entry(f"{i:04d}", score=0.9, rank=i + 1) for i in range(30)]
    report, _ = _build_report_for(candidates, entries)
    assert _gate(report, "P-10")["status"] == "FAIL"


def test_p10_sector_breadth_passes_with_calibration_fixture(tmp_path):
    _artifact, report = _run_calibration_batch(tmp_path)
    gate = _gate(report["qualityGate"], "P-10")
    assert gate["status"] == "PASS"
    assert gate["value"]["deepReview"] >= 7
    assert gate["value"]["actionable"] >= 4


def test_p12_inactive_v1_soft_reasons_are_zero_and_gate_passes(tmp_path):
    _artifact, report = _run_calibration_batch(tmp_path)
    gate = _gate(report["qualityGate"], "P-12")
    assert gate["status"] == "PASS"
    for code in batch.INACTIVE_V1_SOFT_REASONS:
        assert gate["value"]["soft"][code] == 0


def test_p13_degraded_path_actionable_zero_structurally_via_engine():
    """engineのfrozen仕様（pipeline_path=='normal'以外はactionable不可）
    により、degraded path（cache_fallback）ではactionable==0が構造的に
    保証される。P-13はこの不変条件を検出する。"""
    candidates = [_candidate(f"{i:04d}", per=3.0, pbr=0.3, roe=40.0, div=6.0, sigma=0.1, mom=30.0, status="ok") for i in range(20)]
    entries = [_prescreen_entry(f"{i:04d}", score=0.9, rank=i + 1) for i in range(20)]
    report, engine_result = _build_report_for(candidates, entries, context_overrides={"pipelinePath": "cache_fallback"})
    assert engine_result["counts"]["actionable"] == 0
    assert _gate(report, "P-13")["status"] == "PASS"


def test_p13_detects_violation_via_direct_gate_call():
    """compute_quality_reportのP-13ロジック自体が、万一engineがdegraded pathで
    actionable>0を返す regression を起こした場合に検出できることを、
    手組みのengine_resultで直接確認する（engine自体は変更しない）。"""
    fake_engine_result = {
        "status": "generated",
        "counts": {"deepReview": 1, "actionable": 3},
        "candidates": [],
        "sectorDistribution": {"deepReview": {"a": 1}, "actionable": {"a": 1}},
        "selectionObservability": {"sourceStale": False, "deepReviewSectorCapOverflow": {}, "actionableSectorCapOverflow": {}, "deepReviewEligibleCount": 1, "deepReviewSelectedCount": 1, "actionableEligibleCount": 3, "actionableSelectedCount": 3},
        "degradationReasons": [],
    }
    report = batch.compute_quality_report(
        candidates_stocks_payload={"candidates": []},
        joined_candidates=[],
        join_stats={"candidateCount": 0, "joinedCount": 0, "unmatchedCandidateCount": 0, "unmatchedPrescreenCount": 0, "joinRate": 0.0, "unmatchedCandidateRate": 0.0},
        prescreen_duplicate_codes=[],
        engine_result=fake_engine_result,
        context={"pipelinePath": "cache_fallback", "prescreenFallbackUsed": False},
        previous_artifact=None,
    )
    assert _gate(report, "P-13")["status"] == "FAIL"


def test_p14_rank_stability_top40_jaccard_is_perfect_with_calibration_fixture(tmp_path):
    """calibration fixtureのtop-40 Jaccardは±2% perturbationに対して完全
    (1.0)で安定している（gate["value"]はP-14 gateの主表示値として引き続き
    jaccardのfloatを保持する — decision-aware化でこの契約は変更しない）。"""
    artifact, report = _run_calibration_batch(tmp_path)
    gate = _gate(report["qualityGate"], "P-14")
    assert gate["value"] >= 0.95
    assert artifact is not None
    assert report["qualityGate"]["overallPass"] is True


def test_p14_d2_calibration_fixture_reports_decision_aware_deep_review_warn(tmp_path):
    """P14_D2: calibration fixtureは±2% perturbationの下でdeep-review tier
    から1件exitする(A250) — 旧binary policyは jaccard(=1.0)しか見なかった
    ためこの churn を可視化できなかった。新policyはこれをWARNとして
    非blockingに表面化する(exit>=1はHARD閾値を持たない — INSUFFICIENT_
    EVIDENCE_FOR_NUMERIC_FREEZE)。actionableは1件exit(閾値2未満)、
    P14_MARKET_REFERENCE_SHORTLISTはbase/perturbedで完全に不変
    (membership/tier/order変化なし) — WARNの原因はdeep-review churnのみ。"""
    artifact, report = _run_calibration_batch(tmp_path)
    gate = _gate(report["qualityGate"], "P-14")
    assert gate["status"] == "WARN"
    assert "P-14" not in report["qualityGate"]["hardFailIds"]
    assert report["qualityGate"]["overallPass"] is True
    assert artifact is not None

    evidence = report["qualityGate"]["p14ReleaseEvidence"]
    assert evidence["policyVersion"] == "p14-decision-aware-v1"
    assert evidence["top40"]["jaccard"] == 1.0
    assert evidence["final"]["status"] == "WARN"
    assert evidence["final"]["hardReasons"] == []
    assert evidence["final"]["warnReasons"] == ["DEEP_REVIEW_EXIT_WARN"]
    assert evidence["deepReview"]["exitCount"] == 1
    assert evidence["actionable"]["exitCount"] < batch.ACTIONABLE_PERTURBATION_EXIT_WARN_MIN
    shortlist = evidence["marketReferenceShortlist"]
    assert shortlist["membershipChanged"] is False
    assert shortlist["tierChanged"] is False
    assert shortlist["orderChanged"] is False
    assert shortlist["base"] == shortlist["perturbed"]

    artifact_gate = _gate(artifact["_meta"]["qualityGate"], "P-14")
    assert artifact_gate["status"] == "WARN"


def test_p15_no_baseline_records_none(tmp_path):
    _artifact, report = _run_calibration_batch(tmp_path)
    gate = _gate(report["qualityGate"], "P-15")
    assert gate["status"] == "RECORD"
    assert gate["value"] is None


def test_p15_rank_drift_vs_previous_recorded(tmp_path):
    stripped_candidates, prescreen_entries = _calibration_split(
        canonical_p14_order=True
    )
    cs_payload = _candidates_stocks_payload(stripped_candidates)
    cs_path = tmp_path / "candidates_stocks.json"
    _write_json(cs_path, cs_payload)
    prescreen_path = tmp_path / "prescreen_metadata.json"
    _write_json(prescreen_path, _prescreen_payload(prescreen_entries))
    regime_path = tmp_path / "regime_state.json"
    _write_json(regime_path, {"regime_state": {"current_regime": "bull_calm"}})
    previous_path = tmp_path / "candidate_funnel.json"

    artifact1, _report1 = batch.run_batch(
        candidates_stocks_path=cs_path, prescreen_metadata_path=prescreen_path,
        regime_state_path=regime_path, previous_artifact_path=previous_path, now=NOW,
    )
    assert artifact1 is not None
    previous_path.write_text(json.dumps(artifact1), encoding="utf-8")

    artifact2, report2 = batch.run_batch(
        candidates_stocks_path=cs_path, prescreen_metadata_path=prescreen_path,
        regime_state_path=regime_path, previous_artifact_path=previous_path, now=NOW,
    )
    # engineの決定的計算結果（candidates/counts等）は前回artifactの有無に
    # 依存せず同一。_meta.qualityGate.gates（P-15）だけがbaseline有無で変わる。
    assert artifact2["candidates"] == artifact1["candidates"]
    assert artifact2["counts"] == artifact1["counts"]
    gate = _gate(report2["qualityGate"], "P-15")
    assert gate["value"] == 1.0  # 同一artifact同士なのでdrift無し


def test_not_generated_status_skips_p02_through_p15_and_does_not_publish():
    """not_generated（seed_fallback等）はP-02以降N/Aだが、overallPass=False
    としpublishしない（既存の正常なartifactを空のnot_generatedで上書きしない
    — data/build_candidates_stocks.pyのstale-fallback guardと同じ規律）。"""
    candidates = [_candidate("1")]
    cs_payload = _candidates_stocks_payload(candidates, pipeline_path="seed_fallback")
    index, dup = batch.build_prescreen_index(None)
    joined, join_stats = batch.join_candidates_with_prescreen(candidates, index)
    context = batch.build_context(cs_payload, None, NOW)
    engine_result = batch.build_candidate_funnel(joined, context)
    assert engine_result["status"] == "not_generated"
    report = batch.compute_quality_report(
        candidates_stocks_payload=cs_payload, joined_candidates=joined, join_stats=join_stats,
        prescreen_duplicate_codes=dup, engine_result=engine_result, context=context, previous_artifact=None,
    )
    assert report["overallPass"] is False
    for gate_id in ["P-02", "P-07", "P-10", "P-14"]:
        assert _gate(report, gate_id)["status"] == "N/A"


def test_not_generated_run_batch_does_not_publish_and_preserves_existing_artifact(tmp_path):
    data_path = tmp_path / "candidate_funnel.json"
    public_path = tmp_path / "candidate_funnel_public.json"
    data_path.write_text('{"sentinel": "previous-good-artifact"}', encoding="utf-8")
    public_path.write_text('{"sentinel": "previous-good-artifact"}', encoding="utf-8")

    cs_path = tmp_path / "candidates_stocks.json"
    _write_json(cs_path, _candidates_stocks_payload([_candidate("1")], pipeline_path="seed_fallback"))

    artifact, report = batch.run_batch(
        candidates_stocks_path=cs_path,
        prescreen_metadata_path=tmp_path / "does_not_exist.json",
        regime_state_path=tmp_path / "does_not_exist_regime.json",
        previous_artifact_path=data_path,
        now=NOW,
    )
    assert artifact is None
    assert report["qualityGate"]["overallPass"] is False
    assert data_path.read_text(encoding="utf-8") == '{"sentinel": "previous-good-artifact"}'
    assert public_path.read_text(encoding="utf-8") == '{"sentinel": "previous-good-artifact"}'


# ===========================================================================
# P14-O1 frozen order-invariant assignment contract
# ===========================================================================


def test_o1_p14_primary_order_is_valid_prescreen_rank_ascending():
    candidates = [
        {**_candidate("C"), "prescreenRank": 3},
        {**_candidate("B"), "prescreenRank": 1},
        {**_candidate("A"), "prescreenRank": 2},
        {**_candidate("D"), "prescreenRank": 4},
    ]
    perturbed = batch._perturb_candidates(candidates)
    by_code = {candidate["code"]: candidate for candidate in perturbed}
    assert by_code["B"]["per"] == pytest.approx(10.0 * 1.02)
    assert by_code["A"]["per"] == pytest.approx(10.0 * 0.98)
    assert by_code["C"]["per"] == pytest.approx(10.0 * 1.02)
    assert by_code["D"]["per"] == pytest.approx(10.0 * 0.98)


def test_o1_p14_secondary_tie_break_is_exact_code_ascending():
    candidates = [
        {**_candidate("B"), "prescreenRank": 7},
        {**_candidate("A"), "prescreenRank": 7},
    ]
    perturbed = batch._perturb_candidates(candidates)
    by_code = {candidate["code"]: candidate for candidate in perturbed}
    assert by_code["A"]["per"] == pytest.approx(10.0 * 1.02)
    assert by_code["A"]["roe"] == pytest.approx(10.0 * 0.98)
    assert by_code["B"]["per"] == pytest.approx(10.0 * 0.98)
    assert by_code["B"]["roe"] == pytest.approx(10.0 * 1.02)


def test_o1_p14_missing_prescreen_rank_sorts_last_by_code():
    candidates = [
        {**_candidate("z")},
        {**_candidate("b"), "prescreenRank": 0},
        {**_candidate("V"), "prescreenRank": 5},
        {**_candidate("a"), "prescreenRank": True},
        {**_candidate("c"), "prescreenRank": -1},
    ]
    perturbed = batch._perturb_candidates(candidates)
    by_code = {candidate["code"]: candidate for candidate in perturbed}
    # canonical order: V(valid), a(bool), b(zero), c(negative), z(missing)
    assert by_code["V"]["per"] == pytest.approx(10.0 * 1.02)
    assert by_code["a"]["per"] == pytest.approx(10.0 * 0.98)
    assert by_code["b"]["per"] == pytest.approx(10.0 * 1.02)
    assert by_code["c"]["per"] == pytest.approx(10.0 * 0.98)
    assert by_code["z"]["per"] == pytest.approx(10.0 * 1.02)


def test_o1_p14_duplicate_code_gets_no_sign_consumes_no_ordinal_and_p04_fails():
    candidates = [
        {**_candidate("D"), "prescreenRank": 1},
        {**_candidate("E"), "prescreenRank": 2},
        {**_candidate("D"), "prescreenRank": 3},
        {**_candidate("E"), "prescreenRank": 4},
        {**_candidate("A"), "prescreenRank": 5},
        {**_candidate("B"), "prescreenRank": 6},
    ]
    perturbed = batch._perturb_candidates(candidates)
    assert [candidate["per"] for candidate in perturbed[:4]] == [10.0] * 4
    assert perturbed[4]["per"] == pytest.approx(10.0 * 1.02)
    assert perturbed[5]["per"] == pytest.approx(10.0 * 0.98)
    assert batch._p14_canonical_sign_by_code(candidates) == {"A": 1, "B": -1}

    entries = [
        _prescreen_entry(candidate["code"], rank=index + 1)
        for index, candidate in enumerate(candidates)
    ]
    report, _result = _build_report_for(candidates, entries)
    assert _gate(report, "P-04")["status"] == "FAIL"
    assert "P-04" in report["hardFailIds"]


def test_o1_p14_missing_or_invalid_identity_gets_no_sign_and_fails_closed():
    missing = _candidate("placeholder")
    missing.pop("code")
    candidates = [
        "malformed-record",
        missing,
        _candidate(""),
        _candidate(None),
        _candidate(1001),
        {**_candidate("A"), "prescreenRank": 1},
        {**_candidate("B"), "prescreenRank": 2},
    ]
    perturbed = batch._perturb_candidates(candidates)
    assert perturbed[:5] == candidates[:5]
    assert perturbed[5]["per"] == pytest.approx(10.0 * 1.02)
    assert perturbed[6]["per"] == pytest.approx(10.0 * 0.98)
    assert batch._p14_canonical_sign_by_code(candidates) == {"A": 1, "B": -1}

    engine_result = batch.build_candidate_funnel(candidates, {"pipelinePath": "normal"})
    assert all(
        "HARD_CONTRACT_VIOLATION" in candidate["hardExclusionReasons"]
        for candidate in engine_result["candidates"][:5]
    )
    artifact = batch.build_artifact_payload(
        engine_result=engine_result,
        join_stats={"candidateCount": len(candidates)},
        context={"asOf": NOW.isoformat()},
        quality_report={"gates": [], "overallPass": True, "hardFailIds": []},
        now=NOW,
    )
    assert any(
        "invalid exact-string code" in violation
        for violation in batch.validate_artifact_schema(artifact)
    )


def test_o1_p14_numeric_code_is_not_coerced():
    candidates = [
        {**_candidate(1001), "prescreenRank": 1},
        {**_candidate("1001"), "prescreenRank": 2},
    ]
    perturbed = batch._perturb_candidates(candidates)
    assert perturbed[0]["per"] == 10.0
    assert perturbed[1]["per"] == pytest.approx(10.0 * 1.02)
    assert batch._p14_canonical_sign_by_code(candidates) == {"1001": 1}


def test_o1_p14_input_is_not_mutated():
    candidates = [
        {**_candidate("B"), "prescreenRank": 2},
        {**_candidate("A"), "prescreenRank": 1},
    ]
    before = copy.deepcopy(candidates)
    perturbed = batch._perturb_candidates(candidates)
    assert candidates == before
    assert perturbed is not candidates
    assert all(output is not source for output, source in zip(perturbed, candidates))
    assert [candidate["code"] for candidate in perturbed] == ["B", "A"]


def test_o1_p14_per_roe_simultaneous_vector_and_two_percent_are_exact():
    candidates = [
        {**_candidate("A", per=25.0, roe=12.5), "prescreenRank": 1},
        {**_candidate("B", per=25.0, roe=12.5), "prescreenRank": 2},
    ]
    perturbed = batch._perturb_candidates(candidates)
    assert perturbed[0]["per"] == 25.0 * 1.02
    assert perturbed[0]["roe"] == 12.5 * 0.98
    assert perturbed[1]["per"] == 25.0 * 0.98
    assert perturbed[1]["roe"] == 12.5 * 1.02
    assert batch.PERTURBATION_PCT == 0.02


def test_o1_p14_frozen_metric_constants_are_unchanged():
    """OPS_P14_D2_RELEASE_METRIC_IMPLEMENTATION_R2: metric自体（jaccard
    threshold値・top-K・perturbation率）は一切変更しない。D2が変更するのは
    severity mapping（PASS/FAIL binary → PASS/WARN/FAIL decision-aware）
    だけである。"""
    assert batch.RANK_STABILITY_JACCARD_MIN == 0.95
    assert batch.RANK_STABILITY_JACCARD_WARN_MIN == 0.95
    assert batch.RANK_STABILITY_JACCARD_HARD_MIN == 0.80
    assert batch.TOP_N_STABILITY == 40
    assert batch.PERTURBATION_PCT == 0.02


def test_p14_d2_hard_backstop_still_blocks_publish(tmp_path, monkeypatch):
    """P14_D2: compute_p14_release_evidence()がFAILを返せば、P-14は引き続き
    hardFailIdsへ入りoverallPass=False・publishされない
    （decision-aware gate導入後もfail-closed配線は維持される）。gate配線
    のみを検証する単体テストであり、compute_p14_release_evidence自体の
    判定ロジックはtest_p14_d2_*の純粋関数テストで独立に検証する。"""
    monkeypatch.setattr(
        batch,
        "compute_p14_release_evidence",
        lambda engine_result, perturbed_result: {
            "policyVersion": batch.P14_RELEASE_POLICY_VERSION,
            "final": {
                "status": "FAIL",
                "hardReasons": ["TOP40_JACCARD_BELOW_HARD_MIN"],
                "warnReasons": [],
            },
        },
    )
    artifact, report = _run_calibration_batch(tmp_path)
    gate = _gate(report["qualityGate"], "P-14")
    assert artifact is None
    assert gate["status"] == "FAIL"
    assert "P-14" in report["qualityGate"]["hardFailIds"]
    assert report["qualityGate"]["overallPass"] is False


def test_p14_d2_warn_status_does_not_block_publish(tmp_path, monkeypatch):
    """P14_D2 regression fix: 旧policyでは jaccard=0.94 (<0.95) が単独で
    publishをblockしていた。新policyでは0.94はWARN帯（HARD backstop 0.80
    未満ではない）なのでoverallPass/publishをblockしてはならない。"""
    monkeypatch.setattr(
        batch,
        "compute_p14_release_evidence",
        lambda engine_result, perturbed_result: {
            "policyVersion": batch.P14_RELEASE_POLICY_VERSION,
            "final": {
                "status": "WARN",
                "hardReasons": [],
                "warnReasons": ["TOP40_JACCARD_BELOW_WARN_MIN"],
            },
        },
    )
    artifact, report = _run_calibration_batch(tmp_path)
    gate = _gate(report["qualityGate"], "P-14")
    assert artifact is not None
    assert gate["status"] == "WARN"
    assert "P-14" not in report["qualityGate"]["hardFailIds"]
    assert report["qualityGate"]["overallPass"] is True


def test_o1_p14_metadata_declares_exact_assignment_contract(tmp_path):
    artifact, report = _run_calibration_batch(tmp_path)
    assert artifact is not None
    gate = _gate(report["qualityGate"], "P-14")
    assert batch.P14_ASSIGNMENT_CONTRACT == "p14-prescreen-rank-code-v1"
    assert gate["note"] == (
        "assignment=p14-prescreen-rank-code-v1; identity=exact-string-code; "
        "invalid-or-duplicate-identities-do-not-consume-ordinal"
    )
    artifact_gate = _gate(artifact["_meta"]["qualityGate"], "P-14")
    assert artifact_gate["note"] == gate["note"]


def test_o1_p01_through_p13_and_p15_outputs_are_unchanged():
    candidates, entries = _calibration_split(canonical_p14_order=True)
    forward_report, _forward_engine = _build_report_for(candidates, entries)
    reversed_report, _reversed_engine = _build_report_for(
        list(reversed(candidates)), entries
    )
    unchanged_ids = {
        *(f"P-{number:02d}" for number in range(1, 14)),
        "P-15",
    }
    forward = {
        gate["id"]: gate for gate in forward_report["gates"] if gate["id"] in unchanged_ids
    }
    reversed_gates = {
        gate["id"]: gate
        for gate in reversed_report["gates"]
        if gate["id"] in unchanged_ids
    }
    assert forward.keys() == unchanged_ids
    assert reversed_gates == forward


def test_o1_synthetic_fixture_is_separate_supporting_evidence_only():
    real_fixture_path = (
        Path(__file__).resolve().parent
        / "fixtures"
        / "candidate_funnel_order_invariance_real_v1.json"
    )
    real_fixture = json.loads(real_fixture_path.read_text(encoding="utf-8"))
    synthetic_fixture = _load_calibration_fixture()
    assert real_fixture["evidenceClass"] == "real_byte_exact_e1"
    assert real_fixture["sourceEvidenceArchiveSha256"] == (
        "35f55858a9dd243371de9aa4575e3816ebefbdf0526d9500213961ff74be252e"
    )
    assert len(real_fixture["snapshots"]) == 2
    assert all(snapshot["synthetic"] is False for snapshot in real_fixture["snapshots"])
    assert synthetic_fixture["fixtureVersion"] == "candidate-funnel-calibration-v2"
    assert "sourceEvidenceArchiveSha256" not in synthetic_fixture
    assert "snapshots" not in synthetic_fixture


# ===========================================================================
# OPS_P14_D2_RELEASE_METRIC_IMPLEMENTATION_R2: decision-aware P-14 release
# gate（P14_RELEASE_POLICY_VERSION="p14-decision-aware-v1"）。
#
# これらは engine（B1, frozen）を一切呼び出さない純粋関数テストである
# — compute_p14_release_evidence / build_market_reference_shortlist /
# evaluate_market_reference_shortlist は engine_result 形状の read-only
# dictだけを消費するため、最小限の合成candidate listで境界値を厳密に
# 制御できる。P14_BOUNDARY=MARKET_FUNNEL_PERTURBATION_ROBUSTNESS:
# holdings/cash/allocation/officialDecisionは一切参照しない。
# ===========================================================================


def _p14d2_population(codes, tier="screened", rank_offset=1):
    """rank_offset起点の連番marketRankを割り当てたcandidate listを返す
    （P14_D2純粋テスト専用fixture。compute_p14_release_evidence が読む
    code/tier/marketRankのみを持つ最小限のengine_result形状）。"""
    return [
        {"code": code, "tier": tier, "marketRank": rank_offset + index}
        for index, code in enumerate(codes)
    ]


def _p14d2_result(candidates):
    return {"candidates": candidates}


def _p14d2_jaccard_case(swap, population=40):
    """base=population件（B1..Bn, tier=screened, rank 1..n）に対し、
    末尾swap件をX1..Xswapへ置換したperturbedを返す。
    intersection=population-swap, union=population+swap
    （jaccard=(population-swap)/(population+swap)）となる、
    §6.1のswap/jaccard例と一致する構成。"""
    base_codes = [f"B{i:02d}" for i in range(1, population + 1)]
    perturbed_codes = base_codes[: population - swap] + [f"X{i}" for i in range(1, swap + 1)]
    base = _p14d2_result(_p14d2_population(base_codes))
    perturbed = _p14d2_result(_p14d2_population(perturbed_codes))
    return base, perturbed


# ---------------------------------------------------------------------------
# A. Top-40 Jaccard
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "swap,expected_jaccard,expected_status",
    [
        (0, 1.0, "PASS"),
        (1, 39 / 41, "PASS"),
        (2, 38 / 42, "WARN"),
        (4, 36 / 44, "WARN"),
        (5, 35 / 45, "FAIL"),
    ],
)
def test_p14_d2_jaccard_swap_matrix(swap, expected_jaccard, expected_status):
    base, perturbed = _p14d2_jaccard_case(swap)
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence["top40"]["jaccard"] == pytest.approx(expected_jaccard)
    assert evidence["top40"]["swapCount"] == swap
    assert evidence["top40"]["intersection"] == sorted(f"B{i:02d}" for i in range(1, 40 - swap + 1))
    assert len(evidence["top40"]["intersection"]) == 40 - swap
    assert len(evidence["top40"]["union"]) == 40 + swap
    assert evidence["final"]["status"] == expected_status


def test_p14_d2_jaccard_exact_warn_boundary_is_pass():
    """jaccard==0.95ちょうどはWARN側ではなくPASS側（strict '<' — WARNは
    jaccard < 0.95のときのみ発火する）。"""
    base = _p14d2_result(_p14d2_population([f"B{i:02d}" for i in range(1, 20)]))  # 19 codes, rank 1..19
    perturbed = _p14d2_result(
        _p14d2_population([f"B{i:02d}" for i in range(1, 20)] + ["X1"])
    )  # same 19 + 1 new -> intersection=19, union=20
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence["top40"]["jaccard"] == pytest.approx(0.95)
    assert evidence["final"]["status"] == "PASS"
    assert evidence["final"]["hardReasons"] == []
    assert evidence["final"]["warnReasons"] == []


def test_p14_d2_jaccard_exact_hard_boundary_is_warn_not_fail():
    """jaccard==0.80ちょうどはHARD側ではなくWARN側（strict '<' — HARDは
    jaccard < 0.80のときのみ発火する）。"""
    base_codes = [f"B{i:02d}" for i in range(1, 17)] + ["A1", "A2"]  # 16 shared + 2 base-only
    perturbed_codes = [f"B{i:02d}" for i in range(1, 17)] + ["C1", "C2"]  # 16 shared + 2 perturbed-only
    base = _p14d2_result(_p14d2_population(base_codes))
    perturbed = _p14d2_result(_p14d2_population(perturbed_codes))
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence["top40"]["jaccard"] == pytest.approx(0.80)
    assert evidence["final"]["status"] == "WARN"
    assert evidence["final"]["hardReasons"] == []
    assert "TOP40_JACCARD_BELOW_WARN_MIN" in evidence["final"]["warnReasons"]


def test_p14_d2_jaccard_below_hard_min_is_fail():
    base_codes = [f"B{i:02d}" for i in range(1, 11)]  # 10 codes
    perturbed_codes = ["X1", "X2", "X3", "X4", "X5", "X6"]  # fully disjoint
    base = _p14d2_result(_p14d2_population(base_codes))
    perturbed = _p14d2_result(_p14d2_population(perturbed_codes))
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence["top40"]["jaccard"] == 0.0
    assert evidence["final"]["status"] == "FAIL"
    assert "TOP40_JACCARD_BELOW_HARD_MIN" in evidence["final"]["hardReasons"]


def test_p14_d2_top40_retention_is_record_only_not_a_duplicate_hard_gate():
    """§6.2: retentionはRECORD_ONLY。jaccardと重複するhard gateにしない
    （final.hardReasons/warnReasonsにretention由来のentryが無いこと）。"""
    base, perturbed = _p14d2_jaccard_case(swap=2)
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence["top40"]["retention"] == pytest.approx(38 / 40)
    assert all("RETENTION" not in reason for reason in evidence["final"]["hardReasons"])
    assert all("RETENTION" not in reason for reason in evidence["final"]["warnReasons"])


# ---------------------------------------------------------------------------
# B. Deep-review churn
# ---------------------------------------------------------------------------


def _p14d2_churn_population(deep_review_codes=(), actionable_codes=(), screened_codes=()):
    candidates = []
    rank = 1
    for code in deep_review_codes:
        candidates.append({"code": code, "tier": "deep_review", "marketRank": rank})
        rank += 1
    for code in actionable_codes:
        candidates.append({"code": code, "tier": "actionable", "marketRank": rank})
        rank += 1
    for code in screened_codes:
        candidates.append({"code": code, "tier": "screened", "marketRank": rank})
        rank += 1
    return _p14d2_result(candidates)


_P14D2_NEUTRAL_JACCARD_FILLERS = [
    {"code": f"NEUTRAL{i:02d}", "tier": "screened", "marketRank": i} for i in range(1, 41)
]  # 40件、rank 1..40固定・base/perturbed不変 -> top-40 Jaccardを常に1.0で飽和させる

_P14D2_SHORTLIST_STABLE_FILLERS = [
    {"code": f"FILLER{i}", "tier": "actionable", "marketRank": 1000 + i} for i in range(1, 4)
]  # 3件、rank 1000-1002固定・base/perturbed不変 -> reference shortlist top-3を常に飽和させる


def _p14d2_isolated_churn_population(deep_review_codes=(), actionable_codes=(), screened_codes=()):
    """§19.B/Cの churn-only テスト専用。以下2種のfillerで
    top40 Jaccard と P14_MARKET_REFERENCE_SHORTLIST(N=3) の両方を飽和させ、
    churn対象のcode（rank>=1100、top-40窓の外・shortlist上位3件の外）が
    それらを意図せず汚染しないよう分離する:
      * 40件の不変screened filler（rank 1-40）が top-40 windowを常に
        埋め、churn対象codeの出入りがtop40 Jaccardへ一切影響しない。
      * 3件の不変actionable filler（rank 1000-1002）が
        P14_MARKET_REFERENCE_SHORTLIST top-3を常に占有し、churn対象code
        の出入りがshortlist membership/tier/orderへ一切影響しない。"""
    candidates = list(_P14D2_NEUTRAL_JACCARD_FILLERS) + list(_P14D2_SHORTLIST_STABLE_FILLERS)
    rank = 1100
    for code in deep_review_codes:
        candidates.append({"code": code, "tier": "deep_review", "marketRank": rank})
        rank += 1
    for code in actionable_codes:
        candidates.append({"code": code, "tier": "actionable", "marketRank": rank})
        rank += 1
    for code in screened_codes:
        candidates.append({"code": code, "tier": "screened", "marketRank": rank})
        rank += 1
    return _p14d2_result(candidates)


def test_p14_d2_deep_review_zero_exit_no_warn():
    base = _p14d2_churn_population(deep_review_codes=["D1", "D2"])
    perturbed = _p14d2_churn_population(deep_review_codes=["D1", "D2"])
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence["deepReview"]["exitCount"] == 0
    assert evidence["deepReview"]["exited"] == []
    assert "DEEP_REVIEW_EXIT_WARN" not in evidence["final"]["warnReasons"]
    assert evidence["final"]["status"] == "PASS"


def test_p14_d2_deep_review_one_exit_is_warn():
    base = _p14d2_isolated_churn_population(deep_review_codes=["D1", "D2"])
    perturbed = _p14d2_isolated_churn_population(deep_review_codes=["D1"])  # D2 exited
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence["deepReview"]["exitCount"] == 1
    assert evidence["deepReview"]["exited"] == ["D2"]
    assert evidence["marketReferenceShortlist"]["membershipChanged"] is False
    assert evidence["final"]["status"] == "WARN"
    assert "DEEP_REVIEW_EXIT_WARN" in evidence["final"]["warnReasons"]
    assert evidence["final"]["hardReasons"] == []


def test_p14_d2_deep_review_multiple_exits_stay_warn_no_invented_hard_threshold():
    """A2-S/D2 freeze: INSUFFICIENT_EVIDENCE_FOR_NUMERIC_FREEZE — deep-review
    churnにHARD閾値は存在しない。exit>=1は件数によらず常にWARNのみ。"""
    base = _p14d2_isolated_churn_population(deep_review_codes=["D1", "D2", "D3", "D4", "D5"])
    perturbed = _p14d2_isolated_churn_population(deep_review_codes=[])  # all 5 exited
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence["deepReview"]["exitCount"] == 5
    assert evidence["marketReferenceShortlist"]["membershipChanged"] is False
    assert evidence["final"]["status"] == "WARN"
    assert evidence["final"]["hardReasons"] == []
    assert "DEEP_REVIEW_EXIT_WARN" in evidence["final"]["warnReasons"]


# ---------------------------------------------------------------------------
# C. Actionable churn
# ---------------------------------------------------------------------------


def test_p14_d2_actionable_one_exit_no_actionable_specific_warn():
    base = _p14d2_isolated_churn_population(actionable_codes=["A1", "A2"])
    perturbed = _p14d2_isolated_churn_population(actionable_codes=["A1"])  # 1 exit
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence["actionable"]["exitCount"] == 1
    assert evidence["marketReferenceShortlist"]["membershipChanged"] is False
    assert evidence["final"]["status"] == "PASS"
    assert evidence["final"]["hardReasons"] == []
    assert evidence["final"]["warnReasons"] == []


def test_p14_d2_actionable_two_exits_is_warn():
    base = _p14d2_isolated_churn_population(actionable_codes=["A1", "A2", "A3"])
    perturbed = _p14d2_isolated_churn_population(actionable_codes=["A1"])  # 2 exits
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence["actionable"]["exitCount"] == 2
    assert evidence["marketReferenceShortlist"]["membershipChanged"] is False
    assert evidence["final"]["status"] == "WARN"
    assert "ACTIONABLE_EXIT_WARN" in evidence["final"]["warnReasons"]
    assert evidence["final"]["hardReasons"] == []


def test_p14_d2_actionable_three_exits_is_fail():
    base = _p14d2_churn_population(actionable_codes=["A1", "A2", "A3", "A4"])
    perturbed = _p14d2_churn_population(actionable_codes=["A1"])  # 3 exits
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence["actionable"]["exitCount"] == 3
    assert evidence["final"]["status"] == "FAIL"
    assert "ACTIONABLE_EXIT_HARD" in evidence["final"]["hardReasons"]


def test_p14_d2_actionable_more_than_three_exits_stays_fail():
    base = _p14d2_churn_population(actionable_codes=["A1", "A2", "A3", "A4", "A5", "A6"])
    perturbed = _p14d2_churn_population(actionable_codes=[])  # 6 exits
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence["actionable"]["exitCount"] == 6
    assert evidence["final"]["status"] == "FAIL"
    assert "ACTIONABLE_EXIT_HARD" in evidence["final"]["hardReasons"]


# ---------------------------------------------------------------------------
# D. P14_MARKET_REFERENCE_SHORTLIST
# ---------------------------------------------------------------------------


def test_p14_d2_market_reference_shortlist_name_and_n_and_holdings_independence():
    assert batch.P14_MARKET_REFERENCE_SHORTLIST_NAME == "P14_MARKET_REFERENCE_SHORTLIST"
    assert batch.P14_MARKET_REFERENCE_SHORTLIST_N == 3
    result = _p14d2_churn_population(
        deep_review_codes=["D1"], actionable_codes=["A1", "A2"]
    )
    shortlist = batch.build_market_reference_shortlist(result)
    assert len(shortlist) == 3
    # holdings/cash/allocation/officialDecisionを一切参照しない — result
    # dictにそれらのkeyが存在しなくてもエラーなく評価できることそのものが
    # holdings非依存性のevidenceである。
    assert "holdings" not in result and "cash" not in result and "officialDecision" not in result


def test_p14_d2_market_reference_shortlist_eligibility_requires_tier_and_valid_rank():
    result = _p14d2_result(
        [
            {"code": "D1", "tier": "deep_review", "marketRank": 1},
            {"code": "A1", "tier": "actionable", "marketRank": 2},
            {"code": "S1", "tier": "screened", "marketRank": 3},  # wrong tier
            {"code": "X1", "tier": "actionable", "marketRank": None},  # invalid rank
            {"code": "X2", "tier": "excluded", "marketRank": 4},  # wrong tier
        ]
    )
    shortlist = batch.build_market_reference_shortlist(result)
    assert {e["code"] for e in shortlist} == {"D1", "A1"}


def test_p14_d2_market_reference_shortlist_unchanged_ordered_list_is_pass():
    result = _p14d2_churn_population(deep_review_codes=["D1"], actionable_codes=["A1", "A2"])
    evidence = batch.compute_p14_release_evidence(result, result)
    shortlist = evidence["marketReferenceShortlist"]
    assert shortlist["base"] == shortlist["perturbed"]
    assert shortlist["membershipChanged"] is False
    assert shortlist["tierChanged"] is False
    assert shortlist["orderChanged"] is False
    assert evidence["final"]["status"] == "PASS"


def test_p14_d2_market_reference_shortlist_code_replacement_is_fail():
    base = _p14d2_churn_population(actionable_codes=["A1", "A2", "A3"])
    perturbed = _p14d2_churn_population(actionable_codes=["A1", "A2", "A4"])  # A3 -> A4
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence["marketReferenceShortlist"]["membershipChanged"] is True
    assert evidence["final"]["status"] == "FAIL"
    assert "MARKET_REFERENCE_SHORTLIST_MEMBERSHIP_CHANGED" in evidence["final"]["hardReasons"]


def test_p14_d2_market_reference_shortlist_tier_change_is_fail():
    base = _p14d2_result([{"code": "A1", "tier": "deep_review", "marketRank": 1}])
    perturbed = _p14d2_result([{"code": "A1", "tier": "actionable", "marketRank": 1}])
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence["marketReferenceShortlist"]["membershipChanged"] is False
    assert evidence["marketReferenceShortlist"]["tierChanged"] is True
    assert evidence["final"]["status"] == "FAIL"
    assert "MARKET_REFERENCE_SHORTLIST_MEMBERSHIP_CHANGED" in evidence["final"]["hardReasons"]


def test_p14_d2_market_reference_shortlist_order_only_change_is_warn():
    base = _p14d2_result(
        [
            {"code": "A1", "tier": "actionable", "marketRank": 1},
            {"code": "A2", "tier": "actionable", "marketRank": 2},
        ]
    )
    perturbed = _p14d2_result(
        [
            {"code": "A1", "tier": "actionable", "marketRank": 2},
            {"code": "A2", "tier": "actionable", "marketRank": 1},
        ]
    )
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    shortlist = evidence["marketReferenceShortlist"]
    assert shortlist["membershipChanged"] is False
    assert shortlist["tierChanged"] is False
    assert shortlist["orderChanged"] is True
    assert evidence["final"]["status"] == "WARN"
    assert "MARKET_REFERENCE_SHORTLIST_ORDER_CHANGED" in evidence["final"]["warnReasons"]


def test_p14_d2_market_reference_shortlist_n_is_deterministic_3():
    result = _p14d2_churn_population(
        deep_review_codes=["D1", "D2"], actionable_codes=["A1", "A2", "A3"]
    )
    shortlist = batch.build_market_reference_shortlist(result)
    assert len(shortlist) == 3
    # rank 1..5 (D1=1, D2=2, A1=3, A2=4, A3=5) -> top 3 by marketRank ascending
    assert [e["code"] for e in shortlist] == ["D1", "D2", "A1"]


# ---------------------------------------------------------------------------
# D-parity. §13 REFERENCE_ORDER_PARITY — comparator semantics must mirror
# src/domain/candidates/candidatePortfolioRecommendation.ts compareCandidateOrder
# exactly: 1) marketRank ascending 2) null rank last 3) artifactIndex
# ascending tie-break. These cases specifically distinguish marketRank as
# the PRIMARY key from artifactIndex as only the tie-break (a mutation that
# swaps their precedence must fail here even when it happens to agree with
# the simpler monotonic n_is_deterministic_3 case above).
# ---------------------------------------------------------------------------


def test_p14_d2_reference_order_parity_distinct_market_ranks():
    """marketRankが唯一の差別化要因のとき、artifactIndexの並び順とは無関係
    にmarketRank昇順で並ぶ。"""
    result = _p14d2_result(
        [
            {"code": "LOW_IDX_HIGH_RANK", "tier": "actionable", "marketRank": 3},
            {"code": "HIGH_IDX_LOW_RANK", "tier": "actionable", "marketRank": 1},
            {"code": "MID", "tier": "actionable", "marketRank": 2},
        ]
    )
    shortlist = batch.build_market_reference_shortlist(result)
    # artifactIndex order is [0,1,2] but marketRank order must win:
    # HIGH_IDX_LOW_RANK(rank1, idx1) < MID(rank2, idx2) < LOW_IDX_HIGH_RANK(rank3, idx0)
    assert [e["code"] for e in shortlist] == ["HIGH_IDX_LOW_RANK", "MID", "LOW_IDX_HIGH_RANK"]


def test_p14_d2_reference_order_parity_equal_market_ranks_use_artifact_index_tie_break():
    """marketRankが同点のとき、artifactIndex昇順（=engine_result['candidates']
    の配列位置、production artifact.candidatesの配列位置と厳密に一致）が
    tie-breakとして使われる。"""
    result = _p14d2_result(
        [
            {"code": "FIRST", "tier": "actionable", "marketRank": 1},  # artifactIndex 0
            {"code": "SECOND", "tier": "actionable", "marketRank": 1},  # artifactIndex 1
            {"code": "THIRD", "tier": "actionable", "marketRank": 1},  # artifactIndex 2
        ]
    )
    shortlist = batch.build_market_reference_shortlist(result)
    assert [e["code"] for e in shortlist] == ["FIRST", "SECOND", "THIRD"]


def test_p14_d2_reference_order_parity_null_rank_excluded_at_comparator_boundary():
    """P14_MARKET_REFERENCE_SHORTLISTのeligibilityはvalid positive rankを
    要求するため、null rankのcandidateは母集団に入らない（comparator自体は
    section13のparity要件通りnullをlast扱いする一般形だが、eligibility
    filterにより本番の母集団へnullが到達することはない）。"""
    result = _p14d2_result(
        [
            {"code": "VALID", "tier": "actionable", "marketRank": 1},
            {"code": "NULL_RANK", "tier": "actionable", "marketRank": None},
        ]
    )
    shortlist = batch.build_market_reference_shortlist(result)
    assert [e["code"] for e in shortlist] == ["VALID"]


def test_p14_d2_reference_order_parity_comparator_function_handles_null_generically():
    """_reference_shortlist_sort_keyそのもの（eligibility filterを経由しない
    純粋なcomparator）はnull rankをlast扱いする — TSのcompareCandidateOrder
    と同じ一般形であることを直接証明する。"""
    entries = [
        {"code": "NULL1", "marketRank": None, "artifactIndex": 0},
        {"code": "RANKED", "marketRank": 5, "artifactIndex": 1},
        {"code": "NULL2", "marketRank": None, "artifactIndex": 2},
    ]
    ordered = sorted(entries, key=batch._reference_shortlist_sort_key)
    assert [e["code"] for e in ordered] == ["RANKED", "NULL1", "NULL2"]


def test_p14_d2_reference_order_parity_stable_deterministic_replay():
    result = _p14d2_churn_population(
        deep_review_codes=["D1", "D2"], actionable_codes=["A1", "A2", "A3"]
    )
    first = batch.build_market_reference_shortlist(result)
    second = batch.build_market_reference_shortlist(result)
    assert first == second


# ---------------------------------------------------------------------------
# E. Severity precedence
# ---------------------------------------------------------------------------


def test_p14_d2_severity_pass_only():
    base, perturbed = _p14d2_jaccard_case(swap=0)
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence["final"]["status"] == "PASS"


def test_p14_d2_severity_warn_only():
    base, perturbed = _p14d2_jaccard_case(swap=2)
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence["final"]["status"] == "WARN"


def test_p14_d2_severity_multiple_warn_stays_warn():
    """top40 jaccard WARN と deep-review exit WARN を同時に成立させる。
    deep-reviewのfiller(F1-F3)をD1より上位rankへ置き、reference shortlist
    top-3の外側(rank>=1000、top-40 windowの外)でD1だけが退出するように
    構成し、reference shortlistとjaccardのHARD条件を意図せず誘発しない
    ようcode空間を完全に分離する。"""
    screened_base = [{"code": f"B{i:02d}", "tier": "screened", "marketRank": i} for i in range(1, 41)]
    screened_perturbed = [
        {"code": f"B{i:02d}", "tier": "screened", "marketRank": i} for i in range(1, 39)
    ] + [{"code": "X1", "tier": "screened", "marketRank": 39}, {"code": "X2", "tier": "screened", "marketRank": 40}]
    fillers = [{"code": f"F{i}", "tier": "deep_review", "marketRank": 999 + i} for i in range(1, 4)]
    base = _p14d2_result(screened_base + fillers + [{"code": "D1", "tier": "deep_review", "marketRank": 1003}])
    perturbed = _p14d2_result(screened_perturbed + fillers)  # D1 exited
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert "TOP40_JACCARD_BELOW_WARN_MIN" in evidence["final"]["warnReasons"]
    assert "DEEP_REVIEW_EXIT_WARN" in evidence["final"]["warnReasons"]
    assert evidence["marketReferenceShortlist"]["membershipChanged"] is False
    assert len(evidence["final"]["warnReasons"]) >= 2
    assert evidence["final"]["hardReasons"] == []
    assert evidence["final"]["status"] == "WARN"


def test_p14_d2_severity_warn_plus_hard_is_fail():
    """WARNがFAILを上書きしてはならない（§7 — 複数WARN条件が同時に成立
    していても、1つでもHARDが成立すればFAILが優先される）。deep-review/
    actionable churnのcodeをtop-40 window外（rank>=1000）へ配置し、jaccard
    （top-40窓）への意図しない副作用（rank shiftによるswap数の汚染）を
    避ける。"""
    screened_base = [{"code": f"B{i:02d}", "tier": "screened", "marketRank": i} for i in range(1, 41)]
    screened_perturbed = [
        {"code": f"B{i:02d}", "tier": "screened", "marketRank": i} for i in range(1, 39)
    ] + [{"code": "X1", "tier": "screened", "marketRank": 39}, {"code": "X2", "tier": "screened", "marketRank": 40}]
    base = _p14d2_result(
        screened_base
        + [{"code": "D1", "tier": "deep_review", "marketRank": 1000}]
        + [{"code": f"A{i}", "tier": "actionable", "marketRank": 1000 + i} for i in range(1, 5)]
    )
    perturbed = _p14d2_result(screened_perturbed)  # D1 + all 4 actionable exited
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert "DEEP_REVIEW_EXIT_WARN" in evidence["final"]["warnReasons"]
    assert "TOP40_JACCARD_BELOW_WARN_MIN" in evidence["final"]["warnReasons"]
    assert "ACTIONABLE_EXIT_HARD" in evidence["final"]["hardReasons"]
    assert evidence["final"]["status"] == "FAIL"


def test_p14_d2_severity_multiple_hard_stays_fail():
    """actionable exit>=3(HARD)とreference shortlist membership変化(HARD)
    が同時に成立するケース — 4件のactionableが全滅すれば、top-3 reference
    shortlistのmembershipも必然的に変化する（両方が独立にhardReasonsへ
    記録され、複数HARDでもFAILのまま — WARNへ弱まらないことを保証する）。"""
    base = _p14d2_churn_population(actionable_codes=["A1", "A2", "A3", "A4"])
    perturbed = _p14d2_churn_population(actionable_codes=[])
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence["actionable"]["exitCount"] == 4
    assert "ACTIONABLE_EXIT_HARD" in evidence["final"]["hardReasons"]
    assert "MARKET_REFERENCE_SHORTLIST_MEMBERSHIP_CHANGED" in evidence["final"]["hardReasons"]
    assert len(evidence["final"]["hardReasons"]) >= 2
    assert evidence["final"]["status"] == "FAIL"


# ---------------------------------------------------------------------------
# G. Evidence shape
# ---------------------------------------------------------------------------


def test_p14_d2_evidence_composite_fields_present():
    base, perturbed = _p14d2_jaccard_case(swap=1)
    evidence = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence["policyVersion"] == "p14-decision-aware-v1"
    assert evidence["policyVersion"] == batch.P14_RELEASE_POLICY_VERSION
    assert evidence["p14ProvesOfficialDecisionStability"] is False
    for key in ("intersection", "union", "retention", "swapCount", "jaccard", "warnThreshold", "hardThreshold"):
        assert key in evidence["top40"]
    for key in ("baseCodes", "perturbedCodes", "entered", "exited", "exitCount"):
        assert key in evidence["deepReview"]
    for key in ("baseCodes", "perturbedCodes", "entered", "exited", "exitCount", "warnThreshold", "hardThreshold"):
        assert key in evidence["actionable"]
    shortlist = evidence["marketReferenceShortlist"]
    assert shortlist["name"] == "P14_MARKET_REFERENCE_SHORTLIST"
    assert shortlist["holdingsDependent"] is False
    assert shortlist["n"] == 3
    for key in ("status", "hardReasons", "warnReasons"):
        assert key in evidence["final"]


def test_p14_d2_evidence_reasons_are_machine_readable_and_reproducible():
    base, perturbed = _p14d2_jaccard_case(swap=5)
    evidence1 = batch.compute_p14_release_evidence(base, perturbed)
    evidence2 = batch.compute_p14_release_evidence(base, perturbed)
    assert evidence1 == evidence2
    assert all(isinstance(r, str) for r in evidence1["final"]["hardReasons"])


# ---------------------------------------------------------------------------
# I. Determinism / J. Non-regression
# ---------------------------------------------------------------------------


def test_p14_d2_determinism_same_input_twice_identical_evidence():
    base, perturbed = _p14d2_jaccard_case(swap=2)
    first = batch.compute_p14_release_evidence(base, perturbed)
    second = batch.compute_p14_release_evidence(base, perturbed)
    assert first == second
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)


def test_p14_d2_does_not_mutate_engine_or_perturbed_results():
    base, perturbed = _p14d2_jaccard_case(swap=2)
    base_before = copy.deepcopy(base)
    perturbed_before = copy.deepcopy(perturbed)
    batch.compute_p14_release_evidence(base, perturbed)
    assert base == base_before
    assert perturbed == perturbed_before


def test_p14_d2_calibration_fixture_rank_vectors_unchanged_by_evidence_computation(tmp_path):
    """SCORING_CHANGED=NO / ENGINE_RANKING_CHANGED=NO: compute_p14_release_evidence
    を呼び出す前後でengine_result['candidates']（rank vector）が完全に
    element-identicalであること。"""
    stripped_candidates, prescreen_entries = _calibration_split(canonical_p14_order=True)
    index, dup = batch.build_prescreen_index(_prescreen_payload(prescreen_entries))
    joined, join_stats = batch.join_candidates_with_prescreen(stripped_candidates, index)
    context = batch.build_context(_candidates_stocks_payload(stripped_candidates), "bull_calm", NOW)
    engine_result = batch.build_candidate_funnel(joined, context)
    before = copy.deepcopy(engine_result["candidates"])
    jaccard, perturbed_result = batch.compute_rank_stability(joined, context, engine_result)
    batch.compute_p14_release_evidence(engine_result, perturbed_result)
    assert engine_result["candidates"] == before
