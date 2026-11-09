---
id: ARK-T135
title: ARK-T135 ark test records the suites, the head of each worktree, the mode and the duration, and exits 0 when every AC passes
level: integration
technique: state transition (run passes, one event written) with an exit-code check
priority: high
risk: test.completed misses the suites, heads, mode or duration, so a stale or quick result passes the MR gate; or ark test exits non-zero on a fully proved run
status: active
changed_by: 2026-11-08-ARK-389-1
---

## Objective

Prove that a plain `ark test` on a run whose every AC has a passing tagged test writes one `test.completed` event with the suites, the head of each worktree, `mode: full` and a numeric `duration`, and exits 0. Serves ARK-389/AC3 and AC5.

Expected: When every AC has a passing test, the system shall record the suites, heads, mode and duration in test.completed and exit 0.

## Preconditions

- A building run with a unit suite and an e2e suite, two ACs, a passing tagged e2e test for each and one plain passing unit test.
- One empty commit on the run branch, so the run head differs from the workspace head.

## Steps

1. Run `ark test <run>` (no `--quick`).
2. Read the `test.completed` event and the exit code.

## Expected results

- Exit code 0.
- The event holds `passed: true`, `heads` with the run branch head (not the workspace head), the suites `unit` and `e2e` each passed, both criteria `passing`, `mode: full` and a numeric `duration`.
- `results/e2e.report` and `results/e2e.log` hold the test names and log lines.

## Screenshot checkpoints

none: integration case on CLI output and events; no UI surface.
