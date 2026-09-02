"""HOLDING-EVIDENCE-2A: deterministic generator tests（network に触れない）。

pure transform を注入 surface から検証する。§36 の test matrix（F1..F25 / T1..T8 /
TIME1..4 / PUB1..4）と §24 の ticker-universe drift guard を含む。
"""
from __future__ import annotations

import ast
import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

import data.update_holding_evidence as gen
from data.holding_evidence_contract import (
    validate_holding_evidence_artifact,
)

UTC = timezone.utc
JST = timezone(timedelta(hours=9))
ROOT = Path(__file__).parents[1]
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "holding_evidence_parity_v1.json"

# 参照 NOW（HE-1 acceptance と同じ固定点）
REF_NOW = datetime(2026, 9, 1, 0, 0, 0, tzinfo=UTC)
OBSERVED_AT = REF_NOW - timedelta(days=1)          # 2026-08-31T00:00:00.000Z
GENERATED_AT = REF_NOW - timedelta(hours=1)        # 2026-08-31T23:00:00.000Z
NOW_JST = datetime(2026, 9, 1, 12, 0, 0, tzinfo=JST)


# ── surface helpers ──────────────────────────────────────────────────────
def _fundamentals(**over) -> gen.FundamentalsSurface:
    base = dict(
        income_stmt={
            "Net Income Common Stockholders": [300.0, 250.0],
            "Diluted EPS": [20.0, 16.0],
        },
        balance_sheet={
            "Stockholders Equity": [1500.0, 1400.0],
            "Total Debt": [600.0, 550.0],
        },
        cashflow={
            "Operating Cash Flow": [400.0, 380.0],
            "Free Cash Flow": [200.0, 190.0],
        },
        period_ends=[date(2026, 3, 31), date(2025, 3, 31)],
        info={"priceToBook": 1.5, "lastDividendValue": 6.0},
        splits=[],
        dividends=[(date(2025, 12, 1), 6.0), (date(2024, 12, 1), 5.0)],
        dividends_ok=True,
        observed_at=OBSERVED_AT,
    )
    base.update(over)
    return gen.FundamentalsSurface(**base)


def _rising_bars(count: int, *, last_volume_spike: bool = True, end: date = date(2026, 8, 31)):
    bars = []
    for i in range(count):
        bar_date = end - timedelta(days=(count - 1 - i))
        close = 100.0 + i * 0.5
        volume = 1000.0
        if last_volume_spike and i == count - 1:
            volume = 2000.0
        bars.append({"date": bar_date, "close": close, "volume": volume})
    return bars


def _technicals(count: int = 80, *, last_volume_spike: bool = True, **over) -> gen.TechnicalsSurface:
    base = dict(bars=_rising_bars(count, last_volume_spike=last_volume_spike), now_jst=NOW_JST)
    base.update(over)
    return gen.TechnicalsSurface(**base)


def _fund_group(code: str = "6098", *, fundamentals=None, price_last_close: float = 240.0):
    return gen.build_fundamentals_group(code, fundamentals or _fundamentals(), price_last_close)


def _field(group, key):
    return group["fields"][key]


# ═══════════════════════════════════════════════════════════════════════
# F1..F25 fundamentals
# ═══════════════════════════════════════════════════════════════════════
def test_f1_roe_normal():
    f = _fund_group()
    assert _field(f, "roe") == {"v": pytest.approx(20.0), "status": "present"}


def test_f2_negative_roe_present():
    fund = _fundamentals(income_stmt={"Net Income Common Stockholders": [-150.0, 250.0], "Diluted EPS": [20.0, 16.0]})
    f = _fund_group(fundamentals=fund)
    assert _field(f, "roe")["status"] == "present"
    assert _field(f, "roe")["v"] == pytest.approx(-10.0)


def test_f3_per_positive():
    f = _fund_group(price_last_close=240.0)
    assert _field(f, "per")["v"] == pytest.approx(12.0)
    assert _field(f, "per")["status"] == "present"


def test_f4_negative_per_present():
    fund = _fundamentals(income_stmt={"Net Income Common Stockholders": [300.0, 250.0], "Diluted EPS": [-5.0, 16.0]})
    f = _fund_group(fundamentals=fund, price_last_close=240.0)
    assert _field(f, "per")["status"] == "present"
    assert _field(f, "per")["v"] == pytest.approx(-48.0)


