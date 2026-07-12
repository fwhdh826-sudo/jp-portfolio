"""
test_growth_advocate.py — Card 6-4
GrowthAdvocate の単体テスト。
"""
import json

import pytest

from backend.engine.agents.base_agent import AgentInput, AgentOpinion
from backend.engine.agents.growth_advocate import GrowthAdvocate


@pytest.fixture
def agent():
    return GrowthAdvocate()


def _make_input(factor_scores=None, regime="bull_calm", horizon="long_term"):
    return AgentInput(
        ticker="9984",
        factor_scores=factor_scores or {},
        regime=regime,
        horizon=horizon,
    )


class TestGrowthAdvocateSpec:
    def test_role_id(self, agent):
        assert agent.role_id == "growth_advocate"

    def test_role_name(self, agent):
        assert agent.role_name == "Growth Advocate"

    def test_focus_area(self, agent):
        assert agent.focus_area == ("growth", "quality_value")

    def test_returns_agent_opinion(self, agent):
        op = agent.analyze(_make_input({"growth": 70.0, "quality_value": 60.0}))
        assert isinstance(op, AgentOpinion)

    def test_confidence_in_range(self, agent):
        op = agent.analyze(_make_input({"growth": 70.0, "quality_value": 60.0}))
        assert 0.0 <= op.confidence <= 1.0

    def test_confidence_reflects_scores(self, agent):
        high_op = agent.analyze(_make_input({"growth": 90.0, "quality_value": 90.0}))
        low_op  = agent.analyze(_make_input({"growth": 20.0, "quality_value": 20.0}))
        assert high_op.confidence > low_op.confidence

    def test_supportive_points_nonempty_tuple(self, agent):
        op = agent.analyze(_make_input({"growth": 75.0, "quality_value": 70.0}))
        assert isinstance(op.supportive_points, tuple)
        assert len(op.supportive_points) >= 1

    def test_concerns_is_tuple(self, agent):
        op = agent.analyze(_make_input({"growth": 30.0, "quality_value": 30.0}))
        assert isinstance(op.concerns, tuple)
        assert len(op.concerns) >= 1

    def test_crisis_regime_adds_concern(self, agent):
        op = agent.analyze(_make_input({"growth": 80.0, "quality_value": 80.0}, regime="crisis"))
        regime_concerns = [c for c in op.concerns if "crisis" in c.lower() or "regime" in c.lower()]
        assert len(regime_concerns) >= 1

    def test_bear_regime_adds_concern(self, agent):
        op = agent.analyze(_make_input({"growth": 80.0, "quality_value": 80.0}, regime="bear"))
        regime_concerns = [c for c in op.concerns if "bear" in c.lower() or "regime" in c.lower()]
        assert len(regime_concerns) >= 1

    def test_invalid_factor_scores_no_crash(self, agent):
        op = agent.analyze(_make_input({"growth": None, "quality_value": "bad"}))
        assert isinstance(op, AgentOpinion)
        assert 0.0 <= op.confidence <= 1.0

    def test_missing_factors_no_crash(self, agent):
        op = agent.analyze(_make_input({}))
        assert isinstance(op, AgentOpinion)

    def test_factor_scores_used_is_tuple(self, agent):
        op = agent.analyze(_make_input({"growth": 70.0, "quality_value": 60.0}))
        assert isinstance(op.factor_scores_used, tuple)

    def test_to_dict_json_serializable(self, agent):
        op = agent.analyze(_make_input({"growth": 70.0, "quality_value": 60.0}))
        json.dumps(op.to_dict())

    def test_no_forbidden_fields(self, agent):
        op = agent.analyze(_make_input({"growth": 70.0, "quality_value": 60.0}))
        forbidden = {
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "rating", "verdict", "decision",
        }
        for f in forbidden:
            assert not hasattr(op, f), f"Forbidden field '{f}' found"

    def test_regime_observed_stored(self, agent):
        op = agent.analyze(_make_input({}, regime="bear"))
        assert op.regime_observed == "bear"
