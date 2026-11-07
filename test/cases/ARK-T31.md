---
id: ARK-T31
title: ARK-T31 every sync and merge-request test that starts a run or builds a scenario has a timeout of at least 30 seconds
level: integration
technique: boundary values (each timeout against the 30 s minimum)
priority: medium
risk: a sync or merge-request test that starts a run or builds a scenario gets a timeout below 30 seconds, so it times out on a busy host
status: active
changed_by: 2026-11-06-ARK-319-1
---

## Objective

Prove that every test in `test/sync.test.ts` and `test/merge-request.test.ts` that starts a run or builds a scenario sets a timeout of at least 30 seconds. Converted from the legacy test ARK-237-AC1; serves ARK-319/AC4.

Expected: When a sync or merge-request test starts a run or builds a scenario, the system shall require a timeout of at least 30 seconds.

## Preconditions

- A checkout with `bun` installed.
- `ARK_LOAD_PROOF` is unset: the check is not behind that switch.

## Steps

1. Run `bun test test/timeouts.test.ts -t ARK-T31`.
2. Read the exit code and the pass and skip counts.

## Expected results

- Exit code 0, `1 pass`, no non-zero `skip` count.
- At least one git-heavy test is found in the two files, and none has a timeout below 30000 milliseconds.

## Screenshot checkpoints

None, CLI output.
