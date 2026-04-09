"""
ニュース記事と保有銘柄のマッピング
"""
from scripts.news_sources import HOLDINGS_MAP

# 略称も含めた検索辞書
SEARCH_DICT: dict[str, str] = {}
for code, name in HOLDINGS_MAP.items():
    SEARCH_DICT[name] = code
    # 先頭6文字でも検索
    SEARCH_DICT[name[:4]] = code

EXTRA: dict[str, str] = {
    'リクルート': '6098', 'Indeed': '6098',
    '三菱UFJ': '8306', 'MUFG': '8306',
    'カプコン': '9697', 'CAPCOM': '9697',
    'オリエンタルランド': '4661', 'OLC': '4661', 'TDR': '4661',
    '楽天グループ': '4755', '楽天': '4755',
    'INPEX': '1605',
    '三菱商事': '8058',
    '三菱重工': '7011',
    '川崎重工': '7012',
    '任天堂': '7974', 'Nintendo': '7974',
    'KDDI': '9433', 'au': '9433',
}
SEARCH_DICT.update(EXTRA)

def map_tickers(title: str, summary: str) -> list[str]:
    text = f"{title} {summary}"
    found = set()
    for keyword, code in SEARCH_DICT.items():
        if keyword in text:
            found.add(code)
    return sorted(found)
