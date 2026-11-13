---
id: ARK-T333
title: "ARK-T333 finishing a step still works when its worktree is clean"
level: integration
technique: "equivalence classes (clean vs dirty) with the dirty case as the control; state transition running to finished"
priority: high
risk: "the dirty-worktree guard is too broad (for example counts Ark's own workspace entries or committed files) and blocks every finish"
status: active
changed_by: 2026-11-13-ARK-429-1
---

## Objective

Prove that `ark run step <run> <step> finish` exits 0 and records `step.finished` once the changes of a running step are committed, including when the worktree is the run workspace that holds Ark's own untracked entries.

## Preconditions

- A run with a running implementer step and a real git worktree.
- The step's changes (a modified and a new file) are committed.
- The workspace holds Ark's own entries (other repos' worktrees, mirror links) that are not product changes.

## Steps

1. Run `ark run step <run> <step> finish`.
2. Read `events.ndjson`.

## Expected results

- The command shall exit 0.
- A `step.finished` event for the step shall be appended.
- Ark's own workspace entries shall not be listed or counted as dirty.

## Screenshot checkpoints

none: integration case on CLI exit code and events; no UI surface.
