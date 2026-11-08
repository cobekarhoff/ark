---
id: ARK-T77
title: ARK-T77 GET /api/ticket/<project>/<id> answers one ticket document read at request time, and an unknown project, an unknown ticket or a path outside the tickets folder answers 404
level: integration
technique: equivalence classes of request (found, unknown project, unknown ticket, traversal in plain, percent-encoded and single-segment form), state transition (file edited between two reads), route anchoring against /cases
priority: high
risk: "the route answers stale text from a cache instead of the file at request time; an unknown project or ticket answers 200, 500 or an empty body; a `../`, `%2e%2e%2f` or `..` request path reads a file outside the tickets folder; the new pattern swallows /api/ticket/<project>/<id>/cases (or the cases route swallows the new one); a file that exists but does not parse is reported as 404 or as a crash"
status: active
changed_by: 2026-11-07-ARK-329-1
---

## Objective

Prove the read-only ticket route answers the document of exactly one listed ticket from its file at request time, answers 404 for anything else, and coexists with the cases route. Serves ARK-329/AC2.

Expected: When a client requests `/api/ticket/<project>/<id>`, the system shall answer the document read from that ticket's file at request time; the system shall answer 404 for an unknown project, an unknown ticket and a path outside the tickets folder.

## Preconditions

- Hub started on a temp `ARK_HOME` through `start()` in `test/hub.test.ts`, project `p`, `ticket_source: local`.
- Ticket `ARK-840` (title `Readable`): problem `Why it hurts`, change `What changes`, one criterion `AC1` with `verified_by: [ARK-T1]`.
- Ticket file `ARK-842.md` listed in the backlog whose body does not parse as a ticket document.
- A file `<ARK_HOME>/outside.md` with the text `OUTSIDE TICKET DIRECTORY`.

## Steps

1. Request `/api/ticket/p/ARK-840`. Assert status 200 and a document with problem `Why it hurts`, change `What changes` and criterion `AC1`.
2. Rewrite the problem of `ARK-840.md` to `Changed text` without a restart. Request the route again. Assert the new text shows at once.
3. Request `/api/ticket/nope/ARK-840` and `/api/ticket/p/ARK-999`. Assert both answer 404.
4. Request `/api/ticket/p/../../outside`, `/api/ticket/p/..%2F..%2F..%2Foutside`, `/api/ticket/p/%2e%2e%2f%2e%2e%2foutside`, `/api/ticket/p/..` and `/api/ticket/p/..%2F..%2F..%2Foutside.md`. Assert each answers 404 and no body holds `OUTSIDE TICKET DIRECTORY`.
5. Request `/api/ticket/p/ARK-840/cases`. Assert it still answers the cases as before and the body is not a ticket document.
6. Request `/api/ticket/p/ARK-842`. Assert the answer is distinct from 404 and from a found ticket (the plan decides 200 with `document: null` or 500), and that the hub still serves `/` afterwards.
7. Request `/api/ticket/p/%E0%A4%A` (malformed percent-encoding). Assert a 4xx answer and that the hub still serves `/`.

## Expected results

- A listed ticket answers 200 with its document, read from its file at request time (step 2 shows the edit).
- An unknown project, an unknown ticket and every path outside the tickets folder answer 404, and no body holds the outside text.
- `/cases` and the new route each answer their own body.
- An unparseable ticket file answers a defined non-404 answer and never crashes the hub.

## Screenshot checkpoints

none: integration case on the HTTP route; no page is shown.
