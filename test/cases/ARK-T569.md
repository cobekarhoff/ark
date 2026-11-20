---
id: ARK-T569
title: ARK-T569 a process call that stalls in test/worker-start.test.ts (the `ark` helper, the `tempGitRepo` git call, the raw git call of `snapshotOf`, the hub of `startHub`) fails the case at the limit a test sets through ARK_TEST_LIMIT_MS (2 s or less, the case ends in under 5 s), with the command line, the limit and what the command printed, and the default limit of the file stays below its 30 s test timeout
level: integration
technique: equivalence classes over the four kinds of process call the file makes (the shared `ark` helper, the `git` of `tempGitRepo`, a raw git call of the file, the hub of ARK-T308), observed through real child processes that do not exit, behind a PATH shim
priority: high
risk: "a stalled call of worker-start.test.ts has no limit, or reads `ARK_TEST_LIMIT_MS` once at import (`processLimitMs` captured by `ark`, `tempGitRepo`, `startHub`, `stopHub` and `git` when the module loads), so a value set inside the test is ignored and the stall waits the 25 s default (ARK-572: ARK-T569 took 25 s four times on CI, 100 s) or ends by the 30 s test timeout with no command and no stderr (PR #223 ARK-T211 to ARK-T216, T308; PR #229); or one call path (`ark`, the `git` of `tempGitRepo`, the raw `git status --porcelain` of `snapshotOf`, the hub of ARK-T308) keeps a fixed limit and ignores the variable; or the variable leaks past the stall and a later healthy call of the file runs under 1.5 s and fails under CI load; or the default of the file is raised to 30 s or more (or to the shared 45 s `commandLimitMs`) while the short stall tests still pass; or the failure of a killed silent child has an empty message that names neither the command nor the limit"
status: active
changed_by: 2026-11-19-ARK-572-1
---

## Objective

Prove that each kind of process call that `test/worker-start.test.ts` makes (the `ark` helper, the `git` of `tempGitRepo`, the raw git call of `snapshotOf`, the hub that `startHub` starts for ARK-T308) has a time limit below the file's 30 s test timeout, and that a call that exceeds it fails the case with its command line, the limit and what the command wrote to stderr. The file does not use the default repo of `addWorktree` (`test/fake-orca.ts`), which would reach the shared `tempGitRepo` at 45 s: `buildRun` passes the file's own bounded `tempGitRepo()`. Serves ARK-479/AC1.

Ownership (`rules/test-audit.md`, one contract one owner): ARK-T400 owns the behavior of the shared helpers `arkWithin` and `tempGitRepo`'s git against the 60 s timeout of `test/worktree-submodule.test.ts`: the stall message shape, the fast failure and the healthy output, with a bound below 60 000. ARK-T569 owns one thing: the value of each limit that worker-start uses against its own 30 s timeout, with a bound below 30 000. The two bounds differ (30 000 against 60 000) and both stay, because the same helpers run under two test timeouts. A limit of 45 s (today's `commandLimitMs`) passes ARK-T400 and fails ARK-T569, so ARK-T400 does not prove the value for `tempGitRepo` in worker-start. The `ark` helper and `tempGitRepo`'s `git` are two call paths with no shared constant: `ark` passes no timeout (`test/helpers.ts:106-114`), only `git` reads `commandLimitMs` (`:75`). Each needs its own bound below 30 000 in this case: ARK-T569 step 1 for `ark`, step 2 for `tempGitRepo`. The `tempGitRepo` stall of ARK-T569 uses a file set no other test builds, as ARK-T400 does, so a cached template cannot hide the stall; the call and message shape stay with ARK-T400, ARK-T569 adds only the stricter bound.

The authoring gate:

1. The contract is the observable failure of a stalled call at the real process boundary (a child that does not exit), against the limit the file picks.
2. The regression is an unbounded call, a limit read once at import (the short value never reaches the call, which waits 25 s), or a default of 30 s or more.
3. ARK-T211 to ARK-T216 and ARK-T308 start only commands that finish, so they cannot show it. ARK-T400 asserts the `tempGitRepo` limit only below 60 000 (`test/worktree-submodule.test.ts:389,444`), so a 45 s limit passes it while a stalled `tempGitRepo` in worker-start still ends at the 30 s timeout.
4. No export, flag or hook is needed. The case calls what the file already calls: `ark`, `tempGitRepo` and the raw git call through `snapshotOf`. The stall is a program of the case's own on PATH.

Why `snapshotOf` stays: it is a raw `Bun.spawnSync` of the file, not the shared `git` helper, so a lowered shared limit does not bound it. This is a separate risk from the shared value: the helpers bounded and `snapshotOf` left unbounded.

Residual risk: the three raw `Bun.spawnSync` calls of the file (`git init` in `buildRun`, `git symbolic-ref` inline in an ARK-T210 test, `git status --porcelain` in `snapshotOf`) are three sites. The case drives only `snapshotOf`; the plan puts all three through one bounded call, so one stall proves the bound, and the reviewer reads the diff for the other two (no source grep as a test). `addWorktree`'s default repo is not used by the file: `buildRun` passes the file's bounded `tempGitRepo()`, so no call of the file reaches the 45 s default through `test/fake-orca.ts`.

`arkAt` is not a second stall: it sets `ARK_NOW` and returns `ark(...args)`, the same spawn.

