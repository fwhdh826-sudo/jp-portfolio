"""
test_drawdown_estimator.py — Card C（P2-8N）
DrawdownEstimator + FrontierStrategy Phase 8 接続のユニットテスト。

テスト方針:
  - stdlib-only（ast / json / math / pathlib / re / dataclasses）+ pytest
  - import numpy / scipy / pandas 禁止
  - 禁止フィールド / 禁止語 absence assertion
  - import 境界検証: FrontierStrategy は decision を直接 import しない /
    drawdown_estimator のみ calc_max_drawdown を import
  - Phase 8 success → returns-based observed max_dd / fallback → regime reference
"""
from __future__ import annotations

import ast
import json
import math
import re
from dataclasses import fields
from pathlib import Path

import pytest

from engine.frontier.drawdown_estimator import (
    DrawdownEstimator,
    DrawdownEstimatorInput,
    DrawdownEstimatorResult,
)
from engine.strategies.base_strategy import StrategyInput
from engine.strategies.frontier_strategy import (
    FrontierStrategy,
    _FALLBACK_REGIME,
    _REGIME_MAX_DD,
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


def _module_path(name: str) -> Path:
    return Path(__file__).parent.parent.parent / "engine" / "frontier" / name


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


def _est() -> DrawdownEstimator:
    return DrawdownEstimator()


_BASIC_SCORES = {
    "A": {
        "value": {"total": 65.0}, "quality": {"total": 70.0},
        "growth": {"total": 55.0}, "safety": {"total": 60.0},
        "momentum": {"total": 50.0}, "shareholder_return": {"total": 45.0},
    },
    "B": {
        "value": {"total": 50.0}, "quality": {"total": 60.0},
        "growth": {"total": 65.0}, "safety": {"total": 75.0},
        "momentum": {"total": 55.0}, "shareholder_return": {"total": 50.0},
    },
}


def _phase8_input(regime="bull_calm", returns_data=None) -> StrategyInput:
    if returns_data is None:
        returns_data = {
            "A": [0.10, -0.05, 0.08, -0.03, 0.06],
            "B": [0.02, -0.01, 0.03, -0.01, 0.02],
        }
    ctx = {
        "returns_data": returns_data,
        "mean_return_3y_by_ticker": {"A": 0.08, "B": 0.03},
        "size_segment_by_ticker": {"A": "large_cap", "B": "large_cap"},
        "shrinkage_alpha": 0.0,
        "asset_meta_by_ticker": {
            "A": {"sector": "tech", "is_core": False, "is_leveraged": False},
            "B": {"sector": "finance", "is_core": False, "is_leveraged": False},
        },
    }
    return StrategyInput(
        universe=("A", "B"), scores=_BASIC_SCORES, regime=regime,
        horizon="long_term", context=ctx,
    )


def _phase7_input(regime="bull_calm") -> StrategyInput:
    return StrategyInput(
        universe=("A", "B"), scores=_BASIC_SCORES, regime=regime,
        horizon="long_term", context={},
    )


# ── CLASS 1: TestDrawdownEstimatorInputContract ──────────────────────────────


class TestDrawdownEstimatorInputContract:
    def test_is_frozen(self):
        inp = DrawdownEstimatorInput(("A",), (1.0,), {"A": [0.1, 0.2]})
        with pytest.raises(Exception):
            inp.min_periods = 5  # type: ignore

    def test_fields_exist(self):
        inp = DrawdownEstimatorInput(("A",), (1.0,), {"A": [0.1, 0.2]})
        for f in ("tickers", "weights", "returns_data", "min_periods", "context"):
            assert hasattr(inp, f)

    def test_min_periods_default_2(self):
        inp = DrawdownEstimatorInput(("A",), (1.0,), {"A": [0.1, 0.2]})
        assert inp.min_periods == 2

    def test_min_periods_floor_2(self):
        inp = DrawdownEstimatorInput(("A",), (1.0,), {}, min_periods=0)
        assert inp.min_periods == 2

    def test_min_periods_invalid_falls_back(self):
        inp = DrawdownEstimatorInput(("A",), (1.0,), {}, min_periods="bad")  # type: ignore
        assert inp.min_periods == 2

    def test_tickers_coerced_to_tuple_of_str(self):
        inp = DrawdownEstimatorInput(["A", 7011], (1.0, 0.5), {})  # type: ignore
        assert inp.tickers == ("A", "7011")

    def test_weights_coerced_to_float_tuple(self):
        inp = DrawdownEstimatorInput(("A", "B"), ["0.6", None], {})  # type: ignore
        assert inp.weights == (0.6, 0.0)

    def test_non_dict_returns_data_falls_back_to_empty(self):
        inp = DrawdownEstimatorInput(("A",), (1.0,), "not_a_dict")  # type: ignore
        assert inp.returns_data == {}

    def test_non_dict_context_falls_back_to_empty(self):
        inp = DrawdownEstimatorInput(("A",), (1.0,), {}, context=5)  # type: ignore
        assert inp.context == {}

    def test_context_default_factory_independence(self):
        a = DrawdownEstimatorInput(("A",), (1.0,), {})
        b = DrawdownEstimatorInput(("A",), (1.0,), {})
        assert a.context is not b.context

    def test_no_forbidden_fields(self):
        names = {f.name for f in fields(DrawdownEstimatorInput)}
        for forbidden in _FORBIDDEN_FIELD_NAMES:
            assert forbidden not in names


# ── CLASS 2: TestDrawdownEstimatorResultContract ─────────────────────────────


class TestDrawdownEstimatorResultContract:
    def _res(self) -> DrawdownEstimatorResult:
        return _est().estimate(DrawdownEstimatorInput(
            ("A", "B"), (0.6, 0.4),
            {"A": [0.1, -0.2, 0.05, -0.15], "B": [0.02, -0.01, 0.03, -0.01]},
        ))

    def test_is_frozen(self):
        r = self._res()
        with pytest.raises(Exception):
            r.max_drawdown = 1.0  # type: ignore

    def test_fields_exist(self):
        r = self._res()
        for f in (
            "portfolio_returns", "max_drawdown", "is_drawdown_defined",
            "coverage_weight", "used_tickers", "missing_tickers", "diagnostics",
        ):
            assert hasattr(r, f)

    def test_max_drawdown_clamped_nonpositive(self):
        r = DrawdownEstimatorResult((), 0.5, True, 1.0, (), (), ())
        assert r.max_drawdown == 0.0

    def test_portfolio_returns_is_tuple(self):
        r = self._res()
        assert isinstance(r.portfolio_returns, tuple)

    def test_used_missing_are_tuples(self):
        r = self._res()
        assert isinstance(r.used_tickers, tuple)
        assert isinstance(r.missing_tickers, tuple)

    def test_to_dict_json_serializable(self):
        r = self._res()
        assert isinstance(json.dumps(r.to_dict()), str)

    def test_to_dict_keys(self):
        r = self._res()
        d = r.to_dict()
        assert set(d.keys()) == {
            "portfolio_returns", "max_drawdown", "is_drawdown_defined",
            "coverage_weight", "used_tickers", "missing_tickers", "diagnostics",
        }

    def test_no_forbidden_fields(self):
        names = {f.name for f in fields(DrawdownEstimatorResult)}
        for forbidden in _FORBIDDEN_FIELD_NAMES:
            assert forbidden not in names


# ── CLASS 3: TestPortfolioReturnsSynthesis ───────────────────────────────────


class TestPortfolioReturnsSynthesis:
    def test_weighted_sum(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B"), (0.5, 0.5),
            {"A": [0.10, 0.20], "B": [0.00, 0.00]},
        ))
        # pr[t] = 0.5*A + 0.5*B
        assert r.portfolio_returns == pytest.approx((0.05, 0.10))

    def test_weights_not_renormalized(self):
        # B 欠損 → A weight 0.6 のみ。再正規化なら 1.0 になるはずだが、しない
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B"), (0.6, 0.4),
            {"A": [0.10, -0.20, 0.30]},
        ))
        # pr[t] = 0.6 * A[t]（0.4 分は再配分しない）
        assert r.portfolio_returns == pytest.approx((0.06, -0.12, 0.18))
        assert r.coverage_weight == pytest.approx(0.6)

    def test_strict_intersection_min_length(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B"), (0.5, 0.5),
            {"A": [0.1, 0.2, 0.3, 0.4], "B": [0.0, 0.0]},
        ))
        # n_obs = min(4, 2) = 2
        assert len(r.portfolio_returns) == 2

    def test_tail_preferred_alignment(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B"), (1.0, 0.0),
            {"A": [0.99, 0.88, 0.10, 0.20], "B": [0.0, 0.0]},
        ))
        # A は末尾 2 = [0.10, 0.20]、weight A=1.0 B=0.0
        assert r.portfolio_returns == pytest.approx((0.10, 0.20))

    def test_single_ticker(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A",), (1.0,), {"A": [0.05, -0.10, 0.03]},
        ))
        assert r.portfolio_returns == pytest.approx((0.05, -0.10, 0.03))

    def test_three_tickers_weighted(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B", "C"), (0.2, 0.3, 0.5),
            {"A": [0.10, 0.10], "B": [0.20, 0.20], "C": [0.40, 0.40]},
        ))
        # pr = 0.2*0.1 + 0.3*0.2 + 0.5*0.4 = 0.02+0.06+0.20 = 0.28
        assert r.portfolio_returns == pytest.approx((0.28, 0.28))

    def test_zero_weight_ticker_contributes_zero(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B"), (0.0, 1.0),
            {"A": [9.9, 9.9], "B": [0.01, 0.02]},
        ))
        assert r.portfolio_returns == pytest.approx((0.01, 0.02))

    def test_tickers_weights_length_mismatch_truncated(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B", "C"), (0.5, 0.5),  # 3 vs 2
            {"A": [0.1, 0.2], "B": [0.0, 0.0], "C": [9.9, 9.9]},
        ))
        joined = " ".join(r.diagnostics)
        assert "length mismatch" in joined
        # C は truncate されるので used に含まれない
        assert "C" not in r.used_tickers

    def test_invalid_element_coerced_preserves_alignment(self):
        # A に文字混入。finite>=2 なら通過、要素は 0.0 へ coerce
        r = _est().estimate(DrawdownEstimatorInput(
            ("A",), (1.0,), {"A": [0.10, "bad", 0.20]},
        ))
        assert r.is_drawdown_defined is True
        assert r.portfolio_returns == pytest.approx((0.10, 0.0, 0.20))

    def test_portfolio_returns_length_equals_n_obs(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B"), (0.5, 0.5),
            {"A": [0.1] * 7, "B": [0.0] * 5},
        ))
        assert len(r.portfolio_returns) == 5

    def test_input_returns_data_not_mutated(self):
        rd = {"A": [0.1, -0.2, 0.3], "B": [0.0, 0.0, 0.0]}
        snapshot = json.loads(json.dumps(rd))
        _est().estimate(DrawdownEstimatorInput(("A", "B"), (0.5, 0.5), rd))
        assert rd == snapshot


