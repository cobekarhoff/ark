---
id: ARK-T322
title: "ARK-T322 with 2,000 messages and 20 runs the hub pages keep their p95 and every project conversation request under load returns the full, ready conversation"
level: integration
technique: "boundary values (page budgets at the AC's load) with percentile sampling; structural checks of each reply in place of a wall-time bound"
priority: medium
risk: "the 2,000-message conversation read or build blocks the main thread so `/` and `/nope` pass 200 ms p95, or a conversation request made during the builds returns a non-200 status, the early `loading` directory, fewer than 2,000 messages, fewer than 20 runs, or a read older than the cold one"
status: active
changed_by: 2026-11-20-ARK-578-1
---

## Objective

Prove the AC4 budgets of ARK-344 at 2,000 messages and 20 runs: `/` and `/nope` p95 below 200 ms while conversation requests run in the background, and every conversation reply, cold or under load, is the full ready value. The case holds no millisecond threshold on GET /api/conversation: a loaded host slows a request and does not change what it returns.

## Preconditions

- A fixture with 20 runs and an inbox of 2,000 messages with bodies of realistic size.
- A hub with a page connected and the inbox already read (follow the `percentile95` precedents in `test/hub.test.ts`).

## Steps

1. Wait for the first read on GET /api/conversation/message/<id>, then request GET /api/conversation until `directory` is `ready`. That reply is the cold one.
2. Start four background clients that request GET /api/conversation again and again and keep every reply.
3. Sample `/` and `/nope` 100 times each while the clients run, then stop the clients.
4. Compute the p95 of each page and print the line `ARK-T322 cold=... warm-max=... builds=... p95(/)=... p95(/nope)=...`.
5. Repeat proof of ARK-512 AC1: run the test in 20 separate processes, one after the other, with the cli suite running beside them for the whole loop.
   - `for i in $(seq 20); do bun test test/hub.test.ts -t ARK-T322 || break; done` in one terminal.
   - `bun test test --parallel=3` repeated in a second terminal until the first loop ends (the cli suite of `ark.yml`: scope `test`, 3 cores; there is no `test/cli*` file). Stop it by its own PID. Keep its log: it is the evidence that the suite ran beside every repeat.
   - `bun test --rerun-each=N <one file>` is the quick repeat of a flaky test (a one-file run takes no cores). It does not replace this proof: one process keeps module state and process-level timing between repeats, so a race or load fix is proved by 20 separate processes beside the loaded suite.

## Expected results

- The cold reply is status 200 with `directory` `ready`, 2,000 messages and 20 runs.
- Every background reply is status 200 with `directory` `ready`, 2,000 messages and 20 runs, and its `read_at` is not earlier than the cold reply's.
- At least one background reply completes (`builds` above 0).
- The p95 of `/` and of `/nope` is below 200 ms during the background builds.
- The test body holds no absolute millisecond threshold on GET /api/conversation: the printed `cold` and `warm-max` are data and no assertion reads them.
- The 20 processes of step 5 all pass.

## Screenshot checkpoints

none: timing case on hub HTTP; no UI surface.
