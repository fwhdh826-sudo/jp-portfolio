#!/usr/bin/env python3
"""HOLDING-EVIDENCE-2A: 本番 holding_evidence.json generator（yfinance 由来）。

使用: python3 data/update_holding_evidence.py
出力: data/holding_evidence.json（成功 & fleet eligible>=1 のときのみ atomic replace）

frozen authority:
  HOLDING_EVIDENCE_AUTHORITY_DESIGN_FROZEN
  HOLDING_EVIDENCE_1_CLOSED_ON_V13_3_DEV
  HOLDING_EVIDENCE_2_SOURCE_SEMANTICS_FROZEN

原則:
  - artifact は evidence のみを所有する。BUY/SELL threshold を一切知らない（§28）。
  - published evidence 由来の値は分析実行時のみの ephemeral 値であり、
    Holding へ永続化されない（それは HE-1 runtime = holdingEvidence.ts の責務）。
  - yfinance access は薄い fetch 関数へ隔離し、core transform は注入された
    surface から pure に導出する（§30）。unit test は network に触れない。
  - per-ticker fail-soft。16 entry を必ず出力する。値を捏造しない（§25）。
  - fleet eligible entry が 0 のとき generator は FAIL する。既存 artifact を
    all-missing 版で上書きしない。generatedAt を refresh しない（§25 / §26）。

時計（§23）:
  - _meta.generatedAt          : atomic publish 直前の artifact 完成時刻
  - fundamentals.asOf          : その ticker の statement surface 観測時刻
  - underlying statement age    : FY0 period-end から 456 日（Python guard, §6）
  - technicals.asOf            : 最新の完了バー日 @ 15:30 JST を canonical UTC 化

重要（freshness ドキュメント規則, §37）:
  HE-1 の 45 日 fundamentals TTL は group asOf の backstop であって
  「財務諸表が 45 日以内」ではない。source-age の実上限は FY0 period-end + 456 日。
"""
from __future__ import annotations

import json
import math
import os
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Optional

try:  # generator は `python3 data/update_holding_evidence.py`（sys.path[0]=data/）
    from holding_evidence_contract import (
        FUNDAMENTALS_FIELDS,
        KIND,
        MARKET,
        MIN_TECHNICAL_BARS,
        SCHEMA_VERSION,
        STATEMENT_MAX_AGE_DAYS,
        TECHNICALS_FIELDS,
        de_not_applicable_permitted,
        validate_holding_evidence_artifact,
    )
except ImportError:  # pytest は `import data.update_holding_evidence`（repo root on path）
    from data.holding_evidence_contract import (
        FUNDAMENTALS_FIELDS,
        KIND,
        MARKET,
        MIN_TECHNICAL_BARS,
        SCHEMA_VERSION,
        STATEMENT_MAX_AGE_DAYS,
        TECHNICALS_FIELDS,
        de_not_applicable_permitted,
        validate_holding_evidence_artifact,
    )

# ── ticker universe（§24）───────────────────────────────────────────────
# data/update_returns.py / data/update_correlation.py の TICKERS と一致すること。
# 共通化は HE-2A scope 外。drift は tests/test_update_holding_evidence.py の
# AST 抽出比較テストで防ぐ。
HOLDING_EVIDENCE_TICKERS = [
    "6098.T",
    "8306.T",
    "9697.T",
    "4661.T",
    "8593.T",
    "4755.T",
    "5711.T",
    "1605.T",
    "5016.T",
    "8058.T",
    "9418.T",
    "1928.T",
    "7011.T",
    "7974.T",
    "9433.T",
    "7012.T",
]

OUTPUT_PATH = Path(__file__).parent / "holding_evidence.json"

FUNDAMENTALS_SOURCE = "yfinance annual income_stmt/balance_sheet/cashflow + info"
TECHNICALS_SOURCE = "yfinance history(period=1y, interval=1d, auto_adjust=True, actions=False)"

JST = timezone(timedelta(hours=9))
UTC = timezone.utc

_FETCH_ATTEMPTS = 2


