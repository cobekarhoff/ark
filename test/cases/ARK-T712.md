---
id: ARK-T712
title: ARK-T712 bun test --rerun-each=5 on one file that uses the temp root and the shims passes 5 of 5 repeats in one process
level: integration
technique: boundary values (repeat count 1 and 5), equivalence classes (`--rerun-each=5` and the spaced `--rerun-each 5`), state transition (first repeat, middle repeats, last repeat)
priority: high
risk: the preload removes `tempRoot` or `hostRoot` (or the shims in them) after the first repeat, so repeats 2 to 5 fail with ENOENT and a flaky test cannot be repeated in one process
status: active
changed_by: 2026-11-20-ARK-578-1
---

## Objective

Prove that one `bun test --rerun-each=5 <one file>` process keeps the temp root, the refusing shims, the host root and `ARK_FAKE_HOST` alive for every repeat, so all 5 repeats pass.

Expected: the child exits 0 and reports 5 passes of the fixture test, one for each repeat.

## Preconditions

- The real repo `bunfig.toml`, so the preload `test/tmpdir-preload.ts` applies (child cwd is the repo root).
- A scratch fixture written like `writeFixture` and spawned like `spawnBunTest` in `test/tmpdir-preload.test.ts`; the case adds no real repo file as the child file, because that starts nested children and is slow.
- The fixture has one test. Its body reads state the preload made once: it reads `process.env.TMPDIR` and checks the directory exists and holds `ark-owner.pid`; it reads `process.env.ARK_FAKE_HOST` and checks the directory exists and its `bin` holds the `memory_pressure` and `sysctl` fakes; it checks `$TMPDIR/refusing-shims` exists (the refusing shims live there, not under `ARK_FAKE_HOST/bin`); it spawns a refused tool by bare name (for example `gh`) and expects the refusing message that names the tool.
- The fixture does not remove any folder in its own `afterAll`, so it is rerun-safe by itself.

## Steps

1. Run the child `bun test --rerun-each=5 <fixture>` (then the same with the spaced form `--rerun-each 5`) with a scratch `TMPDIR`, and wait for it to exit (no sleep; await the child).
2. Read the exit code and the output of the child.
3. Run the same fixture without the flag as the control: one repeat, one pass.

## Expected results

- The child with `--rerun-each=5`, and with `--rerun-each 5`, exits 0.
- Its output reports 5 passes and 0 failures for the fixture test (the pass count is 5, not 1).
- No repeat fails with `ENOENT` on `TMPDIR` or on `ARK_FAKE_HOST`.
- Every repeat sees the refused tool fail with a message that names it: the shims survive repeat 1.
- The control without the flag exits 0 with 1 pass, so the case also catches a fix that breaks the single run.

## Screenshot checkpoints

none: CLI exit code and test output; no UI surface.
