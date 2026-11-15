---
id: ARK-T628
title: "ARK-T628 status ci passed, failed, running, none; --json failed checks with URL (GitHub and GitLab)"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts breaks this contract: status ci passed, failed, running, none; --json failed checks with URL (GitHub and GitLab)"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that status ci passed, failed, running, none; --json failed checks with URL (GitHub and GitLab). Converted on touch from ARK-200-AC1 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request-status.test.ts` whose title starts with `ARK-T628`.

## Expected results

- The test passes: status ci passed, failed, running, none; --json failed checks with URL (GitHub and GitLab).

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
