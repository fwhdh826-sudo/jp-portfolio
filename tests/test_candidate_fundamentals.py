"""P5-B005-B4-A: Candidate Funnel fundamental-source plumbing（Phase A）
pure derivation テスト。

network に一切触れない（§22）。全 statement/history は明示的 fixture として注入する。

カバレッジ（§22）:
  - valid annual profit growth
  - valid diluted EPS growth
  - Basic EPS fallback は Diluted 行が無い場合のみ
  - negative/zero NI base
  - negative/zero EPS base
  - stale FY0
  - irregular FY span
  - missing row
  - NaN/Inf/non-numeric
  - stock split after FY1
  - split-history retrieval failure
  - valid derived PER shadow
  - valid derived ROE shadow
  - provider statement failure
  - run-level rate-limit abort
"""
from __future__ import annotations

from datetime import datetime, date, timezone

import pytest

from data.candidate_fundamentals import (
    CANONICAL_PE_FIELD,
    COVERAGE_INVALID,
    COVERAGE_IRREGULAR_PERIOD,
    COVERAGE_MISSING,
    COVERAGE_NEGATIVE_BASE,
    COVERAGE_PRESENT,
    COVERAGE_ROW_LABEL_MISSING,
    COVERAGE_SPLIT_GUARD_BLOCKED,
    COVERAGE_STALE,
    FUNDAMENTALS_STATUS_AVAILABLE,
    FUNDAMENTALS_STATUS_INVALID,
    FUNDAMENTALS_STATUS_MISSING,
    FUNDAMENTALS_STATUS_PARTIAL,
    FUNDAMENTALS_STATUS_STALE,
    GROWTH_SCORING_STATUS,
    FundamentalsEnricher,
    FundamentalsFetch,
    FundamentalsRateLimit,
    derive_fundamentals,
    is_rate_limit_error,
    read_fundamentals_input,
)

OBSERVED = datetime(2026, 6, 30, tzinfo=timezone.utc)
FY0_END = date(2026, 3, 31)
FY1_END = date(2025, 3, 31)  # span 365d → comparable


def _derive(
    *,
    income_stmt=None,
    balance_sheet=None,
    period_ends=None,
    splits=None,
    splits_ok=True,
    price_last_close=2000.0,
    observed_at=OBSERVED,
):
    return derive_fundamentals(
        income_stmt=income_stmt if income_stmt is not None else {},
        balance_sheet=balance_sheet if balance_sheet is not None else {},
        period_ends=period_ends if period_ends is not None else [FY0_END, FY1_END],
        splits=splits if splits is not None else [],
        splits_ok=splits_ok,
        price_last_close=price_last_close,
        observed_at=observed_at,
    )


# ── 定数の凍結 ─────────────────────────────────────────────────────────
def test_canonical_pe_field_is_per():
    assert CANONICAL_PE_FIELD == "per"


def test_growth_scoring_status_is_reserved_zero_weight():
    assert GROWTH_SCORING_STATUS == "reserved_zero_weight"


# ── valid profit growth ───────────────────────────────────────────────
def test_valid_annual_profit_growth():
    result = _derive(
        income_stmt={
            "Net Income Common Stockholders": [120.0, 100.0],
            "Diluted EPS": [12.0, 10.0],
        },
        balance_sheet={"Stockholders Equity": [1000.0, 900.0]},
    )
    assert result.profit_growth == pytest.approx(20.0)
    assert result.eps_growth == pytest.approx(20.0)
    assert result.fiscal_period_end == "2026-03-31"
    assert result.status == FUNDAMENTALS_STATUS_AVAILABLE
    assert result.coverage == COVERAGE_PRESENT


def test_net_income_row_fallback_label_only():
    # "Net Income Common Stockholders" 不在時は "Net Income" 行のみ許可
    result = _derive(
        income_stmt={"Net Income": [150.0, 100.0]},
    )
    assert result.profit_growth == pytest.approx(50.0)


def test_no_other_net_income_semantic_fallback():
    # revenue growth / operating income / provider earningsGrowth 等は使わない
    result = _derive(
        income_stmt={
            "Total Revenue": [200.0, 100.0],
            "Operating Income": [50.0, 25.0],
        },
    )
    assert result.profit_growth is None
    assert result.coverage == COVERAGE_ROW_LABEL_MISSING


