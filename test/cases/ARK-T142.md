---
id: ARK-T142
title: ARK-T142 the post-merge refresh moves a submodule to the merged commit
level: integration
technique: state transition
priority: high
risk: the submodule moves to the branch head of a squash-merged upstream, or the refresh commit never reaches the remote, so the downstream MR pins a commit that is not on the upstream target branch
status: active
changed_by: 2026-11-09-ARK-338-1
---

## Objective

Prove that the post-merge refresh moves a submodule to the merged commit.

## Preconditions

Repo lib and repo app (holds lib as the submodule libs/lib) each have a bare remote. The lib MR !41 is merged by squash: the commit on main differs from the branch head. The app MR !87 waits for !41, and its bump step bump-lib points libs/lib at the lib branch head.

## Steps

Run the case with `bun test test/post-mr.test.ts`.

1. Make the host fail and run `ark bump refresh <run> bump-lib`.
2. Make the host answer and run `ark merge-request status <run>`.
3. Run `ark bump refresh <run> bump-lib`, then `ark merge-request status <run>`.
4. Finish the validator and reviewer steps, run `ark test <run>`, then `ark worktree sync <run>`.
5. Merge the upstream MR by fast-forward (the merged commit is the pinned branch head) and run `ark bump refresh <run> bump-lib`.
6. Squash-merge the upstream MR, stage an unrelated file in the app worktree and run the refresh.
7. Run `ark bump refresh <run> implementer --to 1.0.0` on a run whose plan has no such bump step.

## Expected results

- The refresh with the failing host exits non-zero and leaves libs/lib at the branch head.
- The first status shows `waits for !41 (merged)` and `points at upstream branch ` with the branch head.
- The refresh prints `refreshed bump-lib to <8 characters of the merged commit>`, libs/lib in the app worktree is at the merged commit, and the status shows `refreshed to <8 characters>`.
- `ark test` exits 0, and the app branch on the bare remote equals the worktree head and holds the merged commit at libs/lib.
- The fast-forward refresh exits 0, makes no new commit, leaves the app head unchanged and records one `bump.refreshed` with the pinned commit.
- The refresh commit holds only `libs/lib`, and the unrelated file is still staged.
- The refresh of a step that is not a bump step exits 1 with `is not a bump step of the plan` and records no `bump.refreshed`.

Proof: `test/post-mr.test.ts`.

## Screenshot checkpoints

None. The surface is CLI output.
