"""
test_committee_orchestrator.py — Card 6-6
CommitteeOrchestrator / CommitteeInput / CommitteeReport の単体テスト。

テスト対象:
  - CommitteeInput frozen / tuple 保証 / context default_factory
  - CommitteeReport frozen / 禁止フィールドなし / to_dict()
  - orchestrate(): aggregate_confidence / risk_level / evidence_balance
  - key_* スライス上限
  - observation_flags 組み立て
  - is_high_risk / is_consensus_high 観察値フラグ
  - safe clamp: NaN / inf / invalid risk_level
  - run_full(): DI パイプライン / opinions を CommitteeInput に渡す
"""
import json
import math

import pytest

from backend.engine.agents.adversarial_self_check import (
    AdversarialCheckResult,
    AdversarialSelfCheck,
)
from backend.engine.agents.base_agent import AgentInput, AgentOpinion, BaseAgent
from backend.engine.agents.committee_orchestrator import (
    CommitteeInput,
    CommitteeOrchestrator,
    CommitteeReport,
    _safe_float,
    _safe_risk_level,
)
from backend.engine.agents.manager import AgentManager, ManagerSummary


# ── fixture helpers ───────────────────────────────────────────────────────────

def _make_manager_summary(
    ticker: str = "7203",
    average_confidence: float = 0.7,
    concern_count: int = 2,
    supportive_count: int = 4,
    consensus_strength: float = 0.8,
    all_concerns: tuple = ("c1", "c2"),
    all_supportive: tuple = ("s1", "s2", "s3", "s4"),
    agent_count: int = 6,
    regime_observed: str = "bull_calm",
    is_consensus_high: bool = True,
) -> ManagerSummary:
    return ManagerSummary(
        ticker=ticker,
        average_confidence=average_confidence,
        concern_count=concern_count,
        supportive_count=supportive_count,
        consensus_strength=consensus_strength,
        all_concerns=all_concerns,
        all_supportive=all_supportive,
        agent_count=agent_count,
        regime_observed=regime_observed,
        is_consensus_high=is_consensus_high,
    )


def _make_adversarial_result(
    ticker: str = "7203",
    pro_points: tuple = ("pro_a",),
    counter_points: tuple = ("counter_a", "counter_b"),
    missing_evidence: tuple = (),
    adversarial_flags: tuple = ("flag_a",),
    risk_level: str = "low",
    is_high_risk: bool = False,
) -> AdversarialCheckResult:
    return AdversarialCheckResult(
        ticker=ticker,
        pro_points=pro_points,
        counter_points=counter_points,
        missing_evidence=missing_evidence,
        adversarial_flags=adversarial_flags,
        risk_level=risk_level,
        is_high_risk=is_high_risk,
    )


def _make_committee_input(
    ticker: str = "7203",
    manager_summary: ManagerSummary = None,
    adversarial_result: AdversarialCheckResult = None,
    opinions: tuple = (),
) -> CommitteeInput:
    if manager_summary is None:
        manager_summary = _make_manager_summary(ticker=ticker)
    if adversarial_result is None:
        adversarial_result = _make_adversarial_result(ticker=ticker)
    return CommitteeInput(
        ticker=ticker,
        manager_summary=manager_summary,
        adversarial_result=adversarial_result,
        opinions=opinions,
    )


def _make_opinion(role_id: str = "stub", confidence: float = 0.7) -> AgentOpinion:
    return AgentOpinion(
        role_id=role_id,
        role_name="Stub",
        focus_area=("value",),
        confidence=confidence,
        supportive_points=("support_a",),
        concerns=("concern_a",),
        factor_scores_used=(("value", 60.0),),
        regime_observed="bull_calm",
    )


class _StubSpecialist(BaseAgent):
    role_id    = "stub"
    role_name  = "Stub"
    focus_area = ("value",)

    def __init__(self, confidence: float = 0.7):
        self._conf = confidence

    def analyze(self, agent_input: AgentInput) -> AgentOpinion:
        return _make_opinion(confidence=self._conf)


# ── safe helpers ──────────────────────────────────────────────────────────────

