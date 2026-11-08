---
id: ARK-T96
title: ARK-T96 the theme follows the system, the nav switch sets Auto, Light or Dark and keeps it after a reload, and text keeps its contrast on Home, Runs and a ticket page in both themes
level: e2e
technique: matrix of theme (light, dark) times view (Home, Runs, ticket page), request accounting while the views change
priority: medium
risk: "a theme switch or a view change sends a request the page does not need, the theme does not follow the system or does not survive a reload, text drops below the contrast limit in one theme, or the ticket page reads its document more than once for one visit"
status: active
changed_by: 2026-11-07-ARK-329-1
---

## Objective

Prove the theme control and the contrast of Home, Runs and a ticket page in both themes, and that switching theme and view sends only the one ticket document read for each visit of the ticket page. Converted from ARK-285-AC10; ARK-329/AC3 adds the document read.

Expected: When the theme or the view changes, the system shall send no request except one read of the ticket document for each opening of the ticket page.

## Preconditions

- Fixture of `test/pw/hub.pw.ts` `homeWithBlockers`, with tickets ARK-511 and ARK-512 (problem, change, one criterion).

## Steps

1. Open Home in the light system scheme. Assert Auto is pressed, and that the background differs between the system light and dark schemes.
2. For Light and Dark in turn: click the theme button; for Home, Runs and `#/ticket/ARK-512` open the view, wait for its content and assert no text has weak contrast.
3. Assert the requests since step 2 began are exactly two reads of `/api/ticket/p/ARK-512` (one for each opening of the ticket page) and nothing else.
4. Assert the Dark hover contrast of the primary button and Open in Orca, and that the theme survives a reload.

## Expected results

- The theme follows the system, the choice survives a reload, and every text keeps its contrast.
- Switching theme and view sends exactly one ticket document read for each opening of the ticket page and no other request.

## Screenshot checkpoints

none: the existing test takes no checkpoint.
