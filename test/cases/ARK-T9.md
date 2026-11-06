---
id: ARK-T9
title: ARK-T9 bun test discovers no Playwright spec
level: integration
technique: equivalence classes (every *.pw.ts file in test/pw)
priority: medium
risk: bun test picks up a *.pw.ts spec, which needs Node and Playwright, and fails the unit run
status: active
changed_by: 2026-11-06-ARK-312-1
---

## Objective

Prove that `bun test` lists none of the `*.pw.ts` specs in `test/pw/`. They run under `bunx playwright test`. This case replaces the old-id test `ARK-243-AC1 bun test discovers no *.pw.ts file`, which named one spec.

## Preconditions

- The specs `test/pw/hub.pw.ts` and `test/pw/checkpoint.pw.ts` exist.

## Steps

1. List `test/pw/*.pw.ts`.
2. Run `bun test --dry-run test/pw`.

## Expected results

- The list holds exactly the two specs.
- When `bun test` runs on `test/pw`, the system shall print no `.pw.ts` file name.

## Screenshot checkpoints

none: integration case on a file list and a command output; no UI surface.
