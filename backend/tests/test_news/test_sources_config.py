"""
Tests for backend/engine/news/sources_config.py — Card 4-1
"""
from __future__ import annotations

import pytest

from backend.engine.news.sources_config import (
    DEFAULT_NEWS_SOURCES,
    NewsSource,
    NewsSourceValidationError,
    SourceCategory,
    SourcePriority,
    SourceType,
    get_enabled_sources,
    get_sources_by_category,
    get_sources_by_priority,
    get_sources_by_type,
    validate_sources,
)


# ── SourceType ────────────────────────────────────────────────────────────────

class TestSourceType:
    def test_rss_value(self):
        assert SourceType.RSS.value == "rss"

    def test_web_value(self):
        assert SourceType.WEB.value == "web"

    def test_api_value(self):
        assert SourceType.API.value == "api"

    def test_three_members(self):
        assert len(SourceType) == 3


# ── SourcePriority ────────────────────────────────────────────────────────────

class TestSourcePriority:
    def test_high_value(self):
        assert SourcePriority.HIGH.value == "high"

    def test_medium_value(self):
        assert SourcePriority.MEDIUM.value == "medium"

    def test_low_value(self):
        assert SourcePriority.LOW.value == "low"

    def test_three_members(self):
        assert len(SourcePriority) == 3


# ── SourceCategory ────────────────────────────────────────────────────────────

class TestSourceCategory:
    def test_all_nine_categories_exist(self):
        names = {m.name for m in SourceCategory}
        assert names == {
            "MACRO", "INTERNATIONAL", "JAPAN", "MARKETS",
            "INDIVIDUAL_STOCKS", "EARNINGS", "DISCLOSURE",
            "REGULATORY", "MARKET_STRUCTURE",
        }

    def test_category_values_are_strings(self):
        for cat in SourceCategory:
            assert isinstance(cat.value, str)

    def test_nine_members(self):
        assert len(SourceCategory) == 9


# ── NewsSource dataclass ───────────────────────────────────────────────────────

class TestNewsSourceDataclass:
    def _make_source(self, **kwargs) -> NewsSource:
        defaults = dict(
            source_id="test",
            name="Test",
            source_type=SourceType.RSS,
            endpoints=("https://example.com/rss",),
            language=("en",),
            priority=SourcePriority.HIGH,
            fetch_interval_min=30,
            categories=(SourceCategory.MACRO,),
        )
        defaults.update(kwargs)
        return NewsSource(**defaults)

    def test_is_frozen(self):
        src = self._make_source()
        with pytest.raises((AttributeError, TypeError)):
            src.enabled = False  # type: ignore[misc]

    def test_endpoints_is_tuple(self):
        src = self._make_source()
        assert isinstance(src.endpoints, tuple)

    def test_categories_is_tuple(self):
        src = self._make_source()
        assert isinstance(src.categories, tuple)

    def test_language_is_tuple(self):
        src = self._make_source()
        assert isinstance(src.language, tuple)

    def test_enabled_defaults_to_true(self):
        src = self._make_source()
        assert src.enabled is True

    def test_auth_required_defaults_to_false(self):
        src = self._make_source()
        assert src.auth_required is False

    def test_note_defaults_to_empty_string(self):
        src = self._make_source()
        assert src.note == ""

    def test_enabled_type_is_bool(self):
        src = self._make_source()
        assert isinstance(src.enabled, bool)


# ── DEFAULT_NEWS_SOURCES ───────────────────────────────────────────────────────

