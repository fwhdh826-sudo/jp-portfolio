"""
R9 Tier A Routine — Card 2-7
Full Tier A gate execution: hard_gate + soft_penalty + capitulation_signal + alerts_emitter.

No freshness / watchdog / safe_mode pipeline.
Calls all 4 Tier A modules and aggregates results into TierARoutineResult.

tier_a_triggered: True when hard_gate.any_triggered OR alerts.highest_level != "NONE".
Notification trigger: tier_a_triggered OR soft_penalty.any_severe.
Recovery log: written when tier_a_triggered (not soft_penalty.any_severe alone).

Detection-only: no trades, no securities API calls.
Caller is responsible for constructing all input dataclasses from portfolio data.
This routine does not read JSON files.

Sequence:
  check_capitulation(cap_market_input)
  → evaluate_hard_gate(portfolio_input, market_input)  [uses capitulation result]
  → evaluate_soft_penalty(soft_portfolio_input)
  → evaluate_alerts(alerts_portfolio_input, capitulation)

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 2-7
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from backend.engine.tier_a.tier_a_hard_gate import (
    PortfolioInput,
    MarketInput,
    HardGateResult,
    evaluate_hard_gate,
)
from backend.engine.tier_a.tier_a_soft_penalty import (
    SoftPortfolioInput,
    SoftPenaltyResult,
    evaluate_soft_penalty,
)
from backend.engine.tier_a.capitulation_signal import (
    CapitulationMarketInput,
    CapitulationResult,
    check_capitulation,
)
from backend.engine.tier_a.alerts_emitter import (
    AlertsPortfolioInput,
    AlertsResult,
    evaluate_alerts,
)
from backend.engine.operation.discord_notifier import (
    DiscordNotifierConfig,
    DiscordEmbed,
    DiscordEmbedField,
    NotifyResult,
    COLOR_RED,
    COLOR_ORANGE,
    COLOR_GREEN,
    send_notification,
)
from backend.engine.operation.recovery_log_writer import (
    RecoveryLogEntry,
    append_recovery_entry,
    build_recovery_entry,
    write_recovery_log,
)


# ── Result ────────────────────────────────────────────────────────────────────

@dataclass
class TierARoutineResult:
    hard_gate: HardGateResult
    soft_penalty: SoftPenaltyResult
    capitulation: CapitulationResult
    alerts: AlertsResult
    tier_a_triggered: bool      # hard_gate.any_triggered OR alerts.highest_level != "NONE"
    notify_result: Optional[NotifyResult]
    recovery_entry: Optional[RecoveryLogEntry]
    recovery_log_written: bool
    completed_at: datetime


# ── Embed formatter ───────────────────────────────────────────────────────────

def format_tier_a_embed(
    hard_gate: HardGateResult,
    soft_penalty: SoftPenaltyResult,
    capitulation: CapitulationResult,
    alerts: AlertsResult,
) -> DiscordEmbed:
    """Build a Discord embed for R9 Tier A Routine.

    Does not include individual positions, holdings, or personal asset data.
    """
    level = alerts.highest_level
    if hard_gate.any_triggered and hard_gate.safe_mode_recommended:
        color = COLOR_RED
        title = "🚨 Tier A: Hard Gate — Safe Mode Recommended"
    elif hard_gate.any_triggered:
        color = COLOR_RED
        title = "🚨 Tier A: Hard Gate Violation"
    elif level not in ("NONE", ""):
        color = COLOR_ORANGE
        title = f"⚠️ Tier A: Alert {level}"
    elif soft_penalty.any_severe:
        color = COLOR_ORANGE
        title = "⚠️ Tier A: Soft Penalty Severe"
    else:
        color = COLOR_GREEN
        title = "✅ Tier A: All Clear"

    fields: list[DiscordEmbedField] = []
    if hard_gate.any_triggered:
        violated = [v.rule_id for v in hard_gate.violations if v.triggered]
        fields.append(DiscordEmbedField(
            name="Hard Gate Violations", value=", ".join(violated), inline=False
        ))
    if soft_penalty.any_severe:
        severe_rules = [v.rule_id for v in soft_penalty.violations if v.severity == "severe"]
        fields.append(DiscordEmbedField(
            name="Soft Penalty Severe", value=", ".join(severe_rules), inline=False
        ))
    fields.append(DiscordEmbedField(
        name="Capitulation",
        value=f"{capitulation.conditions_met}/4 ({capitulation.alert_level})",
        inline=True,
    ))
    fields.append(DiscordEmbedField(
        name="Alert Level", value=level, inline=True
    ))
    fields.append(DiscordEmbedField(
        name="total_penalty",
        value=f"{soft_penalty.total_penalty:.2f}",
        inline=True,
    ))

    return DiscordEmbed(
        title=title,
        description="Tier A gate evaluation: hard + soft + capitulation + alerts.",
        color=color,
        fields=tuple(fields),
    )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _build_recovery_entry(
    hard_gate: HardGateResult,
    alerts: AlertsResult,
    capitulation: CapitulationResult,
    existing: list[RecoveryLogEntry],
    now: datetime,
) -> Optional[RecoveryLogEntry]:
    tier_a_triggered = hard_gate.any_triggered or alerts.highest_level != "NONE"
    if not tier_a_triggered:
        return None

    if hard_gate.any_triggered:
        violated = [v.rule_id for v in hard_gate.violations if v.triggered]
        source = "tier_a"
        error_type = "hard_gate_violation"
        message = f"Tier A hard gate violations: {violated}"
        action_taken = "tier_a_hard_gate_alert_raised"
    else:
        source = "tier_a"
        error_type = "scenario_alert"
        message = f"Tier A alerts triggered: highest={alerts.highest_level}"
        action_taken = f"tier_a_alert_raised_{alerts.highest_level.lower()}"

    return build_recovery_entry(
        source=source,
        error_type=error_type,
        message=message,
        action_taken=action_taken,
        occurred_at=now,
        resolved_at=None,
        safe_mode_triggered=hard_gate.safe_mode_recommended,
        existing_entries=existing,
    )


# ── Main routine ──────────────────────────────────────────────────────────────

def run_tier_a_routine(
    portfolio_input: PortfolioInput,
    cap_market_input: CapitulationMarketInput,
    soft_portfolio_input: SoftPortfolioInput,
    alerts_portfolio_input: AlertsPortfolioInput,
    nikkei_daily_returns: list[float],
    *,
    notifier_config: Optional[DiscordNotifierConfig] = None,
    recovery_log_output_path=None,
    existing_recovery_entries: Optional[list[RecoveryLogEntry]] = None,
    now: Optional[datetime] = None,
) -> TierARoutineResult:
    """Run R9 Tier A Routine: full Tier A gate execution.

    Detection-only: no trades, no securities API calls.
    Calls all 4 Tier A modules in sequence:
      check_capitulation → evaluate_hard_gate → evaluate_soft_penalty → evaluate_alerts

    Notification triggered when tier_a_triggered=True or soft_penalty.any_severe.
    Recovery log written when tier_a_triggered (not soft_penalty alone).

    nikkei_daily_returns: daily returns list for T4 check (newest last, length >= 3).
    cap_market_input.vix is used for both capitulation and hard gate T4 check.
    """
    if now is None:
        now = datetime.now(timezone.utc)
    if existing_recovery_entries is None:
        existing_recovery_entries = []

    # ── 1. Tier A pipeline ────────────────────────────────────────────────────
    capitulation = check_capitulation(cap_market_input)

    market_input = MarketInput(
        vix=cap_market_input.vix,
        nikkei_daily_returns=nikkei_daily_returns,
        is_capitulation_signal=capitulation.is_capitulation,
    )
    hard_gate = evaluate_hard_gate(portfolio_input, market_input)
    soft_penalty = evaluate_soft_penalty(soft_portfolio_input)
    alerts = evaluate_alerts(alerts_portfolio_input, capitulation)

    # ── 2. tier_a_triggered ───────────────────────────────────────────────────
    tier_a_triggered = hard_gate.any_triggered or alerts.highest_level != "NONE"

    # ── 3. Discord notification ───────────────────────────────────────────────
    notify_result: Optional[NotifyResult] = None
    if notifier_config is not None and (tier_a_triggered or soft_penalty.any_severe):
        embed = format_tier_a_embed(hard_gate, soft_penalty, capitulation, alerts)
        notify_result = send_notification(notifier_config, embed)

    # ── 4. Recovery log entry ─────────────────────────────────────────────────
    recovery_entry = _build_recovery_entry(
        hard_gate, alerts, capitulation, existing_recovery_entries, now
    )

    # ── 5. Write recovery log ─────────────────────────────────────────────────
    recovery_log_written = False
    if recovery_log_output_path is not None and recovery_entry is not None:
        updated_entries = append_recovery_entry(existing_recovery_entries, recovery_entry)
        write_recovery_log(updated_entries, recovery_log_output_path)
        recovery_log_written = True

    return TierARoutineResult(
        hard_gate=hard_gate,
        soft_penalty=soft_penalty,
        capitulation=capitulation,
        alerts=alerts,
        tier_a_triggered=tier_a_triggered,
        notify_result=notify_result,
        recovery_entry=recovery_entry,
        recovery_log_written=recovery_log_written,
        completed_at=now,
    )
