"""
test_phase8_strategy_aggregate_producer.py — D: compute-actual-2 テスト

backend/engine/operation/phase8_strategy_aggregate_producer.py の
produce_strategy_aggregate_raw() を real compute（4 戦略 .compute() +
StrategyAggregator.aggregate()、frontier Phase 8 は scipy/SLSQP 通過）で
検証する。

テスト配置の理由（Q1 決定 / P1-D2-5）:
  D の主語は 4 戦略 + StrategyAggregator であり、strategy / aggregator 系
  テストの本拠が backend/tests/test_strategies/ であるため本テストはここに
  置く。backend/tests/test_operation/ には置かない（Operation 層 test の
  stdlib / Flat-DI / scipy 非依存原則を汚染しない、C precedent 継続）。

scipy 1.13+ required（インストール済み、FrontierStrategy Phase 8 経由）。
"""
from __future__ import annotations

import ast
import json
import os

import pytest

from engine.operation.phase8_strategy_aggregate_producer import (
    produce_strategy_aggregate_raw,
)

# ── フィクスチャ（微小決定論、2 ticker）──────────────────────────────────────

_BASIC_SCORES = {
    "A": {
        "value":              {"total": 65.0},
        "quality":            {"total": 70.0},
        "growth":             {"total": 55.0},
        "safety":             {"total": 60.0},
        "momentum":           {"total": 50.0},
        "shareholder_return": {"total": 45.0},
    },
    "B": {
        "value":              {"total": 50.0},
        "quality":            {"total": 60.0},
        "growth":             {"total": 65.0},
        "safety":             {"total": 75.0},
        "momentum":           {"total": 55.0},
        "shareholder_return": {"total": 50.0},
    },
}

_RETURNS_A = [0.10, -0.05, 0.08, -0.03, 0.06]
_RETURNS_B = [0.02, -0.01, 0.03, -0.01, 0.02]

_TOP_KEYS = {
    "strategy_aggregate_raw",
    "strategy_outputs",
    "regime",
    "diagnostics",
}

_AGGREGATE_KEYS = {
    "aggregated_ideal_pf",
    "expected_return",
    "expected_vol",
    "sharpe_ratio",
    "max_dd_estimate",
    "weights_used",
    "regime",
    "strategy_correlations",
    "diversification_score",
    "diagnostics",
}

_STRATEGY_IDS = {"frontier", "quality_size", "fundamental", "cross_factor"}

_STRATEGY_OUTPUT_KEYS = {
    "strategy_id",
    "strategy_name",
    "ideal_pf",
    "expected_return",
    "expected_vol",
    "sharpe_ratio",
    "max_dd_estimate",
    "rationale",
    "diagnostics",
}


def _phase8_context() -> dict:
    return {
        "returns_data": {"A": list(_RETURNS_A), "B": list(_RETURNS_B)},
        "mean_return_3y_by_ticker": {"A": 0.08, "B": 0.03},
        "size_segment_by_ticker": {"A": "large_cap", "B": "large_cap"},
        "shrinkage_alpha": 0.0,
        "asset_meta_by_ticker": {
            "A": {"sector": "tech", "is_core": False, "is_leveraged": False},
            "B": {"sector": "finance", "is_core": False, "is_leveraged": False},
        },
    }


def _produce_phase8(**overrides):
    kwargs = dict(
        universe=("A", "B"),
        scores=_BASIC_SCORES,
        regime="bull_calm",
        context=_phase8_context(),
    )
    kwargs.update(overrides)
    return produce_strategy_aggregate_raw(**kwargs)


def _produce_phase7(**overrides):
    kwargs = dict(
        universe=("A", "B"),
        scores=_BASIC_SCORES,
        regime="bull_calm",
        context={},
    )
    kwargs.update(overrides)
    return produce_strategy_aggregate_raw(**kwargs)


