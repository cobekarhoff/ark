---
id: ARK-T688
title: ARK-T688 the history test of ARK-T288 and the hub-records test of ARK-T292 pass in a repeat where the first fake ps call answers after 3 s, and a read with the reader limit unset returns null after the same delay
level: integration
technique: state transition (ps answers late, then in time) with a control run, and a fault-injection setting in the shared fixture (a marker file read and consumed by the fake ps script)
priority: high
risk: the raise of the reader limit in installProcessFakes does not reach the readers of the resources source, so a loaded host that holds the fake ps for more than 2 s makes reader.read return null at test/resources-source.test.ts:434 (ARK-T288 failed in 3 runs, ARK-T292 in 2); or the delay is applied in a way that no read ever meets it, so no run proves the 3 s delay was in force and the raise was needed
status: active
changed_by: 2026-11-15-ARK-503-1
---

## Objective

Prove AC3 of ARK-503: with the first call of the fake `ps` of `installProcessFakes` delayed by 3 s, the two tests of `test/resources-source.test.ts` that call `reader.read` directly pass:

- `ARK-T288 the history keeps the points stamped at or after now minus 24 hours and drops the older ones` (`:421`; 6 reads: 4 in the loop at `:432-435`, then `:441` and `:444`).
- `ARK-T292 the hub records the maximum memory and the last cumulative CPU of each agent, and each span with no sample as a gap, and keeps suites` (`:519`; 6 reads: samples at 0, 5, 305, 425, 430 and 1000).

A repeat is one more run of those two bodies with a delay setting of the fixture on (a marker file read by the shell fake `ps` and removed by its first call, as `ps.rejectEnvironment` is read; it affects no other test, because each test calls `installProcessFakes` with its own `stateDirectory`). Only the first `reader.read` of the repeat meets the delay, which is the failure at `:434`. Each test spends 3 s more, well inside `setDefaultTimeout(60_000)`.

A control test proves the delay was in force: with `ARK_READER_TIMEOUT_MS` deleted after `installProcessFakes`, the first `reader.read` against the same delayed `ps` returns null after about 2 s, before the 3 s. The statistical goal of the ticket (20 of 20 runs beside the cli suite) is not a case: it is a manual gate or an `ark test` measurement (see `test-design.md`).

Expected: When the first call of the fake `ps` answers after 3 s, the system shall still give the resources source a process table, because `installProcessFakes` raises the reader limit to 30 s.

## Preconditions

- The real source of `hub/resources.ts`, the fixtures of `test/resources-fixtures.ts` (`installProcessFakes`, the fake `ps` and `lsof` shell scripts) and the two tests above.
- A new `ProcessFakes` method that sets the delay of the first `ps` call in seconds (shell only, so the Node suite `test/pw/resources.pw.ts`, which imports the module, keeps loading it). The fake `lsof` has no delay.
- `ARK_READER_TIMEOUT_MS` is unset in `process.env` of the test process before `installProcessFakes` runs.

## Steps

1. Run the repeat of the two tests: call `installProcessFakes`, set the first-call delay of `ps` to 3 s, and run each body to its end.
2. In the repeat of the history test, read `process.env.ARK_READER_TIMEOUT_MS` after `installProcessFakes` and the elapsed time of the first `reader.read`.
3. Control test: call `installProcessFakes` with one process, set the first-call delay to 3 s, `delete process.env.ARK_READER_TIMEOUT_MS`, call `reader.read(context)` once and read its result and elapsed time.

## Expected results

- Step 1: both tests pass with every assertion of their normal run (history window, peaks, gaps, suites, secrets). The `ps` table is read although the first call answers after 3 s.
- Step 2: `ARK_READER_TIMEOUT_MS` is `30000`. The first read takes at least 3 s and returns a view, not null.
- Step 3: `reader.read` returns null, and its elapsed time is at least 2 s: `exec` killed the delayed `ps` at the 2 s default (the failure shape of `test/resources-source.test.ts:434`), and the table that `ps` would print after 3 s was not waited for. The test passes in itself; it is the control that the delay of step 1 was real.
- The readers of `lsof` (`hub/resources.ts`) and the host readers of `cli/host.ts` (`memory_pressure`, `sysctl`) are not asserted: they may return null on a loaded host and `read()` still returns a view when the `ps` table is present.
- The run without the delay is the existing run of ARK-T288 and ARK-T292 and is not repeated here. The Node suite of the fixture is run by ARK-T290 (`test/pw/resources.pw.ts`), which passes unchanged (see `test-design.md`).

## Screenshot checkpoints

none: no UI surface in this case; the proof is the result of each read and the pass or fail of the tests.