def test_f5_eps_zero_per_missing():
    fund = _fundamentals(income_stmt={"Net Income Common Stockholders": [300.0, 250.0], "Diluted EPS": [0.0, 16.0]})
    f = _fund_group(fundamentals=fund, price_last_close=240.0)
    assert _field(f, "per") == {"v": None, "status": "missing"}


def test_f6_pbr_valid():
    f = _fund_group()
    assert _field(f, "pbr") == {"v": pytest.approx(1.5), "status": "present"}


def test_f7_pbr_invalid_no_fallback():
    fund = _fundamentals(info={"priceToBook": None})
    f = _fund_group(fundamentals=fund)
    assert _field(f, "pbr") == {"v": None, "status": "missing"}
    fund_neg = _fundamentals(info={"priceToBook": -2.0})
    assert _field(_fund_group(fundamentals=fund_neg), "pbr")["status"] == "missing"


def test_f8_epsg_normal_growth():
    f = _fund_group()
    assert _field(f, "epsG")["v"] == pytest.approx(25.0)


def test_f9_positive_fy1_negative_fy0_large_negative_epsg_present():
    fund = _fundamentals(income_stmt={"Net Income Common Stockholders": [300.0, 250.0], "Diluted EPS": [-40.0, 10.0]})
    f = _fund_group(fundamentals=fund)
    assert _field(f, "epsG")["status"] == "present"
    assert _field(f, "epsG")["v"] == pytest.approx(-500.0)


def test_f10_fy1_nonpositive_epsg_missing():
    fund = _fundamentals(income_stmt={"Net Income Common Stockholders": [300.0, 250.0], "Diluted EPS": [20.0, -3.0]})
    assert _field(_fund_group(fundamentals=fund), "epsG") == {"v": None, "status": "missing"}


def test_f11_split_guard_makes_per_and_epsg_missing():
    fund = _fundamentals(splits=[(date(2025, 6, 1), 2.0)])  # FY1 end (2025-03-31) 以降
    f = _fund_group(fundamentals=fund, price_last_close=240.0)
    assert _field(f, "per")["status"] == "missing"
    assert _field(f, "epsG")["status"] == "missing"
    # roe は split guard の対象外
    assert _field(f, "roe")["status"] == "present"


def test_f12_cfok_true():
    assert _field(_fund_group(), "cfOk") == {"v": True, "status": "present"}


def test_f13_cfok_false_is_present():
    fund = _fundamentals(cashflow={"Operating Cash Flow": [-10.0, 380.0], "Free Cash Flow": [-50.0, 190.0]})
    assert _field(_fund_group(fundamentals=fund), "cfOk") == {"v": False, "status": "present"}


def test_f14_cfok_incomplete_source_missing():
    fund = _fundamentals(cashflow={"Operating Cash Flow": [400.0, 380.0]})  # FCF 行も CapEx 行も無い
    assert _field(_fund_group(fundamentals=fund), "cfOk") == {"v": None, "status": "missing"}


def test_f14b_cfok_fcf_derived_from_capex():
    fund = _fundamentals(cashflow={"Operating Cash Flow": [400.0, 380.0], "Capital Expenditure": [-100.0, -90.0]})
    assert _field(_fund_group(fundamentals=fund), "cfOk") == {"v": True, "status": "present"}


def test_f15_de_normal():
    assert _field(_fund_group(), "de")["v"] == pytest.approx(0.4)


def test_f16_de_missing_debt_not_zero():
    fund = _fundamentals(balance_sheet={"Stockholders Equity": [1500.0, 1400.0]})  # debt 行なし
    assert _field(_fund_group(fundamentals=fund), "de") == {"v": None, "status": "missing"}


def test_f16b_de_debt_fallback_rows():
    fund = _fundamentals(balance_sheet={
        "Stockholders Equity": [1000.0, 900.0],
        "Long Term Debt And Capital Lease Obligation": [300.0, 280.0],
        "Current Debt And Capital Lease Obligation": [100.0, 90.0],
    })
    assert _field(_fund_group(fundamentals=fund), "de")["v"] == pytest.approx(0.4)


def test_f17_equity_nonpositive_de_missing():
    fund = _fundamentals(balance_sheet={"Stockholders Equity": [-50.0, 1400.0], "Total Debt": [600.0, 550.0]})
    assert _field(_fund_group(fundamentals=fund), "de") == {"v": None, "status": "missing"}


