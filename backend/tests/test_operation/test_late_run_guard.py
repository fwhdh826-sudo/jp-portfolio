from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

import pytest

from backend.engine.operation import late_run_guard as guard


UTC = timezone.utc
JST = guard.JST


def utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def local(value: str) -> datetime:
    return datetime.fromisoformat(value).replace(tzinfo=JST)


def metadata(
    workflow: str,
    scheduled_local: datetime,
    started_local: datetime,
    *,
    run_id: int = 100,
    run_attempt: int = 1,
    workflow_id: int = 50,
    event: str = "schedule",
    created_delay: timedelta = timedelta(minutes=1),
    path: str | None = None,
) -> guard.RunMetadata:
    scheduled_at = scheduled_local.astimezone(UTC)
    return guard.RunMetadata(
        run_id=run_id,
        run_attempt=run_attempt,
        event=event,
        workflow_id=workflow_id,
        created_at=scheduled_at + created_delay,
        run_started_at=started_local.astimezone(UTC),
        path=path or guard.POLICIES[workflow].path,
    )


def evaluate(
    workflow: str,
    cron: str,
    scheduled_local: datetime,
    started_local: datetime,
    *,
    run_id: int = 100,
    run_attempt: int = 1,
    runs: list[guard.RunMetadata] | None = None,
) -> guard.GuardResult:
    current = metadata(
        workflow,
        scheduled_local,
        started_local,
        run_id=run_id,
        run_attempt=run_attempt,
    )
    return guard.evaluate_scheduled(
        workflow=workflow,
        cron=cron,
        current=current,
        scheduled_runs=runs or [current],
    )


@pytest.mark.parametrize(
    ("workflow", "cron", "scheduled", "deadline", "scheduled_utc", "deadline_utc"),
    [
        (
            "full",
            "30 21 * * 0-4",
            "2026-08-28T06:30:00",
            "2026-08-28T07:30:00",
            "2026-08-27T21:30:00Z",
            "2026-08-27T22:30:00Z",
        ),
        (
            "update",
            "30 23 * * *",
            "2026-08-28T08:30:00",
            "2026-08-28T12:00:00",
            "2026-08-27T23:30:00Z",
            "2026-08-28T03:00:00Z",
        ),
        (
            "update",
            "30 23 * * *",
            "2026-08-29T08:30:00",
            "2026-08-29T20:00:00",
            "2026-08-28T23:30:00Z",
            "2026-08-29T11:00:00Z",
        ),
        (
            "update",
            "30 23 * * *",
            "2026-08-30T08:30:00",
            "2026-08-30T20:00:00",
            "2026-08-29T23:30:00Z",
            "2026-08-30T11:00:00Z",
        ),
        (
            "intraday",
            "30 3 * * 1-5",
            "2026-08-28T12:30:00",
            "2026-08-28T20:00:00",
            "2026-08-28T03:30:00Z",
            "2026-08-28T11:00:00Z",
        ),
        (
            "update",
            "30 11 * * *",
            "2026-08-30T20:30:00",
            "2026-08-31T06:00:00",
            "2026-08-30T11:30:00Z",
            "2026-08-30T21:00:00Z",
        ),
        (
            "update",
            "30 11 * * *",
            "2026-08-31T20:30:00",
            "2026-09-01T06:00:00",
            "2026-08-31T11:30:00Z",
            "2026-08-31T21:00:00Z",
        ),
        (
            "update",
            "30 11 * * *",
            "2026-09-04T20:30:00",
            "2026-09-05T08:00:00",
            "2026-09-04T11:30:00Z",
            "2026-09-04T23:00:00Z",
        ),
        (
            "update",
            "30 11 * * *",
            "2026-09-05T20:30:00",
            "2026-09-06T08:00:00",
            "2026-09-05T11:30:00Z",
            "2026-09-05T23:00:00Z",
        ),
    ],
)
def test_all_frozen_deadlines_in_jst_and_utc(
    workflow, cron, scheduled, deadline, scheduled_utc, deadline_utc
):
    scheduled_local = local(scheduled)
    result = evaluate(workflow, cron, scheduled_local, local(deadline) - timedelta(seconds=1))

    assert result.scheduled_at == utc(scheduled_utc)
    assert result.deadline == utc(deadline_utc)
    assert result.decision == "RUN"


