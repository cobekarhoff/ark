---
id: ARK-T18
title: ARK-T18 ticket page shows method, case links and the no-integration warning
level: e2e
technique: equivalence classes of the four methods; decision table of method test times case levels (unit only / unit plus integration / none); shared case across two tickets
priority: high
risk: "a criterion hides its method or links, a shared case lists only one ticket, a test AC covered only by unit cases shows no warning, or a non-test AC shows a warning it should not"
status: active
changed_by: 2026-11-06-ARK-314-1
---

## Objective

Prove the ticket page shows id, method and one link per `verified_by` case on each criterion, lists every ticket and AC of a shared case with links to each ticket page, and warns on a `method: test` AC with no integration or E2E case.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts` on a fixture project (`test_case_source: local`) with ticket ARK-900 of four criteria and ticket ARK-901 (its page must exist).
  - AC1 `method: test`, `verified_by: [ARK-T1]` (T1 integration, active): no warning.
  - AC2 `method: test`, `verified_by: [ARK-T2]` (T2 unit, active): warning.
  - AC3 `method: demonstration`, `verified_by: []`: no warning.
  - AC4 `method: inspection`, `verified_by: [ARK-T1, ARK-T3, ARK-T99]` (T3 e2e retired, T99 has no file).
  - ARK-T1 also verifies ARK-901 AC1 (shared across two tickets).
- Light theme, desktop viewport 1280x800.

## Steps

1. Open `#/tickets/ARK-900`. `checkpoint(page, "ticket-criteria")`.
2. For each `ticket-criterion` assert the id and method text: `AC1`/`test`, `AC2`/`test`, `AC3`/`demonstration`, `AC4`/`inspection`.
3. Assert AC1 holds one link whose text contains `ARK-T1`, `integration` and `active`. Assert AC4 holds three links, in `verified_by` order: `ARK-T1 integration active`, `ARK-T3 e2e retired` and an entry `ARK-T99 missing` that is not a link to a blank page.
4. Assert AC3 holds no case link and shows no warning.
5. Assert AC2 shows a warning element visible in the viewport whose text names the rule (a `method: test` criterion with no integration or E2E case), and that AC1, AC3 and AC4 show none. Assert the count of warnings on the page is exactly 1.
6. `checkpoint(page, "ticket-shared-case")`. Open the link of `ARK-T1`. Assert it lists `ARK-900 AC1`, `ARK-900 AC4` and `ARK-901 AC1`, and that each ticket id is a link whose `href` ends with `#/tickets/ARK-900` or `#/tickets/ARK-901`.
7. Click the `ARK-901` link. Assert the URL hash is `#/tickets/ARK-901` and that page shows its own criteria.

## Expected results

- When the ticket page opens, the system shall show the id, the method and one link per `verified_by` case on each criterion, each link with case id, level and status.
- Where a case verifies ACs of several tickets, the system shall list every ticket and AC it verifies, and each ticket id shall link to its page.
- If a criterion has `method: test` and no integration or E2E case in `verified_by`, then the system shall show a visible warning on it, and on no other criterion.
- A `verified_by` id with no case file shall show the word `missing`.

## Screenshot checkpoints

- `ticket-criteria`: ticket ARK-900 with four criteria; AC2 warning visible.
- `ticket-shared-case`: the shared case ARK-T1 listing both tickets.
