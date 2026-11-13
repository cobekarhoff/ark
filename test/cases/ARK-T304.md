---
id: ARK-T304
title: "ARK-T304 finishing a succeeded reviewer step is refused when its review range holds no commit"
level: integration
technique: "boundary values (0 commits vs 1 commit) plus equivalence classes of finish outcome"
priority: high
risk: "a reviewer step with an empty range finishes as reviewed, so a run reaches merge with no code review"
status: active
changed_by: 2026-11-12-ARK-426-1
---

## Objective

Prove that `ark run step <run> <reviewer> finish` exits 1 naming the range and the step when start and HEAD are the same commit, and that a commit in the range, `--failed` and `--failed --not-started` still finish.

## Preconditions

- A run with a started reviewer step and a real git worktree whose HEAD equals the recorded base.
- The reviewer step's own `findings/<step>.md` already holds `Reviewed head: <HEAD>`.

## Steps

1. Run `finish` for the reviewer step with no new commit.
2. Commit once in the worktree and run `finish` again.
3. Reset to a reviewer step with an empty range and run `finish --failed`; repeat with `finish --failed --not-started` (`--not-started` alone exits 1 `--not-started needs --failed`, unrelated to range).
4. Run `finish` for an implementer step whose HEAD equals base.

## Expected results

- When the range is empty, the command shall exit 1, the message shall contain `<start>..<end>` and the step id, and no `step.finished` event shall be appended.
- When the range holds one commit, the command shall exit 0 and append `step.finished`.
- `--failed` and `--failed --not-started` shall finish an empty-range reviewer step.
- An implementer step shall finish regardless of range.

## Screenshot checkpoints

none: integration case on CLI spec text and exit codes; no UI surface.
