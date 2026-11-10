---
id: ARK-T190
title: ARK-T190 temp-cleaner keeps every folder with a live owner at any age and removes it after the owner ends
level: integration
technique: state transition (owner alive, owner ended) and boundary values on age (12, 180 minutes)
priority: high
risk: the cleaner removes a folder by its own mtime while its owner process lives (the base checkout, Bun test root or Playwright fixture of a long run), or removes a no-owner folder before 180 minutes, or keeps an ended-owner folder past 12 minutes
status: active
changed_by: 2026-11-10-ARK-404-1
---

## Objective

`scripts/temp-cleaner.sh <workspace> 1 --once` removes no selected folder whose `ark-owner.pid` names a live process, and applies 12 minutes to an ended owner and 180 minutes to a folder with no owner file.

## Preconditions

- Scratch `TMPDIR`, a temp git repo as `<workspace>` (as in `test/chief-scripts.test.ts`).
- One folder per kind of ARK-T189 (ark-base-_, ark-evidence-_, ark-suite-_, bun-test-_, ark-home-* etc.) plus `plannotator-data-*`, each with an `ark-owner.pid` written first, then aged with `utimesSync` (writing the file changes the folder mtime) to 60 minutes.
- A real child process that lives (`sleep` or Bun child) whose pid is in the files.

## Steps

1. Run the cleaner. Check every folder exists.
2. Age one live-owner folder to 1000 minutes; run again; check it exists.
3. End the child and wait until `kill -0` fails. Run the cleaner. Check all 60-minute folders are gone.
4. Boundaries with the owner ended: a folder aged 11 minutes survives, one aged 13 minutes is removed.
5. Boundaries with no owner file: a folder aged 179 minutes survives (ark-* and bun-test-*), one aged 181 minutes is removed.
6. A non-selected name (`unrelated-*`) aged 1000 minutes survives in every step.
7. At the base commit (cleaner without the rule), step 1 fails: the live folders are removed.

## Expected results

- Step 1, 2: all live-owner folders exist, exit code 0.
- Step 3: all folders gone, exit code 0, worktree-held folders still pruned as in the existing cleaner test.
- Steps 4-5 hold at the given boundaries; step 6 holds.
- Step 7: the test fails at base.

## Screenshot checkpoints

none: no UI.
