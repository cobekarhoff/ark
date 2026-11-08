---
id: ARK-T124
title: ARK-T124 the 30-second silence check of every view advances a controlled clock by 30 seconds instead of waiting and fails on a 25-second poll in the page
level: e2e
technique: mutation test (inject a fault, expect failure); boundary value on poll interval (25 s inside, over 30 s outside)
priority: high
risk: "the silence check waits 30 s of wall time again (91 s lost), uses runFor instead of fastForward, or no longer sees a request that a view sends on a timer, so a polling view passes"
status: active
changed_by: 2026-11-08-ARK-331-1
---

## Objective

Prove that ARK-277 silence still holds: for each view (Home, Runs, ticket page) no request leaves the page in 30 s of page time, measured with `page.clock.install` and `page.clock.fastForward(30_000)`, not by waiting.

Expected: When the page clock advances 30 seconds on a view, the page shall send no request; if the page holds a 25 s poll, the check shall fail.

## Preconditions

- Hub fixture of `test/pw/hub.pw.ts` serving Home, Runs and a ticket page.
- Steps that read `Date.now` (the Home appended-event step within 5 s) run before the clock is installed.

## Steps

1. For each view: open it, wait for its content, record requests, install the clock, call `page.clock.fastForward(30_000)`.
2. Assert the request list did not grow. Wall time is not asserted; the elapsed time before and after goes in the AC9 report.
3. Mutation: in a copy of the check, add `page.evaluate(() => setInterval(() => fetch("/api/snapshot"), 25_000))` after load; run it.
4. Assert the mutated run fails, with at least one request counted.
5. Run `bunx playwright test test/pw/hub.pw.ts`.

## Expected results

- Each view passes with no request during the 30 s of page time, decided by the controlled clock and the request list only.
- The 25 s poll makes the check fail.
- `bunx playwright test test/pw/hub.pw.ts` exits 0. The clock call is shown by the request assertion in step 3 (a 25 s poll fires only if the clock advanced), not by a source-text check.

## Screenshot checkpoints

none: the case checks logic or output, not appearance.
