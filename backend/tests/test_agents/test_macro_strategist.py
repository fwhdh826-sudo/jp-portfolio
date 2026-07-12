"""
test_macro_strategist.py — Card 6-4
MacroStrategist の単体テスト。
"""
import json

import pytest

from backend.engine.agents.base_agent import AgentInput, AgentOpinion
from backend.engine.agents.macro_strategist import MacroStrategist


@pytest.fixture
def agent():
    return MacroStrategist()


def _make_input(factor_scores=None, regime="bull_calm", horizon="short_term"):
    return AgentInput(
        ticker="7203",
        factor_scores=factor_scores or {},
        regime=regime,
        horizon=horizon,
    )


class TestMacroStrategistSpec:
    def test_role_id(self, agent):
        assert agent.role_id == "macro_strategist"

    def test_role_name(self, agent):
        assert agent.role_name == "Macro Strategist"

    def test_focus_area(self, agent):
        assert agent.focus_area == ("technical_momentum", "safety")

    def test_returns_agent_opinion(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 70.0, "safety": 65.0}))
        assert isinstance(op, AgentOpinion)

    def test_confidence_in_range(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 70.0, "safety": 65.0}))
        assert 0.0 <= op.confidence <= 1.0

    def test_confidence_reflects_scores(self, agent):
        high_op = agent.analyze(_make_input({"technical_momentum": 90.0, "safety": 90.0}))
        low_op  = agent.analyze(_make_input({"technical_momentum": 20.0, "safety": 20.0}))
        assert high_op.confidence > low_op.confidence

    def test_supportive_points_nonempty_tuple(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 75.0, "safety": 75.0}))
        assert isinstance(op.supportive_points, tuple)
        assert len(op.supportive_points) >= 1

    def test_crisis_regime_adds_concern(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 70.0, "safety": 70.0}, regime="crisis"))
        regime_concerns = [c for c in op.concerns if "crisis" in c.lower()]
        assert len(regime_concerns) >= 1

    def test_bear_regime_adds_concern(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 70.0, "safety": 70.0}, regime="bear"))
        regime_concerns = [c for c in op.concerns if "bear" in c.lower()]
        assert len(regime_concerns) >= 1

    def test_bull_calm_adds_supportive(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 50.0, "safety": 50.0}, regime="bull_calm"))
        regime_support = [s for s in op.supportive_points if "bull_calm" in s.lower() or "bull" in s.lower()]
        assert len(regime_support) >= 1

    def test_bull_volatile_adds_concern(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 70.0, "safety": 70.0}, regime="bull_volatile"))
        regime_concerns = [c for c in op.concerns if "volatile" in c.lower() or "bull_volatile" in c.lower()]
        assert len(regime_concerns) >= 1

    def test_invalid_factor_scores_no_crash(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": None, "safety": float("nan")}))
        assert isinstance(op, AgentOpinion)
        assert 0.0 <= op.confidence <= 1.0

    def test_missing_factors_no_crash(self, agent):
        op = agent.analyze(_make_input({}))
        assert isinstance(op, AgentOpinion)

    def test_factor_scores_used_is_tuple(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 70.0, "safety": 65.0}))
        assert isinstance(op.factor_scores_used, tuple)

    def test_to_dict_json_serializable(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 70.0, "safety": 65.0}))
        json.dumps(op.to_dict())

    def test_no_forbidden_fields(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 70.0, "safety": 65.0}))
        forbidden = {
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "rating", "verdict", "decision",
        }
        for f in forbidden:
            assert not hasattr(op, f)

    def test_regime_observed_stored(self, agent):
        op = agent.analyze(_make_input({}, regime="crisis"))
        assert op.regime_observed == "crisis"
