---
id: ARK-T375
title: ARK-T375 the old-id check of ark test diffs from the synced target commit, so a merged target commit never counts, while the run's own change to an old-id declaration still fails
level: integration
technique: state transition (sync merges a target edit, then the run's own edit) with a paired positive and negative check
priority: high
risk: every run that syncs a main commit editing or deleting an old-id test fails `old-id` for a line the run never touched (the 2026-11-13 ARK-432 escalation); or, after the fix, the check diffs from a base that hides the run's own old-id change, or a stale synced commit that HEAD does not hold makes the run's diff include the target's reverted work
status: active
changed_by: 2026-11-13-ARK-463-1
---

## Objective

Prove that after `ark worktree sync` merges a target commit that edits and deletes tests whose titles carry an old AC id, `ark test` reports its `old-id` check as passed (0 declarations touched), and that when the run then edits an old-id test itself the same check fails and names that line. The case also covers a synced commit that HEAD no longer holds.

## Preconditions

- Fixture of `test/sync-base.test.ts` (`syncedRun("feature")`) with the `moveTarget` helper, with one addition to the base commit: `test/old.test.ts` holds three tests titled `ARK-9-AC2 first`, `ARK-9-AC3 second`, `ARK-9-AC4 third`, each with a body line, pushed to the origin before the run starts (so the run's created base holds them). The suite is the bun suite of the fixture, which runs `./test`.
- Only tests that call `ark test` read the result; the test never reads the verdict from `oldIdsTouched` or `baseSide`. It reads the `old id` line of the `ark test` output and the `check-old-id-<suite>.log` of the run's `results/`.
- A fresh fixture for each variant. The `ark test` runner of each fixture is stopped at the end, as the other files do (`stopStartedRuns`).

## Steps

1. Variant A (target edit merged, then own edit). `moveTarget` with one commit that deletes the `ARK-9-AC2` test and edits the body line of `ARK-9-AC3` in `test/old.test.ts`. Run `ark worktree sync <run>`; assert exit 0.
2. Run `ark test <run>`. Assert the output line starting `old id` for suite `e2e` says `passed` and `0 old-id declarations touched`, the output does not contain `old id touched`, and `results/check-old-id-e2e.log` is empty.
3. In the run worktree edit the body line of `ARK-9-AC4 third`, commit. Run `ark test <run>` again. Assert the `old id` line says `failed`, the output names `test/old.test.ts` with the line of `ARK-9-AC4`, and does not name `ARK-9-AC2` or `ARK-9-AC3`; assert the output carries the `write a test case` fix hint and the run fails.
4. Variant B (the synced commit is not in HEAD). In a fresh fixture, `moveTarget` with the Variant A commit, `ark worktree sync <run>`, then `git reset --hard <the head before the sync>` in the worktree, so `worktree.synced` names a commit that HEAD does not hold, and the run has no old-id edit of its own. Run `ark test <run>`. Assert the `old id` line says `passed` and does not list `ARK-9-AC2` or `ARK-9-AC3`: the diff starts at the merge base of HEAD and the synced commit, so the reverted target work does not count.
5. In Variant A also assert `old id` was run, not skipped: the `old id` line does not contain `skipped`.

## Expected results

- When `ark worktree sync` merged a target commit that edits or deletes an old-id test and the run has not touched an old-id declaration, the `old-id` check of `ark test` shall pass and name 0 touched declarations.
- When the run edits an old-id declaration after such a sync, the `old-id` check shall fail and name only the run's own line.
- When the newest synced target commit is not an ancestor of HEAD, the check shall diff from the merge base of HEAD and that commit (variant B), so the target's changes never count as the run's own.
- The no-sync case (base stays the created base) is owned by ARK-T207 (a) and is not repeated here.
- The check shall not be silently skipped in any variant (no `skipped (scan failed` text).

## Screenshot checkpoints

none: integration case on CLI output and git state; no UI surface.
