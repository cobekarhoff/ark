---
id: ARK-T343
title: "ARK-T343 a click on a tick, a cluster or a feed message links the trace and the feed both ways, and the trace cursor follows the feed scroll"
level: integration
technique: "state transition (selection source: tick, cluster, feed) with pairwise checks of each side"
priority: high
risk: "a trace click selects nothing in the feed or does not scroll to it; a cluster click does not zoom; a feed click draws no arrow or marks the wrong tick; the cursor does not follow the top message"
status: active
changed_by: 2026-11-13-ARK-345-1
---

## Objective

Prove the AC3 links: tick click zooms, selects and scrolls the feed; cluster click zooms; feed click marks the tick and draws the sender-to-receiver arrow; trace cursor follows the time of the top feed message.

## Preconditions

- A fixture run with enough messages that the feed scrolls and with a burst of ticks close in time that cluster at full view (a 9-hour span with a burst within a minute).
- Viewport 1440x900, groups collapsed.

## Steps

1. Open the Conversation tab at full view; note the time range of the axis.
2. Click a single tick: the axis zooms around it, that message is selected and the feed scrolls it into view.
3. Return to full view; click a cluster: the axis zooms so the cluster splits into its ticks (range narrower than before); the first of its messages is selected.
4. Click a different message in the feed: its tick is marked and an arrow runs from the sender row to the receiver row.
5. Scroll the feed to a later message: the trace cursor time equals the time of the top message in view.

## Expected results

- Tick click: zoomed, message selected, feed scrolled to it.
- Cluster click: zoomed range narrower, ticks separate.
- Feed click: the matching tick marked, arrow from sender to receiver drawn.
- Cursor tracks the top message's time after a feed scroll.

## Screenshot checkpoints

After the tick click; after the cluster zoom; the arrow after a feed click.
