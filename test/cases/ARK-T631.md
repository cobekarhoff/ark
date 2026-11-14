---
id: ARK-T631
title: "ARK-T631 status prints conflict for a conflicting GitHub MR and GitLab MR, not for a clean one"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts breaks this contract: status prints conflict for a conflicting GitHub MR and GitLab MR, not for a clean one"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that status prints conflict for a conflicting GitHub MR and GitLab MR, not for a clean one. Converted on touch from ARK-200-AC3 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request-status.test.ts` whose title starts with `ARK-T631`.

## Expected results

- The test passes: status prints conflict for a conflicting GitHub MR and GitLab MR, not for a clean one.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
