---
id: ARK-T296
title: "ARK-T296 temp-cleaner sends one 'Disk low: <n> GB free' message per drop below the limit and sends again only after free disk rose above it"
level: integration
technique: "state transition (above, below, still below, above, below) and boundary values at the limit"
priority: high
risk: "free disk exactly at the limit resets the state (guard `free >= limit` instead of `free > limit`) so the next below-limit sample repeats the message; the cleaner still exits on low disk; it sends each pass while the disk stays low; it never sends the second drop (state not reset on recovery); a launchd restart while low repeats the message; <n> is wrong or the message goes to the wrong Run"
status: active
changed_by: 2026-11-12-ARK-358-1
---

## Objective

When free disk is below the limit, `scripts/temp-cleaner.sh` sends one `Disk low: <n> GB free` message to the Master Chief Run and goes on. It sends again only after free disk went above the limit and fell below it again.

## Preconditions

- A fake `df` first on PATH whose output is read from a file the test rewrites; a fake `orca` as in ARK-T295 (paged `run-list`, logged `send`); scratch `TMPDIR`; `ARK_PROJECT=ark`.
- The limit is the script's own value (15 GB today); the test reads or sets it the same way the script does.

## Steps

1. Free disk at limit + 5 GB. Run the cleaner in loop mode, wait two passes. Check there is no send.
2. Set free disk to limit - 1 GB (drop 1). Wait three passes.
3. Set free disk to limit + 1 GB. Wait two passes. Check no send.
4. Set free disk to limit - 3 GB (drop 2). Wait three passes.
5. Kill and restart the script while still low; wait two passes.
6. Set free disk to exactly the limit; wait two passes.
7. Set free disk to limit - 1 GB immediately after step 6; wait three passes.
8. Set free disk to limit + 1 GB; wait two passes. Check no send.
9. Set free disk to limit - 2 GB (drop 3); wait three passes.

## Expected results

- Step 1: no send.
- Step 2: one send, subject `Disk low: <n> GB free` with `<n>` the faked value, to the Master Chief Run; the process is alive and still sweeping.
- Step 3: no send, state reset.
- Step 4: a second send, two in total.
- Step 5: no third send (the state survives the restart, or the plan states otherwise and the case follows it).
- Step 6: no send (at the limit is not below it, and it does not reset the state).
- Step 7: no additional send (still two in total): equality did not count as recovery.
- Step 8: no send, state reset (free disk went above the limit).
- Step 9: a third send, three in total, `<n>` the faked value.
- Existing ARK-T190 and ARK-T193 runs with `--once` stay green.

## Screenshot checkpoints

none: script and log output, no UI.
