"""
P4.5-A005: titleJa/summaryJa/translationStatus 生成の回帰テスト

テスト対象:
  data/update_news.py の is_japanese_text() / translate_to_ja() / build_translation_fields()

確認項目:
  - 日本語記事は titleJa/summaryJa=原文, translationStatus='ja-original' になる
  - 英語記事で翻訳APIが未設定の場合、translationStatus='pending' になり例外を投げない
  - 英語記事で翻訳APIが使える場合、translationStatus='translated' になる
  - 翻訳API呼び出しが失敗しても例外を投げず 'pending' にfallbackする
  - to_news_item() の戻り値に必ず translationStatus が含まれる（既存フィールドは維持）
"""

import json
from urllib.error import URLError

import pytest

from data.update_news import (
    build_translation_fields,
    is_japanese_text,
    to_news_item,
    translate_to_ja,
)


class TestIsJapaneseText:
    def test_pure_japanese_is_true(self):
        assert is_japanese_text("日経平均株価が大幅反発、金融株が牽引した") is True

    def test_pure_english_is_false(self):
        assert is_japanese_text("Stocks rally as inflation cools across major markets") is False

    def test_empty_string_is_false(self):
        assert is_japanese_text("") is False

    def test_mixed_with_majority_japanese_is_true(self):
        assert is_japanese_text("日経225が3万円を回復。Nikkei sets new high.") is True

    def test_mixed_with_majority_english_is_false(self):
        assert is_japanese_text("Nikkei 225 index rises past 30000 level今日") is False


class TestTranslateToJa:
    def test_no_api_key_returns_none(self, monkeypatch):
        monkeypatch.delenv("DEEPL_API_KEY", raising=False)
        assert translate_to_ja("Stocks rally") is None

    def test_empty_text_returns_none_even_with_key(self, monkeypatch):
        monkeypatch.setenv("DEEPL_API_KEY", "dummy-key")
        assert translate_to_ja("") is None

    def test_successful_translation_with_mocked_api(self, monkeypatch):
        monkeypatch.setenv("DEEPL_API_KEY", "dummy-key")

        class _FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return json.dumps({"translations": [{"text": "株価が上昇"}]}).encode("utf-8")

        monkeypatch.setattr("data.update_news.urlopen", lambda *a, **k: _FakeResponse())
        result = translate_to_ja("Stocks rally")
        assert result == "株価が上昇"

    def test_api_failure_returns_none_not_exception(self, monkeypatch):
        monkeypatch.setenv("DEEPL_API_KEY", "dummy-key")

        def _raise(*args, **kwargs):
            raise URLError("network down")

        monkeypatch.setattr("data.update_news.urlopen", _raise)
        # 例外を投げず None を返すこと（ワークフロー全体を落とさない）
        assert translate_to_ja("Stocks rally") is None

    def test_malformed_response_returns_none(self, monkeypatch):
        monkeypatch.setenv("DEEPL_API_KEY", "dummy-key")

        class _FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return json.dumps({"translations": []}).encode("utf-8")

        monkeypatch.setattr("data.update_news.urlopen", lambda *a, **k: _FakeResponse())
        assert translate_to_ja("Stocks rally") is None


class TestBuildTranslationFields:
    def test_japanese_article_gets_ja_original_status(self):
        fields = build_translation_fields("日銀が金融政策を維持", "市場は限定的な反応にとどまった。")
        assert fields["translationStatus"] == "ja-original"
        assert fields["titleJa"] == "日銀が金融政策を維持"
        assert fields["summaryJa"] == "市場は限定的な反応にとどまった。"

    def test_english_article_without_api_key_is_pending(self, monkeypatch):
        monkeypatch.delenv("DEEPL_API_KEY", raising=False)
        fields = build_translation_fields("Stocks rally as inflation cools", "US equities rose broadly.")
        assert fields["translationStatus"] == "pending"
        assert "titleJa" not in fields
        assert "summaryJa" not in fields

    def test_english_article_with_working_api_is_translated(self, monkeypatch):
        monkeypatch.setenv("DEEPL_API_KEY", "dummy-key")

        class _FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return json.dumps({"translations": [{"text": "インフレ鈍化で株高"}]}).encode("utf-8")

        monkeypatch.setattr("data.update_news.urlopen", lambda *a, **k: _FakeResponse())
        fields = build_translation_fields("Stocks rally as inflation cools", "")
        assert fields["translationStatus"] == "translated"
        assert fields["titleJa"] == "インフレ鈍化で株高"
        assert "translatedAt" in fields


class TestToNewsItemIncludesTranslationStatus:
    def test_japanese_item_has_ja_original_status(self):
        item = to_news_item(
            source_name="NHK 経済",
            category="market",
            title="日銀が政策金利を据え置き",
            summary="市場は事前予想通りと受け止めた。",
            url="https://example.com/a",
            published_at="",
        )
        assert item["translationStatus"] == "ja-original"
        assert item["titleJa"] == "日銀が政策金利を据え置き"

    def test_english_item_without_api_key_is_pending_and_json_serializable(self, monkeypatch):
        monkeypatch.delenv("DEEPL_API_KEY", raising=False)
        item = to_news_item(
            source_name="Bloomberg Markets",
            category="market",
            title="Stocks rally as inflation cools",
            summary="US equities rose broadly after the CPI report.",
            url="https://example.com/b",
            published_at="",
        )
        assert item["translationStatus"] == "pending"
        # 既存フィールドは維持され、JSON化しても失敗しない
        json.dumps(item, ensure_ascii=False)
        assert item["title"] == "Stocks rally as inflation cools"
