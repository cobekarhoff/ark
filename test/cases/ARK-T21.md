---
id: ARK-T21
title: ARK-T21 lint fails each decidable check on its fixture
level: integration
technique: one fixture per check id (equivalence classes), boundary values for SIZE01 and TITLE01
priority: high
risk: a decidable check never fails (a secret, a Co-Authored-By line, a stale body or a missing Not done gap reaches the MR), or a good body fails
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that `lint.ts` returns, for every check, its id, a result (`fail`, `warn`, `pass` or `skip`) and a reason, and that each decidable check of AC6 fails on its own fixture. Serves ARK-316/AC6.

Expected: When a body breaks a decidable check, the system shall return `fail` for that check id.

## Preconditions

- One fixture folder per failing check id under `test/fixtures/pr-writing/lint/<check id>/`, one fixture per check id of AC6's fail list:
  - `test/fixtures/pr-writing/lint/PROV01/` holds one body that triggers PROV01.
  - `test/fixtures/pr-writing/lint/PROV02/` holds one body that triggers PROV02.
  - `test/fixtures/pr-writing/lint/TITLE01/` holds one body that triggers TITLE01.
  - `test/fixtures/pr-writing/lint/SIZE01/` holds one body that triggers SIZE01.
  - `test/fixtures/pr-writing/lint/SIZE02/` holds one body that triggers SIZE02.
  - `test/fixtures/pr-writing/lint/REF01/` holds one body that triggers REF01.
  - `test/fixtures/pr-writing/lint/REF02/` holds one body that triggers REF02.
  - `test/fixtures/pr-writing/lint/VAL01/` holds one body that triggers VAL01.
  - `test/fixtures/pr-writing/lint/VAL03/` holds one body that triggers VAL03.
  - `test/fixtures/pr-writing/lint/RISK02/` holds one body that triggers RISK02.
  - `test/fixtures/pr-writing/lint/RISK03/` holds one body that triggers RISK03.
  - `test/fixtures/pr-writing/lint/FMT01/` holds one body that triggers FMT01.
  - `test/fixtures/pr-writing/lint/FMT02/` holds one body that triggers FMT02.
  - `test/fixtures/pr-writing/lint/STALE01/` holds one body that triggers STALE01.
- The fail list is: PROV01, PROV02, TITLE01, SIZE01, SIZE02, REF01, REF02, VAL01, VAL03, RISK02, RISK03, FMT01, FMT02, STALE01.
- A good body fixture that breaks none of them, and a ledger for each fixture (tier, gaps, head SHA, commit range, flags).

## Steps

1. Run lint on the good body. Read every result.
2. For each fixture of the list above, run lint and read the result for that check id.
3. PROV01: the fixture has the provenance line second, and a second fixture variant has a line that matches none of the three variants.
4. PROV02: a fixture with a `Co-Authored-By: <model>` line in the body; one with `Generated with` in the body; one with such a line only in a commit of the range.
5. TITLE01: a title of 72 characters (pass), 73 characters (fail), a trailing period (fail), a title that breaks the `title_prefix` rule (fail).
6. SIZE01: count prose lines outside code fences against the ceiling of each tier, 3, 12, 40, 150 for tiers 0-3: at the ceiling (pass) and one line above (fail), for each tier. Lines inside a code fence do not count.
7. SIZE02: a tier 0 body with a heading (fail); a tier 1 body with headings (pass).
8. REF01 and REF02: run each fixture and read the reason it gives.
9. VAL01: a body with no `- [ ]` item (fail). VAL03: a ledger gap (an open finding) that does not appear under `Not done` (fail).
10. RISK02: a ledger with the migration flag and a body that names no rollback (fail). RISK03: a ledger with a CI file flag and a body with no note of it (fail).
11. FMT01: a paragraph hard-wrapped at 80 columns (fail), and the same text inside a code fence, a list, a quote and a table (pass).
12. FMT02: a body with a token starting `AKIA`, one with `ghp_`, one with `glpat-`, one with `xox`, one with `-----BEGIN` (each fail).
13. STALE01: a ledger head SHA that differs from the current head (fail); a body hash that differs from the linted body (fail); both equal (pass).
14. Run `bun test test/pr-writing.test.ts`.

## Expected results

- Every result has an `id`, one of `fail`, `warn`, `pass`, `skip`, and a non-empty reason.
- The good body returns no `fail`.
- Each fixture returns `fail` for its own check id with a reason that names the cause: PROV01, PROV02, TITLE01, SIZE01, SIZE02, REF01, REF02, VAL01, VAL03, RISK02, RISK03, FMT01, FMT02, STALE01.
- Boundaries: TITLE01 passes at 72 and fails at 73 characters. SIZE01 passes at 3, 12, 40 and 150 prose lines for tiers 0, 1, 2 and 3, and fails at 4, 13, 41 and 151.
- SIZE02 fails for a heading at tier 0 only. FMT01 fails only for a hard-wrapped paragraph outside fences, lists, quotes and tables. FMT02 fails for each of the five known prefixes.
- PROV02 fails for a model `Co-Authored-By` or `Generated with` line in the body, and in the commit range.
- STALE01 fails when the head SHA or the body hash differs, and passes when both are equal.
- `bun test test/pr-writing.test.ts` exits 0 and runs each fixture.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
