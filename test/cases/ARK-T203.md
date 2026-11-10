---
id: ARK-T203
title: ARK-T203 ark test-audit inventory prints one row for each declaration with its file, line, title, id kind, the ACs of the case and the last duration
level: integration
technique: equivalence classes over title kinds (case id, old AC id, none, describe-name id) and over duration source (report match, no report, no match)
priority: high
risk: "a declaration is missed or counted twice (a fixture string, a file in two suites), the id kind is wrong, a case id with no case file crashes the row, or the duration joins to the wrong test or stale report"
status: active
changed_by: 2026-11-10-ARK-384-1
---

## Objective

Prove the default inventory output of `ark test-audit inventory --project <name>` over a fixture project.

Expected: When a project is audited, the inventory shall print one row for each test declaration in the files of the project suites, with file, line, title, id (the test case id, the old AC id, or none), the ACs that the case verifies, and the last duration from the newest report.

## Preconditions

- Fixture project in a tmpdir (`ARK_HOME` set to it) with `ark.yml` that has a `bun` suite on `test/*.test.ts` and a `playwright` suite on `test/pw/**/*.pw.ts`, no git needed.
- Fixture test files: a title with a case id, a title with an old AC id (`ARK-9-AC2`), a title with neither, a `describe` whose name holds an id (children inherit it, as the bun parser does), a string literal that holds `test("x", ...)` syntax, and a file matched by both suites.
- `test/cases/ARK-T1.md` with no ACs in its front matter: a case file never lists ACs, the ticket criteria do. Two fixture tickets in the project's ticket store: ARK-900 with criterion `ARK-900/AC1` `verified_by: [ARK-T1]` and `ARK-900/AC2` `verified_by: [ARK-T1]`; ARK-901 with `ARK-901/AC1` `verified_by: [ARK-T1]` (a case shared by two tickets). One title names a case id (`ARK-T77`) that has no case file and no ticket link.
- Two `results/*.report` files in the run folders of the project with different mtimes, both holding `<testcase time=...>` for the same test; one fixture test is in no report.

## Steps

1. Run `ark test-audit inventory --project fixture`.
2. Read the rows. For each fixture declaration, find its row by file and line.
3. Run it again after changing no file; compare the output.
4. Run it once with no report file in the project.

## Expected results

- Exactly one row for each real declaration, in file and line order; the string literal that holds test syntax gives no row; the file in two suites gives its rows once.
- Each row shows the right id kind and id; the `ARK-T1` row lists exactly `ARK-900/AC1`, `ARK-900/AC2` and `ARK-901/AC1`, taken from the ticket criteria that name it (the same reversal the hub does in `hub/evidence.ts`), not from the case file; the `ARK-T77` row shows an empty AC list and no error; the old-id row shows its AC id and no ACs; a child of an id-named describe shows the describe id.
- The duration is the one from the newest report by mtime, joined by file and title; the test in no report shows no duration.
- With no report, every row prints and none shows a duration.

## Screenshot checkpoints

none: the surface is CLI output, which the test reads as text.
