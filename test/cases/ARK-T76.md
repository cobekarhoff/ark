---
id: ARK-T76
title: ARK-T76 snapshot and push tickets carry no document, keep the fields other pages read, and stay under 15% of the ticket text
level: integration
technique: boundary value on size ratio (200 tickets of 3 KB against 15%), equivalence classes of delivery path (/api/snapshot, /events first push, /events push after a change), field presence check
priority: high
risk: "a ticket document (problem, change, criteria) still reaches the serialized snapshot or an /events push, so the payload grows with ticket text again; or the slimmed ticket loses a field that Roadmap, Home, evidence or the ticket page's side panels read (project, id, title, status, kind, milestone, depends_on, why, signature); or a body-only edit changes nothing in the snapshot, so the open ticket page gets no push"
status: active
changed_by: 2026-11-07-ARK-329-1
---

## Objective

Prove the hub leaves ticket documents out of every snapshot it serializes while it keeps the fields other pages read, and that the snapshot of 200 tickets of 3 KB is under 15% of the ticket text. Serves ARK-329/AC1.

Expected: The system shall serialize each ticket in the snapshot and in each push with no `document`, and with project, id, title, status, kind, milestone, depends_on, why, signature and the fields Roadmap and Home read.

## Preconditions

- Hub started on a temp `ARK_HOME` through `start()` in `test/hub.test.ts`, project `p`, `ticket_source: local`.
- 200 ticket files written with `writeTicket` from `test/hub-fixtures.ts`: each has title, status, `kind`, `milestone`, `depends_on`, a `why` sentence, and a problem, change and criteria body so the file is about 3 KB. One ticket (`ARK-1`) has a distinct marker string `DOC-MARKER-XYZ` in its problem.

## Steps

1. Wait until the snapshot lists 200 tickets. Read `/api/snapshot` as text.
2. Assert the text does not contain `DOC-MARKER-XYZ`, and that no ticket has a `document` key.
3. Assert each ticket has project, id, title, status, kind, milestone, depends_on, why and signature, equal to the values written. Assert the fields `roadmapOf` and the Home page read are present.
4. Sum the byte size of the 200 ticket files. Assert `snapshot text length / ticket text size < 0.15`.
5. Open `/events`, read the first push, and assert it holds no `DOC-MARKER-XYZ` and no `document` key.
6. Edit only the body of `ARK-1.md` (front matter unchanged). Wait for the next `/events` push. Assert it arrives, holds no `DOC-MARKER-XYZ` or the new body text, and that the `signature` of `ARK-1` differs from before and every other ticket's signature is unchanged.

## Expected results

- No ticket in `/api/snapshot` or any `/events` push has a `document` or any text of a ticket body.
- Each ticket keeps the fields other pages read, with the written values.
- The snapshot is under 15% of the ticket text for 200 tickets of 3 KB.
- A body-only edit changes that ticket's `signature` only, so a push occurs.

## Screenshot checkpoints

none: integration case on the serialized snapshot and the event stream; no page is shown.
