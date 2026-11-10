---
id: ARK-T178
title: ARK-T178 ark retro writes the four time parts to metrics.json and compares runs on waiting on you
level: integration
technique: equivalence classes (new metrics, old metrics) and state transition (old field present before, absent after)
priority: high
risk: "`ark retro` still writes the old gate wait field, writes only some of the four parts, or the comparison counts old `metrics.json` files with no new field as 0 seconds and skews the typical value"
status: active
changed_by: 2026-11-09-ARK-355-1
---

## Objective

Prove that the real `ark retro <run>` command writes waiting on you, working, waiting to merge and idle into the `time` block of `metrics.json`, no longer writes the old gate wait field, and compares the run with other closed runs on waiting on you.

## Preconditions

- A temp `ARK_HOME` with a project and a closed run whose `events.ndjson` is the fixture of ARK-T174 (parts 200, 200, 300, 200 s).
- Two earlier closed runs of the same project: one with the new field in `metrics.json` (waiting on you 100 s), one old run whose `metrics.json` has only the old gate wait field.
- Real CLI process, real files. No mocks.

## Steps

1. Run `ark retro <run>` and read its stdout and exit code.
2. Read `metrics.json` of the run.
3. Read the comparison in the output.

## Expected results

- Exit 0. The `time` block holds the four parts: 200, 200, 300, 200 s (names fixed by the plan, for example `waiting_on_you_seconds`, `working_seconds`, `waiting_to_merge_seconds`, `idle_seconds`), and they sum to the wall time.
- The `time` block holds no old gate wait field, and stdout has no `waiting at gates` line; it shows the four parts.
- The comparison names waiting on you of this run (200 s) against the earlier closed runs. Only the run with the new field counts (typical 100 s); the old run is skipped, not counted as 0 (a typical of 50 s would be a defect).
- The old run's `metrics.json` is not rewritten.

## Screenshot checkpoints

none: CLI output and a JSON file; no UI.
