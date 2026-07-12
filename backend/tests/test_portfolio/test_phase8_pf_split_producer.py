"""
test_phase8_pf_split_producer.py — PF split テスト

backend/engine/operation/phase8_pf_split_producer.py の
produce_pf_split_raw() を実 UnifiedViewBuilder（pure stdlib・scipy 非依存）で
検証する。

テスト配置の理由（Q1 決定 / P1-PFS-5）:
  UnifiedViewBuilder は engine.portfolio 配下であり PF split の主語が
  portfolio であるため本テストは backend/tests/test_portfolio/ に置く。
  backend/tests/test_operation/ には置かない（compute-importing producer
  群を test_operation 外に保つ慣習：C→test_frontier / D→test_strategies /
  F→test_frontier / PF split→test_portfolio）。
"""
from __future__ import annotations

import ast
import json
import os

import pytest

from engine.operation.phase8_pf_split_producer import (
    produce_pf_split_raw,
)

# ── フィクスチャ（外部 DI 値、決定論）────────────────────────────────────────

_HOLDINGS = [
    {"account_id": "sbi", "ticker_or_code": "7203",
     "current_weight": 0.30, "asset_class": "domestic_equity"},
    {"account_id": "sbi", "ticker_or_code": "F1",
     "current_weight": 0.20, "asset_class": "domestic_fund"},
    {"account_id": "rakuten", "ticker_or_code": "F2",
     "current_weight": 0.15, "asset_class": "overseas_fund"},
    {"account_id": "rakuten", "ticker_or_code": "CASH",
     "current_weight": 0.05, "asset_class": "cash"},
]

_TOP_KEYS = {
    "frontier_cash_pct",
    "frontier_fund_pct",
    "total_equity_weight",
    "regime",
    "diagnostics",
}


def _produce(**overrides):
    kwargs = dict(
        account_holdings=[dict(h) for h in _HOLDINGS],
        cash_weight=0.10,
        regime="bull_calm",
    )
    kwargs.update(overrides)
    return produce_pf_split_raw(**kwargs)


def _module_source() -> str:
    import engine.operation.phase8_pf_split_producer as mod
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
        assert isinstance(_produce(), dict)

    def test_exact_top_keys(self):
        assert set(_produce().keys()) == _TOP_KEYS

    def test_cash_pct_is_float(self):
        assert isinstance(_produce()["frontier_cash_pct"], float)

    def test_fund_pct_is_float(self):
        assert isinstance(_produce()["frontier_fund_pct"], float)

    def test_total_equity_weight_is_float(self):
        assert isinstance(_produce()["total_equity_weight"], float)

    def test_regime_is_str(self):
        assert isinstance(_produce()["regime"], str)

    def test_diagnostics_is_list(self):
        assert isinstance(_produce()["diagnostics"], list)

    def test_json_serializable(self):
        json.loads(json.dumps(_produce()))


# ── TestCashFundEquityComputation ────────────────────────────────────────────

