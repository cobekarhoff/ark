---
id: ARK-T6
title: ARK-T6 retro counts left P0 and P1 findings
level: integration
technique: equivalence classes and boundary values (rank P0/P1 against P2, leave against send back, inside against outside the Run lead decision section)
priority: high
risk: findings_left_p0p1 counts a P2 that was left, a P0 that was sent back, or a ranked line outside the "## Run lead decision" section, so the escape signal drifts from the real number of left P0 and P1 findings
status: active
changed_by: 2026-11-06-ARK-318-1
---

## Objective

Prove that `ark retro <run>` writes `rework.findings_left_p0p1` in `metrics.json` as the number of P0 and P1 lines in a `## Run lead decision` section that are marked `leave`. Serves ARK-318/AC6.

Expected: When a Run lead decision section leaves one P1, sends back one P0 and leaves one P2, the system shall write findings_left_p0p1 as 1.

## Preconditions

- A temporary `ARK_HOME` with a closed run, the same fixture as the other `test/retro.test.ts` cases.
- `<run folder>/findings/` holds one findings file. Above the decision section it lists the findings as `### P1: ...`, `### P0: ...` and `### P2: ...` headings. Those lines are outside the decision section and are never counted.
- The file has a `## Run lead decision` section with three list lines:
  - `- P1 <title>: leave. <reason>`
  - `- P0 <title>: send back.`
  - `- P2 <title>: leave. <reason>`
- A second line shape, to pin the pinned format rule: `- **P1 <title>: leave.**` (bold) in a second findings file, and a line `- P0 <title>: send back. A leave would hide the data loss.` in which `leave` appears after `send back`.

## Steps

1. Write the findings file with the three-line decision section.
2. Run `ark retro <run>` through the CLI process, with `ARK_HOME` set to the temporary folder.
3. Read `<run folder>/metrics.json` and note `rework.findings_left_p0p1`.
4. Add the second findings file (the bold P1 `leave` line and the P0 line that says `send back` before `leave`). Run `ark retro <run>` again and read the value.
5. Remove the findings folder and run `ark retro <run>` again.

## Expected results

- After step 2 `rework.findings_left_p0p1` is 1: only the P1 line marked `leave` counts. The P0 marked `send back` and the P2 marked `leave` do not.
- After step 4 the value is 2: the bold `leave` P1 line counts. The P0 line counts for nothing, because the first of `leave` and `send back` in the line is `send back`.
- The ranked `###` headings above the section add nothing to the count.
- After step 5 (no findings folder) the value is 0 and `ark retro` exits 0.
- `rework.findings_sent_back` keeps its earlier meaning: it still counts only ranked lines of `round-<n>.md` files, and it is not changed by this case.

## Screenshot checkpoints

None. The surface is a JSON file; no screenshot applies.
