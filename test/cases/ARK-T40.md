---
id: ARK-T40
title: ARK-T40 ark ui-skills prints the 3 UI skills only when the surfaces include web_ui
level: integration
technique: equivalence classes (none, cli_output, document, web_ui) plus a mixed set (document + web_ui)
priority: high
risk: a non-web_ui surface still demands UI skills (the 49 of 51 refused plan checks), or a mix that contains web_ui loses them
status: active
changed_by: 2026-11-06-ARK-328-2
---

## Objective

Prove `ark ui-skills <run>` and `uiSkillsFor` apply the web_ui-only rule for every surface class and for a mix. Replaces the ARK-279 cases in `test/ui-skills.test.ts` that expect skills for cli_output and document.

## Preconditions

- Temporary ARK_HOME, temp git repo, a started run.

## Steps

1. Record `evaluation.md` with `## Surfaces` = `web_ui`; run `ark ui-skills <run>`.
2. Repeat for `cli_output`, `document`, `none`, each alone.
3. Repeat for the mix `document` + `web_ui`.
4. Call `uiSkillsFor` directly with the same sets.

## Expected results

- `web_ui` and the mix print the 3 skills plus the React line; `uiSkillsFor` returns the 3 skills.
- `cli_output`, `document` and `none` each print `none`; `uiSkillsFor` returns `[]`.
- Exit code 0 in every step.
- `bun test test/ui-skills.test.ts` exits 0.

## Screenshot checkpoints

none: integration case on CLI output; no UI surface.
