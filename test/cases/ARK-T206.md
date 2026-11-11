---
id: ARK-T206
title: ARK-T206 --changed <base> lists only the declarations that the diff changes, with their id kind, and prints old id touched for each old AC id title
level: integration
technique: equivalence classes over declaration form (multi-line table, skipIf, nested describe, fixture string) and over change kind (edit, delete, rename, convert, helper-only); decision table of change kind by id kind
priority: high
risk: "a changed line in a title, body or table is not mapped to its declaration (the retro F8 misses: test.each with a title on a later line, test.skipIf), a fixture string is counted as a test, a deleted or renamed file is lost or reported in full, a converted title is blamed as old-id touched, a helper edit reports a declaration, or the working tree is read in place of the base"
status: active
changed_by: 2026-11-10-ARK-384-1
---

## Objective

Prove the diff-to-declaration mapping of `--changed <base>` on every hard form.

Expected: When --changed <base> is given, the command shall list only the declarations whose title, body or parameter table the diff from the base changes, each with its id kind, and shall print `old id touched: <file>:<line> <title>` for each one whose title has an old AC id.

## Preconditions

- Fixture git repo in a tmpdir with a base commit and a head commit (and an uncommitted working-tree edit that must not count).
- Base files: a multi-line `test.each` (old id, title on line 5 of the declaration, edit later at a table row); a `test.skipIf(cond)("ARK-9-AC1 ...")` with a body edit; a `describe` nested two deep with an old-id test, edit in the inner body; a test whose body holds a string with `test("ARK-8-AC1 x", ...)` syntax, edited inside the string; a file to delete (old-id tests); a file to rename with a small edit in one old-id test and one untouched old-id test; a test with an old id whose title becomes a case id in the head; a file with a helper function and untouched old-id tests; an untouched old-id test and a new test in an edited file.

## Steps

1. Run `ark test-audit inventory --project fixture --changed <base>`; also with `--json`.
2. Compare the listed declarations with the expected set, row by row.
3. Read the `old id touched:` lines.

## Expected results

- Listed: the multi-line each (by its table edit, reported at its declaration line), the skipIf, the inner nested test, the changed tests of the renamed file (compared against the old path), the converted test (kind: case id) and the new test (kind: case id or none, as its title says). The deleted file's tests are not listed and raise no old-id line (deleting a test retires it; it is not touched).
- Not listed: the test syntax inside the fixture string (edited in the string): only the enclosing declaration is listed, and the string content gives no row of its own; the untouched old-id tests; every declaration when only the helper changed (the output is empty and exit 0); the uncommitted working-tree edit.
- `old id touched: <file>:<line> <title>` is printed for the multi-line each, the skipIf, the nested test, the renamed-file test (new path and new line), and not for the converted test, the new test or the helper edit.

## Screenshot checkpoints

none: the surface is CLI output, which the test reads as text.
