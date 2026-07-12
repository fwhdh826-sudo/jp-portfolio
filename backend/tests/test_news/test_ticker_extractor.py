"""
test_ticker_extractor.py — Card 4-6
Ticker Extractor のテストスイート。

テスト方針:
  - inline ticker_master fixture（実 HTTP / ファイルアクセスなし）
  - 全テストが公開 API 経由
  - NewsItem は rss_fetcher.NewsItem を使用
  - 禁止 import: requests / feedparser / aiohttp / httpx / urllib.request / bs4
"""
from __future__ import annotations

import dataclasses

import pytest

from backend.engine.news.rss_fetcher import NewsItem
from backend.engine.news.ticker_extractor import (
    TickerInfo,
    enrich_item,
    enrich_items,
    extract_ticker_aliases,
    extract_ticker_codes,
    extract_tickers,
)

# ── Inline ticker_master fixture ──────────────────────────────────────────────

_MASTER: dict[str, TickerInfo] = {
    "7011": TickerInfo(name="三菱重工業株式会社", aliases=("三菱重工", "MHI")),
    "9984": TickerInfo(name="ソフトバンクグループ株式会社", aliases=("ソフトバンク", "SBG")),
    "6758": TickerInfo(name="ソニーグループ株式会社", aliases=("ソニー", "Sony")),
    "8306": TickerInfo(name="株式会社三菱UFJフィナンシャル・グループ", aliases=("三菱UFJ", "MUFG")),
    "4661": TickerInfo(name="株式会社オリエンタルランド", aliases=("オリエンタルランド", "OLC")),
    "6098": TickerInfo(name="株式会社リクルートホールディングス", aliases=("リクルート",)),
    "9999": TickerInfo(name="エイリアスなし株式会社", aliases=()),  # alias なし
}

_EMPTY_MASTER: dict[str, TickerInfo] = {}


# ── Helper ────────────────────────────────────────────────────────────────────

def _make_item(
    title: str = "",
    summary: str = "",
    url: str = "https://example.com/1",
    related_tickers: tuple[str, ...] = (),
) -> NewsItem:
    return NewsItem(
        source_id="test",
        title=title,
        url=url,
        summary=summary,
        related_tickers=related_tickers,
    )


# ── TestTickerInfo ────────────────────────────────────────────────────────────

class TestTickerInfo:
    def test_fields_name_and_aliases(self):
        info = TickerInfo(name="テスト株式会社", aliases=("テスト", "TEST"))
        assert info.name == "テスト株式会社"
        assert info.aliases == ("テスト", "TEST")

    def test_frozen_immutable(self):
        info = TickerInfo(name="テスト", aliases=("A",))
        with pytest.raises((dataclasses.FrozenInstanceError, AttributeError)):
            info.name = "変更"  # type: ignore[misc]

    def test_empty_aliases_tuple(self):
        info = TickerInfo(name="エイリアスなし", aliases=())
        assert info.aliases == ()

    def test_aliases_as_tuple(self):
        info = TickerInfo(name="X", aliases=("a", "b", "c"))
        assert isinstance(info.aliases, tuple)
        assert len(info.aliases) == 3

    def test_equality(self):
        a = TickerInfo(name="X", aliases=("a",))
        b = TickerInfo(name="X", aliases=("a",))
        assert a == b


# ── TestExtractTickerCodes ────────────────────────────────────────────────────

class TestExtractTickerCodes:
    def test_empty_string(self):
        assert extract_ticker_codes("", _MASTER) == []

    def test_none_text(self):
        assert extract_ticker_codes(None, _MASTER) == []

    def test_whitespace_only(self):
        assert extract_ticker_codes("   ", _MASTER) == []

    def test_no_digit_at_all(self):
        assert extract_ticker_codes("日経平均が上昇", _MASTER) == []

    def test_4digit_not_in_master(self):
        # 2026 は年号 → master にない
        assert extract_ticker_codes("2026年の日経平均", _MASTER) == []

    def test_4digit_in_master(self):
        result = extract_ticker_codes("7011の業績", _MASTER)
        assert result == ["7011"]

    def test_5digit_not_matched(self):
        assert extract_ticker_codes("70112の話", _MASTER) == []

    def test_3digit_not_matched(self):
        assert extract_ticker_codes("701の話", _MASTER) == []

    def test_multiple_same_code_deduped(self):
        result = extract_ticker_codes("7011と7011の決算", _MASTER)
        assert result == ["7011"]

    def test_multiple_different_codes(self):
        result = extract_ticker_codes("7011と9984の比較", _MASTER)
        assert set(result) == {"7011", "9984"}

    def test_code_adjacent_to_letters(self):
        result = extract_ticker_codes("銘柄(7011)の決算", _MASTER)
        assert result == ["7011"]

    def test_code_in_japanese_text(self):
        result = extract_ticker_codes("三菱重工業(7011)が増益", _MASTER)
        assert result == ["7011"]

    def test_empty_master_returns_empty(self):
        assert extract_ticker_codes("7011の話", _EMPTY_MASTER) == []


