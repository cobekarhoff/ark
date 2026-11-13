---
id: ARK-T323
title: ARK-T323 the head pass of ark test skips the suite of a repo the run has no worktree for, prints the skipped line, and runs nothing there
level: integration
technique: equivalence classes (suite repo is `.`, a repo with a worktree, a repo with no worktree)
priority: high
risk: the head pass runs the suite of an untouched repo against the live workspace clone (marker file written), or records a skip or result for it, so a case verified by that suite reads `not run` instead of `missing`
status: active
changed_by: 2026-11-12-ARK-416-1
---

## Objective

Prove that on the head pass `ark test` runs a suite only when its repo is `.` or has a `worktree.created` event in the run. For every other suite it prints `skipped <suite> (repo <repo> not in run)`, runs no command in that repo, and leaves no trace in the results of the run.

Expected: When a suite's repo is not `.` and has no worktree in the run, the system shall not run the suite, shall print the skipped line, and shall record nothing for it.

## Preconditions

- A fixture workspace with repos `a` and `b` (git repos with a base commit) and an `ark.yml` with one suite for each repo plus one suite for `.`.
- Each suite command writes a marker file: the suite of `a` writes `a.marker` and the suite of `b` writes `b.marker`, both outside the worktree so the clone stays clean.
- A run with a `worktree.created` event for `a` only (a worktree for `a`; none for `b`).
- A third suite whose repo is `.` writes `dot.marker`, also outside the worktree.
- A test case `FAKE-T1` in the run's ticket: criterion `AC1` (`method: test`) has `verified_by: [FAKE-T1]`. The only test titled `FAKE-T1 ...` lives in the test file that the suite of `b` runs; no suite of `a` or `.` has a test with that id.

## Steps

1. Run `ark test <run>` (head pass) in the fixture.
2. Read the output (the `AC1` line `via FAKE-T1 <status>`), the marker files, the `test.completed` event in the run's `events.ndjson`, and the folder `results/` of the run.

## Expected results

- `a.marker` exists: the suite of the touched repo ran.
- `b.marker` does not exist: no command ran in repo `b`.
- The output has the line `skipped <suite of b> (repo b not in run)`.
- The `suites` array of the `test.completed` event has an entry for the suites of `a` and `.` and none for the suite of `b`; `results/<b suite>.log` and `results/base-<b suite>.log` do not exist (those of `a` and `.` do).
- The suite of `b` is not in `headRun.skipped`: the line `suite <name> head  skipped  (...)` is not printed for it, and the status of `FAKE-T1` is read from the `ark test` output line for `AC1`: `via FAKE-T1 missing`, not `via FAKE-T1 not run` (the `skipped` reason in `test-run.ts` makes `caseStatus` return `not run` when any suite is in `headRun.skipped`).
- The suite of `.` ran: `dot.marker` exists.

## Screenshot checkpoints

None, CLI output.
