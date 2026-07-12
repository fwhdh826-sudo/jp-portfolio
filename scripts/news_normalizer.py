"""
ニュース正規化（タイトル・サマリーのクリーンアップ）
"""
import re

def normalize_title(title: str) -> str:
    t = re.sub(r'\s+', ' ', title).strip()
    # 括弧内の証券コード等除去
    t = re.sub(r'【[^】]*】', '', t).strip()
    t = re.sub(r'\([^)]*\)', '', t).strip()
    return t

def normalize_item(item: dict) -> dict:
    return {
        **item,
        'title_norm': normalize_title(item.get('title', '')),
    }
