"""
execution_specialist.py — Card 6-4
Phase 6 Agents: Execution Specialist specialist skeleton。

責務:
  - 執行タイミング観点（technical_momentum）から factor_scores を解釈する
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


class ExecutionSpecialist(BaseAgent):
    """
    Execution Specialist — 執行タイミング観点の specialist agent。
    focus_area: technical_momentum
    """

    role_id:    str           = "execution_specialist"
    role_name:  str           = "Execution Specialist"
    focus_area: tuple[str, ...] = ("technical_momentum",)

    def analyze(self, agent_input: AgentInput) -> AgentOpinion:
        scores     = self._get_focus_scores(agent_input.factor_scores)
        mean_s     = self._mean_score(scores)
        conf       = self._clamp_confidence(mean_s / 100.0)

        momentum_s = scores.get("technical_momentum", 50.0)

        supportive: list[str] = []
        concerns:   list[str] = []

        # technical_momentum スコア分岐（執行タイミング視点）
        if momentum_s >= 75.0:
            supportive.append(
                f"technical_momentum strong (score={momentum_s:.1f}): price trend supportive of entry timing"
            )
        elif momentum_s >= 55.0:
            supportive.append(
                f"technical_momentum moderate (score={momentum_s:.1f}): timing is acceptable, trend is positive"
            )
        elif momentum_s >= 40.0:
            concerns.append(
                f"technical_momentum neutral (score={momentum_s:.1f}): trend is weak, timing may be suboptimal"
            )
        else:
            concerns.append(
                f"technical_momentum weak (score={momentum_s:.1f}): adverse price trend detected, timing risk elevated"
            )

        # regime 警戒
        if agent_input.regime == "crisis":
            concerns.append(
                f"regime=crisis: execution risk is high; wide bid-ask spreads and thin liquidity expected"
            )
        elif agent_input.regime == "bear":
            concerns.append(
                f"regime=bear: catching falling knife risk; adverse momentum may persist"
            )

        if not supportive:
            supportive.append(
                f"execution perspective: monitoring timing signals (score={momentum_s:.1f})"
            )

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