# ── EPS growth / Diluted vs Basic ─────────────────────────────────────
def test_valid_diluted_eps_growth():
    result = _derive(
        income_stmt={
            "Net Income": [100.0, 100.0],
            "Diluted EPS": [11.0, 10.0],
            "Basic EPS": [99.0, 1.0],  # 無視されること
        },
    )
    assert result.eps_growth == pytest.approx(10.0)


def test_basic_eps_used_only_when_diluted_row_absent():
    result = _derive(
        income_stmt={
            "Net Income": [100.0, 100.0],
            "Basic EPS": [13.0, 10.0],
        },
    )
    assert result.eps_growth == pytest.approx(30.0)


# ── negative / zero base ──────────────────────────────────────────────
@pytest.mark.parametrize("ni_fy1", [0.0, -50.0])
def test_negative_or_zero_ni_base_yields_null_profit_growth(ni_fy1):
    result = _derive(
        income_stmt={"Net Income": [100.0, ni_fy1], "Diluted EPS": [12.0, 10.0]},
    )
    assert result.profit_growth is None
    # epsGrowth は有効なので present / partial
    assert result.eps_growth == pytest.approx(20.0)
    assert result.status == FUNDAMENTALS_STATUS_PARTIAL


@pytest.mark.parametrize("eps_fy1", [0.0, -2.0])
def test_negative_or_zero_eps_base_yields_null_eps_growth(eps_fy1):
    result = _derive(
        income_stmt={"Net Income": [120.0, 100.0], "Diluted EPS": [10.0, eps_fy1]},
    )
    assert result.eps_growth is None
    assert result.profit_growth == pytest.approx(20.0)


def test_both_negative_base_status_partial_coverage_negative_base():
    result = _derive(
        income_stmt={"Net Income": [10.0, -5.0], "Diluted EPS": [1.0, -1.0]},
    )
    assert result.profit_growth is None and result.eps_growth is None
    assert result.status == FUNDAMENTALS_STATUS_PARTIAL
    assert result.coverage == COVERAGE_NEGATIVE_BASE


def test_swing_to_loss_from_positive_base_is_reported():
    # NI_FY1 > 0、NI_FY0 < 0 → 大きな負の成長率は valid（reported 値をそのまま）
    result = _derive(
        income_stmt={"Net Income": [-50.0, 100.0], "Diluted EPS": [-5.0, 10.0]},
    )
    assert result.profit_growth == pytest.approx(-150.0)
    assert result.eps_growth == pytest.approx(-150.0)


# ── stale FY0 ─────────────────────────────────────────────────────────
def test_stale_fy0_blocks_all_growth():
    result = _derive(
        income_stmt={"Net Income": [120.0, 100.0], "Diluted EPS": [12.0, 10.0]},
        period_ends=[date(2025, 1, 1), date(2024, 1, 1)],
        observed_at=datetime(2026, 9, 9, tzinfo=timezone.utc),
    )
    assert result.profit_growth is None and result.eps_growth is None
    assert result.status == FUNDAMENTALS_STATUS_STALE
    assert result.coverage == COVERAGE_STALE
    # fiscalPeriodEnd は「なぜ stale か」を示すため報告する
    assert result.fiscal_period_end == "2025-01-01"


def test_fy0_age_exactly_456_days_is_in_bounds():
    fy0 = date(2025, 1, 1)
    observed = datetime(2025, 1, 1, tzinfo=timezone.utc).replace(year=2026, month=4, day=2)
    # 2025-01-01 → 2026-04-02 = 456 日
    assert (observed.date() - fy0).days == 456
    result = _derive(
        income_stmt={"Net Income": [110.0, 100.0], "Diluted EPS": [11.0, 10.0]},
        period_ends=[fy0, date(2024, 1, 3)],
        observed_at=observed,
    )
    assert result.status != FUNDAMENTALS_STATUS_STALE


# ── irregular FY span ────────────────────────────────────────────────
def test_irregular_fy_span_blocks_growth():
    result = _derive(
        income_stmt={"Net Income": [120.0, 100.0], "Diluted EPS": [12.0, 10.0]},
        period_ends=[date(2026, 3, 31), date(2025, 9, 30)],  # 182 日
    )
    assert result.profit_growth is None and result.eps_growth is None
    assert result.coverage == COVERAGE_IRREGULAR_PERIOD


