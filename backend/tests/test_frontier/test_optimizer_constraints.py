"""
test_optimizer_constraints.py — Card 8-2 テスト（optimizer_constraints.py）
stdlib-only, pytest only
"""
from __future__ import annotations

import pytest

from engine.frontier.optimizer_constraints import (
    BoundConstraint,
    ConstraintBuilder,
    ConstraintInput,
    GroupConstraint,
    OptimizerConstraints,
    SectorCapConstraint,
    SoftPenaltyParam,
    _VALID_REGIMES,
)

# ── フィクスチャ ──────────────────────────────────────────────────────────────

def _builder() -> ConstraintBuilder:
    return ConstraintBuilder()


def _inp(
    tickers=("7203",),
    asset_meta=None,
    locked_weights=None,
    regime="bull_calm",
    max_single_weight=0.08,
    sector_cap=0.35,
    leverage_cap=0.20,
    core_floor=0.55,
    risk_aversion=3.0,
) -> ConstraintInput:
    if asset_meta is None:
        asset_meta = {
            "7203": {"sector": "automotive", "is_leveraged": False, "is_core": True}
        }
    if locked_weights is None:
        locked_weights = {}
    return ConstraintInput(
        tickers=tickers,
        asset_meta=asset_meta,
        locked_weights=locked_weights,
        regime=regime,
        max_single_weight=max_single_weight,
        sector_cap=sector_cap,
        leverage_cap=leverage_cap,
        core_floor=core_floor,
        risk_aversion=risk_aversion,
    )


def _two_tickers_inp(
    is_core_a=True, is_core_b=False,
    is_lev_a=False, is_lev_b=True,
    locked_weights=None,
) -> ConstraintInput:
    return ConstraintInput(
        tickers=("A", "B"),
        asset_meta={
            "A": {"sector": "tech", "is_core": is_core_a, "is_leveraged": is_lev_a},
            "B": {"sector": "leverage", "is_core": is_core_b, "is_leveraged": is_lev_b},
        },
        locked_weights=locked_weights or {},
    )


# ── TestConstraintInput ───────────────────────────────────────────────────────

class TestConstraintInput:
    def test_valid_creation(self):
        ci = _inp()
        assert "7203" in ci.tickers

    def test_list_tickers_converted_to_tuple(self):
        ci = ConstraintInput(
            tickers=["A", "B"],  # type: ignore[arg-type]
            asset_meta={}, locked_weights={},
        )
        assert isinstance(ci.tickers, tuple)

    def test_invalid_context_becomes_empty_dict(self):
        ci = ConstraintInput(
            tickers=("A",), asset_meta={}, locked_weights={},
            context="bad",  # type: ignore[arg-type]
        )
        assert ci.context == {}

    def test_risk_aversion_default(self):
        ci = ConstraintInput(tickers=("A",), asset_meta={}, locked_weights={})
        assert ci.risk_aversion == pytest.approx(3.0)

    def test_sector_cap_default(self):
        ci = ConstraintInput(tickers=("A",), asset_meta={}, locked_weights={})
        assert ci.sector_cap == pytest.approx(0.35)

    def test_leverage_cap_default(self):
        ci = ConstraintInput(tickers=("A",), asset_meta={}, locked_weights={})
        assert ci.leverage_cap == pytest.approx(0.20)

    def test_core_floor_default(self):
        ci = ConstraintInput(tickers=("A",), asset_meta={}, locked_weights={})
        assert ci.core_floor == pytest.approx(0.55)

    def test_max_single_weight_default(self):
        ci = ConstraintInput(tickers=("A",), asset_meta={}, locked_weights={})
        assert ci.max_single_weight == pytest.approx(0.08)

    def test_frozen(self):
        ci = _inp()
        with pytest.raises((AttributeError, TypeError)):
            ci.regime = "bear"  # type: ignore[misc]


# ── TestBoundConstraint ───────────────────────────────────────────────────────

