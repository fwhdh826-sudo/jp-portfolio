#!/usr/bin/env python3
"""
P5-B002a: candidates_stocks.json 生成スクリプト（seed list方式）

使用: python3 data/build_candidates_stocks.py
出力: data/candidates_stocks.json

目的:
  P5候補発掘の第一段（B002a）。市場公開情報のみ（銘柄コード・会社名・
  セクター・株価・PER/PBR/ROE/配当利回り・ボラティリティ・モメンタム）を
  固定のseed list（_meta.universe: "seed_list_v1"）に基づき取得し、
  observability-only のJSONとして出力する。

honesty / 非範囲:
  - この段階ではスコアリング・BUY/SELL/WATCH判定・提案金額の算出は行わない
    （B002b以降の責務）。schema にも score/action/金額系フィールドは含めない。
  - 保有実額・投信実額・現金実額・口座種別・CSV取込値は一切含まない
    （P4.5-A010/A010-1a方針）。
  - 保有銘柄をseed listから除外しない。batch側で保有有無によって候補を
    フィルタすると、公開JSONの差分から保有銘柄が推定できてしまう
    （間接的な個人情報漏洩）。除外はfrontend側でholdings.map(code)との
    差分により行う設計とする（B002b）。
  - 投資判断・銘柄推奨・PF最適化・売買指示ではない。

設計原則:
  - 銘柄単位のfail-soft: 1銘柄の取得失敗が全体を止めない。取得できな
    かったフィールドはnullとし、当該銘柄は dataStatus: 'partial' として
    candidates配列にそのまま含める（missing配列にもcodeを記録する）。
  - ネットワーク全断などでseed list全銘柄が失敗しても、本スクリプトは
    例外を外へ投げず、status: 'partial' または 'empty' の有効なJSONを
    必ず書き出す。
  - yfinanceは他の data/update_*.py と同様に通常importする
    （実行環境に既にインストールされている前提。full_batch.ymlの
    Install Python deps ステップで導入済み）。
"""
import json
import math
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "candidates-stocks-1"
UNIVERSE = "seed_list_v1"
STALE_THRESHOLD_HOURS = 48
OUTPUT_PATH = Path(__file__).parent / 'candidates_stocks.json'
JST = timezone(timedelta(hours=9))

# seed list（東証主要銘柄、多様なセクターから40銘柄）。
# 固定リストであり、保有有無による除外・フィルタは一切行わない
# （batch側除外は保有情報の間接漏洩リスクがあるため）。
SEED_LIST: list[tuple[str, str, str]] = [
    ('7203', 'トヨタ自動車',       '自動車'),
    ('7267', 'ホンダ',             '自動車'),
    ('6902', 'デンソー',           '自動車部品'),
    ('6758', 'ソニーグループ',     'エレクトロニクス'),
    ('6752', 'パナソニックHD',     'エレクトロニクス'),
    ('6501', '日立製作所',         '電機'),
    ('6503', '三菱電機',           '電機'),
    ('6702', '富士通',             'IT'),
    ('6981', '村田製作所',         '電子部品'),
    ('6971', '京セラ',             '電子部品'),
    ('8035', '東京エレクトロン',   '半導体製造装置'),
    ('4063', '信越化学工業',       '化学'),
    ('4901', '富士フイルムHD',     '光学/化学'),
    ('7741', 'HOYA',               '光学'),
    ('4502', '武田薬品工業',       '医薬品'),
    ('4519', '中外製薬',           '医薬品'),
    ('4568', '第一三共',           '医薬品'),
    ('9432', 'NTT',                '通信'),
    ('9433', 'KDDI',               '通信'),
    ('9984', 'ソフトバンクグループ', '通信/投資'),
    ('8306', '三菱UFJフィナンシャル・グループ', '金融'),
    ('8316', '三井住友フィナンシャルグループ', '金融'),
    ('8411', 'みずほフィナンシャルグループ', '金融'),
    ('8309', '三井住友トラストHD', '金融'),
    ('7182', 'ゆうちょ銀行',       '金融'),
    ('8801', '三井不動産',         '不動産'),
    ('8802', '三菱地所',           '不動産'),
    ('9020', 'JR東日本',           '鉄道'),
    ('9022', '東海旅客鉄道',       '鉄道'),
    ('8058', '三菱商事',           '商社'),
    ('8031', '三井物産',           '商社'),
    ('2914', '日本たばこ産業',     '食品/たばこ'),
    ('2802', '味の素',             '食品'),
    ('9983', 'ファーストリテイリング', '小売/アパレル'),
    ('9843', 'ニトリHD',           '小売'),
    ('3382', 'セブン&アイ・HD',    '小売'),
    ('6273', 'SMC',                '工作機械'),
    ('6301', 'コマツ',             '建機'),
    ('6098', 'リクルートHD',       'HR/テック'),
    ('7011', '三菱重工業',         '重工'),
    ('4661', 'オリエンタルランド', 'レジャー'),
]


