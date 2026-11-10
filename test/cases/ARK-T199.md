---
id: ARK-T199
title: ARK-T199 ark test prints and records the skipped counts at head and base and the tests deleted against the base, and its exit code does not change
level: integration
technique: equivalence classes (unchanged, skipped, deleted, clean) on a fixture whose head differs from base by exactly one skip and one deletion
priority: high
risk: a run that skips or deletes a test to get green stays invisible, because counts come only from ID-tagged cases, the base run of a suite with base_files never sees deleted tests, a duplicate title or a missing file field hides a deletion, or the report turns into a gate and changes the exit code
status: active
changed_by: 2026-11-10-ARK-393-1
---

## Objective

Prove that a full `ark test` on a workspace whose head skips 1 more test and deletes 1 test than base prints the `tests` and `deleted` lines and writes the counts and the deleted titles to the `test.completed` event, with the exit code of a run that only reports.

## Preconditions

- A fixture project and run with a `bun` suite that has `base_files` (as `cli` in `ark.yml`) and a real git repo with a base commit and a head commit. No mocked runner.
- Base: file `a.test.ts` with tests `keeps`, `to skip`, `to delete`, plus `b.test.ts` with one test, one of them already skipped at base (base skipped = 1) and one test with no test case ID.
- Head: in `a.test.ts` `to skip` is now skipped (head skipped = 2, one more than base) and `to delete` is removed. Every remaining test passes.
- A second fixture run whose head equals base.

## Steps

1. Run `ark test <run>` (full) on the first fixture. Read stdout, the exit code and the last `test.completed` event.
2. Run it again after a `--quick`-free rerun with the suite cached, so the suite shows `reused`. Read stdout and the event.
3. Run `ark test <run>` on the second fixture.
4. Delete the whole file `b.test.ts` at head in a third variant and run `ark test <run>`. Read stdout.

## Expected results

- When head skips 1 more test and deletes 1 test, stdout shall hold one line `tests      <n> passed, 2 skipped (base 1), 1 deleted` and one line `deleted    a.test.ts  to delete`, in that order, after the suite lines.
- The skipped count shall cover tests with no test case ID and tests with an old AC tag, not only tagged cases.
- The `test.completed` event shall hold `passed_count`, `skipped` = 2, `base_skipped` = 1 and `deleted` = `[{file: "a.test.ts", name: "to delete"}]`.
- The base side shall see tests that the run's own commits deleted, although the suite has `base_files`.
- When the suite is `reused` from the cache, stdout and the event shall hold the same counts and deleted titles as the first run.
- When head equals base, stdout shall hold `tests      <n> passed, <m> skipped (base <m>), 0 deleted`, with no `deleted` line.
- When a whole test file is deleted at head, each test of that file shall appear as a `deleted` line, sorted by file then title.
- The exit code shall be the same as without the skip and the deletion: 0 when every AC passes. Skips and deletions shall not fail `ark test`.

## Screenshot checkpoints

none: CLI output and an event; the proof is stdout text and the event JSON.
