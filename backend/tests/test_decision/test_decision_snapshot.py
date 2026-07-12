"""
test_decision_snapshot.py — Card 5-9 DecisionSnapshot テスト（65 tests）

6軸スコア / EV / CVaR / リスク調整値を束ねる中間層。
判断フィールドなし。composite_score は present_weight_sum で正規化。
"""
from __future__ import annotations

import inspect
import json
from dataclasses import FrozenInstanceError

import pytest

from backend.engine.decision.decision_snapshot import (
    CANONICAL_AXES,
    AxisScoreBundle,
    AxisScoreEntry,
    DecisionSnapshot,
    SnapshotBuilder,
    _safe_total,
)

_BUILDER = SnapshotBuilder()

_FULL_AXES = [
    {"axis": "value",             "name_ja": "バリュー",    "total": 70, "explanation": "割安"},
    {"axis": "quality",           "name_ja": "クオリティ",  "total": 75, "explanation": "高品質"},
    {"axis": "growth",            "name_ja": "成長",        "total": 65, "explanation": "成長"},
    {"axis": "safety",            "name_ja": "安全",        "total": 80, "explanation": "安全"},
    {"axis": "momentum",          "name_ja": "モメンタム",  "total": 60, "explanation": "上昇"},
    {"axis": "shareholder_return","name_ja": "株主還元",    "total": 72, "explanation": "高配当"},
]

_THREE_AXES = [
    {"axis": "value",   "name_ja": "バリュー",   "total": 80, "explanation": "割安"},
    {"axis": "quality", "name_ja": "クオリティ", "total": 80, "explanation": "高品質"},
    {"axis": "growth",  "name_ja": "成長",       "total": 80, "explanation": "成長"},
]


def _make_snapshot(**kwargs) -> DecisionSnapshot:
    defaults = dict(
        ticker="7203",
        snapshot_id="7203_20240101",
        axis_scores_list=_FULL_AXES,
        axis_weights={},
        ev_fund=0.05,
        ev_final=0.08,
        cvar=-0.12,
        cvar_mode="parametric",
        confidence=0.8,
        uncertainty=0.2,
        risk_adjusted_ev=0.05,
        smoothed_ev=0.06,
        regime="bull_calm",
        notes="テスト用",
    )
    defaults.update(kwargs)
    return _BUILDER.build(**defaults)


# ── TestSafeTotalHelper ────────────────────────────────────────────────────────

class TestSafeTotalHelper:
    def test_int_passthrough(self):
        assert _safe_total(70) == 70

    def test_float_rounded_up(self):
        assert _safe_total(64.7) == 65

    def test_float_rounded_down(self):
        assert _safe_total(64.3) == 64

    def test_float_half_rounds_to_even_or_up(self):
        # round(64.5) is 64 or 65 depending on Python banker's rounding — just check type
        result = _safe_total(64.5)
        assert isinstance(result, int)

    def test_string_int_converted(self):
        assert _safe_total("70") == 70

    def test_string_float_converted(self):
        assert _safe_total("64.7") == 65

    def test_invalid_string_fallback_50(self):
        assert _safe_total("abc") == 50

    def test_none_fallback_50(self):
        assert _safe_total(None) == 50

    def test_clamp_above_100(self):
        assert _safe_total(150) == 100

    def test_clamp_below_0(self):
        assert _safe_total(-10) == 0

    def test_exactly_0(self):
        assert _safe_total(0) == 0

    def test_exactly_100(self):
        assert _safe_total(100) == 100


# ── TestCanonicalAxes ──────────────────────────────────────────────────────────

class TestCanonicalAxes:
    def test_six_elements(self):
        assert len(CANONICAL_AXES) == 6

    def test_expected_axes(self):
        assert CANONICAL_AXES == (
            "value", "quality", "growth", "safety", "momentum", "shareholder_return"
        )

    def test_is_tuple(self):
        assert isinstance(CANONICAL_AXES, tuple)


# ── TestAxisScoreEntry ─────────────────────────────────────────────────────────

