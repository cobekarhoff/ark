---
id: ARK-T726
title: ARK-T726 the base run of a refactor run still holds the head's copy of an added test file, and a failing or missing pristine suite records no figure and never changes base_passed or the exit code
level: integration
technique: decision table (pristine suite: passes, fails, has no census) x (base run result: passes) and state transition (census, then copy of head's tests)
priority: high
risk: The pristine measure replaces the copy of the head's test files onto base (cli/test-run.ts:732-733), so a refactor's added test no longer proves the behavior is kept at base, or the census runs after the copy and times the head's files; or a failing census (a pristine suite red, or a throw in recording) fails `ark test`, flips `base_passed` or changes the exit code, though the figure is data only; or a failed census records the duration of a partial run as a figure; or a suite with no census prints a stale or zero figure
status: active
changed_by: 2026-11-20-ARK-598-1
---

## Objective

Prove that with the pristine measure the base run of a refactor run still runs the head's copy of an added test file (the file the run's own commit adds, which the base commit does not hold), and that a pristine suite that fails records no figure and leaves `base_passed`, the base line and the exit code as they are without the measure.

Gate answers:

1. Protects AC2: the behavior-kept proof at base (the copy) and the rule that the pristine timing is data, never a gate.
2. A regression that fails it: the copy removed or reordered so the added file is absent at base; a failing census failing the run or recording a figure; `base_passed` read from the census instead of the base run.
3. ARK-T122 owns the whole-suite file selection of a refactor base run and the `base_passed` gate with a failing case; ARK-T12 owns the refusal. Neither has a pristine suite that fails while the base run passes, and no case pins the copy together with the census order and a figure. ARK-T725 owns the passing figure, not these cases.
4. No seam. A real `bun cli/ark.ts test <run>` on a fixture run whose pristine suite really fails (a base test file that exits red) and whose added file writes a marker.

## Preconditions

- Temp `ARK_HOME`, temp project and scratch git repo of ARK-T725 (`kind: refactor`, one `cli` suite with a `bun test` command and no `base_files`, a `method: test` AC). The base commit holds `test/old.test.ts`. The run's own commit adds `test/added.test.ts`, which writes the name `added` and its working folder to a marker file when it runs and passes.
- Fixture A: `test/old.test.ts` passes at base and at head.
- Fixture B: `test/old.test.ts` at base fails only when the `added` test file is absent from the checkout (the pristine checkout), and passes when the added file is present (so the census is red and the copied base run is green); the run's own commit leaves `old.test.ts` unchanged.
- Fixture C: a suite whose census is missing (skipped for the run, as a path-skipped suite or a base with no suite command), so there is no pristine figure.
- Durations are read by pattern; the case asserts presence, absence and `base_passed`, never an absolute time.

## Steps

1. On fixture A run `bun cli/ark.ts test <run>`. Read the marker file, the stdout, the exit code and `test.completed`.
2. On fixture B run `bun cli/ark.ts test <run>`. Read the marker file, the stdout, the exit code, `test.completed` and `results/resources.json`. Run `ark test` a second time and read the same outputs.
3. On fixture C run `bun cli/ark.ts test <run>` and read the same outputs.
4. Control: on a copy of fixture B whose `old.test.ts` also fails at base with the added file present, run `ark test` and read `base_passed`, the base line and the exit code.

## Expected results

- Step 1: the marker file holds a line for `added` whose working folder is the base checkout (the head's copy of the added file ran at base, after the census on the pristine files, which has no `added` line); exit 0 and `base_passed: true`; the suite entry holds the pristine figure of ARK-T725.
- Step 2: the marker shows `added` ran at base once for the base run and not in the census run. Exit 0, `base_passed: true` and the base line `base      passed`, though the pristine suite failed. The suite's entry in `test.completed.suites[]` has no `pristine_s` key (the key is omitted, not `null` and not `0`), `resources.json` `suites[<name>]` has no `pristine` entry, and the suite line holds no `pristine base` text. The second run's outputs match: a failed census is not stored as a figure by the cache and does not fail the rerun.
- Step 3: exit code, `base_passed` and the base line are those of the same fixture without a census; the suite has no `pristine_s` and no `pristine` entry; the output prints no figure and no error text about the pristine measure.
- Step 4: exit 1, `base_passed: false` and the line `base      failed`, as before the measure: the base run alone decides `base_passed`.
- The copy of the head's test files onto base stays: at the base commit of this run steps 1 and 2 pass their marker assertion, so the case's red part is the missing-figure and `base_passed` assertions.

## Screenshot checkpoints

none: CLI output and files, no UI.
