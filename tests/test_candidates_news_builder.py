"""
P4-A9c-data-4a: candidates_news builder の回帰テスト

テスト対象:
  data/build_candidates_news.py の build_candidates_news(), _is_social(),
  _collect_items(), _build_role_entry(), _is_stale()

確認項目:
  1. social_noise / social category / reddit source が除外される
  2. us_growth tag item が us_growth に集計される
  3. jp_semiconductor tag item が jp_semiconductor に集計される
  4. 1記事が複数roleに入る
  5. avgSentiment / counts が正しい
  6. empty role も出力される
  7. stale parse失敗時 isStale true
  8. generated schema に必須keyがある
"""

from datetime import datetime, timezone, timedelta

from data.build_candidates_news import (
    ROLE_KEYS,
    _build_role_entry,
    _collect_items,
    _is_social,
    _is_stale,
    build_candidates_news,
)

JST = timezone(timedelta(hours=9))
_NOW = datetime(2026, 6, 14, 12, 0, 0, tzinfo=JST)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_item(
    title: str = "Test",
    source: str = "Reuters",
    sentiment: str = "neutral",
    score: float = 0.0,
    tags: list[str] | None = None,
    category: str = "market",
) -> dict:
    return {
        "title": title,
        "source": source,
        "summary": "",
        "url": "https://example.com",
        "publishedAt": "2026-06-14T00:00:00+09:00",
        "sentiment": sentiment,
        "sentimentScore": score,
        "importance": 0.5,
        "tags": tags if tags is not None else ["market"],
        "tickers": [],
        "category": category,
    }


def _make_news(items_market=None, items_stock=None, updated_at="2026-06-14T10:00:00+09:00", source_updated_at=None):
    return {
        "updatedAt": updated_at,
        "sourceUpdatedAt": source_updated_at or updated_at,
        "marketNews": items_market or [],
        "stockNews": items_stock or [],
    }


# ---------------------------------------------------------------------------
# 1. Social exclusion
# ---------------------------------------------------------------------------

class TestSocialExclusion:
    def test_social_noise_tag_excluded(self):
        item = _make_item(tags=["market", "social_noise"])
        assert _is_social(item) is True

    def test_social_tag_excluded(self):
        item = _make_item(tags=["social"])
        assert _is_social(item) is True

    def test_social_category_excluded(self):
        item = _make_item(tags=["market"], category="social")
        assert _is_social(item) is True

    def test_reddit_source_excluded(self):
        item = _make_item(source="reddit r/investing")
        assert _is_social(item) is True

    def test_r_stocks_source_excluded(self):
        item = _make_item(source="r/stocks")
        assert _is_social(item) is True

    def test_normal_item_not_excluded(self):
        item = _make_item(source="Bloomberg", tags=["market", "us_growth"])
        assert _is_social(item) is False

    def test_excluded_count_incremented(self):
        news = _make_news(
            items_market=[
                _make_item(source="reddit r/investing"),
                _make_item(source="Reuters", tags=["us_growth"]),
            ]
        )
        kept, excluded = _collect_items(news)
        assert excluded == 1
        assert len(kept) == 1

    def test_excluded_count_in_meta(self):
        social_item = _make_item(tags=["social"])
        normal_item = _make_item(tags=["us_growth"])
        news = _make_news(items_market=[social_item, normal_item])
        result = build_candidates_news(news, now=_NOW)
        assert result["meta"]["excludedCount"] == 1


# ---------------------------------------------------------------------------
# 2. us_growth タグ集計
# ---------------------------------------------------------------------------

