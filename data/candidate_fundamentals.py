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
import re
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

# P5-B005-B4-D1a-O: D1a-O 期間中は public production authority は provider ベース
# のまま。strict-derived annual FY0 PER は ephemeral calibration mirror でのみ
# 使用する（実際の authority migration は本 ticket では行わない）。
PER_AUTHORITY_PROVIDER = "providerTrailingPE"
PER_AUTHORITY_DERIVED = "derivedAnnualFY0"
DERIVED_PER_CALIBRATION_HANDOFF_SCHEMA = "derived-per-calibration-handoff-1"
DERIVED_PER_CALIBRATION_HANDOFF_FILENAME = "derived_per_calibration_handoff.json"

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

# _meta.fundamentals.coverage の bucket（§3: TOTAL かつ MUTUALLY EXCLUSIVE。
# publish 対象の各 symbol はちょうど 1 bucket へ寄与し、
# sum(coverage.values()) == publishedCount が常に成り立つ）。
COVERAGE_PRESENT = "present"                    # profitGrowth / epsGrowth 双方が有効
COVERAGE_STALE = "stale"                        # FY0 が 456 日より古い（statement 全体）
COVERAGE_MISSING = "missing"                    # statement / FY1 列が取得できない
COVERAGE_NEGATIVE_BASE = "negativeBase"         # FY1 ベースが非正
COVERAGE_SPLIT_GUARD_BLOCKED = "splitGuardBlocked"  # 分割調整が確定できない（EPS 軸）
COVERAGE_IRREGULAR_PERIOD = "irregularPeriod"   # FY0-FY1 span が 335..395 日外
COVERAGE_ROW_LABEL_MISSING = "rowLabelMissing"  # 行ラベル自体が不在
# 監査 P2-A / P2-01 の repair で追加/拡張した唯一の terminal bucket（§3:
# implementation constraint により unavoidable）。次のいずれかで fundamental を
# 「確定させられなかった」published symbol を、`missing`（＝provider が成功応答を
# 返し、行/期/statement が正当に不在）と混同せず truthfully 計上する:
#   - outer fail-soft 例外 / provider fetch 例外（transport / parse 障害）
#   - provider rate-limit を引いた symbol（fetch が確定前に abort）
#   - run-level rate-limit abort 後に fetch されなかった symbol
#     （財務的 missing だと証明されていない）
#   - statement セルが非有限（invalid numeric）
COVERAGE_INVALID = "invalid"

COVERAGE_BUCKETS = (
    COVERAGE_PRESENT,
    COVERAGE_STALE,
    COVERAGE_MISSING,
    COVERAGE_NEGATIVE_BASE,
    COVERAGE_SPLIT_GUARD_BLOCKED,
    COVERAGE_IRREGULAR_PERIOD,
    COVERAGE_ROW_LABEL_MISSING,
    COVERAGE_INVALID,
)

# ── 決定的 terminal precedence（§3 / §6）──────────────────────────────
# profitGrowth / epsGrowth のどちらも `present` にならないとき、terminal
# coverage bucket は「非可用となった軸（複数可）の原因」のうち、この順序で
# 最初に一致するものを採る。coincident cause はこの一覧で解決する ——
# コードの出現順に暗黙依存しない（§3）。順序の意図は
# 「上流 / データ非可用」→「データ品質」→「データは揃うが計算が誤誘導的」。
_COVERAGE_PRECEDENCE = (
    COVERAGE_STALE,               # 1. FY0 が古すぎて statement 全体が使えない
    COVERAGE_MISSING,             # 2. statement / FY1 列そのものが無い
    COVERAGE_ROW_LABEL_MISSING,   # 3. 必要な行ラベルが無い
    COVERAGE_INVALID,             # 4. 行はあるが非有限 / provider 障害
    COVERAGE_IRREGULAR_PERIOD,    # 5. period 構造が YoY に使えない
    COVERAGE_SPLIT_GUARD_BLOCKED, # 6. 分割調整が確定できない（EPS 軸）
    COVERAGE_NEGATIVE_BASE,       # 7. データは揃うが FY1 ベースが非正
)

