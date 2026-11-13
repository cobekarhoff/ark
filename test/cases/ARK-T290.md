---
id: ARK-T290
title: ARK-T290 the header strip is on every hub page and the Resources page groups run, agent, process, leftover and other, with a red swap level and a copy-kill button
level: e2e
technique: state fixture with one object of each kind (2 runs, 3 agents, 1 leftover, red swap), navigation over every route, clipboard side effect
priority: high
risk: the strip is missing on a page (a route added without it), a level shows the wrong colour or `unchecked` shows as normal, a run or agent has its processes under the wrong heading, the copy button copies the wrong pid or its command or a process command line renders as markup, or the page shows a secret or sends a write request
status: active
changed_by: 2026-11-12-ARK-418-1
---

## Objective

Every hub page shows a strip with CPU, memory pressure, swap, disk, load and the `ark test` admission (holder, waiting runs, wait), each with its level colour, and a link to `#/resources`. `#/resources` lists open runs, then each agent with step and model, then its processes with kind, CPU % and memory; then `Leftover from closed runs` (run, age, command, copy `kill <pid>`); then `Other` (top 10 by memory); and a 24 h sparkline for each host signal.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts` (strategy S1) with the fixtures of `test/hub-fixtures.ts`: fake `orca`, `gh`, `omp` on PATH, and the fake `ps`, `lsof` and host readers of ARK-T288 / ARK-T289.
- Fixture: 2 open runs `RUN-A` and `RUN-B`; 3 agents (2 on `RUN-A` with different step and model, 1 on `RUN-B`), each with 2 or more processes of kinds `bun test`, `playwright`, `chromium`, `omp`, `git`; one leftover (`astro preview`, pid 48189, closed run `RUN-C`, 11 days old, command text with `<b>x</b>` and `&`); 12 `other` processes with different memory; swap 6.5 GB (red), pressure warn (amber), load normal, disk normal, one signal unread (`unchecked`); admission: `RUN-A` holds, `RUN-B` waits 42 s.
- `GET /api/resources/history` serves a fixture history of at least 2 points for each signal, so the sparkline draws. This case owns the rendering only; the 24 h retention window is proven by ARK-T288 step 9.
- Clipboard permission granted to the test page (`context.grantPermissions(["clipboard-read","clipboard-write"])`).

## Steps

1. Open `#/` (Home). Read the strip.
2. Visit each other route (`#/runs`, a run page, `#/roadmap`, `#/resources` and each other view in `views` of `hub/page/app.tsx`, including an unknown route). Check that the strip is present on each.
3. Click the strip link to `#/resources`.
4. Read the sections of the Resources page in order and the rows in each.
5. Click the copy button of the leftover row and read the clipboard.
6. Record every network request made from step 1 to step 5.
7. Emulate light and dark; take screenshots.

## Expected results

- The strip is on each page of step 2 with CPU, memory pressure, swap, disk, load and admission; swap has the red level, pressure amber, the unread signal `unchecked` (a distinct label and colour, not green), others normal. Admission names `RUN-A` as holder and `RUN-B` waiting 42 s. The strip links to `#/resources`.
- Order on the page: open runs (2), each followed by its agents (3 in all, each with step and model), each with its processes with kind, CPU % and memory; then `Leftover from closed runs` with 1 row (run `RUN-C`, age 11 d, command shown as text, no markup rendered: `<b>x</b>` is visible as text); then `Other` with exactly 10 rows, the 10 largest by memory in descending order; each host signal has a sparkline.
- The clipboard holds exactly `kill 48189`.
- Step 6: only GET requests (no POST, PUT, DELETE, PATCH); no request to a kill or process route; the leftover row has no button other than copy.
- No page text and no response holds the fake `GH_TOKEN` value of ARK-T288.
- Dark and light screenshots keep the level colours readable and keep the strip from covering page content.

## Screenshot checkpoints

- Strip on Home, light and dark (each level colour, `unchecked`, admission).
- Strip on a run page.
- Resources page from top to bottom: runs/agents/processes, Leftover section with the copy button, Other with 10 rows, sparklines. Compare with `mockups/s1-resources-page.html` and `mockups/s1-header-strip.html`.
