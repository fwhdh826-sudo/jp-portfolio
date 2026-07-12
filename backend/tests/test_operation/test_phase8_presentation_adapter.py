"""
P2-D1-b — Phase 8 raw→presentation adapter テスト
Operation 層 adapter（backend/engine/operation/phase8_presentation_adapter.py）
の変換・合成ギャップ・Flat DI・JSON serializable・入力非 mutation を検証。

テスト方針:
  - stdlib-only（ast / json / inspect / pathlib / re / dataclasses）+ pytest
  - public/data に書かない（adapter は pure transform）
  - backend dataclass import なし（Flat DI 検証）
  - numpy / scipy / pandas import なし
  - writer 呼び出しなし / path literal public/ なし
  - 禁止フィールド / 禁止語 absence assertion
"""
from __future__ import annotations

import ast
import inspect
import json
import re
from pathlib import Path

import pytest

from backend.engine.operation.phase8_presentation_adapter import (
    adapt_frontier_index,
    adapt_future_branching,
    adapt_opportunity_loss,
    adapt_strategy_aggregate,
    assert_json_serializable,
    build_presentation_document,
)


# ── 禁止語 / 禁止フィールド検証用定数（absence assertion 用） ──────────────────

_FORBIDDEN_FIELD_NAMES: frozenset = frozenset({
    "action", "recommendation", "is_buy", "is_sell", "is_hold",
    "is_recommended", "verdict", "decision", "approve", "reject",
    "conditional", "rating", "rebalance_order", "buy_amount",
    "sell_amount", "shares", "quantity",
    "final_verdict", "order", "amount", "entry_price",
    "stop_loss", "take_profit",
})
_FORBIDDEN_DECISION_TOKENS_UPPER: tuple = ("BUY", "SELL", "WAIT")
_FORBIDDEN_DECISION_HOLD_PATTERN = re.compile(r"\bHOLD\b")


# ── helpers ───────────────────────────────────────────────────────────────────


def _module_path() -> Path:
    return (
        Path(__file__).parent.parent.parent
        / "engine" / "operation" / "phase8_presentation_adapter.py"
    )


def _top_level_imports(path: Path) -> set:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names: set = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module is not None:
                names.add(node.module.split(".")[0])
    return names


def _string_constants_excluding_docstring(path: Path) -> list:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    doc_ids: set = set()

    def _rec(body) -> None:
        if (body and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)):
            doc_ids.add(id(body[0].value))

    _rec(tree.body)
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            _rec(n.body)
    out: list = []
    for n in ast.walk(tree):
        if (isinstance(n, ast.Constant) and isinstance(n.value, str)
                and id(n) not in doc_ids):
            out.append(n.value)
    return out


def _fi_raw() -> dict:
    return {
        "index_name": "Frontier AI Index",
        "tickers": ["7011", "6758", "9984"],
        "weights": [0.5, 0.3, 0.2],
        "expected_return": 0.092,
        "expected_vol": 0.188,
        "sharpe_ratio": 0.489,
        "regime_used": "bull_calm",
        "calculation_date": "2026-05-16",
        "diagnostics": ["observation: Phase 8 SLSQP optimization used (returns_data provided)"],
    }


def _sa_raw(corr=None) -> dict:
    return {
        "aggregated_ideal_pf": {"A": 0.5, "B": 0.5},
        "expected_return": 0.08,
        "expected_vol": 0.15,
        "sharpe_ratio": 0.53,
        "max_dd_estimate": -0.10,
        "weights_used": {"frontier": 0.4, "quality_size": 0.6},
        "regime": "bear",
        "strategy_correlations": corr if corr is not None else {"frontier_vs_quality_size": 0.80},
        "diversification_score": 0.20,
        "diagnostics": ["observation: aggregate computed"],
    }


def _ol_raw() -> dict:
    return {
        "weight_drift_per_ticker": [["A", 0.10], ["B", -0.05]],
        "total_drift_l1": 0.15,
        "total_drift_l2": 0.11,
        "constraint_return_gap": 0.01,
        "drift_return_gap": -0.02,
        "estimated_opportunity_return_gap": -0.02,
        "regime_used": "crisis",
        "diagnostics": ["observation: not an order, not a recommendation"],
    }