class TestCashFundEquityComputation:
    def test_cash_pct_equals_cash_weight_di(self):
        assert _produce(cash_weight=0.10)["frontier_cash_pct"] == 0.10

    def test_cash_pct_changes_with_di(self):
        assert _produce(cash_weight=0.25)["frontier_cash_pct"] == 0.25

    def test_fund_pct_is_domestic_plus_overseas_fund(self):
        # domestic_fund 0.20 + overseas_fund 0.15 = 0.35
        assert _produce()["frontier_fund_pct"] == pytest.approx(0.35)

    def test_total_equity_weight_is_domestic_equity(self):
        # domestic_equity 0.30
        assert _produce()["total_equity_weight"] == pytest.approx(0.30)

    def test_cash_holding_not_in_total_cash(self):
        # account_holdings の asset_class="cash"（0.05）は total_cash_weight に
        # 合算されない（total_cash_weight は cash_weight DI pass-through）
        r = _produce(cash_weight=0.10)
        assert r["frontier_cash_pct"] == 0.10

    def test_only_domestic_fund(self):
        h = [{"account_id": "a", "ticker_or_code": "F",
               "current_weight": 0.4, "asset_class": "domestic_fund"}]
        assert _produce(account_holdings=h)["frontier_fund_pct"] == pytest.approx(0.4)

    def test_only_overseas_fund(self):
        h = [{"account_id": "a", "ticker_or_code": "F",
               "current_weight": 0.3, "asset_class": "overseas_fund"}]
        assert _produce(account_holdings=h)["frontier_fund_pct"] == pytest.approx(0.3)

    def test_fund_sums_across_accounts(self):
        h = [
            {"account_id": "a", "ticker_or_code": "F1",
             "current_weight": 0.1, "asset_class": "domestic_fund"},
            {"account_id": "b", "ticker_or_code": "F2",
             "current_weight": 0.2, "asset_class": "overseas_fund"},
            {"account_id": "c", "ticker_or_code": "F3",
             "current_weight": 0.05, "asset_class": "domestic_fund"},
        ]
        assert _produce(account_holdings=h)["frontier_fund_pct"] == pytest.approx(0.35)

    def test_equity_sums_across_accounts(self):
        h = [
            {"account_id": "a", "ticker_or_code": "E1",
             "current_weight": 0.2, "asset_class": "domestic_equity"},
            {"account_id": "b", "ticker_or_code": "E2",
             "current_weight": 0.3, "asset_class": "domestic_equity"},
        ]
        assert _produce(account_holdings=h)["total_equity_weight"] == pytest.approx(0.5)

    def test_no_fund_holdings_zero(self):
        h = [{"account_id": "a", "ticker_or_code": "E",
               "current_weight": 0.5, "asset_class": "domestic_equity"}]
        assert _produce(account_holdings=h)["frontier_fund_pct"] == 0.0

    def test_no_equity_holdings_zero(self):
        h = [{"account_id": "a", "ticker_or_code": "F",
               "current_weight": 0.5, "asset_class": "domestic_fund"}]
        assert _produce(account_holdings=h)["total_equity_weight"] == 0.0

    def test_duplicate_account_ticker_summed(self):
        h = [
            {"account_id": "a", "ticker_or_code": "F",
             "current_weight": 0.1, "asset_class": "domestic_fund"},
            {"account_id": "a", "ticker_or_code": "F",
             "current_weight": 0.2, "asset_class": "domestic_fund"},
        ]
        assert _produce(account_holdings=h)["frontier_fund_pct"] == pytest.approx(0.3)


# ── TestMissingInputFallback ─────────────────────────────────────────────────

class TestMissingInputFallback:
    def test_missing_holdings_none(self):
        r = _produce(account_holdings=None)
        assert r["frontier_fund_pct"] == 0.0
        assert r["total_equity_weight"] == 0.0

    def test_missing_holdings_diagnostic(self):
        r = _produce(account_holdings=None)
        assert any("observed holdings absent" in d for d in r["diagnostics"])

    def test_empty_list_holdings(self):
        r = _produce(account_holdings=[])
        assert r["frontier_fund_pct"] == 0.0

    def test_non_list_holdings(self):
        r = _produce(account_holdings="bad")
        assert r["frontier_fund_pct"] == 0.0
        assert any("not provided as list" in d for d in r["diagnostics"])

    def test_no_valid_dict_entries(self):
        r = _produce(account_holdings=[1, "x", None])
        assert r["frontier_fund_pct"] == 0.0
        assert any("no valid dict entries" in d for d in r["diagnostics"])

    def test_some_invalid_entries_skipped(self):
        h = [
            {"account_id": "a", "ticker_or_code": "F",
             "current_weight": 0.4, "asset_class": "domestic_fund"},
            "not_a_dict",
        ]
        r = _produce(account_holdings=h)
        assert r["frontier_fund_pct"] == pytest.approx(0.4)
        assert any("not a dict; skipped" in d for d in r["diagnostics"])

    def test_missing_cash_weight_default_zero(self):
        r = produce_pf_split_raw(
            account_holdings=[dict(h) for h in _HOLDINGS], regime="bull_calm",
        )
        assert r["frontier_cash_pct"] == 0.0

    def test_negative_cash_weight_zero(self):
        r = _produce(cash_weight=-0.5)
        assert r["frontier_cash_pct"] == 0.0
        assert any(
            "cash_weight missing/invalid/negative" in d
            for d in r["diagnostics"]
        )

    def test_invalid_string_cash_weight_zero(self):
        r = _produce(cash_weight="not_a_number")
        assert r["frontier_cash_pct"] == 0.0

    def test_nan_cash_weight_zero(self):
        r = _produce(cash_weight=float("nan"))
        assert r["frontier_cash_pct"] == 0.0

    def test_inf_cash_weight_zero(self):
        r = _produce(cash_weight=float("inf"))
        assert r["frontier_cash_pct"] == 0.0

    def test_none_cash_weight_zero(self):
        r = _produce(cash_weight=None)
        assert r["frontier_cash_pct"] == 0.0