# ═══════════════════════════════════════════════════════════════════════
# 注入 surface（pure transform の入力）
# ═══════════════════════════════════════════════════════════════════════
@dataclass
class FundamentalsSurface:
    """1 ticker 分の観測済み財務諸表 surface。全 statement は label -> 列リスト
    （index 0 = FY0 = 最新年次列）。period_ends は date（index 0 = FY0）。"""

    income_stmt: dict[str, list[Optional[float]]]
    balance_sheet: dict[str, list[Optional[float]]]
    cashflow: dict[str, list[Optional[float]]]
    period_ends: list[date]
    info: dict[str, Any]
    splits: list[tuple[date, float]]
    dividends: list[tuple[date, float]]
    dividends_ok: bool
    observed_at: datetime  # tz-aware UTC
    # split history が retry 後も取得できたか。False = unknown split history であり
    # 「分割なし」ではない（§7）。空 series（splits==[] かつ splits_ok=True）は
    # authoritative「関連する分割は観測されず」。
    splits_ok: bool = True


@dataclass
class TechnicalsSurface:
    """1 ticker 分の日次ヒストリ surface（clean 前の生バー）。"""

    bars: list[dict[str, Any]]  # {"date": date, "close": float, "volume": float}
    now_jst: datetime


# ═══════════════════════════════════════════════════════════════════════
# primitive helpers（pure）
# ═══════════════════════════════════════════════════════════════════════
def _finite(value: Any) -> Optional[float]:
    """有限 numeric のみ float を返す。NaN / Inf / None / malformed は None。"""
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(result):
        return None
    return result


def _row(stmt: dict[str, list[Optional[float]]], label: Optional[str], idx: int) -> Optional[float]:
    """EXACT label 一致のみ。substring / prefix / case-fold は禁止（§5）。"""
    if label is None or label not in stmt:
        return None
    column = stmt[label]
    if idx >= len(column):
        return None
    return _finite(column[idx])


def canonical_timestamp(moment: datetime) -> str:
    """YYYY-MM-DDTHH:MM:SS.mmmZ（UTC・ミリ秒 3 桁・終端 Z）。§22"""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    moment = moment.astimezone(UTC)
    millis = moment.microsecond // 1000
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{millis:03d}Z"


def _present_num(value: float) -> dict[str, Any]:
    result = float(value)
    if not math.isfinite(result):
        return _missing()
    return {"v": result, "status": "present"}


def _present_bool(value: bool) -> dict[str, Any]:
    return {"v": bool(value), "status": "present"}


def _missing() -> dict[str, Any]:
    return {"v": None, "status": "missing"}


def _not_applicable() -> dict[str, Any]:
    return {"v": None, "status": "not_applicable"}


def _minus_one_year(anchor: date) -> date:
    try:
        return anchor.replace(year=anchor.year - 1)
    except ValueError:  # Feb 29
        return anchor.replace(year=anchor.year - 1, day=28)


# ═══════════════════════════════════════════════════════════════════════
# fundamentals guards（pure）
# ═══════════════════════════════════════════════════════════════════════
def _statement_age_ok(period_ends: list[date], observed_at: datetime) -> bool:
    """FY0 period-end が観測時刻 - 456 日より古ければ False（§6 / §23C）。
    ちょうど 456 日は境界内（deterministic, §36 F25）。"""
    if not period_ends:
        return False
    observed_date = observed_at.astimezone(UTC).date()
    return (observed_date - period_ends[0]) <= timedelta(days=STATEMENT_MAX_AGE_DAYS)


def _split_guard_ok(splits: list[tuple[date, float]], period_ends: list[date]) -> bool:
    """FY1 period-end 以降に株式分割があれば False（§7）。FY1 が無ければ FY0 を基準。"""
    if len(period_ends) >= 2:
        reference = period_ends[1]
    elif period_ends:
        reference = period_ends[0]
    else:
        return False
    for split_date, ratio in splits:
        if ratio and ratio != 1.0 and split_date > reference:
            return False
    return True


def _eps_label(income_stmt: dict[str, list[Optional[float]]]) -> Optional[str]:
    """Diluted EPS を優先。Diluted EPS 行そのものが存在しない場合のみ Basic EPS（§9 / §11）。"""
    if "Diluted EPS" in income_stmt:
        return "Diluted EPS"
    if "Basic EPS" in income_stmt:
        return "Basic EPS"
    return None


