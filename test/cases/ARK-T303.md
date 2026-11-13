---
id: ARK-T303
title: "ARK-T303 the next reviewer step's spec starts its range at the head recorded by the previous reviewer step"
level: integration
technique: "state transition (no review, one review, two reviews) plus ordering by mtime"
priority: high
risk: "a later reviewer restarts from the base or from a non-reviewer file's head, so it re-reviews reviewed code or skips unreviewed commits"
status: active
changed_by: 2026-11-12-ARK-426-1
---

## Objective

Prove that after a reviewer step records `Reviewed head: <sha>`, the next reviewer step's spec starts at that sha, even when a newer test case review file holds another head.

## Preconditions

- A plan with two reviewer steps (`review`, `review-2`) in one repo and a `worktree.created` base.
- `findings/review.md` with `Reviewed head: <sha-1>`, mtime set with `utimesSync` so ordering does not depend on write time.
- A newer `findings/test-case-review-1.md` with `Reviewed head: <sha-X>`.

## Steps

1. Build the spec for `review-2`.
2. Write `findings/review-2.md` with `Reviewed head: <sha-2>` and an mtime newer than `review.md`; build the spec for a third reviewer step.
3. Add a reviewer step in a second repo with its own findings head and build its spec.

## Expected results

- The spec for `review-2` shall contain `Last reviewed head: <sha-1>`, not sha-X and not the base.
- The spec for the third step shall contain `Last reviewed head: <sha-2>`.
- A reviewer step in another repo shall not take its start from the first repo's findings.

## Screenshot checkpoints

none: integration case on CLI spec text and exit codes; no UI surface.
