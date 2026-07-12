"""
test_risk_manager.py — Card 6-4
RiskManager の単体テスト。

confidence 反転仕様（1.0 - mean/100.0）を重点的にテスト。
"""
import json

import pytest

from backend.engine.agents.base_agent import AgentInput, AgentOpinion
from backend.engine.agents.risk_manager import RiskManager


@pytest.fixture
def agent():
    return RiskManager()


def _make_input(factor_scores=None, regime="bull_calm", horizon="long_term"):
    return AgentInput(
        ticker="1234",
        factor_scores=factor_scores or {},
        regime=regime,
        horizon=horizon,
    )


class TestRiskManagerSpec:
    def test_role_id(self, agent):
        assert agent.role_id == "risk_manager"

    def test_role_name(self, agent):
        assert agent.role_name == "Risk Manager"

    def test_focus_area(self, agent):
        assert agent.focus_area == ("safety", "quality_value")

    def test_returns_agent_opinion(self, agent):
        op = agent.analyze(_make_input({"safety": 60.0, "quality_value": 55.0}))
        assert isinstance(op, AgentOpinion)

    def test_confidence_in_range(self, agent):
        op = agent.analyze(_make_input({"safety": 60.0, "quality_value": 55.0}))
        assert 0.0 <= op.confidence <= 1.0

    def test_confidence_inverted_low_scores_give_high_confidence(self, agent):
        """低スコア（高リスク）ほど RiskManager の confidence が高い（反転）"""
        high_risk_op = agent.analyze(_make_input({"safety": 10.0, "quality_value": 10.0}))
        low_risk_op  = agent.analyze(_make_input({"safety": 90.0, "quality_value": 90.0}))
        assert high_risk_op.confidence > low_risk_op.confidence

    def test_confidence_inverted_calculation(self, agent):
        """mean=50.0 → confidence ≈ 0.5（反転なので 1.0 - 0.5 = 0.5）"""
        op = agent.analyze(_make_input({"safety": 50.0, "quality_value": 50.0}))
        assert op.confidence == pytest.approx(0.5, abs=1e-6)

    def test_confidence_very_high_scores_give_low_confidence(self, agent):
        """mean=100 → confidence ≈ 0.0"""
        op = agent.analyze(_make_input({"safety": 100.0, "quality_value": 100.0}))
        assert op.confidence == pytest.approx(0.0, abs=1e-6)

    def test_supportive_points_nonempty_tuple(self, agent):
        op = agent.analyze(_make_input({"safety": 80.0, "quality_value": 80.0}))
        assert isinstance(op.supportive_points, tuple)
        assert len(op.supportive_points) >= 1

    def test_concerns_populated_for_low_scores(self, agent):
        op = agent.analyze(_make_input({"safety": 20.0, "quality_value": 20.0}))
        assert isinstance(op.concerns, tuple)
        assert len(op.concerns) >= 1

    def test_crisis_regime_adds_concern(self, agent):
        op = agent.analyze(_make_input({"safety": 60.0, "quality_value": 60.0}, regime="crisis"))
        regime_concerns = [c for c in op.concerns if "crisis" in c.lower()]
        assert len(regime_concerns) >= 1

    def test_bear_regime_adds_concern(self, agent):
        op = agent.analyze(_make_input({"safety": 60.0, "quality_value": 60.0}, regime="bear"))
        regime_concerns = [c for c in op.concerns if "bear" in c.lower()]
        assert len(regime_concerns) >= 1

    def test_invalid_factor_scores_no_crash(self, agent):
        op = agent.analyze(_make_input({"safety": "bad", "quality_value": None}))
        assert isinstance(op, AgentOpinion)
        assert 0.0 <= op.confidence <= 1.0

    def test_missing_factors_no_crash(self, agent):
        op = agent.analyze(_make_input({}))
        assert isinstance(op, AgentOpinion)

    def test_factor_scores_used_is_tuple(self, agent):
        op = agent.analyze(_make_input({"safety": 60.0, "quality_value": 55.0}))
        assert isinstance(op.factor_scores_used, tuple)

    def test_to_dict_json_serializable(self, agent):
        op = agent.analyze(_make_input({"safety": 60.0, "quality_value": 55.0}))
        json.dumps(op.to_dict())

    def test_no_forbidden_fields(self, agent):
        op = agent.analyze(_make_input({"safety": 60.0, "quality_value": 55.0}))
        forbidden = {
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "rating", "verdict", "decision",
        }
        for f in forbidden:
            assert not hasattr(op, f)

    def test_regime_observed_stored(self, agent):
        op = agent.analyze(_make_input({}, regime="bear"))
        assert op.regime_observed == "bear"
