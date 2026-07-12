"""
base_agent.py — Card 6-4
Phase 6 Agents: 7代理ベース層。AgentInput / AgentOpinion / BaseAgent を定義。

責務:
  - AgentInput  — specialist agent への入力を保持する frozen dataclass
  - AgentOpinion — specialist agent の分析結果を保持する frozen dataclass
  - BaseAgent   — 全 specialist が継承する ABC

設計原則:
  - 実LLM/HTTP接続禁止（anthropic/openai/litellm/ollama/requests/httpx 禁止）
  - BUY/SELL/HOLD/WAIT 禁止。AgentOpinion は「分析観点の情報整理」であり売買命令ではない
  - action/recommendation/is_buy/is_sell/is_hold/is_recommended/rating/verdict/decision 禁止
  - pandas/numpy 禁止
  - operation/market_intel/news/regime を直接 import しない
  - factor_scores_used は frozen tuple[tuple[str,float],...] で不変性を保持

AgentInput.context:
  - mutable default 回避のため field(default_factory=dict) を使用

AgentOpinion.factor_scores_used:
  - frozen dataclass に mutable dict を持たせると __hash__ 不能かつ不変性が破れるため
    tuple[tuple[str, float], ...] として格納する
  - to_dict() で dict に変換して JSON serializable にする

_get_focus_scores():
  - factor_scores.get(f, 50.0) だけでなく float 変換 + NaN/inf チェック + 0〜100 clamp
  - 変換不能/NaN/inf は 50.0 fallback

実装しないこと:
  - Manager / CommitteeOrchestrator / AdversarialSelfCheck（Card 6-5/6-6 の責務）
  - 売買判断・注文生成・銘柄推奨・PF最適化
  - 実LLM接続・外部API接続
  - public/data writer

Reference: docs/v13.3/07_v13.3_spec.md Section 8.1
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 6-4
"""
from __future__ import annotations

import math
from abc import ABC, abstractmethod
from dataclasses import dataclass, field


# ── AgentInput ────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class AgentInput:
    """
    Specialist agent への入力。immutable。

    factor_scores: 因子スコア dict {factor_name: 0.0〜100.0}
    regime:        "bull_calm" / "bull_volatile" / "bear" / "crisis" / "uncertain"
    horizon:       "short_term" / "long_term"
    context:       追加情報（任意。DI で渡す）。mutable default 禁止のため default_factory。

    action/recommendation 等の判断フィールドは意図的に持たない。
    """

    ticker:        str
    factor_scores: dict[str, float]
    regime:        str
    horizon:       str
    context:       dict = field(default_factory=dict)


# ── AgentOpinion ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class AgentOpinion:
    """
    Specialist agent の分析結果。immutable。

    「このエージェントの分析観点から見た情報の整理」であり売買命令ではない。
    confidence = 分析確信度（0.0〜1.0）
    supportive_points / concerns = 観察された事実と解釈の列挙（判断材料）

    factor_scores_used: frozen tuple[tuple[str, float], ...] で保持。
      frozen dataclass に mutable dict を持たせると不変性が破れるため tuple 化。
      to_dict() で dict に変換して JSON serializable にする。

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold /
      is_recommended / rating / verdict / decision
    """

    role_id:            str
    role_name:          str
    focus_area:         tuple[str, ...]
    confidence:         float
    supportive_points:  tuple[str, ...]
    concerns:           tuple[str, ...]
    factor_scores_used: tuple[tuple[str, float], ...]
    regime_observed:    str

    def to_dict(self) -> dict:
        """JSON serializable な dict を返す（str / float / bool / list のみ）。"""
        return {
            "role_id":            self.role_id,
            "role_name":          self.role_name,
            "focus_area":         list(self.focus_area),
            "confidence":         self.confidence,
            "supportive_points":  list(self.supportive_points),
            "concerns":           list(self.concerns),
            "factor_scores_used": {k: v for k, v in self.factor_scores_used},
            "regime_observed":    self.regime_observed,
        }


# ── BaseAgent ─────────────────────────────────────────────────────────────────

class BaseAgent(ABC):
    """
    全 specialist agent が継承する ABC。

    サブクラスは role_id / role_name / focus_area をクラス変数として定義し、
    analyze(AgentInput) -> AgentOpinion を実装する。

    実LLM/HTTP接続・売買判断・銘柄推奨は行わない。
    """

    role_id:    str
    role_name:  str
    focus_area: tuple[str, ...]

    @abstractmethod
    def analyze(self, agent_input: AgentInput) -> AgentOpinion:
        """factor_scores / regime / horizon を受け取り AgentOpinion を返す。"""

    def _get_focus_scores(self, factor_scores: dict) -> dict[str, float]:
        """
        focus_area の因子スコアを安全に抽出する。

        - missing factor: 50.0 fallback
        - float() 変換不能 (None / str 等): 50.0 fallback
        - NaN / inf: 50.0 fallback
        - 最終値: 0.0〜100.0 に clamp
        """
        result: dict[str, float] = {}
        for f in self.focus_area:
            raw = factor_scores.get(f, None)
            result[f] = self._safe_score(raw)
        return result

    @staticmethod
    def _safe_score(raw) -> float:
        """スコア値を安全に 0.0〜100.0 float に変換する。失敗時 50.0。"""
        if raw is None:
            return 50.0
        try:
            val = float(raw)
        except (TypeError, ValueError):
            return 50.0
        if math.isnan(val) or math.isinf(val):
            return 50.0
        return max(0.0, min(100.0, val))

    def _clamp_confidence(self, raw: float) -> float:
        """0.0〜1.0 にクランプする。"""
        return max(0.0, min(1.0, raw))

    def _mean_score(self, scores: dict[str, float]) -> float:
        """スコア dict の平均を返す。空なら 50.0。"""
        if not scores:
            return 50.0
        return sum(scores.values()) / len(scores)

    def _scores_to_tuple(self, scores: dict[str, float]) -> tuple[tuple[str, float], ...]:
        """dict[str, float] を tuple[tuple[str, float], ...] に変換する。"""
        return tuple((k, v) for k, v in scores.items())

    @staticmethod
    def _is_risk_regime(regime: str) -> bool:
        """crisis / bear は高リスクレジームとして扱う。"""
        return regime in ("crisis", "bear")
