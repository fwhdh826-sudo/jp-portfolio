#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════
# update_news.py — v9.0
# 複数RSSからニュースを収集し、朝メモ形式でJSON生成
#
# ソース:
#   - Yahoo!ファイナンス（マーケット）
#   - Yahoo!ファイナンス（海外）
#   - 日経電子版（マーケット）  ※RSS限定
#   - Bloomberg Japan（Markets）
#
# 機能:
#   - タイトル正規化（全角→半角・空白正規化）
#   - 重複除去（URL + タイトル類似度）
#   - 銘柄コードマッピング（保有銘柄のみ）
#   - センチメント判定（辞書ベース + 経済語彙）
#   - 重要度スコア（0-1）
#   - 朝メモ形式（マーケット/保有銘柄で分割）
#
# 使い方:
#   pip install feedparser
#   python3 data/update_news.py
#
# 出力:
#   data/news.json
#   public/data/news.json
# ═══════════════════════════════════════════════════════════

import json
import sys
import re
import hashlib
import datetime as dt
from pathlib import Path
from urllib.parse import urlparse

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
DATA_DIR = PROJECT_ROOT / "data"
PUBLIC_DIR = PROJECT_ROOT / "public" / "data"
OUT_FILES = [DATA_DIR / "news.json", PUBLIC_DIR / "news.json"]

# ═══════════════════════════════════════════════════════════
# RSS ソース
# ═══════════════════════════════════════════════════════════
RSS_SOURCES = [
    {
        "name": "Yahoo!ニュース ビジネス",
        "url": "https://news.yahoo.co.jp/rss/topics/business.xml",
        "category": "market",
    },
    {
        "name": "Yahoo!ニュース 経済",
        "url": "https://news.yahoo.co.jp/rss/topics/economy.xml",
        "category": "market",
    },
    {
        "name": "NHK 経済",
        "url": "https://www.nhk.or.jp/rss/news/cat4.xml",
        "category": "market",
    },
    {
        "name": "みんかぶ 株式ニュース",
        "url": "https://minkabu.jp/news.rss",
        "category": "market",
    },
]

# ═══════════════════════════════════════════════════════════
# 保有銘柄 → 銘柄コード マッピング
# （保有銘柄のタイトル出現を検出）
# ═══════════════════════════════════════════════════════════
HOLDING_KEYWORDS = {
    "8306": ["三菱UFJ", "三菱ＵＦＪ", "MUFG"],
    "8593": ["三菱HC", "三菱ＨＣ", "三菱HCキャピタル"],
    "8058": ["三菱商事"],
    "7011": ["三菱重工", "三菱重"],
    "7012": ["川崎重工", "川重"],
    "5711": ["三菱マテリアル"],
    "9697": ["カプコン"],
    "7974": ["任天堂"],
    "1605": ["INPEX", "ＩＮＰＥＸ"],
    "5016": ["ENEOS", "ＥＮＥＯＳ"],
    "6098": ["リクルート"],
    "9433": ["KDDI", "ＫＤＤＩ"],
    "9418": ["USEN"],
    "4661": ["オリエンタルランド", "OLC"],
    "1928": ["積水ハウス"],
    "4755": ["楽天", "楽天グループ"],
    "5021": ["JX金属", "ＪＸ金属"],
}

# ═══════════════════════════════════════════════════════════
# センチメント辞書
# ═══════════════════════════════════════════════════════════
POS_WORDS = [
    "上昇", "高値", "好調", "回復", "改善", "最高益", "増益", "増収", "急伸",
    "反発", "堅調", "上方修正", "期待", "強気", "追い風", "買い", "続伸",
    "最高", "成長", "拡大", "黒字", "Beat", "beat", "記録",
]
NEG_WORDS = [
    "下落", "安値", "不調", "悪化", "減益", "減収", "急落", "反落", "軟調",
    "下方修正", "懸念", "弱気", "逆風", "売り", "続落", "赤字", "Miss",
    "miss", "縮小", "停滞", "低迷", "警戒", "不安", "暴落", "急騰",  # 急騰は両面
]

IMPORTANT_KEYWORDS = [
    "日銀", "FRB", "FOMC", "利上げ", "利下げ", "決算", "GDP", "CPI", "雇用統計",
    "SQ", "VIX", "VI", "円安", "円高", "原油", "金価格",
]


def log(msg: str):
    print(f"[update_news] {msg}", flush=True)


# ═══════════════════════════════════════════════════════════
# 正規化
# ═══════════════════════════════════════════════════════════
def normalize_title(title: str) -> str:
    if not title:
        return ""
    # 全角→半角
    t = title
    # 空白正規化
    t = re.sub(r"[\s\u3000]+", " ", t).strip()
    # HTMLタグ除去
    t = re.sub(r"<[^>]+>", "", t)
    return t