class TestBoundConstraint:
    def test_lower_less_than_upper(self):
        b = BoundConstraint(ticker="A", lower=0.0, upper=1.0)
        assert b.lower < b.upper

    def test_lower_equals_upper_locked(self):
        b = BoundConstraint(ticker="A", lower=0.15, upper=0.15)
        assert b.lower == pytest.approx(b.upper)

    def test_frozen(self):
        b = BoundConstraint(ticker="A")
        with pytest.raises((AttributeError, TypeError)):
            b.lower = 0.5  # type: ignore[misc]


# ── TestSectorCapConstraint ───────────────────────────────────────────────────

class TestSectorCapConstraint:
    def test_basic_creation(self):
        s = SectorCapConstraint(sector_id="tech", tickers=("A", "B"), max_weight=0.35)
        assert s.sector_id == "tech"
        assert s.max_weight == pytest.approx(0.35)

    def test_frozen(self):
        s = SectorCapConstraint(sector_id="tech", tickers=("A",), max_weight=0.35)
        with pytest.raises((AttributeError, TypeError)):
            s.max_weight = 0.5  # type: ignore[misc]


# ── TestGroupConstraint ───────────────────────────────────────────────────────

class TestGroupConstraint:
    def test_basic_creation(self):
        g = GroupConstraint(group_id="core", tickers=("A", "B"), min_weight=0.55)
        assert g.group_id == "core"
        assert g.min_weight == pytest.approx(0.55)

    def test_frozen(self):
        g = GroupConstraint(group_id="core", tickers=("A",))
        with pytest.raises((AttributeError, TypeError)):
            g.min_weight = 0.0  # type: ignore[misc]


# ── TestSoftPenaltyParam ──────────────────────────────────────────────────────

class TestSoftPenaltyParam:
    def test_basic_creation(self):
        sp = SoftPenaltyParam(
            constraint_id="T7", tickers=("A",),
            upper_warn=0.08, penalty_coef_warn=8.0,
        )
        assert sp.constraint_id == "T7"
        assert sp.upper_warn == pytest.approx(0.08)

    def test_frozen(self):
        sp = SoftPenaltyParam(constraint_id="T5", tickers=())
        with pytest.raises((AttributeError, TypeError)):
            sp.constraint_id = "T6"  # type: ignore[misc]


# ── TestConstraintBuilder_Basic ───────────────────────────────────────────────

class TestConstraintBuilder_Basic:
    def test_single_ticker_one_bound(self):
        result = _builder().build(_inp(tickers=("7203",)))
        assert len(result.bounds) == 1

    def test_tickers_count_equals_bounds_count(self):
        inp = _two_tickers_inp()
        result = _builder().build(inp)
        assert len(result.bounds) == len(inp.tickers)

    def test_no_asset_meta_sector_unknown(self):
        result = _builder().build(
            ConstraintInput(tickers=("X",), asset_meta={}, locked_weights={})
        )
        assert any(s.sector_id == "unknown" for s in result.sector_caps)

    def test_is_leveraged_true_in_leverage_group(self):
        result = _builder().build(_two_tickers_inp())
        lev_groups = [g for g in result.group_constraints if g.group_id == "leverage"]
        assert any("B" in g.tickers for g in lev_groups)

    def test_is_core_true_in_core_group(self):
        result = _builder().build(_two_tickers_inp())
        core_groups = [g for g in result.group_constraints if g.group_id == "core"]
        assert any("A" in g.tickers for g in core_groups)

    def test_budget_sum_is_one(self):
        result = _builder().build(_inp())
        assert result.budget_sum == pytest.approx(1.0)

    def test_regime_used_passed_through(self):
        result = _builder().build(_inp(regime="bear"))
        assert result.regime_used == "bear"

    def test_unknown_regime_fallback_to_uncertain(self):
        result = _builder().build(_inp(regime="INVALID"))
        assert result.regime_used == "uncertain"

    def test_unknown_regime_diagnostic(self):
        result = _builder().build(_inp(regime="INVALID"))
        diag_text = " ".join(result.diagnostics)
        assert "uncertain" in diag_text


# ── TestConstraintBuilder_SectorCaps ─────────────────────────────────────────

