#!/usr/bin/env python3
"""
P5-B004b: JPX公式 東証上場銘柄一覧（data_j.xls）をprimary sourceとする
whole-market universe providerと、eligibility v1 filter・cache/fallback・
provenanceを含む正規化されたprovider result契約。

責務:
  - JPX公式サイトからdata_j.xlsをHTTPS取得・OLE2/xls検証・xlrd parse
  - eligibility v1 filter（プライム内国株式のみ、5桁優先株/種類株式除外）
  - internal-onlyなlast-good cacheと、fetch/parse/schema/duplicate/
    row-count異常時のcache→seed_list_v1の3段fallback chain
  - provenance情報を含む正規化されたprovider result契約(JPXUniverseResult)

非範囲（B004cへ持ち越し）:
  - cheap pre-screen（eligible universe（約1552件）をMAX_ENRICHMENT_UNIVERSE=
    500以下のbounded shortlistへ絞る処理）は本モジュールでは実装しない。
  - JPXUniverseResultをdata/build_candidates_stocks.pyの
    default_universe_provider()として本番接続すること。このticketでは
    provider/cache/fallbackの実装までであり、既存のSEED_LIST(41銘柄)による
    本番挙動には一切影響しない。

privacy: 本モジュールが扱うのはJPXが公開する市場情報（銘柄コード・銘柄名・
市場区分・業種区分）のみであり、保有・取引・口座・現金等の個人情報は一切
参照・保存しない。cacheは internal only（data/.jpx_cache/ 配下）であり、
public/data配下へは一切コピーしない。

1559 vs 1560件差の説明（P5-B004b-1 dry-run vs Fable監査、2026-07-14実データで検証済み）:
  dry-runは「市場・商品区分」列に対し文字列包含判定
  `df[col].str.contains("プライム")` を用いていたため、
  「プライム（内国株式）」1559件に加え「プライム（外国株式）」1件
  （2026-07-14時点データでは同区分は1銘柄のみ存在）を誤って含み、
  合計1560件になっていた。Fable監査の1559件は「プライム（内国株式）」の
  厳密一致による件数であり、本providerもeligibility v1として
  market_segment の厳密一致（プライム（内国株式）のみ）を採用するため、
  1559件が正しいPrime内国株式候補数となる。
  さらにeligibility v1では5桁コード（優先株/種類株式、7件）を除外するため、
  最終eligibleCountは1552件になる（詳細はapply_eligibility()のdocstring参照）。
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NamedTuple

# ---------------------------------------------------------------------------
# 定数
# ---------------------------------------------------------------------------

JPX_SOURCE_URL = (
    "https://www.jpx.co.jp/markets/statistics-equities/misc/"
    "tvdivq0000001vg2-att/data_j.xls"
)
SOURCE_IDENTIFIER = "jpx_data_j_xls"
FETCH_TIMEOUT_SECONDS = 30

UNIVERSE_ID = "jpx_prime_domestic_v1"
FALLBACK_UNIVERSE_ID = "seed_list_v1"

REQUIRED_COLUMNS = ("コード", "銘柄名", "市場・商品区分")
OLE2_SIGNATURE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

# eligibility v1: プライムかつ内国株式（普通株式相当）のみを厳密一致で採用する。
# ETF・ETN / REIT・ベンチャーファンド等 / PRO Market / 出資証券 / 外国株式 /
# Standard・Growthは、いずれもこの値と異なるためこの1回のマッチで自動的に
# 除外される（2026-07-14実データで確認した「市場・商品区分」列の値は
# スタンダード（内国株式）/プライム（内国株式）/グロース（内国株式）/
# ETF・ETN/PRO Market/REIT・ベンチャーファンド・カントリーファンド・
# インフラファンド/スタンダード（外国株式）/グロース（外国株式）/出資証券/
# プライム（外国株式）の10種）。
MARKET_SEGMENT_PRIME_DOMESTIC = "プライム（内国株式）"

# 前回正常row_countの何%未満ならsource異常とみなしcache fallbackへ回すか。
ROW_COUNT_MIN_RATIO = 0.7

# 絶対floor（前回cacheの有無に関わらず常に適用）。2026-07-14実データでは
# raw row_count=4437・eligible_count=1552。将来の銘柄数増減を過剰に拒否
# しないよう実データの1/4程度に大きな余裕を持たせつつ、HTMLエラーページの
# 誤parseやfirst-run（前回cacheなし）でのtruncated sourceをbaselineとして
# 採用してしまう事態（F7）を防ぐ安全弁として機能する。
MIN_RAW_ROW_COUNT = 1000
MIN_ELIGIBLE_COUNT = 300

# 前回last-good cacheのeligible件数（=cacheのitems件数）の何%未満なら
# eligibility異常（market label drift等）とみなしcache fallbackへ回すか。
# raw row_countは正常でもeligible_countだけが急減するケース（F1）を検知する
# ため、raw用のROW_COUNT_MIN_RATIOとは独立に判定する。
ELIGIBLE_COUNT_MIN_RATIO = 0.7

CACHE_PATH = Path(__file__).parent / ".jpx_cache" / "jpx_universe_cache.json"
CACHE_SCHEMA_KIND = "jpx_universe_cache_v1"


# ---------------------------------------------------------------------------
# 例外
# ---------------------------------------------------------------------------


class JPXFetchError(RuntimeError):
    """HTTPS取得失敗、非200応答、想定外シグネチャ（OLE2/xls以外）。"""


class JPXParseError(RuntimeError):
    """xlrdによるworkbook/parse失敗。"""


class JPXSchemaError(RuntimeError):
    """必須列欠損、重複code検出等のschema異常。"""


class JPXRowCountGuardError(RuntimeError):
    """raw row_countが異常（絶対floor未満、または前回正常値の
    ROW_COUNT_MIN_RATIO未満に急減）。"""


class JPXEligibleCountGuardError(RuntimeError):
    """eligible_countが異常（絶対floor未満、または前回last-good cacheの
    eligible件数のELIGIBLE_COUNT_MIN_RATIO未満に急減）。raw row_countは
    正常でもmarket label drift等でeligible側だけが崩壊するケース（F1）を
    捕捉する。"""


# ---------------------------------------------------------------------------
# 正規化されたprovider result契約
# ---------------------------------------------------------------------------


class JPXUniverseResult(NamedTuple):
    """JPX universe providerの戻り値。既存data/build_candidates_stocks.pyの
    UniverseResult(universe_id, items)契約を踏襲しつつ、provenance/
    eligibility/fallback情報を追加した正規化contract。

    itemsは既存UniverseResult.itemsと同じ (code, name, sector) タプルの
    リスト形式（sectorはJPX「33業種区分」列を採用）。

    注意: このticketではJPXUniverseResultを
    data/build_candidates_stocks.pyのUniverseProvider
    （Callable[[], UniverseResult]）として直接接続しない
    （B004cでpre-screen後に接続する）。UniverseResult自体は変更しない
    ——既存41 seed production behavior・既存testsに一切影響しない。
    """

    universe_id: str
    items: list[tuple[str, str, str]]
    source: str
    source_identifier: str
    fetched_at: str
    source_as_of: str | None
    row_count: int
    eligible_count: int
    segment_counts: dict[str, int]
    filters_applied: list[dict[str, Any]]
    fallback_used: bool
    cache_age_hours: float | None
    dropped_rows: list[dict[str, Any]]


# ---------------------------------------------------------------------------
# Source adapter: fetch
# ---------------------------------------------------------------------------


def fetch_jpx_xls(url: str = JPX_SOURCE_URL, timeout: int = FETCH_TIMEOUT_SECONDS) -> bytes:
    """JPX公式data_j.xlsをHTTPS取得する。200以外・OLE2/xls以外のシグネチャは
    JPXFetchErrorとして送出する（呼び出し側でcache/seed fallbackへ回す）。

    requests自体が未導入の環境（ImportError/ModuleNotFoundError）もfetch異常の
    一種としてJPXFetchErrorへ正規化する。これによりdependency欠如が
    live → valid cache → seed_list_v1 のfallback chainを突破しない。"""
    try:
        import requests
    except ImportError as e:
        raise JPXFetchError(f"requests is not installed: {e!r}") from e

    try:
        resp = requests.get(url, timeout=timeout)
    except Exception as e:  # noqa: BLE001 - network例外は全てfetch失敗として扱う
        raise JPXFetchError(f"fetch failed: {e!r}") from e

    if resp.status_code != 200:
        raise JPXFetchError(f"unexpected status_code={resp.status_code}")

    content = resp.content
    if not content.startswith(OLE2_SIGNATURE):
        raise JPXFetchError(
            f"unexpected file signature (not OLE2/xls): {content[:8].hex()!r}"
        )
    return content


# ---------------------------------------------------------------------------
# Source adapter: parse
# ---------------------------------------------------------------------------


def _code_to_str(raw: Any) -> str:
    """codeは必ずstrとして保持する。xlrdの数値セルはfloatで返るため
    整数値であればゼロ小数を落としてstr化し、文字列セル（英字混在code等）は
    strip済みのstrをそのまま使う。"""
    if isinstance(raw, float):
        if raw.is_integer():
            return str(int(raw))
        return str(raw)
    return str(raw).strip()


def parse_rows_from_sheet(sheet: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """xlrd sheet互換オブジェクト（.nrows/.ncols/.cell(r,c)で
    ctype/valueを持つセルを返す）からrowを抽出する。

    戻り値: (parsed_rows, dropped_rows)。
    parsed_rowsの各要素: {"code": str, "name": str, "market_segment": str,
    "sector": str, "source_as_of_raw": Any}
    dropped_rowsの各要素: {"row": int, "reason": str, "code": str | None}
    """
    if sheet.nrows == 0:
        raise JPXSchemaError("empty sheet (no header row)")

    header = [str(sheet.cell(0, c).value).strip() for c in range(sheet.ncols)]
    missing_cols = [c for c in REQUIRED_COLUMNS if c not in header]
    if missing_cols:
        raise JPXSchemaError(f"missing required columns: {missing_cols}")

    col_idx = {name: header.index(name) for name in header}
    code_c = col_idx["コード"]
    name_c = col_idx["銘柄名"]
    market_c = col_idx["市場・商品区分"]
    sector_c = col_idx.get("33業種区分")
    date_c = col_idx.get("日付")

    parsed: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []

    for r in range(1, sheet.nrows):
        code_raw = sheet.cell(r, code_c).value
        name_raw = sheet.cell(r, name_c).value
        market_raw = sheet.cell(r, market_c).value

        if code_raw is None or (isinstance(code_raw, str) and not code_raw.strip()):
            dropped.append({"row": r, "reason": "missing_code", "code": None})
            continue

        code = _code_to_str(code_raw)
        name = str(name_raw).strip() if name_raw is not None else ""
        market = str(market_raw).strip() if market_raw is not None else ""

        if not code or not name or not market:
            dropped.append({"row": r, "reason": "missing_required_field", "code": code or None})
            continue

        sector = ""
        if sector_c is not None:
            sector_raw = sheet.cell(r, sector_c).value
            sector = str(sector_raw).strip() if sector_raw is not None else ""

        source_as_of_raw = sheet.cell(r, date_c).value if date_c is not None else None

        parsed.append({
            "code": code,
            "name": name,
            "market_segment": market,
            "sector": sector,
            "source_as_of_raw": source_as_of_raw,
        })

    return parsed, dropped


def parse_jpx_xls_bytes(content: bytes) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """OLE2/xls bytesをxlrdでparseし、parse_rows_from_sheet()へ委譲する。

    xlrd自体が未導入の環境（ImportError/ModuleNotFoundError）、workbook open
    失敗、sheet_by_index等のparse adapter失敗は、いずれもJPXParseErrorへ
    正規化する。これによりdependency欠如を含むparse異常が
    live → valid cache → seed_list_v1 のfallback chainを突破しない
    （parse_rows_from_sheet自身が送出するJPXSchemaError/JPXSchemaError系の
    schema異常はそのまま呼び出し元へ伝播させる——parseは成功したがschemaが
    不正、という区別を保つため）。"""
    try:
        import xlrd
    except ImportError as e:
        raise JPXParseError(f"xlrd is not installed: {e!r}") from e

    try:
        wb = xlrd.open_workbook(file_contents=content)
        sheet = wb.sheet_by_index(0)
    except Exception as e:  # noqa: BLE001
        raise JPXParseError(f"xlrd parse failed: {e!r}") from e

    return parse_rows_from_sheet(sheet)


def detect_duplicate_codes(rows: list[dict[str, Any]]) -> list[str]:
    """code重複を検出する（順序維持、重複した2回目以降のcodeを列挙）。"""
    seen: set[str] = set()
    dupes: list[str] = []
    for row in rows:
        c = row["code"]
        if c in seen:
            dupes.append(c)
        seen.add(c)
    return dupes


def _source_as_of_iso(rows: list[dict[str, Any]]) -> str | None:
    """JPX「日付」列（YYYYMMDD形式のfloat、例: 20260630.0）をISO date文字列へ。
    先頭の有効な値を採用する（同一ファイル内で単一のsourceAsOfのため）。"""
    for row in rows:
        raw = row.get("source_as_of_raw")
        if isinstance(raw, (int, float)):
            s = str(int(raw))
            if len(s) == 8:
                return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
    return None


# ---------------------------------------------------------------------------
# Eligibility v1
# ---------------------------------------------------------------------------


def is_preferred_or_class_share(code: str) -> bool:
    """5桁コードは優先株/種類株式を示す（JPXコード命名規則、
    2026-07-14実データで7件全て「◯◯優先株式」「◯◯種類株式」名称と一致確認済み）。

    契約: 4桁コード（数字のみ・英字混在いずれも）は普通株式として保持する。
    4桁+英字のcode（例: 166A, 285A）は2024年以降の新規上場企業に割り当てられる
    正式な普通株式コードであり、eligibility上除外しない。
    判定は桁数のみで行い、文字種（数字/英字混在）は見ない。
    """
    return len(code) == 5


def apply_eligibility(
    rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, int], list[dict[str, Any]]]:
    """v1 eligible universe filter。

    原則:
      1. 「市場・商品区分」が"プライム（内国株式）"と厳密一致する行のみ採用。
         この1回の厳密一致で以下が同時に達成される
         （2026-07-14実データの区分値10種のうちこれ以外の9種を全て除外）:
           - Prime（Standard/Growth除外）
           - domestic common stocks相当（外国株式区分を除外）
           - ETF/ETN除外・REIT除外・PRO Market除外・出資証券除外
      2. 5桁コード（優先株/種類株式）を除外する（is_preferred_or_class_share）。
         4桁の英字混在codeは普通株式として残す。

    戻り値: (eligible_rows, segment_counts, filters_applied)。
    filters_appliedは各段階のcountを明示するリスト
    （1559 vs 1560差・各filter段階の透明性のため）。
    """
    segment_counts: dict[str, int] = {}
    for row in rows:
        segment_counts[row["market_segment"]] = segment_counts.get(row["market_segment"], 0) + 1

    stage_source = {"stage": "source_rows", "count": len(rows)}

    prime_domestic = [r for r in rows if r["market_segment"] == MARKET_SEGMENT_PRIME_DOMESTIC]
    stage_market = {
        "stage": "market_segment_prime_domestic_common_strict_match",
        "count": len(prime_domestic),
        "excluded_segment_counts": {
            k: v for k, v in segment_counts.items() if k != MARKET_SEGMENT_PRIME_DOMESTIC
        },
    }

    preferred_excluded = [r for r in prime_domestic if is_preferred_or_class_share(r["code"])]
    eligible = [r for r in prime_domestic if not is_preferred_or_class_share(r["code"])]
    stage_preferred = {
        "stage": "exclude_preferred_or_class_shares_5digit_code",
        "count": len(eligible),
        "excluded_count": len(preferred_excluded),
        "excluded_codes": sorted(r["code"] for r in preferred_excluded),
    }

    filters_applied = [stage_source, stage_market, stage_preferred]
    return eligible, segment_counts, filters_applied


# ---------------------------------------------------------------------------
# Cache（internal only。public/dataへは一切コピーしない）
# ---------------------------------------------------------------------------


def _parse_iso(raw: Any) -> datetime | None:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def _cache_item_valid(item: Any) -> bool:
    """cache items内の1要素が(code, name, sector)契約を満たすか。

    list/tupleでlen==3、code/nameは非空str、sectorはstr（空可）であることを
    要求する。int要素（items=[123]）やstr要素（items=["garbage-item"]）、
    長さ不一致、code/name欠損はいずれも不正として拒否する。"""
    if not isinstance(item, (list, tuple)):
        return False
    if len(item) != 3:
        return False
    code, name, sector = item
    if not isinstance(code, str) or not code:
        return False
    if not isinstance(name, str) or not name:
        return False
    if not isinstance(sector, str):
        return False
    return True


def _cache_payload_valid(payload: Any) -> bool:
    """cacheファイルがschema上有効か（corruption検出）。

    items自体がlistであることに加え、各要素が_cache_item_valid契約を
    満たすことまで深層検証する。malformed itemsを持つcacheはload_cache()で
    Noneとなり、fallback側（_cache_to_result等）が新たな例外源にならない。"""
    if not isinstance(payload, dict):
        return False
    if payload.get("schemaKind") != CACHE_SCHEMA_KIND:
        return False
    items = payload.get("items")
    if not isinstance(items, list):
        return False
    if not all(_cache_item_valid(item) for item in items):
        return False
    if not isinstance(payload.get("row_count"), int):
        return False
    if not isinstance(payload.get("fetched_at"), str) or _parse_iso(payload["fetched_at"]) is None:
        return False
    return True


def load_cache(path: Path = CACHE_PATH) -> dict[str, Any] | None:
    """既存cacheを読み込む。存在しない/corrupt/schema不正ならNone
    （corrupt cacheはfallback候補として使わない）。"""
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return None
    return raw if _cache_payload_valid(raw) else None


def save_cache(payload: dict[str, Any], path: Path = CACHE_PATH) -> None:
    """cacheを同一ディレクトリの一時ファイルへ書き切ってからatomic replaceする。
    書き込み中断・OSError発生時も、置換前の既存last-good cacheは無傷のまま
    残る（部分書き込みが直接pathへ反映されることはない）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(path.name + ".tmp")
    try:
        tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp_path.replace(path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def _cache_age_hours(cache_payload: dict[str, Any], now: datetime) -> float:
    fetched = _parse_iso(cache_payload.get("fetched_at"))
    if fetched is None:
        return float("inf")
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return (now - fetched).total_seconds() / 3600


def _cache_to_result(cache_payload: dict[str, Any], now: datetime) -> JPXUniverseResult:
    """last-good cacheをJPXUniverseResultへ変換する。fallbackUsed=True、
    timestampはcache生成時のfetched_atをそのまま使う（偽装しない）。"""
    items = [tuple(x) for x in cache_payload["items"]]
    return JPXUniverseResult(
        universe_id=cache_payload.get("universe_id", UNIVERSE_ID),
        items=items,
        source=cache_payload.get("source", SOURCE_IDENTIFIER),
        source_identifier=SOURCE_IDENTIFIER,
        fetched_at=cache_payload["fetched_at"],
        source_as_of=cache_payload.get("source_as_of"),
        row_count=cache_payload["row_count"],
        eligible_count=len(items),
        segment_counts=cache_payload.get("segment_counts", {}),
        filters_applied=cache_payload.get("filters_applied", []),
        fallback_used=True,
        cache_age_hours=_cache_age_hours(cache_payload, now),
        dropped_rows=[],
    )


def seed_list_v1_fallback(now: datetime) -> JPXUniverseResult:
    """live fetch異常・valid cacheなしの最終fallback。既存
    data/build_candidates_stocks.pyのSEED_LIST(41銘柄)をそのまま使う
    （既存41 seed production挙動と同一の縮退universe）。"""
    from data.build_candidates_stocks import SEED_LIST

    now_iso = now.isoformat()
    return JPXUniverseResult(
        universe_id=FALLBACK_UNIVERSE_ID,
        items=list(SEED_LIST),
        source="data/build_candidates_stocks.py::SEED_LIST",
        source_identifier=FALLBACK_UNIVERSE_ID,
        fetched_at=now_iso,
        source_as_of=None,
        row_count=len(SEED_LIST),
        eligible_count=len(SEED_LIST),
        segment_counts={},
        filters_applied=[],
        fallback_used=True,
        cache_age_hours=None,
        dropped_rows=[],
    )


# ---------------------------------------------------------------------------
# Main entrypoint: fetch → validate → eligibility → cache/fallback chain
# ---------------------------------------------------------------------------


def get_jpx_universe(
    now: datetime | None = None,
    fetch_fn: Any = fetch_jpx_xls,
    parse_fn: Any = parse_jpx_xls_bytes,
    cache_path: Path = CACHE_PATH,
) -> JPXUniverseResult:
    """JPX universe providerの主エントリポイント。failure chain:
      1. live fetch成功 → validate（OLE2/schema/duplicate/row-count/
         eligible-count guard）→ eligible universe（fallbackUsed=False）
      2. fetch/parse/schema/duplicate/row-count/eligible-count異常
         → valid last-good cache（fallbackUsed=True, cacheAgeHours>=0）
      3. valid cacheなし → seed_list_v1 fallback
         （fallbackUsed=True, cacheAgeHours=None）

    corrupt cacheは使わない。stale状態はcacheAgeHoursで可視化する
    （fallback時にtimestampを偽装しない）。guard失敗時はsave_cache()に
    到達しないため、last-good cacheが異常結果で上書きされることはない
    （first-runでtruncated sourceをbaseline化することも防ぐ）。

    integrity guardは4段階（raw row絶対floor→raw row前回比ratio→
    eligible絶対floor→eligible前回比ratio）で、raw rowは正常でも
    market label drift等でeligibleだけ崩壊するケース（F1）と、
    前回cacheが無いfirst-runでtruncated sourceがbaseline化される
    ケース（F7）の両方を捕捉する。

    fetch_fn/parse_fnはテスト用のdependency injectionポイント
    （fetch_fn: () -> bytes、parse_fn: (bytes) -> (rows, dropped)）。
    """
    if now is None:
        now = datetime.now(timezone.utc)

    cache = load_cache(cache_path)

    try:
        content = fetch_fn()
        rows, dropped = parse_fn(content)

        dupes = detect_duplicate_codes(rows)
        if dupes:
            raise JPXSchemaError(f"duplicate codes detected: {dupes[:10]}")

        row_count = len(rows)
        if row_count < MIN_RAW_ROW_COUNT:
            raise JPXRowCountGuardError(
                f"row_count {row_count} is below absolute floor MIN_RAW_ROW_COUNT="
                f"{MIN_RAW_ROW_COUNT}"
            )
        if cache is not None:
            prev_row_count = cache.get("row_count", 0)
            if prev_row_count > 0 and row_count < prev_row_count * ROW_COUNT_MIN_RATIO:
                raise JPXRowCountGuardError(
                    f"row_count {row_count} < {ROW_COUNT_MIN_RATIO * 100:.0f}% "
                    f"of previous good row_count {prev_row_count}"
                )

        eligible, segment_counts, filters_applied = apply_eligibility(rows)

        eligible_count = len(eligible)
        if eligible_count < MIN_ELIGIBLE_COUNT:
            raise JPXEligibleCountGuardError(
                f"eligible_count {eligible_count} is below absolute floor "
                f"MIN_ELIGIBLE_COUNT={MIN_ELIGIBLE_COUNT}"
            )
        if cache is not None:
            prev_eligible_count = len(cache.get("items", []))
            if prev_eligible_count > 0 and eligible_count < prev_eligible_count * ELIGIBLE_COUNT_MIN_RATIO:
                raise JPXEligibleCountGuardError(
                    f"eligible_count {eligible_count} < {ELIGIBLE_COUNT_MIN_RATIO * 100:.0f}% "
                    f"of previous good eligible_count {prev_eligible_count}"
                )

        source_as_of = _source_as_of_iso(rows)
        items = [(r["code"], r["name"], r["sector"]) for r in eligible]

        result = JPXUniverseResult(
            universe_id=UNIVERSE_ID,
            items=items,
            source=SOURCE_IDENTIFIER,
            source_identifier=SOURCE_IDENTIFIER,
            fetched_at=now.isoformat(),
            source_as_of=source_as_of,
            row_count=row_count,
            eligible_count=len(items),
            segment_counts=segment_counts,
            filters_applied=filters_applied,
            fallback_used=False,
            cache_age_hours=0.0,
            dropped_rows=dropped,
        )

        save_cache({
            "schemaKind": CACHE_SCHEMA_KIND,
            "universe_id": result.universe_id,
            "items": [list(x) for x in items],
            "source": result.source,
            "fetched_at": result.fetched_at,
            "source_as_of": result.source_as_of,
            "row_count": result.row_count,
            "segment_counts": result.segment_counts,
            "filters_applied": result.filters_applied,
        }, cache_path)

        return result

    except (
        JPXFetchError,
        JPXParseError,
        JPXSchemaError,
        JPXRowCountGuardError,
        JPXEligibleCountGuardError,
    ) as e:
        print(f"[jpx_universe_provider] live fetch/validate failed: {e!r}", file=sys.stderr)
        if cache is not None:
            print("[jpx_universe_provider] falling back to last-good cache", file=sys.stderr)
            return _cache_to_result(cache, now)
        print("[jpx_universe_provider] no valid cache, falling back to seed_list_v1", file=sys.stderr)
        return seed_list_v1_fallback(now)
