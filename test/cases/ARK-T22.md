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
3. Keyboard: press Tab from the page start until focus has visited every link and image-link of the new parts; assert each element is reached, that the focused element has a non-`none` outline (or box-shadow) with width >= 2px against its background, and that each image has non-empty `alt`.
4. Headings: read `h1`..`h6` in order; assert no level is skipped (each heading is at most one level deeper than the previous) and the new panels sit under an existing heading.
5. Contrast: for each text node of the new parts compute the contrast ratio; assert >= 4.5 for normal and >= 3 for text of 24px or 18.66px bold and larger, in both themes.
6. Requests: assert the set of requests after load equals the ones ARK-285-AC11 allows plus exactly one read of the run's test evidence and one read per image (three pairs, so images counted individually) and nothing else.
7. Speed: time 50 GETs each of `/` and `/nope`; assert p95 under 200 ms for each.
8. Run `bun test`, `bun run typecheck`, `bun run lint`, `bun run format:check`; assert exit 0 (scripts, not part of the spec).

## Expected results

- The system shall show every result and status of the new parts as text as well as color.
- The system shall make every link and image of the new parts reachable with the keyboard and readable, with a visible focus ring.
- Headings shall go in order; text shall keep a contrast of at least 4.5:1 (3:1 for large text) in light and dark.
- The pages shall send no request that ARK-285/AC11 does not allow, except one read for the run's test evidence and one for each image; `/` and `/nope` shall answer with a p95 under 200 ms.

## Screenshot checkpoints

- `ticket-dark` and `run-dark`: both pages in the dark theme with a focus ring on the first case link.
