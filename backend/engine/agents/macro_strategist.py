"""
macro_strategist.py — Card 6-4
Phase 6 Agents: Macro Strategist specialist skeleton。

責務:
  - 市況・地政学観点（technical_momentum / safety）から factor_scores と regime を解釈する
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


class MacroStrategist(BaseAgent):
    """
    Macro Strategist — 市況・地政学観点の specialist agent。
    focus_area: technical_momentum, safety
    """

    role_id:    str           = "macro_strategist"
    role_name:  str           = "Macro Strategist"
    focus_area: tuple[str, ...] = ("technical_momentum", "safety")

    def analyze(self, agent_input: AgentInput) -> AgentOpinion:
        scores   = self._get_focus_scores(agent_input.factor_scores)
        mean_s   = self._mean_score(scores)
        conf     = self._clamp_confidence(mean_s / 100.0)

        momentum_s = scores.get("technical_momentum", 50.0)
        safety_s   = scores.get("safety", 50.0)
        regime     = agent_input.regime

        supportive: list[str] = []
        concerns:   list[str] = []

        # technical_momentum スコア分岐
        if momentum_s >= 70.0:
            supportive.append(f"technical_momentum strong (score={momentum_s:.1f}): price trend favorable")
        elif momentum_s >= 50.0:
            supportive.append(f"technical_momentum moderate (score={momentum_s:.1f}): trend is neutral-to-positive")
        else:
            concerns.append(f"technical_momentum weak (score={momentum_s:.1f}): downtrend or momentum reversal risk")

        # safety スコア分岐
        if safety_s >= 70.0:
            supportive.append(f"safety factor strong (score={safety_s:.1f}): macro environment relatively stable")
        elif safety_s >= 50.0:
            supportive.append(f"safety factor moderate (score={safety_s:.1f}): macro risk is contained")
        else:
            concerns.append(f"safety factor weak (score={safety_s:.1f}): macro tail risks elevated")

        # regime 分岐
        if regime == "crisis":
            concerns.append(
                f"regime=crisis: systemic risk elevated; macro headwinds are severe and may override factor signals"
            )
        elif regime == "bear":
            concerns.append(
                f"regime=bear: sustained downtrend; macro backdrop unfavorable for risk assets"
            )
        elif regime == "bull_volatile":
            concerns.append(
                f"regime=bull_volatile: positive trend but elevated volatility; timing risk is higher"
            )
        elif regime == "bull_calm":
            supportive.append(f"regime=bull_calm: macro environment supports risk-taking")

        if not supportive:
            supportive.append(f"macro perspective: no strong positive signals (mean_score={mean_s:.1f})")

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