class TestDefaultNewsSources:
    def test_has_eight_sources(self):
        assert len(DEFAULT_NEWS_SOURCES) == 8

    def test_expected_keys_present(self):
        expected = {
            "bloomberg", "reuters", "yahoo_finance_jp", "minkabu",
            "shikiho_online", "tdnet", "edinet", "jpx",
        }
        assert set(DEFAULT_NEWS_SOURCES.keys()) == expected

    def test_source_ids_match_dict_keys(self):
        for key, src in DEFAULT_NEWS_SOURCES.items():
            assert src.source_id == key, f"{key}: source_id mismatch"

    def test_bloomberg_is_rss_high(self):
        src = DEFAULT_NEWS_SOURCES["bloomberg"]
        assert src.source_type == SourceType.RSS
        assert src.priority == SourcePriority.HIGH

    def test_reuters_is_rss_high(self):
        src = DEFAULT_NEWS_SOURCES["reuters"]
        assert src.source_type == SourceType.RSS
        assert src.priority == SourcePriority.HIGH

    def test_yahoo_finance_jp_is_rss_high(self):
        src = DEFAULT_NEWS_SOURCES["yahoo_finance_jp"]
        assert src.source_type == SourceType.RSS
        assert src.priority == SourcePriority.HIGH

    def test_shikiho_is_web_type(self):
        assert DEFAULT_NEWS_SOURCES["shikiho_online"].source_type == SourceType.WEB

    def test_edinet_is_api_type(self):
        assert DEFAULT_NEWS_SOURCES["edinet"].source_type == SourceType.API

    def test_all_sources_have_at_least_one_endpoint(self):
        for key, src in DEFAULT_NEWS_SOURCES.items():
            assert len(src.endpoints) >= 1, f"{key}: no endpoints"

    def test_all_sources_have_at_least_one_category(self):
        for key, src in DEFAULT_NEWS_SOURCES.items():
            assert len(src.categories) >= 1, f"{key}: no categories"

    def test_all_sources_enabled_by_default(self):
        for key, src in DEFAULT_NEWS_SOURCES.items():
            assert src.enabled is True, f"{key}: not enabled"

    def test_fetch_interval_min_positive(self):
        for key, src in DEFAULT_NEWS_SOURCES.items():
            assert src.fetch_interval_min >= 1, f"{key}: invalid interval"

    def test_shikiho_fetch_interval_is_360(self):
        assert DEFAULT_NEWS_SOURCES["shikiho_online"].fetch_interval_min == 360

    def test_bloomberg_reuters_yahoo_interval_30(self):
        for key in ("bloomberg", "reuters", "yahoo_finance_jp"):
            assert DEFAULT_NEWS_SOURCES[key].fetch_interval_min == 30, f"{key}: interval != 30"

    def test_bloomberg_has_three_endpoints(self):
        assert len(DEFAULT_NEWS_SOURCES["bloomberg"].endpoints) == 3

    def test_reuters_bilingual(self):
        lang = DEFAULT_NEWS_SOURCES["reuters"].language
        assert "en" in lang and "ja" in lang

    def test_shikiho_has_note(self):
        assert DEFAULT_NEWS_SOURCES["shikiho_online"].note != ""

    def test_all_values_are_news_source_instances(self):
        for key, src in DEFAULT_NEWS_SOURCES.items():
            assert isinstance(src, NewsSource), f"{key}: not NewsSource"


# ── Filtering API ─────────────────────────────────────────────────────────────

class TestFilteringAPI:
    def test_get_sources_by_priority_high_returns_five(self):
        # bloomberg, reuters, yahoo_finance_jp, tdnet, edinet
        result = get_sources_by_priority(SourcePriority.HIGH)
        assert len(result) == 5
        assert set(result.keys()) == {"bloomberg", "reuters", "yahoo_finance_jp", "tdnet", "edinet"}

    def test_get_sources_by_priority_medium_returns_three(self):
        # minkabu, shikiho_online, jpx
        result = get_sources_by_priority(SourcePriority.MEDIUM)
        assert len(result) == 3
        assert set(result.keys()) == {"minkabu", "shikiho_online", "jpx"}

    def test_get_sources_by_priority_low_returns_zero(self):
        assert len(get_sources_by_priority(SourcePriority.LOW)) == 0

    def test_get_sources_by_category_japan(self):
        # reuters, yahoo_finance_jp, minkabu, shikiho_online
        result = get_sources_by_category(SourceCategory.JAPAN)
        assert set(result.keys()) == {"reuters", "yahoo_finance_jp", "minkabu", "shikiho_online"}

    def test_get_sources_by_category_disclosure(self):
        # tdnet, edinet
        result = get_sources_by_category(SourceCategory.DISCLOSURE)
        assert set(result.keys()) == {"tdnet", "edinet"}

    def test_get_sources_by_category_macro(self):
        # bloomberg, reuters
        result = get_sources_by_category(SourceCategory.MACRO)
        assert set(result.keys()) == {"bloomberg", "reuters"}

    def test_get_sources_by_category_earnings(self):
        # tdnet, shikiho_online
        result = get_sources_by_category(SourceCategory.EARNINGS)
        assert set(result.keys()) == {"tdnet", "shikiho_online"}

    def test_get_sources_by_type_rss_returns_six(self):
        # bloomberg, reuters, yahoo_finance_jp, minkabu, tdnet, jpx
        result = get_sources_by_type(SourceType.RSS)
        assert len(result) == 6
        assert set(result.keys()) == {
            "bloomberg", "reuters", "yahoo_finance_jp", "minkabu", "tdnet", "jpx"
        }

    def test_get_sources_by_type_api_returns_one(self):
        result = get_sources_by_type(SourceType.API)
        assert len(result) == 1
        assert "edinet" in result

    def test_get_sources_by_type_web_returns_one(self):
        result = get_sources_by_type(SourceType.WEB)
        assert len(result) == 1
        assert "shikiho_online" in result

    def test_get_enabled_sources_all_by_default(self):
        result = get_enabled_sources()
        assert len(result) == 8

    def test_get_enabled_sources_respects_custom_disabled(self):
        # disabled ソースを 1 件含むカスタム dict でテスト
        from dataclasses import replace
        custom = dict(DEFAULT_NEWS_SOURCES)
        custom["bloomberg"] = NewsSource(
            source_id="bloomberg",
            name="Bloomberg",
            source_type=SourceType.RSS,
            endpoints=("https://feeds.bloomberg.com/markets/news.rss",),
            language=("en",),
            priority=SourcePriority.HIGH,
            fetch_interval_min=30,
            categories=(SourceCategory.MACRO,),
            enabled=False,
        )
        result = get_enabled_sources(sources=custom)
        assert len(result) == 7
        assert "bloomberg" not in result

    def test_filtering_accepts_custom_sources_dict(self):
        custom = {"bloomberg": DEFAULT_NEWS_SOURCES["bloomberg"]}
        result = get_sources_by_priority(SourcePriority.HIGH, sources=custom)
        assert "bloomberg" in result

    def test_get_sources_by_category_market_structure(self):
        result = get_sources_by_category(SourceCategory.MARKET_STRUCTURE)
        assert "jpx" in result

    def test_get_sources_by_category_regulatory(self):
        result = get_sources_by_category(SourceCategory.REGULATORY)
        assert set(result.keys()) == {"edinet", "jpx"}


