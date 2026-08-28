"""Fail-closed safe-start guard for scheduled production data workflows.

The guard uses GitHub's run metadata as the clock source.  A scheduled event is
accepted only when its exact cron entry and original ``created_at`` identify one
nominal occurrence without crossing another configured occurrence.  Re-runs
therefore retain the original nominal schedule while ``run_started_at`` reflects
the current attempt.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
from typing import Any, Iterable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


UTC = timezone.utc
JST = ZoneInfo("Asia/Tokyo")

EXIT_RUN = 0
EXIT_SKIP = 78
EXIT_ERROR = 2

MANUAL_EVENT = "workflow_dispatch"
SCHEDULED_EVENT = "schedule"


@dataclass(frozen=True)
class ScheduleRule:
    cron: str
    local_hour: int
    local_minute: int
    weekdays: frozenset[int]


@dataclass(frozen=True)
class WorkflowPolicy:
    path: str
    rules: tuple[ScheduleRule, ...]


ALL_DAYS = frozenset(range(7))
WEEKDAYS = frozenset(range(5))

POLICIES: Mapping[str, WorkflowPolicy] = {
    "full": WorkflowPolicy(
        path=".github/workflows/full_batch.yml",
        rules=(ScheduleRule("30 21 * * 0-4", 6, 30, WEEKDAYS),),
    ),
    "update": WorkflowPolicy(
        path=".github/workflows/update-data.yml",
        rules=(
            ScheduleRule("30 23 * * *", 8, 30, ALL_DAYS),
            ScheduleRule("30 11 * * *", 20, 30, ALL_DAYS),
        ),
    ),
    "intraday": WorkflowPolicy(
        path=".github/workflows/intraday_patch.yml",
        rules=(ScheduleRule("30 3 * * 1-5", 12, 30, WEEKDAYS),),
    ),
}


class GuardError(ValueError):
    """Metadata, configuration, or clock ambiguity."""


@dataclass(frozen=True)
class RunMetadata:
    run_id: int
    run_attempt: int
    event: str
    workflow_id: int
    created_at: datetime
    run_started_at: datetime | None
    path: str


@dataclass(frozen=True)
class GuardResult:
    scheduled_at: datetime | None
    started_at: datetime
    lateness_minutes: int | None
    deadline: datetime | None
    decision: str
    reason: str
    workflow: str
    run_id: int
    run_attempt: int

    def as_dict(self) -> dict[str, object]:
        return {
            "scheduledAt": _format_timestamp(self.scheduled_at),
            "startedAt": _format_timestamp(self.started_at),
            "latenessMinutes": self.lateness_minutes,
            "deadline": _format_timestamp(self.deadline),
            "decision": self.decision,
            "reason": self.reason,
            "workflow": self.workflow,
            "runId": self.run_id,
            "runAttempt": self.run_attempt,
        }


def _format_timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_timestamp(value: object, field: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise GuardError(f"{field} is missing or is not a timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise GuardError(f"{field} is not a valid ISO-8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise GuardError(f"{field} must include a UTC offset")
    return parsed.astimezone(UTC)


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


def parse_run_metadata(
    payload: Mapping[str, object], *, require_started_at: bool = True
) -> RunMetadata:
    path = payload.get("path")
    if not isinstance(path, str) or not path:
        raise GuardError("run.path is missing")
    event = payload.get("event")
    if not isinstance(event, str) or not event:
        raise GuardError("run.event is missing")
    started_raw = payload.get("run_started_at")
    if started_raw is None and not require_started_at:
        started_at = None
    else:
        started_at = parse_timestamp(started_raw, "run.run_started_at")
    return RunMetadata(
        run_id=_positive_int(payload.get("id"), "run.id"),
        run_attempt=_positive_int(payload.get("run_attempt"), "run.run_attempt"),
        event=event,
        workflow_id=_positive_int(payload.get("workflow_id"), "run.workflow_id"),
        created_at=parse_timestamp(payload.get("created_at"), "run.created_at"),
        run_started_at=started_at,
        path=path,
    )


def _rule_for(workflow: str, cron: str) -> ScheduleRule:
    try:
        policy = POLICIES[workflow]
    except KeyError as exc:
        raise GuardError(f"unknown workflow: {workflow}") from exc
    matches = [rule for rule in policy.rules if rule.cron == cron]
    if len(matches) != 1:
        raise GuardError(f"schedule does not exactly match {workflow} policy: {cron!r}")
    return matches[0]


def _occurrences(
    workflow: str, start_local_date: datetime, days: int = 20
) -> list[tuple[datetime, ScheduleRule]]:
    policy = POLICIES[workflow]
    occurrences: list[tuple[datetime, ScheduleRule]] = []
    first_date = start_local_date.date()
    for offset in range(days):
        local_date = first_date + timedelta(days=offset)
        for rule in policy.rules:
            if local_date.weekday() in rule.weekdays:
                local = datetime(
                    local_date.year,
                    local_date.month,
                    local_date.day,
                    rule.local_hour,
                    rule.local_minute,
                    tzinfo=JST,
                )
                occurrences.append((local.astimezone(UTC), rule))
    return sorted(occurrences, key=lambda item: item[0])


def resolve_nominal(
    workflow: str, cron: str, created_at: datetime
) -> tuple[datetime, datetime]:
    """Return the nominal occurrence and the next configured occurrence.

    ``created_at`` must fall after the matching nominal and before *any* next
    nominal for the workflow.  Crossing that boundary would make duplicate
    election from GitHub's run-list metadata ambiguous, because list entries do
    not expose the schedule cron that created them.
    """

    rule = _rule_for(workflow, cron)
    created_at = created_at.astimezone(UTC)
    local_anchor = created_at.astimezone(JST) - timedelta(days=10)
    occurrences = _occurrences(workflow, local_anchor, days=22)
    matching = [
        occurrence
        for occurrence, occurrence_rule in occurrences
        if occurrence_rule == rule and occurrence <= created_at
    ]
    if not matching:
        raise GuardError("run.created_at precedes the first attributable nominal")
    scheduled_at = max(matching)
    following = [occurrence for occurrence, _ in occurrences if occurrence > scheduled_at]
    if not following:
        raise GuardError("next nominal occurrence cannot be resolved")
    next_scheduled_at = min(following)
    if created_at >= next_scheduled_at:
        raise GuardError("run.created_at crossed another nominal occurrence")
    return scheduled_at, next_scheduled_at


def deadline_for(workflow: str, scheduled_at: datetime) -> datetime:
    local = scheduled_at.astimezone(JST)
    if workflow == "full":
        deadline_local = local.replace(hour=7, minute=30)
    elif workflow == "intraday":
        deadline_local = local.replace(hour=20, minute=0)
    elif workflow == "update" and (local.hour, local.minute) == (8, 30):
        hour = 12 if local.weekday() < 5 else 20
        deadline_local = local.replace(hour=hour, minute=0)
    elif workflow == "update" and (local.hour, local.minute) == (20, 30):
        next_day = local + timedelta(days=1)
        hour = 6 if local.weekday() in {6, 0, 1, 2, 3} else 8
        deadline_local = next_day.replace(hour=hour, minute=0)
    else:
        raise GuardError("scheduled occurrence does not match deadline policy")
    return deadline_local.astimezone(UTC)


def evaluate_scheduled(
    *,
    workflow: str,
    cron: str,
    current: RunMetadata,
    scheduled_runs: Sequence[RunMetadata],
) -> GuardResult:
    policy = POLICIES.get(workflow)
    if policy is None:
        raise GuardError(f"unknown workflow: {workflow}")
    if current.event != SCHEDULED_EVENT:
        raise GuardError("GitHub run event does not match schedule event")
    if current.path != policy.path:
        raise GuardError("GitHub run path does not match configured workflow")
    if current.run_started_at is None:
        raise GuardError("current run.run_started_at is missing")
    if current.run_started_at < current.created_at:
        raise GuardError("run_started_at precedes run.created_at")

    scheduled_at, next_scheduled_at = resolve_nominal(
        workflow, cron, current.created_at
    )
    candidates = []
    seen_ids: set[int] = set()
    for run in scheduled_runs:
        if run.workflow_id != current.workflow_id or run.event != SCHEDULED_EVENT:
            continue
        if run.path != policy.path:
            raise GuardError("scheduled run list contains a mismatched workflow path")
        if scheduled_at <= run.created_at < next_scheduled_at:
            if run.run_id in seen_ids:
                raise GuardError("scheduled run list contains duplicate run IDs")
            seen_ids.add(run.run_id)
            candidates.append(run)

    if current.run_id not in seen_ids:
        raise GuardError("current run is missing from scheduled duplicate election")
    canonical_run_id = min(run.run_id for run in candidates)
    deadline = deadline_for(workflow, scheduled_at)
    lateness_minutes = int(
        (current.run_started_at - scheduled_at).total_seconds() // 60
    )
    if lateness_minutes < 0:
        raise GuardError("run_started_at precedes scheduledAt")

    if current.run_id != canonical_run_id:
        decision = "SKIP"
        reason = "duplicate_scheduled_execution"
    elif current.run_started_at >= deadline:
        decision = "SKIP"
        reason = "started_at_at_or_after_deadline"
    else:
        decision = "RUN"
        reason = "started_before_deadline"
    return GuardResult(
        scheduled_at=scheduled_at,
        started_at=current.run_started_at,
        lateness_minutes=lateness_minutes,
        deadline=deadline,
        decision=decision,
        reason=reason,
        workflow=workflow,
        run_id=current.run_id,
        run_attempt=current.run_attempt,
    )


def evaluate_manual(
    *, workflow: str, run_id: int, run_attempt: int, started_at: datetime
) -> GuardResult:
    if workflow not in POLICIES:
        raise GuardError(f"unknown workflow: {workflow}")
    return GuardResult(
        scheduled_at=None,
        started_at=started_at.astimezone(UTC),
        lateness_minutes=None,
        deadline=None,
        decision="RUN",
        reason="manual_dispatch_bypass",
        workflow=workflow,
        run_id=run_id,
        run_attempt=run_attempt,
    )


class GitHubActionsClient:
    def __init__(self, *, api_url: str, repository: str, token: str) -> None:
        if not api_url.startswith("https://"):
            raise GuardError("GITHUB_API_URL must use https")
        if repository.count("/") != 1:
            raise GuardError("GITHUB_REPOSITORY must be owner/repository")
        if not token:
            raise GuardError("GITHUB_TOKEN is missing")
        self._base = f"{api_url.rstrip('/')}/repos/{repository}"
        self._token = token

    def _get(self, endpoint: str, query: Mapping[str, object] | None = None) -> Any:
        url = f"{self._base}{endpoint}"
        if query:
            url = f"{url}?{urlencode(query)}"
        request = Request(
            url,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self._token}",
                "User-Agent": "jp-portfolio-late-run-guard",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urlopen(request, timeout=20) as response:
                return json.load(response)
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise GuardError(f"GitHub Actions metadata request failed: {exc}") from exc

    def get_run(self, run_id: int) -> RunMetadata:
        payload = self._get(f"/actions/runs/{run_id}")
        if not isinstance(payload, dict):
            raise GuardError("GitHub current-run response is not an object")
        return parse_run_metadata(payload)

    def list_scheduled_runs(
        self, *, workflow_id: int, start: datetime, end: datetime
    ) -> list[RunMetadata]:
        results: list[RunMetadata] = []
        page = 1
        # The REST filter is day-granular; exact nominal-window filtering occurs
        # locally after every page has been validated.
        created_filter = (
            f"{start.date().isoformat()}..{end.date().isoformat()}"
        )
        while True:
            payload = self._get(
                f"/actions/workflows/{workflow_id}/runs",
                {
                    "event": SCHEDULED_EVENT,
                    "created": created_filter,
                    "per_page": 100,
                    "page": page,
                },
            )
            if not isinstance(payload, dict) or not isinstance(
                payload.get("workflow_runs"), list
            ):
                raise GuardError("GitHub scheduled-runs response is malformed")
            raw_runs = payload["workflow_runs"]
            for run in raw_runs:
                if not isinstance(run, dict):
                    raise GuardError("GitHub scheduled-runs entry is not an object")
                results.append(parse_run_metadata(run, require_started_at=False))
            if len(raw_runs) < 100:
                break
            page += 1
            if page > 100:
                raise GuardError("scheduled duplicate election exceeded pagination limit")
        return results


def _event_schedule(event_path: str) -> str:
    try:
        payload = json.loads(Path(event_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise GuardError(f"GITHUB_EVENT_PATH cannot be read: {exc}") from exc
    schedule = payload.get("schedule") if isinstance(payload, dict) else None
    if not isinstance(schedule, str) or not schedule:
        raise GuardError("scheduled event payload is missing schedule")
    return schedule


def _required_env(name: str, env: Mapping[str, str]) -> str:
    value = env.get(name)
    if not value:
        raise GuardError(f"{name} is missing")
    return value


def run_from_environment(
    workflow: str,
    *,
    env: Mapping[str, str] | None = None,
    now: datetime | None = None,
    client_factory: type[GitHubActionsClient] = GitHubActionsClient,
) -> GuardResult:
    values = os.environ if env is None else env
    event_name = _required_env("GITHUB_EVENT_NAME", values)
    run_id = _positive_int(_required_env("GITHUB_RUN_ID", values), "GITHUB_RUN_ID")
    run_attempt = _positive_int(
        _required_env("GITHUB_RUN_ATTEMPT", values), "GITHUB_RUN_ATTEMPT"
    )
    observed_now = (now or datetime.now(UTC)).astimezone(UTC)

    if event_name == MANUAL_EVENT:
        return evaluate_manual(
            workflow=workflow,
            run_id=run_id,
            run_attempt=run_attempt,
            started_at=observed_now,
        )
    if event_name != SCHEDULED_EVENT:
        raise GuardError(f"unsupported GitHub event: {event_name}")

    cron = _event_schedule(_required_env("GITHUB_EVENT_PATH", values))
    client = client_factory(
        api_url=_required_env("GITHUB_API_URL", values),
        repository=_required_env("GITHUB_REPOSITORY", values),
        token=_required_env("GITHUB_TOKEN", values),
    )
    current = client.get_run(run_id)
    if current.run_id != run_id:
        raise GuardError("API run ID does not match GITHUB_RUN_ID")
    if current.run_attempt != run_attempt:
        raise GuardError("API run attempt does not match GITHUB_RUN_ATTEMPT")
    scheduled_at, next_scheduled_at = resolve_nominal(
        workflow, cron, current.created_at
    )
    scheduled_runs = client.list_scheduled_runs(
        workflow_id=current.workflow_id,
        start=scheduled_at,
        end=next_scheduled_at,
    )
    return evaluate_scheduled(
        workflow=workflow,
        cron=cron,
        current=current,
        scheduled_runs=scheduled_runs,
    )


def _error_payload(
    *, workflow: str, reason: str, env: Mapping[str, str], now: datetime
) -> dict[str, object]:
    run_id_raw = env.get("GITHUB_RUN_ID", "0")
    run_attempt_raw = env.get("GITHUB_RUN_ATTEMPT", "0")
    try:
        run_id = int(run_id_raw)
    except ValueError:
        run_id = 0
    try:
        run_attempt = int(run_attempt_raw)
    except ValueError:
        run_attempt = 0
    return {
        "scheduledAt": None,
        "startedAt": _format_timestamp(now),
        "latenessMinutes": None,
        "deadline": None,
        "decision": "SKIP",
        "reason": f"metadata_config_clock_error: {reason}",
        "workflow": workflow,
        "runId": run_id,
        "runAttempt": run_attempt,
    }


def append_summary(payload: Mapping[str, object], *, error: bool = False) -> None:
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary_path:
        raise GuardError("GITHUB_STEP_SUMMARY is missing")
    title = "ERROR" if error else str(payload["decision"])
    lines = [
        f"## Late-run guard: {title}",
        "",
        "| Field | Value |",
        "| --- | --- |",
    ]
    for field in (
        "workflow",
        "runId",
        "runAttempt",
        "scheduledAt",
        "startedAt",
        "latenessMinutes",
        "deadline",
        "decision",
        "reason",
    ):
        value = payload.get(field)
        lines.append(f"| {field} | {value if value is not None else 'null'} |")
    try:
        with Path(summary_path).open("a", encoding="utf-8") as summary:
            summary.write("\n".join(lines) + "\n")
    except OSError as exc:
        raise GuardError(f"GITHUB_STEP_SUMMARY cannot be written: {exc}") from exc


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Scheduled workflow late-run guard")
    parser.add_argument("--workflow", required=True, choices=sorted(POLICIES))
    args = parser.parse_args(list(argv) if argv is not None else None)
    now = datetime.now(UTC)
    try:
        result = run_from_environment(args.workflow, now=now)
        payload = result.as_dict()
        if result.decision == "SKIP":
            append_summary(payload)
            print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
            return EXIT_SKIP
        print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
        return EXIT_RUN
    except GuardError as exc:
        payload = _error_payload(
            workflow=args.workflow, reason=str(exc), env=os.environ, now=now
        )
        print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
        try:
            append_summary(payload, error=True)
        except GuardError as summary_exc:
            print(f"late-run guard summary error: {summary_exc}", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
