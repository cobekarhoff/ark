---
id: ARK-T360
title: ARK-T360 An expanded card shows steps in phase columns, and cross-repo step edges draw only on hover or focus
level: e2e
technique: state transition (rest, hover, focus, leave) and equivalence classes (in-card edge, cross-repo edge, bump step)
priority: high
risk: "a bump step lands in Implement because its role is implementer; cross-repo step edges are always drawn and bury the graph; the non-joining steps are not dimmed; leaving the step keeps the edges; Expand all or Collapse all leaves one card behind"
status: active
changed_by: 2026-11-13-ARK-339-1
---

## Objective

Prove the phase columns, the always-drawn in-card step edges, the hover-only cross-repo edges, and Expand all and Collapse all.

## Preconditions

- Playwright in `test/pw/hub.pw.ts`; the 4-repo fixture of ARK-T359 with a bump step in one repo and one step that needs a step of another repo.

## Steps

1. Open the 4-repo run (cards collapsed). Click Expand all; assert every card is open.
2. Assert the cards show only the columns they need among Implement, Bump, Validate, Review, and the bump step is in the Bump column with its state.
3. Assert the step edges inside a card are drawn and no cross-repo step edge is drawn.
4. Hover the cross-repo step; assert its edges are drawn and steps that do not join it are dimmed. Move away; assert the edges are gone and no step is dimmed.
5. Focus the same step with Tab; assert the same as hover.
6. Click Collapse all; assert every card is collapsed.

## Expected results

- An expanded card shall show its steps in the phase columns it needs, with a bump step in Bump with its state.
- Step edges inside a card shall be drawn.
- A step edge between repos shall be drawn only while a step has hover or focus, and the steps that do not join it shall be dimmed.
- Expand all and Collapse all shall open and close every card.

## Screenshot checkpoints

`checkpoint`: `expanded-all`, `cross-repo-hover` (before the edge assertion), `collapsed-all`.