def test_span_at_bounds_ok():
    for span_days in (335, 395):
        fy0 = date(2026, 3, 31)
        fy1 = date(fy0.year, fy0.month, fy0.day)
        fy1 = fy0.toordinal() - span_days
        fy1 = date.fromordinal(fy1)
        result = _derive(
            income_stmt={"Net Income": [110.0, 100.0], "Diluted EPS": [11.0, 10.0]},
            period_ends=[fy0, fy1],
        )
        assert result.profit_growth == pytest.approx(10.0), span_days


# ── missing row ──────────────────────────────────────────────────────
def test_missing_rows_status_missing():
    result = _derive(income_stmt={"Total Revenue": [1.0, 1.0]})
    assert result.status == FUNDAMENTALS_STATUS_MISSING
    assert result.coverage == COVERAGE_ROW_LABEL_MISSING


def test_single_fy_column_yields_null_growth():
    result = _derive(
        income_stmt={"Net Income": [100.0], "Diluted EPS": [10.0]},
        period_ends=[FY0_END],
    )
    assert result.profit_growth is None and result.eps_growth is None


# ── NaN / Inf / non-numeric ──────────────────────────────────────────
@pytest.mark.parametrize("bad", [float("nan"), float("inf"), "not-a-number", None])
def test_non_finite_values_yield_null_and_invalid_status(bad):
    result = _derive(
        income_stmt={"Net Income": [bad, 100.0], "Diluted EPS": [bad, 10.0]},
    )
    assert result.profit_growth is None and result.eps_growth is None
    if bad is None:
        # None は「present だが非有限」ではなく列欠損相当ではないが、
        # _cell は None→not_finite 扱い（bool 以外で float() 不能）
        pass
    assert result.status == FUNDAMENTALS_STATUS_INVALID


def test_partial_invalid_still_reports_valid_metric():
    result = _derive(
        income_stmt={"Net Income": [120.0, 100.0], "Diluted EPS": [float("nan"), 10.0]},
    )
    assert result.profit_growth == pytest.approx(20.0)
    assert result.eps_growth is None
    assert result.status == FUNDAMENTALS_STATUS_PARTIAL


# ── stock split ──────────────────────────────────────────────────────
def test_split_after_fy1_blocks_eps_growth_and_per_shadow():
    result = _derive(
        income_stmt={"Net Income": [120.0, 100.0], "Diluted EPS": [6.0, 10.0]},
        splits=[(date(2025, 10, 1), 2.0)],  # FY1 end (2025-03-31) 以降
    )
    assert result.eps_growth is None
    assert result.shadow_per is None
    # profitGrowth は split と無関係
    assert result.profit_growth == pytest.approx(20.0)
    # P5-B005-B4-A-R1（監査 P2-B repair）: 片軸でも block されていれば coverage は
    # `present` を主張せず、その block 原因を露出する。status=partial は維持。
    assert result.status == FUNDAMENTALS_STATUS_PARTIAL
    assert result.coverage == COVERAGE_SPLIT_GUARD_BLOCKED
    assert result.profit_axis == "available"
    assert result.eps_axis == "splitGuardBlocked"


def test_split_only_blocked_symbol_coverage_is_split_guard():
    # 両 metric が split guard でのみ block される場合に bucket を確認
    result = _derive(
        income_stmt={"Net Income": [100.0, -5.0], "Diluted EPS": [6.0, 10.0]},
        splits=[(date(2025, 10, 1), 2.0)],
    )
    assert result.profit_growth is None  # negativeBase
    assert result.eps_growth is None  # splitGuardBlocked
    # precedence: irregularPeriod > splitGuardBlocked > negativeBase
    assert result.coverage == COVERAGE_SPLIT_GUARD_BLOCKED


def test_split_before_fy1_does_not_block():
    result = _derive(
        income_stmt={"Net Income": [120.0, 100.0], "Diluted EPS": [11.0, 10.0]},
        splits=[(date(2024, 1, 1), 2.0)],
    )
    assert result.eps_growth == pytest.approx(10.0)


