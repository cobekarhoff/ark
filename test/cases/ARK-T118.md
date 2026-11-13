---
id: ARK-T118
title: ARK-T118 The hub header has the same height with 0, 1 and 4 or more stale sources
level: e2e
technique: equivalence classes on the stale-source count (0, 1, 4 or more) compared by measured header height, with the sources held by per-tool gates on the fake tools
priority: high
risk: "the stale chip, its open list or a wrapped label makes the header taller while sources are slow and shorter when they answer (base commit: 85.8 px with labels, 45 px without), moving all page content; a reserved slot that clips the chip, or a height that holds at one stale count only (the matrix 0, 1, 4 or more is what catches it); a leftover `.asof-list` selector makes the case read a missing element"
status: active
changed_by: 2026-11-12-ARK-335-1
---

## Objective

Prove the header of the hub has the same height with 0, 1 and 4 or more stale sources. This case owns the header-height contract across stale counts (AC1); ARK-T310 does not repeat it. Fails at the base commit, passes at head. Updated from per-source labels to the single chip (ARK-335).

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts` on a hub with project `p` and the fake tools, at the viewport of the other hub specs.
- Hold gate as in ARK-T117, with one gate file for each fake tool (`orca`, `gh`, `plannotator`, `omp`) so the test can release them one at a time; each wait is bounded and test cleanup writes every file.

## Steps

1. Set the gates, start the hub with all fake tools held, and open the Roadmap.
2. Assert the stale chip shows with 4 or more sources behind it; read the header bounding box height as `h4`.
3. Release tools until exactly 1 source is stale; assert the chip still shows; read the height as `h1`.
4. Release the rest; wait for the chip to vanish; read the height as `h0`.

## Expected results

- The header height shall be the same px value at 4 or more, 1 and 0 stale sources (`h4 == h1 == h0`).
- With the chip showing, the chip and every nav item (project filter, Master Chief, usage, cost, theme) shall lie inside the header box.

## Screenshot checkpoints

- `header-with-chip`: the header with the stale chip at 4 or more sources, taken before the release.
- `header-without-chip`: the header after the chip vanished, taken at the same viewport.
