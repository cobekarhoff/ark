---
id: ARK-T200
title: ARK-T200 the merge request body shows a Tests line with passed, skipped (and the base count) and deleted, lists each deleted title, and stays deterministic
level: integration
technique: equivalence classes over the last test.completed (full with deletions, full clean, quick, no counts, no event) and boundary values for the deleted list (0, 1, duplicates)
priority: high
risk: the MR body hides skipped or deleted tests from the reviewer, a title with backticks or a pipe breaks the markdown, the line prints for an old run or a quick run with a wrong claim (n/a, a base count that does not exist), or the body differs between two builds of the same events so the STALE01 body hash fails
status: active
changed_by: 2026-11-10-ARK-393-1
---

## Objective

Prove that the Tests line and the deleted bullets in the Evidence block come from the last `test.completed` event: through the real `ark merge-request open` for the runs that may ship (full result), and through the real `buildLedger` then `buildBody` for the runs that the shipping gate refuses (quick result, no result). The shipping gate is not changed and `merge-request open` gets no new flag.

## Preconditions

- Shippable fixtures as in ARK-T57 and ARK-T48: temporary `ARK_HOME`, project, git repo with a bare `origin` remote, a fake `gh` on `PATH` that records each `gh pr create` call and its body file, ACs passing, heads current, evidence complete. Real `events.ndjson`, no mocked ledger.
- Command runs, whose last `test.completed` is `mode: full` (or has no `mode`): (a) `passed_count` 42, `skipped` 3, `base_skipped` 2 and 1 deleted test; (b) 42, 0, 0 and none deleted; (c) 3 deleted tests, two with the same file and title, one title holding backticks and a pipe; (e) an old event with none of the new fields (no `mode`, so the gate accepts it as in ARK-T121 F4).
- Direct runs, in run folders that `assertShippable` would refuse: (d) last `test.completed` is `mode: quick` with `passed_count` 42, `skipped` 3 and no base fields; (f) no `test.completed` event at all.

## Steps

1. For each of (a), (b), (c), (e) run `ark merge-request open <run>` and read the body from the recorded `gh pr create` call.
2. For each of (d), (f) call `buildLedger({ runFolder, heads })` and `buildBody(ledger)` on the run folder and read the body.
3. For (a), (c) and (d) build the body twice from the same events and compare the two bodies.
4. Run the body linter (`lintBody`) over each body.

## Expected results

- (a) The Evidence block shall hold `- Tests: 42 passed, 3 skipped (base 2), 1 deleted` and one bullet `  - Deleted: \`<file>\` <title>` below it.
- (b) The line shall read `- Tests: 42 passed, 0 skipped (base 0), 0 deleted` with no Deleted bullet.
- (c) The line shall say `3 deleted` and list 3 bullets sorted by file then title, the duplicate title once per copy, backticks and the pipe escaped so the markdown renders the literal title.
- (d) The line shall read `- Tests: 42 passed, 3 skipped (no base count, deleted not counted)`, with no base count and no Deleted bullet.
- (e) The posted body shall have no Tests line: no `n/a` and no empty line. The rest of the Evidence block shall be unchanged.
- (f) The body shall have no Tests line and the existing no-evidence text shall be unchanged.
- Two builds from the same events shall give identical bodies, so the STALE01 body hash holds.
- `lintBody` shall accept every body.

## Screenshot checkpoints

none: the proof is the Markdown text of the MR body.
