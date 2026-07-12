"""
test_phase8_input_orchestrator.py — compute-orchestration（入力配線）テスト

backend/engine/operation/phase8_input_orchestrator.py の
assemble_phase8_public_data_inputs() を fixture returns_doc dict で検証する。

テスト配置の理由:
  本層は resolver + C/D/F/PF split producer を横断する cross-domain
  integration であり、FrontierStrategy Phase 8 経由で scipy/SLSQP が
  test path に入る。test_operation の compute 非呼出 / stdlib 思想を
  壊さないため backend/tests/test_integration/ に置く
  （test_phase8_pipeline_e2e.py と同系統）。
"""
from __future__ import annotations

import ast
import json
import os

import pytest

from engine.operation.phase8_input_orchestrator import (
    assemble_phase8_public_data_inputs,
)

_TOP_KEYS = {
    "frontier_index_raw",
    "strategy_aggregate_raw",
    "strategy_outputs",
    "opportunity_loss_raw",
    "future_branching_raw",
    "dd10_uniform_return",
    "frontier_cash_pct",
    "frontier_fund_pct",
    "resolver_diagnostics",
    "diagnostics",
}

_SCORES = {
    "A": {
        "value": {"total": 65.0}, "quality": {"total": 70.0},
        "growth": {"total": 55.0}, "safety": {"total": 60.0},
        "momentum": {"total": 50.0}, "shareholder_return": {"total": 45.0},
    },
    "B": {
        "value": {"total": 50.0}, "quality": {"total": 60.0},
        "growth": {"total": 65.0}, "safety": {"total": 75.0},
        "momentum": {"total": 55.0}, "shareholder_return": {"total": 50.0},
    },
}

_RETURNS_DOC = {
    "_meta": {"version": "v13.3", "kind": "returns_daily",
              "source": "yfinance"},
    "tickers": ["A", "B"],
    "missing": [],
    "returns": {
        "A": [0.10, -0.05, 0.08, -0.03, 0.06],
        "B": [0.02, -0.01, 0.03, -0.01, 0.02],
    },
}

_ACCOUNT_HOLDINGS = [
    {"account_id": "sbi", "ticker_or_code": "A",
     "current_weight": 0.30, "asset_class": "domestic_equity"},
    {"account_id": "sbi", "ticker_or_code": "F1",
     "current_weight": 0.20, "asset_class": "domestic_fund"},
]


def _assemble(**overrides):
    kwargs = dict(
        returns_doc={
            "_meta": dict(_RETURNS_DOC["_meta"]),
            "tickers": list(_RETURNS_DOC["tickers"]),
            "missing": [],
            "returns": {k: list(v) for k, v in _RETURNS_DOC["returns"].items()},
        },
        universe=("A", "B"),
        scores=_SCORES,
        regime="bull_calm",
        base_context={"mean_return_3y_by_ticker": {"A": 0.08, "B": 0.03},
                      "shrinkage_alpha": 0.0},
        pf_weights={"A": 0.6, "B": 0.4},
        current_pf={"A": 0.5, "B": 0.5},
        ideal_pf={"A": 0.6, "B": 0.4},
        constrained_ideal_pf={"A": 0.55, "B": 0.45},
        expected_return_by_ticker={"A": 0.08, "B": 0.03},
        account_holdings=[dict(h) for h in _ACCOUNT_HOLDINGS],
        cash_weight=0.10,
        regime_expected_returns={"bull_calm": 0.09, "bear": 0.03},
        regime_expected_vols={"bull_calm": 0.12, "bear": 0.20},
        regime_expected_max_dds={"bull_calm": -0.08, "bear": -0.20},
        regime_probabilities={"bull_calm": 0.6, "bear": 0.4},
    )
    kwargs.update(overrides)
    return assemble_phase8_public_data_inputs(**kwargs)


def _module_source() -> str:
    import engine.operation.phase8_input_orchestrator as mod
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


# ── TestAssembleContract ─────────────────────────────────────────────────────

