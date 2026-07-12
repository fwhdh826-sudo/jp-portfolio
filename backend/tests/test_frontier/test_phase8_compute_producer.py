"""
test_phase8_compute_producer.py — P2-D3-compute-actual-1（Scope C）テスト

backend/engine/operation/phase8_compute_producer.py の
produce_frontier_index_raw() を real compute（FrontierStrategy.
compute_with_frontier_index 経由、Phase 8 は scipy/SLSQP を通る）で検証する。

テスト配置の理由（Q1 決定 / P1-D3ca1-5）:
  本テストは backend/tests/test_frontier/ に置く。real compute が
  scipy/SLSQP を経由するため、backend/tests/test_operation/ の
  stdlib / Flat-DI / scipy 非依存原則を汚染しないための意図的隔離。

scipy 1.13+ required（インストール済み）。
"""
from __future__ import annotations

import ast
import json
import os

import pytest

from engine.operation.phase8_compute_producer import (
    produce_frontier_index_raw,
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

_RETURN_KEYS = {
    "strategy_output",
    "frontier_index_raw",
    "frontier_cash_pct",
    "frontier_fund_pct",
    "diagnostics",
}

_FRONTIER_INDEX_KEYS = {
    "index_name",
    "tickers",
    "weights",
    "expected_return",
    "expected_vol",
    "sharpe_ratio",
    "regime_used",
    "calculation_date",
    "diagnostics",
}

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
    return produce_frontier_index_raw(**kwargs)


def _produce_phase7(**overrides):
    kwargs = dict(
        universe=("A", "B"),
        scores=_BASIC_SCORES,
        regime="bull_calm",
        context={},
    )
    kwargs.update(overrides)
    return produce_frontier_index_raw(**kwargs)


def _module_source() -> str:
    import engine.operation.phase8_compute_producer as mod
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

    def test_exact_five_keys(self):
        assert set(_produce_phase8().keys()) == _RETURN_KEYS

    def test_strategy_output_is_dict(self):
        assert isinstance(_produce_phase8()["strategy_output"], dict)

    def test_strategy_output_has_nine_keys(self):
        out = _produce_phase8()["strategy_output"]
        assert set(out.keys()) == _STRATEGY_OUTPUT_KEYS

    def test_cash_pct_is_float(self):
        assert isinstance(_produce_phase8()["frontier_cash_pct"], float)

    def test_fund_pct_is_float(self):
        assert isinstance(_produce_phase8()["frontier_fund_pct"], float)

    def test_diagnostics_is_list(self):
        assert isinstance(_produce_phase8()["diagnostics"], list)

    def test_whole_return_json_serializable(self):
        json.loads(json.dumps(_produce_phase8()))


# ── TestPhase8 ───────────────────────────────────────────────────────────────

class TestPhase8:
    def test_frontier_index_raw_is_dict(self):
        assert isinstance(_produce_phase8()["frontier_index_raw"], dict)

    def test_frontier_index_raw_not_none(self):
        assert _produce_phase8()["frontier_index_raw"] is not None

    def test_frontier_index_raw_exact_nine_keys(self):
        fi = _produce_phase8()["frontier_index_raw"]
        assert set(fi.keys()) == _FRONTIER_INDEX_KEYS

    def test_frontier_index_raw_json_serializable(self):
        fi = _produce_phase8()["frontier_index_raw"]
        round_tripped = json.loads(json.dumps(fi))
        assert set(round_tripped.keys()) == _FRONTIER_INDEX_KEYS

    def test_index_name_is_str(self):
        assert isinstance(
            _produce_phase8()["frontier_index_raw"]["index_name"], str
        )

    def test_tickers_is_list(self):
        assert isinstance(
            _produce_phase8()["frontier_index_raw"]["tickers"], list
        )

    def test_weights_is_list(self):
        assert isinstance(
            _produce_phase8()["frontier_index_raw"]["weights"], list
        )

    def test_tickers_subset_of_universe(self):
        fi = _produce_phase8()["frontier_index_raw"]
        assert set(fi["tickers"]).issubset({"A", "B"})

    def test_expected_return_is_number(self):
        v = _produce_phase8()["frontier_index_raw"]["expected_return"]
        assert isinstance(v, (int, float))

    def test_expected_vol_is_number(self):
        v = _produce_phase8()["frontier_index_raw"]["expected_vol"]
        assert isinstance(v, (int, float))

    def test_sharpe_ratio_is_number(self):
        v = _produce_phase8()["frontier_index_raw"]["sharpe_ratio"]
        assert isinstance(v, (int, float))

    def test_regime_used_present(self):
        fi = _produce_phase8()["frontier_index_raw"]
        assert "regime_used" in fi

    def test_diagnostics_mentions_phase8_real_compute(self):
        diags = " ".join(_produce_phase8()["diagnostics"])
        assert "Phase 8 path" in diags
        assert "real compute" in diags

    def test_strategy_output_strategy_id_frontier(self):
        out = _produce_phase8()["strategy_output"]
        assert out["strategy_id"] == "frontier"


# ── TestPhase7 ───────────────────────────────────────────────────────────────

class TestPhase7:
    def test_frontier_index_raw_is_none(self):
        assert _produce_phase7()["frontier_index_raw"] is None

    def test_strategy_output_still_dict(self):
        assert isinstance(_produce_phase7()["strategy_output"], dict)

    def test_strategy_output_nine_keys(self):
        out = _produce_phase7()["strategy_output"]
        assert set(out.keys()) == _STRATEGY_OUTPUT_KEYS

    def test_empty_returns_data_dict_is_phase7(self):
        r = produce_frontier_index_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context={"returns_data": {}},
        )
        assert r["frontier_index_raw"] is None

    def test_non_dict_returns_data_is_phase7(self):
        r = produce_frontier_index_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context={"returns_data": [1, 2, 3]},
        )
        assert r["frontier_index_raw"] is None

    def test_missing_returns_data_key_is_phase7(self):
        r = produce_frontier_index_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context={"mean_return_3y_by_ticker": {"A": 0.1}},
        )
        assert r["frontier_index_raw"] is None

    def test_diagnostics_mentions_phase7(self):
        diags = " ".join(_produce_phase7()["diagnostics"])
        assert "Phase 7 path" in diags

    def test_none_context_is_phase7(self):
        r = produce_frontier_index_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context=None,
        )
        assert r["frontier_index_raw"] is None