class TestSafeHelpers:
    def test_safe_float_normal(self):
        assert _safe_float(0.7) == pytest.approx(0.7)

    def test_safe_float_none(self):
        assert _safe_float(None) == pytest.approx(0.0)

    def test_safe_float_nan(self):
        assert _safe_float(float("nan")) == pytest.approx(0.0)

    def test_safe_float_inf(self):
        assert _safe_float(float("inf")) == pytest.approx(0.0)

    def test_safe_float_str(self):
        assert _safe_float("bad") == pytest.approx(0.0)

    def test_safe_risk_level_valid(self):
        assert _safe_risk_level("low") == "low"
        assert _safe_risk_level("moderate") == "moderate"
        assert _safe_risk_level("high") == "high"

    def test_safe_risk_level_invalid_fallback(self):
        assert _safe_risk_level("extreme") == "moderate"
        assert _safe_risk_level("") == "moderate"
        assert _safe_risk_level("unknown") == "moderate"


# ── CommitteeInput ────────────────────────────────────────────────────────────

class TestCommitteeInput:
    def test_frozen(self):
        inp = _make_committee_input()
        with pytest.raises((AttributeError, TypeError)):
            inp.ticker = "9984"  # type: ignore[misc]

    def test_opinions_is_tuple(self):
        op = _make_opinion()
        inp = _make_committee_input(opinions=(op,))
        assert isinstance(inp.opinions, tuple)

    def test_opinions_list_converted_to_tuple(self):
        op = _make_opinion()
        inp = CommitteeInput(
            ticker="A",
            manager_summary=_make_manager_summary(),
            adversarial_result=_make_adversarial_result(),
            opinions=[op],  # type: ignore[arg-type]
        )
        assert isinstance(inp.opinions, tuple)

    def test_context_default_factory_independence(self):
        a = _make_committee_input()
        b = _make_committee_input()
        assert a.context is not b.context

    def test_context_default_empty(self):
        inp = _make_committee_input()
        assert inp.context == {}


# ── CommitteeReport ───────────────────────────────────────────────────────────

class TestCommitteeReport:
    def _make(self, **kwargs) -> CommitteeReport:
        defaults = dict(
            ticker="X",
            aggregate_confidence=0.7,
            aggregate_risk_level="low",
            evidence_balance=0.3,
            key_supportive_points=("s1",),
            key_concerns=("c1",),
            key_counter_points=("co1",),
            observation_flags=("f1",),
            is_high_risk=False,
            is_consensus_high=True,
            agent_count=6,
            regime_observed="bull_calm",
        )
        defaults.update(kwargs)
        return CommitteeReport(**defaults)

    def test_frozen(self):
        report = self._make()
        with pytest.raises((AttributeError, TypeError)):
            report.aggregate_confidence = 0.5  # type: ignore[misc]

    def test_no_forbidden_fields(self):
        report = self._make()
        forbidden = [
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "verdict", "decision", "rating",
            "approve", "reject", "conditional",
        ]
        for f in forbidden:
            assert not hasattr(report, f), f"Forbidden field '{f}' found"

    def test_to_dict_json_serializable(self):
        report = self._make()
        json.dumps(report.to_dict())

    def test_to_dict_structure(self):
        report = self._make()
        d = report.to_dict()
        assert isinstance(d["key_supportive_points"], list)
        assert isinstance(d["key_concerns"], list)
        assert isinstance(d["key_counter_points"], list)
        assert isinstance(d["observation_flags"], list)
        assert isinstance(d["is_high_risk"], bool)
        assert isinstance(d["is_consensus_high"], bool)


# ── CommitteeOrchestrator.orchestrate ─────────────────────────────────────────

