---
id: ARK-T309
title: ARK-T309 a worker file recorded by worker.started that starts before the first step goes to its step, never to the run lead
level: integration
technique: state transition (order of session mapping and lead selection), boundary value (worker file is the earliest pre-step file; no other lead candidate)
priority: high
risk: the session mapping runs after the lead rule, or leaves the file eligible for it, so a worker file that starts before the first step.started (the file the current start path produces) becomes the run lead's when no earlier file exists; ARK-T308 always has an earlier lead file L, so it passes for the wrong reason
status: active
changed_by: 2026-11-12-ARK-425-1
---

## Objective

Prove that a session file named by `worker.started.session` is owned by that step even when it is the earliest file before the first step, so it is never picked as the run lead. The lead rule itself is unchanged (earliest eligible unmapped file before the first step, written at or after the run start). Serves ARK-425/AC2.

Expected: When the only file that starts before the first step is recorded as a step worker's session, the system shall show it under that step and shall show no run lead file.

## Preconditions

- Fixture run built with `test/hub-fixtures.ts`: one step `build` with `step.started` at t=100 and `step.finished` at t=150, and a `worker.started` for `build` whose `session` is file W.
- File W: `cwd` is the run's worktree, first timestamp t=90 (before `step.started`), last write t=140.
- Variant A: no other file.
- Variant B: add file L, `cwd` the run's worktree, first timestamp t=50 (earlier than W), last write t=200, recorded by no event.

## Steps

1. Variant A: open the hub run page and the `build` transcript page; run `ark retro`.
2. Variant B: the same reads.

## Expected results

- A: W appears on the `build` transcript page; the run lead has no file; Unassigned session files is empty; `ark retro` places W's cost on `build` and none on the lead.
- B: L is the run lead's file; W is on `build`; Unassigned session files is empty.

## Screenshot checkpoints

none: the case reads transcript entries and list contents, which the assertions check as text.
