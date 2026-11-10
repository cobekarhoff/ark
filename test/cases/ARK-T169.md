---
id: ARK-T169
title: ARK-T169 plan check on an invalid config with an unchanged plan hash clears the plan approval, and step start names the plan gate
level: integration
technique: state transition (approved, then invalid recheck with identical plan bytes)
priority: high
risk: an approved plan stays approved after a recheck fails on the config, so a step starts on a plan that no longer validates
status: active
changed_by: 2026-11-09-ARK-340-1
---

## Objective

Prove that when `ark plan check` fails because the project config no longer fits the plan, with the same plan hash, the earlier approval is cleared and `ark run step start` is refused.

## Preconditions

- A run with an approved plan.
- The project config is rewritten so the implementer role's model no longer exists, while `plan.yml` keeps the same bytes.

## Steps

1. Run `ark plan check <run id>`.
2. Run `ark run step <run id> build start`.
3. Count the run events before and after step 2.

## Expected results

- When the config no longer fits the plan, the system shall make `ark plan check` exit with code 1.
- When the approval is cleared, the system shall make `ark run step start` exit with code 1 and name `gate.answered plan approve` on stderr.
- When the step start is refused, the system shall add no event.

## Screenshot checkpoints

none: integration case on CLI output and exit code; no UI surface.
