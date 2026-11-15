---
id: ARK-T646
title: "ARK-T646 placeholder, glob, dots, file:line, own id and manual-AC strings are skipped; the real miss is refused"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts breaks this contract: placeholder, glob, dots, file:line, own id and manual-AC strings are skipped; the real miss is refused"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that placeholder, glob, dots, file:line, own id and manual-AC strings are skipped; the real miss is refused. Converted on touch from ARK-305-AC1 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request.test.ts` whose title starts with `ARK-T646`.

## Expected results

- The test passes: placeholder, glob, dots, file:line, own id and manual-AC strings are skipped; the real miss is refused.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
