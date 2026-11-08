---
id: ARK-T25
title: ARK-T25 ticket text and criteria are read from the ticket's own file and served by /api/ticket/<project>/<id>, never in the snapshot, and a front-matter id with ../ reads nothing outside
level: integration
technique: equivalence classes of ticket id (plain, front-matter id with ../) times read path (server document map, /api/ticket/<project>/<id>); boundary of a path that leaves the ticket folder
priority: high
risk: "the parsed document drops a criterion field (id, text, method, verified_by), or a ticket reads text of a file outside its own folder through a planted front-matter id"
status: active
changed_by: 2026-11-07-ARK-329-1
---

## Objective

Prove the hub reads the text and criteria of each backlog ticket from the ticket's own file with criteria as `{id, text, method, verified_by}`, serves them through `/api/ticket/<project>/<id>`, and that nothing outside the ticket folder is read through a planted front-matter id. The snapshot carries no document (ARK-T76); the route's 404 cases are proven in ARK-T77.

## Preconditions

- Hub started on a temp `ARK_HOME` through `start()` in `test/hub.test.ts`, project `p`, `ticket_source: local`.
- Ticket `ARK-840` (title `Readable`, status `ready`): problem `Why it hurts`, change `What changes`, one criterion written `ARK-840-AC1` (old id form) with text `It works`, no method, no `verified_by`.
- Ticket file `ARK-841.md` with front matter `id: ../../../outside` and title `Planted`, problem `Own text`.
- A file `<ARK_HOME>/outside.md` with the problem text `OUTSIDE TICKET DIRECTORY`.

## Steps

1. Wait for the snapshot to list two tickets.
2. Request `/api/ticket/p/ARK-840` and read the `document`. Assert it equals problem `Why it hurts`, change `What changes` and one criterion `{id: AC1, text: It works, method: test, verified_by: []}` (the old id reads as local `AC1`, the default method is `test`).
3. Request the route for `Planted` by its file's listed id. Assert its problem is `Own text`.
4. Assert the serialized snapshot and every route body never contain `OUTSIDE TICKET DIRECTORY`.

## Expected results

- When the hub serves a ticket document, the system shall send its criteria with id, text, method and `verified_by`.
- The system shall read the text of a ticket only from the ticket's own file, never from a path that a front-matter id names outside the ticket folder.

## Screenshot checkpoints

none: integration case on the HTTP route; the page rendering of a criterion is proven in ARK-T28 and ARK-T26.
