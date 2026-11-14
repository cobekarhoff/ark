---
id: ARK-T15
title: ARK-T15 retro reports rework, plan changes and escaped defects linked to the run
level: integration
technique: equivalence classes (entry of this run, entry of another run) and counted totals
priority: high
risk: retro miscounts rework rounds, escalations, findings sent back or plan changes, or lists an escaped defect of another run, so the run's metrics.json misstates how much human and review effort the run took
status: active
changed_by: 2026-11-14-ARK-392-1
---

## Objective

Prove that `ark retro <run>` writes `rework`, `human_intervention` and `escaped_defects` to `metrics.json`, each counted from this run's events and files only. Serves ARK-160/AC5.

Expected: When ark retro runs for a run, the system shall report rework, plan changes and the escaped defects linked to that run.

## Preconditions

- A temporary `ARK_HOME` with a project and a closed run, the same fixture as the other `test/retro.test.ts` cases. The run's events hold 2 rework rounds, 1 escalation and 1 plan change.
- `$ARK_HOME/projects/<project>/escaped-defects.yml` holds two entries: `ticket: ARK-901` for the run under test (note `rounding bug found in production`), and `ticket: ARK-777` for a different run.
- `<run folder>/findings/round-1.md` holds one finding, `### P1: export drops the unit`.

## Steps

1. Write the escaped-defects entries and the findings file.
2. Run `ark retro <run>`.
3. Read `<run folder>/metrics.json`.

## Expected results

- `rework` is `rounds: 2`, `escalations: 1`, `findings_sent_back: 1`, `findings_left_p0p1: 0`, `findings_dropped: 0`, `merge_steps: 0`, `rules_added: 0`.
- `human_intervention` is `plan_changes: 1`, `mr_comments: 0`, `mr_commits_after_open: 0`, `mr_sync_commits: 0`, `mr_fix_commits: 0`. `mr_commits_after_open` is the sum of the other two.
- `escaped_defects` holds only the ARK-901 entry, with its note and empty `fix` and `reviewer`. The entry of the other run is not listed.

## Screenshot checkpoints

None. The surface is a JSON file; no screenshot applies.
