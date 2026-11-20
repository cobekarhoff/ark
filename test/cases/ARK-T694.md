---
id: ARK-T694
title: "ARK-T694 a suite held on CPU starts when a fresh sample falls to the limit, prints one line for each change of reason, and does not mark itself started while it waits"
level: integration
technique: "state transition (waiting on CPU, waiting on CPU and memory, waiting on memory, started) at the real ticket store"
priority: high
risk: "The admission loop reads the CPU once and never sees it fall, so a held suite waits for ever on a host that has recovered; or it prints the CPU line on every poll; or a CPU hold hides a memory hold (or the reverse), so the line names one reason while the other still holds; or a suite that waits marks itself `started` and takes cores from the budget"
status: active
changed_by: 2026-11-20-ARK-586-1
---

## Objective

Prove that `openTestBudget` takes a fresh CPU sample on each fresh host reading (readings stay cached for 1,000 ms; the loop still polls every 100 ms), holds a waiting ticket while another suite runs and the CPU is above 90 percent, and lets it start once the CPU is at or under 90, with one line for each change of reason, through the same loop and nap as the memory hold.

Gate answers:

1. Protects the waiting-to-started transition of the CPU hold and its print cadence, "same as the memory reasons".
2. A regression that fails it: a one-shot CPU reading that never refreshes, a line for each poll, a reason list that loses the memory or the CPU reason, a started ticket while waiting.
3. ARK-T710 runs the real `ark test` at fixed readings (the runner's environment cannot change while it runs), so it shows hold and start for separate runs, not the move from one to the other. ARK-T187 shows that move for memory only. ARK-T709 owns the move caused by the other suite ending.
4. No test-only hook: `openTestBudget` is the same function `cli/test-run.ts` and `cli/bare-test-budget.ts` call, with the real ticket store in a temp `ARK_HOME`. The case sets and rewrites `process.env.ARK_FAKE_CPU_PERCENT` while the call waits, as `test/test-lock.test.ts` does for `ARK_FAKE_LOAD`; the seam is the one of ARK-T710.

## Preconditions

- Temp `ARK_HOME` with the real ticket store, a budget with free cores beyond the holder's, a healthy fake host (ARK-T187), and no load limit (`openTestBudget` takes no load option).
- A running suite: a `started` ticket of a live pid (the case's own pid under another label) holding 1 core. It stays for every step: with nothing running the CPU hold does not apply (ARK-T709).
- The output of the hold goes to a captured stream, as the in-process calls of `test/test-lock.test.ts` do.
- The case waits on events (a printed line, the ticket file, the resolve of `take()`), never on a fixed sleep. After a rewrite it waits for `take()` to resolve; where the call must stay held, it waits over one cache lifetime (1,000 ms) plus three polls so at least one fresh reading has happened.

## Steps

1. `ARK_FAKE_CPU_PERCENT=95`, `ARK_FAKE_LOAD_ONE=0`. Call `take()`; wait for the waiting line; wait over three poll intervals and one cache lifetime; read the ticket store.
2. Rewrite the seam to `90` (at the limit). Wait for `take()` to resolve; read the ticket store.
3. Release the ticket. `ARK_FAKE_CPU_PERCENT=95` and a memory reading at 15 percent free (under the floor 20). Call `take()`; read the output after three polls.
4. Rewrite the CPU to `5`, so only memory holds. Wait over one cache lifetime and three polls; read the output; the `take()` has not resolved.
5. Rewrite the memory to healthy. Wait for `take()` to resolve.
6. Release the ticket. `ARK_FAKE_CPU_PERCENT=95`. Call a new `take()`; wait for its one initial `waiting for CPU` line. Rewrite the seam to `unreadable`; wait for `take()` to resolve.

## Expected results

- Step 1: exactly one `ark test: waiting for CPU: ...` line however many polls pass; the ticket is waiting and has no `started` mark; `take()` has not resolved.
- Step 2: `take()` resolves on the next fresh host reading after the rewrite (within the 1,000 ms cache plus one poll); the ticket is now started with its cores; no second CPU line printed.
- Step 3: the output names both reasons: a line with the CPU reason (`waiting for CPU`) and a line with the memory reason (`waiting for memory`); each is printed once.
- Step 4: no new CPU line; the memory line stays; `take()` has not resolved (a recovered CPU does not release a memory hold).
- Step 5: `take()` resolves; no further line.
- Step 6: the first hold printed exactly one `waiting for CPU` line; after the reading fails the ticket is admitted and no further CPU line (and no other hold line) is printed.

## Screenshot checkpoints

None. The surface is files and output text; no screenshot applies.
