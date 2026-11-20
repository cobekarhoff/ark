---
id: ARK-T705
title: ARK-T705 temp-cleaner stops an orphaned bun test worker by its pid on the first pass 10 minutes or more after it first saw it orphaned, and never a live-parent worker or another process
level: integration
technique: decision table on (command, parent, working folder) and boundary values on the age (590 s, 600 s)
priority: high
risk: the cleaner leaves orphaned `bun test --test-worker` processes asleep for hours (81 workers, 857 MB on 2026-11-19), or stops one before 10 minutes, or stops a worker whose parent is alive (a run in progress), a plain `bun`, a process outside the test temp roots, or stops a different process that reused the pid between the listing and the kill, or misses a worker because the cwd under `/var` is compared to `$TMPDIR` as a string, or leaves a worker asleep because its temp working folder (or the whole `ark-suite-*` root above it, or the root folder itself) was already deleted when the suite ended, or stops a worker whose deleted folder only looks like it is inside a temp root (a string prefix of `$TMPDIR`, an unrelated folder, a path under `$HOME`, a `..` path), or fails the whole pass (no folder removed, no disk message) when `ps`, `lsof` or `kill` fails
status: active
changed_by: 2026-11-20-ARK-594-1
---

## Objective

`scripts/temp-cleaner.sh <workspace> 1 --once` stops, with `kill <pid>`, a process that is a bun test worker (`bun test --test-worker`), has parent pid 1 and a working folder inside a test temp root of `$TMPDIR` (the folder may already be deleted), on the first pass that runs 10 minutes or more after the pass that first saw it orphaned. It stops no other process.

## Preconditions

- Scratch `TMPDIR` and a temp git repo as `<workspace>`, as in `test/chief-scripts.test.ts` (`runScript`). Run the cleaner with a fake `ps` and a fake `lsof` first on PATH, printing the columns the script parses for the pids and command lines the case sets.
- The pids are real: each "worker" is a `sleep` child the case started (the case stops each by pid at the end). The fake `ps` row for a pid carries the case's ppid and command line, so the case needs no real double fork (the real orphan is ARK-T708).
- Working folders: `$TMPDIR/bun-test-<x>/ark-repo-<y>` (the real orphan shape), `$TMPDIR/ark-suite-<x>/bun-test-<y>/ark-repo-<z>` (nested), and a symlink case: the fake `lsof` reports `/private/var/...` while `$TMPDIR` is the `/var/...` path (the case creates the symlink pair in the scratch folder).
- Deleted folders: the case never creates the folder. The fake `lsof` prints, for a worker whose folder is gone, a `workingFolder` path built from the real path of the scratch `TMPDIR` (`realScratch`, `realpathSync` of the scratch folder, as the kernel prints it: `/private/var/...` on macOS), never from `$TMPDIR` as passed. Every deleted path inside the scratch `TMPDIR` in steps 3b, 3c and 3d is `realScratch` plus a suffix. The exceptions are step 3c (a) (`/never-created/ark-repo-y`) and 3c (b) (`$HOME/never-created/bun-test-x/ark-repo-y`): they lie outside the scratch `TMPDIR` on purpose and are spelled in full, never under `realScratch` (a `realScratch/never-created/...` path would repeat 3c (d) and stop proving the outside-every-root and `$HOME` controls). Reason: a deleted path cannot be resolved by `cd`, so only a path spelled as the real path can match the cleaner's `root=$(pwd -P)`; a path spelled through the `/var` link would stay alive under any fix, and a control in that spelling would pass for the wrong guard. No real child and no `rmdir` are needed. The case does not rely on when the test preload removes `bun-test-*` roots (ARK-578).
- Age is set through the cleaner's first-seen state file next to `temp-cleaner.low` (rewrite the first-seen time of one pid), never by sleeping.

## Steps

