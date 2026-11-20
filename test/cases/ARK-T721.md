---
id: ARK-T721
title: ARK-T721 a quick ark test ticket that fits the free cores starts ahead of a blocked full ticket, passes the same host hold, never takes the started cores above the budget, and a ticket without mode counts as full
level: integration
technique: boundary values on cores (2 fits, 3 does not, with 4 of 6 held), decision table (mode quick, full or missing, fits or not, host hold on or off), race made real with two processes and ordered by a gate
priority: high
risk: the overtake lets a quick ticket start that does not fit (budget exceeded, two suites overload the host), skips the host hold of memory and CPU so ARK-515 and ARK-586 are bypassed, prunes a ticket without a mode (an older runner) as unreadable, reads a missing mode as `quick` so an older runner's ticket overtakes a blocked ticket, or, in a race with the first ticket, leaves the later quick ticket started next to the earlier full ticket (started cores above the budget)
status: active
changed_by: 2026-11-20-ARK-551-1
---

## Objective

Prove the admission in `cli/test-lock.ts` lets a quick ticket pass the first waiting ticket of a full run only when it fits the free cores and the host hold lets it, and that the started cores never pass the budget. Serves ARK-551/AC1.

Expected: When the first waiting ticket is a `full` ticket that does not fit now, a later `quick` ticket whose cores fit the free cores shall mark itself started at once, and the full ticket shall keep waiting.

## Preconditions

- A fixture `ARK_HOME` with a `test-budget` folder and a budget of 6 cores.
- `ARK_FAKE_CPU_PERCENT` set low, `minimumFreeMemoryPercent: 0` and a swap limit as `test/load-hold.test.ts` sets them, so the 1 s CPU sample of the hold never decides the result.
- Ticket pids that are alive: a started ticket of 4 cores held by a spawned `sleep` (stopped by its PID at the end), and a waiting ticket of a full run that asks 3 cores and arrived first (its pid is a second `sleep`, ticket `mode: full`).
- A reader of every ticket file sampled at each poll (the started cores sum).

## Steps

1. With the 4 cores held and the full ticket (3 cores) waiting, run `ark test <run> --quick` with a quick ticket of 2 cores through the real `openTestBudget` path (`executeTest` passes the mode). Poll the ticket folder.
2. Read the quick ticket: `started` set. Read the full ticket: still waiting. Sum the started cores at every poll.
3. Repeat with a quick ticket that asks 3 cores while the 4 cores are held. Poll for a window longer than one hold sample.
4. Repeat Step 1 with the host hold set to wait (CPU above the limit through `ARK_FAKE_CPU_PERCENT`). Then lower it.
5. Repeat Step 1 with the waiting 3-core ticket holding no `mode` field (a file written by hand, as an older runner wrote it, owned by a spawned `sleep`). Then, with the 4 cores held and a waiting full ticket of 3 cores that has `mode: full` (also a hand-written file owned by a spawned `sleep`), take the later 2-core ticket through a real caller that passes no mode: a whole-suite `bun test --parallel=2` in a scratch repo that loads the repo's `test/tmpdir-preload.ts` (as `test/bare-test-budget.test.ts` does), in a project whose `ark.yml` has `test_budget_cores: 6` and a memory limit of 0. The preload takes the ticket through `openTestBudget` with no `mode` option, and the ticket is owned by that `bun test` process, so only that process can mark it started. Poll for a window longer than one hold sample, then stop the holder and the waiting ticket's owner by their PIDs.
6. Race, two real `ark test` processes, budget 6: the holder of 4 cores (a spawned `sleep`), a full `ark test` of 5 cores (waits: 4 + 5 > 6), and a quick `ark test --quick` of 2 cores (fits: 4 + 2 = 6). The quick process gets an opt-in gate that only it reads, an environment variable naming a folder (set by the test on that one process, never in a shared fake): after its read of the ticket folder and before its `started` write it writes `read` in the folder and waits, with a limit, for `go`. The test (a) waits, with a limit, for the `read` file, (b) stops the holder by its PID, (c) waits, with a limit, for the full ticket's `started` (the full process starts on its own poll: 5 <= 6), (d) writes `go`, (e) waits, with a limit, for the quick ticket to lose `started` again. The quick ticket's `started` write makes 5 + 2 = 7 > 6, so the revoke check (the started tickets up to its own arrival exceed the budget) removes it. Repeat the one test file with `bun test --rerun-each=20 <file>`.
7. Read the printed waiting line of the quick and the full runner and the `## ark test budget` rows of `ark chief state`.

## Expected results

- Step 2: the quick ticket has `started` at once (before the hold's next sample), the full ticket has none. The started cores never sum above 6 at any poll.
- Step 3: the 3-core quick ticket does not start while the 4 cores are held and starts only after the holder ends.
- Step 4: while the host hold waits, the overtaking quick ticket does not mark itself started and prints the hold reason, as a first ticket does; it starts after the hold clears.
- Step 5: a waiting ticket without `mode` reads as `full` and is not pruned as unreadable: the quick ticket passes it when it fits, and its file is still in the folder. The later ticket of the bare `bun test` has no `mode` and does not start while the 4 cores are held and the 3-core full ticket waits (a missing `mode` is `full`, never `quick`), although its 2 cores fit; it starts only after the holder and the waiting ticket's owner are stopped.
- Step 6: the gate fixes the order, so it holds in every repeat: the earlier full ticket keeps `started`, the later quick ticket revokes (has no `started` after step (e)) and starts only after the full ticket ends; at every poll after (e) the started cores sum to 6 or less. The test passes with the delay in the quick process only and fails without the revoke check.
- Step 7: the waiting line keeps its form (the place and the holders; no `mode` in it), and `ark chief state` lists the waiting and the started tickets as before.

## Screenshot checkpoints

None. The surface is ticket files and CLI output; no screenshot applies.
