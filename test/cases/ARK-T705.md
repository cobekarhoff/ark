---
id: ARK-T705
title: ARK-T705 temp-cleaner stops an orphaned bun test worker by its pid on the first pass 10 minutes or more after it first saw it orphaned, and never a live-parent worker or another process
level: integration
technique: decision table on (command, parent, working folder, owner) and boundary values on the age (9 min 59 s, 10 min)
priority: high
risk: the cleaner leaves orphaned `bun test --test-worker` processes asleep for hours (81 workers, 857 MB on 2026-11-19), or stops one before 10 minutes, or stops a worker whose parent is alive (a run in progress), a plain `bun`, a process of another user or a process outside the test temp roots, or stops a different process that reused the pid between the listing and the kill, or misses a worker because the cwd under `/var` is compared to `$TMPDIR` as a string, or fails the whole pass (no folder removed, no disk message) when `ps`, `lsof` or `kill` fails
status: active
changed_by: 2026-11-19-ARK-569-1
---

## Objective

`scripts/temp-cleaner.sh <workspace> 1 --once` stops, with `kill <pid>`, a process that is a bun test worker (`bun test --test-worker`), has parent pid 1 and a working folder inside a test temp root of `$TMPDIR`, on the first pass that runs 10 minutes or more after the pass that first saw it orphaned. It stops no other process.

## Preconditions

- Scratch `TMPDIR` and a temp git repo as `<workspace>`, as in `test/chief-scripts.test.ts` (`runScript`). Run the cleaner with a fake `ps` and a fake `lsof` first on PATH, printing the columns the script parses for the pids and command lines the case sets.
- The pids are real: each "worker" is a `sleep` child the case started (the case stops each by pid at the end). The fake `ps` row for a pid carries the case's ppid and command line, so the case needs no real double fork (the real orphan is ARK-T708).
- Working folders: `$TMPDIR/bun-test-<x>/ark-repo-<y>` (the real orphan shape), `$TMPDIR/ark-suite-<x>/bun-test-<y>/ark-repo-<z>` (nested), and a symlink case: the fake `lsof` reports `/private/var/...` while `$TMPDIR` is the `/var/...` path (the case creates the symlink pair in the scratch folder).
- Age is set through the cleaner's first-seen state file next to `temp-cleaner.low` (rewrite the first-seen time of one pid), never by sleeping.

## Steps

1. One worker W (command `bun test --test-worker ...`, ppid 1, cwd in `bun-test-x/ark-repo-y`). Pass 1: W is alive afterwards and the state file names its pid.
2. Set W's first-seen time to 9 minutes 59 seconds ago. Pass: W alive. Set it to 10 minutes ago. Pass: W is gone, killed by its pid (`kill -0` fails), and the pass exits 0.
3. Controls, each first seen 20 minutes ago, one pass: (a) a worker with ppid of a live process (the case's own pid); (b) `bun test test/a.test.ts` with ppid 1 (no `--test-worker`); (c) a command that is not bun (`node script.js --test-worker`) with ppid 1; (d) a worker with ppid 1 whose cwd is outside the temp root (`/` and a `$HOME` folder); (e) a worker of another user (the fake `ps` user column); (f) a worker whose cwd is the nested `ark-suite-x/bun-test-y/ark-repo-z`: this one IS stopped. All of (a) to (e) alive, (f) gone.
4. Worker with a path under `/var` while `$TMPDIR` is the `/private/var` form (and the reverse): it is stopped in both spellings.
5. A worker that was seen with a live parent on pass 1 and orphaned only on pass 2: it is not stopped on pass 2 (the clock starts when the cleaner first sees it orphaned), and a pid that is no longer listed has its entry dropped from the state file (no growth, no stale age for a reused pid).
6. Pid-reuse recheck: the fake `ps` lists W as a worker in the main listing, but the per-pid look the cleaner makes just before the kill (`ps -p <pid>`) reports a different command for W's pid. The case does not replace the process: W stays the real `sleep` child, and only what the fake `ps` reports changes. Pass.
7. Failures of called commands: `ps` exits 1 and prints nothing; `lsof` exits 1; `kill` fails on a pid that has just ended. Each pass still exits 0, still removes the aged `bun-test-*` folders of ARK-T190 and prunes worktrees, and stops no other process. The case registers each aged `bun-test-*` folder as a real worktree of the scratch workspace before the pass and checks after the pass that the folder is gone and `git worktree list` no longer names it.
8. Order: W's own temp root (`bun-test-x`) is aged to be removable (owner ended, over 12 minutes) in the same pass that stops W: W is stopped first, then the folder is removed.
9. At the base commit (cleaner with no orphan pass), step 2 fails: W stays alive.

## Expected results

- Step 1: W alive, state file holds W's pid with a time, exit 0.
- Step 2: alive at 9:59, gone at 10:00; every other `sleep` child of the case is still alive.
- Step 3: (a) to (e) alive, (f) gone.
- Step 4: gone for both path spellings.
- Step 5: not stopped on pass 2; the state file has no entry of a pid that left the listing.
- Step 6: W (the original real child) is still alive after the pass, and the pass exits 0: the cleaner rechecked the identity of the pid before the kill. This proves the recheck, not a real pid replacement.
- Step 7: exit 0 each time, folders still removed, no stopped process except the ones the rule names.
- Step 8: the process is gone and the folder removed in that pass.
- Step 9: fails at base.

## Screenshot checkpoints

none: no UI. The surface is a script, process state and a state file.
