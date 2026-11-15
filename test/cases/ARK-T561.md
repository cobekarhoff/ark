---
id: ARK-T561
title: "ARK-T561 ark test on the last round with a manual criterion pending keeps passed true and does not open the escalation gate"
level: integration
technique: "state transition (last round, manual pending)"
priority: medium
risk: "manual pending counts as an automated failure and escalates a run that waits only for the human"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that ark test on the last round with a manual criterion pending keeps passed true and does not open the escalation gate. Converted on touch from ARK-283-AC1 by the ARK-386 campaign. Production owner: `cli/test-run.ts, cli/transitions.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/test-run.test.ts` whose title starts with `ARK-T561`.

## Expected results

- The test passes: ark test on the last round with a manual criterion pending keeps passed true and does not open the escalation gate.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
