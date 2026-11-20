---
id: ARK-T697
title: ARK-T697 the CI workflow runs every Bun test file in exactly one of 4 timings-balanced shards, and the required check `test` fails unless every job succeeded
level: integration
technique: "equivalence classes (each shard index, each needed-job result: success, failure, cancelled, skipped) and boundary values (a disk file missing from the timings file, a timings entry with no file) on the real ci.yml, the real timings file and the real `bun test`"
priority: high
risk: "a file is run by no shard or by two (the shard total and the matrix disagree, or a listed-but-deleted file hides a gap), or the committed timings map is empty so the shards are not balanced by recorded times, so a defect merges unseen or a suite is paid twice; or the matrix job is named `test` and reports `test (1)`..`test (4)`, so the required context `test` is never produced and every PR waits forever; or the aggregate `test` job runs only on success (no `always()`) or passes on a `skipped` or `cancelled` shard, so a red or missing shard merges; or the workflow loses the `push` to main or the `pull_request` trigger, or a path filter or `if:` skips the suite on some PRs (the human chose the full suite on every PR); or a shard job leaves out the Playwright browser install or the Bun pin, so the shard fails on the runner"
status: active
changed_by: 2026-11-19-ARK-571-1
---

## Objective

Prove that `.github/workflows/ci.yml` runs the Bun suite as 4 parallel shard jobs balanced by the committed timings file, that the 4 shards together run each test file on disk exactly once, and that a final job named `test` fails when any shard or the static-checks job fails, is cancelled or is skipped. Serves ARK-571/AC1.

The authoring gate:

1. The contract is the merge gate: which files run, and which check name the branch protection waits for (`contexts: ["test"]`, `evaluation.md` Risks). The files and the check name are observable on the real workflow, the real timings file and the real Bun.
2. Regressions that fail it: a shard selection that leaves a disk `test/*.test.ts` file in no shard or in two shards; a timings entry for a deleted file; an empty committed timings map (Bun then balances nothing); `--shard=N/3` with a matrix of 4; a matrix job named `test`; an aggregate job with `needs` that leaves out the static-checks job or the shard job; no `if: always()`; a step that treats `skipped` or `cancelled` as pass; a `continue-on-error: true` on a shard; a `paths:` filter under `pull_request`. A new file with no timings entry is not a regression: Bun places it once (Step 6).
3. No existing proof reads shards: `test/tooling.test.ts` (ARK-T103) runs the old single-job command list and is rewritten by this run; `test/ci-bun-pin.test.ts` (ARK-T570) reads only pins; `test/playwright-migration.test.ts` reads only the Playwright job. One contract, one owning case: this case owns shards, coverage, the aggregate and the triggers. The job layout test of ARK-T103 keeps only the static-check commands (see its update).
4. No test-only export, flag or hook. The real `ci.yml` is parsed with `Bun.YAML.parse` (as ARK-T570 does). The file list comes from the disk, never from the timings file. Each shard is observed with the real `bun test` and the exact flags that the shard step carries, in a listing form that runs no test (see Step 4). The aggregate step is the real shell line of `ci.yml`, run with `bash`. GitHub itself is not run: that the runner expands `needs.*.result` is the platform's contract, and AC3 (analysis) covers the real runs.

Out of scope: the wall time of the shards (AC3, analysis); the how-to text (AC4, inspection); Playwright (ARK-T698); that the repo's branch protection lists `test` (a human step; the case proves only that a job named `test` exists and cannot be a matrix).

## Preconditions

- The real `.github/workflows/ci.yml`, the timings file that the shard step names in `--timings=`, and the real test files of the repo at the head under test.
- Bun at the pinned version; `bash` on the host. No network, no Playwright browser, no GitHub.
- For Step 6 a scratch folder with 9 `*.test.ts` files (each one passing `expect(1).toBe(1)`), and a timings file that lists 8 of them and also lists a tenth path that has no file.

## Steps

