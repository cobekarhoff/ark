---
id: ARK-T730
title: ARK-T730 From handmade health probes the window picker names the sources and hub lines of the largest lag, and the message says so when none ran
level: unit
technique: equivalence classes (a pass in the window, a pass outside it, a pass that ran in it and ended after it, no pass, a repeated lag, two spikes) and boundary values (a pass ending exactly at the window start, the first probe holding the lag, an end time before the soak start)
priority: high
risk: >-
  the failing message of ARK-T699 names the wrong window or none: it brackets a lag with the probe that first reported it and the one after, so the source that ran is missing; it prints a source whose pass ended in another second; it drops a pass that ran in the window and ended after it; it compares the wall-clock `ended_at` with soak time without subtracting the soak start, so it names the wrong sources; it moves the window when the same 60 s lag is reported again or when a second spike has the same value; or it prints nothing for a lag no source or hub line explains, so a reader cannot tell "host load" from "not recorded"
status: active
changed_by: 2026-11-20-ARK-602-1
---

## Objective

Prove the pure helper that ARK-T699 calls to build the message of its loop-lag assert (ARK-602/AC1). Expected: Given the recorded `/api/health` answers, the hub's output lines and the soak start epoch, the system shall pick the window of the largest lag and build a message that holds the lag, its time into the soak, each source whose pass ended or ran in the window (name, `last_ms`, end time into the soak) and each hub line of the window, or the words "no source" and "no hub line" when there are none.

Where it lives: a new module `test/hub-stall-window.ts`, beside `test/hub-stall.test.ts`. It is test support, never an export of `hub/`, and its only callers are ARK-T699 (the soak) and this case. Contract the validator pins: `windowMessage(probes, lines, startEpoch): string`, where `probes` is an array of `{ at, lag_ms, sources }`, `at` is the probe time in ms into the soak, `lag_ms` is a number or `null`, and `sources` is the object of `/api/health` (name to `last_ms`, `ended_at`, `slow`); `lines` is an array of `{ at, text }`; `startEpoch` is the soak start in ms since the Unix epoch. `ended_at` is the ISO string the route sends (`hub/snapshot.ts`: `new Date(pass.endedAt).toISOString()`), so the helper converts it with `Date.parse(ended_at) - startEpoch`.

The window rule: the window is the interval from the probe before the first probe that reported the largest `lag_ms` (0 when there is none before it) up to that probe. A pass is `[ended - last_ms, ended]` in soak time, and a source is named for each distinct pass, seen at any probe, that overlaps the window (an end exactly at the window start counts). A hub line is in the window when its `at` is in it.

Question 1: the window rule, the conversion and the message text are the whole content of AC1. Question 2: an off-by-one probe, a window that moves with a repeated or second equal lag, a filter on `ended_at` only, a missing conversion, or an omitted section each fail one example below. Question 3: ARK-T699 can show the message only by failing, and it must never fail on purpose (the limit stays 200); no other test builds a window. This case owns the window rule and the message text; ARK-T699 owns that the soak feeds the helper every probe and asserts the 200 ms limit itself. Question 4: the helper is test support with two test callers and lives under `test/`, so `hub/` gets no export without a production caller; the case calls it with handmade data, no hub, no timer.

The helper module is created by the implementer. The validator loads it with a dynamic `await import` inside each test, so each example fails alone at base (the module does not exist) and the file loads. The file holds no `setTimeout(`, `Bun.sleep(`, `waitForTimeout(` or `.toBeLessThan(<3 or more digits>)` (test/wallclock.test.ts, ARK-T126); the validator runs `bun test test/wallclock.test.ts` before it finishes.

## Preconditions

- No hub, no home, no files, no clock. Each example builds its input by hand with the fixed `startEpoch` 1_800_000_000_000 and a helper `iso(ms)` = `new Date(startEpoch + ms).toISOString()`: every `ended_at` is an `iso(...)` string, never a soak-time number, and a source with no pass has `ended_at` `null` and `last_ms` `null`.
- Probe times and hub-line times are plain numbers in ms into the soak.

## Steps

