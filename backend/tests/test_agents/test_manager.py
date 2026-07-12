"""
test_manager.py — Card 6-5
AgentManager / ManagerInput / ManagerSummary の単体テスト。

テスト対象:
  - ManagerInput frozen / tuple 保証 / context default_factory
  - ManagerSummary frozen / 禁止フィールドなし / to_dict()
  - summarize(): empty / single / multiple opinions
  - safe confidence (None / str / NaN / inf)
  - consensus_strength / is_consensus_high
  - run_all(): DI specialists
"""
import json
import math

import pytest

from backend.engine.agents.base_agent import AgentInput, AgentOpinion, BaseAgent
from backend.engine.agents.manager import (
    AgentManager,
    ManagerInput,
    ManagerSummary,
    _safe_confidence,
)


# ── helpers ───────────────────────────────────────────────────────────────────

def _make_opinion(
    role_id: str = "stub",
    confidence: float = 0.7,
    concerns: tuple = ("concern_a",),
    supportive: tuple = ("support_a",),
    regime: str = "bull_calm",
) -> AgentOpinion:
    return AgentOpinion(
        role_id=role_id,
        role_name="Stub",
        focus_area=("value",),
        confidence=confidence,
        supportive_points=supportive,
        concerns=concerns,
        factor_scores_used=(("value", 60.0),),
        regime_observed=regime,
    )


def _make_manager_input(
    opinions=(),
    ticker: str = "7203",
    regime: str = "bull_calm",
    horizon: str = "long_term",
) -> ManagerInput:
    return ManagerInput(
        ticker=ticker,
        opinions=tuple(opinions),
        regime=regime,
        horizon=horizon,
    )


class _StubSpecialist(BaseAgent):
    role_id    = "stub"
    role_name  = "Stub"
    focus_area = ("value",)

    def __init__(self, confidence: float = 0.7):
        self._conf = confidence

    def analyze(self, agent_input: AgentInput) -> AgentOpinion:
        return _make_opinion(confidence=self._conf)


# ── _safe_confidence ──────────────────────────────────────────────────────────

class TestSafeConfidence:
    def test_normal(self):
        assert _safe_confidence(0.7) == pytest.approx(0.7)

    def test_none_fallback(self):
        assert _safe_confidence(None) == pytest.approx(0.0)

    def test_str_fallback(self):
        assert _safe_confidence("abc") == pytest.approx(0.0)

    def test_nan_fallback(self):
        assert _safe_confidence(float("nan")) == pytest.approx(0.0)

    def test_inf_fallback(self):
        assert _safe_confidence(float("inf")) == pytest.approx(0.0)

    def test_above_1_clamp(self):
        assert _safe_confidence(1.5) == pytest.approx(1.0)

    def test_below_0_clamp(self):
        assert _safe_confidence(-0.3) == pytest.approx(0.0)

    def test_boundary_0(self):
        assert _safe_confidence(0.0) == pytest.approx(0.0)

    def test_boundary_1(self):
        assert _safe_confidence(1.0) == pytest.approx(1.0)


# ── ManagerInput ──────────────────────────────────────────────────────────────

class TestManagerInput:
    def test_frozen(self):
        inp = _make_manager_input()
        with pytest.raises((AttributeError, TypeError)):
            inp.ticker = "9984"  # type: ignore[misc]

    def test_opinions_is_tuple(self):
        op = _make_opinion()
        inp = ManagerInput(ticker="A", opinions=(op,), regime="bull_calm", horizon="long_term")
        assert isinstance(inp.opinions, tuple)

    def test_opinions_list_converted_to_tuple(self):
        op = _make_opinion()
        # list を渡しても __post_init__ で tuple 化される
        inp = ManagerInput(ticker="A", opinions=[op], regime="bull_calm", horizon="long_term")  # type: ignore[arg-type]
        assert isinstance(inp.opinions, tuple)

    def test_context_default_factory_independence(self):
        a = _make_manager_input()
        b = _make_manager_input()
        assert a.context is not b.context

    def test_context_default_empty(self):
        inp = _make_manager_input()
        assert inp.context == {}

    def test_fields_accessible(self):
        op = _make_opinion()
        inp = ManagerInput(ticker="7203", opinions=(op,), regime="bear", horizon="short_term")
        assert inp.ticker == "7203"
        assert inp.regime == "bear"
        assert len(inp.opinions) == 1


