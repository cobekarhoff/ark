---
id: ARK-T41
title: ARK-T41 ark plan check accepts a plan without skills unless the surface is web_ui
level: integration
technique: equivalence classes (cli_output, document, none, web_ui) over the surface of the run
priority: high
risk: plan check still refuses a cli_output or document plan for missing skills, or stops refusing a web_ui plan without them
status: active
changed_by: 2026-11-06-ARK-328-2
---

## Objective

Prove `ark plan check` enforces the skills list only for a web_ui run. Rewrites the `test/plan.test.ts` fixtures that use cli_output/document and expect skills.

## Preconditions

- Temporary ARK_HOME, a started run, a valid plan otherwise.

## Steps

1. Record surface `cli_output`; write a plan with no `skills` list; run `ark plan check`.
2. Repeat for `document` and `none`.
3. Record surface `web_ui`; run `ark plan check` on the same plan without skills.
4. Add the 3 skills to the web_ui plan; run `ark plan check`.

## Expected results

- Steps 1 and 2 exit 0 and log a valid `plan.checked`.
- Step 3 exits non-zero and names the missing skills.
- Step 4 exits 0.
- `bun test test/plan.test.ts` exits 0.

## Screenshot checkpoints

none: integration case on CLI output; no UI surface.
