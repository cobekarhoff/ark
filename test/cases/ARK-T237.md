---
id: ARK-T237
title: ARK-T237 ark worktree sync runs setup after a merge that changes package.json or bun.lock, before any push, and a dependency the merge added loads in the worktree
level: integration
technique: state transition (before merge / after merge and setup) with a real package load as the observable
priority: high
risk: worktreeSync merges a new dependency and pushes without running setup, so suites fail with ERR_MODULE_NOT_FOUND until someone runs bun install by hand (ARK-244, 11 minutes lost); or setup runs after the push; or setup runs when no dependency file changed
status: active
changed_by: 2026-11-11-ARK-407-1
---

## Objective

Prove that `ark worktree sync` runs the project's `setup` in a worktree whose merge changed `package.json` or `bun.lock`, before it pushes, and that a local-folder package the merge added loads with bun from a process that starts in the worktree.

## Preconditions

- Real git and real bun; no network. A temp bare `origin`, a run worktree on the run branch, and a fixture project with `package.json` and `bun.lock`.
- A local folder package `fixture-dep` (a `package.json` and an `index.js` exporting a marker value) outside the repo, referenced as `file:` dependency.
- The project `setup` is `bun install --frozen-lockfile` (the real command), plus a line that appends `setup` to a log file, so the order against the push is visible.
- Three variants, each with its own worktree and origin commit, all with a valid fixture install (`bun install --frozen-lockfile` succeeds):
  - both: one commit adds `fixture-dep` to `package.json` and to a `bun.lock` that the fixture generated.
  - package-only: one commit changes only `package.json` (a field such as `description`, lockfile still matches).
  - lockfile-only: one commit changes only `bun.lock` (a valid regenerated lockfile, for example a comment-neutral reorder or a version metadata change that bun accepts).
- The worktree has no `node_modules/fixture-dep`.
- A control worktree of a second repo, whose merge changes only a source file.

## Steps

1. For each variant, run `ark worktree sync <run>`.
2. Read the exit code, the setup log and the origin ref of the run branch.
3. In the `both` variant, in a new process with cwd = the worktree, run `bun -e "console.log(require('fixture-dep'))"`.
4. Read the setup log for the control repo.
5. Check the `.omp/setup-pending` marker in the worktree.

## Expected results

- When the merge changes `package.json` or `bun.lock`, the system shall run `setup` in that worktree before it pushes anything: the setup finished before the origin ref of the branch moved. This holds in each of the three variants: a package-only change and a lockfile-only change each trigger setup.
- The sync shall exit 0.
- The bun process shall print the fixture marker value and exit 0 (at the base commit it fails with a module not found error).
- `.omp/setup-pending` shall not exist after the sync.
- The system shall not run `setup` in the control repo whose merge changed no dependency file.

## Screenshot checkpoints

none: CLI integration case; the observables are exit codes, files and the origin ref.
