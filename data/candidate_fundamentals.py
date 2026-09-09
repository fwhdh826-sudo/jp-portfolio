#!/usr/bin/env python3
"""P5-B005-B4-A: Candidate Funnel fundamental-source plumbing (Phase A).

このモジュールは Candidate Funnel の凍結済み fundamental-input authority の
Phase A ——「信頼できる fundamental データ source の敷設と observability」——
だけを実装する。

Phase A は以下を **しない**:
  - growth scoring の有効化（GROWTH_SCORING_STATUS = reserved_zero_weight）
  - Candidate Funnel ranking semantics の変更
  - production の public `per` / `roe` authority の切り替え
    （derived PER / ROE は SHADOW evidence としてのみ算出する）

凍結 authority:
  CANONICAL_PE_FIELD    = "per"
  PROFIT_GROWTH         = (NI_FY0 - NI_FY1) / NI_FY1 * 100   （NI_FY1 > 0 必須、
                          満たさなければ null）
  EPS_GROWTH            = (EPS_FY0 - EPS_FY1) / EPS_FY1 * 100 （EPS_FY1 > 0 必須、
                          満たさなければ null）

HE-2（data/update_holding_evidence.py）で既に凍結されている semantic rule を
そのまま単一 authority として再利用する（第二の非互換定義を作らない）:
  - statement row label は EXACT 一致のみ（substring/prefix/case-fold 禁止）
  - FY0 period-end age <= STATEMENT_MAX_AGE_DAYS(456d)
  - Net Income 行 authority: "Net Income Common Stockholders" → fallback は
    "Net Income" 行ラベルのみ
  - EPS 行 authority: "Diluted EPS" 優先。"Diluted EPS" 行自体が無い場合のみ
    "Basic EPS"
  - split guard: FY1 period-end 以降（FY1 が無ければ FY0 基準）に分割があれば
    per / epsGrowth は fail-closed で null。split history 取得失敗（splits_ok=
    False）も「分割なし」と同一視せず null。

Phase A で凍結仕様に追加された guard:
  - comparable-period span guard: 335 <= days(FY0_end - FY1_end) <= 395。
    範囲外なら YoY growth を計算しない（irregularPeriod）。

network I/O は薄い fetch 関数（fetch_fundamentals_one / read_fundamentals_input）
へ隔離し、core transform（derive_fundamentals）は注入された明示的な
statement/history fixture から pure に導出する。unit test は network に触れない。
"""
from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

try:  # generator 実行時 (sys.path[0]=data/)
    from holding_evidence_contract import STATEMENT_MAX_AGE_DAYS
except ImportError:  # pytest / -m 実行時 (repo root on path)
    from data.holding_evidence_contract import STATEMENT_MAX_AGE_DAYS

# HE-2 の凍結 semantic helper を単一 authority としてそのまま import する
# （再実装して drift させない）。module import 自体は network を張らない
# （yfinance import は HE-2 側でも fetch 関数内 lazy import）。
try:
    from update_holding_evidence import (
        _eps_label as _he_eps_label,
        _split_guard_ok as _he_split_guard_ok,
        _statement_age_ok as _he_statement_age_ok,
    )
except ImportError:
    from data.update_holding_evidence import (
        _eps_label as _he_eps_label,
        _split_guard_ok as _he_split_guard_ok,
        _statement_age_ok as _he_statement_age_ok,
    )

# ── 凍結定数 ────────────────────────────────────────────────────────────
CANONICAL_PE_FIELD = "per"
GROWTH_SCORING_STATUS = "reserved_zero_weight"

COMPARABLE_SPAN_MIN_DAYS = 335
COMPARABLE_SPAN_MAX_DAYS = 395

FUNDAMENTALS_SOURCE = "yfinance annual income_stmt/balance_sheet + splits"