class TestOrchestrateBasic:
    def setup_method(self):
        self.orch = CommitteeOrchestrator()

    def test_returns_committee_report(self):
        report = self.orch.orchestrate(_make_committee_input())
        assert isinstance(report, CommitteeReport)

    def test_report_is_frozen(self):
        report = self.orch.orchestrate(_make_committee_input())
        with pytest.raises((AttributeError, TypeError)):
            report.aggregate_confidence = 0.0  # type: ignore[misc]

    def test_aggregate_confidence_from_manager(self):
        ms = _make_manager_summary(average_confidence=0.65)
        inp = _make_committee_input(manager_summary=ms)
        report = self.orch.orchestrate(inp)
        assert report.aggregate_confidence == pytest.approx(0.65)

    def test_aggregate_confidence_clamp_above_1(self):
        ms = _make_manager_summary(average_confidence=1.5)
        inp = _make_committee_input(manager_summary=ms)
        report = self.orch.orchestrate(inp)
        assert report.aggregate_confidence == pytest.approx(1.0)

    def test_aggregate_confidence_clamp_below_0(self):
        ms = _make_manager_summary(average_confidence=-0.3)
        inp = _make_committee_input(manager_summary=ms)
        report = self.orch.orchestrate(inp)
        assert report.aggregate_confidence == pytest.approx(0.0)

    def test_aggregate_confidence_nan_fallback(self):
        ms = _make_manager_summary(average_confidence=float("nan"))
        inp = _make_committee_input(manager_summary=ms)
        report = self.orch.orchestrate(inp)
        assert report.aggregate_confidence == pytest.approx(0.0)

    def test_aggregate_confidence_inf_fallback(self):
        ms = _make_manager_summary(average_confidence=float("inf"))
        inp = _make_committee_input(manager_summary=ms)
        report = self.orch.orchestrate(inp)
        assert report.aggregate_confidence == pytest.approx(0.0)

    def test_aggregate_risk_level_from_adversarial(self):
        ar = _make_adversarial_result(risk_level="high", is_high_risk=True)
        inp = _make_committee_input(adversarial_result=ar)
        report = self.orch.orchestrate(inp)
        assert report.aggregate_risk_level == "high"

    def test_aggregate_risk_level_invalid_fallback_to_moderate(self):
        ar = _make_adversarial_result(risk_level="extreme")
        inp = _make_committee_input(adversarial_result=ar)
        report = self.orch.orchestrate(inp)
        assert report.aggregate_risk_level == "moderate"

    def test_aggregate_risk_level_empty_fallback(self):
        ar = _make_adversarial_result(risk_level="")
        inp = _make_committee_input(adversarial_result=ar)
        report = self.orch.orchestrate(inp)
        assert report.aggregate_risk_level == "moderate"

    def test_is_high_risk_from_adversarial(self):
        ar = _make_adversarial_result(risk_level="high", is_high_risk=True)
        inp = _make_committee_input(adversarial_result=ar)
        report = self.orch.orchestrate(inp)
        assert report.is_high_risk is True

    def test_is_high_risk_false(self):
        ar = _make_adversarial_result(risk_level="low", is_high_risk=False)
        inp = _make_committee_input(adversarial_result=ar)
        report = self.orch.orchestrate(inp)
        assert report.is_high_risk is False

    def test_is_consensus_high_from_manager(self):
        ms = _make_manager_summary(is_consensus_high=True)
        inp = _make_committee_input(manager_summary=ms)
        report = self.orch.orchestrate(inp)
        assert report.is_consensus_high is True

    def test_is_consensus_high_false(self):
        ms = _make_manager_summary(is_consensus_high=False)
        inp = _make_committee_input(manager_summary=ms)
        report = self.orch.orchestrate(inp)
        assert report.is_consensus_high is False

    def test_agent_count_from_manager(self):
        ms = _make_manager_summary(agent_count=4)
        inp = _make_committee_input(manager_summary=ms)
        report = self.orch.orchestrate(inp)
        assert report.agent_count == 4

    def test_regime_observed_correct(self):
        ms = _make_manager_summary(regime_observed="crisis")
        inp = _make_committee_input(manager_summary=ms)
        report = self.orch.orchestrate(inp)
        assert report.regime_observed == "crisis"

    def test_no_forbidden_fields(self):
        report = self.orch.orchestrate(_make_committee_input())
        forbidden = [
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "verdict", "decision", "rating",
            "approve", "reject", "conditional",
        ]
        for f in forbidden:
            assert not hasattr(report, f), f"Forbidden field '{f}' found"

    def test_to_dict_json_serializable(self):
        report = self.orch.orchestrate(_make_committee_input())
        json.dumps(report.to_dict())


