---
id: ARK-T244
title: ARK-T244 the base suites of a touched repo can read an untouched sibling repo
level: integration
technique: equivalence classes of repos (touched vs untouched sibling)
priority: medium
risk: the base checkout of a touched repo is built without the untouched sibling repo, so base suites that read the sibling fail and base_passed is recorded false
status: active
changed_by: 2026-11-10-ARK-419-1
---

## Objective

Prove that when a run touches one repo and a sibling repo stays untouched, `ark test` runs the touched repo's base suites with the untouched sibling readable, so the base passes and `base_passed` is recorded `true`.

## Preconditions

- Fake run fixture of `test/test-run.test.ts` (`siblingRun`): two repos, `repos/a` touched with a `worktree.created` event, the sibling untouched. The touched repo's suites read a file of the sibling.

## Steps

1. Run `ark test` for the fake run.
2. Read the exit code and output.
3. Read the `test.completed` event of the run.

## Expected results

- When a run touches one repo and leaves a sibling untouched, `ark test` shall exit 0.
- The output shall contain `base      passed`, because the base suites read the sibling repo.
- The `test.completed` event shall record `base_passed: true`.

## Screenshot checkpoints

none: integration case on CLI exit codes and events; no UI surface.