class TestConstraintBuilder_SectorCaps:
    def test_same_sector_two_tickers_one_cap(self):
        inp = ConstraintInput(
            tickers=("A", "B"), locked_weights={},
            asset_meta={
                "A": {"sector": "tech", "is_core": False, "is_leveraged": False},
                "B": {"sector": "tech", "is_core": False, "is_leveraged": False},
            },
        )
        result = _builder().build(inp)
        tech_caps = [s for s in result.sector_caps if s.sector_id == "tech"]
        assert len(tech_caps) == 1
        assert set(tech_caps[0].tickers) == {"A", "B"}

    def test_sector_cap_default_value(self):
        result = _builder().build(_inp())
        assert all(s.max_weight == pytest.approx(0.35) for s in result.sector_caps)

    def test_two_sectors_two_caps(self):
        inp = ConstraintInput(
            tickers=("A", "B"), locked_weights={},
            asset_meta={
                "A": {"sector": "tech", "is_core": False, "is_leveraged": False},
                "B": {"sector": "finance", "is_core": False, "is_leveraged": False},
            },
        )
        result = _builder().build(inp)
        sector_ids = {s.sector_id for s in result.sector_caps}
        assert "tech" in sector_ids
        assert "finance" in sector_ids

    def test_tickers_correctly_grouped_in_sector(self):
        inp = ConstraintInput(
            tickers=("A", "B", "C"), locked_weights={},
            asset_meta={
                "A": {"sector": "tech"},
                "B": {"sector": "tech"},
                "C": {"sector": "energy"},
            },
        )
        result = _builder().build(inp)
        tech_cap = next(s for s in result.sector_caps if s.sector_id == "tech")
        assert set(tech_cap.tickers) == {"A", "B"}

    def test_unknown_sector_creates_unknown_cap(self):
        inp = ConstraintInput(tickers=("X",), asset_meta={}, locked_weights={})
        result = _builder().build(inp)
        assert any(s.sector_id == "unknown" for s in result.sector_caps)


# ── TestConstraintBuilder_GroupConstraints ────────────────────────────────────

class TestConstraintBuilder_GroupConstraints:
    def test_core_group_present_when_core_tickers_exist(self):
        result = _builder().build(_two_tickers_inp(is_core_a=True, is_core_b=False))
        core_groups = [g for g in result.group_constraints if g.group_id == "core"]
        assert len(core_groups) == 1

    def test_leverage_group_present_when_leveraged_tickers_exist(self):
        result = _builder().build(_two_tickers_inp(is_lev_b=True))
        lev_groups = [g for g in result.group_constraints if g.group_id == "leverage"]
        assert len(lev_groups) == 1

    def test_core_group_min_weight_equals_core_floor(self):
        result = _builder().build(_two_tickers_inp(), )
        core_groups = [g for g in result.group_constraints if g.group_id == "core"]
        assert core_groups[0].min_weight == pytest.approx(0.55)

    def test_leverage_group_max_weight_equals_leverage_cap(self):
        result = _builder().build(_two_tickers_inp())
        lev_groups = [g for g in result.group_constraints if g.group_id == "leverage"]
        assert lev_groups[0].max_weight == pytest.approx(0.20)

    def test_no_core_tickers_no_core_group(self):
        inp = ConstraintInput(
            tickers=("A",), locked_weights={},
            asset_meta={"A": {"sector": "tech", "is_core": False, "is_leveraged": False}},
        )
        result = _builder().build(inp)
        core_groups = [g for g in result.group_constraints if g.group_id == "core"]
        assert len(core_groups) == 0

    def test_no_leveraged_tickers_no_leverage_group(self):
        inp = ConstraintInput(
            tickers=("A",), locked_weights={},
            asset_meta={"A": {"sector": "tech", "is_core": True, "is_leveraged": False}},
        )
        result = _builder().build(inp)
        lev_groups = [g for g in result.group_constraints if g.group_id == "leverage"]
        assert len(lev_groups) == 0


# ── TestConstraintBuilder_SoftPenalties ───────────────────────────────────────

