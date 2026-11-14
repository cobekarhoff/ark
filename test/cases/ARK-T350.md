---
id: ARK-T350
title: ARK-T350 every spec that starts a hub runs on the frozen clock and no spec unfreezes it
level: integration
technique: equivalence classes (file with `startHub` vs file without); negative scan for `delete process.env.ARK_NOW`
priority: high
risk: "a hub spec runs on real time because it deletes `ARK_NOW` or never calls `useCleanup`, and a test breaks at a certain time of day; or a later test in the file loses the frozen clock"
status: active
changed_by: 2026-11-13-ARK-433-1
---

## Objective

Prove that each `*.pw.ts` file that calls `startHub` also calls `useCleanup` (which freezes `ARK_NOW`), and that no `*.pw.ts` file holds `delete process.env.ARK_NOW`.

Expected: Every spec that calls `startHub` calls `useCleanup`, and no spec deletes `ARK_NOW`.

## Preconditions

- Tree after the change: the delete in `hub.pw.ts` `test.beforeAll` is gone; the `ARK_NOW` override near the end of `hub.pw.ts` saves and restores the previous value.
- `test/pw/helpers.ts` defines `startHub` and `useCleanup`; it is not a spec and the scan skips it.

## Steps

1. List every `*.pw.ts` file under `test/pw`.
2. For each file whose text calls `startHub`, assert the text also calls `useCleanup`.
3. For every file assert the text does not hold `delete process.env.ARK_NOW`.
4. Files with no `startHub` (for example `checkpoint.pw.ts`) pass step 2 with no `useCleanup`.
5. Mutation on a copy of the text: add `delete process.env.ARK_NOW` to `hub.pw.ts` text, assert step 3 fails and names the file; remove `useCleanup` calls, assert step 2 fails and names the file.

## Expected results

- Each hub spec calls `useCleanup`.
- No file holds the delete; a save-and-restore write (`process.env.ARK_NOW = previous`) is allowed.
- Both mutations fail the scan with the file named.

## Screenshot checkpoints

none: the case checks source text, not appearance.