def test_f18_8306_de_not_applicable():
    f = _fund_group("8306")
    assert _field(f, "de") == {"v": None, "status": "not_applicable"}


@pytest.mark.parametrize("code", ["8593", "4755"])
def test_f19_8593_4755_applicable(code):
    f = _fund_group(code)
    assert _field(f, "de")["status"] == "present"


def test_f20_divg_normal():
    assert _field(_fund_group(), "divG")["v"] == pytest.approx(20.0)


def test_f21_dividend_cut_to_zero_minus_100_present():
    fund = _fundamentals(dividends=[(date(2024, 12, 1), 5.0)])  # FY0 window に配当なし、FY1 window に 5.0
    f = _fund_group(fundamentals=fund)
    assert _field(f, "divG") == {"v": pytest.approx(-100.0), "status": "present"}


def test_f22_legit_non_dividend_payer_zero_present():
    fund = _fundamentals(dividends=[], info={"priceToBook": 1.5})
    f = _fund_group(fundamentals=fund)
    assert _field(f, "divG") == {"v": pytest.approx(0.0), "status": "present"}


def test_f23_empty_series_positive_lastdiv_missing():
    fund = _fundamentals(dividends=[], info={"priceToBook": 1.5, "lastDividendValue": 12.0})
    assert _field(_fund_group(fundamentals=fund), "divG") == {"v": None, "status": "missing"}


def test_f23b_divg_retrieval_failed_missing():
    fund = _fundamentals(dividends=[], dividends_ok=False)
    assert _field(_fund_group(fundamentals=fund), "divG") == {"v": None, "status": "missing"}


def test_f24_old_statement_all_seven_missing():
    stale = _fundamentals(period_ends=[date(2025, 1, 1), date(2024, 1, 1)])  # 2026-08-31 から 607 日
    f = _fund_group(fundamentals=stale)
    for key in gen.FUNDAMENTALS_FIELDS:
        assert _field(f, key)["status"] == "missing", key


def test_f24b_stale_8306_de_also_missing_not_not_applicable():
    stale = _fundamentals(period_ends=[date(2025, 1, 1), date(2024, 1, 1)])
    f = _fund_group("8306", fundamentals=stale)
    assert _field(f, "de")["status"] == "missing"


def test_f25_456_day_exact_boundary_deterministic():
    # observed 2026-08-31 → FY0 end = 2026-08-31 - 456d
    exact = date(2026, 8, 31) - timedelta(days=456)
    on_boundary = _fundamentals(period_ends=[exact, exact - timedelta(days=365)])
    assert _field(_fund_group(fundamentals=on_boundary), "roe")["status"] == "present"
    one_past = _fundamentals(period_ends=[exact - timedelta(days=1), exact - timedelta(days=366)])
    assert _field(_fund_group(fundamentals=one_past), "roe")["status"] == "missing"


def test_diluted_missing_cell_does_not_switch_to_basic():
    fund = _fundamentals(income_stmt={
        "Net Income Common Stockholders": [300.0, 250.0],
        "Diluted EPS": [20.0, None],  # FY1 セル欠損
        "Basic EPS": [21.0, 17.0],
    })
    f = _fund_group(fundamentals=fund)
    assert _field(f, "epsG")["status"] == "missing"  # Basic へ切替えない


# ═══════════════════════════════════════════════════════════════════════
# T1..T8 technicals
# ═══════════════════════════════════════════════════════════════════════
def _tech(count=80, **over):
    surface = _technicals(count, **over)
    cleaned = gen.clean_bars(surface.bars, surface.now_jst)
    return gen.build_technicals_group(cleaned, REF_NOW)


def test_t1_ma_definition():
    g = _tech(80)
    assert _field(g, "ma") == {"v": True, "status": "present"}
    # 下降系列では ma=false（present のまま）
    falling = [{"date": date(2026, 8, 31) - timedelta(days=79 - i), "close": 200.0 - i * 0.5, "volume": 1000.0} for i in range(80)]
    g2 = gen.build_technicals_group(gen.clean_bars(falling, NOW_JST), REF_NOW)
    assert _field(g2, "ma") == {"v": False, "status": "present"}


