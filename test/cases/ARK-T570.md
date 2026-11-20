---
id: ARK-T570
title: ARK-T570 every job of .github/workflows/ci.yml that runs bun installs the same exact Bun version, and it is 1.4.4 or later
level: integration
technique: equivalence classes (both jobs pinned and equal, one job differs, version below the floor, floating or missing version, a job that runs bun with no setup-bun step) and boundary values at 1.4.3, 1.4.4 and 1.4.10 through the stdlib semver comparison
priority: high
risk: "the CI runner stays on Bun 1.4.0, which loses the exit of a `spawnSync` child (oven-sh/bun PR #44581, fixed in 1.4.4) and stalls every `bun test --parallel` worker that has run earlier tests (main push CI run 43604566696, 3 of the last 6 merges red); or only the `test` job is bumped and `playwright` stays on 1.4.0; or a pin is a floating value (`latest`, `1.x`, none) that resolves to a different Bun for each job or on each run; or a job added later runs `bun` with no pinned setup-bun step; or the pins are compared as strings so `1.4.10` reads as below `1.4.4`"
status: active
changed_by: 2026-11-19-ARK-571-1
---

## Objective

Prove that every job of `.github/workflows/ci.yml` that runs `bun` or `bunx` first installs Bun with `oven-sh/setup-bun` at one exact version, that all those jobs name the same version, and that it is 1.4.4 or later. Serves ARK-479/AC2.

The authoring gate:

1. The contract is a release/config contract: the Bun version that runs the Ark suite on the Linux runner. A stall on 1.4.0 is not observable on the macOS host, so the file itself is the boundary that can be read.
2. The regression is the base commit: `bun-version: 1.4.0` in both jobs fails the floor; one job bumped fails the equality.
3. `test/playwright-migration.test.ts` (ARK-243-AC4) parses `jobs` and the `playwright install` order and reads no `bun-version`; `test/tooling.test.ts` reads only the `bun test` step (ARK-T100, `--parallel`). No existing proof reads the pin. The case belongs next to the ci.yml reader in `test/tooling.test.ts`, or a new `test/ci-bun-pin.test.ts` if the plan prefers.
4. No export, flag or hook: the case parses the real file with `Bun.YAML.parse`, as ARK-243-AC4 does, and compares with `Bun.semver`, never with a hand-written comparator. A test that restates the version `1.4.4` as the expected pin value would take its expectation from the code under test: the floor is the one constant, written as a floor and cited to ARK-479, and the test never asserts that the pin equals a literal.

Out of scope: that Bun 1.4.4 exists or removes the stall (the validator's Linux reproduction, ARK-479/AC3); the sentence of `docs/how-to/work-on-ark.md` that names the version (an inspection, not a contract a test can fail on without a source grep).

## Preconditions

- The real `.github/workflows/ci.yml` of the repo at the head under test. No fixture, no network.
- The floor `1.4.4` as the one constant of the case.

## Steps

1. Parse `ci.yml` with `Bun.YAML.parse`. Collect each job whose steps include a `uses` that starts with `oven-sh/setup-bun@`, with the value of its `with["bun-version"]`.
2. Collect each job with a `run` step that starts `bun ` or `bunx `.
3. Check that the two sets are equal and non-empty, that each version is a plain `<major>.<minor>.<patch>` string, that all versions are equal, and that `Bun.semver.order(version, floor)` is 0 or 1.

## Expected results

- Step 1: the static-checks job, the shard job and the `playwright` job shall each have a setup-bun step with a `bun-version` (ARK-571 splits the old `test` job; the aggregate job `test` runs no bun command and needs no pin).
- Step 2: every job that runs `bun` or `bunx` shall have a setup-bun step, so a job added later with no pin fails the case by naming itself.
- Step 3: the versions shall be identical across all jobs (`1.4.4` in one job and `1.4.5` in the other fails), each shall be an exact version (`latest`, `1.x`, `>=1.4.4` and a missing `with` fail), and each shall satisfy the floor, compared numerically by `Bun.semver` (`1.4.10` is above `1.4.4`; a string comparison is the defect the risk names). At the base commit (`1.4.0` in both jobs) the case shall fail on the floor.
- The failure message shall name the job and the version it found.

## Screenshot checkpoints

none: reads one YAML file; no UI.
