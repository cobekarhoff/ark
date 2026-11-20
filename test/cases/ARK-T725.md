---
id: ARK-T725
title: ARK-T725 a full ark test of a refactor run records and prints the pristine base duration of each suite beside the head duration, and a rerun that replays the cached census still reports it
level: integration
technique: state transition (first run, cached rerun) and equivalence classes (refactor full run, feature run, refactor quick run; slow suite, fast suite)
priority: high
risk: A refactor that makes a test file faster cannot show its saving against base (ARK-572 measured by hand), because the pristine figure is not recorded, is taken from the base run that holds the head's copied files (so it equals head), or is the wall time of the wrong run or of the wrong suite (one wall time written to every suite, a figure stored under another suite's name); or a second `ark test` of the same run (the census replays from `test-cache/`, which stores no duration) loses the figure; or the figure is written as a third side with `peak_mb` or `cpu_s` and `ark retro` counts the CPU twice; or a feature run or a quick run prints or records a figure that does not compare with its head
status: active
changed_by: 2026-11-20-ARK-598-1
---

## Objective

Prove that a full `ark test` of a `kind: refactor` run records, for each of two suites, the wall time of the pristine base run (the census, which runs the base commit's own test files) beside the wall time of the head's whole-suite run, in `test.completed` and in `results/resources.json`, and prints both on the suite's line of the summary; that each suite's figure is its own (only the suite whose head makes a test file faster shows a pristine figure above its head figure); and that a second `ark test` of the same run still reports it.

Gate answers:

1. Protects AC1: the observable record and print of the pristine duration, the only way a refactor run shows a test-time saving against base.
2. A regression that fails it: no figure; the figure measured from the copied base run (about equal to head); the cached census run drops the figure; a feature or quick run records one; a figure under the wrong suite; a `pristine` entry with `peak_mb` that `ark retro` counts.
3. ARK-T291 owns the `resources.json` head and base entries and the `cached` flag; ARK-T693 owns the other `suites[]` fields of `test.completed`; neither reads the census (the census is not recorded today). ARK-T122 and ARK-T684 run the census but read no duration.
4. No seam. The case runs the real `bun cli/ark.ts test <run>` on a real fixture refactor run and reads files and output. The durations come from real `sleep` in the fixture test file, never from a hook.

## Preconditions

- Temp `ARK_HOME`, temp project and scratch git repo, the helpers of ARK-T122 with suites that have no `base_files` (a refactor census runs the whole suite either way; the base run gets the head's files through the diff copy): a `kind: refactor` run with a `method: test` AC and two `cli` suites, each a `bun test` suite with a JUnit report in `{report}`. Suite `slow` runs `test/slow.test.ts`: at the base commit it sleeps 3 s in its one passing test; the run's own commit rewrites it to the same test with no sleep (the refactor makes the file faster). Suite `fast` runs `test/fast.test.ts`, one passing test with no sleep at base or at head. The base version of `test/slow.test.ts` (the one with the sleep) also appends one line to a marker file each time it runs; the head version writes none, so the marker holds one line for each pristine census run of `slow` and none for the head or base-with-copy runs.
- A second fixture, `kind: feature`, with the same repo and suite, and the `--quick` mode of the refactor run, as controls.
- Durations are read by pattern, never by absolute value: the case parses the numbers from the files and the output line and asserts only an order (for `slow`, pristine greater than head by at least 2 s, the sleep gap minus load slack; for `fast`, no such gap) and presence.
- No other test in the temp store, so no budget wait adds time.

## Steps

1. Run `bun cli/ark.ts test <run>` on the refactor fixture. Read the exit code, the stdout, the `test.completed` event, `results/resources.json` and the marker file.
2. Run `bun cli/ark.ts test <run>` again with no change (the head and the census are reused from the cache). Read the stdout, the new `test.completed` event, `results/resources.json` and the marker file.
3. Run `bun cli/ark.ts test <run> --quick` on the refactor fixture and `bun cli/ark.ts test <run>` on the feature fixture. Read the same three outputs for each.
4. Run `ark retro` for the refactor run and read the `resources` of `metrics.json`.

## Expected results

- Step 1: exit 0. Each suite's entry in `test.completed.suites[]` holds numeric `head_s` and `pristine_s`. Only `slow` has `pristine_s` at least 2 s greater than its `head_s`; for `fast`, `pristine_s` is less than 2 s above `head_s` (a wall time written to every suite, or a figure under the other suite's name, fails this). `results/resources.json` `suites[<name>]` of each suite holds a `pristine` entry whose wall time is numeric and agrees with that suite's own `pristine_s` within a second, and holds no `peak_mb` (the head and base entries keep theirs). The stdout line of each suite (`suite      <name> (<level>)  passed`) holds both figures, the pristine one labelled `pristine base`, next to the head one; the case reads the numbers by pattern from each line and they agree with that suite's event entry within a second. The marker file holds exactly one line (the census run of `slow`). The base side (`base      passed`) and `base_passed: true` are as before.
- Step 2: exit 0. The census is replayed from the cache: the marker file gains no line (the census of `slow` does not run again) (an event, not a wall time). The figures are still present for both suites: each `pristine_s` and printed pristine figure equals that of step 1 (the cache stores the duration of the run that made it, so the figure came from the cache entry), and `resources.json` keeps each `pristine`.
- Step 3: the quick refactor run (it has no base run) and the feature run record no `pristine_s` and no `head_s` in `test.completed.suites[]`, no `pristine` entry in `resources.json` for the feature run, and their suite lines hold no `pristine base` text and is otherwise the line of the same run before this change.
- Step 4: `ark retro` exits 0 and `metrics.json` `resources` holds no `suite <name> pristine` entry and no second CPU figure for the suite: the `pristine` key without `peak_mb` is skipped.
- At the base commit of this run no figure exists, so steps 1 and 2 fail there.

## Screenshot checkpoints

none: CLI output and files, no UI.
