"""Deadline admission for serialized production-data mutation jobs.

GitHub Actions job-level concurrency provides the shared mutation lock.  This
module makes a fresh wall-clock admission decision after that lock is acquired
and again before publication.  The original scheduled occurrence and deadline
come from the frozen late-run guard authority; ``run_started_at`` is retained
only as lock-wait telemetry and never controls admission.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
from typing import Iterable, Mapping

from backend.engine.operation import late_run_guard as late_guard


UTC = timezone.utc

EXIT_RUN = late_guard.EXIT_RUN
EXIT_SKIP = late_guard.EXIT_SKIP
EXIT_ERROR = late_guard.EXIT_ERROR
GuardError = late_guard.GuardError
GitHubActionsClient = late_guard.GitHubActionsClient

MANUAL_EVENT = late_guard.MANUAL_EVENT
SCHEDULED_EVENT = late_guard.SCHEDULED_EVENT

LOCK_GROUP = "jp-portfolio-production-data-mutation"
MARGIN_MINUTES = 5
MARGIN = timedelta(minutes=MARGIN_MINUTES)
CACHE_SCHEMA = "mutation-admission-cache-1"
CHECKPOINTS = ("pre_fetch", "pre_publish")


def _format_timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _positive_int(value: object, field: str) -> int:
    if isinstance(value, bool):
        raise GuardError(f"{field} must be a positive integer")
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise GuardError(f"{field} must be a positive integer") from exc
    if parsed <= 0:
        raise GuardError(f"{field} must be a positive integer")
    return parsed


def _required_env(name: str, env: Mapping[str, str]) -> str:
    value = env.get(name)
    if not value:
        raise GuardError(f"{name} is missing")
    return value


@dataclass(frozen=True)
class NominalCache:
    workflow: str
    run_id: int
    run_attempt: int
    event: str
    scheduled_at: datetime
    deadline: datetime
    effective_deadline: datetime
    lock_wait_minutes: int

    def as_dict(self) -> dict[str, object]:
        return {
            "schemaVersion": CACHE_SCHEMA,
            "workflow": self.workflow,
            "runId": self.run_id,
            "runAttempt": self.run_attempt,
            "event": self.event,
            "checkpoint": "pre_fetch",
            "scheduledAt": _format_timestamp(self.scheduled_at),
            "deadline": _format_timestamp(self.deadline),
            "marginMinutes": MARGIN_MINUTES,
            "effectiveDeadline": _format_timestamp(self.effective_deadline),
            "lockGroup": LOCK_GROUP,
            "lockWaitMinutes": self.lock_wait_minutes,
        }


@dataclass(frozen=True)
class AdmissionResult:
    workflow: str
    run_id: int
    run_attempt: int
    checkpoint: str
    event: str
    scheduled_at: datetime | None
    deadline: datetime | None
    effective_deadline: datetime | None
    now: datetime
    remaining_minutes: int | None
    lock_wait_minutes: int | None
    decision: str
    reason: str

    def as_dict(self) -> dict[str, object]:
        return {
            "workflow": self.workflow,
            "runId": self.run_id,
            "runAttempt": self.run_attempt,
            "checkpoint": self.checkpoint,
            "event": self.event,
            "scheduledAt": _format_timestamp(self.scheduled_at),
            "deadline": _format_timestamp(self.deadline),
            "marginMinutes": MARGIN_MINUTES,
            "effectiveDeadline": _format_timestamp(self.effective_deadline),
            "now": _format_timestamp(self.now),
            "remainingMinutes": self.remaining_minutes,
            "lockGroup": LOCK_GROUP,
            "lockWaitMinutes": self.lock_wait_minutes,
            "decision": self.decision,
            "reason": self.reason,
        }


def _cache_path(workflow: str, env: Mapping[str, str]) -> Path:
    runner_temp = Path(_required_env("RUNNER_TEMP", env))
    if not runner_temp.is_dir():
        raise GuardError("RUNNER_TEMP is not an existing directory")
    return runner_temp / f"mutation-admission-{workflow}.json"


def _write_cache(cache: NominalCache, env: Mapping[str, str]) -> None:
    path = _cache_path(cache.workflow, env)
    temporary = path.with_suffix(".tmp")
    try:
        temporary.write_text(
            json.dumps(cache.as_dict(), sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        temporary.replace(path)
    except OSError as exc:
        raise GuardError(f"nominal cache cannot be written: {exc}") from exc


def _load_cache(
    workflow: str, run_id: int, run_attempt: int, env: Mapping[str, str]
) -> NominalCache:
    path = _cache_path(workflow, env)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise GuardError(f"nominal cache cannot be read: {exc}") from exc
    if not isinstance(payload, dict):
        raise GuardError("nominal cache is not an object")
    expected = {
        "schemaVersion": CACHE_SCHEMA,
        "workflow": workflow,
        "runId": run_id,
        "runAttempt": run_attempt,
        "event": SCHEDULED_EVENT,
        "checkpoint": "pre_fetch",
        "marginMinutes": MARGIN_MINUTES,
        "lockGroup": LOCK_GROUP,
    }
    for field, value in expected.items():
        if payload.get(field) != value:
            raise GuardError(f"nominal cache {field} does not match current run")

    scheduled_at = late_guard.parse_timestamp(payload.get("scheduledAt"), "cache.scheduledAt")
    deadline = late_guard.parse_timestamp(payload.get("deadline"), "cache.deadline")
    effective_deadline = late_guard.parse_timestamp(
        payload.get("effectiveDeadline"), "cache.effectiveDeadline"
    )
    if deadline != late_guard.deadline_for(workflow, scheduled_at):
        raise GuardError("nominal cache deadline is inconsistent")
    if effective_deadline != deadline - MARGIN:
        raise GuardError("nominal cache effective deadline is inconsistent")
    lock_wait_minutes = payload.get("lockWaitMinutes")
    if (
        isinstance(lock_wait_minutes, bool)
        or not isinstance(lock_wait_minutes, int)
        or lock_wait_minutes < 0
    ):
        raise GuardError("nominal cache lockWaitMinutes is invalid")
    return NominalCache(
        workflow=workflow,
        run_id=run_id,
        run_attempt=run_attempt,
        event=SCHEDULED_EVENT,
        scheduled_at=scheduled_at,
        deadline=deadline,
        effective_deadline=effective_deadline,
        lock_wait_minutes=lock_wait_minutes,
    )


def _event_schedule(event_path: str) -> str:
    try:
        payload = json.loads(Path(event_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise GuardError(f"GITHUB_EVENT_PATH cannot be read: {exc}") from exc
    schedule = payload.get("schedule") if isinstance(payload, dict) else None
    if not isinstance(schedule, str) or not schedule:
        raise GuardError("scheduled event payload is missing schedule")
    return schedule


def _fetch_nominal(
    workflow: str,
    run_id: int,
    run_attempt: int,
    env: Mapping[str, str],
    now: datetime,
    client_factory: type[GitHubActionsClient],
) -> NominalCache:
    client = client_factory(
        api_url=_required_env("GITHUB_API_URL", env),
        repository=_required_env("GITHUB_REPOSITORY", env),
        token=_required_env("GITHUB_TOKEN", env),
    )
    current = client.get_run(run_id)
    if current.run_id != run_id:
        raise GuardError("API run ID does not match GITHUB_RUN_ID")
    if current.run_attempt != run_attempt:
        raise GuardError("API run attempt does not match GITHUB_RUN_ATTEMPT")
    if current.event != SCHEDULED_EVENT:
        raise GuardError("GitHub run event does not match schedule event")
    policy = late_guard.POLICIES.get(workflow)
    if policy is None:
        raise GuardError(f"unknown workflow: {workflow}")
    if current.path != policy.path:
        raise GuardError("GitHub run path does not match configured workflow")

    scheduled_at, _ = late_guard.resolve_nominal(
        workflow,
        _event_schedule(_required_env("GITHUB_EVENT_PATH", env)),
        current.created_at,
    )
    deadline = late_guard.deadline_for(workflow, scheduled_at)
    if current.run_started_at is None:
        lock_wait_minutes = 0
    else:
        lock_wait_minutes = max(
            0, int((now - current.run_started_at).total_seconds() // 60)
        )
    return NominalCache(
        workflow=workflow,
        run_id=run_id,
        run_attempt=run_attempt,
        event=SCHEDULED_EVENT,
        scheduled_at=scheduled_at,
        deadline=deadline,
        effective_deadline=deadline - MARGIN,
        lock_wait_minutes=lock_wait_minutes,
    )


def _evaluate(cache: NominalCache, checkpoint: str, now: datetime) -> AdmissionResult:
    remaining_minutes = int(
        (cache.effective_deadline - now).total_seconds() // 60
    )
    if now < cache.effective_deadline:
        decision = "RUN"
        reason = "admitted_before_effective_deadline"
    else:
        decision = "SKIP"
        reason = "mutation_deadline_exceeded"
    return AdmissionResult(
        workflow=cache.workflow,
        run_id=cache.run_id,
        run_attempt=cache.run_attempt,
        checkpoint=checkpoint,
        event=cache.event,
        scheduled_at=cache.scheduled_at,
        deadline=cache.deadline,
        effective_deadline=cache.effective_deadline,
        now=now,
        remaining_minutes=remaining_minutes,
        lock_wait_minutes=cache.lock_wait_minutes,
        decision=decision,
        reason=reason,
    )


def run_from_environment(
    workflow: str,
    checkpoint: str,
    *,
    env: Mapping[str, str] | None = None,
    now: datetime | None = None,
    client_factory: type[GitHubActionsClient] = GitHubActionsClient,
) -> AdmissionResult:
    if workflow not in late_guard.POLICIES:
        raise GuardError(f"unknown workflow: {workflow}")
    if checkpoint not in CHECKPOINTS:
        raise GuardError(f"unknown checkpoint: {checkpoint}")
    values = os.environ if env is None else env
    event = _required_env("GITHUB_EVENT_NAME", values)
    run_id = _positive_int(_required_env("GITHUB_RUN_ID", values), "GITHUB_RUN_ID")
    run_attempt = _positive_int(
        _required_env("GITHUB_RUN_ATTEMPT", values), "GITHUB_RUN_ATTEMPT"
    )
    observed_now = (now or datetime.now(UTC)).astimezone(UTC)

    if event == MANUAL_EVENT:
        return AdmissionResult(
            workflow=workflow,
            run_id=run_id,
            run_attempt=run_attempt,
            checkpoint=checkpoint,
            event=event,
            scheduled_at=None,
            deadline=None,
            effective_deadline=None,
            now=observed_now,
            remaining_minutes=None,
            lock_wait_minutes=None,
            decision="RUN",
            reason="manual_dispatch_bypass",
        )
    if event != SCHEDULED_EVENT:
        raise GuardError(f"unsupported GitHub event: {event}")

    if checkpoint == "pre_fetch":
        cache = _fetch_nominal(
            workflow,
            run_id,
            run_attempt,
            values,
            observed_now,
            client_factory,
        )
        _write_cache(cache, values)
    else:
        try:
            cache = _load_cache(workflow, run_id, run_attempt, values)
        except GuardError as cache_error:
            try:
                cache = _fetch_nominal(
                    workflow,
                    run_id,
                    run_attempt,
                    values,
                    observed_now,
                    client_factory,
                )
            except GuardError as api_error:
                raise GuardError(
                    f"cache unavailable ({cache_error}); API fallback failed ({api_error})"
                ) from api_error
    return _evaluate(cache, checkpoint, observed_now)


SUMMARY_FIELDS = (
    "workflow",
    "runId",
    "runAttempt",
    "checkpoint",
    "event",
    "scheduledAt",
    "deadline",
    "marginMinutes",
    "effectiveDeadline",
    "now",
    "remainingMinutes",
    "lockGroup",
    "lockWaitMinutes",
    "decision",
    "reason",
)


def append_summary(payload: Mapping[str, object], env: Mapping[str, str]) -> None:
    summary_path = _required_env("GITHUB_STEP_SUMMARY", env)
    lines = [
        f"## Mutation admission: {payload['decision']}",
        "",
        "| Field | Value |",
        "| --- | --- |",
    ]
    for field in SUMMARY_FIELDS:
        value = payload.get(field)
        lines.append(f"| {field} | {value if value is not None else 'null'} |")
    try:
        with Path(summary_path).open("a", encoding="utf-8") as summary:
            summary.write("\n".join(lines) + "\n")
    except OSError as exc:
        raise GuardError(f"GITHUB_STEP_SUMMARY cannot be written: {exc}") from exc


def _error_payload(
    workflow: str,
    checkpoint: str,
    reason: str,
    env: Mapping[str, str],
    now: datetime,
) -> dict[str, object]:
    def integer_or_zero(name: str) -> int:
        try:
            return int(env.get(name, "0"))
        except ValueError:
            return 0

    return {
        "workflow": workflow,
        "runId": integer_or_zero("GITHUB_RUN_ID"),
        "runAttempt": integer_or_zero("GITHUB_RUN_ATTEMPT"),
        "checkpoint": checkpoint,
        "event": env.get("GITHUB_EVENT_NAME"),
        "scheduledAt": None,
        "deadline": None,
        "marginMinutes": MARGIN_MINUTES,
        "effectiveDeadline": None,
        "now": _format_timestamp(now),
        "remainingMinutes": None,
        "lockGroup": LOCK_GROUP,
        "lockWaitMinutes": None,
        "decision": "ERROR",
        "reason": f"metadata_config_clock_error: {reason}",
    }


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Serialized mutation admission")
    parser.add_argument("--workflow", required=True, choices=sorted(late_guard.POLICIES))
    parser.add_argument("--checkpoint", required=True, choices=CHECKPOINTS)
    args = parser.parse_args(list(argv) if argv is not None else None)
    now = datetime.now(UTC)
    try:
        result = run_from_environment(args.workflow, args.checkpoint, now=now)
        payload = result.as_dict()
        append_summary(payload, os.environ)
        print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
        return EXIT_SKIP if result.decision == "SKIP" else EXIT_RUN
    except GuardError as exc:
        payload = _error_payload(
            args.workflow, args.checkpoint, str(exc), os.environ, now
        )
        print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
        try:
            append_summary(payload, os.environ)
        except GuardError as summary_error:
            print(f"mutation admission summary error: {summary_error}", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
