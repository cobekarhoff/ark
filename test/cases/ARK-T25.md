---
id: ARK-T25
title: ARK-T25 ticket text and criteria arrive in the snapshot from the ticket's own file, there is no /api/ticket route, and a front-matter id with ../ reads nothing outside
level: integration
technique: equivalence classes of ticket id (plain, front-matter id with ../) times read path (snapshot, /api/ticket/<project>/<id>); boundary of a path that leaves the ticket folder
priority: high
risk: "the snapshot drops a criterion field (id, text, method, verified_by), a ticket reads text of a file outside its own folder through a planted front-matter id, or a bare /api/ticket/<project>/<id> route answers and serves ticket text a second way"
status: active
changed_by: 2026-11-06-ARK-314-1
---

## Objective

Prove the hub sends the text and criteria of each backlog ticket in its snapshot, read from the ticket's own file with criteria as `{id, text, method, verified_by}`, that nothing outside the ticket folder is read through a planted front-matter id, and that no ticket text route exists beside the snapshot (only `/api/ticket/<project>/<id>/cases` is read on request, proven in ARK-T24).

## Preconditions

- Hub started on a temp `ARK_HOME` through `start()` in `test/hub.test.ts`, project `p`, `ticket_source: local`.
- Ticket `ARK-840` (title `Readable`, status `ready`): problem `Why it hurts`, change `What changes`, one criterion written `ARK-840-AC1` (old id form) with text `It works`, no method, no `verified_by`.
- Ticket file `ARK-841.md` with front matter `id: ../../../outside` and title `Planted`, problem `Own text`.
- A file `<ARK_HOME>/outside.md` with the problem text `OUTSIDE TICKET DIRECTORY`.

## Steps

1. Wait for the snapshot to list two tickets.
2. Read the `document` of `Readable`. Assert it equals problem `Why it hurts`, change `What changes` and one criterion `{id: AC1, text: It works, method: test, verified_by: []}` (the old id reads as local `AC1`, the default method is `test`).
3. Read the `document` of `Planted`. Assert its problem is `Own text`.
4. Assert the serialized snapshot never contains `OUTSIDE TICKET DIRECTORY`.
5. Request `/api/ticket/p/ARK-840` and `/api/ticket/p/..%2F..%2F..%2Foutside`. Assert both answer 404.

## Expected results

- When the hub reads a ticket, the system shall send its criteria with id, text, method and `verified_by` in the snapshot.
- The system shall read the text of a ticket only from the ticket's own file, never from a path that a front-matter id names outside the ticket folder.
- The system shall answer 404 for a ticket text request outside the snapshot.

## Screenshot checkpoints

none: integration case on the snapshot and the HTTP route; the page rendering of a criterion is proven in ARK-T28 and ARK-T26.
