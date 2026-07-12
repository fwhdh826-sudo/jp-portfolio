"""
P2-D3-compute（Scope C）— Phase 8 thin batch orchestrator テスト
backend/engine/operation/phase8_compute_orchestrator.py の batch 集約・
partial 出力・Flat DI（実 compute 非呼出）・public/data 非書き込みを検証。

テスト方針:
  - stdlib-only（ast / inspect / json / pathlib / re / dataclasses）+ pytest
  - tmp_path のみ（public/data 非書き込み・no-public-path 静的検証）
  - Flat DI / 実 compute 非呼出を AST 検証（caller のみ import reuse）
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

from backend.engine.operation.phase8_compute_orchestrator import (
    orchestrate_phase8_public_data,
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
_COMPUTE_SYMBOLS: tuple = (
    "FrontierStrategy", "StrategyAggregator", "DD10Calculator",
    "JpEquityPfBuilder", "FundPfBuilder", "UnifiedViewBuilder",
    "UnifiedView", "ExpectedReturnModel", "CovarianceModel",
    "EfficientFrontierOptimizer", "IndexBuilder",
    "OpportunityLossCalculator", "FutureBranchingCalculator",
    "DrawdownEstimator",
)


# ── helpers ───────────────────────────────────────────────────────────────────


def _module_path() -> Path:
    return (
        Path(__file__).parent.parent.parent
        / "engine" / "operation" / "phase8_compute_orchestrator.py"
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


def _from_modules(path: Path) -> set:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return {
        n.module for n in ast.walk(tree)
        if isinstance(n, ast.ImportFrom) and n.module
    }


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


def _sa_raw() -> dict:
    return {
        "aggregated_ideal_pf": {"A": 0.5, "B": 0.5},
        "expected_return": 0.08,
        "expected_vol": 0.15,
        "sharpe_ratio": 0.53,
        "max_dd_estimate": -0.10,
        "weights_used": {"frontier": 0.4, "quality_size": 0.6},
        "regime": "bear",
        "strategy_correlations": {"frontier_vs_quality_size": 0.80},
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


# ── CLASS 1: TestFrontierIndexRouting ────────────────────────────────────────


class TestFrontierIndexRouting:
    def test_routes_to_frontier_index_json(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            frontier_index_raw=_fi_raw(),
        )
        assert set(res.keys()) == {"frontier_index"}
        assert res["frontier_index"] == tmp_path / "frontier_index.json"
        assert res["frontier_index"].exists()

    def test_cash_fund_pct_passthrough(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            frontier_index_raw=_fi_raw(),
            frontier_cash_pct=0.12, frontier_fund_pct=0.44,
        )
        doc = _read(res["frontier_index"])
        assert doc["payload"]["cash_pct"] == pytest.approx(0.12)
        assert doc["payload"]["fund_pct"] == pytest.approx(0.44)

    def test_constituents_round_trip(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            frontier_index_raw=_fi_raw(),
        )
        doc = _read(res["frontier_index"])
        assert doc["payload"]["constituents"] == {"7011": 0.5, "6758": 0.3, "9984": 0.2}
        assert doc["_meta"]["kind"] == "frontier_index"

    def test_returned_value_is_path(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            frontier_index_raw=_fi_raw(),
        )
        assert isinstance(res["frontier_index"], Path)

    def test_none_frontier_index_not_written(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            opportunity_loss_raw=_ol_raw(),
        )
        assert "frontier_index" not in res
        assert not (tmp_path / "frontier_index.json").exists()


# ── CLASS 2: TestStrategyAggregateRouting ────────────────────────────────────


class TestStrategyAggregateRouting:
    def test_routes_to_strategy_aggregate_json(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            strategy_aggregate_raw=_sa_raw(),
            strategy_aggregate_timestamp="2026-05-16T00:00:00+09:00",
        )
        assert res["strategy_aggregate"] == tmp_path / "strategy_aggregate.json"
        assert res["strategy_aggregate"].exists()

    def test_timestamp_required_when_raw_present(self, tmp_path):
        with pytest.raises(ValueError):
            orchestrate_phase8_public_data(
                output_dir=tmp_path, generated_at="g", source="s",
                strategy_aggregate_raw=_sa_raw(),
            )

    def test_timestamp_none_explicit_raises(self, tmp_path):
        with pytest.raises(ValueError):
            orchestrate_phase8_public_data(
                output_dir=tmp_path, generated_at="g", source="s",
                strategy_aggregate_raw=_sa_raw(),
                strategy_aggregate_timestamp=None,
            )

    def test_timestamp_reflected(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            strategy_aggregate_raw=_sa_raw(),
            strategy_aggregate_timestamp="2026-05-16T09:00:00+09:00",
        )
        doc = _read(res["strategy_aggregate"])
        assert doc["payload"]["timestamp"] == "2026-05-16T09:00:00+09:00"

    def test_strategy_outputs_passthrough(self, tmp_path):
        so = {"frontier": {"ideal_pf": {"A": 1.0}}}
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            strategy_aggregate_raw=_sa_raw(),
            strategy_aggregate_timestamp="t",
            strategy_outputs=so,
        )
        doc = _read(res["strategy_aggregate"])
        assert doc["payload"]["strategy_outputs"] == so

    def test_dd10_passthrough(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            strategy_aggregate_raw=_sa_raw(),
            strategy_aggregate_timestamp="t",
            dd10_uniform_return=0.21,
        )
        doc = _read(res["strategy_aggregate"])
        assert doc["payload"]["dd10_uniform_return"] == pytest.approx(0.21)

    def test_aggregated_ideal_pf_renamed(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            strategy_aggregate_raw=_sa_raw(),
            strategy_aggregate_timestamp="t",
        )
        doc = _read(res["strategy_aggregate"])
        assert doc["payload"]["ideal_pf"] == {"A": 0.5, "B": 0.5}
        assert "aggregated_ideal_pf" not in doc["payload"]

    def test_high_correlation_warning_derived(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            strategy_aggregate_raw=_sa_raw(),
            strategy_aggregate_timestamp="t",
        )
        doc = _read(res["strategy_aggregate"])
        assert doc["payload"]["high_correlation_warning"] is True

    def test_none_strategy_aggregate_not_written(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            frontier_index_raw=_fi_raw(),
        )
        assert "strategy_aggregate" not in res


# ── CLASS 3: TestOpportunityLossRouting ──────────────────────────────────────


class TestOpportunityLossRouting:
    def test_routes_to_opportunity_loss_json(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            opportunity_loss_raw=_ol_raw(),
        )
        assert res["opportunity_loss"] == tmp_path / "opportunity_loss.json"
        assert res["opportunity_loss"].exists()

    def test_weight_drift_map(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            opportunity_loss_raw=_ol_raw(),
        )
        doc = _read(res["opportunity_loss"])
        assert doc["payload"]["weight_drift"] == {"A": 0.10, "B": -0.05}
        assert doc["payload"]["regime"] == "crisis"

    def test_meta_kind(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            opportunity_loss_raw=_ol_raw(),
        )
        assert _read(res["opportunity_loss"])["_meta"]["kind"] == "opportunity_loss"

    def test_none_not_written(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            future_branching_raw=_fb_raw(),
        )
        assert "opportunity_loss" not in res

    def test_no_supplementary_di_required(self, tmp_path):
        # opportunity_loss は補助 DI なしで書ける
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            opportunity_loss_raw=_ol_raw(),
        )
        assert res["opportunity_loss"].exists()


# ── CLASS 4: TestFutureBranchingRouting ──────────────────────────────────────


class TestFutureBranchingRouting:
    def test_routes_to_future_branching_json(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            future_branching_raw=_fb_raw(),
        )
        assert res["future_branching"] == tmp_path / "future_branching.json"
        assert res["future_branching"].exists()

    def test_branches_round_trip(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            future_branching_raw=_fb_raw(),
        )
        doc = _read(res["future_branching"])
        assert len(doc["payload"]["branches"]) == 1
        assert doc["payload"]["base_regime"] == "bull_calm"

    def test_meta_kind(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            future_branching_raw=_fb_raw(),
        )
        assert _read(res["future_branching"])["_meta"]["kind"] == "future_branching"

    def test_none_not_written(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            frontier_index_raw=_fi_raw(),
        )
        assert "future_branching" not in res

    def test_no_supplementary_di_required(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            future_branching_raw=_fb_raw(),
        )
        assert res["future_branching"].exists()


# ── CLASS 5: TestPartialAndBatchOutput ───────────────────────────────────────


class TestPartialAndBatchOutput:
    def test_all_four_written(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            frontier_index_raw=_fi_raw(),
            strategy_aggregate_raw=_sa_raw(), strategy_aggregate_timestamp="t",
            opportunity_loss_raw=_ol_raw(),
            future_branching_raw=_fb_raw(),
        )
        assert set(res.keys()) == {
            "frontier_index", "strategy_aggregate",
            "opportunity_loss", "future_branching",
        }
        names = sorted(p.name for p in tmp_path.iterdir())
        assert names == [
            "frontier_index.json", "future_branching.json",
            "opportunity_loss.json", "strategy_aggregate.json",
        ]

    def test_all_none_returns_empty_dict(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s"
        )
        assert res == {}
        assert list(tmp_path.iterdir()) == []

    def test_two_of_four(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            frontier_index_raw=_fi_raw(),
            future_branching_raw=_fb_raw(),
        )
        assert set(res.keys()) == {"frontier_index", "future_branching"}
        assert not (tmp_path / "strategy_aggregate.json").exists()
        assert not (tmp_path / "opportunity_loss.json").exists()

    def test_only_strategy_aggregate(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            strategy_aggregate_raw=_sa_raw(), strategy_aggregate_timestamp="t",
        )
        assert set(res.keys()) == {"strategy_aggregate"}

    def test_returned_dict_str_path(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            frontier_index_raw=_fi_raw(),
            opportunity_loss_raw=_ol_raw(),
        )
        for k, v in res.items():
            assert isinstance(k, str)
            assert isinstance(v, Path)

    def test_partial_does_not_create_other_files(self, tmp_path):
        orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            opportunity_loss_raw=_ol_raw(),
        )
        assert sorted(p.name for p in tmp_path.iterdir()) == ["opportunity_loss.json"]

    def test_kinds_match_filenames(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            frontier_index_raw=_fi_raw(),
            strategy_aggregate_raw=_sa_raw(), strategy_aggregate_timestamp="t",
            opportunity_loss_raw=_ol_raw(),
            future_branching_raw=_fb_raw(),
        )
        assert res["frontier_index"].name == "frontier_index.json"
        assert res["strategy_aggregate"].name == "strategy_aggregate.json"
        assert res["opportunity_loss"].name == "opportunity_loss.json"
        assert res["future_branching"].name == "future_branching.json"

    def test_each_written_doc_round_trips_json(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            frontier_index_raw=_fi_raw(),
            strategy_aggregate_raw=_sa_raw(), strategy_aggregate_timestamp="t",
            opportunity_loss_raw=_ol_raw(),
            future_branching_raw=_fb_raw(),
        )
        for path in res.values():
            doc = _read(path)
            assert isinstance(doc, dict)
            assert "_meta" in doc and "payload" in doc

    def test_batch_kinds_independent_payloads(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            frontier_index_raw=_fi_raw(),
            opportunity_loss_raw=_ol_raw(),
        )
        fi_doc = _read(res["frontier_index"])
        ol_doc = _read(res["opportunity_loss"])
        # 各 payload は独立（frontier の constituents が ol に混入しない等）
        assert "constituents" in fi_doc["payload"]
        assert "constituents" not in ol_doc["payload"]
        assert "weight_drift" in ol_doc["payload"]
        assert "weight_drift" not in fi_doc["payload"]


# ── CLASS 6: TestExplicitOutputDir ───────────────────────────────────────────


class TestExplicitOutputDir:
    def test_output_dir_keyword_only_no_default(self):
        sig = inspect.signature(orchestrate_phase8_public_data)
        p = sig.parameters["output_dir"]
        assert p.kind is inspect.Parameter.KEYWORD_ONLY
        assert p.default is inspect.Parameter.empty

    def test_output_dir_none_raises_when_raw_present(self):
        with pytest.raises(ValueError):
            orchestrate_phase8_public_data(
                output_dir=None, generated_at="g", source="s",
                opportunity_loss_raw=_ol_raw(),
            )

    def test_output_dir_empty_str_raises_when_raw_present(self):
        with pytest.raises(ValueError):
            orchestrate_phase8_public_data(
                output_dir="", generated_at="g", source="s",
                opportunity_loss_raw=_ol_raw(),
            )

    def test_str_output_dir_accepted(self, tmp_path):
        res = orchestrate_phase8_public_data(
            output_dir=str(tmp_path), generated_at="g", source="s",
            opportunity_loss_raw=_ol_raw(),
        )
        assert res["opportunity_loss"].exists()

    def test_empty_source_raises_when_raw_present(self, tmp_path):
        with pytest.raises(ValueError):
            orchestrate_phase8_public_data(
                output_dir=tmp_path, generated_at="g", source="",
                opportunity_loss_raw=_ol_raw(),
            )

    def test_empty_generated_at_raises_when_raw_present(self, tmp_path):
        with pytest.raises(ValueError):
            orchestrate_phase8_public_data(
                output_dir=tmp_path, generated_at="", source="s",
                opportunity_loss_raw=_ol_raw(),
            )

    def test_nested_output_dir_created(self, tmp_path):
        nested = tmp_path / "a" / "b" / "phase8"
        res = orchestrate_phase8_public_data(
            output_dir=nested, generated_at="g", source="s",
            opportunity_loss_raw=_ol_raw(),
        )
        assert res["opportunity_loss"].parent == nested


# ── CLASS 7: TestInputNonMutationAndAtomic ───────────────────────────────────


class TestInputNonMutationAndAtomic:
    def test_frontier_raw_not_mutated(self, tmp_path):
        raw = _fi_raw()
        snap = json.loads(json.dumps(raw))
        orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            frontier_index_raw=raw, frontier_cash_pct=0.1,
        )
        assert raw == snap

    def test_strategy_aggregate_raw_not_mutated(self, tmp_path):
        raw = _sa_raw()
        snap = json.loads(json.dumps(raw))
        orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            strategy_aggregate_raw=raw, strategy_aggregate_timestamp="t",
            strategy_outputs={"x": {}},
        )
        assert raw == snap

    def test_opportunity_loss_raw_not_mutated(self, tmp_path):
        raw = _ol_raw()
        snap = json.loads(json.dumps(raw))
        orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            opportunity_loss_raw=raw,
        )
        assert raw == snap

    def test_future_branching_raw_not_mutated(self, tmp_path):
        raw = _fb_raw()
        snap = json.loads(json.dumps(raw))
        orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            future_branching_raw=raw,
        )
        assert raw == snap

    def test_no_tmp_residue(self, tmp_path):
        orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            frontier_index_raw=_fi_raw(),
            strategy_aggregate_raw=_sa_raw(), strategy_aggregate_timestamp="t",
            opportunity_loss_raw=_ol_raw(),
            future_branching_raw=_fb_raw(),
        )
        leftovers = [p.name for p in tmp_path.iterdir() if p.name.startswith(".tmp_")]
        assert leftovers == []

    def test_overwrite_existing(self, tmp_path):
        (tmp_path / "opportunity_loss.json").write_text('{"old": true}', encoding="utf-8")
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            opportunity_loss_raw=_ol_raw(),
        )
        doc = _read(res["opportunity_loss"])
        assert "old" not in doc
        assert doc["_meta"]["kind"] == "opportunity_loss"


# ── CLASS 8: TestNoPublicDataWrite ───────────────────────────────────────────


class TestNoPublicDataWrite:
    def test_module_no_public_path_literal(self):
        for s in _string_constants_excluding_docstring(_module_path()):
            assert not s.startswith("public/"), f"public path literal: {s!r}"
            assert "public/data" not in s, f"public/data literal: {s!r}"

    def test_all_tests_use_tmp_path_or_negative(self):
        # orchestrate を呼ぶ全テストが tmp_path fixture を受けるか、
        # output_dir=None/"" の負例（tmp_path 不要）であることを構造検証
        src = Path(__file__).read_text(encoding="utf-8")
        tree = ast.parse(src)
        offenders: list = []
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef):
                calls = any(
                    isinstance(c, ast.Call)
                    and isinstance(c.func, ast.Name)
                    and c.func.id == "orchestrate_phase8_public_data"
                    for c in ast.walk(node)
                )
                if not calls:
                    continue
                seg = ast.get_source_segment(src, node) or ""
                uses_tmp = (
                    "output_dir=tmp_path" in seg
                    or "output_dir=str(tmp_path)" in seg
                    or "output_dir=nested" in seg
                )
                is_negative = "output_dir=None" in seg or 'output_dir=""' in seg
                params = {a.arg for a in node.args.args}
                if uses_tmp and "tmp_path" not in params:
                    offenders.append(node.name)
                if (not uses_tmp) and (not is_negative):
                    offenders.append(node.name)
        assert offenders == [], f"tmp_path/negative 構造違反: {offenders}"

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


# ── CLASS 9: TestFlatDIComputeNotInvoked ─────────────────────────────────────


class TestFlatDIComputeNotInvoked:
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

    def test_module_does_not_import_compute_symbols(self):
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
        for sym in _COMPUTE_SYMBOLS:
            assert sym not in imported, f"compute symbol imported: {sym}"
        forbidden_modules = {
            "backend.engine.strategies.frontier_strategy",
            "backend.engine.strategies.aggregator",
            "backend.engine.frontier.index_builder",
            "backend.engine.frontier.efficient_frontier",
            "backend.engine.frontier.opportunity_loss_calc",
            "backend.engine.frontier.future_branching",
            "backend.engine.frontier.drawdown_estimator",
            "backend.engine.frontier.expected_return_model",
            "backend.engine.frontier.covariance_model",
            "backend.engine.decision.dd10_kpi",
            "backend.engine.portfolio.jp_equity_pf_builder",
            "backend.engine.portfolio.fund_pf_builder",
            "backend.engine.portfolio.unified_view",
        }
        assert not (imported & forbidden_modules), (
            f"compute module imported: {imported & forbidden_modules}"
        )

    def test_module_reuses_caller_only(self):
        froms = _from_modules(_module_path())
        assert "backend.engine.operation.phase8_public_data_caller" in froms
        # adapter / writer を直接 import しない（caller 経由のみ）
        assert "backend.engine.operation.phase8_presentation_adapter" not in froms
        assert "backend.engine.frontier.phase8_json_writer" not in froms

    def test_module_only_expected_top_level_imports(self):
        imports = _top_level_imports(_module_path())
        allowed = {"__future__", "pathlib", "typing", "backend"}
        assert not (imports - allowed), f"unexpected: {imports - allowed}"

    def test_module_source_has_no_compute_call_names(self):
        # docstring を除いた実コード文字列に compute シンボルが現れない
        for s in _string_constants_excluding_docstring(_module_path()):
            for sym in _COMPUTE_SYMBOLS:
                assert sym not in s, f"compute symbol in code string: {sym}"


# ── CLASS 10: TestForbiddenAbsence ───────────────────────────────────────────


class TestForbiddenAbsence:
    def _all_docs(self, tmp_path) -> list:
        res = orchestrate_phase8_public_data(
            output_dir=tmp_path, generated_at="g", source="s",
            frontier_index_raw=_fi_raw(),
            strategy_aggregate_raw=_sa_raw(), strategy_aggregate_timestamp="t",
            opportunity_loss_raw=_ol_raw(),
            future_branching_raw=_fb_raw(),
        )
        return [_read(p) for p in res.values()]

    def test_payload_diagnostics_observation_prefix(self, tmp_path):
        for doc in self._all_docs(tmp_path):
            for d in doc["payload"]["diagnostics"]:
                assert d.startswith("observation: "), f"bad diag: {d!r}"

    def test_no_forbidden_decision_tokens_in_diagnostics(self, tmp_path):
        for doc in self._all_docs(tmp_path):
            for d in doc["payload"]["diagnostics"]:
                for tok in _FORBIDDEN_DECISION_TOKENS_UPPER:
                    assert tok not in d
                assert not _FORBIDDEN_DECISION_HOLD_PATTERN.search(d)

    def test_no_forbidden_field_in_keys(self, tmp_path):
        for doc in self._all_docs(tmp_path):
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

    def test_all_docs_meta_not_for_trading_true(self, tmp_path):
        for doc in self._all_docs(tmp_path):
            assert doc["_meta"]["not_for_trading"] is True
