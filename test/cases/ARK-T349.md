---
id: ARK-T349
title: ARK-T349 no playwright spec reads the wall clock; dates come from a helper built on the frozen clock
level: integration
technique: equivalence classes (each `*.pw.ts` file is one member; the limit is 0 for all)
priority: high
risk: "a `*.pw.ts` spec reads `new Date(` or `Date.now(` directly, so a test depends on the time of day (the `resets` text wraps after 22:46 UTC); or the helper itself returns the real clock past the scan (`helpers.ts` is outside the scan)"
status: active
changed_by: 2026-11-13-ARK-433-1
---

## Objective

Prove that no `*.pw.ts` file under `test/pw` holds `new Date(` or `Date.now(`, and that the specs get time from a helper in `test/pw/helpers.ts` built on `testNow`.

Expected: Every `*.pw.ts` file has a date-read count of 0, and `test/wallclock-allowed.json` has no entry for a date read.

## Preconditions

- Tree after the change: `hub.pw.ts` uses the helper; `checkpoint.pw.ts` has no date read.
- `test/pw/helpers.ts` is not a `*.pw.ts` file, so it may hold the one real `new Date(` the helper needs.

## Steps

1. List every `*.pw.ts` file under `test/pw`.
2. For each file count lines with `new Date(` or `Date.now(` (comment lines skipped, as the guard does); assert 0.
3. Read `test/wallclock-allowed.json`: assert no `*.pw.ts` entry exists for the date patterns.
4. Behavior check of the helper: set `ARK_NOW=2026-11-04T23:30:00Z` (after the 22:46 UTC wrap), call the helper the specs use, and assert its value is derived from that instant (equal to the `testNow()`-based value), not from the real clock. Repeat with a second instant and assert the value moves with it.

## Expected results

- Count is 0 for each file, named in the failure message when not.
- No allowance for date reads.
- The helper returns a value derived from `ARK_NOW`, equal to the `testNow()`-based value, for both instants.

## Screenshot checkpoints

none: the case checks source text, not appearance.