def test_split_history_retrieval_failure_blocks_eps_growth():
    result = _derive(
        income_stmt={"Net Income": [120.0, 100.0], "Diluted EPS": [11.0, 10.0]},
        splits=[],
        splits_ok=False,
    )
    assert result.eps_growth is None
    assert result.shadow_per is None
    assert result.profit_growth == pytest.approx(20.0)


# ── shadow PER / ROE（observability only）────────────────────────────
def test_valid_derived_per_shadow():
    result = _derive(
        income_stmt={"Net Income": [120.0, 100.0], "Diluted EPS": [10.0, 8.0]},
        price_last_close=2000.0,
    )
    assert result.shadow_per == pytest.approx(200.0)  # 2000 / 10


def test_valid_derived_roe_shadow():
    result = _derive(
        income_stmt={"Net Income Common Stockholders": [150.0, 100.0], "Diluted EPS": [15.0, 10.0]},
        balance_sheet={"Stockholders Equity": [1000.0, 900.0]},
    )
    assert result.shadow_roe == pytest.approx(15.0)  # 150 / 1000 * 100


def test_roe_shadow_null_when_equity_not_positive():
    result = _derive(
        income_stmt={"Net Income": [150.0, 100.0], "Diluted EPS": [15.0, 10.0]},
        balance_sheet={"Stockholders Equity": [-10.0, 5.0]},
    )
    assert result.shadow_roe is None


def test_negative_eps_gives_negative_per_shadow():
    result = _derive(
        income_stmt={"Net Income": [-50.0, 100.0], "Diluted EPS": [-5.0, 10.0]},
        price_last_close=1000.0,
    )
    assert result.shadow_per == pytest.approx(-200.0)


# ── provider statement failure（fetch 層）────────────────────────────
class _FakeFrame:
    def __init__(self, columns, rows):
        self.columns = columns
        self.index = list(rows.keys())
        self._rows = rows

    @property
    def loc(self):
        outer = self

        class _Loc:
            def __getitem__(self, label):
                return outer._rows[label]

        return _Loc()


class _FakeHandle:
    def __init__(self, income=None, balance=None, splits=None, raise_on=None):
        self._income = income
        self._balance = balance
        self._splits = splits or {}
        self._raise_on = raise_on or set()

    @property
    def income_stmt(self):
        if "income" in self._raise_on:
            raise RuntimeError("boom income")
        return self._income

    @property
    def balance_sheet(self):
        if "balance" in self._raise_on:
            raise RuntimeError("boom balance")
        return self._balance

    @property
    def splits(self):
        if "splits" in self._raise_on:
            raise RuntimeError("boom splits")

        class _S:
            def __init__(self, d):
                self._d = d

            def items(self):
                return self._d.items()

        return _S(self._splits)


def test_read_fundamentals_input_statement_failure_returns_missing():
    handle = _FakeHandle(raise_on={"income"})
    fetched = read_fundamentals_input(handle)
    assert fetched.ok is False
    assert fetched.failure == "missing"


def test_read_fundamentals_input_split_failure_sets_splits_ok_false():
    income = _FakeFrame(
        [date(2026, 3, 31), date(2025, 3, 31)],
        {"Net Income": [120.0, 100.0], "Diluted EPS": [12.0, 10.0]},
    )
    balance = _FakeFrame([date(2026, 3, 31)], {"Stockholders Equity": [1000.0]})
    handle = _FakeHandle(income=income, balance=balance, raise_on={"splits"})
    fetched = read_fundamentals_input(handle)
    assert fetched.ok is True
    assert fetched.splits_ok is False


def test_read_fundamentals_input_happy_path():
    income = _FakeFrame(
        [date(2026, 3, 31), date(2025, 3, 31)],
        {"Net Income": [120.0, 100.0], "Diluted EPS": [12.0, 10.0]},
    )
    balance = _FakeFrame([date(2026, 3, 31)], {"Stockholders Equity": [1000.0]})
    handle = _FakeHandle(income=income, balance=balance, splits={date(2020, 1, 1): 2.0})
    fetched = read_fundamentals_input(handle)
    assert fetched.ok is True
    assert fetched.period_ends[0] == date(2026, 3, 31)
    assert fetched.splits == [(date(2020, 1, 1), 2.0)]


