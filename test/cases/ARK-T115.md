---
id: ARK-T115
title: ARK-T115 chief state prints each live source in one Markdown snapshot
level: integration
technique: equivalence classes of live sources (open run, closed run, queued Orca tasks, project config)
priority: medium
risk: ark chief state omits a live source (open runs, queue, workspace head, gates, concurrency, interview line, disk), lists a closed run as open, or fails when a source is present
status: active
changed_by: 2026-11-08-ARK-327-1
---

## Objective

Prove that `ark chief state` prints each live source in one Markdown snapshot. This case replaces the old id ARK-244-AC1 for the snapshot test, converted when ARK-327 replaced the Close check section with the interview line.

## Preconditions

- Fixture project as in `test/chief.test.ts` (temporary `ARK_HOME`, fixture workspace repo, fake `orca` on `PATH`).
- Master Chief has one open run, one closed run, one ready and one pending Orca task, and a project config with plan and strategy gates `auto` and concurrency 3.

## Steps

1. Run `ark chief state --project <project>`. Assert exit code 0 and empty stderr.
2. Read the `Open runs`, `Queued Orca Tasks`, `Interview` and `Disk` sections and the gates and concurrency lines.

## Expected results

- When `ark chief state` runs, the system shall print each live source in one Markdown snapshot.
- `Open runs` lists the open run with its phase and step, and does not list the closed run.
- `Queued Orca Tasks` lists the ready and the pending task.
- The output holds the short head of `main`, the plan and strategy gates, the concurrency, the interview line and the disk line.

## Screenshot checkpoints

none: integration case on CLI text output; no UI surface.
