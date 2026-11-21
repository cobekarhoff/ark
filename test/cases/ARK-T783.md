---
id: ARK-T783
title: ARK-T783 lint PROV02 passes a body or commit that has `regenerated with` or a mid-sentence `generated with`, and still fails the same body once it holds a `Generated with` trailer line
level: integration
technique: equivalence classes (a trailer line against text that holds the same words) with a paired control, boundary values (`Re` prefix, `without` suffix, start of line against mid-line)
priority: high
risk: PROV02 matches the words `generated with` anywhere in a line, in any case, so an MR whose criterion line says `docs/reference/cli.md regenerated with ...` is refused by `ark merge-request open` and the run reworded its AC to open its MR (ARK-622); or the fix turns the rule off, so a trailer line passes with it
status: active
changed_by: 2026-11-21-ARK-629-1
---

## Objective

Prove that `lintBody` returns `pass` for PROV02 when the words `generated with` appear in a body or in a commit message of the range, no line starts with the trailer `Generated with` and no line is a model `Co-Authored-By` line. Serves ARK-629/AC1.

Expected: When no line of the body or of a commit message in the range starts, after optional spaces and an optional emoji, with `Generated with`, and no line is a model `Co-Authored-By` line, the system shall return `pass` for PROV02.

Question 3 (why existing proof misses it): ARK-T39 owns the failing side of PROV02 (every trailer shape fails). It holds no body or commit with the same words in another place, so a rule that matches the words anywhere passes it. This case owns the false match and nothing else. The failing trailer shapes, the emoji line and the reason text stay with ARK-T39.

Question 4: no hook. The input is a body and a ledger that `lintBody` takes, the way ARK-T39 builds them. The path of the ARK-622 refusal (`ark merge-request open`, cli/merge-request.ts) reads the same `LintResult`, so a second case at that command adds no distinct risk.

## Preconditions

- The PROV02 control body of `test/fixtures/pr-writing/lint/PROV02/control.md` and its ledger (`loadFixture("PROV02", "control")` in `test/pr-writing.test.ts`). It passes PROV02 and has no `Generated with` text.
- Each input below is that control body with one added line, or the ledger with one commit message. A new fixture file in the PROV02 folder is allowed; the folder keeps `fail.md` and `control.md` for ARK-T39.

## Steps

1. Add to the control body, as a criterion bullet, the line ``- AC1: `docs/reference/cli.md` regenerated with `bun scripts/cli-reference.ts` `` (the text of ARK-622). Lint. Read PROV02.
2. Add a body line with `generated with` in the middle of a sentence: `The cache file is generated with bun at build time.` Lint. Read PROV02.
3. Boundary lines, one body each: `Regenerated with bun scripts/cli-reference.ts` (the words start the line, the `Re` prefix), `generated with bun` (lower case at the start of the line), `The page is Generated with care.` (the capital in the middle), and `Generated without review` (the word `with` is the start of another word).
4. Put the line of step 1 in a commit message of the ledger range (a commit with the subject `ARK-316: fix` and the body line ``docs/reference/cli.md regenerated with `bun scripts/cli-reference.ts` ``). Lint. Read PROV02.
5. Negative control: add the line `Generated with Claude Code` as its own line to the body of step 1 after the false-match line. Lint. Read PROV02.
6. Run `bun test test/pr-writing.test.ts -t ARK-T783` after the validator writes the test. Until then no output of that command exists: this is a plan.

## Expected results

- Steps 1 to 4: PROV02 returns `pass` for each input, and every other check returns the same result as for the control body.
- Step 5: PROV02 returns `fail` and its reason names `Generated with Claude Code`, not the `regenerated with` line. It proves that steps 1 to 4 pass because of the rule and not because PROV02 is off or skipped.
- At base the rule is `/^.*Generated with.*$/im`. Run against these strings it matched each of them: the step 1 line, the step 2 line, `Regenerated with bun`, `generated with bun`, `The page is Generated with care.` and `Generated without review`. On the step 5 body (false-match line first) it returned the `regenerated with` line, so step 5 names the wrong line at base. The validator records the base run of the test before the fix lands.
- The test fails when the rule drops the `^` anchor (the `The page is Generated with care.` line of step 3; steps 1, 2 and 4 hold only lower-case `generated with`, so they catch a dropped anchor only together with the `i` flag), keeps the `i` flag (the `generated with bun` line of step 3), or has no boundary after `with` (the `Generated without review` line of step 3).

## Screenshot checkpoints

None. The surface is lint output (JSON and text); no screenshot applies.
