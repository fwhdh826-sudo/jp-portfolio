"""
manager.py — Card 6-5
Phase 6 Agents: Manager — 6 specialist の AgentOpinion を集約する層。

責務:
  - ManagerInput  — Manager への入力を保持する frozen dataclass
  - ManagerSummary — 集約結果を保持する frozen dataclass
  - AgentManager  — summarize() / run_all() で ManagerSummary を返すクラス

設計原則:
  - 実LLM/HTTP接続禁止
  - BUY/SELL/HOLD/WAIT 禁止
  - action/recommendation/is_buy/is_sell/is_hold/is_recommended/
    verdict/decision/rating/approve/reject 禁止
  - pandas/numpy 禁止
  - operation/market_intel/news/regime を直接 import しない
  - specialists は DI で受け取る（Manager 内でインスタンス化しない）

ManagerInput.opinions:
  - tuple[AgentOpinion, ...] で保持（frozen 不変性）
  - list が渡された場合は __post_init__ で tuple 化する

safe confidence:
  - AgentOpinion.confidence は 0〜1 のはずだが Manager 側でも安全処理する
  - None / str / NaN / inf → 0.0 fallback
  - 0.0〜1.0 に clamp

is_consensus_high について:
  - confidence 値の一致度（consensus_strength）が 0.7 以上かを示す「観察値フラグ」
  - is_buy / is_sell / is_hold / is_recommended のような売買命令フラグではない
  - 「高い分析一致度が観察された」という計算上の事実を保持する

実装しないこと:
  - CommitteeOrchestrator（Card 6-6 の責務）
  - AdversarialSelfCheck（同ファイル不含、adversarial_self_check.py に分離）
  - 売買判断・注文生成・銘柄推奨・PF最適化
  - 実LLM接続・外部API接続
  - public/data writer

Reference: docs/v13.3/07_v13.3_spec.md Section 8.1
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 6-5
"""
from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field

from backend.engine.agents.base_agent import AgentInput, AgentOpinion, BaseAgent


# ── safe confidence helper ────────────────────────────────────────────────────

def _safe_confidence(raw) -> float:
    """
    confidence 値を安全に 0.0〜1.0 の float に変換する。

    None / 変換不能 str / NaN / inf → 0.0 fallback。
    それ以外は 0.0〜1.0 に clamp。
    """
    if raw is None:
        return 0.0
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return 0.0
    if math.isnan(val) or math.isinf(val):
        return 0.0
    return max(0.0, min(1.0, val))


# ── ManagerInput ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ManagerInput:
    """
    AgentManager への入力。immutable。

    opinions: tuple[AgentOpinion, ...] で保持。
      list が渡されても __post_init__ で tuple 化するため安全。
    context: mutable default 禁止のため default_factory。

    action/recommendation/verdict 等の判断フィールドは持たない。
    """

    ticker:   str
    opinions: tuple[AgentOpinion, ...]
    regime:   str
    horizon:  str
    context:  dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        # list や他の iterable が渡された場合に tuple 化する
        if not isinstance(self.opinions, tuple):
            object.__setattr__(self, "opinions", tuple(self.opinions))


# ── ManagerSummary ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ManagerSummary:
    """
    AgentManager の集約結果。immutable。

    「全 specialist の分析を統計的に整理した情報」であり売買命令ではない。

    is_consensus_high: 観察値フラグ。
      consensus_strength >= 0.7 のとき True。
      「高い分析一致度が観察された」という計算上の事実。
      is_buy / is_sell / is_hold / is_recommended とは別物 — 売買命令ではない。

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / rating / approve / reject
    """

    ticker:             str
    average_confidence: float           # 全 opinions の confidence 平均（0.0〜1.0）
    concern_count:      int             # 全 concerns の件数合計
    supportive_count:   int             # 全 supportive_points の件数合計
    consensus_strength: float           # confidence のばらつきの低さ（0.0〜1.0）
    all_concerns:       tuple[str, ...] # 全 concerns を結合（重複あり）
    all_supportive:     tuple[str, ...] # 全 supportive_points を結合（重複あり）
    agent_count:        int             # 受け取った opinions の件数
    regime_observed:    str
    is_consensus_high:  bool            # 観察値フラグ: consensus_strength >= 0.7

    def to_dict(self) -> dict:
        """JSON serializable な dict を返す（str / float / int / bool / list のみ）。"""
        return {
            "ticker":             self.ticker,
            "average_confidence": self.average_confidence,
            "concern_count":      self.concern_count,
            "supportive_count":   self.supportive_count,
            "consensus_strength": self.consensus_strength,
            "all_concerns":       list(self.all_concerns),
            "all_supportive":     list(self.all_supportive),
            "agent_count":        self.agent_count,
            "regime_observed":    self.regime_observed,
            "is_consensus_high":  self.is_consensus_high,
        }


