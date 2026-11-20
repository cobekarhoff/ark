---
id: ARK-T706
title: ARK-T706 ark chief state prints the number of orphaned bun test workers and their memory in the Host section, 0 when there are none and unavailable when ps fails
level: integration
technique: equivalence classes (none, some, ps failing) and boundary values on the count (0, 1, 3) and on the memory sum
priority: medium
risk: Master Chief cannot see orphaned bun test workers (81 workers, 857 MB went unreported on 2026-11-19), or the line counts a worker whose parent is alive or a process that is not a worker, or prints 0 when `ps` failed (an unknown reading shown as empty), or the memory is the sum of the wrong column or unit, or the new line comes after `hold new runs:` and breaks the readers that take that line as the last of the section
status: active
changed_by: 2026-11-19-ARK-569-1
---

## Objective

`ark chief state` prints one line in the `## Host` section, `orphaned bun test workers: <n> (<MB> MB)`, before the `hold new runs:` line. A worker counts when its command is `bun test --test-worker` and its parent pid is 1 (the cleaner of ARK-T705 shares this rule; the count does not read the working folder, so `ark chief state` runs no `lsof`). `0` when `ps` ran and listed none; `unavailable` when `ps` failed.

## Preconditions

- Temp project and temp `ARK_HOME`, no tickets, no live Orca (as ARK-T188).
- A fake `ps` first on PATH printing the real columns the reader parses (pid, ppid, rss in KB, command). The real host has live orphans, so no row reads the real `ps`.
- Healthy fake host (ARK-T188).

## Steps

1. The fake `ps` lists three workers with ppid 1 and rss 102400, 51200 and 153600 KB (300 MB), a worker with ppid of a live process, `bun test test/a.test.ts` with ppid 1 and a `node` with ppid 1. Run `ark chief state`.
2. The fake `ps` lists one worker with ppid 1 and rss 2048 KB (2 MB). Run again.
3. The fake `ps` lists only non-orphans. Run again.
4. The fake `ps` exits 1 with no output. Run again.
5. Run the case of step 1 once more and read the last line of the section.

## Expected results

- Step 1: `orphaned bun test workers: 3 (300 MB)`; the other three rows are not counted.
- Step 2: `orphaned bun test workers: 1 (2 MB)`; not 0 and not unavailable.
- Step 3: `orphaned bun test workers: 0`.
- Step 4: `orphaned bun test workers: unavailable`; no `0`, and every other Host line still prints.
- Step 5: the line sits between `tests:` and `hold new runs:`, and `hold new runs:` is the last line of the section; the output has one such line.

## Screenshot checkpoints

none: CLI output, no UI.
