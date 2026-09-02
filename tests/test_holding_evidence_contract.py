"""HOLDING-EVIDENCE-2A: data/holding_evidence_contract.py の Python 契約 validator テスト。

TS strict parser（src/domain/analysis/holdingEvidence.ts / src/utils/strictTimestamp.ts）
との構造 parity と negative cases を検証する。
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from data.holding_evidence_contract import (
    is_canonical_timestamp,
    is_strict_timestamp,
    validate_holding_evidence_artifact,
)

ROOT = Path(__file__).parents[1]
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "holding_evidence_parity_v1.json"


@pytest.fixture()
def artifact() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


# ── happy path ───────────────────────────────────────────────────────────
def test_valid_fixture_accepted(artifact):
    ok, errors = validate_holding_evidence_artifact(artifact)
    assert ok, errors


def test_validator_never_throws_on_hostile_input():
    class Boom:
        def __getitem__(self, _):
            raise RuntimeError("nope")

    ok, errors = validate_holding_evidence_artifact(Boom())
    assert ok is False
    assert errors


# ── strict timestamp parity ──────────────────────────────────────────────
@pytest.mark.parametrize(
    "value",
    [
        "2026-08-31T23:00:00.000Z",
        "2026-08-31T23:00:00.5Z",
        "2026-08-31T23:00:00Z",
        "2026-08-31T23:00:00+09:00",
    ],
)
def test_strict_timestamp_accepts(value):
    assert is_strict_timestamp(value)


@pytest.mark.parametrize(
    "value",
    [
        "2026-08-31T23:00:00.123456Z",  # 6 桁マイクロ秒
        "2026-02-30T00:00:00.000Z",     # 不可能な暦日
        "2026-13-01T00:00:00.000Z",     # 月域外
        "2026-08-31 23:00:00.000Z",     # 空白セパレータ
        "2026-08-31T23:00:00.000",      # tz 無し
        "2026-08-31",                   # date-only は authoritative たり得ない
        "not-a-timestamp",
        "",
        None,
        123,
    ],
)
def test_strict_timestamp_rejects(value):
    assert not is_strict_timestamp(value)


def test_canonical_timestamp_is_stricter_than_strict():
    assert is_canonical_timestamp("2026-08-31T23:00:00.000Z")
    assert not is_canonical_timestamp("2026-08-31T23:00:00Z")
    assert not is_canonical_timestamp("2026-08-31T23:00:00+09:00")


# ── negative structural cases（cross-language parity, §29）────────────────
def _reject(artifact, message_fragment=None):
    ok, errors = validate_holding_evidence_artifact(artifact)
    assert ok is False
    if message_fragment:
        assert any(message_fragment in error for error in errors), errors


def test_reject_wrong_schema_version(artifact):
    artifact["schemaVersion"] = "holding-evidence-2"
    _reject(artifact, "schemaVersion")


def test_reject_not_for_trading_false(artifact):
    artifact["not_for_trading"] = False
    _reject(artifact, "not_for_trading")


def test_reject_missing_meta_generated_at(artifact):
    artifact["_meta"]["generatedAt"] = "2026-08-31T23:00:00.123456Z"
    _reject(artifact, "generatedAt")


def test_reject_noncanonical_group_timestamp(artifact):
    artifact["entries"][0]["fundamentals"]["asOf"] = "2026-08-31 00:00:00Z"
    _reject(artifact, "asOf")


def test_reject_missing_status_with_non_null_v(artifact):
    artifact["entries"][0]["fundamentals"]["fields"]["roe"] = {"v": 12.0, "status": "missing"}
    _reject(artifact, "requires v is null")


def test_reject_not_applicable_status_with_non_null_v(artifact):
    artifact["entries"][2]["fundamentals"]["fields"]["de"] = {"v": 1.5, "status": "not_applicable"}
    _reject(artifact, "requires v is null")


def test_reject_not_applicable_on_non_de_field(artifact):
    artifact["entries"][0]["fundamentals"]["fields"]["roe"] = {"v": None, "status": "not_applicable"}
    _reject(artifact, "not_applicable is only legal")


def test_reject_not_applicable_on_technicals(artifact):
    artifact["entries"][0]["technicals"]["fields"]["ma"] = {"v": None, "status": "not_applicable"}
    _reject(artifact)


def test_reject_invalid_code(artifact):
    artifact["entries"][0]["code"] = "60980"
    _reject(artifact, "canonical JP stock code")


def test_reject_ticker_code_mismatch(artifact):
    artifact["entries"][0]["ticker"] = "9999.T"
    _reject(artifact, "code + '.T'")


def test_reject_non_tse_market(artifact):
    artifact["entries"][0]["market"] = "NYSE"
    _reject(artifact, "market")


def test_reject_fractional_bars(artifact):
    artifact["entries"][0]["technicals"]["bars"] = 74.5
    _reject(artifact, "bars")


def test_reject_boolean_bars(artifact):
    artifact["entries"][0]["technicals"]["bars"] = True
    _reject(artifact, "bars")


def test_reject_negative_bars(artifact):
    artifact["entries"][0]["technicals"]["bars"] = -1
    _reject(artifact, "bars")


def test_reject_numeric_field_with_boolean_value(artifact):
    artifact["entries"][0]["fundamentals"]["fields"]["roe"] = {"v": True, "status": "present"}
    _reject(artifact, "finite number")


def test_reject_boolean_field_with_numeric_value(artifact):
    artifact["entries"][0]["fundamentals"]["fields"]["cfOk"] = {"v": 1, "status": "present"}
    _reject(artifact, "requires v is bool")


def test_reject_non_finite_numeric_value(artifact):
    artifact["entries"][0]["fundamentals"]["fields"]["roe"] = {"v": float("inf"), "status": "present"}
    _reject(artifact, "finite number")


def test_reject_extra_field_key(artifact):
    artifact["entries"][0]["fundamentals"]["fields"]["extra"] = {"v": 1.0, "status": "present"}
    _reject(artifact, "fields keys must be exactly")


def test_reject_missing_field_key(artifact):
    del artifact["entries"][0]["technicals"]["fields"]["mom3m"]
    _reject(artifact, "fields keys must be exactly")


def test_reject_field_extra_object_key(artifact):
    artifact["entries"][0]["fundamentals"]["fields"]["roe"] = {"v": 1.0, "status": "present", "why": "x"}
    _reject(artifact, "field keys must be exactly")


def test_reject_entries_not_a_list(artifact):
    artifact["entries"] = {"0": "nope"}
    _reject(artifact, "entries")


# ── forbidden trading-decision output（§28 / §33-3）──────────────────────
@pytest.mark.parametrize(
    "mutate",
    [
        lambda a: a["entries"][0].__setitem__("recommendedAction", "BUY"),
        lambda a: a["_meta"].__setitem__("officialDecision", "HOLD"),
        lambda a: a["entries"][0]["fundamentals"].__setitem__("targetWeight", 0.1),
        lambda a: a["entries"][0].__setitem__("orderQuantity", 100),
        lambda a: a["entries"][0].__setitem__("rebalanceAmount", 5000),
    ],
)
def test_reject_forbidden_keys(artifact, mutate):
    mutate(artifact)
    _reject(artifact, "forbidden trading-decision")


def test_reject_forbidden_token_in_string_value(artifact):
    artifact["entries"][0]["fundamentals"]["source"] = "yfinance / SELL now"
    _reject(artifact, "forbidden trading-decision token")


# ── validator を通しても実 artifact は byte 安定 ─────────────────────────
def test_validation_is_pure(artifact):
    before = copy.deepcopy(artifact)
    validate_holding_evidence_artifact(artifact)
    assert artifact == before
