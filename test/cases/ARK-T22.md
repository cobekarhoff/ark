---
id: ARK-T22
title: ARK-T22 lint warns on judgment checks and sets the tier
level: integration
technique: one fixture per check id and boundary values on changed lines (20, 21, 149, 150, 399, 400)
priority: medium
risk: a judgment check fails instead of warning and blocks a valid MR, a warning never shows, or the tier is wrong at a boundary so the size ceiling is too tight or too loose
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that the judgment checks of AC6 warn on their fixtures, and that the tier follows changed lines, sensitive paths, a reason line and `tier_floor`. Serves ARK-316/AC6.

Expected: When the diff touches a sensitive path, the system shall raise the tier above 0.

## Preconditions

- One fixture folder per warning check id under `test/fixtures/pr-writing/lint/<check id>/`, one fixture per check id of AC6's warn list:
  - `test/fixtures/pr-writing/lint/TITLE01-imperative/` holds one body that triggers TITLE01-imperative.
  - `test/fixtures/pr-writing/lint/DIFF01/` holds one body that triggers DIFF01.
  - `test/fixtures/pr-writing/lint/EVID01/` holds one body that triggers EVID01.
  - `test/fixtures/pr-writing/lint/EVID03/` holds one body that triggers EVID03.
  - `test/fixtures/pr-writing/lint/VAL02/` holds one body that triggers VAL02.
  - `test/fixtures/pr-writing/lint/RISK01/` holds one body that triggers RISK01.
  - `test/fixtures/pr-writing/lint/SEC01/` holds one body that triggers SEC01.
  - `test/fixtures/pr-writing/lint/ELI01/` holds one body that triggers ELI01.
- The warn list is: TITLE01-imperative, DIFF01, EVID01, EVID03, VAL02, RISK01, SEC01, ELI01.
- Fixture diffs of 20, 21, 149, 150, 399 and 400 changed lines with no sensitive path, and a 5-line diff that touches a path from `sensitive_paths` (for example `cli/gate.ts`).

## Steps

1. Run lint on each warning fixture. Read the result for that check id.
2. Run lint on the good body. Check that none of the eight checks warns.
3. Compute the tier for a 20-line diff, a 21-line diff, 149, 150, 399 and 400 lines.
4. Compute the tier for the 5-line diff on a sensitive path, with and without a reason line for the raise.
5. Compute the tier of a 5-line diff with `tier_floor: 2`, and of a 400-line diff with `tier_floor: 1`.
6. Run `bun test test/pr-writing.test.ts`.

## Expected results

- Each fixture returns `warn` (never `fail`) for its own check id with a reason: TITLE01-imperative, DIFF01, EVID01, EVID03, VAL02, RISK01, SEC01, ELI01.
- The good body gives no warning on those checks.
- Tier by changed lines with no sensitive path: 20 lines is tier 0 (20 or less); 21 and 149 are tier 1 (under 150); 150 and 399 are tier 2 (under 400); 400 is tier 3.
- The 5-line diff on a sensitive path is raised above tier 0, and the raise carries a reason line. A raise without a reason line is not applied.
- The tier is never below `tier_floor`: the 5-line diff with `tier_floor: 2` is tier 2; the 400-line diff with `tier_floor: 1` stays tier 3.
- `bun test test/pr-writing.test.ts` exits 0 and runs each fixture.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
