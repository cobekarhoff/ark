---
id: ARK-T1
title: ARK-T1 ark test runs new tests at base and a base failure does not fail a feature run
level: integration
technique: state transition (base fail / head pass) plus equivalence classes of run kind (feature vs refactor)
priority: high
risk: ark test skips base for non-refactor kinds, copies no head test files into base, or lets a base failure fail a feature run; or a head failure stops failing the run
status: active
changed_by: 2026-11-06-ARK-312-1
---

## Objective

Prove that `ark test` runs every suite at the `worktree.created` base commit for a `feature` run, after copying the head's added or changed test files into the base checkout, and that a base failure is data: `ark test` exits 0.

## Preconditions

- Fake project helper as in `test/test-run.test.ts`, no git mocking. Two touched repos, `repoA` and `repoB`, each with its own base commit (different SHAs). Expected base SHAs are read with `git rev-parse` in each fixture repo right after creating the base commit and written into that run's `worktree.created` event by the fixture; the assertions compare against those values.
- Each repo's test config has two suites (`s1`, `s2`). Every suite prints `SUITE=<repo>/<suite> CHECKOUT=<base|head>` where CHECKOUT is derived from `git rev-parse HEAD` compared with the fixture's recorded base SHA, never from the code under test.
- Base commit of each repo: production `src/feature.ts` without `feature()`; tests `test/keep.test.ts` (to be deleted at head), `test/old-name.test.ts` (to be renamed), `test/helpers/util.ts` (helper, old content `v1`), `tests/nested/a.test.ts`, `features/x.feature` (old content `v1`), `test/cases/ARK-X.md`, `packages/app/test/helpers/h.ts` (old content `v1`), `packages/app/features/z.feature` (old content `v1`), `packages/app/tests/a.test.ts`.
- Head commit of each repo: adds `src/feature.ts: feature()` (production, must stay absent at base); adds `test/new.test.ts`, `tests/nested/deep/b.test.ts`, `features/y.feature`, `test/fixtures/data.json`, `test/cases/ARK-Y.md`, and the non-root files `packages/app/test/new.test.ts`, `packages/app/tests/new.test.ts`, `packages/app/features/y.feature`; changes `test/helpers/util.ts` (`v2`), `features/x.feature` (`v2`), `packages/app/test/helpers/h.ts` (`v2`), `packages/app/features/z.feature` (`v2`); deletes `test/keep.test.ts`; renames `test/old-name.test.ts` to `test/renamed.test.ts` (git rename, content unchanged). A production file `packages/app/src/p.ts` is added at head and must stay absent at base.
- Run fixtures (same repos, different `kind` in `state.json`): K1 `feature`, K2 `bug`, K3 `perf`, K4 `refactor` (suites fail at base), K5 `feature` where `test/new.test.ts` also fails at head, K6 `bug` and K7 `perf` where `test/new.test.ts` fails at head, K8 `refactor` where every suite passes at base and `test/new.test.ts` fails at head.

## Steps

1. For K1: hand-run `test/new.test.ts` in a plain checkout of repoA base; assert it fails (`feature` is not a function).
2. Run `ark test` for K1. Assert exit code 0.
3. In each of repoA and repoB, read the base checkout the run used (or its suite output). Assert all four suite markers `repoA/s1`, `repoA/s2`, `repoB/s1`, `repoB/s2` appear with `CHECKOUT=base` and that each base run's `git rev-parse HEAD` equals that repo's own recorded base SHA (repoA's SHA is not used for repoB).
4. In each base checkout assert by file content: `test/new.test.ts`, `tests/nested/deep/b.test.ts`, `features/y.feature`, `test/fixtures/data.json`, `test/cases/ARK-Y.md`, `packages/app/test/new.test.ts`, `packages/app/tests/new.test.ts`, `packages/app/features/y.feature` exist and equal head; `test/helpers/util.ts`, `features/x.feature`, `packages/app/test/helpers/h.ts` and `packages/app/features/z.feature` are `v2`; `test/renamed.test.ts` exists.
5. In each base checkout assert: `test/keep.test.ts` still exists (deletion is not copied); `test/old-name.test.ts` still exists beside `test/renamed.test.ts`; `src/feature.ts` has no `feature()` and `packages/app/src/p.ts` does not exist (production stays at base); `tests/nested/a.test.ts`, `packages/app/tests/a.test.ts` and `test/cases/ARK-X.md` are unchanged.
6. Run `ark test` for K2 (`bug`) and K3 (`perf`). For each assert exit 0 and the same base assertions of steps 3 to 5.
7. Run `ark test` for K4 (`refactor`). Assert exit non-zero. Run it a second time after changing `test/new.test.ts` at head so the suites pass at base the second time; assert the second run executed the suites again (suite output carries a fresh run counter written by the suite to a file outside the repo) and its exit code reflects the second result (0), not the first.
8. Run `ark test` for K5. Assert exit non-zero although base failed as well.
8a. Run `ark test` for K6 (`bug`), K7 (`perf`) and K8 (`refactor`, suites pass at base, `test/new.test.ts` fails at head). For each assert exit non-zero and that the head suite output shows the failure.
9. Run `ark test` for K1 twice with `test/new.test.ts` content changed in head between the runs; assert the second run's base checkout holds the second content and the suite run counter increased for K1 as well.

## Expected results

- When a new test fails at base and passes at head in a `feature`, `bug` or `perf` run, the system shall exit 0 from `ark test`.
- When `ark test` runs, the system shall run every configured suite of every touched repo at that repo's own recorded base SHA.
- When `ark test` runs, the system shall copy head's added, changed and renamed-to files under any `test`, `tests` or `features` folder (any depth, including non-root folders such as `packages/app/test`, helpers, fixtures and `test/cases/`) into the base checkout, and shall not delete a base file deleted or renamed at head, and shall not copy production files.
- When `ark test` runs a `feature`, `bug`, `perf` or `refactor` run, the system shall run the suites at base on every invocation and shall not reuse an earlier base result.
- When the suites fail at base in a `refactor` run, the system shall exit non-zero.
- When a suite fails at head, the system shall exit non-zero for every kind, including `bug`, `perf` and `refactor` runs whose base passes.

## Screenshot checkpoints

none: integration case on CLI exit codes and files; no UI surface.
