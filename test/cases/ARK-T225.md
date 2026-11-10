---
id: ARK-T225
title: ARK-T225 every closed run card and graph node shows its outcome as its own icon and text for merged, aborted and handed_off
level: e2e
technique: equivalence classes (one closed run per outcome) with a negative check on the shared green check
priority: high
risk: an aborted or handed_off run still shows the merged look (green check, no icon, or no text), or a graph node carries no outcome at all, or the outcome is shown by colour only
status: active
changed_by: 2026-11-10-ARK-375-1
---

## Objective

Prove that on the Runs page each closed run shows its outcome (merged, aborted, handed_off) with its own icon and its own text, on the Closed lane card and on the dependency graph node, and that the three looks differ.

## Preconditions

- The hub runs against a scratch `ARK_HOME` with a fake tool set (as the other Playwright hub tests).
- Three closed runs of three backlog tickets, one with `outcome: merged`, one `aborted`, one `handed_off`, each the newest run of its ticket. One backlog ticket depends on another so the graph has an edge.
- One open backlog ticket (a queued run, not closed) that depends on one of the closed tickets, so the graph has a non-closed node.
- Desktop viewport (1280 px).

## Steps

1. Open the Runs page.
2. In the Closed lane read each card's `card-outcome` text and its icon (the element that holds the icon, its `data-outcome` or accessible name).
3. In the graph panel select the Old filter (Active is pressed on load and shows no closed nodes). Assert the three closed tickets' nodes are present, then read each node's outcome text and icon.
4. Compare the three cards with each other and the three nodes with each other.
5. Take the `outcomes-lane` and `outcomes-graph` checkpoints.
6. Select the Active filter, find the open ticket's node, and read it for any outcome text or icon.

## Expected results

- When a closed run has outcome `merged`, `aborted` or `handed_off`, its card and its graph node shall show that word as text.
- Each of the three outcomes shall have its own icon, and the three icons shall differ from each other.
- The `aborted` and `handed_off` cards shall not show the green check of `merged`.
- The icon shall not be the only carrier of the outcome: the text is present in the same card and node.
- The graph node of the open ticket (Active filter) shall show no outcome text or icon.

## Screenshot checkpoints

- `outcomes-lane`: the Closed lane with the three cards.
- `outcomes-graph`: the graph with the three closed nodes.