class TestAxisScoreEntry:
    def test_frozen(self):
        e = AxisScoreEntry(axis="value", name_ja="バリュー", total=70, explanation="割安")
        with pytest.raises((FrozenInstanceError, TypeError)):
            e.total = 80  # type: ignore[misc]

    def test_fields(self):
        e = AxisScoreEntry(axis="value", name_ja="バリュー", total=70, explanation="割安")
        assert e.axis == "value"
        assert e.name_ja == "バリュー"
        assert e.total == 70
        assert e.explanation == "割安"

    def test_no_judgment_fields(self):
        e = AxisScoreEntry(axis="value", name_ja="バリュー", total=70, explanation="割安")
        for field in ("is_buy", "is_sell", "is_hold", "is_recommended", "action", "rating"):
            assert not hasattr(e, field), f"{field} は判断フィールドのため禁止"


# ── TestAxisScoreBundle ────────────────────────────────────────────────────────

class TestAxisScoreBundle:
    def _make(self) -> AxisScoreBundle:
        snap = _make_snapshot()
        return snap.axis_bundle

    def test_frozen(self):
        b = self._make()
        with pytest.raises((FrozenInstanceError, TypeError)):
            b.composite_score = 0.0  # type: ignore[misc]

    def test_fields_exist(self):
        b = self._make()
        assert hasattr(b, "ticker")
        assert hasattr(b, "entries")
        assert hasattr(b, "missing_axes")
        assert hasattr(b, "axis_count")
        assert hasattr(b, "composite_score")

    def test_no_judgment_fields(self):
        b = self._make()
        for field in ("is_buy", "is_sell", "is_hold", "is_recommended", "action"):
            assert not hasattr(b, field), f"{field} は判断フィールドのため禁止"


# ── TestDecisionSnapshot ───────────────────────────────────────────────────────

class TestDecisionSnapshot:
    def test_frozen(self):
        s = _make_snapshot()
        with pytest.raises((FrozenInstanceError, TypeError)):
            s.ev_final = 0.0  # type: ignore[misc]

    def test_fields_exist(self):
        s = _make_snapshot()
        assert hasattr(s, "ticker")
        assert hasattr(s, "snapshot_id")
        assert hasattr(s, "axis_bundle")
        assert hasattr(s, "ev_fund")
        assert hasattr(s, "ev_final")
        assert hasattr(s, "cvar")
        assert hasattr(s, "cvar_mode")
        assert hasattr(s, "confidence")
        assert hasattr(s, "uncertainty")
        assert hasattr(s, "risk_adjusted_ev")
        assert hasattr(s, "smoothed_ev")
        assert hasattr(s, "regime")
        assert hasattr(s, "notes")

    def test_no_judgment_fields(self):
        s = _make_snapshot()
        for field in ("action", "recommendation", "is_buy", "is_sell",
                      "is_hold", "is_recommended", "rating"):
            assert not hasattr(s, field), f"{field} は判断フィールドのため禁止"

    def test_ticker_preserved(self):
        s = _make_snapshot(ticker="9984")
        assert s.ticker == "9984"

    def test_snapshot_id_preserved(self):
        s = _make_snapshot(snapshot_id="9984_20240601")
        assert s.snapshot_id == "9984_20240601"

    def test_regime_empty_string_allowed(self):
        s = _make_snapshot(regime="")
        assert s.regime == ""

    def test_notes_default_empty(self):
        s = _make_snapshot(notes="")
        assert s.notes == ""

    def test_negative_ev_allowed(self):
        s = _make_snapshot(ev_final=-0.03, risk_adjusted_ev=-0.03)
        assert s.ev_final < 0

    def test_negative_cvar_allowed(self):
        s = _make_snapshot(cvar=-0.25)
        assert s.cvar < 0


# ── TestMissingAxes ────────────────────────────────────────────────────────────

class TestMissingAxes:
    def test_all_six_present_no_missing(self):
        s = _make_snapshot(axis_scores_list=_FULL_AXES)
        assert s.axis_bundle.missing_axes == ()

    def test_three_axes_missing_three(self):
        s = _make_snapshot(axis_scores_list=_THREE_AXES)
        assert set(s.axis_bundle.missing_axes) == {"safety", "momentum", "shareholder_return"}

    def test_missing_axes_in_canonical_order(self):
        s = _make_snapshot(axis_scores_list=_THREE_AXES)
        # missing: safety(3), momentum(4), shareholder_return(5)
        assert s.axis_bundle.missing_axes == ("safety", "momentum", "shareholder_return")

    def test_empty_axis_list_all_missing(self):
        s = _make_snapshot(axis_scores_list=[])
        assert s.axis_bundle.missing_axes == CANONICAL_AXES

    def test_unknown_axis_not_in_missing(self):
        axes = _THREE_AXES + [{"axis": "unknown_axis", "name_ja": "不明", "total": 50, "explanation": ""}]
        s = _make_snapshot(axis_scores_list=axes)
        assert "unknown_axis" not in s.axis_bundle.missing_axes

    def test_axis_count_full(self):
        s = _make_snapshot(axis_scores_list=_FULL_AXES)
        assert s.axis_bundle.axis_count == 6

    def test_axis_count_three(self):
        s = _make_snapshot(axis_scores_list=_THREE_AXES)
        assert s.axis_bundle.axis_count == 3

    def test_axis_count_empty(self):
        s = _make_snapshot(axis_scores_list=[])
        assert s.axis_bundle.axis_count == 0


