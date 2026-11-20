---
id: ARK-T698
title: ARK-T698 the Playwright step of ci.yml runs with 4 workers under CI and lists every spec of test/pw exactly once
level: integration
technique: equivalence classes (no filter flag, each filter flag in the step) and a set comparison of the listed tests against the files on disk, using the real `playwright test --list` under CI=true
priority: medium
risk: "the 4-worker setting is not applied on the runner (the config keeps `workers: 2`, the `CI` condition is mistyped, or the flag is on a step that the job does not run), so the Playwright job stays at 227 s; or the change to 4 workers or to a shard drops or doubles a spec (a `--grep`, `--grep-invert`, `--project`, `--last-failed` or `--shard` flag in the step, a `testMatch` that stops matching a file, a 2-shard split whose halves overlap or leave a test out), so a spec never runs on CI or runs twice"
status: active
changed_by: 2026-11-19-ARK-571-1
---

## Objective

Prove that the Playwright command of `.github/workflows/ci.yml`, run as the runner runs it (`CI=true`), resolves to 4 workers (or to 2 shards that together list the same tests as one run), and that it lists every test of every `test/pw/*.pw.ts` file exactly once. Serves ARK-571/AC2.

The authoring gate:

1. The contract is the CI Playwright run: its effective worker count and the set of tests it selects. Playwright resolves both from `playwright.config.ts`, the environment and the step's flags, so only the resolved config and the list show what the runner will do.
2. Regressions that fail it: `workers: 2` left in the config; `process.env.CI ? 4 : 2` read from a different variable name; `--workers=4` added to a job other than the Playwright job; `--grep`/`--shard`/a file argument added to the step; a spec file that `testMatch` no longer lists.
3. Existing proof misses it: `test/playwright-migration.test.ts` (ARK-243-AC4) checks that one job runs `playwright test` after the install, and reads neither the workers nor the list; ARK-T123 proves the suite passes at 2 and at 4 workers, by running it, and does not read what CI passes. No test reads `workers`. One contract, one owning case: this case owns the CI worker count and the once-each selection; ARK-T123 keeps the pass-at-4 proof; the ARK-243-AC4 test keeps the one-job contract.
4. No test-only export, flag or hook. The case parses the real `ci.yml`, runs the real `bunx playwright test --list --reporter=json` (no browser starts; `--list` takes about 10 s) and reads `config.workers`, `config.shard` and the listed tests from the JSON.

Out of scope: that the suite passes at 4 workers on a Linux runner (ARK-T123 on a Mac; the real CI runs of AC3 on Linux); the Playwright job wall time (AC3, analysis).

## Preconditions

- The real `.github/workflows/ci.yml`, `playwright.config.ts` and `test/pw/*.pw.ts`. `bun install` done; no network and no browser launch (`--list` does not start one).
- `CI=true` set in the child environment of every run.

## Steps

1. Parse `ci.yml`. Find the job with a `run` step that contains `playwright test` and take that step's command (flags included). If the job has a `strategy.matrix`, read its `shard` values.
2. Run that command with `--list --reporter=json` added and `CI=true` set. If the step carries `--shard=<n>/<total>` with a matrix, run it once for each matrix value. Read `config.workers`, `config.shard` and each listed test (file, title path, project).
3. Run `bunx playwright test --list --reporter=json` with no other flag (the control for the selection), and read its listed tests.
4. List the files `test/pw/*.pw.ts` on the disk.

## Expected results

- Step 1: the step carries no `--grep`, `--grep-invert`, `--project`, `--last-failed`, `--only-changed` or file-path argument. (That exactly one job has the step stays with the ARK-243-AC4 test; this case reads the first such job.)
- Step 2: `config.workers` shall be 4, or the step shall carry a matrix of 2 shards whose `config.shard.total` is 2 for each value. The failure message shall name the value found.
- Step 2 and 3: the listed tests of Step 2 (the union of the shards, if any) shall equal the tests of Step 3 as sets, with no test listed twice across the runs of Step 2. Every `test/pw/*.pw.ts` file of Step 4 shall have at least one listed test, and no listed test shall belong to a file that Step 4 does not list.

## Screenshot checkpoints

none: reads one YAML file and the JSON list of `playwright test --list`; no UI.
