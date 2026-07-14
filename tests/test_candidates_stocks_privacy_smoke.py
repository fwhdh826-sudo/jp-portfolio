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
from datetime import datetime, timezone
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
    check_production_candidates_stocks_payload,
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


def _valid_production_payload(
    path="normal",
    updated_at="2026-07-14T12:00:01+00:00",
    run_token="test-run-token-123",
):
    count = 41 if path == "seed_fallback" else 200
    universe = "seed_list_v1" if path == "seed_fallback" else "jpx_cheap_prescreen_v1"
    candidates = [
        {
            "code": str(1000 + i), "name": f"Test {i}", "sector": f"sector{i % 5}",
            "price": 1000.0, "per": 12.0, "pbr": 1.2, "roe": 11.0,
            "dividendYield": 2.0, "sigma252d": 0.2, "mom3m": 1.5,
            "dataStatus": "ok", "screenReasons": [],
        }
        for i in range(count)
    ]
    fallback = path != "normal"
    bypass = path == "seed_fallback"
    return {
        "schemaVersion": SCHEMA_VERSION,
        "updatedAt": updated_at,
        "sourceUpdatedAt": updated_at,
        "staleThresholdHours": 48,
        "candidates": candidates,
        "missing": [],
        "status": "ok",
        "_meta": {
            "kind": "candidates_stocks",
            "source": "data/build_candidates_stocks.py + yfinance",
            "not_for_trading": True,
            "universe": universe,
            "note": "market public information only",
            "pipelineContract": "jpx_whole_market_candidates_v1",
            "pipelinePath": path,
            "runToken": run_token,
            "counts": {
                "universeCount": count,
                "publishedCount": count,
                "truncatedCount": 0,
                "failedTotalCount": 0,
            },
            "universeProvenance": {
                "pipelinePath": path,
                "jpxSource": "jpx_data_j_xls",
                "jpxFallbackUsed": fallback,
                "jpxEligibleCount": 41 if bypass else 1552,
                "shortlistId": "seed_list_v1_bypass" if bypass else "jpx_cheap_prescreen_v1",
                "shortlistCount": 0 if bypass else count,
                "shortlistSuccessRatio": 0.0 if bypass else 1.0,
                "shortlistFallbackUsed": fallback,
                "shortlistFallbackReason": "no valid cache" if fallback else None,
                "shortlistBypassSeedListV1": bypass,
                "sectorCapRelaxed": False,
                "sectorCapRelaxedCount": 0,
            },
        },
    }


def _set_enrichment_successes(payload, success_count):
    candidates = payload["candidates"]
    assert 0 <= success_count <= len(candidates)
    missing = []
    for index, candidate in enumerate(candidates):
        if index < success_count:
            candidate["dataStatus"] = "ok"
            candidate["price"] = 1000.0
        else:
            candidate["dataStatus"] = "partial"
            for key in (
                "price", "per", "pbr", "roe", "dividendYield", "sigma252d", "mom3m"
            ):
                candidate[key] = None
            missing.append(candidate["code"])
    payload["missing"] = missing
    payload["_meta"]["counts"]["failedTotalCount"] = len(missing)
    if success_count == 0:
        payload["status"] = "empty"
        payload["sourceUpdatedAt"] = None
    elif success_count == len(candidates):
        payload["status"] = "ok"
    else:
        payload["status"] = "partial"
    return payload


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


@pytest.mark.parametrize(
    "bad_meta",
    [None, "bad", {}, {"not_for_trading": False}, {"not_for_trading": None}, {"not_for_trading": "true"}],
)
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


# --- 9. production whole-market artifact contract ---------------------------


def test_production_candidates_stocks_json_passes_guard():
    real_path = REPO_ROOT / "data" / "candidates_stocks.json"
    payload = json.loads(real_path.read_text())
    violations = check_production_candidates_stocks_payload(
        payload, "data/candidates_stocks.json"
    )
    assert violations == []


def test_production_public_candidates_stocks_json_passes_guard():
    real_path = REPO_ROOT / "public" / "data" / "candidates_stocks.json"
    payload = json.loads(real_path.read_text())
    violations = check_production_candidates_stocks_payload(
        payload, "public/data/candidates_stocks.json"
    )
    assert violations == []


def test_default_paths_match_production_layout():
    assert DEFAULT_PATHS == (
        "data/candidates_stocks.json",
        "public/data/candidates_stocks.json",
    )


# --- 10. production contract / freshness / fallback path --------------------


@pytest.mark.parametrize("path", ["normal", "cache_fallback", "seed_fallback"])
def test_production_contract_accepts_all_three_explicit_paths(path):
    payload = _valid_production_payload(path)
    assert check_production_candidates_stocks_payload(payload, "p") == []


def test_production_contract_rejects_missing_pipeline_path():
    payload = _valid_production_payload()
    del payload["_meta"]["pipelinePath"]
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any("pipelinePath" in v for v in violations)