class TestUsGrowthAggregation:
    def test_us_growth_tag_item_collected(self):
        item = _make_item(title="Nasdaq rallies", tags=["market", "us_growth"], score=0.33, sentiment="positive")
        news = _make_news(items_market=[item])
        result = build_candidates_news(news, now=_NOW)
        assert result["assetClassNews"]["us_growth"]["itemCount"] == 1

    def test_us_growth_positive_count(self):
        item = _make_item(tags=["us_growth"], score=0.5, sentiment="positive")
        news = _make_news(items_market=[item])
        result = build_candidates_news(news, now=_NOW)
        entry = result["assetClassNews"]["us_growth"]
        assert entry["positiveCount"] == 1
        assert entry["negativeCount"] == 0

    def test_us_growth_top_positive_title(self):
        item = _make_item(title="Big rally", tags=["us_growth"], score=0.66, sentiment="positive")
        news = _make_news(items_market=[item])
        result = build_candidates_news(news, now=_NOW)
        assert result["assetClassNews"]["us_growth"]["topPositiveTitle"] == "Big rally"


# ---------------------------------------------------------------------------
# 3. jp_semiconductor タグ集計
# ---------------------------------------------------------------------------

class TestJpSemiconductorAggregation:
    def test_jp_semiconductor_tag_item_collected(self):
        item = _make_item(title="NVIDIA chip", tags=["market", "jp_semiconductor"], score=-0.33, sentiment="negative")
        news = _make_news(items_market=[item])
        result = build_candidates_news(news, now=_NOW)
        assert result["assetClassNews"]["jp_semiconductor"]["itemCount"] == 1

    def test_jp_semiconductor_negative_count(self):
        item = _make_item(tags=["jp_semiconductor"], score=-0.5, sentiment="negative")
        news = _make_news(items_market=[item])
        result = build_candidates_news(news, now=_NOW)
        entry = result["assetClassNews"]["jp_semiconductor"]
        assert entry["negativeCount"] == 1
        assert entry["positiveCount"] == 0

    def test_jp_semiconductor_top_negative_title(self):
        item = _make_item(title="Chip selloff", tags=["jp_semiconductor"], score=-0.66, sentiment="negative")
        news = _make_news(items_market=[item])
        result = build_candidates_news(news, now=_NOW)
        assert result["assetClassNews"]["jp_semiconductor"]["topNegativeTitle"] == "Chip selloff"


# ---------------------------------------------------------------------------
# 4. 1記事が複数roleに入る
# ---------------------------------------------------------------------------

class TestMultiRoleItem:
    def test_item_with_two_roles_appears_in_both(self):
        item = _make_item(
            title="NVIDIA AI chip rally",
            tags=["market", "us_growth", "jp_semiconductor"],
            score=0.5,
            sentiment="positive",
        )
        news = _make_news(items_market=[item])
        result = build_candidates_news(news, now=_NOW)
        assert result["assetClassNews"]["us_growth"]["itemCount"] == 1
        assert result["assetClassNews"]["jp_semiconductor"]["itemCount"] == 1

    def test_item_with_three_roles(self):
        item = _make_item(
            tags=["us_broad", "rates", "fx"],
            score=-0.33,
            sentiment="negative",
        )
        news = _make_news(items_market=[item])
        result = build_candidates_news(news, now=_NOW)
        assert result["assetClassNews"]["us_broad"]["itemCount"] == 1
        assert result["assetClassNews"]["rates"]["itemCount"] == 1
        assert result["assetClassNews"]["fx"]["itemCount"] == 1

    def test_other_roles_unaffected(self):
        item = _make_item(tags=["us_growth"], score=0.33, sentiment="positive")
        news = _make_news(items_market=[item])
        result = build_candidates_news(news, now=_NOW)
        # jp_broad should have 0 items
        assert result["assetClassNews"]["jp_broad"]["itemCount"] == 0


# ---------------------------------------------------------------------------
# 5. avgSentiment / counts
# ---------------------------------------------------------------------------