# ── validate_sources ──────────────────────────────────────────────────────────

class TestValidateSources:
    def test_validate_default_sources_passes(self):
        validate_sources(DEFAULT_NEWS_SOURCES)  # must not raise

    def test_validate_raises_on_mismatched_source_id(self):
        bad = {
            "wrong_key": NewsSource(
                source_id="bloomberg",
                name="Bloomberg",
                source_type=SourceType.RSS,
                endpoints=("https://example.com",),
                language=("en",),
                priority=SourcePriority.HIGH,
                fetch_interval_min=30,
                categories=(SourceCategory.MACRO,),
            )
        }
        with pytest.raises(NewsSourceValidationError, match="does not match"):
            validate_sources(bad)

    def test_validate_raises_on_empty_endpoints(self):
        bad = {
            "test": NewsSource(
                source_id="test",
                name="Test",
                source_type=SourceType.RSS,
                endpoints=(),
                language=("en",),
                priority=SourcePriority.HIGH,
                fetch_interval_min=30,
                categories=(SourceCategory.MACRO,),
            )
        }
        with pytest.raises(NewsSourceValidationError, match="endpoints"):
            validate_sources(bad)

    def test_validate_raises_on_empty_categories(self):
        bad = {
            "test": NewsSource(
                source_id="test",
                name="Test",
                source_type=SourceType.RSS,
                endpoints=("https://example.com",),
                language=("en",),
                priority=SourcePriority.HIGH,
                fetch_interval_min=30,
                categories=(),
            )
        }
        with pytest.raises(NewsSourceValidationError, match="categories"):
            validate_sources(bad)

    def test_validate_raises_on_zero_interval(self):
        bad = {
            "test": NewsSource(
                source_id="test",
                name="Test",
                source_type=SourceType.RSS,
                endpoints=("https://example.com",),
                language=("en",),
                priority=SourcePriority.HIGH,
                fetch_interval_min=0,
                categories=(SourceCategory.MACRO,),
            )
        }
        with pytest.raises(NewsSourceValidationError, match="fetch_interval_min"):
            validate_sources(bad)

    def test_validate_raises_on_empty_source_id(self):
        bad = {
            "": NewsSource(
                source_id="",
                name="Test",
                source_type=SourceType.RSS,
                endpoints=("https://example.com",),
                language=("en",),
                priority=SourcePriority.HIGH,
                fetch_interval_min=30,
                categories=(SourceCategory.MACRO,),
            )
        }
        with pytest.raises(NewsSourceValidationError, match="source_id"):
            validate_sources(bad)

    def test_validate_not_called_at_import(self):
        # モジュールが副作用なしにインポートできること（既に import 済みなのでこれで十分）
        import backend.engine.news.sources_config as m
        assert hasattr(m, "DEFAULT_NEWS_SOURCES")

    def test_validate_empty_dict_passes(self):
        validate_sources({})  # 空 dict は有効（要素がないのでエラーなし）