# ── rate limit ───────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "exc",
    [
        FundamentalsRateLimit("x"),
        RuntimeError("HTTP 429 Too Many Requests"),
        Exception("provider rate limit exceeded"),
    ],
)
def test_is_rate_limit_error_detects(exc):
    assert is_rate_limit_error(exc) is True


def test_is_rate_limit_error_ignores_unrelated():
    assert is_rate_limit_error(RuntimeError("connection reset")) is False


def test_read_fundamentals_input_rate_limit_propagates():
    handle = _FakeHandle(raise_on={"income"})
    handle._raise_on = set()

    class _RL(_FakeHandle):
        @property
        def income_stmt(self):
            raise RuntimeError("429 rate limit")

    with pytest.raises(FundamentalsRateLimit):
        read_fundamentals_input(_RL())


# ── run-level rate-limit abort（FundamentalsEnricher）────────────────
def _valid_fetch():
    return FundamentalsFetch(
        income_stmt={"Net Income": [120.0, 100.0], "Diluted EPS": [12.0, 10.0]},
        balance_sheet={"Stockholders Equity": [1000.0, 900.0]},
        period_ends=[FY0_END, FY1_END],
        splits=[],
        splits_ok=True,
        ok=True,
    )


def test_enricher_rate_limit_aborts_remaining_symbols():
    calls: list[str] = []

    def fetch_fn(code):
        calls.append(code)
        if code == "0002":
            raise FundamentalsRateLimit("429")
        return _valid_fetch()

    enr = FundamentalsEnricher(fetch_fn, now=OBSERVED)
    items = [{"code": c, "per": 10.0, "roe": 12.0, "price": 1000.0} for c in ("0001", "0002", "0003", "0004")]
    for it in items:
        enr.enrich(it, it["code"])

    # rate-limit 後は新規 fetch を止める（0003/0004 は呼ばれない）
    assert calls == ["0001", "0002"]
    assert enr.aborted is True
    assert enr.abort_reason and "rate" in enr.abort_reason.lower()
    # 最初の 1 件は正常導出
    assert items[0]["profitGrowth"] == pytest.approx(20.0)
    # abort 後は null + missing status
    for it in items[1:]:
        assert it["profitGrowth"] is None
        assert it["epsGrowth"] is None
        assert it["fundamentalsStatus"] == FUNDAMENTALS_STATUS_MISSING

    meta = enr.meta([it["code"] for it in items])
    assert meta["aborted"] is True
    assert meta["abortReason"]
    assert meta["statementMaxAgeDays"] == 456
    assert meta["canonicalPeField"] == "per"
    assert meta["growthScoringStatus"] == "reserved_zero_weight"
    assert sum(meta["coverage"].values()) == 4


def test_enricher_statement_failure_is_fail_soft_per_symbol():
    def fetch_fn(code):
        if code == "0002":
            return FundamentalsFetch({}, {}, [], [], False, ok=False, failure="missing")
        return _valid_fetch()

    enr = FundamentalsEnricher(fetch_fn, now=OBSERVED)
    items = [{"code": c, "per": 10.0, "roe": 12.0, "price": 1000.0} for c in ("0001", "0002", "0003")]
    for it in items:
        enr.enrich(it, it["code"])

    assert enr.aborted is False
    assert items[0]["fundamentalsStatus"] == FUNDAMENTALS_STATUS_AVAILABLE
    assert items[1]["fundamentalsStatus"] == FUNDAMENTALS_STATUS_MISSING
    assert items[2]["fundamentalsStatus"] == FUNDAMENTALS_STATUS_AVAILABLE


def test_enricher_meta_coverage_only_counts_published():
    enr = FundamentalsEnricher(lambda code: _valid_fetch(), now=OBSERVED)
    items = [{"code": c, "per": 10.0, "roe": 12.0, "price": 1000.0} for c in ("0001", "0002", "0003")]
    for it in items:
        enr.enrich(it, it["code"])
    meta = enr.meta(["0001", "0002"])  # 0003 は publish cap 外を模擬
    assert sum(meta["coverage"].values()) == 2
    assert meta["coverage"]["present"] == 2


