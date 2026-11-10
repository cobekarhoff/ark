---
id: ARK-T171
title: ARK-T171 an ark test killed during the base run leaves no worktree in the source repo once ark test --stop has run
level: integration
technique: state transition (base run active, caller killed, runner stopped), error guessing (cleanup after SIGKILL)
priority: high
risk: the base worktree `ark-base-*` stays registered in the source repo after the caller dies or the runner is stopped, and every later `git worktree list` and base run meets a stale worktree
status: active
changed_by: 2026-11-09-ARK-366-1
---

## Objective

Prove that the detached runner removes its base worktree when it is stopped, although the caller was killed with SIGKILL during the base run.

Expected: When `ark test <run> --stop` ends a runner that is in the base run, the system shall remove the `ark-base-*` worktree from the source repo.

## Preconditions

- A temporary `ARK_HOME` and a run whose e2e test holds for 60 s when its working directory is an `ark-base-*` worktree, and writes a marker file first. No real `ARK_HOME` and no `~/.ark/test.lock`.

## Steps

1. Start `ark test <run>` as a child process of the CLI.
2. Wait until the marker file exists (the base run is running).
3. Kill the caller with SIGKILL and wait for it to exit.
4. Run `ark test <run> --stop`.
5. Run `git worktree list --porcelain` in the workspace repo.

## Expected results

- Step 4: the output contains `stopped the ark test`.
- Step 5: no worktree path contains `ark-base-`.

## Screenshot checkpoints

None, CLI output.
