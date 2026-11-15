---
id: ARK-T671
title: ARK-T671 finishing an implementer step is refused when the run's diff changes a test whose case id the plan test_cases does not list, and the message names the ids and the ark plan hint
level: integration
technique: equivalence classes (listed id, unlisted id) over ids in one diff; error guessing on message content
priority: high
risk: "a touched case id missing from the plan passes implementer finish, so the miss surfaces only in the validator's full ark test after 15 to 25 minutes; only the first unlisted id is reported; the refusal omits an id, the test file or the ark plan hint; the refusal still appends step.finished, so the step is stuck finished; the finish scan compares ids loosely and reports a listed id"
status: active
changed_by: 2026-11-14-ARK-496-1
---

## Objective

Prove that `ark run step <run> <step> finish` for an implementer step runs the plan membership check on the run's diff and refuses when a touched test holds a case id that `plan.yml` `test_cases` does not list. Serves ARK-496/AC1.

Expected: When an implementer step finishes and the diff from the run's base to HEAD changes a bun test whose title holds a case id that `test_cases` does not list, the command shall exit 1, print each missing id with its test file, print the hint to add the ids to `test_cases` and run `ark plan check <run>`, and append no `step.finished` event.

## Preconditions

- Fixture project and real git repo as the `ark test` integration tests of ARK-T346 build: a base commit with a bun test file whose tests are titled `ARK-T1 ...`, `ARK-T2 ...` and `ARK-T3 ...`, plus an untouched test titled `ARK-T9 ...`.
- A run in the `building` phase with an approved `plan.yml` that has one implementer step on that repo, `test_cases` listing only `ARK-T1`, and the step started.
- A commit in the step's worktree that edits the bodies of the `ARK-T1`, `ARK-T2` and `ARK-T3` tests.
- The real `ark` CLI, no stub for the scan.

## Steps

1. Run `ark run step <run> <step> finish`; read exit code, output and `events.ndjson`.
2. Read `ark status <run>` for the step.

## Expected results

- Step 1: exit 1. The output holds the line `case id not in plan test_cases: ARK-T2 in <test file>` and the same line for `ARK-T3`, the same line wording that `ark test` prints (ARK-T346). `ARK-T1` (listed) and `ARK-T9` (untouched) are not named. The output names `ark plan check <run>` and says to add the ids to `test_cases` first. No `step.finished` event is appended.
- Step 2: the step is still `running`, so the run lead can edit the plan and finish again.

## Screenshot checkpoints

none: CLI output, exit code and the event log; no UI.