# ── TestExtractTickerAliases ──────────────────────────────────────────────────

class TestExtractTickerAliases:
    def test_empty_text(self):
        assert extract_ticker_aliases("", _MASTER) == []

    def test_none_text(self):
        assert extract_ticker_aliases(None, _MASTER) == []

    def test_no_alias_match(self):
        assert extract_ticker_aliases("NTTドコモの話", _MASTER) == []

    def test_single_alias_match(self):
        result = extract_ticker_aliases("ソニーが好決算", _MASTER)
        assert result == ["6758"]

    def test_multiple_aliases_same_ticker(self):
        # "三菱重工" と "MHI" が両方含まれても 7011 は 1 件
        result = extract_ticker_aliases("三菱重工(MHI)の受注", _MASTER)
        assert result == ["7011"]

    def test_multiple_tickers_from_aliases(self):
        result = extract_ticker_aliases("ソニーとソフトバンクの提携", _MASTER)
        assert set(result) == {"6758", "9984"}

    def test_empty_aliases_in_master_skipped(self):
        # 9999 は aliases=() → マッチしない
        result = extract_ticker_aliases("エイリアスなし株式会社の記事", _MASTER)
        assert "9999" not in result

    def test_dedup_multiple_alias_mentions(self):
        # "ソニー" が複数回登場しても 6758 は 1 件
        result = extract_ticker_aliases("ソニーはソニーグループを傘下に持つ", _MASTER)
        assert result.count("6758") == 1

    def test_empty_master_returns_empty(self):
        assert extract_ticker_aliases("ソニーの話", _EMPTY_MASTER) == []


# ── TestExtractTickers ────────────────────────────────────────────────────────

class TestExtractTickers:
    def test_empty_string(self):
        assert extract_tickers("", _MASTER) == ()

    def test_none_text(self):
        assert extract_tickers(None, _MASTER) == ()

    def test_empty_tuple_no_match(self):
        assert extract_tickers("NTTの話 2026年", _MASTER) == ()

    def test_code_only_match(self):
        result = extract_tickers("7011の業績", _MASTER)
        assert result == ("7011",)

    def test_alias_only_match(self):
        result = extract_tickers("ソニーが躍進", _MASTER)
        assert result == ("6758",)

    def test_code_and_alias_same_ticker_deduped(self):
        # "ソニー" (alias) と "6758" (code) → 1 件に統合
        result = extract_tickers("ソニー(6758)の決算", _MASTER)
        assert result == ("6758",)

    def test_code_and_alias_different_tickers(self):
        result = extract_tickers("7011の受注とソニーの利益", _MASTER)
        assert "7011" in result
        assert "6758" in result

    def test_returns_tuple_not_list(self):
        result = extract_tickers("7011の話", _MASTER)
        assert isinstance(result, tuple)

    def test_sorted_result(self):
        result = extract_tickers("9984と7011と6758の比較", _MASTER)
        assert result == tuple(sorted(result))

    def test_empty_master_empty_tuple(self):
        assert extract_tickers("7011 ソニー", _EMPTY_MASTER) == ()


# ── TestEnrichItem ────────────────────────────────────────────────────────────

class TestEnrichItem:
    def test_empty_master_related_tickers_empty(self):
        item = _make_item(title="7011の業績")
        result = enrich_item(item, _EMPTY_MASTER)
        assert result.related_tickers == ()

    def test_title_code_extracted(self):
        item = _make_item(title="三菱重工業(7011)が増益")
        result = enrich_item(item, _MASTER)
        assert "7011" in result.related_tickers

    def test_summary_code_extracted(self):
        item = _make_item(title="市場動向", summary="9984が大幅高")
        result = enrich_item(item, _MASTER)
        assert "9984" in result.related_tickers

    def test_alias_from_title(self):
        item = _make_item(title="ソニーが好決算を発表")
        result = enrich_item(item, _MASTER)
        assert "6758" in result.related_tickers

    def test_alias_from_summary(self):
        item = _make_item(title="テック株動向", summary="ソフトバンクが子会社上場")
        result = enrich_item(item, _MASTER)
        assert "9984" in result.related_tickers

    def test_both_title_and_summary_combined(self):
        item = _make_item(title="7011が増益", summary="ソニーも好調")
        result = enrich_item(item, _MASTER)
        assert "7011" in result.related_tickers
        assert "6758" in result.related_tickers

    def test_url_not_searched(self):
        # URL に 7011 が含まれていても url は検索対象外
        item = _make_item(
            title="市場概況",
            summary="相場は落ち着いた動き",
            url="https://example.com/stocks/7011/report",
        )
        result = enrich_item(item, _MASTER)
        assert result.related_tickers == ()

    def test_returns_new_newsitem_not_same_object(self):
        item = _make_item(title="7011の話")
        result = enrich_item(item, _MASTER)
        assert result is not item

    def test_original_item_not_mutated(self):
        item = _make_item(title="7011の話")
        original_tickers = item.related_tickers
        enrich_item(item, _MASTER)
        assert item.related_tickers == original_tickers

    def test_no_match_empty_related_tickers(self):
        item = _make_item(title="マクロ経済の概況", summary="FRBが利上げ示唆")
        result = enrich_item(item, _MASTER)
        assert result.related_tickers == ()

    def test_multiple_tickers_sorted(self):
        item = _make_item(title="9984と7011と6758の株価動向")
        result = enrich_item(item, _MASTER)
        assert result.related_tickers == tuple(sorted(result.related_tickers))

    def test_other_fields_unchanged(self):
        item = _make_item(
            title="7011の業績",
            summary="三菱重工が好調",
            url="https://example.com/news/1",
        )
        result = enrich_item(item, _MASTER)
        assert result.source_id == item.source_id
        assert result.title == item.title
        assert result.summary == item.summary
        assert result.url == item.url

    def test_existing_related_tickers_overwritten(self):
        item = _make_item(title="7011の話", related_tickers=("9999",))
        result = enrich_item(item, _MASTER)
        # 9999 は title に出てこないので上書き後は消える
        assert "9999" not in result.related_tickers
        assert "7011" in result.related_tickers


