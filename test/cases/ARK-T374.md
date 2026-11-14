---
id: ARK-T374
title: ARK-T374 merge-request open still refuses a head whose commits after the passing test include an own commit, a conflict-resolving merge, an altered merge tree, a merge of a non-target commit, an own commit between clean merges, or an octopus merge
level: integration
technique: decision table over the commit shapes after H (own, resolved conflict, altered tree, foreign second parent, own commit between clean merges, octopus), each against the one accepted shape owned by ARK-T373
priority: high
risk: the accepted-merge check is too loose, so an untested commit (the run's own, hand-resolved conflict code, a file added inside a merge) ships under the tested evidence of H; or it accepts any merge commit instead of a clean target merge
status: active
changed_by: 2026-11-13-ARK-463-1
---

## Objective

Prove that `ark merge-request open` refuses every head that has, after the passing test head H, any commit that is not a clean `ark worktree sync` merge of `origin/<target>`, and that it refuses with the same `changed since the last test run` message. Six refused shapes run through the real CLI; the one accepted shape (a single clean sync) is ARK-T373, so a check that only counts parents, or only looks at the second parent, fails here or there.

## Preconditions

- Fixture of `test/sync-base.test.ts` (`syncedRun`) with the `moveTarget` helper and the fake host of `test/fixtures/merge-request` (`gh` and `fake-host.ts`, first on `PATH`, `FAKE_LOG` set), as in ARK-T373 (including `FAKE-1-AC1` with `verified_by: [FAKE-T1]` and its head evidence sha H). Every refusal here happens in `assertShippable` before any host call, so the host never answers; it is named so the fixture is the same as ARK-T373's, whose accepted control then runs on it unchanged. A fresh fixture for each shape below; a full `ark test <run>` passes in each before the shape is built. The test reads H with `git -C <worktree> rev-parse HEAD` after the test and takes every other sha from git, never from the code under test.
- Shapes use real git in the run worktree: a conflict shape edits `src.txt` in the run (own commit before the test, already `own`) and on the target with a different line value, so `git merge origin/main` conflicts.
- The test records `git ls-remote origin` refs, the `events.ndjson` line count and the run phase before each open.
- A fixture with a submodule is not used.

## Steps

For every shape, run the test first, build the shape after it, then run `ark merge-request open <run>` and `ark status <run>`.

1. (a) Own commit: commit a new file in the worktree. No sync.
2. (b) Resolved conflict: `moveTarget` with a change to `src.txt`; `git merge origin/main` conflicts; edit `src.txt` to a hand-written resolution, `git add`, `git commit --no-edit`. The merge commit has first parent H and second parent on `origin/main`, and its tree is not what `git merge-tree --write-tree` makes of the parents (that call exits 1).
3. (c) Altered tree: `moveTarget` with a new file; `git merge --no-commit --no-ff origin/main`, add an extra file `extra.txt`, commit. The merge is conflict-free, but the committed tree differs from the merge of its parents by that file.
4. (d) Foreign second parent: create a local branch with one commit that is not on `origin/main`; merge it with `git merge --no-ff` into the worktree branch. The merge is clean and its tree is exact, but its second parent is not on `origin/<target>`.
5. (e) Own commit between two clean merges: `moveTarget`, `ark worktree sync`, an own commit, `moveTarget` again, `ark worktree sync`. Both merges are clean; the own commit lies between them.
6. (f) Octopus: `moveTarget` twice with different files (T1 then T2, both on `origin/main`), `git fetch origin`. Build the three-parent merge with plumbing, because `git merge` drops a parent that is an ancestor of another: `tree=$(git merge-tree --write-tree HEAD origin/main)`, `c=$(git commit-tree $tree -p HEAD -p T1 -p T2 -m octopus)`, `git reset --hard $c`. Assert `git rev-list --parents -1 HEAD` shows three parents (H, T1, T2) before the open. The tree is the exact merge of H and the target tip and both extra parents are commits of `origin/main`, so only the parent count can refuse it.
7. (g) Accepted control: `moveTarget`, one clean `ark worktree sync`. Assert `ark merge-request open` exits 0 and `ark status` says `test head: current`. It is the decision table's accepted row: it shows that no refusal above is caused by an unrelated guard such as a missing `origin` or an evidence problem, and it fails on the code before the fix, as the refusals do not. ARK-T373 owns the accepted contract (the named line, the chain of syncs, the second open).
8. For (a) to (f): assert exit code 1 from `ark merge-request open`, `changed since the last test run`, `repo .` and `run ark test <run> again` in the error, remote refs, `events.ndjson` line count and phase unchanged, and `ark status` `test head:` line `stale`.
9. For (b) and (c), also assert `ark status` does not say `test head: current`, and that the error text has no line naming H as the accepted head.

## Expected results

- When any commit after H is an own commit (a), the system shall keep the head stale and `ark merge-request open` shall refuse.
- When a merge after H resolved a conflict (b), the system shall keep the head stale and refuse.
- When the tree of a merge after H differs from what git merges its two parents into (c), the system shall keep the head stale and refuse.
- When the second parent of a merge after H is not a commit of `origin/<target>` (d), or the commit has more than two parents (f), the system shall keep the head stale and refuse.
- When an own commit lies between two clean sync merges (e), the system shall keep the head stale and refuse.
- When the refusal fires, the system shall push nothing and append no event.
- When the head is one clean sync merge after H (g), the system shall accept it and open (the contract is owned by ARK-T373).

## Screenshot checkpoints

none: integration case on CLI refusals and git state; no UI surface.
