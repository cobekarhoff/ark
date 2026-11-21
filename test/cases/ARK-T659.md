---
id: ARK-T659
title: ARK-T659 ark companion advise sends the run lead, addressed by its terminal, one message marked as advice that is not a gate answer plus a copy to Master Chief, or sends Master Chief the advice marked not delivered with the reason when the lead is gone or its send fails; and ark companion propose writes a ticket with status proposed and a source line and never overwrites a ticket or queues it
level: integration
technique: equivalence classes (a run with a live lead, a run with none, a lead row with no terminal, an unknown run, a name not in ark.yml, a new ticket id, an existing ticket id, a file that is not a valid ticket), state transition (a lead row with no terminal on the first `worker-list` read and with or without one on the second; no ticket file, proposed ticket) and error guessing (each Orca call that can fail or time out)
priority: high
risk: "advice reaches the lead typed as a gate reply and the lead takes it as the human's answer; the copy to Master Chief is missing, so the human never sees the advice; advice goes to the wrong run's lead or to a closed run whose lead worker is still listed; the lead is gone, its send fails or times out, or its `worker-list` row has no terminal, and the advice reaches no one (the command throws, as on 2026-11-20 for ARK-574 and ARK-521) or is sent to `dispatch:<id>`, which Orca refuses with task_not_found after a restart; a lead row with no terminal is not read again, so a terminal that appears a moment later is missed; the advice that went to Master Chief instead exits 1 or prints nothing, so the companion resends it by hand; the Master Chief send also fails and the command exits 0 or names only one failure; propose overwrites an existing ticket, including one at status ready, or writes it ready so it is queued; a ticket with the new `source` key is rejected by readTicket or the hub readers; a name that is not in ark.yml still writes or sends"
status: active
changed_by: 2026-11-20-ARK-611-1
---

## Objective

Prove `ark companion advise <name> <run> <text>` sends the lead of that run, addressed by its terminal handle, one message that reads as advice from the companion and not as a gate answer, with one copy to Master Chief; and that advice the lead cannot get (no live lead, a lead row with no terminal after one more read, a failed or timed-out lead send, a failed lead lookup) reaches Master Chief as one message marked not delivered with the reason, never a `dispatch:<id>` recipient. Prove `ark companion propose <name> <file>` writes the ticket file with `status: proposed` and a source line that names the companion and does nothing else. Both refuse a name that is not in `ark.yml`. Serves ARK-480/AC5, ARK-611/AC1 and ARK-611/AC2.

## Preconditions

- A temp `ARK_HOME`, project `p` (ticket source `local`, tickets folder `projects/p/tickets/`) with the companion `cortana` listed. The fake orca of `test/fake-companion-tools.ts` lists the Master Chief Run (Master Chief terminal `term_chief`) with a lead `ctx_lead1` / `term_lead1` whose `worker-list` workspace is `<run folder>/workspace` of an open run `R1`, no lead for the open run `R2`, a lead still listed for the closed run `R3` (phase `closed`), and a lead `ctx_lead5` for the open run `R5`. It logs each call (`calls.jsonl`, every `send` attempt, refused or not) and each delivered `send` (`delivered.jsonl`), and any `task-create`.
- The fake can be set, per test, to: fail `send` to a named recipient with a named error (for example `task_not_found`, as real Orca answers a `dispatch:` recipient after a restart); hang `send` to one named recipient only (Master Chief's send still answers); fail one verb (`worker-list`); fail every verb (Orca down); disconnect the Master Chief terminal; answer `worker-list` with a script of rows per read, so the `R5` lead row has no `terminal` on the first read (the structured lead of a real Orca) and either has `term_lead5` or still has none on the second. `ARK_ORCA_TIMEOUT_MS` is set to a few seconds for the timeout step (long enough for the fake's reads on a loaded host), and the hang lasts longer than it.
- A ticket `ARK-900` already in `tickets/` at `status: ready`.
- A draft file `draft.md` with front matter `id: ARK-901`, `title`, `status: ready` (a companion tried to set it), valid `acceptance_criteria`, and a second draft with `id: ARK-900`, and a third with no `id`.

## Steps

