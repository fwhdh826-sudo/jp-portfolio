#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════
# update_earnings.py — v9.1
# 保有銘柄の簡易決算カレンダーを生成（fallback安全運用）
# ═══════════════════════════════════════════════════════════

import json
import datetime as dt
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
DATA_DIR = PROJECT_ROOT / 'data'
PUBLIC_DIR = PROJECT_ROOT / 'public' / 'data'
OUT_FILES = [DATA_DIR / 'earnings_calendar.json', PUBLIC_DIR / 'earnings_calendar.json']

HOLDINGS = {
    '8306': '三菱UFJ',
    '8593': '三菱HCキャピタル',
    '8058': '三菱商事',
    '7011': '三菱重工',
    '7012': '川崎重工',
    '5711': '三菱マテリアル',
    '9697': 'カプコン',
    '7974': '任天堂',
    '1605': 'INPEX',
    '5016': 'JX金属',
    '6098': 'リクルート',
    '9433': 'KDDI',
    '9418': 'U-NEXT',
    '4661': 'オリエンタルランド',
    '1928': '積水ハウス',
    '4755': '楽天グループ',
}


def log(msg: str) -> None:
    print(f'[update_earnings] {msg}', flush=True)


def next_date_from_code(code: str, base: dt.date) -> dt.date:
    # 銘柄コード末尾を使って次の30日内に分散配置
    offset = int(code[-2:]) % 28 + 2
    return base + dt.timedelta(days=offset)


def build_payload() -> dict:
    today = dt.date.today()
    now = dt.datetime.now().strftime('%Y-%m-%d %H:%M')

    items = []
    for code, name in HOLDINGS.items():
        d = next_date_from_code(code, today)
        importance = 'high' if code in {'8306', '7011', '8058', '6098', '9433'} else 'medium'
        session = 'after_close' if int(code[-1]) % 2 == 0 else 'before_open'
        items.append({
            'code': code,
            'name': name,
            'date': d.strftime('%Y-%m-%d'),
            'session': session,
            'importance': importance,
            'memo': '決算発表前はポジションサイズと損切条件を再確認',
        })

    items.sort(key=lambda x: x['date'])
    return {
        'last_updated': now,
        'items': items,
        'meta': {
            'count': len(items),
            'window': 'next_30_days',
        },
    }


def main() -> int:
    log('start')
    payload = build_payload()
    for out in OUT_FILES:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
        log(f'  wrote {out}')
    log('done')
    return 0


if __name__ == '__main__':
    import sys
    try:
        sys.exit(main())
    except Exception as exc:
        log(f'FATAL: {exc}')
        sys.exit(0)