Check in the plan, not in this case: the shared `ark` of `test/helpers.ts` is imported by 36 test files (`evaluation.md` line 20). If the plan lowers its default, the full `ark test` run in the validator step is the proof that no real call of those 36 files is killed by the lowered limit. No case covers that caller set.

Out of scope: the tests of this case live in `test/worker-start.test.ts` and must never start that file or `bun test`. The stall tests set `ARK_TEST_LIMIT_MS` to a named `stallLimitMs = 1_500` in `try/finally` around the one stalled call, assert the limit parsed from the message equals `stallLimitMs`, and compare the elapsed time with a named `stallBudgetMs = 5_000` (`test/wallclock.test.ts` (ARK-T126) refuses a new `toBeLessThan(<ms literal>)`, so no literal). The 30 s bound is asserted once, on the default (step 5), against `const testTimeoutMs = 30_000`, kept equal to the file's `setDefaultTimeout`.

Residual risk of the short limit (ARK-572): the stall tests run with the variable set, so they no longer show that each call path of the file falls back to the file's 25 s `processLimitMs` and not to the shared 45 s `commandLimitMs`. Step 5 proves the value the file resolves with the variable unset; the plan puts every call of the file (`ark`, `tempGitRepo`, `snapshotOf`, `startHub`, `stopHub`, the raw `git` calls) through one function of the file, so the reviewer reads the diff for a call that bypasses it. No source grep is a test.

## Preconditions

- Real `git` and real `bun` binaries. No mock of the helpers, and no fake `orca` is needed: the stall comes before `ark` runs `orca`.
- A shim directory first on `PATH` (`writeFakeCommand`, ARK-T400), restored in `finally`. Each shim replaces one command for the case only:
  - `git` shim A: prints `shim-git-stderr-marker` to stderr, then `exec sleep 90`. The `exec` is required: a killed `sh` leaves a `sleep` that holds the stderr pipe open, and `spawnSync` would wait for it.
  - `bun` shim B: prints nothing, then `exec sleep 90` (the `ark` helper starts `bun cli/ark.ts`).
  - `bun` shim C: prints `shim-hub-stderr-marker` to stderr, then `exec sleep 90` (`startHub` starts `bun hub/main.ts`).
- `ARK_TEST_LIMIT_MS` is set to `1500` after the modules are imported, in `try/finally` around the stalled call alone, and restored to its earlier value (unset). It is never set in `beforeEach` or around a healthy call.
- Each stall step is its own test under the file's 30 s timeout and stalls one call, so a test waits one limit of 1.5 s. The sleep (90 s) is longer than the test timeout: if the variable is ignored the case ends by the test timeout (or at the 25 s default) and fails; with the fix it ends at 1.5 s. The case has four stall tests and one default test.
- The file's own `tempArkHome` and `beforeEach` run as for any test; no run, project or ticket is created.
- Step 3 builds its scratch repo with the real PATH and the variable unset before shim A goes on PATH.

## Steps

1. With the variable set to `1500` and shim B on PATH, call `ark("status")` as the file calls it and catch what it throws. Record the limit named in the message and the elapsed time.
2. With the variable set to `1500` and shim A on PATH, call `tempGitRepo({ "worker-start-stalled-template.txt": "x\n" })` of `test/helpers.ts` (a file set no other test builds, so no cached template hides the stall) and catch the error. Record the limit and the elapsed time.
3. Create a scratch directory as a git repo (real PATH, `tempGitRepo()`), write `README.md` and `scratch.txt` as `dirtyWorktree` does, set the variable to `1500`, put shim A on PATH, call `snapshotOf(<directory>)` and catch the error. Record the elapsed time.
4. With the variable set to `1500` and shim C on PATH, call the file's `startHub()` and catch the error. The hub is never started for real. Record the elapsed time.
5. With no shim, no stall and the variable unset, read the default limit the file resolves for its calls (`limitOr(processLimitMs)`, the value `ark`, `tempGitRepo`, `snapshotOf`, `startHub` and `stopHub` use).

## Expected results

- Step 1: the call shall throw. The message shall contain the command line (`ark status`) and `timed out after 1500 ms`. A killed child (exit code `null`) shall not come back as a plain code 1 with empty stderr: the call shall throw, not return. The elapsed time shall be below `stallBudgetMs`.
- Step 2: the call shall throw. The message shall contain ` init -q -b main timed out after 1500 ms` and `shim-git-stderr-marker`. The elapsed time shall be below `stallBudgetMs`.
- Step 3: the call shall throw. The message shall contain `git status --porcelain`, `timed out after 1500 ms` and `shim-git-stderr-marker`. A return of an empty `status` string is a failure of the case. The elapsed time shall be below `stallBudgetMs`.
- Step 4: the call shall throw. The message shall contain `bun hub/main.ts --port 0 timed out after 1500 ms` and `shim-hub-stderr-marker`. The shared `startHub` called with no limit and no variable has no limit (AC1) and is not driven here: the file's `startHub` shall always pass a limit. The elapsed time shall be below `stallBudgetMs`.
- Step 5: the default limit shall be below `testTimeoutMs` (30 000), so a default of 30 000 or more, or the shared 45 000, shall fail the case although the four stall tests pass. After each stall test the variable is unset again.
- The stop of the hub (`stopHub` of the file) uses the same limit and is not driven by a stall test.

## Screenshot checkpoints

none: integration case on child processes and error text; no UI.
