---
id: ARK-T139
title: ARK-T139 status shows a package bump that waits for the upstream merge
level: integration
technique: equivalence classes
priority: high
risk: a package bump shows a publish wait while the upstream MR is still open, so the run lead looks for a version that cannot exist
status: active
changed_by: 2026-11-09-ARK-338-1
---

## Objective

Prove that status shows a package bump that waits for the upstream merge.

## Preconditions

A plan has a package edge `core` with pin `clara-core>=0.0.5rc3,<1.0` and the bump step bump-lib, no refresh is recorded, and the upstream MR is open.

## Steps

1. Run `ark merge-request status <run>`.

## Expected results

- The status prints `  waits for !2 (open)` and the bump line with `waits for upstream merge`.

Proof: `test/merge-request-status.test.ts`.

## Screenshot checkpoints

None. The surface is CLI output.
