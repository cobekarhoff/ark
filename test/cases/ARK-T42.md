---
id: ARK-T42
title: ARK-T42 ark strategy record accepts mockup cards without a Skills line when the surface is not web_ui
level: integration
technique: state transition (needsMockups true) crossed with surface class (cli_output, web_ui)
priority: high
risk: "a cli_output run with a mockup card can never pass strategy record: the empty Skills line is refused and any named skill is 'not listed' (`cli/strategy.ts:112-124`)"
status: active
changed_by: 2026-11-06-ARK-328-2
---

## Objective

Prove the Skills check on mockup cards applies only when `uiSkillsFor(surfaces)` is non-empty.

## Preconditions

- Temporary ARK_HOME, a started run, evaluation with `needsMockups` true.

## Steps

1. Record surface `cli_output`; run `ark strategy record` with a card that has no `Skills:` line.
2. Record surface `web_ui`; run it with a card with no `Skills:` line.
3. Run it with a web_ui card that lists the 3 skills.

## Expected results

- Step 1 exits 0.
- Step 2 exits non-zero (empty Skills line).
- Step 3 exits 0.

## Screenshot checkpoints

none: integration case on CLI output; no UI surface.
