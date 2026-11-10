---
id: ARK-T113
title: ARK-T113 a newer ark test does not take a free lock while an older live waiter exists
level: integration
technique: state transition (budget free, older live waiter present, then waiter gone) with an equivalence class on the arrival order
priority: high
risk: a newer ark test takes the free budget at once, so a run that waited longer starves behind later runs (ARK-317 waited 3 hours)
status: active
changed_by: 2026-11-09-ARK-390-1
---

## Objective

Prove that a newer `ark test` leaves a free budget alone while a live waiting ticket with an earlier arrival of the same size exists, and starts once that ticket has gone.

## Preconditions

- A temporary `ARK_HOME` with one run (real `ark test` child process, real suite script that logs `start <run>`), a budget of 6 cores and no running ticket.
- A live older waiter: a spawned `sleep` process (live pid, not the test process). Its ticket in `test-budget` holds `run`, `pid`, `cores` 6 and an `arrival` earlier than now, and no `started`.

## Steps

1. Start `ark test` for the newer run.
2. Wait until its stdout holds `waiting: place 2 of 2; running: none`. Wait for the text, no fixed sleep.
3. Check that `ark test` still runs and the suite log has no `start` line for it.
4. Kill the spawned `sleep` process.
5. Wait for `ark test` to exit.

## Expected results

- While the older live ticket exists, the newer `ark test` shall print `waiting: place 2 of 2; running: none`, shall not start its suites and shall keep running.
- After the older ticket's process has gone, the newer `ark test` shall start its suites, exit 0 and leave no ticket.
- At the base commit the newer `ark test` takes the free lock at once and never prints `waiting:`, so step 2 fails there.

## Screenshot checkpoints

none: integration case on ticket files and process output.