def test_t2_rsi_definition_and_flat_series_missing():
    g = _tech(80)
    assert _field(g, "rsi")["status"] == "present"
    flat = [{"date": date(2026, 8, 31) - timedelta(days=79 - i), "close": 100.0, "volume": 1000.0} for i in range(80)]
    g2 = gen.build_technicals_group(gen.clean_bars(flat, NOW_JST), REF_NOW)
    assert _field(g2, "rsi") == {"v": None, "status": "missing"}


def test_t3_macd_definition():
    g = _tech(80)
    assert _field(g, "macd") == {"v": True, "status": "present"}


def test_t4_volume_confirmation():
    assert _field(_tech(80, last_volume_spike=True), "vol") == {"v": True, "status": "present"}
    assert _field(_tech(80, last_volume_spike=False), "vol") == {"v": False, "status": "present"}


def test_t5_mom3m_63_session_calculation():
    g = _tech(80)
    # closes: 100 + i*0.5; t=139.5, t-63 = closes[16] = 108.0
    assert _field(g, "mom3m")["v"] == pytest.approx((139.5 / 108.0 - 1.0) * 100.0)


def test_t6_bars_74_technical_group_incomplete():
    g = _tech(74)
    assert g["bars"] == 74
    for key in gen.TECHNICALS_FIELDS:
        assert _field(g, key)["status"] == "missing", key


def test_t7_bars_75_eligible_technical_completeness():
    g = _tech(75)
    assert g["bars"] == 75
    for key in gen.TECHNICALS_FIELDS:
        assert _field(g, key)["status"] == "present", key


def test_t8_same_day_unfinished_tse_bar_removed():
    # 当日 (NOW_JST=2026-09-01) を含む 81 本、現在時刻 14:00 JST（15:30 前）
    now_before_close = datetime(2026, 9, 1, 14, 0, 0, tzinfo=JST)
    bars = _rising_bars(81, end=date(2026, 9, 1))
    cleaned = gen.clean_bars(bars, now_before_close)
    assert all(bar["date"] != date(2026, 9, 1) for bar in cleaned)
    assert len(cleaned) == 80
    # 15:30 以降なら当日バーは残る
    now_after_close = datetime(2026, 9, 1, 16, 0, 0, tzinfo=JST)
    cleaned_after = gen.clean_bars(bars, now_after_close)
    assert cleaned_after[-1]["date"] == date(2026, 9, 1)


def test_bars_honest_count_when_unusable_rows_dropped():
    bars = _rising_bars(80)
    bars[10]["close"] = float("nan")
    bars[20]["volume"] = None
    g = gen.build_technicals_group(gen.clean_bars(bars, NOW_JST), REF_NOW)
    assert g["bars"] == 78


# ═══════════════════════════════════════════════════════════════════════
# TIME1..4
# ═══════════════════════════════════════════════════════════════════════
_CANONICAL_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def test_time1_canonical_milliseconds_and_z():
    ts = gen.canonical_timestamp(datetime(2026, 8, 31, 6, 30, 0, 123456, tzinfo=UTC))
    assert ts == "2026-08-31T06:30:00.123Z"
    assert _CANONICAL_RE.match(ts)


def test_time2_no_six_digit_microsecond_timestamp():
    entry = gen.build_entry(gen.EntryInput("6098", _fundamentals(), _technicals(), REF_NOW))
    blob = json.dumps(entry)
    assert not re.search(r"\d{2}:\d{2}:\d{2}\.\d{6}", blob)
    assert "+00:00" not in blob


def test_time3_fundamentals_asof_is_observation_timestamp():
    g = _fund_group()
    assert g["asOf"] == gen.canonical_timestamp(OBSERVED_AT)


def test_time4_technicals_asof_is_completed_bar_close_timestamp():
    g = _tech(80)
    # 最終バー日 = 2026-08-31、15:30 JST = 06:30:00 UTC
    assert g["asOf"] == "2026-08-31T06:30:00.000Z"


def test_time3b_failed_fundamentals_use_attempt_timestamp():
    g = gen.empty_fundamentals_group(REF_NOW)
    assert g["asOf"] == gen.canonical_timestamp(REF_NOW)
    assert all(field["status"] == "missing" for field in g["fields"].values())


# ═══════════════════════════════════════════════════════════════════════
# PUB1..4 publication contract
# ═══════════════════════════════════════════════════════════════════════
def _eligible_input(code: str) -> gen.EntryInput:
    return gen.EntryInput(code, _fundamentals(), _technicals(80), REF_NOW)


