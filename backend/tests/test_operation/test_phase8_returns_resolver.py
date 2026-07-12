"""
test_phase8_returns_resolver.py — D: returns DI resolver テスト

backend/engine/operation/phase8_returns_resolver.py の
resolve_phase8_returns_di() を fixture dict で検証する。

テスト配置の理由:
  resolver は pure stdlib・Flat-DI dict-in・file io なし・実 compute 非呼出
  であり test_operation の思想（stdlib-only / Flat DI / 実 compute 非呼出 /
  numpy/scipy/pandas import なし / public/data 非書き込み）に合致するため
  backend/tests/test_operation/ に置く（compute import する producer 群＝
  test_frontier/strategies/portfolio とは別系統）。
"""
from __future__ import annotations

import ast
import json
import math

import pytest

from backend.engine.operation.phase8_returns_resolver import (
    resolve_phase8_returns_di,
)

_TOP_KEYS = {"returns_data", "dd10_returns", "missing", "diagnostics"}


def _doc(**overrides):
    base = {
        "_meta": {"version": "v13.3", "kind": "returns_daily",
                  "source": "yfinance"},
        "tickers": ["6098.T", "8306.T", "9697.T"],
        "missing": [],
        "returns": {
            "6098.T": [0.01, -0.02, 0.03, 0.00],
            "8306.T": [0.02, -0.01, 0.01, 0.02],
            "9697.T": [0.005, 0.004, -0.003, 0.006],
        },
    }
    base.update(overrides)
    return base


def _module_source() -> str:
    import backend.engine.operation.phase8_returns_resolver as mod
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


# ── TestContract ─────────────────────────────────────────────────────────────

class TestContract:
    def test_returns_dict(self):
        assert isinstance(resolve_phase8_returns_di(_doc()), dict)

    def test_exact_top_keys(self):
        assert set(resolve_phase8_returns_di(_doc()).keys()) == _TOP_KEYS

    def test_returns_data_is_dict(self):
        assert isinstance(resolve_phase8_returns_di(_doc())["returns_data"], dict)

    def test_dd10_returns_is_list(self):
        assert isinstance(resolve_phase8_returns_di(_doc())["dd10_returns"], list)

    def test_missing_is_list(self):
        assert isinstance(resolve_phase8_returns_di(_doc())["missing"], list)

    def test_diagnostics_is_list(self):
        assert isinstance(resolve_phase8_returns_di(_doc())["diagnostics"], list)

    def test_json_serializable(self):
        json.loads(json.dumps(resolve_phase8_returns_di(_doc(), pf_weights={"6098.T": 1.0})))

    def test_keyword_only_enforced(self):
        with pytest.raises(TypeError):
            resolve_phase8_returns_di(_doc(), ["6098"])  # type: ignore[misc]


# ── TestReturnsData ──────────────────────────────────────────────────────────

