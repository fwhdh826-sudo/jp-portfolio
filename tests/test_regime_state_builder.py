"""
P4-A9d-1a: live regime_state.json generator tests

確認項目:
  1. generator が data/regime_state.json / public/data/regime_state.json を作る
  2. _meta.kind が 'sample_contract' ではない
  3. _meta.not_for_trading が true ではない
  4. current_regime が既存 RegimeId のいずれか
  5. schemaVersion / generatedAt が存在する
  6. market_intel.json が無い場合も uncertain fallback で成功する
  7. public/data/contracts/v13.3/regime/regime_state.json をコピーしていない
  8. live 出力は is_fallback=True の場合も kind='live_regime_state'
  9. build_hmm_features が market_intel の値を正しく変換する
  10. build_fallback_output の schema 整合性
"""

from __future__ import annotations

import json
import math
import pathlib

import pytest

from data.update_regime_state import (
    SCHEMA_VERSION,
    VALID_REGIME_IDS,
    build_fallback_output,
    build_hmm_features,
    build_news_summary,
    build_regime_state,
    load_market_intel,
    main,
    write_outputs,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SAMPLE_CONTRACT_PATH = pathlib.Path(
    "public/data/contracts/v13.3/regime/regime_state.json"
)

_SAMPLE_INTEL: dict = {
    "fetched_at": "2026-06-11T15:00:00Z",
    "source": "yfinance_hybrid",
    "vix": 21.43,
    "nikkei_5d_return": -0.061736,
    "nikkei_60ma": 59227.0,
    "nikkei_200ma": 52678.0,
    "sp500_dd_30d": -0.044983,
    "usdjpy": 160.49,
    "risk_level": "medium",
    "narrative": {
        "headline": "リスクレベル: 中程度リスク",
        "body_lines": ["VIX 21.4 / 日経5日 -6.2%", "中程度リスク"],
        "sentiment_label": "neutral",
        "sentiment_score": 50.0,
        "method": "rule_based",
    },
    "sources_status": {"yfinance_n225": "ok"},
}


def _make_intel_file(tmp_path: pathlib.Path, data: dict) -> pathlib.Path:
    p = tmp_path / "market_intel.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    return p


# ---------------------------------------------------------------------------
# 1. Generator creates output files (tmp_path)
# ---------------------------------------------------------------------------

class TestGeneratorOutput:
    def test_creates_both_output_files(self, tmp_path):
        intel_path = _make_intel_file(tmp_path, _SAMPLE_INTEL)
        out1 = tmp_path / "regime_state_a.json"
        out2 = tmp_path / "regime_state_b.json"

        main(
            market_intel_paths=[intel_path],
            output_paths=[out1, out2],
        )

        assert out1.exists(), "data/regime_state.json が作成されていない"
        assert out2.exists(), "public/data/regime_state.json が作成されていない"

    def test_output_is_valid_json(self, tmp_path):
        intel_path = _make_intel_file(tmp_path, _SAMPLE_INTEL)
        out = tmp_path / "regime_state.json"
        main(market_intel_paths=[intel_path], output_paths=[out])
        data = json.loads(out.read_text())
        assert isinstance(data, dict)


# ---------------------------------------------------------------------------
# 2-3. _meta checks
# ---------------------------------------------------------------------------

class TestMetaFields:
    def _run(self, tmp_path, intel=None):
        intel_path = _make_intel_file(tmp_path, intel or _SAMPLE_INTEL)
        out = tmp_path / "regime_state.json"
        main(market_intel_paths=[intel_path], output_paths=[out])
        return json.loads(out.read_text())

    def test_kind_is_not_sample_contract(self, tmp_path):
        data = self._run(tmp_path)
        assert data["_meta"]["kind"] != "sample_contract"

    def test_kind_is_live_regime_state(self, tmp_path):
        data = self._run(tmp_path)
        assert data["_meta"]["kind"] == "live_regime_state"

    def test_not_for_trading_is_false(self, tmp_path):
        data = self._run(tmp_path)
        assert data["_meta"]["not_for_trading"] is False

    def test_schema_version_present(self, tmp_path):
        data = self._run(tmp_path)
        assert data["_meta"]["schemaVersion"] == SCHEMA_VERSION

    def test_generated_at_present(self, tmp_path):
        data = self._run(tmp_path)
        assert "generatedAt" in data["_meta"]
        assert isinstance(data["_meta"]["generatedAt"], str)
        assert len(data["_meta"]["generatedAt"]) > 10


# ---------------------------------------------------------------------------
# 4. current_regime is a valid RegimeId
# ---------------------------------------------------------------------------

class TestRegimeId:
    def test_current_regime_is_valid(self, tmp_path):
        intel_path = _make_intel_file(tmp_path, _SAMPLE_INTEL)
        out = tmp_path / "regime_state.json"
        main(market_intel_paths=[intel_path], output_paths=[out])
        data = json.loads(out.read_text())
        assert data["regime_state"]["current_regime"] in VALID_REGIME_IDS

    def test_all_valid_regime_ids_defined(self):
        expected = {"bull_calm", "bull_volatile", "bear", "crisis", "uncertain"}
        assert VALID_REGIME_IDS == expected


# ---------------------------------------------------------------------------
# 6. Fallback when market_intel.json not found
# ---------------------------------------------------------------------------

class TestFallback:
    def test_no_intel_produces_uncertain(self, tmp_path):
        out = tmp_path / "regime_state.json"
        main(
            market_intel_paths=[tmp_path / "nonexistent.json"],
            output_paths=[out],
        )
        data = json.loads(out.read_text())
        assert data["regime_state"]["current_regime"] == "uncertain"

    def test_fallback_kind_is_live_not_sample(self, tmp_path):
        out = tmp_path / "regime_state.json"
        main(
            market_intel_paths=[tmp_path / "nonexistent.json"],
            output_paths=[out],
        )
        data = json.loads(out.read_text())
        assert data["_meta"]["kind"] == "live_regime_state"
        assert data["_meta"]["kind"] != "sample_contract"

    def test_fallback_not_for_trading_false(self, tmp_path):
        out = tmp_path / "regime_state.json"
        main(
            market_intel_paths=[tmp_path / "nonexistent.json"],
            output_paths=[out],
        )
        data = json.loads(out.read_text())
        assert data["_meta"]["not_for_trading"] is False

    def test_fallback_has_schema_version(self, tmp_path):
        out = tmp_path / "regime_state.json"
        main(
            market_intel_paths=[tmp_path / "nonexistent.json"],
            output_paths=[out],
        )
        data = json.loads(out.read_text())
        assert data["_meta"]["schemaVersion"] == SCHEMA_VERSION

    def test_fallback_output_direct(self):
        out = build_fallback_output("2026-06-15T00:00:00+00:00", "test reason")
        assert out["regime_state"]["current_regime"] == "uncertain"
        assert out["_meta"]["kind"] == "live_regime_state"
        assert out["_meta"]["not_for_trading"] is False
        assert out["regime_state"]["is_fallback"] is True
        assert "fallback_reason" in out["_meta"]


# ---------------------------------------------------------------------------
# 7. Not copying sample contract
# ---------------------------------------------------------------------------

class TestNotSampleContract:
    def test_does_not_copy_sample_contract(self, tmp_path):
        if not SAMPLE_CONTRACT_PATH.exists():
            pytest.skip("sample contract not found")
        sample = json.loads(SAMPLE_CONTRACT_PATH.read_text())

        intel_path = _make_intel_file(tmp_path, _SAMPLE_INTEL)
        out = tmp_path / "regime_state.json"
        main(market_intel_paths=[intel_path], output_paths=[out])
        live = json.loads(out.read_text())

        # sample_contract は not_for_trading=True / kind='sample_contract'
        sample_meta = sample.get("_meta", {})
        assert sample_meta.get("kind") == "sample_contract"
        assert sample_meta.get("not_for_trading") is True

        # live 出力はどちらでもない
        live_meta = live.get("_meta", {})
        assert live_meta.get("kind") != "sample_contract"
        assert live_meta.get("not_for_trading") is not True

    def test_live_regime_state_has_generated_at(self, tmp_path):
        intel_path = _make_intel_file(tmp_path, _SAMPLE_INTEL)
        out = tmp_path / "regime_state.json"
        main(market_intel_paths=[intel_path], output_paths=[out])
        live = json.loads(out.read_text())
        # sample contract には generatedAt が無い
        assert "generatedAt" in live["_meta"]


# ---------------------------------------------------------------------------
# 9. build_hmm_features
# ---------------------------------------------------------------------------

class TestBuildHmmFeatures:
    def test_returns_5d_scaling(self):
        intel = {"nikkei_5d_return": 0.025, "vix": 20.0}
        f = build_hmm_features(intel)
        assert abs(f["returns_5d"] - 1.0) < 0.01, "2.5% return should map to z=1.0"

    def test_returns_5d_negative(self):
        intel = {"nikkei_5d_return": -0.05, "vix": 20.0}
        f = build_hmm_features(intel)
        assert f["returns_5d"] < 0

    def test_vix_log_baseline(self):
        intel = {"vix": 20.0, "nikkei_5d_return": 0.0}
        f = build_hmm_features(intel)
        assert abs(f["vix_log"] - 0.0) < 0.01, "VIX=20 should map to vix_log=0.0"

    def test_vix_log_high(self):
        intel = {"vix": 40.0, "nikkei_5d_return": 0.0}
        f = build_hmm_features(intel)
        expected = math.log(40.0 / 20.0) / 0.3
        assert abs(f["vix_log"] - round(expected, 4)) < 0.01

    def test_volume_z_zero(self):
        f = build_hmm_features({"vix": 20.0, "nikkei_5d_return": 0.0})
        assert f["volume_z"] == 0.0

    def test_spread_high_low_zero(self):
        f = build_hmm_features({"vix": 20.0, "nikkei_5d_return": 0.0})
        assert f["spread_high_low"] == 0.0

    def test_sentiment_neutral(self):
        intel = {
            "vix": 20.0,
            "nikkei_5d_return": 0.0,
            "narrative": {"sentiment_score": 50.0},
        }
        f = build_hmm_features(intel)
        assert abs(f["sentiment"] - 0.0) < 0.01

    def test_sentiment_positive(self):
        intel = {
            "vix": 20.0,
            "nikkei_5d_return": 0.0,
            "narrative": {"sentiment_score": 75.0},
        }
        f = build_hmm_features(intel)
        assert abs(f["sentiment"] - 1.0) < 0.01

    def test_sentiment_missing_narrative(self):
        intel = {"vix": 20.0, "nikkei_5d_return": 0.0}
        f = build_hmm_features(intel)
        assert f["sentiment"] == 0.0

    def test_returns_all_required_keys(self):
        f = build_hmm_features({"vix": 20.0, "nikkei_5d_return": 0.0})
        assert set(f.keys()) == {
            "returns_5d", "vix_log", "volume_z", "spread_high_low", "sentiment"
        }


# ---------------------------------------------------------------------------
# 10. build_fallback_output schema integrity
# ---------------------------------------------------------------------------

class TestFallbackOutputSchema:
    def _out(self):
        return build_fallback_output("2026-06-15T00:00:00+00:00", "test")

    def test_has_meta(self):
        assert "_meta" in self._out()

    def test_has_regime_state(self):
        assert "regime_state" in self._out()

    def test_regime_state_has_required_keys(self):
        rs = self._out()["regime_state"]
        required = {
            "timestamp", "current_regime", "consensus", "confidence",
            "is_crisis", "votes", "market_data_snapshot",
            "regime_changed_at", "previous_regime", "duration_hours",
        }
        assert required.issubset(rs.keys())

    def test_current_regime_is_uncertain(self):
        assert self._out()["regime_state"]["current_regime"] == "uncertain"

    def test_is_not_crisis(self):
        assert self._out()["regime_state"]["is_crisis"] is False


# ---------------------------------------------------------------------------
# load_market_intel
# ---------------------------------------------------------------------------

class TestLoadMarketIntel:
    def test_loads_from_first_path(self, tmp_path):
        p = tmp_path / "intel.json"
        p.write_text(json.dumps(_SAMPLE_INTEL), encoding="utf-8")
        data, source = load_market_intel([p])
        assert data is not None
        assert source == str(p)

    def test_fallback_to_second_path(self, tmp_path):
        p1 = tmp_path / "missing.json"
        p2 = tmp_path / "fallback.json"
        p2.write_text(json.dumps(_SAMPLE_INTEL), encoding="utf-8")
        data, source = load_market_intel([p1, p2])
        assert data is not None
        assert source == str(p2)

    def test_none_when_no_path_exists(self, tmp_path):
        data, source = load_market_intel([tmp_path / "nope.json"])
        assert data is None
        assert source == "not_found"


# ---------------------------------------------------------------------------
# build_news_summary
# ---------------------------------------------------------------------------

class TestBuildNewsSummary:
    def test_returns_body_lines_joined(self):
        intel = {"narrative": {"body_lines": ["line1", "line2"]}}
        assert build_news_summary(intel) == "line1 line2"

    def test_returns_empty_when_no_narrative(self):
        assert build_news_summary({}) == ""

    def test_returns_headline_when_no_body_lines(self):
        intel = {"narrative": {"headline": "test headline"}}
        assert build_news_summary(intel) == "test headline"
