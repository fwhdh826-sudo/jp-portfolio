"""
test_phase8_json_writer.py — Card D（Scope B）
phase8_json_writer のユニットテスト。

テスト方針:
  - stdlib-only（ast / json / inspect / os / pathlib / re / dataclasses）+ pytest
  - import numpy / scipy / pandas 禁止
  - **tmp_path のみ使用。public/ 配下に一切書かない**（静的検証含む）
  - 禁止フィールド / 禁止語 absence assertion
  - dataclass なし（writer は関数のみ）

Scope B 検証:
  - writer 基盤が public/data に書かないことを静的に保証
  - atomic write が tmp_path で round-trip すること
  - _meta envelope 仕様
"""
from __future__ import annotations

import ast
import inspect
import json
import os
import re
from pathlib import Path

import pytest

from engine.frontier.phase8_json_writer import (
    ALLOWED_KINDS,
    _META_NOT_FOR_TRADING,
    _META_VERSION,
    assert_json_serializable,
    build_phase8_document,
    write_json_atomic,
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


def _sample_payload() -> dict:
    return {
        "tickers": ["7011", "6758", "9984"],
        "weights": [0.5, 0.3, 0.2],
        "expected_return": 0.092,
        "expected_vol": 0.188,
        "sharpe_ratio": 0.489,
        "regime_used": "bull_volatile",
        "diagnostics": [
            "observation: Phase 8 SLSQP optimization used (returns_data provided)",
            "observation: calculation-only, not a recommendation",
        ],
    }


def _module_path() -> Path:
    return (
        Path(__file__).parent.parent.parent
        / "engine" / "frontier" / "phase8_json_writer.py"
    )


def _string_constants_excluding_docstring(path: Path) -> list:
    """
    モジュール/テストのコード文字列定数を docstring を除いて列挙する。

    docstring は AST ノード identity（id()）で厳密に除外する。
    ast.get_docstring() は cleandoc 済みで raw Constant.value と一致しないため
    value 比較ではなく node identity で判定する。
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    docstring_node_ids: set = set()

    def _record(body) -> None:
        if (
            body
            and isinstance(body[0], ast.Expr)
            and isinstance(body[0].value, ast.Constant)
            and isinstance(body[0].value.value, str)
        ):
            docstring_node_ids.add(id(body[0].value))

    _record(tree.body)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            _record(node.body)

    consts: list = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if id(node) in docstring_node_ids:
                continue
            consts.append(node.value)
    return consts


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


# ── CLASS 1: TestModuleConstants ─────────────────────────────────────────────


class TestModuleConstants:
    def test_meta_version_value(self):
        assert _META_VERSION == "v13.3"

    def test_meta_not_for_trading_is_true(self):
        assert _META_NOT_FOR_TRADING is True

    def test_allowed_kinds_is_frozenset(self):
        assert isinstance(ALLOWED_KINDS, frozenset)

    def test_allowed_kinds_exact_content(self):
        assert ALLOWED_KINDS == frozenset({
            "frontier_index",
            "strategy_aggregate",
            "opportunity_loss",
            "future_branching",
        })

    def test_allowed_kinds_length_4(self):
        assert len(ALLOWED_KINDS) == 4


# ── CLASS 2: TestBuildPhase8Document ─────────────────────────────────────────


class TestBuildPhase8Document:
    def test_returns_dict(self):
        doc = build_phase8_document(
            _sample_payload(), "frontier_index", "src", "2026-05-16T00:00:00Z", "frontier_index"
        )
        assert isinstance(doc, dict)

    def test_meta_has_exactly_five_keys(self):
        doc = build_phase8_document(
            _sample_payload(), "frontier_index", "src", "2026-05-16T00:00:00Z", "frontier_index"
        )
        assert set(doc["_meta"].keys()) == {
            "version", "kind", "source", "generated_at", "not_for_trading"
        }

    def test_meta_version_is_v13_3(self):
        doc = build_phase8_document(
            _sample_payload(), "frontier_index", "src", "2026-05-16T00:00:00Z", "frontier_index"
        )
        assert doc["_meta"]["version"] == "v13.3"

    def test_meta_not_for_trading_is_true(self):
        doc = build_phase8_document(
            _sample_payload(), "frontier_index", "src", "2026-05-16T00:00:00Z", "frontier_index"
        )
        assert doc["_meta"]["not_for_trading"] is True

    def test_meta_kind_reflected(self):
        doc = build_phase8_document(
            _sample_payload(), "strategy_aggregate", "src", "g", "k"
        )
        assert doc["_meta"]["kind"] == "strategy_aggregate"

    def test_meta_source_reflected(self):
        doc = build_phase8_document(
            _sample_payload(), "frontier_index", "phase8.frontier.index_builder", "g", "k"
        )
        assert doc["_meta"]["source"] == "phase8.frontier.index_builder"

    def test_meta_generated_at_reflected(self):
        doc = build_phase8_document(
            _sample_payload(), "frontier_index", "src", "2026-05-16T09:30:00+09:00", "k"
        )
        assert doc["_meta"]["generated_at"] == "2026-05-16T09:30:00+09:00"

    def test_payload_key_placement(self):
        doc = build_phase8_document(
            _sample_payload(), "frontier_index", "src", "g", "frontier_index"
        )
        assert "frontier_index" in doc
        assert doc["frontier_index"]["expected_return"] == 0.092

    def test_payload_not_mutated(self):
        payload = _sample_payload()
        snapshot = json.loads(json.dumps(payload))
        build_phase8_document(payload, "frontier_index", "src", "g", "k")
        assert payload == snapshot

    def test_returned_document_independent_of_payload(self):
        payload = _sample_payload()
        doc = build_phase8_document(payload, "frontier_index", "src", "g", "data")
        # 返り値の payload を mutation しても入力は不変（deepcopy snapshot）
        doc["data"]["expected_return"] = 999.0
        doc["data"]["tickers"].append("MUT")
        assert payload["expected_return"] == 0.092
        assert "MUT" not in payload["tickers"]

    def test_input_mutation_does_not_affect_returned_document(self):
        payload = _sample_payload()
        doc = build_phase8_document(payload, "frontier_index", "src", "g", "data")
        payload["expected_return"] = -1.0
        payload["tickers"].append("LATE")
        assert doc["data"]["expected_return"] == 0.092
        assert "LATE" not in doc["data"]["tickers"]

    @pytest.mark.parametrize("kind", sorted(ALLOWED_KINDS))
    def test_each_allowed_kind_accepted(self, kind):
        doc = build_phase8_document(_sample_payload(), kind, "src", "g", "k")
        assert doc["_meta"]["kind"] == kind

    def test_empty_payload_dict_allowed(self):
        doc = build_phase8_document({}, "frontier_index", "src", "g", "payload")
        assert doc["payload"] == {}

    def test_tuple_in_payload_preserved_in_document(self):
        payload = {"weights": (0.6, 0.4)}
        doc = build_phase8_document(payload, "frontier_index", "src", "g", "data")
        # deepcopy はtuple を保持（JSON 化は write 時に list 化）
        assert doc["data"]["weights"] == (0.6, 0.4)


# ── CLASS 3: TestBuildPhase8DocumentValidation ───────────────────────────────


class TestBuildPhase8DocumentValidation:
    def test_unknown_kind_raises_value_error(self):
        with pytest.raises(ValueError):
            build_phase8_document(_sample_payload(), "bogus_kind", "src", "g", "k")

    def test_non_dict_payload_raises_type_error(self):
        with pytest.raises(TypeError):
            build_phase8_document("not_a_dict", "frontier_index", "src", "g", "k")  # type: ignore

    def test_none_payload_raises_type_error(self):
        with pytest.raises(TypeError):
            build_phase8_document(None, "frontier_index", "src", "g", "k")  # type: ignore

    def test_list_payload_raises_type_error(self):
        with pytest.raises(TypeError):
            build_phase8_document([1, 2, 3], "frontier_index", "src", "g", "k")  # type: ignore

    def test_empty_payload_key_raises_value_error(self):
        with pytest.raises(ValueError):
            build_phase8_document(_sample_payload(), "frontier_index", "src", "g", "")

    def test_non_str_payload_key_raises_value_error(self):
        with pytest.raises(ValueError):
            build_phase8_document(_sample_payload(), "frontier_index", "src", "g", 123)  # type: ignore

    def test_empty_source_raises_value_error(self):
        with pytest.raises(ValueError):
            build_phase8_document(_sample_payload(), "frontier_index", "", "g", "k")

    def test_non_str_source_raises_value_error(self):
        with pytest.raises(ValueError):
            build_phase8_document(_sample_payload(), "frontier_index", None, "g", "k")  # type: ignore

    def test_empty_generated_at_raises_value_error(self):
        with pytest.raises(ValueError):
            build_phase8_document(_sample_payload(), "frontier_index", "src", "", "k")

    def test_non_str_generated_at_raises_value_error(self):
        with pytest.raises(ValueError):
            build_phase8_document(_sample_payload(), "frontier_index", "src", 12345, "k")  # type: ignore

    def test_none_kind_raises_value_error(self):
        with pytest.raises(ValueError):
            build_phase8_document(_sample_payload(), None, "src", "g", "k")  # type: ignore


# ── CLASS 4: TestAssertJsonSerializable ──────────────────────────────────────


class TestAssertJsonSerializable:
    def test_plain_dict_ok(self):
        assert assert_json_serializable({"a": 1, "b": "x"}) is None

    def test_nested_dict_list_ok(self):
        assert_json_serializable({"a": {"b": [1, 2, {"c": 3}]}})

    def test_str_float_bool_none_ok(self):
        assert_json_serializable({"s": "x", "f": 1.5, "b": True, "n": None})

    def test_tuple_is_ok(self):
        # tuple は JSON 上 list になるため例外なし
        assert_json_serializable({"weights": (0.6, 0.4)})

    def test_nested_tuple_ok(self):
        assert_json_serializable({"pairs": [("a", 1), ("b", 2)]})

    def test_set_raises_type_error(self):
        with pytest.raises(TypeError):
            assert_json_serializable({"bad": {1, 2, 3}})

    def test_nested_set_raises_type_error(self):
        with pytest.raises(TypeError):
            assert_json_serializable({"a": {"b": {1, 2}}})

    def test_arbitrary_object_raises_type_error(self):
        class _Obj:
            pass
        with pytest.raises(TypeError):
            assert_json_serializable({"o": _Obj()})

    def test_returns_none_on_success(self):
        result = assert_json_serializable({"ok": True})
        assert result is None

    def test_envelope_document_is_serializable(self):
        doc = build_phase8_document(_sample_payload(), "frontier_index", "src", "g", "k")
        assert_json_serializable(doc)


# ── CLASS 5: TestWriteJsonAtomic ─────────────────────────────────────────────


class TestWriteJsonAtomic:
    def test_round_trip(self, tmp_path):
        doc = build_phase8_document(_sample_payload(), "frontier_index", "src", "g", "frontier_index")
        out = tmp_path / "frontier_index.json"
        write_json_atomic(doc, out)
        loaded = json.loads(out.read_text(encoding="utf-8"))
        assert loaded["_meta"]["kind"] == "frontier_index"
        assert loaded["frontier_index"]["expected_return"] == 0.092

    def test_creates_nested_parent_dirs(self, tmp_path):
        doc = build_phase8_document(_sample_payload(), "frontier_index", "src", "g", "k")
        out = tmp_path / "a" / "b" / "c" / "frontier_index.json"
        write_json_atomic(doc, out)
        assert out.exists()

    def test_accepts_str_path(self, tmp_path):
        doc = build_phase8_document(_sample_payload(), "frontier_index", "src", "g", "k")
        out = str(tmp_path / "out.json")
        write_json_atomic(doc, out)
        assert Path(out).exists()

    def test_accepts_path_object(self, tmp_path):
        doc = build_phase8_document(_sample_payload(), "frontier_index", "src", "g", "k")
        out = tmp_path / "out.json"
        write_json_atomic(doc, out)
        assert out.exists()

    def test_ensure_ascii_false_preserves_japanese(self, tmp_path):
        payload = {"note": "観察値: これは推奨ではない"}
        doc = build_phase8_document(payload, "frontier_index", "src", "g", "data")
        out = tmp_path / "ja.json"
        write_json_atomic(doc, out)
        raw = out.read_text(encoding="utf-8")
        assert "観察値: これは推奨ではない" in raw

    def test_indent_two(self, tmp_path):
        doc = build_phase8_document({"a": 1}, "frontier_index", "src", "g", "data")
        out = tmp_path / "indent.json"
        write_json_atomic(doc, out)
        raw = out.read_text(encoding="utf-8")
        # indent=2 で "_meta" は 2 スペースインデント
        assert '\n  "_meta"' in raw

    def test_no_tmp_file_left_on_success(self, tmp_path):
        doc = build_phase8_document(_sample_payload(), "frontier_index", "src", "g", "k")
        out = tmp_path / "frontier_index.json"
        write_json_atomic(doc, out)
        leftovers = [p.name for p in tmp_path.iterdir() if p.name.startswith(".tmp_")]
        assert leftovers == []

    def test_non_serializable_raises_type_error(self, tmp_path):
        out = tmp_path / "bad.json"
        with pytest.raises(TypeError):
            write_json_atomic({"bad": {1, 2, 3}}, out)

    def test_non_serializable_leaves_no_output_file(self, tmp_path):
        out = tmp_path / "bad.json"
        with pytest.raises(TypeError):
            write_json_atomic({"bad": {1, 2, 3}}, out)
        assert not out.exists()

    def test_non_serializable_leaves_no_tmp_file(self, tmp_path):
        out = tmp_path / "bad.json"
        with pytest.raises(TypeError):
            write_json_atomic({"bad": {1, 2, 3}}, out)
        leftovers = [p.name for p in tmp_path.iterdir() if p.name.startswith(".tmp_")]
        assert leftovers == []

    def test_overwrites_existing_file_atomically(self, tmp_path):
        out = tmp_path / "x.json"
        out.write_text('{"old": true}', encoding="utf-8")
        doc = build_phase8_document({"new": True}, "frontier_index", "src", "g", "data")
        write_json_atomic(doc, out)
        loaded = json.loads(out.read_text(encoding="utf-8"))
        assert "old" not in loaded
        assert loaded["data"]["new"] is True

    def test_returns_none(self, tmp_path):
        doc = build_phase8_document({"a": 1}, "frontier_index", "src", "g", "k")
        out = tmp_path / "ret.json"
        assert write_json_atomic(doc, out) is None

    def test_tuple_payload_serialized_as_list(self, tmp_path):
        payload = {"weights": (0.6, 0.4)}
        doc = build_phase8_document(payload, "frontier_index", "src", "g", "data")
        out = tmp_path / "t.json"
        write_json_atomic(doc, out)
        loaded = json.loads(out.read_text(encoding="utf-8"))
        assert loaded["data"]["weights"] == [0.6, 0.4]

    def test_round_trip_all_kinds(self, tmp_path):
        for kind in sorted(ALLOWED_KINDS):
            doc = build_phase8_document(_sample_payload(), kind, "src", "g", kind)
            out = tmp_path / f"{kind}.json"
            write_json_atomic(doc, out)
            loaded = json.loads(out.read_text(encoding="utf-8"))
            assert loaded["_meta"]["kind"] == kind


# ── CLASS 6: TestExplicitPathContract ────────────────────────────────────────


class TestExplicitPathContract:
    def test_write_json_atomic_has_no_default_output_path(self):
        sig = inspect.signature(write_json_atomic)
        param = sig.parameters["output_path"]
        assert param.default is inspect.Parameter.empty

    def test_write_json_atomic_requires_two_args(self):
        sig = inspect.signature(write_json_atomic)
        assert list(sig.parameters.keys()) == ["data", "output_path"]

    def test_build_phase8_document_has_no_path_parameter(self):
        sig = inspect.signature(build_phase8_document)
        for name in sig.parameters:
            assert "path" not in name.lower()

    def test_module_defines_no_public_data_path_constant(self):
        consts = _string_constants_excluding_docstring(_module_path())
        for s in consts:
            assert "public/data" not in s, (
                f"module has a non-docstring string referencing public/data: {s!r}"
            )

    def test_module_defines_no_public_path_constant(self):
        consts = _string_constants_excluding_docstring(_module_path())
        for s in consts:
            assert not s.startswith("public/"), (
                f"module has a string literal starting with 'public/': {s!r}"
            )


# ── CLASS 7: TestNoPublicDataWrite ───────────────────────────────────────────


class TestNoPublicDataWrite:
    def test_all_filewrite_tests_use_tmp_path_fixture(self):
        """
        write_json_atomic を呼ぶ全テスト関数が pytest tmp_path fixture を
        受け取ることを構造的に検証する（public/ 配下に書かない保証）。
        """
        tree = ast.parse(Path(__file__).read_text(encoding="utf-8"))
        offenders: list = []
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef):
                calls_write = any(
                    isinstance(c, ast.Call)
                    and isinstance(c.func, ast.Name)
                    and c.func.id == "write_json_atomic"
                    for c in ast.walk(node)
                )
                if calls_write:
                    params = {a.arg for a in node.args.args}
                    if "tmp_path" not in params:
                        offenders.append(node.name)
        assert offenders == [], (
            f"write_json_atomic tests must use tmp_path fixture: {offenders}"
        )

    def test_module_string_constants_have_no_public_path_literal(self):
        """
        実装モジュールのコード文字列定数（docstring 除く）に public/ 始まり
        の path リテラルが無いことを検証する。

        モジュール側は public/data を散文でも持たない（docstring のみ言及）ため
        厳密に startswith 判定できる。テストファイル自身の自己参照スキャンは
        assertion メッセージ等で 'public/data' を必然的に含むため行わず、
        書き込みは test_all_filewrite_tests_use_tmp_path_fixture で構造的に保証する。
        """
        consts = _string_constants_excluding_docstring(_module_path())
        for s in consts:
            assert not s.startswith("public/"), (
                f"module string literal looks like a public write path: {s!r}"
            )

    def test_module_source_has_no_datetime_now(self):
        # generated_at は caller 供給。writer は datetime.now() を呼ばない（P1-D4）
        src = _module_path().read_text(encoding="utf-8")
        # docstring を除いた実コード行に datetime.now / time.time がない
        tree = ast.parse(src)
        doc = ast.get_docstring(tree)
        code_lines = src
        if doc is not None:
            code_lines = code_lines.replace(doc, "")
        assert "datetime.now" not in code_lines
        assert "time.time(" not in code_lines

    def test_module_does_not_import_datetime(self):
        imports = _top_level_imports(_module_path())
        assert "datetime" not in imports


# ── CLASS 8: TestForbiddenAbsence ────────────────────────────────────────────


class TestForbiddenAbsence:
    def test_module_code_has_no_forbidden_decision_tokens(self):
        consts = _string_constants_excluding_docstring(_module_path())
        for s in consts:
            for tok in _FORBIDDEN_DECISION_TOKENS_UPPER:
                assert tok not in s, (
                    f"module code string has forbidden token '{tok}': {s!r}"
                )

    def test_module_code_has_no_HOLD_word(self):
        consts = _string_constants_excluding_docstring(_module_path())
        for s in consts:
            assert not _FORBIDDEN_DECISION_HOLD_PATTERN.search(s), (
                f"module code string has HOLD as word: {s!r}"
            )

    def test_envelope_keys_have_no_forbidden_field_names(self):
        doc = build_phase8_document(_sample_payload(), "frontier_index", "src", "g", "k")
        for key in doc.keys():
            assert key not in _FORBIDDEN_FIELD_NAMES
        for key in doc["_meta"].keys():
            assert key not in _FORBIDDEN_FIELD_NAMES

    def test_module_has_no_forbidden_field_assignment(self):
        # モジュール内に禁止フィールド名の変数/定数定義がない
        tree = ast.parse(_module_path().read_text(encoding="utf-8"))
        assigned: set = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for tgt in node.targets:
                    if isinstance(tgt, ast.Name):
                        assigned.add(tgt.id)
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                assigned.add(node.target.id)
        for forbidden in _FORBIDDEN_FIELD_NAMES:
            assert forbidden not in assigned

    def test_meta_kind_allowlist_has_no_forbidden_tokens(self):
        for kind in ALLOWED_KINDS:
            for tok in _FORBIDDEN_DECISION_TOKENS_UPPER:
                assert tok not in kind


# ── CLASS 9: TestStaticImportConstraints ─────────────────────────────────────


class TestStaticImportConstraints:
    def test_test_file_no_numpy(self):
        assert "numpy" not in _top_level_imports(Path(__file__))

    def test_test_file_no_scipy(self):
        assert "scipy" not in _top_level_imports(Path(__file__))

    def test_test_file_no_pandas(self):
        assert "pandas" not in _top_level_imports(Path(__file__))

    def test_module_no_numpy(self):
        assert "numpy" not in _top_level_imports(_module_path())

    def test_module_no_scipy(self):
        assert "scipy" not in _top_level_imports(_module_path())

    def test_module_no_pandas(self):
        assert "pandas" not in _top_level_imports(_module_path())

    def test_module_does_not_import_phase8_dataclasses(self):
        # Flat DI: Phase 8 dataclass を直接 import しない（P1-D3）
        src = _module_path().read_text(encoding="utf-8")
        tree = ast.parse(src)
        imported: set = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                for alias in node.names:
                    imported.add(alias.name)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    imported.add(alias.name)
        forbidden_types = {
            "FrontierIndex", "StrategyAggregateResult",
            "OpportunityLossResult", "FutureBranchingResult",
            "StrategyOutput",
        }
        assert not (imported & forbidden_types), (
            f"Flat DI violation: imported Phase 8 types {imported & forbidden_types}"
        )

    def test_module_only_stdlib_imports(self):
        allowed = {
            "__future__", "copy", "json", "os", "tempfile",
            "pathlib", "typing",
        }
        imports = _top_level_imports(_module_path())
        unexpected = imports - allowed
        assert not unexpected, f"Unexpected module imports: {unexpected}"