1. Probes at 0, 5000, 10000, 15000 ms with lags 20, 20, 240, 240. Sources: `usage` (`ended_at` `iso(7000)`, `last_ms` 180), `github` (`iso(2000)`, 90) and `claude` (`iso(12000)`, 3). Each source is present from its first probe on: `usage` and `github` from 10000, `claude` from 15000. One hub line at 8000 and one at 13000.
2. Probes at 0, 5000, 10000 with lags 0, 0, 252, the largest lag on the last probe. `usage` has `ended_at` `iso(4000)`, `last_ms` 180 at probe 5000 and `iso(9000)`, `last_ms` 60 at probe 10000; `github` has `iso(4000)`, `last_ms` 90 at both probes.
3. Probes at 0, 5000, 10000, 70000 with lags 10, 10, 226, 226 (the hub reports its 60 s maximum again at the last probe). One pass ending at 7000 (`last_ms` 50) and another ending at 65000 (`last_ms` 50).
4. Probes at 0 and 5000 with lags 10 and 244. `sources` hold: `a` with `ended_at` `null` and `last_ms` `null`, `b` with `ended_at` `iso(-1000)` and `last_ms` 40 (a pass that ended before the soak start). No hub line.
5. One probe at 0 with lag 300, and a source `a` with `ended_at` `iso(0)`, `last_ms` 40.
6. Two spikes of the same value: probes at 0, 5000, 10000, 15000, 20000 with lags 10, 300, 20, 300, 10. `usage` ended at `iso(3000)` (`last_ms` 50), `github` ended at `iso(12000)` (`last_ms` 50). Then, on their own, two sets of probes at 0 and 5000: one where every `lag_ms` is `null`, one where every `lag_ms` is 0 (no lag means every `lag_ms` is `null` or 0).
7. Probes at 0, 5000, 10000, 15000 with lags 20, 20, 240, 240. `batch` first appears at probe 15000 with `ended_at` `iso(12000)` and `last_ms` 5000 (it started at 7000, inside the window 5000 to 10000, and ended after it). `claude` appears at probe 15000 with `iso(12000)` and `last_ms` 3.

## Expected results

- Step 1: the window is 5000 to 10000. The message holds `240`, the time 10000 ms into the soak, and `usage` with `180` and its end time 7000. It does not name `github` (ended at 2000, ran 1910 to 2000) or `claude` (ended at 12000, ran 11997 to 12000). The hub line at 8000 is in the message; the one at 13000 is not. `usage` is named only if the helper subtracts `startEpoch`: a helper that compares `Date.parse(ended_at)` or a wall-clock number with 5000 to 10000 names no source here.
- Step 2: the message names `usage` once, with `last_ms` 60 and end time 9000 (its pass of the window); it does not name the earlier `usage` pass (ended at 4000, ran 3820 to 4000) or `github` (ended at 4000 at both probes, ran 3910 to 4000, outside 5000 to 10000).
- Step 3: the window is 5000 to 10000, not 10000 to 70000: the pass ending at 7000 is named, the one ending at 65000 is not. The message time is 10000 ms.
- Step 4: the message still holds `244` and its time 5000, and says "no source" and "no hub line": `a` has no pass and `b` ended before the soak start, so neither is named. A section is never omitted.
- Step 5: with no probe before the largest one, the window starts at 0 and is 0 to 0; `a` (ran -40 to 0) is named, a pass ending exactly at the window start is in it. The helper does not throw.
- Step 6, first example: the first spike wins: the message time is 5000, it names `usage` (3000 is in 0 to 5000) and not `github` (12000 is in the second spike's window, 10000 to 15000). Second and third examples: the message says there was no lag, the helper does not throw, and no source or hub line is invented.
- Step 7: `batch` is named (its pass ran 7000 to 12000 and overlaps 5000 to 10000, though it ended after the window); `claude` is not (11997 to 12000). A helper that filters on `ended_at` alone fails this step.

Red at base: the helper module does not exist, so each dynamic import fails; each example fails by its own message and the rest of the file loads. The deletion that must turn step 1 red: widening the window to the whole soak (names `github`) or narrowing it to the single probe. The one that must turn step 3 red: using the last probe that reports the maximum. The one that must turn step 7 red: filtering on `ended_at` only.

## Screenshot checkpoints

none: a pure function, no page and no rendered output.