1. Parse `ci.yml`. Read `on`: `push.branches` and `pull_request`.
2. Find the shard job: the job with `strategy.matrix` whose steps run `bun test`. Read its matrix values, its `bun test` step and its `--shard` and `--timings` flags. Find the aggregate job named `test` and the static-checks job (the job that runs `bun run typecheck`, `bun run lint` and `bun run format:check`).
3. Read the timings file named by `--timings`: `version`, and each path in `files`. Build the expected file set from the disk: every `*.test.ts` under the repo root, skipping `node_modules` and the `pathIgnorePatterns` of `bunfig.toml` (`test/pw/**`).
4. For each matrix value `n`, run the real `bun test` with the step's flags (the `${{ matrix.shard }}` expression replaced by `n`, `--parallel` dropped) plus `--test-name-pattern` of a string that matches no test and `--reporter=junit --reporter-outfile=<scratch>/<n>.xml`, so Bun selects the shard's files, loads them and runs no test (a non-zero exit with "matched 0 tests" is expected). Read the `<testsuite name="....test.ts">` entries of each report as that shard's files (describe blocks add other `testsuite` entries; skip those). Record also the `--shard=n/T: running k/N test files` line.
5. Run the aggregate step. Take the `run` line of the aggregate job and run it with `bash -e`, with the `needs.<job>.result` expressions (or the `join(needs.*.result, ...)` expression) replaced by a value, for these inputs: all needed jobs `success`; for each needed job in turn (the static-checks job result and the shard job result, the two `needs` entries; the shard job result is the one value GitHub reduces from the 4 matrix shards, so a failed or a cancelled shard reaches the line as `failure` or `cancelled`) `failure`; for each in turn `cancelled`; for each in turn `skipped`.
6. In the scratch folder, run Step 4's selection with the 4 shard values on the 9 files and the timings file of the preconditions (8 files listed, 1 unlisted, 1 entry with no file).

## Expected results

- Step 1: `push.branches` shall contain `main`, and `pull_request` shall be present with no `paths`, `paths-ignore` or `branches` key, so every PR runs the suite and a push to main runs it as well.
- Step 2: the matrix shall have exactly the 4 values 1, 2, 3, 4 (any order, any type that expands to 1..4); the `--shard` flag shall be `${{ matrix.shard }}/4`, so the total equals the matrix size; `--timings=` shall name one file that exists in the repo. The shard job shall not be named `test`, shall have no `if:` and no `continue-on-error: true`, and shall run `bun install --frozen-lockfile` and `bunx playwright install --with-deps chromium` before `bun test`. The static-checks job shall have no `if:` and no `continue-on-error: true`. A job named `test` shall exist, shall have no `strategy`, and shall have `needs` equal to exactly the static-checks job plus the shard job (so the line reads two results), `if` containing `always()`, and no `bun`/`bunx` step (or one pinned like ARK-T570 requires).
- Step 3: the timings file shall have `version` 1, `files` shall have at least one entry (an empty map shall fail the case: no recorded durations supply the balance), every entry shall be a finite non-negative number of milliseconds and at least one shall be above 0, and every path in `files` shall be a file on the disk (an entry with no file shall fail the case and name the path; the file list is never taken from the timings file).
- Step 4: the 4 file lists shall be pairwise disjoint and their union shall equal the disk set exactly, so each file runs once; each `running k/N test files` line shall have k equal to the length of its list and N equal to the disk count. No shard shall be empty. The failure message shall name the file that has zero or two shards.
- Step 5: for all `success`, the line shall exit 0. For the static-checks job result at `failure`, `cancelled` or `skipped`, and for the shard job result at `failure` (a failed shard), `cancelled` (a cancelled shard) or `skipped`, the line shall exit non-zero. A `skipped` result shall never pass.
- Step 6: the 4 lists shall be disjoint and their union shall be the 9 files, with the unlisted file in exactly one shard; the entry with no file shall change nothing. This proves Bun's placement of an unlisted file, which `evaluation.md` did not verify: the coverage check in Step 4 reads the disk, so a new file missing from the timings file is placed, not lost.

## Screenshot checkpoints

none: reads one YAML file and runs `bun test` and `bash` on files; no UI.
