---
id: ARK-T12
title: ARK-T12 a refactor run whose base fails exits 1, reruns the base on each ark test and merge-request open refuses
level: integration
technique: state transition (base failing) over two runs
priority: high
risk: a refactor run ships although its suites fail at the base commit, or a stale base result is reused
status: active
changed_by: 2026-11-06-ARK-312-1
---

## Objective

Prove that for a `kind: refactor` run whose suites fail at the base commit, `ark test` exits 1, records `base_passed: false`, runs the base suites again on each invocation, and `ark merge-request open` refuses with the base commit named. This case replaces the old-id test `ARK-302-AC7 a base that fails records base_passed false once per run and merge-request open refuses`.

## Preconditions

- A refactor run whose e2e test fails at base and passes at head (the head commit fixes it).

## Steps

1. Run `ark test`. Assert exit 1, the line `base      failed` and `base_passed: false` in `test.completed`.
2. Remove `results/base-e2e.log`. Run `ark test` again.
3. Run `ark merge-request open`.

## Expected results

- The second run exits 1 and writes `results/base-e2e.log` again.
- `ark merge-request open` exits 1 and its error names the base commit.

## Screenshot checkpoints

none: integration case on CLI exit codes and files; no UI surface.
