---
id: ARK-T111
title: ARK-T111 worktree create fills each submodule at its recorded commit and keeps the worktree when a submodule fails
level: integration
technique: equivalence classes (repo with submodule, repo without, submodule that cannot be fetched)
priority: high
risk: a run worktree leaves its submodule folder empty or at another commit, so a consumer is tested against nothing and passes; or a failed submodule step deletes the worktree or is deleted as stale by the next create
status: active
changed_by: 2026-11-08-ARK-337-1
---

## Objective

Prove that `ark worktree create` initialises the submodules of the worktree it makes, at the commits the worktree records, and that a failing submodule stops with its cause and keeps the worktree.

## Preconditions

- Real git. A temp meta-repo with a consumer repo that holds a library repo as a submodule at `vendor/lib` (added with `git -c protocol.file.allow=always submodule add`), the library having two commits and the consumer's index recording the first.
- A second plain repo in the meta-repo with no submodule.
- A started run on that meta-repo. No mocks of git or of `ark worktree`.

## Steps

1. In the consumer's source checkout read `git ls-files --stage -- vendor/lib` (the recorded gitlink). Run `ark worktree create` for the consumer repo.
2. In the new consumer worktree list `vendor/lib` and read `git -C vendor/lib rev-parse HEAD`, `git ls-files --stage -- vendor/lib`, `git diff --cached --raw` and `git status --porcelain`.
3. Run `ark worktree create` for the plain repo and compare its worktree with the same command's result before the change (files, events).
4. Make a second consumer whose recorded submodule commit does not exist in any reachable source (remove the object from the source clone's modules and point `.gitmodules` at a missing path). Run `ark worktree create` for it.
5. Run `ark worktree create` for that repo a second time.

## Expected results

- After step 1 the command shall exit 0 and `vendor/lib` shall hold the library's files.
- The submodule HEAD shall equal the commit recorded in the consumer's index (the first library commit), not the library's newest commit.
- The worktree's `git ls-files --stage -- vendor/lib` shall equal the step 1 value, `git diff --cached --raw` shall be empty, and `git status --porcelain` shall show no staged `vendor/lib` change (the index, not only HEAD, is unchanged).
- The plain repo's worktree shall be made as before: same files, no submodule step, no submodule output.
- In step 4 the command shall exit non-zero, name the consumer, the submodule path and the git cause, and the worktree folder shall still exist with its `worktree.created` event recorded.
- In step 5 the kept worktree shall not be removed as stale.
- `bun test test/worktree.test.ts` shall exit 0.

## Screenshot checkpoints

none: integration case on files, git state and a process exit code; no UI.
