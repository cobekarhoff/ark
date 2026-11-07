---
id: ARK-T26
title: ARK-T26 Roadmap lists the tickets by horizon, keys move and open them, a ticket opens as a full page with its graph and lists, and Esc returns to the same scroll position
level: e2e
technique: state transition (list, search box, ticket page, back to list) with boundaries of the first and the last selected row, a scrolled list and a ticket with escaped markup
priority: medium
risk: "a done or superseded ticket shows in the list, j, k or Enter act inside the search box or on a focused button, Esc loses the selected row or the scroll position, ticket text runs as markup or script, a criterion shows a list number or the long form of its id in place of its own id, or the graph and the dependency lists are wrong"
status: active
changed_by: 2026-11-06-ARK-314-1
---

## Objective

Prove the Roadmap lists tickets under Now, Next, Later and Unranked, that keys select and open them, that a ticket opens as a full page with its escaped text, its criteria each with their own id (`AC1`, `AC2`), its dependency graph and lists, and that Esc returns to the same row and scroll position.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts` on a hub with project `p` and fake Orca tools.
- Tickets: `ARK-701` ready with a building run; `ARK-702` in progress; `ARK-703` ready (title `The ticket page`, depends on `ARK-701`, problem with a paragraph, raw `<b>raw markup</b>` and two bullets, change with a `<script>` tag, criteria `ARK-703-AC1` `The page shows the title` and `ARK-703-AC2` `Esc returns to the list`); `ARK-704` ready depends on `ARK-703`; `ARK-705` superseded; `ARK-706` done; 40 proposed tickets `ARK-800` to `ARK-839`.
- `ROADMAP.md`: now `ARK-701`; next `ARK-702`, `ARK-703`; later `ARK-704`, the proposed tickets, `ARK-705`, `ARK-706`.

## Steps

1. Open `#/roadmap`. `checkpoint(page, "roadmap-list")`. Assert the sections read Now, Next, Later, Unranked and 44 rows show; `ARK-705` and `ARK-706` have no row.
2. Assert `ARK-701` is selected; `j` selects `ARK-702`, then `ARK-703`; `k` returns to `ARK-702`.
3. Press `/`; assert the search box has focus; type `ticket page`; assert one row; press Esc; assert the box lost focus; clear it; assert 44 rows; press Esc again.
4. Press `j`, focus the List view button, press Enter; assert the URL stays `#/roadmap`.
5. Press `j` 30 times, record `scrollY` (above 100) and the selected ticket. Press Enter; assert the URL is `#/ticket/<id>` and the ticket page shows.
6. Press Esc; assert the URL is `#/roadmap`, the same row is selected and `scrollY` equals the recorded value.
7. Open `ARK-703` from its row link. Assert the heading `The ticket page`, the problem text and its two bullets, the markup shown as written (no `<b>` element) and the `<script>` text shown as written with `window.__ran` undefined.
8. `checkpoint(page, "ticket-criteria")`. Assert two criteria; the second contains `Esc returns to the list`; the ids in `.crit-head .mono` read `AC1` and `AC2`.
9. Assert the graph holds nodes `ARK-701`, `ARK-703`, `ARK-704` and two edges, the depends-on list reads `ARK-701` and the unblocks list reads `ARK-704`; click the `ARK-704` link and assert its page opens with the title `Title of ARK-704`.

## Expected results

- When the Roadmap opens, the system shall list each open ticket once under its horizon, and no done or superseded ticket.
- When a ticket opens from the Roadmap, the system shall show each criterion with its id (`AC1`, `AC2`), its text escaped, and its graph and lists.
- When Esc is pressed on the ticket page, the system shall return to the Roadmap with the same selected row and scroll position.

## Screenshot checkpoints

- `roadmap-list`: the Roadmap with all four sections and 44 rows.
- `ticket-criteria`: the ticket page of `ARK-703` with the two criteria showing `AC1` and `AC2`.
