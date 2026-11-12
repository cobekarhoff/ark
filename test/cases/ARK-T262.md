---
id: ARK-T262
title: ARK-T262 the ARK-T227 Home 1024 px check gives the same result at 23:30 UTC, inside the window where the usage reset text wrapped
level: e2e
technique: boundary values over the clock (a time inside the 22:46-00:00 UTC window against a midday control), with the page clock fixed
priority: high
risk: the usage tile "resets <date> <time>" text is longer in the 22:46-00:00 UTC window and wraps at 1024 px, so ARK-T227 passes at midday and fails at night (or the fix hides the wrap only at one time)
status: active
changed_by: 2026-11-11-ARK-423-1
---

## Objective

Prove that the ARK-T227 geometry checks give the same result at a clock time inside the 22:46-00:00 UTC window as at midday, so ARK-T227 does not depend on the time of day.

## Preconditions

- Same scratch `ARK_HOME`, fake tools, fixtures and 1024 x 800 viewport as ARK-T227.
- Timezone UTC. The page clock fixed with `page.clock.setFixedTime` (timers keep running), and the fixture dates (usage reset, run names, "yesterday") derived from the same fixed instant.
- Two instants: 23:30 UTC (this case) and 12:00 UTC (the control, run by ARK-T227).

## Steps

1. Fix the clock at 23:30 UTC and open Home at 1024 px.
2. Read the usage tile note: it shows the long form `resets <date> <time>`.
3. Run the ARK-T227 geometry checks (tile lines, longest word, date `scrollWidth`, ticket id on one line).
4. Take a checkpoint.

## Expected results

- The usage tile shall show `resets <date> <time>` in the long form, so the case does test the text that used to wrap.
- The usage tile note shall not break one word per line and shall have at most 3 lines.
- Every ARK-T227 expected result shall hold at 23:30 UTC as at 12:00 UTC.
- The result shall not change with the real time of day when the test runs.

## Screenshot checkpoints

- `home-1024-2330`: the whole Home page at 1024 px with the clock at 23:30 UTC.
- `home-1024-2330-tiles`: the tile row, including the usage tile.
