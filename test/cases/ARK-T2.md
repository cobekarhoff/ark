---
id: ARK-T2
title: ARK-T2 ark test writes base and head result.json with different SHAs
level: integration
technique: equivalence classes of outcome (failed/passed/skipped) and a base-crash boundary
priority: high
risk: a case has no base or head folder, result.json lacks the id/name/status/sha fields, the base SHA equals the head SHA in a touched repo, or a base crash leaves a case with no base evidence
status: active
changed_by: 2026-11-06-ARK-312-1
---

## Objective

Prove `results/evidence/<case id>/{base,head}/result.json` is written for every case id the parsers find, with the right fields and the SHA of the checkout that ran.

## Preconditions

- Fake project as in ARK-T1: touched repo, base commit and a distinct head commit; run `kind: feature`.
- Suite A: tests with ids `FAKE-T1` (fails at base, passes at head), `FAKE-T2` (passes both), `FAKE-T3` (skipped at both).
- Suite B (crash fixture): a new test file `FAKE-T4` that imports a module existing only at head, so at base the whole file fails to load and the JUnit has no entry for `FAKE-T4`.
- Expected SHAs: base SHA from the `worktree.created` event; head SHA from `headOf(repo, workspace, mirror)` (the function `ark test` and `staleHeads` use), computed by the test itself with the same function.

## Steps

1. Run `ark test` on suite A.
2. For FAKE-T1, FAKE-T2, FAKE-T3 list `results/evidence/<id>/`; assert `base/` and `head/` exist.
3. Parse each `result.json`. Assert keys `case`, `name`, `status`, `sha` and nothing else required.
4. Assert FAKE-T1: base `status` failed, head `status` passed. FAKE-T2: both passed. FAKE-T3: both skipped. `name` is the JUnit test name and starts with the case id.
5. Assert for FAKE-T1 that base `sha` equals the base SHA, head `sha` equals `headOf(...)`, and the two differ.
6. Run `ark test` on suite B. Assert `FAKE-T4/base/result.json` exists with `status` failed and the base SHA, and `FAKE-T4/head/result.json` has status passed.
7. Re-run `ark test` after the head test file drops FAKE-T2. Assert `results/evidence/FAKE-T2` is gone (no stale folder of a case that no longer appears).

## Expected results

- When `ark test` finds a case id, the system shall write `result.json` with the case id, the JUnit name, the status and the commit SHA of the checkout that ran to its `base/` and `head/` folders.
- When a case ran in a touched repo, the system shall record the base SHA in `base/result.json` and `headOf(repo, workspace, mirror)` in `head/result.json`, and the two shall differ.
- If the base run crashes before reporting a case that head reports, then the system shall write a `result.json` with status `failed` to that case's `base/` folder.
- When a case id no longer appears in the results, the system shall remove its evidence folder.

## Screenshot checkpoints

none: integration case on JSON files; no UI surface.
