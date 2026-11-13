---
id: ARK-T287
title: "ARK-T287 Evidence section folds each test case and each non-test AC in a details block, the same on both hosts, and SIZE01 skips it"
level: integration
technique: "equivalence classes (test case / non-test AC / no log / old ledger without a log field), boundary values on the log length (0, 20, 25 lines) and a state transition (open and closed details for SIZE01)"
priority: high
risk: "a case has no `<details>` block or shows its log open, more than the last 20 lines of the head `command.log` are posted, base and head results are missing, a non-test AC evidence file is not read, GitHub and GitLab bodies differ, a log line starting `## ` or `**` cuts the Evidence section so EVID01/EVID03/EVID04 fail, a backtick fence in the log breaks out of its fence, SIZE01 counts the block as prose, or an unclosed `<details>` hides the rest of the body from SIZE01"
status: active
changed_by: 2026-11-12-ARK-399-1
---

## Objective

Prove that for each test case in `results/evidence/` the Evidence section has one collapsed `<details>` block with the result at base and at head and the last 20 lines of the head `command.log`, that a non-test AC puts its `results/evidence/<AC id>.md` in a `<details>` block, that the body is the same for GitHub and GitLab, and that SIZE01 counts no line inside a `<details>` block as prose. Serves ARK-399/AC4.

Expected: When `results/evidence/` exists, the Evidence section shall hold one collapsed `<details>` block for each test case and each non-test AC.

## Preconditions

- Fixture run with one test case (`base/` and `head/` with `result.json` and a `command.log` of 25 lines, the last 20 numbered; one line of the log is `## heading`, one is `**bold**`, one has a run of 5 backticks) and one demonstration AC with `results/evidence/AC5.md`.
- A variant run with a test case that has no `head/command.log`, and a saved ledger JSON from before this change (no log field), e.g. `test/fixtures/pr-writing/lint/EVID01/ledger.json`.
- Variant body for SIZE01 with a long text inside `<details>` and the same text outside; a variant with an unclosed `<details>`.

## Steps

1. Build the body for the host `github` and for the host `gitlab`. Diff them.
2. Read the Evidence section: the block of the test case and the block of the AC.
3. Run lint on the body. Read EVID01, EVID03, EVID04 and SIZE01.
4. Build with the no-log variant and the old ledger.
5. Run lint on the SIZE01 variants.
6. Run `bun test test/pr-writing.test.ts`.

## Expected results

- Each of the test case and the AC has one `<details>` block with a `<summary>` that names its id and holds the `base`/`head` result; the blocks hold no `open` attribute.
- The test case block holds exactly the last 20 lines of the head `command.log` (lines 6 to 25), fenced with a fence longer than any backtick run in the tail.
- The AC block holds the text of `results/evidence/AC5.md`.
- The GitHub body and the GitLab body are byte-equal.
- The `## heading` and `**bold**` log lines inside the fence do not end the Evidence section: EVID01, EVID03 and EVID04 do not fail.
- A case with no head `command.log` and an old ledger with no log field still build a block with the results and no error.
- SIZE01 does not fail for long text inside `<details>`, fails for the same text outside, and an unclosed `<details>` does not hide the rest of the body.
- `bun test test/pr-writing.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is Markdown text; no screenshot applies.
