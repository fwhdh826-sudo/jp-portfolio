"""
P2-D3（Scope D）— Phase 8 public-data caller foundation テスト
Operation caller（backend/engine/operation/phase8_public_data_caller.py）の
adapt→document→atomic write フルチェーンを tmp_path で統合検証。

テスト方針:
  - stdlib-only（ast / inspect / json / pathlib / re / dataclasses）+ pytest
  - tmp_path のみ（public/data 非書き込み・no-public-path 静的検証）
  - Flat DI / 実 compute 非呼出を AST 検証
  - numpy / scipy / pandas import なし
  - 禁止フィールド / 禁止語 absence assertion
  - JSON round-trip / 入力非 mutation / .tmp_* 残存なし / explicit output_dir
"""
from __future__ import annotations

import ast
import inspect
import json
import re
from pathlib import Path

import pytest

from backend.engine.operation.phase8_public_data_caller import (
    write_frontier_index_presentation,
    write_future_branching_presentation,
    write_opportunity_loss_presentation,
    write_strategy_aggregate_presentation,
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
        / "engine" / "operation" / "phase8_public_data_caller.py"
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
        ],
        "base_regime": "bull_calm",
        "weighted_expected_return": 0.06,
        "weighted_expected_vol": 0.17,
        "worst_case_dd": -0.35,
        "worst_case_downside": -0.59,
        "best_case_upside": 0.61,
        "diagnostics": ["observation: future branches are scenario calculations, not predictions"],
    }


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


# ── CLASS 1: TestWriteFrontierIndexPresentation ──────────────────────────────


class TestWriteFrontierIndexPresentation:
    def test_writes_frontier_index_json(self, tmp_path):
        p = write_frontier_index_presentation(
            _fi_raw(), output_dir=tmp_path, generated_at="g", source="s"
        )
        assert p == tmp_path / "frontier_index.json"
        assert p.exists()

    def test_round_trip_constituents(self, tmp_path):
        p = write_frontier_index_presentation(
            _fi_raw(), output_dir=tmp_path, generated_at="g", source="s"
        )
        doc = _read(p)
        assert doc["payload"]["constituents"] == {"7011": 0.5, "6758": 0.3, "9984": 0.2}
        assert doc["payload"]["total_weight"] == pytest.approx(1.0)
        assert doc["payload"]["regime"] == "bull_calm"

    def test_cash_fund_di_reflected(self, tmp_path):
        p = write_frontier_index_presentation(
            _fi_raw(), output_dir=tmp_path, generated_at="g", source="s",
            cash_pct=0.12, fund_pct=0.44,
        )
        doc = _read(p)
        assert doc["payload"]["cash_pct"] == pytest.approx(0.12)
        assert doc["payload"]["fund_pct"] == pytest.approx(0.44)

    def test_meta_kind_frontier_index(self, tmp_path):
        p = write_frontier_index_presentation(
            _fi_raw(), output_dir=tmp_path, generated_at="g", source="s"
        )
        assert _read(p)["_meta"]["kind"] == "frontier_index"

    def test_returns_written_path(self, tmp_path):
        p = write_frontier_index_presentation(
            _fi_raw(), output_dir=tmp_path, generated_at="g", source="s"
        )
        assert isinstance(p, Path)
        assert p.name == "frontier_index.json"

    def test_diagnostics_passthrough(self, tmp_path):
        p = write_frontier_index_presentation(
            _fi_raw(), output_dir=tmp_path, generated_at="g", source="s"
        )
        joined = " ".join(_read(p)["payload"]["diagnostics"])
        assert "Phase 8 SLSQP optimization used" in joined

    def test_input_not_mutated(self, tmp_path):
        raw = _fi_raw()
        snap = json.loads(json.dumps(raw))
        write_frontier_index_presentation(
            raw, output_dir=tmp_path, generated_at="g", source="s", cash_pct=0.1
        )
        assert raw == snap


# ── CLASS 2: TestWriteStrategyAggregatePresentation ──────────────────────────