# ── CLASS 4: TestCoverageWeight ──────────────────────────────────────────────


class TestCoverageWeight:
    def test_full_coverage(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B"), (0.7, 0.3),
            {"A": [0.1, 0.2], "B": [0.0, 0.0]},
        ))
        assert r.coverage_weight == pytest.approx(1.0)

    def test_partial_coverage_not_renormalized(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B"), (0.7, 0.3),
            {"A": [0.1, 0.2]},  # B missing
        ))
        assert r.coverage_weight == pytest.approx(0.7)

    def test_coverage_excludes_insufficient_series(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B"), (0.6, 0.4),
            {"A": [0.1, 0.2, 0.3], "B": [0.5]},  # B finite count < 2
        ))
        assert "B" in r.missing_tickers
        assert r.coverage_weight == pytest.approx(0.6)

    def test_zero_coverage_when_no_overlap(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("X",), (1.0,), {"A": [0.1, 0.2]},
        ))
        assert r.coverage_weight == 0.0

    def test_coverage_diagnostic_present_when_missing(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B"), (0.7, 0.3), {"A": [0.1, 0.2]},
        ))
        joined = " ".join(r.diagnostics)
        assert "coverage_weight" in joined
        assert "NOT renormalized" in joined

    def test_coverage_sums_only_used(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B", "C"), (0.2, 0.3, 0.5),
            {"A": [0.1, 0.2], "C": [0.0, 0.0]},  # B missing
        ))
        assert r.coverage_weight == pytest.approx(0.7)  # 0.2 + 0.5


