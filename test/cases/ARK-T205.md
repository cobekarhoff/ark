---
id: ARK-T205
title: ARK-T205 a parameter table (test.each) is one row with its row count and the command changes no file
level: integration
technique: boundary values (table of 0, 1 and many rows; one-line and multi-line table), before and after tree comparison
priority: high
risk: "a test.each table is counted as one test for each row or as zero, the title on a later line is lost, the row count is wrong for a nested array or a template-literal table, or the command writes a file (cache, report, lock) in the audited project"
status: active
changed_by: 2026-11-10-ARK-384-1
---

## Objective

Prove that a parameter table is one inventory row with its row count, and that the audit is read-only.

Expected: When a declaration is a parameter table, the command shall print one row for it with its row count. The command shall change no file.

## Preconditions

- Fixture project with: `test.each([[1,2],[3,4],[5,6]])("ARK-T1 adds %i", ...)` on one line; a multi-line `test.each([...])` with the title on a later line and 4 rows; an empty table; a template-literal `test.each` table.
- A hash (path, size, mtime, content) of the whole fixture tree, taken before the run.

## Steps

1. Run the default inventory and `--json`, and `--summary`.
2. Find the row of each table.
3. Take the hash of the fixture tree again and compare.

## Expected results

- Each table is one row, with its row count (3, 4, 0 and the template row count); the title is the one on the later line, and the line is the one of the declaration.
- The total test lines of `--summary` counts each table once.
- The tree after is identical to the tree before: no file added, changed or removed in the project, in `ARK_HOME` or in the fixture repo.

## Screenshot checkpoints

none: the surface is CLI output, which the test reads as text.