# ── evidence_balance ──────────────────────────────────────────────────────────

class TestEvidenceBalance:
    def setup_method(self):
        self.orch = CommitteeOrchestrator()

    def _report(self, supportive_count, concern_count) -> CommitteeReport:
        ms = _make_manager_summary(
            supportive_count=supportive_count,
            concern_count=concern_count,
        )
        return self.orch.orchestrate(_make_committee_input(manager_summary=ms))

    def test_positive_when_supportive_dominant(self):
        report = self._report(supportive_count=8, concern_count=2)
        assert report.evidence_balance > 0.0

    def test_negative_when_concern_dominant(self):
        report = self._report(supportive_count=2, concern_count=8)
        assert report.evidence_balance < 0.0

    def test_zero_when_equal(self):
        report = self._report(supportive_count=4, concern_count=4)
        assert report.evidence_balance == pytest.approx(0.0)

    def test_zero_when_both_empty(self):
        report = self._report(supportive_count=0, concern_count=0)
        assert report.evidence_balance == pytest.approx(0.0)

    def test_in_range_minus_1_to_1(self):
        for s, c in [(0, 10), (10, 0), (5, 5), (1, 1), (0, 0)]:
            report = self._report(supportive_count=s, concern_count=c)
            assert -1.0 <= report.evidence_balance <= 1.0

    def test_exact_value(self):
        # (6 - 2) / (6 + 2) = 4/8 = 0.5
        report = self._report(supportive_count=6, concern_count=2)
        assert report.evidence_balance == pytest.approx(0.5)


# ── key_* slices ──────────────────────────────────────────────────────────────

class TestKeySlices:
    def setup_method(self):
        self.orch = CommitteeOrchestrator()

    def test_key_supportive_max_5(self):
        ms = _make_manager_summary(
            all_supportive=tuple(f"s{i}" for i in range(10)),
            supportive_count=10,
        )
        report = self.orch.orchestrate(_make_committee_input(manager_summary=ms))
        assert len(report.key_supportive_points) <= 5

    def test_key_concerns_max_5(self):
        ms = _make_manager_summary(
            all_concerns=tuple(f"c{i}" for i in range(10)),
            concern_count=10,
        )
        report = self.orch.orchestrate(_make_committee_input(manager_summary=ms))
        assert len(report.key_concerns) <= 5

    def test_key_counter_points_max_5(self):
        ar = _make_adversarial_result(
            counter_points=tuple(f"co{i}" for i in range(10)),
        )
        report = self.orch.orchestrate(_make_committee_input(adversarial_result=ar))
        assert len(report.key_counter_points) <= 5

    def test_key_supportive_empty_when_no_supportive(self):
        ms = _make_manager_summary(all_supportive=(), supportive_count=0)
        report = self.orch.orchestrate(_make_committee_input(manager_summary=ms))
        assert report.key_supportive_points == ()

    def test_key_concerns_empty_when_no_concerns(self):
        ms = _make_manager_summary(all_concerns=(), concern_count=0)
        report = self.orch.orchestrate(_make_committee_input(manager_summary=ms))
        assert report.key_concerns == ()


# ── observation_flags ─────────────────────────────────────────────────────────

