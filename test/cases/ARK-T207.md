---
id: ARK-T207
title: ARK-T207 ark test fails a bun suite whose diff touches an old-id test, passes its converted form, a new test and a diff with no old-id declaration, and prints a skip line for another parser
level: integration
technique: state transition (touched old id, then converted) over suite parser (bun, pytest/behave); equivalence classes over diff content
priority: high
risk: "the old-id gate does not run in ark test, fails the 628 untouched old-id tests, passes a touched old-id test, fails a converted title, reads the copied base checkout instead of `git show <base>`, hides the failure from the results, or runs on a pytest/behave suite with a wrong parse"
status: active
changed_by: 2026-11-10-ARK-384-1
---

## Objective

Prove the old-id rule inside `ark test <run>`: a touched old-id test fails the run, and the fixes and non-touching diffs pass.

Expected: When a bun-parser suite's diff touches a declaration whose title has an old AC id, `ark test <run>` shall fail and print each `old id touched:` line. When the suite has another parser, `ark test <run>` shall print a skip line.

## Preconditions

- Fixture project with a git repo, a base commit with old-id tests (and untouched old-id tests that stay old-id), a `bun` suite on the fixture tests, and a second suite with `parser: pytest`.
- A run whose base is that commit (worktree.created event), as the existing `ark test` integration tests build.
- Four head commits tried in turn: (a) an edit in the body of an old-id test; (b) the same test with its title converted to a case id; (c) a new test added and no old-id declaration touched; (d) an edit to a file that holds old-id tests, outside every declaration.

## Steps

1. For head (a), run `ark test <run>`; read its output, exit code and the recorded results.
2. Repeat for heads (b), (c) and (d) (reset to base between them).
3. In the (a) run read the line for the pytest suite.

## Expected results

- (a): exit non-zero; output has `old id touched: <file>:<line> <title>` for the test; the failure shows in the results and in `test.completed` so the run lead's gate sees it; the untouched old-id tests are not listed.
- (b), (c) and (d): the gate passes, with no `old id touched` line; the suite results decide the exit code as before.
- The pytest suite prints a skip line that names the suite and the parser; it adds no failure.
- The check reads the base from `git show <base>:<path>`: it gives the same answer when the copied base checkout holds the head test files.

## Screenshot checkpoints

none: the surface is CLI output, which the test reads as text.
