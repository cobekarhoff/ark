---
id: ARK-T270
title: ARK-T270 the run-lead playbook's analysis evidence example and Not in plan example pass the real lint
level: integration
technique: equivalence classes (accepted shape vs refused shape), example extracted from the document
priority: medium
risk: the playbook example of an analysis evidence section or of a `Not in plan` line is shaped so the real check refuses it (wrong heading level, empty Base or Head, wrong separator, reason in a later Merge risk block), so a lead who copies it is refused by `ark merge-request open` anyway
status: active
changed_by: 2026-11-11-ARK-421-1
---

## Objective

Prove that the example sections that section 8 of `skills/ark/playbooks/run-lead.md` gives for an analysis evidence file and for a RISK04 reason are accepted by the code that enforces them (`evidenceProblem` in `cli/ticket.ts`, and RISK04 in `skills/pr-writing/lib/lint.ts` through `parseReviewerBlock`), not only well-formed prose.

## Preconditions

- The edited `skills/ark/playbooks/run-lead.md` read from disk. No fake: the real functions run.
- A complete control evidence file for a `method: analysis` criterion with all four sections (`## Command`, `## Output`, `## Threshold`, `## Result`), each with `Base: ok` and `Head: ok` paragraphs. `evidenceProblem("analysis", control)` reports no problem (checked first, so a later refusal is the example's doing).
- A fixture reviewer findings file with a changed file outside every plan `where` list.

## Steps

1. Extract the example section from section 8 (its heading name and its content, unchanged). Replace the matching section of the control with it, keeping the other three control sections. Call `evidenceProblem("analysis", ...)`.
2. Only if the example uses `Base`/`Head` subheadings: raise the Base heading to the level of the section heading and call `evidenceProblem` again. If the example uses `Base: text` paragraphs, skip this step.
3. Remove the Base paragraph from the example section in the same control and call `evidenceProblem`.
4. Take the example `Not in plan` line from section 8, put it in the first `## Merge risk` block of the findings file, and run the RISK04 lint on a body that lists the unplanned file.
5. Move the same line to a second `## Merge risk` block appended after the first (first block without it), and run the lint again.

## Expected results

- The control alone and the control with the example section swapped in shall report no problem (the example is one section, the other three come from the control).
- Where step 2 applies, the same-level Base heading shall report `section "<name>" has no Base`.
- The control with the example's Base paragraph removed shall report `section "<name>" has no Base`.
- The example `Not in plan` line in the first block shall give the file a reason, and RISK04 shall not fail.
- The same line in a second block shall be ignored, and RISK04 shall fail with `no reason given`, so the playbook's statement that the lint reads the first block is true.

## Screenshot checkpoints

none: integration case on function results; no UI.
