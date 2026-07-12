"""
risk_manager.py — Card 6-4
Phase 6 Agents: Risk Manager specialist skeleton。

責務:
  - 下落シナリオ監査観点（safety / quality_value）から factor_scores を解釈する
  - deterministic rule stub のみ。実LLM接続なし。
  - BUY/SELL/HOLD/WAIT 禁止。売買命令は返さない。

confidence（Risk Manager のみ反転）:
  raw = mean(focus_scores) / 100.0
  confidence = 1.0 - raw（低スコア = 高リスク意識 = 高 confidence）
  最後に _clamp_confidence() を通す

crisis/bear regime: concerns に regime 警戒文言を追加

実装しないこと:
  - 実LLM/HTTP接続
  - action / recommendation / is_buy / is_sell / verdict / decision
  - 銘柄推奨・PF最適化・売買判断

Reference: docs/v13.3/07_v13.3_spec.md Section 8.1
"""
from __future__ import annotations

from backend.engine.agents.base_agent import AgentInput, AgentOpinion, BaseAgent


class RiskManager(BaseAgent):
    """
    Risk Manager — 下落シナリオ監査観点の specialist agent。
    focus_area: safety, quality_value
    confidence は 1.0 - mean(focus_scores)/100.0 （反転）。
    """

    role_id:    str           = "risk_manager"
    role_name:  str           = "Risk Manager"
    focus_area: tuple[str, ...] = ("safety", "quality_value")

    def analyze(self, agent_input: AgentInput) -> AgentOpinion:
        scores   = self._get_focus_scores(agent_input.factor_scores)
        mean_s   = self._mean_score(scores)
        # 反転: 低スコア（高リスク）ほど confidence が高い
        conf     = self._clamp_confidence(1.0 - mean_s / 100.0)

        safety_s  = scores.get("safety", 50.0)
        quality_s = scores.get("quality_value", 50.0)

        supportive: list[str] = []
        concerns:   list[str] = []

        # safety スコア分岐（Risk Manager 視点: 低スコアは懸念）
        if safety_s >= 70.0:
            supportive.append(f"safety factor adequate (score={safety_s:.1f}): downside protection appears sufficient")
        elif safety_s >= 50.0:
            concerns.append(f"safety factor moderate (score={safety_s:.1f}): downside risk not fully contained")
        else:
            concerns.append(f"safety factor low (score={safety_s:.1f}): significant downside exposure identified")

        # quality_value スコア分岐
        if quality_s >= 70.0:
            supportive.append(f"quality_value adequate (score={quality_s:.1f}): balance sheet resilience observed")
        elif quality_s >= 50.0:
            concerns.append(f"quality_value moderate (score={quality_s:.1f}): earnings stability not guaranteed")
        else:
            concerns.append(f"quality_value low (score={quality_s:.1f}): deteriorating fundamentals raise tail-risk")

        # regime 警戒
        if agent_input.regime == "crisis":
            concerns.append(
                f"regime=crisis: tail-risk is extreme; correlation spikes and liquidity stress expected"
            )
        elif agent_input.regime == "bear":
            concerns.append(
                f"regime=bear: sustained drawdown risk; factor diversification may fail as correlations rise"
            )

        if not supportive:
            supportive.append(
                f"risk perspective: monitoring downside scenarios (mean_score={mean_s:.1f})"
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
