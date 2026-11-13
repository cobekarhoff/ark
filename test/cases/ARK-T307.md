---
id: ARK-T307
title: ARK-T307 a refactor run that synced a target with new tests opens its merge request through ark merge-request open
level: integration
technique: state transition (synced, tested, merge request open), equivalence classes (synced, not synced)
priority: high
risk: "a synced refactor run still fails its base run on target-side tests, so ark merge-request open refuses with base_passed false and the run can never open its MR"
status: active
changed_by: 2026-11-12-ARK-435-1
---

## Objective

Prove the end of the ARK-435 failure: a refactor run that synced a target with new tests opens its MR. Serves ARK-435/AC3. Evidence: run 2026-11-12-ARK-372-1 failed 4 of 1058 base tests from target merges.

Expected: When a refactor run synced a target branch that has new tests, `ark merge-request open` shall open the merge request. The failed-base refusal stays owned by ARK-T12 (reuse), not repeated here.

## Preconditions

- Fixture refactor run (as `test/test-run.test.ts:523` and `:635`, and the `merge-request` fixtures) with a real git origin, a worktree with one own refactor commit, a `bun` suite, an AC with `method: test` and the run at the merge-request gate path (plan approved, `ark test` not yet run).
- After the worktree was created, the origin target gets a commit with new source and a new test that passes with it.

## Steps

1. In fixture 1, run `ark worktree sync <run>`, then `ark test <run>`, then `ark merge-request open <run>`.
2. Control: in a copy of fixture 1 with the same target move and no sync, run `ark test <run>` and read `base_passed` in the state.

## Expected results

- Step 1: `ark test` reports the base side passed, `base_passed` is true, `ark merge-request open` exits 0 and records the merge request. Before the fix it exits non-zero with the base refusal.
- Step 2: with no sync the base is the created base and passes as before: the new target test is not in the run at all.

## Screenshot checkpoints

None, command output.