# ── TestAssetClassDI ─────────────────────────────────────────────────────────

class TestAssetClassDI:
    def test_unknown_asset_class_unclassified_diagnostic(self):
        h = [{"account_id": "a", "ticker_or_code": "X",
               "current_weight": 0.5, "asset_class": "crypto"}]
        r = _produce(account_holdings=h)
        assert any(
            "unknown asset_class" in d and "unclassified" in d
            for d in r["diagnostics"]
        )

    def test_unknown_asset_class_not_in_fund_or_equity(self):
        h = [{"account_id": "a", "ticker_or_code": "X",
               "current_weight": 0.5, "asset_class": "crypto"}]
        r = _produce(account_holdings=h)
        assert r["frontier_fund_pct"] == 0.0
        assert r["total_equity_weight"] == 0.0

    def test_missing_asset_class_field_treated_unclassified(self):
        h = [{"account_id": "a", "ticker_or_code": "X",
               "current_weight": 0.5}]
        r = _produce(account_holdings=h)
        assert r["frontier_fund_pct"] == 0.0
        assert r["total_equity_weight"] == 0.0

    def test_producer_does_not_classify_mixed(self):
        h = [
            {"account_id": "a", "ticker_or_code": "E",
             "current_weight": 0.3, "asset_class": "domestic_equity"},
            {"account_id": "a", "ticker_or_code": "Z",
             "current_weight": 0.2, "asset_class": "weird_class"},
        ]
        r = _produce(account_holdings=h)
        # domestic_equity のみ equity に入る。weird_class は分類されず
        assert r["total_equity_weight"] == pytest.approx(0.3)
        assert r["frontier_fund_pct"] == 0.0

    def test_cash_asset_class_not_summed_into_cash_pct(self):
        h = [{"account_id": "a", "ticker_or_code": "C",
               "current_weight": 0.4, "asset_class": "cash"}]
        r = _produce(account_holdings=h, cash_weight=0.0)
        # asset_class="cash" 保有は total_cash_weight に合算されない
        assert r["frontier_cash_pct"] == 0.0

    def test_known_asset_class_no_unknown_diagnostic(self):
        r = _produce()
        assert not any("unknown asset_class" in d for d in r["diagnostics"])


# ── TestPassThroughInputs ────────────────────────────────────────────────────

class TestPassThroughInputs:
    def test_equity_constrained_pf_does_not_affect_cash_fund(self):
        base = _produce()
        with_pf = _produce(equity_constrained_pf={"7203": 0.5, "6758": 0.5})
        assert with_pf["frontier_cash_pct"] == base["frontier_cash_pct"]
        assert with_pf["frontier_fund_pct"] == base["frontier_fund_pct"]

    def test_fund_pf_does_not_affect_cash_fund(self):
        base = _produce()
        with_pf = _produce(fund_pf=[("F1", 0.6), ("F2", 0.4)])
        assert with_pf["frontier_fund_pct"] == base["frontier_fund_pct"]

    def test_none_pass_through_ok(self):
        r = _produce(equity_constrained_pf=None, fund_pf=None)
        assert set(r.keys()) == _TOP_KEYS

    def test_invalid_pass_through_does_not_raise(self):
        r = _produce(equity_constrained_pf="garbage", fund_pf=123)
        assert set(r.keys()) == _TOP_KEYS


