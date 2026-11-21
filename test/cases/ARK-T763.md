---
id: ARK-T763
title: ARK-T763 a bug run's implementer start needs every non-guard test AC failing in one ark test, and refuses a run whose test ACs are all guards
level: integration
technique: decision table over the guard flags of a bug run's test ACs (none, one of two, all) and the statuses of one test run (guard passing, failing, not run, missing; non-guard failing or passing), with state transition (criteria gate, ark test, implementer start) and an old event log
priority: high
risk: "redTest still demands every non-manual AC failing, so a bug run with a guard AC that holds at base can never start its implementer (the ARK-606 and ARK-612 rewrites); or it skips the guard but also a non-guard AC, so the implementer starts with no red proof; or it reads a guard only when the guard reads `passing`, so a guard that is `not run` in a quick red run is still demanded; or a run whose test ACs are all guards passes the start with no red proof at all, or gets the old message instead of `bug run: every AC is a guard; mark the AC that shows the bug`; or the guard set in criteria.yml never reaches the event log; or the replay of an old events.ndjson with no guard field throws or reads every AC as a guard"
status: active
changed_by: 2026-11-21-ARK-617-1
---

## Objective

Prove that `ark run step <run> <implementer step> start` in a `kind: bug` run counts only the non-guard `method: test` ACs in the red proof, refuses with today's text when the run has no guard and no red proof, and refuses a run whose `method: test` ACs are all guards with `bug run: every AC is a guard; mark the AC that shows the bug`. Serves ARK-617/AC1 (the red proof). The refusals of the criteria gate are ARK-T764.

Expected: Where a bug run has a non-guard `method: test` AC, the system shall start the implementer step once one `ark test` shows every non-guard `method: test` AC `failing`, whatever its guard ACs read. Where every `method: test` AC is a guard, the system shall refuse the start with `bug run: every AC is a guard; mark the AC that shows the bug`.

Authoring gate:

1. Protects: the bug-run gate of the implementer start (`redTest` in `cli/events.ts`, the `step.started` refusal in `cli/transitions.ts`) fed by the guard ids that the criteria gate writes into the log.
2. Fails when: `redTest` does not skip guard ids (row A turns red), skips more than the guards (row B), demands a guard status (rows C and D), lets an all-guards run start or prints the old text for it (rows E, F, G), the criteria gate drops the guard on the way into the event (row A), or the replay of an old log without the guard field throws or changes (row H).
3. Existing proof misses it: ARK-T62, ARK-T475, ARK-T720 and ARK-T740 own the rule for runs with no guard and stay as they are; none has a guard. This case owns the guard exemption and the all-guards refusal, at the `ark` process.
4. No test-only export, flag or hook: the guard reaches the log through the real `ark gate record <run> criteria accept --criteria <file>`, and the start is the real `ark run step`.

## Preconditions

- A temp `ARK_HOME` and project with a git repo and a test command, as `test/run.test.ts` (`startMethodRun`, `approvePlan` without its appended criteria accept) for rows B to H, and the fixture of ARK-T665 and ARK-T720 (`bugRun` in `test/test-run.test.ts` with two criteria, `installFakeOrca()`, AC1 verified by `FAKE-T1`, AC2 by `FAKE-T2`) for row A, which runs a real full `ark test`. The `failureSwitch` file does not exist, so the check `lint` passes.
- Each run is `kind: bug` and has a plan with an implementer step `build`. The criteria gate is answered with the real `ark gate record <run> criteria accept --criteria criteria.yml`, whose file holds the ACs of the row and `guard: true` on each guard AC, never with an appended `gate.answered`: the guard must reach the log the way a real run sends it.
- Rows B to H append `test.completed` events as ARK-T475 does (`passed: false`, `heads: {}`, `suites: []`, `criteria` as the row says). Row A runs a full `ark test`, not `--quick`: a quick run records a passing AC as `not run` (`quickStatus` in `cli/test-run.ts`), so only a full run gives the guard `passing`, the AC's own example. A guard that reads `not run` is row C.
- Before each start: the line count of `events.ndjson`.

## Steps