# ── TestEmptyUniverse ────────────────────────────────────────────────────────

class TestEmptyUniverse:
    def _empty(self):
        return produce_frontier_index_raw(
            universe=(), scores={}, regime="bull_calm",
            context=_phase8_context(),
        )

    def test_frontier_index_raw_none(self):
        assert self._empty()["frontier_index_raw"] is None

    def test_strategy_output_is_dict(self):
        assert isinstance(self._empty()["strategy_output"], dict)

    def test_ideal_pf_empty(self):
        assert self._empty()["strategy_output"]["ideal_pf"] == {}

    def test_diagnostics_mentions_empty_universe(self):
        diags = " ".join(self._empty()["diagnostics"])
        assert "empty universe" in diags

    def test_return_has_five_keys(self):
        assert set(self._empty().keys()) == _RETURN_KEYS

    def test_json_serializable(self):
        json.loads(json.dumps(self._empty()))


# ── TestCashFundPassthrough ──────────────────────────────────────────────────

class TestCashFundPassthrough:
    def test_default_cash_zero(self):
        assert _produce_phase8()["frontier_cash_pct"] == 0.0

    def test_default_fund_zero(self):
        assert _produce_phase8()["frontier_fund_pct"] == 0.0

    def test_positive_cash_passthrough(self):
        r = _produce_phase8(frontier_cash_pct=0.15)
        assert r["frontier_cash_pct"] == 0.15

    def test_positive_fund_passthrough(self):
        r = _produce_phase8(frontier_fund_pct=0.25)
        assert r["frontier_fund_pct"] == 0.25

    def test_negative_cash_clamped_zero(self):
        r = _produce_phase8(frontier_cash_pct=-0.5)
        assert r["frontier_cash_pct"] == 0.0

    def test_negative_fund_clamped_zero(self):
        r = _produce_phase8(frontier_fund_pct=-1.0)
        assert r["frontier_fund_pct"] == 0.0

    def test_none_cash_clamped_zero(self):
        r = _produce_phase8(frontier_cash_pct=None)
        assert r["frontier_cash_pct"] == 0.0

    def test_string_fund_clamped_zero(self):
        r = _produce_phase8(frontier_fund_pct="not_a_number")
        assert r["frontier_fund_pct"] == 0.0

    def test_nan_cash_clamped_zero(self):
        r = _produce_phase8(frontier_cash_pct=float("nan"))
        assert r["frontier_cash_pct"] == 0.0

    def test_inf_fund_clamped_zero(self):
        r = _produce_phase8(frontier_fund_pct=float("inf"))
        assert r["frontier_fund_pct"] == 0.0

    def test_invalid_cash_emits_diagnostic(self):
        r = _produce_phase8(frontier_cash_pct=-0.5)
        assert any("frontier_cash_pct invalid" in d for d in r["diagnostics"])

    def test_invalid_fund_emits_diagnostic(self):
        r = _produce_phase8(frontier_fund_pct=None)
        assert any("frontier_fund_pct invalid" in d for d in r["diagnostics"])

    def test_valid_default_no_invalid_diagnostic(self):
        r = _produce_phase8()
        assert not any("invalid or negative" in d for d in r["diagnostics"])

    def test_cash_fund_independent(self):
        r = _produce_phase8(frontier_cash_pct=0.1, frontier_fund_pct=0.3)
        assert r["frontier_cash_pct"] == 0.1
        assert r["frontier_fund_pct"] == 0.3

    def test_passthrough_diagnostic_always_present(self):
        diags = " ".join(_produce_phase8()["diagnostics"])
        assert "DI passthrough" in diags


