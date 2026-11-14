---
id: ARK-T661
title: ARK-T661 two real ark processes that sync at once start one worker and wake once for each event, and parallel answers and a sync that writes the cursor leave every answer line whole and the cursor readable
level: integration
technique: race with real processes (start two processes on a barrier file; repeat the pair 10 times) and state transition on the state files of companions/<name>/
priority: medium
risk: "two syncs (chief state of Master Chief and a second chief state or the hub's ask) both see no live worker and start two workers for one companion, or both read the same cursor and send the same wake twice; two answers write at the same time and one is lost or two lines are cut into each other; a cursor read half-written by a sync crashes the next sync or reads as a first sync and resends nothing or everything"
status: active
changed_by: 2026-11-14-ARK-480-1
---

## Objective

Prove the state files of `companions/<name>/` and the Orca calls of the sync hold when two real `ark` processes run at the same time: one worker for one companion, one wake for one event, and no lost or torn answer line. Serves ARK-480/AC2, AC3 and AC4 (the race that evaluation.md names for ask during a sync).

## Preconditions

- A temp `ARK_HOME`, project `p` with the companion `cortana` listed, `on: [run.merged]`, no live worker, and a fake orca (ARK-T656) whose `worker-start` and `send` each take 200 ms and append to a call log, so the two processes overlap in the fake.
- A first sync was done with one run closed `merged` (so a cursor exists), then a second run is closed `merged` after it.
- Real processes (`Bun.spawn` of `bun cli/ark.ts`), not calls in one process.

## Steps

1. With no live worker and no cursor: start two `ark companions sync --project p` at once. Read the call log and `companions/cortana/`.
2. With a live worker and the new merged run waiting: start two `ark companions sync` at once.
3. Start 8 `ark companion answer cortana "answer <n> ..." --project p` (each text 2 KB, with a newline inside) and one `ark companions sync` at once.
4. Repeat steps 2 and 3 ten times.

## Expected results

- Step 1: the log has one `worker-start` for `cortana`; both processes exit 0 or one exits 1 with an `ark: ` line that says another sync is running; the recorded dispatch id is the one worker's.
- Step 2: the log has one `send` for the new run; the next sync sends nothing.
- Step 3: `answers.md` has 8 entries, each whole and equal to its text, in some order; the cursor file parses and holds the merged run's time; no process exits with a stack trace.
- Step 4: the same in each round.

## Screenshot checkpoints

None. The surface is files and process output; no screenshot applies.
