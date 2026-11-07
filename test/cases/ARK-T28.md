---
id: ARK-T28
title: ARK-T28 ticket page shows method, case links and the no-integration warning
level: e2e
technique: equivalence classes of the four methods; decision table of method test times case levels (unit only / integration / empty list); shared case across two tickets
priority: high
risk: "a criterion hides its method or links, a shared case lists only one ticket, a test AC covered only by unit cases shows no warning, or a non-test AC shows a warning it should not"
status: active
changed_by: 2026-11-06-ARK-314-1
---

## Objective

Prove the ticket page shows id, method and one link per `verified_by` case on each criterion, lists every ticket and AC of a shared case with links to each ticket page, and warns on a `method: test` AC with no integration or E2E case.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts` on a fixture project (`test_case_source: local`) with three tickets.
  - ARK-900, one criterion of each method:
    - AC1 `method: test`, `verified_by: [ARK-T1]` (T1 integration, active): no warning.
    - AC2 `method: demonstration`, `verified_by: []`: no warning.
    - AC3 `method: inspection`, `verified_by: [ARK-T1, ARK-T3, ARK-T99]` (T3 e2e retired, T99 has no case file).
    - AC4 `method: analysis`, `verified_by: []`: no warning.
  - ARK-901 (its page must exist): AC1 `method: test`, `verified_by: [ARK-T1]`. ARK-T1 is shared by ARK-900 AC1, ARK-900 AC3, ARK-901 AC1 and ARK-902 AC3.
  - ARK-902, warning fixture:
    - AC1 `method: test`, `verified_by: [ARK-T2]` (T2 unit, active): warning.
    - AC2 `method: test`, `verified_by: []` (empty list): warning.
    - AC3 `method: test`, `verified_by: [ARK-T1]`: no warning.
- Light theme, desktop viewport 1280x800.

## Steps

1. Open `#/ticket/ARK-900`. `checkpoint(page, "ticket-criteria")`.
2. For each `ticket-criterion` assert the id and method text: `AC1`/`test`, `AC2`/`demonstration`, `AC3`/`inspection`, `AC4`/`analysis`. Assert exactly four criteria.
3. Assert AC1 holds exactly one case link whose text contains `ARK-T1`, `integration` and `active`.
4. Assert AC3 holds three case entries in `verified_by` order, of which exactly two are links: `ARK-T1 integration active` and `ARK-T3 e2e retired`, each with a non-empty `href`. The third entry reads `ARK-T99 missing`, is plain text with no `<a>` and no `href`, and is not an empty row.
5. Assert AC2 and AC4 hold no case entry and no link. Assert the page holds no warning element (count 0).
6. Open `#/ticket/ARK-902`. Assert AC1 and AC2 each show one warning element, visible in the viewport, whose text names the rule (a `method: test` criterion with no integration or E2E case). Assert AC3 shows none and the warning count on the page is exactly 2.
7. Open `#/ticket/ARK-900` again. Click the link of `ARK-T1` in AC1 and wait until the case listing is visible. `checkpoint(page, "ticket-shared-case")`.
8. Assert the listing holds exactly the four entries `ARK-900 AC1`, `ARK-900 AC3`, `ARK-901 AC1` and `ARK-902 AC3`, and that each ticket id is a link whose `href` ends with `#/ticket/<id>` of that ticket.
9. Click the `ARK-901` link. Assert the URL hash is `#/ticket/ARK-901` and that page shows its own criteria.

## Expected results

- When the ticket page opens, the system shall show the id, the method and one link per `verified_by` case on each criterion, each link with case id, level and status.
- Where a case verifies ACs of several tickets, the system shall list every ticket and AC it verifies, and each ticket id shall link to its page.
- If a criterion has `method: test` and no integration or E2E case in `verified_by`, then the system shall show a visible warning on it, and on no other criterion.
- A `verified_by` id with no case file shall show the word `missing` as a plain-text entry that is not a link.

## Screenshot checkpoints

- `ticket-criteria`: ticket ARK-900 with its four criteria, one of each method, no warning.
- `ticket-shared-case`: the opened shared case ARK-T1 listing ARK-900, ARK-901 and ARK-902.
