---
id: ARK-T197
title: ARK-T197 ark test-case new without --run refuses in the workspace checkout and works in a run worktree
level: integration
technique: equivalence classes (workspace checkout, run worktree, plain git repo) with a state check that a refusal writes nothing
priority: high
risk: an agent that omits --run in the main checkout still creates a stray untracked case file, or the refusal also blocks run worktrees and unrelated repos
status: active
changed_by: 2026-11-10-ARK-395-1
---

## Objective

Prove that without `--run`, `ark test-case new <KEY>` refuses in the workspace checkout of a project (the `workspace:` folder of `ark.yml`) and names the `--run` form, and that it works as today in a run worktree.

## Preconditions

- A temporary `ARK_HOME` holds a project whose `ark.yml` names `workspace:` as a temporary git repo (the main checkout) with a commit.
- A run worktree of that repo exists (a `git worktree` of the main checkout).

## Steps

1. In the main checkout, run `ark test-case new <KEY>` with no `--run`. Record stdout, stderr, exit code.
2. List `test/cases/` in the main checkout and check that no counter changed (the next allocation in step 4 continues the sequence without a gap).
3. In a subfolder of the main checkout, run `ark test-case new <KEY>` with no `--run`. Record the exit code.
4. In the run worktree, run `ark test-case new <KEY>` with no `--run`. Record stdout, stderr, exit code, and list `test/cases/` there.

## Expected results

- When `ark test-case new <KEY>` runs without `--run` in the workspace checkout, the system shall exit with code 1 and print nothing on stdout.
- When it refuses, the system shall print on stderr a message that names the checkout and contains `ark test-case new <KEY> --run <run>`.
- When it refuses, the system shall create no file under the main checkout's `test/cases/` and shall not advance the id counter.
- When it runs in a subfolder of the workspace checkout without `--run`, the system shall refuse the same way.
- When it runs in the run worktree without `--run`, the system shall exit with code 0, print the new id on stdout, and create the file under that worktree's `test/cases/`; its id is the first one after the refusals.

## Screenshot checkpoints

none: integration case on CLI output, exit code and files; no UI surface.
