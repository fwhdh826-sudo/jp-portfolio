from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json

import pytest

from backend.engine.operation import late_run_guard
from backend.engine.operation import mutation_admission as admission


UTC = timezone.utc


def utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def metadata(
    *,
    run_id: int = 100,
    run_attempt: int = 1,
    created_at: str = "2026-08-27T23:31:00Z",
    run_started_at: str = "2026-08-27T23:35:00Z",
) -> late_run_guard.RunMetadata:
    return late_run_guard.RunMetadata(
        run_id=run_id,
        run_attempt=run_attempt,
        event="schedule",
        workflow_id=50,
        created_at=utc(created_at),
        run_started_at=utc(run_started_at),
        path=".github/workflows/update-data.yml",
    )


def client_for(current: late_run_guard.RunMetadata):
    class FakeClient:
        calls = 0

        def __init__(self, *, api_url: str, repository: str, token: str) -> None:
            assert api_url == "https://api.github.test"
            assert repository == "example/jp-portfolio"
            assert token == "token"

        def get_run(self, run_id: int) -> late_run_guard.RunMetadata:
            type(self).calls += 1
            assert run_id == current.run_id
            return current

    return FakeClient


def scheduled_env(tmp_path, *, run_id: int = 100, run_attempt: int = 1):
    event = tmp_path / "event.json"
    event.write_text(json.dumps({"schedule": "30 23 * * *"}))
    return {
        "GITHUB_EVENT_NAME": "schedule",
        "GITHUB_RUN_ID": str(run_id),
        "GITHUB_RUN_ATTEMPT": str(run_attempt),
        "GITHUB_EVENT_PATH": str(event),
        "GITHUB_API_URL": "https://api.github.test",
        "GITHUB_REPOSITORY": "example/jp-portfolio",
        "GITHUB_TOKEN": "token",
        "RUNNER_TEMP": str(tmp_path),
    }


@pytest.mark.parametrize(
    ("now", "decision", "reason", "exit_code"),
    [
        (
            "2026-08-28T02:54:59Z",
            "RUN",
            "admitted_before_effective_deadline",
            0,
        ),
        ("2026-08-28T02:55:00Z", "SKIP", "mutation_deadline_exceeded", 78),
    ],
    ids=[
        "2026-08-28T02:54:59Z-RUN-before_effective_deadline-0",
        "2026-08-28T02:55:00Z-SKIP-at_or_after_effective_deadline-78",
    ],
)
def test_boundary_is_inclusive_at_deadline_minus_five_minutes(
    tmp_path, now, decision, reason, exit_code
):
    result = admission.run_from_environment(
        "update",
        "pre_fetch",
        env=scheduled_env(tmp_path),
        now=utc(now),
        client_factory=client_for(metadata()),
    )

    assert result.decision == decision
    assert result.reason == reason
    assert result.effective_deadline == utc("2026-08-28T02:55:00Z")
    assert (admission.EXIT_SKIP if decision == "SKIP" else admission.EXIT_RUN) == exit_code


def test_manual_dispatch_bypasses_deadline_and_api_but_keeps_lock_contract():
    class ForbiddenClient:
        def __init__(self, **kwargs):
            raise AssertionError("manual dispatch must not call the API")

    result = admission.run_from_environment(
        "full",
        "pre_publish",
        env={
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_RUN_ID": "321",
            "GITHUB_RUN_ATTEMPT": "4",
        },
        now=utc("2026-09-30T00:00:00Z"),
        client_factory=ForbiddenClient,
    )

    assert result.decision == "RUN"
    assert result.reason == "manual_dispatch_bypass"
    assert result.deadline is None
    assert result.effective_deadline is None
    assert result.as_dict()["lockGroup"] == admission.LOCK_GROUP


def test_rerun_uses_original_created_at_nominal_not_run_started_at(tmp_path):
    current = metadata(
        run_attempt=3,
        run_started_at="2026-09-30T00:00:00Z",
    )
    result = admission.run_from_environment(
        "update",
        "pre_fetch",
        env=scheduled_env(tmp_path, run_attempt=3),
        now=utc("2026-08-28T02:54:59Z"),
        client_factory=client_for(current),
    )

    assert result.run_attempt == 3
    assert result.scheduled_at == utc("2026-08-27T23:30:00Z")
    assert result.deadline == utc("2026-08-28T03:00:00Z")
    assert result.decision == "RUN"


def test_run_started_at_is_telemetry_not_admission_authority(tmp_path):
    early = admission.run_from_environment(
        "update",
        "pre_fetch",
        env=scheduled_env(tmp_path),
        now=utc("2026-08-28T02:54:00Z"),
        client_factory=client_for(
            metadata(run_started_at="2026-08-27T23:32:00Z")
        ),
    )
    late_started = admission.run_from_environment(
        "update",
        "pre_fetch",
        env=scheduled_env(tmp_path),
        now=utc("2026-08-28T02:54:00Z"),
        client_factory=client_for(
            metadata(run_started_at="2026-09-01T00:00:00Z")
        ),
    )

    assert early.decision == late_started.decision == "RUN"
    assert early.effective_deadline == late_started.effective_deadline
    assert early.lock_wait_minutes > late_started.lock_wait_minutes


