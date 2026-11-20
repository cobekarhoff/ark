---
id: ARK-T738
title: ARK-T738 a full ark test never runs a changed_command, with or without --keep-going, and a last quick run is still refused at MR open
level: integration
technique: equivalence classes of run mode (full, full with --keep-going, quick) over a suite that sets changed_command, and a state transition (quick run, then MR open)
priority: high
risk: a full run, the run that gates the MR, runs `changed_command` of a suite (or only some suites, or only under `--keep-going`), so a change reaches an MR on affected tests alone; or the new key makes `ark merge-request open` accept a last run of mode quick
status: active
changed_by: 2026-11-20-ARK-580-1
---

## Objective

Prove that a full `ark test <run>` runs the whole `command` of every suite and never `changed_command`, also with `--keep-going`, and that a last quick run, whose suites ran `changed_command`, does not open the MR while the last full run does. Serves ARK-580/AC2.

Authoring gate:

1. Protects: the invariant of ARK-580 that the MR gate runs the full command of every suite, and that no new mode lets an affected-only run reach the MR.
2. Fails when: the head loop or `runSuite` of `cli/test-run.ts` picks `changed_command` outside `quick`, or the mode written to `test.completed` for a quick run with `changed_command` is not `quick`, so the refusal `mode === "quick"` of `cli/merge-request.ts` no longer fires.
3. Existing proof misses it: ARK-T121 proves the refusal for a quick run that selected files by `base_files`; no case has a suite with `changed_command`. One contract, one owner: this case owns the full run with the key, ARK-T121 stays the owner of the refusal of a last quick run, and this case only adds the step with the new key, not a second copy of its assertions about the refusal text.
4. No test-only export, flag or hook: the case runs the real `ark` process against the fixture.

## Preconditions

- Fixture of `test/test-run.test.ts` (`buildingRun`, real `ark` process), two suites `unit` and `e2e`, each with a `command` that writes its own marker (`unit-full`, `e2e-full`) and a `changed_command` that writes another marker (`unit-changed`, `e2e-changed`) and exits 0. One suite also has `base_files` and `base_command`, so the case holds one suite of each shape.
- One check that passes, and a second fixture where one check fails (to reach `--keep-going`).
- The setup of ARK-T121 for `ark merge-request open` (a fake remote, as that case uses).

## Steps

The suites are reused when the heads and the mode are the same (the cache key has no `--keep-going`). So before each run that must start the suites, make a new commit in the worktree and delete the markers.

1. Run `ark test <run>` (full). Read the markers and the last `test.completed`.
2. Make a new commit, delete the markers, and run `ark test <run> --keep-going`. Read the markers.
3. On the second fixture (one failed check, fresh run), run `ark test <run> --keep-going` and read the markers.
4. On the first fixture: make a new commit, delete the markers, run `ark test <run> --quick`, then `ark merge-request open <run>`. Read the markers, the exit code and stderr.
5. Make a new commit, delete the markers, run `ark test <run>` (full), then `ark merge-request open <run>`. Read the markers.

## Expected results

- Steps 1, 2 and 3: `unit-full` and `e2e-full` exist after the run; `unit-changed` and `e2e-changed` never exist. `test.completed` has `mode: "full"`.
- Step 4: the quick run wrote `unit-changed` and not `unit-full`; `test.completed` has `mode: "quick"`; `ark merge-request open` exits non-zero and refuses the last run because it was quick (the same refusal text as ARK-T121; this case asserts the refusal, not a new wording).
- Step 5: `unit-full` and `e2e-full` exist and `unit-changed` does not; the MR opens (exit 0), so the full run, which ran `command` only, is the one the gate accepts.
- The case does not assert which commit the quick run used for `{base}` (ARK-T737 owns it).

## Screenshot checkpoints

none: CLI and event-log case; no UI surface.
