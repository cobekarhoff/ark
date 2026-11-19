---
id: ARK-T694
title: "ARK-T694 a suite held on load starts when the load falls to the limit, prints one line for each change of reason, and does not mark itself started while it waits"
level: integration
technique: "state transition (waiting on load, waiting on load and memory, waiting on memory, started) at the real ticket store"
priority: high
risk: "The admission loop reads the load once and never sees it fall, so a held suite waits forever on a host that has recovered; or it prints the load line on every poll; or a load hold hides a memory hold (or the reverse), so the line names one reason while the other still holds; or a suite that waits marks itself `started` and takes cores from the budget"
status: active
changed_by: 2026-11-18-ARK-515-1
---

## Objective

Prove that `openTestBudget` re-reads the 1-minute load on each fresh host reading (readings stay cached for 1,000 ms; the loop still polls every 100 ms), holds a waiting ticket while it is above the limit, and lets it start once the load is at or under the limit, with one line for each change of reason, through the same loop and nap as the memory hold.

Gate answers:

1. Protects the waiting-to-started transition of AC1 and the print cadence "same as the memory reasons".
2. A regression that fails it: a one-shot load reading that never refreshes, a line for each poll, a reason list that loses the memory or the load reason, a started ticket while waiting.
3. ARK-T692 runs the real `ark test` at fixed readings (the runner's environment cannot change while it runs), so it shows hold and start for separate runs, but not the move from one to the other. ARK-T187 shows that move for memory only.
4. No test-only hook: `openTestBudget` is the same function `cli/test-run.ts` and `cli/bare-test-budget.ts` call, with the real ticket store in a temp `ARK_HOME`. The case sets and rewrites `process.env.ARK_FAKE_LOAD_ONE` while the call waits, as `test/test-lock.test.ts` does for `ARK_FAKE_LOAD`; the seam is the one of ARK-T692.

## Preconditions

- Temp `ARK_HOME` with the real ticket store, a budget with free cores, a healthy fake host (ARK-T187), and `maximumLoad` 10 passed to `openTestBudget` as `cli/test-run.ts` passes it from `test_max_load`.
- The output of the hold goes to a captured stream, as the in-process calls of `test/test-lock.test.ts` do.
- The case waits on events (a printed line, the ticket file, the resolve of `take()`), never on a fixed sleep. After a rewrite it waits for `take()` to resolve; where the call must stay held, it waits over one cache lifetime (1,000 ms) plus three polls so at least one fresh reading has happened.

## Steps

1. `ARK_FAKE_LOAD_ONE=12.5`. Call `take()`; wait for the waiting line; wait over three poll intervals and one cache lifetime (1,000 ms); read the ticket store.
2. Rewrite the seam to `10` (at the limit). Wait for `take()` to resolve; read the ticket store.
3. Release the ticket. `ARK_FAKE_LOAD_ONE=12.5` and a memory reading at 15 percent free (under the floor 20). Call `take()`; read the output after three polls.
4. Rewrite the load to `3`, so only memory holds. Wait over one cache lifetime and three polls; read the output; the `take()` has not resolved.
5. Rewrite the memory to healthy. Wait for `take()` to resolve.
6. Release the ticket. `ARK_FAKE_LOAD_ONE=12.5`. Call a new `take()`; wait for its one initial `waiting for load` line. Rewrite the seam to `unreadable`; wait for `take()` to resolve.

## Expected results

- Step 1: exactly one `ark test: waiting for load: ...` line however many polls pass; the ticket is waiting and has no `started` mark; `take()` has not resolved.
- Step 2: `take()` resolves on the next fresh host reading after the rewrite (within the 1,000 ms cache plus one poll); the ticket is now started with its cores; no second load line printed.
- Step 3: the output names both reasons: a line with the load reason (`waiting for load`) and a line with the memory reason (`waiting for memory`); each is printed once.
- Step 4: no new load line; the memory line stays; `take()` has not resolved (a recovered load does not release a memory hold).
- Step 5: `take()` resolves; no further line.
- Step 6: the first hold printed exactly one `waiting for load` line; after the reading fails the ticket is admitted and no further load line (and no other hold line) is printed.

## Screenshot checkpoints

None. The surface is files and output text; no screenshot applies.