# fundamentalsStatus: null 値を等価に見せず実際の authority state を露出する。
# Phase A では stale/前回 run の fundamental 再利用が禁止のため fallback は
# 有効な現在 authority ではない。
FUNDAMENTALS_STATUS_AVAILABLE = "available"   # profitGrowth と epsGrowth 双方あり
FUNDAMENTALS_STATUS_PARTIAL = "partial"       # 一部の growth authority のみ
FUNDAMENTALS_STATUS_MISSING = "missing"       # statement/行が取得できない
FUNDAMENTALS_STATUS_STALE = "stale"           # FY0 が 456 日より古い
FUNDAMENTALS_STATUS_INVALID = "invalid"       # 数値が非有限 / provider 障害

FUNDAMENTALS_STATUSES = (
    FUNDAMENTALS_STATUS_AVAILABLE,
    FUNDAMENTALS_STATUS_PARTIAL,
    FUNDAMENTALS_STATUS_MISSING,
    FUNDAMENTALS_STATUS_STALE,
    FUNDAMENTALS_STATUS_INVALID,
)

# _meta.fundamentals.coverage の bucket（各 symbol はちょうど 1 bucket へ寄与する）。
COVERAGE_PRESENT = "present"
COVERAGE_STALE = "stale"
COVERAGE_MISSING = "missing"
COVERAGE_NEGATIVE_BASE = "negativeBase"
COVERAGE_SPLIT_GUARD_BLOCKED = "splitGuardBlocked"
COVERAGE_IRREGULAR_PERIOD = "irregularPeriod"
COVERAGE_ROW_LABEL_MISSING = "rowLabelMissing"

COVERAGE_BUCKETS = (
    COVERAGE_PRESENT,
    COVERAGE_STALE,
    COVERAGE_MISSING,
    COVERAGE_NEGATIVE_BASE,
    COVERAGE_SPLIT_GUARD_BLOCKED,
    COVERAGE_IRREGULAR_PERIOD,
    COVERAGE_ROW_LABEL_MISSING,
)

_FETCH_ATTEMPTS = 1  # zero-weight shadow channel。retry storm を持ち込まない（§15）。

_RATE_LIMIT_MARKERS = (
    "rate limit",
    "ratelimit",
    "too many requests",
    "429",
)


# ── cell 分類（pure。数値受理規律は HE-2 `_finite` と一致）──────────────
_CELL_OK = "ok"
_CELL_LABEL_MISSING = "label_missing"
_CELL_INDEX_MISSING = "index_missing"
_CELL_NOT_FINITE = "not_finite"


def _cell(stmt: dict[str, list[Any]], label: Optional[str], idx: int) -> tuple[Optional[float], str]:
    """EXACT label 一致のみ（HE-2 §5）。戻り値 (value_or_None, kind)。
    kind で「行ラベル欠損」「列欠損」「present だが非有限」を区別する
    （§14: invalid numeric は行欠損とは別分類）。"""
    if label is None or label not in stmt:
        return None, _CELL_LABEL_MISSING
    column = stmt[label]
    if not isinstance(column, (list, tuple)) or idx >= len(column):
        return None, _CELL_INDEX_MISSING
    raw = column[idx]
    if isinstance(raw, bool):
        return None, _CELL_NOT_FINITE
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None, _CELL_NOT_FINITE
    if not math.isfinite(value):
        return None, _CELL_NOT_FINITE
    return value, _CELL_OK


def _ni_label(income_stmt: dict[str, list[Any]]) -> Optional[str]:
    """Net-income 行 authority（HE-2 §8 / build_fundamentals_group と同一規律）。
    "Net Income Common Stockholders" → fallback は "Net Income" 行のみ。"""
    if "Net Income Common Stockholders" in income_stmt:
        return "Net Income Common Stockholders"
    if "Net Income" in income_stmt:
        return "Net Income"
    return None


def _comparable_span_ok(period_ends: list[date]) -> bool:
    """FY0 period-end と FY1 period-end の間隔が 335..395 日か（Phase A 追加 guard）。"""
    if len(period_ends) < 2:
        return False
    span_days = (period_ends[0] - period_ends[1]).days
    return COMPARABLE_SPAN_MIN_DAYS <= span_days <= COMPARABLE_SPAN_MAX_DAYS