# ── TestEnrichItems ───────────────────────────────────────────────────────────

class TestEnrichItems:
    def test_empty_list(self):
        assert enrich_items([], _MASTER) == []

    def test_single_item(self):
        item = _make_item(title="7011の業績")
        result = enrich_items([item], _MASTER)
        assert len(result) == 1
        assert "7011" in result[0].related_tickers

    def test_multiple_items_all_enriched(self):
        items = [
            _make_item(title="7011の話"),
            _make_item(title="9984の話", url="https://example.com/2"),
            _make_item(title="6758の話", url="https://example.com/3"),
        ]
        result = enrich_items(items, _MASTER)
        assert "7011" in result[0].related_tickers
        assert "9984" in result[1].related_tickers
        assert "6758" in result[2].related_tickers

    def test_returns_new_list_not_original(self):
        items = [_make_item(title="7011")]
        result = enrich_items(items, _MASTER)
        assert result is not items

    def test_original_items_not_mutated(self):
        item = _make_item(title="7011の話")
        original_tickers = item.related_tickers
        enrich_items([item], _MASTER)
        assert item.related_tickers == original_tickers

    def test_mixed_match_no_match(self):
        items = [
            _make_item(title="7011の増益"),
            _make_item(title="マクロ経済の概況", url="https://example.com/2"),
        ]
        result = enrich_items(items, _MASTER)
        assert "7011" in result[0].related_tickers
        assert result[1].related_tickers == ()

    def test_item_count_preserved(self):
        items = [_make_item(title=f"記事{i}", url=f"https://example.com/{i}") for i in range(5)]
        result = enrich_items(items, _MASTER)
        assert len(result) == 5

    def test_items_with_no_tickers_stay_empty(self):
        items = [
            _make_item(title="マクロ概況", url="https://example.com/1"),
            _make_item(title="FRB利上げ示唆", url="https://example.com/2"),
        ]
        result = enrich_items(items, _MASTER)
        assert all(item.related_tickers == () for item in result)


# ── TestEdgeCases ─────────────────────────────────────────────────────────────

class TestEdgeCases:
    def test_text_only_whitespace(self):
        assert extract_tickers("   \t\n  ", _MASTER) == ()

    def test_ticker_master_with_only_name_no_aliases(self):
        master = {"9999": TickerInfo(name="エイリアスなし", aliases=())}
        assert extract_ticker_aliases("エイリアスなし株式会社", master) == []
        assert extract_ticker_codes("9999の話", master) == ["9999"]

    def test_year_number_not_in_master_excluded(self):
        # 2026 は年号 → master 照合で除外
        assert extract_ticker_codes("2026年度の業績予想", _MASTER) == []

    def test_extract_tickers_japanese_article_example(self):
        text = (
            "三菱重工業(7011)は本日、航空機エンジン部門での増収増益を発表。"
            "ソニー(6758)との共同開発プロジェクトも順調に進行中。"
        )
        result = extract_tickers(text, _MASTER)
        assert "7011" in result
        assert "6758" in result
        assert result == tuple(sorted(result))

    def test_alias_empty_string_ignored(self):
        master = {"7777": TickerInfo(name="テスト", aliases=("", "テスト社"))}
        result = extract_ticker_aliases("テスト社の話", master)
        assert result == ["7777"]

    def test_enrich_item_no_title_no_summary(self):
        item = _make_item(title="", summary="")
        result = enrich_item(item, _MASTER)
        assert result.related_tickers == ()

    def test_enrich_items_empty_master(self):
        items = [_make_item(title="7011 ソニー")]
        result = enrich_items(items, _EMPTY_MASTER)
        assert result[0].related_tickers == ()
