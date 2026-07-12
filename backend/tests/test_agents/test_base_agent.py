"""
test_base_agent.py — Card 6-4
AgentInput / AgentOpinion / BaseAgent の単体テスト。

テスト対象:
  - AgentInput frozen / dataclass
  - AgentInput.context が default_factory で独立 dict
  - AgentOpinion frozen / to_dict()
  - AgentOpinion に判断フィールドがないこと
  - AgentOpinion.factor_scores_used が tuple
  - BaseAgent._get_focus_scores() fallback 仕様
  - BaseAgent._clamp_confidence()
  - BaseAgent._safe_score()
"""
import json
import math

import pytest

from backend.engine.agents.base_agent import AgentInput, AgentOpinion, BaseAgent


# ── テスト用 concrete stub ─────────────────────────────────────────────────────

class _StubAgent(BaseAgent):
    role_id    = "stub"
    role_name  = "Stub Agent"
    focus_area = ("value", "growth")

    def analyze(self, agent_input: AgentInput) -> AgentOpinion:
        scores = self._get_focus_scores(agent_input.factor_scores)
        return AgentOpinion(
            role_id=self.role_id,
            role_name=self.role_name,
            focus_area=self.focus_area,
            confidence=self._clamp_confidence(self._mean_score(scores) / 100.0),
            supportive_points=("stub supportive",),
            concerns=("stub concern",),
            factor_scores_used=self._scores_to_tuple(scores),
            regime_observed=agent_input.regime,
        )


# ── AgentInput ────────────────────────────────────────────────────────────────

class TestAgentInput:
    def test_frozen(self):
        inp = AgentInput(ticker="7203", factor_scores={"value": 60.0}, regime="bull_calm", horizon="short_term")
        with pytest.raises((AttributeError, TypeError)):
            inp.ticker = "9984"  # type: ignore[misc]

    def test_context_default_factory_independence(self):
        a = AgentInput(ticker="A", factor_scores={}, regime="bear", horizon="long_term")
        b = AgentInput(ticker="B", factor_scores={}, regime="bear", horizon="long_term")
        assert a.context is not b.context, "context should be independent dict instances"

    def test_context_default_empty(self):
        inp = AgentInput(ticker="X", factor_scores={}, regime="uncertain", horizon="short_term")
        assert inp.context == {}

    def test_context_accepts_dict(self):
        inp = AgentInput(
            ticker="X", factor_scores={}, regime="bull_calm", horizon="long_term",
            context={"extra": "value"}
        )
        assert inp.context["extra"] == "value"

    def test_fields_accessible(self):
        inp = AgentInput(
            ticker="7203",
            factor_scores={"value": 70.0},
            regime="bull_calm",
            horizon="short_term",
        )
        assert inp.ticker == "7203"
        assert inp.factor_scores["value"] == 70.0
        assert inp.regime == "bull_calm"
        assert inp.horizon == "short_term"


# ── AgentOpinion ──────────────────────────────────────────────────────────────

class TestAgentOpinion:
    def _make(self, **kwargs):
        defaults = dict(
            role_id="test",
            role_name="Test",
            focus_area=("value",),
            confidence=0.7,
            supportive_points=("ok",),
            concerns=("risk",),
            factor_scores_used=(("value", 70.0),),
            regime_observed="bull_calm",
        )
        defaults.update(kwargs)
        return AgentOpinion(**defaults)

    def test_frozen(self):
        op = self._make()
        with pytest.raises((AttributeError, TypeError)):
            op.confidence = 0.5  # type: ignore[misc]

    def test_factor_scores_used_is_tuple(self):
        op = self._make(factor_scores_used=(("value", 65.0), ("growth", 55.0)))
        assert isinstance(op.factor_scores_used, tuple)
        for item in op.factor_scores_used:
            assert isinstance(item, tuple)
            assert len(item) == 2

    def test_to_dict_json_serializable(self):
        op = self._make(factor_scores_used=(("value", 65.0),))
        d = op.to_dict()
        json.dumps(d)  # JSON serializable ならここで例外が出ない

    def test_to_dict_structure(self):
        op = self._make(
            factor_scores_used=(("value", 65.0), ("growth", 50.0)),
        )
        d = op.to_dict()
        assert d["role_id"] == "test"
        assert isinstance(d["focus_area"], list)
        assert isinstance(d["supportive_points"], list)
        assert isinstance(d["concerns"], list)
        assert isinstance(d["factor_scores_used"], dict)
        assert d["factor_scores_used"]["value"] == 65.0

    def test_to_dict_no_forbidden_fields(self):
        op = self._make()
        d = op.to_dict()
        forbidden = {
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "rating", "verdict", "decision",
        }
        for f in forbidden:
            assert f not in d, f"Forbidden field '{f}' found in to_dict()"

    def test_opinion_has_no_forbidden_attributes(self):
        op = self._make()
        forbidden = [
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "rating", "verdict", "decision",
        ]
        for attr in forbidden:
            assert not hasattr(op, attr), f"AgentOpinion must not have attribute '{attr}'"

    def test_supportive_points_is_tuple(self):
        op = self._make(supportive_points=("a", "b"))
        assert isinstance(op.supportive_points, tuple)

    def test_concerns_is_tuple(self):
        op = self._make(concerns=("x",))
        assert isinstance(op.concerns, tuple)


