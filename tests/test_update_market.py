"""Regression tests for strict and fail-soft market snapshot production."""

import json
import math

import pandas as pd
import pytest

from data import update_market as market


def _history(closes, *, with_volume=False):
    values = {"Close": list(closes)}
    if with_volume:
        values["Volume"] = [1_000_000] * len(values["Close"])
    return pd.DataFrame(values)


def _nikkei_history():
    closes = [
        38_000 + index * 3 + (8 if index % 2 else -8)
        for index in range(100)
    ]
    return _history(closes, with_volume=True)


def _install_tickers(monkeypatch, histories):
    class FakeTicker:
        def __init__(self, symbol):
            self.symbol = symbol

        def history(self, period):
            result = histories[self.symbol]
            if isinstance(result, Exception):
                raise result
            return result.copy()

    monkeypatch.setattr(market.yf, "Ticker", FakeTicker)


@pytest.mark.parametrize(
    ("closes", "field"),
    [
        ([100.0, math.nan], "price"),
        ([math.inf, 100.0], "prev"),
        ([-1e308, 1e308], "chg"),
        ([1e-308, 1.0], "chg_pct"),
    ],
)
def test_fetch_price_pack_rejects_non_finite_primary_values(
    monkeypatch, closes, field
):
    _install_tickers(monkeypatch, {"TEST": _history(closes)})

    with pytest.raises(ValueError, match=field):
        market.fetch_price_pack("TEST")


def test_futures_non_finite_candidate_falls_through_to_next_candidate(
    monkeypatch, tmp_path
):
    output_path = tmp_path / "market.json"
    histories = {
        "^N225": _nikkei_history(),
        "NIY=F": _history([39_000.0, math.nan]),
        "NKD=F": _history([39_100.0, 39_250.0]),
        "N225M.CME": AssertionError("third future must not be requested"),
        "^VIX": _history([17.25]),
    }
    _install_tickers(monkeypatch, histories)
    monkeypatch.setattr(market, "OUTPUT_PATH", output_path)

    assert market.main() is True

    output = json.loads(output_path.read_text())
    assert output["nikkeiFutures"] == 39_250
    assert output["nikkeiFuturesChg"] == 150
    assert output["nikkeiFuturesChgPct"] == 0.38


def test_all_futures_fail_preserves_nikkei_fallback(monkeypatch, tmp_path):
    output_path = tmp_path / "market.json"
    histories = {
        "^N225": _nikkei_history(),
        "NIY=F": _history([39_000.0, math.nan]),
        "NKD=F": _history([math.inf, 39_200.0]),
        "N225M.CME": _history([]),
        "^VIX": _history([18.0]),
    }
    _install_tickers(monkeypatch, histories)
    monkeypatch.setattr(market, "OUTPUT_PATH", output_path)

    assert market.main() is True

    output = json.loads(output_path.read_text())
    assert output["nikkeiFutures"] == output["nikkei"]
    assert output["nikkeiFuturesChg"] == output["nikkeiChg"]
    assert output["nikkeiFuturesChgPct"] == output["nikkeiChgPct"]


def test_vix_non_finite_value_uses_existing_fallback(monkeypatch, tmp_path):
    output_path = tmp_path / "market.json"
    histories = {
        "^N225": _nikkei_history(),
        "NIY=F": _history([39_100.0, 39_250.0]),
        "NKD=F": AssertionError("second future must not be requested"),
        "N225M.CME": AssertionError("third future must not be requested"),
        "^VIX": _history([math.nan]),
    }
    _install_tickers(monkeypatch, histories)
    monkeypatch.setattr(market, "OUTPUT_PATH", output_path)

    assert market.main() is True

    output = json.loads(output_path.read_text())
    assert output["vix"] == 20.0


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_strict_serialization_rejects_non_finite_values(tmp_path, value):
    output_path = tmp_path / "market.json"

    with pytest.raises(ValueError, match="Out of range float values"):
        market.write_market_json({"nested": {"value": value}}, output_path)

    assert not output_path.exists()
    assert list(tmp_path.glob(".market.json.*.tmp")) == []


def test_serialization_failure_preserves_existing_file_bytes(tmp_path):
    output_path = tmp_path / "market.json"
    original = b'{"last_known_good":true}\n'
    output_path.write_bytes(original)

    with pytest.raises(ValueError):
        market.write_market_json({"bad": math.nan}, output_path)

    assert output_path.read_bytes() == original


def test_write_failure_preserves_existing_file_bytes(monkeypatch, tmp_path):
    output_path = tmp_path / "market.json"
    original = b'{"last_known_good":true}\n'
    output_path.write_bytes(original)

    def fail_fsync(_file_descriptor):
        raise OSError("simulated write durability failure")

    monkeypatch.setattr(market.os, "fsync", fail_fsync)

    with pytest.raises(OSError, match="simulated write durability failure"):
        market.write_market_json({"valid": True}, output_path)

    assert output_path.read_bytes() == original
    assert list(tmp_path.glob(".market.json.*.tmp")) == []


def test_successful_write_uses_sibling_temp_and_atomic_replace(
    monkeypatch, tmp_path
):
    output_path = tmp_path / "market.json"
    output_path.write_text('{"version":"old"}\n')
    real_replace = market.os.replace
    replace_call = {}

    def recording_replace(source, destination):
        replace_call["source"] = source
        replace_call["destination"] = destination
        real_replace(source, destination)

    monkeypatch.setattr(market.os, "replace", recording_replace)

    market.write_market_json({"version": "new", "price": 1.5}, output_path)

    assert replace_call["source"].parent == output_path.parent
    assert replace_call["source"] != output_path
    assert replace_call["destination"] == output_path
    assert json.loads(output_path.read_text()) == {"version": "new", "price": 1.5}
    assert list(tmp_path.glob(".market.json.*.tmp")) == []