def _divg_field(surface: FundamentalsSurface) -> dict[str, Any]:
    """divG（§15）: 年次 FY window での DPS 成長率。calendar-year 集計は禁止。"""
    period_ends = surface.period_ends
    if len(period_ends) < 2:
        return _missing()
    if not surface.dividends_ok:
        return _missing()

    end0, end1 = period_ends[0], period_ends[1]
    window0 = (_minus_one_year(end0), end0)
    window1 = (_minus_one_year(end1), end1)
    dps0 = sum(amount for when, amount in surface.dividends if window0[0] < when <= window0[1])
    dps1 = sum(amount for when, amount in surface.dividends if window1[0] < when <= window1[1])

    last_div_value = _finite(surface.info.get("lastDividendValue"))
    series_empty = len(surface.dividends) == 0

    if dps1 > 0:
        if dps0 == 0:
            return _present_num(-100.0)  # 減配ゼロ = authoritative negative evidence
        return _present_num((dps0 - dps1) / dps1 * 100)

    # dps1 == 0
    if dps0 > 0:
        return _missing()  # 意味のある prior denominator 無し

    # dps0 == 0 かつ dps1 == 0
    if series_empty and (last_div_value is None or last_div_value == 0):
        return _present_num(0.0)  # 正当な長期無配
    return _missing()  # 空 series が正の lastDividendValue と矛盾 / retrieval 失敗


# ═══════════════════════════════════════════════════════════════════════
# fundamentals group builder（pure）
# ═══════════════════════════════════════════════════════════════════════
def build_fundamentals_group(
    code: str, surface: FundamentalsSurface, price_last_close: Optional[float]
) -> dict[str, Any]:
    fields: dict[str, Any] = {key: _missing() for key in FUNDAMENTALS_FIELDS}
    as_of = canonical_timestamp(surface.observed_at)
    group = {"asOf": as_of, "source": FUNDAMENTALS_SOURCE, "fields": fields}

    if not _statement_age_ok(surface.period_ends, surface.observed_at):
        # FY0 が >456d → 7 フィールドすべて missing（de の not_applicable も含め上書き, §6）
        return group

    income = surface.income_stmt
    balance = surface.balance_sheet
    cash = surface.cashflow

    equity_fy0 = _row(balance, "Stockholders Equity", 0)

    # ── roe（§8）──────────────────────────────────────────────
    if "Net Income Common Stockholders" in income:
        net_income = _row(income, "Net Income Common Stockholders", 0)
    else:
        net_income = _row(income, "Net Income", 0)
    if net_income is not None and equity_fy0 is not None and equity_fy0 > 0:
        fields["roe"] = _present_num(net_income / equity_fy0 * 100)

    # ── per / epsG が共有する EPS 行と split guard ────────────
    eps_label = _eps_label(income)
    eps_fy0 = _row(income, eps_label, 0)
    eps_fy1 = _row(income, eps_label, 1)
    # split history が取得できていない（splits_ok=False）場合は unknown split history。
    # per / epsG は fail-closed で missing にする（retrieval 失敗を「分割なし」と
    # 同一視しない, §7）。roe/pbr/cfOk/de/divG は split と無関係なので影響しない。
    split_ok = surface.splits_ok and _split_guard_ok(surface.splits, surface.period_ends)

    # ── per（§9）──────────────────────────────────────────────
    if (
        price_last_close is not None
        and price_last_close > 0
        and eps_fy0 is not None
        and eps_fy0 != 0
        and split_ok
    ):
        fields["per"] = _present_num(price_last_close / eps_fy0)  # EPS<0 → 負 PER も present

    # ── pbr（§10）─────────────────────────────────────────────
    price_to_book = _finite(surface.info.get("priceToBook"))
    if price_to_book is not None and price_to_book > 0:
        fields["pbr"] = _present_num(price_to_book)  # pass-through のみ。fallback 導出禁止

    # ── epsG（§11）────────────────────────────────────────────
    if eps_fy0 is not None and eps_fy1 is not None and eps_fy1 > 0 and split_ok:
        fields["epsG"] = _present_num((eps_fy0 - eps_fy1) / eps_fy1 * 100)

    # ── cfOk（§12）────────────────────────────────────────────
    ocf_fy0 = _row(cash, "Operating Cash Flow", 0)
    fcf_fy0 = _row(cash, "Free Cash Flow", 0)
    if fcf_fy0 is None:
        capex_fy0 = _row(cash, "Capital Expenditure", 0)
        if ocf_fy0 is not None and capex_fy0 is not None:
            fcf_fy0 = ocf_fy0 - abs(capex_fy0)
    if ocf_fy0 is not None and fcf_fy0 is not None:
        fields["cfOk"] = _present_bool(ocf_fy0 > 0 and fcf_fy0 > 0)  # false も present

    # ── de（§13 / §14）───────────────────────────────────────
    if de_not_applicable_permitted(code):
        fields["de"] = _not_applicable()
    else:
        if "Total Debt" in balance:
            debt_fy0 = _row(balance, "Total Debt", 0)
        else:
            long_term = _row(balance, "Long Term Debt And Capital Lease Obligation", 0)
            current = _row(balance, "Current Debt And Capital Lease Obligation", 0)
            debt_fy0 = (long_term + current) if (long_term is not None and current is not None) else None
        if debt_fy0 is not None and equity_fy0 is not None and equity_fy0 > 0:
            fields["de"] = _present_num(debt_fy0 / equity_fy0)  # debt 未解決 → missing（0 と仮定しない）

    # ── divG（§15）────────────────────────────────────────────
    fields["divG"] = _divg_field(surface)

    return group


