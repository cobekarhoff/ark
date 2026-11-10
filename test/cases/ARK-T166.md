---
id: ARK-T166
title: ARK-T166 ark status passes when every project config is valid
level: integration
technique: equivalence classes (all projects valid)
priority: medium
risk: a valid config makes status print a config error or exit non-zero
status: active
changed_by: 2026-11-09-ARK-340-1
---

## Objective

Prove that `ark status` exits 0 and prints no config error when every project config is valid.

## Preconditions

- A temporary `ARK_HOME` with project `demo` holding a valid `ark.yml`.
- The harnesses of the roles are on PATH.

## Steps

1. Run `ark status`.
2. Record the output and the exit code.

## Expected results

- When every project config is valid, the system shall exit with code 0.
- When every project config is valid, the system shall not print "config error".

## Screenshot checkpoints

none: integration case on CLI output and exit code; no UI surface.