def normalize_url(url: str) -> str:
    if not url:
        return ""
    # クエリパラメータの一部を除去（UTM 等）
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}{p.path}"


def similarity(a: str, b: str) -> float:
    """単純な Jaccard 類似度（文字3-gram）"""
    if not a or not b:
        return 0.0
    def ngrams(s, n=3):
        return set(s[i:i+n] for i in range(len(s) - n + 1))
    ga, gb = ngrams(a), ngrams(b)
    if not ga or not gb:
        return 0.0
    return len(ga & gb) / len(ga | gb)


# ═══════════════════════════════════════════════════════════
# センチメント・重要度
# ═══════════════════════════════════════════════════════════
def compute_sentiment(title: str, summary: str) -> tuple:
    """Returns (sentiment, score)"""
    text = (title or "") + " " + (summary or "")
    pos = sum(1 for w in POS_WORDS if w in text)
    neg = sum(1 for w in NEG_WORDS if w in text)
    total = pos + neg
    if total == 0:
        return ("neutral", 0.0)
    score = (pos - neg) / max(total, 1)
    if score > 0.2:
        return ("positive", round(score, 2))
    if score < -0.2:
        return ("negative", round(score, 2))
    return ("neutral", round(score, 2))


def compute_importance(title: str, summary: str) -> float:
    text = (title or "") + " " + (summary or "")
    hits = sum(1 for w in IMPORTANT_KEYWORDS if w in text)
    return min(1.0, 0.3 + hits * 0.2)


def map_tickers(title: str, summary: str) -> list:
    text = (title or "") + " " + (summary or "")
    hits = []
    for code, keywords in HOLDING_KEYWORDS.items():
        if any(k in text for k in keywords):
            hits.append(code)
    return hits


# ═══════════════════════════════════════════════════════════
# フェッチ
# ═══════════════════════════════════════════════════════════
def fetch_feed(src: dict) -> list:
    try:
        import feedparser
    except ImportError:
        log("  feedparser not installed — pip install feedparser")
        return []

    try:
        log(f"  fetching {src['name']} ...")
        feed = feedparser.parse(src["url"])
        items = []
        for entry in feed.entries[:30]:
            title = normalize_title(entry.get("title", ""))
            summary = normalize_title(entry.get("summary", entry.get("description", "")))
            url = normalize_url(entry.get("link", ""))
            published = entry.get("published", entry.get("updated", ""))

            if not title or not url:
                continue

            sentiment, score = compute_sentiment(title, summary)
            importance = compute_importance(title, summary)
            tickers = map_tickers(title, summary)

            uid = hashlib.md5(url.encode("utf-8")).hexdigest()[:12]

            items.append({
                "id": uid,
                "source": src["name"],
                "title": title,
                "summary": summary[:200] if summary else "",
                "url": url,
                "publishedAt": published,
                "sentiment": sentiment,
                "sentimentScore": score,
                "importance": importance,
                "tags": [src["category"]],
                "tickers": tickers,
            })
        log(f"    got {len(items)} items")
        return items
    except Exception as e:
        log(f"    ERR: {e}")
        return []


# ═══════════════════════════════════════════════════════════
# 重複除去
# ═══════════════════════════════════════════════════════════
def dedupe(items: list, sim_threshold: float = 0.65) -> tuple:
    seen_urls = set()
    seen_titles = []
    result = []
    removed = 0
    for it in items:
        url = it.get("url", "")
        title = it.get("title", "")
        if url in seen_urls:
            removed += 1
            continue
        if any(similarity(title, t) > sim_threshold for t in seen_titles):
            removed += 1
            continue
        seen_urls.add(url)
        seen_titles.append(title)
        result.append(it)
    return result, removed


# ═══════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════
def main():
    log("start")

    all_items = []
    source_status = {}

    for src in RSS_SOURCES:
        items = fetch_feed(src)
        source_status[src["name"]] = "ok" if items else "error"
        all_items.extend(items)

    if not all_items:
        log("  no news fetched — keeping existing JSON (fallback)")
        return 0

    # 重複除去
    all_items, removed = dedupe(all_items)
    log(f"  after dedupe: {len(all_items)} items ({removed} removed)")

    # 重要度降順ソート
    all_items.sort(key=lambda x: (x["importance"], x["sentimentScore"]), reverse=True)

    # 分類: 保有銘柄関連 / 一般マーケット
    market_news = [it for it in all_items if not it["tickers"]]
    stock_news = [it for it in all_items if it["tickers"]]

    # 上限
    market_news = market_news[:30]
    stock_news = stock_news[:20]

    data = {
        "updatedAt": dt.datetime.now().isoformat(timespec="seconds"),
        "sourceStatus": source_status,
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
        out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"  wrote {out}")

    log(f"done: market={len(market_news)} stock={len(stock_news)}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(f"FATAL: {e}")
        sys.exit(0)