class TestSentimentCounts:
    def test_avg_sentiment_calculation(self):
        items = [
            _make_item(tags=["us_growth"], score=0.33, sentiment="positive"),
            _make_item(tags=["us_growth"], score=-0.33, sentiment="negative"),
            _make_item(tags=["us_growth"], score=0.0, sentiment="neutral"),
        ]
        entry = _build_role_entry(items, is_stale=False)
        assert entry["avgSentiment"] == round((0.33 - 0.33 + 0.0) / 3, 3)

    def test_counts_split_correctly(self):
        items = [
            _make_item(tags=["gold"], score=0.5, sentiment="positive"),
            _make_item(tags=["gold"], score=0.5, sentiment="positive"),
            _make_item(tags=["gold"], score=-0.5, sentiment="negative"),
            _make_item(tags=["gold"], score=0.0, sentiment="neutral"),
            _make_item(tags=["gold"], score=0.1, sentiment="neutral"),
        ]
        entry = _build_role_entry(items, is_stale=False)
        assert entry["positiveCount"] == 2
        assert entry["negativeCount"] == 1
        assert entry["neutralCount"] == 2
        assert entry["itemCount"] == 5

    def test_source_count_deduplicates(self):
        items = [
            _make_item(source="Bloomberg", tags=["gold"]),
            _make_item(source="Bloomberg", tags=["gold"]),
            _make_item(source="Reuters", tags=["gold"]),
        ]
        entry = _build_role_entry(items, is_stale=False)
        assert entry["sourceCount"] == 2

    def test_items_capped_at_5(self):
        items = [_make_item(tags=["macro_risk"], score=float(-i) * 0.1) for i in range(8)]
        entry = _build_role_entry(items, is_stale=False)
        assert len(entry["items"]) == 5

    def test_top_titles_correct(self):
        items = [
            _make_item(title="Most negative", tags=["rates"], score=-0.9, sentiment="negative"),
            _make_item(title="Most positive", tags=["rates"], score=0.9, sentiment="positive"),
            _make_item(title="Neutral", tags=["rates"], score=0.0, sentiment="neutral"),
        ]
        entry = _build_role_entry(items, is_stale=False)
        assert entry["topNegativeTitle"] == "Most negative"
        assert entry["topPositiveTitle"] == "Most positive"

    def test_avg_sentiment_rounded_to_3_decimals(self):
        items = [_make_item(tags=["fx"], score=1/3)]
        entry = _build_role_entry(items, is_stale=False)
        assert entry["avgSentiment"] == round(1/3, 3)


# ---------------------------------------------------------------------------
# 6. empty role も出力される
# ---------------------------------------------------------------------------

class TestEmptyRoles:
    def test_all_role_keys_present_in_output(self):
        news = _make_news()
        result = build_candidates_news(news, now=_NOW)
        for role in ROLE_KEYS:
            assert role in result["assetClassNews"], f"Missing role: {role}"

    def test_empty_role_has_zero_counts(self):
        news = _make_news()
        result = build_candidates_news(news, now=_NOW)
        entry = result["assetClassNews"]["commodity"]
        assert entry["itemCount"] == 0
        assert entry["negativeCount"] == 0
        assert entry["positiveCount"] == 0
        assert entry["neutralCount"] == 0
        assert entry["sourceCount"] == 0

    def test_empty_role_has_null_titles(self):
        news = _make_news()
        result = build_candidates_news(news, now=_NOW)
        entry = result["assetClassNews"]["geopolitical"]
        assert entry["topNegativeTitle"] is None
        assert entry["topPositiveTitle"] is None

    def test_empty_role_items_is_empty_list(self):
        news = _make_news()
        result = build_candidates_news(news, now=_NOW)
        assert result["assetClassNews"]["global_broad"]["items"] == []


# ---------------------------------------------------------------------------
# 7. stale判定
# ---------------------------------------------------------------------------