# ── TestCompositeScore ─────────────────────────────────────────────────────────

class TestCompositeScore:
    def test_equal_weight_average(self):
        axes = [
            {"axis": "value",   "name_ja": "v", "total": 60, "explanation": ""},
            {"axis": "quality", "name_ja": "q", "total": 80, "explanation": ""},
        ]
        s = _make_snapshot(axis_scores_list=axes, axis_weights={})
        assert abs(s.axis_bundle.composite_score - 70.0) < 1e-9

    def test_empty_entries_fallback_50(self):
        s = _make_snapshot(axis_scores_list=[], axis_weights={})
        assert abs(s.axis_bundle.composite_score - 50.0) < 1e-9

    def test_present_weight_sum_normalization(self):
        # 3 axes: total=80, weights: value=0.3, quality=0.2, growth=0.0 (missing from input: safety/momentum/shareholder_return)
        # only value and quality present
        axes = [
            {"axis": "value",   "name_ja": "v", "total": 80, "explanation": ""},
            {"axis": "quality", "name_ja": "q", "total": 80, "explanation": ""},
        ]
        weights = {"value": 0.3, "quality": 0.2, "growth": 0.5}
        s = _make_snapshot(axis_scores_list=axes, axis_weights=weights)
        # present_weight_sum = 0.3 + 0.2 = 0.5
        # weighted_sum = 80*0.3 + 80*0.2 = 40
        # composite = 40 / 0.5 = 80.0
        assert abs(s.axis_bundle.composite_score - 80.0) < 1e-9

    def test_weighted_average_all_present(self):
        axes = [
            {"axis": "value",   "name_ja": "v", "total": 60, "explanation": ""},
            {"axis": "quality", "name_ja": "q", "total": 80, "explanation": ""},
        ]
        weights = {"value": 0.4, "quality": 0.6}
        s = _make_snapshot(axis_scores_list=axes, axis_weights=weights)
        expected = (60 * 0.4 + 80 * 0.6) / (0.4 + 0.6)
        assert abs(s.axis_bundle.composite_score - expected) < 1e-9

    def test_present_weight_sum_zero_fallback_equal_weight(self):
        # weights only mention missing axes → present_weight_sum=0 → equal-weight fallback
        axes = [
            {"axis": "value",   "name_ja": "v", "total": 60, "explanation": ""},
            {"axis": "quality", "name_ja": "q", "total": 80, "explanation": ""},
        ]
        weights = {"growth": 0.5, "safety": 0.5}
        s = _make_snapshot(axis_scores_list=axes, axis_weights=weights)
        assert abs(s.axis_bundle.composite_score - 70.0) < 1e-9

    def test_single_axis_equal_weight(self):
        axes = [{"axis": "value", "name_ja": "v", "total": 77, "explanation": ""}]
        s = _make_snapshot(axis_scores_list=axes, axis_weights={})
        assert abs(s.axis_bundle.composite_score - 77.0) < 1e-9


# ── TestTotalConversion ────────────────────────────────────────────────────────

class TestTotalConversion:
    def test_float_total_rounded(self):
        axes = [{"axis": "value", "name_ja": "v", "total": 64.7, "explanation": ""}]
        s = _make_snapshot(axis_scores_list=axes)
        entry = s.axis_bundle.entries[0]
        assert entry.total == 65
        assert isinstance(entry.total, int)

    def test_invalid_total_fallback_50(self):
        axes = [{"axis": "value", "name_ja": "v", "total": "invalid", "explanation": ""}]
        s = _make_snapshot(axis_scores_list=axes)
        entry = s.axis_bundle.entries[0]
        assert entry.total == 50

    def test_total_clamped_above_100(self):
        axes = [{"axis": "value", "name_ja": "v", "total": 150, "explanation": ""}]
        s = _make_snapshot(axis_scores_list=axes)
        assert s.axis_bundle.entries[0].total == 100

    def test_total_clamped_below_0(self):
        axes = [{"axis": "value", "name_ja": "v", "total": -20, "explanation": ""}]
        s = _make_snapshot(axis_scores_list=axes)
        assert s.axis_bundle.entries[0].total == 0

    def test_missing_total_key_defaults_50(self):
        axes = [{"axis": "value", "name_ja": "v", "explanation": ""}]
        s = _make_snapshot(axis_scores_list=axes)
        assert s.axis_bundle.entries[0].total == 50


