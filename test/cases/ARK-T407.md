---
id: ARK-T407
title: ARK-T407 the prompt that ark chief handover gives the new Master Chief starts the skill ark-chief by its own name, and that name is a skill that exists
level: integration
technique: equivalence classes (prompt names the role skill, prompt names the old router form, skill name matches a skill folder)
priority: high
risk: "the handover prompt still starts the new Master Chief through the old router skill (or a misspelled role skill name) after the router is deleted, so it runs on a skill omp does not list, with no chief instructions, while the old terminal is already told to exit"
status: active
changed_by: 2026-11-14-ARK-414-1
---

## Objective

Prove that `ark chief handover` launches the new Master Chief with a prompt that starts the skill `ark-chief` by its own name, and that this name is the `name` of a skill folder in the repo. Covers ARK-414 AC3.

Expected: When `ark chief handover` starts a new Master Chief, the system shall give it a prompt that starts the skill ark-chief, and shall not start it through the old router form.

## Preconditions

- The fake `orca` of `test/chief.test.ts` (`setScenario`, `callsTo`) with one Master Chief Run for the project (objective `Master Chief: <project> tickets`), one live connected Master Chief terminal in the workspace, and `agent launch --surface terminal` answering with a terminal handle.
- `ark.yml` of the test project sets `roles.chief` (harness and model).
- The repo holds `skills/ark-chief/SKILL.md` with a `name` front matter key.

## Steps

1. Run `ark chief handover --project <project>` with the fake orca.
2. Read the single `orca agent launch` call and take the value after `--prompt`.
3. Read `name` from the front matter of `skills/ark-chief/SKILL.md`.

## Expected results

- The command exits 0 and prints the new terminal handle; exactly one `agent launch` call is made.
- The prompt contains `/skill:` followed by the `name` read in step 3 (`ark-chief`), as the instruction that starts the role.
- The prompt does not contain the old router form: `/skill:ark` followed by a space and `chief`.
- The expected skill name comes from the skill file, not from a literal copied out of `cli/chief.ts`. A rename of the folder or a typo in the prompt fails the case.
- The case asserts the skill name only. The wait, the run-use and the refusal contracts stay with the ARK-244 handover tests.

## Screenshot checkpoints

none: a CLI case with a fake orca; there is no UI surface.
