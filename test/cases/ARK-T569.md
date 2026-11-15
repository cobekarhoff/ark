---
id: ARK-T569
title: ARK-T569 a process call that stalls in test/worker-start.test.ts (the `ark` helper, the `tempGitRepo` git call, the raw git call of `snapshotOf`, the hub of `startHub`) fails the case at a limit below the file's 30 s test timeout, with the command line, the limit and what the command printed
level: integration
technique: equivalence classes over the four kinds of process call the file makes (the shared `ark` helper, the `git` of `tempGitRepo`, a raw git call of the file, the hub of ARK-T308), observed through real child processes that do not exit, behind a PATH shim
priority: high
risk: "a stalled call of worker-start.test.ts has no limit, or a limit at or above the 30 s test timeout (the shared `commandLimitMs` is 45 s), so Bun reports only `timed out after 30000ms` with no command and no stderr (PR #223 ARK-T211, T212, T214, T215, T216, T308; PR #229 attempt 10 ARK-T212 to ARK-T215); or `ark` is bounded below 30 s but the `git` of `tempGitRepo` keeps `commandLimitMs` (45 s), so a stalled `tempGitRepo` in worker-start (`test/worker-start.test.ts:119`) still ends at the test timeout with no command; or the shared helpers are bounded but a raw `Bun.spawnSync` of the file (`git status --porcelain` in `snapshotOf`) is left unbounded; or the failure of a killed silent child has an empty message that names neither the command nor the limit; or the hub that ARK-T308 starts through `startHub` (`bun hub/main.ts --port 0`) never prints its address and fails only at the 30 s test timeout with no command and no stderr"
status: active
changed_by: 2026-11-14-ARK-479-1
---

## Objective

Prove that each kind of process call that `test/worker-start.test.ts` makes (the `ark` helper, the `git` of `tempGitRepo`, the raw git call of `snapshotOf`, the hub that `startHub` starts for ARK-T308) has a time limit below the file's 30 s test timeout, and that a call that exceeds it fails the case with its command line, the limit and what the command wrote to stderr. The file does not use the default repo of `addWorktree` (`test/fake-orca.ts`), which would reach the shared `tempGitRepo` at 45 s: `buildRun` passes the file's own bounded `tempGitRepo()`. Serves ARK-479/AC1.

Ownership (`rules/test-audit.md`, one contract one owner): ARK-T400 owns the behavior of the shared helpers `arkWithin` and `tempGitRepo`'s git against the 60 s timeout of `test/worktree-submodule.test.ts`: the stall message shape, the fast failure and the healthy output, with a bound below 60 000. ARK-T569 owns one thing: the value of each limit that worker-start uses against its own 30 s timeout, with a bound below 30 000. The two bounds differ (30 000 against 60 000) and both stay, because the same helpers run under two test timeouts. A limit of 45 s (today's `commandLimitMs`) passes ARK-T400 and fails ARK-T569, so ARK-T400 does not prove the value for `tempGitRepo` in worker-start. The `ark` helper and `tempGitRepo`'s `git` are two call paths with no shared constant: `ark` passes no timeout (`test/helpers.ts:106-114`), only `git` reads `commandLimitMs` (`:75`). Each needs its own bound below 30 000 in this case: ARK-T569 step 1 for `ark`, step 2 for `tempGitRepo`. The `tempGitRepo` stall of ARK-T569 uses a file set no other test builds, as ARK-T400 does, so a cached template cannot hide the stall; the call and message shape stay with ARK-T400, ARK-T569 adds only the stricter bound.

The authoring gate:

1. The contract is the observable failure of a stalled call at the real process boundary (a child that does not exit), against the limit the file picks.
2. The regression is an unbounded call, or one bounded at 45 s: the case then ends by the 30 s test timeout and fails.
3. ARK-T211 to ARK-T216 and ARK-T308 start only commands that finish, so they cannot show it. ARK-T400 asserts the `tempGitRepo` limit only below 60 000 (`test/worktree-submodule.test.ts:389,444`), so a 45 s limit passes it while a stalled `tempGitRepo` in worker-start still ends at the 30 s timeout.
4. No export, flag or hook is needed. The case calls what the file already calls: `ark`, `tempGitRepo` and the raw git call through `snapshotOf`. The stall is a program of the case's own on PATH.

Why `snapshotOf` stays: it is a raw `Bun.spawnSync` of the file, not the shared `git` helper, so a lowered shared limit does not bound it. This is a separate risk from the shared value: the helpers bounded and `snapshotOf` left unbounded.

