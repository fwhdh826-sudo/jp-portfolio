#!/usr/bin/env python3
"""
P5-B002a: candidates_stocks.json 生成スクリプト（seed list方式）
P5-B004a: 将来のmarket-wide universe接続に備え、
  universe provider / enrichment / publish の3責務へ分離した
  behavior-preserving scaffold。デフォルトでは現行SEED_LIST（41銘柄、
  UNIVERSE="seed_list_v1"）をそのまま使い、通常成功時の出力・
  schemaVersion・下流契約は変更しない。外部JPX等の広域sourceは
  本ticketでは導入しない（provider差し替え可能な形にするのみ）。

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
  - stale-fallback guard: 新結果がempty相当（candidates 0件 or
    status=='empty'）で、既存candidates_stocks.jsonがまだfresh
    （staleThresholdHours以内）かつschema検証OKなら、既存fileを
    破壊的にemptyで上書きしない。既存fileのタイムスタンプを書き換えて
    偽装fresh化することはしない（単に書き込みをskipするのみ）。
    既存fileがstale・存在しない・corrupt/schema不正の場合はfallbackせず
    通常どおり新結果（empty含む）を書き出す。
"""
import json
import math
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Callable, NamedTuple

SCHEMA_VERSION = "candidates-stocks-1"
UNIVERSE = "seed_list_v1"
STALE_THRESHOLD_HOURS = 48
OUTPUT_PATH = Path(__file__).parent / 'candidates_stocks.json'
JST = timezone(timedelta(hours=9))

# P5-B004a: 公開JSONの無制限肥大化を防ぐための明示的な上限。
# 現行SEED_LIST(41件)では結果が変わらない値にしてある。
# cap適用順序: provider→enrichment(全件)→publish capで先頭からcap件に
# 切り詰め（sort/sampleなし・非決定性を持ち込まない）。
PUBLISH_CAP = 200

# P5-B004b: enrichment safety guard。publish capはenrichment後の"公開"件数を
# 絞るだけであり、それ以前のenrichment（yfinance等の外部fetch）自体の
# runtime/API量は一切守らない。whole-market providerが誤って
# enrich_universe()へ直結された場合に数千件を無制限にfetchしてしまうのを
# 防ぐため、enrichment直前にuniverseサイズを明示的に検査しfail-fastする。
# 現行SEED_LIST(41件)・将来のB004c pre-screen/shortlist（有界入力を想定）
# には影響しない値にしてある。silent truncationはしない
# （黙って一部だけenrichすると集計・公開結果が入力依存で不透明になるため）。
MAX_ENRICHMENT_UNIVERSE = 500

# seed list（東証主要銘柄、多様なセクターから41銘柄）。
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

class UniverseResult(NamedTuple):
    """providerの戻り値。universe_idは_meta.universeへそのまま反映される
    provenance情報（provider差替え時にfixed定数へ追随しない実体）。"""
    universe_id: str
    items: list[tuple[str, str, str]]


# provider: UniverseResult（universe_id + (code, name, sector)のリスト）を
# 返す関数。将来はJPX全銘柄→eligibility→pre-screen等の別providerに
# 差し替え可能。custom/future providerは自身のuniverse_idを明示的に
# 返すことで_meta.universeを正しく追随させる（P5-B004b SCALE-02対応）。
UniverseProvider = Callable[[], UniverseResult]


def default_universe_provider() -> UniverseResult:
    """デフォルトprovider。固定SEED_LIST(41銘柄・universe_id=seed_list_v1)を
    そのまま返す。外部JPX等のfetchは行わない。"""
    return UniverseResult(universe_id=UNIVERSE, items=list(SEED_LIST))


# ---------------------------------------------------------------------------
# Enrichment（銘柄単位の市場公開情報取得）
# ---------------------------------------------------------------------------


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


EnrichFn = Callable[[str, str, str], dict[str, Any]]


class EnrichmentGuardExceeded(RuntimeError):
    """universeサイズがMAX_ENRICHMENT_UNIVERSEを超えた場合に送出される。
    publish capはこの安全性を代替しない（cap適用はenrichment後のため）。"""