class TestWriteStrategyAggregatePresentation:
    def test_writes_strategy_aggregate_json(self, tmp_path):
        p = write_strategy_aggregate_presentation(
            _sa_raw(), output_dir=tmp_path, generated_at="g", source="s", timestamp="t"
        )
        assert p == tmp_path / "strategy_aggregate.json"
        assert p.exists()

    def test_aggregated_ideal_pf_renamed(self, tmp_path):
        p = write_strategy_aggregate_presentation(
            _sa_raw(), output_dir=tmp_path, generated_at="g", source="s", timestamp="t"
        )
        doc = _read(p)
        assert doc["payload"]["ideal_pf"] == {"A": 0.5, "B": 0.5}
        assert "aggregated_ideal_pf" not in doc["payload"]

    def test_high_correlation_warning_true(self, tmp_path):
        p = write_strategy_aggregate_presentation(
            _sa_raw({"frontier_vs_quality_size": 0.80}),
            output_dir=tmp_path, generated_at="g", source="s", timestamp="t",
        )
        assert _read(p)["payload"]["high_correlation_warning"] is True

    def test_high_correlation_warning_false(self, tmp_path):
        p = write_strategy_aggregate_presentation(
            _sa_raw({"a_vs_b": 0.50}),
            output_dir=tmp_path, generated_at="g", source="s", timestamp="t",
        )
        assert _read(p)["payload"]["high_correlation_warning"] is False

    def test_dd10_di_reflected(self, tmp_path):
        p = write_strategy_aggregate_presentation(
            _sa_raw(), output_dir=tmp_path, generated_at="g", source="s",
            timestamp="t", dd10_uniform_return=0.21,
        )
        assert _read(p)["payload"]["dd10_uniform_return"] == pytest.approx(0.21)

    def test_strategy_outputs_di_reflected(self, tmp_path):
        so = {"frontier": {"ideal_pf": {"A": 1.0}}}
        p = write_strategy_aggregate_presentation(
            _sa_raw(), output_dir=tmp_path, generated_at="g", source="s",
            timestamp="t", strategy_outputs=so,
        )
        assert _read(p)["payload"]["strategy_outputs"] == so

    def test_timestamp_caller_supplied(self, tmp_path):
        p = write_strategy_aggregate_presentation(
            _sa_raw(), output_dir=tmp_path, generated_at="g", source="s",
            timestamp="2026-05-16T09:00:00+09:00",
        )
        assert _read(p)["payload"]["timestamp"] == "2026-05-16T09:00:00+09:00"

    def test_meta_kind_strategy_aggregate(self, tmp_path):
        p = write_strategy_aggregate_presentation(
            _sa_raw(), output_dir=tmp_path, generated_at="g", source="s", timestamp="t"
        )
        assert _read(p)["_meta"]["kind"] == "strategy_aggregate"

    def test_input_not_mutated(self, tmp_path):
        raw = _sa_raw()
        snap = json.loads(json.dumps(raw))
        write_strategy_aggregate_presentation(
            raw, output_dir=tmp_path, generated_at="g", source="s",
            timestamp="t", strategy_outputs={"x": {}},
        )
        assert raw == snap


# ── CLASS 3: TestWriteOpportunityLossPresentation ────────────────────────────


