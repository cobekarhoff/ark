---
id: ARK-T168
title: ARK-T168 a gates map with only plan set loads, and the other gate keys stay human
level: integration
technique: boundary values (partial gates map) and state transition (strategy gate still waits)
priority: medium
risk: a partial gates map is refused, or an unset key defaults to auto and skips a human gate
status: active
changed_by: 2026-11-09-ARK-340-1
---

## Objective

Prove that a `gates` map that sets only `plan` is a valid config and that the keys it leaves out stay `human`.

## Preconditions

- A project config with `gates: { plan: auto }` and valid roles.
- A run in that project awaiting its strategy.
- The harnesses of the roles are on PATH.

## Steps

1. Run `ark status`.
2. Record two strategy cards with the answers `yes` and `no`.
3. Read the run state.

## Expected results

- When `gates` sets only `plan`, the system shall load the config and `ark status` shall exit with code 0.
- When `gates.strategy` is not set, the system shall keep the run in `awaiting_strategy` after two cards are recorded, until the human answers.

## Screenshot checkpoints

none: integration case on CLI output and exit code; no UI surface.