def _ineligible_input(code: str) -> gen.EntryInput:
    return gen.EntryInput(code, None, None, REF_NOW)


def test_pub1_zero_eligible_no_replacement(tmp_path, monkeypatch):
    target = tmp_path / "holding_evidence.json"
    sentinel = '{"schemaVersion":"holding-evidence-1","preserved":true}\n'
    target.write_text(sentinel)
    monkeypatch.setattr(gen, "OUTPUT_PATH", target)
    monkeypatch.setattr(gen, "HOLDING_EVIDENCE_TICKERS", ["6098.T", "8306.T"])
    monkeypatch.setattr(gen, "fetch_fundamentals_surface", lambda ticker: None)
    monkeypatch.setattr(gen, "fetch_technicals_surface", lambda ticker: None)
    assert gen.main() is False
    assert target.read_text() == sentinel  # 既存 artifact 無傷


def test_pub2_one_eligible_ticker_permits_partial_fleet(tmp_path, monkeypatch):
    target = tmp_path / "holding_evidence.json"
    monkeypatch.setattr(gen, "OUTPUT_PATH", target)
    monkeypatch.setattr(gen, "HOLDING_EVIDENCE_TICKERS", ["6098.T", "8306.T", "9697.T"])

    def _fund(ticker):
        return _fundamentals() if ticker == "6098.T" else None

    def _tech_surface(ticker):
        return _technicals(80) if ticker == "6098.T" else None

    monkeypatch.setattr(gen, "fetch_fundamentals_surface", _fund)
    monkeypatch.setattr(gen, "fetch_technicals_surface", _tech_surface)
    assert gen.main() is True
    artifact = json.loads(target.read_text())
    assert len(artifact["entries"]) == 3  # 全 entry 出力
    assert [gen.is_eligible(e) for e in artifact["entries"]] == [True, False, False]


def test_pub3_atomic_write_does_not_damage_previous_on_validation_failure(tmp_path):
    target = tmp_path / "holding_evidence.json"
    good = '{"prev":"valid"}\n'
    target.write_text(good)
    # allow_nan=False により NaN 直列化は失敗 → os.replace 前に例外
    with pytest.raises(ValueError):
        gen.atomic_write_json(target, {"x": float("nan")})
    assert target.read_text() == good
    assert not list(tmp_path.glob(".holding_evidence.json.tmp*"))


def test_pub4_all_16_entries_emitted_in_successful_partial_fleet(tmp_path, monkeypatch):
    target = tmp_path / "holding_evidence.json"
    monkeypatch.setattr(gen, "OUTPUT_PATH", target)

    def _fund(ticker):
        return _fundamentals() if ticker in ("6098.T", "8058.T") else None

    def _tech_surface(ticker):
        return _technicals(80) if ticker in ("6098.T", "8058.T") else _technicals(40)

    monkeypatch.setattr(gen, "fetch_fundamentals_surface", _fund)
    monkeypatch.setattr(gen, "fetch_technicals_surface", _tech_surface)
    assert gen.main() is True
    artifact = json.loads(target.read_text())
    assert len(artifact["entries"]) == 16
    assert [e["code"] for e in artifact["entries"]] == [t[:-2] for t in gen.HOLDING_EVIDENCE_TICKERS]
    ok, errors = validate_holding_evidence_artifact(artifact)
    assert ok, errors


def test_generated_artifact_has_no_forbidden_tokens(tmp_path, monkeypatch):
    target = tmp_path / "holding_evidence.json"
    monkeypatch.setattr(gen, "OUTPUT_PATH", target)
    monkeypatch.setattr(gen, "HOLDING_EVIDENCE_TICKERS", ["6098.T"])
    monkeypatch.setattr(gen, "fetch_fundamentals_surface", lambda t: _fundamentals())
    monkeypatch.setattr(gen, "fetch_technicals_surface", lambda t: _technicals(80))
    assert gen.main() is True
    blob = target.read_text()
    for token in ("recommendedAction", "targetWeight", "orderQuantity", "officialDecision"):
        assert token not in blob


def test_retry_policy_two_attempts_then_none():
    calls = {"n": 0}

    def _always_fail():
        calls["n"] += 1
        raise RuntimeError("boom")

    assert gen._retry(_always_fail) is None
    assert calls["n"] == 2