# ── CLASS 5: TestMissingTickers ──────────────────────────────────────────────


class TestMissingTickers:
    def test_missing_recorded(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B"), (0.5, 0.5), {"A": [0.1, 0.2]},
        ))
        assert "B" in r.missing_tickers
        assert "A" in r.used_tickers

    def test_invalid_series_excluded(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B"), (0.5, 0.5),
            {"A": [0.1, 0.2], "B": "not_a_list"},
        ))
        assert "B" in r.missing_tickers

    def test_short_series_excluded(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B"), (0.5, 0.5),
            {"A": [0.1, 0.2, 0.3], "B": [0.5]},
        ))
        assert "B" in r.missing_tickers

    def test_all_invalid_floats_excluded(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A",), (1.0,), {"A": [None, "x", float("nan")]},
        ))
        assert "A" in r.missing_tickers
        assert r.is_drawdown_defined is False

    def test_used_tickers_order_follows_input(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("B", "A"), (0.5, 0.5),
            {"A": [0.1, 0.2], "B": [0.0, 0.0]},
        ))
        assert r.used_tickers == ("B", "A")

    def test_missing_empty_when_all_valid(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B"), (0.5, 0.5),
            {"A": [0.1, 0.2], "B": [0.0, 0.0]},
        ))
        assert r.missing_tickers == ()