class TestReturnsData:
    def test_dot_t_stripped_default(self):
        rd = resolve_phase8_returns_di(_doc())["returns_data"]
        assert set(rd.keys()) == {"6098", "8306", "9697"}

    def test_ticker_normalize_false_keeps_suffix(self):
        rd = resolve_phase8_returns_di(_doc(), ticker_normalize=False)["returns_data"]
        assert set(rd.keys()) == {"6098.T", "8306.T", "9697.T"}

    def test_series_pass_through(self):
        rd = resolve_phase8_returns_di(_doc())["returns_data"]
        assert rd["6098"] == [0.01, -0.02, 0.03, 0.00]

    def test_universe_filter_normalized(self):
        rd = resolve_phase8_returns_di(_doc(), universe=["6098", "8306"])["returns_data"]
        assert set(rd.keys()) == {"6098", "8306"}

    def test_universe_filter_with_dot_t_input(self):
        rd = resolve_phase8_returns_di(_doc(), universe=["6098.T"])["returns_data"]
        assert set(rd.keys()) == {"6098"}

    def test_universe_non_list_ignored(self):
        r = resolve_phase8_returns_di(_doc(), universe="6098")
        assert set(r["returns_data"].keys()) == {"6098", "8306", "9697"}
        assert any("universe is not" in d for d in r["diagnostics"])

    def test_nan_dropped(self):
        d = _doc(returns={"6098.T": [0.01, float("nan"), 0.03]})
        rd = resolve_phase8_returns_di(d)["returns_data"]
        assert rd["6098"] == [0.01, 0.03]

    def test_inf_dropped(self):
        d = _doc(returns={"6098.T": [0.01, float("inf"), -float("inf"), 0.02]})
        rd = resolve_phase8_returns_di(d)["returns_data"]
        assert rd["6098"] == [0.01, 0.02]

    def test_non_number_dropped(self):
        d = _doc(returns={"6098.T": [0.01, "x", None, 0.02]})
        rd = resolve_phase8_returns_di(d)["returns_data"]
        assert rd["6098"] == [0.01, 0.02]

    def test_bool_not_treated_as_number(self):
        d = _doc(returns={"6098.T": [0.01, True, False, 0.02]})
        rd = resolve_phase8_returns_di(d)["returns_data"]
        assert rd["6098"] == [0.01, 0.02]

    def test_dropped_emits_diagnostic(self):
        d = _doc(returns={"6098.T": [0.01, float("nan"), 0.02]})
        r = resolve_phase8_returns_di(d)
        assert any("non-finite/non-number sample" in x for x in r["diagnostics"])

    def test_int_returns_coerced_to_float(self):
        d = _doc(returns={"6098.T": [1, 2, 3]})
        rd = resolve_phase8_returns_di(d)["returns_data"]
        assert rd["6098"] == [1.0, 2.0, 3.0]
        assert all(isinstance(x, float) for x in rd["6098"])

    def test_int_keys_stringified(self):
        d = _doc(returns={7011: [0.01, 0.02]})
        rd = resolve_phase8_returns_di(d)["returns_data"]
        assert "7011" in rd


# ── TestMissing ──────────────────────────────────────────────────────────────

class TestMissing:
    def test_empty_series_missing(self):
        d = _doc(returns={"6098.T": [], "8306.T": [0.01]})
        r = resolve_phase8_returns_di(d)
        assert "6098" in r["missing"]
        assert "6098" not in r["returns_data"]

    def test_all_nonfinite_series_missing(self):
        d = _doc(returns={"6098.T": [float("nan"), "x", None]})
        r = resolve_phase8_returns_di(d)
        assert "6098" in r["missing"]

    def test_non_list_series_missing(self):
        d = _doc(returns={"6098.T": 123})
        r = resolve_phase8_returns_di(d)
        assert "6098" in r["missing"]
        assert any("is not a list" in x for x in r["diagnostics"])

    def test_universe_absent_ticker_missing(self):
        d = _doc(returns={"6098.T": [0.01]})
        r = resolve_phase8_returns_di(d, universe=["6098", "9999"])
        assert "9999" in r["missing"]

    def test_missing_diagnostic_emitted(self):
        d = _doc(returns={"6098.T": []})
        r = resolve_phase8_returns_di(d)
        assert any("unresolved" in x for x in r["diagnostics"])

    def test_upstream_missing_diagnostic(self):
        d = _doc(missing=["XXXX.T", "YYYY.T"])
        r = resolve_phase8_returns_di(d)
        assert any("upstream missing" in x for x in r["diagnostics"])

    def test_missing_no_duplicates(self):
        d = _doc(returns={"6098.T": []})
        r = resolve_phase8_returns_di(d, universe=["6098"])
        assert r["missing"].count("6098") == 1


# ── TestMissingSafe ──────────────────────────────────────────────────────────

