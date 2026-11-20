---
id: ARK-T730
title: ARK-T730 From handmade health probes the window picker names the sources and hub lines of the largest lag, and the message says so when none ran
level: unit
technique: equivalence classes (a pass in the window, a pass outside it, no pass, a repeated lag) and boundary values (a pass ending exactly at a probe time, the first probe holding the lag)
priority: high
risk: the failing message of ARK-T699 names the wrong window or none: it brackets a lag with the probe that first reported it and the one after, so the source that ran is missing; it prints a source whose pass ended in another second; it moves the window when the same 60 s lag is reported again at a later probe; or it prints nothing for a lag no source or hub line explains, so a reader cannot tell "host load" from "not recorded"
status: active
changed_by: 2026-11-20-ARK-602-1
---

## Objective

Prove the pure helper that ARK-T699 calls when its loop-lag assert fails (ARK-602/AC1). Expected: Given a list of recorded `/api/health` answers and the hub's output lines, the system shall pick the window of the largest lag and build a message that holds the lag, its time into the soak, each source whose pass ended or ran in the window (name, `last_ms`, end time) and each hub line of the window, or the words "no source" and "no hub line" when there are none.

Question 1: the window rule and the message text are the whole content of AC1. Question 2: an off-by-one probe, a window that moves with a repeated lag, a filter on `ended_at` that drops a source, or an omitted section each fail one example below. Question 3: ARK-T699 can prove the message only by failing, and it must never fail on purpose (the limit stays 200); no other test builds a window. This case is the only owner of the window rule and the message; ARK-T699 owns that the soak calls the helper and still asserts 200 ms. Question 4: no test-only hook. The helper is a pure function with a production caller (the soak), and the case calls it with handmade data, no hub, no timer.

The helper module is created by the implementer. The validator loads it with a dynamic `await import` inside each test, so each example fails alone at base (the module does not exist) and the file loads. The helper never lives in the test file. The file holds no `setTimeout(`, `Bun.sleep(`, `waitForTimeout(` or `.toBeLessThan(<3 or more digits>)` (test/wallclock.test.ts, ARK-T126); the validator runs `bun test test/wallclock.test.ts` before it finishes.

## Preconditions

- No hub, no home, no files. Each example builds its input by hand: an array of probes, each with the time into the soak in milliseconds, the `lag_ms` the answer reported (`null` or a number) and `sources` (name to `last_ms`, `ended_at`, `slow`, as `Health` of `hub/snapshot.ts` has them), and an array of hub output lines each with a time.
- Times are plain numbers: the case reads no clock.

## Steps

1. Call the helper on probes at 0, 5000, 10000, 15000 ms with lags 20, 20, 240, 240. Sources `usage` (ended at 7000, `last_ms` 180) and `github` (ended at 2000, `last_ms` 90) and `claude` (ended at 12000, `last_ms` 3). One hub line at 8000 and one at 13000.
2. Call it on probes at 0, 5000, 10000 with lags 0, 0, 252, where the largest lag is on the last probe and `sources.usage.ended_at` is 4000 at probe 5000 and 9000 at probe 10000.
3. Call it on probes at 0, 5000, 10000, 70000 ms with lags 10, 226, 226, 226 (the hub reports its 60 s maximum again), with a pass ending at 7000 and another at 65000.
4. Call it on probes at 0 and 5000 ms with lags 10 and 244 and `sources` with every `ended_at` `null` or before 0, and no hub line.
5. Call it with the largest lag on the first probe (at 0 ms, lag 300) and a source that ended at 0.
6. Call it on probes where two probes report the same largest lag at different times in different sources, and on probes where every `lag_ms` is `null`.

## Expected results

- Step 1: the window is the interval from the probe before the first probe that reported the largest lag (5000) up to that probe (10000). The message holds `240`, the time 10000 ms into the soak, and `usage` with `180` and its end time 7000. It does not name `github` (ended at 2000, outside the window) or `claude` (ended at 12000, after the window). The hub line at 8000 is in the message; the one at 13000 is not.
- Step 2: the source `usage` is named because its `ended_at` moved between the bracketing probes (4000 to 9000), with its `last_ms` read at the probe that holds the lag. A source whose `ended_at` did not move between the two probes and fell outside the window is not named.
- Step 3: the window is the one of the first probe that reported 226 (5000 to 10000), not 65000 to 70000: the pass ending at 7000 is named, the one ending at 65000 is not. The message time is 10000 ms.
- Step 4: the message still holds the lag and its time and says "no source" for the sources and "no hub line" for the lines. A section is never omitted.
- Step 5: with no probe before the largest one, the window starts at 0; the source ended at 0 is named (a pass ending exactly at the start of the window is in it). The helper does not throw.
- Step 6: of two probes with the same largest lag the first one wins. When no probe holds a lag, the message says there was no lag and the helper does not throw.
- In every step the helper returns text only; it never reads a limit, so `lagLimitMilliseconds` (200) cannot be changed through it. The assert in ARK-T699 (see that case) keeps its own limit.

Red at base: the helper module does not exist, so each dynamic import fails; each example fails by its own message and the rest of the file loads. The deletion that must turn step 1 red: widening the window to the whole soak (names `github`), or narrowing it to the single probe (misses `usage`). The deletion that must turn step 3 red: using the last probe that reports the maximum.

## Screenshot checkpoints

none: a pure function, no page and no rendered output.