# ── CLASS 6: TestCalcMaxDrawdownIntegration ──────────────────────────────────


class TestCalcMaxDrawdownIntegration:
    def test_monotonic_up_returns_zero_drawdown(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A",), (1.0,), {"A": [0.01, 0.02, 0.03, 0.04]},
        ))
        assert r.max_drawdown == 0.0
        assert r.is_drawdown_defined is True

    def test_drawdown_case_negative(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A",), (1.0,), {"A": [0.10, -0.30, -0.10, 0.05]},
        ))
        assert r.max_drawdown < 0.0

    def test_max_drawdown_always_nonpositive(self):
        for series in (
            [0.1, 0.1, 0.1], [-0.5, -0.5], [0.2, -0.9, 0.3],
            [0.0, 0.0, 0.0], [1.0, -0.99],
        ):
            r = _est().estimate(DrawdownEstimatorInput(
                ("A",), (1.0,), {"A": series},
            ))
            assert r.max_drawdown <= 0.0

    def test_known_drawdown_value(self):
        # equity: 1.0 -> 1.2 -> 0.6 -> ...; dd at trough = 0.6/1.2 - 1 = -0.5
        r = _est().estimate(DrawdownEstimatorInput(
            ("A",), (1.0,), {"A": [0.20, -0.50, 0.10]},
        ))
        assert r.max_drawdown == pytest.approx(-0.5, abs=1e-9)

    def test_observed_diagnostic_present_when_defined(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A",), (1.0,), {"A": [0.10, -0.20, 0.05]},
        ))
        joined = " ".join(r.diagnostics)
        assert "observed max drawdown" in joined
        assert "not a prediction" in joined

    def test_recovery_then_new_high_drawdown(self):
        # dd is worst at trough, recovery to new high keeps recorded worst dd
        r = _est().estimate(DrawdownEstimatorInput(
            ("A",), (1.0,), {"A": [0.50, -0.40, 0.50, 0.50]},
        ))
        assert r.max_drawdown < 0.0

    def test_all_negative_returns_large_drawdown(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A",), (1.0,), {"A": [-0.10, -0.10, -0.10, -0.10]},
        ))
        assert r.max_drawdown < -0.30

    def test_flat_returns_zero_drawdown(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A",), (1.0,), {"A": [0.0, 0.0, 0.0, 0.0]},
        ))
        assert r.max_drawdown == 0.0


# ── CLASS 7: TestUndefinedCases ──────────────────────────────────────────────


class TestUndefinedCases:
    def test_empty_returns_data(self):
        r = _est().estimate(DrawdownEstimatorInput(("A",), (1.0,), {}))
        assert r.is_drawdown_defined is False
        assert r.max_drawdown == 0.0
        assert r.portfolio_returns == ()

    def test_no_ticker_overlap(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("X", "Y"), (0.5, 0.5), {"A": [0.1, 0.2]},
        ))
        assert r.is_drawdown_defined is False
        joined = " ".join(r.diagnostics)
        assert "no ticker overlap" in joined

    def test_insufficient_periods(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A",), (1.0,), {"A": [0.1, 0.2, 0.3]}, min_periods=5,
        ))
        assert r.is_drawdown_defined is False
        joined = " ".join(r.diagnostics)
        assert "insufficient overlapping periods" in joined

    def test_n_obs_below_two_undefined(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B"), (0.5, 0.5),
            {"A": [0.1, 0.2, 0.3], "B": [0.0]},  # B finite count 1 -> missing
        ))
        # B excluded; A alone n_obs=3 -> defined
        assert r.is_drawdown_defined is True
        assert "B" in r.missing_tickers

    def test_non_dict_returns_data_undefined(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A",), (1.0,), "garbage",  # type: ignore
        ))
        assert r.is_drawdown_defined is False

    def test_undefined_keeps_coverage_and_missing(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B"), (0.6, 0.4),
            {"A": [0.1]},  # too short -> A missing, no valid
        ))
        assert r.is_drawdown_defined is False
        assert "A" in r.missing_tickers

    def test_empty_universe(self):
        r = _est().estimate(DrawdownEstimatorInput((), (), {"A": [0.1, 0.2]}))
        assert r.is_drawdown_defined is False

    def test_undefined_max_drawdown_is_zero(self):
        r = _est().estimate(DrawdownEstimatorInput(("X",), (1.0,), {}))
        assert r.max_drawdown == 0.0


