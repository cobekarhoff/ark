---
id: ARK-T776
title: ARK-T776 while the hub's first Ark read of a large home takes longer than 250 ms, GET /api/run/<run> answers 503 `loading` at once, and 200 with the run once the read ends
level: integration
technique: state transition (cold hub answering 503 `loading`, then ready hub answering 200), boundary value (a first read held well past the 250 ms bound of `readyOrLoading`)
priority: medium
risk: "a change makes the run route wait for the whole first read (the bound raised or `readyOrLoading` dropped), so a cold hub holds the request for seconds instead of answering 503 `loading`; or the hub never leaves 503 after a long first read (`reader.ready()` never resolves on a large home), so the poll of ARK-T662 hides it until its bound; or the large-home fixture stops holding the first read (a builder change, a project the reader skips), so ARK-T662's red proof of ARK-620/AC1 passes by accident"
status: active
changed_by: 2026-11-21-ARK-620-1
---

## Objective

Prove the 503 contract of the run route on a cold hub: while the first read of a large Ark home runs past the 250 ms bound of `readyOrLoading` (hub/server.ts), GET `/api/run/<run>` answers 503 with the body `loading`, and once the read ends it answers 200 with the run. This keeps the poll of ARK-T662 honest: the poll waits on a real 503 phase that ends. Serves ARK-620/AC2 (a guard: it holds at base).

## Preconditions

- A real hub (`startHub` of `test/helpers.ts` through `start()` of `test/hub.test.ts`) on a temp `ARK_HOME` from `isolatedEnvironment()`, with the fake tools of `installFakeTools({ orca: orcaAnswersFor(run) })`.
- The Ark home holds project `p` with one open run `<today>-ARK-<n>-1` (`writeRun`) and the large project of `test/hub-home-lag.test.ts` (1,620 run folders in the real shape, written by the same builder, not a copy of it), written once per test file and shared read only with ARK-T662. No change under `hub/`, no env var or fake that delays the read: the hold is the size of the home.
- The validator records once, on an idle host, how long the first read of this home takes (the time from the printed port to the first 200 of the run route), and keeps the home large enough that this is at least 4 times 250 ms.

## Steps

1. Start the hub. As soon as `start()` returns (the port is printed and the page's `/events` stream is open), GET `/api/run/<run>` once and note the status, the body and how long the answer took.
2. Poll GET `/api/run/<run>` until the status is not 503 (bound 10 s, an event wait with no fixed sleep); note each status.
3. Read the body of the first answer that is not 503.

## Expected results

- Step 1: the status is 503 and the body is `loading`: the hub answered from its 250 ms bound, not after the read (a hub that waits for the read answers 200 here). The case asserts no fixed time (a time limit flakes on a loaded host); it puts the time the answer took in its failure message. At base this already holds (a guard).
- Step 2: every answer before the last is 503 `loading`; the poll ends before its bound with 200. A poll that reaches its bound fails with the route, the bound and the last status and body in its message, never with a bare Bun timeout.
- Step 3: the body is the run's detail JSON and names the run (its name, ticket `ARK-<n>`), not an empty or `no such run` answer.
- A first answer of 200 fails the case: either the hold is gone (the fixture no longer slows the first read, so ARK-T662's large home proves nothing) or the hub waits for the whole read; the failure message names the time the answer took so the two can be told apart.

## Authoring gate

1. Protects: the cold-hub contract of the run route (503 `loading` within the bound, then 200), which the page reads as a loading state (ARK-T699 step 7) and which the poll of ARK-T662 now depends on.
2. Regression: the 250 ms bound raised or removed, `readyOrLoading` dropped from `runRoute`, `reader.ready()` that never resolves after a long first read, or a fixture change that removes the hold.
3. Existing proof misses it: `test/hub-stall.test.ts` (cold `GET /api/run/<open>`) accepts a 503 `loading` while cold but does not require one, and its hub's first read is short; ARK-T699 step 7 fakes the 503 in the page with a route handler. No test makes a real hub answer 503 and then 200 on the same route.
4. No test-only export, flag or hook in product code: the hold is the size of the home, read through the real `hub/main.ts`. The home builder is shared between test files (a test fixture, not a seam).

## Screenshot checkpoints

None. The surface is HTTP; ARK-T699 step 7 covers the page's loading state.
