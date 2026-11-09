---
id: ARK-T154
title: ARK-T154 bun test refuses a real orca, gh, glab, omp, plannotator, launchctl or portless and a test's own fake still wins
level: integration
technique: equivalence classes (refused tool, faked tool)
priority: high
risk: A test reaches the live Orca, GitHub or launchd and its result depends on the host, or the refusing shim hides a test's own fake and breaks it
status: active
changed_by: 2026-11-09-ARK-390-1
---

## Objective

Prove the `bun test` preload puts refusing shims first on `PATH`, and that a test which installs its own fake tool gets its fake.

Expected: A call to a real tool fails with a message that names the tool; a call to a tool the test faked runs the fake.

## Preconditions

- A temp folder with a throwaway test file and `bunfig.toml` that loads the repo preload `test/tmpdir-preload.ts`; the file is run by the real `bun test`.
- The throwaway test has one test per tool in the seven (spawn by bare name) and one test that writes a fake `orca` script into its own folder, puts that folder first on `PATH`, and spawns `orca`.
- Owned downstream sentinel executables for all seven names (`orca`, `gh`, `glab`, `omp`, `plannotator`, `launchctl`, `portless`) sit in a folder the case puts on the `PATH` that the child `bun test` process inherits, behind the preload shims. Each sentinel appends its name to a sentinel log and exits 0. Nothing on the host PATH is reachable by name.

## Steps

1. Run `bun test` on the throwaway file.
2. Read the per-tool result of the refused calls: exit code and message.
3. Read the result of the faked call.
4. Read the sentinel log.

## Expected results

- Each of the seven refused calls exits non-zero and its message contains the name of that tool (`orca`, `gh`, `glab`, `omp`, `plannotator`, `launchctl`, `portless`); the sentinel log is empty after the seven refused calls: no downstream executable ran, so a real tool's own failure cannot satisfy the case.
- The faked `orca` call exits 0 and prints the fake's output.
- The faked `orca` call does not write to the sentinel log either.
- A tool outside the seven (for example `git`) still runs.

## Screenshot checkpoints

None. The surface is CLI output; no screenshot applies.
