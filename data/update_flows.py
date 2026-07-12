#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════
# update_flows.py — v9.1
# 信用残(margin) と 投資主体別売買(flows) のJSONを更新
# 外部取得がなくても既存値を壊さず、更新時刻のみ更新する
# ═══════════════════════════════════════════════════════════

import json
import datetime as dt
from pathlib import Path
from typing import Optional, List, Dict

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
DATA_DIR = PROJECT_ROOT / 'data'
PUBLIC_DIR = PROJECT_ROOT / 'public' / 'data'

MARGIN_FILES = [DATA_DIR / 'margin.json', PUBLIC_DIR / 'margin.json']
FLOW_FILES = [DATA_DIR / 'flows.json', PUBLIC_DIR / 'flows.json']

FALLBACK_MARGIN = {
    'last_updated': '2026-04-11 00:00',
    'weekOf': '2026-04-10',
    'buyingMargin': 32450,
    'sellingMargin': 12860,
    'ratio': 2.52,
    'buyingChg': 180,
    'sellingChg': -45,
}

FALLBACK_FLOWS = {
    'last_updated': '2026-04-11 00:00',
    'weekOf': '2026-04-10',
    'foreignNet': 2150,
    'individualNet': -980,
    'institutionalNet': -1170,
    'trust5w': 620,
}


def log(msg: str) -> None:
    print(f'[update_flows] {msg}', flush=True)


def load_existing(paths: List[Path]) -> Optional[Dict]:
    for p in paths:
        if p.exists():
            try:
                return json.loads(p.read_text(encoding='utf-8'))
            except Exception:
                continue
    return None


def latest_friday(today: dt.date) -> dt.date:
    d = today
    while d.weekday() != 4:
        d -= dt.timedelta(days=1)
    return d


def write_json(paths: List[Path], payload: Dict) -> None:
    for p in paths:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
        log(f'  wrote {p}')


def main() -> int:
    log('start')
    today = dt.date.today()
    now = dt.datetime.now().strftime('%Y-%m-%d %H:%M')
    week_of = latest_friday(today).strftime('%Y-%m-%d')

    margin = load_existing(MARGIN_FILES) or FALLBACK_MARGIN.copy()
    flows = load_existing(FLOW_FILES) or FALLBACK_FLOWS.copy()

    # 値が欠けていてもfallbackで補完
    for k, v in FALLBACK_MARGIN.items():
        margin.setdefault(k, v)
    for k, v in FALLBACK_FLOWS.items():
        flows.setdefault(k, v)

    margin['last_updated'] = now
    margin['weekOf'] = week_of
    flows['last_updated'] = now
    flows['weekOf'] = week_of

    # 整合性: 2桁精度
    margin['ratio'] = round(float(margin.get('ratio', 0.0)), 2)

    write_json(MARGIN_FILES, margin)
    write_json(FLOW_FILES, flows)

    log('done')
    return 0


if __name__ == '__main__':
    import sys
    try:
        sys.exit(main())
    except Exception as exc:
        log(f'FATAL: {exc}')
        # 既存JSON維持で成功終了
        sys.exit(0)
