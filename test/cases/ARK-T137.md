---
id: ARK-T137
title: ARK-T137 status prints the upstream wait of each MR
level: integration
technique: state transition
priority: high
risk: a downstream MR shows no wait, or a wrong or stale upstream state, so the run lead refreshes a bump too early; a failed host call shows a state it does not know
status: active
changed_by: 2026-11-09-ARK-338-1
---

## Objective

Prove that status prints the upstream wait of each MR.

## Preconditions

A run has two GitLab MRs: the downstream !1 lists !2 in waits_for, and !2 is the MR of the upstream repo.

## Steps

1. Make the host answer `merged` for !2 and run `ark merge-request status <run>`.
2. Make the host fail for !2 (exit 1) and run the status again.
3. Add a second repo whose MR is also !2 (on GitHub) but is not an upstream of the downstream repo in the plan, and run the status.
4. Run the status of a run whose MRs are all on GitHub.

## Expected results

- The status exits 0 and prints `  waits for !2 (merged)` under the downstream MR.
- With the failing host call the status exits 0 and prints `  waits for !2 (unknown)`.
- With equal MR numbers in two repos the status prints exactly one waits line, `  waits for !2 (merged)`, for the repo that the plan edge names.
- On GitHub the status prints `  waits for !2 (merged)` with a literal `!`, never `#2`.

Proof: `test/merge-request-status.test.ts`.

## Screenshot checkpoints

None. The surface is CLI output.