def empty_fundamentals_group(attempt_at: datetime) -> dict[str, Any]:
    """fetch 失敗時。観測試行時刻を asOf にし、7 フィールドすべて missing（§23B）。"""
    return {
        "asOf": canonical_timestamp(attempt_at),
        "source": FUNDAMENTALS_SOURCE,
        "fields": {key: _missing() for key in FUNDAMENTALS_FIELDS},
    }


# ═══════════════════════════════════════════════════════════════════════
# technicals（pure）
# ═══════════════════════════════════════════════════════════════════════
def clean_bars(raw_bars: list[dict[str, Any]], now_jst: datetime) -> list[dict[str, Any]]:
    """使えない Close/Volume 行を除去。未確定の当日 TSE バーを除外（§16）。"""
    today_jst = now_jst.astimezone(JST).date()
    cutoff = now_jst.astimezone(JST).replace(hour=15, minute=30, second=0, microsecond=0)
    cleaned: list[dict[str, Any]] = []
    for bar in sorted(raw_bars, key=lambda item: item["date"]):
        close = _finite(bar.get("close"))
        volume = _finite(bar.get("volume"))
        if close is None or close <= 0:
            continue
        if volume is None or volume < 0:
            continue
        bar_date = bar["date"]
        if bar_date == today_jst and now_jst.astimezone(JST) < cutoff:
            continue  # 未確定の当日バー
        cleaned.append({"date": bar_date, "close": close, "volume": volume})
    return cleaned


def _sma(values: list[float], window: int) -> float:
    return sum(values[-window:]) / window


def _ema(values: list[float], span: int) -> list[float]:
    alpha = 2.0 / (span + 1.0)
    result = [values[0]]
    for value in values[1:]:
        result.append(alpha * value + (1.0 - alpha) * result[-1])
    return result


def _cutler_rsi14(closes: list[float]) -> Optional[float]:
    """Cutler RSI14: 直近 14 差分の単純平均 gain/loss（§18）。Wilder へ切替えない。"""
    if len(closes) < 15:
        return None
    diffs = [closes[i] - closes[i - 1] for i in range(len(closes) - 14, len(closes))]
    gain = sum(d for d in diffs if d > 0) / 14.0
    loss = sum(-d for d in diffs if d < 0) / 14.0
    if loss == 0 and gain > 0:
        return 100.0
    if gain == 0 and loss > 0:
        return 0.0
    if gain == 0 and loss == 0:
        return None
    return 100.0 - 100.0 / (1.0 + gain / loss)


def _macd_line_above_signal(closes: list[float]) -> bool:
    ema12 = _ema(closes, 12)
    ema26 = _ema(closes, 26)
    macd_line = [fast - slow for fast, slow in zip(ema12, ema26)]
    signal = _ema(macd_line, 9)
    return macd_line[-1] > signal[-1]  # 等値は false


