---
id: ARK-T747
title: ARK-T747 a test's own ARK_ORCA_TIMEOUT_MS wins over the 60 s of the test helper, and an ark process with no ARK_ORCA_TIMEOUT_MS started outside the helper still cuts an Orca read at 10 s
level: integration
technique: equivalence classes on the source of the Orca limit (the test sets it, nobody sets it outside the helper) against the same 12 s run-list
priority: high
risk: "the 60 s default is put after ...process.env in spawnArk, so it overrides a test's own short value and a test can no longer force an Orca timeout; or the fix raises the production default of orcaTimeout (cli/orca.ts) instead of the test helper, so a real ark waits 60 s or more for a hung Orca; or the production read limit drops below 10 s"
status: active
changed_by: 2026-11-20-ARK-612-1
---

## Objective

Prove AC2 of ARK-612: the 60 s default of `spawnArk` loses to a value the test sets, and an `ark` process that does not go through `spawnArk` and has no `ARK_ORCA_TIMEOUT_MS` keeps the production limit of 10 s (`orcaTimeout(10_000)` in `readTerminals`, `cli/orca.ts`).

The second row cannot use `ark()`, because `spawnArk` always adds the default: it spawns `cli/ark.ts` itself with an env that lacks the key. It passes before and after a correct fix; it fails when the fix lands in production code. A test that sets the variable to an empty string (`withProductionLimits`) is ARK-T732's guard and is not repeated here.

Expected: When an ark process starts with no `ARK_ORCA_TIMEOUT_MS`, the system shall cut an Orca read at 10 s; when a test sets `ARK_ORCA_TIMEOUT_MS`, the ark process the test helper starts shall use that value.

## Preconditions

- The advice project and fake of ARK-T746 (`adviceProject` in `test/companions.test.ts`), with `hangVerbs: ["run-list"]` and `hangMilliseconds: 12000`. Both rows run against this one setup in one test.
- `ARK_ORCA_TIMEOUT_MS` is not set in `process.env` before row 1. Row 1 sets it and restores the saved value in `finally` (`delete` when it was unset), so no later test meets it.
- Row 2 never edits `process.env`: its env is a copy of `process.env` without `ARK_ORCA_TIMEOUT_MS` and with `ARK_READER_TIMEOUT_MS=30000`, so the unrelated 2 s reader limit cannot cut `terminal list` on a loaded host and fail the row for the wrong reason.

## Steps

1. Set `process.env.ARK_ORCA_TIMEOUT_MS = "2000"` and run `ark companion advise cortana <R1> <advice> --project <project>` through `arkP`. Read the exit code, stderr, the delivered messages and `hung-done.jsonl`. Restore the variable.
2. Run the same command with `Bun.spawnSync(["bun", "cli/ark.ts", ...])` and the env of the preconditions. Read the exit code, stderr, the elapsed time, the delivered messages and `hung-done.jsonl` at the moment the command returns.

## Expected results

- Row 1: exit code 1, stderr holds `Orca did not answer`, no send is delivered, and `hung-done.jsonl` is absent: the test's 2 s cut the read, so the 60 s default did not override it.
- Row 2: exit code 1, stderr holds `Orca did not answer`, no send is delivered.
- Row 2: `hung-done.jsonl` is absent when the command returns, so the read was cut before the 12 s answer (not 60 s); the elapsed time is at least 9.5 s, so the cut came from the 10 s limit and not from a shorter one (the 2 s reader or the 3 s wake bound). No upper bound on time is asserted: the marker proves it.

## Screenshot checkpoints

none: a CLI case with a fake orca; there is no UI surface.