1. One worker W (command `bun test --test-worker ...`, ppid 1, cwd in `bun-test-x/ark-repo-y`). Pass 1: W is alive afterwards and the state file names its pid.
2. Set W's first-seen time to 590 seconds ago (10 s under the limit, not 1 s: the state file has second precision and the script reads the clock a little later). Pass: W alive. Set it to 600 seconds ago. Pass: W is gone, killed by its pid (`kill -0` fails), and the pass exits 0.
3. Controls, each first seen 20 minutes ago, one pass: (a) a worker with ppid of a live process (the case's own pid); (b) `bun test test/a.test.ts` with ppid 1 (no `--test-worker`); (c) a command that is not bun (`node script.js --test-worker`) with ppid 1; (d) a worker with ppid 1 whose cwd is outside the temp root (`/` and a `$HOME` folder); (e) a worker whose cwd is the nested `ark-suite-x/bun-test-y/ark-repo-z`: this one IS stopped. All of (a) to (d) alive, (e) gone.
   3b. Deleted folders, stopped. Each worker is first seen 20 minutes ago, one pass, and its folder (and every folder above it inside the scratch `TMPDIR`) was never created. Every path is `realScratch` plus the suffix: (a) `/bun-test-x/ark-repo-y`; (b) `/ark-suite-x/bun-test-y/ark-repo-z` (the ticket's shape: the suite's own root `ark-suite-x` is gone too); (c) one worker for each root name the cleaner removes (`ark-x`, `ark179-x`, `ark199-x`, `plannotator-data-x`, `.x.bun-chrome`, `bun-test-x`), whose cwd is that deleted root folder itself (`realScratch/<root name>`, so nothing follows the root name in the path). All gone.
   3c. Deleted folders, never stopped. Each worker is first seen 20 minutes ago, one pass, and its folder was never created. Each path is spelled so that the guard it names is the only reason it stays alive: (a) `/never-created/ark-repo-y` (outside every root, as `/` is for a folder that exists); (b) `$HOME/never-created/bun-test-x/ark-repo-y`; (c) `realScratch-other/bun-test-x/ark-repo-y` (string prefix of the real `TMPDIR`); (d) `realScratch/unrelated/ark-repo-y`; (e) `realScratch/bun-test-x/../unrelated/ark-repo-y` (a `..` path that starts with a root name but leaves it); (f) a worker the fake `lsof` has no folder for (no `workingFolder`). All alive. (a) to (d) are the deleted twin of a control in step 3 (d) or of an existing outside folder.
   3d. Pass 1 only: a deleted-folder worker (3b (b)) with no prior state is alive after pass 1 and the state file names its pid, so the age clock starts on the first pass that sees it, as for a worker whose folder exists. Then first seen 590 s ago: alive; 600 s ago: gone. The case does not sleep.
4. Worker with a path under `/var` while `$TMPDIR` is the `/private/var` form (and the reverse): it is stopped in both spellings.
5. A worker that was seen with a live parent on pass 1 and orphaned only on pass 2: it is not stopped on pass 2 (the clock starts when the cleaner first sees it orphaned), and a pid that is no longer listed has its entry dropped from the state file (no growth, no stale age for a reused pid).
6. Pid-reuse recheck, run for W: the fake `ps` lists W in the main listing, but the per-pid look the cleaner makes just before the kill (`ps -p <pid>`) reports a different command for W's pid. The case does not replace the process: W stays the real `sleep` child, and only what the fake `ps` reports changes. Pass. A deleted-folder worker is not repeated: the recheck runs for every pid after one shared rooted test, whatever made the pid rooted.
7. Failures of called commands: `ps` exits 1 and prints nothing; `lsof` exits 1; `kill` fails on a pid that has just ended. Each pass still exits 0, still removes the aged `bun-test-*` folders of ARK-T190 and prunes worktrees, and stops no other process. The case registers each aged `bun-test-*` folder as a real worktree of the scratch workspace before the pass and checks after the pass that the folder is gone and `git worktree list` no longer names it.
8. Order: W's own temp root (`bun-test-x`) is aged to be removable (owner ended, over 12 minutes) in the same pass that stops W: W is stopped first, then the folder is removed.
9. At the base commit (cleaner with no orphan pass), step 2 fails: W stays alive. At the commit before ARK-594, step 3b fails: the deleted-folder workers stay alive.

## Expected results

- Step 1: W alive, state file holds W's pid with a time, exit 0.
- Step 2: alive at 590 s, gone at 600 s; every other `sleep` child of the case is still alive.
- Step 3: (a) to (d) alive, (e) gone.
- Step 3b: every worker gone.
- Step 3c: every worker alive; the pass exits 0.
- Step 3d: alive on pass 1 with its pid in the state file; alive at 590 s; gone at 600 s.
- Step 4: gone for both path spellings; a folder that exists is resolved before it is compared, so the symlink spelling still matches.
- Step 5: not stopped on pass 2; the state file has no entry of a pid that left the listing.
- Step 6: W (the original real child) is still alive after the pass, and the pass exits 0: the cleaner rechecked the identity of the pid before the kill. This proves the recheck, not a real pid replacement.
- Step 7: exit 0 each time, folders still removed, no stopped process except the ones the rule names.
- Step 8: the process is gone and the folder removed in that pass.
- Step 9: fails at base: W stays alive; at the commit before ARK-594 the 3b and 3d workers stay alive.

## Screenshot checkpoints

none: no UI. The surface is a script, process state and a state file.
