"""
test_phase8_analysis_producer.py — F: compute-actual-3 テスト

backend/engine/operation/phase8_analysis_producer.py の
produce_phase8_analysis_raw() を実 calculator（OpportunityLoss /
FutureBranching / DD10、全て pure stdlib・scipy 非依存）で検証する。

テスト配置の理由（Q1 決定 / P1-F-5）:
  F は scipy 非依存だが compute（3 calculator）を呼ぶ producer であり、
  test_operation 群の「compute 非呼出 / Flat-DI」思想を維持するため
  backend/tests/test_frontier/ に置く（compute-importing producer 群慣習：
  C→test_frontier / D→test_strategies / F→test_frontier）。
  backend/tests/test_operation/ には置かない。
"""
from __future__ import annotations

import ast
import json
import os

import pytest

from engine.operation.phase8_analysis_producer import (
    produce_phase8_analysis_raw,
)

# ── フィクスチャ（外部 DI 値、決定論）────────────────────────────────────────

_CURRENT_PF = {"A": 0.5, "B": 0.5}
_IDEAL_PF = {"A": 0.6, "B": 0.4}
_CONSTRAINED_IDEAL_PF = {"A": 0.55, "B": 0.45}
_ER_BY_TICKER = {"A": 0.08, "B": 0.03}
_PF_WEIGHTS = {"A": 0.55, "B": 0.45}
_REGIME_ER = {"bull_calm": 0.09, "bear": 0.03, "uncertain": 0.06}
_REGIME_VOL = {"bull_calm": 0.12, "bear": 0.20, "uncertain": 0.15}
_REGIME_DD = {"bull_calm": -0.08, "bear": -0.20, "uncertain": -0.12}
_REGIME_PROB = {"bull_calm": 0.5, "bear": 0.2, "uncertain": 0.3}
_DD10_RETURNS = [0.10, -0.05, 0.08, -0.03, 0.06]

_TOP_KEYS = {
    "opportunity_loss_raw",
    "future_branching_raw",
    "dd10_uniform_return",
    "regime",
    "diagnostics",
}

_OL_KEYS = {
    "weight_drift_per_ticker",
    "total_drift_l1",
    "total_drift_l2",
    "constraint_return_gap",
    "drift_return_gap",
    "estimated_opportunity_return_gap",
    "regime_used",
    "diagnostics",
}

_FB_KEYS = {
    "branches",
    "base_regime",
    "weighted_expected_return",
    "weighted_expected_vol",
    "worst_case_dd",
    "worst_case_downside",
    "best_case_upside",
    "diagnostics",
}


def _produce_valid(**overrides):
    kwargs = dict(
        current_pf=dict(_CURRENT_PF),
        ideal_pf=dict(_IDEAL_PF),
        constrained_ideal_pf=dict(_CONSTRAINED_IDEAL_PF),
        expected_return_by_ticker=dict(_ER_BY_TICKER),
        expected_vol=0.12,
        sharpe_ratio=0.7,
        pf_weights=dict(_PF_WEIGHTS),
        regime_expected_returns=dict(_REGIME_ER),
        regime_expected_vols=dict(_REGIME_VOL),
        regime_expected_max_dds=dict(_REGIME_DD),
        regime_probabilities=dict(_REGIME_PROB),
        downside_z_score=1.0,
        dd10_returns=list(_DD10_RETURNS),
        regime="bull_calm",
        base_regime="bull_calm",
    )
    kwargs.update(overrides)
    return produce_phase8_analysis_raw(**kwargs)


