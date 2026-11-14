---
id: ARK-T348
title: ARK-T348 ark test stays silent about a changed test with no case id in the plan-membership check, and the old id check still reports a changed old-id test
level: integration
technique: equivalence classes (no id, old id) in one diff; regression of the ARK-T207 behavior
priority: high
risk: "the new check reports a test with no id; the new check replaces or swallows the old id check so a touched old-id test is no longer reported; the old id message changes or gains the new fix text"
status: active
changed_by: 2026-11-13-ARK-431-1
---

## Objective

Prove that the new check leaves id-less tests alone and does not change the old id check.

Expected: When the diff changes one test with no id and one test with an old id, `ark test <run>` shall print the old id line for the old-id test only, and shall print no plan-membership line.

## Preconditions

- Fixture project, base commit and run as in ARK-T346, with a bun test file that holds one test titled with no id (`works`) and one titled with an old AC id (as the ARK-T207 fixture builds it).
- A `plan.yml` with an empty `test_cases` list.
- A head commit that edits the body of both tests.

## Steps

1. Run `ark test <run>`; read its output, its exit code and the recorded checks.

## Expected results

- The output has one `old id touched: <file>:<line> <title>` line, for the old-id test, with the old fix text unchanged. The id-less test appears in no line.
- No line of the plan-membership check appears, and its recorded check passes.
- Exit non-zero because of the old id check, as in ARK-T207 (a).

## Screenshot checkpoints

none: the surface is CLI output, which the test reads as text.
