"""
ニュースセンチメント判定（辞書ベース）
Claude API等は使用しない（静的運用）
"""

POSITIVE_WORDS = [
    '増収', '増益', '最高益', '最高値', '上方修正', '増配', '好調', '成長',
    '黒字', '回復', '改善', '上昇', '高値', '買い', '急騰', '反発', '底打ち',
    'M&A', '新製品', '受注', '契約', '提携', '特需',
]
NEGATIVE_WORDS = [
    '減収', '減益', '赤字', '損失', '下方修正', '減配', '不調', '悪化',
    '下落', '安値', '売り', '急落', '暴落', '警戒', 'リコール', '不正',
    '問題', '懸念', 'リスク', '倒産', '債務超過', '訴訟',
]

def calc_sentiment(title: str, summary: str) -> tuple[str, float]:
    """
    returns: (sentiment: 'positive'|'neutral'|'negative', score: -1.0~1.0)
    """
    text = f"{title} {summary}"
    pos = sum(1 for w in POSITIVE_WORDS if w in text)
    neg = sum(1 for w in NEGATIVE_WORDS if w in text)
    total = pos + neg
    if total == 0:
        return 'neutral', 0.0
    score = (pos - neg) / total
    if score > 0.1:
        return 'positive', round(score, 2)
    if score < -0.1:
        return 'negative', round(score, 2)
    return 'neutral', round(score, 2)

def calc_importance(title: str, summary: str, tickers: list[str]) -> float:
    """0.0 ~ 1.0"""
    score = 0.5
    if tickers:
        score += 0.2 * min(len(tickers), 2)
    high_imp = ['決算', '業績', '修正', 'M&A', '日銀', '利上げ', 'FRB', '金利', '米中']
    score += 0.05 * sum(1 for w in high_imp if w in title)
    return round(min(1.0, score), 2)