def _module_source() -> str:
    import engine.operation.phase8_analysis_producer as mod
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
        assert isinstance(_produce_valid(), dict)

    def test_exact_top_keys(self):
        assert set(_produce_valid().keys()) == _TOP_KEYS

    def test_opportunity_loss_raw_is_dict(self):
        assert isinstance(_produce_valid()["opportunity_loss_raw"], dict)

    def test_future_branching_raw_is_dict(self):
        assert isinstance(_produce_valid()["future_branching_raw"], dict)

    def test_dd10_uniform_return_is_float(self):
        assert isinstance(_produce_valid()["dd10_uniform_return"], float)

    def test_regime_is_str(self):
        assert isinstance(_produce_valid()["regime"], str)

    def test_diagnostics_is_list(self):
        assert isinstance(_produce_valid()["diagnostics"], list)

    def test_opportunity_loss_raw_eight_keys(self):
        assert set(_produce_valid()["opportunity_loss_raw"].keys()) == _OL_KEYS

    def test_future_branching_raw_eight_keys(self):
        assert set(_produce_valid()["future_branching_raw"].keys()) == _FB_KEYS

    def test_whole_return_json_serializable(self):
        json.loads(json.dumps(_produce_valid()))


# ── TestOpportunityLossRaw ───────────────────────────────────────────────────

class TestOpportunityLossRaw:
    def test_eight_keys_exact(self):
        assert set(_produce_valid()["opportunity_loss_raw"].keys()) == _OL_KEYS

    def test_weight_drift_per_ticker_is_list(self):
        ol = _produce_valid()["opportunity_loss_raw"]
        assert isinstance(ol["weight_drift_per_ticker"], list)

    def test_total_drift_l1_non_negative(self):
        ol = _produce_valid()["opportunity_loss_raw"]
        assert ol["total_drift_l1"] >= 0.0

    def test_total_drift_l2_non_negative(self):
        ol = _produce_valid()["opportunity_loss_raw"]
        assert ol["total_drift_l2"] >= 0.0

    def test_constraint_return_gap_is_number(self):
        ol = _produce_valid()["opportunity_loss_raw"]
        assert isinstance(ol["constraint_return_gap"], (int, float))

    def test_drift_return_gap_is_number(self):
        ol = _produce_valid()["opportunity_loss_raw"]
        assert isinstance(ol["drift_return_gap"], (int, float))

    def test_estimated_opportunity_return_gap_is_number(self):
        ol = _produce_valid()["opportunity_loss_raw"]
        assert isinstance(ol["estimated_opportunity_return_gap"], (int, float))

    def test_regime_used_is_str(self):
        ol = _produce_valid()["opportunity_loss_raw"]
        assert isinstance(ol["regime_used"], str)

    def test_diagnostics_is_list(self):
        ol = _produce_valid()["opportunity_loss_raw"]
        assert isinstance(ol["diagnostics"], list)

    def test_json_serializable(self):
        ol = _produce_valid()["opportunity_loss_raw"]
        assert set(json.loads(json.dumps(ol)).keys()) == _OL_KEYS

    def test_weight_drift_entries_are_pairs(self):
        ol = _produce_valid()["opportunity_loss_raw"]
        for entry in ol["weight_drift_per_ticker"]:
            assert len(entry) == 2


# ── TestFutureBranchingRaw ───────────────────────────────────────────────────

class TestFutureBranchingRaw:
    def test_eight_keys_exact(self):
        assert set(_produce_valid()["future_branching_raw"].keys()) == _FB_KEYS

    def test_branches_is_list(self):
        fb = _produce_valid()["future_branching_raw"]
        assert isinstance(fb["branches"], list)

    def test_branches_length_five(self):
        fb = _produce_valid()["future_branching_raw"]
        assert len(fb["branches"]) == 5

    def test_base_regime_is_str(self):
        fb = _produce_valid()["future_branching_raw"]
        assert isinstance(fb["base_regime"], str)

    def test_weighted_expected_return_is_number(self):
        fb = _produce_valid()["future_branching_raw"]
        assert isinstance(fb["weighted_expected_return"], (int, float))

    def test_weighted_expected_vol_non_negative(self):
        fb = _produce_valid()["future_branching_raw"]
        assert fb["weighted_expected_vol"] >= 0.0

    def test_worst_case_dd_non_positive(self):
        fb = _produce_valid()["future_branching_raw"]
        assert fb["worst_case_dd"] <= 0.0

    def test_worst_case_downside_is_number(self):
        fb = _produce_valid()["future_branching_raw"]
        assert isinstance(fb["worst_case_downside"], (int, float))

    def test_best_case_upside_is_number(self):
        fb = _produce_valid()["future_branching_raw"]
        assert isinstance(fb["best_case_upside"], (int, float))

    def test_diagnostics_is_list(self):
        fb = _produce_valid()["future_branching_raw"]
        assert isinstance(fb["diagnostics"], list)

    def test_json_serializable(self):
        fb = _produce_valid()["future_branching_raw"]
        assert set(json.loads(json.dumps(fb)).keys()) == _FB_KEYS

    def test_regime_expected_max_dds_mapped(self):
        # regime_expected_max_dds → FutureBranchingInput.regime_max_dds
        # 渡しても渡さなくても 8 キー dict が生成される（マップ成立）
        r = _produce_valid(regime_expected_max_dds={"bull_calm": -0.05})
        assert set(r["future_branching_raw"].keys()) == _FB_KEYS


