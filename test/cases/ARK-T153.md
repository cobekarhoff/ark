---
id: ARK-T153
title: ARK-T153 each suite of one ark test runs with its own TMPDIR that is gone when the suite ends
level: integration
technique: equivalence classes (four suite runs, one caller TMPDIR)
priority: high
risk: Suites share the caller's TMPDIR (or one another's), so the Playwright transform-cache delete of one run hits another, and folders leak after the run
status: active
changed_by: 2026-11-09-ARK-390-1
---

## Objective

Prove `ark test` gives every suite run, at head and at base, a private `TMPDIR` and deletes it at the end.

Expected: The four suite runs of one `ark test` see four different `TMPDIR` values, all different from the caller's, and none of the folders exists afterwards.

## Preconditions

- Temp project and temp `ARK_HOME` with a feature run that has a base and a head worktree and two suites (cli and playwright) whose commands are a script that appends `$TMPDIR` to a record file outside the suite folders and writes a marker file into `$TMPDIR`.
- A caller `TMPDIR` set to a known empty folder.

## Steps

1. Run the real `ark test <run>` (full mode) with the caller `TMPDIR` set.
2. Read the record file: the four `TMPDIR` values (cli head, playwright head, cli base, playwright base).
3. List the caller `TMPDIR` and check each recorded path.

## Expected results

- `ark test` exits 0 and the record file has four lines.
- The four values differ from each other and from the caller `TMPDIR`.
- Each marker file was written in its own folder while the suite ran.
- No recorded folder exists after `ark test` ends, and the caller `TMPDIR` holds no new entry.
- A suite that fails still has its folder deleted (repeat with one suite exiting 1; the folder is gone).

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