class TestAssembleContract:
    def test_returns_dict(self):
        assert isinstance(_assemble(), dict)

    def test_exact_top_keys(self):
        assert set(_assemble().keys()) == _TOP_KEYS

    def test_strategy_aggregate_raw_is_dict(self):
        assert isinstance(_assemble()["strategy_aggregate_raw"], dict)

    def test_strategy_outputs_is_dict(self):
        assert isinstance(_assemble()["strategy_outputs"], dict)

    def test_opportunity_loss_raw_is_dict(self):
        assert isinstance(_assemble()["opportunity_loss_raw"], dict)

    def test_future_branching_raw_is_dict(self):
        assert isinstance(_assemble()["future_branching_raw"], dict)

    def test_dd10_uniform_return_is_number(self):
        assert isinstance(_assemble()["dd10_uniform_return"], (int, float))

    def test_cash_fund_pct_floats(self):
        r = _assemble()
        assert isinstance(r["frontier_cash_pct"], float)
        assert isinstance(r["frontier_fund_pct"], float)

    def test_resolver_diagnostics_is_list(self):
        assert isinstance(_assemble()["resolver_diagnostics"], list)

    def test_diagnostics_is_list(self):
        assert isinstance(_assemble()["diagnostics"], list)

    def test_json_serializable(self):
        json.loads(json.dumps(_assemble()))


# ── TestPhase8Path ───────────────────────────────────────────────────────────

class TestPhase8Path:
    def test_frontier_index_raw_is_dict(self):
        assert isinstance(_assemble()["frontier_index_raw"], dict)

    def test_frontier_index_raw_nine_keys(self):
        fi = _assemble()["frontier_index_raw"]
        assert set(fi.keys()) == {
            "index_name", "tickers", "weights", "expected_return",
            "expected_vol", "sharpe_ratio", "regime_used",
            "calculation_date", "diagnostics",
        }

    def test_strategy_aggregate_ten_keys(self):
        agg = _assemble()["strategy_aggregate_raw"]
        assert len(agg) == 10

    def test_strategy_outputs_four(self):
        so = _assemble()["strategy_outputs"]
        assert set(so.keys()) == {
            "frontier", "quality_size", "fundamental", "cross_factor",
        }

    def test_opportunity_loss_eight_keys(self):
        assert len(_assemble()["opportunity_loss_raw"]) == 8

    def test_future_branching_eight_keys(self):
        assert len(_assemble()["future_branching_raw"]) == 8

    def test_phase8_diagnostic_note(self):
        diags = " ".join(_assemble()["diagnostics"])
        assert "Phase 8 path expected" in diags

    def test_assembled_diagnostic_note(self):
        diags = " ".join(_assemble()["diagnostics"])
        assert "phase8 inputs assembled" in diags


# ── TestMissingSafe ──────────────────────────────────────────────────────────

class TestMissingSafe:
    def test_none_returns_doc_phase7_fallback(self):
        r = _assemble(returns_doc=None)
        assert r["frontier_index_raw"] is None

    def test_none_returns_doc_aggregate_still_ten(self):
        r = _assemble(returns_doc=None)
        assert len(r["strategy_aggregate_raw"]) == 10

    def test_none_returns_doc_dd10_zero(self):
        r = _assemble(returns_doc=None)
        assert r["dd10_uniform_return"] == 0.0

    def test_non_dict_returns_doc_safe(self):
        r = _assemble(returns_doc="garbage")
        assert r["frontier_index_raw"] is None
        assert set(r.keys()) == _TOP_KEYS

    def test_empty_returns_doc_safe(self):
        r = _assemble(returns_doc={"returns": {}})
        assert r["frontier_index_raw"] is None

    def test_degrade_diagnostic_present(self):
        r = _assemble(returns_doc=None)
        assert any("degrade to" in d for d in r["diagnostics"])

    def test_missing_safe_still_json_serializable(self):
        json.loads(json.dumps(_assemble(returns_doc=None)))

    def test_missing_safe_pf_split_still_present(self):
        r = _assemble(returns_doc=None)
        assert isinstance(r["frontier_cash_pct"], float)


# ── TestResolverWiring ───────────────────────────────────────────────────────