# ── CLASS 8: TestForbiddenAbsence ────────────────────────────────────────────


class TestForbiddenAbsence:
    def test_diagnostics_no_decision_tokens(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A",), (1.0,), {"A": [0.1, -0.2, 0.05]},
        ))
        for d in r.diagnostics:
            for tok in _FORBIDDEN_DECISION_TOKENS_UPPER:
                assert tok not in d
            assert not _FORBIDDEN_DECISION_HOLD_PATTERN.search(d)

    def test_diagnostics_observation_prefix(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A", "B"), (0.5, 0.5), {"A": [0.1, 0.2]},
        ))
        for d in r.diagnostics:
            assert d.startswith("observation: ")

    def test_to_dict_keys_no_forbidden_names(self):
        r = _est().estimate(DrawdownEstimatorInput(
            ("A",), (1.0,), {"A": [0.1, 0.2]},
        ))
        for k in r.to_dict().keys():
            assert k not in _FORBIDDEN_FIELD_NAMES

    def test_module_code_no_decision_tokens(self):
        # docstring を除いた module コード文字列に禁止トークンがない
        src = _module_path("drawdown_estimator.py").read_text(encoding="utf-8")
        tree = ast.parse(src)
        doc_ids = set()

        def _rec(body):
            if (body and isinstance(body[0], ast.Expr)
                    and isinstance(body[0].value, ast.Constant)
                    and isinstance(body[0].value.value, str)):
                doc_ids.add(id(body[0].value))

        _rec(tree.body)
        for n in ast.walk(tree):
            if isinstance(n, (ast.FunctionDef, ast.ClassDef)):
                _rec(n.body)
        for n in ast.walk(tree):
            if (isinstance(n, ast.Constant) and isinstance(n.value, str)
                    and id(n) not in doc_ids):
                for tok in _FORBIDDEN_DECISION_TOKENS_UPPER:
                    assert tok not in n.value

    def test_no_dd10_uniform_return_usage(self):
        # dd10_uniform_return / DD10Calculator / DD10KPIResult を使わない
        src = _module_path("drawdown_estimator.py").read_text(encoding="utf-8")
        tree = ast.parse(src)
        imported: set = set()
        for n in ast.walk(tree):
            if isinstance(n, ast.ImportFrom) and n.module:
                for a in n.names:
                    imported.add(a.name)
        assert "dd10_uniform_return" not in imported
        assert "calc_dd10_uniform_return" not in imported
        assert "DD10Calculator" not in imported
        assert "DD10KPIResult" not in imported


# ── CLASS 9: TestImportBoundary ──────────────────────────────────────────────


