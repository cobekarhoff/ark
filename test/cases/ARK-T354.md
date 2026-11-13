---
id: ARK-T354
title: "ARK-T354 a runner that exits before it writes runner.json makes ark test fail at once with the runner-exited error"
level: integration
technique: error guessing (start failure before the claim)
priority: medium
risk: the caller cannot read the pid or exit code of a runner it did not spawn, so it waits for a record that never comes and fails only after a fixed time limit
status: active
changed_by: 2026-11-12-ARK-427-1
---

## Objective

Prove that `ark test <run>` reports a runner that dies before it writes `results/runner.json` as an error at once, not after a fixed wait.

## Preconditions

- A run folder with no `runner.json`, a project that does not exist, so the runner process exits 1 before it claims the run.

## Steps

1. Call the start path of `ark test <run>` with that run.

## Expected results

- The call rejects with `the runner of <run> exited before it started`.
- It rejects long before the former 30 s start limit.

## Screenshot checkpoints

None.
