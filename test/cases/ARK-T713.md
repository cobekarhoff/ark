---
id: ARK-T713
title: ARK-T713 after a bun test process ends normally, with or without --rerun-each, and after repeats that fail, its bun-test-* root and its host root no longer exist
level: integration
technique: equivalence classes (no flag, --rerun-each=5, --rerun-each=4 with failing repeats, a file that fails at load under --rerun-each=3 and `--rerun-each 3`), state transition (roots exist while the child runs, gone after it exits)
priority: high
risk: the fix for repeats stops the cleanup (the preload never removes `tempRoot` or `hostRoot` because it never reaches the last repeat, or the `hostRoot` hook is skipped), so each `bun test` run leaks a `bun-test-*` folder and an `ark-fake-host-*` folder
status: active
changed_by: 2026-11-20-ARK-578-1
---

## Objective

Prove that the preload still removes both of its roots when the `bun test` process ends, in a run without `--rerun-each`, in a run with `--rerun-each=5`, in a run where some repeats fail (exit 1), and in a run where the file throws at load (`--rerun-each=3` and the spaced `--rerun-each 3`, exit 1, no repeat runs), and that the removal happens once the last repeat is done, not never.

Expected: both paths the child reported exist while it ran and are gone after it exits.

## Preconditions

- The real repo `bunfig.toml`, so the preload applies.
- A scratch fixture written like `writeFixture` and spawned like `spawnBunTest` in `test/tmpdir-preload.test.ts`, with a scratch `TMPDIR`.
- The fixture has one test. In its body it reads `process.env.TMPDIR` and `process.env.ARK_FAKE_HOST` from the child, checks both exist at that moment, and appends both paths to a file the case owns (outside both roots). `hostRoot` is `/tmp/ark-fake-host-*`, outside `TMPDIR`, so both variables are read.
- A second fixture fails on every second repeat. It decides by the number of lines already in the record file the case owns (even count: `expect(1).toBe(2)`), not by module state.
- A third fixture throws at load. Before the throw it writes `process.env.TMPDIR` and `process.env.ARK_FAKE_HOST` to the record file the case owns (the preload has run by then).
- The case never counts entries of `/tmp`: that folder holds hundreds of `ark-fake-host-*` folders from other, killed runs.

## Steps

1. Run the child `bun test <fixture>` (no flag) and wait for it to exit.
2. Read the recorded paths. Check the `TMPDIR` path is the `bun-test-*` root of the child, under the scratch `TMPDIR` the case set, and not the scratch directory itself.
3. Check both paths no longer exist.
4. Run the child `bun test --rerun-each=5 <fixture>` and wait for it to exit.
5. Read the paths of the 5 repeats, and check that every repeat reports the same two paths (one root of each kind for the process) and that both no longer exist.
6. Run the child `bun test --rerun-each=4 <failing fixture>` and wait for it to exit.
7. Read the paths of the 4 repeats and check that every repeat reports the same two paths and that both no longer exist.
8. Run the child `bun test --rerun-each=3 <load-failure fixture>` and wait for it to exit; repeat with `--rerun-each 3`.
9. Read the two recorded paths and check that neither exists after exit.

## Expected results

- Without the flag: the child exits 0, it reported a `bun-test-*` path and an `ark-fake-host-*` path, and neither exists after exit.
- With `--rerun-each=5`: the child exits 0, all 5 repeats reported the same two paths, and neither exists after exit.
- With failing repeats: the child exits 1, reports 2 pass and 2 fail (all 4 repeats ran), all 4 repeats reported the same two paths and found them present, and neither exists after exit.
- A file that throws at load (`--rerun-each=3` and `--rerun-each 3`): the child exits 1, no repeat runs, the recorded `bun-test-*` root (under the scratch `TMPDIR`) and host root are both gone after exit.
- Each repeat found both paths present while it ran (the root is removed after the last repeat, not after the first).
- The check reads only the paths of its own child and does not depend on any other folder in `/tmp`.

## Screenshot checkpoints

none: filesystem state after a child process; no UI surface.
