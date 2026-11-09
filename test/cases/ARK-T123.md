---
id: ARK-T123
title: ARK-T123 the Playwright suite runs fully parallel and passes with 2 and 4 workers, each spec with its own port, temp folder and ARK_HOME
level: e2e
technique: equivalence classes of worker count (2, 4) with repeated runs; state isolation check
priority: high
risk: "a spec shares a port, temp folder or ARK_HOME with another once tests run in parallel, so a test fails or passes by the order or timing of its neighbours; or fullyParallel is switched back off and the speed gain is lost"
status: active
changed_by: 2026-11-08-ARK-331-1
---

## Objective

Prove that `playwright.config.ts` runs every test of every spec in parallel and that no two tests share a port, temp folder, ARK_HOME or process env value, so the suite result does not depend on the worker count.

Expected: While fullyParallel is true, the suite shall exit 0 with 2 workers and with 4 workers.

## Preconditions

- Quiet host (load below the core count); `bun install` done.
- No hub or fake tool process of an earlier run left over.

## Steps

1. Read the config: assert `fullyParallel` is `true`.
2. Run `bunx playwright test --workers=2` three times in a row; record each exit code.
3. Run `bunx playwright test --workers=4` once; record the exit code.
4. For each spec that starts a hub or sets `ARK_HOME`, `ARK_NOW` or `ARK_*_SESSIONS`, read where it gets the port, folder and env: assert it is from `--port 0`, `tempArkHome` or `tempDirectory` per test, and that a `describe` block with shared state is configured serial or sets up per test.
5. Run `bun test test/playwright-migration.test.ts test/evidence-test-run.test.ts` after the config change.

## Expected results

- `fullyParallel` is true.
- All three runs with 2 workers and the run with 4 workers exit 0, with no skipped test added.
- No spec shares a port, folder or ARK_HOME with another; the two config-reading test files pass.

## Screenshot checkpoints

none: the case checks logic or output, not appearance.