class TestWriteOpportunityLossPresentation:
    def test_writes_opportunity_loss_json(self, tmp_path):
        p = write_opportunity_loss_presentation(
            _ol_raw(), output_dir=tmp_path, generated_at="g", source="s"
        )
        assert p == tmp_path / "opportunity_loss.json"
        assert p.exists()

    def test_weight_drift_map(self, tmp_path):
        p = write_opportunity_loss_presentation(
            _ol_raw(), output_dir=tmp_path, generated_at="g", source="s"
        )
        doc = _read(p)
        assert doc["payload"]["weight_drift"] == {"A": 0.10, "B": -0.05}
        assert doc["payload"]["regime"] == "crisis"

    def test_gap_fields(self, tmp_path):
        p = write_opportunity_loss_presentation(
            _ol_raw(), output_dir=tmp_path, generated_at="g", source="s"
        )
        pl = _read(p)["payload"]
        assert pl["total_drift_l1"] == pytest.approx(0.15)
        assert pl["constraint_return_gap"] == pytest.approx(0.01)
        assert pl["estimated_opportunity_return_gap"] == pytest.approx(-0.02)

    def test_meta_kind_opportunity_loss(self, tmp_path):
        p = write_opportunity_loss_presentation(
            _ol_raw(), output_dir=tmp_path, generated_at="g", source="s"
        )
        assert _read(p)["_meta"]["kind"] == "opportunity_loss"

    def test_input_not_mutated(self, tmp_path):
        raw = _ol_raw()
        snap = json.loads(json.dumps(raw))
        write_opportunity_loss_presentation(
            raw, output_dir=tmp_path, generated_at="g", source="s"
        )
        assert raw == snap

    def test_returns_written_path(self, tmp_path):
        p = write_opportunity_loss_presentation(
            _ol_raw(), output_dir=tmp_path, generated_at="g", source="s"
        )
        assert p.name == "opportunity_loss.json"


# ── CLASS 4: TestWriteFutureBranchingPresentation ────────────────────────────


class TestWriteFutureBranchingPresentation:
    def test_writes_future_branching_json(self, tmp_path):
        p = write_future_branching_presentation(
            _fb_raw(), output_dir=tmp_path, generated_at="g", source="s"
        )
        assert p == tmp_path / "future_branching.json"
        assert p.exists()

    def test_branches_round_trip(self, tmp_path):
        p = write_future_branching_presentation(
            _fb_raw(), output_dir=tmp_path, generated_at="g", source="s"
        )
        doc = _read(p)
        assert len(doc["payload"]["branches"]) == 1
        assert doc["payload"]["branches"][0]["regime"] == "bull_calm"
        assert doc["payload"]["base_regime"] == "bull_calm"

    def test_weighted_worst_best(self, tmp_path):
        p = write_future_branching_presentation(
            _fb_raw(), output_dir=tmp_path, generated_at="g", source="s"
        )
        pl = _read(p)["payload"]
        assert pl["weighted_expected_return"] == pytest.approx(0.06)
        assert pl["worst_case_dd"] == pytest.approx(-0.35)
        assert pl["best_case_upside"] == pytest.approx(0.61)

    def test_meta_kind_future_branching(self, tmp_path):
        p = write_future_branching_presentation(
            _fb_raw(), output_dir=tmp_path, generated_at="g", source="s"
        )
        assert _read(p)["_meta"]["kind"] == "future_branching"

    def test_input_not_mutated(self, tmp_path):
        raw = _fb_raw()
        snap = json.loads(json.dumps(raw))
        write_future_branching_presentation(
            raw, output_dir=tmp_path, generated_at="g", source="s"
        )
        assert raw == snap

    def test_returns_written_path(self, tmp_path):
        p = write_future_branching_presentation(
            _fb_raw(), output_dir=tmp_path, generated_at="g", source="s"
        )
        assert p.name == "future_branching.json"


# ── CLASS 5: TestMetaEnvelope ────────────────────────────────────────────────


