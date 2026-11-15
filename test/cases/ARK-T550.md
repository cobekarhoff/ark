---
id: ARK-T550
title: "ARK-T550 a text amend rewrites the frontmatter text and the table row (pipe escaped), records the event, and leaves the backlog ticket"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: a text amend rewrites the frontmatter text and the table row (pipe escaped), records the event, and leaves the backlog ticket"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a text amend rewrites the frontmatter text and the table row (pipe escaped), records the event, and leaves the backlog ticket. Converted on touch from ARK-207-AC1 by the ARK-386 campaign. Production owner: `cli/criteria.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/criteria-amend.test.ts` whose title starts with `ARK-T550`.

## Expected results

- The test passes: a text amend rewrites the frontmatter text and the table row (pipe escaped), records the event, and leaves the backlog ticket.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