class TestConstraintBuilder_SoftPenalties:
    def test_t7_penalty_one_per_ticker(self):
        result = _builder().build(_two_tickers_inp())
        t7s = [sp for sp in result.soft_penalties if sp.constraint_id == "T7"]
        assert len(t7s) == len(result.tickers)

    def test_t5_present_for_core_tickers(self):
        result = _builder().build(_two_tickers_inp(is_core_a=True))
        t5s = [sp for sp in result.soft_penalties if sp.constraint_id == "T5"]
        assert len(t5s) == 1
        assert "A" in t5s[0].tickers

    def test_t6_present_for_leverage_tickers(self):
        result = _builder().build(_two_tickers_inp(is_lev_b=True))
        t6s = [sp for sp in result.soft_penalties if sp.constraint_id == "T6"]
        assert len(t6s) == 1
        assert "B" in t6s[0].tickers

    def test_t8_present_with_empty_tickers(self):
        result = _builder().build(_inp())
        t8s = [sp for sp in result.soft_penalties if sp.constraint_id == "T8"]
        assert len(t8s) == 1
        assert t8s[0].tickers == ()

    def test_all_constraint_ids_valid(self):
        valid_ids = {"T5", "T6", "T7", "T8"}
        result = _builder().build(_two_tickers_inp())
        for sp in result.soft_penalties:
            assert sp.constraint_id in valid_ids, f"invalid id: {sp.constraint_id}"

    def test_t7_upper_warn_equals_max_single_weight(self):
        result = _builder().build(_inp(max_single_weight=0.10))
        t7s = [sp for sp in result.soft_penalties if sp.constraint_id == "T7"]
        assert all(sp.upper_warn == pytest.approx(0.10) for sp in t7s)

    def test_t5_lower_warn_equals_core_floor(self):
        inp = ConstraintInput(
            tickers=("A",), locked_weights={},
            asset_meta={"A": {"sector": "tech", "is_core": True, "is_leveraged": False}},
            core_floor=0.60,
        )
        result = _builder().build(inp)
        t5s = [sp for sp in result.soft_penalties if sp.constraint_id == "T5"]
        assert t5s[0].lower_warn == pytest.approx(0.60)

    def test_t5_absent_when_no_core_tickers(self):
        inp = ConstraintInput(
            tickers=("A",), locked_weights={},
            asset_meta={"A": {"sector": "tech", "is_core": False, "is_leveraged": False}},
        )
        result = _builder().build(inp)
        t5s = [sp for sp in result.soft_penalties if sp.constraint_id == "T5"]
        assert len(t5s) == 0


# ── TestConstraintBuilder_LockedWeights ──────────────────────────────────────

class TestConstraintBuilder_LockedWeights:
    def test_locked_ticker_bound_lower_equals_upper(self):
        inp = ConstraintInput(
            tickers=("A",), asset_meta={},
            locked_weights={"A": 0.15},
        )
        result = _builder().build(inp)
        b = result.bounds[0]
        assert b.lower == pytest.approx(0.15)
        assert b.upper == pytest.approx(0.15)

    def test_locked_weight_diagnostic_present(self):
        inp = ConstraintInput(
            tickers=("A",), asset_meta={},
            locked_weights={"A": 0.20},
        )
        result = _builder().build(inp)
        diag_text = " ".join(result.diagnostics)
        assert "locked weight" in diag_text

    def test_multiple_locked_tickers_all_pinned(self):
        inp = ConstraintInput(
            tickers=("A", "B"), asset_meta={},
            locked_weights={"A": 0.10, "B": 0.20},
        )
        result = _builder().build(inp)
        for b in result.bounds:
            assert b.lower == pytest.approx(b.upper)

    def test_unlocked_ticker_lower_zero_upper_one(self):
        inp = ConstraintInput(
            tickers=("A", "B"), asset_meta={},
            locked_weights={"A": 0.10},
        )
        result = _builder().build(inp)
        b_b = next(b for b in result.bounds if b.ticker == "B")
        assert b_b.lower == pytest.approx(0.0)
        assert b_b.upper == pytest.approx(1.0)

    def test_locked_weights_sum_exceeds_one_diagnostic(self):
        inp = ConstraintInput(
            tickers=("A", "B"), asset_meta={},
            locked_weights={"A": 0.6, "B": 0.6},
        )
        result = _builder().build(inp)
        diag_text = " ".join(result.diagnostics)
        assert "locked_weights sum exceeds 1.0" in diag_text

    def test_locked_weights_sum_under_one_no_sum_diagnostic(self):
        inp = ConstraintInput(
            tickers=("A", "B"), asset_meta={},
            locked_weights={"A": 0.3, "B": 0.3},
        )
        result = _builder().build(inp)
        diag_text = " ".join(result.diagnostics)
        assert "locked_weights sum exceeds 1.0" not in diag_text

    def test_locked_weight_clamped_to_0_1(self):
        inp = ConstraintInput(
            tickers=("A",), asset_meta={},
            locked_weights={"A": 1.5},  # above 1.0
        )
        result = _builder().build(inp)
        b = result.bounds[0]
        assert b.lower == pytest.approx(1.0)
        assert b.upper == pytest.approx(1.0)