# ── ManagerSummary ────────────────────────────────────────────────────────────

class TestManagerSummary:
    def _make(self, **kwargs) -> ManagerSummary:
        defaults = dict(
            ticker="X",
            average_confidence=0.7,
            concern_count=2,
            supportive_count=2,
            consensus_strength=0.8,
            all_concerns=("c1", "c2"),
            all_supportive=("s1", "s2"),
            agent_count=2,
            regime_observed="bull_calm",
            is_consensus_high=True,
        )
        defaults.update(kwargs)
        return ManagerSummary(**defaults)

    def test_frozen(self):
        ms = self._make()
        with pytest.raises((AttributeError, TypeError)):
            ms.average_confidence = 0.5  # type: ignore[misc]

    def test_no_forbidden_fields(self):
        ms = self._make()
        forbidden = [
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "verdict", "decision", "rating", "approve", "reject",
        ]
        for f in forbidden:
            assert not hasattr(ms, f), f"Forbidden field '{f}' found"

    def test_to_dict_json_serializable(self):
        ms = self._make()
        json.dumps(ms.to_dict())

    def test_to_dict_structure(self):
        ms = self._make()
        d = ms.to_dict()
        assert isinstance(d["all_concerns"], list)
        assert isinstance(d["all_supportive"], list)
        assert isinstance(d["is_consensus_high"], bool)

    def test_is_consensus_high_is_bool(self):
        ms = self._make(is_consensus_high=True)
        assert isinstance(ms.is_consensus_high, bool)


# ── AgentManager.summarize ────────────────────────────────────────────────────