class TestMetaEnvelope:
    def _doc(self, tmp_path) -> dict:
        p = write_frontier_index_presentation(
            _fi_raw(), output_dir=tmp_path,
            generated_at="2026-05-16T00:00:00+09:00", source="phase8.caller",
        )
        return _read(p)

    def test_meta_five_keys(self, tmp_path):
        doc = self._doc(tmp_path)
        assert set(doc["_meta"].keys()) == {
            "version", "kind", "source", "generated_at", "not_for_trading"
        }

    def test_version_v13_3(self, tmp_path):
        assert self._doc(tmp_path)["_meta"]["version"] == "v13.3"

    def test_not_for_trading_true(self, tmp_path):
        assert self._doc(tmp_path)["_meta"]["not_for_trading"] is True

    def test_source_reflected(self, tmp_path):
        assert self._doc(tmp_path)["_meta"]["source"] == "phase8.caller"

    def test_generated_at_reflected(self, tmp_path):
        assert self._doc(tmp_path)["_meta"]["generated_at"] == "2026-05-16T00:00:00+09:00"

    def test_payload_key_present(self, tmp_path):
        doc = self._doc(tmp_path)
        assert "payload" in doc
        assert isinstance(doc["payload"], dict)

    def test_all_four_kinds_distinct(self, tmp_path):
        kinds = set()
        kinds.add(_read(write_frontier_index_presentation(
            _fi_raw(), output_dir=tmp_path, generated_at="g", source="s"))["_meta"]["kind"])
        kinds.add(_read(write_strategy_aggregate_presentation(
            _sa_raw(), output_dir=tmp_path, generated_at="g", source="s", timestamp="t"))["_meta"]["kind"])
        kinds.add(_read(write_opportunity_loss_presentation(
            _ol_raw(), output_dir=tmp_path, generated_at="g", source="s"))["_meta"]["kind"])
        kinds.add(_read(write_future_branching_presentation(
            _fb_raw(), output_dir=tmp_path, generated_at="g", source="s"))["_meta"]["kind"])
        assert kinds == {
            "frontier_index", "strategy_aggregate",
            "opportunity_loss", "future_branching",
        }


# ── CLASS 6: TestAtomicWriteBehavior ─────────────────────────────────────────


class TestAtomicWriteBehavior:
    def test_creates_nested_output_dir(self, tmp_path):
        nested = tmp_path / "a" / "b" / "phase8"
        p = write_frontier_index_presentation(
            _fi_raw(), output_dir=nested, generated_at="g", source="s"
        )
        assert p.exists()
        assert p.parent == nested

    def test_overwrites_existing_file(self, tmp_path):
        out = tmp_path / "frontier_index.json"
        out.write_text('{"old": true}', encoding="utf-8")
        write_frontier_index_presentation(
            _fi_raw(), output_dir=tmp_path, generated_at="g", source="s"
        )
        doc = _read(out)
        assert "old" not in doc
        assert doc["_meta"]["kind"] == "frontier_index"

    def test_no_tmp_residue(self, tmp_path):
        write_frontier_index_presentation(
            _fi_raw(), output_dir=tmp_path, generated_at="g", source="s"
        )
        write_strategy_aggregate_presentation(
            _sa_raw(), output_dir=tmp_path, generated_at="g", source="s", timestamp="t"
        )
        leftovers = [p.name for p in tmp_path.iterdir() if p.name.startswith(".tmp_")]
        assert leftovers == []

    def test_str_output_dir_accepted(self, tmp_path):
        p = write_frontier_index_presentation(
            _fi_raw(), output_dir=str(tmp_path), generated_at="g", source="s"
        )
        assert p.exists()

    def test_document_is_json_serializable(self, tmp_path):
        p = write_future_branching_presentation(
            _fb_raw(), output_dir=tmp_path, generated_at="g", source="s"
        )
        # 既に書けている = serializable。read back も成功する
        assert isinstance(_read(p), dict)

    def test_four_outputs_independent_files(self, tmp_path):
        write_frontier_index_presentation(_fi_raw(), output_dir=tmp_path, generated_at="g", source="s")
        write_strategy_aggregate_presentation(_sa_raw(), output_dir=tmp_path, generated_at="g", source="s", timestamp="t")
        write_opportunity_loss_presentation(_ol_raw(), output_dir=tmp_path, generated_at="g", source="s")
        write_future_branching_presentation(_fb_raw(), output_dir=tmp_path, generated_at="g", source="s")
        names = sorted(p.name for p in tmp_path.iterdir())
        assert names == [
            "frontier_index.json", "future_branching.json",
            "opportunity_loss.json", "strategy_aggregate.json",
        ]


# ── CLASS 7: TestExplicitOutputDir ───────────────────────────────────────────


