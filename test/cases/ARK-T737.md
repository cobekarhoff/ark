---
id: ARK-T737
title: ARK-T737 a quick ark test runs a suite's changed_command with the worktree base in place of command and base_files, prints and records the files that ran, and a suite without one runs as before
level: integration
technique: equivalence classes of suite shape (changed_command only, changed_command with base_files, neither), boundary values of the affected set (some files, none), the cached-suite class, and the failure and missing-input classes (changed_command that crashes, worktree with no base)
priority: high
risk: a quick run still runs the whole `command` or the own-commit `base_files` selection although `changed_command` is set (the whole point of ARK-580 is lost); `{base}` stays literal or is replaced by another commit than the worktree base; the files that ran are not recorded or printed, so nobody can tell what the quick run proved; a quick run where nothing is affected prints `passed` with no tests instead of a skip line; a suite with no `changed_command` changes behavior; a reused (cached) suite prints no files; a `changed_command` that crashes with no report is printed as the `no test files are affected` skip and passes; a worktree with no `base` sends an empty or literal `{base}` to the command
status: active
changed_by: 2026-11-20-ARK-580-1
---

## Objective

Prove that `ark test <run> --quick` runs the `changed_command` of a suite, with `{base}` set to the run's worktree base commit and `{report}` set as for `command`, instead of `command` and instead of the own-commit `base_files` selection; that it records and prints the test files that ran; that a `changed_command` that crashes fails the suite, that a worktree with no `base` runs the whole `command` (never `{base}` empty or literal), and that a suite with no `changed_command` runs as today. Serves ARK-580/AC1.

Authoring gate:

1. Protects: the quick-run contract of the suite key `changed_command` (command chosen, `{base}` value, files recorded in the `test.completed` suite row and printed on the `suite` line).
2. Fails when: the quick branch of `cli/test-run.ts` ignores the key, lets `base_files` win, substitutes another commit or none, drops the files, or the skip line for an empty affected set is missing.
3. Existing proof misses it: ARK-T120, ARK-T121, ARK-T201 and ARK-T388 cover quick runs with `paths` and `base_files` only; no case has a suite key that chooses the quick command. ARK-T738 owns the full run; ARK-T739 owns the config refusals; ARK-T740 owns the bug-run readers.
4. No test-only export, flag or hook: the case runs the real `ark` process against the fixture.

## Preconditions

- Fixture of `test/test-run.test.ts` (`buildingRun`, real `ark` process, a git repo whose worktree has a `base` commit).
- Each suite has its own markers and its own `base-seen` file, named by the suite (`<suite>-changed-ran`, `<suite>-full-ran`, `<suite>-base-seen`), so one suite never hides the result of another. `changed_command` stubs are scripts that write their first argument (the `{base}` value) to `<suite>-base-seen` and write a JUnit report to `{report}` with a `file` on each test case.
- Suite `unit` (parser `bun`): `command` writes `unit-full-ran` and runs `./a.test.ts` and `./b.test.ts`; `changed_command` writes `unit-changed-ran` and chooses `a.test.ts` only. `base_files` and `base_command` are not set.
- Suite `both`: same shape as `unit` with its own markers (`both-changed-ran`, `both-full-ran`, `both-base-seen`; chooses `a.test.ts`), and it also has `base_files: a.test.ts` and a `base_command` with `{files}` that writes `both-base-command-ran`. One own commit changes `a.test.ts`, so the old quick branch would run `base_command`.
- Suite `plain`: no `changed_command`, no `base_files`; `command` writes `plain-full-ran`.
- Suite `none`: `changed_command` writes `none-changed-ran`, prints `no test files are affected`, exits 0 and writes an empty JUnit report.
- Fixture B (real runner): one suite whose `changed_command` is `bun test --changed={base} --reporter=junit --reporter-outfile={report}` in a fake repo with `lib.ts`, `lib.test.ts` (imports `lib.ts`) and `other.test.ts` (imports nothing). One own commit changes `lib.ts`.
- Fixture C (crash): one suite whose `changed_command` writes `crash-ran`, prints an error to stderr, exits 1 and writes no report.
- Fixture D (no base): one suite with `unit`'s `command` and `changed_command` shape, in a run whose `events.ndjson` holds a `worktree.created` event that has no `base` (the fixture appends a second `worktree.created` for the same repo, with its `path` and `branch` and no `base`; the later event replaces the first in `deriveState`, `cli/events.ts:278-282`). `ark test` takes `base` from that event (`deriveState(readEvents(directory))`, `cli/test-run.ts:1149`) and never reads `state.json`, so a `state.json` edit cannot reach this path.

## Steps

1. Run `ark test <run> --quick`. Read stdout, the marker files, each `<suite>-base-seen` and the last `test.completed` of `events.ndjson`.
2. Run `ark test <run> --quick` again with no commit between (the suites are reusable).
3. Fixture B: run `ark test <run> --quick`. Read stdout and the last `test.completed`.
4. Fixture C: run `ark test <run> --quick`. Read the exit code, stdout and the last `test.completed`.
5. Fixture D: run `ark test <run> --quick`. Read the markers and `unit-base-seen`.

## Expected results

- Step 1:
  - `unit`: `unit-changed-ran` exists and `unit-full-ran` does not. `unit-base-seen` holds the run's worktree `base` commit (the 40-character sha of the `base` in the `worktree.created` event), never the literal `{base}` and never the head commit.
  - `both`: `both-changed-ran` exists and `both-base-command-ran` does not (`changed_command` wins over `base_files`); `both-base-seen` holds the same `base` sha.
  - `plain`: `plain-full-ran` exists (the whole `command` runs as today).
  - `none`: stdout has a `suite  none` line that says it was skipped with the reason `no test files are affected`, never `passed` with no tests; exit 0.
  - The suite row of `unit` in `test.completed` lists `a.test.ts` and not `b.test.ts`, and the `suite  unit` line prints the same files. `plain` records no selected files (it ran whole) and prints none.
  - `test.completed` has `mode: "quick"`.
- Step 2: the suites that reused their cached result print `reused` and the same files as in step 1 (the files are not dropped).
- Step 3: the suite runs `bun test --changed=<base>`, selects `lib.test.ts` and not `other.test.ts`, and the recorded and printed files are `lib.test.ts` only.
- Step 4: `crash-ran` exists; the exit code is non-zero; the suite row is failed (not passed); stdout never has `no test files are affected` for the suite.
- Step 5: `unit-full-ran` exists and `unit-changed-ran` does not (the whole `command` runs); `unit-base-seen` does not exist (no empty or literal `{base}` was sent); the suite is not skipped.
- This case does not assert the call shape of the shell, only the markers, the `{base}` value, the files, the exit code and the skip line.

## Screenshot checkpoints

none: CLI and event-log case; no UI surface.
