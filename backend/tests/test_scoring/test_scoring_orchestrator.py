"""
test_scoring_orchestrator.py — backend/engine/scoring/scoring_orchestrator.py
検証

compute_axis_scores が 6 軸 scorer を Flat-DI で compose し、
schema・missing fallback・bounded・diagnostics honesty・data/
fundamentals.json read-only 互換を保つことを検証する。
静的検査では file I/O / network / 禁止 subsystem 依存 / public/data
path literal / 禁止トークンが含まれないことを担保する。

network 非呼出・file I/O 非実行・public/data 非接触。
"""
from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest

from backend.engine.scoring import scoring_orchestrator as so

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SRC = (
    _REPO_ROOT / "backend" / "engine" / "scoring" / "scoring_orchestrator.py"
)
_FUND = _REPO_ROOT / "data" / "fundamentals.json"

AXES = ("value", "safety", "shareholder_return", "quality", "growth",
        "momentum")


def _source() -> str:
    return _SRC.read_text(encoding="utf-8")


def _docstring_node_ids(tree: ast.AST) -> set:
    ids: set = set()
    for node in ast.walk(tree):
        if isinstance(
            node, (ast.Module, ast.ClassDef, ast.FunctionDef,
                   ast.AsyncFunctionDef)
        ):
            body = getattr(node, "body", None)
            if not body:
                continue
            first = body[0]
            if (isinstance(first, ast.Expr)
                    and isinstance(first.value, ast.Constant)
                    and isinstance(first.value.value, str)):
                ids.add(id(first.value))
    return ids


# ── TestSourceStructure（AST / 静的）─────────────────────────────────────────