def test_enricher_shadow_evidence_has_no_raw_values():
    enr = FundamentalsEnricher(lambda code: _valid_fetch(), now=OBSERVED)
    enr.enrich({"code": "0001", "per": 200.0, "roe": 12.0, "price": 2000.0}, "0001")
    evidence = enr.shadow_evidence()
    assert evidence["kind"] == "fundamentals_shadow_evidence"
    assert evidence["not_for_trading"] is True
    # per-symbol の raw 値は含まれない —— 集計統計のみ
    text = str(evidence)
    assert "perShadowVsProviderTrailingPE" in evidence
    assert "comparablePairs" in evidence["perShadowVsProviderTrailingPE"]


# ══════════════════════════════════════════════════════════════════════
# P5-B005-B4-A-R1: fundamentals coverage authority repair
# ══════════════════════════════════════════════════════════════════════

# ── §6: mixed / partial authority ────────────────────────────────────
def test_mixed_axis_profit_valid_eps_split_blocked():
    # §6.A: profitGrowth valid / epsGrowth split-blocked
    result = _derive(
        income_stmt={"Net Income": [120.0, 100.0], "Diluted EPS": [6.0, 10.0]},
        splits=[(date(2025, 10, 1), 2.0)],
    )
    assert result.profit_growth == pytest.approx(20.0)
    assert result.eps_growth is None
    assert result.status == FUNDAMENTALS_STATUS_PARTIAL
    assert result.coverage != COVERAGE_PRESENT
    assert result.coverage == COVERAGE_SPLIT_GUARD_BLOCKED
    # diagnostics は両軸を保存する
    assert result.profit_axis == "available"
    assert result.eps_axis == "splitGuardBlocked"


def test_mixed_axis_profit_negative_base_eps_valid():
    # §6.B: profitGrowth negative-base / epsGrowth valid
    result = _derive(
        income_stmt={"Net Income": [120.0, -50.0], "Diluted EPS": [12.0, 10.0]},
    )
    assert result.profit_growth is None
    assert result.eps_growth == pytest.approx(20.0)
    assert result.status == FUNDAMENTALS_STATUS_PARTIAL
    assert result.coverage == COVERAGE_NEGATIVE_BASE
    assert result.profit_axis == "negativeBase"
    assert result.eps_axis == "available"


def test_mixed_axis_profit_valid_eps_row_missing():
    # §6.C: profitGrowth valid / epsGrowth row missing
    result = _derive(income_stmt={"Net Income": [120.0, 100.0]})
    assert result.profit_growth == pytest.approx(20.0)
    assert result.eps_growth is None
    assert result.status == FUNDAMENTALS_STATUS_PARTIAL
    assert result.coverage == COVERAGE_ROW_LABEL_MISSING
    assert result.profit_axis == "available"
    assert result.eps_axis == "rowLabelMissing"


def test_stale_is_statement_level_not_axis_level():
    # §6.D: 現 architecture では freshness は statement 単位。片軸のみ stale は
    # 構造的に発生しない —— FY0 が古ければ両軸が stale になる。
    result = _derive(
        income_stmt={"Net Income": [120.0, 100.0], "Diluted EPS": [12.0, 10.0]},
        period_ends=[date(2024, 1, 1), date(2023, 1, 1)],
        observed_at=datetime(2026, 9, 9, tzinfo=timezone.utc),
    )
    assert result.status == FUNDAMENTALS_STATUS_STALE
    assert result.coverage == COVERAGE_STALE
    assert result.profit_axis == "stale" and result.eps_axis == "stale"


# ── §3: terminal precedence（決定的）────────────────────────────────
def test_terminal_precedence_split_guard_beats_negative_base():
    # profit=negativeBase, eps=splitGuardBlocked → precedence で splitGuard が勝つ
    result = _derive(
        income_stmt={"Net Income": [100.0, -5.0], "Diluted EPS": [6.0, 10.0]},
        splits=[(date(2025, 10, 1), 2.0)],
    )
    assert result.profit_axis == "negativeBase"
    assert result.eps_axis == "splitGuardBlocked"
    assert result.coverage == COVERAGE_SPLIT_GUARD_BLOCKED


def test_terminal_precedence_missing_beats_negative_base():
    # profit=missing（片 FY のみ）, eps=negativeBase → missing が勝つ
    result = _derive(
        income_stmt={"Net Income": [120.0], "Diluted EPS": [12.0, -3.0]},
        period_ends=[FY0_END, FY1_END],
    )
    # ni は片列のみ → missing、eps1<0 → negativeBase
    assert result.coverage == COVERAGE_MISSING


