---
id: ARK-T227
title: ARK-T227 at 1024 px the Home tiles do not break one word per line, clip a date or wrap a ticket id
level: e2e
technique: boundary values (1024 px viewport, longest ids and dates, narrowest tile) with geometry assertions
priority: high
risk: at 1024 px the KPI tile text breaks one word per line, a relative date such as "yesterday" is clipped by its box, or a long ticket id wraps; short fixture ids and dates hide all three
status: active
changed_by: 2026-11-11-ARK-423-1
---

## Objective

Prove, by measuring the page in a real browser at 1024 px wide, that Home shows no tile text broken one word per line, no clipped date and no wrapped ticket id.

## Preconditions

- Scratch `ARK_HOME`, fake tools, the hub on the Home page. Viewport 1024 x 800.
- A fixed clock: timezone UTC and `page.clock.setFixedTime` at 12:00 UTC (control; ARK-T262 runs the same checks at 23:30 UTC). The fixture dates (usage reset, run names, "yesterday") derive from the same instant, so the result does not depend on the time of day.
- Fixtures with the longest realistic text: a ticket id of 12 characters or more with a long run id (`ARK-1234-12`), a run that waits on a gate, a run last updated "yesterday" (the widest relative date), a stuck run, a review item, and the KPI tiles with values of several digits.
- Named elements that count as "tile text": `[data-testid="tile"] .tile-label` and `.tile-note`. Named dates: the `run-age`, `waited` and `run-idle` text on Home and the tile notes that hold a time. Named ticket ids: the ticket id link or label in every `run`, `review`, `gate`, `waiting` and `stuck` row and in each tile that shows one.

## Steps

1. Set the viewport to 1024 x 800 and open Home.
2. For each tile, read the `tile-label` and `tile-note` boxes: the number of text lines (`height / line-height`) and the longest word width against the box width.
3. For each named date element, compare `scrollWidth` with `clientWidth`, and check its box is inside its parent's box.
4. For each named ticket id, compare its height with one line (`height <= line-height`), and check `white-space` does not allow a wrap inside the id.
5. Take a checkpoint, then repeat steps 2 to 4 at 1280 px as a control.

## Expected results

- At 1024 px, no tile label or note shall have more lines than words in a phrase that fits: no tile shall show a word of its text alone on a line when another word fits beside it (the number of lines of each tile note is at most 3, and the tile text box is at least as wide as its longest word and wider than 8 characters).
- At 1024 px, no date element shall have `scrollWidth` above `clientWidth`, and none shall lie outside its parent box.
- At 1024 px, every ticket id shall render on one line.
- The same checks shall pass at 1280 px, so the fix does not move the break.
- The result shall be the same whatever the real time of day when the test runs.
- The existing 320 px and 1280 px tests shall still pass, so the shared CSS (`.gnode .ghead`, `Card`) did not shift other checkpoints.

## Screenshot checkpoints

- `home-1024`: the whole Home page at 1024 px.
- `home-1024-tiles`: the tile row at 1024 px.
