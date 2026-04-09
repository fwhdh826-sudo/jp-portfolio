"""
news.json スキーマ定義とバリデーション
"""
from dataclasses import dataclass, field
from typing import Literal, Optional
import json

Sentiment = Literal['positive', 'neutral', 'negative']
SourceStatus = Literal['ok', 'error', 'timeout']

def validate_news_json(data: dict) -> tuple[bool, str]:
    """壊れたJSONを保存しない — バリデーション通過のみ書き込み許可"""
    try:
        required_keys = ['updatedAt', 'sourceStatus', 'marketNews', 'stockNews', 'meta']
        for k in required_keys:
            if k not in data:
                return False, f"missing key: {k}"

        meta = data['meta']
        for mk in ['totalCount', 'marketCount', 'stockCount', 'duplicateRemoved']:
            if mk not in meta:
                return False, f"meta missing: {mk}"

        for item in data['marketNews'] + data['stockNews']:
            for ik in ['id', 'source', 'title', 'summary', 'url', 'publishedAt', 'sentiment', 'sentimentScore', 'importance', 'tags', 'tickers']:
                if ik not in item:
                    return False, f"news item missing: {ik}"
            if not isinstance(item['sentimentScore'], (int, float)):
                return False, "sentimentScore must be numeric"
            if not (-1.0 <= item['sentimentScore'] <= 1.0):
                return False, "sentimentScore out of range"

        return True, "ok"
    except Exception as e:
        return False, str(e)

def empty_news_json() -> dict:
    """データなし時の安全な空スキーマ"""
    from datetime import datetime
    return {
        "updatedAt": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "sourceStatus": {},
        "marketNews": [],
        "stockNews": [],
        "meta": {
            "totalCount": 0,
            "marketCount": 0,
            "stockCount": 0,
            "duplicateRemoved": 0
        }
    }