class TestStaleness:
    def test_stale_when_updatedAt_missing(self):
        news = {"marketNews": [], "stockNews": []}
        result = build_candidates_news(news, now=_NOW)
        for role in ROLE_KEYS:
            assert result["assetClassNews"][role]["isStale"] is True

    def test_stale_when_updatedAt_unparseable(self):
        news = _make_news(updated_at="not-a-date", source_updated_at="also-bad")
        result = build_candidates_news(news, now=_NOW)
        assert result["assetClassNews"]["us_growth"]["isStale"] is True

    def test_not_stale_when_fresh(self):
        fresh = "2026-06-14T10:00:00+09:00"
        news = _make_news(updated_at=fresh, source_updated_at=fresh)
        item = _make_item(tags=["us_growth"])
        news["marketNews"] = [item]
        result = build_candidates_news(news, now=_NOW)
        assert result["assetClassNews"]["us_growth"]["isStale"] is False

    def test_stale_when_older_than_24h(self):
        old = "2026-06-12T10:00:00+09:00"
        news = _make_news(updated_at=old, source_updated_at=old)
        item = _make_item(tags=["us_growth"])
        news["marketNews"] = [item]
        result = build_candidates_news(news, now=_NOW)
        assert result["assetClassNews"]["us_growth"]["isStale"] is True

    def test_stale_uses_best_of_updatedAt_and_sourceUpdatedAt(self):
        # updatedAt is stale but sourceUpdatedAt is fresh -> not stale
        news = {
            "updatedAt": "2026-06-12T00:00:00+09:00",
            "sourceUpdatedAt": "2026-06-14T10:00:00+09:00",
            "marketNews": [_make_item(tags=["us_growth"])],
            "stockNews": [],
        }
        result = build_candidates_news(news, now=_NOW)
        assert result["assetClassNews"]["us_growth"]["isStale"] is False

    def test_stale_sourceUpdatedAt_as_dict(self):
        news = {
            "updatedAt": "2026-06-12T00:00:00+09:00",
            "sourceUpdatedAt": {
                "Bloomberg": "2026-06-14T10:00:00+09:00",
                "Reuters": None,
            },
            "marketNews": [_make_item(tags=["us_growth"])],
            "stockNews": [],
        }
        result = build_candidates_news(news, now=_NOW)
        assert result["assetClassNews"]["us_growth"]["isStale"] is False


# ---------------------------------------------------------------------------
# 8. Schema必須key
# ---------------------------------------------------------------------------

class TestSchemaKeys:
    def _result(self):
        news = _make_news(
            items_market=[_make_item(tags=["us_growth"], score=-0.33, sentiment="negative")],
            updated_at="2026-06-14T10:00:00+09:00",
        )
        return build_candidates_news(news, now=_NOW)

    def test_top_level_keys_present(self):
        r = self._result()
        for key in ("schemaVersion", "updatedAt", "sourceUpdatedAt", "staleThresholdHours", "assetClassNews", "meta"):
            assert key in r, f"Missing top-level key: {key}"

    def test_schema_version_value(self):
        assert self._result()["schemaVersion"] == "candidates-news-1"

    def test_meta_keys_present(self):
        meta = self._result()["meta"]
        for key in ("excludedTags", "excludedCategories", "excludedCount", "minItemsForSignal", "generator"):
            assert key in meta, f"Missing meta key: {key}"

    def test_role_entry_keys_present(self):
        entry = self._result()["assetClassNews"]["us_growth"]
        for key in (
            "avgSentiment", "negativeCount", "positiveCount", "neutralCount",
            "sourceCount", "itemCount", "isStale", "topNegativeTitle", "topPositiveTitle", "items",
        ):
            assert key in entry, f"Missing role entry key: {key}"

    def test_item_entry_keys_present(self):
        result = self._result()
        items = result["assetClassNews"]["us_growth"]["items"]
        assert len(items) == 1
        for key in ("title", "source", "sentiment", "sentimentScore", "publishedAt", "url", "tags"):
            assert key in items[0], f"Missing item key: {key}"

    def test_stale_threshold_value(self):
        assert self._result()["staleThresholdHours"] == 24
