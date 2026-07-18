# Ticket Contract and Decision Rules

Read this reference for every ticket run.

## Required ticket contract

Normalize the ticket into the following fields before doing work:

```text
ticket_id: <stable identifier>
objective: <one bounded outcome>
mode: implementation | audit | test-only
allowed_paths:
  - <exact repository-relative file path>
production_changes: allowed | forbidden
targeted_tests:
  - <exact test file or explicit deterministic selection rule>
expected_branch: <branch>
expected_upstream: <remote/branch>
commit_authorized: yes | no
push_authorized: yes | no
```

Use `no` for commit and push unless the user or ticket explicitly says otherwise. Do not infer authorization from “finish,” “complete,” an existing commit convention, or handover history.

For an audit, allow `allowed_paths: []` only when it is explicitly read-only. A ticket that permits an audit report file must name that file. For a test-only ticket, require every writable path to be a test, fixture, or test-only helper and explicitly list it.

## Path rules

- Resolve every path relative to `/Users/ryo/jp-portfolio`.
- Reject paths that escape the repository, contain unresolved variables, or rely on implicit shell expansion.
- Treat renames and deletions as changes to both the source and destination path.
- Treat generated files, snapshots, lockfiles, and formatting changes as changes requiring permission.
- Treat a directory or glob as allowed only when the ticket states that exact directory or glob.
- Do not add “necessary” companion files without explicit permission; report `BLOCKED` and request the smallest allowlist extension.

## Production-file classification

Classify a file as production when it can affect runtime behavior, stored data, build output, deployment, dependencies, or release configuration. This normally includes:

- runtime source under `src/`, excluding clearly named test-only files;
- runtime source under `backend/`, excluding `backend/tests/` and clearly test-only helpers;
- public/static assets consumed by the application;
- package manifests and lockfiles;
- TypeScript, Vite, Vitest, lint, build, environment, workflow, deploy, and GitHub Pages configuration;
- schemas, migrations, persistence contracts, generated runtime data, and production scripts.

Test files normally match `*.test.*`, `*.spec.*`, `__tests__/`, `backend/tests/`, or an explicitly documented fixture/test-helper path. A test-looking file is not automatically allowed: the ticket must still authorize it. When classification is uncertain, classify the file as production.

For `production_changes: forbidden`, do not edit a production file even if it appears in the allowlist. Treat the conflict as `BLOCKED` unless the ticket is corrected.

## Remote-conflict rules

Use the fetched upstream branch as the authority. Report `BLOCKED` without auto-reconciliation when:

- local HEAD is behind upstream;
- local and upstream have diverged;
- upstream moves between initial preflight and final recheck;
- the expected upstream disappears or cannot be fetched;
- an existing ahead state is not explicitly acknowledged by the ticket;
- a push is rejected because the remote changed.

An ahead-only state created by the current ticket is not a remote conflict. A new remote branch is allowed only when the ticket explicitly authorizes creating and pushing that non-`main` branch.

## Terminal decision table

Use `COMPLETE` only if every applicable row passes:

| Gate | COMPLETE condition |
| --- | --- |
| Instructions | AGENTS instructions and all of `handover.md` were read first |
| Contract | Mode, scope, production policy, tests, branch, and Git permissions are explicit |
| Baseline | Branch, HEAD, remotes, upstream, worktree, index, and untracked files were captured |
| Remote | Upstream was fetchable, not ahead of local baseline, and unchanged at final recheck |
| Scope | Every ticket-owned change is allowlisted; pre-existing work is untouched |
| Production | No production file changed when production changes are forbidden |
| Tests | Targeted and full suites pass in both UTC and Asia/Tokyo with no unexpected skips |
| Static checks | `npx tsc --noEmit`, `npm run build`, and `git diff --check` pass |
| Git actions | Commit/push match explicit permission; no direct push to `main` occurred |
| Outcome | The bounded ticket objective is fully met |

Any failed or unverifiable gate yields `BLOCKED`.

## Final report schema

Start the report with exactly one terminal status:

```text
COMPLETE — <ticket_id>
```

or:

```text
BLOCKED — <ticket_id>
```

Then include:

```text
Objective:
Mode:
Allowed paths:
Production changes: allowed | forbidden

Initial Git state:
- branch:
- HEAD:
- upstream and OID:
- ahead/behind:
- pre-existing working-tree/index changes:

Files changed by this ticket:
- <path and concise purpose, or none>

Validation:
- UTC targeted: <command; files/tests/skips; PASS|FAIL>
- JST targeted: <command; files/tests/skips; PASS|FAIL>
- UTC full: <command; files/tests/skips; PASS|FAIL>
- JST full: <command; files/tests/skips; PASS|FAIL>
- tsc: PASS|FAIL
- build: PASS|FAIL
- git diff --check: PASS|FAIL

Git actions:
- commit: <withheld or hash>
- push: <withheld or remote ref>

Final Git state:
- branch:
- HEAD:
- upstream and OID:
- ahead/behind:
- working tree:

Completed at:
- UTC: <ISO-8601>
- JST: <ISO-8601 with +09:00>

Remaining risks:
- <risk or none>
```

For `BLOCKED`, add:

```text
Blocking gate:
Evidence:
Resume requirement:
```

Report test failures accurately; do not relabel them as unrelated. Distinguish pre-existing changes from ticket-owned changes. State explicitly when commit and push were withheld because authorization was absent.
