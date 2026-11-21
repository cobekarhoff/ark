---
id: ARK-T687
title: ARK-T687 ark chief handover started through spawnArk starts the new Master Chief when the fake orca answers its terminal list after 2.5 s, and fails with Orca did not answer when the test sets the Orca limit to 2 s
level: integration
technique: state transition (terminal list answers late, answers in time) with a control run that holds the Orca limit at 2 s
priority: high
risk: the limits that spawnArk sets (ARK_ORCA_TIMEOUT_MS 60000, ARK_READER_TIMEOUT_MS 30000) do not reach the ark process or do not reach the terminal list read of chief handover, so a chief test that reads a fake orca on a loaded host fails with Orca did not answer at a 2 s limit (ARK-244-AC2 of test/chief.test.ts, 5 failures); or terminal list keeps the reader limit and ignores ARK_ORCA_TIMEOUT_MS, so the control never fails and the test cannot shorten the limit that governs the read (ARK-642); or the limit hides a slow terminal list for good, so the control never fails and the green row proves nothing
status: active
changed_by: 2026-11-21-ARK-642-1
---

## Objective

Prove through the real boundary that `ark chief handover` reads `terminal list` with the Orca limit. The `ark` process that `spawnArk` of `test/helpers.ts` starts gets `ARK_ORCA_TIMEOUT_MS=60000` and `ARK_READER_TIMEOUT_MS=30000` unless the test sets them. `ark chief handover` reads `terminal list` through `readTerminals` (`cli/orca.ts`), which gives `terminal list` the same limit as `run-list`: `orcaTimeout(10_000)`, so `ARK_ORCA_TIMEOUT_MS` governs it and `ARK_READER_TIMEOUT_MS` does not. Against a fake orca that answers that call after 2.5 s, the command still starts the new Master Chief and prints its handle.

A control row proves the delay is real and that the Orca limit cuts the call: the same command, with the test having set `process.env.ARK_ORCA_TIMEOUT_MS=2000` before it calls `ark()`, fails with `Orca did not answer`. The reader limit stays at the 30 s of `spawnArk`, so only the Orca limit can cut the 2.5 s call. At base `terminal list` follows the reader limit, the 2 s Orca limit does not reach it, and the control exits 0 and starts a new Master Chief: the control is red at base. `ark chief state` is not used: it reads Orca with the 10 s `orcaTimeout` and passes before the change (see `evaluation.md` of ARK-503).

Expected: When the fake orca answers `terminal list` after 2.5 s, the system shall start the new Master Chief and print its handle; when `ARK_ORCA_TIMEOUT_MS` is 2000, the system shall fail with `Orca did not answer`.

## Preconditions

- The fake `orca` of `test/chief.test.ts` (`setScenario`, `callsTo`), with the delay setting for the verb `terminal list`: the script sleeps 2.5 s before it answers that verb only. `setScenario` removes the delay file, and the fresh temporary directory of `beforeEach` holds none, so no later test meets it. The delay is released by its own sleep, not by a test signal. Other verbs answer at once.
- One Master Chief Run for the project and one live connected Master Chief terminal in the workspace, and `agent launch --surface terminal` answering with the handle `term_new` (the scenario of ARK-244-AC2).
- `ARK_READER_TIMEOUT_MS` and `ARK_ORCA_TIMEOUT_MS` are not set in `process.env` of the test process before the steps; `test/chief.test.ts` does not call `installProcessFakes`.
- The override channel of the control row: the test sets `process.env.ARK_ORCA_TIMEOUT_MS = "2000"` before it calls `ark()`, and `afterEach` deletes it (and `ARK_READER_TIMEOUT_MS`). `spawnArk` puts its defaults first and `process.env` after them, so a value in `process.env` wins.

## Steps

1. Set the `terminal list` delay of the fake to 2.5 s.
2. Run `ark chief handover --project <project>` through the `ark` helper of the file. Read the exit code, stdout, stderr, the elapsed time and the calls to the fake orca.
3. Control: set `process.env.ARK_ORCA_TIMEOUT_MS = "2000"`, keep the delay at 2.5 s, and run the command of step 2 again. Read the exit code, stderr and the calls to the fake orca.

## Expected results

- Step 2: exit code 0, stdout `term_new`, stderr empty. Exactly one `agent launch` call is made. The run takes at least 2.5 s and finishes well before the 10 s production Orca limit and the 60 s limit of the helper.
- Step 3: the command exits non-zero with `Orca did not answer` on stderr (the text of `cli/chief.ts`) and starts nothing: no further `agent launch` call, so the total stays at one. The test could therefore shorten the limit that `spawnArk` sets, the Orca limit reached the `terminal list` read, and the 2.5 s delay in step 2 was really in force.
- The case does not assert the argv of the `agent launch` call, its prompt text or the handle of the old terminal. They belong to ARK-244-AC2 and ARK-T407.

## Screenshot checkpoints

none: a CLI case with a fake orca; there is no UI surface.