def _module_source() -> str:
    import engine.operation.phase8_strategy_aggregate_producer as mod
    with open(mod.__file__) as fh:
        return fh.read()


def _docstring_node_ids(tree: ast.AST) -> set[int]:
    ids: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(
            node,
            (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef),
        ):
            body = getattr(node, "body", None)
            if not body:
                continue
            first = body[0]
            if (
                isinstance(first, ast.Expr)
                and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)
            ):
                ids.add(id(first.value))
    return ids


# ── TestProduceContract ──────────────────────────────────────────────────────

class TestProduceContract:
    def test_returns_dict(self):
        assert isinstance(_produce_phase8(), dict)

    def test_exact_top_keys(self):
        assert set(_produce_phase8().keys()) == _TOP_KEYS

    def test_strategy_aggregate_raw_is_dict(self):
        assert isinstance(_produce_phase8()["strategy_aggregate_raw"], dict)

    def test_strategy_aggregate_raw_ten_keys(self):
        agg = _produce_phase8()["strategy_aggregate_raw"]
        assert set(agg.keys()) == _AGGREGATE_KEYS

    def test_strategy_outputs_is_dict(self):
        assert isinstance(_produce_phase8()["strategy_outputs"], dict)

    def test_strategy_outputs_four_ids(self):
        assert set(_produce_phase8()["strategy_outputs"].keys()) == _STRATEGY_IDS

    def test_regime_is_str(self):
        assert isinstance(_produce_phase8()["regime"], str)

    def test_diagnostics_is_list(self):
        assert isinstance(_produce_phase8()["diagnostics"], list)

    def test_whole_return_json_serializable(self):
        json.loads(json.dumps(_produce_phase8()))


# ── TestPhase8 ───────────────────────────────────────────────────────────────

class TestPhase8:
    def test_aggregate_raw_ten_keys_exact(self):
        agg = _produce_phase8()["strategy_aggregate_raw"]
        assert set(agg.keys()) == _AGGREGATE_KEYS

    def test_aggregate_raw_json_serializable(self):
        agg = _produce_phase8()["strategy_aggregate_raw"]
        round_tripped = json.loads(json.dumps(agg))
        assert set(round_tripped.keys()) == _AGGREGATE_KEYS

    def test_strategy_outputs_four(self):
        assert len(_produce_phase8()["strategy_outputs"]) == 4

    def test_each_strategy_output_nine_keys(self):
        so = _produce_phase8()["strategy_outputs"]
        for sid in _STRATEGY_IDS:
            assert set(so[sid].keys()) == _STRATEGY_OUTPUT_KEYS

    def test_frontier_strategy_output_present(self):
        assert "frontier" in _produce_phase8()["strategy_outputs"]

    def test_frontier_strategy_id_field(self):
        so = _produce_phase8()["strategy_outputs"]["frontier"]
        assert so["strategy_id"] == "frontier"

    def test_aggregated_ideal_pf_present(self):
        agg = _produce_phase8()["strategy_aggregate_raw"]
        assert "aggregated_ideal_pf" in agg

    def test_expected_return_is_number(self):
        agg = _produce_phase8()["strategy_aggregate_raw"]
        assert isinstance(agg["expected_return"], (int, float))

    def test_expected_vol_is_number(self):
        agg = _produce_phase8()["strategy_aggregate_raw"]
        assert isinstance(agg["expected_vol"], (int, float))

    def test_sharpe_ratio_is_number(self):
        agg = _produce_phase8()["strategy_aggregate_raw"]
        assert isinstance(agg["sharpe_ratio"], (int, float))

    def test_regime_echoed(self):
        assert _produce_phase8(regime="bear")["regime"] == "bear"

    def test_diagnostics_mentions_phase8(self):
        diags = " ".join(_produce_phase8()["diagnostics"])
        assert "Phase 8 path" in diags


# ── TestPhase7 ───────────────────────────────────────────────────────────────

