---
id: ARK-T362
title: ARK-T362 The repo graph uses the graph controls and the motion of ARK-335, with none of it under prefers-reduced-motion
level: e2e
technique: state transition (step change, order change) crossed with reduced motion on/off
priority: medium
risk: "the graph draws its own zoom so Fit, 100% and Full screen do not work on it; a pushed step change gets no 600 ms highlight; cards reorder with no FLIP, or a nested Flip breaks it; the running-repo edge has no dash flow; the new classes are missing from the reduced-motion rule so they still animate"
status: active
changed_by: 2026-11-13-ARK-339-1
---

## Objective

Prove the repo graph is on `GraphViewport` and `motion.tsx`: controls work, a running step pulses, a running-repo edge flows, a changed card or step highlights for 600 ms, cards FLIP on reorder, and nothing animates with reduced motion.

## Preconditions

- Playwright in `test/pw/hub.pw.ts`, with the push helper of ARK-T312 and the 3-repo fixture of ARK-T359 with a running step.
- A second pass runs with `page.emulateMedia({ reducedMotion: "reduce" })`.

## Steps

1. Open the 3-repo run. Click Fit, 100% and Full screen; assert the scale and the full-screen state change.
2. Assert the running step pulses and the edge into its repo has a dash flow animation.
3. Push a snapshot where one step finishes; assert its box and its card get the highlight and it ends after 600 ms.
4. Push a snapshot that swaps the order of two cards; assert the cards end at the new place and a FLIP animation ran on them.
5. Repeat 2 to 4 with reduced motion; assert `document.getAnimations()` is empty, and the new state shows.

## Expected results

- The repo graph shall use the Fit, 100% and Full screen controls.
- A running step shall pulse and the repo edge into a running repo shall show a dash flow.
- A changed card or step shall get the 600 ms highlight, and cards shall move with FLIP when the order changes.
- Where prefers-reduced-motion is set, none of this shall animate.

## Screenshot checkpoints

none: the proof is the animation list and element position, which a screenshot cannot show.
