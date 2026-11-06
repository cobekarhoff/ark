---
id: ARK-T19
title: ARK-T19 the five-process load test of ARK-T22 runs only with ARK_LOAD_PROOF=1
level: integration
technique: equivalence classes (variable unset against variable set to 1)
priority: high
risk: the ARK-T22 test that starts five `bun test` processes runs on every full `bun test`, so on a busy host it hits its 300 s limit and fails the suite; or it never runs, even with ARK_LOAD_PROOF=1
status: active
changed_by: 2026-11-06-ARK-319-1
---

## Objective

Prove that `test/timeouts.test.ts` skips the five-process ARK-T22 test unless `ARK_LOAD_PROOF=1`, and runs it when the variable is set. Serves ARK-326/AC1 and ARK-319/AC4.

Expected: While ARK_LOAD_PROOF is unset, the system shall skip the five-process test and exit 0; when ARK_LOAD_PROOF is 1, the system shall run it.

## Preconditions

- A checkout with `bun` installed.
- For the with-variable side, a temporary folder holds a fake `bun` script. It appends its arguments to a log file and exits 0. The folder is first on `PATH` of the child process only.

## Steps

1. Run `bun test test/timeouts.test.ts -t ARK-T22` in a child process with `ARK_LOAD_PROOF` removed from the environment. Read the exit code and the skip and pass counts from the output.
2. Run the same command in a child process with `ARK_LOAD_PROOF=1` and the fake `bun` first on `PATH`. Read the exit code, the counts and the log file.

## Expected results

- Step 1: exit code 0, `1 skip`, and no non-zero `pass` count.
- Step 2: exit code 0, `1 pass`, no non-zero `skip` count. The log has five lines, each `test test/sync.test.ts test/merge-request.test.ts`. This proves that the test is not skipped and starts five processes of the two files. It does not prove that the real runs pass; the fake `bun` replaces the real five-process run, which takes 5+ minutes on a loaded host and is verified by running with `ARK_LOAD_PROOF=1` on a quiet host.

## Screenshot checkpoints

None, CLI output.
