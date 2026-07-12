"""
Discord Notifier — Card 2-4
Formats operation-layer events as Discord embeds and sends via webhook.

Detection-only contract: this module sends notifications, it does NOT:
  - execute trades, call securities APIs, or modify SAFE_MODE state
  - embed individual stock positions, holdings ratios, or personal asset info
  - store or log the webhook URL

dry_run=True (default): formats payload, skips HTTP POST.
Caller must explicitly pass dry_run=False to enable live sending.

Webhook URL is NEVER read from os.environ inside this module.
Use load_notifier_config_from_env() to build DiscordNotifierConfig from env.

Reference: public/data/contracts/v13.3/operation/safe_mode.json
Reference: public/data/contracts/v13.3/operation/recovery_log.json
"""
from __future__ import annotations

import json
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from backend.engine.operation.safe_mode import SafeModeResult
from backend.engine.operation.watchdog import WatchdogResult, STATUS_CRITICAL

# ── Embed color constants (Discord color integers) ────────────────────────────

COLOR_RED: int = 0xE74C3C       # SAFE_MODE active / system_error
COLOR_ORANGE: int = 0xE67E22    # watchdog critical (non-system-error)
COLOR_GREEN: int = 0x2ECC71     # recovered / healthy
COLOR_GREY: int = 0x95A5A6      # informational / idle


# ── Config ────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class DiscordNotifierConfig:
    webhook_url: str
    dry_run: bool = True    # safe default: must explicitly opt-in to live sending


# ── Embed dataclasses ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class DiscordEmbedField:
    name: str
    value: str
    inline: bool = False


@dataclass(frozen=True)
class DiscordEmbed:
    title: str
    description: str
    color: int
    fields: tuple[DiscordEmbedField, ...]


# ── Result ────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class NotifyResult:
    message_sent: bool          # True only when HTTP POST succeeded (dry_run=False)
    dry_run: bool
    payload: dict               # serialized Discord webhook payload (always built)
    error: Optional[str]        # None on success or dry_run; error message on failure


# ── Embed formatters ──────────────────────────────────────────────────────────

def format_safe_mode_embed(result: SafeModeResult) -> DiscordEmbed:
    """Format a SafeModeResult as a Discord embed.

    Does not include individual positions, holdings, or personal asset data.
    """
    if result.active:
        title = "⚠️ SAFE_MODE ACTIVATED"
        description = "Operation layer has triggered SAFE_MODE restrictions."
        color = COLOR_RED
        fields: list[DiscordEmbedField] = [
            DiscordEmbedField(
                name="Trigger",
                value=result.trigger_reason or "unknown",
                inline=True,
            ),
            DiscordEmbedField(
                name="Detail",
                value=result.trigger_reason_detail or "—",
                inline=False,
            ),
            DiscordEmbedField(
                name="new_buys_frozen",
                value=str(result.restrictions.new_buys_frozen),
                inline=True,
            ),
            DiscordEmbedField(
                name="rebalance_frozen",
                value=str(result.restrictions.rebalance_frozen),
                inline=True,
            ),
            DiscordEmbedField(
                name="force_sell_active",
                value=str(result.restrictions.force_sell_active),
                inline=True,
            ),
            DiscordEmbedField(
                name="checked_at",
                value=result.checked_at.isoformat(),
                inline=False,
            ),
        ]
    else:
        title = "✅ SAFE_MODE CLEAR"
        description = "All SAFE_MODE conditions are inactive."
        color = COLOR_GREEN
        fields = [
            DiscordEmbedField(
                name="checked_at",
                value=result.checked_at.isoformat(),
                inline=False,
            ),
        ]

    return DiscordEmbed(
        title=title,
        description=description,
        color=color,
        fields=tuple(fields),
    )