def _volume_confirmation(volumes: list[float]) -> Optional[bool]:
    """Volume_t > 1.3 * mean(直近 20 バー、当日除外)（§20）。

    21 観測すべてが有限 かつ baseline mean > 0 のとき、この不等式は well-defined。
    観測された Volume_t == 0 は source 不在ではなく authoritative な False（0 は
    どんな正の閾値も超えない, §20）。missing にするのは非有限 volume / 観測不足 /
    baseline mean <= 0 のときのみ。"""
    if len(volumes) < 21:
        return None
    baseline = volumes[-21:-1]
    current = volumes[-1]
    if not all(math.isfinite(value) for value in baseline) or not math.isfinite(current):
        return None
    baseline_mean = sum(baseline) / 20.0
    if baseline_mean <= 0:
        return None
    return current > 1.3 * baseline_mean


def _mom3m(closes: list[float]) -> Optional[float]:
    """(Close_t / Close_{t-63} - 1) * 100（63 session lookback, §21）。"""
    if len(closes) < 64:
        return None
    prior = closes[-64]
    if prior <= 0:
        return None
    return (closes[-1] / prior - 1.0) * 100.0


def build_technicals_group(cleaned: list[dict[str, Any]], fallback_at: datetime) -> dict[str, Any]:
    count = len(cleaned)
    closes = [bar["close"] for bar in cleaned]
    volumes = [bar["volume"] for bar in cleaned]

    if count:
        last_date = cleaned[-1]["date"]
        as_of_moment = datetime(
            last_date.year, last_date.month, last_date.day, 15, 30, 0, tzinfo=JST
        )
    else:
        as_of_moment = fallback_at

    fields: dict[str, Any] = {key: _missing() for key in TECHNICALS_FIELDS}
    group = {
        "asOf": canonical_timestamp(as_of_moment),
        "source": TECHNICALS_SOURCE,
        "bars": count,
        "fields": fields,
    }

    if count < MIN_TECHNICAL_BARS:
        return group  # group-authority: bars<75 → 5 フィールドすべて missing

    fields["ma"] = _present_bool(closes[-1] > _sma(closes, 25) and closes[-1] > _sma(closes, 75))

    rsi = _cutler_rsi14(closes)
    fields["rsi"] = _present_num(rsi) if rsi is not None else _missing()

    fields["macd"] = _present_bool(_macd_line_above_signal(closes))

    volume_confirmed = _volume_confirmation(volumes)
    fields["vol"] = _present_bool(volume_confirmed) if volume_confirmed is not None else _missing()

    momentum = _mom3m(closes)
    fields["mom3m"] = _present_num(momentum) if momentum is not None else _missing()

    return group


# ═══════════════════════════════════════════════════════════════════════
# entry / artifact builder（pure）
# ═══════════════════════════════════════════════════════════════════════
@dataclass
class EntryInput:
    code: str
    fundamentals: Optional[FundamentalsSurface]
    technicals: Optional[TechnicalsSurface]
    attempt_at: datetime  # tz-aware UTC（fetch 試行時刻 / fail-soft fallback）


def build_entry(entry_input: EntryInput) -> dict[str, Any]:
    code = entry_input.code
    attempt_at = entry_input.attempt_at

    if entry_input.technicals is not None:
        cleaned = clean_bars(entry_input.technicals.bars, entry_input.technicals.now_jst)
        technicals = build_technicals_group(cleaned, attempt_at)
        price_last_close = cleaned[-1]["close"] if cleaned else None
    else:
        technicals = build_technicals_group([], attempt_at)
        price_last_close = None

    if entry_input.fundamentals is not None:
        fundamentals = build_fundamentals_group(code, entry_input.fundamentals, price_last_close)
    else:
        fundamentals = empty_fundamentals_group(attempt_at)

    return {
        "code": code,
        "ticker": f"{code}.T",
        "market": MARKET,
        "fundamentals": fundamentals,
        "technicals": technicals,
    }


