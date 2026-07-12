"""
P4-A28: data/update_safe_mode.py tests

確認項目:
  1. main() が data/safe_mode.json と public/data/safe_mode.json を生成する
  2. 生成ファイルの _meta.kind が 'operation_snapshot'
  3. safe_mode.active は bool 型
  4. タイムスタンプが欠落している場合 → tier1_data_stale=True → active=True (fail-closed)
  5. market/regime/news のタイムスタンプが新鮮な場合 → active=False
  6. regime_state.json が current_regime=="crisis" の場合 → crisis_regime=True
  7. load_timestamps が各 JSON の正しいキーを読む
  8. load_crisis_regime がファイル不在時に False を返す
  9. _parse_dt が naive datetime を JST として扱う
  10. 出力ファイルが write_safe_mode_snapshot の契約 (_meta / safe_mode 構造) を満たす
"""
from __future__ import annotations

import json
import pathlib
from datetime import datetime, timedelta, timezone

import pytest

from data.update_safe_mode import (
    DEFAULT_DATA_DIRS,
    DEFAULT_OUTPUT_PATHS,
    load_crisis_regime,
    load_timestamps,
    main,
    _parse_dt,
)

_REPO = pathlib.Path(__file__).parents[1]


# ---------------------------------------------------------------------------
# _parse_dt
# ---------------------------------------------------------------------------

def test_parse_dt_none_returns_none():
    assert _parse_dt(None) is None


def test_parse_dt_empty_returns_none():
    assert _parse_dt("") is None


def test_parse_dt_iso_utc():
    dt = _parse_dt("2026-06-20T07:00:00+00:00")
    assert dt is not None
    assert dt.tzinfo is not None


def test_parse_dt_naive_assumed_jst():
    dt = _parse_dt("2026-06-20T09:00:00")
    assert dt is not None
    # JST = UTC+9 → offset should be +9 hours
    assert dt.utcoffset() == timedelta(hours=9)


def test_parse_dt_space_separator():
    dt = _parse_dt("2026-06-20 09:00:00")
    assert dt is not None


def test_parse_dt_invalid_returns_none():
    assert _parse_dt("not-a-date") is None


def test_parse_dt_utc_aware_market_format():
    # P4-A31-A: new market.last_updated format: "2026-06-20T21:30+00:00"
    dt = _parse_dt("2026-06-20T21:30+00:00")
    assert dt is not None
    assert dt.utcoffset() == timedelta(0)  # UTC


def test_parse_dt_utc_aware_treated_as_utc_not_jst():
    # UTC-aware timestamp must NOT have 9h added (distinct from naive)
    dt_utc = _parse_dt("2026-06-20T21:30+00:00")
    dt_naive = _parse_dt("2026-06-20T21:30:00")  # naive → assumed JST
    assert dt_utc is not None and dt_naive is not None
    # UTC-aware 21:30 UTC should be 9h LATER than naive 21:30 JST (=12:30 UTC)
    from datetime import timezone as tz
    assert dt_utc.astimezone(tz.utc) > dt_naive.astimezone(tz.utc)


# ---------------------------------------------------------------------------
# load_timestamps
# ---------------------------------------------------------------------------

def test_load_timestamps_missing_files_returns_all_none(tmp_path):
    ts = load_timestamps([tmp_path])
    assert ts == {"market": None, "regime": None, "news": None}


def test_load_timestamps_reads_correct_keys(tmp_path):
    now = datetime.now(timezone.utc).isoformat()
    (tmp_path / "market.json").write_text(json.dumps({"last_updated": now}))
    (tmp_path / "regime_state.json").write_text(
        json.dumps({"_meta": {"generatedAt": now}})
    )
    (tmp_path / "news.json").write_text(json.dumps({"updatedAt": now}))

    ts = load_timestamps([tmp_path])
    assert ts["market"] is not None
    assert ts["regime"] is not None
    assert ts["news"] is not None


def test_load_timestamps_fallback_to_second_dir(tmp_path):
    dir_a = tmp_path / "a"
    dir_b = tmp_path / "b"
    dir_a.mkdir()
    dir_b.mkdir()
    now = datetime.now(timezone.utc).isoformat()
    (dir_b / "market.json").write_text(json.dumps({"last_updated": now}))

    ts = load_timestamps([dir_a, dir_b])
    assert ts["market"] is not None


# ---------------------------------------------------------------------------
# load_crisis_regime
# ---------------------------------------------------------------------------

def test_load_crisis_regime_no_file(tmp_path):
    assert load_crisis_regime([tmp_path]) is False