# ── axis-specific diagnostics（§4）───────────────────────────────────
# coverage（exclusive, sum == publishedCount）と混同しない overlapping な
# per-axis 観測値。各軸は published symbol ごとにちょうど 1 つの reason を
# 取る（mixed-axis authority を保存する）。
_AXIS_AVAILABLE = "available"
_AXIS_MISSING = "missing"
_AXIS_ROW_LABEL_MISSING = "rowLabelMissing"
_AXIS_INVALID_NUMERIC = "invalidNumeric"
_AXIS_IRREGULAR_PERIOD = "irregularPeriod"
_AXIS_SPLIT_GUARD_BLOCKED = "splitGuardBlocked"  # EPS 軸のみ
_AXIS_NEGATIVE_BASE = "negativeBase"
_AXIS_STALE = "stale"
_AXIS_ENRICH_FAILED = "enrichFailed"  # provider 障害 / rate-limit abort / outer 例外

_DIAG_PROFIT_KEYS = (
    _AXIS_AVAILABLE,
    _AXIS_MISSING,
    _AXIS_ROW_LABEL_MISSING,
    _AXIS_INVALID_NUMERIC,
    _AXIS_IRREGULAR_PERIOD,
    _AXIS_NEGATIVE_BASE,
    _AXIS_STALE,
    _AXIS_ENRICH_FAILED,
)
_DIAG_EPS_KEYS = _DIAG_PROFIT_KEYS + (_AXIS_SPLIT_GUARD_BLOCKED,)

# axis reason → terminal coverage bucket。`available` は非可用軸の集合に
# 入らないため写像不要。
_AXIS_TO_COVERAGE = {
    _AXIS_MISSING: COVERAGE_MISSING,
    _AXIS_ROW_LABEL_MISSING: COVERAGE_ROW_LABEL_MISSING,
    _AXIS_INVALID_NUMERIC: COVERAGE_INVALID,
    _AXIS_IRREGULAR_PERIOD: COVERAGE_IRREGULAR_PERIOD,
    _AXIS_SPLIT_GUARD_BLOCKED: COVERAGE_SPLIT_GUARD_BLOCKED,
    _AXIS_NEGATIVE_BASE: COVERAGE_NEGATIVE_BASE,
    _AXIS_STALE: COVERAGE_STALE,
    _AXIS_ENRICH_FAILED: COVERAGE_INVALID,
}

# ── strict-derived PER 診断語彙（P5-B005-B4-D1a-O calibration authority）──
# frozen future authority = candidate canonical price / accepted annual FY0
# reported EPS（Diluted 優先、Diluted 行が無い場合のみ Basic。Diluted 行が
# あって値が invalid なら Basic fallback しない）。この値は D1a-O では
# ephemeral な calibration mirror でのみ使われ、production の public `per`
# authority（provider trailingPE）は一切変更しない。
#
# 各 published symbol はちょうど 1 つの per-diagnostic bucket へ寄与し、
# sum(diagnostics.per.values()) == publishedCount が常に成り立つ。
PER_DIAG_AVAILABLE = "available"
PER_DIAG_MISSING = "missing"                    # EPS 行はあるが FY0 セルが無い
PER_DIAG_ROW_LABEL_MISSING = "rowLabelMissing"  # Diluted/Basic EPS 行自体が不在
PER_DIAG_INVALID_NUMERIC = "invalidNumeric"     # FY0 EPS セルが非有限
PER_DIAG_EPS_NOT_POSITIVE = "epsNotPositive"    # FY0 EPS <= 0
PER_DIAG_STALE = "stale"                        # FY0 statement が 456 日より古い
PER_DIAG_IRREGULAR_PERIOD = "irregularPeriod"   # FY0-FY1 span が 335..395 日外
PER_DIAG_SPLIT_GUARD_BLOCKED = "splitGuardBlocked"  # 分割調整不確定 / split 履歴取得失敗
PER_DIAG_ENRICH_FAILED = "enrichFailed"         # provider 障害 / rate-limit abort / outer 例外
PER_DIAG_PRICE_UNAVAILABLE = "priceUnavailable"  # canonical price が非正 / 非有限 / 欠損

