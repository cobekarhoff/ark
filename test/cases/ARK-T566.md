---
id: ARK-T566
title: "ARK-T566 a base that passes records base_passed true and merge-request open no longer refuses on the base"
level: integration
technique: "state transition (refactor base fails then passes)"
priority: medium
risk: "a passing refactor base is not recorded, so merge-request open keeps refusing"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a base that passes records base_passed true and merge-request open no longer refuses on the base. Converted on touch from ARK-302-AC7 by the ARK-386 campaign. Production owner: `cli/test-run.ts, cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/test-run.test.ts` whose title starts with `ARK-T566`.

## Expected results

- The test passes: a base that passes records base_passed true and merge-request open no longer refuses on the base.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