def test_pre_publish_prefers_valid_same_run_cache_over_api(tmp_path):
    env = scheduled_env(tmp_path)
    first_client = client_for(metadata())
    first = admission.run_from_environment(
        "update",
        "pre_fetch",
        env=env,
        now=utc("2026-08-28T00:00:00Z"),
        client_factory=first_client,
    )

    class ForbiddenClient:
        def __init__(self, **kwargs):
            raise AssertionError("valid cache must be preferred")

    second = admission.run_from_environment(
        "update",
        "pre_publish",
        env=env,
        now=utc("2026-08-28T01:00:00Z"),
        client_factory=ForbiddenClient,
    )

    assert first_client.calls == 1
    assert second.scheduled_at == first.scheduled_at
    assert second.lock_wait_minutes == first.lock_wait_minutes


def test_invalid_cache_falls_back_to_api(tmp_path):
    env = scheduled_env(tmp_path)
    first_client = client_for(metadata())
    admission.run_from_environment(
        "update",
        "pre_fetch",
        env=env,
        now=utc("2026-08-28T00:00:00Z"),
        client_factory=first_client,
    )
    cache_path = tmp_path / "mutation-admission-update.json"
    payload = json.loads(cache_path.read_text())
    payload["runId"] = 999
    cache_path.write_text(json.dumps(payload))
    fallback_client = client_for(metadata())

    result = admission.run_from_environment(
        "update",
        "pre_publish",
        env=env,
        now=utc("2026-08-28T01:00:00Z"),
        client_factory=fallback_client,
    )

    assert fallback_client.calls == 1
    assert result.decision == "RUN"


def test_invalid_cache_and_api_failure_fail_closed(tmp_path):
    env = scheduled_env(tmp_path)
    (tmp_path / "mutation-admission-update.json").write_text("not-json")

    class FailingClient:
        def __init__(self, **kwargs):
            raise admission.GuardError("API unavailable")

    with pytest.raises(
        admission.GuardError,
        match=r"cache unavailable .* API fallback failed \(API unavailable\)",
    ):
        admission.run_from_environment(
            "update",
            "pre_publish",
            env=env,
            now=utc("2026-08-28T01:00:00Z"),
            client_factory=FailingClient,
        )


def test_summary_contains_every_frozen_field(tmp_path):
    result = admission.run_from_environment(
        "update",
        "pre_fetch",
        env=scheduled_env(tmp_path),
        now=utc("2026-08-28T01:00:00Z"),
        client_factory=client_for(metadata()),
    )
    summary = tmp_path / "summary.md"
    admission.append_summary(result.as_dict(), {"GITHUB_STEP_SUMMARY": str(summary)})
    text = summary.read_text()

    assert tuple(result.as_dict()) == admission.SUMMARY_FIELDS
    for field in admission.SUMMARY_FIELDS:
        assert f"| {field} |" in text


@pytest.mark.parametrize(
    ("event", "checkpoint", "now", "expected"),
    [
        ("workflow_dispatch", "pre_fetch", "2026-08-28T01:00:00Z", 0),
        ("schedule", "pre_publish", "2026-08-28T02:55:00Z", 78),
        ("schedule", "pre_publish", "2026-08-28T01:00:00Z", 2),
    ],
)
def test_main_exit_codes_are_zero_78_and_two(
    tmp_path, monkeypatch, capsys, event, checkpoint, now, expected
):
    summary = tmp_path / "summary.md"
    env = {
        "GITHUB_EVENT_NAME": event,
        "GITHUB_RUN_ID": "100",
        "GITHUB_RUN_ATTEMPT": "1",
        "GITHUB_STEP_SUMMARY": str(summary),
        "RUNNER_TEMP": str(tmp_path),
    }
    if event == "schedule" and expected == 78:
        cache = admission.NominalCache(
            workflow="update",
            run_id=100,
            run_attempt=1,
            event="schedule",
            scheduled_at=utc("2026-08-27T23:30:00Z"),
            deadline=utc("2026-08-28T03:00:00Z"),
            effective_deadline=utc("2026-08-28T02:55:00Z"),
            lock_wait_minutes=0,
        )
        admission._write_cache(cache, env)
    monkeypatch.setattr(admission, "datetime", FixedDateTime(utc(now)))
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    for name in (
        "GITHUB_API_URL",
        "GITHUB_REPOSITORY",
        "GITHUB_TOKEN",
        "GITHUB_EVENT_PATH",
    ):
        monkeypatch.delenv(name, raising=False)

    assert admission.main(["--workflow", "update", "--checkpoint", checkpoint]) == expected
    payload = json.loads(capsys.readouterr().out)
    assert payload["decision"] == {0: "RUN", 78: "SKIP", 2: "ERROR"}[expected]
    if expected == 0:
        assert payload["reason"] == "manual_dispatch_bypass"
    elif expected == 78:
        assert payload["reason"] == "mutation_deadline_exceeded"
    else:
        assert payload["reason"].startswith("metadata_config_clock_error: ")


class FixedDateTime:
    current: datetime

    def __init__(self, current: datetime):
        type(self).current = current

    @classmethod
    def now(cls, tz=None):
        return cls.current
