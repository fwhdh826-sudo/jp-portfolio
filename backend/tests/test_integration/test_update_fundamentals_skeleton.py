"""
test_update_fundamentals_skeleton.py — D: data/update_fundamentals.py 検証

data/update_fundamentals.py の pure helper を注入データで検証する。
build_fundamentals_doc が正準 19 component_key のみ扱い、対象外 9 /
volatility_252d / 未知 key を出さず、欠損を 0 埋めせず missing-safe で
不在化すること、schema envelope（_meta.kind=="fundamentals_raw" /
not_for_trading / note の honesty 文言）、write_doc / backup_existing /
restore_backup が tmp_path で動くこと、pure helper が yfinance / fetch を
参照しない（static）こと、test が network / fetch を呼ばないこと、
data/fundamentals.json・public/data を一切作らないことを検証する。

本 D では script を本番実行しない（main() / __main__ / fetch_raw_per_ticker
を呼ばない）。tmp_path と注入データで pure helper を駆動するのみ。
実 HTTP / yfinance fetch なし。
"""
from __future__ import annotations

import ast
import importlib.util
import json
import math
import os
from datetime import datetime
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCRIPT_PATH = _REPO_ROOT / "data" / "update_fundamentals.py"

_FIXED_TS = "2026-05-19T00:00:00+00:00"

_PURE_HELPERS = (
    "build_fundamentals_doc", "write_doc", "backup_existing",
    "restore_backup", "is_usable", "now_iso_tz",
)


