---
id: ARK-T745
title: ARK-T745 when the removal of a preload root always fails, bun test keeps the exit status of its tests, prints one line with the root and the code, leaves the root and calls rmSync at most 4 times
level: integration
technique: fault injection (every removal fails), equivalence classes on the error code (retried EFAULT and EBUSY, ENOENT read as removed, EACCES not retried) and on the root (`bun-test-*`, fake host), boundary values (retry limit 3, so 4 calls)
priority: high
risk: the preload's cleanup still throws when the rm never succeeds (or for a code outside EFAULT, ENOENT and EBUSY), so a `bun test` whose tests passed exits non-zero; the retry loops without a limit and stalls the `afterAll` up to its 60 s or 5 s hook timeout; the failure is swallowed in silence, so a leaked root is never seen; the fake host root's hook keeps the old throwing `rmSync`; or a failing test's exit 1 is turned into 0
status: active
changed_by: 2026-11-20-ARK-610-1
---

## Objective

Prove that when `rmSync` of a preload root throws on every call, the preload retries a retried code 3 times (4 calls in all), then prints one line to stderr that names the root and the error code and goes on, so the `bun test` process exits with the status of its tests and the root stays. A code it does not retry is printed after 1 call; ENOENT counts as removed and prints nothing. The fake host root takes the same path. The process is a `bun test` started by another `bun test`. Serves ARK-610/AC2.

Expected: the exit code is that of the tests, stderr holds exactly one line with the root and the code, the root still exists, and the log holds 4 calls for EFAULT and EBUSY, 1 for EACCES and ENOENT.

## Preconditions

- The fixture, record file, scratch `TMPDIR`, inner `bun test` and the two fault routes of ARK-T744: the preload's own `ARK_PRELOAD_RM_FAULTS` and `ARK_PRELOAD_RM_LOG`, and the test-side `--preload` that replaces `rmSync` of `node:fs`. Here the test-side preload also takes the error code to throw (the message `<CODE>: ..., rm '<root>'`) and which root to fault: the live `process.env.TMPDIR` or the live `process.env.ARK_FAKE_HOST`.
- A second fixture whose one test fails (`expect(1).toBe(2)`) and records the roots the same way.
- All variables go only into the `env` object of the inner `bun test`, never into the outer `process.env`.
- The case removes each root a row leaves (with a plain `rmSync` of its own after the row), so no `bun-test-*` or `/tmp/ark-fake-host-*` folder outlives the case.

## Steps

1. Row "every call, passing test": the passing fixture with `ARK_PRELOAD_RM_FAULTS=all` and `ARK_PRELOAD_RM_LOG=<log>`. Wait for the exit (await the child, no sleep). Read the exit code, stdout and stderr apart, the record file and the log.
2. Row "every call, failing test": the failing fixture, same env.
3. Rows through the test-side preload, passing fixture, every call faulted: code `EBUSY` on the `bun-test-*` root; code `EACCES` on the `bun-test-*` root; code `ENOENT` on the `bun-test-*` root; code `EFAULT` on the fake host root. The test-side preload logs each call on the faulted root.
4. After each row, check which recorded roots exist, then remove the ones left.

## Expected results

- Row 1: exit 0, ` 1 pass`. stderr holds exactly one line that contains the `bun-test-*` root path and `EFAULT`; stdout holds no such line. The root still exists. The log holds exactly 4 lines that name it (1 call and 3 retries). The host root no longer exists and no line names it (the preload fault hits the `bun-test-*` root only).
- Row 2: exit 1, ` 1 fail`; the same one stderr line, the root left, 4 calls. The cleanup neither hides the failing test nor adds a second failure.
- `EBUSY` row: as row 1 with `EBUSY` in the line (a retried code: 4 calls).
- `EACCES` row: exit 0, one stderr line with the root and `EACCES`, the root left, exactly 1 call (not retried, never thrown).
- `ENOENT` row: exit 0, exactly 1 call, no stderr line that names the root (ENOENT counts as removed).
- Fake host row: exit 0, one stderr line with the host root path and `EFAULT`, the host root left, 4 calls; the `bun-test-*` root is gone.
- In no row does the log exceed 4 lines for one root, and no row hits a hook timeout.
- At base: rows 1 and 2 write no log and no line (the variables do nothing), and every test-side row exits non-zero with the thrown code: the case is red at base.

## Screenshot checkpoints

none: exit code, the two output streams and filesystem state of a child process; no UI surface.
