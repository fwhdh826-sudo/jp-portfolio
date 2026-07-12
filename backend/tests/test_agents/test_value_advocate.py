"""
test_value_advocate.py — Card 6-4
ValueAdvocate の単体テスト。
"""
import json

import pytest

from backend.engine.agents.base_agent import AgentInput, AgentOpinion
from backend.engine.agents.value_advocate import ValueAdvocate


@pytest.fixture
def agent():
    return ValueAdvocate()


def _make_input(factor_scores=None, regime="bull_calm", horizon="long_term"):
    return AgentInput(
        ticker="7203",
        factor_scores=factor_scores or {},
        regime=regime,
        horizon=horizon,
    )


class TestValueAdvocateSpec:
    def test_role_id(self, agent):
        assert agent.role_id == "value_advocate"

    def test_role_name(self, agent):
        assert agent.role_name == "Value Advocate"

    def test_focus_area(self, agent):
        assert agent.focus_area == ("value", "shareholder_return")

    def test_returns_agent_opinion(self, agent):
        op = agent.analyze(_make_input({"value": 70.0, "shareholder_return": 60.0}))
        assert isinstance(op, AgentOpinion)

    def test_confidence_in_range(self, agent):
        op = agent.analyze(_make_input({"value": 70.0, "shareholder_return": 60.0}))
        assert 0.0 <= op.confidence <= 1.0

    def test_confidence_reflects_scores(self, agent):
        high_op = agent.analyze(_make_input({"value": 90.0, "shareholder_return": 90.0}))
        low_op  = agent.analyze(_make_input({"value": 20.0, "shareholder_return": 20.0}))
        assert high_op.confidence > low_op.confidence

    def test_supportive_points_nonempty_tuple(self, agent):
        op = agent.analyze(_make_input({"value": 75.0, "shareholder_return": 70.0}))
        assert isinstance(op.supportive_points, tuple)
        assert len(op.supportive_points) >= 1

    def test_concerns_is_tuple(self, agent):
        op = agent.analyze(_make_input({"value": 30.0, "shareholder_return": 30.0}))
        assert isinstance(op.concerns, tuple)
        assert len(op.concerns) >= 1

    def test_crisis_regime_adds_concern(self, agent):
        op = agent.analyze(_make_input({"value": 70.0, "shareholder_return": 70.0}, regime="crisis"))
        regime_concerns = [c for c in op.concerns if "crisis" in c.lower() or "regime" in c.lower()]
        assert len(regime_concerns) >= 1

    def test_bear_regime_adds_concern(self, agent):
        op = agent.analyze(_make_input({"value": 70.0, "shareholder_return": 70.0}, regime="bear"))
        regime_concerns = [c for c in op.concerns if "bear" in c.lower() or "regime" in c.lower()]
        assert len(regime_concerns) >= 1

    def test_bull_calm_no_regime_concern(self, agent):
        op = agent.analyze(_make_input({"value": 70.0, "shareholder_return": 70.0}, regime="bull_calm"))
        regime_concerns = [c for c in op.concerns if "regime=crisis" in c or "regime=bear" in c]
        assert len(regime_concerns) == 0

    def test_invalid_factor_scores_no_crash(self, agent):
        op = agent.analyze(_make_input({"value": None, "shareholder_return": "bad"}))
        assert isinstance(op, AgentOpinion)
        assert 0.0 <= op.confidence <= 1.0

    def test_missing_factors_no_crash(self, agent):
        op = agent.analyze(_make_input({}))
        assert isinstance(op, AgentOpinion)

    def test_factor_scores_used_is_tuple(self, agent):
        op = agent.analyze(_make_input({"value": 70.0, "shareholder_return": 60.0}))
        assert isinstance(op.factor_scores_used, tuple)

    def test_to_dict_json_serializable(self, agent):
        op = agent.analyze(_make_input({"value": 70.0, "shareholder_return": 60.0}))
        json.dumps(op.to_dict())

    def test_no_forbidden_fields(self, agent):
        op = agent.analyze(_make_input({"value": 70.0, "shareholder_return": 60.0}))
        forbidden = {
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "rating", "verdict", "decision",
        }
        for f in forbidden:
            assert not hasattr(op, f), f"Forbidden field '{f}' found"

    def test_regime_observed_stored(self, agent):
        op = agent.analyze(_make_input({}, regime="uncertain"))
        assert op.regime_observed == "uncertain"