class TestObservationFlags:
    def setup_method(self):
        self.orch = CommitteeOrchestrator()

    def test_contains_adversarial_flags(self):
        ar = _make_adversarial_result(adversarial_flags=("flag_x",))
        report = self.orch.orchestrate(_make_committee_input(adversarial_result=ar))
        assert any("flag_x" in f for f in report.observation_flags)

    def test_contains_missing_evidence(self):
        ar = _make_adversarial_result(missing_evidence=("missing_x",))
        report = self.orch.orchestrate(_make_committee_input(adversarial_result=ar))
        assert any("missing_x" in f for f in report.observation_flags)

    def test_high_risk_adds_flag(self):
        ar = _make_adversarial_result(risk_level="high", is_high_risk=True)
        report = self.orch.orchestrate(_make_committee_input(adversarial_result=ar))
        high_flags = [f for f in report.observation_flags if "high_risk" in f.lower()]
        assert len(high_flags) >= 1

    def test_low_risk_no_high_risk_flag(self):
        ar = _make_adversarial_result(risk_level="low", is_high_risk=False)
        report = self.orch.orchestrate(_make_committee_input(adversarial_result=ar))
        high_flags = [f for f in report.observation_flags if "high_risk_detected" in f]
        assert len(high_flags) == 0

    def test_consensus_high_adds_flag(self):
        ms = _make_manager_summary(is_consensus_high=True, consensus_strength=0.9)
        report = self.orch.orchestrate(_make_committee_input(manager_summary=ms))
        consensus_flags = [f for f in report.observation_flags if "high_consensus" in f]
        assert len(consensus_flags) >= 1

    def test_consensus_low_adds_flag(self):
        ms = _make_manager_summary(is_consensus_high=False, consensus_strength=0.4)
        report = self.orch.orchestrate(_make_committee_input(manager_summary=ms))
        consensus_flags = [f for f in report.observation_flags if "low_consensus" in f]
        assert len(consensus_flags) >= 1

    def test_observation_flags_nonempty(self):
        report = self.orch.orchestrate(_make_committee_input())
        assert isinstance(report.observation_flags, tuple)
        assert len(report.observation_flags) >= 1


# ── run_full ──────────────────────────────────────────────────────────────────

class TestRunFull:
    def setup_method(self):
        self.orch    = CommitteeOrchestrator()
        self.manager = AgentManager()
        self.checker = AdversarialSelfCheck()

    def _agent_input(self, regime: str = "bull_calm") -> AgentInput:
        return AgentInput(
            ticker="7203",
            factor_scores={"value": 70.0, "growth": 60.0},
            regime=regime,
            horizon="long_term",
        )

    def test_run_full_returns_committee_report(self):
        specialists = (_StubSpecialist(0.7), _StubSpecialist(0.8))
        report = self.orch.run_full(
            self._agent_input(), specialists, self.manager, self.checker
        )
        assert isinstance(report, CommitteeReport)

    def test_run_full_agent_count_matches_specialists(self):
        specialists = (_StubSpecialist(), _StubSpecialist(), _StubSpecialist())
        report = self.orch.run_full(
            self._agent_input(), specialists, self.manager, self.checker
        )
        assert report.agent_count == 3

    def test_run_full_empty_specialists_no_crash(self):
        report = self.orch.run_full(
            self._agent_input(), (), self.manager, self.checker
        )
        assert isinstance(report, CommitteeReport)
        assert report.agent_count == 0

    def test_run_full_opinions_passed_to_committee_input(self):
        """
        opinions が CommitteeInput に渡されていることを間接確認:
        agent_count が specialist 数と一致すれば manager に opinions が渡っている。
        """
        specialists = (_StubSpecialist(0.6), _StubSpecialist(0.9))
        report = self.orch.run_full(
            self._agent_input(), specialists, self.manager, self.checker
        )
        # manager_summary.agent_count == len(specialists) であれば opinions が渡っている
        assert report.agent_count == 2

    def test_run_full_regime_propagated(self):
        specialists = (_StubSpecialist(),)
        report = self.orch.run_full(
            self._agent_input(regime="crisis"), specialists, self.manager, self.checker
        )
        assert report.regime_observed == "crisis"

    def test_run_full_no_forbidden_fields(self):
        specialists = (_StubSpecialist(),)
        report = self.orch.run_full(
            self._agent_input(), specialists, self.manager, self.checker
        )
        forbidden = [
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "verdict", "decision", "rating",
            "approve", "reject", "conditional",
        ]
        for f in forbidden:
            assert not hasattr(report, f), f"Forbidden field '{f}' found"

    def test_run_full_to_dict_json_serializable(self):
        specialists = (_StubSpecialist(),)
        report = self.orch.run_full(
            self._agent_input(), specialists, self.manager, self.checker
        )
        json.dumps(report.to_dict())