def enforce_enrichment_guard(
    universe: list[tuple[str, str, str]], max_items: int = MAX_ENRICHMENT_UNIVERSE
) -> None:
    """enrichment直前にuniverseサイズを検査する。超過時はsilent truncationせず
    例外を送出しfail-fastする（whole-market providerの直結を防ぐ）。"""
    if len(universe) > max_items:
        raise EnrichmentGuardExceeded(
            f"universe size {len(universe)} exceeds MAX_ENRICHMENT_UNIVERSE={max_items}; "
            "whole-market/unbounded providers must be pre-screened into a bounded "
            "shortlist before enrichment (see B004c)"
        )


def enrich_universe(
    universe: list[tuple[str, str, str]], fetch_fn: EnrichFn = fetch_one
) -> tuple[list[dict[str, Any]], list[str]]:
    """universe（(code,name,sector)のリスト）を1件ずつenrichする。
    銘柄単位fail-soft: 1銘柄が完全に例外を投げても全体を止めず、
    partial扱いのitemを積んで続行する。"""
    candidates: list[dict[str, Any]] = []
    missing: list[str] = []

    for code, name, sector in universe:
        try:
            item = fetch_fn(code, name, sector)
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

    return candidates, missing


# ---------------------------------------------------------------------------
# Publish（cap適用 + JSON payload組み立て）
# ---------------------------------------------------------------------------


def apply_publish_cap(
    candidates: list[dict[str, Any]], missing: list[str], cap: int
) -> tuple[list[dict[str, Any]], list[str], int]:
    """publish cap適用。enrichment順（=provider順）の先頭からcap件のみを
    公開対象とする。sort/sampleは行わず、常に同じ入力に対して同じ結果になる
    ようにして非決定性を避ける。戻り値: (published_candidates,
    published_missing, truncated_count)。"""
    truncated = max(0, len(candidates) - cap)
    published = candidates[:cap]
    published_codes = {c['code'] for c in published}
    published_missing = [code for code in missing if code in published_codes]
    return published, published_missing, truncated


def build_candidates_stocks(
    universe_provider: UniverseProvider = default_universe_provider,
    fetch_fn: EnrichFn = fetch_one,
    publish_cap: int = PUBLISH_CAP,
    enrichment_guard: int = MAX_ENRICHMENT_UNIVERSE,
    now: datetime | None = None,
) -> dict[str, Any]:
    """provider→enrichment→publish capの3段を実行し、公開JSON payload
    （dict、ファイルI/Oなし）を返す純粋関数。

    enrichment_guard超過時はEnrichmentGuardExceededを送出する（fail-fast、
    silent truncationはしない）。publish_capはこのguardの代替にはならない
    ——capはenrichment"後"の公開件数を絞るだけで、enrichment自体の
    runtime/API量は守らないため。"""
    if now is None:
        now = datetime.now(JST)

    universe_id, universe = universe_provider()
    enforce_enrichment_guard(universe, max_items=enrichment_guard)

    candidates_all, missing_all = enrich_universe(universe, fetch_fn=fetch_fn)
    candidates, missing, truncated = apply_publish_cap(candidates_all, missing_all, publish_cap)

    if truncated > 0:
        print(f"  ⚠ publish cap={publish_cap}: {truncated}件を切り詰めました", file=sys.stderr)

    # status: publish対象（=公開JSONに実際に載る）candidatesの品質のみで判定する。
    # cap外で切り捨てられたuniverse分の失敗・truncationはstatusに混ぜない
    # （P5-B004b STATUS-1対応: universe > cap でも全publishedがokならstatus=ok）。
    ok_count = sum(1 for c in candidates if c.get('dataStatus') == 'ok')
    if len(candidates) == 0 or ok_count == 0:
        status = 'empty'
    elif ok_count == len(candidates):
        status = 'ok'
    else:
        status = 'partial'

    now_iso = now.isoformat()
    return {
        "schemaVersion": SCHEMA_VERSION,
        "updatedAt": now_iso,
        "sourceUpdatedAt": now_iso if ok_count > 0 else None,
        "staleThresholdHours": STALE_THRESHOLD_HOURS,
        "_meta": {
            "kind": "candidates_stocks",
            "source": "data/build_candidates_stocks.py + yfinance",
            "not_for_trading": True,
            "universe": universe_id,
            "note": "市場公開情報のみ。個人資産・保有実額・現金・口座情報は含まない",
            "counts": {
                "universeCount": len(universe),
                "publishedCount": len(candidates),
                "truncatedCount": truncated,
                "failedTotalCount": len(missing_all),
            },
        },
        "candidates": candidates,
        "missing": missing,
        "status": status,
    }