def test_retry_policy_succeeds_on_second_attempt():
    calls = {"n": 0}

    def _flaky():
        calls["n"] += 1
        if calls["n"] < 2:
            raise RuntimeError("transient")
        return "ok"

    assert gen._retry(_flaky) == "ok"
    assert calls["n"] == 2


# ═══════════════════════════════════════════════════════════════════════
# S1..S5 split retrieval failure ≠ empty splits（P1 authority repair）
# ═══════════════════════════════════════════════════════════════════════
class _RaisingSplitsHandle:
    """handle.splits accessor を最初の `raises` 回だけ実際に raise させる fake。"""

    def __init__(self, raises: int, series):
        self._remaining = raises
        self._series = series

    @property
    def splits(self):
        if self._remaining > 0:
            self._remaining -= 1
            raise RuntimeError("splits endpoint unavailable")
        return self._series


class _Series:
    def __init__(self, pairs):
        self._pairs = pairs

    def items(self):
        return iter(self._pairs)


def test_s1_splits_ok_empty_series_normal_per_epsg():
    fund = _fundamentals(splits=[], splits_ok=True)
    f = _fund_group(fundamentals=fund, price_last_close=240.0)
    assert _field(f, "per")["status"] == "present"
    assert _field(f, "epsG")["status"] == "present"


def test_s2_splits_ok_relevant_split_per_epsg_missing():
    fund = _fundamentals(splits=[(date(2025, 6, 1), 2.0)], splits_ok=True)
    f = _fund_group(fundamentals=fund, price_last_close=240.0)
    assert _field(f, "per")["status"] == "missing"
    assert _field(f, "epsG")["status"] == "missing"
    assert _field(f, "roe")["status"] == "present"


def test_s3_splits_first_attempt_raises_second_empty_allows_per_epsg():
    handle = _RaisingSplitsHandle(raises=1, series=_Series([]))
    result = gen._retry(lambda: gen._collect_splits(handle))
    assert result == []  # 2 回目で成功（例外を握り潰していない）
    fund = _fundamentals(splits=result, splits_ok=result is not None)
    f = _fund_group(fundamentals=fund, price_last_close=240.0)
    assert _field(f, "per")["status"] == "present"
    assert _field(f, "epsG")["status"] == "present"


def test_s4_splits_both_attempts_raise_forces_per_epsg_missing_not_eligible():
    handle = _RaisingSplitsHandle(raises=2, series=_Series([]))
    result = gen._retry(lambda: gen._collect_splits(handle))
    assert result is None  # 両試行失敗 → unknown split history

    fund = _fundamentals(splits=[], splits_ok=False)
    entry = gen.build_entry(gen.EntryInput("6098", fund, _technicals(80), REF_NOW))
    fields = entry["fundamentals"]["fields"]
    assert fields["per"]["status"] == "missing"
    assert fields["epsG"]["status"] == "missing"
    # fundamentals group は per/epsG が required のため不完全 → fleet ineligible
    assert gen.is_eligible(entry) is False


def test_s5_failed_split_surface_does_not_mutate_unrelated_fields():
    fund = _fundamentals(splits=[], splits_ok=False)
    f = _fund_group(fundamentals=fund, price_last_close=240.0)
    assert _field(f, "roe") == {"v": pytest.approx(20.0), "status": "present"}
    assert _field(f, "pbr") == {"v": pytest.approx(1.5), "status": "present"}
    assert _field(f, "cfOk") == {"v": True, "status": "present"}
    assert _field(f, "de")["v"] == pytest.approx(0.4)
    assert _field(f, "divG")["v"] == pytest.approx(20.0)


def test_s_split_accessor_success_after_retry_parses_pairs():
    handle = _RaisingSplitsHandle(raises=1, series=_Series([(date(2025, 6, 1), 2.0)]))
    result = gen._retry(lambda: gen._collect_splits(handle))
    assert result == [(date(2025, 6, 1), 2.0)]


# ═══════════════════════════════════════════════════════════════════════
# D5 malformed de:not_applicable can never increase eligibility（P2）
# ═══════════════════════════════════════════════════════════════════════
def test_d5_unapproved_de_not_applicable_not_eligible():
    fund = _fundamentals()
    entry = gen.build_entry(gen.EntryInput("6098", fund, _technicals(80), REF_NOW))
    # 承認外コード 6098 の de を not_applicable へ改竄
    entry["fundamentals"]["fields"]["de"] = {"v": None, "status": "not_applicable"}
    assert gen.is_eligible(entry) is False
    # 承認済み 8306 は許容
    entry_bank = gen.build_entry(gen.EntryInput("8306", _fundamentals(), _technicals(80), REF_NOW))
    assert entry_bank["fundamentals"]["fields"]["de"]["status"] == "not_applicable"
    assert gen.is_eligible(entry_bank) is True


