---
id: ARK-T312
title: ARK-T312 A pushed new gate or changed count shows a fading amber highlight and a polite live count, and no animation loops forever
level: e2e
technique: state transition (snapshot A to B) with equivalence classes (new item, changed existing item with the count unchanged, changed tile count, unchanged push) and a bounded-duration check of the looping animations
priority: high
risk: "a highlight that covers insertions only: a changed existing item keeps no feedback; a new gate changes in one frame and the human does not see it; the first snapshot highlights everything; a push that changes nothing still highlights; the count is not in an aria-live polite region or announces on every re-render; the pulse or dash loops forever so `getAnimations().finished` never settles, the suite hangs and an open tab burns CPU; the eased segments and meters stay on a stale colour"
status: active
changed_by: 2026-11-12-ARK-335-1
---

## Objective

Prove that a pushed snapshot with a new gate highlights a new or changed Needs me item and the changed tile count with an amber fade of 600 ms, that segments and meters change over 200 ms, that the running step pulse and the edge dash stop after a few cycles or when the page is hidden, and that the Needs me count sits in an aria-live polite region.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts` on a hub whose run folder the test can change; Home open on a snapshot with 1 gate, 1 run with a running step and a plan graph.
- Motion allowed (no reduced-motion emulation).

## Steps

1. Open Home; assert no highlight class on any item or tile (the first snapshot does not highlight) and read the Needs me live-region text.
2. Push an identical snapshot; assert no highlight class and no live-region change.
3. Push a snapshot with a new gate; assert the new Needs me item has the highlight class, the Needs me tile count changed and has the highlight class, and the live region (aria-live polite) text shows the new count.
4. Read the highlight animation or transition: duration 600 ms, ease-out, amber start colour; wait for it to settle and assert the class or colour is gone.
5. Push a snapshot that updates the existing gate (same id, new text or age) with the gate count unchanged; assert that item has the highlight class, the Needs me tile has no highlight class and the live-region text is unchanged; wait for it to settle.
6. Push a snapshot that changes a step status and a meter value; assert the segment and the meter transition over 200 ms.
7. Assert the running step node has a pulse and the edges into it a dash flow; wait: every animation with `iterations: Infinity` must be absent, so `Promise.all(document.getAnimations().map(a => a.finished))` resolves within a bounded time.
8. Hide the page (emulate `visibilitychange` hidden); assert the pulse and dash are paused or cancelled.

## Expected results

- When a new or changed item appears in Needs me, or a tile count changes, the system shall show an amber highlight that fades over 600 ms with an ease-out curve.
- A step segment and a meter shall change width and colour over 200 ms.
- A running step node shall pulse and the edges into it shall show a dash flow, each stopping after a few cycles or when the page is hidden; no animation shall run forever.
- The Needs me count shall be in an aria-live polite region and its text shall change only when the count changes.
- A changed existing Needs me item shall highlight even when the count is unchanged, and the unchanged count shall not highlight.
- A push that changes nothing, and the first snapshot, shall not highlight.

## Screenshot checkpoints

- `needs-me-highlight`: Home right after the new gate arrives, the highlight showing.
- `needs-me-changed-item`: the existing gate highlighted, the count not.
- `needs-me-settled`: Home after the fade, no highlight.
