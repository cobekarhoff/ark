---
id: ARK-T732
title: ARK-T732 a companion wake that ark run start or ark evaluation record cannot send never fails the command, prints one not-sent line on stderr for each companion, never waits for a lock, never retries and is bounded in time, and the next ark companions sync sends it
level: integration
technique: equivalence classes on the cause (send fails, Orca down, Orca slow, no live worker, lock held by a live sync, an older unsent event) with a catch-up sync after each; boundary on the stream (stdout is the run id alone)
priority: high
risk: "a failed or unreachable wake fails ark run start (exit 1, no run, or no run id printed) or ark evaluation record; the not-sent line goes to stdout and breaks the run id Master Chief reads from ark run start; the line has an ark: prefix or another text; two lines for one companion, or a line for a companion with nothing to send; the command waits for a held lock or retries a failed send; a hung Orca holds the command for about 130 s; the command starts a worker for a companion with no live worker, or stops or releases one; the command keeps no event, or does not do what it does with no companion (the worktree, the state, the kind warning); the cursor moves past a wake that was not sent, so the next sync loses it; a non-ArkError thrown in the wake propagates out of the command"
status: active
changed_by: 2026-11-20-ARK-521-1
---

## Objective

Prove that when the wake cannot be sent, `ark run start` and `ark evaluation record` print `companion <name>: wake <trigger> for <run> not sent: <reason>` on stderr, one line for each companion, keep their event and their normal result, exit 0, start or stop no worker, never wait for a lock or retry, return within a few seconds of a hung Orca, and that `ark companions sync` then sends the wake. Serves ARK-521/AC4.

## Preconditions

- The setup of ARK-T731: a temp `ARK_HOME`, project `p`, the fake orca with a Master Chief Run and live workers, two companions `alpha` and `beta`, both with `on: [run.started, criteria.opened]` and a `cursor.json` from an earlier sync.
- Fake settings (existing verbs of `test/fake-companion-tools.ts`): `failSendTo` for one companion, `failSendOnce`, `failVerbs` for `run-list` and `worker-list`, `failAll`, and a hang for a send or a read longer than the bound of the command (a delay far past a few seconds, with a marker file the fake writes when the call ends, so the test waits for the command or for the marker, never for a millisecond sleep).
- A held lock: `companions/alpha/sync.lock` created with the pid of a live process that the test started and stops by that pid (a real second process, not a file edited after the fact).

## Steps

For each cause below, start from a fresh state, run `ark run start` for a new ticket and then `ark evaluation record` with blockers for that run. Read stdout, stderr, the exit code, `events.ndjson`, the call log, and the files of each companion. Then run `ark companions sync` with the cause removed and read the `send` records.

1. The send fails for `alpha` only (`failSendTo`).
2. The send fails for both companions.
3. Every Orca call fails (`failAll`), and also only `run-list` fails, and only `worker-list` fails.
4. Orca does not answer: a hung send, and a hung `worker-list`; run the command with a timer that checks the command ended before the fake's hung call.
5. `beta` has no live worker (the fake `worker-list` has no row for it; its `worker.json` is recorded).
6. A live sync holds the lock of `alpha` (the lock of step "preconditions"); `beta` is free.
7. An older unsent event: `send` failed once for an `escalation.requested` of the same run (as in ARK-T731 step 5), then the command runs.
8. `ark run start` for a ticket of `kind: bug` with no `method: test` AC (it prints a warning today), with the wake failing.

## Expected results

- Every step: exit code 0. For `ark run start`, stdout is the run id and nothing else; the run folder, ticket copy, `run.started` event in `events.ndjson` and the ticket status `in_progress` are as with no companion; for `ark evaluation record`, stdout is the one `recorded evaluation: ...` line and the `evaluation.recorded` event is kept. Stderr holds nothing but the not-sent lines (and the existing kind warning in step 8, before them).
- Step 1: one stderr line `companion alpha: wake run.started <run> not sent: <send error>` and no line for `beta`, whose wake is sent; the same for the evaluation with `criteria.opened`. The cursor of `alpha` does not pass the event, `beta`'s does. The catch-up sync sends `alpha` the wake once; `beta` is sent nothing again.
- Step 2: one line for `alpha` and one for `beta`, each once, no line holds `ark: `.
- Step 3: one line for each companion that names the failing verb (`run-list failed: ...`, `worker-list failed: ...`, or the send error), once for each, not one line in total; no `send` is recorded; the cursors do not move. The catch-up sync sends both wakes.
- Step 4: the command ends with the line `... not sent: <a timeout reason>` for each companion and exit 0 before the fake's hung call ends (the marker file is absent when the command returns), so the delay of the command is bounded by the few seconds of the bound, not by the 10 s read or 120 s send time of `cli/orca.ts`. No retry: the call log holds one call of the hung verb for the command. The test names the bound it checks.
- Step 5: `beta` gets the line `companion beta: wake <trigger> for <run> not sent: <no live worker reason>`; the call log holds no `worker-start`, no `worker-stop` and no release; `beta`'s record `worker.json` is unchanged; `alpha` is sent normally. Only the catch-up sync starts `beta`'s worker.
- Step 6: `alpha` gets `companion alpha: wake <trigger> for <run> not sent: another sync is running` (the `acquireLock` text); the command does not wait (it returns while the lock holder is alive) and does not retry; `beta` is sent normally. `alpha`'s lock file and cursor are not touched by the command. After the test stops its lock holder by pid, the sync sends `alpha`'s wake once.
- Step 7: the line names the older trigger `escalation` for the older event, not the command's own; the cursor stays behind the escalation; one line for the companion; the catch-up sync sends the escalation and the command's event in order, each once.
- Step 8: the `kind` warning is printed as before this ticket, then the not-sent lines; the exit code is 0 and stdout is still the run id.
- A throw that is not an `ArkError` inside the wake (for example an unreadable `cursor.json`) is printed as a not-sent line and does not change the exit code or the event.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
