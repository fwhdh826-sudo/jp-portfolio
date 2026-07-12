"""
test_update_phase8_skeleton.py — C: data/update_phase8.py skeleton 検証

data/update_phase8.py の run_phase8() を tmp_path output_dir で駆動し、
input_orchestrator → orchestrate_phase8_public_data 接続が 4 JSON を
生成すること、_meta.source に hybrid provenance が載ること、
public/data/phase8 が作られないこと等を検証する。

テスト配置の理由:
  run_phase8 は input_orchestrator + orchestrate_phase8_public_data を
  横断し FrontierStrategy Phase 8 経由で scipy/SLSQP が test path に入る
  cross-domain integration（test_phase8_pipeline_e2e.py と同系統）。
  backend/tests/test_integration/ に置く。

本 C では script を本番実行しない（main() / __main__ を呼ばない）。
tmp_path output_dir で run_phase8 を直接駆動するのみ。public/data/phase8
は完全無変更。実 HTTP / API / LLM 接続なし。
"""
from __future__ import annotations

import ast
import importlib.util
import json
import os
from datetime import datetime
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCRIPT_PATH = _REPO_ROOT / "data" / "update_phase8.py"
_RETURNS_JSON = _REPO_ROOT / "public" / "data" / "returns.json"
_SCORES_CONTRACT = (
    _REPO_ROOT / "public" / "data" / "contracts" / "v13.3" / "scoring"
    / "stock_scores_6axis.json"
)
_PUBLIC_PHASE8_DIR = _REPO_ROOT / "public" / "data" / "phase8"

_EXPECTED_FILES = {
    "frontier_index.json",
    "strategy_aggregate.json",
    "opportunity_loss.json",
    "future_branching.json",
}

# caller 供給 timestamp は run ごとに変わると payload が非決定的になる
# （strategy_aggregate.payload.timestamp）。テストは固定 tz-aware ISO8601 を
# 使い決定論化する（tz-aware ISO8601 検証は本値で成立）。
_FIXED_TS = "2026-05-19T00:00:00+09:00"


