"""
P4-A9c-data-4a: candidates_news.json generator

入力: public/data/news.json (fallback: data/news.json)
出力: data/candidates_news.json + public/data/candidates_news.json

schema: candidates-news-1
"""

import json
import os
import sys
from datetime import datetime, timezone, timedelta
from typing import Any

ROLE_KEYS = [
    "jp_broad",
    "jp_semiconductor",
    "us_broad",
    "us_growth",
    "global_broad",
    "gold",
    "reit",
    "dividend",
    "macro_risk",
    "fx",
    "rates",
    "commodity",
    "geopolitical",
]

_SOCIAL_TAGS = {"social_noise", "social"}
_SOCIAL_CATEGORIES = {"social"}
_SOCIAL_SOURCES = {"reddit", "r/stocks", "r/investing"}

STALE_THRESHOLD_HOURS = 24
MAX_ITEMS_PER_ROLE = 5
SCHEMA_VERSION = "candidates-news-1"
GENERATOR = "data/build_candidates_news.py"
JST = timezone(timedelta(hours=9))


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def _is_social(item: dict[str, Any]) -> bool:
    if _SOCIAL_TAGS & set(item.get("tags", [])):
        return True
    if item.get("category") in _SOCIAL_CATEGORIES:
        return True
    source = item.get("source", "").lower()
    return any(s in source for s in _SOCIAL_SOURCES)


def _parse_dt(raw: Any) -> datetime | None:
    """Parse an ISO string into an aware datetime, None on failure."""
    if not isinstance(raw, str) or not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def _best_source_updated_at(raw: Any) -> datetime | None:
    """news.json sourceUpdatedAt can be a string or a dict of source->ISO."""
    if isinstance(raw, str):
        return _parse_dt(raw)
    if isinstance(raw, dict):
        best: datetime | None = None
        for v in raw.values():
            dt = _parse_dt(v)
            if dt is not None and (best is None or dt > best):
                best = dt
        return best
    return None


def _is_stale(news_data: dict[str, Any], now: datetime) -> bool:
    src_dt = _best_source_updated_at(news_data.get("sourceUpdatedAt"))
    upd_dt = _parse_dt(news_data.get("updatedAt"))

    best: datetime | None = src_dt
    if upd_dt is not None and (best is None or upd_dt > best):
        best = upd_dt

    if best is None:
        return True

    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)

    return (now - best).total_seconds() / 3600 > STALE_THRESHOLD_HOURS


def _collect_items(news_data: dict[str, Any]) -> tuple[list[dict[str, Any]], int]:
    """Filter social items. Returns (kept_items, excluded_count)."""
    all_items: list[dict[str, Any]] = (
        news_data.get("marketNews", []) + news_data.get("stockNews", [])
    )
    kept: list[dict[str, Any]] = []
    excluded = 0
    for item in all_items:
        if _is_social(item):
            excluded += 1
        else:
            kept.append(item)
    return kept, excluded


def _build_role_entry(items: list[dict[str, Any]], is_stale: bool) -> dict[str, Any]:
    if not items:
        return {
            "avgSentiment": 0,
            "negativeCount": 0,
            "positiveCount": 0,
            "neutralCount": 0,
            "sourceCount": 0,
            "itemCount": 0,
            "isStale": is_stale,
            "topNegativeTitle": None,
            "topPositiveTitle": None,
            "items": [],
        }

    scores = [float(item.get("sentimentScore", 0.0)) for item in items]
    avg = round(sum(scores) / len(scores), 3)
    neg_count = sum(1 for s in scores if s < -0.2)
    pos_count = sum(1 for s in scores if s > 0.2)
    neu_count = sum(1 for s in scores if -0.2 <= s <= 0.2)
    sources = {item.get("source", "") for item in items if item.get("source")}

    sorted_asc = sorted(items, key=lambda i: float(i.get("sentimentScore", 0.0)))
    sorted_desc = sorted(items, key=lambda i: float(i.get("sentimentScore", 0.0)), reverse=True)

    top_neg_title: str | None = sorted_asc[0].get("title") if sorted_asc else None
    top_pos_title: str | None = sorted_desc[0].get("title") if sorted_desc else None

    # P4.5-A005: news.json側でtitleJaがpopulateされていれば引き継ぐ（表示専用、任意項目）。
    # 無い場合はキー自体を省略し、frontendのtitle fallbackに委ねる。
    compact = []
    for i in sorted_asc[:MAX_ITEMS_PER_ROLE]:
        entry = {
            "title": i.get("title", ""),
            "source": i.get("source", ""),
            "sentiment": i.get("sentiment", "neutral"),
            "sentimentScore": float(i.get("sentimentScore", 0.0)),
            "publishedAt": i.get("publishedAt", ""),
            "url": i.get("url", ""),
            "tags": i.get("tags", []),
        }
        if i.get("titleJa"):
            entry["titleJa"] = i["titleJa"]
        compact.append(entry)

    return {
        "avgSentiment": avg,
        "negativeCount": neg_count,
        "positiveCount": pos_count,
        "neutralCount": neu_count,
        "sourceCount": len(sources),
        "itemCount": len(items),
        "isStale": is_stale,
        "topNegativeTitle": top_neg_title,
        "topPositiveTitle": top_pos_title,
        "items": compact,
    }


# ---------------------------------------------------------------------------
# Main builder (pure function)
# ---------------------------------------------------------------------------


def build_candidates_news(
    news_data: dict[str, Any], now: datetime | None = None
) -> dict[str, Any]:
    if now is None:
        now = datetime.now(tz=JST)

    stale = _is_stale(news_data, now)
    kept_items, excluded = _collect_items(news_data)

    role_items: dict[str, list[dict[str, Any]]] = {role: [] for role in ROLE_KEYS}
    for item in kept_items:
        tags = item.get("tags", [])
        for role in ROLE_KEYS:
            if role in tags:
                role_items[role].append(item)

    asset_class_news = {
        role: _build_role_entry(role_items[role], stale) for role in ROLE_KEYS
    }

    src_best = _best_source_updated_at(news_data.get("sourceUpdatedAt"))
    source_updated_str = src_best.isoformat() if src_best else ""

    return {
        "schemaVersion": SCHEMA_VERSION,
        "updatedAt": now.isoformat(),
        "sourceUpdatedAt": source_updated_str,
        "staleThresholdHours": STALE_THRESHOLD_HOURS,
        "assetClassNews": asset_class_news,
        "meta": {
            "excludedTags": ["social_noise", "social"],
            "excludedCategories": ["social"],
            "excludedCount": excluded,
            "minItemsForSignal": 3,
            "generator": GENERATOR,
        },
    }


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    input_path: str | None = None
    for candidate in [
        os.path.join(root, "public", "data", "news.json"),
        os.path.join(root, "data", "news.json"),
    ]:
        if os.path.exists(candidate):
            input_path = candidate
            break

    if input_path is None:
        print("ERROR: news.json not found", file=sys.stderr)
        sys.exit(1)

    with open(input_path, encoding="utf-8") as f:
        news_data = json.load(f)

    result = build_candidates_news(news_data)
    output_json = json.dumps(result, ensure_ascii=False, indent=2)

    for out_path in [
        os.path.join(root, "data", "candidates_news.json"),
        os.path.join(root, "public", "data", "candidates_news.json"),
    ]:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(output_json)
        print(f"Written: {out_path}")

    acn = result["assetClassNews"]
    total = sum(v["itemCount"] for v in acn.values())
    print(
        f"Roles: {len(acn)}, total role-items: {total}, excluded: {result['meta']['excludedCount']}"
    )


if __name__ == "__main__":
    main()
