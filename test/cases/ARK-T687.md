---
id: ARK-T687
title: ARK-T687 ark chief handover started through spawnArk starts the new Master Chief when the fake orca answers its terminal list after 2.5 s, and fails with Orca did not answer when the test sets the 2 s limit
level: integration
technique: state transition (terminal list answers late, answers in time) with a control run that holds the limit at 2 s
priority: high
risk: the raised reader limit reaches only the process of the test (installProcessFakes sets process.env) and not the ark process that spawnArk starts, so a chief test that reads a fake orca on a loaded host fails with Orca did not answer at the 2000 ms limit (ARK-244-AC2 of test/chief.test.ts, 5 failures); or the raise cannot be overridden by the test, so no case can prove the 2 s limit through spawnArk; or the raise hides a slow terminal list for good, so the control never fails and the green row proves nothing
status: active
changed_by: 2026-11-15-ARK-503-1
---

## Objective

Prove AC2 of ARK-503 through the real boundary: the `ark` process that `spawnArk` of `test/helpers.ts` starts has a reader limit of 30 s without the test setting it. `ark chief handover` reads `terminal list` through `readTerminals` (`cli/orca.ts`), which uses the reader default and not `ARK_ORCA_TIMEOUT_MS`. Against a fake orca that answers that call after 2.5 s, the command still starts the new Master Chief and prints its handle.

A control row proves the delay is real and that a test can override the raise: the same command, with the test having set `process.env.ARK_READER_TIMEOUT_MS=2000` before it calls `ark()`, fails with `Orca did not answer`. `ark chief state` is not used: it reads Orca with the 10 s `orcaTimeout` and passes before the change (see `evaluation.md`).

Expected: When a test starts an ark process through `spawnArk`, the system shall give it a reader timeout of 30 s unless the test sets `ARK_READER_TIMEOUT_MS` itself.

## Preconditions

- The fake `orca` of `test/chief.test.ts` (`setScenario`, `callsTo`), with a new delay setting for the verb `terminal list`: the script sleeps 2.5 s before it answers that verb only. `setScenario` removes the delay file, and the fresh temporary directory of `beforeEach` holds none, so no later test meets it. The delay is released by its own sleep, not by a test signal. Other verbs answer at once.
- One Master Chief Run for the project and one live connected Master Chief terminal in the workspace, and `agent launch --surface terminal` answering with the handle `term_new` (the scenario of ARK-244-AC2).
- `ARK_READER_TIMEOUT_MS` is not set in `process.env` of the test process before the steps; `test/chief.test.ts` does not call `installProcessFakes`. `ARK_ORCA_TIMEOUT_MS` is not set.
- The override channel of the control row: the test sets `process.env.ARK_READER_TIMEOUT_MS = "2000"` before it calls `ark()`, and `afterEach` deletes it. `spawnArk` puts its 30000 first and `process.env` after it, so a value in `process.env` wins.

## Steps

1. Set the `terminal list` delay of the fake to 2.5 s.
2. Run `ark chief handover --project <project>` through the `ark` helper of the file. Read the exit code, stdout, stderr, the elapsed time and the calls to the fake orca.
3. Control: set `process.env.ARK_READER_TIMEOUT_MS = "2000"`, keep the delay at 2.5 s, and run the command of step 2 again. Read the exit code, stderr and the calls to the fake orca.

## Expected results

- Step 2: exit code 0, stdout `term_new`, stderr empty. Exactly one `agent launch` call is made. The run takes at least 2.5 s and finishes well before 30 s.
- Step 3: the command exits non-zero with `Orca did not answer` on stderr (the text of `cli/chief.ts`) and starts nothing: no `agent launch` call. The test could therefore override the value that `spawnArk` sets, and the 2.5 s delay in step 2 was really in force.
- The case does not assert the argv of the `agent launch` call, its prompt text or the handle of the old terminal. They belong to ARK-244-AC2 and ARK-T407.

## Screenshot checkpoints

none: a CLI case with a fake orca; there is no UI surface.