@pytest.mark.parametrize(
    ("workflow", "cron", "scheduled", "deadline"),
    [
        ("full", "30 21 * * 0-4", "2026-08-28T06:30:00", "2026-08-28T07:30:00"),
        ("update", "30 23 * * *", "2026-08-28T08:30:00", "2026-08-28T12:00:00"),
        ("update", "30 23 * * *", "2026-08-29T08:30:00", "2026-08-29T20:00:00"),
        ("intraday", "30 3 * * 1-5", "2026-08-28T12:30:00", "2026-08-28T20:00:00"),
        ("update", "30 11 * * *", "2026-08-30T20:30:00", "2026-08-31T06:00:00"),
        ("update", "30 11 * * *", "2026-09-04T20:30:00", "2026-09-05T08:00:00"),
        ("update", "30 11 * * *", "2026-09-05T20:30:00", "2026-09-06T08:00:00"),
    ],
)
@pytest.mark.parametrize(
    ("offset", "decision"),
    [
        (timedelta(seconds=-1), "RUN"),
        (timedelta(0), "SKIP"),
        (timedelta(seconds=1), "SKIP"),
    ],
)
def test_every_deadline_boundary_is_inclusive_for_skip(
    workflow, cron, scheduled, deadline, offset, decision
):
    result = evaluate(
        workflow,
        cron,
        local(scheduled),
        local(deadline) + offset,
    )
    assert result.decision == decision


@pytest.mark.parametrize(
    ("minutes", "decision"),
    [(3, "RUN"), (60, "RUN"), (120, "RUN"), (180, "RUN"), (360, "SKIP")],
)
def test_lateness_minutes_and_decision_from_original_nominal(minutes, decision):
    scheduled = local("2026-08-28T08:30:00")
    result = evaluate(
        "update",
        "30 23 * * *",
        scheduled,
        scheduled + timedelta(minutes=minutes),
    )
    assert result.lateness_minutes == minutes
    assert result.decision == decision


def test_date_crossing_evening_deadline_uses_next_jst_day():
    scheduled = local("2026-09-04T20:30:00")
    before = evaluate(
        "update",
        "30 11 * * *",
        scheduled,
        local("2026-09-05T07:59:59"),
    )
    at = evaluate(
        "update",
        "30 11 * * *",
        scheduled,
        local("2026-09-05T08:00:00"),
    )
    assert before.decision == "RUN"
    assert at.decision == "SKIP"


def test_holiday_is_an_ordinary_weekday_calendar_day():
    # 2026-01-01 is a Japanese holiday but a Thursday in the frozen policy.
    scheduled = local("2026-01-01T08:30:00")
    result = evaluate(
        "update",
        "30 23 * * *",
        scheduled,
        local("2026-01-01T12:00:00"),
    )
    assert result.deadline == utc("2026-01-01T03:00:00Z")
    assert result.decision == "SKIP"


def test_manual_dispatch_bypasses_api_metadata_and_deadlines(tmp_path):
    env = {
        "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_RUN_ID": "321",
        "GITHUB_RUN_ATTEMPT": "1",
    }
    result = guard.run_from_environment(
        "full", env=env, now=utc("2026-08-29T15:00:00Z")
    )
    assert result.decision == "RUN"
    assert result.reason == "manual_dispatch_bypass"
    assert result.scheduled_at is None
    assert result.deadline is None


def test_manual_rerun_is_still_a_manual_bypass():
    result = guard.run_from_environment(
        "update",
        env={
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_RUN_ID": "321",
            "GITHUB_RUN_ATTEMPT": "4",
        },
        now=utc("2026-09-30T00:00:00Z"),
    )
    assert result.decision == "RUN"
    assert result.run_attempt == 4


