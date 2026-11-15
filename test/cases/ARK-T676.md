---
id: ARK-T676
title: ARK-T676 implementer finish skips with a printed line when the scan fails, and scans only the bun suites of the step's repo that has a base commit
level: integration
technique: error guessing (a git failure in the scan) and equivalence classes of suite (step repo, other repo, non-bun parser, repo with no base commit)
priority: medium
risk: "a scan failure (an unreadable base commit, a failing git diff) aborts the finish with a stack trace or refuses it, so the step is stuck over a tool fault; the failure is silent; the step reads a suite of another repo that it did not change and is refused for that repo's cases; a pytest or behave suite is parsed as bun and reports false ids; a repo with no base commit crashes the finish or is refused"
status: active
changed_by: 2026-11-14-ARK-496-1
---

## Objective

Prove the skip rules of the finish check: a failed scan skips with a printed line; a suite of another repo is not scanned by this step; a non-bun suite or a repo with no base commit prints no line. Serves ARK-496/AC1. The plan-membership `scan failed` skip has no other owning case: ARK-T207 owns the skip of the old-id check and ARK-T346 the missing-plan skip.

Expected: When the scan of a suite fails, the command shall print `plan-membership suite <name> (bun)  skipped  (scan failed: <reason>)` and finish. The command shall scan only the suites of the step's repo (`ark test` scans the suites of every repo). For a suite with a parser other than `bun`, or a repo with no base commit, the command shall print no line, as the plan-membership loop of `ark test` does (`cli/test-run.ts:1175-1186`: `continue` when `suite.parser !== "bun" || base === undefined`). Only a missing or invalid plan and a failed scan print a skip line; a `--merge` step prints none (ARK-T674).

## Preconditions

- A two-repo run: repos A and B, each with a bun suite and a base test file with `ARK-T1`; `ark.yml` suites for both and a third suite with parser `pytest` on repo A. The implementer step is on repo A.
- Repo B's worktree has a committed edit of an `ARK-T2` test that `test_cases` does not list. Repo A's step commit edits no case id.
- For the no-base variant: repo A's `worktree.created` event has no `base` (`RunState.worktrees[].base` is optional) and there is no `worktree.synced` event for repo A.
- For the failure variant: a `worktree.synced` event for repo A whose `target_commit` is a commit id that is not in the repo, so `git diff` of the scan fails.

## Steps

1. Run `finish` for the repo A step on the run without the bad `target_commit`; read exit code and output.
2. Use the run whose repo A `worktree.created` carries no base; run `finish` on a fresh started step.
3. Add the `worktree.synced` event with the unknown commit (repo A's base restored) and run `finish` on a fresh started step.

## Expected results

- Step 1: exit 0, no mention of `ARK-T2` (repo B's suite is not scanned by repo A's step), no `skipped` line for the pytest suite or repo B's suite, one `step.finished` event.
- Step 2: exit 0, no `skipped` line and no `case id not in plan test_cases` line (nothing is scanned without a base), no stack trace, one `step.finished` event.
- Step 3: exit 0, a printed line `plan-membership suite <name> (bun)  skipped  (scan failed: ...)`, no stack trace, one `step.finished` event.

## Screenshot checkpoints

none: CLI output, exit code and the event log; no UI.
