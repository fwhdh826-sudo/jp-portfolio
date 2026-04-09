"""
ニュース重複除去
優先順位: Yahoo!ファイナンス > MINKABU (将来拡張)
"""
from difflib import SequenceMatcher

SOURCE_PRIORITY = {'Reuters': 0, 'Bloomberg': 1, '会社四季報': 2, 'Yahoo!ファイナンス': 3, 'MINKABU': 4}

def similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()

def dedupe(items: list[dict]) -> tuple[list[dict], int]:
    """重複除去済みリストと除去数を返す"""
    seen_urls: set[str] = set()
    seen_titles: list[str] = []
    result = []
    removed = 0

    # ソース優先順にソート
    items_sorted = sorted(items, key=lambda x: SOURCE_PRIORITY.get(x.get('source', ''), 99))

    for item in items_sorted:
        url = item.get('url', '')
        title_norm = item.get('title_norm', item.get('title', ''))

        # URL重複
        if url and url in seen_urls:
            removed += 1
            continue

        # タイトル類似度 (0.85以上を重複とみなす)
        is_dup = any(similar(title_norm, t) >= 0.85 for t in seen_titles)
        if is_dup:
            removed += 1
            continue

        seen_urls.add(url)
        seen_titles.append(title_norm)
        result.append(item)

    return result, removed
