---
id: ARK-T16
title: ARK-T16 ticket parser returns method and verified_by with legacy ids
level: integration
technique: equivalence classes of the four reads (explicit method, manual only, plain, old id) plus boundary of empty and multi-item verified_by
priority: high
risk: "the parser still drops method or verified_by, reads a manual criterion as test, reads a plain criterion as demonstration, or shows an old id ARK-243-AC1 as a different AC than local AC1 so one AC appears twice"
status: active
changed_by: 2026-11-06-ARK-314-1
---

## Objective

Prove `parseTicketDocument` (`hub/ticket-document.ts`) returns the id, `method` and `verified_by` list of every criterion, with the `manual` and default rules and one id for an old and a local form.

## Preconditions

- A ticket file written to a temp folder (the way `test/hub-fixtures.ts` writes tickets) with this front matter and a matching `## Acceptance criteria` table:
  - `ARK-900-AC1`: `method: inspection`, `verified_by: [ARK-T1, ARK-T2]`.
  - `AC2`: `manual: true`, no `method`, `verified_by: []`.
  - `AC3`: no `method`, no `manual`, `verified_by: [ARK-T3]`.
  - `ARK-243-AC4`: no `method`, no `manual`, no `verified_by` key (old id form; the ticket id of the file is ARK-900).
  - `AC5`: `manual: true` and `method: analysis` (explicit method wins over `manual`).
- A second ticket file of the same shape whose criterion is written `ARK-900-AC1` in one place and `AC1` in another (same AC, both forms), to check one AC, not two.
- `test/hub.test.ts` is where the case lives and `bun test test/hub.test.ts` runs it.

## Steps

1. Parse the ticket file with `parseTicketDocument`.
2. Read `criteria` and assert the list has five entries in file order.
3. For each entry assert the triple (id, method, verified_by) in Expected results.
4. Parse the second file. Assert `ARK-900-AC1` and `AC1` yield one criterion of the ticket with the display id `AC1`, never two.
5. Assert the parse does not throw and drops no other field the page already used (`id` and `text` of each criterion are unchanged).

## Expected results

- When a ticket is parsed, the system shall return `id`, `method` and `verified_by` of each criterion.
- Exact triples: `AC1`, `inspection`, `[ARK-T1, ARK-T2]`; `AC2`, `demonstration`, `[]`; `AC3`, `test`, `[ARK-T3]`; `AC4` (from `ARK-243-AC4`), `test`, `[]`; `AC5`, `analysis`, `[]`.
- Where a criterion has `manual: true` and no `method`, the system shall read `demonstration`.
- Where a criterion has no `method` and no `manual`, the system shall read `test`.
- An old id `ARK-243-AC4` and a local id `AC4` shall both show as AC4 of their ticket, and a ticket that spells one AC both ways shall list it once.

## Screenshot checkpoints

none: integration case on a parser; no UI surface.
