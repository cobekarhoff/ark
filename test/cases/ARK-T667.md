---
id: ARK-T667
title: ARK-T667 the pr-writing scripts gather, lint_body, post_mr and review refuse a project folder and work in a repo outside ARK_HOME and in a run worktree
level: integration
technique: equivalence classes (project folder, run worktree nested in it, repo outside ARK_HOME) over the four scripts that share repoRoot(), with a state check that a refusal writes nothing
priority: high
risk: gather.ts, lint_body.ts, post_mr.ts or review.ts run from a project folder that is a git repository take the project repo as the code repo (gather writes .pr-writing/ into it, post_mr posts from it), or the guard in repoRoot() also blocks the run's worktree or a published repo outside Ark where there is no project folder
status: active
changed_by: 2026-11-14-ARK-494-1
---

## Objective

Prove that the four scripts of `skills/pr-writing/scripts` that find their repository with `git rev-parse --show-toplevel` from the cwd (through `repoRoot()`) refuse when that repository is a project folder under `ARK_HOME/projects`, and that the guard is inert in a run worktree nested under it and in a repo outside `ARK_HOME`.

## Preconditions

- A temporary `ARK_HOME` through a symlinked path, holding project `demo` as a git repository (`git init`, `.gitignore` with `runs/`, one commit) with a run folder `runs/<run>/`.
- A run worktree `runs/<run>/workspace` (a real nested git worktree on a branch with a commit and an `origin` url).
- A separate temporary git repo outside `ARK_HOME` with a branch, a commit and an `origin` url (a repo that uses the published skill).
- Fake `gh` and `glab` executables first on PATH that record every call.
- Real `gather.ts`, `lint_body.ts`, `post_mr.ts`, `review.ts`. No mocks of the scripts.

## Steps

1. From the project folder run `gather.ts`, `lint_body.ts`, `post_mr.ts --confirmed` and `review.ts`. Record exit code, stdout, stderr of each.
2. List the project folder and `git status --porcelain` there, and read the fake CLI call logs.
3. From the run worktree run `gather.ts`. Record exit code and check for `.pr-writing/ledger.json` there.
4. From the repo outside `ARK_HOME` run `gather.ts`. Record exit code and check for `.pr-writing/ledger.json` there.

## Expected results

- When `gather.ts`, `lint_body.ts` or `post_mr.ts` runs in the project folder, the system shall exit with code 1 and name the project folder on stderr.
- When `review.ts` runs in the project folder, the system shall exit with code 1 and not fall back to the project folder as its root.
- When a script refuses, the system shall create no `.pr-writing/` folder in the project folder, `git status --porcelain` there is empty, and the fake `gh` and `glab` logs hold no call.
- When `gather.ts` runs in the run worktree, the system shall exit with code 0 and write `.pr-writing/ledger.json` there, not in the project folder.
- When `gather.ts` runs in a repo outside `ARK_HOME`, the system shall exit with code 0 and write its ledger there.

## Screenshot checkpoints

none: integration case on CLI output, exit code and files; no UI surface.