class TestMissingSafe:
    def test_non_dict_returns_doc(self):
        for bad in (None, 123, "x", [1, 2], (1,)):
            r = resolve_phase8_returns_di(bad)  # type: ignore[arg-type]
            assert r["returns_data"] == {}
            assert r["dd10_returns"] == []
            assert r["missing"] == []
            assert any("not a dict" in x for x in r["diagnostics"])

    def test_returns_not_dict(self):
        for bad in (None, 123, "x", [1], {"returns": [1, 2]}):
            doc = bad if isinstance(bad, dict) else {"returns": bad}
            r = resolve_phase8_returns_di(doc)
            assert r["returns_data"] == {}

    def test_returns_key_absent(self):
        r = resolve_phase8_returns_di({"_meta": {}})
        assert r["returns_data"] == {}
        assert any("not a dict" in x for x in r["diagnostics"])

    def test_empty_returns_dict(self):
        r = resolve_phase8_returns_di({"returns": {}})
        assert r["returns_data"] == {}
        assert r["dd10_returns"] == []

    def test_no_fabrication_on_empty(self):
        r = resolve_phase8_returns_di({"returns": {}})
        assert r["returns_data"] == {} and r["missing"] == []


# ── TestDD10Synthesis ────────────────────────────────────────────────────────

class TestDD10Synthesis:
    def test_synthesized_from_weights(self):
        r = resolve_phase8_returns_di(_doc(), pf_weights={"6098.T": 0.6, "8306.T": 0.4})
        # period0 = 0.6*0.01 + 0.4*0.02 = 0.014
        assert r["dd10_returns"][0] == pytest.approx(0.014)

    def test_weight_renormalized(self):
        # weights not summing to 1 → renormalized over usable set
        r = resolve_phase8_returns_di(_doc(), pf_weights={"6098.T": 6.0, "8306.T": 4.0})
        assert r["dd10_returns"][0] == pytest.approx(0.014)

    def test_dot_t_match_in_weights(self):
        r = resolve_phase8_returns_di(_doc(), pf_weights={"6098": 1.0})
        assert r["dd10_returns"] == pytest.approx([0.01, -0.02, 0.03, 0.00])

    def test_min_length_truncate(self):
        d = _doc(returns={"6098.T": [0.01, 0.02, 0.03], "8306.T": [0.04, 0.05]})
        r = resolve_phase8_returns_di(d, pf_weights={"6098.T": 0.5, "8306.T": 0.5})
        assert len(r["dd10_returns"]) == 2
        assert any("truncated to min common length" in x for x in r["diagnostics"])

    def test_no_pf_weights_empty_dd10(self):
        r = resolve_phase8_returns_di(_doc())
        assert r["dd10_returns"] == []
        assert any("pf_weights not provided" in x for x in r["diagnostics"])

    def test_non_dict_pf_weights_empty_dd10(self):
        r = resolve_phase8_returns_di(_doc(), pf_weights=[("6098", 1.0)])
        assert r["dd10_returns"] == []
        assert any("pf_weights is not a dict" in x for x in r["diagnostics"])

    def test_cash_excluded(self):
        r = resolve_phase8_returns_di(_doc(), pf_weights={"6098.T": 0.5, "CASH": 0.5})
        assert r["dd10_returns"] == pytest.approx([0.01, -0.02, 0.03, 0.00])
        assert any("no returns series" in x for x in r["diagnostics"])

    def test_usable_none_empty_dd10(self):
        r = resolve_phase8_returns_di(_doc(), pf_weights={"CASH": 1.0, "FUND": 2.0})
        assert r["dd10_returns"] == []
        assert any("no usable" in x for x in r["diagnostics"])

    def test_zero_weight_excluded(self):
        r = resolve_phase8_returns_di(_doc(), pf_weights={"6098.T": 0.0, "8306.T": 1.0})
        assert r["dd10_returns"] == pytest.approx([0.02, -0.01, 0.01, 0.02])
        assert any("weight invalid/<=0" in x for x in r["diagnostics"])

    def test_negative_weight_excluded(self):
        r = resolve_phase8_returns_di(_doc(), pf_weights={"6098.T": -0.5, "8306.T": 1.0})
        assert r["dd10_returns"] == pytest.approx([0.02, -0.01, 0.01, 0.02])

    def test_nan_weight_excluded(self):
        r = resolve_phase8_returns_di(_doc(), pf_weights={"6098.T": float("nan"), "8306.T": 1.0})
        assert r["dd10_returns"] == pytest.approx([0.02, -0.01, 0.01, 0.02])

    def test_inf_weight_excluded(self):
        r = resolve_phase8_returns_di(_doc(), pf_weights={"6098.T": float("inf"), "8306.T": 1.0})
        assert r["dd10_returns"] == pytest.approx([0.02, -0.01, 0.01, 0.02])

    def test_bool_weight_excluded(self):
        r = resolve_phase8_returns_di(_doc(), pf_weights={"6098.T": True, "8306.T": 1.0})
        assert r["dd10_returns"] == pytest.approx([0.02, -0.01, 0.01, 0.02])

    def test_string_weight_excluded(self):
        r = resolve_phase8_returns_di(_doc(), pf_weights={"6098.T": "1.0", "8306.T": 1.0})
        assert r["dd10_returns"] == pytest.approx([0.02, -0.01, 0.01, 0.02])

    def test_weight_for_missing_ticker_excluded(self):
        d = _doc(returns={"6098.T": []})
        r = resolve_phase8_returns_di(d, pf_weights={"6098.T": 1.0})
        assert r["dd10_returns"] == []

    def test_dd10_deterministic(self):
        a = resolve_phase8_returns_di(_doc(), pf_weights={"6098.T": 0.6, "8306.T": 0.4})
        b = resolve_phase8_returns_di(_doc(), pf_weights={"6098.T": 0.6, "8306.T": 0.4})
        assert a["dd10_returns"] == b["dd10_returns"]

    def test_dd10_synth_diagnostic(self):
        r = resolve_phase8_returns_di(_doc(), pf_weights={"6098.T": 1.0})
        assert any("dd10_returns synthesized" in x and "calculation-only" in x
                   for x in r["diagnostics"])

    def test_dd10_all_floats(self):
        r = resolve_phase8_returns_di(_doc(), pf_weights={"6098.T": 0.5, "8306.T": 0.5})
        assert all(isinstance(x, float) for x in r["dd10_returns"])


