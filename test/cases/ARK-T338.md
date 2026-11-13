---
id: ARK-T338
title: ARK-T338 RISK04 message for an unplanned file names the file, the Not in plan line and the findings file
level: integration
technique: equivalence classes (one bare entry, several bare entries, entry with reason), message content check
priority: medium
risk: the refusal prints only the first 80 characters of the entry, so the reviewer or run lead does not know which line to write or in which file, and loops on RISK04 refusals
status: active
changed_by: 2026-11-13-ARK-430-1
---

## Objective

Prove that RISK04 on a body listing an unplanned file with no reason names that file, the line `Not in plan: <file> — <reason>` and the path `findings/<step>.md` of the reviewer step. Serves ARK-430/AC4.

## Preconditions

- Fixture run with a reviewer step in `plan.yml` and a findings file with a `## Merge risk` block and no `Not in plan:` line.
- Body A lists `cli/helpers.ts` under `Also changed, not in plan:` with the `no reason given` marker.
- Body B lists two entries without a reason (`cli/helpers.ts`, `cli/run.ts`) and one with a reason.
- Body C: every entry has a reason.

## Steps

1. Lint body A; read the RISK04 status and reason.
2. Lint body B.
3. Lint body C.
4. Run `bun test test/pr-writing.test.ts` (existing assertion for `an unplanned file has no reason`).

## Expected results

- Body A: RISK04 fails; the reason names `cli/helpers.ts`, `Not in plan:` with the `—` form, and `findings/<step>.md` for the reviewer step.
- Body B: the message names both files without a reason and not the one with a reason.
- Body C: RISK04 passes.
- Existing tests still pass, or are updated with the phrase kept.

## Screenshot checkpoints

none: CLI output and function results; no UI.