def _fb_raw() -> dict:
    return {
        "branches": [
            {
                "regime": "bull_calm", "expected_return": 0.09,
                "expected_vol": 0.12, "sharpe_ratio": 0.75,
                "max_dd_estimate": -0.08, "downside_case": -0.15,
                "upside_case": 0.33, "probability": 0.3,
                "is_base_regime": True,
            },
            {
                "regime": "crisis", "expected_return": 0.01,
                "expected_vol": 0.30, "sharpe_ratio": 0.03,
                "max_dd_estimate": -0.35, "downside_case": -0.59,
                "upside_case": 0.61, "probability": 0.1,
                "is_base_regime": False,
            },
        ],
        "base_regime": "bull_calm",
        "weighted_expected_return": 0.06,
        "weighted_expected_vol": 0.17,
        "worst_case_dd": -0.35,
        "worst_case_downside": -0.59,
        "best_case_upside": 0.61,
        "diagnostics": ["observation: future branches are scenario calculations, not predictions"],
    }


# ── CLASS 1: TestAdaptFrontierIndex ──────────────────────────────────────────


class TestAdaptFrontierIndex:
    def test_constituents_from_tickers_weights(self):
        out = adapt_frontier_index(_fi_raw(), generated_at="g")
        assert out["constituents"] == {"7011": 0.5, "6758": 0.3, "9984": 0.2}

    def test_total_weight_is_sum_of_weights(self):
        out = adapt_frontier_index(_fi_raw(), generated_at="g")
        assert out["total_weight"] == pytest.approx(1.0)

    def test_regime_from_regime_used(self):
        out = adapt_frontier_index(_fi_raw(), generated_at="g")
        assert out["regime"] == "bull_calm"

    def test_generated_at_caller_supplied(self):
        out = adapt_frontier_index(_fi_raw(), generated_at="2026-05-16T09:30:00+09:00")
        assert out["generated_at"] == "2026-05-16T09:30:00+09:00"

    def test_cash_fund_pct_di_reflected(self):
        out = adapt_frontier_index(_fi_raw(), generated_at="g", cash_pct=0.12, fund_pct=0.44)
        assert out["cash_pct"] == pytest.approx(0.12)
        assert out["fund_pct"] == pytest.approx(0.44)

    def test_cash_pct_absent_default_and_diagnostic(self):
        out = adapt_frontier_index(_fi_raw(), generated_at="g")
        assert out["cash_pct"] == 0.0
        joined = " ".join(out["diagnostics"])
        assert "cash_pct treated as 0.0" in joined

    def test_fund_pct_absent_default_and_diagnostic(self):
        out = adapt_frontier_index(_fi_raw(), generated_at="g")
        assert out["fund_pct"] == 0.0
        joined = " ".join(out["diagnostics"])
        assert "fund_pct treated as 0.0" in joined

    def test_di_nonzero_no_default_diagnostic(self):
        out = adapt_frontier_index(_fi_raw(), generated_at="g", cash_pct=0.12, fund_pct=0.44)
        joined = " ".join(out["diagnostics"])
        assert "cash_pct treated as 0.0" not in joined
        assert "fund_pct treated as 0.0" not in joined

    def test_metrics_passthrough(self):
        out = adapt_frontier_index(_fi_raw(), generated_at="g")
        assert out["expected_return"] == pytest.approx(0.092)
        assert out["expected_vol"] == pytest.approx(0.188)
        assert out["sharpe_ratio"] == pytest.approx(0.489)

    def test_diagnostics_passthrough(self):
        out = adapt_frontier_index(_fi_raw(), generated_at="g")
        assert any("Phase 8 SLSQP optimization used" in d for d in out["diagnostics"])

    def test_no_index_name_in_presentation(self):
        out = adapt_frontier_index(_fi_raw(), generated_at="g")
        assert "index_name" not in out

    def test_length_mismatch_diagnostic(self):
        raw = _fi_raw()
        raw["weights"] = [0.5, 0.3]  # 3 tickers vs 2 weights
        out = adapt_frontier_index(raw, generated_at="g")
        joined = " ".join(out["diagnostics"])
        assert "length mismatch" in joined
        assert len(out["constituents"]) == 2

    def test_non_dict_raw_raises_type_error(self):
        with pytest.raises(TypeError):
            adapt_frontier_index("not_a_dict", generated_at="g")  # type: ignore

    def test_input_not_mutated(self):
        raw = _fi_raw()
        snap = json.loads(json.dumps(raw))
        adapt_frontier_index(raw, generated_at="g", cash_pct=0.1)
        assert raw == snap


# ── CLASS 2: TestAdaptStrategyAggregate ──────────────────────────────────────


