---
id: ARK-T313
title: ARK-T313 Reordered Home lists and Runs board items move by FLIP in at most 250 ms and end in the new place, and a view change transitions in at most 200 ms
level: e2e
technique: state transition (order A to order B) with boundary values on the duration limits (250 ms, 200 ms), one scenario that reorders every distinct Home list rendering path (Needs me gates, Needs me waiting items, Stuck agents, Review queue, Starts next rows, Run progress) plus the Runs board, and one for a view change
priority: high
risk: "items jump to the new order with no motion, in one list or in only some Home lists (FLIP wired to Needs me and Runs only); the FLIP animation leaves an item at its old offset (a transform not cleared), or runs longer than 250 ms; keys not stable so an item remounts instead of moving; the view transition lasts longer than 200 ms, runs when `startViewTransition` is missing (Firefox, WebKit), or blocks the keyboard route tests (`j`, Enter, Esc, scroll restore) while it runs"
status: active
changed_by: 2026-11-12-ARK-335-1
---

## Objective

Prove that when the order of a Home list or the Runs board changes the items move to their new place with a FLIP animation of at most 250 ms and end exactly there, and that a change of view uses a same-document view transition of at most 200 ms.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`, Chromium, motion allowed.
- A run folder fixture the test can change so two runs swap order on the Runs board and so each Home list holds 2 items that can swap: Needs me gates, Needs me waiting items, Stuck agents, Review queue, Starts next rows and Run progress (`hub/page/Home.tsx` renders each by its own `.map`, so each needs its own assertion).
- Runs A and B have stable ids.

## Steps

1. Open Runs; record the bounding box of A and B.
2. Push a snapshot that swaps A and B; read the Web Animations of A and B right after: assert a transform animation with duration at most 250 ms on each moved item.
3. Wait for the animations to finish; assert A's box is B's old box and B's box is A's old box, with no leftover transform.
4. On Home, record the boxes of 2 items in each of the six lists; push one snapshot that swaps the pair in every list; for each list assert a transform animation of at most 250 ms on each moved item, then after it finishes that each item's box is the other's old box and no transform is left.
5. Push a snapshot with the same order; assert no animation starts.
6. Change view Home to Runs to a run to a ticket to Roadmap; for each change assert a view transition ran (`document.activeViewTransition` or a transition pseudo-element animation) of at most 200 ms, and that the new view is in the DOM at the end.
7. Press `j`, Enter and Esc right after a view change; assert the key still acts (no blocked focus) and the scroll position restores as in ARK-T26.

## Expected results

- When the order of any Home list (Needs me gates and waiting items, Stuck agents, Review queue, Starts next, Run progress) or the Runs board changes, each item shall move to its new place with a FLIP animation of at most 250 ms and end at its new place.
- A change of view shall use a same-document view transition of at most 200 ms.
- An unchanged order shall not animate.
- Where `document.startViewTransition` is missing, the view shall change with no transition.

## Screenshot checkpoints

- `runs-before-reorder`: the Runs board before the swap.
- `home-after-reorder`: Home after the animations ended, all six lists swapped.
- `runs-after-reorder`: the board after the animation ended, A and B swapped.
