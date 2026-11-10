---
id: ARK-T17
title: ARK-T17 the default roles block of bootstrap.md is a valid config on two vendors
level: integration
technique: equivalence classes (vendor of each role) over the block that a human copies
priority: medium
risk: the default block that bootstrap shows has a typo or a role on one vendor, so a bootstrapped project fails to load or has a reviewer that shares the writer's blind spots
status: retired
retired_reason: ARK-340 removes the literal roles block from bootstrap.md, so the extraction contract is obsolete; role config loading is owned by ARK-T16 and role availability by ARK-T158, and playbook wording is proved by inspection
changed_by: 2026-11-09-ARK-340-1
---

## Objective

Prove that the default `roles:` block in `skills/ark/playbooks/bootstrap.md` (the fenced block in section 2 with real harness and model values) loads through `loadConfig` with `test_writer` and `test_reviewer`, and that the reviewer is on a different vendor from the implementer and the test writer. This reads the block, not its prose: wording is proved by inspection.

## Preconditions

- `bootstrap.md` has the default roles block in section 2 (the one with real values; not the `<harness>` template in section 8).
- A temporary `ARK_HOME` and a temporary git repo as the workspace.

## Steps

1. Extract the fenced block that starts with `roles:` from section 2 of `bootstrap.md`.
2. Write a project config with a valid `suites` entry and the extracted `roles` value, then run `ark status --project <name>`.
3. Load the config through `loadConfig` and read each role's `harness` and `model`.
4. Map each harness to its vendor (`claude` is Anthropic, `codex` is OpenAI, `omp` takes the vendor from the model prefix).

## Expected results

- Step 2 exits 0, and step 3 returns `test_writer` and `test_reviewer` with a harness and a model.
- The vendor of `test_reviewer` differs from the vendor of `implementer` and from the vendor of `test_writer`.
- The existing roles (`implementer`, `validator`, `reviewer`, `evaluator`, `designer`, `chief`) still load from the same block.

## Screenshot checkpoints

none: integration case on a config block; no UI surface.
