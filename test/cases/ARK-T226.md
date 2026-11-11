---
id: ARK-T226
title: ARK-T226 the closed-run count in the page header equals the Closed lane count with 45 closed runs
level: e2e
technique: equivalence classes with fixtures that make the per-ticket count and the per-run count differ
priority: high
risk: the header counts closed backlog tickets (one per ticket) while the lane counts closed runs, so the two numbers differ whenever a ticket has several closed runs, a newer open run, or is missing from the backlog; a fixture with one run per ticket hides this
status: active
changed_by: 2026-11-10-ARK-375-1
---

## Objective

Prove that the number of closed runs in the Runs page header and the number in the Closed lane are one number, with 45 closed runs in a fixture where the per-ticket count and the per-run count differ.

## Preconditions

- Scratch `ARK_HOME`, fake tools, the hub on the Runs page.
- 45 closed runs in total, built so that a per-ticket count is not 45:
  - 40 closed runs, one per backlog ticket (`done`).
  - 2 closed runs of one backlog ticket (an older and a newer closed run), so one ticket has two runs.
  - 1 closed run of a ticket that has a newer `building` run (the ticket is open, its older run is closed).
  - 2 closed runs of tickets that are not in the backlog.
- The expected closed-run count is 45; the number of closed backlog tickets is not 45.

## Steps

1. Open the Runs page.
2. Read the number of closed runs in the header (`Runs ... N closed`).
3. Read the count in the Closed lane header (`lane` with `data-lane="Closed"`).
4. Click Show more until every card shows, and count the Closed lane cards.
5. Read the graph filter label that counts closed tickets, if it is still shown.

## Expected results

- The header closed number shall be 45.
- The Closed lane count shall be 45.
- The header number and the lane number shall be equal, and equal to the number of cards after Show more has shown all.
- If the graph filter still shows a ticket-based count, it shall be labelled apart from the run count (for example "tickets"), so that two unlabelled closed numbers never disagree on the page.

## Screenshot checkpoints

- `closed-count-45`: the page header and the top of the Closed lane in one view.
