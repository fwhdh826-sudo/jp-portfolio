"""
test_update_scores_skeleton.py — D: data/update_scores.py skeleton 検証

pure helper を注入データで検証し、phase8 互換 schema・volatility_252d
の decimal 単位・missing-safe・honesty・main 非呼出・repo 無痕を担保。

本 D では script を本番実行しない（main() / __main__ を呼ばない）。
tmp_path と注入データで pure helper を駆動するのみ。実 HTTP / yfinance
fetch なし。
"""
from __future__ import annotations

import ast
import importlib.util
import json
import math
import statistics
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCRIPT_PATH = _REPO_ROOT / "data" / "update_scores.py"
_FIXED_TS = "2026-05-20T00:00:00+00:00"

AXES = ("value", "safety", "shareholder_return", "quality", "growth",
        "momentum")


def _load_script():
    spec = importlib.util.spec_from_file_location(
        "update_scores_under_test", _SCRIPT_PATH
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _script_source() -> str:
    return _SCRIPT_PATH.read_text(encoding="utf-8")


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


def _fund_doc():
    """合成 fundamentals doc（最小・2 ticker）。"""
    return {
        "_meta": {
            "version": "v13.3", "kind": "fundamentals_raw",
            "generated_at": "2026-05-20T00:00:00+00:00",
            "not_for_trading": True, "note": "test",
        },
        "tickers": ["T001.T", "T002.T"],
        "missing": [],
        "fundamentals": {
            "T001.T": {
                "per_score": 12.0, "pbr_score": 1.5, "peg_score": 1.2,
                "div_yield": 3.0, "ev_ebitda": 9.0,
                "equity_ratio": 60.0, "de_ratio": 0.5,
                "interest_cover": 10.0, "beta_inverse": 1.0,
                "div_payout": 0.3, "buyback_yield": 1.5, "doe": 2.0,
                "div_growth_5y": 4.0, "total_yield": 3.0,
                "roe_3y_avg": 12.0, "roa": 8.0, "fcf_yield": 4.0,
                "revenue_cagr_3y": 7.0, "eps_growth_3y": 10.0,
            },
            "T002.T": {
                "per_score": 18.0, "pbr_score": 2.0,
                "equity_ratio": 45.0, "roe_3y_avg": 8.0,
            },
        },
        "status": "ok",
    }


def _returns_doc():
    return {
        "_meta": {
            "version": "v13.3", "kind": "returns_daily",
            "generated_at": "2026-05-20T00:00:00+00:00",
        },
        "frequency": "daily", "lookback": "52w",
        "tickers": ["T001.T"],
        "missing": [],
        "returns": {
            "T001.T": [0.01, -0.005, 0.012, -0.008, 0.003,
                       -0.002, 0.007, -0.011, 0.004, 0.006],
            # T002.T returns absent → volatility missing-safe
        },
        "status": "ok",
    }


# ── TestSourceStructure（AST / 静的）─────────────────────────────────────

class TestSourceStructure:
    def _tree(self) -> ast.AST:
        return ast.parse(_script_source())

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
        allowed = {"__future__", "json", "math", "shutil", "statistics",
                   "sys", "datetime", "pathlib", "typing", "backend"}
        assert self._imported_top() <= allowed

    def test_no_forbidden_imports(self):
        tops = self._imported_top()
        for bad in ("pandas", "numpy", "yfinance", "requests", "urllib",
                    "http", "httpx", "aiohttp", "socket"):
            assert bad not in tops, f"forbidden import {bad!r}"

    def test_main_guard_present(self):
        assert 'if __name__ == "__main__":' in _script_source()

    def test_no_workflow_dispatch_or_gh_in_source(self):
        src = _script_source()
        assert "workflow_dispatch" not in src
        assert "gh run" not in src
        assert "gh workflow" not in src

    def test_no_public_data_scoring_or_phase8_path_literal_in_code(self):
        # honesty docstring は public/data に言及してよい（returns.json
        # / scoring 文脈等）。コード文字列定数（非 docstring）には
        # public/data/scoring / public/data/phase8 path literal を
        # 持たない（出力先は data/ 固定）。
        tree = ast.parse(_script_source())
        doc_ids = _docstring_node_ids(tree)
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(
                node.value, str
            ):
                if id(node) in doc_ids:
                    continue
                assert "public/data/scoring" not in node.value, (
                    f"public/data/scoring path literal in code string: "
                    f"{node.value!r}"
                )
                assert "public/data/phase8" not in node.value, (
                    f"public/data/phase8 path literal in code string: "
                    f"{node.value!r}"
                )

    def test_no_forbidden_tokens_in_non_docstring_strings(self):
        tree = ast.parse(_script_source())
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

    def test_callables_present(self):
        m = _load_script()
        for name in ("now_iso_tz", "is_usable", "compute_volatility_252d",
                     "read_fundamentals_doc", "read_returns_doc",
                     "build_financial_data", "build_scores_doc",
                     "write_doc", "backup_existing", "restore_backup",
                     "main"):
            assert callable(getattr(m, name))

    def test_default_output_paths_under_data(self):
        m = _load_script()
        op = str(m.OUTPUT_PATH).replace("\\", "/")
        bp = str(m.BACKUP_PATH).replace("\\", "/")
        assert op.endswith("data/stock_scores_6axis.json")
        assert bp.endswith("data/stock_scores_6axis_backup.json")
        assert "public/data" not in op
        assert "public/data" not in bp


# ── TestComputeVolatility ─────────────────────────────────────────────

class TestComputeVolatility:
    def test_empty_none(self):
        m = _load_script()
        assert m.compute_volatility_252d([]) is None
        assert m.compute_volatility_252d(None) is None

    def test_single_value_none(self):
        m = _load_script()
        assert m.compute_volatility_252d([0.01]) is None

    def test_excludes_nan_inf_bool_nonnumeric(self):
        m = _load_script()
        # 1 有効 + 不正値 → 残 1 → None
        assert m.compute_volatility_252d(
            [0.01, float("nan"), float("inf"), True, "x"]
        ) is None
        # 2 有効値（NaN/inf/bool/非数値は除外）→ stdev*sqrt(252)
        vals = [0.01, -0.005]
        expected = statistics.stdev(vals) * math.sqrt(252.0)
        got = m.compute_volatility_252d(
            [0.01, float("nan"), -0.005, True, "y"]
        )
        assert got == pytest.approx(expected)

    def test_decimal_unit_annualized(self):
        m = _load_script()
        series = [0.01, -0.005, 0.012, -0.008, 0.003,
                  -0.002, 0.007, -0.011, 0.004, 0.006]
        expected = statistics.stdev(series) * math.sqrt(252.0)
        got = m.compute_volatility_252d(series)
        assert got == pytest.approx(expected)
        # decimal 単位（0.25=25% 年率 scorer 想定）。妥当域 < 2。
        assert 0.0 < got < 2.0


# ── TestBuildFinancialData ────────────────────────────────────────────

class TestBuildFinancialData:
    def test_does_not_mutate_input(self):
        m = _load_script()
        fund_row = {"per_score": 12.0, "equity_ratio": 60.0}
        snapshot = dict(fund_row)
        m.build_financial_data(fund_row,
                                [0.01, -0.005, 0.01, -0.01, 0.005])
        assert fund_row == snapshot

    def test_injects_volatility_when_computable(self):
        m = _load_script()
        fd = m.build_financial_data(
            {"per_score": 12.0},
            [0.01, -0.005, 0.012, -0.008, 0.003, -0.002],
        )
        assert "volatility_252d" in fd
        assert fd["per_score"] == 12.0

    def test_absent_volatility_when_returns_missing(self):
        m = _load_script()
        assert "volatility_252d" not in m.build_financial_data(
            {"per_score": 12.0}, None
        )
        assert "volatility_252d" not in m.build_financial_data(
            {"per_score": 12.0}, []
        )
        assert "volatility_252d" not in m.build_financial_data(
            {"per_score": 12.0}, [0.01]
        )

    def test_non_dict_fund_row_safe(self):
        m = _load_script()
        fd = m.build_financial_data(
            None, [0.01, -0.005, 0.012, -0.008]
        )
        assert isinstance(fd, dict)
        assert "volatility_252d" in fd


# ── TestBuildScoresDocEmpty ───────────────────────────────────────────

class TestBuildScoresDocEmpty:
    def test_empty_inputs_inconclusive(self):
        m = _load_script()
        doc = m.build_scores_doc({}, {}, generated_at=_FIXED_TS)
        assert doc["status"] == "inconclusive"
        assert doc["stock_scores_6axis"] == []
        assert doc["tickers"] == []
        assert isinstance(doc["diagnostics"], list)
        assert len(doc["diagnostics"]) >= 1

    def test_envelope_schema(self):
        m = _load_script()
        doc = m.build_scores_doc({}, {}, generated_at=_FIXED_TS)
        assert set(doc.keys()) == {
            "_meta", "last_updated", "tickers", "missing",
            "stock_scores_6axis", "diagnostics", "status",
        }
        assert set(doc["_meta"].keys()) == {
            "version", "kind", "source", "generated_at",
            "not_for_trading", "note",
        }
        assert doc["_meta"]["kind"] == "stock_scores_6axis"
        assert doc["_meta"]["version"] == "v13.3"
        assert doc["_meta"]["not_for_trading"] is True
        assert doc["_meta"]["generated_at"] == _FIXED_TS
        assert doc["last_updated"] == _FIXED_TS


# ── TestBuildScoresDocFixture ─────────────────────────────────────────

class TestBuildScoresDocFixture:
    def test_status_ok_when_fundamentals_present(self):
        m = _load_script()
        doc = m.build_scores_doc(_fund_doc(), _returns_doc(),
                                  generated_at=_FIXED_TS)
        assert doc["status"] == "ok"
        assert len(doc["stock_scores_6axis"]) == 2
        assert set(doc["tickers"]) == {"T001.T", "T002.T"}

    def test_each_row_phase8_compatible_schema(self):
        m = _load_script()
        doc = m.build_scores_doc(_fund_doc(), _returns_doc(),
                                  generated_at=_FIXED_TS)
        for row in doc["stock_scores_6axis"]:
            assert set(row.keys()) == {"ticker", "six_axis",
                                        "diagnostics"}
            six = row["six_axis"]
            assert set(six.keys()) == set(AXES)
            # phase8 build_scores_from_contract が読む形:
            #   row["six_axis"][axis]["total"] へアクセス可能
            for axis in AXES:
                assert "total" in six[axis]
                t = six[axis]["total"]
                assert isinstance(t, int)
                assert 0 <= t <= 100

    def test_volatility_missing_recorded(self):
        m = _load_script()
        doc = m.build_scores_doc(_fund_doc(), _returns_doc(),
                                  generated_at=_FIXED_TS)
        # T002.T には returns が無いため volatility_252d 不在 → missing
        miss_t002 = [
            x for x in doc["missing"]
            if x["ticker"] == "T002.T"
            and x["component"] == "volatility_252d"
        ]
        assert len(miss_t002) == 1
        miss_t001 = [
            x for x in doc["missing"]
            if x["ticker"] == "T001.T"
            and x["component"] == "volatility_252d"
        ]
        assert miss_t001 == []

    def test_no_rating_field_emitted(self):
        m = _load_script()
        doc = m.build_scores_doc(_fund_doc(), _returns_doc(),
                                  generated_at=_FIXED_TS)
        for row in doc["stock_scores_6axis"]:
            for axis in AXES:
                assert "rating" not in row["six_axis"][axis]

    def test_axis_total_int_bounded(self):
        m = _load_script()
        doc = m.build_scores_doc(_fund_doc(), _returns_doc(),
                                  generated_at=_FIXED_TS)
        for row in doc["stock_scores_6axis"]:
            for axis in AXES:
                t = row["six_axis"][axis]["total"]
                assert isinstance(t, int)
                assert 0 <= t <= 100


# ── TestHonesty ───────────────────────────────────────────────────────

class TestHonesty:
    def test_meta_note_contains_honesty(self):
        m = _load_script()
        doc = m.build_scores_doc(_fund_doc(), _returns_doc(),
                                  generated_at=_FIXED_TS)
        note = doc["_meta"]["note"]
        for frag in ("partial-real", "hybrid",
                     "not full real", "not full generated"):
            assert frag in note

    def test_diagnostics_contain_honesty(self):
        m = _load_script()
        doc = m.build_scores_doc(_fund_doc(), _returns_doc(),
                                  generated_at=_FIXED_TS)
        joined = " | ".join(doc["diagnostics"])
        for frag in ("partial-real", "hybrid",
                     "not full real", "not full generated"):
            assert frag in joined


# ── TestIOHelpersTmpPath ──────────────────────────────────────────────

class TestIOHelpersTmpPath:
    def test_write_doc_roundtrip(self, tmp_path):
        m = _load_script()
        out = tmp_path / "stock_scores_6axis.json"
        doc = m.build_scores_doc(_fund_doc(), _returns_doc(),
                                  generated_at=_FIXED_TS)
        p = m.write_doc(out, doc)
        assert Path(p) == out
        assert json.loads(out.read_text(encoding="utf-8")) == doc

    def test_backup_then_restore(self, tmp_path):
        m = _load_script()
        out = tmp_path / "x.json"
        bak = tmp_path / "x_backup.json"
        doc = m.build_scores_doc(_fund_doc(), _returns_doc(),
                                  generated_at=_FIXED_TS)
        m.write_doc(out, doc)
        assert m.backup_existing(out, bak) is True
        out.unlink()
        assert m.restore_backup(out, bak) is True
        assert json.loads(out.read_text(encoding="utf-8")) == doc

    def test_backup_false_when_no_output(self, tmp_path):
        m = _load_script()
        assert m.backup_existing(tmp_path / "absent.json",
                                   tmp_path / "absent_bak.json") is False

    def test_restore_false_when_no_backup(self, tmp_path):
        m = _load_script()
        assert m.restore_backup(tmp_path / "absent.json",
                                  tmp_path / "absent_bak.json") is False


# ── TestMainNotCalled ─────────────────────────────────────────────────

class TestMainNotCalled:
    def test_main_tripwire(self, tmp_path, monkeypatch):
        # main を tripwire 化し、pure helper exercise で呼ばれないことを
        # 動的に担保。
        m = _load_script()

        def _boom(*_a, **_k):
            raise AssertionError("main must NOT be called by test")

        monkeypatch.setattr(m, "main", _boom)
        doc = m.build_scores_doc(_fund_doc(), _returns_doc(),
                                  generated_at=_FIXED_TS)
        assert doc["status"] == "ok"
        out = tmp_path / "scores.json"
        bak = tmp_path / "scores_backup.json"
        m.write_doc(out, doc)
        assert m.backup_existing(out, bak) is True
        out.unlink()
        assert m.restore_backup(out, bak) is True


# ── TestNoRepoArtifact ────────────────────────────────────────────────

class TestNoRepoArtifact:
    def test_committed_data_stock_scores_unmodified_by_test(
        self, tmp_path
    ):
        """C live snapshot card 完了後の契約: data/stock_scores_6axis.json
        は committed snapshot として存在してよい。ただし本 test class
        の pure helper exercise が bytes を変更してはならない
        （不在/存在いずれにも成立）。"""
        p = _REPO_ROOT / "data" / "stock_scores_6axis.json"
        before = p.read_bytes() if p.exists() else None
        # pure helper のみ exercise（network/main 非呼出・tmp_path 専用）
        m = _load_script()
        doc = m.build_scores_doc(_fund_doc(), _returns_doc(),
                                  generated_at=_FIXED_TS)
        out = tmp_path / "stock_scores_6axis.json"
        bak = tmp_path / "stock_scores_6axis_backup.json"
        m.write_doc(out, doc)
        m.backup_existing(out, bak)
        m.restore_backup(out, bak)
        after = p.read_bytes() if p.exists() else None
        assert before == after, (
            "data/stock_scores_6axis.json must NOT be modified by test"
        )

    def test_no_data_stock_scores_backup_created_by_test(self):
        """test が main() を呼ばないため data/stock_scores_6axis_backup.json
        は post-test で不在のままであること（回帰防止）。"""
        assert not (
            _REPO_ROOT / "data" / "stock_scores_6axis_backup.json"
        ).exists()

    def test_committed_data_fundamentals_unmodified_by_test(self, tmp_path):
        # data/fundamentals.json は read-only fixture（存在/不在いずれ
        # でも本 test class が bytes を変えない）。
        p = _REPO_ROOT / "data" / "fundamentals.json"
        before = p.read_bytes() if p.exists() else None
        m = _load_script()
        m.build_scores_doc(_fund_doc(), _returns_doc(),
                            generated_at=_FIXED_TS)
        m.write_doc(
            tmp_path / "x.json",
            m.build_scores_doc(_fund_doc(), _returns_doc(),
                                generated_at=_FIXED_TS),
        )
        after = p.read_bytes() if p.exists() else None
        assert before == after

    def test_no_data_fundamentals_backup_created_by_test(self):
        assert not (
            _REPO_ROOT / "data" / "fundamentals_backup.json"
        ).exists()