PER_DIAG_KEYS = (
    PER_DIAG_AVAILABLE,
    PER_DIAG_MISSING,
    PER_DIAG_ROW_LABEL_MISSING,
    PER_DIAG_INVALID_NUMERIC,
    PER_DIAG_EPS_NOT_POSITIVE,
    PER_DIAG_STALE,
    PER_DIAG_IRREGULAR_PERIOD,
    PER_DIAG_SPLIT_GUARD_BLOCKED,
    PER_DIAG_ENRICH_FAILED,
    PER_DIAG_PRICE_UNAVAILABLE,
)

_FETCH_ATTEMPTS = 1  # zero-weight shadow channel。retry storm を持ち込まない（§15）。

# ── rate-limit 検出（§8: bare "429" substring を廃止）────────────────
# text fallback の "429" は必ず数値境界と context を要求し、
# "4290.T connection reset" / "account 1429 unavailable" のような無関係
# 文字列で false-positive しないようにする。
_RATE_LIMIT_TEXT_MARKERS = (
    "rate limit",
    "rate-limit",
    "ratelimit",
    "too many requests",
)
_RATE_LIMIT_429_RE = re.compile(
    # HTTP/status/response/code/error のような context 語の直後（非数字 0..6 文字）
    # に、前後を数字・ドットで囲まれない 429。
    r"\b(?:http|https|status|status[_-]?code|statuscode|response|resp|err|error|code)\b"
    r"[^0-9]{0,6}429(?![\d.])"
    # または「429 Too Many Requests」「429 Client Error」「429 rate ...」。
    r"|(?<![\d.])429(?![\d.])\s*(?:too many requests|client error|rate)",
    re.IGNORECASE,
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
    # §4 axis-specific diagnostics。coverage（exclusive）とは別契約の per-axis
    # reason。mixed-axis authority（片軸 valid / 片軸 block）を保存する。
    profit_axis: str = _AXIS_MISSING
    eps_axis: str = _AXIS_MISSING
    # P5-B005-B4-D1a-O: strict-derived annual FY0 PER（ephemeral calibration
    # mirror 専用。production public `per` authority は不変）。
    strict_derived_per: Optional[float] = None
    strict_derived_per_diag: str = PER_DIAG_MISSING


def _null_result(
    status: str,
    fiscal_period_end: Optional[str] = None,
    coverage: str = COVERAGE_MISSING,
    *,
    profit_axis: str = _AXIS_MISSING,
    eps_axis: str = _AXIS_MISSING,
    strict_derived_per_diag: str = PER_DIAG_MISSING,
) -> FundamentalsResult:
    return FundamentalsResult(
        profit_growth=None,
        eps_growth=None,
        fiscal_period_end=fiscal_period_end,
        status=status,
        shadow_per=None,
        shadow_roe=None,
        coverage=coverage,
        profit_axis=profit_axis,
        eps_axis=eps_axis,
        strict_derived_per=None,
        strict_derived_per_diag=strict_derived_per_diag,
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
        return _null_result(
            FUNDAMENTALS_STATUS_INVALID,
            coverage=COVERAGE_MISSING,
            profit_axis=_AXIS_MISSING,
            eps_axis=_AXIS_MISSING,
            strict_derived_per_diag=PER_DIAG_MISSING,
        )

    # ── FY0 / FY1 を period identity で決定する（§10 T9）────────────────
    # provider の列順に依存しない。データが period-end を持つ以上、それを
    # 単一 authority として降順に並べ替える。厳密降順にできない
    # （重複 period-end 等）場合は span guard が deterministic に fail-closed
    # する（span 0 は 335..395 外）。
    sorted_ends = sorted(period_ends, reverse=True)
    fiscal_period_end = sorted_ends[0].isoformat()
    fy_order = sorted(range(len(period_ends)), key=lambda i: period_ends[i], reverse=True)
    fy0_idx: Optional[int] = fy_order[0]
    fy1_idx: Optional[int] = fy_order[1] if len(fy_order) >= 2 else None

    # 2 つの時計を混同しない（§13）: ここで見るのは財務諸表の freshness
    # （fiscalPeriodEnd / 456 日 authority）であって dataset freshness ではない。
    if not _he_statement_age_ok(sorted_ends, observed_at):
        return _null_result(
            FUNDAMENTALS_STATUS_STALE,
            fiscal_period_end=fiscal_period_end,
            coverage=COVERAGE_STALE,
            profit_axis=_AXIS_STALE,
            eps_axis=_AXIS_STALE,
            strict_derived_per_diag=PER_DIAG_STALE,
        )

    ni_label = _ni_label(income_stmt)
    eps_label = _he_eps_label(income_stmt)

    ni0, ni0_kind = _cell(income_stmt, ni_label, fy0_idx) if fy0_idx is not None else (None, _CELL_INDEX_MISSING)
    ni1, ni1_kind = _cell(income_stmt, ni_label, fy1_idx) if fy1_idx is not None else (None, _CELL_INDEX_MISSING)
    eps0, eps0_kind = _cell(income_stmt, eps_label, fy0_idx) if fy0_idx is not None else (None, _CELL_INDEX_MISSING)
    eps1, eps1_kind = _cell(income_stmt, eps_label, fy1_idx) if fy1_idx is not None else (None, _CELL_INDEX_MISSING)
    equity0, _equity0_kind = _cell(balance_sheet, "Stockholders Equity", 0)

    span_ok = _comparable_span_ok(sorted_ends)
    # split history が取得できていない場合は fail-closed（§7）。
    split_ok = bool(splits_ok) and _he_split_guard_ok(splits, sorted_ends)

    # ── profitGrowth 軸（§7）── reason 内の precedence は
    # rowLabelMissing > invalidNumeric > missing > irregularPeriod > negativeBase。
    profit_growth: Optional[float] = None
    if ni_label is None:
        profit_axis = _AXIS_ROW_LABEL_MISSING
    elif ni0_kind == _CELL_NOT_FINITE or ni1_kind == _CELL_NOT_FINITE:
        profit_axis = _AXIS_INVALID_NUMERIC
    elif ni0 is None or ni1 is None:
        profit_axis = _AXIS_MISSING  # 片方の FY しか無い
    elif not span_ok:
        profit_axis = _AXIS_IRREGULAR_PERIOD
    elif ni1 <= 0:
        # NI_FY1 <= 0: ゼロ/負ベースから explosive/misleading な成長率を作らない
        profit_axis = _AXIS_NEGATIVE_BASE
    else:
        profit_growth = (ni0 - ni1) / ni1 * 100.0
        profit_axis = _AXIS_AVAILABLE

    # ── epsGrowth 軸（§8）── split guard は irregularPeriod と negativeBase の間。
    eps_growth: Optional[float] = None
    if eps_label is None:
        eps_axis = _AXIS_ROW_LABEL_MISSING
    elif eps0_kind == _CELL_NOT_FINITE or eps1_kind == _CELL_NOT_FINITE:
        eps_axis = _AXIS_INVALID_NUMERIC
    elif eps0 is None or eps1 is None:
        eps_axis = _AXIS_MISSING
    elif not span_ok:
        eps_axis = _AXIS_IRREGULAR_PERIOD
    elif not split_ok:
        eps_axis = _AXIS_SPLIT_GUARD_BLOCKED
    elif eps1 <= 0:
        eps_axis = _AXIS_NEGATIVE_BASE
    else:
        eps_growth = (eps0 - eps1) / eps1 * 100.0
        eps_axis = _AXIS_AVAILABLE

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

    # ── strict-derived annual FY0 PER（§2 / P5-B005-B4-D1a-O）────────────
    # canonical price / accepted annual FY0 reported EPS。provider PER
    # fallback は決して使わない（frozen future authority = STRICT_DERIVED）。
    # numeric になるのは全 guard が pass したときのみ。決定的 precedence:
    #   rowLabelMissing > invalidNumeric > missing > irregularPeriod
    #   > splitGuardBlocked > epsNotPositive > priceUnavailable > available
    # （stale は上で早期 return 済み。enrichFailed は enricher が設定する。）
    strict_derived_per: Optional[float] = None
    if eps_label is None:
        strict_derived_per_diag = PER_DIAG_ROW_LABEL_MISSING
    elif eps0_kind == _CELL_NOT_FINITE:
        strict_derived_per_diag = PER_DIAG_INVALID_NUMERIC
    elif eps0 is None:
        strict_derived_per_diag = PER_DIAG_MISSING
    elif not span_ok:
        # FY1 period identity が欠落（sorted_ends < 2）でも strict-derived PER は
        # usable にしない。frozen D1a authority は FY0/FY1 の annual temporal
        # identity を要求する。comparability guard が pass できない以上
        # irregularPeriod で fail-closed する（provider PER fallback は禁止）。
        strict_derived_per_diag = PER_DIAG_IRREGULAR_PERIOD
    elif not split_ok:
        # split guard 未 pass、または split 履歴取得失敗（splits_ok=False）を
        # 決定的に splitGuardBlocked へ写像する（§5 注 A。「分割なし」と
        # silent に混同しない）。
        strict_derived_per_diag = PER_DIAG_SPLIT_GUARD_BLOCKED
    elif eps0 <= 0:
        strict_derived_per_diag = PER_DIAG_EPS_NOT_POSITIVE
    elif price_last_close is None or not (
        isinstance(price_last_close, (int, float))
        and math.isfinite(price_last_close)
        and price_last_close > 0
    ):
        strict_derived_per_diag = PER_DIAG_PRICE_UNAVAILABLE
    else:
        strict_derived_per = price_last_close / eps0
        strict_derived_per_diag = PER_DIAG_AVAILABLE

    # ── coverage bucket（§3: exclusive・total・決定的）─────────────────
    # `present` は「両軸とも available」のときのみ。片軸でも block されていれば
    # coverage はその block 原因を露出する（監査 P2-B の repair）。
    if profit_axis == _AXIS_AVAILABLE and eps_axis == _AXIS_AVAILABLE:
        coverage = COVERAGE_PRESENT
    else:
        blocked_buckets = {
            _AXIS_TO_COVERAGE[axis]
            for axis in (profit_axis, eps_axis)
            if axis != _AXIS_AVAILABLE
        }
        coverage = next(
            (bucket for bucket in _COVERAGE_PRECEDENCE if bucket in blocked_buckets),
            COVERAGE_INVALID,
        )

    # ── status（§11: 5 値 vocabulary。詳細な原因は diagnostics へ委ねる）──
    # 決定的 precedence:
    #   both available            → available
    #   片軸のみ available          → partial
    #   いずれかの軸が invalid/障害  → invalid
    #   両軸 stale                 → stale
    #   両軸が missing/rowLabel     → missing
    #   それ以外（行はあるが両軸 block）→ partial
    profit_ok = profit_axis == _AXIS_AVAILABLE
    eps_ok = eps_axis == _AXIS_AVAILABLE
    axes = (profit_axis, eps_axis)
    if profit_ok and eps_ok:
        status = FUNDAMENTALS_STATUS_AVAILABLE
    elif profit_ok or eps_ok:
        status = FUNDAMENTALS_STATUS_PARTIAL
    elif _AXIS_ENRICH_FAILED in axes or _AXIS_INVALID_NUMERIC in axes:
        status = FUNDAMENTALS_STATUS_INVALID
    elif profit_axis == _AXIS_STALE and eps_axis == _AXIS_STALE:
        status = FUNDAMENTALS_STATUS_STALE
    elif profit_axis in (_AXIS_MISSING, _AXIS_ROW_LABEL_MISSING) and eps_axis in (
        _AXIS_MISSING,
        _AXIS_ROW_LABEL_MISSING,
    ):
        status = FUNDAMENTALS_STATUS_MISSING
    else:
        status = FUNDAMENTALS_STATUS_PARTIAL

    return FundamentalsResult(
        profit_growth=profit_growth,
        eps_growth=eps_growth,
        fiscal_period_end=fiscal_period_end,
        status=status,
        shadow_per=shadow_per,
        shadow_roe=shadow_roe,
        coverage=coverage,
        profit_axis=profit_axis,
        eps_axis=eps_axis,
        strict_derived_per=strict_derived_per,
        strict_derived_per_diag=strict_derived_per_diag,
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


def _int_attr(obj: Any, name: str) -> Optional[int]:
    """obj.<name> が bool でない int ならそれを、さもなくば None を返す。"""
    try:
        value = getattr(obj, name, None)
    except Exception:  # noqa: BLE001 - 属性 getter が投げても rate-limit 判定は続行
        return None
    if isinstance(value, bool):
        return None
    return value if isinstance(value, int) else None


def is_rate_limit_error(exc: BaseException) -> bool:
    """例外が provider rate-limit 由来か（§8: 明示的 type / status_code を優先し、
    text fallback の "429" は数値境界＋context を必須にする。"4290.T ..." や
    "account 1429 ..." では決して true にしない）。"""
    # 1. 明示的な provider exception type
    if isinstance(exc, FundamentalsRateLimit):
        return True
    type_name = type(exc).__name__.lower()
    if "ratelimit" in type_name or "toomanyrequests" in type_name:
        return True
    # 2. 明示的な status_code == 429（例外自身の属性）
    for attr in ("status_code", "code", "status"):
        if _int_attr(exc, attr) == 429:
            return True
    # 3. response.status_code == 429（観測可能な場合）
    response = getattr(exc, "response", None)
    if response is not None and _int_attr(response, "status_code") == 429:
        return True
    # 4. 十分に境界の明確な textual signal
    message = str(exc)
    lowered = message.lower()
    if any(marker in lowered for marker in _RATE_LIMIT_TEXT_MARKERS):
        return True
    if _RATE_LIMIT_429_RE.search(message):
        return True
    return False


@dataclass(frozen=True)
class FundamentalsFetch:
    """1 symbol 分の生 statement surface（derive_fundamentals への入力）。"""

    income_stmt: dict[str, list[Any]]
    balance_sheet: dict[str, list[Any]]
    period_ends: list[date]
    splits: list[tuple[date, float]]
    splits_ok: bool
    ok: bool = True
    # None            : ok
    # "missing"       : provider が成功応答を返したが必要な statement/期/行が
    #                   正当に不在（§4A: genuine data absence）
    # "invalid"       : provider fetch / parse 例外。信頼できる statement
    #                   authority が確立する前に失敗した（§4C: provider failure）
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
        # §4C / P2-01: income statement の fetch/parse 例外は provider 障害であり、
        # 「行が正当に無い（missing）」とは意味が違う。信頼できる statement
        # authority が確立する前に失敗しているので `invalid` として露出する。
        return FundamentalsFetch({}, {}, [], [], False, ok=False, failure="invalid")

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
    # §4C / P2-01: ここに到達するのは non-rate-limit の provider 例外が起きた
    # ときのみ（正常 fetch は上で return 済み）。provider 障害であって
    # 「行が正当に無い」ではないため `invalid`。
    return FundamentalsFetch({}, {}, [], [], False, ok=False, failure="invalid")


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
        # §4 axis diagnostics: code -> (profit_axis, eps_axis)
        self._axes_by_code: dict[str, tuple[str, str]] = {}
        self._shadow = _ShadowAggregator()
        # P5-B005-B4-D1a-O: per-symbol strict-derived PER calibration record。
        # provider per の availability と strict-derived PER + diagnostic のみ。
        # raw income statement / EPS 履歴は保持しない（§7）。
        self._calib_by_code: dict[str, dict[str, Any]] = {}
        self.aborted = False
        self.abort_reason: Optional[str] = None

    def _record(
        self, code: str, result: FundamentalsResult, item: Optional[dict[str, Any]] = None
    ) -> None:
        """1 published symbol 分の terminal coverage bucket と per-axis diagnostics
        を登録する。§3: どの経路もここを通り、集計から漏れる symbol を作らない。"""
        self._coverage_by_code[code] = result.coverage
        self._axes_by_code[code] = (result.profit_axis, result.eps_axis)
        provider_per = _finite_or_none(item.get("per")) if isinstance(item, dict) else None
        strict_per = _finite_or_none(result.strict_derived_per)
        strict_valid = strict_per is not None and result.strict_derived_per_diag == PER_DIAG_AVAILABLE
        self._calib_by_code[code] = {
            "code": code,
            "providerPer": provider_per,
            # availability class は dataConfidence の per usable-axis と同じ規律
            # （engine: per_vals is not None ＝ 有限なら符号を問わず usable）。
            "providerPerValid": provider_per is not None,
            "strictDerivedPer": strict_per if strict_valid else None,
            "strictDerivedPerValid": strict_valid,
            "strictDerivedPerDiag": result.strict_derived_per_diag,
        }

    def enrich(self, item: dict[str, Any], code: str) -> None:
        """item へ profitGrowth / epsGrowth / fiscalPeriodEnd / fundamentalsStatus
        を付与する。この shadow channel は zero-weight であり、いかなる例外でも
        market candidate publication を止めない —— 予期しない例外は terminal
        invalid bucket として計上する（§5 / §3: no exception path bypasses
        registration）。"""
        try:
            self._enrich_inner(item, code)
        except Exception as exc:  # noqa: BLE001 - fail-soft 最終防御（§5）
            print(
                f"  ⚠ {code}: fundamentals shadow enrich unexpected error: "
                f"{type(exc).__name__}"
            )
            self.record_enrich_failure(item, code)

    def _enrich_inner(self, item: dict[str, Any], code: str) -> None:
        if self.aborted:
            # §4E / P2-01: run-level rate-limit abort 後に fetch されなかった
            # symbol。財務的に missing だと証明されていない —— provider authority
            # が既に abort していたため fetch されなかっただけ。truthful に
            # invalid / enrichFailed とする（追加 fetch はしない）。
            result = _null_result(
                FUNDAMENTALS_STATUS_INVALID,
                coverage=COVERAGE_INVALID,
                profit_axis=_AXIS_ENRICH_FAILED,
                eps_axis=_AXIS_ENRICH_FAILED,
                strict_derived_per_diag=PER_DIAG_ENRICH_FAILED,
            )
            self._apply(item, result)
            self._record(code, result, item)
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
            # §4D / P2-01: rate-limit を引いた symbol 自身。provider 障害と同じ
            # authority（invalid / enrichFailed）。加えて aborted=True /
            # abortReason は上で設定済み。
            result = _null_result(
                FUNDAMENTALS_STATUS_INVALID,
                coverage=COVERAGE_INVALID,
                profit_axis=_AXIS_ENRICH_FAILED,
                eps_axis=_AXIS_ENRICH_FAILED,
                strict_derived_per_diag=PER_DIAG_ENRICH_FAILED,
            )
            self._apply(item, result)
            self._record(code, result, item)
            return

        if not fetched.ok:
            if fetched.failure == "invalid":
                result = _null_result(
                    FUNDAMENTALS_STATUS_INVALID,
                    coverage=COVERAGE_INVALID,
                    profit_axis=_AXIS_ENRICH_FAILED,
                    eps_axis=_AXIS_ENRICH_FAILED,
                    strict_derived_per_diag=PER_DIAG_ENRICH_FAILED,
                )
            else:
                result = _null_result(
                    FUNDAMENTALS_STATUS_MISSING,
                    profit_axis=_AXIS_MISSING,
                    eps_axis=_AXIS_MISSING,
                    strict_derived_per_diag=PER_DIAG_MISSING,
                )
            self._apply(item, result)
            self._record(code, result, item)
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
        self._record(code, result, item)

    def record_enrich_failure(self, item: dict[str, Any], code: str) -> None:
        """enrich() が予期せず throw した場合（あるいは呼び出し元の outer
        fail-soft handler）の最終防御（§5 / 監査 P2-A）。published symbol が
        coverage / diagnostics 集計から漏れないよう terminal invalid bucket を
        ちょうど 1 つ登録し、market field は保ったまま fundamental を null に
        する。dataset publication は継続する。"""
        result = _null_result(
            FUNDAMENTALS_STATUS_INVALID,
            coverage=COVERAGE_INVALID,
            profit_axis=_AXIS_ENRICH_FAILED,
            eps_axis=_AXIS_ENRICH_FAILED,
            strict_derived_per_diag=PER_DIAG_ENRICH_FAILED,
        )
        self._apply(item, result)
        self._record(code, result, item)

    @staticmethod
    def _apply(item: dict[str, Any], result: FundamentalsResult) -> None:
        item["profitGrowth"] = _round_or_none(result.profit_growth, 2)
        item["epsGrowth"] = _round_or_none(result.eps_growth, 2)
        item["fiscalPeriodEnd"] = result.fiscal_period_end
        item["fundamentalsStatus"] = result.status

    def meta(self, published_codes: list[str]) -> dict[str, Any]:
        """_meta.fundamentals contract（§12）。coverage / diagnostics は publish
        対象 symbol のみ集計する（公開 artifact と一致させる）。

        §3 invariant: sum(coverage.values()) == len(published_codes)。すべての
        published symbol はちょうど 1 つの terminal bucket に寄与する。未登録
        symbol（本来あり得ない）は fail-closed で `invalid` として計上し、
        observability を保つ。"""
        coverage = {bucket: 0 for bucket in COVERAGE_BUCKETS}
        diagnostics = {
            "profitGrowth": {key: 0 for key in _DIAG_PROFIT_KEYS},
            "epsGrowth": {key: 0 for key in _DIAG_EPS_KEYS},
            # §5: strict-derived PER calibration diagnostic（exclusive・total）。
            # sum(diagnostics.per.values()) == publishedCount。growth 診断は不変。
            "per": {key: 0 for key in PER_DIAG_KEYS},
        }
        for code in published_codes:
            bucket = self._coverage_by_code.get(code)
            if bucket not in coverage:
                bucket = COVERAGE_INVALID  # fail-closed（§3: 漏れを許さない）
            coverage[bucket] += 1

            profit_axis, eps_axis = self._axes_by_code.get(
                code, (_AXIS_ENRICH_FAILED, _AXIS_ENRICH_FAILED)
            )
            diagnostics["profitGrowth"][
                profit_axis if profit_axis in diagnostics["profitGrowth"] else _AXIS_ENRICH_FAILED
            ] += 1
            diagnostics["epsGrowth"][
                eps_axis if eps_axis in diagnostics["epsGrowth"] else _AXIS_ENRICH_FAILED
            ] += 1
            per_diag = (self._calib_by_code.get(code) or {}).get(
                "strictDerivedPerDiag", PER_DIAG_ENRICH_FAILED
            )
            diagnostics["per"][
                per_diag if per_diag in diagnostics["per"] else PER_DIAG_ENRICH_FAILED
            ] += 1
        return {
            "source": FUNDAMENTALS_SOURCE,
            "fetchedAt": self._now.isoformat(),
            "statementMaxAgeDays": STATEMENT_MAX_AGE_DAYS,
            "canonicalPeField": CANONICAL_PE_FIELD,
            # §6: D1a-O 期間中の public production authority は provider ベース。
            # 実際の authority migration まで "derivedAnnualFY0" にはしない。
            "perAuthority": PER_AUTHORITY_PROVIDER,
            "growthScoringStatus": GROWTH_SCORING_STATUS,
            "coverage": coverage,
            "diagnostics": diagnostics,
            "aborted": self.aborted,
            "abortReason": self.abort_reason,
        }

    def calibration_handoff_payload(self, published_codes: list[str]) -> dict[str, Any]:
        """§7: job-local ephemeral calibration handoff。mirror を回すのに必要な
        最小限の per-symbol scalar のみ（raw income statement / EPS 履歴なし、
        secrets なし、portfolio data なし）。RUNNER_TEMP 以外へは決して書かない。"""
        entries = []
        for code in published_codes:
            rec = self._calib_by_code.get(code)
            if rec is None:
                rec = {
                    "code": code,
                    "providerPer": None,
                    "providerPerValid": False,
                    "strictDerivedPer": None,
                    "strictDerivedPerValid": False,
                    "strictDerivedPerDiag": PER_DIAG_ENRICH_FAILED,
                }
            entries.append(dict(rec))
        return {
            "schemaVersion": DERIVED_PER_CALIBRATION_HANDOFF_SCHEMA,
            "kind": "derived_per_calibration_handoff",
            "generatedAt": self._now.isoformat(),
            "not_for_trading": True,
            "perAuthority": PER_AUTHORITY_PROVIDER,
            "mirrorAuthority": PER_AUTHORITY_DERIVED,
            "aborted": self.aborted,
            "abortReason": self.abort_reason,
            "entries": entries,
        }

    def emit_calibration_handoff(self, published_codes: list[str]) -> Optional[Path]:
        """calibration handoff を RUNNER_TEMP へ書く（§7 / §19）。RUNNER_TEMP が
        無ければ何もしない。data/ ・ public/data/ へは決して書かない。"""
        runner_temp = os.environ.get("RUNNER_TEMP")
        if not runner_temp:
            return None
        payload = self.calibration_handoff_payload(published_codes)
        try:
            out_path = Path(runner_temp) / DERIVED_PER_CALIBRATION_HANDOFF_FILENAME
            out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            return out_path
        except OSError:
            return None

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