def _load_script():
    spec = importlib.util.spec_from_file_location(
        "update_phase8_under_test", _SCRIPT_PATH
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _script_source() -> str:
    with open(_SCRIPT_PATH, encoding="utf-8") as fh:
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


def _run(tmp_path):
    m = _load_script()
    rd = m.read_returns_doc(_RETURNS_JSON)
    sc = m.build_scores_from_contract(_SCORES_CONTRACT)
    uni = m.derive_universe(rd)
    ts = _FIXED_TS
    out = m.run_phase8(
        returns_doc=rd,
        scores=sc,
        universe=uni,
        output_dir=str(tmp_path),
        generated_at=ts,
        source=m.SOURCE_PROVENANCE,
        strategy_aggregate_timestamp=ts,
        regime="uncertain",
    )
    return m, out


# ── TestScriptStructure（AST、静的）──────────────────────────────────────────

class TestScriptStructure:
    def _tree(self) -> ast.AST:
        return ast.parse(_script_source())

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

    def test_no_live_http_imports(self):
        tops = self._imported_top()
        for forbidden in ("yfinance", "requests", "urllib", "http",
                          "httpx", "aiohttp", "socket"):
            assert forbidden not in tops, f"live-HTTP import {forbidden!r}"

    def test_imports_subset_allowed(self):
        allowed = {
            "__future__", "json", "math", "sys", "datetime", "pathlib",
            "typing", "backend",
        }
        assert self._imported_top() <= allowed

    def test_imports_input_orchestrator_and_orchestrate(self):
        src = _script_source()
        assert "phase8_input_orchestrator import" in src
        assert "phase8_compute_orchestrator import" in src

    def test_callables_present(self):
        m = _load_script()
        for name in ("read_returns_doc", "build_scores_from_contract",
                     "build_scores_from_scoring_or_contract",
                     "derive_source_provenance",
                     "derive_universe", "run_phase8", "main", "now_iso_tz"):
            assert callable(getattr(m, name))
        # migration constant
        assert hasattr(m, "SCORES_PUBLIC_PATH")
        assert str(m.SCORES_PUBLIC_PATH).replace(chr(92), "/").endswith(
            "public/data/scoring/stock_scores_6axis.json"
        )

    def test_source_provenance_hybrid_markers(self):
        m = _load_script()
        s = m.SOURCE_PROVENANCE
        assert "phase8_hybrid" in s
        assert "returns=yfinance-real" in s
        assert "scores=sample_contract" in s
        assert "missing-safe-default" in s

    def test_main_guard_present(self):
        assert 'if __name__ == "__main__":' in _script_source()

    def test_default_output_dir_is_public_phase8(self):
        m = _load_script()
        assert str(m.DEFAULT_OUTPUT_DIR).replace(os.sep, "/").endswith(
            "public/data/phase8"
        )

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


# ── TestRunPhase8TmpPath ─────────────────────────────────────────────────────

class TestRunPhase8TmpPath:
    def test_returns_doc_loaded(self):
        m = _load_script()
        rd = m.read_returns_doc(_RETURNS_JSON)
        assert isinstance(rd, dict)
        assert isinstance(rd.get("returns"), dict)
        assert len(rd["returns"]) >= 1

    def test_four_json_generated(self, tmp_path):
        _m, _out = _run(tmp_path)
        produced = {p.name for p in tmp_path.iterdir()}
        assert produced == _EXPECTED_FILES

    def test_written_kinds(self, tmp_path):
        _m, out = _run(tmp_path)
        assert set(out["written"].keys()) == {
            "frontier_index", "strategy_aggregate",
            "opportunity_loss", "future_branching",
        }

    def test_each_doc_has_meta_payload(self, tmp_path):
        _run(tmp_path)
        for f in _EXPECTED_FILES:
            doc = json.loads((tmp_path / f).read_text())
            assert set(doc.keys()) == {"_meta", "payload"}

    def test_meta_source_hybrid_provenance(self, tmp_path):
        _run(tmp_path)
        for f in _EXPECTED_FILES:
            doc = json.loads((tmp_path / f).read_text())
            assert "phase8_hybrid" in doc["_meta"]["source"]
            assert "scores=sample_contract" in doc["_meta"]["source"]

    def test_meta_not_for_trading_true(self, tmp_path):
        _run(tmp_path)
        for f in _EXPECTED_FILES:
            doc = json.loads((tmp_path / f).read_text())
            assert doc["_meta"]["not_for_trading"] is True

    def test_meta_kind_is_output_type(self, tmp_path):
        _run(tmp_path)
        for kind in ("frontier_index", "strategy_aggregate",
                     "opportunity_loss", "future_branching"):
            doc = json.loads((tmp_path / f"{kind}.json").read_text())
            assert doc["_meta"]["kind"] == kind

    def test_meta_version(self, tmp_path):
        _run(tmp_path)
        for f in _EXPECTED_FILES:
            doc = json.loads((tmp_path / f).read_text())
            assert doc["_meta"]["version"] == "v13.3"

    def test_generated_at_timezone_aware_iso8601(self, tmp_path):
        _run(tmp_path)
        for f in _EXPECTED_FILES:
            doc = json.loads((tmp_path / f).read_text())
            ga = doc["_meta"]["generated_at"]
            parsed = datetime.fromisoformat(ga)
            assert parsed.tzinfo is not None, f"{f}: {ga} not tz-aware"

    def test_each_doc_json_serializable(self, tmp_path):
        _run(tmp_path)
        for f in _EXPECTED_FILES:
            doc = json.loads((tmp_path / f).read_text())
            assert json.loads(json.dumps(doc)) == doc

    def test_payload_present(self, tmp_path):
        _run(tmp_path)
        for f in _EXPECTED_FILES:
            doc = json.loads((tmp_path / f).read_text())
            assert isinstance(doc["payload"], dict)

    def test_return_diagnostics_observation_prefixed(self, tmp_path):
        _m, out = _run(tmp_path)
        for d in out["diagnostics"]:
            assert isinstance(d, str) and d.startswith("observation: ")
        for d in out["resolver_diagnostics"]:
            assert isinstance(d, str) and d.startswith("observation: ")

    def test_deterministic(self, tmp_path):
        a = tmp_path / "a"
        b = tmp_path / "b"
        a.mkdir()
        b.mkdir()
        _run(a)
        _run(b)
        for f in _EXPECTED_FILES:
            assert json.loads((a / f).read_text())["payload"] == \
                json.loads((b / f).read_text())["payload"]


# ── TestPublicDataUntouched ──────────────────────────────────────────────────

class TestPublicDataUntouched:
    """
    A-Sub2-C で public/data/phase8 4 JSON が本番 fixture 化された後の契約
    （R-Phase8 reconciliation, 2026-05-24）。

    旧契約「output JSON が public/data/phase8 に存在しないこと」は
    A-Sub2-C 以降陳腐化したため廃止。新契約は「test 自身が committed
    public/data/phase8 fixture を変更しないこと」を bytes 等値で検出する。
    """

    def _snapshot_phase8_dir(self) -> dict:
        """public/data/phase8 配下の現存ファイル bytes を辞書化."""
        snap: dict = {}
        if _PUBLIC_PHASE8_DIR.exists():
            for p in sorted(_PUBLIC_PHASE8_DIR.iterdir()):
                if p.is_file():
                    snap[p.name] = p.read_bytes()
        return snap

    def test_committed_public_data_phase8_outputs_unmodified_by_test(
        self, tmp_path
    ):
        """test 実行が public/data/phase8 を bytes 単位で変更しない."""
        before = self._snapshot_phase8_dir()
        # A-Sub2-C 以降は 4 JSON が committed fixture として存在
        for f in (
            "frontier_index.json",
            "strategy_aggregate.json",
            "opportunity_loss.json",
            "future_branching.json",
        ):
            assert f in before, (
                f"{f} expected to be present in public/data/phase8 "
                "(A-Sub2-C 以降の本番 fixture)"
            )

        # tmp_path に run_phase8 を駆動（public/data/phase8 に書かない）
        _run(tmp_path)

        after = self._snapshot_phase8_dir()
        assert set(before.keys()) == set(after.keys()), (
            "public/data/phase8 のファイル構成が test 実行で変化した "
            "(read-only fixture 契約違反)"
        )
        for name, before_bytes in before.items():
            assert after[name] == before_bytes, (
                f"public/data/phase8/{name} の bytes が test で変更された "
                "(read-only fixture 契約違反)"
            )

    def test_public_data_phase8_readme_still_present(self):
        """README.md が namespace に残存している（4 JSON 本番化済でも維持）."""
        assert (_PUBLIC_PHASE8_DIR / "README.md").exists(), (
            "public/data/phase8/README.md must be present"
        )

    def test_only_tmp_path_written(self, tmp_path):
        _m, out = _run(tmp_path)
        for path_str in out["written"].values():
            assert str(tmp_path) in path_str
            assert "public/data" not in path_str

    def test_returns_json_unchanged_readonly(self):
        # read_returns_doc は読むだけ（書かない）。サイズ不変を確認
        m = _load_script()
        before = _RETURNS_JSON.stat().st_size
        m.read_returns_doc(_RETURNS_JSON)
        assert _RETURNS_JSON.stat().st_size == before

    def test_run_creates_no_repo_public_data(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        work = tmp_path / "out"
        work.mkdir()
        _load_script().run_phase8(
            returns_doc=_load_script().read_returns_doc(_RETURNS_JSON),
            scores={},
            universe=(),
            output_dir=str(work),
            generated_at=_FIXED_TS,
            source="phase8_hybrid: test",
            strategy_aggregate_timestamp=_FIXED_TS,
            regime="uncertain",
        )
        # cwd(tmp) に public/ を作らない
        assert not (tmp_path / "public").exists()


# ── TestHelpers ──────────────────────────────────────────────────────────────

class TestHelpers:
    def test_read_returns_doc_missing_returns_empty(self):
        m = _load_script()
        assert m.read_returns_doc(_REPO_ROOT / "nonexistent_xyz.json") == {}

    def test_build_scores_missing_returns_empty(self):
        m = _load_script()
        assert m.build_scores_from_contract(
            _REPO_ROOT / "nonexistent_scores.json"
        ) == {}

    def test_build_scores_extracts_total_only(self):
        m = _load_script()
        sc = m.build_scores_from_contract(_SCORES_CONTRACT)
        assert isinstance(sc, dict)
        for _tk, axes in sc.items():
            assert isinstance(axes, dict)
            for _ax, body in axes.items():
                assert set(body.keys()) == {"total"}
                assert "rating" not in body
                assert isinstance(body["total"], float)

    def test_derive_universe_strips_dot_t(self):
        m = _load_script()
        uni = m.derive_universe(
            {"returns": {"6098.T": [0.1], "7011.T": [0.2]}}
        )
        assert set(uni) == {"6098", "7011"}

    def test_derive_universe_non_dict_safe(self):
        m = _load_script()
        assert m.derive_universe(None) == ()
        assert m.derive_universe({"returns": "x"}) == ()

    def test_now_iso_tz_is_tz_aware(self):
        m = _load_script()
        parsed = datetime.fromisoformat(m.now_iso_tz())
        assert parsed.tzinfo is not None

    def test_no_workflow_dispatch_or_gh_in_source(self):
        src = _script_source()
        assert "workflow_dispatch" not in src
        assert "gh run" not in src
        assert "gh workflow" not in src


# ── TestScoresMigration ──────────────────────────────────────────────────────
#
# update_phase8.py の scores INPUT 切替 migration の検証:
#   - public/data/scoring 優先 / contracts sample fallback
#   - source provenance dispatch (public_scoring / sample_contract / missing)
#   - 両 path の schema parity
# 既存 32 tests は不変。network 不要・tmp_path 専用・main 非呼出。

AXES_TUPLE = ("value", "safety", "shareholder_return", "quality", "growth",
              "momentum")


def _make_scores_doc(ticker_value_map: dict) -> dict:
    """合成 stock_scores_6axis envelope を構築（rating 等は含めない）。

    ticker_value_map: {ticker: total_base_value} → 各 axis の total を
    base_value からオフセットで生成（schema parity 検証用に決定論）。
    """
    rows = []
    for t, base in ticker_value_map.items():
        six = {a: {"total": float(base + i)}
               for i, a in enumerate(AXES_TUPLE)}
        rows.append({"ticker": t, "six_axis": six})
    return {
        "_meta": {"version": "v13.3", "kind": "stock_scores_6axis"},
        "stock_scores_6axis": rows,
    }


def _write_json(path, doc):
    import json as _json
    with open(path, "w", encoding="utf-8") as fh:
        _json.dump(doc, fh, ensure_ascii=False)


class TestScoresMigration:
    def test_priority_public_scoring_when_present(self, tmp_path):
        m = _load_script()
        scoring = tmp_path / "scoring.json"
        contract = tmp_path / "contract.json"
        _write_json(scoring, _make_scores_doc({"T001.T": 70.0}))
        _write_json(contract, _make_scores_doc({"T001.T": 30.0}))
        scores, label = m.build_scores_from_scoring_or_contract(
            scoring, contract
        )
        assert label == "public_scoring"
        # public 側 base=70.0 + axis offset i: value=70.0
        assert scores["T001.T"]["value"]["total"] == 70.0

    def test_fallback_to_contract_when_scoring_absent(self, tmp_path):
        m = _load_script()
        scoring = tmp_path / "absent_scoring.json"  # not created
        contract = tmp_path / "contract.json"
        _write_json(contract, _make_scores_doc({"T001.T": 30.0}))
        scores, label = m.build_scores_from_scoring_or_contract(
            scoring, contract
        )
        assert label == "sample_contract"
        assert scores["T001.T"]["value"]["total"] == 30.0

    def test_fallback_to_contract_when_scoring_empty_or_invalid(
        self, tmp_path
    ):
        m = _load_script()
        contract = tmp_path / "contract.json"
        _write_json(contract, _make_scores_doc({"T001.T": 30.0}))

        # case A: scoring 存在だが stock_scores_6axis が空 list
        scoring_empty = tmp_path / "scoring_empty.json"
        _write_json(scoring_empty, {
            "_meta": {"version": "v13.3", "kind": "stock_scores_6axis"},
            "stock_scores_6axis": [],
        })
        scores, label = m.build_scores_from_scoring_or_contract(
            scoring_empty, contract
        )
        assert label == "sample_contract"
        assert scores["T001.T"]["value"]["total"] == 30.0

        # case B: scoring 存在だが JSON 不正
        scoring_invalid = tmp_path / "scoring_invalid.json"
        scoring_invalid.write_text("not a json {", encoding="utf-8")
        scores, label = m.build_scores_from_scoring_or_contract(
            scoring_invalid, contract
        )
        assert label == "sample_contract"
        assert scores["T001.T"]["value"]["total"] == 30.0

    def test_missing_when_both_absent(self, tmp_path):
        m = _load_script()
        scoring = tmp_path / "absent_scoring.json"
        contract = tmp_path / "absent_contract.json"
        scores, label = m.build_scores_from_scoring_or_contract(
            scoring, contract
        )
        assert scores == {}
        assert label == "missing"

    def test_derive_source_provenance_dispatches_per_label(self):
        m = _load_script()

        public_s = m.derive_source_provenance("public_scoring")
        assert "scores=public_scoring" in public_s
        assert "phase8_hybrid" in public_s

        sample_s = m.derive_source_provenance("sample_contract")
        assert "scores=sample_contract" in sample_s
        assert "phase8_hybrid" in sample_s
        # legacy SOURCE_PROVENANCE 文字列との同一性
        assert sample_s == m.SOURCE_PROVENANCE

        missing_s = m.derive_source_provenance("missing")
        assert "scores=missing" in missing_s
        assert "phase8_hybrid" in missing_s

        # unknown label → missing と同等の fallback
        unknown_s = m.derive_source_provenance("xxx_unknown")
        assert "scores=missing" in unknown_s
        assert "phase8_hybrid" in unknown_s

    def test_scores_schema_parity_public_vs_contract(self, tmp_path):
        """同一合成 data を scoring path / contract path の両方から
        読み込み、build_scores_from_contract が同形を返す。
        {ticker: {axis: {"total": float}}} 構造で rating 非伝播。"""
        m = _load_script()
        # 同一 envelope を両 path に置く（ただし rating field を一方に
        # 付加し、build_scores_from_contract が rating を伝播しない
        # ことも併せて確認）
        doc = _make_scores_doc({"T001.T": 50.0})
        for row in doc["stock_scores_6axis"]:
            for axis in row["six_axis"]:
                row["six_axis"][axis]["rating"] = "A"  # 非伝播確認用
        path_a = tmp_path / "as_scoring.json"
        path_b = tmp_path / "as_contract.json"
        _write_json(path_a, doc)
        _write_json(path_b, doc)

        scores_a = m.build_scores_from_contract(path_a)
        scores_b = m.build_scores_from_contract(path_b)
        assert scores_a == scores_b
        # {ticker: {axis: {"total": float}}} 構造
        for ticker, axes in scores_a.items():
            assert isinstance(axes, dict)
            for axis, body in axes.items():
                assert set(body.keys()) == {"total"}
                assert isinstance(body["total"], float)
                # rating 非伝播
                assert "rating" not in body

        # 経由関数（priority dispatcher）でも同形
        scores_pri, label = m.build_scores_from_scoring_or_contract(
            path_a, path_b
        )
        assert label == "public_scoring"
        assert scores_pri == scores_a


# ── TestConcentratedRegimeProbabilities（D2c1 純関数）────────────────────────

class TestConcentratedRegimeProbabilities:
    """D2c1: build_concentrated_regime_probabilities 純関数テスト。

    main() 未接続・public/data/phase8 不変のまま concentration 関数を検証。
    """

    _VALID_REGIMES = ("bull_calm", "bull_volatile", "bear", "crisis", "uncertain")

    def test_bull_calm_concentration(self):
        m = _load_script()
        probs = m.build_concentrated_regime_probabilities("bull_calm")
        assert probs["bull_calm"] == pytest.approx(0.60)
        for r in ("bull_volatile", "bear", "crisis", "uncertain"):
            assert probs[r] == pytest.approx(0.10)
        assert sum(probs.values()) == pytest.approx(1.0)

    def test_crisis_concentration(self):
        m = _load_script()
        probs = m.build_concentrated_regime_probabilities("crisis")
        assert probs["crisis"] == pytest.approx(0.60)
        for r in ("bull_calm", "bull_volatile", "bear", "uncertain"):
            assert probs[r] == pytest.approx(0.10)
        assert sum(probs.values()) == pytest.approx(1.0)

    def test_unknown_detected_returns_uniform(self):
        m = _load_script()
        probs = m.build_concentrated_regime_probabilities("totally_unknown")
        for v in probs.values():
            assert v == pytest.approx(0.20)
        assert sum(probs.values()) == pytest.approx(1.0)

    def test_empty_string_returns_uniform(self):
        m = _load_script()
        probs = m.build_concentrated_regime_probabilities("")
        for v in probs.values():
            assert v == pytest.approx(0.20)

    def test_none_returns_uniform(self):
        m = _load_script()
        probs = m.build_concentrated_regime_probabilities(None)
        for v in probs.values():
            assert v == pytest.approx(0.20)

    def test_returns_new_dict_does_not_mutate_uniform_constant(self):
        """戻り値を変更しても REGIME_PROBABILITIES_UNIFORM が汚染されない。"""
        m = _load_script()
        original = dict(m.REGIME_PROBABILITIES_UNIFORM)
        # concentrated パス
        probs_c = m.build_concentrated_regime_probabilities("bull_calm")
        probs_c["bull_calm"] = 999.0
        assert m.REGIME_PROBABILITIES_UNIFORM == original
        # uniform fallback パス
        probs_u = m.build_concentrated_regime_probabilities("unknown")
        probs_u["bull_calm"] = 999.0
        assert m.REGIME_PROBABILITIES_UNIFORM == original

    def test_key_set_matches_uniform_keys(self):
        """probability key set が REGIME_PROBABILITIES_UNIFORM と一致すること。"""
        m = _load_script()
        expected_keys = set(m.REGIME_PROBABILITIES_UNIFORM.keys())
        for regime in self._VALID_REGIMES:
            probs = m.build_concentrated_regime_probabilities(regime)
            assert set(probs.keys()) == expected_keys

    def test_sum_is_one_for_all_valid_regimes(self):
        m = _load_script()
        for regime in self._VALID_REGIMES:
            probs = m.build_concentrated_regime_probabilities(regime)
            assert sum(probs.values()) == pytest.approx(1.0), regime

    def test_concentration_constant_is_0_60(self):
        m = _load_script()
        assert m.DETECTED_REGIME_CONCENTRATION == pytest.approx(0.60)


# ── TestRuleBasedRegimeProbabilityDI（D2c2: probability DI wiring）────────────

class TestRuleBasedRegimeProbabilityDI:
    """D2c2: market_intel fresh / warn 時のみ rule_based 単層判定で
    detected_regime に 0.60 集中する probability DI を main() 経由で検証する。

    base_regime は D2c2 範囲外（"uncertain" 固定）。regime cascade は別 Card。
    """

    _FIVE_FIELDS = {
        "vix": 16.89,
        "nikkei_5d_return": 0.0714,
        "nikkei_60ma": 57297.4,
        "nikkei_200ma": 51188.6,
        "sp500_dd_30d": 0.0,
    }

    def _write_market_intel(self, path, *, fetched_at: str | None, extra: dict | None = None):
        doc: dict = {}
        if fetched_at is not None:
            doc["fetched_at"] = fetched_at
        doc.update(dict(self._FIVE_FIELDS))
        if extra is not None:
            doc.update(extra)
        path.write_text(json.dumps(doc), encoding="utf-8")

    def _fresh_fetched_at(self) -> str:
        from datetime import datetime as _dt, timezone as _tz
        return _dt.now(_tz.utc).isoformat().replace("+00:00", "Z")

    def _stale_fetched_at(self) -> str:
        from datetime import datetime as _dt, timezone as _tz, timedelta
        return (_dt.now(_tz.utc) - timedelta(days=100)).isoformat()

    def _run_main_with_market_intel(
        self, m, tmp_path, monkeypatch, *, market_intel_path
    ):
        monkeypatch.setattr(m, "MARKET_INTEL_JSON_PATH", market_intel_path)
        out_dir = tmp_path / "out"
        out_dir.mkdir()
        m.main(output_dir=str(out_dir))
        return out_dir

    # ── read_market_intel_for_regime helper ─────────────────────────────

    def test_read_market_intel_for_regime_returns_5_fields_as_float(self, tmp_path):
        m = _load_script()
        mi_path = tmp_path / "mi.json"
        self._write_market_intel(mi_path, fetched_at=None)
        result = m.read_market_intel_for_regime(mi_path)
        assert result is not None
        assert set(result.keys()) == set(self._FIVE_FIELDS.keys())
        for v in result.values():
            assert isinstance(v, float)
        assert result["vix"] == pytest.approx(16.89)

    def test_read_market_intel_for_regime_missing_file_returns_none(self, tmp_path):
        m = _load_script()
        assert m.read_market_intel_for_regime(tmp_path / "absent.json") is None

    def test_read_market_intel_for_regime_missing_field_returns_none(self, tmp_path):
        m = _load_script()
        mi_path = tmp_path / "mi.json"
        partial = dict(self._FIVE_FIELDS)
        partial.pop("nikkei_60ma")
        mi_path.write_text(json.dumps(partial), encoding="utf-8")
        assert m.read_market_intel_for_regime(mi_path) is None

    def test_read_market_intel_for_regime_non_finite_returns_none(self, tmp_path):
        m = _load_script()
        mi_path = tmp_path / "mi.json"
        bad = dict(self._FIVE_FIELDS)
        # JSON cannot encode inf directly; use json string with NaN literal
        mi_path.write_text(
            '{"vix": NaN, "nikkei_5d_return": 0.0714, "nikkei_60ma": 57297.4,'
            ' "nikkei_200ma": 51188.6, "sp500_dd_30d": 0.0}',
            encoding="utf-8",
        )
        assert m.read_market_intel_for_regime(mi_path) is None

    def test_read_market_intel_for_regime_parse_error_returns_none(self, tmp_path):
        m = _load_script()
        bad_path = tmp_path / "broken.json"
        bad_path.write_text("not a json {", encoding="utf-8")
        assert m.read_market_intel_for_regime(bad_path) is None

    # ── fresh market_intel → concentrated probability ──────────────────

    def test_fresh_market_intel_yields_concentrated_probability(
        self, tmp_path, monkeypatch
    ):
        m = _load_script()
        mi_path = tmp_path / "market_intel.json"
        self._write_market_intel(mi_path, fetched_at=self._fresh_fetched_at())
        out_dir = self._run_main_with_market_intel(
            m, tmp_path, monkeypatch, market_intel_path=mi_path
        )
        fb = json.loads((out_dir / "future_branching.json").read_text())
        branches = {b["regime"]: b for b in fb["payload"]["branches"]}
        assert branches["bull_calm"]["probability"] == pytest.approx(0.60)
        for r in ("bull_volatile", "bear", "crisis", "uncertain"):
            assert branches[r]["probability"] == pytest.approx(0.10)

    def test_stale_market_intel_keeps_uniform(self, tmp_path, monkeypatch):
        m = _load_script()
        mi_path = tmp_path / "market_intel.json"
        self._write_market_intel(mi_path, fetched_at=self._stale_fetched_at())
        out_dir = self._run_main_with_market_intel(
            m, tmp_path, monkeypatch, market_intel_path=mi_path
        )
        fb = json.loads((out_dir / "future_branching.json").read_text())
        branches = {b["regime"]: b for b in fb["payload"]["branches"]}
        for r in branches:
            assert branches[r]["probability"] == pytest.approx(0.20)

    def test_probability_sum_is_one_under_fresh(self, tmp_path, monkeypatch):
        m = _load_script()
        mi_path = tmp_path / "market_intel.json"
        self._write_market_intel(mi_path, fetched_at=self._fresh_fetched_at())
        out_dir = self._run_main_with_market_intel(
            m, tmp_path, monkeypatch, market_intel_path=mi_path
        )
        fb = json.loads((out_dir / "future_branching.json").read_text())
        total = sum(b["probability"] for b in fb["payload"]["branches"])
        assert total == pytest.approx(1.0)

    # ── base_regime invariant under D2c2 ─────────────────────────────

    def test_base_regime_stays_uncertain_in_d2c2(self, tmp_path, monkeypatch):
        """D2c2 では base_regime は "uncertain" のまま (regime cascade は別 Card)。"""
        m = _load_script()
        mi_path = tmp_path / "market_intel.json"
        self._write_market_intel(mi_path, fetched_at=self._fresh_fetched_at())
        out_dir = self._run_main_with_market_intel(
            m, tmp_path, monkeypatch, market_intel_path=mi_path
        )
        fb = json.loads((out_dir / "future_branching.json").read_text())
        assert fb["payload"]["base_regime"] == "uncertain"
        base_branches = [
            b for b in fb["payload"]["branches"] if b.get("is_base_regime")
        ]
        assert len(base_branches) == 1
        assert base_branches[0]["regime"] == "uncertain"

    # ── source provenance v7 ─────────────────────────────────────────

    def test_v7_includes_regime_probabilities_label(self):
        m = _load_script()
        s = m.derive_source_provenance_v7(
            "public_scoring",
            asset_meta_present=True,
            holdings_snapshot_label="public_holdings_snapshot_2026-04-06",
            mean_return_label="returns_yfinance_52w_annualized",
            regime_table_label="manual_regime_constitution_v13_3",
            lock_calc_label="purchase_date_days_since_purchase_utc",
            market_intel_label="fresh",
            regime_probabilities_label="rule_based_concentrated_0_60_bull_calm",
        )
        assert "phase8_hybrid" in s
        assert "market_intel=fresh" in s
        assert "regime_probabilities=rule_based_concentrated_0_60_bull_calm" in s

    def test_v7_uniform_default_when_label_none(self):
        m = _load_script()
        s = m.derive_source_provenance_v7(
            "public_scoring",
            asset_meta_present=True,
            regime_probabilities_label=None,
        )
        assert "regime_probabilities=uniform_1_5" in s

    def test_v7_uniform_explicit(self):
        m = _load_script()
        s = m.derive_source_provenance_v7(
            "public_scoring",
            asset_meta_present=True,
            market_intel_label="stale_not_used",
            regime_probabilities_label="uniform_1_5",
        )
        assert "regime_probabilities=uniform_1_5" in s
        assert "market_intel=stale_not_used" in s

    def test_v6_preserved_no_regime_probabilities_field(self):
        """v6 は regime_probabilities フィールドを含まない（v6→v7 後方互換）。"""
        m = _load_script()
        s = m.derive_source_provenance_v6(
            "public_scoring",
            asset_meta_present=True,
            holdings_snapshot_label="public_holdings_snapshot_2026-04-06",
            mean_return_label="returns_yfinance_52w_annualized",
            regime_table_label="manual_regime_constitution_v13_3",
            lock_calc_label="purchase_date_days_since_purchase_utc",
            market_intel_label="fresh",
        )
        assert "phase8_hybrid" in s
        assert "market_intel=fresh" in s
        assert "regime_probabilities" not in s

    # ── _meta.source contains expected D2c2 labels under fresh ──────────

    def test_fresh_meta_source_contains_d2c2_labels(self, tmp_path, monkeypatch):
        m = _load_script()
        mi_path = tmp_path / "market_intel.json"
        self._write_market_intel(mi_path, fetched_at=self._fresh_fetched_at())
        out_dir = self._run_main_with_market_intel(
            m, tmp_path, monkeypatch, market_intel_path=mi_path
        )
        fb = json.loads((out_dir / "future_branching.json").read_text())
        src = fb["_meta"]["source"]
        assert "market_intel=fresh" in src
        assert "regime_probabilities=rule_based_concentrated_0_60_bull_calm" in src

    # ── future_branching diagnostics prepend ────────────────────────

    def test_fresh_diagnostics_prepend_rule_based_observation(
        self, tmp_path, monkeypatch
    ):
        m = _load_script()
        mi_path = tmp_path / "market_intel.json"
        self._write_market_intel(mi_path, fetched_at=self._fresh_fetched_at())
        out_dir = self._run_main_with_market_intel(
            m, tmp_path, monkeypatch, market_intel_path=mi_path
        )
        fb = json.loads((out_dir / "future_branching.json").read_text())
        diags = fb["payload"]["diagnostics"]
        assert isinstance(diags, list) and len(diags) > 0
        assert diags[0].startswith("observation: rule_based regime detected ")
        assert "bull_calm" in diags[0]
        assert "primary_rule=low_vol_uptrend" in diags[0]

    def test_weighted_expected_return_under_fresh_bull_calm(
        self, tmp_path, monkeypatch
    ):
        """fresh + bull_calm 集中時 weighted_expected_return ≈ 0.0710"""
        m = _load_script()
        mi_path = tmp_path / "market_intel.json"
        self._write_market_intel(mi_path, fetched_at=self._fresh_fetched_at())
        out_dir = self._run_main_with_market_intel(
            m, tmp_path, monkeypatch, market_intel_path=mi_path
        )
        fb = json.loads((out_dir / "future_branching.json").read_text())
        # 0.60 * 0.090 + 0.10 * (0.070 + 0.030 + 0.010 + 0.060) = 0.071
        assert fb["payload"]["weighted_expected_return"] == pytest.approx(0.071)
        # 0.60 * 0.120 + 0.10 * (0.180 + 0.200 + 0.300 + 0.150) = 0.155
        assert fb["payload"]["weighted_expected_vol"] == pytest.approx(0.155)
        # crisis max_dd = -0.35 across all 5 branches
        assert fb["payload"]["worst_case_dd"] == pytest.approx(-0.35)
