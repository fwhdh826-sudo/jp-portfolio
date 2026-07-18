---
name: jp-portfolio-ticket-runner
description: Execute implementation, audit, and test-only tickets safely in the /Users/ryo/jp-portfolio repository. Use when Codex must honor an explicit ticket file allowlist, prohibit production changes when required, verify Git and remote state, run UTC/JST targeted and full tests plus TypeScript/build/diff checks, avoid unauthorized commit or push, and finish with an evidence-based COMPLETE or BLOCKED report.
---

# JP Portfolio Ticket Runner

Treat every ticket as a closed-scope contract. Work only in `/Users/ryo/jp-portfolio`. Never expand the ticket by inference.

## 1. Read repository instructions first

Perform this step before Git inspection, ticket analysis, tests, or edits.

1. Enter `/Users/ryo/jp-portfolio`.
2. Read the root `AGENTS.md` completely. If it is absent, use the AGENTS instructions supplied by the environment or user. If neither exists, report `BLOCKED`.
3. Read `handover.md` completely, in chunks through EOF. Do not rely only on its first or last section.
4. After identifying the allowed paths, read every additional `AGENTS.md` that governs those paths.
5. Resolve instruction conflicts by precedence. If the ticket cannot satisfy a higher-priority instruction, report `BLOCKED`.

Do not modify `AGENTS.md` or `handover.md` unless the ticket explicitly allows the exact file.

## 2. Freeze the ticket contract

Read [references/ticket-contract.md](references/ticket-contract.md) every time. Extract and state:

- ticket ID and objective;
- mode: `implementation`, `audit`, or `test-only`;
- exact repository-relative allowed paths;
- whether production changes are allowed;
- targeted test files or an explicit deterministic selection rule;
- expected branch and upstream;
- separate authorization for commit and push.

Treat missing or ambiguous mode, allowed paths, production policy, or targeted-test scope as `BLOCKED`. Do not interpret a directory, glob, “related files,” or “as needed” as permission unless the ticket explicitly uses that scope. An explicit empty allowlist is valid for a read-only audit.

## 3. Capture the Git and remote baseline

Run read-only checks and retain their exact output for the final report:

```bash
git branch --show-current
git rev-parse HEAD
git remote -v
git status --short --branch
git status --porcelain=v1 --untracked-files=all
git diff --name-only
git diff --cached --name-only
git worktree list --porcelain
git rev-parse --abbrev-ref --symbolic-full-name '@{u}'
```

Then run `git fetch --prune origin`. Resolve the upstream OID and calculate ahead/behind without merging, rebasing, pulling, checking out, or resetting:

```bash
git rev-parse '@{u}'
git rev-list --left-right --count 'HEAD...@{u}'
```

Apply these gates:

- Report `BLOCKED` if the expected branch does not match.
- Report `BLOCKED` for change-bearing work on `main`.
- Report `BLOCKED` if no required remote/upstream can be verified.
- Report `BLOCKED` if the branch is behind or diverged from upstream. Never auto-resolve a remote conflict.
- If the branch is already ahead, continue only when the ticket explicitly acknowledges the existing local commits; otherwise report `BLOCKED`.
- Preserve all pre-existing working-tree and index changes. If a pre-existing change overlaps an allowed path that must be edited, report `BLOCKED`. Do not stage, rewrite, or clean unrelated user changes.

Record the fetched upstream OID as the remote baseline.

## 4. Enforce the mode and file boundary

### Implementation

Modify only explicitly allowed paths. If production changes are forbidden, treat every ambiguous file as production and do not touch it.

### Audit

Keep the audit read-only. Do not persist repository changes. If a mandatory command creates generated output, remove only output created during this run and verify that the repository returns to its baseline state.

### Test-only

Modify only explicitly allowed test, fixture, or test-helper paths. Do not edit runtime code, production configuration, dependencies, build/deploy files, or generated production artifacts.

Use the production classification in [references/ticket-contract.md](references/ticket-contract.md). The ticket allowlist and the production prohibition are independent gates: a path must pass both.

After every edit or formatter, compare the current state with the captured baseline:

```bash
git status --porcelain=v1 --untracked-files=all
git diff --name-only
git diff --cached --name-only
```

Stop immediately on an out-of-scope path. Undo only changes created during this run, using a precise inverse patch when safe. Never use destructive cleanup, `git reset --hard`, broad checkout/restore, or removal that could affect pre-existing work. If safe separation is impossible, leave evidence intact and report `BLOCKED`.

Do not change tests merely to weaken assertions, skip failures, or hide a production defect. Do not update snapshots unless the ticket explicitly authorizes the exact snapshot files and the new output is reviewed.

## 5. Run the mandatory validation matrix

Run all commands from the repository root. Select targeted test files from the frozen contract; do not silently substitute a smaller set.

```bash
TZ=UTC npx vitest run <targeted-test-files>
TZ=Asia/Tokyo npx vitest run <targeted-test-files>
TZ=UTC npm run test:unit
TZ=Asia/Tokyo npm run test:unit
npx tsc --noEmit
npm run build
git diff --check
```

Record command, timezone, exit status, file/test counts, skipped count, and relevant warnings. Require both UTC and JST targeted/full runs. Treat an unavailable command, unexpected skip, timeout, failure, or inability to identify targeted tests as `BLOCKED`; do not weaken the matrix. A ticket may alter this matrix only by an explicit higher-priority instruction.

After validation, re-run the scope checks. Confirm that build or test tooling did not leave out-of-scope tracked or untracked files.

## 6. Recheck remote state and finish Git actions

Before any commit or push:

1. Run `git fetch --prune origin` again.
2. Compare the current upstream OID with the recorded remote baseline.
3. Report `BLOCKED` if upstream moved, disappeared, or cannot be verified. Do not pull, merge, or rebase.
4. Recheck every changed and staged path against the initial baseline, allowlist, mode, and production policy.

Do not commit unless the ticket explicitly authorizes commit. Do not push unless it explicitly authorizes push. Treat the two permissions independently.

When commit is authorized, stage only ticket-owned allowed paths and inspect `git diff --cached --name-only` plus `git diff --cached` before committing. When push is authorized, require a non-`main` branch, never force-push, and push only the current ticket branch. Never push directly to `main`.

After authorized Git actions, capture final branch, HEAD, upstream, ahead/behind, and working-tree status.

## 7. Report exactly one terminal status

Report `COMPLETE` only when the requested work is finished, all scope gates hold, all mandatory checks pass, and remote state remains safe. Otherwise report `BLOCKED`; do not use partial-success labels.

Use the report schema in [references/ticket-contract.md](references/ticket-contract.md). Include UTC and JST completion timestamps, changed files, production-file status, validation evidence, Git actions performed or withheld, final Git state, and any remaining risk. For `BLOCKED`, identify the exact gate, preserve command evidence, and state the minimal user action needed to resume.
