---
id: ARK-T279
title: "ARK-T279 the sticky bar of a ticket page holds the part chips and the Rendered and Raw switch, a click scrolls to the part, the chip of the part in view is marked, and a chip click does not change the route"
level: e2e
technique: "state transition (scroll position to marked chip, click to scroll) with equivalence classes of part kinds (prose section, criterion) and of document state (loading, loaded, section not written)"
priority: high
risk: "a chip click sets `location.hash` and leaves the ticket page, a chip click scrolls the target under the sticky bar or under the app header, the marked chip does not follow the scroll or marks two chips, a section with no text has no chip, the bar shows chips while the document is loading, or the Rendered and Raw switch is lost or loses its state when it moves into the bar"
status: active
changed_by: 2026-11-12-ARK-325-1
---

## Objective

Prove the sticky bar stays at the top while the window scrolls, holds one chip each for Problem, Change, Evidence and every criterion plus the Rendered and Raw switch, that a click scrolls its part into view below the bars with the route unchanged, and that scrolling marks the chip of the part in view.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`; viewport 1440 x 900.
- Ticket `ARK-903` with long Problem, Change and Evidence (each taller than the window) and 3 criteria, so the page scrolls. Ticket `ARK-904` whose Evidence is empty. The ticket document request for `ARK-903` is delayed by a route handler for the loading step.

## Steps

1. Delay the document of `ARK-903`; open `#/ticket/ARK-903`. While it loads, assert the bar has no part chip.
2. Release it. Assert the bar holds chips `Problem`, `Change`, `Evidence`, `AC1`, `AC2`, `AC3` in this order and a Rendered and Raw switch.
3. Record `location.hash`. Click the `AC2` chip. Wait with `expect` for the chip to have `aria-current`. Assert the AC2 criterion top is at or below the bottom of the bar and within 120 px of it, and `location.hash` is unchanged.
4. `checkpoint(page, "ticket-chip-ac2")`.
5. Scroll the window with `window.scrollTo` to the Change section; wait; assert only the `Change` chip is marked. Scroll to the top; assert only `Problem` is marked. Scroll to the page end; assert only the last chip in view is marked.
6. Assert the bar is still at the top of the window (its top within 1 px of its sticky offset, below the app header) after each scroll.
7. Click `Raw` in the bar; click the `Evidence` chip; assert the `Raw` button is still the pressed one (the state survives chip navigation). The source text itself is owned by ARK-T181.
8. Open `#/ticket/ARK-904`; assert an `Evidence` chip still exists and a click on it scrolls to the `Not written in the ticket.` section.

## Expected results

- When the document loads, the system shall show a sticky bar with a chip for Problem, Change, Evidence and each criterion, and the Rendered and Raw switch.
- When a chip is clicked, the system shall scroll its part into view below the bars and keep the route.
- While the window scrolls, the system shall mark the one chip of the part in view.
- When a section has no text, the system shall still show its chip.

## Screenshot checkpoints

- `ticket-chip-ac2`: the page scrolled to AC2 with the bar at the top and the `AC2` chip marked.