# ── TestDD10UniformReturn ────────────────────────────────────────────────────

class TestDD10UniformReturn:
    def test_is_float(self):
        assert isinstance(_produce_valid()["dd10_uniform_return"], float)

    def test_not_a_dict(self):
        assert not isinstance(_produce_valid()["dd10_uniform_return"], dict)

    def test_valid_returns_produce_value(self):
        v = _produce_valid()["dd10_uniform_return"]
        assert isinstance(v, float)

    def test_missing_returns_zero_fallback(self):
        r = _produce_valid(dd10_returns=None)
        assert r["dd10_uniform_return"] == 0.0

    def test_empty_returns_zero_fallback(self):
        r = _produce_valid(dd10_returns=[])
        assert r["dd10_uniform_return"] == 0.0

    def test_non_list_returns_zero_fallback(self):
        r = _produce_valid(dd10_returns="not_a_list")
        assert r["dd10_uniform_return"] == 0.0

    def test_missing_returns_emits_diagnostic(self):
        r = _produce_valid(dd10_returns=None)
        assert any("dd10_returns missing" in d for d in r["diagnostics"])

    def test_deterministic(self):
        assert (
            _produce_valid()["dd10_uniform_return"]
            == _produce_valid()["dd10_uniform_return"]
        )

    def test_no_dd10kpiresult_leak_in_top(self):
        # dd10 は単一 float のみ。to_dict 全体（scale_factor 等）は露出しない
        r = _produce_valid()
        assert "scale_factor" not in r
        assert "actual_max_drawdown" not in r


# ── TestMissingInputFallback ─────────────────────────────────────────────────

class TestMissingInputFallback:
    def test_all_missing_still_valid_top_keys(self):
        r = produce_phase8_analysis_raw(regime="bear")
        assert set(r.keys()) == _TOP_KEYS

    def test_missing_current_pf_ol_eight_keys(self):
        r = _produce_valid(current_pf=None)
        assert set(r["opportunity_loss_raw"].keys()) == _OL_KEYS

    def test_missing_ideal_pf_ol_eight_keys(self):
        r = _produce_valid(ideal_pf=None)
        assert set(r["opportunity_loss_raw"].keys()) == _OL_KEYS

    def test_missing_constrained_ol_eight_keys(self):
        r = _produce_valid(constrained_ideal_pf=None)
        assert set(r["opportunity_loss_raw"].keys()) == _OL_KEYS

    def test_missing_er_by_ticker_ol_eight_keys(self):
        r = _produce_valid(expected_return_by_ticker=None)
        assert set(r["opportunity_loss_raw"].keys()) == _OL_KEYS

    def test_missing_pf_weights_fb_eight_keys(self):
        r = _produce_valid(pf_weights=None)
        assert set(r["future_branching_raw"].keys()) == _FB_KEYS

    def test_missing_regime_tables_fb_eight_keys(self):
        r = _produce_valid(
            regime_expected_returns=None,
            regime_expected_vols=None,
            regime_expected_max_dds=None,
            regime_probabilities=None,
        )
        assert set(r["future_branching_raw"].keys()) == _FB_KEYS

    def test_missing_dd10_zero(self):
        r = _produce_valid(dd10_returns=None)
        assert r["dd10_uniform_return"] == 0.0

    def test_missing_inputs_emit_not_fabricated_diagnostic(self):
        r = produce_phase8_analysis_raw(regime="bear")
        assert any("not fabricated" in d for d in r["diagnostics"])

    def test_missing_current_pf_specific_diagnostic(self):
        r = _produce_valid(current_pf=None)
        assert any("current_pf not provided" in d for d in r["diagnostics"])

    def test_non_dict_regime_table_safe(self):
        r = _produce_valid(regime_probabilities="bad")
        assert set(r["future_branching_raw"].keys()) == _FB_KEYS

    def test_downside_z_score_none_safe(self):
        r = _produce_valid(downside_z_score=None)
        assert set(r["future_branching_raw"].keys()) == _FB_KEYS


