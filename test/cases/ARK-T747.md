---
id: ARK-T747
title: ARK-T747 the ark process of the test helper sees ARK_ORCA_TIMEOUT_MS 60000 when the test sets none and the test's own value when it sets one, and an ark process with no ARK_ORCA_TIMEOUT_MS started outside the helper still cuts an Orca read at 10 s
level: integration
technique: equivalence classes on the source of the Orca limit (nobody sets it, the test sets it, nobody sets it outside the helper)
priority: high
risk: "spawnArk passes no ARK_ORCA_TIMEOUT_MS, so a test that sets none has no 60 s to keep its own value against; or the 60 s default is put after ...process.env in spawnArk, so it overrides a test's own short value and a test can no longer force an Orca timeout; or the fix raises the production default of orcaTimeout (cli/orca.ts) instead of the test helper, so a real ark waits 60 s or more for a hung Orca; or the production read limit drops below 10 s"
status: active
changed_by: 2026-11-20-ARK-612-1
---

## Objective

Prove AC2 of ARK-612: the `ark` process that `spawnArk` starts keeps a value the test sets, against the 60 s default it gets when the test sets none, and an `ark` process that does not go through `spawnArk` and has no `ARK_ORCA_TIMEOUT_MS` keeps the production limit of 10 s (`orcaTimeout(10_000)` in `readTerminals`, `cli/orca.ts`).

Row 1 reads the value the `ark` child actually has. The child passes its own env to each `orca` it spawns (`env: process.env` in `cli/exec.ts`), so a fake `orca` that records `ARK_ORCA_TIMEOUT_MS` sees the env of the `ark` process, as the fake of `test/run.test.ts` does with `env.log`. Row 1a (no value in the test) fails on the baseline: the child sees no value. Row 1b (the test's `2000`) fails when the default is put after `...process.env`: the child sees `60000`.

Row 2 cannot use `ark()`, because `spawnArk` always adds the default: it spawns `cli/ark.ts` itself with an env that lacks the key. It passes before and after a correct fix and fails when the fix lands in production code. A test that sets the variable to an empty string (`withProductionLimits`) is ARK-T732's guard and is not repeated here.

Expected: When the test helper starts an ark process and the test sets no `ARK_ORCA_TIMEOUT_MS`, the ark process shall have `ARK_ORCA_TIMEOUT_MS=60000`; when the test sets `ARK_ORCA_TIMEOUT_MS`, the ark process shall have the test's value; when an ark process starts outside the test helper with no `ARK_ORCA_TIMEOUT_MS`, the system shall cut an Orca read at 10 s.

## Preconditions

- The advice project and fake of ARK-T746 (`adviceProject` in `test/companions.test.ts`). All rows run against this one setup in one test.
- Row 1: `writeFakeCommand("orca", ...)` of `test/helpers.ts` puts a wrapper first on PATH. The wrapper appends `${ARK_ORCA_TIMEOUT_MS-absent}` as one line to a log file in `$FAKE_COMPANION_DIR`, then `exec`s the companion fake (`$FAKE_COMPANION_DIR/bin/orca "$@"`), so the advice still goes through. `removeFakeCompanionTools` restores PATH after the test.
- `ARK_ORCA_TIMEOUT_MS` is not set in `process.env` before row 1a (asserted). Row 1b sets it and restores the saved value in `finally` (`delete` when it was unset), so no later test meets it.
- Row 2: `hangVerbs: ["run-list"]` and `hangMilliseconds: 12000`, set after row 1. Row 2 never edits `process.env`: its env is a copy of `process.env` without `ARK_ORCA_TIMEOUT_MS` and with `ARK_READER_TIMEOUT_MS=30000`, so the unrelated 2 s reader limit cannot cut `terminal list` on a loaded host and fail the row for the wrong reason.

## Steps

1. Row 1a: with no `ARK_ORCA_TIMEOUT_MS` in `process.env`, run `ark companion advise cortana <R1> <advice> --project <project>` through `arkP`. Read the exit code and the lines the wrapper logged.
2. Row 1b: set `process.env.ARK_ORCA_TIMEOUT_MS = "2000"`, empty the wrapper's log, and run the same command through `arkP`. Read the exit code and the logged lines. Restore the variable.
3. Row 2: set the hang of the preconditions and run the same command with `Bun.spawnSync(["bun", "cli/ark.ts", ...])` and the env of the preconditions. Read the exit code, stderr, the elapsed time, the delivered messages and `hung-done.jsonl` at the moment the command returns.

## Expected results

- Row 1a: exit code 0, the wrapper logged at least one line, and every line is `60000`: the helper gave the child the default.
- Row 1b: exit code 0, the wrapper logged at least one line, and every line is `2000`: the test's value won over the default.
- Row 2: exit code 1, stderr holds `Orca did not answer`, no send is delivered.
- Row 2: `hung-done.jsonl` is absent when the command returns, so the read was cut before the 12 s answer (not 60 s); the elapsed time is at least 9.5 s, so the cut came from the 10 s limit and not from a shorter one (the 2 s reader or the 3 s wake bound). No upper bound on time is asserted: the marker proves it.

## Screenshot checkpoints

none: a CLI case with a fake orca; there is no UI surface.
