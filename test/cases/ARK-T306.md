---
id: ARK-T306
title: ARK-T306 after a sync ark test runs the base side of a repo at the newest synced target commit, and at the worktree.created base when the repo was never synced or the event has no commit
level: integration
technique: equivalence classes (never synced, synced clean, synced then conflict event, old-shape event), state transition (sync after the target moved)
priority: high
risk: "the base side stays at the worktree.created base, so a test that came in from the target branch fails at a base that lacks its source; the state base field is overwritten with the target commit, so the MR ahead count, the paths skip and the old-id check change meaning; the checkout and the copied-in test files use different bases; a newer conflict-only event clears the commit; a never-synced or old-shape run loses its base"
status: active
changed_by: 2026-11-12-ARK-435-1
---

## Objective

Prove that the base side of `ark test` uses the target commit of the newest `worktree.synced` event that has one, and keeps the `worktree.created` base otherwise. Serves ARK-435/AC2. Own files of the run still count as own.

Expected: When `ark test` runs the base side of a repo that was synced, the system shall check out the target commit of the newest `worktree.synced` event of that repo that carries one; when the repo was never synced, or no event carries a commit, the system shall check out the `worktree.created` base.

## Preconditions

- Fixture run of kind `feature` as in `test/test-run.test.ts` (one `bun` suite with no `base_files` and no `base_command`, so the base side runs the whole suite; a real git origin, a worktree on the run branch, own commit adding source and its own test `ARK-T900`).
- After the worktree was created, the origin target gets a commit adding `src/late.ts` and `test/late.test.ts` with a test titled `ARK-T901` that passes only when `src/late.ts` exists.
- Repo N (never synced) is a second repo of the run whose target moved the same way and that was not synced.

## Steps

0. Every `ark test` below is expected to exit 0: on a feature run a base failure of the own test `ARK-T900` does not fail the run, and `ARK-T901` passes at head and base once synced.
1. Run `ark test <run>` for repo N and read its base result and base commit in the evidence (`results/evidence/<case>/base/`).
2. Run `ark worktree sync <run>` for the main repo. Run `ark test <run>`. Read the base result of `ARK-T901`, `ARK-T900` and the base commit.
3. Read `state.json` and the derived worktree base of the main repo.
4. Move the target on a third time (commit `T2` with a second late test), run `ark worktree sync`, run `ark test <run>` again. Read the base commit.
5. Append a conflict-only `worktree.synced` event (`conflict: true`, no commit) for the main repo as the newest event, run `ark test <run>` and read the base commit.
6. Drop the commit from every synced event (old shape), run `ark test <run>` and read the base commit.

## Expected results

- Step 1: the base commit of repo N is the `worktree.created` base; `ARK-T901` is `not run` or absent there and does not fail it.
- Step 2: the base commit is the target tip merged by the sync; `ARK-T901` passes at base and at head; `ARK-T900` (own test) fails at base and passes at head, as a new test does, and `ark test` still exits 0 (feature run); the base side is not failed by a test that came from the target.
- Step 3: the worktree base in the state is still the `worktree.created` base, so the MR ahead count (`base..HEAD`) and the paths skip are unchanged.
- Step 4: the base commit is `T2`'s tip (the newest synced commit wins over the one from step 2). Base-SHA cache invalidation is not asserted here: ARK-T163 owns it.
- Step 5: the base commit is still the newest commit that a synced event carries (reading: the newest event with a commit wins), and the run is not reset to the created base.
- Step 6: the base commit is the `worktree.created` base and `ark test` does not error.

## Screenshot checkpoints

None, test output and evidence files.
