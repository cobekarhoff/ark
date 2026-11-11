---
id: ARK-T238
title: ARK-T238 a failed setup after a clean merge exits 1, names the repo, pushes nothing and leaves .omp/setup-pending, and the next sync retries setup even with nothing to merge
level: integration
technique: state transition (merged, setup failed, retry, setup ok) with a marker file as the state
priority: high
risk: a failed setup is swallowed and the broken worktree is pushed; or the marker is missing, so the next sync sees nothing to merge and never reruns setup and the worktree stays without its dependency; or the marker stays after success; or the failure records conflict true and so unlocks --merge wrongly
status: active
changed_by: 2026-11-11-ARK-407-1
---

## Objective

Prove that a setup failure after a clean merge blocks the push and leaves a retry marker, and that the following sync runs setup again with nothing to merge and clears the marker on success.

## Preconditions

- The fixtures of ARK-T237 (temp origin, run worktree, a merge that changes `package.json`), with a configured `setup`.
- `setup` is a command that fails on its first run and passes on the second (it checks a counter file it creates).
- A second repo in the run whose merge and setup succeed.

## Steps

1. Run `ark worktree sync <run>`. Read the exit code, the output, the origin ref of the failing repo and of the second repo, the marker, and the run's events.
2. Run `ark worktree sync <run>` again, with origin unchanged since the first merge. Read the exit code, the setup counter, the marker and the origin ref.
3. Run `ark worktree sync <run>` a third time. Read the setup counter.

## Expected results

- When setup fails after a clean merge, the system shall exit 1 and the output shall name the failing repo.
- The system shall not push the failing repo: its origin ref is unchanged. The second repo shall still sync and push.
- `<worktree>/.omp/setup-pending` shall exist after the first sync (the system creates `.omp` if it is missing).
- The failure shall not record a conflict: the run's `sync_conflicts` does not hold the repo.
- When the second sync merges nothing, the system shall still run `setup` again, exit 0, push, and remove the marker.
- The third sync shall not run setup (the counter does not grow).
- With no `setup` in `ark.yml`, a merge that changes `package.json` shall leave no marker and run nothing.

## Screenshot checkpoints

none: CLI integration case; the observables are exit codes, files and the origin ref.
