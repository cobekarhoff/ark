---
id: ARK-T693
title: "ARK-T693 test.completed records the 1-minute load at the start of each suite and the highest sampled while it ran (the maximum of several samples), null for a reused suite, and a reader tolerates an old suite entry"
level: integration
technique: "equivalence classes (a suite that ran and passed, one that ran and failed, a reused suite, an old entry without the fields) and state transition (first run, second identical run)"
priority: high
risk: "A failed full test cannot be judged a load failure from the event alone (ARK-499: 15 test ids failed on load with no record), because the fields are missing, always `null`, or taken from the wrong moment; or a reused suite records the load of the old run instead of `null`; or a reader that reads a suite entry throws on an old event that has no `loadAtStart` or `loadPeak`, so the retro, the MR body or a run page of an older run breaks"
status: active
changed_by: 2026-11-18-ARK-515-1
---

## Objective

Prove each suite entry of `test.completed` that ran carries `loadAtStart` and `loadPeak` (the 1-minute load), a reused suite carries `null` for both, and the readers of `events.ndjson` read an old entry without them.

Gate answers:
1. Protects the event contract of AC2 (new fields, the `null` of a reused suite) and the tolerance of the readers for the old shape.
2. A regression that fails it: fields missing, a load of 0 or a wrong slot (5-minute) recorded, a reused suite not `null`, a reader that fails on an absent field.
3. ARK-T135 proves the event holds suites, heads, mode and duration, and the reused flag, with no load; ARK-T163 owns the cache semantics. The load fields have no case.
4. The seam of ARK-T692 in its file form, `ARK_FAKE_LOAD_ONE=file:<path>`: the file's number is read on every reading by the same reader the runner uses for the admission and the once-a-second sampler (it takes the reader as a parameter). The fake suite command rewrites that file while it runs, so the load changes during the suite: start 2, a middle value 9 higher than both start and final, final 3. Each of 9 and 3 stays in the file for at least two sampler ticks (2.5 s each), so the sampler reads `9` at least once and `3` at least once, and the last value read is `3`. A recorded first sample (2), last sample (3) or constant fails; only the maximum (9) passes. The case does not require the sampler to take one more reading when the suite ends: the oracle is `loadAtStart` = the first value and `loadPeak` = the middle maximum 9, with the last value sampled at least once. The case runs the real `ark test` and reads the event the runner writes; there is no export.

## Preconditions

- Temp project and temp `ARK_HOME`, a run with two suites (one passes, one fails) and a check that passes; the fake host of ARK-T187, `test_max_load: 100`.
- `ARK_FAKE_LOAD_ONE=file:<load file>` in the environment of `ark test`, the file holding `2` before each run (the case writes it).
- The failing suite's command writes the load file itself while it runs: `9`, holds 2.5 seconds (at least two sampler ticks, so `9` is sampled), then writes `3`, holds another 2.5 seconds (at least two ticks, so `3` is sampled at least once and is the last value read before the sampler stops), then exits 1. The passing suite is cheap and does not touch the file.
- A second run folder whose `events.ndjson` was written by hand with a `test.completed` whose suites are `{ name, level, passed }` only (the shape of `test/merge-request.test.ts`, `test/pr-writing.test.ts` and `test/evidence-ship.test.ts`).

## Steps

1. Write `2` into the load file. Run `ark test <run>`. Read the `test.completed` event and the exit code.
2. Write `2` into the load file. Run `ark test <run>` again with no change (the passing suite is reused), then read the new event.
3. Write `2` into the load file. Run `ark test <run> --quick`, and a run whose check fails (ARK-T664: no suite starts), and read each event.
4. Run `ark retro` and the merge-request body for the run with the hand-written old event, and fetch the run page of the hub for it.

## Expected results

- Step 1: exit 1 (one suite fails). The failing suite's entry has `loadAtStart: 2` (the first value, read before its command ran) and `loadPeak: 9` (the middle maximum: not the start `2`, not the last sampled value `3`, which was read at least twice before the suite exited). A final reading when the suite ends is not required. The passing suite's entry has numbers from the set {2, 9, 3} with `loadPeak >= loadAtStart`. A failed full test is judged from the event.
- Step 2: the reused suite has `reused: true`, `loadAtStart: null` and `loadPeak: null`; the failing suite that ran again has `loadAtStart: 2` and `loadPeak: 9` again (the earlier peak does not carry over).
- Step 3: the quick run records the fields for each suite that ran, with the same values for the failing suite if it runs; a run stopped by a failed check keeps `suites: []` (no suite, so no load) as before.
- Step 4: the retro, the MR body and the run page read the old event with no error and print what they printed before; no `undefined`, `NaN` or `null` appears in their output for the missing fields.

## Screenshot checkpoints

None for the CLI. The run page of step 4 is checked for a successful response and its text; no new element shows, so no screenshot applies.
