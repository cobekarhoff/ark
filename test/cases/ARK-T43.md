---
id: ARK-T43
title: ARK-T43 the merge request and plan.md show the UI section only for web_ui
level: integration
technique: equivalence classes (web_ui, cli_output) over the other callers of `uiSkillsFor`
priority: medium
risk: "the MR 'UI/UX checks' block or the plan.md UI section still appears for a CLI diff, so a reviewer reviews it against UI skills (`cli/merge-request.ts:560`, `cli/plan.ts:401,613`)"
status: active
changed_by: 2026-11-06-ARK-328-2
---

## Objective

Prove the callers other than `ui-skills` and `plan check` follow the new rule.

## Preconditions

- Temporary ARK_HOME, a started run with a plan, for each surface.

## Steps

1. Surface `cli_output`: render the MR body and plan.md.
2. Surface `web_ui` with the 3 skills: render both.

## Expected results

- Step 1: neither has the UI/UX checks block or UI skills section.
- Step 2: both have them and name the 3 skills.

## Screenshot checkpoints

none: integration case on CLI output; no UI surface.
