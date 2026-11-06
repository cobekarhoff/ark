---
id: ARK-T22
title: ARK-T22 five bun test processes of the sync and merge-request files at once all pass without a timeout
level: integration
technique: load (five parallel processes)
priority: medium
risk: five parallel runs of the git-heavy suites hit a timeout, so the 30 s timeouts are too short under load
status: active
changed_by: 2026-11-06-ARK-319-1
---

## Objective

Prove that five `bun test` processes of `test/sync.test.ts` and `test/merge-request.test.ts` started at once all pass without a timeout. Converted from the legacy test ARK-237-AC2; it runs only with `ARK_LOAD_PROOF=1` because it takes 5+ minutes on a busy host (ARK-326). Serves ARK-319/AC4.

Expected: When ARK_LOAD_PROOF is 1, the system shall run five suites at once without a timeout.

## Preconditions

- A checkout with `bun` installed, on a quiet host.
- `ARK_LOAD_PROOF=1`.

## Steps

1. Run `ARK_LOAD_PROOF=1 bun test test/timeouts.test.ts -t ARK-T22`.
2. Read the exit code and the output.

## Expected results

- Exit code 0, `1 pass`.
- None of the five processes exits non-zero or reports `timed out`.
- The skip switch itself is proven by ARK-T19.

## Screenshot checkpoints

None, CLI output.
