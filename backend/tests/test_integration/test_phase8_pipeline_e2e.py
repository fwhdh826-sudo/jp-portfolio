"""
test_phase8_pipeline_e2e.py — D: tmp_path 統合 E2E

producer 群 C/D/F/PF split → orchestrator → caller → adapter → writer を
**tmp_path 上で end-to-end 接続検証**する。public/data には一切書かない。

テスト配置の理由:
  本 E2E は 4 producer ドメイン（frontier / strategies / portfolio）+
  operation orchestrator/caller + frontier writer を横断する cross-domain
  統合テストであり、単一ドメインに属さないため backend/tests/test_integration/
  に置く。C producer 経由で FrontierStrategy Phase 8（scipy/SLSQP）が
  test path に入るため、backend/tests/test_operation/ には置かない
  （test_operation 群の compute 非呼出 / Flat-DI / scipy 非依存思想を維持）。

入力は明示 fixture（本番値ではない）。source 文字列で由来を明示し、
public/data には書かない（実 write は別 Card、P2-D2-actual で No-Go 確定済）。
producer / orchestrator / caller / adapter / writer は import reuse のみ
（本 E2E はそれらを変更しない）。

import root：producer は engine.* 規約、orchestrator は backend.engine.*
規約（各モジュール本体の内部 import と一致）。両者間のデータ授受は
plain dict の Flat DI でありモジュール同一性を跨がない。
"""
from __future__ import annotations

import ast
import json
import os

import pytest

from engine.operation.phase8_analysis_producer import (
    produce_phase8_analysis_raw,
)
from engine.operation.phase8_compute_producer import (
    produce_frontier_index_raw,
)
from engine.operation.phase8_pf_split_producer import (
    produce_pf_split_raw,
)
from engine.operation.phase8_strategy_aggregate_producer import (
    produce_strategy_aggregate_raw,
)
from backend.engine.operation.phase8_compute_orchestrator import (
    orchestrate_phase8_public_data,
)

# ── 固定 fixture（微小決定論・2 ticker、本番値ではない）─────────────────────

_GENERATED_AT = "2026-05-17T00:00:00+09:00"
_TIMESTAMP = "2026-05-17T00:00:00+09:00"
_SOURCE = "phase8_tmp_path_e2e_fixture"

