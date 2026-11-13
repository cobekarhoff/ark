---
id: ARK-T331
title: "ARK-T331 `ark chief state` lists each red on main file with its run id, once per file, from the run's last full test, and says unavailable when the source fails"
level: integration
technique: state transition (last full test replaces earlier ones) with boundaries on quick runs, no red on main, and source failure
priority: medium
risk: Master Chief cannot see red on main files and writes no bug ticket; or a file stays listed after the run's last test no longer records it, appears twice, or a quick run erases it; or a failed read prints an empty section that reads as `nothing is red`
status: active
changed_by: 2026-11-13-ARK-428-1
---

## Objective

Prove that `ark chief state` shows the red on main files of each run exactly as the run's last full test recorded them.

## Preconditions

- Temporary `ARK_HOME` with three runs: run A whose last full `test.completed` records `red.test` and `other.test` red on main (two earlier full tests also recorded `red.test`), run B with no red on main file, and run C whose earlier test recorded `red.test` and whose last full test records nothing.
- Run A also has a later quick `test.completed` with no red-on-main field.

## Steps

1. Run `ark chief state`. Read the red on main section.
2. Make the events of run A unreadable (source failure) and run `ark chief state` again.

## Expected results

- Step 1: the section holds one row per file with the run id: `<run A> red.test`, `<run A> other.test`, each once; no row for run B or run C; the quick run does not remove A's rows. A state with no red on main file anywhere prints `none` or no section, in the form of the other sections of `test/chief.test.ts`.
- Step 2: the section reads `unavailable`, not an empty list. The Config concurrency line counts the unreadable run (`N open, 1 unreadable: <run A>`) and the Run leads section holds a note for it.

## Screenshot checkpoints

none: integration case on CLI output; no UI surface.
