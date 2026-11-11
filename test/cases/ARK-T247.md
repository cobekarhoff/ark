---
id: ARK-T247
title: ARK-T247 a repo with no base keeps the origin/HEAD target while a configured repo uses its base
level: integration
technique: equivalence classes (repo with no configured base / repo with a configured base)
priority: medium
risk: a configured base leaks to every repo, or a repo with no base loses the origin/HEAD fallback, so an MR targets the wrong branch
status: active
changed_by: 2026-11-11-ARK-407-1
---

## Objective

Prove that `ark merge-request open` targets the branch `origin/HEAD` names for a repo with no configured base, and the configured `repos.<repo>.base` for another repo of the same run.

## Preconditions

- Real git and a fake `gh` and `glab` that record their calls.
- Two repos in one run: `core` (GitHub, no configured base) and `app` (GitLab, `base: release/9`).
- In `core`, `origin` has a `develop` branch and `refs/remotes/origin/HEAD` points at `origin/develop`.
- The run passed `ark test` at the current heads.

## Steps

1. Run `ark merge-request open <run>`.
2. Read the exit code and the create calls of `gh` and `glab`.

## Expected results

- The open shall exit 0.
- When a repo has no base, the system shall target the branch that origin/HEAD names: the `gh` create call has `--base develop`.
- The configured repo shall target its base: the `glab` create call has `--target-branch release/9`.

## Screenshot checkpoints

none: CLI integration case; the observables are exit code and forge call arguments.