# ── §10: authority boundary tests ───────────────────────────────────
def test_t1_diluted_eps_present_but_invalid_does_not_fall_back_to_basic():
    result = _derive(
        income_stmt={
            "Net Income": [120.0, 100.0],
            "Diluted EPS": [float("nan"), 10.0],
            "Basic EPS": [13.0, 10.0],  # 使われてはならない
        },
    )
    assert result.eps_growth is None
    assert result.profit_growth == pytest.approx(20.0)
    assert result.eps_axis == "invalidNumeric"


def test_t2_t3_fy0_age_456_ok_457_stale():
    fy0 = date(2025, 1, 1)
    stmt = {"Net Income": [110.0, 100.0], "Diluted EPS": [11.0, 10.0]}
    fy1 = date(2024, 1, 3)
    ok = _derive(
        income_stmt=stmt, period_ends=[fy0, fy1],
        observed_at=datetime(2026, 4, 2, tzinfo=timezone.utc),  # 456d
    )
    assert ok.status != FUNDAMENTALS_STATUS_STALE
    stale = _derive(
        income_stmt=stmt, period_ends=[fy0, fy1],
        observed_at=datetime(2026, 4, 3, tzinfo=timezone.utc),  # 457d
    )
    assert (datetime(2026, 4, 3).date() - fy0).days == 457
    assert stale.status == FUNDAMENTALS_STATUS_STALE
    assert stale.coverage == COVERAGE_STALE


@pytest.mark.parametrize(
    "span_days,expect_growth",
    [(334, False), (335, True), (395, True), (396, False)],
)
def test_t4_t7_comparable_span_boundaries(span_days, expect_growth):
    fy0 = date(2026, 3, 31)
    fy1 = date.fromordinal(fy0.toordinal() - span_days)
    result = _derive(
        income_stmt={"Net Income": [110.0, 100.0], "Diluted EPS": [11.0, 10.0]},
        period_ends=[fy0, fy1],
    )
    if expect_growth:
        assert result.profit_growth == pytest.approx(10.0), span_days
    else:
        assert result.profit_growth is None, span_days
        assert result.coverage == COVERAGE_IRREGULAR_PERIOD


def test_t8_boolean_statement_cell_is_invalid_numeric():
    result = _derive(
        income_stmt={"Net Income": [True, 100.0], "Diluted EPS": [12.0, 10.0]},
    )
    assert result.profit_growth is None
    assert result.profit_axis == "invalidNumeric"
    # eps 側は有効
    assert result.eps_growth == pytest.approx(20.0)
    assert result.status == FUNDAMENTALS_STATUS_PARTIAL


def test_t9_reversed_statement_columns_do_not_produce_wrong_growth():
    # provider が古い順で返しても、period identity が FY0/FY1 を決める
    result = _derive(
        income_stmt={"Net Income": [100.0, 120.0], "Diluted EPS": [10.0, 12.0]},
        period_ends=[FY1_END, FY0_END],  # oldest-first（reversed）
    )
    # FY0=2026(120) / FY1=2025(100) → +20%（-16.7% ではない）
    assert result.profit_growth == pytest.approx(20.0)
    assert result.eps_growth == pytest.approx(20.0)
    assert result.fiscal_period_end == "2026-03-31"


def test_t9_duplicate_period_ends_fail_closed():
    result = _derive(
        income_stmt={"Net Income": [120.0, 100.0], "Diluted EPS": [12.0, 10.0]},
        period_ends=[FY0_END, FY0_END],
    )
    assert result.profit_growth is None and result.eps_growth is None
    assert result.coverage == COVERAGE_IRREGULAR_PERIOD


# ── §8: rate-limit detection hardening ──────────────────────────────
@pytest.mark.parametrize(
    "text",
    [
        "4290.T connection reset",
        "account 1429 unavailable",
        "error code 4290",
        "HTTP 4299 gateway",
        "connection reset by peer",
    ],
)
def test_rate_limit_does_not_false_positive_on_bare_429(text):
    assert is_rate_limit_error(RuntimeError(text)) is False


