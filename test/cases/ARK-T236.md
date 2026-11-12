---
id: ARK-T236
title: "ARK-T236 after the suite hook ends, no test-runner process of a fake run remains, even one that ignores SIGTERM"
level: integration
technique: "state transition (runner alive, then hook ends, then gone) with a runner that traps SIGTERM"
priority: high
risk: "A suite ends with its `test-runner` child alive under parent pid 1 (a timeout, a failure before the run id is known, or a runner that ignores SIGTERM), so orphans pile up, busy-poll and push the host load to 60"
status: active
changed_by: 2026-11-10-ARK-419-1
---

## Objective

Prove the `afterEach` cleanup of each of the three suites leaves no `test-runner` process of a run the suite started, including a runner that ignores SIGTERM, and leaves a runner it did not start alone.

## Preconditions

- Temp `ARK_HOME`, temp git repo, two fake runs with different ids. The target `FAKE-1` is started through the suite's own helper (`buildingRun`, `startRun` or the evidence helper), so the hook under test owns it. The control `FAKE-2` is started by the test itself, directly (spawning the `test-runner` entry point for `FAKE-2` detached), never through the suite helper: the hook's registry of started runs does not contain it, and it needs no admission through the helper.
- A healthy fake host reading (`setFakeHost` with the shared healthy reading, 50 percent free, 2 GB swap), so admission lets both runners start their suite at once.
- The suite command of `FAKE-1` is a shell script that runs `trap '' TERM`, writes a started marker and sleeps 300 seconds. The runner then sits in its own SIGTERM handler (`runnerMain` in `cli/test-runner.ts`, which awaits `stopChildren`, the grace time before SIGKILL of the suite group). That is the resistance, in the runner process itself: it does not exit at once on SIGTERM.
- The suite command of `FAKE-2` is a plain `sleep 300` with a started marker. `FAKE-2` is test-owned, registered only in the test's own cleanup (not the hook under test), and never a real ticket's run. It is the live control. The healthy fake host reading gives it admission capacity, so both started markers appear while `FAKE-1` sits in its SIGTERM handler.
- The id of each run the helper starts (`FAKE-1`) is recorded where the fixture starts it, including a run that fails before the test reads its id.

## Steps

1. Start `FAKE-1` through the suite helper and `FAKE-2` directly from the test, both in the background; wait for both started markers; list `ps -axo pid,ppid,command` and record the pids of `test-runner FAKE-1` and `test-runner FAKE-2`.
2. Probe the resistance: send SIGTERM to the `FAKE-1` runner pid only; wait 500 ms; check that pid with `kill -0`.
3. Run the suite's cleanup hook (`afterEach`) once.
4. Poll `ps -axo pid,ppid,command` for up to 5 seconds for `test-runner FAKE-1`, and check the recorded `FAKE-2` pid with `kill -0`.
5. Repeat steps 1 and 3 to 4 for a run whose start fails before the helper returns its id (the id is recorded first).
6. Repeat for each of the three suites.
7. Clean up `FAKE-2` independently, in the test's own final cleanup (runs even if an assertion failed): SIGKILL its recorded pid and its suite group, not in the hook under test.

## Expected results

- Step 1: both runner processes exist (the case can fail).
- Step 2: the `FAKE-1` runner is still alive 500 ms after SIGTERM: resistance is observed in the exact process the hook must end. Without this the case stops here.
- Step 4: no process with `test-runner FAKE-1` remains, and none has parent pid 1, although SIGTERM alone did not end it (SIGKILL or the grace time of `stopChildren`). The `FAKE-2` runner pid is still alive: the hook stops the runs it started and does not kill every `test-runner`.
- Step 5: the id is recorded and its runner process is gone.
- Step 6: the same for `test/test-run.test.ts`, `test/evidence-test-run.test.ts` and `test/test-selection.test.ts`.
- Step 7: the control is gone, so the case leaves no process behind.

## Screenshot checkpoints

None. The surface is processes and files; no screenshot applies.
