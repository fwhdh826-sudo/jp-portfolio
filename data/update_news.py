#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
update_news.py — v10.0
複数ソースを横断収集し、marketNews/stockNews を同時更新する。

対応ソース:
- Yahoo!ファイナンス (market/news)
- Reuters (business/markets)
- Bloomberg (markets/economics)
- NHK 経済
- Reddit (r/investing, r/stocks)
- Finnhub (APIキー指定時)
- X (RSS URL指定時)
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
DATA_DIR = PROJECT_ROOT / "data"
PUBLIC_DIR = PROJECT_ROOT / "public" / "data"
OUT_FILES = [DATA_DIR / "news.json", PUBLIC_DIR / "news.json"]

RSS_SOURCES = [
    {
        "name": "Yahoo!ファイナンス Market",
        "url": "https://finance.yahoo.co.jp/rss/news/market",
        "category": "market",
    },
    {
        "name": "Yahoo!ファイナンス News",
        "url": "https://finance.yahoo.co.jp/rss/news",
        "category": "market",
    },
    {
        "name": "Reuters Business",
        "url": "https://feeds.reuters.com/reuters/businessNews",
        "category": "market",
    },
    {
        "name": "Reuters Markets",
        "url": "https://feeds.reuters.com/reuters/marketsNews",
        "category": "market",
    },
    {
        "name": "Bloomberg Markets",
        "url": "https://feeds.bloomberg.com/markets/news.rss",
        "category": "market",
    },
    {
        "name": "Bloomberg Economics",
        "url": "https://feeds.bloomberg.com/economics/news.rss",
        "category": "market",
    },
    {
        "name": "NHK 経済",
        "url": "https://www.nhk.or.jp/rss/news/cat4.xml",
        "category": "market",
    },
    {
        "name": "reddit r/investing",
        "url": "https://www.reddit.com/r/investing/.rss",
        "category": "social",
    },
    {
        "name": "reddit r/stocks",
        "url": "https://www.reddit.com/r/stocks/.rss",
        "category": "social",
    },
]

TRUST_KEYWORDS = [
    "日経225",
    "S&P500",
    "NASDAQ",
    "FANG",
    "オルカン",
    "ゴールド",
    "REIT",
    "ETF",
    "投信",
    "米国株",
]

HOLDING_KEYWORDS = {
    "8306": ["三菱UFJ", "三菱ＵＦＪ", "MUFG"],
    "8593": ["三菱HC", "三菱ＨＣ", "三菱HCキャピタル"],
    "8058": ["三菱商事"],
    "7011": ["三菱重工", "三菱重"],
    "7012": ["川崎重工", "川重"],
    "5711": ["三菱マテリアル"],
    "9697": ["カプコン", "CAPCOM"],
    "7974": ["任天堂", "Nintendo"],
    "1605": ["INPEX", "ＩＮＰＥＸ"],
    "5016": ["ENEOS", "ＪＸ金属", "JX金属"],
    "6098": ["リクルート", "Recruit"],
    "9433": ["KDDI", "ＫＤＤＩ", "au"],
    "9418": ["U-NEXT", "USEN", "ＵＳＥＮ"],
    "4661": ["オリエンタルランド", "OLC", "TDR"],
    "1928": ["積水ハウス"],
    "4755": ["楽天", "楽天グループ", "Rakuten"],
    "5021": ["JX金属", "ＪＸ金属"],
}

POS_WORDS = [
    "上昇",
    "高値",
    "好調",
    "回復",
    "改善",
    "最高益",
    "増益",
    "増収",
    "急伸",
    "反発",
    "堅調",
    "上方修正",
    "期待",
    "強気",
    "追い風",
    "買い",
    "続伸",
    "成長",
    "Beat",
    "beat",
]

NEG_WORDS = [
    "下落",
    "安値",
    "不調",
    "悪化",
    "減益",
    "減収",
    "急落",
    "反落",
    "軟調",
    "下方修正",
    "懸念",
    "弱気",
    "逆風",
    "売り",
    "続落",
    "赤字",
    "Miss",
    "miss",
    "縮小",
    "停滞",
    "警戒",
]