# ═══════════════════════════════════════════════════════════════════════
# VOL1..VOL3 zero current volume is authoritative false（P3）
# ═══════════════════════════════════════════════════════════════════════
def test_vol1_zero_current_volume_present_false():
    volumes = [1000.0] * 20 + [0.0]
    assert gen._volume_confirmation(volumes) is False


def test_vol1b_zero_current_volume_via_group_is_present_false():
    bars = _rising_bars(80)
    bars[-1]["volume"] = 0.0
    g = gen.build_technicals_group(gen.clean_bars(bars, NOW_JST), REF_NOW)
    assert _field(g, "vol") == {"v": False, "status": "present"}


def test_vol2_non_finite_current_volume_missing():
    volumes = [1000.0] * 20 + [float("nan")]
    assert gen._volume_confirmation(volumes) is None


def test_vol3_zero_baseline_mean_missing():
    volumes = [0.0] * 20 + [500.0]
    assert gen._volume_confirmation(volumes) is None


def test_vol_insufficient_observations_missing():
    assert gen._volume_confirmation([1000.0] * 20) is None


# ═══════════════════════════════════════════════════════════════════════
# A1..A5 atomic write temp-file cleanup（P3）
# ═══════════════════════════════════════════════════════════════════════
def _tmp_glob(tmp_path):
    return list(tmp_path.glob(".holding_evidence.json.tmp*"))


def test_a1_serialization_failure_no_temp_old_unchanged(tmp_path):
    target = tmp_path / "holding_evidence.json"
    good = '{"prev":"valid"}\n'
    target.write_text(good)
    with pytest.raises(ValueError):
        gen.atomic_write_json(target, {"x": float("nan")})
    assert target.read_text() == good
    assert not _tmp_glob(tmp_path)


def test_a2_write_failure_after_temp_creation_cleans_temp(tmp_path, monkeypatch):
    target = tmp_path / "holding_evidence.json"
    good = '{"prev":"valid"}\n'
    target.write_text(good)

    real_open = open

    class _FailingHandle:
        def __init__(self, path):
            self._fh = real_open(path, "w", encoding="utf-8")

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            self._fh.close()
            return False

        def write(self, _data):
            raise OSError("disk full")

        def flush(self):
            pass

        def fileno(self):
            return self._fh.fileno()

    def _fake_open(path, mode="r", **kwargs):
        assert "w" in mode
        return _FailingHandle(path)

    monkeypatch.setattr(gen, "open", _fake_open, raising=False)
    with pytest.raises(OSError):
        gen.atomic_write_json(target, {"ok": True})
    assert target.read_text() == good
    assert not _tmp_glob(tmp_path)


def test_a3_fsync_failure_old_unchanged_temp_cleaned(tmp_path, monkeypatch):
    target = tmp_path / "holding_evidence.json"
    good = '{"prev":"valid"}\n'
    target.write_text(good)
    monkeypatch.setattr(gen.os, "fsync", lambda fd: (_ for _ in ()).throw(OSError("fsync")))
    with pytest.raises(OSError):
        gen.atomic_write_json(target, {"ok": True})
    assert target.read_text() == good
    assert not _tmp_glob(tmp_path)


def test_a4_replace_failure_old_unchanged_temp_cleaned(tmp_path, monkeypatch):
    target = tmp_path / "holding_evidence.json"
    good = '{"prev":"valid"}\n'
    target.write_text(good)
    monkeypatch.setattr(gen.os, "replace", lambda src, dst: (_ for _ in ()).throw(OSError("replace")))
    with pytest.raises(OSError):
        gen.atomic_write_json(target, {"ok": True})
    assert target.read_text() == good
    assert not _tmp_glob(tmp_path)


def test_a5_success_replaces_atomically_no_temp(tmp_path):
    target = tmp_path / "holding_evidence.json"
    target.write_text('{"prev":"valid"}\n')
    gen.atomic_write_json(target, {"ok": True})
    assert json.loads(target.read_text()) == {"ok": True}
    assert not _tmp_glob(tmp_path)