def test_load_crisis_regime_normal_regime(tmp_path):
    (tmp_path / "regime_state.json").write_text(
        json.dumps({"regime_state": {"current_regime": "bull_calm"}})
    )
    assert load_crisis_regime([tmp_path]) is False


def test_load_crisis_regime_crisis(tmp_path):
    (tmp_path / "regime_state.json").write_text(
        json.dumps({"regime_state": {"current_regime": "crisis"}})
    )
    assert load_crisis_regime([tmp_path]) is True


def test_load_crisis_regime_malformed_returns_false(tmp_path):
    (tmp_path / "regime_state.json").write_text('{"broken": true}')
    assert load_crisis_regime([tmp_path]) is False


# ---------------------------------------------------------------------------
# main() — output contract
# ---------------------------------------------------------------------------

def test_main_writes_both_output_files(tmp_path):
    out_a = tmp_path / "data" / "safe_mode.json"
    out_b = tmp_path / "public" / "safe_mode.json"
    main(data_dirs=[], output_paths=[out_a, out_b])
    assert out_a.exists()
    assert out_b.exists()


def test_main_output_kind_operation_snapshot(tmp_path):
    out = tmp_path / "safe_mode.json"
    main(data_dirs=[], output_paths=[out])
    d = json.loads(out.read_text())
    assert d["_meta"]["kind"] == "operation_snapshot"


def test_main_output_active_is_bool(tmp_path):
    out = tmp_path / "safe_mode.json"
    main(data_dirs=[], output_paths=[out])
    d = json.loads(out.read_text())
    assert isinstance(d["safe_mode"]["active"], bool)


def test_main_no_timestamps_fail_closed(tmp_path):
    # 全タイムスタンプ欠落 → tier1_data_stale → active=True
    out = tmp_path / "safe_mode.json"
    main(data_dirs=[], output_paths=[out])
    d = json.loads(out.read_text())
    assert d["safe_mode"]["active"] is True
    assert d["safe_mode"]["trigger_conditions"]["tier1_data_stale"] is True


def test_main_fresh_timestamps_active_false(tmp_path):
    # 新鮮なタイムスタンプ → tier1_data_stale=False → active=False (no crisis, no system_error)
    now = datetime.now(timezone.utc).isoformat()
    (tmp_path / "market.json").write_text(json.dumps({"last_updated": now}))
    (tmp_path / "regime_state.json").write_text(
        json.dumps({"_meta": {"generatedAt": now}, "regime_state": {"current_regime": "bull_calm"}})
    )
    (tmp_path / "news.json").write_text(json.dumps({"updatedAt": now}))

    out = tmp_path / "safe_mode.json"
    main(data_dirs=[tmp_path], output_paths=[out])
    d = json.loads(out.read_text())
    assert d["safe_mode"]["active"] is False


def test_main_crisis_regime_triggers_safe_mode(tmp_path):
    now = datetime.now(timezone.utc).isoformat()
    (tmp_path / "market.json").write_text(json.dumps({"last_updated": now}))
    (tmp_path / "regime_state.json").write_text(
        json.dumps({"_meta": {"generatedAt": now}, "regime_state": {"current_regime": "crisis"}})
    )
    (tmp_path / "news.json").write_text(json.dumps({"updatedAt": now}))

    out = tmp_path / "safe_mode.json"
    main(data_dirs=[tmp_path], output_paths=[out])
    d = json.loads(out.read_text())
    assert d["safe_mode"]["active"] is True
    assert d["safe_mode"]["trigger_conditions"]["crisis_regime"] is True


def test_main_output_has_restrictions_block(tmp_path):
    out = tmp_path / "safe_mode.json"
    main(data_dirs=[], output_paths=[out])
    d = json.loads(out.read_text())
    restrictions = d["safe_mode"]["restrictions"]
    assert "new_buys_frozen" in restrictions
    assert "rebalance_frozen" in restrictions
    assert "force_sell_active" in restrictions


def test_main_active_true_means_new_buys_frozen(tmp_path):
    out = tmp_path / "safe_mode.json"
    main(data_dirs=[], output_paths=[out])
    d = json.loads(out.read_text())
    if d["safe_mode"]["active"]:
        assert d["safe_mode"]["restrictions"]["new_buys_frozen"] is True


def test_main_not_for_trading_flag_set(tmp_path):
    out = tmp_path / "safe_mode.json"
    main(data_dirs=[], output_paths=[out])
    d = json.loads(out.read_text())
    assert d["_meta"]["not_for_trading"] is True