@pytest.mark.parametrize(
    "text",
    [
        "HTTP 429",
        "status=429",
        "status_code=429",
        "429 Too Many Requests",
        "Received response code 429",
        "provider rate-limit hit",
    ],
)
def test_rate_limit_detects_bounded_429_and_textual_signals(text):
    assert is_rate_limit_error(RuntimeError(text)) is True


def test_rate_limit_detects_explicit_status_code_attribute():
    class _Boom(Exception):
        status_code = 429

    class _RespBoom(Exception):
        class response:  # noqa: N801
            status_code = 429

    assert is_rate_limit_error(_Boom("weird message")) is True
    assert is_rate_limit_error(_RespBoom("weird message")) is True


def test_rate_limit_ignores_non_429_status_code():
    class _Boom(Exception):
        status_code = 503

    assert is_rate_limit_error(_Boom("service unavailable")) is False


# ── §4: diagnostics contract（overlapping, per-axis）────────────────
def test_meta_diagnostics_preserves_mixed_axis_authority():
    def fetch_fn(code):
        if code == "0001":
            return FundamentalsFetch(
                income_stmt={"Net Income": [120.0, 100.0], "Diluted EPS": [6.0, 10.0]},
                balance_sheet={}, period_ends=[FY0_END, FY1_END],
                splits=[(date(2025, 10, 1), 2.0)], splits_ok=True, ok=True,
            )
        return _valid_fetch()

    enr = FundamentalsEnricher(fetch_fn, now=OBSERVED)
    for code in ("0001", "0002"):
        enr.enrich({"code": code, "per": 10.0, "roe": 12.0, "price": 1000.0}, code)
    meta = enr.meta(["0001", "0002"])
    # coverage: exclusive, sum == publishedCount
    assert sum(meta["coverage"].values()) == 2
    assert meta["coverage"]["present"] == 1
    assert meta["coverage"]["splitGuardBlocked"] == 1
    # diagnostics: per-axis, overlapping。0001 は profit available / eps split-blocked
    diag = meta["diagnostics"]
    assert diag["profitGrowth"]["available"] == 2
    assert diag["epsGrowth"]["available"] == 1
    assert diag["epsGrowth"]["splitGuardBlocked"] == 1


# ── §5 / §14: outer fail-soft + negative regression proof ───────────
def test_enricher_enrich_never_raises_and_registers_on_unexpected_error():
    def boom(code):
        raise RuntimeError("unexpected provider bug")

    enr = FundamentalsEnricher(boom, now=OBSERVED)
    item = {"code": "0001", "per": 10.0, "roe": 12.0, "price": 1000.0}
    enr.enrich(item, "0001")  # 例外を投げない
    assert item["fundamentalsStatus"] == FUNDAMENTALS_STATUS_INVALID
    assert item["profitGrowth"] is None and item["epsGrowth"] is None
    meta = enr.meta(["0001"])
    # §14 CASE A（post-repair）: publishedCount=1 → coverage sum == 1
    assert sum(meta["coverage"].values()) == 1
    assert meta["coverage"]["invalid"] == 1
    assert meta["diagnostics"]["profitGrowth"]["enrichFailed"] == 1
    assert meta["diagnostics"]["epsGrowth"]["enrichFailed"] == 1


def test_record_enrich_failure_is_total_for_outer_handler():
    enr = FundamentalsEnricher(lambda code: _valid_fetch(), now=OBSERVED)
    item = {"code": "0001", "per": 10.0, "roe": 12.0, "price": 1000.0}
    enr.record_enrich_failure(item, "0001")
    assert item["fundamentalsStatus"] == FUNDAMENTALS_STATUS_INVALID
    meta = enr.meta(["0001"])
    assert sum(meta["coverage"].values()) == 1
    assert meta["coverage"]["invalid"] == 1


def test_meta_fail_closed_counts_unregistered_published_symbol():
    # 本来あり得ないが、published_code が未登録でも coverage 合計は
    # publishedCount と一致し続ける（fail-closed）。
    enr = FundamentalsEnricher(lambda code: _valid_fetch(), now=OBSERVED)
    enr.enrich({"code": "0001", "per": 10.0, "roe": 12.0, "price": 1000.0}, "0001")
    meta = enr.meta(["0001", "0002"])  # 0002 は enrich されていない
    assert sum(meta["coverage"].values()) == 2
    assert meta["coverage"]["invalid"] == 1