def format_watchdog_embed(result: WatchdogResult) -> DiscordEmbed:
    """Format a WatchdogResult as a Discord embed.

    Does not include individual positions, holdings, or personal asset data.
    """
    critical_sources = [
        name for name, r in result.sources.items()
        if r.status == STATUS_CRITICAL
    ]

    if result.system_error:
        title = "🚨 Watchdog: SYSTEM ERROR"
        description = "One or more Tier 1 sources have reached the critical failure threshold."
        color = COLOR_RED
    elif result.any_critical:
        title = "⚠️ Watchdog: Source Critical"
        description = "One or more sources reached the critical failure threshold."
        color = COLOR_ORANGE
    else:
        title = "✅ Watchdog: All Healthy"
        description = "No sources are in critical state."
        color = COLOR_GREEN

    fields: list[DiscordEmbedField] = []
    if critical_sources:
        fields.append(DiscordEmbedField(
            name="Critical Sources",
            value=", ".join(critical_sources),
            inline=False,
        ))

    for name, src in result.sources.items():
        fields.append(DiscordEmbedField(
            name=name,
            value=f"{src.status} (failures={src.consecutive_failures})",
            inline=True,
        ))

    fields.append(DiscordEmbedField(
        name="checked_at",
        value=result.checked_at.isoformat(),
        inline=False,
    ))

    return DiscordEmbed(
        title=title,
        description=description,
        color=color,
        fields=tuple(fields),
    )


# ── Payload builder ───────────────────────────────────────────────────────────

def _build_payload(embed: DiscordEmbed) -> dict:
    """Build Discord webhook JSON payload from a DiscordEmbed."""
    return {
        "embeds": [
            {
                "title": embed.title,
                "description": embed.description,
                "color": embed.color,
                "fields": [
                    {
                        "name": f.name,
                        "value": f.value,
                        "inline": f.inline,
                    }
                    for f in embed.fields
                ],
            }
        ]
    }


# ── HTTP transport (thin wrapper for easy mocking) ────────────────────────────

def _http_post(url: str, payload_json: bytes, timeout: int = 10) -> None:
    """POST payload_json bytes to url. Raises urllib.error.URLError on failure.

    Separated from send_notification to allow unittest.mock.patch replacement.
    Webhook URL is passed as argument; it is never logged or stored here.
    """
    req = urllib.request.Request(
        url,
        data=payload_json,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout):
        pass


# ── Main send function ────────────────────────────────────────────────────────

def send_notification(
    config: DiscordNotifierConfig,
    embed: DiscordEmbed,
) -> NotifyResult:
    """Send a Discord notification.

    If config.dry_run is True (the default), no HTTP request is made.
    payload is always built and returned for inspection.

    The webhook URL is never included in the returned payload or logs.
    """
    payload = _build_payload(embed)
    payload_json = json.dumps(payload).encode("utf-8")

    if config.dry_run:
        return NotifyResult(
            message_sent=False,
            dry_run=True,
            payload=payload,
            error=None,
        )

    try:
        _http_post(config.webhook_url, payload_json, timeout=10)
        return NotifyResult(
            message_sent=True,
            dry_run=False,
            payload=payload,
            error=None,
        )
    except Exception as exc:
        return NotifyResult(
            message_sent=False,
            dry_run=False,
            payload=payload,
            error=str(exc),
        )


# ── Environment helper ────────────────────────────────────────────────────────

def load_notifier_config_from_env(
    env: Optional[dict] = None,
) -> Optional[DiscordNotifierConfig]:
    """Build DiscordNotifierConfig from environment variables.

    This is the ONLY function in this module that reads environment state.
    Pass env dict in tests to avoid touching os.environ.

    Returns None if DISCORD_WEBHOOK_URL is not set.
    Caller must explicitly pass dry_run=False to enable live sending.
    """
    import os
    source = env if env is not None else os.environ
    url = source.get("DISCORD_WEBHOOK_URL")
    if not url:
        return None
    return DiscordNotifierConfig(webhook_url=url, dry_run=True)
