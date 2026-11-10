---
id: ARK-T189
title: ARK-T189 every temp root that the cleaner can select holds ark-owner.pid with the pid of its live maker
level: integration
technique: equivalence classes (one case per producer kind), read back from a real child process
priority: high
risk: a producer makes its root without an owner file, or writes the pid of a parent/other process or a malformed file, so the cleaner cannot tell a live root from a dead one and deletes a root under a running process (ENOENT posix_spawn 'git' in runs 313 and 316)
status: active
changed_by: 2026-11-10-ARK-404-1
---

## Objective

Each producer of a cleaner-selected root writes `<root>/ark-owner.pid` (decimal pid, newline) when it makes the root, and the pid is the live process that owns the root.

## Preconditions

- A scratch `TMPDIR` per kind, so no real temp root is touched.
- Kinds: (a) `ark-base-*` base checkout folder of `ark test`; (b) `ark-evidence-*` scratch of `ark test`; (c) `ark-suite-*` private TMPDIR of a suite (ARK-390; selected by `ark-*`, held for the whole suite); (d) `bun-test-*` root of `test/tmpdir-preload.ts`; (e) fixture roots of `tempDirectory()` in `test/pw/helpers.ts` (prefixes `ark-home-`, `ark-repo-`, `ark-fake-tools-`, `ark-gate-`).
- Each root is made by the production code that makes it, in a real child process (Bun for a-d; Node for e, because the helpers import `@playwright/test`). No mock of the maker.

## Steps

1. For each kind, start the child that runs the maker. After the maker returns (the root is published to its caller), the child prints `ready <pid> <root>` and blocks on stdin.
2. Wait for the `ready` line; take the pid and root path from it. Do not poll the scratch `TMPDIR` listing for the root.
3. Read `<root>/ark-owner.pid`.
4. For (e), make roots with at least two different prefixes through `tempDirectory()` and read each.
5. For (d), run the child as `bun test` with the preload, and read the file of the outer `bun-test-*` root.
6. End each child.

## Expected results

- The file exists in every root of every kind, including both prefixes of (e).
- Content is the decimal pid of the owning child (the `bun test` process for d, the Node worker for e, the `ark test` runner for a-c) followed by one newline, and `kill -0` of it succeeds while the child lives.
- The file exists by the time the maker returns: it is read only after the child's `ready` handshake. A directory briefly listed without the file inside the maker, before it returns, is allowed and not tested.
- A nested root made inside (c) by a suite is not required to hold a file.

## Screenshot checkpoints

none: no UI; the proof is the file content.
