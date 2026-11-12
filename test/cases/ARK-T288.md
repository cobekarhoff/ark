---
id: ARK-T288
title: ARK-T288 the resources source gives every process to one owner in the AC1 order and never keeps or serves an env variable other than ORCA_TERMINAL_HANDLE
level: integration
technique: equivalence classes (one process per owner kind) and precedence (a process that matches two rules), plus a negative probe for a secret
priority: high
risk: the 24 h history keeps points older than the cutoff or drops points inside it, a process lands in the wrong bucket (a base-checkout process under ark-base-* goes to other, a child of an agent goes to a run or leftover, a closed run's process goes to other), or the whole `ps -E` environment, with GH_TOKEN, reaches the snapshot, a route response, the SSE stream or results/resources.json
status: active
changed_by: 2026-11-12-ARK-418-1
---

## Objective

The `resources` source reads each process once through `/bin/ps -E -ww` and `lsof -d cwd` and gives it to the agent of its `ORCA_TERMINAL_HANDLE`, else the run whose `runs/<run>/` folder holds its cwd, else the run whose `ark test` admission holds its process group, else `leftover` (cwd in the folder of a closed run), else `other`. The source keeps only `ORCA_TERMINAL_HANDLE` from a process environment. No other variable is stored, logged or served.

- The hub keeps each host signal's history for 24 hours. A point stamped `ts` is kept while `ts >= now - 24 h` (the cutoff is inclusive) and removed when older.

## Preconditions

- A fixture `ARK_HOME` with an open run `RUN-A` and a closed run `RUN-C` (listed in the hub's run list as closed), and a `$TMPDIR` of the fixture.
- A fake `orca` that lists one agent with handle `H1` working on `RUN-A` (step and model set), and one with handle `H2` on `RUN-B` (an open run).
- A fake `ps` and a fake `lsof` that the source runs in place of `/bin/ps` and `lsof` (the seam of the resources source: its path from an env var or PATH in test mode). The fake `ps` prints each line as one space-joined string `command args... ENV=value ...`, the shape of the real `ps -E -ww`. Its fixture holds these processes:
  1. `bun test` with `ORCA_TERMINAL_HANDLE=H1`, cwd anywhere (agent).
  2. A `git` child that inherits `ORCA_TERMINAL_HANDLE=H1` and has its cwd in the folder of `RUN-C` (agent wins over leftover).
  3. `playwright` with no handle, cwd in `runs/RUN-A/workspace` (run).
  4. `chromium`, no handle, cwd outside every run folder, process group held by a started `ark test` ticket of `RUN-B` (admission).
  5. `bun test` of the base side: no handle, cwd `$TMPDIR/ark-base-xxxx`, pid whose group is held by a started ticket of `RUN-B` (admission, not other).
  6. `astro preview`, no handle, cwd in `runs/RUN-C/workspace` (leftover; run `RUN-C`, age from its start time).
  7. A process with no handle and a cwd in `/tmp/unrelated` (other).
  8. Each of lines 1-7 carries the variables `GH_TOKEN=ghp_FAKE_SECRET_418` and `AWS_SECRET_ACCESS_KEY=FAKE_SECRET_418`; line 3 also carries an env value with a space (`NOTE=a b ORCA_TERMINAL_HANDLE=EVIL`) after the real handle slot, to show a parse is by the first `ORCA_TERMINAL_HANDLE=` token only.
- Admission tickets are written by the fixture into the lock folder of the fixture `ARK_HOME` in the format of `cli/test-lock.ts`.
- The hub runs on a free port (`--port 0`) with a page open (an SSE client) so the source samples, and an injected clock the test sets (also used by the history scenario, step 9).
- For step 9, a fixture history file or sample feed for the signal `swap` (T = injected now) with points `A` at T minus 23 h 59 m 59 s, `B` at T minus 24 h 00 m 00 s exactly, `C` at T minus 24 h 00 m 01 s, and `D` at T minus 1 h.

## Steps

1. Start the hub with the fixtures and open one SSE client.
2. Wait for the first `resources` sample (`sources.resources` not stale, `ARK_HUB_INTERVAL_MS` set small).
3. `GET /api/snapshot` and read the `resources` part. Record the owner of each of the seven processes.
4. `GET /api/resources/history` (with and without a good Host header) and read the whole body.
5. Capture the first SSE push that holds the `resources` slot.
6. Read `results/resources.json` of `RUN-A` after the hub writes its `agents` key, and any hub log file.
7. Grep the bodies of steps 3, 4 and 5, `results/resources.json` and the hub log for `ghp_FAKE_SECRET_418`, `FAKE_SECRET_418`, `GH_TOKEN`, `AWS_SECRET_ACCESS_KEY` and `EVIL`.
8. Repeat steps 3-7 once with the fake `lsof` failing (exit 1, no output) and once with a fake `ps` that rejects `-E`.
9. History window: with the clock at T, `GET /api/resources/history` and read the `swap` points. Advance the clock by 2 s, trigger one more sample, and read again. Advance by 1 h and read again.

## Expected results

- Owners: 1 and 2 -> agent `H1` (process 2 is not `leftover`, though its cwd is in `RUN-C`); 3 -> run `RUN-A`; 4 and 5 -> admission of `RUN-B` (process 5 is not `other`); 6 -> `leftover`, run `RUN-C`, with an age and the command text; 7 -> `other`.
- The kind of each process is read from the head of the command: `bun test`, `git`, `playwright`, `chromium`, other (process 6 and 7).
- Each process has exactly one owner; the sum of processes over all owners equals the 7 of the fixture.
- Process 3 is not attributed to agent `EVIL` or to a handle with the text `a b`.
- No body of step 7, no `resources.json` and no log holds any of the secret strings or the names `GH_TOKEN` / `AWS_SECRET_ACCESS_KEY`. A body may hold the handle `H1`.
- Step 8: with `lsof` failing, cwd is unavailable, so only ownership that does not need cwd survives: processes 1 and 2 (handle) stay on agent `H1`; processes 4 and 5 stay on admission of `RUN-B` (process group, independent of cwd); process 3 (run by cwd) and process 6 (leftover by cwd) go to `other`; process 7 stays `other`. The source is marked degraded (not a throw, not an empty list). Each process still has one owner, 7 in all. With `ps` failing, the `resources` slot reports its error, shows no process, and the other sources stay fresh. The secrets are still absent.
- Step 9 (cutoff = now minus 24 h, inclusive): at T the `swap` history holds `A`, `B` (exactly at the cutoff, kept) and `D`, and not `C`. After +2 s the cutoff is T minus 23 h 59 m 58 s, so `A` (23 h 59 m 59 s before T, now 24 h 00 m 01 s old) and `B` are both gone; only `D` and the new samples remain. After a further +1 h (T + 1 h 2 s, cutoff T minus 22 h 59 m 58 s) `D` (T minus 1 h) is still kept, with every sample taken since; no point is older than the cutoff, so the count equals the points stamped within `[now-24h, now]`. A history that grows without bound, keeps `A` or `B` after +2 s, or drops `A` or `B` at T, fails.

## Screenshot checkpoints

none: no UI surface in this case; the proof is the owner of each process and a text search of every output.
