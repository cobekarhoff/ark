---
id: ARK-T332
title: "ARK-T332 finishing a step is refused and lists each file when its worktree holds a changed tracked or untracked file"
level: integration
technique: "equivalence classes of dirty entries (modified tracked, untracked) plus state transition (running stays running)"
priority: high
risk: "a worker reports done with work uncommitted, so the next step reads a head that lacks the work"
status: active
changed_by: 2026-11-13-ARK-429-1
---

## Objective

Prove that `ark run step <run> <step> finish` exits 1, lists every dirty file, advises committing or `--failed`, and records no `step.finished` event when the step worktree holds a changed tracked file and an untracked file.

## Preconditions

- A run with a running implementer step and a real git worktree with a clean committed head.
- One tracked file is modified and one new untracked file exists in the worktree.

## Steps

1. Run `ark run step <run> <step> finish`.
2. Read `events.ndjson` and the step state.

## Expected results

- The command shall exit 1.
- The message shall list the modified tracked file and the untracked file by path.
- The message shall tell the user to commit the files or to finish with `--failed`.
- No `step.finished` event shall be appended and the step shall stay running.

## Screenshot checkpoints

none: integration case on CLI exit code and text; no UI surface.
