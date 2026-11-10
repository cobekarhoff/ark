---
id: ARK-T185
title: "ARK-T185 ark retro counts a manual criterion wait from its first manual pending to its manual answer, up to the close when unanswered"
level: integration
technique: "state transition (pending, answer, problem, re-pending) and overlap of two criteria"
priority: medium
risk: "a manual wait counts as work or idle, restarts at a repeated pending, is closed by another criterion's answer, is double counted, or is dropped when open at run.closed"
status: active
changed_by: 2026-11-09-ARK-355-1
---

## Objective

Prove that `ark retro` counts the time from `manual pending` to the manual answer as waiting on you, per criterion, counting elapsed time once. Converted on touch from ARK-283-AC3; adds the wait still open at close.

## Preconditions

- Temp `ARK_HOME`, closed run fixtures with real `events.ndjson`: `run.started` 14:00:00 (or as stated), `test.completed` events with manual pending results, manual `gate.answered` events.
- Fixtures: (a) pending 14:10, answer 14:20, close 14:30; (b) pending 14:10 and again 14:15, answer 14:20; (c) pending 14:10, `problem` 14:12, pending 14:20, answer 14:21; (d) AC1 and AC2 pending 14:10, answers 14:11 and 14:15; (e) both pending and answered at the close time, spanning the whole run; (f) pending 14:10, no answer, close 14:30.

## Steps

1. Run `ark retro <run>` on the run and read its exit code.
2. Read the `time` block of `metrics.json`.

## Expected results

- (a) waiting on you 600 s; the other three parts sum to 1200 s; wall 1800 s.
- (b) 600 s: the repeated pending does not restart the wait.
- (c) 180 s: the problem answer closes the first wait and the later pending opens a new one.
- (d) 300 s: an answer for AC1 does not close AC2; the union counts once.
- (e) waiting on you is not above the wall time and idle is 0.
- (f) 1200 s: the open wait counts up to `run.closed`.

## Screenshot checkpoints

none: CLI process and a JSON file; no UI.
