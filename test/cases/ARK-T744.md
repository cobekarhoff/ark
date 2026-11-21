---
id: ARK-T744
title: ARK-T744 a nested bun test whose first 2 rmSync calls of its bun-test-* root throw EFAULT still exits 0, prints no error and leaves no root
level: integration
technique: fault injection (the first 2 removals of the root throw EFAULT, below the retry limit), equivalence classes (the preload's own opt-in fault, a test-side `--preload` fault that also reaches the base)
priority: high
risk: a transient EFAULT (or EBUSY) from the recursive rm of the preload's `bun-test-*` root, as on the Linux CI runner in runs 44796185110 and 44826239875, throws out of the preload's `afterAll`, so an inner `bun test` whose tests passed exits non-zero and ARK-T714 (and any test that reads the exit of a nested `bun test`) fails; or the retry is added but the root is left behind after a later call succeeds
status: active
changed_by: 2026-11-20-ARK-610-1
---

## Objective

Prove that when the first 2 `rmSync` calls on the preload's `bun-test-*` root throw EFAULT, the preload retries, the root is removed by a later call, and the `bun test` process keeps the exit status of its tests (0 for one passing test) with no error in its output. The process is a `bun test` started by another `bun test`, as the inner run of ARK-T707 and ARK-T714 was when CI failed, so the nested root is the root under test. Serves ARK-610/AC1.

Expected: exit 0, ` 1 pass`, no `EFAULT` and no error in stdout or stderr, the recorded `bun-test-*` root no longer exists, and the preload made 3 calls on it (2 faults, then the removal).

## Preconditions

- The case is a test of `test/tmpdir-preload.test.ts` (the outer `bun test`). It writes a scratch fixture like `writeFixture` and starts the inner `bun test` like `spawnBunTest`, cwd the repo root (so `bunfig.toml` loads `test/tmpdir-preload.ts`), with a scratch `TMPDIR`.
- The fixture has one passing test. Its body writes `process.env.TMPDIR` (the inner `bun-test-*` root) and `process.env.ARK_FAKE_HOST` to a record file the case owns, outside both roots.
- The preload's opt-in fault: `ARK_PRELOAD_RM_FAULTS=<N>` makes the first N `rmSync` calls of the `bun-test-*` root (never of the fake host root) throw an error with code `EFAULT` and the message `EFAULT: bad address in system call argument, rm '<root>'`; `all` makes every call throw. `ARK_PRELOAD_RM_LOG=<file>` makes the preload append one line with the root path before each `rmSync` call of either root. Both are documented in `docs/how-to/work-on-ark.md`.
- The test-side fault for the base: a preload file the case writes into its scratch folder and passes to the inner run with an extra `--preload`. It replaces `rmSync` of `node:fs` (`mock.module`, which reaches the named import of `test/tmpdir-preload.ts`) with a wrapper: a call whose path equals the live `process.env.TMPDIR` appends the path to a log file and, for the first N such calls, throws the same EFAULT error; every other call goes to the real `rmSync`. It lives only in the case, in no product file and no export.
- Both variables (and the test-side preload's own N and log path) go only into the `env` object of the inner `bun test`. The case never sets them in its own `process.env`, so no other nested `bun test` of the outer suite faults.

## Steps

1. Row "preload fault": start the inner `bun test <fixture>` with `ARK_PRELOAD_RM_FAULTS=2` and `ARK_PRELOAD_RM_LOG=<log>` in its env. Wait for it to exit (await the child, no sleep). Read the exit code, stdout and stderr, the record file and the log.
2. Row "test-side fault": start the same fixture with `--preload <scratch>/efault.ts` and N = 2 for that preload, no `ARK_PRELOAD_RM_FAULTS`. Wait for it to exit and read the same.
3. In each row, check the recorded host root too.
4. Check the outer `process.env` holds neither `ARK_PRELOAD_RM_FAULTS` nor `ARK_PRELOAD_RM_LOG`.

## Expected results

- Both rows: the inner run exits 0 and reports ` 1 pass` and ` 0 fail`.
- Both rows: stdout and stderr hold no `EFAULT`, no `error:` line and no line that names the `bun-test-*` root.
- Both rows: the recorded `bun-test-*` root (under the scratch `TMPDIR`) and the recorded host root no longer exist after the exit.
- Both rows: the log holds exactly 3 lines that name the `bun-test-*` root (2 faulted calls, then the call that removed it). A fix without a retry gives 1 line and a left root.
- Step 4: the outer `process.env` holds neither variable.
- At base (`test/tmpdir-preload.ts` without the retry): row "test-side fault" exits non-zero and its output contains `EFAULT: bad address in system call argument, rm`; row "preload fault" writes no log, so its 3-line check fails. The case is red at base for the intended reason in the test-side row.

## Screenshot checkpoints

none: exit code, output and filesystem state of a child process; no UI surface.
