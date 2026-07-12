"""
adversarial_self_check.py — Card 6-5
Phase 6 Agents: Adversarial Self-Check — deterministic 反証・懸念抽出層。

責務:
  - AdversarialCheckInput  — AdversarialSelfCheck への入力
  - AdversarialCheckResult — 反証チェック結果を保持する frozen dataclass
  - AdversarialSelfCheck   — review() で AdversarialCheckResult を返すクラス

spec §8.2 の設計（Pro/Anti Thesis + Evaluator）を deterministic stub で近似する。
  - _build_pro_points():         ManagerSummary.all_supportive を pro 論点として整形
  - _build_counter_points():     ManagerSummary.all_concerns を反証視点で強化
  - _detect_adversarial_flags(): regime / consensus_strength / concern_count でパターン検出
  - _detect_missing_evidence():  average_confidence / agent_count から情報不足を列挙
  - _calc_risk_level():          concern_count / consensus_strength → "low" / "moderate" / "high"

risk_level / is_high_risk について:
  - 「懸念の多さ・consensus の低さから計算したリスク区分」であり売買判断ではない
  - is_high_risk は risk_level == "high" の観察値フラグ
  - is_buy / is_sell / is_hold / is_recommended のような売買命令ではない
  - Committee Orchestrator (Card 6-6) がこれらを材料に最終的な扱い方を決める

実装しないこと:
  - call_llm_json()（実LLM接続）
  - CommitteeOrchestrator（Card 6-6）
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / rating / approve / reject / conditional
  - 売買判断・注文生成・銘柄推奨・PF最適化
  - pandas / numpy
  - operation / market_intel / news / regime の直接 import

Reference: docs/v13.3/07_v13.3_spec.md Section 8.2
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 6-5
"""
from __future__ import annotations

from dataclasses import dataclass, field

from backend.engine.agents.manager import ManagerSummary


# ── AdversarialCheckInput ─────────────────────────────────────────────────────

@dataclass(frozen=True)
class AdversarialCheckInput:
    """
    AdversarialSelfCheck への入力。immutable。

    summary: AgentManager が生成した ManagerSummary（DI）。
    context: 追加情報（任意）。mutable default 禁止のため default_factory。

    action/recommendation 等の判断フィールドは持たない。
    """

    summary: ManagerSummary
    ticker:  str
    context: dict = field(default_factory=dict)


# ── AdversarialCheckResult ────────────────────────────────────────────────────

@dataclass(frozen=True)
class AdversarialCheckResult:
    """
    Adversarial Self-Check の結果。immutable。

    「分析上の反証・懸念・情報不足を整理した情報」であり売買命令ではない。

    risk_level: "low" / "moderate" / "high" の計算上のリスク区分。
      concern_count と consensus_strength から deterministic に決定する。
      「懸念が多い / 一致度が低い」という観察的事実の区分であり、売買判断ではない。

    is_high_risk: 観察値フラグ。risk_level == "high" のとき True。
      「高リスク区分が計算された」という事実。
      is_buy / is_sell / is_hold / is_recommended とは別物 — 売買命令ではない。
      Committee Orchestrator (Card 6-6) がこれを材料に扱う。

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / rating / approve / reject / conditional
    """

    ticker:            str
    pro_points:        tuple[str, ...]  # supportive から抽出した肯定論点
    counter_points:    tuple[str, ...]  # concerns を反証視点で強化した論点
    missing_evidence:  tuple[str, ...]  # 情報不足フラグ（confidence/agent_count 閾値判定）
    adversarial_flags: tuple[str, ...]  # 懸念パターン（regime/consensus）
    risk_level:        str              # "low" / "moderate" / "high"（観察値）
    is_high_risk:      bool             # 観察値フラグ: risk_level == "high"

    def to_dict(self) -> dict:
        """JSON serializable な dict を返す（str / bool / list のみ）。"""
        return {
            "ticker":            self.ticker,
            "pro_points":        list(self.pro_points),
            "counter_points":    list(self.counter_points),
            "missing_evidence":  list(self.missing_evidence),
            "adversarial_flags": list(self.adversarial_flags),
            "risk_level":        self.risk_level,
            "is_high_risk":      self.is_high_risk,
        }


# ── AdversarialSelfCheck ──────────────────────────────────────────────────────

