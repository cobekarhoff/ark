---
id: ARK-T21
title: ARK-T21 lint fails each decidable check on its fixture
level: integration
technique: one fixture per check id (equivalence classes) with a corrected control for each, boundary values for SIZE01 and TITLE01
priority: high
risk: a decidable check never fails (a secret, a Co-Authored-By line, a missing tracker or dependency ref, a stale body or a missing Not done gap reaches the MR), or a good body fails
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that `lint.ts` returns, for every check, its id, a result (`fail`, `warn`, `pass` or `skip`) and a reason, and that each decidable check of AC6 fails on its own offending input and passes on its corrected control. Serves ARK-316/AC6.

Expected: When a body breaks a decidable check, the system shall return `fail` for that check id.

## Preconditions

- One fixture folder per failing check id under `test/fixtures/pr-writing/lint/<check id>/`: PROV01, PROV02, TITLE01, SIZE01, SIZE02, REF01, REF02, VAL01, VAL03, RISK02, RISK03, FMT01, FMT02, STALE01. Each holds an offending body and a corrected control body that differs from it only in the cause:
  - `test/fixtures/pr-writing/lint/PROV01/` holds the failing input of step 3 and its corrected control.
  - `test/fixtures/pr-writing/lint/PROV02/` holds the failing input of step 4 and its corrected control.
  - `test/fixtures/pr-writing/lint/TITLE01/` holds the failing input of step 5 and its corrected control.
  - `test/fixtures/pr-writing/lint/SIZE01/` holds the failing input of step 6 and its corrected control.
  - `test/fixtures/pr-writing/lint/SIZE02/` holds the failing input of step 7 and its corrected control.
  - `test/fixtures/pr-writing/lint/REF01/` holds the failing input of step 8 and its corrected control.
  - `test/fixtures/pr-writing/lint/REF02/` holds the failing input of step 9 and its corrected control.
  - `test/fixtures/pr-writing/lint/VAL01/` holds the failing input of step 10 and its corrected control.
  - `test/fixtures/pr-writing/lint/VAL03/` holds the failing input of step 10 and its corrected control.
  - `test/fixtures/pr-writing/lint/RISK02/` holds the failing input of step 11 and its corrected control.
  - `test/fixtures/pr-writing/lint/RISK03/` holds the failing input of step 11 and its corrected control.
  - `test/fixtures/pr-writing/lint/FMT01/` holds the failing input of step 12 and its corrected control.
  - `test/fixtures/pr-writing/lint/FMT02/` holds the failing input of step 13 and its corrected control.
  - `test/fixtures/pr-writing/lint/STALE01/` holds the failing input of step 14 and its corrected control.
- A good body fixture that breaks none of them, and a ledger for each fixture (tier, gaps, head SHA, commit range, flags, tracker refs, dependency and merge-order refs).
- Ledger for REF01/REF02: tracker refs `ARK-316` and `ARK-77`; `Depends on ARK-311`; merge order `ARK-311` then `ARK-316`.

## Steps

1. Run lint on the good body. Read every result.
2. For each fixture, run lint on the offending body, then on the control, and read the result for that check id.
3. PROV01: provenance line second (fail); a first line that matches none of the three variants, for example `> Written by an AI.` (fail); control: the exact first line of a variant.
4. PROV02: `Co-Authored-By: Claude <noreply@anthropic.com>` in the body (fail); `Generated with Claude Code` in the body (fail); the same line only in a commit message of the range (fail); control: none of them.
5. TITLE01: a title of 72 characters (pass), 73 characters (fail), `ARK-316: Fix stale bodies.` with a trailing period (fail), and with `title_prefix: "feat(TICKET): desc"` the title `ARK-316: Fix stale bodies` (fail; the prefix rule is broken) against `feat(ARK-316): Fix stale bodies` (pass).
6. SIZE01: count prose lines outside code fences against the ceiling of each tier, 3, 12, 40, 150 for tiers 0-3: at the ceiling (pass) and one line above (fail), for each tier. Lines inside a code fence do not count.
7. SIZE02: a tier 0 body with a heading (fail); a tier 1 body with headings (pass).
8. REF01 (fail: a tracker ref of the ledger is missing from the body or contradicted): the body never names `ARK-77` (fail; reason names `ARK-77` as missing); the body says `Closes ARK-78` where the ledger holds `ARK-77` (fail; reason names the contradiction). Control: the body names `ARK-316` and `ARK-77`.
9. REF02 (fail: a dependency or merge-order ref of the ledger is missing or contradicted): the body has no `Depends on ARK-311` line (fail; reason names `ARK-311`); the body says `Depends on ARK-312`, or lists the merge order `ARK-316` before `ARK-311` (fail; reason names the contradicting ref). Control: `Depends on ARK-311` and the order `ARK-311`, `ARK-316`.
10. VAL01: a body with no `- [ ]` item (fail); control with one. VAL03: a ledger gap (an open P2 finding) that does not appear under `Not done` (fail); control lists it.
11. RISK02: a ledger with the migration flag and a body that names no rollback (fail); control names the rollback. RISK03: a ledger with a CI file flag (`.github/workflows/ci.yml` in the diff) and a body with no note of it (fail); control notes it.
12. FMT01: a paragraph hard-wrapped at 80 columns (fail), and the same text inside a code fence, a list, a quote and a table (pass).
13. FMT02: a body with a token starting `AKIA`, one with `ghp_`, one with `glpat-`, one with `xox`, one with `-----BEGIN` (each fail; synthetic values). Control: none.
14. STALE01: a ledger head SHA that differs from the current head (fail); a body hash that differs from the linted body (fail); both equal (pass).
15. Run `bun test test/pr-writing.test.ts`.

## Expected results

- Every result has an `id`, one of `fail`, `warn`, `pass`, `skip`, and a non-empty reason.
- The good body returns no `fail`, and every control returns `pass` for its check id.
- Each offending body returns `fail` for its own check id with a reason that names the cause. The reasons name: the failing line or the second-place provenance (PROV01); the matching line and whether it came from the body or from the commit range (PROV02); the length, the trailing period or the broken prefix (TITLE01); the counted lines against the ceiling (SIZE01); the heading (SIZE02); the missing or contradicting ref, `ARK-77` or `ARK-78` (REF01); the missing or contradicting dependency or order, `ARK-311` or `ARK-312` (REF02); the missing item (VAL01); the unlisted gap (VAL03); the missing rollback (RISK02); the missing CI note (RISK03); the wrapped paragraph (FMT01); the token prefix (FMT02); the SHA or hash that differs (STALE01).
- Boundaries: TITLE01 passes at 72 and fails at 73 characters. SIZE01 passes at 3, 12, 40 and 150 prose lines for tiers 0, 1, 2 and 3, and fails at 4, 13, 41 and 151.
- SIZE02 fails for a heading at tier 0 only. FMT01 fails only for a hard-wrapped paragraph outside fences, lists, quotes and tables. FMT02 fails for each of the five known prefixes.
- PROV02 fails for a model `Co-Authored-By` or `Generated with` line in the body, and in the commit range.
- STALE01 fails when the head SHA or the body hash differs, and passes when both are equal.
- `bun test test/pr-writing.test.ts` exits 0 and runs each fixture.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
