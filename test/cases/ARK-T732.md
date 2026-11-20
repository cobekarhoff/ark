---
id: ARK-T732
title: ARK-T732 a companion wake that ark run start or ark evaluation record cannot send never fails the command, prints one not-sent line on stderr for each companion, never waits for a lock, never retries and is bounded in time, and the next ark companions sync sends it
level: integration
technique: equivalence classes on the cause (send fails, an Orca read fails, Orca hangs, no live worker, no worker yet, lock held by a live process, an older unsent event) with a catch-up sync after each; boundary on the stream (stdout is the run id alone)
priority: high
risk: "a failed or unreachable wake fails ark run start (exit 1, no run, or no run id printed) or ark evaluation record; the not-sent line goes to stdout and breaks the run id Master Chief reads from ark run start; the line has an ark: prefix or another text; two lines for one companion; a line for a companion that was never synced and has nothing to send, or one that says no live worker for it on every start; the command waits for a held lock or retries a failed send; a hung Orca call (send, worker-list, or the terminal list of the sender lookup) holds the command for the 10 s read or the 120 s send timeout; the command starts a worker for a companion with no live worker, or stops or releases one; the command loses its event or does not do what it does with no companion (the worktree, the state, the kind warning); the cursor moves past a wake that was not sent, so the next sync loses it; the older unsent wake is lost behind the command's own"
status: active
changed_by: 2026-11-20-ARK-521-1
---

## Objective

Prove that when the wake cannot be sent, `ark run start` and `ark evaluation record` print `companion <name>: wake <trigger> for <run> not sent: <reason>` on stderr, one line for each companion, keep their event and their normal result, exit 0, start or stop no worker, never wait for a lock or retry, return within the bound of a hung Orca call, and that `ark companions sync` then sends the wake. Serves ARK-521/AC4.

## Preconditions

- The setup of ARK-T731: a temp `ARK_HOME`, project `p`, the fake orca with a Master Chief Run and live workers, and two companions `alpha` and `beta`, both with `on: [run.started, criteria.opened]` and a `cursor.json` from an earlier sync. Steps 7 and 8 use their own companion as named there. `ORCA_AGENT_SESSION_ID` is unset, as for Master Chief's `ark run start`, so each send looks up the sender with `terminal list`.
- Existing settings of the fake (`test/fake-companion-tools.ts`): `failSendTo`, `failSendOnce`, `failVerbs`, `failAll`.
- Two new opt-in settings of the same fake, which no other case sets: a list of verbs that hang (any word of the fake: `send`, `run-list`, `worker-list`, `terminal list`) for a time longer than the bound of the command and shorter than the 10 s read timeout of `cli/orca.ts` (8 s), and a marker file `hung-done.jsonl` the fake appends to when a hung call ends. The proof of the bound is the marker: when the command returns the marker is absent, so the command did not wait for the hung call. The test uses no millisecond budget. Every case that runs this fake is listed in `test-design.md` as `reuse`: the settings default to off.
- A held lock: `companions/alpha/sync.lock` created with the pid of a live process that the test started and stops by that pid (a real second process, not a file edited after the fact).

## Steps

For each cause below, start from a fresh state, run `ark run start` for a new ticket and then `ark evaluation record` with blockers for that run, with the cause still in place for both. Read stdout, stderr, the exit code, `events.ndjson`, the call log, and the files of each companion. Then run `ark companions sync` with the cause removed and read the `send` records.

1. The send fails for `alpha` only (`failSendTo`).
2. The send fails for both companions.
3. `run-list` fails (`failAll`: it is the first call of the wake). In a second state only `worker-list` fails (`failVerbs`).
4. Orca does not answer: a hung `send`; in a second state a hung `worker-list`; in a third a hung `terminal list` (the sender lookup).
5. `beta` has a recorded `worker.json` and a cursor, and the fake `worker-list` has no row for it (its worker is gone). `gamma`, listed in `ark.yml` and never synced (no `worker.json`, no `cursor.json`, no worker row), is the third companion with `on: [run.started]`.
6. A live process holds the lock of `alpha` (the lock of the preconditions); `beta` is free.
7. An older unsent event: a companion `both` with `on: [escalation, criteria.opened]`, live, with a cursor. Append a raw `escalation.requested` event to a run `K1` with no sync after it, make the fake `send` fail once (`failSendOnce`), then run `ark evaluation record` for `K1` with blockers. Then run the sync with `send` working.
8. `ark run start` for a ticket of `kind: bug` with no `method: test` AC (it prints a warning today), with the send failing for `alpha`.
9. The `terminal list` call alone fails (`failVerbs`), with no other cause: the sender lookup of the send.

