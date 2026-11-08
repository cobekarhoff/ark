---
id: ARK-T106
title: ARK-T106 the playbook plan shape gives a valid merge order with no repo cycle
level: integration
technique: regression of a known failure
priority: high
risk: a reviewer step that needs a validator in another repo makes a repo edge again, so the plan of the run-lead playbook fails with a repo cycle after the run was built
status: active
changed_by: 2026-11-08-ARK-336-1
---

## Objective

Prove that the plan shape of `run-lead.md` (an implementer per repo, a validator in the suite repo, a reviewer per repo that needs the implementer and the validator) passes `ark plan check` and gives a valid order, where the old step-`needs` order threw a repo cycle.

## Preconditions

- A fixture plan with `repos/shared/packages` (upstream), `repos/platform` (suite repo, holds the validator) and `.`; an implementer in each, one validator in `repos/platform`, and a reviewer per repo that needs its implementer and the validator. The `repos` block holds the real edges only.

## Steps

1. Run `ark plan check <run>`.

## Expected results

- The run shall exit 0 and print an order in which `repos/shared/packages` comes before `repos/platform`.
- The output shall not contain `dependency cycle between repos`.
- A reviewer `needs` edge alone shall never make a repo cycle. Real repo cycles are owned by ARK-T104.

## Screenshot checkpoints

none: integration case on command output.