# ── TestContextNonMutation ───────────────────────────────────────────────────

class TestContextNonMutation:
    def test_phase8_context_keys_unchanged(self):
        ctx = _phase8_context()
        keys_before = set(ctx.keys())
        produce_frontier_index_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context=ctx,
        )
        assert set(ctx.keys()) == keys_before

    def test_phase8_returns_data_unchanged(self):
        ctx = _phase8_context()
        rd_before = {k: list(v) for k, v in ctx["returns_data"].items()}
        produce_frontier_index_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context=ctx,
        )
        assert ctx["returns_data"] == rd_before

    def test_phase7_context_unchanged(self):
        ctx = {"unrelated": 1}
        produce_frontier_index_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context=ctx,
        )
        assert ctx == {"unrelated": 1}

    def test_scores_not_mutated(self):
        scores = {
            t: {ax: dict(v) for ax, v in axes.items()}
            for t, axes in _BASIC_SCORES.items()
        }
        snapshot = {
            t: {ax: dict(v) for ax, v in axes.items()}
            for t, axes in scores.items()
        }
        produce_frontier_index_raw(
            universe=("A", "B"), scores=scores,
            regime="bull_calm", context=_phase8_context(),
        )
        assert scores == snapshot

    def test_none_context_does_not_raise(self):
        r = produce_frontier_index_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context=None,
        )
        assert isinstance(r, dict)


# ── TestDeterminism ──────────────────────────────────────────────────────────

class TestDeterminism:
    def test_phase8_frontier_index_raw_deterministic(self):
        a = _produce_phase8()["frontier_index_raw"]
        b = _produce_phase8()["frontier_index_raw"]
        assert a == b

    def test_phase8_strategy_output_deterministic(self):
        a = _produce_phase8()["strategy_output"]
        b = _produce_phase8()["strategy_output"]
        assert a == b

    def test_repeated_calls_distinct_objects(self):
        a = _produce_phase8()
        b = _produce_phase8()
        assert a is not b
        assert a["frontier_index_raw"] is not b["frontier_index_raw"]

    def test_phase7_deterministic(self):
        assert (
            _produce_phase7()["strategy_output"]
            == _produce_phase7()["strategy_output"]
        )


# ── TestDiagnostics ──────────────────────────────────────────────────────────

class TestDiagnostics:
    def test_all_diagnostics_observation_prefixed_phase8(self):
        for d in _produce_phase8()["diagnostics"]:
            assert d.startswith("observation: ")

    def test_all_diagnostics_observation_prefixed_phase7(self):
        for d in _produce_phase7()["diagnostics"]:
            assert d.startswith("observation: ")

    def test_all_diagnostics_observation_prefixed_empty(self):
        r = produce_frontier_index_raw(
            universe=(), scores={}, regime="bull_calm", context={},
        )
        for d in r["diagnostics"]:
            assert d.startswith("observation: ")

    def test_diagnostics_non_empty(self):
        assert len(_produce_phase8()["diagnostics"]) >= 1

    def test_no_forbidden_words_in_diagnostics(self):
        diags = " ".join(_produce_phase8()["diagnostics"])
        for tok in ("BUY", "SELL", "HOLD", "WAIT"):
            assert tok not in diags

    def test_diagnostics_all_str(self):
        assert all(isinstance(d, str) for d in _produce_phase8()["diagnostics"])