# ── TestSemantics ────────────────────────────────────────────────────────────

class TestSemantics:
    def test_semantics_diagnostic_present(self):
        diags = " ".join(_produce()["diagnostics"])
        assert "observed portfolio split" in diags

    def test_not_frontier_index_output(self):
        diags = " ".join(_produce()["diagnostics"])
        assert "not frontier index output" in diags

    def test_calculation_observation_only(self):
        diags = " ".join(_produce()["diagnostics"])
        assert "calculation-only/observation-only" in diags

    def test_not_an_order(self):
        diags = " ".join(_produce()["diagnostics"])
        assert "not an order" in diags

    def test_produced_via_unifiedview_note(self):
        diags = " ".join(_produce()["diagnostics"])
        assert "UnifiedViewBuilder" in diags


# ── TestObservationDiagnostics ───────────────────────────────────────────────

class TestObservationDiagnostics:
    def test_all_observation_prefixed_valid(self):
        for d in _produce()["diagnostics"]:
            assert d.startswith("observation: ")

    def test_all_observation_prefixed_missing(self):
        for d in _produce(account_holdings=None, cash_weight=None)["diagnostics"]:
            assert d.startswith("observation: ")

    def test_all_observation_prefixed_unknown_class(self):
        h = [{"account_id": "a", "ticker_or_code": "X",
               "current_weight": 0.5, "asset_class": "crypto"}]
        for d in _produce(account_holdings=h)["diagnostics"]:
            assert d.startswith("observation: ")

    def test_diagnostics_non_empty(self):
        assert len(_produce()["diagnostics"]) >= 1

    def test_diagnostics_all_str(self):
        assert all(isinstance(d, str) for d in _produce()["diagnostics"])

    def test_no_forbidden_words_in_diagnostics(self):
        diags = " ".join(_produce()["diagnostics"])
        for tok in ("BUY", "SELL", "HOLD", "WAIT"):
            assert tok not in diags


# ── TestNonMutation ──────────────────────────────────────────────────────────

class TestNonMutation:
    def test_account_holdings_list_not_mutated(self):
        h = [dict(x) for x in _HOLDINGS]
        snapshot = [dict(x) for x in h]
        produce_pf_split_raw(
            account_holdings=h, cash_weight=0.1, regime="bull_calm",
        )
        assert h == snapshot

    def test_account_holdings_entry_dicts_not_mutated(self):
        entry = {"account_id": "a", "ticker_or_code": "F",
                 "current_weight": 0.4, "asset_class": "domestic_fund"}
        produce_pf_split_raw(
            account_holdings=[entry], cash_weight=0.1, regime="bull_calm",
        )
        assert entry == {"account_id": "a", "ticker_or_code": "F",
                         "current_weight": 0.4, "asset_class": "domestic_fund"}

    def test_context_not_mutated(self):
        ctx = {"k": 1, "nested": {"x": 2}}
        produce_pf_split_raw(
            account_holdings=None, cash_weight=0.1,
            regime="bull_calm", context=ctx,
        )
        assert ctx == {"k": 1, "nested": {"x": 2}}

    def test_equity_pf_dict_not_mutated(self):
        pf = {"7203": 0.5, "6758": 0.5}
        _produce(equity_constrained_pf=pf)
        assert pf == {"7203": 0.5, "6758": 0.5}

    def test_fund_pf_list_not_mutated(self):
        pf = [("F1", 0.6), ("F2", 0.4)]
        _produce(fund_pf=pf)
        assert pf == [("F1", 0.6), ("F2", 0.4)]

    def test_none_context_does_not_raise(self):
        r = produce_pf_split_raw(
            account_holdings=None, cash_weight=0.0,
            regime="bull_calm", context=None,
        )
        assert isinstance(r, dict)

    def test_regime_echoed(self):
        assert _produce(regime="crisis")["regime"] == "crisis"