1. Run `ark companion advise cortana R1 "Run R1 touches the same file as R3." --project p`.
2. Run `advise` for `R2` (no live lead).
3. Run `advise` for `R3` (closed, lead still listed), for a run name that does not exist, and for `ghost`.
4. Lead send fails: set `send` to `term_lead1` to fail with `task_not_found` and run `advise` for `R1`. Then set `send` to `term_lead1` to hang past `ARK_ORCA_TIMEOUT_MS` and run it. Then set `worker-list` to fail and run it.
5. Lead row with no terminal: set the `R5` lead row to have no `terminal` on the first `worker-list` read and `term_lead5` on the second, clear the call log, and run `advise` for `R5`. Then set it to have no `terminal` on both reads, clear the call log, and run it again.
6. Both recipients fail: set `send` to `term_lead1` and to `term_chief` to fail and run `advise` for `R1`. Set only `send` to `term_chief` to fail and run `advise` for `R2`.
7. Copy fails after delivery: set only `send` to `term_chief` to fail and run `advise` for `R1`.
8. Master Chief unreachable: disconnect the Master Chief terminal and run `advise` for `R1`. Set every Orca verb to fail and run it.
9. Run `ark companion propose cortana draft.md --project p` (id `ARK-901`).
10. Run `propose` with the draft whose id is `ARK-900`, with the draft that has no id, with `ghost`, and with a path that does not exist.
11. Read `ARK-901` with the ticket reader that `ark run start <ticket-file>` uses, and load the Roadmap data of the hub for `p`.

## Expected results

- Step 1: exit 0; exactly two delivered `send` calls: one to `term_lead1` and one to `term_chief`. The lead's message has `--type status` (never a type the run lead skill reads as a reply or gate answer), a subject that starts `Advice from companion cortana`, and a body that holds the text and the words `not a gate answer`; the copy to Master Chief holds the same text, the name and `R1`. No call goes to another run's lead.
- Step 2: exit 0; stdout is `advice for R2 went to Master Chief: <reason>`, where the reason says the run has no live run lead; stderr is empty. Exactly one delivered `send`, to `term_chief`, whose subject starts `Companion cortana advice for R2 (not delivered to the lead)` and whose body holds the reason and the text. No `send` attempt goes to any lead.
- Step 3: `R3` (closed) exits 1 with an `ark: ` line that says the run is closed and sends nothing, although its lead is listed; an unknown run and `ghost` (not in ark.yml) exit 1 with an `ark: ` line and send nothing, to the lead or to Master Chief.
- Step 4: each of the three runs exits 0 and prints `advice for R1 went to Master Chief: <reason>`. The reason names `task_not_found` in the first run, the timeout (`timed out after`) in the second, and the failed `worker-list` read in the third. Each run delivers exactly one `send`, to `term_chief`, with the subject prefix `Companion cortana advice for R1 (not delivered to the lead)` and a body that holds the reason and the text. [INFERENCE: the case treats a failed lead lookup like a lead that is gone; the evaluation leaves that choice to the plan, and the ticket's Why says advice must not reach no one.]
- Step 5: terminal on the second read: exit 0; exactly two `worker-list` calls (AC2: one more read); one delivered `send` to `term_lead5` (the advice) and one to `term_chief` (the copy `Companion cortana advised the lead of R5`), as in Step 1. No terminal on either read: exit 0; exactly two `worker-list` calls; stdout `advice for R5 went to Master Chief: <reason>` with a reason that says the lead has no terminal; one delivered `send`, to `term_chief`, with the not-delivered subject. In both runs no `send` attempt in the call log names a `dispatch:` recipient (the base code sends to `dispatch:ctx_lead5`, and the fake accepts it, so only the attempt log shows it).
- Step 6: each run exits 1 with one `ark: ` line on stderr that names both failures: for `R1` the error the lead send gave and the error the Master Chief send gave; for `R2` the missing lead and the error the Master Chief send gave. Stdout has no `went to Master Chief` line, and no `send` is delivered.
- Step 7: exit 1 with an `ark: ` line that says the copy to Master Chief failed; the lead keeps the advice (one delivered `send`, to `term_lead1`), and stdout has no `went to Master Chief` line, because the lead got it.
- Step 8: with no live Master Chief, exit 1 with an `ark: ` line that names the missing Master Chief, and no `send` is delivered. With Orca down, exit 1 with an `ark: ` line naming the Orca error, and no `send` is delivered. Neither run prints `went to Master Chief`.
- Step 9: exit 0; `tickets/ARK-901.md` exists with `status: proposed` (not `ready`) and a `source:` line that names `cortana`; its other front matter and body are the draft's; no `task-create` and no `send` call was made, so nothing is queued.
- Step 10: the draft with id `ARK-900` exits 1 with an `ark: ` line that names the existing ticket, and `tickets/ARK-900.md` is byte for byte what it was, still `status: ready`; the draft with no id, `ghost` and the missing path exit 1 with an `ark: ` line and write no file.
- Step 11: The reader reads `ARK-901` with no warning and no error although `source` is a key no ticket has used; the hub roadmap lists `ARK-901` once in its Review list (the existing `proposed` list) and no other list shows it.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
