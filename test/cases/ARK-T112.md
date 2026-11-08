---
id: ARK-T112
title: ARK-T112 create and sync check a submodule out at the run's library head, so a consumer test sees the change, and status names it
level: integration
technique: state transition (library commit, sync, consumer test) plus equivalence classes (submodule whose repo the run has vs has not)
priority: high
risk: ark test runs the consumer against the old library and passes; sync bumps the consumer's index pointer or fails on the dirty submodule; a library worktree made after the consumer is ignored; ark status hides which submodule runs at the run head
status: active
changed_by: 2026-11-08-ARK-337-1
---

## Objective

Prove that when the run also has a worktree of the submodule's repo, `ark worktree create` and `ark worktree sync` fetch from that worktree and check the submodule out at its head, leave the index pointer alone, and `ark status` prints the `submodule` line.

## Preconditions

- Real git. A temp meta-repo with a library repo, and a consumer repo that holds the library as a submodule at `vendor/lib`. The consumer has a test that reads a file of `vendor/lib`, configured as a suite of the project's `ark.yml` (`repo` = the consumer) so `ark test <run>` runs it in the composed workspace.
- A started run with worktrees of both the library and the consumer (the consumer's made after the library's, and once with the consumer's made first).
- A second submodule whose repo the run has no worktree of.
- No mocks of git or of `ark worktree`.

## Steps

1. In the consumer's source checkout read `git ls-files --stage -- vendor/lib`. Create the library worktree, commit a change to a file in it, then run `ark worktree create` for the consumer.
2. In the consumer worktree read `vendor/lib` HEAD and the changed file, `git ls-files --stage -- vendor/lib`, `git diff --cached --raw` and `git status --porcelain`. Commit the consumer's work, then run `ark test <run>` and read the consumer suite's head-side `results/evidence/<case id>/head/command.log` and `result.json`.
3. Commit a second change in the library worktree, leave a third change uncommitted, run `ark worktree sync`, read the same values, commit the consumer's work, run `ark test <run>` again and read the head-side log.
4. Run `ark status <run>`.
5. Repeat step 1 with the consumer's worktree made first and the library's second, then run `ark worktree create` again.
6. Read the other submodule (no run worktree of its repo) and the `ark status` output.

## Expected results

- After step 1 `vendor/lib` HEAD shall equal the library worktree's head, and the `ark test <run>` head-side log of step 2 shall show the consumer suite passing having read the library change (the library revision the log reports equals the library worktree's head, not the recorded commit and not an empty folder).
- After create and after sync `git ls-files --stage -- vendor/lib` shall equal the step 1 value, `git diff --cached --raw` shall be empty and `git status --porcelain` shall show no staged `vendor/lib` change.
- After step 3 the head-side log of the second `ark test <run>` shall show the second change and not the uncommitted one, and sync shall exit 0 with the dirty submodule in place.
- `ark status` shall print `submodule <consumer>/vendor/lib at run head of <library repo> <8 characters>`, the 8 characters being the start of the library head, once for each such submodule.
- In step 5 the second `create` shall move the submodule to the library head.
- The submodule without a run worktree of its repo shall stay at its recorded commit and shall have no `submodule` line in `ark status`.
- `bun test test/worktree.test.ts` shall exit 0.

## Screenshot checkpoints

none: integration case on git state, a consumer test result and CLI text; no UI.