class AdversarialSelfCheck:
    """
    ManagerSummary を入力として受け取り、反証・懸念抽出を deterministic rule で実施する。

    spec §8.2 の Pro/Anti Thesis + Evaluator 構造を LLM なしで近似する。
    review() は pure computation: DI された入力のみを使い副作用なし。
    売買判断・注文生成は行わない。
    """

    # missing_evidence 判定の閾値
    LOW_CONFIDENCE_THRESHOLD: float = 0.4
    FULL_AGENT_COUNT: int = 6

    def review(self, check_input: AdversarialCheckInput) -> AdversarialCheckResult:
        """
        ManagerSummary を受け取り AdversarialCheckResult を返す。

        Args:
            check_input: AdversarialCheckInput（summary / ticker / context）
        Returns:
            AdversarialCheckResult
        """
        summary = check_input.summary

        pro_points        = self._build_pro_points(summary)
        counter_points    = self._build_counter_points(summary)
        adversarial_flags = self._detect_adversarial_flags(summary)
        missing_evidence  = self._detect_missing_evidence(summary)
        risk_level        = self._calc_risk_level(summary)

        return AdversarialCheckResult(
            ticker=check_input.ticker,
            pro_points=pro_points,
            counter_points=counter_points,
            missing_evidence=missing_evidence,
            adversarial_flags=adversarial_flags,
            risk_level=risk_level,
            is_high_risk=(risk_level == "high"),
        )

    def _build_pro_points(self, summary: ManagerSummary) -> tuple[str, ...]:
        """
        supportive_points を pro 論点として整形する（deterministic）。

        all_supportive が空の場合は中立的な fallback メッセージを返す。
        """
        if not summary.all_supportive:
            return (
                f"pro: no strong supportive signals observed "
                f"(agent_count={summary.agent_count}, avg_conf={summary.average_confidence:.2f})",
            )

        points: list[str] = []
        for s in summary.all_supportive:
            points.append(f"pro: {s}")
        return tuple(points)

    def _build_counter_points(self, summary: ManagerSummary) -> tuple[str, ...]:
        """
        concerns を反証視点で強化した論点を生成する（deterministic rule）。

        concerns が空の場合は fallback メッセージを返す。
        """
        if not summary.all_concerns:
            return (
                f"counter: no explicit concerns raised — consider whether risks are overlooked "
                f"(concern_count={summary.concern_count})",
            )

        points: list[str] = []
        for c in summary.all_concerns:
            points.append(f"counter: {c}")
        return tuple(points)

    def _detect_adversarial_flags(self, summary: ManagerSummary) -> tuple[str, ...]:
        """
        regime / consensus_strength / concern_count から懸念パターンを検出する。

        crisis / bear regime: 外部環境リスクフラグ
        low consensus:        エージェント間の分析乖離フラグ
        high concern count:   懸念集中フラグ
        """
        flags: list[str] = []

        regime = summary.regime_observed
        if regime == "crisis":
            flags.append(
                "adversarial_flag: regime=crisis — systemic risk scenario; "
                "all factor signals may be overwhelmed by macro stress"
            )
        elif regime == "bear":
            flags.append(
                "adversarial_flag: regime=bear — sustained downtrend; "
                "factor premiums historically compress in bear regimes"
            )
        elif regime == "bull_volatile":
            flags.append(
                "adversarial_flag: regime=bull_volatile — elevated volatility; "
                "signal-to-noise ratio is lower than bull_calm"
            )

        if summary.consensus_strength < 0.3:
            flags.append(
                f"adversarial_flag: low_consensus (consensus_strength={summary.consensus_strength:.2f}) — "
                "agents disagree significantly; analysis uncertainty is high"
            )
        elif summary.consensus_strength < 0.5:
            flags.append(
                f"adversarial_flag: moderate_consensus (consensus_strength={summary.consensus_strength:.2f}) — "
                "partial disagreement among agents"
            )

        if summary.concern_count >= 6:
            flags.append(
                f"adversarial_flag: high_concern_density (concern_count={summary.concern_count}) — "
                "multiple agents raised concerns; aggregate risk is elevated"
            )

        if not flags:
            flags.append(
                f"adversarial_flag: none — no critical patterns detected "
                f"(regime={regime}, consensus={summary.consensus_strength:.2f})"
            )

        return tuple(flags)

    def _detect_missing_evidence(self, summary: ManagerSummary) -> tuple[str, ...]:
        """
        average_confidence / agent_count から情報不足を列挙する。

        average_confidence < LOW_CONFIDENCE_THRESHOLD → 分析確信度不足
        agent_count < FULL_AGENT_COUNT → エージェント不足
        """
        missing: list[str] = []

        if summary.average_confidence < self.LOW_CONFIDENCE_THRESHOLD:
            missing.append(
                f"missing_evidence: low average_confidence ({summary.average_confidence:.2f} < "
                f"{self.LOW_CONFIDENCE_THRESHOLD}) — factor scores may lack sufficient signal strength"
            )

        if summary.agent_count < self.FULL_AGENT_COUNT:
            missing.append(
                f"missing_evidence: incomplete agent coverage "
                f"(agent_count={summary.agent_count} < {self.FULL_AGENT_COUNT}) — "
                "some analytical perspectives are absent"
            )

        return tuple(missing)

    def _calc_risk_level(self, summary: ManagerSummary) -> str:
        """
        concern_count と consensus_strength から観察的リスク区分を計算する。

        "high":     concern_count >= 6 または consensus_strength < 0.3
        "moderate": concern_count >= 3 または consensus_strength < 0.5
        "low":      それ以外

        この区分は「懸念の多さ・一致度の低さ」という観察事実の整理であり売買判断ではない。
        """
        if summary.concern_count >= 6 or summary.consensus_strength < 0.3:
            return "high"
        if summary.concern_count >= 3 or summary.consensus_strength < 0.5:
            return "moderate"
        return "low"
