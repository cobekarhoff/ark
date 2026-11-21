---
id: ARK-T721
title: ARK-T721 a quick ark test ticket that fits the free cores starts ahead of a blocked full ticket, passes the same host hold, never takes the started cores above the budget, and a ticket without mode counts as full
level: integration
technique: boundary values on cores (2 fits, 3 does not, with 4 of 6 held), decision table (mode quick, full or missing, fits or not, host hold on or off), race made real with two processes and ordered by a gate
priority: high
risk: the overtake lets a quick ticket start that does not fit (budget exceeded, two suites overload the host), skips the host hold of memory and CPU so ARK-515 and ARK-586 are bypassed, prunes a ticket without a mode (an older runner) as unreadable, reads a missing mode as `quick` so an older runner's ticket overtakes a blocked ticket, or, in a race with the first ticket, leaves the later quick ticket started next to the earlier full ticket (started cores above the budget)
status: active
changed_by: 2026-11-21-ARK-623-1
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
4. Repeat Step 1 with the quick `ark test --quick` process started with `ARK_FAKE_CPU_PERCENT=95`, which stays set for the whole step (the host hold's CPU limit stays exceeded). Poll for the `waiting for CPU` line. Then stop the holder and the full ticket's owner by their PIDs and wait for the quick ticket's `started`.
5. Repeat Step 1 with the waiting 3-core ticket holding no `mode` field (a file written by hand, as an older runner wrote it, owned by a spawned `sleep`). Then, with the 4 cores held and a waiting full ticket of 3 cores that has `mode: full` (also a hand-written file owned by a spawned `sleep`), run a whole-suite `bun test` (serial: it asks 1 core, which fits next to the 4 held) in a scratch repo that loads the repo's `test/tmpdir-preload.ts` (as `test/bare-test-budget.test.ts` does), in a project of a temp `ARK_HOME` whose `host.yml` has `test_budget_cores: 6` and `test_min_free_memory_percent: 0`. The preload takes the ticket through `openTestBudget` with no `mode` option, so the ticket gets the default `mode: "full"`. Poll for the waiting line and read the command log of the scratch repo. Then stop the holder and the waiting ticket's owner by their PIDs and read the exit code and the command log.
6. Race, two child processes of the `scenario` helper of `test/test-lock.test.ts`, each calling `openTestBudget` directly (not `ark test`), budget 6: the holder of 4 cores (a spawned `sleep`), a full child of 5 cores (waits: 4 + 5 > 6), and a quick child of 2 cores (fits: 4 + 2 <= 6). The gate is the opt-in `start` pause of the `node:fs` mock of the quick child, given to that one child only (no environment variable, no delay in a shared fake): after its read of the ticket folder and before its `started` write it reports `quick-at-start` and waits for `go`. The test (a) waits for `full-r1-poll-3` (the full ticket is published and waits), starts the quick child with the pause and waits for `quick-at-start`, and checks the full child is not running; (b) stops the holder by its PID; (c) waits for `full-running` (the quick ticket is not started yet, so 5 <= 6); (d) gives `go` to the quick child; (e) waits for `quick-after-3` (its third ticket write is the revocation) and checks the quick child is not running; (f) reads the ticket folder once and sums the `cores` of the started tickets; (g) stops the full child and waits for `quick-running`. Repeat the one test file with `bun test --rerun-each=20 <file>`.
7. Read the printed waiting line of the quick and the full runner and the `## ark test budget` rows of `ark chief state`.

## Expected results

- Step 2: the quick ticket has `started` at once (before the hold's next sample), the full ticket has none. The started cores never sum above 6 at any poll.
- Step 3: the 3-core quick ticket does not start while the 4 cores are held and starts only after the holder ends.
- Step 4: while the host hold waits, the overtaking quick ticket does not mark itself started, prints `waiting for CPU` with the 95 % reading as a first ticket does, and the started cores stay at 4. The hold stays at 95 % for the whole step: it applies only while a suite holds cores, so once the holder and the full ticket's owner are gone the quick ticket is the first and starts.
- Step 5: a waiting ticket without `mode` reads as `full` and is not pruned as unreadable: the quick ticket passes it when it fits, and its file is still in the folder. The bare `bun test` (1 core, which fits) has the default `mode: "full"`, so it does not pass the blocked full ticket: it prints its waiting line, runs no test file while the 4 cores are held and the 3-core full ticket waits, and runs every file once and exits 0 after the holder and the waiting ticket's owner are stopped. The `test.each` row of Step 1 with no `mode` field is the proof that a missing field reads as `full`, never `quick`.
- Step 6: the gate fixes the order, so it holds in every repeat: the earlier full child keeps `started` and runs, the quick child revokes (it is not running after its third write at step (e)), the started cores read in step (f) sum to 5 (the full ticket only; 7 means the revoke check is lost), and the quick child runs only after the full child ended. The delay is in the quick child only, and the test fails without the revoke check. The sum is read once, after (e), not at every poll.
- Step 7: the waiting line keeps its form (the place and the holders; no `mode` in it), and `ark chief state` lists the waiting and the started tickets as before.

## Screenshot checkpoints

None. The surface is ticket files and CLI output; no screenshot applies.