# ── AgentManager ──────────────────────────────────────────────────────────────

class AgentManager:
    """
    6 specialist の AgentOpinion を集約して ManagerSummary を返す。

    summarize(): ManagerInput を受け取り ManagerSummary を返す（純集約）。
    run_all():   AgentInput と specialists（DI）を受け取り、analyze() を呼んで集約する。

    売買判断・注文生成は行わない。
    specialists は DI で受け取るため、Manager 内でインスタンス化しない。
    """

    # is_consensus_high の閾値（観察値フラグの計算基準）
    CONSENSUS_HIGH_THRESHOLD: float = 0.7
    # missing_evidence 判定の confidence 閾値
    LOW_CONFIDENCE_THRESHOLD: float = 0.4

    def summarize(self, manager_input: ManagerInput) -> ManagerSummary:
        """
        ManagerInput を受け取り、全 opinions を集約して ManagerSummary を返す。

        opinions 空 → fallback（average_confidence=0.0, consensus_strength=0.0）
        opinions 1件 → consensus_strength=1.0（stdev 計算不能のため）
        opinions 複数 → consensus_strength = 1.0 - clamp(stdev(conf) * 2.0, 0, 1)
        """
        opinions = manager_input.opinions  # 常に tuple（__post_init__ で保証）

        if not opinions:
            return ManagerSummary(
                ticker=manager_input.ticker,
                average_confidence=0.0,
                concern_count=0,
                supportive_count=0,
                consensus_strength=0.0,
                all_concerns=(),
                all_supportive=(),
                agent_count=0,
                regime_observed=manager_input.regime,
                is_consensus_high=False,
            )

        # safe clamp した confidence リスト
        confidences = [_safe_confidence(op.confidence) for op in opinions]

        average_confidence = sum(confidences) / len(confidences)

        if len(confidences) == 1:
            consensus_strength = 1.0
        else:
            std = statistics.stdev(confidences)
            consensus_strength = max(0.0, min(1.0, 1.0 - std * 2.0))

        # concerns / supportive_points を結合
        all_concerns_list: list[str] = []
        all_supportive_list: list[str] = []
        for op in opinions:
            all_concerns_list.extend(op.concerns)
            all_supportive_list.extend(op.supportive_points)

        return ManagerSummary(
            ticker=manager_input.ticker,
            average_confidence=max(0.0, min(1.0, average_confidence)),
            concern_count=len(all_concerns_list),
            supportive_count=len(all_supportive_list),
            consensus_strength=consensus_strength,
            all_concerns=tuple(all_concerns_list),
            all_supportive=tuple(all_supportive_list),
            agent_count=len(opinions),
            regime_observed=manager_input.regime,
            is_consensus_high=consensus_strength >= self.CONSENSUS_HIGH_THRESHOLD,
        )

    def run_all(
        self,
        agent_input: AgentInput,
        specialists: tuple[BaseAgent, ...],
    ) -> ManagerSummary:
        """
        specialists（DI）の analyze() を呼び出し、ManagerSummary を返す。

        specialists は外部から DI で渡す（AgentManager 内でインスタンス化しない）。
        空 specialists は fallback（agent_count=0）。
        """
        if not specialists:
            opinions: tuple[AgentOpinion, ...] = ()
        else:
            opinions = tuple(agent.analyze(agent_input) for agent in specialists)

        manager_input = ManagerInput(
            ticker=agent_input.ticker,
            opinions=opinions,
            regime=agent_input.regime,
            horizon=agent_input.horizon,
            context=dict(agent_input.context),
        )
        return self.summarize(manager_input)