1. Row A (one real full ark test, the AC's own example). AC1 `method: test` (no flag), AC2 `method: test` with `guard: true`. The validator commit makes the `FAKE-T1` test fail and the `FAKE-T2` test pass. Run `ark test <run>` (full mode, as the ARK-T665 run that lets the implementer start), read its exit code, stdout and the last `test.completed`, then run `ark run step <run> build start`.
2. Row A without the flag: the same fixture and commit in a fresh run whose criteria file has no `guard` key. Run the same full `ark test`, then the start.
3. Row B (non-guard passing). AC1 `test`, AC2 `test` guard, AC3 `test`. Append a run with AC1 `failing`, AC2 `failing`, AC3 `passing`, then a run with AC1 `passing`, AC2 `passing`, AC3 `failing`. Run the start.
4. Row C (guard not run or missing). The run of row B, fresh. Append one run with AC1 `failing`, AC2 `not run`, AC3 `failing`. Run the start. In a second fresh run, append one run with AC1 and AC3 `failing` and no AC2 key at all. Run the start.
5. Row D (guard failing). The run of row B, fresh. Append one run with all three `failing`. Run the start.
6. Row E (all guards). AC1 and AC2 `test`, both `guard: true`. Run the start with no test run; then append a run with both `failing` and run the start again.
7. Row F (the only test AC is a guard). AC1 `test` with `guard: true`, AC2 `inspection`. Run the start with no test run, and again after an appended run with AC1 `failing` and AC2 `manual pending`.
8. Row G (a guard and a manual AC). AC1 `test` with `guard: true`, AC2 `demonstration`. Run the start with no test run.
9. Row H (old event log). A bug run whose `events.ndjson` holds `run.started`, a `criteria.updated` with only the `criteria` field, and a text `criteria.amended` of `AC2` with only `criterion`, `old`, `new`, `by` and `reason` (no `guard`, no `verified_by_new`: the shapes before this change, appended by hand), AC1 and AC2 `method: test`, no guard anywhere. Run `ark status <run>`, then the start; append a run with AC1 `failing` and AC2 `passing` and run the start; append a run with both `failing` and run the start.

## Expected results

- After each criteria gate: `ark gate record` exits 0, also for the all-guards runs of rows E, F and G (the all-guards refusal lives at the implementer start, not at the gate).
- Step 1: `ark test` exits 1 (`suite e2e failed`); stdout has `FAKE-1/AC1  failing` and `FAKE-1/AC2  passing`; the last `test.completed` has `mode: "full"` and `criteria: { "FAKE-1/AC1": "failing", "FAKE-1/AC2": "passing" }`. The start exits 0 and one `step.started` for `build` is recorded.
- Step 2: `ark test` records the same statuses; the start exits 1, stderr holds `bug run: record a failing ark test of the ACs before the fix` (today's text), and `events.ndjson` has the same line count as before the start.
- Step 3: exit 1 with the same text and no new event: a non-guard AC that read `passing` in each run leaves no red proof, and failing ACs spread over two runs are not one.
- Step 4: exit 0 in both runs: a guard needs no status at all.
- Step 5: exit 0: a guard that reads `failing` does not block the start.
- Step 6: both starts exit 1, stderr holds `bug run: every AC is a guard; mark the AC that shows the bug` and not the text of step 2, and no event is added; the run with every AC `failing` is refused the same way.
- Step 7: both starts exit 1 with `bug run: every AC is a guard; mark the AC that shows the bug`: "every AC" means every `method: test` AC, so an `inspection` AC does not make the run startable.
- Step 8: exit 1 with the same all-guards text.
- Step 9: `ark status` exits 0 and its stdout holds `amended criteria:` with the id of `AC2` (the old text event still reads as a text amendment); the first start and the start after the AC2 `passing` run exit 1 with today's text; the start after the run with both `failing` exits 0. The old log, with its field-less `criteria.updated` and `criteria.amended`, reads as a run with no guard.
- This case does not assert the criteria gate refusals (ARK-T764), the amend of a guard (ARK-T766), or the final test and the MR body (ARK-T765).

## Screenshot checkpoints

none: CLI and event-log case; no UI surface.
