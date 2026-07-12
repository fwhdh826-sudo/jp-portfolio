"""
R10 Capitulation Deploy Routine — Card 2-7
Capitulation Signal detection and deploy recommendation generation.

No freshness / watchdog / safe_mode pipeline.
Calls check_capitulation() and generates DeployRecommendation when 4 conditions met.

DETECTION-ONLY. DeployRecommendation is a recommendation record only.
No actual fund deployment, no securities API calls, no money transfer.

deploy_recommendation: populated only when is_capitulation=True (all 4 conditions).
Notification trigger: is_capitulation OR is_partial_capitulation.
Recovery log: written when is_capitulation OR is_partial_capitulation (with path).

Reference: docs/v13.3/07_v13.3_spec.md Section 7.3 / 9.3
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 2-7
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

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

# ── Deploy constants (07_spec.md §9.3 / §11.4) ────────────────────────────────
DEPLOY_ACTION: str = "deploy_strategic_cash_4m_jpy_recommended"
DEPLOY_AMOUNT_JPY: int = 4_000_000
DEPLOY_TARGET: str = "core_global"


# ── Deploy recommendation ─────────────────────────────────────────────────────

@dataclass(frozen=True)
class DeployRecommendation:
    """Deployment recommendation generated when Capitulation Signal is active.

    DETECTION-ONLY. This dataclass records what is recommended.
    No actual fund deployment or securities API calls occur here.
    Final execution decision belongs entirely to the user.
    """
    action: str          # DEPLOY_ACTION constant
    amount_jpy: int      # recommended deploy amount in JPY
    target: str          # "core_global"
    conditions_met: int  # 4 (all conditions required for full capitulation)


# ── Result ────────────────────────────────────────────────────────────────────

@dataclass
class CapitulationDeployRoutineResult:
    capitulation: CapitulationResult
    deploy_recommendation: Optional[DeployRecommendation]  # None unless is_capitulation
    notify_result: Optional[NotifyResult]
    recovery_entry: Optional[RecoveryLogEntry]
    recovery_log_written: bool
    completed_at: datetime


# ── Embed formatter ───────────────────────────────────────────────────────────

def format_capitulation_embed(
    capitulation: CapitulationResult,
    deploy_recommendation: Optional[DeployRecommendation],
) -> DiscordEmbed:
    """Build a Discord embed for R10 Capitulation Deploy Routine.

    Does not include individual positions, holdings, or personal asset data.
    """
    if capitulation.is_capitulation:
        color = COLOR_RED
        title = "🔴 CAPITULATION SIGNAL — OPPORTUNITY"
    else:
        color = COLOR_ORANGE
        title = f"⚠️ Capitulation Watch — {capitulation.conditions_met}/4 条件成立"

    fields: list[DiscordEmbedField] = [
        DiscordEmbedField(
            name="conditions_met",
            value=f"{capitulation.conditions_met}/4",
            inline=True,
        ),
        DiscordEmbedField(
            name="alert_level",
            value=capitulation.alert_level,
            inline=True,
        ),
        DiscordEmbedField(
            name="is_capitulation",
            value=str(capitulation.is_capitulation),
            inline=True,
        ),
    ]
    for name, cond in capitulation.conditions.items():
        fields.append(DiscordEmbedField(
            name=name,
            value=f"{'✓' if cond.met else '✗'} ({cond.current_value:.2f})",
            inline=True,
        ))
    if deploy_recommendation is not None:
        fields.append(DiscordEmbedField(
            name="Deploy Recommendation",
            value=f"{deploy_recommendation.action} ({deploy_recommendation.amount_jpy:,} JPY → {deploy_recommendation.target})",
            inline=False,
        ))

    return DiscordEmbed(
        title=title,
        description="Capitulation Signal detection. Deploy recommendation is advisory only.",
        color=color,
        fields=tuple(fields),
    )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _build_deploy_recommendation(
    capitulation: CapitulationResult,
) -> Optional[DeployRecommendation]:
    if not capitulation.is_capitulation:
        return None
    return DeployRecommendation(
        action=DEPLOY_ACTION,
        amount_jpy=DEPLOY_AMOUNT_JPY,
        target=DEPLOY_TARGET,
        conditions_met=capitulation.conditions_met,
    )


def _build_recovery_entry(
    capitulation: CapitulationResult,
    deploy_recommendation: Optional[DeployRecommendation],
    existing: list[RecoveryLogEntry],
    now: datetime,
) -> Optional[RecoveryLogEntry]:
    if not (capitulation.is_capitulation or capitulation.is_partial_capitulation):
        return None

    if capitulation.is_capitulation:
        error_type = "capitulation_signal_full"
        message = f"Capitulation Signal FULL: {capitulation.conditions_met}/4 conditions met. Deploy recommended."
        action_taken = DEPLOY_ACTION
    else:
        error_type = "capitulation_signal_partial"
        message = f"Capitulation Signal PARTIAL: {capitulation.conditions_met}/4 conditions met. Monitoring."
        action_taken = "capitulation_partial_alert_raised"

    return build_recovery_entry(
        source="capitulation_signal",
        error_type=error_type,
        message=message,
        action_taken=action_taken,
        occurred_at=now,
        resolved_at=None,
        safe_mode_triggered=False,
        existing_entries=existing,
    )


# ── Main routine ──────────────────────────────────────────────────────────────

def run_capitulation_routine(
    market_input: CapitulationMarketInput,
    *,
    notifier_config: Optional[DiscordNotifierConfig] = None,
    recovery_log_output_path=None,
    existing_recovery_entries: Optional[list[RecoveryLogEntry]] = None,
    now: Optional[datetime] = None,
) -> CapitulationDeployRoutineResult:
    """Run R10 Capitulation Deploy Routine.

    Detection-only: no trades, no securities API calls.
    DeployRecommendation is generated as a recommendation record only.
    No actual fund deployment occurs. Final execution is the user's decision.

    Notification: when is_capitulation OR is_partial_capitulation.
    deploy_recommendation: only when is_capitulation=True (all 4 conditions met).
    """
    if now is None:
        now = datetime.now(timezone.utc)
    if existing_recovery_entries is None:
        existing_recovery_entries = []

    # ── 1. Capitulation detection ─────────────────────────────────────────────
    capitulation = check_capitulation(market_input)

    # ── 2. Deploy recommendation (detection-only) ─────────────────────────────
    deploy_recommendation = _build_deploy_recommendation(capitulation)

    # ── 3. Discord notification ───────────────────────────────────────────────
    notify_result: Optional[NotifyResult] = None
    should_notify = capitulation.is_capitulation or capitulation.is_partial_capitulation
    if notifier_config is not None and should_notify:
        embed = format_capitulation_embed(capitulation, deploy_recommendation)
        notify_result = send_notification(notifier_config, embed)

    # ── 4. Recovery log entry ─────────────────────────────────────────────────
    recovery_entry = _build_recovery_entry(
        capitulation, deploy_recommendation, existing_recovery_entries, now
    )

    # ── 5. Write recovery log ─────────────────────────────────────────────────
    recovery_log_written = False
    if recovery_log_output_path is not None and recovery_entry is not None:
        updated_entries = append_recovery_entry(existing_recovery_entries, recovery_entry)
        write_recovery_log(updated_entries, recovery_log_output_path)
        recovery_log_written = True

    return CapitulationDeployRoutineResult(
        capitulation=capitulation,
        deploy_recommendation=deploy_recommendation,
        notify_result=notify_result,
        recovery_entry=recovery_entry,
        recovery_log_written=recovery_log_written,
        completed_at=now,
    )