# ── TestConstraintBuilder_AssetMeta ──────────────────────────────────────────

class TestConstraintBuilder_AssetMeta:
    def test_missing_is_core_defaults_to_false(self):
        inp = ConstraintInput(
            tickers=("A",), locked_weights={},
            asset_meta={"A": {"sector": "tech"}},  # no is_core
        )
        result = _builder().build(inp)
        core_groups = [g for g in result.group_constraints if g.group_id == "core"]
        assert len(core_groups) == 0  # no core tickers

    def test_missing_is_leveraged_defaults_to_false(self):
        inp = ConstraintInput(
            tickers=("A",), locked_weights={},
            asset_meta={"A": {"sector": "tech"}},  # no is_leveraged
        )
        result = _builder().build(inp)
        lev_groups = [g for g in result.group_constraints if g.group_id == "leverage"]
        assert len(lev_groups) == 0

    def test_non_dict_asset_meta_uses_defaults(self):
        inp = ConstraintInput(
            tickers=("A",), locked_weights={},
            asset_meta={"A": "not_a_dict"},  # type: ignore[dict-item]
        )
        result = _builder().build(inp)
        # Should not raise; sector defaults to "unknown"
        assert any(s.sector_id == "unknown" for s in result.sector_caps)


# ── TestOptimizerConstraints ──────────────────────────────────────────────────

class TestOptimizerConstraints:
    def test_get_bounds_as_pairs_type(self):
        result = _builder().build(_two_tickers_inp())
        pairs = result.get_bounds_as_pairs()
        assert isinstance(pairs, list)
        assert all(isinstance(p, tuple) and len(p) == 2 for p in pairs)

    def test_get_bounds_as_pairs_length_equals_tickers(self):
        result = _builder().build(_two_tickers_inp())
        assert len(result.get_bounds_as_pairs()) == len(result.tickers)

    def test_to_dict_required_keys(self):
        result = _builder().build(_inp())
        d = result.to_dict()
        assert set(d.keys()) == {
            "tickers", "bounds", "sector_caps", "group_constraints",
            "soft_penalties", "risk_aversion", "budget_sum", "regime_used", "diagnostics",
        }

    def test_regime_used_in_to_dict(self):
        result = _builder().build(_inp(regime="bear"))
        d = result.to_dict()
        assert d["regime_used"] == "bear"

    def test_frozen(self):
        result = _builder().build(_inp())
        with pytest.raises((AttributeError, TypeError)):
            result.budget_sum = 0.9  # type: ignore[misc]

    def test_all_diagnostics_start_with_observation(self):
        # Use unknown regime to generate diagnostics
        result = _builder().build(_inp(regime="UNKNOWN"))
        for d in result.diagnostics:
            assert d.startswith("observation:"), f"bad diag: {d!r}"

    def test_to_dict_serializable_json(self):
        import json
        result = _builder().build(_two_tickers_inp())
        serialized = json.dumps(result.to_dict())
        assert "T7" in serialized
        assert "budget_sum" in serialized
