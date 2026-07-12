"""
test_execution_specialist.py — Card 6-4
ExecutionSpecialist の単体テスト。
"""
import json

import pytest

from backend.engine.agents.base_agent import AgentInput, AgentOpinion
from backend.engine.agents.execution_specialist import ExecutionSpecialist


@pytest.fixture
def agent():
    return ExecutionSpecialist()


def _make_input(factor_scores=None, regime="bull_calm", horizon="short_term"):
    return AgentInput(
        ticker="7203",
        factor_scores=factor_scores or {},
        regime=regime,
        horizon=horizon,
    )


class TestExecutionSpecialistSpec:
    def test_role_id(self, agent):
        assert agent.role_id == "execution_specialist"

    def test_role_name(self, agent):
        assert agent.role_name == "Execution Specialist"

    def test_focus_area(self, agent):
        assert agent.focus_area == ("technical_momentum",)

    def test_returns_agent_opinion(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 70.0}))
        assert isinstance(op, AgentOpinion)

    def test_confidence_in_range(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 70.0}))
        assert 0.0 <= op.confidence <= 1.0

    def test_confidence_reflects_scores(self, agent):
        high_op = agent.analyze(_make_input({"technical_momentum": 95.0}))
        low_op  = agent.analyze(_make_input({"technical_momentum": 10.0}))
        assert high_op.confidence > low_op.confidence

    def test_confidence_calculation(self, agent):
        """score=70 → confidence ≈ 0.70"""
        op = agent.analyze(_make_input({"technical_momentum": 70.0}))
        assert op.confidence == pytest.approx(0.70, abs=1e-6)

    def test_supportive_points_nonempty_tuple(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 80.0}))
        assert isinstance(op.supportive_points, tuple)
        assert len(op.supportive_points) >= 1

    def test_concerns_populated_for_low_scores(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 20.0}))
        assert isinstance(op.concerns, tuple)
        assert len(op.concerns) >= 1

    def test_crisis_regime_adds_concern(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 70.0}, regime="crisis"))
        regime_concerns = [c for c in op.concerns if "crisis" in c.lower()]
        assert len(regime_concerns) >= 1

    def test_bear_regime_adds_concern(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 70.0}, regime="bear"))
        regime_concerns = [c for c in op.concerns if "bear" in c.lower()]
        assert len(regime_concerns) >= 1

    def test_invalid_factor_scores_no_crash(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": None}))
        assert isinstance(op, AgentOpinion)
        assert 0.0 <= op.confidence <= 1.0

    def test_missing_factors_no_crash(self, agent):
        op = agent.analyze(_make_input({}))
        assert isinstance(op, AgentOpinion)

    def test_factor_scores_used_is_tuple(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 70.0}))
        assert isinstance(op.factor_scores_used, tuple)

    def test_to_dict_json_serializable(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 70.0}))
        json.dumps(op.to_dict())

    def test_no_forbidden_fields(self, agent):
        op = agent.analyze(_make_input({"technical_momentum": 70.0}))
        forbidden = {
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "rating", "verdict", "decision",
        }
        for f in forbidden:
            assert not hasattr(op, f)

    def test_regime_observed_stored(self, agent):
        op = agent.analyze(_make_input({}, regime="uncertain"))
        assert op.regime_observed == "uncertain"
