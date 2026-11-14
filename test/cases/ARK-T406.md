---
id: ARK-T406
title: ARK-T406 retro counts the rule lines of rules.md into rework.rules_added
level: integration
technique: equivalence classes (rule list line, heading, prose line, blank line) and boundary values (two rules, no rules file)
priority: high
risk: rules_added counts every line of rules.md (heading, prose, blank lines), reads the wrong file, or throws when rules.md is missing, so the number of in-run rules that the retro reports and proposes for learnings.md is wrong or ark retro fails on every run without a repeated finding
status: active
changed_by: 2026-11-14-ARK-392-1
---

## Objective

Prove that `ark retro <run>` writes `rework.rules_added` in `metrics.json` as the number of rule list lines in `<run folder>/rules.md`, and 0 when the file is missing. Serves ARK-392/AC4.

Expected: When rules.md holds two rule lines, the system shall write rules_added as 2.

## Preconditions

- A temporary `ARK_HOME` with a project and a closed run, the same fixture as the other `test/retro.test.ts` cases.
- `<run folder>/rules.md` holds:
  - a heading line `# Rules`;
  - a prose line `Written by the run lead when a finding repeats.` (no list marker);
  - two rule list lines in the form `- <rule> (<finding title 1>; <finding title 2>; <ISO time>)`, for example `- Check the unit on every export path (export drops the unit; csv export drops the unit; 2026-11-14T10:00:00Z)` and `- Never read ARK_HOME at import time (config read at import; path read at import; 2026-11-14T11:00:00Z)`;
  - a blank line between the prose line and the first rule line.

## Steps

1. Write `rules.md`.
2. Run `ark retro <run>` through the CLI process, with `ARK_HOME` set to the temporary folder.
3. Read `<run folder>/metrics.json` and note `rework.rules_added`.
4. Remove `rules.md`. Run `ark retro <run>` again and read `rework.rules_added`.

## Expected results

- After step 2 `rework.rules_added` is 2: only the two rule list lines count. The heading, the prose line and the blank line add nothing.
- After step 2 the other `rework` fields are unchanged by the file (`findings_dropped`, `findings_sent_back` and `merge_steps` do not count rules.md lines).
- After step 4 (no rules.md) `rework.rules_added` is 0 and `ark retro` exits 0.

## Screenshot checkpoints

None. The surface is a JSON file; no screenshot applies.
