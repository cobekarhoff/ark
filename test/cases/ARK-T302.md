---
id: ARK-T302
title: "ARK-T302 the first reviewer step's spec starts its range at the run base when only non-reviewer findings carry a Reviewed head"
level: integration
technique: "equivalence classes of findings file kind (reviewer step vs test case review vs round file)"
priority: high
risk: "the first code reviewer starts from a head written by a test case review or round file, so it reviews an empty range and the run's code ships unreviewed"
status: active
changed_by: 2026-11-12-ARK-426-1
---

## Objective

Prove that the spec built for the first reviewer step prints `Last reviewed head: <base>` with the run base, and never the head of a test case review or round file.

## Preconditions

- A run with a plan holding an implementer step and a reviewer step in one repo, and a `worktree.created` event with a `base` sha.
- `findings/test-case-review-1.md` with `Reviewed head: <sha-A>` and `findings/round-1.md` with `Reviewed head: <sha-B>`; no reviewer step findings file.

## Steps

1. Build the spec for the reviewer step (through `buildSpec`).
2. Repeat with a `worktree.created` event that has no `base`.

## Expected results

- When no reviewer step has findings, the spec shall contain `Last reviewed head: <base>` and neither sha-A nor sha-B.
- Where the worktree has no recorded base, the spec shall contain no `Last reviewed head` line and building it shall not throw.

## Screenshot checkpoints

none: integration case on CLI spec text and exit codes; no UI surface.
