---
id: ARK-T737
title: ARK-T737 a quick ark test runs a suite's changed_command with the worktree base in place of command and base_files, prints and records the files that ran, and a suite without one runs as before
level: integration
technique: equivalence classes of suite shape (changed_command only, changed_command with base_files, base_files only, neither) and boundary values of the affected set (some files, none), plus the cached-suite class
priority: high
risk: a quick run still runs the whole `command` or the own-commit `base_files` selection although `changed_command` is set (the whole point of ARK-580 is lost); `{base}` stays literal or is replaced by another commit than the worktree base; the files that ran are not recorded or printed, so nobody can tell what the quick run proved; a quick run where nothing is affected prints `passed` with no tests instead of a skip line; a suite with no `changed_command` changes behavior; a reused (cached) suite prints no files
status: active
changed_by: 2026-11-20-ARK-580-1
---

## Objective

Prove that `ark test <run> --quick` runs the `changed_command` of a suite, with `{base}` set to the run's worktree base commit and `{report}` set as for `command`, instead of `command` and instead of the own-commit `base_files` selection; that it records and prints the test files that ran; and that a suite with no `changed_command` runs as today. Serves ARK-580/AC1.

Authoring gate:

1. Protects: the quick-run contract of the suite key `changed_command` (command chosen, `{base}` value, files recorded in the `test.completed` suite row and printed on the `suite` line).
2. Fails when: the quick branch of `cli/test-run.ts` ignores the key, lets `base_files` win, substitutes another commit or none, drops the files, or the skip line for an empty affected set is missing.
3. Existing proof misses it: ARK-T120, ARK-T121, ARK-T201 and ARK-T388 cover quick runs with `paths` and `base_files` only; no case has a suite key that chooses the quick command. ARK-T738 owns the full run; ARK-T739 owns the config refusals; ARK-T740 owns the bug-run readers.
4. No test-only export, flag or hook: the case runs the real `ark` process against the fixture.

## Preconditions

- Fixture of `test/test-run.test.ts` (`buildingRun`, real `ark` process, a git repo whose worktree has a `base` commit).
- Suite `unit` (parser `bun`): `command` writes the marker `full-ran` and runs `./a.test.ts` and `./b.test.ts`; `changed_command` is a stub script that writes the marker `changed-ran`, writes its first argument (the `{base}` value) to the file `base-seen`, and writes a JUnit report with a `file` on each test case for the files it chooses (`a.test.ts` only). `base_files` and `base_command` are not set.
- Suite `both`: same as `unit`, and it also has `base_files: a.test.ts` and `base_command` with `{files}` that writes the marker `base-command-ran`. One own commit changes `a.test.ts`, so the old quick branch would run `base_command`.
- Suite `plain`: no `changed_command`, no `base_files`; `command` writes the marker `plain-full-ran`.
- Suite `none`: `changed_command` selects no test and prints `no test files are affected`, exits 0 and writes an empty JUnit report.
- Fixture B (real runner): one suite whose `changed_command` is `bun test --changed={base} --reporter=junit --reporter-outfile={report}` in a fake repo with `lib.ts`, `lib.test.ts` (imports `lib.ts`) and `other.test.ts` (imports nothing). One own commit changes `lib.ts`.

## Steps

1. Run `ark test <run> --quick`. Read stdout, the marker files, `base-seen` and the last `test.completed` of `events.ndjson`.
2. Run `ark test <run> --quick` again with no commit between (the suites are reusable).
3. Fixture B: run `ark test <run> --quick`. Read stdout and the last `test.completed`.

## Expected results

- Step 1:
  - `unit`: `changed-ran` exists and `full-ran` does not. `base-seen` holds the run's worktree `base` commit (the 40-character sha in `state.json`), never the literal `{base}` and never the head commit.
  - `both`: `changed-ran` exists and `base-command-ran` does not (`changed_command` wins over `base_files`).
  - `plain`: `plain-full-ran` exists (the whole `command` runs as today).
  - `none`: stdout has a `suite  none` line that says it was skipped with the reason `no test files are affected`, never `passed` with no tests; exit 0.
  - The suite row of `unit` in `test.completed` lists `a.test.ts` and not `b.test.ts`, and the `suite  unit` line prints the same files. `plain` records no selected files (it ran whole) and prints none.
  - `test.completed` has `mode: "quick"`.
- Step 2: the suites that reused their cached result print the same files as in step 1 (`reused` is printed and the files are not dropped).
- Step 3: the suite runs `bun test --changed=<base>`, selects `lib.test.ts` and not `other.test.ts`, and the recorded and printed files are `lib.test.ts` only.
- This case does not assert the call shape of the shell, only the markers, the `{base}` value, the files and the skip line.

## Screenshot checkpoints

none: CLI and event-log case; no UI surface.
