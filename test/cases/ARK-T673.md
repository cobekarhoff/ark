---
id: ARK-T673
title: ARK-T673 finish --failed and finish --failed --not-started of an implementer step are not refused when the diff touches an unlisted case id
level: integration
technique: equivalence classes of finish outcome (success, failed, not-started) against a diff that fails the plan check
priority: high
risk: "the plan check also blocks a failed or dead worker's finish, so the run lead cannot record the failure and the step stays running; the failed finish runs the scan and fails on it"
status: active
changed_by: 2026-11-14-ARK-496-1
---

## Objective

Prove that the implementer-finish plan check does not apply to a failed finish. Serves ARK-496/AC1. Control for ARK-T671, as ARK-T334 is for the dirty guard.

Expected: When an implementer step finishes with `--failed` or with `--failed --not-started`, the command shall not run the plan membership check, shall exit 0 and shall append `step.finished` with outcome `failed`, even when the diff touches a case id that `test_cases` does not list.

## Preconditions

- The state of ARK-T671 before step 1: a started implementer step whose commit edits the `ARK-T2` test, and `test_cases` listing only `ARK-T1`.
- A second started implementer step on the same plan with no commit, for the `--not-started` variant.

## Steps

1. Run `ark run step <run> <step> finish --failed`; read exit code and events.
2. On the second step run `finish --failed --not-started`.

## Expected results

- Step 1: exit 0, no `case id not in plan test_cases` line, a `step.finished` event with outcome `failed`.
- Step 2: exit 0 and a `step.finished` event for that step with `not_started` set.

## Screenshot checkpoints

none: CLI output, exit code and the event log; no UI.