class TestImportBoundary:
    def test_drawdown_estimator_imports_calc_max_drawdown(self):
        src = _module_path("drawdown_estimator.py").read_text(encoding="utf-8")
        tree = ast.parse(src)
        found = False
        for n in ast.walk(tree):
            if isinstance(n, ast.ImportFrom) and n.module == "engine.decision.dd10_kpi":
                names = {a.name for a in n.names}
                assert "calc_max_drawdown" in names
                found = True
        assert found, "drawdown_estimator must import calc_max_drawdown from dd10_kpi"

    def test_frontier_strategy_does_not_import_decision(self):
        src = (
            Path(__file__).parent.parent.parent
            / "engine" / "strategies" / "frontier_strategy.py"
        ).read_text(encoding="utf-8")
        tree = ast.parse(src)
        for n in ast.walk(tree):
            if isinstance(n, ast.ImportFrom) and n.module:
                assert not n.module.startswith("engine.decision"), (
                    f"FrontierStrategy must not import decision: {n.module}"
                )
            if isinstance(n, ast.Import):
                for a in n.names:
                    assert not a.name.startswith("engine.decision")

    def test_frontier_strategy_imports_drawdown_estimator(self):
        src = (
            Path(__file__).parent.parent.parent
            / "engine" / "strategies" / "frontier_strategy.py"
        ).read_text(encoding="utf-8")
        tree = ast.parse(src)
        found = any(
            isinstance(n, ast.ImportFrom)
            and n.module == "engine.frontier.drawdown_estimator"
            for n in ast.walk(tree)
        )
        assert found

    def test_drawdown_estimator_no_numpy_scipy_pandas(self):
        imports = _top_level_imports(_module_path("drawdown_estimator.py"))
        assert "numpy" not in imports
        assert "scipy" not in imports
        assert "pandas" not in imports

    def test_test_file_no_numpy_scipy_pandas(self):
        imports = _top_level_imports(Path(__file__))
        assert "numpy" not in imports
        assert "scipy" not in imports
        assert "pandas" not in imports

    def test_drawdown_estimator_only_expected_imports(self):
        imports = _top_level_imports(_module_path("drawdown_estimator.py"))
        allowed = {"__future__", "math", "dataclasses", "typing", "engine"}
        assert not (imports - allowed), f"unexpected imports: {imports - allowed}"


# ── CLASS 10: TestFrontierStrategyPhase8Integration ──────────────────────────


class TestFrontierStrategyPhase8Integration:
    def test_phase8_success_uses_returns_based_max_dd(self):
        out = FrontierStrategy().compute(_phase8_input(regime="bull_calm"))
        # returns_data ありなので regime reference とは異なる観測値
        assert out.max_dd_estimate != pytest.approx(_REGIME_MAX_DD["bull_calm"])
        assert out.max_dd_estimate <= 0.0
        diag = " ".join(out.diagnostics)
        assert "observed max drawdown from returns_data" in diag

    def test_phase8_success_no_regime_reference_diagnostic(self):
        out = FrontierStrategy().compute(_phase8_input())
        diag = " ".join(out.diagnostics)
        assert "max_dd_estimate is regime reference value" not in diag
        assert "P1-8N" not in diag

    def test_phase8_fallback_uses_regime_reference(self):
        # returns_data の ticker が universe と重複しない → fallback
        rd = {"ZZZ": [0.1, -0.2, 0.05, -0.1]}
        out = FrontierStrategy().compute(
            _phase8_input(regime="bull_calm", returns_data=rd)
        )
        # Phase 8 経路には入る（returns_data は非空 dict）が drawdown undefined
        assert out.max_dd_estimate == pytest.approx(_REGIME_MAX_DD["bull_calm"])
        diag = " ".join(out.diagnostics)
        assert "fell back to regime reference" in diag

    def test_phase8_fallback_diagnostic_text(self):
        rd = {"ZZZ": [0.1, -0.2, 0.05, -0.1]}
        out = FrontierStrategy().compute(
            _phase8_input(returns_data=rd)
        )
        diag = " ".join(out.diagnostics)
        assert "returns_data unavailable or insufficient" in diag

    def test_phase8_max_dd_nonpositive(self):
        out = FrontierStrategy().compute(_phase8_input())
        assert out.max_dd_estimate <= 0.0

    def test_phase7_unchanged_regime_reference(self):
        # Phase 7 経路（returns_data なし）は regime reference 継続
        out = FrontierStrategy().compute(_phase7_input(regime="bull_calm"))
        assert out.max_dd_estimate == pytest.approx(_REGIME_MAX_DD["bull_calm"])

    def test_phase7_still_has_phase7_identifier(self):
        out = FrontierStrategy().compute(_phase7_input())
        diag = " ".join(out.diagnostics)
        assert "Phase 8 returns_data not provided" in diag

    def test_strategy_output_schema_fields_unchanged(self):
        out = FrontierStrategy().compute(_phase8_input())
        # StrategyOutput の標準フィールドのみ（schema 不変）
        for f in (
            "strategy_id", "strategy_name", "ideal_pf", "expected_return",
            "expected_vol", "sharpe_ratio", "max_dd_estimate",
            "rationale", "diagnostics",
        ):
            assert hasattr(out, f)