# ── 導出結果 ────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class FundamentalsResult:
    """1 symbol 分の Phase A fundamental 導出結果。

    profit_growth / eps_growth / fiscal_period_end / status は public candidate
    field になる。shadow_per / shadow_roe は OBSERVABILITY ONLY で candidates_stocks.json
    には出力されない（§9 / §16）。coverage は _meta.fundamentals 集計用の単一 bucket。"""

    profit_growth: Optional[float]
    eps_growth: Optional[float]
    fiscal_period_end: Optional[str]
    status: str
    shadow_per: Optional[float]
    shadow_roe: Optional[float]
    coverage: str


def _null_result(status: str, fiscal_period_end: Optional[str] = None, coverage: str = COVERAGE_MISSING) -> FundamentalsResult:
    return FundamentalsResult(
        profit_growth=None,
        eps_growth=None,
        fiscal_period_end=fiscal_period_end,
        status=status,
        shadow_per=None,
        shadow_roe=None,
        coverage=coverage,
    )


def derive_fundamentals(
    *,
    income_stmt: dict[str, list[Any]],
    balance_sheet: dict[str, list[Any]],
    period_ends: list[date],
    splits: list[tuple[date, float]],
    splits_ok: bool,
    price_last_close: Optional[float],
    observed_at: datetime,
) -> FundamentalsResult:
    """凍結 authority に厳密に従い Phase A fundamental を pure に導出する。

    network I/O 一切なし。全入力は明示的に注入される（§22）。
    """
    if not period_ends:
        return _null_result(FUNDAMENTALS_STATUS_INVALID, coverage=COVERAGE_MISSING)

    fiscal_period_end = period_ends[0].isoformat()

    # 2 つの時計を混同しない（§13）: ここで見るのは財務諸表の freshness
    # （fiscalPeriodEnd / 456 日 authority）であって dataset freshness ではない。
    if not _he_statement_age_ok(period_ends, observed_at):
        return _null_result(
            FUNDAMENTALS_STATUS_STALE, fiscal_period_end=fiscal_period_end, coverage=COVERAGE_STALE
        )

    ni_label = _ni_label(income_stmt)
    eps_label = _he_eps_label(income_stmt)

    ni0, ni0_kind = _cell(income_stmt, ni_label, 0)
    ni1, ni1_kind = _cell(income_stmt, ni_label, 1)
    eps0, eps0_kind = _cell(income_stmt, eps_label, 0)
    eps1, eps1_kind = _cell(income_stmt, eps_label, 1)
    equity0, _equity0_kind = _cell(balance_sheet, "Stockholders Equity", 0)

    span_ok = _comparable_span_ok(period_ends)
    # split history が取得できていない場合は fail-closed（§7）。
    split_ok = bool(splits_ok) and _he_split_guard_ok(splits, period_ends)

    invalid_seen = False

    # ── profitGrowth（§7）───────────────────────────────────────────────
    profit_growth: Optional[float] = None
    if ni_label is None:
        profit_reason = COVERAGE_ROW_LABEL_MISSING
    elif ni0_kind == _CELL_NOT_FINITE or ni1_kind == _CELL_NOT_FINITE:
        profit_reason = "invalid"
        invalid_seen = True
    elif ni0 is None or ni1 is None:
        profit_reason = COVERAGE_MISSING  # 片方の FY しか無い
    elif not span_ok:
        profit_reason = COVERAGE_IRREGULAR_PERIOD
    elif ni1 <= 0:
        # NI_FY1 <= 0: ゼロ/負ベースから explosive/misleading な成長率を作らない
        profit_reason = COVERAGE_NEGATIVE_BASE
    else:
        profit_growth = (ni0 - ni1) / ni1 * 100.0
        profit_reason = COVERAGE_PRESENT

    # ── epsGrowth（§8）─────────────────────────────────────────────────
    eps_growth: Optional[float] = None
    if eps_label is None:
        eps_reason = COVERAGE_ROW_LABEL_MISSING
    elif eps0_kind == _CELL_NOT_FINITE or eps1_kind == _CELL_NOT_FINITE:
        eps_reason = "invalid"
        invalid_seen = True
    elif eps0 is None or eps1 is None:
        eps_reason = COVERAGE_MISSING
    elif not span_ok:
        eps_reason = COVERAGE_IRREGULAR_PERIOD
    elif not split_ok:
        eps_reason = COVERAGE_SPLIT_GUARD_BLOCKED
    elif eps1 <= 0:
        eps_reason = COVERAGE_NEGATIVE_BASE
    else:
        eps_growth = (eps0 - eps1) / eps1 * 100.0
        eps_reason = COVERAGE_PRESENT

    # ── shadow PER（§9。OBSERVABILITY ONLY）────────────────────────────
    # derived PER shadow = latest relevant price / annual reported EPS authority
    shadow_per: Optional[float] = None
    if (
        price_last_close is not None
        and price_last_close > 0
        and eps0 is not None
        and eps0 != 0
        and split_ok
    ):
        shadow_per = price_last_close / eps0

    # ── shadow ROE（§9。OBSERVABILITY ONLY）────────────────────────────
    # derived ROE shadow = Net Income (Common Stockholders → HE 許可 fallback) FY0
    #                      / Stockholders Equity FY0 * 100
    shadow_roe: Optional[float] = None
    if ni0 is not None and equity0 is not None and equity0 > 0:
        shadow_roe = ni0 / equity0 * 100.0

    # ── coverage bucket（単一・決定的）─────────────────────────────────
    if profit_growth is not None or eps_growth is not None:
        coverage = COVERAGE_PRESENT
    else:
        reasons = {profit_reason, eps_reason}
        # 「invalid numeric」は §12 の 7 bucket に無いため missing へ畳む
        # （status は別途 invalid になる）。
        precedence = (
            COVERAGE_ROW_LABEL_MISSING,
            COVERAGE_MISSING,
            COVERAGE_IRREGULAR_PERIOD,
            COVERAGE_SPLIT_GUARD_BLOCKED,
            COVERAGE_NEGATIVE_BASE,
        )
        coverage = COVERAGE_MISSING
        if "invalid" in reasons and reasons.issubset({"invalid"}):
            coverage = COVERAGE_MISSING
        else:
            for candidate in precedence:
                if candidate in reasons:
                    coverage = candidate
                    break

    # ── status（null 値を等価に見せない）──────────────────────────────
    if profit_growth is not None and eps_growth is not None:
        status = FUNDAMENTALS_STATUS_AVAILABLE
    elif profit_growth is not None or eps_growth is not None:
        status = FUNDAMENTALS_STATUS_PARTIAL
    elif invalid_seen:
        status = FUNDAMENTALS_STATUS_INVALID
    elif ni_label is None and eps_label is None:
        status = FUNDAMENTALS_STATUS_MISSING
    else:
        # 行はあるが negativeBase / split guard / irregular period 等で
        # 双方 null（部分的な authority のみ）。
        status = FUNDAMENTALS_STATUS_PARTIAL

    return FundamentalsResult(
        profit_growth=profit_growth,
        eps_growth=eps_growth,
        fiscal_period_end=fiscal_period_end,
        status=status,
        shadow_per=shadow_per,
        shadow_roe=shadow_roe,
        coverage=coverage,
    )