# ═══════════════════════════════════════════════════════════════════════
# §24 ticker universe drift guard（AST 抽出・依存なし）
# ═══════════════════════════════════════════════════════════════════════
def _ast_static_tickers(relpath: str) -> list[str]:
    tree = ast.parse((ROOT / relpath).read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "TICKERS":
                    return [ast.literal_eval(element) for element in node.value.elts]
    raise AssertionError(f"static TICKERS not found in {relpath}")


def test_expected_current_16_symbols():
    assert gen.HOLDING_EVIDENCE_TICKERS == [
        "6098.T", "8306.T", "9697.T", "4661.T", "8593.T", "4755.T", "5711.T", "1605.T",
        "5016.T", "8058.T", "9418.T", "1928.T", "7011.T", "7974.T", "9433.T", "7012.T",
    ]


@pytest.mark.parametrize("relpath", ["data/update_returns.py", "data/update_correlation.py"])
def test_ticker_universe_matches_upstream_generators(relpath):
    assert _ast_static_tickers(relpath) == gen.HOLDING_EVIDENCE_TICKERS


def test_codes_are_repository_canonical():
    canonical = re.compile(r"^\d{3}[0-9A-HJ-NP-Z]$")
    for ticker in gen.HOLDING_EVIDENCE_TICKERS:
        assert canonical.match(ticker[:-2])


# ═══════════════════════════════════════════════════════════════════════
# §29 cross-language parity fixture（Python 側）
# ═══════════════════════════════════════════════════════════════════════
def parity_entry_inputs() -> list[gen.EntryInput]:
    """deterministic な 3 entry: A=完全 eligible / B=partial+insufficient / C=8306 de not_applicable。"""
    # A: 6098 — 全 fundamentals present + 全 technicals present
    a_fund = _fundamentals()
    a_tech = _technicals(80)

    # B: 9697 — roe 欠損（partial_fields）+ bars 70（insufficient_bars）
    b_fund = _fundamentals(income_stmt={"Diluted EPS": [20.0, 16.0]})  # NI 行なし → roe missing
    b_tech = _technicals(70)

    # C: 8306 — de not_applicable、他は present
    c_fund = _fundamentals(
        income_stmt={"Net Income Common Stockholders": [800.0, 700.0], "Diluted EPS": [90.0, 80.0]},
        balance_sheet={"Stockholders Equity": [10000.0, 9500.0], "Total Debt": [4000.0, 3800.0]},
        cashflow={"Operating Cash Flow": [5000.0, 4800.0], "Free Cash Flow": [3000.0, 2900.0]},
        info={"priceToBook": 0.8, "lastDividendValue": 30.0},
        dividends=[(date(2025, 12, 1), 30.0), (date(2024, 12, 1), 25.0)],
    )
    c_tech = _technicals(80)

    return [
        gen.EntryInput("6098", a_fund, a_tech, GENERATED_AT),
        gen.EntryInput("9697", b_fund, b_tech, GENERATED_AT),
        gen.EntryInput("8306", c_fund, c_tech, GENERATED_AT),
    ]


def build_parity_artifact() -> dict:
    return gen.build_artifact(parity_entry_inputs(), GENERATED_AT)


def test_parity_fixture_matches_pure_builder():
    expected = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    assert build_parity_artifact() == expected


def test_parity_fixture_passes_python_contract_validator():
    ok, errors = validate_holding_evidence_artifact(json.loads(FIXTURE_PATH.read_text(encoding="utf-8")))
    assert ok, errors


def test_parity_fixture_entry_shapes():
    artifact = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    a, b, c = artifact["entries"]
    assert gen.is_eligible(a) is True
    assert gen.is_eligible(b) is False
    assert gen.is_eligible(c) is True
    assert c["fundamentals"]["fields"]["de"] == {"v": None, "status": "not_applicable"}
    assert b["fundamentals"]["fields"]["roe"]["status"] == "missing"
    assert b["technicals"]["bars"] == 70


if __name__ == "__main__":
    # フィクスチャ再生成: python3 tests/test_update_holding_evidence.py --emit-fixture
    import sys

    if "--emit-fixture" in sys.argv:
        FIXTURE_PATH.write_text(
            json.dumps(build_parity_artifact(), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"wrote {FIXTURE_PATH}")
