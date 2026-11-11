---
id: ARK-T208
title: ARK-T208 ark strategy record refuses a web_ui card whose Mockup link is not a file, and accepts it once the file exists
level: integration
technique: "state transition (missing mockup file, then present mockup file)"
priority: medium
risk: "a card links a mockup file that is not in the run folder and the strategy is recorded anyway, so the human reviews a dead link"
status: active
changed_by: 2026-11-10-ARK-409-1
---

## Objective

Prove that `ark strategy record <run>` checks that a linked mockup is a file in the run folder for a `web_ui` surface. Converted on touch from ARK-173-AC9; the no-`Mockup:`-line refusals moved to ARK-T202.

## Preconditions

- Temporary `ARK_HOME`, temp git repo, a started run with the real `ark` process and `roles.designer` configured.
- Surface `web_ui`; one card `S1` with a `Mockup: mockups/s1.html` line and a `Skills:` line; no mockup file yet.

## Steps

1. Run `ark strategy record <run>`.
2. Write `mockups/s1.html` in the run folder and run `ark strategy record <run>` again.

## Expected results

- Step 1: exit 1, and stderr names `S1`.
- Step 2: exit 0.

## Screenshot checkpoints

none: CLI process; the observable is exit code and stderr.