class TestPhase7:
    def test_aggregate_raw_ten_keys(self):
        agg = _produce_phase7()["strategy_aggregate_raw"]
        assert set(agg.keys()) == _AGGREGATE_KEYS

    def test_strategy_outputs_four(self):
        assert set(_produce_phase7()["strategy_outputs"].keys()) == _STRATEGY_IDS

    def test_p2a1_hybrid_absent_in_phase7(self):
        ad = _produce_phase7()["strategy_aggregate_raw"]["diagnostics"]
        assert not any("hybrid metric sources" in d for d in ad)

    def test_frontier_phase7_diagnostic(self):
        diags = " ".join(_produce_phase7()["diagnostics"])
        assert "Phase 7 fallback" in diags

    def test_none_context_is_phase7(self):
        r = produce_strategy_aggregate_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context=None,
        )
        assert set(r["strategy_aggregate_raw"].keys()) == _AGGREGATE_KEYS

    def test_empty_returns_data_is_phase7(self):
        r = produce_strategy_aggregate_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context={"returns_data": {}},
        )
        ad = r["strategy_aggregate_raw"]["diagnostics"]
        assert not any("hybrid metric sources" in d for d in ad)

    def test_non_dict_returns_data_is_phase7(self):
        r = produce_strategy_aggregate_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context={"returns_data": [1, 2]},
        )
        assert len(r["strategy_outputs"]) == 4


# ── TestEmptyUniverse ────────────────────────────────────────────────────────

class TestEmptyUniverse:
    def _empty(self):
        return produce_strategy_aggregate_raw(
            universe=(), scores={}, regime="bull_calm",
            context=_phase8_context(),
        )

    def test_aggregate_raw_ten_keys(self):
        assert set(self._empty()["strategy_aggregate_raw"].keys()) == _AGGREGATE_KEYS

    def test_strategy_outputs_four(self):
        assert set(self._empty()["strategy_outputs"].keys()) == _STRATEGY_IDS

    def test_diagnostics_mentions_empty_universe(self):
        diags = " ".join(self._empty()["diagnostics"])
        assert "empty universe" in diags

    def test_top_keys(self):
        assert set(self._empty().keys()) == _TOP_KEYS

    def test_json_serializable(self):
        json.loads(json.dumps(self._empty()))


# ── TestHybridDiagnostics（P2-A1 / P2-C5）────────────────────────────────────

class TestHybridDiagnostics:
    def test_p2a1_hybrid_metric_sources_present_phase8(self):
        ad = _produce_phase8()["strategy_aggregate_raw"]["diagnostics"]
        assert any("hybrid metric sources" in d for d in ad)

    def test_p2c5_hybrid_drawdown_present_phase8(self):
        ad = _produce_phase8()["strategy_aggregate_raw"]["diagnostics"]
        assert any("hybrid" in d and "drawdown" in d for d in ad)

    def test_p2a1_absent_phase7(self):
        ad = _produce_phase7()["strategy_aggregate_raw"]["diagnostics"]
        assert not any("hybrid metric sources" in d for d in ad)

    def test_hybrid_diagnostics_observation_prefixed(self):
        ad = _produce_phase8()["strategy_aggregate_raw"]["diagnostics"]
        for d in ad:
            if "hybrid" in d:
                assert d.startswith("observation: ")

    def test_hybrid_calculation_only_wording(self):
        ad = _produce_phase8()["strategy_aggregate_raw"]["diagnostics"]
        joined = " ".join(ad)
        assert "calculation-only" in joined

    def test_phase8_diagnostic_notes_hybrid_maintained(self):
        diags = " ".join(_produce_phase8()["diagnostics"])
        assert "hybrid diagnostic maintained" in diags


# ── TestStrategyOutputsAuxDI ─────────────────────────────────────────────────

