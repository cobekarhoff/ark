# Evidence and lint checks

What counts as evidence in an MR or PR body, and every check `lint_body.ts` runs. Result is `fail` (decidable, refuses the post), `warn` (judgment, never refuses) or `skip` (does not apply). Source: `skills/pr-writing/lib/lint.ts`.

## What counts as evidence

| Claim in the body              | Evidence the reader can check                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| "tests pass"                   | The command and its result line, for example `bun test` and `42 pass, 0 fail`. Paste the output of `review.ts`. |
| "bug fixed"                    | A test that fails at base and passes at head, with both results.                                                |
| "refactor, no behavior change" | The same test passing at base and at head.                                                                      |
| "faster"                       | Baseline and compare numbers, with n, the machine and the bounds.                                               |
| "works in the UI"              | Screenshot files named in the body, 5 at most. Captures are not built yet: add them by hand.                    |
| "not tested"                   | `Not run: <what>, <reason>`. This is evidence of honesty and is welcome.                                        |
| "[x] Self-review completed"    | None. Delete it or name the command.                                                                            |
| "passed three runs in a row"   | The three commands and their result lines, or drop the claim.                                                   |

## Lint checks

| Id                   | Result | What it wants                                                                                                                                     |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| PROV01               | fail   | First line is a provenance variant naming the token owner (`> Written by an AI agent on behalf of @handle...`), unless `agent_authored` is false. |
| PROV02               | fail   | No model `Co-Authored-By` and no `Generated with` line in the body or the commits of the range.                                                   |
| TITLE01              | fail   | Title is 72 characters or less, has no trailing period, and matches `title_prefix` when set.                                                      |
| TITLE01 (imperative) | warn   | The first word is imperative (`Fix`, not `Fixed` or `Fixes`).                                                                                     |
| SIZE01               | fail   | Prose lines at most 3, 12, 40 or 150 for tier 0 to 3.                                                                                             |
| SIZE02               | fail   | No headings at tier 0, unless the repo template names headings.                                                                                   |
| REF01                | fail   | Every tracker ref of the branch or commits is in the body, and no `Closes X` names another ref.                                                   |
| REF02                | fail   | `Depends on` and merge order lines match the ledger.                                                                                              |
| DIFF01               | fail   | Every file path the body names is in the diff.                                                                                                    |
| EVID01               | warn   | Bug: fail at base, pass at head. Refactor: pass at both. Perf: baseline and compare files. Skipped outside an Ark ticket.                         |
| EVID03               | warn   | A claimed test case result matches an artifact for that case and head. Skipped outside Ark.                                                       |
| EVID04               | warn   | At most 5 screenshots in Evidence. Fails with no Evidence section when the run has `results/evidence/`.                                           |
| VAL01                | fail   | A `- [ ]` item under How to verify (or Testing).                                                                                                  |
| VAL02                | warn   | Each verify item has a backticked command and an `Expect` clause.                                                                                 |
| VAL03                | fail   | A Not done section lists every gap the ledger finds.                                                                                              |
| RISK01               | warn   | Risk text names what breaks and a `git revert` step.                                                                                              |
| RISK02               | fail   | A migration file in the diff has a rollback named.                                                                                                |
| RISK03               | fail   | A CI file in the diff is named in the body.                                                                                                       |
| RISK04               | fail   | Ark runs only: reviewer block present, one-way door has a recovery, unplanned files have reasons (any reviewer findings file may give it).        |
| FMT01                | fail   | No hard-wrapped paragraph.                                                                                                                        |
| FMT02                | fail   | No known token prefix (`AKIA`, `ghp_`, `glpat-`, `xox`, `-----BEGIN`).                                                                            |
| STALE01              | fail   | The ledger head equals the branch head, and the body equals the body that was linted.                                                             |
| SEC01                | warn   | A diff that touches a token, credential or auth line has a Security note.                                                                         |
| ELI01                | warn   | The problem text is in plain words, not implementation verbs and jargon.                                                                          |
| VOICE01              | warn   | The body is written about the system: no process role (`run lead`, `agent`, `the human`) or first person outside the provenance line.             |
