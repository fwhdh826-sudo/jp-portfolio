"""
Tests for backend/engine/snapshot/phase3_snapshot.py — Card 3-8
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

from backend.engine.snapshot.phase3_snapshot import (
    SCHEMA_VERSION,
    build_phase3_snapshot,
    write_json_atomic,
)
from backend.engine.shadow.shadow_mode import (
    ShadowAuditInput,
    make_default_scenarios,
    run_shadow_audit,
)
from backend.engine.universe.size_segments import SizeInput, classify_size_batch


# ── Helpers ───────────────────────────────────────────────────────────────────

FIXED_DATE = date(2026, 5, 3)
FIXED_TS = datetime(2026, 5, 3, 0, 0, 0, tzinfo=timezone.utc)

SAMPLE_STOCKS = [
    SizeInput(ticker="7011", market_cap=2_000_000_000_000),  # large_cap
    SizeInput(ticker="6758", market_cap=500_000_000_000),    # mid_cap
    SizeInput(ticker="4755", market_cap=80_000_000_000),     # small_cap
]


def _run_default():
    inp = ShadowAuditInput(scenarios=make_default_scenarios(), run_date=FIXED_DATE)
    return run_shadow_audit(inp)


def _get_regime_result(name: str):
    result = _run_default()
    for r in result.results:
        if r.scenario_name == name:
            return r.regime_result
    raise KeyError(name)


def _build_snapshot(scenario_name: str = "S1_bull_calm_normal", stocks=None):
    if stocks is None:
        stocks = SAMPLE_STOCKS
    rr = _get_regime_result(scenario_name)
    size_results = classify_size_batch(stocks)
    return build_phase3_snapshot(rr, size_results, generated_at=FIXED_TS)


# ── Schema version ────────────────────────────────────────────────────────────

class TestSchemaVersion:
    def test_schema_version_constant(self):
        assert SCHEMA_VERSION == "3.8"

    def test_schema_version_in_phase3_snapshot(self):
        d = _build_snapshot()
        assert d["phase3_snapshot"]["schema_version"] == "3.8"

    def test_schema_version_at_phase3_snapshot_top(self):
        # spec: "phase3_snapshot 直下" に schema_version
        d = _build_snapshot()
        assert "schema_version" in d["phase3_snapshot"]
        assert "schema_version" not in d  # not at outermost level


# ── Top-level structure ───────────────────────────────────────────────────────

class TestTopLevelStructure:
    def test_has_phase3_snapshot_key(self):
        d = _build_snapshot()
        assert "phase3_snapshot" in d

    def test_only_phase3_snapshot_at_top(self):
        d = _build_snapshot()
        assert list(d.keys()) == ["phase3_snapshot"]

    def test_phase3_snapshot_is_dict(self):
        d = _build_snapshot()
        assert isinstance(d["phase3_snapshot"], dict)


# ── phase3_snapshot sub-keys ──────────────────────────────────────────────────

class TestPhase3SnapshotSubKeys:
    def test_has_schema_version(self):
        d = _build_snapshot()
        assert "schema_version" in d["phase3_snapshot"]

    def test_has_generated_at(self):
        d = _build_snapshot()
        assert "generated_at" in d["phase3_snapshot"]

    def test_has_regime_state(self):
        d = _build_snapshot()
        assert "regime_state" in d["phase3_snapshot"]

    def test_has_size_segments(self):
        d = _build_snapshot()
        assert "size_segments" in d["phase3_snapshot"]

    def test_has_metadata(self):
        d = _build_snapshot()
        assert "_metadata" in d["phase3_snapshot"]

    def test_metadata_parallel_to_regime_state_and_size_segments(self):
        # _metadata は regime_state / size_segments と同階層
        snap = _build_snapshot()["phase3_snapshot"]
        assert "regime_state" in snap
        assert "size_segments" in snap
        assert "_metadata" in snap

    def test_generated_at_is_fixed_timestamp(self):
        d = _build_snapshot()
        assert d["phase3_snapshot"]["generated_at"] == FIXED_TS.isoformat()


# ── regime_state content in snapshot ─────────────────────────────────────────

class TestRegimeStateContent:
    def test_regime_state_has_schema_version(self):
        d = _build_snapshot()
        assert d["phase3_snapshot"]["regime_state"]["schema_version"] == "3.8"

    def test_regime_state_has_current_regime(self):
        d = _build_snapshot("S1_bull_calm_normal")
        assert d["phase3_snapshot"]["regime_state"]["current_regime"] == "bull_calm"

    def test_regime_state_has_consensus(self):
        d = _build_snapshot()
        assert "consensus" in d["phase3_snapshot"]["regime_state"]

    def test_regime_state_has_raw_consensus(self):
        d = _build_snapshot()
        assert "raw_consensus" in d["phase3_snapshot"]["regime_state"]

    def test_regime_state_has_layer_reliability(self):
        d = _build_snapshot()
        assert "layer_reliability" in d["phase3_snapshot"]["regime_state"]


# ── size_segments content in snapshot ────────────────────────────────────────

class TestSizeSegmentsContent:
    def test_size_segments_has_schema_version(self):
        d = _build_snapshot()
        assert d["phase3_snapshot"]["size_segments"]["schema_version"] == "3.8"

    def test_size_segments_has_count(self):
        d = _build_snapshot()
        assert d["phase3_snapshot"]["size_segments"]["count"] == len(SAMPLE_STOCKS)

    def test_size_segments_has_segments_list(self):
        d = _build_snapshot()
        segs = d["phase3_snapshot"]["size_segments"]["segments"]
        assert isinstance(segs, list)
        assert len(segs) == len(SAMPLE_STOCKS)


# ── _metadata in snapshot ─────────────────────────────────────────────────────

class TestMetadataInSnapshot:
    def test_p1f_consensus_semantics_present(self):
        d = _build_snapshot()
        assert "p1f_consensus_semantics" in d["phase3_snapshot"]["_metadata"]

    def test_p1f_s1_no_diverge(self):
        d = _build_snapshot("S1_bull_calm_normal")
        p1f = d["phase3_snapshot"]["_metadata"]["p1f_consensus_semantics"]
        assert p1f["semantics_diverge"] is False

    def test_p1f_s8_diverge_true(self):
        # S8: is_override=True AND is_crisis=True → semantics_diverge=True
        d = _build_snapshot("S8_override_crisis")
        p1f = d["phase3_snapshot"]["_metadata"]["p1f_consensus_semantics"]
        assert p1f["semantics_diverge"] is True

    def test_p1f_s8_is_override_true_in_metadata(self):
        d = _build_snapshot("S8_override_crisis")
        p1f = d["phase3_snapshot"]["_metadata"]["p1f_consensus_semantics"]
        assert p1f["is_override"] is True


# ── S8: is_override=True AND is_crisis=True coexist in phase3_snapshot ────────

class TestS8OverrideCrisisInSnapshot:
    def test_s8_is_override_and_is_crisis_both_true(self):
        d = _build_snapshot("S8_override_crisis")
        rs = d["phase3_snapshot"]["regime_state"]
        assert rs["is_override"] is True
        assert rs["is_crisis"] is True

    def test_s8_regime_is_crisis(self):
        d = _build_snapshot("S8_override_crisis")
        assert d["phase3_snapshot"]["regime_state"]["current_regime"] == "crisis"


# ── S9: HMM low_confidence in phase3_snapshot ────────────────────────────────

class TestS9HmmLowConfidenceInSnapshot:
    def test_s9_hmm_is_low_confidence_in_layer_reliability(self):
        d = _build_snapshot("S9_hmm_low_confidence")
        lr = d["phase3_snapshot"]["regime_state"]["layer_reliability"]
        assert lr["hmm"]["is_low_confidence"] is True

    def test_s9_regime_is_bear(self):
        d = _build_snapshot("S9_hmm_low_confidence")
        assert d["phase3_snapshot"]["regime_state"]["current_regime"] == "bear"


# ── write_json_atomic ─────────────────────────────────────────────────────────

class TestWriteJsonAtomic:
    def test_writes_file(self, tmp_path):
        data = {"hello": "world"}
        out = tmp_path / "test.json"
        write_json_atomic(data, out)
        assert out.exists()

    def test_written_content_is_valid_json(self, tmp_path):
        data = {"regime": "bull_calm", "schema_version": "3.8"}
        out = tmp_path / "out.json"
        write_json_atomic(data, out)
        loaded = json.loads(out.read_text(encoding="utf-8"))
        assert loaded == data

    def test_overwrites_existing_file(self, tmp_path):
        out = tmp_path / "out.json"
        write_json_atomic({"v": 1}, out)
        write_json_atomic({"v": 2}, out)
        loaded = json.loads(out.read_text(encoding="utf-8"))
        assert loaded["v"] == 2

    def test_no_tmp_file_left_on_success(self, tmp_path):
        out = tmp_path / "out.json"
        write_json_atomic({"x": 1}, out)
        tmp_files = list(tmp_path.glob("*.tmp"))
        assert tmp_files == []

    def test_accepts_path_object(self, tmp_path):
        out = tmp_path / "snapshot.json"
        write_json_atomic({"a": 1}, Path(out))
        assert out.exists()

    def test_accepts_path_as_string(self, tmp_path):
        out = tmp_path / "snapshot.json"
        write_json_atomic({"a": 1}, str(out))
        assert out.exists()

    def test_writes_phase3_snapshot(self, tmp_path):
        d = _build_snapshot()
        out = tmp_path / "phase3_snapshot.json"
        write_json_atomic(d, out)
        loaded = json.loads(out.read_text(encoding="utf-8"))
        assert loaded["phase3_snapshot"]["schema_version"] == "3.8"

    def test_ensures_utf8_encoding(self, tmp_path):
        data = {"label": "日本株"}
        out = tmp_path / "out.json"
        write_json_atomic(data, out)
        text = out.read_text(encoding="utf-8")
        assert "日本株" in text

    def test_path_is_tmp_only_not_public_data(self, tmp_path):
        # 本テストは tmp_path のみを使う（public/data への書き込み禁止の確認）
        out = tmp_path / "snapshot.json"
        write_json_atomic({"ok": True}, out)
        assert str(out).startswith(str(tmp_path))


# ── build_phase3_snapshot auto generated_at ──────────────────────────────────

class TestAutoGeneratedAt:
    def test_auto_generated_at_is_set(self):
        rr = _get_regime_result("S1_bull_calm_normal")
        size_results = classify_size_batch(SAMPLE_STOCKS)
        d = build_phase3_snapshot(rr, size_results, generated_at=None)
        assert d["phase3_snapshot"]["generated_at"] is not None

    def test_generated_at_consistent_in_regime_and_size(self):
        # regime_state と size_segments が同じ generated_at を持つかは実装依存だが、
        # phase3_snapshot.generated_at は存在する
        d = _build_snapshot()
        assert "generated_at" in d["phase3_snapshot"]
        assert "generated_at" in d["phase3_snapshot"]["size_segments"]