class TestAdaptStrategyAggregate:
    def test_aggregated_ideal_pf_renamed_to_ideal_pf(self):
        out = adapt_strategy_aggregate(_sa_raw(), timestamp="t")
        assert out["ideal_pf"] == {"A": 0.5, "B": 0.5}
        assert "aggregated_ideal_pf" not in out

    def test_timestamp_caller_supplied(self):
        out = adapt_strategy_aggregate(_sa_raw(), timestamp="2026-05-16T00:00:00+09:00")
        assert out["timestamp"] == "2026-05-16T00:00:00+09:00"

    def test_strategy_outputs_di_reflected(self):
        so = {"frontier": {"ideal_pf": {"A": 1.0}}}
        out = adapt_strategy_aggregate(_sa_raw(), timestamp="t", strategy_outputs=so)
        assert out["strategy_outputs"] == so

    def test_strategy_outputs_absent_default_and_diagnostic(self):
        out = adapt_strategy_aggregate(_sa_raw(), timestamp="t")
        assert out["strategy_outputs"] == {}
        joined = " ".join(out["diagnostics"])
        assert "strategy_outputs not provided" in joined

    def test_strategy_outputs_non_dict_defaults_empty(self):
        out = adapt_strategy_aggregate(_sa_raw(), timestamp="t", strategy_outputs="x")  # type: ignore
        assert out["strategy_outputs"] == {}
        joined = " ".join(out["diagnostics"])
        assert "strategy_outputs is not a dict" in joined

    def test_dd10_di_reflected(self):
        out = adapt_strategy_aggregate(_sa_raw(), timestamp="t", dd10_uniform_return=0.21)
        assert out["dd10_uniform_return"] == pytest.approx(0.21)

    def test_dd10_absent_default_zero_and_diagnostic(self):
        out = adapt_strategy_aggregate(_sa_raw(), timestamp="t")
        assert out["dd10_uniform_return"] == 0.0
        joined = " ".join(out["diagnostics"])
        assert "dd10_uniform_return not provided" in joined

    def test_high_correlation_warning_true_above_threshold(self):
        out = adapt_strategy_aggregate(
            _sa_raw({"frontier_vs_quality_size": 0.80}), timestamp="t"
        )
        assert out["high_correlation_warning"] is True

    def test_high_correlation_warning_false_at_or_below_threshold(self):
        out = adapt_strategy_aggregate(
            _sa_raw({"frontier_vs_quality_size": 0.70}), timestamp="t"
        )
        assert out["high_correlation_warning"] is False

    def test_high_correlation_warning_false_low(self):
        out = adapt_strategy_aggregate(
            _sa_raw({"a_vs_b": 0.30, "c_vs_d": 0.55}), timestamp="t"
        )
        assert out["high_correlation_warning"] is False

    def test_high_correlation_warning_empty_correlations_false(self):
        out = adapt_strategy_aggregate(_sa_raw({}), timestamp="t")
        assert out["high_correlation_warning"] is False

    def test_direct_passthrough_fields(self):
        out = adapt_strategy_aggregate(_sa_raw(), timestamp="t")
        assert out["regime"] == "bear"
        assert out["weights_used"] == {"frontier": 0.4, "quality_size": 0.6}
        assert out["diversification_score"] == pytest.approx(0.20)
        assert out["expected_return"] == pytest.approx(0.08)

    def test_no_expected_vol_sharpe_maxdd_in_presentation(self):
        # StrategyAggregated には expected_vol/sharpe_ratio/max_dd_estimate はない
        out = adapt_strategy_aggregate(_sa_raw(), timestamp="t")
        assert "expected_vol" not in out
        assert "sharpe_ratio" not in out
        assert "max_dd_estimate" not in out

    def test_non_dict_raw_raises_type_error(self):
        with pytest.raises(TypeError):
            adapt_strategy_aggregate(None, timestamp="t")  # type: ignore

    def test_input_not_mutated(self):
        raw = _sa_raw()
        snap = json.loads(json.dumps(raw))
        adapt_strategy_aggregate(raw, timestamp="t", strategy_outputs={"x": {}})
        assert raw == snap

    def test_strategy_outputs_di_deep_independent(self):
        so = {"frontier": {"ideal_pf": {"A": 1.0}}}
        out = adapt_strategy_aggregate(_sa_raw(), timestamp="t", strategy_outputs=so)
        out["strategy_outputs"]["frontier"]["ideal_pf"]["A"] = 999.0
        assert so["frontier"]["ideal_pf"]["A"] == 1.0