class TestResolverWiring:
    def test_returns_doc_triggers_phase8(self):
        # returns_doc 供給で frontier Phase 8（frontier_index_raw dict）
        assert isinstance(_assemble()["frontier_index_raw"], dict)

    def test_resolver_diagnostics_surfaced(self):
        rd = _assemble()["resolver_diagnostics"]
        assert len(rd) >= 1
        assert all(d.startswith("observation: ") for d in rd)

    def test_resolver_diag_separate_from_top(self):
        r = _assemble()
        # resolver_diagnostics は top diagnostics と別キー
        assert r["resolver_diagnostics"] is not r["diagnostics"]

    def test_dd10_returns_flows_to_f(self):
        # pf_weights + returns_doc → resolver dd10_returns → F が値を出す
        r = _assemble()
        assert isinstance(r["dd10_uniform_return"], (int, float))

    def test_dot_t_normalization_via_resolver(self):
        doc = {
            "returns": {"A.T": [0.10, -0.05, 0.08, -0.03, 0.06],
                        "B.T": [0.02, -0.01, 0.03, -0.01, 0.02]},
        }
        r = _assemble(returns_doc=doc)
        # ".T" 正規化で A/B にマッチ → Phase 8 path
        assert isinstance(r["frontier_index_raw"], dict)

    def test_resolver_missing_diagnostic_when_empty(self):
        r = _assemble(returns_doc={"returns": {}})
        joined = " ".join(r["diagnostics"])
        assert "missing-safe" in joined


# ── TestPFSplitWiring ────────────────────────────────────────────────────────

class TestPFSplitWiring:
    def test_cash_pct_from_account_holdings(self):
        assert _assemble(cash_weight=0.10)["frontier_cash_pct"] == 0.10

    def test_fund_pct_from_account_holdings(self):
        # domestic_fund 0.20
        assert _assemble()["frontier_fund_pct"] == pytest.approx(0.20)

    def test_cash_pct_changes_with_di(self):
        assert _assemble(cash_weight=0.25)["frontier_cash_pct"] == 0.25

    def test_missing_holdings_zero(self):
        r = _assemble(account_holdings=None, cash_weight=0.0)
        assert r["frontier_fund_pct"] == 0.0


# ── TestNonMutation ──────────────────────────────────────────────────────────

class TestNonMutation:
    def test_base_context_not_mutated(self):
        bc = {"mean_return_3y_by_ticker": {"A": 0.08}, "shrinkage_alpha": 0.0}
        _assemble(base_context=bc)
        assert "returns_data" not in bc
        assert bc == {"mean_return_3y_by_ticker": {"A": 0.08},
                      "shrinkage_alpha": 0.0}

    def test_returns_doc_not_mutated(self):
        import copy
        doc = copy.deepcopy(_RETURNS_DOC)
        snap = copy.deepcopy(doc)
        _assemble(returns_doc=doc)
        assert doc == snap

    def test_scores_not_mutated(self):
        import copy
        sc = copy.deepcopy(_SCORES)
        snap = copy.deepcopy(sc)
        _assemble(scores=sc)
        assert sc == snap

    def test_pf_weights_not_mutated(self):
        pw = {"A": 0.6, "B": 0.4}
        _assemble(pf_weights=pw)
        assert pw == {"A": 0.6, "B": 0.4}

    def test_account_holdings_not_mutated(self):
        h = [dict(x) for x in _ACCOUNT_HOLDINGS]
        snap = [dict(x) for x in h]
        _assemble(account_holdings=h)
        assert h == snap

    def test_none_base_context_safe(self):
        r = _assemble(base_context=None)
        assert set(r.keys()) == _TOP_KEYS


# ── TestDiagnostics ──────────────────────────────────────────────────────────

class TestDiagnostics:
    def test_top_diagnostics_observation_prefixed(self):
        for d in _assemble()["diagnostics"]:
            assert d.startswith("observation: ")

    def test_top_diagnostics_observation_prefixed_missing(self):
        for d in _assemble(returns_doc=None)["diagnostics"]:
            assert d.startswith("observation: ")

    def test_resolver_diagnostics_observation_prefixed(self):
        for d in _assemble()["resolver_diagnostics"]:
            assert d.startswith("observation: ")

    def test_diagnostics_non_empty(self):
        assert len(_assemble()["diagnostics"]) >= 1

    def test_diagnostics_all_str(self):
        assert all(isinstance(d, str) for d in _assemble()["diagnostics"])

    def test_no_forbidden_words_in_top_diagnostics(self):
        blob = " ".join(_assemble()["diagnostics"])
        for tok in ("BUY", "SELL", "HOLD", "WAIT"):
            assert tok not in blob


# ── TestStaticBoundary（AST）──────────────────────────────────────────────────

