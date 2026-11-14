---
id: ARK-T392
title: ARK-T392 retro counts only the dropped lines under Run lead decision into rework.findings_dropped
level: integration
technique: equivalence classes (dropped line under the decision section, send-back line, dropped text outside the section) and boundary values (zero, two, no findings folder)
priority: high
risk: findings_dropped counts every "dropped" word in a findings file (a finding's Evidence text, a round file, a `## Notes` section), counts a send-back line, or misses a bold or starred dropped line, so the number ARK-349 uses to rate reviewer noise is wrong
status: active
changed_by: 2026-11-14-ARK-391-1
---

## Objective

Prove that `ark retro <run>` writes `rework.findings_dropped` in `metrics.json` as the number of list lines under `## Run lead decision`, across every findings file, that start with `dropped`. Serves ARK-391/AC3.

Expected: When a findings file holds two `- dropped <title>: <reason>` lines and one send-back line under Run lead decision, the system shall write findings_dropped as 2.

## Preconditions

- A temporary `ARK_HOME` with a closed run, the same fixture as the other `test/retro.test.ts` cases.
- `<run folder>/findings/reviewer.md` holds:
  - above the decision section: `### P2: slow export`, then an Evidence line `- **Evidence:** the reviewer dropped the unit` (the word `dropped`, not a decision line);
  - a `## Run lead decision` section with three list lines: `- dropped might be slow: no Line and no Input`, `- dropped cleanup helper: no File`, and `- P1 export drops the unit: send back, the Repro fails`;
  - a section after it, `## Notes`, with the list line `- dropped in the notes, not a decision`.
- `<run folder>/findings/round-1.md` holds one line `- dropped by hand: not a decision` and no decision section.
- A second findings file `second.md`, used in step 4: a `## Run lead decision` section with the lines `- **dropped bold title: no Input**` and `* Dropped star title: no File`.

## Steps

1. Write `reviewer.md` and `round-1.md`.
2. Run `ark retro <run>` through the CLI process, with `ARK_HOME` set to the temporary folder.
3. Read `<run folder>/metrics.json` and note `rework.findings_dropped`, `rework.findings_sent_back` and `rework.findings_left_p0p1`.
4. Add `second.md`. Run `ark retro <run>` again and read the three values.
5. Remove the findings folder and run `ark retro <run>` again.

## Expected results

- After step 2 `rework.findings_dropped` is 2: only the two `dropped` lines under `## Run lead decision` count. The send-back line, the Evidence text, the `## Notes` line and the `round-1.md` line add nothing.
- After step 2 `rework.findings_left_p0p1` is 0 and `rework.findings_sent_back` counts only the ranked lines of `round-1.md` (none here), because a `dropped` line starts with no rank. The `- P1 ... send back` line is not a leave.
- After step 4 `rework.findings_dropped` is 4: the bold line and the starred, capitalised line count, so the total adds across files.
- After step 5 (no findings folder) the value is 0 and `ark retro` exits 0.

## Screenshot checkpoints

None. The surface is a JSON file; no screenshot applies.
