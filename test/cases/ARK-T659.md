---
id: ARK-T659
title: ARK-T659 ark companion advise sends the run lead one message marked as advice that is not a gate answer plus a copy to Master Chief, and ark companion propose writes a ticket with status proposed and a source line and never overwrites a ticket or queues it
level: integration
technique: equivalence classes (a run with a live lead, a run with none, an unknown run, a name not in ark.yml, a new ticket id, an existing ticket id, a file that is not a valid ticket) and state transition (no ticket file, proposed ticket)
priority: high
risk: "advice reaches the lead typed as a gate reply and the lead takes it as the human's answer; the copy to Master Chief is missing, so the human never sees the advice; advice goes to the wrong run's lead or to a closed run; propose overwrites an existing ticket, including one at status ready, or writes it ready so it is queued; a ticket with the new `source` key is rejected by readTicket or the hub readers; a name that is not in ark.yml still writes or sends"
status: active
changed_by: 2026-11-14-ARK-480-1
---

## Objective

Prove `ark companion advise <name> <run> <text>` sends the lead of that run one message that reads as advice from the companion and not as a gate answer, with one copy to Master Chief; and `ark companion propose <name> <file>` writes the ticket file with `status: proposed` and a source line that names the companion and does nothing else. Both refuse a name that is not in `ark.yml`. Serves ARK-480/AC5.

## Preconditions

- A temp `ARK_HOME`, project `p` (ticket source `local`, tickets folder `projects/p/tickets/`) with the companion `cortana` listed. The fake orca of ARK-T656 lists the Master Chief Run with a lead whose `worker-list` workspace is `<run folder>/workspace` of an open run `R1`, no lead for the open run `R2`, and logs each `send` and any `task-create`.
- A ticket `ARK-900` already in `tickets/` at `status: ready`.
- A draft file `draft.md` with front matter `id: ARK-901`, `title`, `status: ready` (a companion tried to set it), valid `acceptance_criteria`, and a second draft with `id: ARK-900`, and a third with no `id`.

## Steps

1. Run `ark companion advise cortana R1 "Run R1 touches the same file as R3." --project p`.
2. Run `advise` for `R2` (no live lead), for a run name that does not exist, and for `ghost`.
3. Run `ark companion propose cortana draft.md --project p` (id `ARK-901`).
4. Run `propose` with the draft whose id is `ARK-900`, with the draft that has no id, with `ghost`, and with a path that does not exist.
5. Read `ARK-901` with the ticket reader that `ark run start <ticket-file>` uses, and load the Roadmap data of the hub for `p`.
6. Run `bun test test/roadmap.test.ts test/ticket-status.test.ts`.

## Expected results

- Step 1: exit 0; exactly two `send` calls: one to the lead of `R1` and one to Master Chief. The lead's message has `--type status` (never a type the run lead skill reads as a reply or gate answer), a subject that starts with a fixed prefix naming advice and `cortana`, and a body that holds the text and the words `not a gate answer`; the copy to Master Chief holds the same text, the name and `R1`. No call goes to another run's lead.
- Step 2: `R2` with no live lead exits 1 with an `ark: ` line that names the run and sends nothing to a lead; an unknown run and `ghost` exit 1 with an `ark: ` line (`ghost`: not in ark.yml) and send nothing.
- Step 3: exit 0; `tickets/ARK-901.md` exists with `status: proposed` (not `ready`) and a `source:` line that names `cortana`; its other front matter and body are the draft's; no `task-create` and no `send` call was made, so nothing is queued.
- Step 4: the draft with id `ARK-900` exits 1 with an `ark: ` line that names the existing ticket, and `tickets/ARK-900.md` is byte for byte what it was, still `status: ready`; the draft with no id, `ghost` and the missing path exit 1 with an `ark: ` line and write no file.
- Step 5: The reader reads `ARK-901` with no warning and no error although `source` is a key no ticket has used; the hub roadmap lists `ARK-901` once in its Review list (the existing `proposed` list) and no other list shows it.
- Step 6 exits 0.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