def fetch_one(code: str, name: str, sector: str) -> dict[str, Any]:
    """1銘柄の公開情報を取得する。失敗時はNoneフィールドのままdataStatus: 'partial'で返す。"""
    item: dict[str, Any] = {
        'code': code,
        'name': name,
        'sector': sector,
        'price': None,
        'per': None,
        'pbr': None,
        'roe': None,
        'dividendYield': None,
        'sigma252d': None,
        'mom3m': None,
        'screenReasons': [],
        'dataStatus': 'partial',
    }
    try:
        import yfinance as yf

        ticker = f"{code}.T"
        tk = yf.Ticker(ticker)

        try:
            info = tk.info or {}
        except Exception:
            info = {}

        try:
            hist = tk.history(period='1y')
        except Exception:
            hist = None

        def _clean(value: Any, digits: int) -> Any:
            """NaN/Infは標準JSONで無効なリテラルになるため、Noneへ落とす。"""
            try:
                v = float(value)
            except (TypeError, ValueError):
                return None
            if math.isnan(v) or math.isinf(v):
                return None
            return round(v, digits)

        # yfinanceは当日分の未確定行（出来高0でCloseがNaN）を含むことがあるため、
        # 直近終値ベースの計算はすべて欠損を除去した系列から行う
        closes = hist['Close'].dropna() if hist is not None and not hist.empty else None

        price = info.get('currentPrice') or info.get('regularMarketPrice')
        if price is None and closes is not None and not closes.empty:
            price = closes.iloc[-1]
        item['price'] = _clean(price, 2)

        item['per'] = _clean(info.get('trailingPE'), 2)
        item['pbr'] = _clean(info.get('priceToBook'), 2)

        roe = info.get('returnOnEquity')
        # yfinanceのreturnOnEquityは小数比率(0.15=15%)で返る想定のため%表記へ変換する
        item['roe'] = _clean(roe * 100, 2) if roe is not None else None

        # data/update_fundamentals.py注記: このプロジェクトのyfinanceバージョンは
        # JP銘柄でpercent等倍を返す（3.12=3.12%）。ここでも等倍のまま扱う。
        item['dividendYield'] = _clean(info.get('dividendYield'), 2)

        if closes is not None and len(closes) >= 2:
            returns = closes.pct_change().dropna()
            if len(returns) >= 20:
                item['sigma252d'] = _clean(float(returns.std()) * math.sqrt(252), 4)
            if len(closes) >= 63:
                price_now = float(closes.iloc[-1])
                price_3m = float(closes.iloc[-63])
                if price_3m > 0:
                    item['mom3m'] = _clean((price_now - price_3m) / price_3m * 100, 2)

        has_any = any(
            item[k] is not None
            for k in ('price', 'per', 'pbr', 'roe', 'dividendYield', 'sigma252d', 'mom3m')
        )
        item['dataStatus'] = 'ok' if has_any else 'partial'

        reasons: list[str] = []
        if item['per'] is not None and 0 < item['per'] < 15:
            reasons.append('低PER')
        if item['roe'] is not None and item['roe'] >= 10:
            reasons.append('高ROE')
        if item['dividendYield'] is not None and item['dividendYield'] >= 3:
            reasons.append('高配当')
        item['screenReasons'] = reasons

    except Exception as e:
        print(f"  ⚠ {code} {name}: {e}", file=sys.stderr)
        item['dataStatus'] = 'partial'

    return item


def main() -> None:
    print(f"[{datetime.now():%Y-%m-%d %H:%M}] candidates_stocks.json 生成開始（{len(SEED_LIST)}銘柄）")

    candidates: list[dict[str, Any]] = []
    missing: list[str] = []

    for code, name, sector in SEED_LIST:
        try:
            item = fetch_one(code, name, sector)
        except Exception as e:
            print(f"  ⚠ {code} 完全失敗: {e}", file=sys.stderr)
            item = {
                'code': code, 'name': name, 'sector': sector,
                'price': None, 'per': None, 'pbr': None, 'roe': None,
                'dividendYield': None, 'sigma252d': None, 'mom3m': None,
                'screenReasons': [], 'dataStatus': 'partial',
            }
        if item['dataStatus'] != 'ok':
            missing.append(code)
        candidates.append(item)

    ok_count = sum(1 for c in candidates if c.get('dataStatus') == 'ok')
    if len(candidates) == 0 or ok_count == 0:
        status = 'empty'
    elif ok_count < len(SEED_LIST):
        status = 'partial'
    else:
        status = 'ok'

    now_iso = datetime.now(JST).isoformat()
    output = {
        "schemaVersion": SCHEMA_VERSION,
        "updatedAt": now_iso,
        "sourceUpdatedAt": now_iso if ok_count > 0 else None,
        "staleThresholdHours": STALE_THRESHOLD_HOURS,
        "_meta": {
            "kind": "candidates_stocks",
            "source": "data/build_candidates_stocks.py + yfinance",
            "not_for_trading": True,
            "universe": UNIVERSE,
            "note": "市場公開情報のみ。個人資産・保有実額・現金・口座情報は含まない",
        },
        "candidates": candidates,
        "missing": missing,
        "status": status,
    }

    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"  ✓ {ok_count}/{len(SEED_LIST)}銘柄成功 → {OUTPUT_PATH} (status={status})")


if __name__ == '__main__':
    main()