# ── TestProvenance ───────────────────────────────────────────────────────────

class TestProvenance:
    def test_meta_provenance_diagnostic(self):
        r = resolve_phase8_returns_di(_doc())
        assert any("provenance" in x and "yfinance" in x for x in r["diagnostics"])

    def test_no_meta_no_provenance_diag(self):
        d = _doc()
        del d["_meta"]
        r = resolve_phase8_returns_di(d)
        assert not any("provenance" in x for x in r["diagnostics"])

    def test_meta_non_dict_safe(self):
        d = _doc(_meta="bad")
        r = resolve_phase8_returns_di(d)
        assert set(r["returns_data"].keys()) == {"6098", "8306", "9697"}


# ── TestNonMutation ──────────────────────────────────────────────────────────

class TestNonMutation:
    def test_returns_doc_not_mutated(self):
        import copy
        d = _doc()
        snap = copy.deepcopy(d)
        resolve_phase8_returns_di(d, pf_weights={"6098.T": 1.0}, universe=["6098"])
        assert d == snap

    def test_pf_weights_not_mutated(self):
        pw = {"6098.T": 0.6, "8306.T": 0.4}
        resolve_phase8_returns_di(_doc(), pf_weights=pw)
        assert pw == {"6098.T": 0.6, "8306.T": 0.4}

    def test_universe_list_not_mutated(self):
        uni = ["6098", "8306"]
        resolve_phase8_returns_di(_doc(), universe=uni)
        assert uni == ["6098", "8306"]

    def test_returns_series_objects_not_mutated(self):
        d = _doc(returns={"6098.T": [0.01, float("nan"), 0.02]})
        orig = d["returns"]["6098.T"]
        resolve_phase8_returns_di(d)
        assert len(orig) == 3 and math.isnan(orig[1])


# ── TestDiagnostics ──────────────────────────────────────────────────────────

