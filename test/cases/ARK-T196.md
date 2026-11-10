---
id: ARK-T196
title: ARK-T196 ark test-case new --run writes into the run worktree from the main checkout and keeps ids unique
level: integration
technique: equivalence classes (cwd in main checkout versus run worktree) and state transition (counter after each call)
priority: high
risk: the file lands untracked in the main checkout instead of the run's branch, or an id is reused across the main checkout and the run worktrees
status: active
changed_by: 2026-11-10-ARK-395-1
---

## Objective

Prove that `ark test-case new <KEY> --run <run>` writes `test/cases/<KEY>-T<n>.md` under that run's worktree whatever the working directory, never into the main checkout, and that ids stay unique across the main checkout and the run worktrees.

## Preconditions

- A temporary `ARK_HOME` holds a project whose `ark.yml` names `workspace:` as a temporary git repo (the main checkout) with a commit.
- A run folder of that project has a worktree of the repo (a `git worktree` of the main checkout) recorded as the run's worktree.
- `test/cases/` in the main checkout holds a case `<KEY>-T5.md`.

## Steps

1. From the main checkout, run `ark test-case new <KEY> --run <run>`. Record stdout, stderr, exit code.
2. List `test/cases/` in the main checkout and in the run worktree. Run `git status --porcelain` in the main checkout.
3. From an unrelated folder (a temporary non-git directory), run `ark test-case new <KEY> --run <run> --project <project>` again. Record stdout and exit code.
4. List `test/cases/` in the run worktree again.

## Expected results

- When `ark test-case new <KEY> --run <run>` runs in the main checkout, the system shall exit with code 0 and print the new id alone on stdout.
- When the command succeeds, the system shall print the path of the new file under the run worktree's `test/cases/` on stderr.
- When the command succeeds, the system shall create the file in the run worktree and no new file in the main checkout; `git status --porcelain` there is empty.
- The id from step 1 is greater than `<KEY>-T5` (unique against the main checkout).
- When the command runs from an unrelated folder, the system shall write a second file in the run worktree with an id different from the first.

## Screenshot checkpoints

none: integration case on CLI output, exit code and files; no UI surface.