# ── CLASS 3: TestAdaptOpportunityLoss（クリーン 1:1）─────────────────────────


class TestAdaptOpportunityLoss:
    def test_weight_drift_per_ticker_to_dict(self):
        out = adapt_opportunity_loss(_ol_raw())
        assert out["weight_drift"] == {"A": 0.10, "B": -0.05}

    def test_regime_used_renamed_to_regime(self):
        out = adapt_opportunity_loss(_ol_raw())
        assert out["regime"] == "crisis"
        assert "regime_used" not in out

    def test_direct_gap_fields(self):
        out = adapt_opportunity_loss(_ol_raw())
        assert out["total_drift_l1"] == pytest.approx(0.15)
        assert out["total_drift_l2"] == pytest.approx(0.11)
        assert out["constraint_return_gap"] == pytest.approx(0.01)
        assert out["drift_return_gap"] == pytest.approx(-0.02)
        assert out["estimated_opportunity_return_gap"] == pytest.approx(-0.02)

    def test_diagnostics_passthrough(self):
        out = adapt_opportunity_loss(_ol_raw())
        assert any("not an order, not a recommendation" in d for d in out["diagnostics"])

    def test_weight_drift_per_ticker_not_in_output(self):
        out = adapt_opportunity_loss(_ol_raw())
        assert "weight_drift_per_ticker" not in out

    def test_empty_drift_list(self):
        raw = _ol_raw()
        raw["weight_drift_per_ticker"] = []
        out = adapt_opportunity_loss(raw)
        assert out["weight_drift"] == {}

    def test_non_dict_raw_raises_type_error(self):
        with pytest.raises(TypeError):
            adapt_opportunity_loss([1, 2, 3])  # type: ignore

    def test_input_not_mutated(self):
        raw = _ol_raw()
        snap = json.loads(json.dumps(raw))
        adapt_opportunity_loss(raw)
        assert raw == snap


# ── CLASS 4: TestAdaptFutureBranching（クリーン 1:1）─────────────────────────


class TestAdaptFutureBranching:
    def test_branches_converted(self):
        out = adapt_future_branching(_fb_raw())
        assert len(out["branches"]) == 2
        assert out["branches"][0]["regime"] == "bull_calm"
        assert out["branches"][0]["is_base_regime"] is True
        assert out["branches"][1]["regime"] == "crisis"

    def test_branch_fields_preserved(self):
        out = adapt_future_branching(_fb_raw())
        b = out["branches"][0]
        assert b["expected_return"] == pytest.approx(0.09)
        assert b["expected_vol"] == pytest.approx(0.12)
        assert b["sharpe_ratio"] == pytest.approx(0.75)
        assert b["max_dd_estimate"] == pytest.approx(-0.08)
        assert b["downside_case"] == pytest.approx(-0.15)
        assert b["upside_case"] == pytest.approx(0.33)
        assert b["probability"] == pytest.approx(0.3)

    def test_base_regime_direct(self):
        out = adapt_future_branching(_fb_raw())
        assert out["base_regime"] == "bull_calm"

    def test_weighted_and_worst_best_direct(self):
        out = adapt_future_branching(_fb_raw())
        assert out["weighted_expected_return"] == pytest.approx(0.06)
        assert out["weighted_expected_vol"] == pytest.approx(0.17)
        assert out["worst_case_dd"] == pytest.approx(-0.35)
        assert out["worst_case_downside"] == pytest.approx(-0.59)
        assert out["best_case_upside"] == pytest.approx(0.61)

    def test_diagnostics_passthrough(self):
        out = adapt_future_branching(_fb_raw())
        assert any("scenario calculations, not predictions" in d for d in out["diagnostics"])

    def test_max_dd_clamped_nonpositive(self):
        raw = _fb_raw()
        raw["branches"][0]["max_dd_estimate"] = 0.5  # positive -> clamp 0.0
        out = adapt_future_branching(raw)
        assert out["branches"][0]["max_dd_estimate"] == 0.0

    def test_empty_branches(self):
        raw = _fb_raw()
        raw["branches"] = []
        out = adapt_future_branching(raw)
        assert out["branches"] == []

    def test_non_dict_raw_raises_type_error(self):
        with pytest.raises(TypeError):
            adapt_future_branching(42)  # type: ignore

    def test_input_not_mutated(self):
        raw = _fb_raw()
        snap = json.loads(json.dumps(raw))
        adapt_future_branching(raw)
        assert raw == snap


# ── CLASS 5: TestBuildPresentationDocument ───────────────────────────────────


