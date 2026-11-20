---
id: ARK-T686
title: ARK-T686 the reader timeout is read from ARK_READER_TIMEOUT_MS at each call by exec, execJson, execResult and orcaRead as a real limit, and an unset, empty, non-numeric, zero, negative, infinite or above-2^31 value keeps 2 s
level: integration
technique: equivalence classes (unset, empty, non-numeric, zero, negative, Infinity, above 2147483647, small positive, large positive) and boundary values (a command that outlasts 2 s but not 30 s, a limit of 1 s (below the 2 s default) that cuts a 6 s command), with the variable set after the module is loaded
priority: high
risk: the variable is read once at module load (the constant of cli/exec.ts stays), so a test that sets process.env after import never reaches execJson, execResult or the defaults of cli/orca.ts, which pass the limit to exec explicitly; or the variable is read only in the default of exec; or a set value is not a limit (any value means no wait limit); or production loses its 2 s limit when the variable is unset or holds junk, because zero, a negative number, NaN, Infinity or a value above 2147483647 reaches setTimeout and fires it at once (Bun clamps those to 1 ms), so every reader returns null after about 1 ms
status: active
changed_by: 2026-11-19-ARK-572-1
---

## Objective

Prove AC1 of ARK-503 at the real boundary, a real child process behind each reader that takes the default limit:

- With `ARK_READER_TIMEOUT_MS=30000`, a command that sleeps longer than 2 s returns its output instead of null.
- With the variable unset, a command that sleeps longer still returns null after about 2 s.
- A set value is a limit: with `1000`, a 6 s command is cut after about 1 s, and the timeout reason names 1 s.
- The variable is read at call time: it is set after `cli/exec.ts` and `cli/orca.ts` are imported.
- A value that is empty, not a number, zero, negative, `Infinity` or above 2147483647 (the largest delay `setTimeout` accepts) gives the 2 s default, not a limit of 1 ms.

`exec`, `execJson`, `execResult` of `cli/exec.ts` and `orcaRead` of `cli/orca.ts` are the callers whose default is the one limit of the file. The other three defaults of `cli/orca.ts` (`orcaPages`, `readChiefTasks`, `readChiefQueue`) share that expression and are not given a row (see `test-design.md`).

Expected: When `ARK_READER_TIMEOUT_MS` is a number from 1 to 2147483647, the system shall wait that many milliseconds for an external reader; when it is unset or any other value, the system shall wait 2000.

## Preconditions

- Bun test, in `test/exec.test.ts` or beside it. The modules are imported once at the top of the file, and the test sets and deletes `process.env.ARK_READER_TIMEOUT_MS` between the starts of the calls. `afterEach` restores the value that was set before the file started.
- A fake `orca` (shell script) first on `process.env.PATH`. For any `orca orchestration probe <seconds> --json` it sleeps `<seconds>` and prints `{"result":{"ok":true}}`. The row for `orcaRead` calls `orcaRead(["probe", "<seconds>"])`; the case does not assert the argv.
- The commands: `["/bin/sh", "-c", "sleep 2.5; echo done"]` (the 2.5 s command) and `["/bin/sh", "-c", "sleep 6; echo done"]` (the 6 s command); `execJson` rows print `{"ok":true}` instead of `done`.
- The default of each reader is read when the call starts. The test therefore starts every call of the rows below one after the other, without awaiting between them, and sets or deletes the variable just before each start; it then awaits them all. The rows run side by side and the case takes about 2.5 s (the longest row), not the sum of the rows. The file timeout of 30 s (`setDefaultTimeout(30_000)`) holds the case.
- Each row records the start time of its call and its elapsed time when it settles.

## Steps

1. With `ARK_READER_TIMEOUT_MS=30000`, start `exec`, `execJson` and `execResult` with the 2.5 s command and no timeout argument, and `orcaRead(["probe", "2.5"])`.
2. Delete the variable. Start `exec`, `execJson` and `execResult` with the 6 s command and no timeout argument, and `orcaRead(["probe", "6"])`.
3. With `ARK_READER_TIMEOUT_MS=1000`, start `exec` and `execResult` with the 6 s command and no timeout argument, and `orcaRead(["probe", "6"])`.
4. For each of the values `""`, `abc`, `0`, `-5`, `NaN`, `Infinity` and `2147483648`: set the variable and start `exec` with the 6 s command and no timeout argument.
5. With `ARK_READER_TIMEOUT_MS=30000`, start `exec` with the 2.5 s command and an explicit timeout of 300 ms.
6. Await every call and read each result and elapsed time.

## Expected results

- Step 1: `exec` returns `done\n`; `execJson` returns `{ ok: true }`; `execResult` has code 0, stdout `done\n` and `timedOut` false; `orcaRead` returns `{ ok: true, value: { ok: true } }`. None is a timeout, although the variable was set after the import.
- Step 2: `exec` and `execJson` return null; `execResult` has `timedOut` true; `orcaRead` returns `{ ok: false, reason: "timed out after 2 s" }`. Each elapsed time is at least 2 s and below the 6 s of the command.
- Step 3: `exec` returns null, `execResult` has `timedOut` true, and `orcaRead` returns `{ ok: false, reason: "timed out after 1 s" }`. Each elapsed time is at least 0.9 s and below 1.9 s: a set value is a limit, not an unlimited wait, and it is not the 2 s default.
- Step 4: every one of the seven values behaves as unset: `exec` returns null and its elapsed time is at least 2 s and below 6 s. A value that gives a limit of about 1 ms (elapsed far below 2 s) or an unlimited wait (the 6 s command ends) fails the row.
- Step 5: an explicit timeout argument still wins: `exec` returns null after about 300 ms (elapsed below 2 s), not after 2.5 s or 30 s.

## Screenshot checkpoints

none: a library-level case with real child processes; there is no UI surface.