class TestExplicitOutputDir:
    def test_output_dir_has_no_default(self):
        for fn in (
            write_frontier_index_presentation,
            write_strategy_aggregate_presentation,
            write_opportunity_loss_presentation,
            write_future_branching_presentation,
        ):
            sig = inspect.signature(fn)
            assert sig.parameters["output_dir"].default is inspect.Parameter.empty

    def test_output_dir_none_raises_value_error(self, tmp_path):
        with pytest.raises(ValueError):
            write_opportunity_loss_presentation(
                _ol_raw(), output_dir=None, generated_at="g", source="s"
            )

    def test_output_dir_empty_str_raises_value_error(self):
        with pytest.raises(ValueError):
            write_opportunity_loss_presentation(
                _ol_raw(), output_dir="", generated_at="g", source="s"
            )

    def test_empty_source_raises_value_error(self, tmp_path):
        with pytest.raises(ValueError):
            write_frontier_index_presentation(
                _fi_raw(), output_dir=tmp_path, generated_at="g", source=""
            )

    def test_empty_generated_at_raises_value_error(self, tmp_path):
        with pytest.raises(ValueError):
            write_frontier_index_presentation(
                _fi_raw(), output_dir=tmp_path, generated_at="", source="s"
            )

    def test_non_dict_raw_raises_type_error(self, tmp_path):
        with pytest.raises(TypeError):
            write_frontier_index_presentation(
                "not_a_dict", output_dir=tmp_path, generated_at="g", source="s"  # type: ignore
            )


# ── CLASS 8: TestNoPublicDataWrite ───────────────────────────────────────────


class TestNoPublicDataWrite:
    def test_module_no_public_path_literal(self):
        for s in _string_constants_excluding_docstring(_module_path()):
            assert not s.startswith("public/"), f"public path literal: {s!r}"
            assert "public/data" not in s, f"public/data literal: {s!r}"

    def test_module_no_hardcoded_default_path(self):
        # output_dir に public/data 等のデフォルトがないことを inspect で確認
        for fn in (
            write_frontier_index_presentation,
            write_strategy_aggregate_presentation,
            write_opportunity_loss_presentation,
            write_future_branching_presentation,
        ):
            sig = inspect.signature(fn)
            assert sig.parameters["output_dir"].default is inspect.Parameter.empty

    def test_all_tests_use_tmp_path_fixture(self):
        # caller を呼ぶ全テスト関数が tmp_path fixture を受け取ることを構造検証
        tree = ast.parse(Path(__file__).read_text(encoding="utf-8"))
        callers = {
            "write_frontier_index_presentation",
            "write_strategy_aggregate_presentation",
            "write_opportunity_loss_presentation",
            "write_future_branching_presentation",
        }
        offenders: list = []
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef):
                calls = any(
                    isinstance(c, ast.Call)
                    and isinstance(c.func, ast.Name)
                    and c.func.id in callers
                    for c in ast.walk(node)
                )
                if calls:
                    params = {a.arg for a in node.args.args}
                    # output_dir=None / "" の負例テストは tmp_path 不要なので許容
                    src = ast.get_source_segment(
                        Path(__file__).read_text(encoding="utf-8"), node
                    ) or ""
                    needs_tmp = "output_dir=tmp_path" in src or "output_dir=str(tmp_path)" in src or "output_dir=nested" in src
                    if needs_tmp and "tmp_path" not in params:
                        offenders.append(node.name)
        assert offenders == [], f"missing tmp_path fixture: {offenders}"

    def test_module_no_writer_redefinition(self):
        # write_json_atomic / build_phase8_document を再定義しない（reuse のみ）
        tree = ast.parse(_module_path().read_text(encoding="utf-8"))
        defined = {
            n.name for n in ast.walk(tree)
            if isinstance(n, ast.FunctionDef)
        }
        assert "write_json_atomic" not in defined
        assert "build_phase8_document" not in defined
        assert "build_presentation_document" not in defined
        assert "adapt_frontier_index" not in defined


# ── CLASS 9: TestFlatDIImportConstraints ─────────────────────────────────────


