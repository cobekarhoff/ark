---
id: ARK-T157
title: ARK-T157 config load refuses a role whose harness is not claude, codex, omp or pi, and names the role and the four harnesses
level: integration
technique: equivalence classes (valid harness x4, misspelled harness, empty-looking name) and boundary values (case and near-miss spelling)
priority: high
risk: a typo such as `ompp` or `Claude` loads silently and fails only when a worker starts; the refusal names no role or no harness list so the human cannot fix it; a valid harness (any of the four) is refused; an optional role is skipped by the check
status: active
changed_by: 2026-11-09-ARK-340-1
---

## Objective

Prove that the real config loader rejects an unknown harness at load, with a message the human can act on, and still accepts the four real harnesses.

## Preconditions

- A scratch `ARK_HOME` with a project `ark.yml` written to disk, loaded through the real `loadConfig` (no mock of the loader or of the schema).
- A base `ark.yml` whose roles all use harness `omp` with a real selector.

## Steps

1. Load the base config; note it loads.
2. Load four configs that differ only in the `implementer` harness: `claude`, `codex`, `omp`, `pi`.
3. Load a config where `reviewer` has the harness `ompp` (misspelled).
4. Load a config where an optional role (`designer`) has the harness `Claude` (wrong case).
5. Read each error message.

## Expected results

- The base config and the four configs with a real harness shall load without error.
- The config with `ompp` shall be refused at load. The message shall name the role `reviewer` and the four harnesses `claude`, `codex`, `omp` and `pi`.
- The config with `Claude` on the optional role `designer` shall be refused, naming `designer` and the four harnesses.
- No fixture in `test/*.test.ts` that goes through `loadConfig` shall use a harness outside the four.

## Screenshot checkpoints

none: a config loader has no visible surface; the proof is the thrown error text in the test result.