# ── TestStaticComputeBoundary（AST）──────────────────────────────────────────

class TestStaticComputeBoundary:
    """real compute 境界・禁止 import / token を AST で検証する。"""

    _ALLOWED_ENGINE_MODULES = {
        "engine.strategies.base_strategy",
        "engine.strategies.frontier_strategy",
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

    def test_frontier_strategy_is_imported(self):
        assert (
            "engine.strategies.frontier_strategy"
            in self._imported_modules()
        )

    def test_strategy_input_module_imported(self):
        assert (
            "engine.strategies.base_strategy" in self._imported_modules()
        )

    def test_no_numpy_scipy_pandas_import(self):
        tops = {m.split(".")[0] for m in self._imported_modules()}
        assert "numpy" not in tops
        assert "scipy" not in tops
        assert "pandas" not in tops

    def test_no_operation_sibling_imported(self):
        # orchestrator / caller / adapter / writer を import しない
        for m in self._imported_modules():
            assert "phase8_compute_orchestrator" not in m
            assert "phase8_public_data_caller" not in m
            assert "phase8_presentation_adapter" not in m
            assert "phase8_json_writer" not in m

    def test_no_datetime_now_or_time_call(self):
        for node in ast.walk(self._tree()):
            if isinstance(node, ast.Call):
                f = node.func
                if isinstance(f, ast.Attribute):
                    if f.attr in ("now", "utcnow"):
                        raise AssertionError("datetime.now()/utcnow() found")
                    if f.attr == "time":
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

    def test_docstring_declares_sole_compute_module(self):
        import engine.operation.phase8_compute_producer as mod
        assert "compute import を許される唯一" in (mod.__doc__ or "")

    def test_produce_is_callable(self):
        assert callable(produce_frontier_index_raw)


# ── TestNoPublicDataWrite ────────────────────────────────────────────────────

class TestNoPublicDataWrite:
    """public/data はもちろん任意のファイルへ書かないことを検証する。"""

    def _tree(self) -> ast.AST:
        return ast.parse(_module_source())

    def test_no_open_call(self):
        for node in ast.walk(self._tree()):
            if isinstance(node, ast.Call):
                f = node.func
                if isinstance(f, ast.Name) and f.id == "open":
                    raise AssertionError("open() call found in module")

    def test_no_write_attribute_call(self):
        for node in ast.walk(self._tree()):
            if isinstance(node, ast.Call) and isinstance(
                node.func, ast.Attribute
            ):
                assert node.func.attr not in (
                    "write", "write_text", "write_bytes",
                    "replace", "mkdir", "writelines",
                )

    def test_no_writer_import(self):
        src = _module_source()
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                assert "writer" not in node.module
                assert "caller" not in node.module

    def test_call_creates_no_file_in_cwd(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        before = set(os.listdir(tmp_path))
        produce_frontier_index_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context=_phase8_context(),
        )
        after = set(os.listdir(tmp_path))
        assert before == after

    def test_return_contains_no_path_like_value(self):
        r = _produce_phase8()
        # frontier_index_raw / strategy_output は dict、path 文字列を返さない
        flat = json.dumps(r)
        assert "public/data" not in flat


# ── TestInputHandling ────────────────────────────────────────────────────────

class TestInputHandling:
    def test_horizon_default_long_term_accepted(self):
        r = produce_frontier_index_raw(
            universe=("A", "B"), scores=_BASIC_SCORES,
            regime="bull_calm", context=_phase8_context(),
        )
        assert isinstance(r, dict)

    def test_explicit_horizon_accepted(self):
        r = _produce_phase8(horizon="short_term")
        assert isinstance(r, dict)

    def test_non_dict_scores_does_not_raise(self):
        r = produce_frontier_index_raw(
            universe=("A", "B"), scores=None,
            regime="bull_calm", context={},
        )
        assert isinstance(r, dict)
        assert r["frontier_index_raw"] is None

    def test_list_universe_accepted(self):
        r = produce_frontier_index_raw(
            universe=["A", "B"], scores=_BASIC_SCORES,
            regime="bull_calm", context=_phase8_context(),
        )
        assert isinstance(r, dict)

    def test_unknown_regime_does_not_raise(self):
        r = _produce_phase8(regime="not_a_regime")
        assert isinstance(r, dict)

    def test_keyword_only_enforced(self):
        with pytest.raises(TypeError):
            produce_frontier_index_raw(  # type: ignore[misc]
                ("A", "B"), _BASIC_SCORES, "bull_calm",
            )