class TestFlatDIImportConstraints:
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

    def test_module_no_compute_dataclass_import(self):
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
            "FrontierStrategy", "StrategyAggregator",
            "FrontierIndex", "StrategyAggregateResult",
            "OpportunityLossResult", "FutureBranchingResult",
            "DrawdownEstimator", "DD10Calculator",
            "calc_dd10_uniform_return", "calc_max_drawdown",
            "backend.engine.strategies.frontier_strategy",
            "backend.engine.strategies.aggregator",
            "backend.engine.frontier.index_builder",
            "backend.engine.frontier.opportunity_loss_calc",
            "backend.engine.frontier.future_branching",
            "backend.engine.frontier.drawdown_estimator",
            "backend.engine.decision.dd10_kpi",
            "backend.engine.portfolio",
        }
        assert not (imported & forbidden), (
            f"Flat DI / compute 非呼出 違反: {imported & forbidden}"
        )

    def test_module_reuses_adapter_and_writer_only(self):
        # adapter（phase8_presentation_adapter）と writer（phase8_json_writer）
        # からの import reuse のみ
        src = _module_path().read_text(encoding="utf-8")
        tree = ast.parse(src)
        from_modules = {
            n.module for n in ast.walk(tree)
            if isinstance(n, ast.ImportFrom) and n.module
        }
        assert "backend.engine.operation.phase8_presentation_adapter" in from_modules
        assert "backend.engine.frontier.phase8_json_writer" in from_modules

    def test_module_only_expected_top_level_imports(self):
        imports = _top_level_imports(_module_path())
        allowed = {"__future__", "pathlib", "typing", "backend"}
        assert not (imports - allowed), f"unexpected: {imports - allowed}"

    def test_module_no_datetime_now_or_time_call(self):
        tree = ast.parse(_module_path().read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                base = node.func.value
                base_name = base.id if isinstance(base, ast.Name) else ""
                assert not (base_name == "datetime" and node.func.attr == "now")
                assert not (base_name == "time" and node.func.attr in ("time", "time_ns"))

    def test_module_does_not_import_datetime_or_time(self):
        imports = _top_level_imports(_module_path())
        assert "datetime" not in imports
        assert "time" not in imports


# ── CLASS 10: TestForbiddenAbsence ───────────────────────────────────────────


class TestForbiddenAbsence:
    def _docs(self, tmp_path) -> list:
        return [
            _read(write_frontier_index_presentation(
                _fi_raw(), output_dir=tmp_path, generated_at="g", source="s")),
            _read(write_strategy_aggregate_presentation(
                _sa_raw(), output_dir=tmp_path, generated_at="g", source="s", timestamp="t")),
            _read(write_opportunity_loss_presentation(
                _ol_raw(), output_dir=tmp_path, generated_at="g", source="s")),
            _read(write_future_branching_presentation(
                _fb_raw(), output_dir=tmp_path, generated_at="g", source="s")),
        ]

    def test_payload_diagnostics_observation_prefix(self, tmp_path):
        for doc in self._docs(tmp_path):
            for d in doc["payload"]["diagnostics"]:
                assert d.startswith("observation: "), f"bad diag: {d!r}"

    def test_no_forbidden_decision_tokens_in_diagnostics(self, tmp_path):
        for doc in self._docs(tmp_path):
            for d in doc["payload"]["diagnostics"]:
                for tok in _FORBIDDEN_DECISION_TOKENS_UPPER:
                    assert tok not in d
                assert not _FORBIDDEN_DECISION_HOLD_PATTERN.search(d)

    def test_no_forbidden_field_in_payload_or_meta_keys(self, tmp_path):
        for doc in self._docs(tmp_path):
            for k in doc.keys():
                assert k not in _FORBIDDEN_FIELD_NAMES
            for k in doc["_meta"].keys():
                assert k not in _FORBIDDEN_FIELD_NAMES
            for k in doc["payload"].keys():
                assert k not in _FORBIDDEN_FIELD_NAMES

    def test_module_code_no_forbidden_decision_tokens(self):
        for s in _string_constants_excluding_docstring(_module_path()):
            for tok in _FORBIDDEN_DECISION_TOKENS_UPPER:
                assert tok not in s
            assert not _FORBIDDEN_DECISION_HOLD_PATTERN.search(s)