# ── TestObservationDiagnostics ───────────────────────────────────────────────

class TestObservationDiagnostics:
    def test_all_observation_prefixed_valid(self):
        for d in _produce_valid()["diagnostics"]:
            assert d.startswith("observation: ")

    def test_all_observation_prefixed_missing(self):
        r = produce_phase8_analysis_raw(regime="bear")
        for d in r["diagnostics"]:
            assert d.startswith("observation: ")

    def test_diagnostics_non_empty(self):
        assert len(_produce_valid()["diagnostics"]) >= 1

    def test_diagnostics_all_str(self):
        assert all(isinstance(d, str) for d in _produce_valid()["diagnostics"])

    def test_real_calculator_diagnostic_present(self):
        diags = " ".join(_produce_valid()["diagnostics"])
        assert "real calculators" in diags

    def test_no_forbidden_words_in_producer_diagnostics(self):
        diags = " ".join(produce_phase8_analysis_raw(regime="bear")["diagnostics"])
        for tok in ("BUY", "SELL", "HOLD", "WAIT"):
            assert tok not in diags


# ── TestContextInputNonMutation ──────────────────────────────────────────────

class TestContextInputNonMutation:
    def test_context_not_mutated(self):
        ctx = {"k": 1, "nested": {"x": 2}}
        produce_phase8_analysis_raw(regime="bull_calm", context=ctx)
        assert ctx == {"k": 1, "nested": {"x": 2}}

    def test_current_pf_not_mutated(self):
        cp = {"A": 0.5, "B": 0.5}
        _produce_valid(current_pf=cp)
        assert cp == {"A": 0.5, "B": 0.5}

    def test_ideal_pf_not_mutated(self):
        ip = {"A": 0.6, "B": 0.4}
        _produce_valid(ideal_pf=ip)
        assert ip == {"A": 0.6, "B": 0.4}

    def test_constrained_pf_not_mutated(self):
        cp = {"A": 0.55, "B": 0.45}
        _produce_valid(constrained_ideal_pf=cp)
        assert cp == {"A": 0.55, "B": 0.45}

    def test_er_by_ticker_not_mutated(self):
        er = {"A": 0.08, "B": 0.03}
        _produce_valid(expected_return_by_ticker=er)
        assert er == {"A": 0.08, "B": 0.03}

    def test_pf_weights_not_mutated(self):
        pw = {"A": 0.55, "B": 0.45}
        _produce_valid(pf_weights=pw)
        assert pw == {"A": 0.55, "B": 0.45}

    def test_regime_tables_not_mutated(self):
        er = dict(_REGIME_ER)
        _produce_valid(regime_expected_returns=er)
        assert er == _REGIME_ER

    def test_dd10_returns_not_mutated(self):
        rr = list(_DD10_RETURNS)
        _produce_valid(dd10_returns=rr)
        assert rr == list(_DD10_RETURNS)

    def test_none_context_does_not_raise(self):
        r = produce_phase8_analysis_raw(regime="bull_calm", context=None)
        assert isinstance(r, dict)


# ── TestDeterminism ──────────────────────────────────────────────────────────

