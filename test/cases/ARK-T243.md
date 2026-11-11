---
id: ARK-T243
title: ARK-T243 The hub reads Plannotator only while a run has an open gate, reads at once when a gate opens, and clears review_url when the gate closes
level: integration
technique: equivalence classes (run with a gate, run without) and state transition (no gate, gate open, gate closed)
priority: high
risk: Plannotator is read every 5 s with an empty answer (17,000 runs a day); or a gate that opens waits up to a full interval for its review link; or a closed gate keeps its old review_url or shows plannotator as failed
status: active
changed_by: 2026-11-11-ARK-365-1
---

## Objective

Prove that the Plannotator read follows the gate. Serves ARK-365/AC4.

Expected: The hub shall read Plannotator sessions only while a run has an open gate. When a gate opens the read shall start at once. When the gate closes the hub shall stop the read and clear review_url.

## Preconditions

- A temporary `ARK_HOME` and a temporary git repo as the Ark repo, with a project and a run in `building`.
- Fake `orca`, `plannotator` and `gh` binaries first on `PATH`. Each appends one line to its own call-log file on every start and prints a fixed valid answer. A control file makes each one fail (exit 1) or change its answer.
- `ARK_HUB_INTERVAL_MS=100` so every source interval is 100 ms.
- The hub is started with `Bun.spawn` on port 0 and its port is read from its output.
- One client holds `/events` open.
- Fake `plannotator` returns one session whose URL is `http://localhost:20000/review`.
- Run R1 is in `building` with no gate. Run R2 is in `planning` waiting at the plan gate.

## Steps

1. With only R1 (no gate) connected, wait 2 s at a 100 ms interval. Count the lines in the plannotator log. Record R1's `review_url` and the plannotator `ok`.
2. Restart the hub with `ARK_HUB_INTERVAL_MS=60000`. Connect a client. Open the plan gate on R2 by appending the event. Record the time from the append to the push with `review_url` set.
3. With the gate open at the 100 ms interval, record the plannotator read rate and R2's `review_url`.
4. Answer the gate (append the event). Wait 2 s. Count the log lines and read R2's `review_url` and the plannotator state.
5. Open a gate on R2 and make fake `plannotator` exit 1. Record the push and that the hub stays up. Close the gate.
6. Open two gates on two runs, close one. Check the log keeps growing.
7. Open a gate while the first client connects (idle hub, ARK-T241 wake) and record the first read.

## Expected results

- Step 1: 0 plannotator log lines; `review_url` is null; the plannotator `ok` is not shown as failed and no Stale label names plannotator.
- Step 2: `review_url` appears within one ark read of the append, not 60 s later, because the gate opening wakes the read.
- Step 3: reads happen at the interval and R2 has `review_url`.
- Step 4: no new log lines after the gate closes (a read in flight may finish); `review_url` is null; the plannotator state is not failed.
- Step 5: the hub stays up; the failed read leaves `review_url` null; after the gate closes no failed plannotator label shows.
- Step 6: reads continue while any gate is open; the closed run has no `review_url`.
- Step 7: the first plannotator read comes with the first wake, and the run with the gate gets `review_url`.

## Screenshot checkpoints

none: process, call-log and event-stream assertions only
