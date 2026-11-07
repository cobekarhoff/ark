---
id: ARK-T40
title: ARK-T40 lint warns on judgment checks and sets the tier
level: integration
technique: one fixture per check id with a corrected control, and boundary values on changed lines (20, 21, 149, 150, 399, 400)
priority: medium
risk: a judgment check fails instead of warning and blocks a valid MR, a warning never shows, or the tier is wrong at a boundary or for a sensitive path so the size ceiling is too tight or too loose
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that the judgment checks of AC6 warn on their offending input and not on the corrected control, and that the tier follows changed lines, sensitive paths, a reason line and `tier_floor`. Serves ARK-316/AC6.

Expected: When the diff touches a sensitive path, the system shall keep the tier above 0 and give the reason.

## Preconditions

- One fixture folder per warning check id under `test/fixtures/pr-writing/lint/<check id>/`, each with an offending body (plus ledger and diff where the step names them) and a corrected control:
  - `test/fixtures/pr-writing/lint/TITLE01-imperative/` holds the offending input of step 2 and its corrected control.
  - `test/fixtures/pr-writing/lint/DIFF01/` holds the offending input of step 3 and its corrected control.
  - `test/fixtures/pr-writing/lint/EVID01/` holds the offending input of step 4 and its corrected control.
  - `test/fixtures/pr-writing/lint/EVID03/` holds the offending input of step 5 and its corrected control.
  - `test/fixtures/pr-writing/lint/VAL02/` holds the offending input of step 6 and its corrected control.
  - `test/fixtures/pr-writing/lint/RISK01/` holds the offending input of step 7 and its corrected control.
  - `test/fixtures/pr-writing/lint/SEC01/` holds the offending input of step 8 and its corrected control.
  - `test/fixtures/pr-writing/lint/ELI01/` holds the offending input of step 9 and its corrected control.
- Fixture diffs of 20, 21, 149, 150, 399 and 400 changed lines with no sensitive path; a 5-line diff that touches `cli/gate.ts` (in `sensitive_paths`); a 5-line diff on a non-sensitive file, `cli/helpers.ts`.

## Steps

1. Run lint on the good body. Check that none of the eight checks warns.
2. TITLE01-imperative: the title `ARK-316: Fixed stale MR bodies` and the title `ARK-316: Fixes stale MR bodies` (each warn); control `ARK-316: Fix stale MR bodies` (pass).
3. DIFF01 (warn: the stated change is not supported by the three-dot diff): the diff changes only `cli/events.ts` (12 lines) and the body says `Adds a retry loop to cli/gate.ts` (warn; reason names `cli/gate.ts`). Control: the body names `cli/events.ts`.
4. EVID01 (warn: the evidence does not fit the ticket `kind`): `kind: bug` with an evidence section that shows the AC test passing at head and says nothing about base (warn); `kind: perf` with an evidence section that names neither `baseline.md` nor `compare.md` (warn). Control: bug evidence with fail at base and pass at head; perf evidence naming both files.
5. EVID03 (warn: an evidence claim has no run artifact for its case and head): the body claims `ARK-T5: base fail, head pass @ abc1234` and `results/evidence/` has no `ARK-T5` folder (warn; reason names `ARK-T5`); the folder exists but its head result is for SHA `deadbee` (warn; reason names the head). Control: folder and SHA match.
6. VAL02 (warn: a verify item has no backticked command or no `Expect` clause): `- [ ] run the tests` (warn; no command) and ``- [ ] `bun test` `` (warn; no `Expect`). Control: ``- [ ] `bun test test/pr-writing.test.ts`. Expect: exits 0``.
7. RISK01 (warn: the risk and revert text is missing or too vague): a diff on `cli/events.ts` with the risk section `Risk: low.` and no revert text (warn). Control: the section says which events a bad change would corrupt and names `git revert <sha>`. The fixtures break none of RISK02-RISK04.
8. SEC01 (warn: a security-relevant diff has no security note): a diff that adds a line reading `process.env.GH_TOKEN` and sending it in an `Authorization` header, a body with no security note (warn). Control: the body has `Security: the token comes from the env and is never logged.`
9. ELI01 (warn: the problem text is jargon or implementation-only): problem text `Refactors the reducer so memoized selectors no longer invalidate on shallow-equal args.` (warn). Control: `An MR body listed a bug that was already fixed, so reviewers chased a problem that was gone.`
10. Compute the tier for a 20-line diff, a 21-line diff, 149, 150, 399 and 400 lines.
11. Compute the tier for the 5-line diff on `cli/gate.ts` with no reason line and `tier_floor: 0`.
12. Compute the tier for the 5-line diff on non-sensitive `cli/helpers.ts`: with no raise requested; with a raise and a reason line `raise: parser change`; with a raise and no reason line.
13. Compute the tier of a 5-line diff with `tier_floor: 2`, and of a 400-line diff with `tier_floor: 1`.
14. Run `bun test test/pr-writing.test.ts`.

## Expected results

- Each offending input returns `warn` (never `fail`) for its own check id with a reason that names its cause (the file, the missing evidence kind or case, the item, the vague text). The control returns `pass`.
- Tier by changed lines with no sensitive path: 20 lines is tier 0 (20 or less); 21 and 149 are tier 1 (under 150); 150 and 399 are tier 2 (under 400); 400 is tier 3.
- The 5-line diff on `cli/gate.ts` is above tier 0 (tier 1) with no raise requested, and the result carries a reason that names the sensitive path `cli/gate.ts`. A missing reason line never puts it back at tier 0.
- The discretionary raise is tested on the non-sensitive diff only: no raise is tier 0; a raise with a reason line is above tier 0; a raise without a reason line is ignored and the tier stays 0.
- The tier is never below `tier_floor`: the 5-line diff with `tier_floor: 2` is tier 2; the 400-line diff with `tier_floor: 1` stays tier 3.
- `bun test test/pr-writing.test.ts` exits 0 and runs each fixture.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
