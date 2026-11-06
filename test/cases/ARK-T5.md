---
id: ARK-T5
title: ARK-T5 retro reads fix and reviewer of an escaped defect
level: integration
technique: equivalence classes (entry with both new fields, entry with neither, entry of another run)
priority: high
risk: escapedDefects() maps only ticket, run and note, so fix and reviewer are dropped from escaped_defects and the escape data the deep interview and the reviewer eval need is lost
status: active
changed_by: 2026-11-06-ARK-318-1
---

## Objective

Prove that `ark retro <run>` keeps the fields `fix` and `reviewer` of an `escaped-defects.yml` entry in `escaped_defects` of `metrics.json`, next to `ticket`, `run` and `note`. Serves ARK-318/AC5.

Expected: When an escaped-defects.yml entry has fix and reviewer, the system shall keep both in escaped_defects.

## Preconditions

- A temporary `ARK_HOME` with a project and a closed run, the same fixture as the other `test/retro.test.ts` cases.
- `$ARK_HOME/projects/<project>/escaped-defects.yml` holds three entries:
  1. `ticket: ARK-213`, `run: <the run under test>`, `note: Failed LaunchAgent update deletes the working configuration`, `fix: 6e4bd35`, `reviewer: downgraded`.
  2. An entry of the same run with `ticket`, `run` and `note` only (no `fix`, no `reviewer`), to show an old-format entry still loads.
  3. An entry whose `run` is a different run, with `fix` and `reviewer` set.

## Steps

1. Write the three entries to `escaped-defects.yml`.
2. Run `ark retro <run>` through the CLI process, with `ARK_HOME` set to the temporary folder.
3. Read `<run folder>/metrics.json`.

## Expected results

- `escaped_defects` holds the entry of step 1 with all five fields. `fix` is `6e4bd35` and `reviewer` is `downgraded`, both as written.
- The old-format entry is kept with its `ticket`, `run` and `note`. It has no `fix` or `reviewer` value invented for it, and `ark retro` exits 0.
- The entry of the other run is not in `escaped_defects`.
- `reviewer` values `caught`, `missed` and `downgraded` are kept as written.

## Screenshot checkpoints

None. The surface is a JSON file; no screenshot applies.
