---
id: ARK-T16
title: ARK-T16 loadConfig reads the optional test_writer and test_reviewer roles
level: integration
technique: equivalence classes (both roles, no test roles, role without model) with a boundary on the missing field
priority: high
risk: a config with a test role and no model loads, and the run lead starts a test step with no model; or an old config with no test roles stops loading
status: active
changed_by: 2026-11-06-ARK-313-1
---

## Objective

Prove that `loadConfig` (through an `ark` command that reads `ark.yml`) accepts `roles.test_writer` and `roles.test_reviewer` when both carry a harness and a model, accepts a config with neither, and refuses a test role that has no model, naming the role.

## Preconditions

- A temporary `ARK_HOME` and a temporary git repo as the workspace (`tempArkHome`, `tempGitRepo`, `writeProject` in `test/helpers.ts`).
- Three projects, each with a valid `suites` entry and the roles `implementer`, `validator` and `reviewer`:
  - `with-test-roles`: also `test_writer` and `test_reviewer`, each with `harness` and `model`.
  - `without-test-roles`: no test role.
  - `writer-no-model`: `test_writer` has `harness` and no `model`.

## Steps

1. Run `ark status --project with-test-roles` and read the exit code.
2. Run `ark status --project without-test-roles` and read the exit code.
3. Run `ark status --project writer-no-model` and read the exit code and the error text.
4. Load the first config through `loadConfig` and read `roles.test_writer` and `roles.test_reviewer`.

## Expected results

- Step 1 exits 0, and step 4 returns both roles with the harness and the model written in the file.
- Step 2 exits 0 with no error: old configs still load.
- Step 3 exits non-zero, and the error names `roles.test_writer` and the missing `model`.

## Screenshot checkpoints

none: integration case on CLI exit codes and error text; no UI surface.
