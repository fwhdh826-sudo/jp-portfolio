"""
behavioral_coach.py — Card 6-4
Phase 6 Agents: Behavioral Coach specialist skeleton。

責務:
  - 投資家心理・バイアス観点（shareholder_return）から factor_scores と regime を解釈する
  - deterministic rule stub のみ。実LLM接続なし。
  - BUY/SELL/HOLD/WAIT 禁止。売買命令は返さない。

confidence: mean(focus_scores) / 100.0、_clamp_confidence() を通す
crisis/bear regime: concerns に regime 警戒文言（パニック売り / 損失回避バイアス）を追加

実装しないこと:
  - 実LLM/HTTP接続
  - action / recommendation / is_buy / is_sell / verdict / decision
  - 銘柄推奨・PF最適化・売買判断

Reference: docs/v13.3/07_v13.3_spec.md Section 8.1
"""
from __future__ import annotations

from backend.engine.agents.base_agent import AgentInput, AgentOpinion, BaseAgent


class BehavioralCoach(BaseAgent):
    """
    Behavioral Coach — 投資家心理・バイアス観点の specialist agent。
    focus_area: shareholder_return
    """

    role_id:    str           = "behavioral_coach"
    role_name:  str           = "Behavioral Coach"
    focus_area: tuple[str, ...] = ("shareholder_return",)

    def analyze(self, agent_input: AgentInput) -> AgentOpinion:
        scores  = self._get_focus_scores(agent_input.factor_scores)
        mean_s  = self._mean_score(scores)
        conf    = self._clamp_confidence(mean_s / 100.0)

        sr_s    = scores.get("shareholder_return", 50.0)
        regime  = agent_input.regime

        supportive: list[str] = []
        concerns:   list[str] = []

        # shareholder_return スコア分岐（行動コーチ視点）
        if sr_s >= 70.0:
            supportive.append(
                f"shareholder_return strong (score={sr_s:.1f}): consistent return-of-capital may anchor investor confidence"
            )
        elif sr_s >= 50.0:
            supportive.append(
                f"shareholder_return moderate (score={sr_s:.1f}): yield/buyback provides modest behavioral anchor"
            )
        else:
            concerns.append(
                f"shareholder_return weak (score={sr_s:.1f}): lack of yield may heighten disposition-effect risk"
            )

        # regime 別バイアス警戒
        if regime == "crisis":
            concerns.append(
                f"regime=crisis: panic-selling and loss-aversion bias are at peak; emotional decision-making risk is high"
            )
        elif regime == "bear":
            concerns.append(
                f"regime=bear: loss-aversion bias may lead to premature capitulation; recency bias is elevated"
            )
        elif regime == "bull_volatile":
            concerns.append(
                f"regime=bull_volatile: overconfidence and FOMO bias risk in volatile upswing; discipline check recommended"
            )
        elif regime == "bull_calm":
            supportive.append(
                f"regime=bull_calm: complacency risk is low; behavioral environment is supportive"
            )

        if not supportive:
            supportive.append(
                f"behavioral perspective: monitoring investor psychology (score={sr_s:.1f})"
            )

        return AgentOpinion(
            role_id=self.role_id,
            role_name=self.role_name,
            focus_area=self.focus_area,
            confidence=conf,
            supportive_points=tuple(supportive),
            concerns=tuple(concerns),
            factor_scores_used=self._scores_to_tuple(scores),
            regime_observed=regime,
        )