def test_scheduled_rerun_reuses_original_nominal_and_new_attempt_start():
    scheduled = local("2026-08-28T06:30:00")
    current = metadata(
        "full",
        scheduled,
        local("2026-08-29T06:30:00"),
        run_attempt=2,
    )
    result = guard.evaluate_scheduled(
        workflow="full",
        cron="30 21 * * 0-4",
        current=current,
        scheduled_runs=[current],
    )
    assert result.scheduled_at == scheduled.astimezone(UTC)
    assert result.run_attempt == 2
    assert result.decision == "SKIP"


def test_duplicate_election_allows_only_lowest_run_id():
    scheduled = local("2026-08-28T12:30:00")
    canonical = metadata(
        "intraday", scheduled, local("2026-08-28T12:35:00"), run_id=99
    )
    duplicate = metadata(
        "intraday",
        scheduled,
        local("2026-08-28T12:36:00"),
        run_id=100,
        created_delay=timedelta(minutes=2),
    )
    result = guard.evaluate_scheduled(
        workflow="intraday",
        cron="30 3 * * 1-5",
        current=duplicate,
        scheduled_runs=[duplicate, canonical],
    )
    assert result.decision == "SKIP"
    assert result.reason == "duplicate_scheduled_execution"


def test_canonical_run_remains_run_when_duplicate_exists():
    scheduled = local("2026-08-28T12:30:00")
    canonical = metadata(
        "intraday", scheduled, local("2026-08-28T12:35:00"), run_id=99
    )
    duplicate = metadata(
        "intraday", scheduled, local("2026-08-28T12:36:00"), run_id=100
    )
    result = guard.evaluate_scheduled(
        workflow="intraday",
        cron="30 3 * * 1-5",
        current=canonical,
        scheduled_runs=[duplicate, canonical],
    )
    assert result.decision == "RUN"


@pytest.mark.parametrize(
    "mutation",
    [
        {"event": "workflow_dispatch"},
        {"path": ".github/workflows/update-data.yml"},
        {"run_started_at": utc("2026-08-27T21:30:30Z")},
    ],
)
def test_invalid_clock_or_current_metadata_mismatch_is_error(mutation):
    scheduled = local("2026-08-28T06:30:00")
    values = {
        "run_id": 100,
        "run_attempt": 1,
        "event": "schedule",
        "workflow_id": 50,
        "created_at": utc("2026-08-27T21:31:00Z"),
        "run_started_at": utc("2026-08-27T21:32:00Z"),
        "path": guard.POLICIES["full"].path,
    }
    values.update(mutation)
    current = guard.RunMetadata(**values)
    with pytest.raises(guard.GuardError):
        guard.evaluate_scheduled(
            workflow="full",
            cron="30 21 * * 0-4",
            current=current,
            scheduled_runs=[current],
        )


def test_started_at_before_created_at_is_clock_error():
    scheduled = local("2026-08-28T06:30:00")
    current = metadata(
        "full",
        scheduled,
        local("2026-08-28T06:29:59"),
    )
    with pytest.raises(guard.GuardError, match="precedes run.created_at"):
        guard.evaluate_scheduled(
            workflow="full",
            cron="30 21 * * 0-4",
            current=current,
            scheduled_runs=[current],
        )


def test_missing_current_run_from_duplicate_metadata_is_error():
    scheduled = local("2026-08-28T06:30:00")
    current = metadata("full", scheduled, local("2026-08-28T06:35:00"))
    other = metadata(
        "full", scheduled, local("2026-08-28T06:35:00"), run_id=99
    )
    with pytest.raises(guard.GuardError, match="current run is missing"):
        guard.evaluate_scheduled(
            workflow="full",
            cron="30 21 * * 0-4",
            current=current,
            scheduled_runs=[other],
        )


@pytest.mark.parametrize(
    ("workflow", "cron"),
    [
        ("full", "30 22 * * 0-4"),
        ("update", "30 3 * * 1-5"),
        ("intraday", "30 11 * * *"),
    ],
)
def test_unknown_or_mismatched_cron_is_config_error(workflow, cron):
    with pytest.raises(guard.GuardError, match="does not exactly match"):
        guard.resolve_nominal(workflow, cron, utc("2026-08-28T00:00:00Z"))