IMPORTANT_KEYWORDS = [
    "日銀",
    "FRB",
    "FOMC",
    "利上げ",
    "利下げ",
    "決算",
    "GDP",
    "CPI",
    "雇用統計",
    "SQ",
    "VIX",
    "円安",
    "円高",
    "原油",
    "金価格",
]


def log(msg: str) -> None:
    print(f"[update_news] {msg}", flush=True)


def normalize_title(title: str) -> str:
    if not title:
        return ""
    cleaned = re.sub(r"<[^>]+>", "", title)
    return re.sub(r"[\s\u3000]+", " ", cleaned).strip()


def normalize_url(url: str) -> str:
    if not url:
        return ""
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"


def normalize_summary(summary: str) -> str:
    if not summary:
        return ""
    cleaned = re.sub(r"<[^>]+>", "", summary)
    return re.sub(r"[\s\u3000]+", " ", cleaned).strip()


def parse_published(raw: str) -> str:
    if not raw:
        return dt.datetime.now().isoformat(timespec="seconds")
    try:
        from email.utils import parsedate_to_datetime

        parsed = parsedate_to_datetime(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(dt.timezone.utc).isoformat(timespec="seconds")
    except Exception:
        try:
            return dt.datetime.fromisoformat(raw.replace("Z", "+00:00")).isoformat(timespec="seconds")
        except Exception:
            return dt.datetime.now().isoformat(timespec="seconds")


def similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0

    def ngrams(text: str, n: int = 3) -> set[str]:
        if len(text) < n:
            return {text}
        return {text[i : i + n] for i in range(len(text) - n + 1)}

    left, right = ngrams(a), ngrams(b)
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def compute_sentiment(title: str, summary: str) -> tuple[str, float]:
    text = f"{title} {summary}"
    pos = sum(1 for word in POS_WORDS if word in text)
    neg = sum(1 for word in NEG_WORDS if word in text)
    total = pos + neg
    if total == 0:
        return "neutral", 0.0
    score = (pos - neg) / max(total, 1)
    if score > 0.2:
        return "positive", round(score, 2)
    if score < -0.2:
        return "negative", round(score, 2)
    return "neutral", round(score, 2)


def compute_importance(title: str, summary: str, source: str, tickers: list[str]) -> float:
    text = f"{title} {summary}"
    score = 0.25
    score += min(0.35, len(tickers) * 0.14)
    score += min(0.35, sum(1 for word in IMPORTANT_KEYWORDS if word in text) * 0.08)
    if "Reuters" in source or "Bloomberg" in source:
        score += 0.08
    if "reddit" in source:
        score -= 0.05
    return round(max(0.05, min(1.0, score)), 2)


def classify_impact(score: float) -> str:
    if score > 0.2:
        return "positive"
    if score < -0.2:
        return "negative"
    return "neutral"


def map_tickers(title: str, summary: str) -> list[str]:
    text = f"{title} {summary}"
    hit_codes: list[str] = []
    for code, keywords in HOLDING_KEYWORDS.items():
        if any(keyword in text for keyword in keywords):
            hit_codes.append(code)
    return sorted(set(hit_codes))


def build_why_important(importance: float, tickers: list[str], source: str) -> str:
    if tickers and importance >= 0.7:
        return "保有・候補銘柄に直接関連し、売買判断へ直結するため。"
    if tickers:
        return "関連銘柄の前提確認に必要なため。"
    if "reddit" in source:
        return "個人投資家のセンチメント変化を早期に検知するため。"
    if importance >= 0.7:
        return "市場全体の地合いとボラティリティに影響しやすいため。"
    return "短期の地合い把握に有用なため。"


def build_recommendation(score: float, importance: float, tickers: list[str]) -> str:
    if score < -0.25 and tickers:
        return "関連銘柄の損切条件・前提崩れ条件を再確認する。"
    if score > 0.25 and tickers:
        return "分割エントリー可能か、理想PF差分と合わせて確認する。"
    if importance >= 0.75:
        return "寄り付き前に市場モード判定を更新する。"
    return "監視継続。次回更新時に再評価する。"


def to_news_item(source_name: str, category: str, title: str, summary: str, url: str, published_at: str) -> dict[str, Any]:
    normalized_title = normalize_title(title)
    normalized_summary = normalize_summary(summary)
    normalized_url = normalize_url(url)
    tickers = map_tickers(normalized_title, normalized_summary)
    sentiment, sentiment_score = compute_sentiment(normalized_title, normalized_summary)
    importance = compute_importance(normalized_title, normalized_summary, source_name, tickers)
    impact = classify_impact(sentiment_score)
    tags = [category]
    if any(keyword in f"{normalized_title} {normalized_summary}" for keyword in TRUST_KEYWORDS):
        tags.append("trust")

    seed = f"{normalized_url}|{normalized_title}|{source_name}"
    uid = hashlib.md5(seed.encode("utf-8")).hexdigest()[:12]

    return {
        "id": uid,
        "source": source_name,
        "title": normalized_title,
        "summary": normalized_summary[:240],
        "url": normalized_url,
        "publishedAt": parse_published(published_at),
        "sentiment": sentiment,
        "sentimentScore": sentiment_score,
        "importance": importance,
        "tags": tags,
        "tickers": tickers,
        "impact": impact,
        "whyImportant": build_why_important(importance, tickers, source_name),
        "recommendation": build_recommendation(sentiment_score, importance, tickers),
    }


def fetch_rss_source(src: dict[str, str]) -> tuple[str, list[dict[str, Any]], str | None]:
    try:
        import feedparser
    except Exception:
        log("feedparser not installed (pip install feedparser)")
        return "error", [], None

    try:
        log(f"  fetching RSS: {src['name']}")
        feed = feedparser.parse(src["url"])
        entries = getattr(feed, "entries", [])
        if not entries:
            return "timeout", [], None

        items: list[dict[str, Any]] = []
        latest_ts: str | None = None
        for entry in entries[:35]:
            title = entry.get("title", "")
            summary = entry.get("summary", entry.get("description", ""))
            url = entry.get("link", "")
            published = entry.get("published", entry.get("updated", ""))

            if not title or not url:
                continue

            item = to_news_item(
                source_name=src["name"],
                category=src["category"],
                title=title,
                summary=summary,
                url=url,
                published_at=published,
            )
            items.append(item)
            ts = item["publishedAt"]
            if latest_ts is None or ts > latest_ts:
                latest_ts = ts

        if not items:
            return "timeout", [], None
        return "ok", items, latest_ts
    except Exception as exc:
        log(f"    ERR {src['name']}: {exc}")
        return "error", [], None


def fetch_json(url: str, headers: dict[str, str] | None = None) -> Any:
    request = Request(url, headers=headers or {"User-Agent": "Mozilla/5.0"})
    with urlopen(request, timeout=12) as response:
        body = response.read().decode("utf-8")
    return json.loads(body)


def fetch_finnhub() -> tuple[str, list[dict[str, Any]], str | None]:
    token = os.getenv("FINNHUB_API_KEY", "").strip()
    if not token:
        return "timeout", [], None
    try:
        url = f"https://finnhub.io/api/v1/news?category=general&token={token}"
        raw = fetch_json(url)
        if not isinstance(raw, list) or len(raw) == 0:
            return "timeout", [], None

        items: list[dict[str, Any]] = []
        latest_ts: str | None = None
        for row in raw[:40]:
            published_epoch = row.get("datetime", 0)
            published = (
                dt.datetime.fromtimestamp(published_epoch, tz=dt.timezone.utc).isoformat(timespec="seconds")
                if isinstance(published_epoch, (int, float)) and published_epoch > 0
                else dt.datetime.now(tz=dt.timezone.utc).isoformat(timespec="seconds")
            )
            item = to_news_item(
                source_name="Finnhub",
                category="market",
                title=str(row.get("headline", "")),
                summary=str(row.get("summary", "")),
                url=str(row.get("url", "")),
                published_at=published,
            )
            if not item["title"] or not item["url"]:
                continue
            items.append(item)
            if latest_ts is None or item["publishedAt"] > latest_ts:
                latest_ts = item["publishedAt"]

        if not items:
            return "timeout", [], None
        return "ok", items, latest_ts
    except Exception as exc:
        log(f"    ERR Finnhub: {exc}")
        return "error", [], None


def fetch_x_feed() -> tuple[str, list[dict[str, Any]], str | None]:
    rss_url = os.getenv("X_RSS_URL", "").strip()
    if not rss_url:
        return "timeout", [], None
    return fetch_rss_source(
        {
            "name": "X (RSS mirror)",
            "url": rss_url,
            "category": "social",
        }
    )


def dedupe(items: list[dict[str, Any]], sim_threshold: float = 0.68) -> tuple[list[dict[str, Any]], int]:
    seen_urls: set[str] = set()
    seen_titles: list[str] = []
    result: list[dict[str, Any]] = []
    removed = 0

    for item in items:
        url = item.get("url", "")
        title = item.get("title", "")
        if not url or not title:
            removed += 1
            continue
        if url in seen_urls:
            removed += 1
            continue
        if any(similarity(title, existing) > sim_threshold for existing in seen_titles):
            removed += 1
            continue
        seen_urls.add(url)
        seen_titles.append(title)
        result.append(item)

    return result, removed


def classify_market_or_stock(item: dict[str, Any]) -> str:
    if item.get("tickers"):
        return "stock"
    title = item.get("title", "")
    summary = item.get("summary", "")
    text = f"{title} {summary}"
    if any(keyword in text for keyword in TRUST_KEYWORDS):
        return "stock"
    return "market"


def build_empty_payload() -> dict[str, Any]:
    now = dt.datetime.now().isoformat(timespec="seconds")
    return {
        "updatedAt": now,
        "sourceStatus": {},
        "sourceUpdatedAt": {},
        "marketNews": [],
        "stockNews": [],
        "meta": {
            "totalCount": 0,
            "marketCount": 0,
            "stockCount": 0,
            "duplicateRemoved": 0,
        },
    }


def main() -> int:
    log("start")
    payload = build_empty_payload()

    all_items: list[dict[str, Any]] = []
    source_status: dict[str, str] = {}
    source_updated_at: dict[str, str | None] = {}

    for src in RSS_SOURCES:
        status, items, latest_ts = fetch_rss_source(src)
        source_status[src["name"]] = status
        source_updated_at[src["name"]] = latest_ts
        all_items.extend(items)

    finnhub_status, finnhub_items, finnhub_ts = fetch_finnhub()
    source_status["Finnhub"] = finnhub_status
    source_updated_at["Finnhub"] = finnhub_ts
    all_items.extend(finnhub_items)

    x_status, x_items, x_ts = fetch_x_feed()
    source_status["X (RSS mirror)"] = x_status
    source_updated_at["X (RSS mirror)"] = x_ts
    all_items.extend(x_items)

    if len(all_items) == 0:
        log("no fetched items. keep existing file if present.")
        existing_path = DATA_DIR / "news.json"
        if existing_path.exists():
            existing = json.loads(existing_path.read_text(encoding="utf-8"))
            existing["updatedAt"] = dt.datetime.now().isoformat(timespec="seconds")
            existing["sourceStatus"] = source_status
            existing["sourceUpdatedAt"] = source_updated_at
            payload = existing
        else:
            payload["sourceStatus"] = source_status
            payload["sourceUpdatedAt"] = source_updated_at
    else:
        cleaned, removed = dedupe(all_items)
        cleaned.sort(
            key=lambda item: (float(item.get("importance", 0)), item.get("publishedAt", "")),
            reverse=True,
        )

        market_news = [item for item in cleaned if classify_market_or_stock(item) == "market"][:48]
        stock_news = [item for item in cleaned if classify_market_or_stock(item) == "stock"][:42]

        payload = {
            "updatedAt": dt.datetime.now().isoformat(timespec="seconds"),
            "sourceStatus": source_status,
            "sourceUpdatedAt": source_updated_at,
            "marketNews": market_news,
            "stockNews": stock_news,
            "meta": {
                "totalCount": len(market_news) + len(stock_news),
                "marketCount": len(market_news),
                "stockCount": len(stock_news),
                "duplicateRemoved": removed,
            },
        }

    for out in OUT_FILES:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"wrote {out}")

    log(
        "done: market=%s stock=%s"
        % (len(payload.get("marketNews", [])), len(payload.get("stockNews", [])))
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        log(f"FATAL: {exc}")
        sys.exit(0)