# ── TestDeterminism ──────────────────────────────────────────────────────────

class TestDeterminism:
    def test_cash_deterministic(self):
        assert _produce()["frontier_cash_pct"] == _produce()["frontier_cash_pct"]

    def test_fund_deterministic(self):
        assert _produce()["frontier_fund_pct"] == _produce()["frontier_fund_pct"]

    def test_equity_deterministic(self):
        assert (
            _produce()["total_equity_weight"]
            == _produce()["total_equity_weight"]
        )

    def test_repeated_calls_distinct_objects(self):
        a = _produce()
        b = _produce()
        assert a is not b
        assert a["diagnostics"] is not b["diagnostics"]


# ── TestStaticComputeBoundary（AST）──────────────────────────────────────────

class TestStaticComputeBoundary:
    """UnifiedView のみ・禁止 import / token を AST で検証する。"""

    _ALLOWED_ENGINE_MODULES = {
        "engine.portfolio.unified_view",
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

    def test_unified_view_imported(self):
        assert "engine.portfolio.unified_view" in self._imported_modules()

    def test_no_numpy_scipy_pandas_direct_import(self):
        tops = {m.split(".")[0] for m in self._imported_modules()}
        assert "numpy" not in tops
        assert "scipy" not in tops
        assert "pandas" not in tops

    def test_no_cdf_producer_import(self):
        for m in self._imported_modules():
            assert "phase8_compute_producer" not in m
            assert "phase8_strategy_aggregate_producer" not in m
            assert "phase8_analysis_producer" not in m

    def test_no_orchestrator_caller_adapter_writer_import(self):
        for m in self._imported_modules():
            assert "phase8_compute_orchestrator" not in m
            assert "phase8_public_data_caller" not in m
            assert "phase8_presentation_adapter" not in m
            assert "phase8_json_writer" not in m

    def test_no_jpequity_fund_strategy_aggregate_frontier_decision_import(self):
        for m in self._imported_modules():
            assert "jp_equity_pf_builder" not in m
            assert "fund_pf_builder" not in m
            assert "splitter" not in m
            assert "strategies" not in m
            assert "aggregator" not in m
            assert "frontier" not in m
            assert "decision" not in m

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
        import engine.operation.phase8_pf_split_producer as mod
        assert "producer 群の 4 つ目" in (mod.__doc__ or "")

    def test_produce_is_callable(self):
        assert callable(produce_pf_split_raw)

    def test_test_file_no_sci_stack_import(self):
        with open(__file__) as fh:
            tree = ast.parse(fh.read())
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
        _produce()
        assert set(os.listdir(tmp_path)) == before

    def test_return_contains_no_public_data_literal(self):
        flat = json.dumps(_produce())
        assert "public/data" not in flat


# ── TestInputHandling ────────────────────────────────────────────────────────

class TestInputHandling:
    def test_regime_required_keyword(self):
        with pytest.raises(TypeError):
            produce_pf_split_raw()  # type: ignore[call-arg]

    def test_keyword_only_enforced(self):
        with pytest.raises(TypeError):
            produce_pf_split_raw([], 0.0, "bull_calm")  # type: ignore[misc]

    def test_empty_regime_string_safe(self):
        r = produce_pf_split_raw(
            account_holdings=None, cash_weight=0.0, regime="",
        )
        assert set(r.keys()) == _TOP_KEYS

    def test_regime_echoed_in_top(self):
        assert _produce(regime="bear")["regime"] == "bear"

    def test_default_top_keys(self):
        assert set(_produce().keys()) == _TOP_KEYS

    def test_minimal_call(self):
        r = produce_pf_split_raw(regime="uncertain")
        assert set(r.keys()) == _TOP_KEYS
        assert r["frontier_cash_pct"] == 0.0
        assert r["frontier_fund_pct"] == 0.0
