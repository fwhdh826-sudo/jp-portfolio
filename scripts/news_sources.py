"""
ニュースソース定義 & フェッチ
取得できるもの: Yahoo!ファイナンスRSS, MINKABU RSS
Bloomberg/Reuters/四季報はログイン必須のため対象外
"""
import feedparser
import hashlib
from datetime import datetime, timezone
from typing import Optional

SOURCES = [
    # Yahoo!ファイナンス マーケット
    {
        "id": "yahoo_market",
        "name": "Yahoo!ファイナンス",
        "url": "https://finance.yahoo.co.jp/rss/news/market",
        "type": "market",
        "priority": 2,
    },
    # Yahoo!ファイナンス ニュース
    {
        "id": "yahoo_news",
        "name": "Yahoo!ファイナンス",
        "url": "https://finance.yahoo.co.jp/rss/news",
        "type": "mixed",
        "priority": 2,
    },
]

# 保有銘柄ティッカー（コード→社名マッピング用）
HOLDINGS_MAP = {
    '6098': 'リクルート', '8306': '三菱UFJ', '9697': 'カプコン',
    '4661': 'OLC',       '8593': '三菱HC',  '4755': '楽天',
    '5711': '三菱マテリアル', '1605': 'INPEX', '5016': 'JX金属',
    '8058': '三菱商事', '9418': 'Uネクスト', '1928': '積水ハウス',
    '7011': '三菱重工', '7974': '任天堂', '9433': 'KDDI', '7012': '川崎重工',
}

def make_id(url: str, title: str) -> str:
    return hashlib.md5(f"{url}|{title}".encode()).hexdigest()[:16]

def fetch_source(src: dict, timeout: int = 10) -> tuple[str, list[dict]]:
    """単一ソース取得。失敗は空リストを返し例外を伝播しない"""
    try:
        feed = feedparser.parse(src['url'])
        items = []
        for entry in feed.entries[:30]:
            published = entry.get('published', '') or entry.get('updated', '')
            try:
                dt = datetime(*entry.published_parsed[:6], tzinfo=timezone.utc).isoformat()
            except Exception:
                dt = datetime.now(timezone.utc).isoformat()
            items.append({
                'raw_id':    make_id(entry.get('link',''), entry.get('title','')),
                'source':    src['name'],
                'title':     entry.get('title','').strip(),
                'summary':   entry.get('summary', entry.get('description', ''))[:300].strip(),
                'url':       entry.get('link', ''),
                'publishedAt': dt,
                'type':      src['type'],
            })
        return 'ok', items
    except Exception as e:
        return 'error', []

def fetch_all() -> tuple[dict, list[dict]]:
    """全ソースフェッチ。sourceStatus と raw_items を返す"""
    status = {}
    all_items = []
    for src in SOURCES:
        st, items = fetch_source(src)
        status[src['id']] = st
        all_items.extend(items)
    return status, all_items