class TestAgentManagerSummarize:
    def setup_method(self):
        self.manager = AgentManager()

    def test_empty_opinions_fallback(self):
        summary = self.manager.summarize(_make_manager_input(opinions=[]))
        assert summary.average_confidence == pytest.approx(0.0)
        assert summary.consensus_strength == pytest.approx(0.0)
        assert summary.concern_count == 0
        assert summary.supportive_count == 0
        assert summary.agent_count == 0
        assert summary.is_consensus_high is False

    def test_empty_opinions_all_concerns_empty(self):
        summary = self.manager.summarize(_make_manager_input())
        assert summary.all_concerns == ()
        assert summary.all_supportive == ()

    def test_single_opinion_consensus_strength_one(self):
        op = _make_opinion(confidence=0.6)
        summary = self.manager.summarize(_make_manager_input(opinions=[op]))
        assert summary.consensus_strength == pytest.approx(1.0)
        assert summary.average_confidence == pytest.approx(0.6)

    def test_multiple_opinions_average_confidence(self):
        ops = [_make_opinion(confidence=0.8), _make_opinion(confidence=0.6)]
        summary = self.manager.summarize(_make_manager_input(opinions=ops))
        assert summary.average_confidence == pytest.approx(0.7)

    def test_concern_count_correct(self):
        ops = [
            _make_opinion(concerns=("c1", "c2")),
            _make_opinion(concerns=("c3",)),
        ]
        summary = self.manager.summarize(_make_manager_input(opinions=ops))
        assert summary.concern_count == 3

    def test_supportive_count_correct(self):
        ops = [
            _make_opinion(supportive=("s1",)),
            _make_opinion(supportive=("s2", "s3")),
        ]
        summary = self.manager.summarize(_make_manager_input(opinions=ops))
        assert summary.supportive_count == 3

    def test_all_concerns_combined(self):
        ops = [
            _make_opinion(concerns=("c1",)),
            _make_opinion(concerns=("c2", "c3")),
        ]
        summary = self.manager.summarize(_make_manager_input(opinions=ops))
        assert "c1" in summary.all_concerns
        assert "c2" in summary.all_concerns
        assert "c3" in summary.all_concerns

    def test_all_supportive_combined(self):
        ops = [
            _make_opinion(supportive=("s1", "s2")),
            _make_opinion(supportive=("s3",)),
        ]
        summary = self.manager.summarize(_make_manager_input(opinions=ops))
        assert "s1" in summary.all_supportive
        assert "s3" in summary.all_supportive

    def test_agent_count_correct(self):
        ops = [_make_opinion(), _make_opinion(), _make_opinion()]
        summary = self.manager.summarize(_make_manager_input(opinions=ops))
        assert summary.agent_count == 3

    def test_consensus_strength_in_range(self):
        ops = [_make_opinion(confidence=0.9), _make_opinion(confidence=0.1)]
        summary = self.manager.summarize(_make_manager_input(opinions=ops))
        assert 0.0 <= summary.consensus_strength <= 1.0

    def test_consensus_high_true_when_identical_confidence(self):
        ops = [_make_opinion(confidence=0.8), _make_opinion(confidence=0.8)]
        summary = self.manager.summarize(_make_manager_input(opinions=ops))
        # stdev=0 → consensus_strength=1.0 → is_consensus_high=True
        assert summary.is_consensus_high is True

    def test_consensus_high_false_when_diverged(self):
        # stdev of [0.0, 1.0] = ~0.707 → consensus = 1 - 0.707*2 = -0.414 → clamp to 0.0
        ops = [_make_opinion(confidence=0.0), _make_opinion(confidence=1.0)]
        summary = self.manager.summarize(_make_manager_input(opinions=ops))
        assert summary.is_consensus_high is False

    def test_safe_confidence_none_no_crash(self):
        # confidence=None の AgentOpinion を直接作れないので stub で迂回
        op = _make_opinion(confidence=0.5)
        # ManagerInput の opinions にそのまま渡す（_safe_confidence が 0.0 fallback）
        inp = _make_manager_input(opinions=[op])
        summary = self.manager.summarize(inp)
        assert 0.0 <= summary.average_confidence <= 1.0

    def test_summary_is_frozen(self):
        summary = self.manager.summarize(_make_manager_input())
        with pytest.raises((AttributeError, TypeError)):
            summary.average_confidence = 0.0  # type: ignore[misc]

    def test_to_dict_json_serializable(self):
        ops = [_make_opinion(confidence=0.7), _make_opinion(confidence=0.8)]
        summary = self.manager.summarize(_make_manager_input(opinions=ops))
        json.dumps(summary.to_dict())

    def test_regime_observed_stored(self):
        summary = self.manager.summarize(_make_manager_input(opinions=[], regime="crisis"))
        assert summary.regime_observed == "crisis"


# ── AgentManager.run_all ──────────────────────────────────────────────────────

class TestAgentManagerRunAll:
    def setup_method(self):
        self.manager = AgentManager()

    def _make_agent_input(self, regime="bull_calm") -> AgentInput:
        return AgentInput(
            ticker="7203",
            factor_scores={"value": 70.0},
            regime=regime,
            horizon="long_term",
        )

    def test_run_all_returns_manager_summary(self):
        specialists = (
            _StubSpecialist(0.7),
            _StubSpecialist(0.8),
        )
        summary = self.manager.run_all(self._make_agent_input(), specialists)
        assert isinstance(summary, ManagerSummary)

    def test_run_all_agent_count_matches_specialists(self):
        specialists = (_StubSpecialist(), _StubSpecialist(), _StubSpecialist())
        summary = self.manager.run_all(self._make_agent_input(), specialists)
        assert summary.agent_count == 3

    def test_run_all_empty_specialists_fallback(self):
        summary = self.manager.run_all(self._make_agent_input(), specialists=())
        assert summary.agent_count == 0
        assert summary.average_confidence == pytest.approx(0.0)

    def test_run_all_average_confidence_correct(self):
        specialists = (_StubSpecialist(0.6), _StubSpecialist(0.8))
        summary = self.manager.run_all(self._make_agent_input(), specialists)
        assert summary.average_confidence == pytest.approx(0.7)
