---
id: ARK-T715
title: ARK-T715 the ARK-T707 test "takes its own ticket under the marker of a run that has ended" passes, and its taking run exits under 5 s after the case closes the FIFO writer, when the writer closes during the pause after the fake test writes ran-x
level: integration
technique: race made deterministic by a delayed fixture (boundary value, the writer closes inside the window after the marker), plus a validator evidence run of repeats on a loaded shard
priority: high
risk: the fake test of `makeProbeRepo` with `hold` set writes `ran-x` and only then opens its FIFO for reading; the case sees `ran-x`, calls `release()` (closes its read-write descriptor), the child then opens a FIFO that has no writer and blocks forever, so `finish(taking)` times out at 20 s with `no exit of the child` on a loaded CI shard (2 of 2 attempts of PR #265, passing in 173, 254 and 495 ms on idle hosts)
status: active
changed_by: 2026-11-20-ARK-596-1
---

## Objective

Prove that the ARK-T707 test of the free-cores run does not depend on how fast the child gets from the `ran-x` marker to its FIFO: the writer closes during the delay after `ran-x` is written, the test still passes, and the taking run exits under 5 s after the writer closes. The delay that opens that window is a fixture option of `makeProbeRepo`.

One contract, one owner: the order inside the `hold` probe file of `makeProbeRepo` (open the FIFO for reading, then write `ran-x`, as the `gate` file does). The rest of the test (ticket, lock, exit code 0 of `taking`) is owned by ARK-T707 and is not repeated.

## Preconditions

- `makeProbeRepo({ hold: true, holdDelay: <ms> })` has the opt-in option `holdDelay`: the fake test pauses `<ms>` milliseconds (synchronous, in the fake test process) right after it appends `ran-x`. Without the option there is no pause. At the base commit the fake test writes `ran-x`, pauses, then opens the FIFO, so the writer can close in the pause. At the fixed commit it opens the FIFO first, writes `ran-x`, then pauses, so the child has opened the FIFO by the time `ran-x` exists.
- The test that carries ARK-T715 is the ARK-T707 test "takes its own ticket under the marker of a run that has ended". It passes `holdDelay: 1000` to its `makeProbeRepo({ hold: true })` call for the free-cores run, calls `free.release()` as soon as `free.started` resolves and the lock holds the `taking` ticket, and asserts that `finish(taking)` returns 0 and that the time from `free.release()` to that return is under 5 s (the `rejectionCeiling` of the file). Only that window is bounded: the whole test also holds the first run, the `holdDelay` and the nested `bun test` starts, and its time depends on the load of the host. The `<ms>` is 1000, well below that bound.
- Base evidence is the base fixture plus only the `holdDelay` option (old order); head evidence is the fixture with the option and the new order. The `holdDelay` option and its use in the test belong to the validator's test commit; the order fix belongs to the implementer.
- The environment of each `bun test` the validator starts is built, never inherited. The validator starts every process itself and stops a left-over one by its own pid (never by name).

## Steps

Test (the assertion of the ARK-T707 test above):

1. Run `bun test test/bare-test-budget.test.ts -t "takes its own ticket under the marker of a run that has ended"`. The test closes the writer during the pause and asserts exit 0 of `taking` and a window under 5 s from the release of the writer to that exit.

Validator evidence run (a run check recorded in the validator evidence, not a test assertion and not part of the test file; the 30 repeats and the shard are far over the 30 s budget of a test file):

2. Start 30 separate `bun test` processes with the filter of step 1, 4 at a time (not `--rerun-each`: the preload removes its scratch `TMPDIR` after one run, so a second run in one process fails with `ENOENT mkdtemp .../ark-home-...` at `tempArkHome`). Run them together with the CI shard command, copied from `.github/workflows/ci.yml` line 31: `bun test --parallel --shard=1/4 --timings=test/timings.json`. Record for each repeat: exit code, the `[N ms]` line, and the wall time of the process. The times are recorded, not bounded: the 5 s window is the assertion of the test, and a repeat in which it fails exits 1.
3. Do step 2 at the base fixture (option, old order) and at the head fixture (new order). Record both sets.

## Expected results

- Step 1, head: exit 0, and the test passes, so its window from the release of the writer to the exit of `taking` is under 5 s.
- Step 1, base: the test fails. The child blocks on the FIFO that has no writer, `finish(taking)` rejects with `no exit of the child within 20000 ms` at about 20 s. The delay opens the window for every run, so this fails deterministically.
- Step 2, head (evidence): 30 of 30 repeats exit 0 (each passes its own 5 s window assertion), and no output has `no exit of` or `ENOENT mkdtemp`. The `[N ms]` and wall times of the whole test are recorded and not bounded.
- Step 3, base (evidence): every repeat fails with `no exit of the child within 20000 ms`.

## Screenshot checkpoints

none: runner output and files, no UI.
