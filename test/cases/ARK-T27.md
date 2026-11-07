---
id: ARK-T27
title: ARK-T27 Home, Runs and Roadmap send no request after the first load, and a ticket page and a run page read only their own text
level: e2e
technique: request accounting per route (a list of every request from navigation to idle), boundary of duplicate requests counting
priority: high
risk: "Home, Runs or Roadmap poll or fetch after the first load, the ticket page reads its text or its cases more than once or from a second route, the run page reads anything beyond its own `/api/run/` reads, or the run evidence is read twice"
status: active
changed_by: 2026-11-06-ARK-314-1
---

## Objective

Prove the request limits of the hub pages: the first load makes only the document, one event stream and assets; moving between Home, Runs and Roadmap sends nothing; the ticket page sends exactly one read of its test cases; each run page sends only `/api/run/` reads, with the test evidence read once for each run page and no image read when the plan has none.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts` on the `homeWithBlockers` fixture (project `p`, a stuck run, an older run with test evidence and a 6-pass review) with fake Orca tools.
- Ticket `ARK-521` (title `Ticket`, ready) with criterion `AC1`, method `test`, `verified_by: [ARK-T1]`.
- The page records every request path in a list (duplicates count).

## Steps

1. Open Home. Wait until the stuck count and the `6 pass · 0 fail` review tests show and no stale label remains. Take the recorded requests as the first load.
2. Assert the first load holds exactly one `/events` request and otherwise only `/` and `/assets/*`.
3. Click Runs, Roadmap, Home in the navigation; wait 2 s. Assert no request was sent.
4. Open `#/ticket/ARK-521`. Assert the ticket page shows. `checkpoint(page, "ticket-page-requests")`. Wait 1 s. Assert the `/api/ticket` requests are exactly `["/api/ticket/p/ARK-521/cases"]`.
5. Open the stuck run page (timeline visible), then the older run page. Assert its evidence block shows. `checkpoint(page, "run-evidence-requests")`. Wait 2 s.
6. Assert that every request other than `/`, `/events`, `/assets/*` and `/api/ticket/*` starts with `/api/run/`, that there is at least one, that exactly two requests end in `/evidence` (one for each run page) and that none ends in `/image`.

## Expected results

- When a page loads, the system shall send only the reads that ARK-285 and ARK-314 allow.
- Home, Runs and Roadmap shall send no request after the first load.
- The ticket page shall send one read of its test cases and nothing else under `/api/ticket`.
- A run page shall send one read of its test evidence, and an image read only for an image that the plan names.

## Screenshot checkpoints

- `ticket-page-requests`: the ticket page of `ARK-521` loaded.
- `run-evidence-requests`: the older run page with its test evidence block.
