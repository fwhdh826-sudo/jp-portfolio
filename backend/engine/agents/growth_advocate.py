"""
growth_advocate.py — Card 6-4
Phase 6 Agents: Growth Advocate specialist skeleton。

責務:
  - 成長性・優位性観点（growth / quality_value）から factor_scores を解釈する
  - deterministic rule stub のみ。実LLM接続なし。
  - BUY/SELL/HOLD/WAIT 禁止。売買命令は返さない。

confidence: mean(focus_scores) / 100.0、_clamp_confidence() を通す
crisis/bear regime: concerns に regime 警戒文言を追加

実装しないこと:
  - 実LLM/HTTP接続
  - action / recommendation / is_buy / is_sell / verdict / decision
  - 銘柄推奨・PF最適化・売買判断

Reference: docs/v13.3/07_v13.3_spec.md Section 8.1
"""
from __future__ import annotations

from backend.engine.agents.base_agent import AgentInput, AgentOpinion, BaseAgent


class GrowthAdvocate(BaseAgent):
    """
    Growth Advocate — 成長性・優位性観点の specialist agent。
    focus_area: growth, quality_value
    """

    role_id:    str           = "growth_advocate"
    role_name:  str           = "Growth Advocate"
    focus_area: tuple[str, ...] = ("growth", "quality_value")

    def analyze(self, agent_input: AgentInput) -> AgentOpinion:
        scores   = self._get_focus_scores(agent_input.factor_scores)
        mean_s   = self._mean_score(scores)
        conf     = self._clamp_confidence(mean_s / 100.0)

        growth_s  = scores.get("growth", 50.0)
        quality_s = scores.get("quality_value", 50.0)

        supportive: list[str] = []
        concerns:   list[str] = []

        # growth スコア分岐
        if growth_s >= 70.0:
            supportive.append(f"growth factor strong (score={growth_s:.1f}): solid growth trajectory")
        elif growth_s >= 50.0:
            supportive.append(f"growth factor moderate (score={growth_s:.1f}): growth prospects acceptable")
        else:
            concerns.append(f"growth factor weak (score={growth_s:.1f}): growth momentum may be fading")

        # quality_value スコア分岐
        if quality_s >= 70.0:
            supportive.append(f"quality_value strong (score={quality_s:.1f}): high-quality business fundamentals")
        elif quality_s >= 50.0:
            supportive.append(f"quality_value moderate (score={quality_s:.1f}): adequate business quality")
        else:
            concerns.append(f"quality_value weak (score={quality_s:.1f}): quality concerns noted")

        # regime 警戒
        if self._is_risk_regime(agent_input.regime):
            concerns.append(
                f"regime={agent_input.regime}: high-growth names can de-rate sharply in risk-off environments"
            )

        if not supportive:
            supportive.append(f"growth perspective: no strong positive signals (mean_score={mean_s:.1f})")

        return AgentOpinion(
            role_id=self.role_id,
            role_name=self.role_name,
            focus_area=self.focus_area,
            confidence=conf,
            supportive_points=tuple(supportive),
            concerns=tuple(concerns),
            factor_scores_used=self._scores_to_tuple(scores),
            regime_observed=agent_input.regime,
        )
