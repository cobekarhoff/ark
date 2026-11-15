---
id: ARK-T647
title: "ARK-T647 a `not:` string still tracked is refused, an absent one passes, a bare `not:` is no literal"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/merge-request.ts breaks this contract: a `not:` string still tracked is refused, an absent one passes, a bare `not:` is no literal"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a `not:` string still tracked is refused, an absent one passes, a bare `not:` is no literal. Converted on touch from ARK-305-AC2 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/merge-request.test.ts` whose title starts with `ARK-T647`.

## Expected results

- The test passes: a `not:` string still tracked is refused, an absent one passes, a bare `not:` is no literal.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
