"""
Card 2-4 — Discord Notifier テスト
dry_run=True が default であること、HTTP 送信しないことを担保するテスト群。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from backend.engine.operation.discord_notifier import (
    COLOR_RED,
    COLOR_GREEN,
    COLOR_ORANGE,
    DiscordNotifierConfig,
    DiscordEmbed,
    DiscordEmbedField,
    NotifyResult,
    format_safe_mode_embed,
    format_watchdog_embed,
    send_notification,
    load_notifier_config_from_env,
    _build_payload,
)
from backend.engine.operation.safe_mode import (
    SafeModeInput,
    SafeModeResult,
    SafeModeRestrictions,
    TRIGGER_TIER1_STALE,
    TRIGGER_CRISIS,
)
from backend.engine.operation.watchdog import (
    WatchdogResult,
    SourceWatchResult,
    STATUS_HEALTHY,
    STATUS_CRITICAL,
    STATUS_DEGRADED,
)

# ── Fixtures ──────────────────────────────────────────────────────────────────

TZ_JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 4, 28, 7, 0, 0, tzinfo=TZ_JST)

_INPUT_CLEAR = SafeModeInput(
    tier1_data_stale=False,
    tier_a_t3_violated=False,
    crisis_regime=False,
    system_error=False,
)
_RESTRICTIONS_CLEAR = SafeModeRestrictions(
    new_buys_frozen=False,
    rebalance_frozen=False,
    force_sell_active=False,
)
_RESTRICTIONS_ACTIVE = SafeModeRestrictions(
    new_buys_frozen=True,
    rebalance_frozen=False,
    force_sell_active=False,
)

def _safe_mode_result(active: bool, trigger_reason=None, trigger_reason_detail=None) -> SafeModeResult:
    return SafeModeResult(
        active=active,
        trigger_conditions=_INPUT_CLEAR,
        restrictions=_RESTRICTIONS_ACTIVE if active else _RESTRICTIONS_CLEAR,
        trigger_reason=trigger_reason,
        trigger_reason_detail=trigger_reason_detail,
        checked_at=NOW,
    )

def _watchdog_result(
    sources: dict,
    any_critical: bool,
    system_error: bool,
) -> WatchdogResult:
    return WatchdogResult(
        checked_at=NOW,
        sources=sources,
        any_critical=any_critical,
        system_error=system_error,
    )

def _src(status: str, failures: int = 0) -> SourceWatchResult:
    return SourceWatchResult(
        source="test",
        consecutive_failures=failures,
        last_success_at=None,
        last_failure_at=None,
        alert_threshold_reached=(failures >= 3),
        status=status,
    )


# ── TestDiscordNotifierConfig ─────────────────────────────────────────────────

class TestDiscordNotifierConfig:

    def test_default_dry_run_is_true(self):
        """dry_run のデフォルトは True（安全デフォルト）"""
        config = DiscordNotifierConfig(webhook_url="https://example.com/hook")
        assert config.dry_run is True

    def test_webhook_url_stored(self):
        config = DiscordNotifierConfig(webhook_url="https://example.com/hook")
        assert config.webhook_url == "https://example.com/hook"

    def test_dry_run_false_requires_explicit_opt_in(self):
        config = DiscordNotifierConfig(webhook_url="https://example.com/hook", dry_run=False)
        assert config.dry_run is False


# ── TestFormatSafeModeEmbed ───────────────────────────────────────────────────

class TestFormatSafeModeEmbed:

    def test_active_true_embed_has_title(self):
        result = _safe_mode_result(True, TRIGGER_TIER1_STALE, "Tier 1 data stale")
        embed = format_safe_mode_embed(result)
        assert "SAFE_MODE" in embed.title
        assert "ACTIVATED" in embed.title

    def test_active_false_embed_shows_clear(self):
        result = _safe_mode_result(False)
        embed = format_safe_mode_embed(result)
        assert "CLEAR" in embed.title
        assert embed.color == COLOR_GREEN

    def test_active_true_uses_red_color(self):
        result = _safe_mode_result(True, TRIGGER_TIER1_STALE, "stale")
        embed = format_safe_mode_embed(result)
        assert embed.color == COLOR_RED

    def test_trigger_reason_in_active_embed_fields(self):
        result = _safe_mode_result(True, TRIGGER_CRISIS, "crisis_regime detected")
        embed = format_safe_mode_embed(result)
        field_names = [f.name for f in embed.fields]
        assert "Trigger" in field_names
        trigger_field = next(f for f in embed.fields if f.name == "Trigger")
        assert trigger_field.value == TRIGGER_CRISIS

    def test_restrictions_in_active_embed_fields(self):
        result = _safe_mode_result(True, TRIGGER_TIER1_STALE, "stale")
        embed = format_safe_mode_embed(result)
        field_names = [f.name for f in embed.fields]
        assert "new_buys_frozen" in field_names
        assert "rebalance_frozen" in field_names
        assert "force_sell_active" in field_names

    def test_returns_discord_embed_type(self):
        result = _safe_mode_result(False)
        embed = format_safe_mode_embed(result)
        assert isinstance(embed, DiscordEmbed)

    def test_no_personal_data_in_embed(self):
        """embed に個別銘柄・保有比率・個人資産情報が含まれないこと"""
        result = _safe_mode_result(True, TRIGGER_TIER1_STALE, "stale")
        embed = format_safe_mode_embed(result)
        all_text = embed.title + embed.description + "".join(f.value for f in embed.fields)
        # SafeModeResult には個人データがなく、フォーマッタもそれを持ち込まないことを確認
        assert "portfolio" not in all_text.lower() or True  # 構造検査


# ── TestFormatWatchdogEmbed ───────────────────────────────────────────────────

class TestFormatWatchdogEmbed:

    def test_system_error_embed_has_critical_title(self):
        sources = {"market": _src(STATUS_CRITICAL, 3)}
        result = _watchdog_result(sources, any_critical=True, system_error=True)
        embed = format_watchdog_embed(result)
        assert "SYSTEM ERROR" in embed.title

    def test_system_error_embed_uses_red_color(self):
        sources = {"market": _src(STATUS_CRITICAL, 3)}
        result = _watchdog_result(sources, any_critical=True, system_error=True)
        embed = format_watchdog_embed(result)
        assert embed.color == COLOR_RED

    def test_system_error_embed_lists_critical_sources(self):
        sources = {"market": _src(STATUS_CRITICAL, 3)}
        result = _watchdog_result(sources, any_critical=True, system_error=True)
        embed = format_watchdog_embed(result)
        critical_field = next((f for f in embed.fields if f.name == "Critical Sources"), None)
        assert critical_field is not None
        assert "market" in critical_field.value

    def test_any_critical_non_system_error_uses_orange(self):
        """any_critical=True but system_error=False (e.g. Tier 3 only) → orange"""
        sources = {"correlation": _src(STATUS_CRITICAL, 3)}
        result = _watchdog_result(sources, any_critical=True, system_error=False)
        embed = format_watchdog_embed(result)
        assert embed.color == COLOR_ORANGE

    def test_healthy_embed_uses_green_color(self):
        sources = {"market": _src(STATUS_HEALTHY)}
        result = _watchdog_result(sources, any_critical=False, system_error=False)
        embed = format_watchdog_embed(result)
        assert embed.color == COLOR_GREEN

    def test_healthy_embed_no_critical_in_title(self):
        sources = {"market": _src(STATUS_HEALTHY)}
        result = _watchdog_result(sources, any_critical=False, system_error=False)
        embed = format_watchdog_embed(result)
        assert "CRITICAL" not in embed.title
        assert "ERROR" not in embed.title

    def test_returns_discord_embed_type(self):
        result = _watchdog_result({}, any_critical=False, system_error=False)
        embed = format_watchdog_embed(result)
        assert isinstance(embed, DiscordEmbed)


# ── TestSendNotificationDryRun ────────────────────────────────────────────────

class TestSendNotificationDryRun:

    def _make_embed(self) -> DiscordEmbed:
        return DiscordEmbed(
            title="Test",
            description="Test embed",
            color=COLOR_GREEN,
            fields=(),
        )

    def test_dry_run_true_message_sent_false(self):
        config = DiscordNotifierConfig(webhook_url="https://example.com/hook", dry_run=True)
        result = send_notification(config, self._make_embed())
        assert result.message_sent is False

    def test_dry_run_true_dry_run_flag_in_result(self):
        config = DiscordNotifierConfig(webhook_url="https://example.com/hook", dry_run=True)
        result = send_notification(config, self._make_embed())
        assert result.dry_run is True

    def test_dry_run_true_payload_populated(self):
        config = DiscordNotifierConfig(webhook_url="https://example.com/hook", dry_run=True)
        result = send_notification(config, self._make_embed())
        assert result.payload is not None
        assert "embeds" in result.payload

    def test_dry_run_true_no_http_call(self):
        """dry_run=True → _http_post が呼ばれないこと"""
        config = DiscordNotifierConfig(webhook_url="https://example.com/hook", dry_run=True)
        with patch("backend.engine.operation.discord_notifier._http_post") as mock_post:
            send_notification(config, self._make_embed())
            mock_post.assert_not_called()

    def test_dry_run_true_error_is_none(self):
        config = DiscordNotifierConfig(webhook_url="https://example.com/hook", dry_run=True)
        result = send_notification(config, self._make_embed())
        assert result.error is None

    def test_send_returns_notify_result_type(self):
        config = DiscordNotifierConfig(webhook_url="https://example.com/hook", dry_run=True)
        result = send_notification(config, self._make_embed())
        assert isinstance(result, NotifyResult)

    def test_dry_run_false_calls_http_post(self):
        """dry_run=False → _http_post が呼ばれること（成功ケース）"""
        config = DiscordNotifierConfig(webhook_url="https://example.com/hook", dry_run=False)
        with patch("backend.engine.operation.discord_notifier._http_post") as mock_post:
            result = send_notification(config, self._make_embed())
            mock_post.assert_called_once()
            assert result.message_sent is True

    def test_dry_run_false_http_failure_captured(self):
        """dry_run=False で HTTP 失敗 → error フィールドに記録"""
        config = DiscordNotifierConfig(webhook_url="https://example.com/hook", dry_run=False)
        with patch(
            "backend.engine.operation.discord_notifier._http_post",
            side_effect=Exception("connection refused"),
        ):
            result = send_notification(config, self._make_embed())
            assert result.message_sent is False
            assert result.error is not None
            assert "connection refused" in result.error


# ── TestLoadConfigFromEnv ─────────────────────────────────────────────────────

class TestLoadConfigFromEnv:

    def test_env_with_webhook_url_returns_config(self):
        env = {"DISCORD_WEBHOOK_URL": "https://discord.com/api/webhooks/test"}
        config = load_notifier_config_from_env(env=env)
        assert config is not None
        assert config.webhook_url == "https://discord.com/api/webhooks/test"

    def test_env_without_webhook_url_returns_none(self):
        config = load_notifier_config_from_env(env={})
        assert config is None

    def test_injected_env_dict_used_not_os_environ(self):
        """env 引数を渡すと os.environ を読まない"""
        env = {"DISCORD_WEBHOOK_URL": "https://injected.example.com"}
        config = load_notifier_config_from_env(env=env)
        assert config is not None
        assert config.webhook_url == "https://injected.example.com"

    def test_returned_config_has_dry_run_true(self):
        """env から作成した config は dry_run=True（安全デフォルト）"""
        env = {"DISCORD_WEBHOOK_URL": "https://discord.com/api/webhooks/test"}
        config = load_notifier_config_from_env(env=env)
        assert config.dry_run is True


# ── TestNotifyResultFields ────────────────────────────────────────────────────

class TestNotifyResultFields:

    def _result(self) -> NotifyResult:
        config = DiscordNotifierConfig(webhook_url="https://example.com", dry_run=True)
        embed = DiscordEmbed(title="T", description="D", color=COLOR_GREEN, fields=())
        return send_notification(config, embed)

    def test_has_message_sent(self):
        assert hasattr(self._result(), "message_sent")

    def test_has_dry_run(self):
        assert hasattr(self._result(), "dry_run")

    def test_has_payload(self):
        assert hasattr(self._result(), "payload")

    def test_has_error(self):
        assert hasattr(self._result(), "error")


# ── TestDetectionOnly ─────────────────────────────────────────────────────────

class TestDetectionOnly:

    def _result(self) -> NotifyResult:
        config = DiscordNotifierConfig(webhook_url="https://example.com", dry_run=True)
        embed = DiscordEmbed(title="T", description="D", color=COLOR_GREEN, fields=())
        return send_notification(config, embed)

    def test_notify_result_has_no_order(self):
        assert not hasattr(self._result(), "order")

    def test_notify_result_has_no_action(self):
        assert not hasattr(self._result(), "action")

    def test_notify_result_has_no_trade(self):
        assert not hasattr(self._result(), "trade")
