"""
test_adversarial_self_check.py — Card 6-5
AdversarialSelfCheck / AdversarialCheckInput / AdversarialCheckResult の単体テスト。

テスト対象:
  - AdversarialCheckInput frozen / context default_factory
  - AdversarialCheckResult frozen / 禁止フィールドなし / to_dict()
  - pro_points / counter_points の生成
  - risk_level: low / moderate / high の閾値
  - is_high_risk 観察値フラグ
  - adversarial_flags: crisis / bear regime
  - missing_evidence: low confidence / few agents
  - review() が AdversarialCheckResult を返す
"""
import json

import pytest

from backend.engine.agents.adversarial_self_check import (
    AdversarialCheckInput,
    AdversarialCheckResult,
    AdversarialSelfCheck,
)
from backend.engine.agents.manager import ManagerSummary


# ── helpers ───────────────────────────────────────────────────────────────────

def _make_summary(
    ticker: str = "7203",
    average_confidence: float = 0.7,
    concern_count: int = 2,
    supportive_count: int = 2,
    consensus_strength: float = 0.8,
    all_concerns: tuple = ("concern_a", "concern_b"),
    all_supportive: tuple = ("support_a", "support_b"),
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


def _make_check_input(
    summary: ManagerSummary = None,
    ticker: str = "7203",
) -> AdversarialCheckInput:
    if summary is None:
        summary = _make_summary(ticker=ticker)
    return AdversarialCheckInput(summary=summary, ticker=ticker)


# ── AdversarialCheckInput ─────────────────────────────────────────────────────

class TestAdversarialCheckInput:
    def test_frozen(self):
        inp = _make_check_input()
        with pytest.raises((AttributeError, TypeError)):
            inp.ticker = "9984"  # type: ignore[misc]

    def test_context_default_factory_independence(self):
        a = _make_check_input()
        b = _make_check_input()
        assert a.context is not b.context

    def test_context_default_empty(self):
        inp = _make_check_input()
        assert inp.context == {}

    def test_fields_accessible(self):
        s = _make_summary()
        inp = AdversarialCheckInput(summary=s, ticker="7203")
        assert inp.ticker == "7203"
        assert inp.summary is s


# ── AdversarialCheckResult ────────────────────────────────────────────────────

class TestAdversarialCheckResult:
    def _make(self, **kwargs) -> AdversarialCheckResult:
        defaults = dict(
            ticker="X",
            pro_points=("pro_a",),
            counter_points=("counter_a",),
            missing_evidence=(),
            adversarial_flags=("flag_a",),
            risk_level="low",
            is_high_risk=False,
        )
        defaults.update(kwargs)
        return AdversarialCheckResult(**defaults)

    def test_frozen(self):
        result = self._make()
        with pytest.raises((AttributeError, TypeError)):
            result.risk_level = "high"  # type: ignore[misc]

    def test_no_forbidden_fields(self):
        result = self._make()
        forbidden = [
            "action", "recommendation", "is_buy", "is_sell", "is_hold",
            "is_recommended", "verdict", "decision", "rating", "approve", "reject",
            "conditional",
        ]
        for f in forbidden:
            assert not hasattr(result, f), f"Forbidden field '{f}' found"

    def test_to_dict_json_serializable(self):
        result = self._make()
        json.dumps(result.to_dict())

    def test_to_dict_structure(self):
        result = self._make()
        d = result.to_dict()
        assert isinstance(d["pro_points"], list)
        assert isinstance(d["counter_points"], list)
        assert isinstance(d["missing_evidence"], list)
        assert isinstance(d["adversarial_flags"], list)
        assert isinstance(d["risk_level"], str)
        assert isinstance(d["is_high_risk"], bool)

    def test_is_high_risk_is_bool(self):
        result = self._make(is_high_risk=True)
        assert isinstance(result.is_high_risk, bool)

    def test_is_high_risk_not_action_field(self):
        # is_high_risk は観察値フラグ（is_buy/is_sell/is_recommended とは別物）
        result = self._make(is_high_risk=True)
        assert not hasattr(result, "is_buy")
        assert not hasattr(result, "is_sell")
        assert not hasattr(result, "is_recommended")


# ── AdversarialSelfCheck ──────────────────────────────────────────────────────

class TestAdversarialSelfCheck:
    def setup_method(self):
        self.checker = AdversarialSelfCheck()

    def test_review_returns_result(self):
        inp = _make_check_input()
        result = self.checker.review(inp)
        assert isinstance(result, AdversarialCheckResult)

    def test_pro_points_from_supportive(self):
        s = _make_summary(all_supportive=("strong value",))
        inp = _make_check_input(summary=s)
        result = self.checker.review(inp)
        assert isinstance(result.pro_points, tuple)
        assert len(result.pro_points) >= 1
        assert any("strong value" in p for p in result.pro_points)

    def test_pro_points_fallback_when_empty_supportive(self):
        s = _make_summary(all_supportive=())
        inp = _make_check_input(summary=s)
        result = self.checker.review(inp)
        assert isinstance(result.pro_points, tuple)
        assert len(result.pro_points) >= 1  # fallback メッセージ

    def test_counter_points_from_concerns(self):
        s = _make_summary(all_concerns=("value trap risk",))
        inp = _make_check_input(summary=s)
        result = self.checker.review(inp)
        assert isinstance(result.counter_points, tuple)
        assert len(result.counter_points) >= 1
        assert any("value trap risk" in c for c in result.counter_points)

    def test_counter_points_fallback_when_empty_concerns(self):
        s = _make_summary(all_concerns=(), concern_count=0)
        inp = _make_check_input(summary=s)
        result = self.checker.review(inp)
        assert isinstance(result.counter_points, tuple)
        assert len(result.counter_points) >= 1  # fallback メッセージ

    # ── risk_level ────────────────────────────────────────────────────────────

    def test_risk_level_low(self):
        s = _make_summary(concern_count=1, consensus_strength=0.8)
        result = self.checker.review(_make_check_input(summary=s))
        assert result.risk_level == "low"
        assert result.is_high_risk is False

    def test_risk_level_moderate_concern_count(self):
        s = _make_summary(concern_count=4, consensus_strength=0.8)
        result = self.checker.review(_make_check_input(summary=s))
        assert result.risk_level == "moderate"

    def test_risk_level_moderate_low_consensus(self):
        s = _make_summary(concern_count=1, consensus_strength=0.4)
        result = self.checker.review(_make_check_input(summary=s))
        assert result.risk_level == "moderate"

    def test_risk_level_high_concern_count(self):
        s = _make_summary(concern_count=6, consensus_strength=0.8)
        result = self.checker.review(_make_check_input(summary=s))
        assert result.risk_level == "high"
        assert result.is_high_risk is True

    def test_risk_level_high_low_consensus(self):
        s = _make_summary(concern_count=1, consensus_strength=0.2)
        result = self.checker.review(_make_check_input(summary=s))
        assert result.risk_level == "high"
        assert result.is_high_risk is True

    def test_risk_level_high_takes_priority_over_moderate(self):
        s = _make_summary(concern_count=6, consensus_strength=0.4)
        result = self.checker.review(_make_check_input(summary=s))
        assert result.risk_level == "high"

    # ── adversarial_flags ─────────────────────────────────────────────────────

    def test_adversarial_flags_crisis_regime(self):
        s = _make_summary(regime_observed="crisis")
        result = self.checker.review(_make_check_input(summary=s))
        crisis_flags = [f for f in result.adversarial_flags if "crisis" in f.lower()]
        assert len(crisis_flags) >= 1

    def test_adversarial_flags_bear_regime(self):
        s = _make_summary(regime_observed="bear")
        result = self.checker.review(_make_check_input(summary=s))
        bear_flags = [f for f in result.adversarial_flags if "bear" in f.lower()]
        assert len(bear_flags) >= 1

    def test_adversarial_flags_bull_volatile_regime(self):
        s = _make_summary(regime_observed="bull_volatile")
        result = self.checker.review(_make_check_input(summary=s))
        vol_flags = [f for f in result.adversarial_flags if "volatile" in f.lower()]
        assert len(vol_flags) >= 1

    def test_adversarial_flags_low_consensus(self):
        s = _make_summary(regime_observed="bull_calm", consensus_strength=0.2)
        result = self.checker.review(_make_check_input(summary=s))
        consensus_flags = [f for f in result.adversarial_flags if "consensus" in f.lower()]
        assert len(consensus_flags) >= 1

    def test_adversarial_flags_nonempty(self):
        result = self.checker.review(_make_check_input())
        assert isinstance(result.adversarial_flags, tuple)
        assert len(result.adversarial_flags) >= 1

    # ── missing_evidence ──────────────────────────────────────────────────────

    def test_missing_evidence_low_confidence(self):
        s = _make_summary(average_confidence=0.2)
        result = self.checker.review(_make_check_input(summary=s))
        conf_missing = [m for m in result.missing_evidence if "confidence" in m.lower()]
        assert len(conf_missing) >= 1

    def test_missing_evidence_few_agents(self):
        s = _make_summary(agent_count=3)
        result = self.checker.review(_make_check_input(summary=s))
        agent_missing = [m for m in result.missing_evidence if "agent" in m.lower()]
        assert len(agent_missing) >= 1

    def test_missing_evidence_full_agents_high_confidence(self):
        s = _make_summary(agent_count=6, average_confidence=0.7)
        result = self.checker.review(_make_check_input(summary=s))
        # 閾値を満たしているので missing_evidence は空
        assert result.missing_evidence == ()

    # ── result tuple types ────────────────────────────────────────────────────

    def test_all_result_fields_are_tuples_of_strings(self):
        result = self.checker.review(_make_check_input())
        for field in (result.pro_points, result.counter_points,
                      result.missing_evidence, result.adversarial_flags):
            assert isinstance(field, tuple)
            for item in field:
                assert isinstance(item, str)

    def test_result_ticker_correct(self):
        result = self.checker.review(_make_check_input(ticker="9984"))
        assert result.ticker == "9984"

    def test_to_dict_json_serializable(self):
        result = self.checker.review(_make_check_input())
        json.dumps(result.to_dict())
