---
id: ARK-T301
title: ARK-T301 the hub nav lists Home, Runs, Roadmap, Resources and Companions, and the retired #/map and #/backlog routes still redirect
level: e2e
technique: equivalence classes (retired route, current route) and an exact list of the nav links
priority: medium
risk: the Companions view is missing from the nav or not last, the Resources view is missing or in the wrong place, a retired view (Map, Backlog) comes back as a nav link, or a retired route stops redirecting to Runs or Roadmap
status: active
changed_by: 2026-11-14-ARK-480-1
---

## Objective

The nav of the hub lists exactly Home, Runs, Roadmap, Resources and Companions, in that order. `#/map` still lands on `#/runs`, and `#/backlog` and `#/backlog/<ticket>` still land on `#/roadmap` and `#/roadmap/<ticket>`. Converted on touch from ARK-285-AC1 and ARK-291-AC1: both asserted the nav list, which ARK-418 extended with Resources and ARK-480 extends with Companions.

Expected: When the hub opens, the system shall list five nav links, Home, Runs, Roadmap, Resources and Companions, with Companions last, and keep the redirects of the retired routes.

## Preconditions

- A hub fixture with no run, and one with a ready ticket and a Roadmap file.
- Playwright (`test/pw/hub.pw.ts`).

## Steps

1. Open `#/map` and read the nav links.
2. Open `#/backlog` and `#/backlog/ARK-701` and read the nav links and the third link's href.

## Expected results

- `#/map` ends at `#/runs` and the nav links read Home, Runs, Roadmap, Resources, Companions.
- `#/backlog` ends at `#/roadmap`, `#/backlog/ARK-701` at `#/roadmap/ARK-701`, the nav reads the same five links and does not hold Backlog, and the Roadmap link is `#/roadmap`.

## Screenshot checkpoints

none
