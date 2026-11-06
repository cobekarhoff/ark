---
id: ARK-T11
title: ARK-T11 ark test runs compose up and down on the mirror and again for the base run
level: integration
technique: ordering check of the compose commands
priority: medium
risk: the stack is not up for the head suites, is left up after a failing suite, or the base suites run without their own stack
status: active
changed_by: 2026-11-06-ARK-312-1
---

## Objective

Prove that `ark test` runs `compose up` on the run's mirror before the suites and `compose down` afterwards, even when a suite fails, and that the base run has its own `up` and `down` on the base checkout under the project `<run>-base`. This case replaces the old-id test `ARK-154-AC3 runs compose up on the mirror before the suites and compose down afterwards, even when a suite fails`.

## Preconditions

- A project whose `ark.yml` sets `compose` to a fake command that appends its arguments to a log, and one failing e2e test.

## Steps

1. Run `ark test`. Assert exit 1.
2. Read the compose log.

## Expected results

- The first two lines are `up -d --wait` and `down` on the mirror with the project `<run>`.
- The next two lines are `up -d --wait` and `down` on the base checkout with the project `<run>-base`.

## Screenshot checkpoints

none: integration case on a command log; no UI surface.