class TestStrategyOutputsAuxDI:
    def test_exactly_four_ids(self):
        assert set(_produce_phase8()["strategy_outputs"].keys()) == _STRATEGY_IDS

    def test_each_is_dict(self):
        so = _produce_phase8()["strategy_outputs"]
        for sid in _STRATEGY_IDS:
            assert isinstance(so[sid], dict)

    def test_each_has_strategy_output_schema(self):
        so = _produce_phase8()["strategy_outputs"]
        for sid in _STRATEGY_IDS:
            assert set(so[sid].keys()) == _STRATEGY_OUTPUT_KEYS

    def test_each_json_serializable(self):
        so = _produce_phase8()["strategy_outputs"]
        for sid in _STRATEGY_IDS:
            json.loads(json.dumps(so[sid]))

    def test_strategy_id_fields_match_keys(self):
        so = _produce_phase8()["strategy_outputs"]
        for sid in _STRATEGY_IDS:
            assert so[sid]["strategy_id"] == sid

    def test_ideal_pf_is_dict(self):
        so = _produce_phase8()["strategy_outputs"]
        for sid in _STRATEGY_IDS:
            assert isinstance(so[sid]["ideal_pf"], dict)

    def test_diagnostics_is_list_per_strategy(self):
        so = _produce_phase8()["strategy_outputs"]
        for sid in _STRATEGY_IDS:
            assert isinstance(so[sid]["diagnostics"], list)

    def test_aux_di_usable_as_mapping_payload(self):
        # adapter 補助 DI 形状（{sid: dict}）として deepcopy 可能
        import copy
        so = _produce_phase8()["strategy_outputs"]
        clone = copy.deepcopy(so)
        assert clone == so
        assert clone is not so


# ── TestContextScoresNonMutation ─────────────────────────────────────────────

class TestContextScoresNonMutation:
    def test_phase8_context_keys_unchanged(self):
        ctx = _phase8_context()
        before = set(ctx.keys())
        produce_strategy_aggregate_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context=ctx,
        )
        assert set(ctx.keys()) == before

    def test_phase8_returns_data_unchanged(self):
        ctx = _phase8_context()
        rd_before = {k: list(v) for k, v in ctx["returns_data"].items()}
        produce_strategy_aggregate_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context=ctx,
        )
        assert ctx["returns_data"] == rd_before

    def test_scores_not_mutated(self):
        scores = {
            t: {ax: dict(v) for ax, v in axes.items()}
            for t, axes in _BASIC_SCORES.items()
        }
        snapshot = {
            t: {ax: dict(v) for ax, v in axes.items()}
            for t, axes in scores.items()
        }
        produce_strategy_aggregate_raw(
            universe=("A", "B"), scores=scores,
            regime="bull_calm", context=_phase8_context(),
        )
        assert scores == snapshot

    def test_phase7_context_unchanged(self):
        ctx = {"unrelated": 1}
        produce_strategy_aggregate_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context=ctx,
        )
        assert ctx == {"unrelated": 1}

    def test_none_context_does_not_raise(self):
        r = produce_strategy_aggregate_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context=None,
        )
        assert isinstance(r, dict)

    def test_universe_tuple_or_list_accepted(self):
        r = produce_strategy_aggregate_raw(
            universe=["A", "B"], scores=_BASIC_SCORES,
            regime="bull_calm", context=_phase8_context(),
        )
        assert set(r.keys()) == _TOP_KEYS


# ── TestDeterminism ──────────────────────────────────────────────────────────

class TestDeterminism:
    def test_aggregate_raw_deterministic(self):
        assert (
            _produce_phase8()["strategy_aggregate_raw"]
            == _produce_phase8()["strategy_aggregate_raw"]
        )

    def test_strategy_outputs_deterministic(self):
        assert (
            _produce_phase8()["strategy_outputs"]
            == _produce_phase8()["strategy_outputs"]
        )

    def test_repeated_calls_distinct_objects(self):
        a = _produce_phase8()
        b = _produce_phase8()
        assert a is not b
        assert a["strategy_aggregate_raw"] is not b["strategy_aggregate_raw"]

    def test_phase7_deterministic(self):
        assert (
            _produce_phase7()["strategy_aggregate_raw"]
            == _produce_phase7()["strategy_aggregate_raw"]
        )


