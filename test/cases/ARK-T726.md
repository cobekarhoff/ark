---
id: ARK-T726
title: ARK-T726 a pristine suite that fails records no figure and never changes base_passed or the exit code of a refactor run, and the base run still holds the head's copy of an added test file
level: integration
technique: decision table (pristine suite fails x base run passes) and state transition (census, then copy of head's tests; first run, rerun)
priority: high
risk: A failing census (a pristine suite red while the base run with the head's copy is green) fails `ark test`, flips `base_passed` or changes the exit code, though the figure is data only; or a failed census records the duration of a partial run as a figure, or stores it in the cache so a rerun prints one; or the pristine measure moves the copy of the head's test files before the census, so the census times the head's files
status: active
changed_by: 2026-11-20-ARK-598-1
---

## Objective

Prove that a pristine suite that fails (while the base run, which holds the head's copy of an added test file, passes) records no figure and leaves `base_passed`, the base line and the exit code as they are without the measure, on the first run and on a rerun.

Gate answers:

1. Protects AC2: the rule that the pristine timing is data, never a gate, in the one state where the census and the base run disagree.
2. A regression that fails it: a failing census failing the run or recording a figure; `base_passed` read from the census instead of the base run; the census run after the copy.
3. ARK-T122 owns the whole-suite file selection of a refactor base run, the copy of an added test file onto base and the `base_passed` gate with a failing case; ARK-T12 owns the red base run (exit 1, `base failed`, with its red census). Neither has a pristine suite that fails while the base run passes. ARK-T725 owns the passing figure, not this state.
4. No seam. A real `bun cli/ark.ts test <run>` on a fixture run whose pristine suite really fails (a base test file that exits red when the added file is absent) and whose added file writes a marker.

## Preconditions

- Temp `ARK_HOME`, temp project and scratch git repo as in ARK-T725, with one suite only (`kind: refactor`, one `cli` suite with a `bun test` command and no `base_files`, a `method: test` AC). The base commit holds `test/old.test.ts`. The run's own commit adds `test/added.test.ts`, which writes the name `added` and its working folder to a marker file when it runs and passes.
- The fixture: `test/old.test.ts` at base fails only when the `added` test file is absent from the checkout (the pristine checkout), and passes when the added file is present (so the census is red and the copied base run is green); the run's own commit leaves `old.test.ts` unchanged.
- Durations are read by pattern; the case asserts presence, absence and `base_passed`, never an absolute time.

## Steps

1. Run `bun cli/ark.ts test <run>`. Read the marker file, the stdout, the exit code, `test.completed` and `results/resources.json`.
2. Run `bun cli/ark.ts test <run>` a second time with no change and read the same outputs.

## Expected results

- Step 1: the marker holds a line for `added` whose working folder is the base checkout, once (the base run ran the head's copy; the census did not have the file). Exit 0, `base_passed: true` and the base line `base      passed`, though the pristine suite failed. The suite's entry in `test.completed.suites[]` has no `pristine_s` key (the key is omitted, not `null` and not `0`), `resources.json` `suites[<name>]` has no `pristine` entry, and the suite line holds no `pristine base` text.
- Step 2: the outputs match step 1: exit 0, `base_passed: true`, no `pristine_s`, no `pristine` entry, no `pristine base` text. A failed census is not stored as a figure by the cache and does not fail the rerun.
- This case passes at the base commit of this run: it guards the new measure against turning a red census into a failed run or a recorded figure.

## Screenshot checkpoints

none: CLI output and files, no UI.
