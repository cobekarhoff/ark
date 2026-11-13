---
id: ARK-T281
title: "ARK-T281 Full screen opens the graph in one overlay over the window at fit scale, Esc and Close close it and return the focus, Esc does not leave the ticket page, and a node click goes where it goes outside"
level: e2e
technique: "state transition (closed, open, closed by Esc, by Close, by node click or hashchange) with equivalence classes of the opened graph and of the key press"
priority: high
risk: "the overlay shows a second copy of the graph so a `graph-node` locator matches twice, Esc also fires the ticket page handler and the route goes to `#/roadmap`, the focus is lost or lands on `body` or on a missing button after close, the overlay is not at fit scale of the window, a node click changes the route and leaves the overlay over the next page, a click does not reach the node link, or the page behind scrolls"
status: active
changed_by: 2026-11-12-ARK-325-1
---

## Objective

Prove Full screen moves the one graph into a dialog over the whole window at fit scale, that Esc and Close close it and put the focus back on the Full screen button without leaving the page, and that a node click in the overlay opens the same route as outside and does not leave the overlay open.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`; viewport 1440 x 900.
- Ticket `ARK-905` with a graph holding a node `ARK-906`, and the Roadmap, Runs and plan graphs of ARK-T280.

## Steps

1. Open `#/ticket/ARK-905`. Assert `graph-node` count is N. Focus then click `Full screen`.
2. Assert a `role=dialog` with `aria-modal=true` covers the window (its box equals the viewport), `graph-node` count is still N, and the focus is inside the dialog. `checkpoint(page, "graph-overlay")`.
3. Assert the scale in the overlay equals `min(1, dialog graph box width / graph width)` (the fit scale of the overlay box, which may exceed the scale of the page box).
4. Press Esc. Assert the dialog is gone, `location.hash` is still `#/ticket/ARK-905`, and the focus is on `Full screen` (`toBeFocused`).
5. Open again; click `Close`; assert the dialog is gone and the focus is on `Full screen`.
6. Open again; click the `ARK-906` node. Assert `location.hash` is `#/ticket/ARK-906`, the same URL as a click on that node outside the overlay, and no dialog is over the new page.
7. Repeat steps 1 to 5 on the Roadmap, Runs and plan graphs and assert on each: the count of its node test id is the same open and closed, Esc closes, Close closes, the focus returns, and a node click goes to the route of the node.
8. With the overlay open on the Roadmap, press Esc while the search box has focus on the page behind; assert the overlay closes and the route stays `#/roadmap`.
9. With the overlay open, scroll the wheel over it; assert `window.scrollY` is unchanged.

## Expected results

- When Full screen is pressed, the system shall show the graph, not a copy, in a dialog over the whole window at fit scale.
- When Esc or Close is used, the system shall close the overlay, keep the page and put the focus on the Full screen button.
- When a node is clicked in the overlay, the system shall go to the route the node opens outside the overlay and close the overlay.

## Screenshot checkpoints

- `graph-overlay`: the ticket graph of `ARK-905` in the overlay at fit scale with the Close button.