# ── TestDiagnostics ──────────────────────────────────────────────────────────

class TestDiagnostics:
    def test_observation_prefixed_phase8(self):
        for d in _produce_phase8()["diagnostics"]:
            assert d.startswith("observation: ")

    def test_observation_prefixed_phase7(self):
        for d in _produce_phase7()["diagnostics"]:
            assert d.startswith("observation: ")

    def test_observation_prefixed_empty(self):
        r = produce_strategy_aggregate_raw(
            universe=(), scores={}, regime="bull_calm", context={},
        )
        for d in r["diagnostics"]:
            assert d.startswith("observation: ")

    def test_diagnostics_non_empty(self):
        assert len(_produce_phase8()["diagnostics"]) >= 1

    def test_no_forbidden_words_in_producer_diagnostics(self):
        diags = " ".join(_produce_phase8()["diagnostics"])
        for tok in ("BUY", "SELL", "HOLD", "WAIT"):
            assert tok not in diags

    def test_diagnostics_all_str(self):
        assert all(isinstance(d, str) for d in _produce_phase8()["diagnostics"])


# ── TestStaticComputeBoundary（AST）──────────────────────────────────────────

class TestStaticComputeBoundary:
    """real compute 境界・禁止 import / token を AST で検証する。"""

    _ALLOWED_ENGINE_MODULES = {
        "engine.strategies.aggregator",
        "engine.strategies.base_strategy",
        "engine.strategies.cross_factor_strategy",
        "engine.strategies.frontier_strategy",
        "engine.strategies.fundamental_weighted_strategy",
        "engine.strategies.quality_size_strategy",
    }

    def _tree(self) -> ast.AST:
        return ast.parse(_module_source())

    def _imported_modules(self) -> set[str]:
        mods: set[str] = set()
        for node in ast.walk(self._tree()):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    mods.add(alias.name)
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    mods.add(node.module)
        return mods

    def test_only_allowed_engine_modules_imported(self):
        engine_mods = {
            m for m in self._imported_modules() if m.split(".")[0] == "engine"
        }
        assert engine_mods <= self._ALLOWED_ENGINE_MODULES

    def test_aggregator_imported(self):
        assert "engine.strategies.aggregator" in self._imported_modules()

    def test_all_four_strategy_modules_imported(self):
        mods = self._imported_modules()
        assert "engine.strategies.frontier_strategy" in mods
        assert "engine.strategies.quality_size_strategy" in mods
        assert "engine.strategies.fundamental_weighted_strategy" in mods
        assert "engine.strategies.cross_factor_strategy" in mods

    def test_no_numpy_scipy_pandas_direct_import(self):
        tops = {m.split(".")[0] for m in self._imported_modules()}
        assert "numpy" not in tops
        assert "scipy" not in tops
        assert "pandas" not in tops

    def test_no_c_producer_import(self):
        for m in self._imported_modules():
            assert "phase8_compute_producer" not in m

    def test_no_orchestrator_caller_adapter_writer_import(self):
        for m in self._imported_modules():
            assert "phase8_compute_orchestrator" not in m
            assert "phase8_public_data_caller" not in m
            assert "phase8_presentation_adapter" not in m
            assert "phase8_json_writer" not in m

    def test_no_e_or_pf_cluster_import(self):
        # 機会損失 / 将来分岐 / DD-10% / PF builder cluster 非 import
        for m in self._imported_modules():
            assert "opportunity_loss" not in m
            assert "future_branching" not in m
            assert "dd10" not in m
            assert "pf_builder" not in m
            assert "unified_view" not in m

    def test_no_datetime_now_or_time_call(self):
        for node in ast.walk(self._tree()):
            if isinstance(node, ast.Call) and isinstance(
                node.func, ast.Attribute
            ):
                if node.func.attr in ("now", "utcnow"):
                    raise AssertionError("datetime.now()/utcnow() found")
                if node.func.attr == "time":
                    raise AssertionError("time.time() found")

    def test_no_public_data_path_literal(self):
        tree = self._tree()
        doc_ids = _docstring_node_ids(tree)
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if id(node) in doc_ids:
                    continue
                assert "public/data" not in node.value

    def test_no_forbidden_tokens_in_non_docstring_strings(self):
        tree = self._tree()
        doc_ids = _docstring_node_ids(tree)
        upper = ("BUY", "SELL", "HOLD", "WAIT")
        snake = (
            "is_buy", "is_sell", "is_hold", "is_recommended",
            "rebalance_order", "buy_amount", "sell_amount",
        )
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if id(node) in doc_ids:
                    continue
                v = node.value
                for tok in upper + snake:
                    assert tok not in v, f"forbidden {tok!r} in {v!r}"

    def test_docstring_declares_producer_group_member(self):
        import engine.operation.phase8_strategy_aggregate_producer as mod
        assert "producer 群の 2 つ目" in (mod.__doc__ or "")

    def test_produce_is_callable(self):
        assert callable(produce_strategy_aggregate_raw)


