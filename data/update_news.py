#!/usr/bin/env python3
"""
JP株OS — ニュース自動収集スクリプト
使用: python3 data/update_news.py
出力: public/data/news.json（バリデーション通過時のみ書き込み）
"""
import sys
import json
from pathlib import Path
from datetime import datetime

# プロジェクトルートをパスに追加
sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.news_sources import fetch_all
from scripts.news_normalizer import normalize_item
from scripts.news_deduper import dedupe
from scripts.news_ticker_mapper import map_tickers
from scripts.news_sentiment import calc_sentiment, calc_importance
from scripts.news_schema import validate_news_json, empty_news_json

OUTPUT_PATH = Path(__file__).parent.parent / 'public' / 'data' / 'news.json'
BACKUP_PATH = Path(__file__).parent.parent / 'public' / 'data' / 'news_backup.json'

def main():
    print(f"[{datetime.now():%Y-%m-%d %H:%M}] ニュース収集開始")

    # バックアップ
    if OUTPUT_PATH.exists():
        import shutil
        shutil.copy(OUTPUT_PATH, BACKUP_PATH)

    try:
        # 1. フェッチ
        source_status, raw_items = fetch_all()
        print(f"  → 取得件数: {len(raw_items)}")

        # 2. 正規化
        normalized = [normalize_item(item) for item in raw_items]

        # 3. 重複除去
        deduped, removed_count = dedupe(normalized)
        print(f"  → 重複除去後: {len(deduped)} (除去: {removed_count})")

        # 4. センチメント + ティッカーマッピング
        market_news = []
        stock_news = []

        for item in deduped:
            title   = item.get('title', '')
            summary = item.get('summary', '')
            tickers = map_tickers(title, summary)
            sentiment, score = calc_sentiment(title, summary)
            importance = calc_importance(title, summary, tickers)

            news_item = {
                'id':           item.get('raw_id', ''),
                'source':       item.get('source', ''),
                'title':        title,
                'summary':      summary,
                'url':          item.get('url', ''),
                'publishedAt':  item.get('publishedAt', ''),
                'sentiment':    sentiment,
                'sentimentScore': score,
                'importance':   importance,
                'tags':         [],
                'tickers':      tickers,
            }

            if tickers:
                stock_news.append(news_item)
            else:
                market_news.append(news_item)

        # 5. スキーマ組立
        output = {
            'updatedAt':    datetime.now().strftime('%Y-%m-%dT%H:%M:%S'),
            'sourceStatus': source_status,
            'marketNews':   market_news[:50],
            'stockNews':    stock_news[:100],
            'meta': {
                'totalCount':       len(market_news) + len(stock_news),
                'marketCount':      len(market_news),
                'stockCount':       len(stock_news),
                'duplicateRemoved': removed_count,
            }
        }

        # 6. バリデーション — 通過しない場合は書き込まない
        ok, reason = validate_news_json(output)
        if not ok:
            print(f"  ✗ バリデーション失敗: {reason}")
            if BACKUP_PATH.exists():
                import shutil
                shutil.copy(BACKUP_PATH, OUTPUT_PATH)
                print("  → バックアップを復元しました")
            sys.exit(1)

        OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
            json.dump(output, f, ensure_ascii=False, indent=2)

        print(f"  ✓ {OUTPUT_PATH} 生成完了")
        print(f"  ✓ 市場ニュース: {len(market_news)} / 銘柄ニュース: {len(stock_news)}")
        return True

    except Exception as e:
        print(f"  ✗ エラー: {e}")
        if BACKUP_PATH.exists():
            import shutil
            shutil.copy(BACKUP_PATH, OUTPUT_PATH)
            print("  → バックアップを復元しました")
        else:
            # 安全な空JSONを書き込む
            empty = empty_news_json()
            with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
                json.dump(empty, f, ensure_ascii=False, indent=2)
            print("  → 空のnews.jsonを書き込みました（フォールバック）")
        return False

if __name__ == '__main__':
    success = main()
    sys.exit(0 if success else 1)
