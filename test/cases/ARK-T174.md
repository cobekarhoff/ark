---
id: ARK-T174
title: ARK-T174 a run's time splits into waiting on you, working, waiting to merge and idle, adding up to the wall time with that precedence
level: integration
technique: equivalence classes (one interval per part) plus overlap precedence and boundary clamping at run start and run end
priority: high
risk: the four parts do not add up to the wall time (a subtraction chain or double count), an overlap is credited to the wrong part (working instead of waiting on you), or a gate or step still open at run.closed is dropped or runs past the end
status: active
changed_by: 2026-11-09-ARK-355-1
---

## Objective

Prove that `ark retro <run>`, reading a real `events.ndjson` through the one time-split function, writes waiting on you, working, waiting to merge and idle, into the `time` block of `metrics.json`, each to the second, summing to the time from `run.started` to `run.closed`, and that overlaps go to the first part in the order you > working > merge > idle.

## Preconditions

- A temp `ARK_HOME` with a project and one closed run folder for each fixture below, each holding a real `events.ndjson` file. The real `ark retro` process reads it. No mocks.
- Fixture events with whole-second times; `T` is `run.started`:
  - T+60 to T+300: step A runs (`step.started`, `step.finished`).
  - T+200: a criteria (or plan) gate opens; T+400: it is answered. It overlaps step A from T+200 to T+300.
  - T+500 to T+560: step B runs.
  - T+600: first `merge_request.opened`. A second `merge_request.opened` at T+700 (must not move the start).
  - T+900: `run.closed`.
- Variant fixtures built from the same events: (b) `run.closed` at T+900 and a gate opened at T+800 never answered; (c) a step started at T+850 with no `step.finished`, run closed at T+900; (d) no step, no gate and no MR, closed at T+90.

## Steps

1. Run `ark retro <run>` on the base fixture run and read its exit code.
2. Read the `time` block of its `metrics.json`; add the four parts and compare with `run.closed - run.started`.
3. Repeat on variant runs (b), (c) and (d).

## Expected results

- Base fixture: exit 0 and `metrics.json` `time` holds: waiting on you 200 s (T+200..400), working 200 s (T+60..200 = 140 s, plus T+500..560 = 60 s; the overlap T+200..300 is not counted twice), waiting to merge 300 s (T+600..900, from the first MR only), idle 200 s (T+0..60, T+400..500, T+560..600). Sum 900 s.
- (b) The gate left open at close counts as waiting on you up to `run.closed`; the parts still sum to 900 s, and the gate time T+800..900 is waiting on you, not waiting to merge.
- (c) The unfinished step runs to the run end: working includes T+850..900; the sum is 900 s.
- (d) A run with no step, gate or MR gives idle 90 s and the other three 0, sum 90 s.
- For every fixture the four parts are non-negative and sum to the wall time exactly.

## Screenshot checkpoints

none: CLI process and a JSON file; no UI. The bar and the open run (`now`) are ARK-T180.