def build_artifact(entry_inputs: list[EntryInput], generated_at: datetime) -> dict[str, Any]:
    entries = [build_entry(item) for item in entry_inputs]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "not_for_trading": True,
        "_meta": {
            "kind": KIND,
            "schemaVersion": SCHEMA_VERSION,
            "generatedAt": canonical_timestamp(generated_at),
            "not_for_trading": True,
        },
        "entries": entries,
    }


def is_eligible(entry: dict[str, Any]) -> bool:
    """fundamentals 完全（承認済み de not_applicable を除く）AND technicals 完全 AND bars>=75（§25）。"""
    code = entry.get("code")
    fundamentals_fields = entry["fundamentals"]["fields"]
    for key in FUNDAMENTALS_FIELDS:
        status = fundamentals_fields[key]["status"]
        if status == "present":
            continue
        # not_applicable が完全性を満たすのは承認済みコードの de のみ（validator と同一規則）。
        if status == "not_applicable" and key == "de" and de_not_applicable_permitted(code):
            continue
        return False

    technicals = entry["technicals"]
    if technicals["bars"] < MIN_TECHNICAL_BARS:
        return False
    for key in TECHNICALS_FIELDS:
        if technicals["fields"][key]["status"] != "present":
            return False
    return True


# ═══════════════════════════════════════════════════════════════════════
# atomic write（§26）
# ═══════════════════════════════════════════════════════════════════════
def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    # serialize は temp 生成の前。ここで失敗しても temp file は存在しない。
    serialized = json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False)
    directory = path.parent
    temp_path = directory / f".{path.name}.tmp.{os.getpid()}"
    replaced = False
    try:
        with open(temp_path, "w", encoding="utf-8") as handle:
            handle.write(serialized)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        replaced = True
    finally:
        # temp 生成後・os.replace 成功前のいかなる例外でも temp を掃除する。
        # 元の destination は無傷（os.replace は atomic）。cleanup 失敗は
        # 一次例外を隠さない。
        if not replaced:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


# ═══════════════════════════════════════════════════════════════════════
# yfinance fetch 層（薄い / network 隔離 / §30）
# ═══════════════════════════════════════════════════════════════════════
def _retry(operation: Callable[[], Any], attempts: int = _FETCH_ATTEMPTS) -> Any:
    """deterministic retry（最大 attempts 回・sleep 無し）。失敗時 None（§25）。"""
    last_error: Optional[Exception] = None
    for _ in range(attempts):
        try:
            return operation()
        except Exception as error:  # noqa: BLE001 - fail-soft
            last_error = error
    if last_error is not None:
        print(f"    fetch failed after {attempts} attempts: {last_error!r}")
    return None


def _statement_to_columns(frame: Any) -> tuple[dict[str, list[Optional[float]]], list[date]]:
    """yfinance の年次 statement DataFrame を label -> [FY0, FY1, ...] へ。"""
    columns = list(frame.columns)  # 直近が先頭
    period_ends = [_to_date(column) for column in columns]
    table: dict[str, list[Optional[float]]] = {}
    for label in frame.index:
        raw = list(frame.loc[label])
        table[str(label)] = [_finite(value) for value in raw]
    return table, [item for item in period_ends if item is not None]


def _to_date(value: Any) -> Optional[date]:
    try:
        if hasattr(value, "date"):
            return value.date()
        if isinstance(value, date):
            return value
        return datetime.fromisoformat(str(value)).date()
    except (TypeError, ValueError):
        return None


def _collect_splits(handle: Any) -> list[tuple[date, float]]:
    """handle.splits を (date, factor) list へ。accessor / iteration の例外は
    呼び出し側（_retry）へ伝播させる — 空 series の捏造で握り潰さない（§7）。"""
    collected: list[tuple[date, float]] = []
    for when, ratio in handle.splits.items():
        parsed = _to_date(when)
        factor = _finite(ratio)
        if parsed is not None and factor is not None:
            collected.append((parsed, factor))
    return collected


