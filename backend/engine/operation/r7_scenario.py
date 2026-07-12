"""
R7 Scenario Routine — Card 2-7
Portfolio stress scenario check via L1/L2/L3 drawdown alerts.

No freshness / watchdog / safe_mode pipeline.
Calls evaluate_alerts() from alerts_emitter to check L1/L2/L3 alert levels.
Notification trigger: alerts.highest_level != "NONE".

Detection-only: no trades, no securities API calls.
Caller is responsible for providing portfolio_drawdown and vix from portfolio data.
This routine does not read JSON files.

Capitulation check (OPPORTUNITY alert) is R10's scope.
When capitulation_result is None, a neutral (0-condition) result is used internally.

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 2-7
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from backend.engine.tier_a.alerts_emitter import (
    AlertsPortfolioInput,
    AlertsResult,
    evaluate_alerts,
)
from backend.engine.tier_a.capitulation_signal import (
    CapitulationMarketInput,
    CapitulationResult,
    check_capitulation,
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


# ── Input dataclass ───────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ScenarioPortfolioInput:
    """Portfolio stress scenario input from caller.

    Caller computes portfolio_drawdown from current holdings.
    This dataclass is passed to run_scenario_routine; the routine does not read JSON.
    """
    portfolio_drawdown: float   # current PF drawdown from peak, e.g. -0.12
    vix: float                  # for L1 VIX trigger


# ── Result ────────────────────────────────────────────────────────────────────

@dataclass
class ScenarioRoutineResult:
    portfolio_input: ScenarioPortfolioInput
    alerts: AlertsResult
    scenario_triggered: bool        # True when alerts.highest_level != "NONE"
    notify_result: Optional[NotifyResult]
    recovery_entry: Optional[RecoveryLogEntry]
    recovery_log_written: bool
    completed_at: datetime


# ── Helpers ───────────────────────────────────────────────────────────────────

def _neutral_capitulation() -> CapitulationResult:
    """Return a 0-condition CapitulationResult for use when capitulation data unavailable."""
    return check_capitulation(CapitulationMarketInput(
        vix=0.0,
        nikkei_5d_return=0.0,
        nikkei_rsi_14=50.0,
        nikkei_volume=1.0,
        avg_volume_60d=2.0,
    ))


def format_scenario_embed(
    alerts: AlertsResult,
    portfolio_input: ScenarioPortfolioInput,
) -> DiscordEmbed:
    """Build a Discord embed for R7 Scenario Routine.

    Does not include individual positions, holdings, or personal asset data.
    """
    level = alerts.highest_level
    if level == "L3":
        color = COLOR_RED
        title = "🚨 Scenario: L3 — Survival Mode"
    elif level == "L2":
        color = COLOR_RED
        title = "⚠️ Scenario: L2 — Defensive"
    elif level == "L1":
        color = COLOR_ORANGE
        title = "⚠️ Scenario: L1 — Caution"
    else:
        color = COLOR_GREEN
        title = "✅ Scenario: All Clear"

    fields: list[DiscordEmbedField] = [
        DiscordEmbedField(
            name="portfolio_drawdown",
            value=f"{portfolio_input.portfolio_drawdown:.1%}",
            inline=True,
        ),
        DiscordEmbedField(
            name="vix",
            value=f"{portfolio_input.vix:.1f}",
            inline=True,
        ),
        DiscordEmbedField(
            name="highest_level",
            value=level,
            inline=True,
        ),
    ]
    if alerts.l1.triggered:
        fields.append(DiscordEmbedField(name="L1", value=alerts.l1.action_recommended, inline=False))
    if alerts.l2.triggered:
        fields.append(DiscordEmbedField(name="L2", value=alerts.l2.action_recommended, inline=False))
    if alerts.l3.triggered:
        fields.append(DiscordEmbedField(name="L3", value=alerts.l3.action_recommended, inline=False))

    return DiscordEmbed(
        title=title,
        description="Portfolio stress scenario evaluation.",
        color=color,
        fields=tuple(fields),
    )


def _build_recovery_entry(
    alerts: AlertsResult,
    existing: list[RecoveryLogEntry],
    now: datetime,
) -> Optional[RecoveryLogEntry]:
    if alerts.highest_level == "NONE":
        return None

    triggered_levels = [
        ev.level for ev in [alerts.l1, alerts.l2, alerts.l3] if ev.triggered
    ]
    return build_recovery_entry(
        source="portfolio_scenario",
        error_type="scenario_alert",
        message=f"Scenario alert triggered: levels={triggered_levels}, highest={alerts.highest_level}",
        action_taken=f"scenario_alert_raised_{alerts.highest_level.lower()}",
        occurred_at=now,
        resolved_at=None,
        safe_mode_triggered=False,
        existing_entries=existing,
    )


# ── Main routine ──────────────────────────────────────────────────────────────

def run_scenario_routine(
    portfolio_input: ScenarioPortfolioInput,
    *,
    capitulation_result: Optional[CapitulationResult] = None,
    notifier_config: Optional[DiscordNotifierConfig] = None,
    recovery_log_output_path=None,
    existing_recovery_entries: Optional[list[RecoveryLogEntry]] = None,
    now: Optional[datetime] = None,
) -> ScenarioRoutineResult:
    """Run R7 Scenario Routine: portfolio stress scenario check.

    Detection-only: no trades, no securities API calls.
    Notification triggered when any alert level is active (L1/L2/L3).
    No safe_mode snapshot written (no freshness/watchdog pipeline).

    capitulation_result: pre-computed from check_capitulation(); if None, a
    neutral (0-condition) result is used. OPPORTUNITY alert is R10's scope.
    """
    if now is None:
        now = datetime.now(timezone.utc)
    if existing_recovery_entries is None:
        existing_recovery_entries = []
    if capitulation_result is None:
        capitulation_result = _neutral_capitulation()

    # ── 1. Alerts evaluation ──────────────────────────────────────────────────
    alerts_input = AlertsPortfolioInput(
        portfolio_drawdown=portfolio_input.portfolio_drawdown,
        vix=portfolio_input.vix,
    )
    alerts = evaluate_alerts(alerts_input, capitulation_result)
    scenario_triggered = alerts.highest_level != "NONE"

    # ── 2. Discord notification ───────────────────────────────────────────────
    notify_result: Optional[NotifyResult] = None
    if notifier_config is not None and scenario_triggered:
        embed = format_scenario_embed(alerts, portfolio_input)
        notify_result = send_notification(notifier_config, embed)

    # ── 3. Recovery log entry ─────────────────────────────────────────────────
    recovery_entry = _build_recovery_entry(alerts, existing_recovery_entries, now)

    # ── 4. Write recovery log ─────────────────────────────────────────────────
    recovery_log_written = False
    if recovery_log_output_path is not None and recovery_entry is not None:
        updated_entries = append_recovery_entry(existing_recovery_entries, recovery_entry)
        write_recovery_log(updated_entries, recovery_log_output_path)
        recovery_log_written = True

    return ScenarioRoutineResult(
        portfolio_input=portfolio_input,
        alerts=alerts,
        scenario_triggered=scenario_triggered,
        notify_result=notify_result,
        recovery_entry=recovery_entry,
        recovery_log_written=recovery_log_written,
        completed_at=now,
    )