class TestBuildPresentationDocument:
    def _payload(self) -> dict:
        return adapt_frontier_index(_fi_raw(), generated_at="g")

    def test_meta_five_keys(self):
        doc = build_presentation_document(
            self._payload(), kind="frontier_index", source="s",
            generated_at="2026-05-16T00:00:00+09:00",
        )
        assert set(doc["_meta"].keys()) == {
            "version", "kind", "source", "generated_at", "not_for_trading"
        }

    def test_meta_version_v13_3(self):
        doc = build_presentation_document(
            self._payload(), kind="frontier_index", source="s", generated_at="g"
        )
        assert doc["_meta"]["version"] == "v13.3"

    def test_not_for_trading_true(self):
        doc = build_presentation_document(
            self._payload(), kind="frontier_index", source="s", generated_at="g"
        )
        assert doc["_meta"]["not_for_trading"] is True

    def test_kind_source_generated_at_reflected(self):
        doc = build_presentation_document(
            self._payload(), kind="strategy_aggregate",
            source="phase8.adapter", generated_at="2026-05-16T09:00:00+09:00",
        )
        assert doc["_meta"]["kind"] == "strategy_aggregate"
        assert doc["_meta"]["source"] == "phase8.adapter"
        assert doc["_meta"]["generated_at"] == "2026-05-16T09:00:00+09:00"

    def test_payload_under_payload_key(self):
        p = self._payload()
        doc = build_presentation_document(p, kind="frontier_index", source="s", generated_at="g")
        assert doc["payload"]["regime"] == "bull_calm"

    def test_payload_deepcopied(self):
        p = self._payload()
        doc = build_presentation_document(p, kind="frontier_index", source="s", generated_at="g")
        doc["payload"]["regime"] = "MUTATED"
        assert p["regime"] == "bull_calm"

    def test_non_dict_payload_type_error(self):
        with pytest.raises(TypeError):
            build_presentation_document("x", kind="frontier_index", source="s", generated_at="g")  # type: ignore

    def test_empty_kind_value_error(self):
        with pytest.raises(ValueError):
            build_presentation_document(self._payload(), kind="", source="s", generated_at="g")

    def test_empty_source_value_error(self):
        with pytest.raises(ValueError):
            build_presentation_document(self._payload(), kind="k", source="", generated_at="g")

    def test_empty_generated_at_value_error(self):
        with pytest.raises(ValueError):
            build_presentation_document(self._payload(), kind="k", source="s", generated_at="")

    def test_document_json_serializable(self):
        doc = build_presentation_document(
            self._payload(), kind="frontier_index", source="s", generated_at="g"
        )
        assert isinstance(json.dumps(doc), str)


# ── CLASS 6: TestAssertJsonSerializable ──────────────────────────────────────


class TestAssertJsonSerializable:
    def test_plain_ok(self):
        assert assert_json_serializable({"a": 1, "b": [1, 2], "c": None}) is None

    def test_nested_ok(self):
        assert_json_serializable({"a": {"b": {"c": [1.0, "x", True]}}})

    def test_tuple_ok(self):
        assert_json_serializable({"w": (0.6, 0.4)})

    def test_set_type_error(self):
        with pytest.raises(TypeError):
            assert_json_serializable({"bad": {1, 2, 3}})

    def test_object_type_error(self):
        class _O:
            pass
        with pytest.raises(TypeError):
            assert_json_serializable({"o": _O()})

    def test_all_adapter_outputs_serializable(self):
        for out in (
            adapt_frontier_index(_fi_raw(), generated_at="g"),
            adapt_strategy_aggregate(_sa_raw(), timestamp="t"),
            adapt_opportunity_loss(_ol_raw()),
            adapt_future_branching(_fb_raw()),
        ):
            assert_json_serializable(out)


# ── CLASS 7: TestObservationPrefixAndForbidden ───────────────────────────────


