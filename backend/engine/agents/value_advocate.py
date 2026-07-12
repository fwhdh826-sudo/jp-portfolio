"""
value_advocate.py — Card 6-4
Phase 6 Agents: Value Advocate specialist skeleton。

責務:
  - バリュー観点（value / shareholder_return）から factor_scores を解釈する
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


class ValueAdvocate(BaseAgent):
    """
    Value Advocate — バリュー観点の specialist agent。
    focus_area: value, shareholder_return
    """

    role_id:    str           = "value_advocate"
    role_name:  str           = "Value Advocate"
    focus_area: tuple[str, ...] = ("value", "shareholder_return")

    def analyze(self, agent_input: AgentInput) -> AgentOpinion:
        scores  = self._get_focus_scores(agent_input.factor_scores)
        mean_s  = self._mean_score(scores)
        conf    = self._clamp_confidence(mean_s / 100.0)

        value_s = scores.get("value", 50.0)
        sr_s    = scores.get("shareholder_return", 50.0)

        supportive: list[str] = []
        concerns:   list[str] = []

        # value スコア分岐
        if value_s >= 70.0:
            supportive.append(f"value factor strong (score={value_s:.1f}): attractive valuation observed")
        elif value_s >= 50.0:
            supportive.append(f"value factor moderate (score={value_s:.1f}): valuation is acceptable")
        else:
            concerns.append(f"value factor weak (score={value_s:.1f}): valuation may be stretched")

        # shareholder_return スコア分岐
        if sr_s >= 70.0:
            supportive.append(f"shareholder_return strong (score={sr_s:.1f}): robust return-of-capital profile")
        elif sr_s >= 50.0:
            supportive.append(f"shareholder_return moderate (score={sr_s:.1f}): adequate yield/buyback")
        else:
            concerns.append(f"shareholder_return weak (score={sr_s:.1f}): limited return-of-capital")

        # regime 警戒
        if self._is_risk_regime(agent_input.regime):
            concerns.append(
                f"regime={agent_input.regime}: value traps possible in deteriorating market conditions"
            )

        # fallback: supportive_points が空なら neutral 文言
        if not supportive:
            supportive.append(f"value perspective: no strong positive signals (mean_score={mean_s:.1f})")

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
