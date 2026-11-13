---
id: ARK-T364
title: ARK-T364 a body over the GitHub limit from plan cases alone has its log tails cut first, says how many lines were left out, and keeps the AC evidence
level: integration
technique: boundary values (uncut body of 65,535, exactly 65,536 and 65,537 characters, plus a far-over body) with the cut as the state transition
priority: high
risk: a body made only of plan cases is still over the limit, so open refuses on length; or the cut removes AC evidence blocks or result lines instead of log tails; or the body is cut silently, so a reader thinks the logs are whole; or a body under the limit loses its tails
status: active
changed_by: 2026-11-13-ARK-446-1
---

## Objective

Prove that when the evidence of the plan's own cases makes the body longer than the limit, `buildBody` cuts log tails first, ends under `githubBodyLimit`, says how many lines it left out, and keeps each AC evidence block and each case result line whole.

## Preconditions

- A run folder in a scratch folder with enough plan cases (about 150, each in `plan.yml` `test_cases`) with a 20-line `head/command.log` of short lines (no `secretLike` words), so the uncut body is over 65,536 characters.
- Two AC evidence files, `results/evidence/AC1.md` and `AC2.md`.
- A second run folder with 3 plan cases, whose uncut body is under the limit.
- Three boundary runs: a plan case set with a 20-line log whose uncut body is padded, with the text of `ticket.md` problem, to exactly 65,535, 65,536 and 65,537 characters (measure the uncut length first, then pad the difference).
- The real ledger reader, `buildBody` and `githubBodyLimit`. No mocks.

## Steps

1. Build the large run folder and build the body with `buildBody`.
2. Measure the body length, and find the note about the cut and each result line (`ARK-T<n>: base X, head Y @ sha`).
3. Count the AC evidence blocks.
4. Build the small run folder and build its body.
5. Build the three boundary runs and measure each body and look for the note about a cut.

## Expected results

- When the body would be over `githubBodyLimit`, the system shall cut log tails first, and the body shall be at most `githubBodyLimit` characters.
- The body shall say how many log lines were left out, and that count shall equal the lines missing from the logs.
- The body shall keep one block for each AC evidence file, whole, and one result line for each plan case.
- The note about the cut shall not read as a test case claim and shall add no screenshot path.
- A body whose uncut length is 65,535 or 65,536 characters shall be left whole with no note; one of 65,537 characters shall be cut to at most 65,536 characters and shall carry the note. A cut at a margin below the limit, or at `>=`, fails this.
- When the body is under the limit, the system shall cut no line and shall show no note about a cut.

## Screenshot checkpoints

none: integration case on the text of a built body.