Residual risk: the three raw `Bun.spawnSync` calls of the file (`git init` in `buildRun`, `git symbolic-ref` inline in an ARK-T210 test, `git status --porcelain` in `snapshotOf`) are three sites. The case drives only `snapshotOf`; the plan puts all three through one bounded call, so one stall proves the bound, and the reviewer reads the diff for the other two (no source grep as a test). `addWorktree`'s default repo is not used by the file: `buildRun` passes the file's bounded `tempGitRepo()`, so no call of the file reaches the 45 s default through `test/fake-orca.ts`.

`arkAt` is not a second stall: it sets `ARK_NOW` and returns `ark(...args)`, the same spawn.

Check in the plan, not in this case: the shared `ark` of `test/helpers.ts` is imported by 36 test files (`evaluation.md` line 20). If the plan lowers its default, the full `ark test` run in the validator step is the proof that no real call of those 36 files is killed by the lowered limit. No case covers that caller set.

Out of scope: the tests of this case live in `test/worker-start.test.ts` and must never start that file or `bun test`. They assert the message, never the elapsed time: `test/wallclock.test.ts` (ARK-T126) refuses a new `toBeLessThan(<ms literal>)`, so compare the limit parsed from the message with a named constant (`const testTimeoutMs = 30_000`, kept equal to the file's `setDefaultTimeout`), the way ARK-T400 does.

## Preconditions

- Real `git` and real `bun` binaries. No mock of the helpers, and no fake `orca` is needed: the stall comes before `ark` runs `orca`.
- A shim directory first on `PATH` (`writeFakeCommand`, ARK-T400), restored in `finally`. Each shim replaces one command for the case only:
  - `git` shim A: prints `shim-git-stderr-marker` to stderr, then `exec sleep 90`. The `exec` is required: a killed `sh` leaves a `sleep` that holds the stderr pipe open, and `spawnSync` would wait for it.
  - `bun` shim B: prints nothing, then `exec sleep 90` (the `ark` helper starts `bun cli/ark.ts`).
  - `bun` shim C: prints `shim-hub-stderr-marker` to stderr, then `exec sleep 90` (`startHub` starts `bun hub/main.ts`).
- Each step is its own test under the file's 30 s timeout, and each step stalls one call, so the test waits one limit. The sleep (90 s) is longer than the test timeout: at the base commit (no limit, or 45 s) the case ends by the test timeout and fails; with the fix it ends at the limit. The case has four stall tests.
- The file's own `tempArkHome` and `beforeEach` run as for any test; no run, project or ticket is created.
- Step 3 builds its scratch repo with the real PATH before shim A goes on PATH.

## Steps

1. With shim B on PATH, call `ark("status")` as the file calls it (default limit) and catch what it throws. Record the limit named in the message.
2. With shim A on PATH, call `tempGitRepo({ "worker-start-stalled-template.txt": "x\n" })` of `test/helpers.ts` (a file set no other test builds, so no cached template hides the stall) and catch the error. Record the limit named in the message.
3. Create a scratch directory as a git repo (real PATH, `tempGitRepo()`), write `README.md` and `scratch.txt` as `dirtyWorktree` does, put shim A on PATH, call `snapshotOf(<directory>)` and catch the error.
4. With shim C on PATH (`bun`: prints `shim-hub-stderr-marker` to stderr, then `exec sleep 90`), call the file's `startHub()` (the shared `startHub` of `test/helpers.ts` with the file limit) and catch the error. The hub is never started for real.
5. Read each message and parse the limit from it.

## Expected results

- Step 1: the call shall throw. The message shall contain the command line (`ark status`), `timed out after <limit> ms` and the limit shall be below 30 000. A killed child (exit code `null`) shall not come back as a plain code 1 with empty stderr: the call shall throw, not return.
- Step 2: the call shall throw. The message shall contain ` init -q -b main timed out after <limit> ms`, the limit below 30 000 and `shim-git-stderr-marker`. A limit of 45 000 or more shall fail the case, though it passes ARK-T400 (below 60 000).
- Step 3: the call shall throw. The message shall contain `git status --porcelain`, `timed out after <limit> ms`, the limit below 30 000, and `shim-git-stderr-marker`. A return of an empty `status` string is a failure of the case.
- Step 4: the call shall throw. The message shall contain `bun hub/main.ts --port 0 timed out after <limit> ms`, the limit below 30 000 and `shim-hub-stderr-marker`. The shared `startHub` without a limit shall fail the case by the 30 s test timeout.
- Step 5: the four limits shall be below the file's 30 s test timeout. They need not be equal. A limit at or above 30 000 shall fail the case. The stop of the hub (`stopHub` of the file) uses the same limit and is not driven by a stall test.

## Screenshot checkpoints

none: integration case on child processes and error text; no UI.
