"""
P5-B004c-3: data/candidates_stocks_privacy_smoke.py の回帰テスト。

.github/workflows/full_batch.ymlのcandidates_stocks smoke（personal-data
guard）は旧実装がWARN-onlyでexit 0継続していた。data/へ抽出しfail-closed
（違反時exit 1）化したことを、以下の10観点で機械的に検証する:

  1. 正常candidate JSON → pass（violations空）
  2. forbidden key含有 → fail
  3. schemaVersion不正 → fail
  4. candidates非list → fail
  5. not_for_trading不正 → fail
  6. status不正 → fail
  7. data/public片方のみ不正 → fail（もう片方は正常でも検出）
  8. personal holdings/trust/cash/account系keyの個別検出
  9. production seed 41不変（実ファイルがguardを通過し続けること）
  10. JPX/pre-screen production未接続（default_universe_providerがseed_list_v1のまま）
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

from data.build_candidates_stocks import default_universe_provider
from data.candidates_stocks_privacy_smoke import (
    ALLOWED_STATUS,
    DEFAULT_PATHS,
    FORBIDDEN_KEYS,
    SCHEMA_VERSION,
    check_candidates_stocks_files,
    check_candidates_stocks_payload,
    main,
)

REPO_ROOT = Path(__file__).resolve().parents[1]


def _valid_payload(candidates=None):
    return {
        "schemaVersion": SCHEMA_VERSION,
        "candidates": candidates if candidates is not None else [
            {"code": "1234", "name": "Test Co", "sector": "情報通信"}
        ],
        "_meta": {"not_for_trading": True},
        "status": "ok",
    }


# --- 1. 正常candidate JSON → pass -------------------------------------------


def test_valid_payload_has_no_violations():
    assert check_candidates_stocks_payload(_valid_payload(), "p") == []


def test_valid_payload_empty_candidates_has_no_violations():
    payload = _valid_payload(candidates=[])
    payload["status"] = "empty"
    assert check_candidates_stocks_payload(payload, "p") == []


# --- 2. forbidden key含有 → fail ---------------------------------------------


@pytest.mark.parametrize("key", sorted(FORBIDDEN_KEYS))
def test_forbidden_key_detected(key):
    payload = _valid_payload(
        candidates=[{"code": "1234", "name": "Test Co", key: 1}]
    )
    violations = check_candidates_stocks_payload(payload, "p")
    assert violations, f"expected violation for forbidden key {key!r}"
    assert any(key in v for v in violations)


def test_multiple_forbidden_keys_all_reported_in_single_violation():
    payload = _valid_payload(
        candidates=[{"code": "1234", "name": "Test Co", "holdings": 1, "cash": 2}]
    )
    violations = check_candidates_stocks_payload(payload, "p")
    assert len(violations) == 1
    assert "holdings" in violations[0] and "cash" in violations[0]


# --- 3. schemaVersion不正 → fail ---------------------------------------------


@pytest.mark.parametrize("bad_version", ["candidates-stocks-2", "", None])
def test_invalid_schema_version_detected(bad_version):
    payload = _valid_payload()
    payload["schemaVersion"] = bad_version
    violations = check_candidates_stocks_payload(payload, "p")
    assert any("schemaVersion" in v for v in violations)


# --- 4. candidates非list → fail ----------------------------------------------


@pytest.mark.parametrize("bad_candidates", [None, {}, "not-a-list", 123])
def test_non_list_candidates_detected(bad_candidates):
    payload = _valid_payload()
    payload["candidates"] = bad_candidates
    violations = check_candidates_stocks_payload(payload, "p")
    assert any("candidates is not a list" in v for v in violations)


def test_non_dict_candidate_entry_detected():
    payload = _valid_payload(candidates=["not-a-dict"])
    violations = check_candidates_stocks_payload(payload, "p")
    assert any("candidate entry is not a dict" in v for v in violations)


# --- 5. not_for_trading不正 → fail -------------------------------------------


@pytest.mark.parametrize("bad_meta", [{}, {"not_for_trading": False}, {"not_for_trading": None}, {"not_for_trading": "true"}])
def test_invalid_not_for_trading_detected(bad_meta):
    payload = _valid_payload()
    payload["_meta"] = bad_meta
    violations = check_candidates_stocks_payload(payload, "p")
    assert any("not_for_trading" in v for v in violations)


# --- 6. status不正 → fail -----------------------------------------------------


@pytest.mark.parametrize("bad_status", ["buy", "sell", None, "", "OK"])
def test_invalid_status_detected(bad_status):
    payload = _valid_payload()
    payload["status"] = bad_status
    violations = check_candidates_stocks_payload(payload, "p")
    assert any("status" in v for v in violations)


def test_allowed_status_values_all_pass():
    for status in ALLOWED_STATUS:
        payload = _valid_payload()
        payload["status"] = status
        assert check_candidates_stocks_payload(payload, "p") == []


# --- top-level非dict payload -------------------------------------------------


@pytest.mark.parametrize("bad_payload", [None, [], "not-a-dict", 123])
def test_non_dict_payload_detected(bad_payload):
    violations = check_candidates_stocks_payload(bad_payload, "p")
    assert violations == ["p: payload is not a dict"]


# --- 7. data/public片方のみ不正 → fail ----------------------------------------


def test_only_public_file_broken_is_detected(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "data").mkdir()
    (tmp_path / "public" / "data").mkdir(parents=True)
    (tmp_path / "data" / "candidates_stocks.json").write_text(
        json.dumps(_valid_payload())
    )
    broken = _valid_payload()
    broken["schemaVersion"] = "wrong"
    (tmp_path / "public" / "data" / "candidates_stocks.json").write_text(
        json.dumps(broken)
    )

    violations = check_candidates_stocks_files()
    assert len(violations) == 1
    assert "public/data/candidates_stocks.json" in violations[0]
    assert "data/candidates_stocks.json" not in violations[0].replace(
        "public/data/candidates_stocks.json", ""
    )


def test_only_data_file_broken_is_detected(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "data").mkdir()
    (tmp_path / "public" / "data").mkdir(parents=True)
    broken = _valid_payload()
    broken["status"] = "invalid"
    (tmp_path / "data" / "candidates_stocks.json").write_text(json.dumps(broken))
    (tmp_path / "public" / "data" / "candidates_stocks.json").write_text(
        json.dumps(_valid_payload())
    )

    violations = check_candidates_stocks_files()
    assert len(violations) == 1
    assert violations[0].startswith("data/candidates_stocks.json")


def test_missing_file_is_detected(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "data").mkdir()
    (tmp_path / "public" / "data").mkdir(parents=True)
    (tmp_path / "data" / "candidates_stocks.json").write_text(
        json.dumps(_valid_payload())
    )
    # public/data/candidates_stocks.json を意図的に作らない

    violations = check_candidates_stocks_files()
    assert len(violations) == 1
    assert "public/data/candidates_stocks.json" in violations[0]
    assert "failed to read/parse" in violations[0]


# --- 8. personal holdings/trust/cash/account系keyの個別検出 ------------------


@pytest.mark.parametrize(
    "key", ["holdings", "cash", "account", "accountType", "reserve", "amount"]
)
def test_personal_asset_keys_individually_detected(key):
    payload = _valid_payload(candidates=[{"code": "1234", "name": "Test Co", key: 1}])
    violations = check_candidates_stocks_payload(payload, "p")
    assert any(key in v for v in violations)


# --- main()のexit code契約（fail-closed） ------------------------------------


def test_main_returns_zero_on_all_valid(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "data").mkdir()
    (tmp_path / "public" / "data").mkdir(parents=True)
    (tmp_path / "data" / "candidates_stocks.json").write_text(
        json.dumps(_valid_payload())
    )
    (tmp_path / "public" / "data" / "candidates_stocks.json").write_text(
        json.dumps(_valid_payload())
    )
    assert main() == 0


def test_main_returns_one_on_violation(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "data").mkdir()
    (tmp_path / "public" / "data").mkdir(parents=True)
    broken = _valid_payload(candidates=[{"code": "1234", "name": "x", "holdings": 1}])
    (tmp_path / "data" / "candidates_stocks.json").write_text(json.dumps(broken))
    (tmp_path / "public" / "data" / "candidates_stocks.json").write_text(
        json.dumps(_valid_payload())
    )
    assert main() == 1


def test_cli_invocation_exit_code_is_fail_closed(tmp_path):
    """`python3 -m data.candidates_stocks_privacy_smoke` 相当のCLI実行が、
    違反時に実際に非ゼロexit codeを返すことをsubprocessレベルで確認する
    （workflow stepがexit 1でjob failureになる契約そのものの検証）。"""
    data_dir = tmp_path / "data"
    public_dir = tmp_path / "public" / "data"
    data_dir.mkdir(parents=True)
    public_dir.mkdir(parents=True)
    broken = _valid_payload()
    broken["status"] = "invalid-status"
    (data_dir / "candidates_stocks.json").write_text(json.dumps(broken))
    (public_dir / "candidates_stocks.json").write_text(json.dumps(_valid_payload()))

    result = subprocess.run(
        [sys.executable, "-m", "data.candidates_stocks_privacy_smoke"],
        cwd=tmp_path,
        env={"PYTHONPATH": str(REPO_ROOT)},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1
    assert "FAIL candidates_stocks smoke" in result.stderr


def test_cli_invocation_exit_code_is_zero_on_success(tmp_path):
    data_dir = tmp_path / "data"
    public_dir = tmp_path / "public" / "data"
    data_dir.mkdir(parents=True)
    public_dir.mkdir(parents=True)
    (data_dir / "candidates_stocks.json").write_text(json.dumps(_valid_payload()))
    (public_dir / "candidates_stocks.json").write_text(json.dumps(_valid_payload()))

    result = subprocess.run(
        [sys.executable, "-m", "data.candidates_stocks_privacy_smoke"],
        cwd=tmp_path,
        env={"PYTHONPATH": str(REPO_ROOT)},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert "candidates_stocks smoke ok" in result.stdout


# --- 9. production seed 41不変（実ファイルがguardを通過し続けること） --------


def test_production_candidates_stocks_json_passes_guard():
    real_path = REPO_ROOT / "data" / "candidates_stocks.json"
    payload = json.loads(real_path.read_text())
    assert payload["_meta"]["universe"] == "seed_list_v1"
    assert len(payload["candidates"]) == 41
    violations = check_candidates_stocks_payload(payload, "data/candidates_stocks.json")
    assert violations == []


def test_production_public_candidates_stocks_json_passes_guard():
    real_path = REPO_ROOT / "public" / "data" / "candidates_stocks.json"
    payload = json.loads(real_path.read_text())
    assert len(payload["candidates"]) == 41
    violations = check_candidates_stocks_payload(
        payload, "public/data/candidates_stocks.json"
    )
    assert violations == []


def test_default_paths_match_production_layout():
    assert DEFAULT_PATHS == (
        "data/candidates_stocks.json",
        "public/data/candidates_stocks.json",
    )


# --- 10. JPX/pre-screen production未接続 -------------------------------------


def test_default_universe_provider_still_seed_list_v1():
    result = default_universe_provider()
    assert result.universe_id == "seed_list_v1"
    assert len(result.items) == 41
