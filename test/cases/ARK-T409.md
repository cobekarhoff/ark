---
id: ARK-T409
title: ARK-T409 the spec built for a step of each plan role starts that role's own skill by name, and that name is a skill that exists
level: integration
technique: "equivalence classes (one step of each plan role: implementer, validator, reviewer; skill name matches a skill folder; spec names the old router form)"
priority: high
risk: "the first line of the spec of an implementer, validator or reviewer worker still starts the old router skill (or a misspelled role skill name) after the router is deleted, so every plan step starts on a skill omp does not list and gets no role instructions"
status: active
changed_by: 2026-11-14-ARK-414-1
---

## Objective

Prove that `buildSpec` (the text every worker of `ark run step <run> <step> start` starts from) names the skill of the step's role by its own name, that this name is the `name` of a skill folder in the repo, and that the line that states the role and the step stays. Extra protection for ARK-414 AC4 (`method: inspection`): the case guards the same defect as ARK-T407, with a wider reach, because this call site serves every plan step.

Expected: When the spec of a plan step is built, the system shall start the skill ark-<role> of the step's role, and shall not start it through the old router form.

## Preconditions

- A run with a plan holding one step of each plan role (`implementer`, `validator`, `reviewer`), as the fixture of `test/reviewed-head.test.ts` (`openRun`, `planStep`, `specOf`) builds it.
- The repo holds `skills/ark-implementer/SKILL.md`, `skills/ark-validator/SKILL.md` and `skills/ark-reviewer/SKILL.md`, each with a `name` front matter key.

## Steps

1. For each plan role, build the spec of that role's step through `buildSpec`.
2. For each role, read `name` from the front matter of `skills/ark-<role>/SKILL.md`.

## Expected results

- The first line of each spec is `/skill:<name> <run> <step>` with the `name` read in step 2 (`ark-implementer`, `ark-validator`, `ark-reviewer`) and the run and step ids of the fixture.
- No spec contains the old router form: `/skill:ark` followed by a space and `worker`.
- The second line of each spec stays `You are the <ROLE> for step <step> of run <run>.` with `<ROLE>` the upper-case role (`IMPLEMENTER`, `VALIDATOR`, `REVIEWER`).
- The expected skill names come from the skill files, not from a literal copied out of `cli/spec.ts`. A rename of a folder or a typo in the spec fails the case.
- The case asserts the skill line and the role line only. The `Last reviewed head` contract stays with ARK-T302.

## Screenshot checkpoints

none: a CLI spec-text case; there is no UI surface.