# ---------------------------------------------------------------------------
# Stale-fallback guard（既存fileの検証・staleness判定・書き込み判断）
# ---------------------------------------------------------------------------


def _parse_iso(raw: Any) -> datetime | None:
    """ISO文字列をaware datetimeへ。失敗時はNone。"""
    if not isinstance(raw, str) or not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def is_valid_candidates_stocks_schema(payload: Any) -> bool:
    """既存candidates_stocks.jsonがschema上有効か（corruption/schema不正検出）。
    fallback候補として使ってよいかの必要条件チェック。"""
    if not isinstance(payload, dict):
        return False
    if payload.get('schemaVersion') != SCHEMA_VERSION:
        return False
    if not isinstance(payload.get('candidates'), list):
        return False
    if not isinstance(payload.get('missing'), list):
        return False
    if payload.get('status') not in ('ok', 'partial', 'empty'):
        return False
    return True


def is_stale_payload(payload: dict[str, Any], now: datetime) -> bool:
    """payloadのupdatedAt/sourceUpdatedAtのうち新しい方とnowの差が
    STALE_THRESHOLD_HOURSを超えていればstale。両方欠損/parse不可ならstale扱い。"""
    src_dt = _parse_iso(payload.get('sourceUpdatedAt'))
    upd_dt = _parse_iso(payload.get('updatedAt'))

    best = src_dt
    if upd_dt is not None and (best is None or upd_dt > best):
        best = upd_dt

    if best is None:
        return True

    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)

    return (now - best).total_seconds() / 3600 > STALE_THRESHOLD_HOURS


def decide_write(
    new_payload: dict[str, Any],
    existing_payload: dict[str, Any] | None,
    now: datetime,
) -> tuple[bool, str]:
    """新結果を書き込むべきか判断する（純粋関数）。
    existing_payloadはNoneなら「既存fileなし、またはschema不正/corrupt」を表す
    （呼び出し側で検証済みであること）。
    戻り値: (should_write, reason)。should_write=Falseの場合は既存fileを
    一切変更せず保持する（タイムスタンプの書き換えも行わない）。"""
    new_is_empty = new_payload.get('status') == 'empty' or len(new_payload.get('candidates') or []) == 0

    if not new_is_empty:
        return True, 'new-nonempty'
    if existing_payload is None:
        return True, 'no-valid-existing'
    if is_stale_payload(existing_payload, now):
        return True, 'existing-stale'
    return False, 'existing-fresh-fallback-guard'


def load_existing(path: Path) -> dict[str, Any] | None:
    """既存candidates_stocks.jsonを読み込み、schema検証済みならdictを、
    存在しない/corrupt/schema不正ならNoneを返す。"""
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return None
    return raw if is_valid_candidates_stocks_schema(raw) else None


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------


def main() -> None:
    now = datetime.now(JST)
    print(f"[{now:%Y-%m-%d %H:%M}] candidates_stocks.json 生成開始（universe={UNIVERSE}）")

    payload = build_candidates_stocks(now=now)
    ok_count = sum(1 for c in payload['candidates'] if c.get('dataStatus') == 'ok')
    print(
        f"  ✓ {ok_count}/{len(payload['candidates'])}銘柄成功 "
        f"(status={payload['status']}, missing={len(payload['missing'])})"
    )

    existing = load_existing(OUTPUT_PATH)
    should_write, reason = decide_write(payload, existing, now)

    if not should_write:
        print(
            f"  ⚠ stale-fallback guard: 新結果がempty相当・既存fileがfreshのため "
            f"上書きをskipします（既存fileを保持, reason={reason}）",
            file=sys.stderr,
        )
        return

    if reason != 'new-nonempty':
        print(f"  ⚠ stale-fallback: reason={reason} のため新結果で書き込みます", file=sys.stderr)

    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(f"  → {OUTPUT_PATH}")


if __name__ == '__main__':
    main()