# ── BaseAgent helpers ─────────────────────────────────────────────────────────

class TestBaseAgentHelpers:
    def setup_method(self):
        self.agent = _StubAgent()

    def test_get_focus_scores_normal(self):
        scores = self.agent._get_focus_scores({"value": 70.0, "growth": 60.0})
        assert scores["value"] == pytest.approx(70.0)
        assert scores["growth"] == pytest.approx(60.0)

    def test_get_focus_scores_missing_factor_fallback(self):
        scores = self.agent._get_focus_scores({})
        assert scores["value"] == pytest.approx(50.0)
        assert scores["growth"] == pytest.approx(50.0)

    def test_get_focus_scores_none_fallback(self):
        scores = self.agent._get_focus_scores({"value": None, "growth": 60.0})
        assert scores["value"] == pytest.approx(50.0)

    def test_get_focus_scores_str_fallback(self):
        scores = self.agent._get_focus_scores({"value": "abc", "growth": 60.0})
        assert scores["value"] == pytest.approx(50.0)

    def test_get_focus_scores_nan_fallback(self):
        scores = self.agent._get_focus_scores({"value": float("nan"), "growth": 60.0})
        assert scores["value"] == pytest.approx(50.0)

    def test_get_focus_scores_inf_fallback(self):
        scores = self.agent._get_focus_scores({"value": float("inf"), "growth": 60.0})
        assert scores["value"] == pytest.approx(50.0)

    def test_get_focus_scores_clamp_above_100(self):
        scores = self.agent._get_focus_scores({"value": 150.0, "growth": 60.0})
        assert scores["value"] == pytest.approx(100.0)

    def test_get_focus_scores_clamp_below_0(self):
        scores = self.agent._get_focus_scores({"value": -10.0, "growth": 60.0})
        assert scores["value"] == pytest.approx(0.0)

    def test_clamp_confidence_normal(self):
        assert self.agent._clamp_confidence(0.7) == pytest.approx(0.7)

    def test_clamp_confidence_above_1(self):
        assert self.agent._clamp_confidence(1.5) == pytest.approx(1.0)

    def test_clamp_confidence_below_0(self):
        assert self.agent._clamp_confidence(-0.3) == pytest.approx(0.0)

    def test_clamp_confidence_boundary(self):
        assert self.agent._clamp_confidence(0.0) == pytest.approx(0.0)
        assert self.agent._clamp_confidence(1.0) == pytest.approx(1.0)

    def test_is_risk_regime_crisis(self):
        assert BaseAgent._is_risk_regime("crisis") is True

    def test_is_risk_regime_bear(self):
        assert BaseAgent._is_risk_regime("bear") is True

    def test_is_risk_regime_bull_calm(self):
        assert BaseAgent._is_risk_regime("bull_calm") is False

    def test_is_risk_regime_bull_volatile(self):
        assert BaseAgent._is_risk_regime("bull_volatile") is False

    def test_scores_to_tuple(self):
        result = self.agent._scores_to_tuple({"value": 70.0, "growth": 60.0})
        assert isinstance(result, tuple)
        for item in result:
            assert isinstance(item, tuple)
            assert len(item) == 2

    def test_stub_analyze_returns_opinion(self):
        inp = AgentInput(
            ticker="TEST",
            factor_scores={"value": 70.0, "growth": 60.0},
            regime="bull_calm",
            horizon="short_term",
        )
        opinion = self.agent.analyze(inp)
        assert isinstance(opinion, AgentOpinion)
        assert 0.0 <= opinion.confidence <= 1.0