_SCORES = {
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

_CONTEXT = {
    "returns_data": {
        "A": [0.10, -0.05, 0.08, -0.03, 0.06],
        "B": [0.02, -0.01, 0.03, -0.01, 0.02],
    },
    "mean_return_3y_by_ticker": {"A": 0.08, "B": 0.03},
    "shrinkage_alpha": 0.0,
}

_ACCOUNT_HOLDINGS = [
    {"account_id": "sbi", "ticker_or_code": "A",
     "current_weight": 0.30, "asset_class": "domestic_equity"},
    {"account_id": "sbi", "ticker_or_code": "F1",
     "current_weight": 0.20, "asset_class": "domestic_fund"},
    {"account_id": "rakuten", "ticker_or_code": "F2",
     "current_weight": 0.15, "asset_class": "overseas_fund"},
]

_TOP_DOC_KEYS = {"_meta", "payload"}
_META_KEYS = {
    "version", "kind", "source", "generated_at", "not_for_trading",
}
_EXPECTED_KINDS = {
    "frontier_index",
    "strategy_aggregate",
    "opportunity_loss",
    "future_branching",
}
_EXPECTED_FILENAMES = {
    "frontier_index.json",
    "strategy_aggregate.json",
    "opportunity_loss.json",
    "future_branching.json",
}

_FRONTIER_INDEX_PAYLOAD = {
    "constituents", "total_weight", "cash_pct", "fund_pct",
    "expected_return", "expected_vol", "sharpe_ratio", "diagnostics",
}
_STRATEGY_AGGREGATE_PAYLOAD = {
    "ideal_pf", "strategy_outputs", "dd10_uniform_return",
    "high_correlation_warning", "diagnostics",
}
_OPPORTUNITY_LOSS_PAYLOAD = {
    "weight_drift", "total_drift_l1", "total_drift_l2",
    "constraint_return_gap", "drift_return_gap",
    "estimated_opportunity_return_gap", "regime", "diagnostics",
}
_FUTURE_BRANCHING_PAYLOAD = {
    "branches", "base_regime", "weighted_expected_return",
    "weighted_expected_vol", "worst_case_dd", "worst_case_downside",
    "best_case_upside", "diagnostics",
}

# 連結リテラルを本ファイルに置かないため断片から組み立てる検査ニードル。
_PUBLIC_DATA_NEEDLE = "public" + "/" + "data"


def _run_pipeline(output_dir):
    """C/D/F/PF split producer → orchestrator を実行し written を返す。"""
    c = produce_frontier_index_raw(
        universe=("A", "B"), scores=_SCORES,
        regime="bull_calm", context=dict(_CONTEXT),
    )
    d = produce_strategy_aggregate_raw(
        universe=("A", "B"), scores=_SCORES,
        regime="bull_calm", context=dict(_CONTEXT),
    )
    f = produce_phase8_analysis_raw(
        current_pf={"A": 0.5, "B": 0.5},
        ideal_pf={"A": 0.6, "B": 0.4},
        constrained_ideal_pf={"A": 0.55, "B": 0.45},
        expected_return_by_ticker={"A": 0.08, "B": 0.03},
        expected_vol=0.12, sharpe_ratio=0.7,
        pf_weights={"A": 0.55, "B": 0.45},
        regime_expected_returns={"bull_calm": 0.09, "bear": 0.03},
        regime_expected_vols={"bull_calm": 0.12, "bear": 0.20},
        regime_expected_max_dds={"bull_calm": -0.08, "bear": -0.20},
        regime_probabilities={"bull_calm": 0.6, "bear": 0.4},
        dd10_returns=[0.10, -0.05, 0.08, -0.03, 0.06],
        regime="bull_calm", base_regime="bull_calm",
    )
    p = produce_pf_split_raw(
        account_holdings=[dict(h) for h in _ACCOUNT_HOLDINGS],
        cash_weight=0.10, regime="bull_calm",
    )
    written = orchestrate_phase8_public_data(
        output_dir=output_dir,
        generated_at=_GENERATED_AT,
        source=_SOURCE,
        frontier_index_raw=c["frontier_index_raw"],
        frontier_cash_pct=p["frontier_cash_pct"],
        frontier_fund_pct=p["frontier_fund_pct"],
        strategy_aggregate_raw=d["strategy_aggregate_raw"],
        strategy_aggregate_timestamp=_TIMESTAMP,
        strategy_outputs=d["strategy_outputs"],
        dd10_uniform_return=f["dd10_uniform_return"],
        opportunity_loss_raw=f["opportunity_loss_raw"],
        future_branching_raw=f["future_branching_raw"],
    )
    return written


def _load(path) -> dict:
    with open(path) as fh:
        return json.load(fh)


# ── TestPipelineWrites ───────────────────────────────────────────────────────

class TestPipelineWrites:
    def test_returns_four_paths(self, tmp_path):
        written = _run_pipeline(tmp_path)
        assert len(written) == 4

    def test_returned_kinds(self, tmp_path):
        written = _run_pipeline(tmp_path)
        assert set(written.keys()) == _EXPECTED_KINDS

    def test_filenames(self, tmp_path):
        written = _run_pipeline(tmp_path)
        names = {os.path.basename(str(p)) for p in written.values()}
        assert names == _EXPECTED_FILENAMES

    def test_all_paths_under_tmp_path(self, tmp_path):
        written = _run_pipeline(tmp_path)
        for p in written.values():
            assert str(p).startswith(str(tmp_path))

    def test_no_path_outside_tmp(self, tmp_path):
        # public/data 等 tmp_path 外へは一切書かない（強い正検証）
        written = _run_pipeline(tmp_path)
        for p in written.values():
            assert _PUBLIC_DATA_NEEDLE not in str(p)

    def test_all_files_exist(self, tmp_path):
        written = _run_pipeline(tmp_path)
        for p in written.values():
            assert os.path.isfile(p)

    def test_no_residual_tmp_files(self, tmp_path):
        _run_pipeline(tmp_path)
        residual = sorted(os.listdir(tmp_path))
        assert residual == sorted(_EXPECTED_FILENAMES)

    def test_idempotent_rewrite(self, tmp_path):
        _run_pipeline(tmp_path)
        _run_pipeline(tmp_path)
        assert sorted(os.listdir(tmp_path)) == sorted(_EXPECTED_FILENAMES)


# ── TestMetaEnvelope ─────────────────────────────────────────────────────────

class TestMetaEnvelope:
    def test_top_keys(self, tmp_path):
        written = _run_pipeline(tmp_path)
        for p in written.values():
            assert set(_load(p).keys()) == _TOP_DOC_KEYS

    def test_meta_five_keys(self, tmp_path):
        written = _run_pipeline(tmp_path)
        for p in written.values():
            assert set(_load(p)["_meta"].keys()) == _META_KEYS

    def test_version_v13_3(self, tmp_path):
        written = _run_pipeline(tmp_path)
        for p in written.values():
            assert _load(p)["_meta"]["version"] == "v13.3"

    def test_not_for_trading_true(self, tmp_path):
        written = _run_pipeline(tmp_path)
        for p in written.values():
            assert _load(p)["_meta"]["not_for_trading"] is True

    def test_source_fixed(self, tmp_path):
        written = _run_pipeline(tmp_path)
        for p in written.values():
            assert _load(p)["_meta"]["source"] == _SOURCE

    def test_generated_at_fixed(self, tmp_path):
        written = _run_pipeline(tmp_path)
        for p in written.values():
            assert _load(p)["_meta"]["generated_at"] == _GENERATED_AT

    def test_kind_matches_filename(self, tmp_path):
        written = _run_pipeline(tmp_path)
        for kind, p in written.items():
            assert _load(p)["_meta"]["kind"] == kind

    def test_kind_in_expected_set(self, tmp_path):
        written = _run_pipeline(tmp_path)
        for p in written.values():
            assert _load(p)["_meta"]["kind"] in _EXPECTED_KINDS


# ── TestFrontierIndexPayload ─────────────────────────────────────────────────

class TestFrontierIndexPayload:
    def _payload(self, tmp_path):
        return _load(_run_pipeline(tmp_path)["frontier_index"])["payload"]

    def test_required_keys_present(self, tmp_path):
        pl = self._payload(tmp_path)
        assert _FRONTIER_INDEX_PAYLOAD <= set(pl.keys())

    def test_constituents_is_dict(self, tmp_path):
        assert isinstance(self._payload(tmp_path)["constituents"], dict)

    def test_total_weight_is_number(self, tmp_path):
        assert isinstance(self._payload(tmp_path)["total_weight"], (int, float))

    def test_cash_pct_matches_pf_split(self, tmp_path):
        # PF split fixture: cash_weight=0.10 → frontier_cash_pct=0.10
        assert self._payload(tmp_path)["cash_pct"] == pytest.approx(0.10)

    def test_fund_pct_matches_pf_split(self, tmp_path):
        # domestic_fund 0.20 + overseas_fund 0.15 = 0.35
        assert self._payload(tmp_path)["fund_pct"] == pytest.approx(0.35)

    def test_expected_metrics_numbers(self, tmp_path):
        pl = self._payload(tmp_path)
        assert isinstance(pl["expected_return"], (int, float))
        assert isinstance(pl["expected_vol"], (int, float))
        assert isinstance(pl["sharpe_ratio"], (int, float))

    def test_diagnostics_is_list(self, tmp_path):
        assert isinstance(self._payload(tmp_path)["diagnostics"], list)


# ── TestStrategyAggregatePayload ─────────────────────────────────────────────

class TestStrategyAggregatePayload:
    def _payload(self, tmp_path):
        return _load(_run_pipeline(tmp_path)["strategy_aggregate"])["payload"]

    def test_required_keys_present(self, tmp_path):
        pl = self._payload(tmp_path)
        assert _STRATEGY_AGGREGATE_PAYLOAD <= set(pl.keys())

    def test_ideal_pf_is_dict(self, tmp_path):
        assert isinstance(self._payload(tmp_path)["ideal_pf"], dict)

    def test_strategy_outputs_four(self, tmp_path):
        so = self._payload(tmp_path)["strategy_outputs"]
        assert set(so.keys()) == {
            "frontier", "quality_size", "fundamental", "cross_factor",
        }

    def test_dd10_uniform_return_is_number(self, tmp_path):
        v = self._payload(tmp_path)["dd10_uniform_return"]
        assert isinstance(v, (int, float))

    def test_high_correlation_warning_is_bool(self, tmp_path):
        assert isinstance(
            self._payload(tmp_path)["high_correlation_warning"], bool
        )

    def test_diagnostics_is_list(self, tmp_path):
        assert isinstance(self._payload(tmp_path)["diagnostics"], list)

    def test_timestamp_fixed(self, tmp_path):
        assert self._payload(tmp_path)["timestamp"] == _TIMESTAMP

    def test_p2a1_hybrid_diagnostic_propagated(self, tmp_path):
        # D producer の real Phase 8 frontier output 経由で P2-A1 が
        # strategy_aggregate diagnostics に伝播していること
        diags = " ".join(self._payload(tmp_path)["diagnostics"])
        assert "hybrid metric sources" in diags


# ── TestOpportunityLossPayload ───────────────────────────────────────────────

class TestOpportunityLossPayload:
    def _payload(self, tmp_path):
        return _load(_run_pipeline(tmp_path)["opportunity_loss"])["payload"]

    def test_required_keys_present(self, tmp_path):
        assert set(self._payload(tmp_path).keys()) == _OPPORTUNITY_LOSS_PAYLOAD

    def test_weight_drift_is_dict(self, tmp_path):
        assert isinstance(self._payload(tmp_path)["weight_drift"], dict)

    def test_total_drift_l1_non_negative(self, tmp_path):
        assert self._payload(tmp_path)["total_drift_l1"] >= 0.0

    def test_total_drift_l2_non_negative(self, tmp_path):
        assert self._payload(tmp_path)["total_drift_l2"] >= 0.0

    def test_gaps_are_numbers(self, tmp_path):
        pl = self._payload(tmp_path)
        assert isinstance(pl["constraint_return_gap"], (int, float))
        assert isinstance(pl["drift_return_gap"], (int, float))
        assert isinstance(pl["estimated_opportunity_return_gap"], (int, float))

    def test_regime_is_str(self, tmp_path):
        assert isinstance(self._payload(tmp_path)["regime"], str)

    def test_diagnostics_is_list(self, tmp_path):
        assert isinstance(self._payload(tmp_path)["diagnostics"], list)


# ── TestFutureBranchingPayload ───────────────────────────────────────────────

class TestFutureBranchingPayload:
    def _payload(self, tmp_path):
        return _load(_run_pipeline(tmp_path)["future_branching"])["payload"]

    def test_required_keys_present(self, tmp_path):
        assert set(self._payload(tmp_path).keys()) == _FUTURE_BRANCHING_PAYLOAD

    def test_branches_is_list(self, tmp_path):
        assert isinstance(self._payload(tmp_path)["branches"], list)

    def test_branches_length_five(self, tmp_path):
        assert len(self._payload(tmp_path)["branches"]) == 5

    def test_base_regime_is_str(self, tmp_path):
        assert isinstance(self._payload(tmp_path)["base_regime"], str)

    def test_weighted_expected_vol_non_negative(self, tmp_path):
        assert self._payload(tmp_path)["weighted_expected_vol"] >= 0.0

    def test_worst_case_dd_non_positive(self, tmp_path):
        assert self._payload(tmp_path)["worst_case_dd"] <= 0.0

    def test_downside_upside_numbers(self, tmp_path):
        pl = self._payload(tmp_path)
        assert isinstance(pl["worst_case_downside"], (int, float))
        assert isinstance(pl["best_case_upside"], (int, float))

    def test_diagnostics_is_list(self, tmp_path):
        assert isinstance(self._payload(tmp_path)["diagnostics"], list)


# ── TestJsonSerializableAndDiagnostics ───────────────────────────────────────

class TestJsonSerializableAndDiagnostics:
    def test_each_doc_round_trips(self, tmp_path):
        written = _run_pipeline(tmp_path)
        for p in written.values():
            doc = _load(p)
            assert json.loads(json.dumps(doc)) == doc

    def test_payload_diagnostics_observation_prefixed(self, tmp_path):
        written = _run_pipeline(tmp_path)
        for p in written.values():
            for d in _load(p)["payload"].get("diagnostics", []):
                assert isinstance(d, str)
                assert d.startswith("observation: ")

    def test_diagnostics_present_each_output(self, tmp_path):
        written = _run_pipeline(tmp_path)
        for p in written.values():
            assert "diagnostics" in _load(p)["payload"]


# ── TestPublicDataUntouched ──────────────────────────────────────────────────

class TestPublicDataUntouched:
    def test_no_written_path_has_public_data(self, tmp_path):
        written = _run_pipeline(tmp_path)
        for p in written.values():
            assert _PUBLIC_DATA_NEEDLE not in str(p)

    def test_cwd_unchanged_no_files_created(self, tmp_path, monkeypatch):
        # pipeline 実行が cwd に副作用ファイルを作らない
        work = tmp_path / "cwd"
        work.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        monkeypatch.chdir(work)
        before = set(os.listdir(work))
        _run_pipeline(out)
        assert set(os.listdir(work)) == before

    def test_test_source_has_no_public_data_literal(self):
        # 本テストファイル非 docstring 文字列に連結リテラルが無いこと
        with open(__file__) as fh:
            tree = ast.parse(fh.read())
        doc_ids: set[int] = set()
        for node in ast.walk(tree):
            if isinstance(
                node,
                (ast.Module, ast.ClassDef, ast.FunctionDef,
                 ast.AsyncFunctionDef),
            ):
                body = getattr(node, "body", None)
                if body and isinstance(body[0], ast.Expr) and isinstance(
                    body[0].value, ast.Constant
                ) and isinstance(body[0].value.value, str):
                    doc_ids.add(id(body[0].value))
        needle = "public" + "/" + "data"
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if id(node) in doc_ids:
                    continue
                assert needle not in node.value


# ── TestNoForbiddenTokensInOutput（実行時 pipeline 出力スキャン）─────────────

class TestNoForbiddenTokensInOutput:
    """E2E pipeline が生成する 4 JSON 実出力に取引動詞・禁止フィールドが
    含まれないことを検証する（テストソース自己スキャンではなく、
    パイプラインの実成果物を検査する有意義な統合アサーション）。"""

    _UPPER = ("BUY", "SELL", "HOLD", "WAIT")
    _SNAKE = (
        "is_buy", "is_sell", "is_hold", "is_recommended",
        "rebalance_order", "buy_amount", "sell_amount",
        "shares", "quantity",
    )

    def test_no_forbidden_trade_verbs_in_output(self, tmp_path):
        written = _run_pipeline(tmp_path)
        for p in written.values():
            blob = json.dumps(_load(p), ensure_ascii=False)
            for tok in self._UPPER:
                assert tok not in blob, f"forbidden {tok!r} in {p}"

    def test_no_forbidden_fields_in_output(self, tmp_path):
        written = _run_pipeline(tmp_path)
        for p in written.values():
            blob = json.dumps(_load(p), ensure_ascii=False)
            for tok in self._SNAKE:
                assert tok not in blob, f"forbidden {tok!r} in {p}"

    def test_no_action_recommendation_keys_in_payload(self, tmp_path):
        written = _run_pipeline(tmp_path)
        for p in written.values():
            payload = _load(p)["payload"]
            for k in ("action", "recommendation", "verdict", "decision"):
                assert k not in payload

    def test_no_sci_stack_import_in_test(self):
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


# ── TestProducerOrchestratorReuseOnly ────────────────────────────────────────

class TestProducerOrchestratorReuseOnly:
    def test_producers_and_orchestrator_callable(self):
        assert callable(produce_frontier_index_raw)
        assert callable(produce_strategy_aggregate_raw)
        assert callable(produce_phase8_analysis_raw)
        assert callable(produce_pf_split_raw)
        assert callable(orchestrate_phase8_public_data)

    def test_pipeline_deterministic(self, tmp_path):
        a = tmp_path / "a"
        b = tmp_path / "b"
        a.mkdir()
        b.mkdir()
        wa = _run_pipeline(a)
        wb = _run_pipeline(b)
        for kind in _EXPECTED_KINDS:
            da = _load(wa[kind])
            db = _load(wb[kind])
            assert da == db
