"""
Tests for backend/engine/news/edinet_api.py — Card 4-3

テスト方針:
  - 実ネットワークアクセスなし
  - parse / normalize: inline dict fixture を直接渡す（mock 不要）
  - fetch_edinet_documents: fetcher_fn に json.dumps(fixture) を返す lambda を注入（DI）
  - requests / httpx / aiohttp / urllib.request は一切使わない
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone

import pytest

from backend.engine.news.edinet_api import (
    EDINET_BASE,
    DOC_TYPE_ALL,
    DOC_TYPE_MAIN,
    EdinetDocument,
    EdinetFetchResult,
    build_documents_url,
    edinet_document_to_news_item,
    fetch_edinet_documents,
    normalize_document,
    parse_documents_response,
    parse_submit_datetime,
)
from backend.engine.news.rss_fetcher import NewsItem


# ── Inline fixtures ───────────────────────────────────────────────────────────

def _make_doc_dict(**kwargs) -> dict:
    """最小有効ドキュメント dict を生成する。"""
    defaults = {
        "docID": "S100ABCD",
        "edinetCode": "E12345",
        "filerName": "トヨタ自動車株式会社",
        "docDescription": "有価証券報告書",
        "submitDateTime": "2026-05-07 09:00",
        "docTypeCode": "120",
        "periodStart": "2025-04-01",
        "periodEnd": "2026-03-31",
    }
    defaults.update(kwargs)
    return defaults


_RESPONSE_SINGLE = {
    "metadata": {
        "title": "EDINET提出書類一覧API",
        "parameter": {"date": "2026-05-07", "type": "2"},
        "resultset": {"count": 1, "date": "2026-05-07", "totalCount": 1},
    },
    "results": [_make_doc_dict()],
}

_RESPONSE_THREE = {
    "metadata": {"resultset": {"count": 3}},
    "results": [
        _make_doc_dict(docID="S100AAA1", filerName="会社A", docDescription="有価証券報告書"),
        _make_doc_dict(docID="S100BBB2", filerName="会社B", docDescription="四半期報告書"),
        _make_doc_dict(docID="S100CCC3", filerName="会社C", docDescription="臨時報告書"),
    ],
}

_RESPONSE_EMPTY = {
    "metadata": {"resultset": {"count": 0}},
    "results": [],
}

_RESPONSE_NO_RESULTS_KEY = {
    "metadata": {"resultset": {"count": 0}},
}

_RESPONSE_WITH_INVALID = {
    "metadata": {"resultset": {"count": 2}},
    "results": [
        _make_doc_dict(),                              # valid
        {"edinetCode": "E99999", "filerName": "会社X"},  # missing docID
        {"docID": "S100DDDD"},                         # missing filerName
    ],
}


# ── TestEdinetDocumentDataclass ───────────────────────────────────────────────

class TestEdinetDocumentDataclass:
    def test_fields_accessible(self):
        doc = EdinetDocument(
            doc_id="S100ABCD",
            edinet_code="E12345",
            filer_name="トヨタ自動車株式会社",
            doc_description="有価証券報告書",
            submit_datetime="2026-05-07 09:00",
            doc_type_code="120",
            url=f"{EDINET_BASE}/documents/S100ABCD",
        )
        assert doc.doc_id == "S100ABCD"
        assert doc.filer_name == "トヨタ自動車株式会社"

    def test_url_field_set(self):
        url = f"{EDINET_BASE}/documents/S100ABCD"
        doc = EdinetDocument(
            doc_id="S100ABCD", edinet_code="", filer_name="A",
            doc_description="", submit_datetime="", doc_type_code="",
            url=url,
        )
        assert doc.url == url

    def test_period_defaults_none(self):
        doc = EdinetDocument(
            doc_id="X", edinet_code="", filer_name="B",
            doc_description="", submit_datetime="", doc_type_code="",
            url="https://example.com",
        )
        assert doc.period_start is None
        assert doc.period_end is None

    def test_period_set_when_provided(self):
        doc = EdinetDocument(
            doc_id="X", edinet_code="", filer_name="B",
            doc_description="", submit_datetime="", doc_type_code="",
            url="https://example.com",
            period_start="2025-04-01",
            period_end="2026-03-31",
        )
        assert doc.period_start == "2025-04-01"
        assert doc.period_end == "2026-03-31"

    def test_is_mutable(self):
        doc = EdinetDocument(
            doc_id="X", edinet_code="", filer_name="B",
            doc_description="", submit_datetime="", doc_type_code="",
            url="https://example.com",
        )
        doc.filer_name = "Updated"
        assert doc.filer_name == "Updated"


# ── TestEdinetFetchResultDataclass ────────────────────────────────────────────

class TestEdinetFetchResultDataclass:
    def test_fields_accessible(self):
        r = EdinetFetchResult(target_date=date(2026, 5, 7), doc_type=2)
        assert r.target_date == date(2026, 5, 7)
        assert r.doc_type == 2
        assert r.success is False

    def test_items_is_list(self):
        r = EdinetFetchResult(target_date=date(2026, 5, 7), doc_type=2)
        assert isinstance(r.items, list)
        assert r.items == []

    def test_fetched_at_is_utc(self):
        r = EdinetFetchResult(target_date=date(2026, 5, 7), doc_type=2)
        assert r.fetched_at.tzinfo == timezone.utc

    def test_error_defaults_none(self):
        r = EdinetFetchResult(target_date=date(2026, 5, 7), doc_type=2)
        assert r.error is None

    def test_total_count_defaults_zero(self):
        r = EdinetFetchResult(target_date=date(2026, 5, 7), doc_type=2)
        assert r.total_count == 0

    def test_two_instances_have_independent_lists(self):
        r1 = EdinetFetchResult(target_date=date(2026, 5, 7), doc_type=2)
        r2 = EdinetFetchResult(target_date=date(2026, 5, 7), doc_type=2)
        r1.items.append(NewsItem(source_id="edinet", title="T", url="https://example.com"))
        assert r2.items == []


# ── TestConstants ─────────────────────────────────────────────────────────────

class TestConstants:
    def test_edinet_base_contains_edinet(self):
        assert "edinet-fsa.go.jp" in EDINET_BASE

    def test_edinet_base_v2(self):
        assert "/api/v2" in EDINET_BASE

    def test_doc_type_main_is_2(self):
        assert DOC_TYPE_MAIN == 2

    def test_doc_type_all_is_1(self):
        assert DOC_TYPE_ALL == 1


# ── TestBuildDocumentsUrl ─────────────────────────────────────────────────────

class TestBuildDocumentsUrl:
    def test_default_type_is_2(self):
        url = build_documents_url(date(2026, 5, 7))
        assert "type=2" in url

    def test_date_formatted_correctly(self):
        url = build_documents_url(date(2026, 5, 7))
        assert "date=2026-05-07" in url

    def test_base_url_correct(self):
        url = build_documents_url(date(2026, 5, 7))
        assert url.startswith(EDINET_BASE)
        assert "documents.json" in url

    def test_doc_type_1_in_url(self):
        url = build_documents_url(date(2026, 5, 7), doc_type=1)
        assert "type=1" in url

    def test_different_dates(self):
        url1 = build_documents_url(date(2026, 5, 1))
        url2 = build_documents_url(date(2026, 5, 7))
        assert "2026-05-01" in url1
        assert "2026-05-07" in url2
        assert url1 != url2

    def test_month_zero_padded(self):
        url = build_documents_url(date(2026, 1, 3))
        assert "2026-01-03" in url


# ── TestParseSubmitDatetime ───────────────────────────────────────────────────

_JST = timezone(timedelta(hours=9))


class TestParseSubmitDatetime:
    def test_valid_format_returns_datetime(self):
        result = parse_submit_datetime("2026-05-07 09:00")
        assert isinstance(result, datetime)

    def test_jst_09_00_converts_to_utc_00_00(self):
        result = parse_submit_datetime("2026-05-07 09:00")
        assert result is not None
        assert result.hour == 0
        assert result.day == 7

    def test_jst_15_30_converts_to_utc_06_30(self):
        result = parse_submit_datetime("2026-05-07 15:30")
        assert result is not None
        assert result.hour == 6
        assert result.minute == 30

    def test_none_returns_none(self):
        assert parse_submit_datetime(None) is None

    def test_empty_string_returns_none(self):
        assert parse_submit_datetime("") is None

    def test_whitespace_only_returns_none(self):
        assert parse_submit_datetime("   ") is None

    def test_garbage_returns_none(self):
        assert parse_submit_datetime("not a date") is None

    def test_result_is_timezone_aware(self):
        result = parse_submit_datetime("2026-05-07 09:00")
        assert result is not None
        assert result.tzinfo is not None

    def test_result_tzinfo_is_utc(self):
        result = parse_submit_datetime("2026-05-07 09:00")
        assert result is not None
        assert result.tzinfo == timezone.utc

    def test_iso_fallback_with_tz(self):
        result = parse_submit_datetime("2026-05-07T09:00:00+09:00")
        assert result is not None
        assert result.tzinfo == timezone.utc
        assert result.hour == 0

    def test_iso_fallback_naive_treated_as_jst(self):
        result = parse_submit_datetime("2026-05-07T09:00:00")
        assert result is not None
        assert result.tzinfo == timezone.utc
        assert result.hour == 0


# ── TestNormalizeDocument ─────────────────────────────────────────────────────

class TestNormalizeDocument:
    def test_valid_dict_returns_document(self):
        doc = normalize_document(_make_doc_dict())
        assert isinstance(doc, EdinetDocument)

    def test_missing_doc_id_returns_none(self):
        d = _make_doc_dict()
        del d["docID"]
        assert normalize_document(d) is None

    def test_empty_doc_id_returns_none(self):
        assert normalize_document(_make_doc_dict(docID="")) is None

    def test_whitespace_doc_id_returns_none(self):
        assert normalize_document(_make_doc_dict(docID="   ")) is None

    def test_missing_filer_name_returns_none(self):
        d = _make_doc_dict()
        del d["filerName"]
        assert normalize_document(d) is None

    def test_empty_filer_name_returns_none(self):
        assert normalize_document(_make_doc_dict(filerName="")) is None

    def test_url_constructed_from_base_and_doc_id(self):
        doc = normalize_document(_make_doc_dict(docID="S100ABCD"))
        assert doc is not None
        assert doc.url == f"{EDINET_BASE}/documents/S100ABCD"

    def test_period_start_end_populated(self):
        doc = normalize_document(_make_doc_dict(
            periodStart="2025-04-01", periodEnd="2026-03-31"
        ))
        assert doc is not None
        assert doc.period_start == "2025-04-01"
        assert doc.period_end == "2026-03-31"

    def test_period_start_end_none_when_absent(self):
        d = _make_doc_dict()
        d.pop("periodStart", None)
        d.pop("periodEnd", None)
        doc = normalize_document(d)
        assert doc is not None
        assert doc.period_start is None
        assert doc.period_end is None

    def test_all_fields_mapped(self):
        doc = normalize_document(_make_doc_dict())
        assert doc is not None
        assert doc.doc_id == "S100ABCD"
        assert doc.edinet_code == "E12345"
        assert doc.filer_name == "トヨタ自動車株式会社"
        assert doc.doc_description == "有価証券報告書"
        assert doc.submit_datetime == "2026-05-07 09:00"
        assert doc.doc_type_code == "120"

    def test_filer_name_stripped(self):
        doc = normalize_document(_make_doc_dict(filerName="  会社A  "))
        assert doc is not None
        assert doc.filer_name == "会社A"


# ── TestParseDocumentsResponse ────────────────────────────────────────────────

class TestParseDocumentsResponse:
    def test_empty_results_returns_empty(self):
        assert parse_documents_response(_RESPONSE_EMPTY) == []

    def test_single_document(self):
        docs = parse_documents_response(_RESPONSE_SINGLE)
        assert len(docs) == 1
        assert isinstance(docs[0], EdinetDocument)

    def test_multiple_documents(self):
        docs = parse_documents_response(_RESPONSE_THREE)
        assert len(docs) == 3

    def test_missing_results_key_returns_empty(self):
        assert parse_documents_response(_RESPONSE_NO_RESULTS_KEY) == []

    def test_none_results_value_returns_empty(self):
        assert parse_documents_response({"results": None}) == []

    def test_skips_invalid_documents(self):
        # 3件中 1件 valid, 2件 invalid
        docs = parse_documents_response(_RESPONSE_WITH_INVALID)
        assert len(docs) == 1
        assert docs[0].doc_id == "S100ABCD"

    def test_returns_list_type(self):
        result = parse_documents_response(_RESPONSE_EMPTY)
        assert isinstance(result, list)

    def test_document_fields_correct(self):
        docs = parse_documents_response(_RESPONSE_SINGLE)
        doc = docs[0]
        assert doc.doc_id == "S100ABCD"
        assert doc.filer_name == "トヨタ自動車株式会社"


# ── TestEdinetDocumentToNewsItem ──────────────────────────────────────────────

class TestEdinetDocumentToNewsItem:
    def _make_doc(self, **kwargs) -> EdinetDocument:
        defaults = dict(
            doc_id="S100ABCD",
            edinet_code="E12345",
            filer_name="トヨタ自動車株式会社",
            doc_description="有価証券報告書",
            submit_datetime="2026-05-07 09:00",
            doc_type_code="120",
            url=f"{EDINET_BASE}/documents/S100ABCD",
            period_start="2025-04-01",
            period_end="2026-03-31",
        )
        defaults.update(kwargs)
        return EdinetDocument(**defaults)

    def test_source_id_is_edinet(self):
        item = edinet_document_to_news_item(self._make_doc())
        assert item.source_id == "edinet"

    def test_title_combines_filer_and_description(self):
        item = edinet_document_to_news_item(self._make_doc())
        assert item.title == "トヨタ自動車株式会社 - 有価証券報告書"

    def test_title_filer_only_when_no_description(self):
        doc = self._make_doc(doc_description="")
        item = edinet_document_to_news_item(doc)
        assert item.title == "トヨタ自動車株式会社"
        assert " - " not in item.title

    def test_url_from_doc_url(self):
        url = f"{EDINET_BASE}/documents/S100ABCD"
        item = edinet_document_to_news_item(self._make_doc(url=url))
        assert item.url == url

    def test_summary_is_doc_description(self):
        item = edinet_document_to_news_item(self._make_doc())
        assert item.summary == "有価証券報告書"

    def test_published_at_from_submit_datetime(self):
        item = edinet_document_to_news_item(self._make_doc(submit_datetime="2026-05-07 09:00"))
        assert item.published_at is not None
        assert isinstance(item.published_at, datetime)
        assert item.published_at.tzinfo == timezone.utc

    def test_published_at_none_when_empty_datetime(self):
        item = edinet_document_to_news_item(self._make_doc(submit_datetime=""))
        assert item.published_at is None

    def test_language_is_ja(self):
        item = edinet_document_to_news_item(self._make_doc())
        assert item.language == "ja"

    def test_categories_tuple(self):
        item = edinet_document_to_news_item(self._make_doc())
        assert item.categories == ("disclosure", "regulatory")
        assert isinstance(item.categories, tuple)

    def test_returns_news_item_instance(self):
        item = edinet_document_to_news_item(self._make_doc())
        assert isinstance(item, NewsItem)


# ── TestFetchEdinetDocuments ──────────────────────────────────────────────────

class TestFetchEdinetDocuments:
    def _fetcher(self, data: dict):
        """fixture dict を返す fetcher_fn を生成する。"""
        return lambda url: json.dumps(data, ensure_ascii=False)

    def test_success_populates_items(self):
        result = fetch_edinet_documents(
            date(2026, 5, 7), self._fetcher(_RESPONSE_SINGLE)
        )
        assert result.success is True
        assert len(result.items) == 1

    def test_success_true_on_valid_response(self):
        result = fetch_edinet_documents(
            date(2026, 5, 7), self._fetcher(_RESPONSE_SINGLE)
        )
        assert result.success is True
        assert result.error is None

    def test_fetcher_exception_sets_error(self):
        def bad_fetcher(url: str) -> str:
            raise ConnectionError("network timeout")

        result = fetch_edinet_documents(date(2026, 5, 7), bad_fetcher)
        assert result.success is False
        assert result.error is not None
        assert "timeout" in result.error

    def test_fetcher_exception_success_false(self):
        result = fetch_edinet_documents(
            date(2026, 5, 7), lambda url: (_ for _ in ()).throw(RuntimeError("fail"))
        )
        assert result.success is False

    def test_invalid_json_sets_error(self):
        result = fetch_edinet_documents(
            date(2026, 5, 7), lambda url: "NOT JSON {"
        )
        assert result.success is False
        assert result.error is not None

    def test_date_in_url(self):
        seen_urls: list[str] = []

        def capturing_fetcher(url: str) -> str:
            seen_urls.append(url)
            return json.dumps(_RESPONSE_EMPTY)

        fetch_edinet_documents(date(2026, 5, 7), capturing_fetcher)
        assert len(seen_urls) == 1
        assert "2026-05-07" in seen_urls[0]

    def test_doc_type_in_url(self):
        seen_urls: list[str] = []

        def capturing_fetcher(url: str) -> str:
            seen_urls.append(url)
            return json.dumps(_RESPONSE_EMPTY)

        fetch_edinet_documents(date(2026, 5, 7), capturing_fetcher, doc_type=1)
        assert "type=1" in seen_urls[0]

    def test_fetched_at_is_utc(self):
        result = fetch_edinet_documents(
            date(2026, 5, 7), self._fetcher(_RESPONSE_EMPTY)
        )
        assert result.fetched_at.tzinfo == timezone.utc

    def test_empty_results_success_true(self):
        result = fetch_edinet_documents(
            date(2026, 5, 7), self._fetcher(_RESPONSE_EMPTY)
        )
        assert result.success is True
        assert result.items == []

    def test_total_count_from_metadata(self):
        result = fetch_edinet_documents(
            date(2026, 5, 7), self._fetcher(_RESPONSE_SINGLE)
        )
        assert result.total_count == 1

    def test_total_count_fallback_to_len_docs(self):
        # metadata.resultset.count が存在しない場合は len(docs) にフォールバック
        data = {"results": [_make_doc_dict(), _make_doc_dict(docID="S100BBBB", filerName="会社B")]}
        result = fetch_edinet_documents(date(2026, 5, 7), self._fetcher(data))
        assert result.total_count == 2

    def test_target_date_preserved_in_result(self):
        result = fetch_edinet_documents(
            date(2026, 5, 7), self._fetcher(_RESPONSE_EMPTY)
        )
        assert result.target_date == date(2026, 5, 7)

    def test_doc_type_preserved_in_result(self):
        result = fetch_edinet_documents(
            date(2026, 5, 7), self._fetcher(_RESPONSE_EMPTY), doc_type=1
        )
        assert result.doc_type == 1

    def test_multiple_docs_all_converted(self):
        result = fetch_edinet_documents(
            date(2026, 5, 7), self._fetcher(_RESPONSE_THREE)
        )
        assert len(result.items) == 3
        assert all(isinstance(i, NewsItem) for i in result.items)
