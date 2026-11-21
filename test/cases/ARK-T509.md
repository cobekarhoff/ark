---
id: ARK-T509
title: "ARK-T509 a bug run's first validator need not serve a manual criterion, and must serve a criterion with no method"
level: integration
technique: "equivalence classes of a criterion's front matter without a `method` key (`manual: true`, neither key) over the first-step rule of a bug run"
priority: medium
risk: "the narrowed rule reads the `method` key of the front matter, not the parsed method, so a `manual: true` criterion with no `method` counts as a test criterion and a first validator that leaves it to a later step is refused; or a criterion with no `method` and no `manual` (a test criterion by default) is no longer required of the first validator, so the red proof runs without its test"
status: active
changed_by: 2026-11-21-ARK-619-1
---

## Objective

Prove that `ark plan check` of a bug run applies the first-step rule to the method that `parseCriteria` (`cli/ticket.ts`) reads: a criterion written as `manual: true` with no `method` is `demonstration`, so the first validator need not serve it; a criterion with no `method` and no `manual` is `test`, so the first validator must serve it. Serves ARK-619/AC1. Production owner: `cli/plan-check.ts`.

Authoring gate:

1. Protects: the first-step rule of a bug run for criteria whose method comes from a default, not from a `method` key.
2. Fails when: the rule's filter reads the raw front matter (`manual: true` with no `method` taken as a test criterion), or treats a missing `method` as a non-test criterion.
3. Existing proof misses it: ARK-T508 writes a `method` on every criterion; this case owns the two defaults of the reader.
4. No test-only export: the case runs the real `ark plan check` process on fixture files.

## Preconditions

- The fixture of the `plan check by ticket kind` block of `test/plan.test.ts` (as ARK-T508): a bug run started with `ark run start` on ticket `ARK-901` (kind `bug`) whose criteria are `AC1` with no `method` and no `manual` key, and `AC2` with `manual: true` and no `method`. Every plan is valid for every other rule of plan check.

## Steps

1. Write a plan whose first step is a validator serving `AC1` only, then an implementer that needs it and serves `AC1`, then a validator that needs the implementer and serves `AC2`. Run `ark plan check <run>`.
2. Write the same plan with a first validator that serves `AC2` only. Run plan check.

## Expected results

- Step 1: exit 0, and no line that starts with `bug run`.
- Step 2: exit 1, and the output holds the line `bug run: the first step must be a validator step that serves every criterion`.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
