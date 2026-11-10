---
id: ARK-T184
title: "ARK-T184 ark retro counts each plan wait from the first valid plan check after the previous answer"
level: integration
technique: "boundary values (3601 s) and state transition (change answer then approve)"
priority: medium
risk: "a repeated valid check restarts the plan wait, or a wait of more than 3600 s is cut or lost"
status: active
changed_by: 2026-11-09-ARK-355-1
---

## Objective

Prove that `ark retro` starts a plan wait at the first valid `plan.checked` after the previous plan answer, ignores later checks, and does not cap long waits. Converted on touch from ARK-217-AC1 and ARK-217-AC2.

## Preconditions

- Temp `ARK_HOME`, closed run fixtures with real `events.ndjson`.
- (a) check 14:20:30, answer `change` 14:21:00, checks 14:21:30 and 14:21:50, answer `approve` 14:22:00, close 14:23:00.
- (b) checks at 14:00:00 and 15:00:00, answer `approve` at 15:00:01, close 15:01:00.

## Steps

1. Run `ark retro <run>` on the run and read its exit code.
2. Read the `time` block of `metrics.json`.

## Expected results

- (a) `waiting_on_you_seconds` is 60: 30 s for the change wait, 30 s from the second check (not 20 s from the third).
- (b) `waiting_on_you_seconds` is 3601.

## Screenshot checkpoints

none: CLI process and a JSON file; no UI.
