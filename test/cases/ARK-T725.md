---
id: ARK-T725
title: ARK-T725 a full ark test of a refactor run records and prints the pristine base duration of each suite beside the head duration, and a rerun that replays the cached census still reports it
level: integration
technique: state transition (first run, cached rerun) and equivalence classes (refactor full run, feature run, refactor quick run)
priority: high
risk: A refactor that makes a test file faster cannot show its saving against base (ARK-572 measured by hand), because the pristine figure is not recorded, is taken from the base run that holds the head's copied files (so it equals head), or is the wall time of the wrong run; or a second `ark test` of the same run (the census replays from `test-cache/`, which stores no duration) loses the figure; or the figure is written as a third side with `peak_mb` or `cpu_s` and `ark retro` counts the CPU twice; or a feature run or a quick run prints or records a figure that does not compare with its head
status: active
changed_by: 2026-11-20-ARK-598-1
---

## Objective

Prove that a full `ark test` of a `kind: refactor` run records, for each suite, the wall time of the pristine base run (the census, which runs the base commit's own test files) beside the wall time of the head's whole-suite run, in `test.completed` and in `results/resources.json`, and prints both on the suite's line of the summary; that the pristine figure is greater than the head figure when the head makes a test file faster; and that a second `ark test` of the same run still reports it.

Gate answers:

1. Protects AC1: the observable record and print of the pristine duration, the only way a refactor run shows a test-time saving against base.
2. A regression that fails it: no figure; the figure measured from the copied base run (about equal to head); the cached census run drops the figure; a feature or quick run records one; a `pristine` entry with `peak_mb` that `ark retro` counts.
3. ARK-T291 owns the `resources.json` head and base entries and the `cached` flag; ARK-T693 owns the other `suites[]` fields of `test.completed`; neither reads the census (the census is not recorded today). ARK-T122 and ARK-T684 run the census but read no duration.
4. No seam. The case runs the real `bun cli/ark.ts test <run>` on a real fixture refactor run and reads files and output. The durations come from real `sleep` in the fixture test file, never from a hook.

## Preconditions

- Temp `ARK_HOME`, temp project and scratch git repo, the fixture of ARK-T122: a `kind: refactor` run with a `method: test` AC, one `cli` suite with a `command` that runs `test/slow.test.ts` (a `bun test` suite with a JUnit report in `{report}`), no `base_files`, so the census runs the whole suite on the pristine base. A base commit holds `test/slow.test.ts` that sleeps 3 s in its one passing test; the run's own commit rewrites it to the same test with no sleep (the refactor makes the file faster).
- A second fixture, `kind: feature`, with the same repo and suite, and the `--quick` mode of the refactor run, as controls.
- Durations are read by pattern, never by absolute value: the case parses the numbers from the files and the output line and asserts only an order (pristine greater than head by at least 2 s, the sleep gap minus load slack) and presence.
- No other test in the temp store, so no budget wait adds time.

## Steps

1. Run `bun cli/ark.ts test <run>` on the refactor fixture. Read the exit code, the stdout, the `test.completed` event and `results/resources.json`.
2. Run `bun cli/ark.ts test <run>` again with no change (the head and the census are reused from the cache). Read the stdout, the new `test.completed` event and `results/resources.json`.
3. Run `bun cli/ark.ts test <run> --quick` on the refactor fixture and `bun cli/ark.ts test <run>` on the feature fixture. Read the same three outputs for each.
4. Run `ark retro` for the refactor run and read the `resources` of `metrics.json`.

## Expected results

- Step 1: exit 0. The suite's entry in `test.completed.suites[]` holds numeric `head_s` and `pristine_s`, and `pristine_s` is at least 2 s greater than `head_s`. `results/resources.json` `suites[<name>]` holds a `pristine` entry whose wall time is numeric and agrees with `pristine_s` within a second, and it holds no `peak_mb` (the head and base entries keep theirs). The stdout line of the suite (`suite      <name> (<level>)  passed`) holds both figures, the pristine one labelled `pristine base`, next to the head one; the case reads the numbers by pattern from the line and they agree with the event within a second. The base side (`base      passed`) and `base_passed: true` are as before.
- Step 2: exit 0. The census is replayed from the cache (no `sleep` runs again: the rerun takes much less than the 3 s of the base file), and the figures are still present: `pristine_s` and the printed pristine figure equal those of step 1 (the cache stores the duration of the run that made it), and `resources.json` keeps `pristine`.
- Step 3: the quick refactor run (it has no base run) and the feature run record no `pristine_s` and no `head_s` in `test.completed.suites[]`, no `pristine` entry in `resources.json` for the feature run, and their suite line holds no `pristine base` text and is otherwise the line of the same run before this change.
- Step 4: `ark retro` exits 0 and `metrics.json` `resources` holds no `suite <name> pristine` entry and no second CPU figure for the suite: the `pristine` key without `peak_mb` is skipped.
- At the base commit of this run no figure exists, so steps 1 and 2 fail there.

## Screenshot checkpoints

none: CLI output and files, no UI.