class TestSourceStructure:
    def _tree(self) -> ast.AST:
        return ast.parse(_source())

    def _imported_top(self) -> set:
        tops: set = set()
        for node in ast.walk(self._tree()):
            if isinstance(node, ast.Import):
                for a in node.names:
                    tops.add(a.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    tops.add(node.module.split(".")[0])
        return tops

    def test_imports_subset_allowed(self):
        allowed = {"__future__", "typing", "backend"}
        assert self._imported_top() <= allowed

    def test_no_forbidden_imports(self):
        tops = self._imported_top()
        for bad in ("pandas", "numpy", "yfinance", "requests", "urllib",
                    "http", "httpx", "aiohttp", "socket", "pathlib", "os",
                    "io", "json"):
            assert bad not in tops, f"forbidden import {bad!r}"

    def test_no_backend_subsystem_leakage(self):
        src = _source()
        for bad in ("backend.engine.operation", "backend.engine.frontier",
                    "backend.engine.regime", "backend.engine.market_intel",
                    "backend.engine.news"):
            assert bad not in src, f"forbidden subsystem reference: {bad}"

    def test_no_file_io_hints(self):
        src = _source()
        for bad in ("open(", "Path(", "with open", "json.dump",
                    "json.load", ".write_text", ".read_text", "shutil"):
            assert bad not in src, f"forbidden I/O hint: {bad}"

    def test_no_public_data_path_literal_in_code(self):
        # honesty docstring は public/data に言及してよい。コード文字列
        # 定数（非 docstring）には public/data path literal を持たない。
        tree = ast.parse(_source())
        doc_ids = _docstring_node_ids(tree)
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(
                node.value, str
            ):
                if id(node) in doc_ids:
                    continue
                assert "public/data" not in node.value, (
                    f"public/data path literal in code string "
                    f"{node.value!r}"
                )

    def test_no_workflow_dispatch_or_gh_in_source(self):
        src = _source()
        assert "workflow_dispatch" not in src
        assert "gh run" not in src
        assert "gh workflow" not in src

    def test_no_forbidden_tokens_in_non_docstring_strings(self):
        tree = ast.parse(_source())
        doc_ids = _docstring_node_ids(tree)
        upper = ("BUY", "SELL", "HOLD", "WAIT")
        snake = ("is_buy", "is_sell", "is_hold", "is_recommended",
                 "rebalance_order", "buy_amount", "sell_amount")
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(
                node.value, str
            ):
                if id(node) in doc_ids:
                    continue
                for tok in upper + snake:
                    assert tok not in node.value, (
                        f"forbidden {tok!r} in {node.value!r}"
                    )

    def test_callable_present(self):
        assert callable(getattr(so, "compute_axis_scores"))

    def test_axis_ids_constant(self):
        assert so.AXIS_IDS == AXES


# ── TestComputeAxisScoresBasic ──────────────────────────────────────────────

class TestComputeAxisScoresBasic:
    def test_returns_dict(self):
        r = so.compute_axis_scores(ticker="9999.T", financial_data={})
        assert isinstance(r, dict)

    def test_top_level_keys(self):
        r = so.compute_axis_scores(ticker="9999.T", financial_data={})
        assert set(r.keys()) == {"ticker", "axes", "diagnostics"}

    def test_ticker_preserved(self):
        r = so.compute_axis_scores(ticker="9999.T", financial_data={})
        assert r["ticker"] == "9999.T"

    def test_six_axes_present(self):
        r = so.compute_axis_scores(ticker="9999.T", financial_data={})
        assert set(r["axes"].keys()) == set(AXES)

    def test_missing_fallback_all_axes_total_50(self):
        # financial_data={} → 各 scorer の MISSING_RAW_VALUES で
        # 全 axis total = 50（round int 後）
        r = so.compute_axis_scores(ticker="9999.T", financial_data={})
        for a in AXES:
            assert r["axes"][a]["total"] == 50, (
                f"{a} total={r['axes'][a]['total']} (expected 50)"
            )

    def test_all_axes_total_bounded_0_100(self):
        r = so.compute_axis_scores(ticker="9999.T", financial_data={})
        for a in AXES:
            t = r["axes"][a]["total"]
            assert 0 <= t <= 100, f"{a} total={t} out of [0,100]"

    def test_axis_schema_keys(self):
        r = so.compute_axis_scores(ticker="9999.T", financial_data={})
        for a in AXES:
            d = r["axes"][a]
            assert set(d.keys()) == {
                "axis", "name_ja", "total", "components", "explanation"
            }
            assert d["axis"] == a

    def test_non_dict_financial_data_normalized(self):
        r = so.compute_axis_scores(ticker="X", financial_data=None)
        # None は空 dict 正規化 → 全 axis total=50
        for a in AXES:
            assert r["axes"][a]["total"] == 50


# ── TestDelegationSpy ───────────────────────────────────────────────────────

class TestDelegationSpy:
    def test_each_scorer_called_once_with_args(self, monkeypatch):
        """6 軸 scorer 各々の .calculate が 1 回ずつ呼ばれ、ticker と
        financial_data が透過することを spy で確認。"""
        calls: list = []

        def make_spy(axis_id):
            class _FakeScore:
                def to_dict(self):
                    return {
                        "axis": axis_id, "name_ja": "stub",
                        "total": 0, "components": [], "explanation": "",
                    }

            def spy(self, ticker, financial_data, *, normalizer_fn=None):
                calls.append((axis_id, ticker, financial_data))
                return _FakeScore()
            return spy

        monkeypatch.setattr(so.ValueScorer, "calculate", make_spy("value"))
        monkeypatch.setattr(so.SafetyScorer, "calculate", make_spy("safety"))
        monkeypatch.setattr(so.ShareholderReturnScorer, "calculate",
                            make_spy("shareholder_return"))
        monkeypatch.setattr(so.QualityScorer, "calculate",
                            make_spy("quality"))
        monkeypatch.setattr(so.GrowthScorer, "calculate", make_spy("growth"))
        monkeypatch.setattr(so.MomentumScorer, "calculate",
                            make_spy("momentum"))

        fd = {"per_score": 12.0, "equity_ratio": 50.0}
        so.compute_axis_scores(ticker="TST.T", financial_data=fd)

        called_axes = sorted(c[0] for c in calls)
        assert called_axes == sorted(list(AXES))
        for axis_id, t, f in calls:
            assert t == "TST.T", f"{axis_id} got ticker={t}"
            assert f is fd, (
                f"{axis_id} did not receive same financial_data ref"
            )


# ── TestDiagnostics ─────────────────────────────────────────────────────────

class TestDiagnostics:
    def test_honesty_phrases_included(self):
        r = so.compute_axis_scores(ticker="X", financial_data={})
        joined = " | ".join(r["diagnostics"])
        for frag in (
            "partial-real", "hybrid", "not full real",
            "not full generated", "MISSING_RAW_VALUES",
            "financial-sector", "technical-deferred", "volatility_252d",
        ):
            assert frag in joined, f"missing diagnostic fragment: {frag}"

    def test_diagnostics_extra_appended_at_end(self):
        extra = ["observation: caller note A",
                 "observation: caller note B"]
        r = so.compute_axis_scores(
            ticker="X", financial_data={}, diagnostics_extra=extra,
        )
        assert r["diagnostics"][-2:] == extra
        # base 文言が依然先頭側に保持される
        assert "partial-real" in " | ".join(r["diagnostics"][:-2])

    def test_diagnostics_extra_none_ok(self):
        r = so.compute_axis_scores(
            ticker="X", financial_data={}, diagnostics_extra=None,
        )
        assert all(isinstance(d, str) and d for d in r["diagnostics"])

    def test_diagnostics_extra_non_string_and_empty_filtered(self):
        r = so.compute_axis_scores(
            ticker="X", financial_data={},
            diagnostics_extra=["", 42, None, "observation: kept"],
        )
        assert r["diagnostics"][-1] == "observation: kept"
        assert "" not in r["diagnostics"]
        # base は維持
        assert any("partial-real" in d for d in r["diagnostics"])


# ── TestRealFundamentalsReadOnly ─────────────────────────────────────────────

class TestRealFundamentalsReadOnly:
    def test_real_data_all_tickers_bounded(self):
        """data/fundamentals.json を read-only fixture として 16 ticker
        で compute_axis_scores を呼び、全 axis total ∈ [0,100]。"""
        if not _FUND.exists():
            pytest.skip("data/fundamentals.json not present")
        doc = json.loads(_FUND.read_text(encoding="utf-8"))
        fund = doc.get("fundamentals", {})
        assert len(fund) >= 1
        for ticker, fd in fund.items():
            r = so.compute_axis_scores(ticker=ticker, financial_data=fd)
            assert set(r["axes"].keys()) == set(AXES)
            for a in AXES:
                t = r["axes"][a]["total"]
                assert 0 <= t <= 100, (
                    f"{ticker}/{a} total={t} out of [0,100]"
                )

    def test_committed_data_fundamentals_unmodified_by_test(self):
        """本 test class 実行で data/fundamentals.json bytes 不変。"""
        if not _FUND.exists():
            pytest.skip("data/fundamentals.json not present")
        before = _FUND.read_bytes()
        doc = json.loads(_FUND.read_text(encoding="utf-8"))
        for ticker, fd in doc.get("fundamentals", {}).items():
            so.compute_axis_scores(ticker=ticker, financial_data=fd)
        after = _FUND.read_bytes()
        assert before == after, (
            "data/fundamentals.json must NOT be modified by test"
        )

    def test_no_data_fundamentals_backup_created_by_test(self):
        assert not (
            _REPO_ROOT / "data" / "fundamentals_backup.json"
        ).exists()
