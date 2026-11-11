---
id: ARK-T240
title: ARK-T240 With no change in any source, 10 reads of every source send 0 pushes after the first, a changed answer pushes once, and a source that fails then recovers pushes on each ok flip and restarts its healthy period
level: integration
technique: state transition (healthy, failed, healthy) and equivalence classes (no change, data change, ok flip)
priority: high
risk: the read time stays in the body that publish() compares, so each source loop pushes on every read and one open tab gets tens of MB a minute; or the healthy-period start moves on each read, or fails to restart after a failure, so the Stale label shows a false age
status: active
changed_by: 2026-11-11-ARK-365-1
---

## Objective

Prove that the hub pushes only when data changes. Serves ARK-365/AC1.

Expected: Where no source changes its data, the hub shall send no push, and the time of a source's last read in the body shall be the start of its current healthy period.

## Preconditions

- A temporary `ARK_HOME` and a temporary git repo as the Ark repo, with a project and a run in `building`.
- Fake `orca`, `plannotator` and `gh` binaries first on `PATH`. Each appends one line to its own call-log file on every start and prints a fixed valid answer. A control file makes each one fail (exit 1) or change its answer.
- `ARK_HUB_INTERVAL_MS=100` so every source interval is 100 ms.
- The hub is started with `Bun.spawn` on port 0 and its port is read from its output.
- The run has an open plan gate (the gate event appended to its `events.ndjson`) and one merge request URL in its `state.json`, so Plannotator and GitHub have something to read. Fake `gh` answers `pr view` for that URL. (The `ark` source reads files and starts no binary, so it has no call log; its reads show through its `read_at`.)
- One client holds `/events` open and records each push with its body.

## Steps

1. Connect to `/events`. Wait until each call log (orca, plannotator, gh) has at least one line and the first push shows all three sources read. Take the baseline from the latest push after that: its body and the `read_at` of orca, plannotator, github and ark.
2. Wait until each call log has at least 10 more lines than at the baseline (about 1 s). Count the pushes since the baseline.
3. Compare each source's `read_at` in `/api/snapshot` with the baseline.
4. Change the fake orca answer (a new terminal). Wait for 2 reads. Count the pushes.
5. Make fake `gh` exit 1. Wait for 2 reads. Record the pushes and the github `ok` and `read_at`.
6. Make fake `gh` succeed again. Wait for 2 reads. Record the pushes, the `ok` and the `read_at`.
7. Repeat step 5 and 6 with fake `orca` and with fake `plannotator`.

## Expected results

- Step 2: at least 10 new reads of orca, plannotator and github in the call logs and 0 pushes after the baseline.
- Step 3: every `read_at` (ark included) equals the baseline.
- Step 4: exactly 1 push, and it shows the new terminal.
- Step 5: 1 push with that source `ok: false`; no further push on later failed reads; the other sources' `read_at` stay unchanged.
- Step 6: 1 push with `ok: true` and a `read_at` later than the baseline (a new healthy period); no further push on later reads.
- Step 7: the same for orca and plannotator; a failing binary never makes the hub exit.

## Screenshot checkpoints

none: process, call-log and event-stream assertions only