def test_production_contract_rejects_stale_artifact_for_current_run():
    payload = _valid_production_payload(updated_at="2026-07-14T11:59:59+00:00")
    violations = check_production_candidates_stocks_payload(
        payload, "p", run_started_at="2026-07-14T12:00:00+00:00"
    )
    assert any("current run" in v for v in violations)


def test_production_contract_rejects_seed_shape_labeled_normal():
    payload = _valid_production_payload("seed_fallback")
    payload["_meta"]["pipelinePath"] = "normal"
    payload["_meta"]["universeProvenance"]["pipelinePath"] = "normal"
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any("normal" in v for v in violations)


def test_production_file_gate_rejects_data_public_mismatch(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "data").mkdir()
    (tmp_path / "public" / "data").mkdir(parents=True)
    data_payload = _valid_production_payload()
    public_payload = _valid_production_payload()
    public_payload["candidates"][0]["code"] = "DIFFERENT"
    (tmp_path / "data" / "candidates_stocks.json").write_text(json.dumps(data_payload))
    (tmp_path / "public" / "data" / "candidates_stocks.json").write_text(
        json.dumps(public_payload)
    )
    violations = check_candidates_stocks_files(
        production=True, run_started_at="2026-07-14T12:00:00+00:00"
    )
    assert any("identical" in v for v in violations)


def test_default_universe_provider_remains_seed_fallback_only():
    result = default_universe_provider()
    assert result.universe_id == "seed_list_v1"
    assert len(result.items) == 41


# --- P5-B004e-2 A: enrichment quality contract ------------------------------


@pytest.mark.parametrize(
    ("success_count", "should_pass"),
    [(200, True), (180, True), (179, False), (1, False), (0, False)],
)
def test_production_enrichment_ratio_normal_boundary(success_count, should_pass):
    payload = _set_enrichment_successes(_valid_production_payload(), success_count)
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert (violations == []) is should_pass
    if not should_pass:
        assert any("enrichment success ratio" in v for v in violations)


@pytest.mark.parametrize(("success_count", "should_pass"), [(41, True), (37, True), (36, False), (0, False)])
def test_production_enrichment_ratio_seed_boundary(success_count, should_pass):
    payload = _set_enrichment_successes(
        _valid_production_payload("seed_fallback"), success_count
    )
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert (violations == []) is should_pass


def test_enrichment_ratio_is_not_shortlist_success_ratio():
    payload = _set_enrichment_successes(_valid_production_payload(), 1)
    payload["_meta"]["universeProvenance"]["shortlistSuccessRatio"] = 1.0
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any("enrichment success ratio" in v for v in violations)


@pytest.mark.parametrize(("success_count", "should_pass"), [(180, True), (179, False)])
def test_production_enrichment_ratio_cache_fallback_boundary(success_count, should_pass):
    payload = _set_enrichment_successes(
        _valid_production_payload("cache_fallback"), success_count
    )
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert (violations == []) is should_pass


# --- P5-B004e-2 B: strict public allowlist/privacy contract -----------------


@pytest.mark.parametrize(
    ("location", "key", "value"),
    [
        ("root", "cash", 100),
        ("meta", "holdings", ["7203"]),
        ("provenance", "account", "taxable"),
        ("candidate", "portfolio", {}),
        ("candidate", "quantity", 10),
        ("candidate", "purchasePrice", 900),
        ("candidate", "marketValue", 10000),
        ("candidate", "broker", "private"),
        ("candidate", "nisa", True),
    ],
)
def test_strict_allowlist_rejects_unknown_keys_at_every_object_layer(location, key, value):
    payload = _valid_production_payload()
    target = {
        "root": payload,
        "meta": payload["_meta"],
        "provenance": payload["_meta"]["universeProvenance"],
        "candidate": payload["candidates"][0],
    }[location]
    target[key] = value
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any(key in v for v in violations)


def test_strict_allowlist_rejects_nested_private_account_and_amount():
    payload = _valid_production_payload()
    payload["candidates"][0]["private"] = {"account": "x", "amount": 100}
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any("private" in v for v in violations)


def test_strict_allowlist_rejects_nested_object_in_screen_reasons():
    payload = _valid_production_payload()
    payload["candidates"][0]["screenReasons"] = [{"csv": {"amount": 100}}]
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any("screenReasons" in v for v in violations)


def test_strict_allowlist_rejects_object_in_missing():
    payload = _valid_production_payload()
    payload["missing"] = [{"code": "1000", "account": "x"}]
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any("missing" in v for v in violations)


# --- P5-B004e-2 C: counts/status/missing/code consistency -------------------


def test_production_rejects_impossible_failed_total_count():
    payload = _valid_production_payload()
    payload["_meta"]["counts"]["failedTotalCount"] = 999999
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any("failedTotalCount" in v for v in violations)


def test_production_rejects_missing_code_not_in_partial_candidates():
    payload = _valid_production_payload()
    payload["missing"] = ["NOT_A_CANDIDATE"]
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any("missing" in v for v in violations)


def test_production_rejects_duplicate_candidate_code():
    payload = _valid_production_payload()
    payload["candidates"][1]["code"] = payload["candidates"][0]["code"]
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any("duplicate" in v for v in violations)


