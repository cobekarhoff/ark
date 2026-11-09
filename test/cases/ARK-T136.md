---
id: ARK-T136
title: ARK-T136 ARK-309-AC5 a ticket and a run of another project open by direct link with their project, say Outside the filter with a link, keep the filter in the control, and Esc and the back links return with it and with the scroll
level: e2e
technique: state transition (filter alpha, page of beta, then link, no filter, Esc, back links); settled geometry before the click
priority: high
risk: "a direct link to another project's ticket or run drops the project, shows no Outside the filter note, loses the filter on Esc or a back link, or returns to a different scroll position; or the click lands on a layout that still moves"
status: active
changed_by: 2026-11-08-ARK-331-1
---

## Objective

Prove that a ticket page and a run page of another project open by direct link, name the filter they are outside of, and return with the URL filter and the scroll position.

Expected: When a ticket or run of another project opens by direct link with a filter, the page shall show its project and `Outside the filter <name>` with a link, keep the filter in the control, and Esc and the back links shall return with the filter and the scroll.

## Preconditions

- A hub with projects alpha and beta, each with tickets and runs (40 tickets for the scroll check).

## Steps

1. Open `#/ticket/<beta ticket>?project=alpha` and `#/run/<beta run>?project=alpha`. Check the page shows `Project beta` and `Outside the filter alpha`, and the control shows alpha pressed.
2. Follow the note's link: the URL becomes `?project=beta`, the note is gone and beta is pressed.
3. Open each link with no filter: the project shows, there is no note, All projects is pressed.
4. From the ticket with filter alpha, follow `← Roadmap`, then use Esc from the ticket; from the run, follow `← Runs`.
5. Open the roadmap with filter alpha, wait until every source has answered and the geometry of an item is equal across two frames, scroll that item to the center, record the scroll, click it, press Esc.

## Expected results

- Each page shows its own project and the note while the filter is another project.
- The note's link sets the filter to the page's project.
- The back links and Esc return to `#/roadmap?project=alpha` or `#/runs?project=alpha`, with alpha pressed.
- Esc from a ticket of the filter's project shows no note and restores the recorded scroll position.
- The click waits for settled geometry, not for a time.

## Screenshot checkpoints

none: the case asserts text, URLs and scroll position, not appearance.