# ── TestComponentsKeyIgnored ───────────────────────────────────────────────────

class TestComponentsKeyIgnored:
    def test_components_key_ignored(self):
        axes = [{
            "axis": "value", "name_ja": "バリュー", "total": 70, "explanation": "割安",
            "components": [{"name": "per", "score": 30}],
        }]
        s = _make_snapshot(axis_scores_list=axes)
        entry = s.axis_bundle.entries[0]
        assert entry.total == 70
        assert not hasattr(entry, "components")

    def test_non_dict_items_skipped(self):
        axes = [
            "not_a_dict",
            {"axis": "value", "name_ja": "v", "total": 70, "explanation": ""},
        ]
        s = _make_snapshot(axis_scores_list=axes)
        assert s.axis_bundle.axis_count == 1


# ── TestToDict ────────────────────────────────────────────────────────────────

class TestToDict:
    def test_json_serializable(self):
        s = _make_snapshot()
        d = s.to_dict()
        json.dumps(d)  # raises if not serializable

    def test_top_level_keys(self):
        s = _make_snapshot()
        d = s.to_dict()
        for key in ("ticker", "snapshot_id", "regime", "composite_score",
                    "axis_count", "missing_axes", "axes", "ev", "notes"):
            assert key in d, f"キー {key!r} が to_dict() に含まれていない"

    def test_composite_score_is_int(self):
        s = _make_snapshot()
        d = s.to_dict()
        assert isinstance(d["composite_score"], int)

    def test_missing_axes_is_list(self):
        s = _make_snapshot()
        d = s.to_dict()
        assert isinstance(d["missing_axes"], list)

    def test_axes_list_structure(self):
        s = _make_snapshot()
        d = s.to_dict()
        for item in d["axes"]:
            assert "axis"        in item
            assert "name_ja"     in item
            assert "total"       in item
            assert "explanation" in item

    def test_ev_dict_keys(self):
        s = _make_snapshot()
        ev = s.to_dict()["ev"]
        for key in ("ev_fund", "ev_final", "cvar", "cvar_mode",
                    "confidence", "uncertainty", "risk_adjusted_ev", "smoothed_ev"):
            assert key in ev, f"ev キー {key!r} が欠損"

    def test_ticker_in_dict(self):
        s = _make_snapshot(ticker="9984")
        assert s.to_dict()["ticker"] == "9984"

    def test_regime_in_dict(self):
        s = _make_snapshot(regime="bear_volatile")
        assert s.to_dict()["regime"] == "bear_volatile"

    def test_cvar_mode_in_ev(self):
        s = _make_snapshot(cvar_mode="scenario")
        assert s.to_dict()["ev"]["cvar_mode"] == "scenario"


# ── TestForbiddenImports ───────────────────────────────────────────────────────

class TestForbiddenImports:
    def test_no_forbidden_imports(self):
        import backend.engine.decision.decision_snapshot as mod
        import_lines = [
            line.strip()
            for line in inspect.getsource(mod).splitlines()
            if line.strip().startswith(("import ", "from "))
        ]
        src_imports = "\n".join(import_lines)
        forbidden = [
            "import requests", "import httpx", "import aiohttp",
            "import urllib.request", "import openai", "import anthropic",
            "import litellm", "import ollama", "import pandas", "import numpy",
            "from backend.engine.regime",
            "from backend.engine.operation",
            "from backend.engine.market_intel",
            "from backend.engine.news",
            "from backend.engine.scoring",
            "from backend.engine.decision.ev_calculator",
            "from backend.engine.decision.cvar_estimator",
            "from backend.engine.decision.uncertainty_calc",
        ]
        for item in forbidden:
            assert item not in src_imports, f"禁止 import が含まれている: {item}"