def fetch_fundamentals_surface(ticker: str) -> Optional[FundamentalsSurface]:
    import yfinance as yf

    def _load() -> FundamentalsSurface:
        handle = yf.Ticker(ticker)
        income, income_ends = _statement_to_columns(handle.income_stmt)
        balance, _balance_ends = _statement_to_columns(handle.balance_sheet)
        cash, _cash_ends = _statement_to_columns(handle.cashflow)

        try:
            info = dict(handle.info)
        except Exception:  # noqa: BLE001
            info = {}

        # split history は per-ticker retry policy に参加する（最大 _FETCH_ATTEMPTS 回）。
        # _collect_splits は必ず list を返すので _retry の None は「両試行が例外」を意味する。
        # その場合 splits_ok=False（unknown split history）。空 series の握り潰しはしない（§7）。
        splits_result = _retry(lambda: _collect_splits(handle))
        splits_ok = splits_result is not None
        splits = splits_result if splits_result is not None else []
        if not splits_ok:
            print(f"    {ticker}: split history unavailable after retry → per/epsG missing")

        dividends: list[tuple[date, float]] = []
        dividends_ok = True
        try:
            for when, amount in handle.dividends.items():
                parsed = _to_date(when)
                value = _finite(amount)
                if parsed is not None and value is not None:
                    dividends.append((parsed, value))
        except Exception:  # noqa: BLE001
            dividends_ok = False
            dividends = []

        if not income_ends:
            raise ValueError("no annual statement period ends")

        return FundamentalsSurface(
            income_stmt=income,
            balance_sheet=balance,
            cashflow=cash,
            period_ends=income_ends,
            info=info,
            splits=splits,
            dividends=dividends,
            dividends_ok=dividends_ok,
            observed_at=datetime.now(UTC),
            splits_ok=splits_ok,
        )

    return _retry(_load)


def fetch_technicals_surface(ticker: str) -> Optional[TechnicalsSurface]:
    import yfinance as yf

    def _load() -> TechnicalsSurface:
        handle = yf.Ticker(ticker)
        history = handle.history(
            period="1y", interval="1d", auto_adjust=True, actions=False
        )
        if history is None or history.empty:
            raise ValueError("empty history")
        bars: list[dict[str, Any]] = []
        for index, row in history.iterrows():
            moment = index
            try:
                if getattr(moment, "tzinfo", None) is not None:
                    moment = moment.tz_convert("Asia/Tokyo")
            except Exception:  # noqa: BLE001
                pass
            bar_date = _to_date(moment)
            if bar_date is None:
                continue
            bars.append(
                {
                    "date": bar_date,
                    "close": _finite(row.get("Close")),
                    "volume": _finite(row.get("Volume")),
                }
            )
        return TechnicalsSurface(bars=bars, now_jst=datetime.now(JST))

    return _retry(_load)


# ═══════════════════════════════════════════════════════════════════════
# main
# ═══════════════════════════════════════════════════════════════════════
def main() -> bool:
    print(f"[{datetime.now(UTC):%Y-%m-%d %H:%M}] holding_evidence 生成開始（{len(HOLDING_EVIDENCE_TICKERS)} 銘柄）")
    attempt_at = datetime.now(UTC)

    entry_inputs: list[EntryInput] = []
    for ticker in HOLDING_EVIDENCE_TICKERS:
        code = ticker[:-2]
        print(f"  → {ticker}")
        fundamentals = fetch_fundamentals_surface(ticker)
        technicals = fetch_technicals_surface(ticker)
        entry_inputs.append(
            EntryInput(
                code=code,
                fundamentals=fundamentals,
                technicals=technicals,
                attempt_at=attempt_at,
            )
        )

    # generatedAt = validation 完了・atomic publish 直前（§23A）
    generated_at = datetime.now(UTC)
    artifact = build_artifact(entry_inputs, generated_at)

    ok, problems = validate_holding_evidence_artifact(artifact)
    if not ok:
        print("  ✗ 生成 artifact が contract 検証に失敗。既存 artifact は保持。")
        for problem in problems:
            print(f"     - {problem}")
        return False

    eligible = [entry for entry in artifact["entries"] if is_eligible(entry)]
    print(f"  eligible entries: {len(eligible)} / {len(artifact['entries'])}")
    if not eligible:
        print("  ✗ fleet publication blocked: eligible entry が 0。既存 artifact / generatedAt を保持。")
        return False

    atomic_write_json(OUTPUT_PATH, artifact)
    print(f"  ✓ {OUTPUT_PATH} 生成完了（eligible {len(eligible)} 銘柄）")
    return True


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