## Expected results

- Every step: exit code 0. For `ark run start`, stdout is the run id and nothing else; the run folder, ticket copy, `run.started` event in `events.ndjson` and the ticket status `in_progress` are as with no companion; for `ark evaluation record`, stdout is the one `recorded evaluation: ...` line and the `evaluation.recorded` event is kept. Stderr holds nothing but the not-sent lines (and the existing kind warning in step 8, before them). No line holds `ark: `.
- Step 1: `ark run start` prints `companion alpha: wake run.started <run> not sent: <send error>` and no line for `beta`, whose wake is sent. `ark evaluation record`, run while `alpha`'s `run.started` is still unsent, prints the same line naming `run.started` (the run's unseen events go in order and stop at the first failure), not `criteria.opened`. The cursor of `alpha` stays behind `run.started`; `beta` is sent both wakes once. The catch-up sync sends `alpha` two wakes, `run.started` and then `criteria.opened`, each once, and `beta` nothing.
- Step 2: one line for `alpha` and one for `beta` from each command, each once; both name `run.started`; the catch-up sync sends each companion `run.started` and then `criteria.opened`, once.
- Step 3: one line for each companion from each command, naming the failing call (`run-list failed: ...`, `worker-list failed: ...`), once for each, not one line in total; the lines name the command's own trigger (`run.started` for the start, `criteria.opened` for the evaluation), because no step was built; no `send` is recorded; the cursors do not move; the call log holds no `worker-start`, `worker-stop` or release. The catch-up sync sends each companion `run.started` and `criteria.opened`, once each, in order.
- Step 4: each command returns exit 0 with a not-sent line for each companion whose call hung (`... not sent: <a timeout reason>`) and the marker file absent. For the hung `send` and `worker-list` the wake is not delivered, and the call log holds one `send` for each companion for each command (`applySteps` stops a companion at its first failure, so `alpha` and `beta` each get one call, never two) and one `worker-list` for each command (it is read once before the companions); no call is repeated. For the hung `terminal list` the sender lookup is swallowed as in sync: the wake is delivered with no `from`, stderr is empty, and the marker is absent. The delay is bounded by the few seconds of the bound, not by the 10 s read or 120 s send timeout of `cli/orca.ts`. The catch-up sync sends what was not delivered, once each.
- Step 5: `beta` gets the line `companion beta: wake <trigger> for <run> not sent: <no live worker reason>` from each command; `gamma` gets no line, no `send`, and no `worker.json` or `cursor.json` is written for it (it has no cursor, so there is nothing to send: the first-sync rule); the call log holds no `worker-start`, no `worker-stop` and no release; `beta`'s `worker.json` is unchanged; `alpha` is sent normally. Only the catch-up sync starts `beta`'s and `gamma`'s workers; it sends `beta` `run.started` and `criteria.opened`, once each, and `gamma` nothing for the older events.
- Step 6: `alpha` gets `companion alpha: wake <trigger> for <run> not sent: another sync is running` (the `acquireLock` text) from each command; the command does not wait (it returns while the lock holder is alive) and does not retry; `beta` is sent normally. `alpha`'s lock file and cursor are not touched by the command. After the test stops its lock holder by pid, the sync sends `alpha` `run.started` and `criteria.opened`, once each, in order.
- Step 7: the line names the older trigger `escalation`, not `criteria.opened`; one line for the companion; the cursor of `both` stays behind the escalation. The catch-up sync sends the escalation and then the `criteria.opened` wake, in event order, each once; no event is lost.
- Step 8: the `kind` warning is printed as before this ticket, then the not-sent line; the exit code is 0 and stdout is still the run id.
- Step 9: the wake is sent as sync sends it with no live Master Chief terminal: delivered with no `from`, no not-sent line, stderr empty, exit 0; the failure of the sender lookup is not an error of the wake.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
