---
id: ARK-T118
title: ARK-T118 The hub header has the same height with 4 or more stale source labels in the nav as with none
level: e2e
technique: equivalence classes (labels present / labels absent) compared by measured header height, with the labels held on by a hold gate on the fake tools
priority: high
risk: "4 or more `stale-label` elements wrap the nav onto a second line, so the header is taller while sources are slow and shrinks when they answer (base commit: 85.8 px with labels, 45 px without), moving all page content; a reserved row that clips chips or labels, or a height that holds at one label count only, passes a single-count check"
status: active
changed_by: 2026-11-08-ARK-363-1
---

## Objective

Prove the header of the hub has the same height with 4 or more `stale-label` elements in the nav and with none. Fails at the base commit, passes at head.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts` on a hub with project `p` and the fake tools, at the viewport of the other hub specs.
- Hold gate as in ARK-T117: one environment variable names a file; while it is missing every fake tool (`orca`, `gh`, `plannotator`, `omp`) waits; the test releases them by writing the file; the wait is bounded and test cleanup writes the file.

## Steps

1. Set the gate, start the hub with the fake tools held, and open the Roadmap.
2. Assert at least 4 `stale-label` elements show.
3. Read the header bounding box height as `withLabels`.
4. Release the tools by writing the gate file; wait for 0 `stale-label` elements.
5. Read the header bounding box height as `withoutLabels`.

## Expected results

- When 4 or more source labels show, the header height shall equal the height with no labels (the same px value, both reads; at base 85.8 px and 45 px).
- With the labels showing, every label and every nav chip (project filter, Master Chief, usage, cost, theme) shall lie inside the header box.

## Screenshot checkpoints

- `header-with-labels`: the header with 4 or more stale labels showing, taken before the release.
- `header-without-labels`: the header after the labels vanished, taken at the same viewport.