def _load_script():
    spec = importlib.util.spec_from_file_location(
        "update_fundamentals_under_test", _SCRIPT_PATH
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _script_source() -> str:
    with open(_SCRIPT_PATH, encoding="utf-8") as fh:
        return fh.read()


def _docstring_node_ids(tree: ast.AST) -> set:
    ids: set = set()
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


def _sample_parsed() -> dict:
    """注入データ（network なし）。usable / 欠損 / 対象外 / 未知を混在。"""
    return {
        "6098.T": {
            # 正準 19 を全て usable で
            "per_score": 18.0, "pbr_score": 3.1, "peg_score": 1.4,
            "div_yield": 0.012, "ev_ebitda": 12.5,
            "equity_ratio": 0.55, "de_ratio": 0.4, "interest_cover": 30.0,
            "beta_inverse": 1.1,
            "div_payout": 0.25, "buyback_yield": 0.01, "doe": 0.06,
            "div_growth_5y": 0.08, "total_yield": 0.012,
            "roe_3y_avg": 0.18, "roa": 0.09, "fcf_yield": 0.05,
            "revenue_cagr_3y": 0.07, "eps_growth_3y": 0.1,
            # 対象外 9 / volatility_252d / 未知 → 全て drop されるべき
            "moat_score": 80.0, "earnings_stab": 60.0, "guidance": 55.0,
            "tam_expansion": 50.0, "trend_score": 70.0, "ma_spread": 65.0,
            "credit_ratio": 50.0, "volume_z": 40.0,
            "relative_strength": 60.0, "volatility_252d": 0.22,
            "unknown_key": 123.0,
        },
        "8306.T": {
            # 一部欠損 / not_usable（不在化されるべき・0 埋め禁止）
            # 注: 数値文字列は float() 可で usable（trial 前例と整合）。
            # not_usable を示すため equity_ratio は非数値文字列にする。
            "per_score": 9.0, "pbr_score": 0.7,
            "peg_score": None, "div_yield": float("nan"),
            "ev_ebitda": float("inf"), "beta_inverse": True,
            "equity_ratio": "n/a",
            "div_payout": 0.4,
        },
        "9999.T": {
            # usable component ゼロ → fundamentals に載らない
            "per_score": None, "moat_score": 50.0,
        },
    }


# ── TestScriptStructure（AST・静的）──────────────────────────────────────────

class TestScriptStructure:
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
        allowed = {
            "__future__", "json", "math", "shutil", "sys",
            "datetime", "pathlib", "typing", "yfinance",
        }
        assert self._imported_top() <= allowed

    def test_no_backend_import(self):
        # standalone data script。backend を import しない
        assert "backend" not in self._imported_top()

    def test_no_extra_http_client_imports(self):
        # yfinance のみ network ライブラリ。requests/urllib 等は import しない
        tops = self._imported_top()
        for forbidden in ("requests", "urllib", "http", "httpx",
                          "aiohttp", "socket"):
            assert forbidden not in tops, f"unexpected import {forbidden!r}"

    def test_main_guard_present(self):
        assert 'if __name__ == "__main__":' in _script_source()

    def test_callables_present(self):
        m = _load_script()
        for name in ("now_iso_tz", "is_usable", "build_fundamentals_doc",
                     "write_doc", "backup_existing", "restore_backup",
                     "derive_components", "_div_year_sums",
                     "fetch_raw_per_ticker", "main"):
            assert callable(getattr(m, name))

    def test_default_paths_under_data_not_public(self):
        m = _load_script()
        op = str(m.OUTPUT_PATH).replace(os.sep, "/")
        bp = str(m.BACKUP_PATH).replace(os.sep, "/")
        assert op.endswith("data/fundamentals.json")
        assert bp.endswith("data/fundamentals_backup.json")
        assert "public/data" not in op
        assert "public/data" not in bp

    def test_no_public_data_path_literal_in_code(self):
        # honesty docstring は public/data に言及してよい（volatility_252d
        # の出所 / public/data 出力は後続 Card 等）。禁止すべきは
        # **コード文字列定数**に public/data path literal が無いこと。
        tree = ast.parse(_script_source())
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
        src = _script_source()
        assert "workflow_dispatch" not in src
        assert "gh run" not in src
        assert "gh workflow" not in src

    def test_pure_helpers_do_not_reference_network(self):
        # build/write/backup/restore/derive/_div は yfinance/fetch 非参照
        tree = ast.parse(_script_source())
        targets = {"build_fundamentals_doc", "write_doc",
                   "backup_existing", "restore_backup",
                   "derive_components", "_div_year_sums"}
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name in targets:
                names: set = set()
                for sub in ast.walk(node):
                    if isinstance(sub, ast.Name):
                        names.add(sub.id)
                    elif isinstance(sub, ast.Attribute):
                        names.add(sub.attr)
                assert "yf" not in names, f"{node.name} references yf"
                assert "yfinance" not in names
                assert "fetch_raw_per_ticker" not in names, (
                    f"{node.name} references fetch_raw_per_ticker"
                )

    def test_no_forbidden_tokens_in_non_docstring_strings(self):
        tree = ast.parse(_script_source())
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

    def test_canonical_keys_are_nineteen(self):
        m = _load_script()
        assert len(m.CANONICAL_KEYS) == 19
        assert len(set(m.CANONICAL_KEYS)) == 19

    def test_out_of_scope_constants(self):
        m = _load_script()
        assert set(m.OUT_OF_SCOPE_COMPONENTS) == {
            "moat_score", "earnings_stab", "guidance", "tam_expansion",
            "trend_score", "ma_spread", "credit_ratio", "volume_z",
            "relative_strength",
        }
        assert m.RETURNS_DERIVED_COMPONENTS == ("volatility_252d",)

    def test_meta_constants(self):
        m = _load_script()
        assert m.META_KIND == "fundamentals_raw"
        assert m.META_VERSION == "v13.3"
        assert m.META_SOURCE == "yfinance"
        for frag in ("presence!=correctness", "partial-real hybrid",
                     "not full real"):
            assert frag in m.META_NOTE


# ── TestBuildFundamentalsDoc（注入データ・network なし）────────────────────────

class TestBuildFundamentalsDoc:
    def _doc(self):
        m = _load_script()
        return m, m.build_fundamentals_doc(
            _sample_parsed(), generated_at=_FIXED_TS
        )

    def test_envelope_schema(self):
        _m, doc = self._doc()
        assert set(doc.keys()) == {
            "_meta", "last_updated", "tickers", "missing",
            "fundamentals", "status",
        }
        assert set(doc["_meta"].keys()) == {
            "version", "kind", "source", "generated_at",
            "not_for_trading", "note",
        }

    def test_meta_kind_and_flags(self):
        _m, doc = self._doc()
        assert doc["_meta"]["kind"] == "fundamentals_raw"
        assert doc["_meta"]["version"] == "v13.3"
        assert doc["_meta"]["not_for_trading"] is True

    def test_meta_note_honesty(self):
        _m, doc = self._doc()
        note = doc["_meta"]["note"]
        for frag in ("presence!=correctness", "partial-real hybrid",
                     "not full real"):
            assert frag in note

    def test_generated_at_tz_aware(self):
        _m, doc = self._doc()
        parsed = datetime.fromisoformat(doc["_meta"]["generated_at"])
        assert parsed.tzinfo is not None
        assert doc["_meta"]["generated_at"] == _FIXED_TS
        assert doc["last_updated"] == _FIXED_TS

    def test_only_canonical_keys_emitted(self):
        m, doc = self._doc()
        canon = set(m.CANONICAL_KEYS)
        for _t, row in doc["fundamentals"].items():
            assert set(row.keys()) <= canon

    def test_full_ticker_has_all_19(self):
        m, doc = self._doc()
        assert set(doc["fundamentals"]["6098.T"].keys()) == set(
            m.CANONICAL_KEYS
        )

    def test_out_of_scope_and_volatility_not_emitted(self):
        m, doc = self._doc()
        for _t, row in doc["fundamentals"].items():
            for bad in m.OUT_OF_SCOPE_COMPONENTS:
                assert bad not in row
            assert "volatility_252d" not in row
            assert "unknown_key" not in row

    def test_absent_and_not_usable_are_missing_not_zero(self):
        _m, doc = self._doc()
        # 8306.T: peg_score(None) / div_yield(NaN) / ev_ebitda(inf) /
        # beta_inverse(bool) / equity_ratio(非数値str) は不在（0 埋めしない）
        row = doc["fundamentals"]["8306.T"]
        for k in ("peg_score", "div_yield", "ev_ebitda", "beta_inverse",
                  "equity_ratio"):
            assert k not in row
        # usable のものは残る
        assert row["per_score"] == 9.0
        assert row["pbr_score"] == 0.7
        assert row["div_payout"] == 0.4
        # 0 埋めされていない（値はすべて入力どおり、0.0 が紛れない）
        assert 0.0 not in row.values()

    def test_missing_records_reasons(self):
        _m, doc = self._doc()
        miss = doc["missing"]
        assert all(set(r.keys()) == {"ticker", "component", "reason"}
                   for r in miss)
        reasons = {r["reason"] for r in miss}
        assert "absent" in reasons
        assert "not_usable" in reasons
        # 9999.T は usable ゼロ → no_usable_component
        assert any(r["ticker"] == "9999.T"
                   and r["reason"] == "no_usable_component" for r in miss)

    def test_zero_usable_ticker_excluded(self):
        _m, doc = self._doc()
        assert "9999.T" not in doc["fundamentals"]
        assert "9999.T" not in doc["tickers"]
        assert "6098.T" in doc["tickers"]
        assert "8306.T" in doc["tickers"]

    def test_status_ok_when_usable_present(self):
        _m, doc = self._doc()
        assert doc["status"] == "ok"

    def test_status_inconclusive_when_all_unusable(self):
        m = _load_script()
        doc = m.build_fundamentals_doc(
            {"1111.T": {"per_score": None, "moat_score": 50.0}},
            generated_at=_FIXED_TS,
        )
        assert doc["status"] == "inconclusive"
        assert doc["fundamentals"] == {}
        assert doc["tickers"] == []

    def test_empty_input_inconclusive(self):
        m = _load_script()
        doc = m.build_fundamentals_doc({}, generated_at=_FIXED_TS)
        assert doc["status"] == "inconclusive"
        assert doc["fundamentals"] == {}

    def test_deterministic_fixed_ts(self):
        m = _load_script()
        a = m.build_fundamentals_doc(_sample_parsed(), generated_at=_FIXED_TS)
        b = m.build_fundamentals_doc(_sample_parsed(), generated_at=_FIXED_TS)
        assert a == b

    def test_json_serializable(self):
        _m, doc = self._doc()
        assert json.loads(json.dumps(doc)) == doc

    def test_is_usable_rejects_bool_nan_inf_none_str(self):
        m = _load_script()
        assert m.is_usable(1.5) is True
        assert m.is_usable(0.0) is True
        assert m.is_usable(True) is False
        assert m.is_usable(None) is False
        assert m.is_usable(float("nan")) is False
        assert m.is_usable(math.inf) is False
        assert m.is_usable("x") is False


# ── TestIOHelpersTmpPath ─────────────────────────────────────────────────────

class TestIOHelpersTmpPath:
    def test_write_doc_roundtrip(self, tmp_path):
        m = _load_script()
        out = tmp_path / "fundamentals.json"
        doc = m.build_fundamentals_doc(_sample_parsed(),
                                       generated_at=_FIXED_TS)
        p = m.write_doc(out, doc)
        assert Path(p) == out
        assert json.loads(out.read_text(encoding="utf-8")) == doc

    def test_backup_existing_false_when_no_output(self, tmp_path):
        m = _load_script()
        out = tmp_path / "fundamentals.json"
        bak = tmp_path / "fundamentals_backup.json"
        assert m.backup_existing(out, bak) is False
        assert not bak.exists()

    def test_backup_then_restore(self, tmp_path):
        m = _load_script()
        out = tmp_path / "fundamentals.json"
        bak = tmp_path / "fundamentals_backup.json"
        doc = m.build_fundamentals_doc(_sample_parsed(),
                                       generated_at=_FIXED_TS)
        m.write_doc(out, doc)
        assert m.backup_existing(out, bak) is True
        assert bak.exists()
        out.unlink()
        assert m.restore_backup(out, bak) is True
        assert json.loads(out.read_text(encoding="utf-8")) == doc

    def test_restore_backup_false_when_no_backup(self, tmp_path):
        m = _load_script()
        out = tmp_path / "fundamentals.json"
        bak = tmp_path / "fundamentals_backup.json"
        assert m.restore_backup(out, bak) is False
        assert not out.exists()


# ── TestNoNetworkNoRepoWrite ─────────────────────────────────────────────────

class TestNoNetworkNoRepoWrite:
    def test_fetch_not_invoked_by_helpers(self, tmp_path, monkeypatch):
        # fetch_raw_per_ticker を tripwire 化。pure helper 経路で
        # 一切呼ばれないことを担保（network 非呼出の動的保証）。
        m = _load_script()

        def _boom(*_a, **_k):
            raise AssertionError("fetch_raw_per_ticker must NOT be called")

        monkeypatch.setattr(m, "fetch_raw_per_ticker", _boom)
        doc = m.build_fundamentals_doc(_sample_parsed(),
                                       generated_at=_FIXED_TS)
        out = tmp_path / "fundamentals.json"
        bak = tmp_path / "fundamentals_backup.json"
        m.write_doc(out, doc)
        assert m.backup_existing(out, bak) is True
        out.unlink()
        assert m.restore_backup(out, bak) is True

    def test_committed_data_fundamentals_unmodified_by_test(self, tmp_path):
        """G 完了後の契約: data/fundamentals.json は committed raw snapshot
        として存在してよい。ただし本 test class の pure helper exercise が
        bytes を変更してはならない（不在/存在いずれにも成立）。"""
        p = _REPO_ROOT / "data" / "fundamentals.json"
        before = p.read_bytes() if p.exists() else None
        # pure helper のみを exercise（network/fetch/main 非呼出）
        m = _load_script()
        doc = m.build_fundamentals_doc(_sample_parsed(),
                                       generated_at=_FIXED_TS)
        out = tmp_path / "fundamentals.json"
        bak = tmp_path / "fundamentals_backup.json"
        m.write_doc(out, doc)
        m.backup_existing(out, bak)
        m.restore_backup(out, bak)
        after = p.read_bytes() if p.exists() else None
        assert before == after, (
            "data/fundamentals.json must NOT be modified by test"
        )

    def test_no_data_fundamentals_backup_created_by_test(self):
        """test が main()/fetch を呼ばないため data/fundamentals_backup.json
        は post-test で不在のままであること（回帰防止）。"""
        assert not (
            _REPO_ROOT / "data" / "fundamentals_backup.json"
        ).exists()

    def test_no_public_data_written(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        m = _load_script()
        doc = m.build_fundamentals_doc(_sample_parsed(),
                                       generated_at=_FIXED_TS)
        m.write_doc(tmp_path / "fundamentals.json", doc)
        assert not (tmp_path / "public").exists()
        assert not (_REPO_ROOT / "public" / "data"
                    / "fundamentals.json").exists()


# ── fixture stubs（yfinance 非依存・network なし）─────────────────────────────

class _StmtRow:
    def __init__(self, vals):
        self._vals = vals

    def tolist(self):
        return list(self._vals)


class _StmtLoc:
    def __init__(self, rows):
        self._rows = rows

    def __getitem__(self, label):
        return _StmtRow(self._rows[label])


class _Stmt:
    """yfinance statement stub: 行＝項目 / 列＝期（最新先頭）。"""

    def __init__(self, rows):
        self._rows = dict(rows)
        self.empty = not self._rows

    @property
    def index(self):
        return list(self._rows.keys())

    @property
    def loc(self):
        return _StmtLoc(self._rows)


class _TS:
    def __init__(self, year):
        self.year = year


class _Div:
    """yfinance dividends stub: items() -> (TS(year), value)。"""

    def __init__(self, pairs):
        self._p = [(_TS(y), v) for y, v in pairs]

    def __len__(self):
        return len(self._p)

    def items(self):
        return list(self._p)


class _Fast:
    def __init__(self, market_cap):
        self.market_cap = market_cap


def _formula_fixture():
    info = {
        "trailingPE": 18.0, "priceToBook": 3.0, "pegRatio": 1.5,
        "enterpriseToEbitda": 12.0, "beta": 1.1, "payoutRatio": 0.25,
        # yfinance 1.2.0 は dividendYield を percent 等倍で返す
        # （D′ 実測: KDDI 3.12 等）。等倍 pass-through を pin。
        "dividendYield": 3.12,
    }
    bs = _Stmt({
        "Stockholders Equity": [1000.0, 1000.0, 1000.0],
        "Total Assets": [2000.0, 2000.0, 2000.0],
        "Total Liabilities Net Minority Interest": [800.0, 800.0, 800.0],
        "Ordinary Share Number": [95.0, 96.0, 100.0],
    })
    fin = _Stmt({
        "EBIT": [300.0, 280.0, 260.0],
        "Interest Expense": [-10.0, -9.0, -8.0],   # 負値（符号修正検証）
        "Total Revenue": [121.0, 110.0, 100.0],    # 最新先頭
        "Net Income": [200.0, 180.0, 160.0],
    })
    cf = _Stmt({
        "Operating Cash Flow": [80.0, 70.0, 60.0],
        "Capital Expenditure": [-30.0, -25.0, -20.0],
        "Cash Dividends Paid": [-50.0, -45.0, -40.0],
    })
    div = _Div([(2020, 10.0), (2021, 12.0), (2022, 14.0),
                (2023, 16.0), (2024, 18.0), (2025, 20.0)])
    fast = _Fast(1000.0)
    return info, bs, fin, cf, div, fast


# ── TestDeriveComponentsFormula ──────────────────────────────────────────────

class TestDeriveComponentsFormula:
    def _derive(self):
        m = _load_script()
        return m, m.derive_components(*_formula_fixture())

    def test_passthrough_raw_unchanged(self):
        _m, r = self._derive()
        assert r["per_score"] == 18.0
        assert r["pbr_score"] == 3.0
        assert r["peg_score"] == 1.5
        assert r["ev_ebitda"] == 12.0
        assert r["beta_inverse"] == 1.1          # 生 β passthrough
        assert r["div_payout"] == 0.25           # ratio 維持（%化しない）

    def test_div_yield_total_yield_passthrough_no_x100(self):
        # yfinance 1.2.0 は dividendYield を percent 等倍で返す
        # （D′ 実測）→ ×100 せず等倍 pass-through（fixture=3.12）。
        _m, r = self._derive()
        assert r["div_yield"] == pytest.approx(3.12)
        assert r["total_yield"] == pytest.approx(3.12)
        # 回帰防止: dividendYield*100（=312）になっていないこと
        assert r["div_yield"] != pytest.approx(312.0)
        assert r["total_yield"] != pytest.approx(312.0)

    def test_equity_ratio_percent_not_fraction(self):
        _m, r = self._derive()
        assert r["equity_ratio"] == pytest.approx(50.0)  # 1000/2000*100
        assert r["equity_ratio"] != pytest.approx(0.5)

    def test_de_ratio_is_multiple_not_percent(self):
        _m, r = self._derive()
        assert r["de_ratio"] == pytest.approx(0.8)       # 800/1000 倍率

    def test_interest_cover_positive_despite_negative_expense(self):
        _m, r = self._derive()
        assert r["interest_cover"] == pytest.approx(30.0)  # 300/abs(-10)
        assert r["interest_cover"] > 0

    def test_roe_roa_fcf_percent(self):
        _m, r = self._derive()
        assert r["roe_3y_avg"] == pytest.approx(18.0)   # mean(200,180,160)/1000*100
        assert r["roa"] == pytest.approx(10.0)          # 200/2000*100
        assert r["fcf_yield"] == pytest.approx(5.0)     # (80-30)/1000*100

    def test_revenue_eps_growth_percent_latest_first(self):
        _m, r = self._derive()
        assert r["revenue_cagr_3y"] == pytest.approx(10.0)  # (121/100)^.5-1)*100
        assert r["eps_growth_3y"] == pytest.approx(
            ((200.0 / 160.0) ** 0.5 - 1.0) * 100.0
        )
        # 最新先頭前提: rev[0]=121(最新) → 正の成長（誤って逆順なら負）
        assert r["revenue_cagr_3y"] > 0

    def test_buyback_yield_percent_reduction(self):
        _m, r = self._derive()
        # share-count 100(最古)→95(最新): (100-95)/100*100 = 5.0
        assert r["buyback_yield"] == pytest.approx(5.0)

    def test_doe_correct_scale_percent(self):
        _m, r = self._derive()
        assert r["doe"] == pytest.approx(5.0)           # abs(-50)/1000*100

    def test_div_growth_5y_percent(self):
        _m, r = self._derive()
        assert r["div_growth_5y"] == pytest.approx(
            ((20.0 / 10.0) ** (1.0 / 5.0) - 1.0) * 100.0
        )

    def test_only_canonical_keys_no_out_of_scope(self):
        m, r = self._derive()
        assert set(r.keys()) <= set(m.CANONICAL_KEYS)
        for bad in m.OUT_OF_SCOPE_COMPONENTS:
            assert bad not in r
        assert "volatility_252d" not in r

    def test_missing_safe_empty_inputs(self):
        m = _load_script()
        assert m.derive_components({}, None, None, None, None, None) == {}

    def test_missing_safe_no_zero_fill_on_absent_rows(self):
        m = _load_script()
        # bs/fin/cf 欠損 → statement 由来 component は不在（0 埋めしない）
        info = {"trailingPE": 12.0}
        r = m.derive_components(info, None, None, None, None, None)
        assert r == {"per_score": 12.0}
        assert "equity_ratio" not in r
        assert "roe_3y_avg" not in r
        assert 0.0 not in r.values()

    def test_missing_safe_rejects_nan_inf_bool_str(self):
        m = _load_script()
        info = {
            "trailingPE": float("nan"), "priceToBook": float("inf"),
            "beta": True, "payoutRatio": "x", "pegRatio": 1.5,
        }
        r = m.derive_components(info, None, None, None, None, None)
        assert "per_score" not in r
        assert "pbr_score" not in r
        assert "beta_inverse" not in r
        assert "div_payout" not in r
        assert r["peg_score"] == 1.5

    def test_zero_denominator_missing_safe(self):
        m = _load_script()
        bs = _Stmt({"Stockholders Equity": [100.0], "Total Assets": [0.0]})
        fin = _Stmt({"EBIT": [50.0], "Interest Expense": [0.0]})
        r = m.derive_components({}, bs, fin, None, None, None)
        assert "equity_ratio" not in r          # at[0]==0 → 不在
        assert "interest_cover" not in r        # abs(inte[0])==0 → 不在

    def test_div_year_sums_pure(self):
        m = _load_script()
        ds = m._div_year_sums(_Div([(2020, 1.0), (2020, 2.0), (2021, 3.0)]))
        assert ds == {2020: 3.0, 2021: 3.0}
        assert m._div_year_sums(None) == {}

    def test_fetch_delegates_to_derive(self):
        # fetch_raw_per_ticker は derive_components へ委譲する（static）
        src = _script_source()
        assert "derive_components(" in src
        assert "import yfinance as yf" in src  # 遅延 import は fetch 内のみ
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if (isinstance(node, ast.FunctionDef)
                    and node.name == "fetch_raw_per_ticker"):
                calls = {
                    s.func.id for s in ast.walk(node)
                    if isinstance(s, ast.Call)
                    and isinstance(s.func, ast.Name)
                }
                assert "derive_components" in calls