# ── shadow 比較集計（ephemeral。raw 値は commit / publish しない、§16）──
@dataclass
class _ShadowAggregator:
    """provider-direct trailingPE vs derived PER shadow、および
    provider-direct returnOnEquity vs derived ROE shadow の in-memory 集計。
    per-symbol raw 値は保持しない —— Phase B calibration 用の非機微な要約統計のみ。"""

    per_pairs: int = 0
    per_abs_rel_diffs: list[float] = field(default_factory=list)
    roe_pairs: int = 0
    roe_abs_rel_diffs: list[float] = field(default_factory=list)

    def add(
        self,
        *,
        provider_per: Optional[float],
        shadow_per: Optional[float],
        provider_roe: Optional[float],
        shadow_roe: Optional[float],
    ) -> None:
        if _finite_or_none(provider_per) is not None and _finite_or_none(shadow_per) is not None and provider_per != 0:
            self.per_pairs += 1
            self.per_abs_rel_diffs.append(abs((shadow_per - provider_per) / provider_per))
        if _finite_or_none(provider_roe) is not None and _finite_or_none(shadow_roe) is not None and provider_roe != 0:
            self.roe_pairs += 1
            self.roe_abs_rel_diffs.append(abs((shadow_roe - provider_roe) / provider_roe))

    @staticmethod
    def _median(values: list[float]) -> Optional[float]:
        if not values:
            return None
        ordered = sorted(values)
        mid = len(ordered) // 2
        if len(ordered) % 2:
            return ordered[mid]
        return (ordered[mid - 1] + ordered[mid]) / 2.0

    def summary(self) -> dict[str, Any]:
        return {
            "perShadowVsProviderTrailingPE": {
                "comparablePairs": self.per_pairs,
                "medianAbsRelDiff": self._median(self.per_abs_rel_diffs),
            },
            "roeShadowVsProviderReturnOnEquity": {
                "comparablePairs": self.roe_pairs,
                "medianAbsRelDiff": self._median(self.roe_abs_rel_diffs),
            },
        }


