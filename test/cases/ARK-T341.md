---
id: ARK-T341
title: "ARK-T341 the trace shows the Master Chief, run lead and role-group rows, expands a group, and fits 19 workers at 1440x900 collapsed"
level: integration
technique: "boundary values (19 workers, collapsed vs expanded) with state transition (group collapse)"
priority: high
risk: "the collapsed trace scrolls or clips with 19 workers; overlapping workers of one group hide each other with no hover name; answer markers, idle or waiting bars or role colours are missing; a group click does not expand to one row per worker"
status: active
changed_by: 2026-11-13-ARK-345-1
---

## Objective

Prove the AC1 trace: time axis with minimap brush, Master Chief row with a person marker per human answer, run lead row with idle and 'waiting on you' bars, one row per role group (Planning, Implementers, Validators, Reviewers) with role-coloured bars, expanding to worker rows.

## Preconditions

- A 19-worker fixture run in test/pw/hub.pw.ts: workers across all four groups, some overlapping in time inside one group; at least two human answers; one run-lead waiting span.
- Viewport 1440x900, groups collapsed.

## Steps

1. Open the Conversation tab.
2. Check the time axis and the minimap brush exist.
3. Count the person markers on the Master Chief row; check the run lead row has idle and waiting bars.
4. Check the four group rows exist, collapsed, with role-coloured bars. Measure: the trace container has no vertical scroll (scrollHeight <= clientHeight) and nothing is clipped outside the viewport.
5. Hover a bar of an overlapping group: its tooltip names each worker.
6. Click a group row: it expands to one row per worker (count equals the group's workers); click again to collapse.

## Expected results

- Markers equal the human answers of the fixture; the run lead row shows idle and waiting bars.
- The four group rows show with distinct role colours; the collapsed trace of 19 workers has no scroll at 1440x900.
- Hover names every overlapping worker; expand gives one row per worker and collapse restores the fit.

## Screenshot checkpoints

Collapsed trace with 19 workers (dark, 1440x900); one group expanded; the hover on an overlap.
