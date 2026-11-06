---
id: ARK-T10
title: ARK-T10 every Playwright test title starts with an AC id or a test case id
level: integration
technique: equivalence classes (old AC id, test case id) over the titles that Playwright lists
priority: medium
risk: a Playwright test carries no id the parsers can read, so its result proves nothing
status: active
changed_by: 2026-11-06-ARK-312-1
---

## Objective

Prove that each migrated criterion id of the hub spec appears in a Playwright test title, and that every title starts with an old AC id (`ARK-<n>-AC<k>`) or a test case id (`ARK-T<n>`). This case replaces the old-id test `ARK-243-AC2 every migrated criterion id appears in a Playwright test title`.

## Preconditions

- Playwright can list its tests (`bunx playwright test --list`).

## Steps

1. List the tests and read their titles.
2. For each migrated criterion id, find a title that starts with it.
3. Check the first word of every title.

## Expected results

- Every migrated criterion id starts at least one title.
- Every title starts with an old AC id or a test case id.

## Screenshot checkpoints

none: integration case on a test listing; no UI surface.
