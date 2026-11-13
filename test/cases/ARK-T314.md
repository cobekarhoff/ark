---
id: ARK-T314
title: ARK-T314 With prefers-reduced-motion, or for a keyboard action's result, no element animates or transitions
level: e2e
technique: decision table (reduced motion on/off by input origin keyboard/pointer) over each motion kind (highlight, pulse, dash, FLIP, view transition)
priority: high
risk: "the rule `* { transition: none }` stays the only reduced-motion rule, so keyframes, the WAAPI FLIP and `startViewTransition` still run (JS motion is not controlled by CSS); a keyboard route change (`j`, Enter) animates its own result; the check passes because the animation list was read before the push, or because `getAnimations()` skips the pseudo-elements"
status: active
changed_by: 2026-11-12-ARK-335-1
---

## Objective

Prove that with prefers-reduced-motion set no highlight fade, pulse, dash flow, FLIP or view transition runs after a push and a reorder, and that an action started from the keyboard does not animate its own result.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts` (after ARK-T312 and ARK-T313 data exists), `page.emulateMedia({ reducedMotion: "reduce" })` set before the page loads.
- The same fixtures as ARK-T312 (a new gate, a running step) and ARK-T313 (two runs that swap).
- A control run with motion allowed shows the same pushes do animate, so an empty list cannot come from a missing push.

## Steps

1. Control: with motion allowed, push a new gate and a reorder; assert `document.getAnimations()` is not empty.
2. Emulate reduced motion and open Home with a running step on screen; assert `document.getAnimations()` is empty.
3. Push a snapshot with a new gate; wait one frame past the push; assert `document.getAnimations()` is empty and the new item still shows (no highlight animation).
4. Push a snapshot that swaps two runs on the Runs board; assert `document.getAnimations()` is empty and the items are at the new place.
5. Change view by link; assert no view transition (`document.activeViewTransition` is null) and `getAnimations()` is empty.
6. Without reduced motion: press `j` then Enter from the keyboard to change view; assert no view transition and no animation on its result; do the same change by pointer click and assert the view transition runs.

## Expected results

- With prefers-reduced-motion set, no element shall animate or transition: `document.getAnimations()` shall be empty after a push and after a reorder, with no highlight fade, pulse, dash flow, FLIP or view transition.
- An action started from the keyboard shall not animate its own result.
- The control run shall show animations, so the empty list proves the rule and not a missing push.

## Screenshot checkpoints

none: the proof is the animation list and element position, which a screenshot cannot show.