def test_created_at_crossing_another_update_nominal_is_ambiguous():
    # A morning event arriving after the evening nominal cannot be uniquely
    # reconciled with list metadata, which does not expose each run's cron.
    with pytest.raises(guard.GuardError, match="crossed another nominal"):
        guard.resolve_nominal(
            "update", "30 23 * * *", utc("2026-08-28T12:00:00Z")
        )


def test_parse_metadata_rejects_missing_and_naive_timestamps():
    with pytest.raises(guard.GuardError, match="run.path"):
        guard.parse_run_metadata({})
    with pytest.raises(guard.GuardError, match="UTC offset"):
        guard.parse_timestamp("2026-08-28T06:30:00", "clock")


def test_structured_json_contains_contract_fields_and_run_exit_zero(
    monkeypatch, capsys
):
    result = guard.evaluate_manual(
        workflow="full",
        run_id=100,
        run_attempt=1,
        started_at=utc("2026-08-28T00:00:00Z"),
    )
    monkeypatch.setattr(guard, "run_from_environment", lambda *args, **kwargs: result)
    assert guard.main(["--workflow", "full"]) == guard.EXIT_RUN
    payload = json.loads(capsys.readouterr().out)
    assert set(payload) == {
        "scheduledAt",
        "startedAt",
        "latenessMinutes",
        "deadline",
        "decision",
        "reason",
        "workflow",
        "runId",
        "runAttempt",
    }
    assert payload["decision"] == "RUN"


def test_skip_exit_78_writes_required_summary(monkeypatch, tmp_path, capsys):
    summary = tmp_path / "summary"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    result = guard.GuardResult(
        scheduled_at=utc("2026-08-27T21:30:00Z"),
        started_at=utc("2026-08-27T22:30:00Z"),
        lateness_minutes=60,
        deadline=utc("2026-08-27T22:30:00Z"),
        decision="SKIP",
        reason="started_at_at_or_after_deadline",
        workflow="full",
        run_id=100,
        run_attempt=1,
    )
    monkeypatch.setattr(guard, "run_from_environment", lambda *args, **kwargs: result)
    assert guard.main(["--workflow", "full"]) == guard.EXIT_SKIP
    payload = json.loads(capsys.readouterr().out)
    text = summary.read_text()
    for field, value in payload.items():
        assert field in text
        assert str(value if value is not None else "null") in text


def test_metadata_error_exit_2_is_structured_and_summarized(
    monkeypatch, tmp_path, capsys
):
    summary = tmp_path / "summary"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    monkeypatch.setenv("GITHUB_RUN_ID", "100")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "2")

    def fail(*args, **kwargs):
        raise guard.GuardError("ambiguous clock")

    monkeypatch.setattr(guard, "run_from_environment", fail)
    assert guard.main(["--workflow", "update"]) == guard.EXIT_ERROR
    payload = json.loads(capsys.readouterr().out)
    assert payload["decision"] == "SKIP"
    assert payload["reason"] == "metadata_config_clock_error: ambiguous clock"
    assert payload["runId"] == 100
    assert "Late-run guard: ERROR" in summary.read_text()


def test_schedule_event_requires_payload_and_api_metadata(tmp_path):
    event = tmp_path / "event.json"
    event.write_text("{}")
    with pytest.raises(guard.GuardError, match="missing schedule"):
        guard.run_from_environment(
            "full",
            env={
                "GITHUB_EVENT_NAME": "schedule",
                "GITHUB_RUN_ID": "100",
                "GITHUB_RUN_ATTEMPT": "1",
                "GITHUB_EVENT_PATH": str(event),
                "GITHUB_API_URL": "https://api.github.com",
                "GITHUB_REPOSITORY": "owner/repo",
                "GITHUB_TOKEN": "token",
            },
        )


def test_parse_run_metadata_accepts_github_utc_json():
    parsed = guard.parse_run_metadata(
        {
            "id": 123,
            "run_attempt": 2,
            "event": "schedule",
            "workflow_id": 7,
            "created_at": "2026-08-27T21:31:00Z",
            "run_started_at": "2026-08-27T21:32:00Z",
            "path": ".github/workflows/full_batch.yml",
        }
    )
    assert parsed.run_id == 123
    assert parsed.run_attempt == 2
    assert parsed.created_at.tzinfo == UTC
