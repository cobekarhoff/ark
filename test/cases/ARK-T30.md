---
id: ARK-T30
title: ARK-T30 the every-file timeout check of ARK-T31 refuses a git-heavy test with a short, missing or unresolved timeout and passes one with a limit
level: integration
technique: boundary values (10 s and a named constant below 30 s against the 30 s minimum) and equivalence classes (each helper call, a number against a named constant)
priority: medium
risk: the ARK-T31 check misses a git-heavy test: one built through generatedScenario(, submoduleRun( or openRun( with no timeout, one with a named constant below 30 seconds, or one whose named constant does not resolve passes unseen; or the check flags a test that only has a helper definition in its chunk, so main goes red
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

## Steps

1. Run `bun test test/timeouts.test.ts -t ARK-T31` in the repository in a child process with `ARK_LOAD_PROOF` removed. Read the exit code and the counts.
2. For each fixture 1 to 5, write `test/fixture.test.ts` and run `bun test test/timeouts.test.ts -t ARK-T31` in the temporary folder in a child process with `ARK_LOAD_PROOF` removed. Read the exit code and the output.

## Expected results

- Step 1: exit code 0, `1 pass`, no non-zero `skip` count: the owning check runs by default and passes on the real files.
- Fixture 1: a non-zero exit code. The output reports the 10 second test with `"timeout": 10000` and does not name the 30 second test.
- Fixture 2: a non-zero exit code. The output names each of the three tests, so each helper call is read as git-heavy.
- Fixture 3: a non-zero exit code. The output names the test and its limit 10000 (the constant is resolved, not read as 0 or skipped).
- Fixture 4: a non-zero exit code. The output names the test: an unresolved name fails the guard, it never passes it.
- Fixture 5: exit code 0, `1 pass`. A named constant of 120 s and a number of exactly 30 s pass; the pure test with a helper definition after it is not flagged.
- Deleting the helper-name list entry for `generatedScenario(`, `submoduleRun(` or `openRun(`, or the constant resolution, turns fixture 2, 3 or 4 green (the child exits 0).

## Screenshot checkpoints

None, CLI output.
