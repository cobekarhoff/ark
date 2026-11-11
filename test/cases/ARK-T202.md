---
id: ARK-T202
title: ARK-T202 ark strategy record accepts one cli_output card with no Mockup line, and still refuses two cards or a web_ui card with no Mockup line
level: integration
technique: "equivalence classes (card count 1 / 2 crossed with surface class cli_output / web_ui) with the one-card cli_output cell as the boundary"
priority: high
risk: "a one-card cli_output run is still refused for a missing Mockup line, so the lead starts a Designer and makes two refused strategy record calls (the ARK-409 defect); or the exception is widened so a two-card cli_output run or a one-card web_ui run is accepted with no mockup and no Designer"
status: active
changed_by: 2026-11-10-ARK-409-1
---

## Objective

Prove that `ark strategy record <run>` waives the `Mockup:` line only for one card whose surfaces are all `cli_output`, `document` or `none`, and refuses every other card with no `Mockup:` line as before.

## Preconditions

- Temporary `ARK_HOME`, temp git repo, a started run with the real `ark` process.
- Initial `ark.yml` has no `roles.designer`, so a wrongly required Designer shows as a refusal in step 1. Before step 2 the test rewrites `ark.yml` to add `roles.designer` (`{ harness: "omp", model: "pi/design" }`), so steps 2 and 3 reach the card/mockup check instead of the Designer-role check.
- No mockup file in the run folder; no card has a `Mockup:` line.

## Steps

1. With no `roles.designer`: write `evaluation.md` with `## Surfaces` = `cli_output`, run `ark evaluation record <run>`. Write `strategies.md` with one card (`S1`, no `Mockup:` line). Run `ark strategy record <run>`.
2. Add `roles.designer` to `ark.yml`. Keep surface `cli_output`. Write `strategies.md` with two cards (`S1`, `S2`, no `Mockup:` line). Run `ark strategy record <run>`.
3. With `roles.designer` still configured, record surface `web_ui` with `evaluation record`. Write `strategies.md` with one card (`S1`, no `Mockup:` line). Run `ark strategy record <run>`.
4. Read the exit code, stderr and the run phase after each step.

## Expected results

- Step 1: exit 0, a `strategy.recorded` event is appended and the phase is `planning`. Stderr names no `Mockup` and no `roles.designer`.
- Step 2: exit 1, and stderr names the card `S1` as missing a mockup, not `roles.designer`. No `strategy.recorded` event is appended and the phase does not change.
- Step 3: exit 1, and stderr names the card `S1` as missing a mockup, not `roles.designer`. No `strategy.recorded` event is appended and the phase does not change.

## Screenshot checkpoints

none: cli_output case; the observable is exit code, stderr and the run phase.
