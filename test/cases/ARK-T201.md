---
id: ARK-T201
title: ARK-T201 a quick ark test prints the skipped count at head only and leaves the base fields out of the event
level: integration
technique: state transition (full run to quick run) on the same fixture
priority: medium
risk: a quick run has no base run, yet prints a made-up base count or an empty deleted list that reads as "nothing deleted", and the MR body then claims a clean result from a run that never compared against base
status: active
changed_by: 2026-11-10-ARK-393-1
---

## Objective

Prove that `ark test <run> --quick` reports skipped tests at head and records neither the base count nor the deleted list.

## Preconditions

- The head-skips-one, head-deletes-one fixture of ARK-T199, with a changed test file so that `--quick` runs it.

## Steps

1. Run `ark test <run> --quick`. Read stdout and the `test.completed` event.

## Expected results

- stdout shall hold `tests      <n> passed, 2 skipped` with no `(base ...)` and no `deleted` text, and no `deleted` line.
- The event shall have `mode` = `quick`, `passed_count` and `skipped`, and shall have no `base_skipped` and no `deleted` field (absent, not `[]`).
- The exit code shall be the same as before.

## Screenshot checkpoints

none: CLI output and an event.