# ── TestNoPublicDataWrite ────────────────────────────────────────────────────

class TestNoPublicDataWrite:
    def _tree(self) -> ast.AST:
        return ast.parse(_module_source())

    def test_no_open_call(self):
        for node in ast.walk(self._tree()):
            if isinstance(node, ast.Call):
                f = node.func
                if isinstance(f, ast.Name) and f.id == "open":
                    raise AssertionError("open() call found")

    def test_no_write_attribute_call(self):
        for node in ast.walk(self._tree()):
            if isinstance(node, ast.Call) and isinstance(
                node.func, ast.Attribute
            ):
                assert node.func.attr not in (
                    "write", "write_text", "write_bytes",
                    "replace", "mkdir", "writelines",
                )

    def test_no_writer_caller_import(self):
        tree = ast.parse(_module_source())
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                assert "writer" not in node.module
                assert "caller" not in node.module

    def test_call_creates_no_file_in_cwd(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        before = set(os.listdir(tmp_path))
        produce_strategy_aggregate_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context=_phase8_context(),
        )
        assert set(os.listdir(tmp_path)) == before

    def test_return_contains_no_public_data_literal(self):
        flat = json.dumps(_produce_phase8())
        assert "public/data" not in flat


# ── TestInputHandling ────────────────────────────────────────────────────────

class TestInputHandling:
    def test_horizon_default_accepted(self):
        r = produce_strategy_aggregate_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context=_phase8_context(),
        )
        assert isinstance(r, dict)

    def test_explicit_horizon_accepted(self):
        r = _produce_phase8(horizon="short_term")
        assert set(r.keys()) == _TOP_KEYS

    def test_non_dict_scores_does_not_raise(self):
        r = produce_strategy_aggregate_raw(
            universe=("A", "B"), scores=None,
            regime="bull_calm", context={},
        )
        assert set(r["strategy_aggregate_raw"].keys()) == _AGGREGATE_KEYS

    def test_unknown_regime_does_not_raise(self):
        r = _produce_phase8(regime="not_a_regime")
        assert isinstance(r, dict)

    def test_keyword_only_enforced(self):
        with pytest.raises(TypeError):
            produce_strategy_aggregate_raw(  # type: ignore[misc]
                ("A", "B"), _BASIC_SCORES, "bull_calm",
            )

    def test_regime_passthrough_in_top_level(self):
        assert _produce_phase8(regime="crisis")["regime"] == "crisis"
