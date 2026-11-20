---
id: ARK-T30
title: "ARK-T30 the every-file timeout check of ARK-T31 refuses a git-heavy test with a short, missing or unresolved timeout and passes one with a limit"
level: integration
technique: "boundary values (10 s and a named constant below 30 s against the 30 s minimum) and equivalence classes (each helper call, a number against a named constant, a test with its own limit against one that borrows the limit of a later test in its chunk)"
priority: medium
risk: "the ARK-T31 check misses a git-heavy test: one built through generatedScenario(, submoduleRun( or openRun( with no timeout, one with a named constant below 30 seconds, or one whose named constant does not resolve passes unseen; a test with no limit that sits before a loop-declared test with a limit reads that limit and passes, or a git-heavy test declared inside a `for` loop is never split out; or the check flags a test that only has a helper definition in its chunk, so main goes red"
status: active
changed_by: 2026-11-20-ARK-600-1
---

## Objective

Prove that the owning every-file check ARK-T31, which runs by default, runs without `ARK_LOAD_PROOF`, refuses each git-heavy test that has no timeout or one below 30 seconds, and passes when every such test carries its own limit. Serves ARK-326/AC2, ARK-319/AC4 and ARK-600/AC1.

Expected: If a test that starts a run or builds a scenario through `startRun(`, `scenario(`, `generatedScenario(`, `submoduleRun(` or `openRun(` has no timeout, a timeout below 30 seconds, or a named constant that is below 30 seconds or that the file does not define, then the check shall report that test; if every such test has a limit of at least 30 seconds, then the check shall pass.

## Preconditions

- A checkout with `bun` installed.
- A temporary repository folder holds a copy of `test/timeouts.test.ts` whose file list for the guard is replaced by `["test/fixture.test.ts"]`.
- The same folder holds `test/fixture.test.ts`, written once for each of these fixtures (one child run for each):
  1. Refused, limit below the minimum: a test that calls `startRun(` with `{ timeout: 10_000 }`, and a test that calls `scenario(` with `{ timeout: 30_000 }` (the boundary).
  2. Refused, no limit: a test that calls `generatedScenario(` with no `{ timeout }`, one that calls `submoduleRun(` with none, and one that calls `openRun(` with none.
  3. Refused, constant below the minimum: `const SHORT = 10_000;` and a test that calls `generatedScenario(` with `{ timeout: SHORT }`.
  4. Refused, unresolved name: a test that calls `submoduleRun(` with `{ timeout: MISSING }` and no `const MISSING` in the file.
  5. Passes: `const LONG = 120_000;`, a test that calls `generatedScenario(` with `{ timeout: LONG }`, one that calls `submoduleRun(` with `{ timeout: 30_000 }`, one that calls `openRun(` with `{ timeout: 120_000 }`, and a test with no helper call and no limit followed by a function `testedRun()` whose body calls `scenario(` (a helper definition between tests).
  6. Refused, borrowed limit and loop-declared test: a top-level test `alpha borrows a later limit` that calls `generatedScenario(` with no `{ timeout }`, followed by `for (const n of [1]) { test("gamma loop with a limit", () => { scenario(); }, { timeout: 30_000 }); }`, then a second loop `for (const n of [1]) { test("beta loop without a limit", () => { openRun(); }); }`.

## Steps

1. Run `bun test test/timeouts.test.ts -t "^ARK-T31 "` in the repository in a child process with `ARK_LOAD_PROOF` removed. Read the exit code and the counts. The pattern is anchored: the title of this case also contains "ARK-T31", and an unanchored `-t ARK-T31` selects both tests (`2 pass`).
2. For each fixture 1 to 6, write `test/fixture.test.ts` and run `bun test test/timeouts.test.ts -t "^ARK-T31 "` in the temporary folder in a child process with `ARK_LOAD_PROOF` removed. Read the exit code and the output.

## Expected results

- Step 1: exit code 0, `1 pass`, no non-zero `skip` count: the owning check runs by default and passes on the real files.
- Fixture 1: a non-zero exit code. The output reports the 10 second test with `"timeout": 10000` and does not name the 30 second test.
- Fixture 2: a non-zero exit code. The output names each of the three tests, so each helper call is read as git-heavy.
- Fixture 3: a non-zero exit code. The output names the test and its limit 10000 (the constant is resolved, not read as 0 or skipped).
- Fixture 4: a non-zero exit code. The output names the test: an unresolved name fails the guard, it never passes it.
- Fixture 5: exit code 0, `1 pass`. A named constant of 120 s and a number of exactly 30 s pass; the pure test with a helper definition after it is not flagged.
- Fixture 6: a non-zero exit code. The output names `alpha borrows a later limit` (its own limit is missing, it never borrows the 30 s of the loop test after it) and `beta loop without a limit` (a loop-declared test is split out), and does not name `gamma loop with a limit`. The last test of fixture 2 is the last test of its file; its being named shows that a final chunk is read.
- Negative controls: each change below is made in a copy of the check and run against the fixtures. A fixture can still exit non-zero after the change. In two cases the only cause is the guard's "at least one git-heavy test per file" check: fixture 3 with `generatedScenario(` deleted and fixture 4 with `submoduleRun(` deleted (each has one test, which is no longer found). Every other fixture that still exits non-zero does so because a test of it is still flagged as short: another of its tests, or the same test with another limit (fixture 3 with the constant resolution deleted reads `"timeout": 0`). In both kinds of case the red assertion named is the name or limit check, not the exit code.
  - Deleting `generatedScenario(` from the helper-name list: fixture 2's names check turns red (two of three names); fixture 3 no longer names its test nor `"timeout": 10000`; fixture 6 no longer names `alpha borrows a later limit`.
  - Deleting `submoduleRun(`: fixture 2's names check turns red; fixture 4 no longer names its test.
  - Deleting `openRun(`: fixture 2 still exits non-zero (its other two tests have no limit), only its names check turns red; fixture 6 no longer names `beta loop without a limit`. Fixtures 3 and 4 do not call `openRun(` and do not change.
  - Deleting the constant resolution (a name reads as 0): fixture 3's `"timeout": 10000` check turns red (it reads `"timeout": 0`) and fixture 5 exits non-zero (`timeout: LONG` reads 0). Fixture 4 stays refused.
  - Reverting only the first split to the top-level `^test(` (the cut at a line starting `for (` stays): alpha's chunk still ends at the first loop, so `alpha borrows a later limit` is still named; the loop-declared tests are no longer split out, so only the `beta loop without a limit` name check turns red.
  - Reverting that split and also deleting the whole function, const, let and `for (` cut: alpha's chunk runs through both loops and reads gamma's `30_000`, so fixture 6 exits 0. The non-zero exit, the `alpha borrows a later limit` name and the `beta loop without a limit` name turn red, and fixture 5 exits non-zero (its `1 pass` turns red).
  - Deleting the `function` alternative of the cut (a chunk ends at a helper definition): fixture 5 exits non-zero, because the `scenario(` in the `testedRun()` body is read into the chunk of the pure test before it and that test is flagged. Its `1 pass` check turns red. No fixture covers the `const`, `let` and `for (` alternatives of the cut on their own.

## Screenshot checkpoints

None, CLI output.
