---
id: ARK-T372
title: ARK-T372 the usage reset time shows HH:MM only when it falls on the same UTC day as the page clock, and its date and time when it falls on the next day
level: e2e
technique: boundary values on the page clock (23:30 UTC across midnight, 12:00 UTC inside the day)
priority: high
risk: "the usage reset shows HH:MM for a reset on the next day (the user reads it as today), or shows a date for a reset on the same day, or the form depends on the time of day the suite runs"
status: active
changed_by: 2026-11-13-ARK-433-1
---

## Objective

Prove that the usage reset text of Home follows the page clock: the same UTC day gives `HH:MM`, the next day gives `DD Mon HH:MM`.

Expected: When the reset falls on the day after the page clock, Home shall show its date and time; when it falls on the same day, Home shall show HH:MM only.

## Preconditions

- The usage fixture resets within the hour after the base instant; the page clock and the fixtures share one instant in UTC (timezone UTC).
- The Home fixtures of ARK-T371 (gate, stuck agent, two reviews, usage 82%).

## Steps

1. Set the page clock and the fixtures to 23:30 UTC of the frozen day; open Home; read `usage-reset`.
2. Set both to 12:00 UTC of the frozen day; open Home; read `usage-reset`.

## Expected results

- At 23:30 UTC: the reset matches `resets DD Mon 00:MM` (the next day, with its date).
- At 12:00 UTC: the reset matches `resets 13:MM` (same day, HH:MM only).
- Both results hold whatever the real time of the run.

## Screenshot checkpoints

none: the case checks text, counts, order and attributes, not appearance.
