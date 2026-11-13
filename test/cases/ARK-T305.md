---
id: ARK-T305
title: ARK-T305 a clean ark worktree sync, and a conflict the --merge implementer resolves, each record the merged target commit in worktree.synced, and a conflicting sync records none
level: integration
technique: state transition (never synced, clean sync, conflict, merge-resolved), equivalence classes of writer (sync clean, sync conflict, --merge step)
priority: high
risk: "the event still carries only repo and conflict, so ark test cannot find the target commit; the recorded commit is the worktree HEAD (the merge commit) and not the merged target tip; a conflicting sync records a commit that was never merged; the --merge implementer path records no worktree.synced, so a run that fixed a conflict by hand keeps the old base; the merge path records the target tip at the time of the step start and not the tip that was merged"
status: active
changed_by: 2026-11-12-ARK-435-1
---

## Objective

Prove that each path that merges the target branch into a run's repo worktree leaves a `worktree.synced` event with the target commit it merged. Serves ARK-435/AC1. The field is optional: only a merge that went in carries it.

Expected: When `ark worktree sync` merges the target branch into a repo worktree, the system shall record the merged target commit in the `worktree.synced` event of that repo; when an implementer step started with `--merge` finishes with the target branch merged, the system shall record the merged target commit the same way.

## Preconditions

- Fixture run in a temp `ARK_HOME` with a real git origin (as in `test/sync.test.ts`), a worktree on the run branch with one own commit, and the `worktree.created` base recorded.
- Repo A: after the worktree was created, the origin target branch gets commit `T1` (a new file, no overlap with the run's commit).
- Repo B: the origin target branch gets commit `C1` that edits the same line the run's commit edited, so a sync conflicts.
- A run in the build phase with a plan holding an implementer step on repo B.

## Steps

1. Run `ark worktree sync <run>` for repo A. Read the new `worktree.synced` event of repo A from `events.ndjson`, and `git rev-parse origin/<target>` and `git rev-parse HEAD` of the worktree.
2. Run `ark worktree sync <run>` for repo B (conflict). Read its `worktree.synced` event.
3. Move the origin target of repo B on with a second commit `C2` (so that the tip differs from the tip at the conflict). Start the implementer step with `ark run step <run> <step> start --merge`, merge `origin/<target>` in the worktree by hand, resolve the conflict, commit, and finish the step with `ark run step <run> <step> finish`. Read the `worktree.synced` events of repo B.
4. Run `ark worktree sync <run>` again on repo A with no new target commit, and read the event.
5. Append an old-shape `worktree.synced` event (only `repo`, `conflict`) to a copy of the log and derive the state, to prove the old shape stays valid.

## Expected results

- Step 1: the event of repo A has `conflict: false` and the target commit equal to `T1`, the origin tip that was merged. It differs from the worktree HEAD (the merge commit).
- Step 2: the event of repo B has `conflict: true` and no target commit field. Repo B stays in `sync_conflicts`.
- Step 3: after the finish, a new `worktree.synced` event of repo B has `conflict: false` and the target commit equal to `C2`, the tip that is an ancestor of the worktree HEAD at the finish. Repo B leaves `sync_conflicts`. No step but the `--merge` implementer one wrote it.
- Step 4: the event records the same commit again with no error.
- Step 5: the old-shape event is accepted and derives with no target commit.

## Screenshot checkpoints

None, event log and git output.