class TestDiagnostics:
    def test_all_observation_prefixed_valid(self):
        r = resolve_phase8_returns_di(_doc(), pf_weights={"6098.T": 1.0})
        for d in r["diagnostics"]:
            assert d.startswith("observation: ")

    def test_all_observation_prefixed_empty(self):
        for d in resolve_phase8_returns_di(None)["diagnostics"]:  # type: ignore[arg-type]
            assert d.startswith("observation: ")

    def test_all_observation_prefixed_missing(self):
        r = resolve_phase8_returns_di(_doc(returns={"6098.T": []}), universe=["6098", "ZZZZ"])
        for d in r["diagnostics"]:
            assert d.startswith("observation: ")

    def test_diagnostics_all_str(self):
        r = resolve_phase8_returns_di(_doc(), pf_weights={"6098.T": 1.0})
        assert all(isinstance(d, str) for d in r["diagnostics"])

    def test_no_forbidden_words_in_output_diagnostics(self):
        r = resolve_phase8_returns_di(_doc(), pf_weights={"6098.T": 1.0})
        blob = " ".join(r["diagnostics"])
        for tok in ("BUY", "SELL", "HOLD", "WAIT"):
            assert tok not in blob


# ── TestStaticBoundary（AST）──────────────────────────────────────────────────

class TestStaticBoundary:
    _ALLOWED_TOP = {"__future__", "math", "typing"}

    def _tree(self) -> ast.AST:
        return ast.parse(_module_source())

    def _imported_top(self) -> set[str]:
        tops: set[str] = set()
        for node in ast.walk(self._tree()):
            if isinstance(node, ast.Import):
                for a in node.names:
                    tops.add(a.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    tops.add(node.module.split(".")[0])
        return tops

    def test_only_stdlib_imports(self):
        assert self._imported_top() <= self._ALLOWED_TOP

    def test_no_numpy_scipy_pandas(self):
        tops = self._imported_top()
        assert "numpy" not in tops
        assert "scipy" not in tops
        assert "pandas" not in tops

    def test_no_engine_or_compute_import(self):
        for m in self._imported_top():
            assert m not in ("engine", "backend")

    def test_no_path_read_calls(self):
        for node in ast.walk(self._tree()):
            if isinstance(node, ast.Call):
                f = node.func
                if isinstance(f, ast.Name) and f.id in ("open",):
                    raise AssertionError("open() call found")
                if isinstance(f, ast.Attribute) and f.attr in (
                    "read_text", "write_text", "read_bytes", "write_bytes",
                    "open", "write", "replace", "mkdir",
                ):
                    raise AssertionError(f"file io call .{f.attr}() found")

    def test_no_pathlib_import(self):
        assert "pathlib" not in self._imported_top()

    def test_no_datetime_now_or_time_call(self):
        for node in ast.walk(self._tree()):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
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

    def test_resolve_is_callable(self):
        assert callable(resolve_phase8_returns_di)

    def test_module_docstring_declares_flat_di(self):
        import backend.engine.operation.phase8_returns_resolver as mod
        assert "Flat-DI" in (mod.__doc__ or "")


# ── TestInputHandling ────────────────────────────────────────────────────────

class TestInputHandling:
    def test_ticker_normalize_default_true(self):
        rd = resolve_phase8_returns_di(_doc())["returns_data"]
        assert "6098" in rd

    def test_universe_none_default_no_filter(self):
        rd = resolve_phase8_returns_di(_doc())["returns_data"]
        assert len(rd) == 3

    def test_universe_set_accepted(self):
        rd = resolve_phase8_returns_di(_doc(), universe={"6098", "8306"})["returns_data"]
        assert set(rd.keys()) == {"6098", "8306"}

    def test_universe_tuple_accepted(self):
        rd = resolve_phase8_returns_di(_doc(), universe=("6098",))["returns_data"]
        assert set(rd.keys()) == {"6098"}

    def test_empty_universe_filters_all(self):
        r = resolve_phase8_returns_di(_doc(), universe=[])
        assert r["returns_data"] == {}

    def test_returns_doc_with_extra_keys_ignored(self):
        d = _doc(unrelated_key={"x": 1})
        r = resolve_phase8_returns_di(d)
        assert set(r["returns_data"].keys()) == {"6098", "8306", "9697"}
