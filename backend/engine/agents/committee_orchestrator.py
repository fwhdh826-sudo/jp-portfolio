"""
committee_orchestrator.py — Card 6-6
Phase 6 Agents: Committee Orchestrator — 統合分析レポート層。

責務:
  - CommitteeInput  — CommitteeOrchestrator への入力を保持する frozen dataclass
  - CommitteeReport — 統合分析レポートを保持する frozen dataclass
  - CommitteeOrchestrator — orchestrate() / run_full() で CommitteeReport を返すクラス

パイプライン位置:
  specialist(×6) → AgentManager → AdversarialSelfCheck → CommitteeOrchestrator → Operation 層

設計原則:
  - 実LLM/HTTP接続禁止
  - BUY/SELL/HOLD/WAIT 禁止
  - action/recommendation/is_buy/is_sell/is_hold/is_recommended/
    verdict/decision/rating/approve/reject/conditional 禁止
  - pandas/numpy 禁止
  - operation/market_intel/news/regime を直接 import しない
  - CommitteeOrchestrator 内で specialist/manager/checker をインスタンス化しない（DI）

final_verdict / approve / reject / conditional を実装しない理由:
  spec §8 の `final_verdict` は LLM 統合前提の記述。
  計算層での LLM 呼び出しはテスト不能・DI 原則違反。
  代わりに aggregate_risk_level / evidence_balance / observation_flags の観察値で表現し、
  Operation 層が最終的な扱い方を決める。

CommitteeReport の観察値フラグ:
  is_high_risk:     adversarial_result.is_high_risk を bool 化した観察値フラグ
  is_consensus_high: manager_summary.is_consensus_high を bool 化した観察値フラグ
  どちらも is_buy / is_sell / is_recommended のような売買命令ではない。

safe helpers:
  _safe_float():      None/str/NaN/inf → 0.0、それ以外は float 変換
  _clamp():           min/max クランプ
  _safe_risk_level(): "low"/"moderate"/"high" 以外 → "moderate" fallback

実装しないこと:
  - 実LLM接続 / call_llm_json()
  - final_verdict / approve / reject / conditional
  - BUY/SELL/HOLD/WAIT 判定
  - 売買判断・注文生成・銘柄推奨・PF最適化
  - public/data writer

Reference: docs/v13.3/07_v13.3_spec.md Section 8
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 6-6
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from backend.engine.agents.adversarial_self_check import (
    AdversarialCheckInput,
    AdversarialCheckResult,
    AdversarialSelfCheck,
)
from backend.engine.agents.base_agent import AgentInput, AgentOpinion, BaseAgent
from backend.engine.agents.manager import AgentManager, ManagerInput, ManagerSummary


# ── safe helpers ──────────────────────────────────────────────────────────────

_VALID_RISK_LEVELS = frozenset({"low", "moderate", "high"})


def _safe_float(raw) -> float:
    """None / str / NaN / inf を 0.0 に fallback して float を返す。"""
    if raw is None:
        return 0.0
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return 0.0
    if math.isnan(val) or math.isinf(val):
        return 0.0
    return val


def _clamp(val: float, lo: float, hi: float) -> float:
    """val を [lo, hi] に clamp する。"""
    return max(lo, min(hi, val))


def _safe_risk_level(raw: str) -> str:
    """"low"/"moderate"/"high" 以外は "moderate" fallback。"""
    return raw if raw in _VALID_RISK_LEVELS else "moderate"


# ── CommitteeInput ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class CommitteeInput:
    """
    CommitteeOrchestrator への入力。immutable。

    opinions: tuple[AgentOpinion, ...] で保持。
      list が渡されても __post_init__ で tuple 化するため安全。
    context: mutable default 禁止のため default_factory。

    action/recommendation/verdict 等の判断フィールドは持たない。
    """

    ticker:             str
    manager_summary:    ManagerSummary
    adversarial_result: AdversarialCheckResult
    opinions:           tuple[AgentOpinion, ...]
    context:            dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        # list や他の iterable が渡された場合に tuple 化する
        if not isinstance(self.opinions, tuple):
            object.__setattr__(self, "opinions", tuple(self.opinions))


# ── CommitteeReport ───────────────────────────────────────────────────────────

@dataclass(frozen=True)
class CommitteeReport:
    """
    CommitteeOrchestrator の統合分析レポート。immutable。

    「specialist → manager → adversarial の分析を横断的に読める形に整形した情報」
    であり売買命令ではない。Operation 層がこのレポートを受け取り、実際の判断を行う。

    aggregate_risk_level:
      adversarial_result.risk_level を安全に引き継いだ観察値区分。
      "low" / "moderate" / "high" のいずれか。売買判断ではない。

    evidence_balance:
      (supportive_count - concern_count) / total の比率。-1.0〜1.0。
      正 → 支持論点が多い、負 → 懸念論点が多い、0 → 均衡。
      「論点数の分布」という統計量であり BUY/SELL 命令ではない。

    is_high_risk: 観察値フラグ。adversarial_result.is_high_risk の bool 化。
      「高リスク区分が計算された」という事実。売買命令ではない。
    is_consensus_high: 観察値フラグ。manager_summary.is_consensus_high の bool 化。
      「高い分析一致度が観察された」という事実。売買命令ではない。

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / rating / approve / reject / conditional
    """

    ticker:                str
    aggregate_confidence:  float           # 0.0〜1.0
    aggregate_risk_level:  str             # "low" / "moderate" / "high"（観察値）
    evidence_balance:      float           # -1.0〜1.0（論点バランス統計量）
    key_supportive_points: tuple[str, ...] # all_supportive の先頭 MAX_KEY_POINTS 件
    key_concerns:          tuple[str, ...] # all_concerns の先頭 MAX_KEY_POINTS 件
    key_counter_points:    tuple[str, ...] # counter_points の先頭 MAX_KEY_POINTS 件
    observation_flags:     tuple[str, ...] # adversarial_flags + missing_evidence + 観察値文言
    is_high_risk:          bool            # 観察値フラグ: adversarial_result.is_high_risk
    is_consensus_high:     bool            # 観察値フラグ: manager_summary.is_consensus_high
    agent_count:           int             # manager_summary.agent_count
    regime_observed:       str

    def to_dict(self) -> dict:
        """JSON serializable な dict を返す（str / float / int / bool / list のみ）。"""
        return {
            "ticker":                self.ticker,
            "aggregate_confidence":  self.aggregate_confidence,
            "aggregate_risk_level":  self.aggregate_risk_level,
            "evidence_balance":      self.evidence_balance,
            "key_supportive_points": list(self.key_supportive_points),
            "key_concerns":          list(self.key_concerns),
            "key_counter_points":    list(self.key_counter_points),
            "observation_flags":     list(self.observation_flags),
            "is_high_risk":          self.is_high_risk,
            "is_consensus_high":     self.is_consensus_high,
            "agent_count":           self.agent_count,
            "regime_observed":       self.regime_observed,
        }


# ── CommitteeOrchestrator ─────────────────────────────────────────────────────

class CommitteeOrchestrator:
    """
    specialist / manager / adversarial の出力を束ねて CommitteeReport を返す。

    orchestrate(): CommitteeInput を受け取り CommitteeReport を返す（純集約）。
    run_full():    AgentInput + DI コンポーネントを受け取り、全パイプラインを実行する。

    売買判断・注文生成・銘柄推奨は行わない。
    final_verdict / approve / reject / conditional は実装しない。
    全コンポーネントは DI で受け取り、CommitteeOrchestrator 内でインスタンス化しない。
    """

    MAX_KEY_POINTS: int = 5

    def orchestrate(self, committee_input: CommitteeInput) -> CommitteeReport:
        """
        CommitteeInput を受け取り CommitteeReport を返す。

        aggregate_confidence: safe float + 0.0〜1.0 clamp
        evidence_balance:     (supportive - concern) / total、-1.0〜1.0 clamp
        aggregate_risk_level: "low"/"moderate"/"high" 以外は "moderate" fallback
        """
        ms  = committee_input.manager_summary
        ar  = committee_input.adversarial_result

        # ── aggregate_confidence ──────────────────────────────────────────────
        aggregate_confidence = _clamp(_safe_float(ms.average_confidence), 0.0, 1.0)

        # ── aggregate_risk_level ──────────────────────────────────────────────
        aggregate_risk_level = _safe_risk_level(ar.risk_level)

        # ── evidence_balance ──────────────────────────────────────────────────
        total = ms.supportive_count + ms.concern_count
        if total == 0:
            evidence_balance = 0.0
        else:
            raw_balance = (ms.supportive_count - ms.concern_count) / total
            evidence_balance = _clamp(raw_balance, -1.0, 1.0)

        # ── key_* slices ──────────────────────────────────────────────────────
        n = self.MAX_KEY_POINTS
        key_supportive_points = ms.all_supportive[:n]
        key_concerns          = ms.all_concerns[:n]
        key_counter_points    = ar.counter_points[:n]

        # ── observation_flags ─────────────────────────────────────────────────
        flags: list[str] = []
        flags.extend(ar.adversarial_flags)
        flags.extend(ar.missing_evidence)

        if ms.is_consensus_high:
            flags.append(
                f"observation: high_consensus (strength={ms.consensus_strength:.2f}) "
                "— agents show strong agreement"
            )
        else:
            flags.append(
                f"observation: low_consensus (strength={ms.consensus_strength:.2f}) "
                "— partial disagreement among agents"
            )

        if ar.is_high_risk:
            flags.append(
                f"observation: high_risk_detected (risk_level={aggregate_risk_level}) "
                "— adversarial analysis flagged elevated risk"
            )

        observation_flags = tuple(flags)

        return CommitteeReport(
            ticker=committee_input.ticker,
            aggregate_confidence=aggregate_confidence,
            aggregate_risk_level=aggregate_risk_level,
            evidence_balance=evidence_balance,
            key_supportive_points=key_supportive_points,
            key_concerns=key_concerns,
            key_counter_points=key_counter_points,
            observation_flags=observation_flags,
            is_high_risk=bool(ar.is_high_risk),
            is_consensus_high=bool(ms.is_consensus_high),
            agent_count=ms.agent_count,
            regime_observed=ms.regime_observed,
        )

    def run_full(
        self,
        agent_input:         AgentInput,
        specialists:         tuple[BaseAgent, ...],
        manager:             AgentManager,
        adversarial_checker: AdversarialSelfCheck,
    ) -> CommitteeReport:
        """
        specialist → manager → adversarial → committee の全パイプラインを実行する。

        opinions は specialist の analyze() 結果を tuple で保持し、
        ManagerInput と CommitteeInput の両方に渡す。

        Args:
            agent_input:         全 specialist への入力（DI）
            specialists:         6 specialist の tuple（DI）
            manager:             AgentManager インスタンス（DI）
            adversarial_checker: AdversarialSelfCheck インスタンス（DI）
        Returns:
            CommitteeReport
        """
        # 1. 全 specialist を呼び出して opinions を生成
        opinions: tuple[AgentOpinion, ...] = tuple(
            agent.analyze(agent_input) for agent in specialists
        )

        # 2. opinions を manager に渡して ManagerSummary を生成
        manager_input = ManagerInput(
            ticker=agent_input.ticker,
            opinions=opinions,
            regime=agent_input.regime,
            horizon=agent_input.horizon,
            context=dict(agent_input.context),
        )
        manager_summary = manager.summarize(manager_input)

        # 3. AdversarialSelfCheck で反証チェック
        check_input = AdversarialCheckInput(
            summary=manager_summary,
            ticker=agent_input.ticker,
            context=dict(agent_input.context),
        )
        adversarial_result = adversarial_checker.review(check_input)

        # 4. CommitteeInput に opinions を渡す（捨てない）
        committee_input = CommitteeInput(
            ticker=agent_input.ticker,
            manager_summary=manager_summary,
            adversarial_result=adversarial_result,
            opinions=opinions,
            context=dict(agent_input.context),
        )

        return self.orchestrate(committee_input)