class TestStaticBoundary:
    _ALLOWED_ENGINE = {
        "engine.operation.phase8_analysis_producer",
        "engine.operation.phase8_compute_producer",
        "engine.operation.phase8_pf_split_producer",
        "engine.operation.phase8_returns_resolver",
        "engine.operation.phase8_strategy_aggregate_producer",
    }

    def _tree(self) -> ast.AST:
        return ast.parse(_module_source())

    def _imported(self) -> set[str]:
        mods: set[str] = set()
        for node in ast.walk(self._tree()):
            if isinstance(node, ast.Import):
                for a in node.names:
                    mods.add(a.name)
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    mods.add(node.module)
        return mods

    def test_engine_imports_subset_allowed(self):
        eng = {m for m in self._imported() if m.split(".")[0] == "engine"}
        assert eng <= self._ALLOWED_ENGINE

    def test_no_numpy_scipy_pandas_direct_import(self):
        tops = {m.split(".")[0] for m in self._imported()}
        assert "numpy" not in tops
        assert "scipy" not in tops
        assert "pandas" not in tops

    def test_no_orchestrator_caller_adapter_writer_import(self):
        for m in self._imported():
            assert "phase8_compute_orchestrator" not in m
            assert "phase8_public_data_caller" not in m
            assert "phase8_presentation_adapter" not in m
            assert "phase8_json_writer" not in m

    def test_no_write_or_orchestrate_call(self):
        for node in ast.walk(self._tree()):
            if isinstance(node, ast.Call):
                f = node.func
                if isinstance(f, ast.Name):
                    assert f.id not in (
                        "orchestrate_phase8_public_data",
                        "write_json_atomic", "open",
                    )
                if isinstance(f, ast.Attribute):
                    assert f.attr not in (
                        "write", "write_text", "write_bytes",
                        "replace", "mkdir",
                    )

    def test_no_pathlib_import(self):
        assert "pathlib" not in {m.split(".")[0] for m in self._imported()}

    def test_no_datetime_now_or_time_call(self):
        for node in ast.walk(self._tree()):
            if isinstance(node, ast.Call) and isinstance(
                node.func, ast.Attribute
            ):
                if node.func.attr in ("now", "utcnow"):
                    raise AssertionError("datetime.now()/utcnow() found")
                if node.func.attr == "time":
                    raise AssertionError("time.time() found")

    def test_no_public_data_or_returns_path_literal(self):
        tree = self._tree()
        doc_ids = _docstring_node_ids(tree)
        needle_pd = "public" + "/" + "data"
        needle_dr = "data" + "/" + "returns"
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if id(node) in doc_ids:
                    continue
                assert needle_pd not in node.value
                assert needle_dr not in node.value

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

    def test_docstring_declares_assemble_only(self):
        import engine.operation.phase8_input_orchestrator as mod
        assert "assemble-only" in (mod.__doc__ or "")

    def test_assemble_is_callable(self):
        assert callable(assemble_phase8_public_data_inputs)


# ── TestNoPublicDataWrite ────────────────────────────────────────────────────

class TestNoPublicDataWrite:
    def test_call_creates_no_file_in_cwd(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        before = set(os.listdir(tmp_path))
        _assemble()
        assert set(os.listdir(tmp_path)) == before

    def test_output_has_no_public_data_literal(self):
        flat = json.dumps(_assemble())
        assert ("public" + "/" + "data") not in flat

    def test_returns_json_not_generated(self):
        _assemble()
        assert not os.path.isfile("data/returns.json")
        assert not os.path.isfile("data/returns_backup.json")


# ── TestInputHandling ────────────────────────────────────────────────────────

class TestInputHandling:
    def test_keyword_only_enforced(self):
        with pytest.raises(TypeError):
            assemble_phase8_public_data_inputs(  # type: ignore[misc]
                None, ("A",), _SCORES, "bull_calm",
            )

    def test_regime_required(self):
        with pytest.raises(TypeError):
            assemble_phase8_public_data_inputs(  # type: ignore[call-arg]
                universe=("A",), scores=_SCORES,
            )

    def test_horizon_default(self):
        r = _assemble()
        assert set(r.keys()) == _TOP_KEYS

    def test_ticker_normalize_false(self):
        # ".T" 無し fixture なので normalize=False でも Phase 8 成立
        r = _assemble(ticker_normalize=False)
        assert isinstance(r["frontier_index_raw"], dict)

    def test_empty_universe_safe(self):
        r = assemble_phase8_public_data_inputs(
            returns_doc=None, universe=(), scores={}, regime="bull_calm",
        )
        assert set(r.keys()) == _TOP_KEYS

    def test_deterministic(self):
        a = _assemble()
        b = _assemble()
        assert a["strategy_aggregate_raw"] == b["strategy_aggregate_raw"]
        assert a["frontier_index_raw"] == b["frontier_index_raw"]
