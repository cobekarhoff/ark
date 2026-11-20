---
id: ARK-T702
title: ARK-T702 ark chief state and ark services status print a Hub line with the answer time and lag, say stalled after 5 s, and read a missing or dead hub as no hub, not as stalled
level: integration
technique: boundary values (answer 1.5 s after arrival below the limit, no answer at 5 s above), state transition (running, frozen, continued) and decision table over hub presence
priority: high
risk: the Hub line is missing from one command; or a hub that answers in 1.5 s is called stalled, or a hub with no answer is waited on for ever (the command hangs behind the stalled hub it should report); or a missing, dead-pid or not-installed hub reads as stalled or breaks the command; or the two commands print different Hub lines; or a hub that was stalled stays stalled after it answers; or the CLI cannot find a hub started from another clone of the repo (the installed hub runs from `~/.ark/bin-src`)
status: active
changed_by: 2026-11-19-ARK-533-1
---

## Objective

Prove the CLI shows the hub's answer time and lag, and says stalled when the health route does not answer within 5 s, in both commands (ARK-533/AC4). Expected: When the health route answers, `ark chief state` and `ark services status` shall print a Hub line with the answer time and loop lag; when it does not answer within 5 s, the Hub line shall say the hub is stalled and the commands shall still finish.

Question 3: the four existing Services tests expect only `not installed` rows and know nothing about a hub. `test/chief.test.ts:376-395` pins the Services section of `chief state` to the output of `services status` byte for byte; the two outputs now hold two different answer times, so that test is a contract test to update: compare the Services rows without the Hub line, and compare the Hub line shape of both. The commands' own `bun cli/ark.ts` run is the boundary.

## Waiting rule (test/wallclock.test.ts, ARK-T126)

The test file holds no `setTimeout(`, `Bun.sleep(`, `waitForTimeout(` or `.toBeLessThan(<3 or more digits>)`, and the guard's allowance cannot be raised. Every wait is an event: a process exit (the commands end on their own), a health-route poll loop whose answer ends it (the requests are the wait), or a fake-tool marker file. The hub stays frozen until both commands have exited, so no delay is needed for the 5 s stall; the CLI's own 5 s limit is the product's. The slow answer of step 4 is held by a fixture process, not by the test (see step 4). Limits are named constants (`answerLimitMilliseconds` 1000, `stallLimitMilliseconds` 5000, `slowAnswerSeconds` 1.5) compared with `toBeLessThanOrEqual`, `toBeGreaterThanOrEqual` or a boolean; a wall-time bound is a lower bound, or the named limit as a boolean. The validator runs `bun test test/wallclock.test.ts` before it finishes.

## Preconditions

- Temp `ARK_HOME` and `HOME`, a project with `ark.yml`, the fake `launchctl` of `test/chief.test.ts` (`ARK_LAUNCHCTL`).
- Real hubs: `bun hub/main.ts --port 0` for the same repo folder the CLI runs from, with fake tools on `PATH`. Freeze with `kill -STOP <pid>` (a plain `child.kill("SIGSTOP")` does not stop a Bun child); wait until `ps -o stat=` starts with `T`, as in ARK-T268. Always `kill -CONT` then `SIGTERM` the hub by its pid at the end.
- The 5 s stall is real and needed: it is the AC's limit and the probe has no shorter path without a second code path. Both commands run at the same time in step 5, so the case costs about 5 s there.
- The delaying proxy of step 4 is a fixture process under `test/fixtures/` (a fixed delay held in a fixture, like the `sleep` of the fake `orca`; the wallclock scan reads no fixture), started with a target port, a listen port and `slowAnswerSeconds`. It writes `proxy.arrived` when a request reaches it and forwards that request to the real hub, with the hub's own `Host`, after the delay counted from that arrival. The test file holds no timer.
- The test sets its own timeout of 60 s.

## Steps

1. No hub: no lock file. Run `ark chief state --project P` and `ark services status --project P`.
2. A lock file of the hub's name that holds a dead pid and a closed port. Run both.
3. Start a hub and open `/events`. Run both. Capture each Hub line.
4. Start the delaying proxy in front of the hub of step 3 (listen port free, target the hub's port). Write a second `ARK_HOME` (`proxyHome`) with the same temporary project as the original home: `projects/P/ark.yml` copied from the original home (`resolveProject` lists projects of the home the command runs in, `cli/paths.ts:31-55`, so a home without it fails with `project P does not exist`). In `proxyHome` write `hub-<hash>.lock` (the file name the real hub made in its own home) with `{"pid": <real hub pid>, "port": <proxy port>}`. Run `ark services status --project P` with `ARK_HOME=proxyHome` (same `HOME` and `ARK_LAUNCHCTL` as the other steps) and await its exit. The request reaches the proxy whenever the command is ready and is answered `slowAnswerSeconds` after it arrived, so the command's startup time cannot change the delay the hub reports. Capture its Hub line, and the marker `proxy.arrived`.
5. `kill -STOP` the hub and run both commands at once (two spawned processes, started together). Await both exits; record each exit code and the wall time from spawn to exit (`performance.now()`).
6. `kill -CONT` the hub. Run both again.
7. Start a second hub from a copy of the repo folder (`copyOfRepository` of `test/hub-idle.test.ts`, as the installed hub runs from a different clone) with its own `ARK_HOME`, and run both commands from this repo with that `ARK_HOME`.

## Expected results

- Steps 1 and 2: both commands exit 0; the Services rows are as before (`not installed` for each service); no Hub line says stalled and none shows an answer time; each wall time is at most `stallLimitMilliseconds` as a boolean (no wait on a dead port; a command that waited for the 5 s limit would exceed it).
- Step 3: both exit 0; each has a Hub line with an answer time in ms (at most `answerLimitMilliseconds`) and a loop lag in ms. The two Hub lines have the same shape (equal after the numbers are replaced). The Services rows of `chief state` equal the rows of `services status` once the Hub line is removed from each.
- Step 4: `proxy.arrived` exists; exit 0 (the project `P` resolves in `proxyHome`, so the command reaches the Hub line); the Hub line shows an answer time of at least 1000 ms (the proxy held it 1500 ms from arrival) and does not say stalled: the hub that answers late is slow, not stalled. The ARK-T700 route's JSON came through the proxy unchanged, so the loop lag is the hub's.
- Step 5: both exit 0 after a wall time of at least `stallLimitMilliseconds` (the command waited the limit; there is no upper bound but the case timeout, and a hung command fails by it); the Hub line says the hub is stalled and shows no answer time; every other line (the Services rows, and the other sections of `chief state`) is printed.
- Step 6: both Hub lines show an answer time again and do not say stalled.
- Step 7: the Hub line shows an answer time (the CLI finds a hub that its own repo folder did not start).

## Screenshot checkpoints

none: command output and exit codes only