class TestDeterminism:
    def test_opportunity_loss_deterministic(self):
        assert (
            _produce_valid()["opportunity_loss_raw"]
            == _produce_valid()["opportunity_loss_raw"]
        )

    def test_future_branching_deterministic(self):
        assert (
            _produce_valid()["future_branching_raw"]
            == _produce_valid()["future_branching_raw"]
        )

    def test_dd10_deterministic(self):
        assert (
            _produce_valid()["dd10_uniform_return"]
            == _produce_valid()["dd10_uniform_return"]
        )

    def test_repeated_calls_distinct_objects(self):
        a = _produce_valid()
        b = _produce_valid()
        assert a is not b
        assert a["opportunity_loss_raw"] is not b["opportunity_loss_raw"]


# ── TestStaticComputeBoundary（AST）──────────────────────────────────────────

class TestStaticComputeBoundary:
    """real calculator 境界・禁止 import / token を AST で検証する。"""

    _ALLOWED_ENGINE_MODULES = {
        "engine.decision.dd10_kpi",
        "engine.frontier.future_branching",
        "engine.frontier.opportunity_loss_calc",
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

    def test_three_calculators_imported(self):
        mods = self._imported_modules()
        assert "engine.decision.dd10_kpi" in mods
        assert "engine.frontier.future_branching" in mods
        assert "engine.frontier.opportunity_loss_calc" in mods

    def test_no_numpy_scipy_pandas_direct_import(self):
        tops = {m.split(".")[0] for m in self._imported_modules()}
        assert "numpy" not in tops
        assert "scipy" not in tops
        assert "pandas" not in tops

    def test_no_cd_producer_import(self):
        for m in self._imported_modules():
            assert "phase8_compute_producer" not in m
            assert "phase8_strategy_aggregate_producer" not in m

    def test_no_orchestrator_caller_adapter_writer_import(self):
        for m in self._imported_modules():
            assert "phase8_compute_orchestrator" not in m
            assert "phase8_public_data_caller" not in m
            assert "phase8_presentation_adapter" not in m
            assert "phase8_json_writer" not in m

    def test_no_strategy_aggregate_pf_builder_import(self):
        for m in self._imported_modules():
            assert "strategies" not in m
            assert "aggregator" not in m
            assert "pf_builder" not in m
            assert "unified_view" not in m
            assert "efficient_frontier" not in m

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
        import engine.operation.phase8_analysis_producer as mod
        assert "producer 群の 3 つ目" in (mod.__doc__ or "")

    def test_produce_is_callable(self):
        assert callable(produce_phase8_analysis_raw)

    def test_test_file_no_sci_stack_import(self):
        with open(__file__) as fh:
            src = fh.read()
        tree = ast.parse(src)
        tops: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    tops.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    tops.add(node.module.split(".")[0])
        assert "numpy" not in tops
        assert "scipy" not in tops
        assert "pandas" not in tops


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
        _produce_valid()
        assert set(os.listdir(tmp_path)) == before

    def test_return_contains_no_public_data_literal(self):
        flat = json.dumps(_produce_valid())
        assert "public/data" not in flat


# ── TestInputHandling ────────────────────────────────────────────────────────

class TestInputHandling:
    def test_regime_required_keyword(self):
        with pytest.raises(TypeError):
            produce_phase8_analysis_raw()  # type: ignore[call-arg]

    def test_keyword_only_enforced(self):
        with pytest.raises(TypeError):
            produce_phase8_analysis_raw("bull_calm")  # type: ignore[misc]

    def test_horizon_default_accepted(self):
        r = produce_phase8_analysis_raw(regime="bull_calm")
        assert set(r.keys()) == _TOP_KEYS

    def test_explicit_horizon_accepted(self):
        r = _produce_valid(horizon="short_term")
        assert set(r.keys()) == _TOP_KEYS

    def test_base_regime_none_falls_back_to_regime(self):
        r = _produce_valid(base_regime=None, regime="bear")
        assert r["regime"] == "bear"

    def test_regime_echoed_in_top(self):
        assert _produce_valid(regime="crisis")["regime"] == "crisis"

    def test_empty_regime_string_safe(self):
        r = produce_phase8_analysis_raw(regime="")
        assert set(r.keys()) == _TOP_KEYS