class TestObservationPrefixAndForbidden:
    def _all_outputs(self) -> list:
        return [
            adapt_frontier_index(_fi_raw(), generated_at="g"),
            adapt_strategy_aggregate(_sa_raw(), timestamp="t"),
            adapt_opportunity_loss(_ol_raw()),
            adapt_future_branching(_fb_raw()),
        ]

    def test_all_diagnostics_observation_prefix(self):
        for out in self._all_outputs():
            for d in out["diagnostics"]:
                assert d.startswith("observation: "), f"bad diag: {d!r}"

    def test_no_forbidden_decision_tokens_in_diagnostics(self):
        for out in self._all_outputs():
            for d in out["diagnostics"]:
                for tok in _FORBIDDEN_DECISION_TOKENS_UPPER:
                    assert tok not in d
                assert not _FORBIDDEN_DECISION_HOLD_PATTERN.search(d)

    def test_no_forbidden_field_names_in_output_keys(self):
        for out in self._all_outputs():
            for k in out.keys():
                assert k not in _FORBIDDEN_FIELD_NAMES

    def test_module_code_no_forbidden_decision_tokens(self):
        for s in _string_constants_excluding_docstring(_module_path()):
            for tok in _FORBIDDEN_DECISION_TOKENS_UPPER:
                assert tok not in s
            assert not _FORBIDDEN_DECISION_HOLD_PATTERN.search(s)


# ── CLASS 8: TestImportAndPathConstraints ────────────────────────────────────


class TestImportAndPathConstraints:
    def test_module_no_numpy_scipy_pandas(self):
        imports = _top_level_imports(_module_path())
        assert "numpy" not in imports
        assert "scipy" not in imports
        assert "pandas" not in imports

    def test_test_file_no_numpy_scipy_pandas(self):
        imports = _top_level_imports(Path(__file__))
        assert "numpy" not in imports
        assert "scipy" not in imports
        assert "pandas" not in imports

    def test_module_no_phase8_dataclass_import(self):
        # Flat DI: Phase 8 dataclass / Card D writer を直接 import しない
        src = _module_path().read_text(encoding="utf-8")
        tree = ast.parse(src)
        imported: set = set()
        for n in ast.walk(tree):
            if isinstance(n, ast.ImportFrom) and n.module:
                imported.add(n.module)
                for a in n.names:
                    imported.add(a.name)
            elif isinstance(n, ast.Import):
                for a in n.names:
                    imported.add(a.name)
        forbidden = {
            "FrontierIndex", "StrategyAggregateResult",
            "OpportunityLossResult", "FutureBranchingResult",
            "FutureBranch", "DrawdownEstimator",
            "engine.frontier.index_builder",
            "engine.frontier.opportunity_loss_calc",
            "engine.frontier.future_branching",
            "engine.strategies.aggregator",
            "engine.frontier.phase8_json_writer",
            "backend.engine.frontier.phase8_json_writer",
        }
        assert not (imported & forbidden), f"Flat DI 違反: {imported & forbidden}"

    def test_module_only_stdlib_imports(self):
        imports = _top_level_imports(_module_path())
        allowed = {"__future__", "copy", "json", "math", "typing"}
        assert not (imports - allowed), f"unexpected: {imports - allowed}"

    def test_module_no_datetime_now_or_time(self):
        # docstring の「datetime.now() 不使用」記述は除外し、実コードの
        # Call ノードに datetime.now() / time.time() / time.time_ns() が
        # 無いことを AST で検証する（実 import も無いことは別テストで担保）。
        tree = ast.parse(_module_path().read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                attr = node.func.attr
                base = node.func.value
                base_name = base.id if isinstance(base, ast.Name) else ""
                assert not (base_name == "datetime" and attr == "now"), (
                    "datetime.now() call found in module code"
                )
                assert not (
                    base_name == "time" and attr in ("time", "time_ns")
                ), "time.time() call found in module code"
        # 非 docstring 文字列定数にも実コードとしての呼び出し痕跡がないこと
        for s in _string_constants_excluding_docstring(_module_path()):
            assert "datetime.now(" not in s
            assert "time.time(" not in s

    def test_module_does_not_import_datetime_or_time(self):
        imports = _top_level_imports(_module_path())
        assert "datetime" not in imports
        assert "time" not in imports

    def test_module_no_public_path_literal(self):
        for s in _string_constants_excluding_docstring(_module_path()):
            assert not s.startswith("public/"), f"public path literal: {s!r}"
            assert "public/data" not in s, f"public/data literal: {s!r}"

    def test_module_no_writer_call(self):
        # writer 呼び出し禁止: write_json_atomic / build_phase8_document を呼ばない
        src = _module_path().read_text(encoding="utf-8")
        assert "write_json_atomic" not in src
        assert "build_phase8_document" not in src

    def test_build_presentation_document_no_default_meta_path(self):
        sig = inspect.signature(build_presentation_document)
        # generated_at / source / kind に默认値がない（caller 供給必須）
        for name in ("kind", "source", "generated_at"):
            assert sig.parameters[name].default is inspect.Parameter.empty