def test_production_rejects_status_ok_with_partial_candidate():
    payload = _set_enrichment_successes(_valid_production_payload(), 199)
    payload["status"] = "ok"
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any("status" in v for v in violations)


def test_production_rejects_status_partial_with_all_ok_candidates():
    payload = _valid_production_payload()
    payload["status"] = "partial"
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any("status" in v for v in violations)


def test_production_rejects_data_status_ok_without_any_market_data():
    payload = _valid_production_payload()
    for key in (
        "price", "per", "pbr", "roe", "dividendYield", "sigma252d", "mom3m"
    ):
        payload["candidates"][0][key] = None
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any("dataStatus ok" in v for v in violations)


def test_production_rejects_data_status_partial_with_market_data():
    payload = _set_enrichment_successes(_valid_production_payload(), 199)
    payload["candidates"][-1]["price"] = 1000.0
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any("dataStatus partial" in v for v in violations)


@pytest.mark.parametrize(
    ("count_key", "value"),
    [
        ("publishedCount", 199),
        ("universeCount", 199),
        ("truncatedCount", 1),
    ],
)
def test_production_rejects_internally_inconsistent_counts(count_key, value):
    payload = _valid_production_payload()
    payload["_meta"]["counts"][count_key] = value
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any(count_key in v or "count" in v for v in violations)


def test_production_accepts_builder_consistent_truncation_and_total_failures():
    payload = _valid_production_payload()
    payload["_meta"]["counts"].update(
        universeCount=250, truncatedCount=50, failedTotalCount=10
    )
    payload["_meta"]["universeProvenance"]["shortlistCount"] = 250
    assert check_production_candidates_stocks_payload(payload, "p") == []


# --- P5-B004e-2 D: provenance cross-field contract -------------------------


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("jpxEligibleCount", 0),
        ("shortlistCount", 0),
        ("shortlistId", "seed_list_v1_bypass"),
    ],
)
def test_normal_path_rejects_forged_provenance(key, value):
    payload = _valid_production_payload("normal")
    payload["_meta"]["universeProvenance"][key] = value
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any(key in v or "normal" in v or "shortlist" in v for v in violations)


def test_cache_fallback_rejects_all_fallback_flags_false():
    payload = _valid_production_payload("cache_fallback")
    provenance = payload["_meta"]["universeProvenance"]
    provenance["jpxFallbackUsed"] = False
    provenance["shortlistFallbackUsed"] = False
    provenance["shortlistFallbackReason"] = None
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any("cache_fallback" in v for v in violations)


def test_seed_fallback_rejects_shortlist_fallback_false():
    payload = _valid_production_payload("seed_fallback")
    provenance = payload["_meta"]["universeProvenance"]
    provenance["shortlistFallbackUsed"] = False
    provenance["shortlistFallbackReason"] = None
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any("seed_fallback" in v for v in violations)


def test_seed_fallback_rejects_impossible_non_bypass_shape():
    payload = _valid_production_payload("seed_fallback")
    payload["_meta"]["universeProvenance"]["shortlistBypassSeedListV1"] = False
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any("seed_fallback" in v for v in violations)


# --- P5-B004e-2 E: current-run token + timestamp auxiliary contract ---------


_RUN_START = "2026-07-14T12:00:00+00:00"
_CHECKED_AT = datetime(2026, 7, 14, 12, 1, tzinfo=timezone.utc)


def test_current_run_token_exact_match_passes():
    payload = _valid_production_payload(run_token="expected-token")
    assert check_production_candidates_stocks_payload(
        payload,
        "p",
        run_started_at=_RUN_START,
        expected_run_token="expected-token",
        checked_at=_CHECKED_AT,
    ) == []


def test_current_run_token_missing_fails():
    payload = _valid_production_payload()
    del payload["_meta"]["runToken"]
    violations = check_production_candidates_stocks_payload(
        payload, "p", expected_run_token="expected-token"
    )
    assert any("runToken" in v for v in violations)


def test_current_run_token_mismatch_fails():
    payload = _valid_production_payload(run_token="old-token")
    violations = check_production_candidates_stocks_payload(
        payload, "p", expected_run_token="expected-token"
    )
    assert any("runToken" in v for v in violations)


def test_future_timestamps_fail():
    payload = _valid_production_payload(updated_at="2026-07-14T12:01:01+00:00")
    violations = check_production_candidates_stocks_payload(
        payload, "p", checked_at=_CHECKED_AT
    )
    assert any("future" in v for v in violations)


def test_same_second_as_run_start_is_rejected():
    payload = _valid_production_payload(updated_at=_RUN_START)
    violations = check_production_candidates_stocks_payload(
        payload, "p", run_started_at=_RUN_START, checked_at=_CHECKED_AT
    )
    assert any("current run" in v for v in violations)


def test_naive_timestamps_are_rejected():
    payload = _valid_production_payload(updated_at="2026-07-14T12:00:01")
    violations = check_production_candidates_stocks_payload(payload, "p")
    assert any("timezone" in v for v in violations)