def _finite_or_none(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _round_or_none(value: Optional[float], digits: int) -> Optional[float]:
    if value is None:
        return None
    if not math.isfinite(value):
        return None
    return round(value, digits)


# ── fetch 層（薄い / network 隔離。unit test は触れない、§22 / §30）────
class FundamentalsRateLimit(RuntimeError):
    """provider の rate-limit condition が確定したことを表す。run-level の
    fail-soft abort をトリガする（§15）。"""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def is_rate_limit_error(exc: BaseException) -> bool:
    """例外が provider rate-limit 由来か（type 名 / message から非機微判定）。"""
    if isinstance(exc, FundamentalsRateLimit):
        return True
    if "ratelimit" in type(exc).__name__.lower():
        return True
    message = str(exc).lower()
    return any(marker in message for marker in _RATE_LIMIT_MARKERS)


@dataclass(frozen=True)
class FundamentalsFetch:
    """1 symbol 分の生 statement surface（derive_fundamentals への入力）。"""

    income_stmt: dict[str, list[Any]]
    balance_sheet: dict[str, list[Any]]
    period_ends: list[date]
    splits: list[tuple[date, float]]
    splits_ok: bool
    ok: bool = True
    failure: Optional[str] = None  # "missing" | "invalid" | None


def _to_date(value: Any) -> Optional[date]:
    try:
        if hasattr(value, "date"):
            return value.date()
        if isinstance(value, date):
            return value
        return datetime.fromisoformat(str(value)).date()
    except (TypeError, ValueError):
        return None


def _statement_to_columns(frame: Any) -> tuple[dict[str, list[Optional[float]]], list[date]]:
    """yfinance の年次 statement DataFrame を label -> [FY0, FY1, ...] へ
    （HE-2 `_statement_to_columns` と同一規律）。"""
    if frame is None:
        raise ValueError("no statement frame")
    columns = list(frame.columns)  # 直近が先頭
    period_ends = [_to_date(column) for column in columns]
    table: dict[str, list[Optional[float]]] = {}
    for label in frame.index:
        table[str(label)] = [_finite_or_none(value) for value in list(frame.loc[label])]
    return table, [item for item in period_ends if item is not None]


def _collect_splits(handle: Any) -> list[tuple[date, float]]:
    collected: list[tuple[date, float]] = []
    for when, ratio in handle.splits.items():
        parsed = _to_date(when)
        factor = _finite_or_none(ratio)
        if parsed is not None and factor is not None:
            collected.append((parsed, factor))
    return collected


def read_fundamentals_input(handle: Any) -> FundamentalsFetch:
    """既に構築済みの yfinance Ticker 相当 handle から income_stmt /
    balance_sheet / splits を読む（3 endpoint のみ。§15: frozen semantic
    contract が要求する最小 call 数）。rate-limit は FundamentalsRateLimit
    として送出。それ以外の provider 障害は ok=False で返す（fail-soft）。"""
    try:
        income, income_ends = _statement_to_columns(handle.income_stmt)
    except Exception as error:  # noqa: BLE001
        if is_rate_limit_error(error):
            raise FundamentalsRateLimit(_safe_reason(error)) from None
        return FundamentalsFetch({}, {}, [], [], False, ok=False, failure="missing")

    try:
        balance, _balance_ends = _statement_to_columns(handle.balance_sheet)
    except Exception as error:  # noqa: BLE001
        if is_rate_limit_error(error):
            raise FundamentalsRateLimit(_safe_reason(error)) from None
        balance = {}

    try:
        splits = _collect_splits(handle)
        splits_ok = True
    except Exception as error:  # noqa: BLE001
        if is_rate_limit_error(error):
            raise FundamentalsRateLimit(_safe_reason(error)) from None
        # split history 取得失敗を「分割なし」と解釈しない（§8）。
        splits = []
        splits_ok = False

    if not income_ends:
        return FundamentalsFetch(income, balance, [], splits, splits_ok, ok=False, failure="missing")

    return FundamentalsFetch(
        income_stmt=income,
        balance_sheet=balance,
        period_ends=income_ends,
        splits=splits,
        splits_ok=splits_ok,
        ok=True,
        failure=None,
    )


def _safe_reason(error: BaseException) -> str:
    """例外から非機微な短い理由文字列を作る（URL/トークン等を載せない）。"""
    return f"{type(error).__name__}"


def fetch_fundamentals_one(code: str, *, ticker_factory: Optional[Callable[[str], Any]] = None) -> FundamentalsFetch:
    """1 symbol の生 statement surface を取得する（network）。

    FundamentalsRateLimit を送出しうる —— 呼び出し元（FundamentalsEnricher）は
    それを run-level abort として扱う。retry loop は張らない（§15）。"""
    if ticker_factory is None:
        import yfinance as yf

        ticker_factory = lambda symbol: yf.Ticker(symbol)  # noqa: E731

    last_error: Optional[BaseException] = None
    for _ in range(_FETCH_ATTEMPTS):
        try:
            handle = ticker_factory(f"{code}.T")
            return read_fundamentals_input(handle)
        except FundamentalsRateLimit:
            raise
        except Exception as error:  # noqa: BLE001
            if is_rate_limit_error(error):
                raise FundamentalsRateLimit(_safe_reason(error)) from None
            last_error = error
    if last_error is not None:
        print(f"    {code}: fundamentals fetch failed: {type(last_error).__name__}")
    return FundamentalsFetch({}, {}, [], [], False, ok=False, failure="missing")


FundamentalsFetchFn = Callable[[str], FundamentalsFetch]


# ── run-level enricher（abort 状態・coverage・shadow 集計を保持）────────
class FundamentalsEnricher:
    """1 run 分の fundamental shadow channel。candidate item を in-place で
    enrich し、_meta.fundamentals 集計と ephemeral shadow 要約を提供する。

    fail-soft 契約（§14 / §15）:
      - 1 symbol の statement 障害 → その symbol の新 field のみ null、
        既存 market field は不変
      - provider rate-limit が確定 → 以降の symbol の新 fundamental fetch を
        停止（aborted=True）。既存 candidate 生成は継続。
    """

    def __init__(
        self,
        fetch_fn: FundamentalsFetchFn,
        *,
        now: datetime,
    ) -> None:
        self._fetch_fn = fetch_fn
        self._now = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
        self._coverage_by_code: dict[str, str] = {}
        self._shadow = _ShadowAggregator()
        self.aborted = False
        self.abort_reason: Optional[str] = None

    def enrich(self, item: dict[str, Any], code: str) -> None:
        """item へ profitGrowth / epsGrowth / fiscalPeriodEnd / fundamentalsStatus
        を付与する。"""
        if self.aborted:
            self._apply(item, _null_result(FUNDAMENTALS_STATUS_MISSING))
            self._coverage_by_code[code] = COVERAGE_MISSING
            return

        try:
            fetched = self._fetch_fn(code)
        except FundamentalsRateLimit as rate_limit:
            self.aborted = True
            self.abort_reason = f"provider_rate_limited: {rate_limit.reason}"
            print(
                f"  ⚠ fundamentals shadow channel aborted (provider rate limit); "
                f"remaining symbols get null fundamentals"
            )
            self._apply(item, _null_result(FUNDAMENTALS_STATUS_MISSING))
            self._coverage_by_code[code] = COVERAGE_MISSING
            return

        if not fetched.ok:
            status = (
                FUNDAMENTALS_STATUS_INVALID
                if fetched.failure == "invalid"
                else FUNDAMENTALS_STATUS_MISSING
            )
            self._apply(item, _null_result(status))
            self._coverage_by_code[code] = COVERAGE_MISSING
            return

        result = derive_fundamentals(
            income_stmt=fetched.income_stmt,
            balance_sheet=fetched.balance_sheet,
            period_ends=fetched.period_ends,
            splits=fetched.splits,
            splits_ok=fetched.splits_ok,
            price_last_close=_finite_or_none(item.get("price")),
            observed_at=self._now,
        )
        self._shadow.add(
            provider_per=item.get("per"),
            shadow_per=result.shadow_per,
            provider_roe=item.get("roe"),
            shadow_roe=result.shadow_roe,
        )
        self._apply(item, result)
        self._coverage_by_code[code] = result.coverage

    @staticmethod
    def _apply(item: dict[str, Any], result: FundamentalsResult) -> None:
        item["profitGrowth"] = _round_or_none(result.profit_growth, 2)
        item["epsGrowth"] = _round_or_none(result.eps_growth, 2)
        item["fiscalPeriodEnd"] = result.fiscal_period_end
        item["fundamentalsStatus"] = result.status

    def meta(self, published_codes: list[str]) -> dict[str, Any]:
        """_meta.fundamentals contract（§12）。coverage は publish 対象 symbol
        のみ集計する（公開 artifact と一致させる）。"""
        coverage = {bucket: 0 for bucket in COVERAGE_BUCKETS}
        for code in published_codes:
            bucket = self._coverage_by_code.get(code)
            if bucket in coverage:
                coverage[bucket] += 1
        return {
            "source": FUNDAMENTALS_SOURCE,
            "fetchedAt": self._now.isoformat(),
            "statementMaxAgeDays": STATEMENT_MAX_AGE_DAYS,
            "canonicalPeField": CANONICAL_PE_FIELD,
            "growthScoringStatus": GROWTH_SCORING_STATUS,
            "coverage": coverage,
            "aborted": self.aborted,
            "abortReason": self.abort_reason,
        }

    def shadow_evidence(self) -> dict[str, Any]:
        """ephemeral な Phase B calibration 用要約（raw 値なし、非機微）。"""
        return {
            "kind": "fundamentals_shadow_evidence",
            "generatedAt": self._now.isoformat(),
            "not_for_trading": True,
            "note": (
                "ephemeral Phase B calibration input; derived PER/ROE shadow vs "
                "provider-direct. never committed or published."
            ),
            "aborted": self.aborted,
            "abortReason": self.abort_reason,
            **self._shadow.summary(),
        }

    def emit_shadow_evidence(self) -> Optional[Path]:
        """shadow 要約を 1 行 log へ出し、RUNNER_TEMP があれば ephemeral file
        へも書く。repo / public/data へは決して書かない（§16）。"""
        evidence = self.shadow_evidence()
        print(f"  fundamentals shadow evidence: {json.dumps(evidence, ensure_ascii=False)}")
        runner_temp = os.environ.get("RUNNER_TEMP")
        if not runner_temp:
            return None
        try:
            out_path = Path(runner_temp) / "fundamentals_shadow_evidence.json"
            out_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
            return out_path
        except OSError:
            return None
