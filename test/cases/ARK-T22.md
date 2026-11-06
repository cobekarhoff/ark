---
id: ARK-T22
title: ARK-T22 new page parts keep accessibility, request limits and speed
level: e2e
technique: matrix of page (ticket, run) times theme (light, dark); boundary values of contrast 4.5:1 and 3:1; request allow-list; p95 sample
priority: medium
risk: "a result is color only, a link or image is not reachable by keyboard or has no focus ring, headings skip a level, contrast drops below 4.5:1 in one theme, the pages call a disallowed request, or the root routes slow past 200 ms"
status: active
changed_by: 2026-11-06-ARK-314-1
---

## Objective

Prove the new ticket and run page parts keep the accessibility and request limits of ARK-285 and ARK-309 in both themes, and `/` and `/nope` stay under p95 200 ms.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`, using the fixtures of ARK-T18 to ARK-T21 (ticket with four criteria and a warning; run with five panel rows, three checkpoint pairs, five evidence blocks), run once for light and once for dark (`colorScheme` emulation).
- The existing helpers of ARK-285-AC10 (contrast measure) and ARK-285-AC11 (request list) are reused, not rewritten.

## Steps

1. For each theme and each page (ticket, run), open the page and collect the requests.
2. Text status: assert each case result, status, method and warning in the new parts has a text word (`pass`, `fail`, `not run`, `active`, `retired`, `missing`, `no evidence`), not only a color.
3. Keyboard: enumerate every required target of the new parts independently of whether it is focusable now: on the ticket page every case link, every ticket-id link of the shared case listing and every warning-bearing criterion's links; on the run page every AC link of the evidence panel and every present screenshot image (a missing side has no image and is not counted). Assert each has a keyboard focus target (the element or its enclosing link/button has `tabindex` >= 0 or is natively focusable); a plain non-focusable image fails here. Press Tab from the page start at most `targets + 20` times; assert every enumerated target was focused, else fail naming the unvisited targets. For each focused target assert a non-`none` outline (or box-shadow) of width >= 2px against its background, and for each image assert non-empty `alt`.
4. Headings: read `h1`..`h6` in order; assert no level is skipped (each heading is at most one level deeper than the previous) and the new panels sit under an existing heading.
5. Contrast: for each text node of the new parts compute the contrast ratio; assert >= 4.5 for normal and >= 3 for text of 24px or 18.66px bold and larger, in both themes.
6. Requests: for each page record every individual request (a list, not a set, so duplicates count) from navigation until the network is idle plus 1 s. Remove those ARK-285/AC11 allows. Ticket page: the rest shall be exactly one read of the ticket test cases (the route of ARK-T17) and nothing else. Run page: the rest shall be exactly one read of the run test evidence plus one read for each image that is present (the fixture has 3 checkpoints, 2 with both sideswith real images: `login` 2, `list` 1, `detail` 1, so 4 image reads) and nothing else; a second read of any of them fails.
7. Speed: time 50 GETs each of `/` and `/nope`; assert p95 under 200 ms for each.
8. Run `bun test`, `bun run typecheck`, `bun run lint`, `bun run format:check`; assert exit 0 (scripts, not part of the spec).

## Expected results

- The system shall show every result and status of the new parts as text as well as color.
- The system shall make every link and every present image of the new parts reachable with the keyboard (each with its own focus target) and readable, with a visible focus ring.
- Headings shall go in order; text shall keep a contrast of at least 4.5:1 (3:1 for large text) in light and dark.
- The pages shall send no request that ARK-285/AC11 does not allow, except one read of the ticket test cases on the ticket page, one read of the run test evidence on the run page, and one read for each image; `/` and `/nope` shall answer with a p95 under 200 ms.

## Screenshot checkpoints

- `ticket-dark` and `run-dark`: both pages in the dark theme with a focus ring on the first case link.
