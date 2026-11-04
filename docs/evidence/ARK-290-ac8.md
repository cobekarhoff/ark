# ARK-290-AC8 evidence

Manual criterion. The human reviewed `~/.ark/projects/ark/ROADMAP.md` and the slimmed `~/.ark/projects/ark/tickets/README.md`.

human: ok

## Ranks the human saw

- As first ranked: Now ARK-290, ARK-296, ARK-302, ARK-288.
- At confirmation, after merged tickets were dropped: Now ARK-290; Next ARK-291, ARK-303, ARK-293; Later ARK-202, ARK-158, ARK-159.

## ROADMAP.md (on disk now)

```markdown
## Vision

Ark takes a ticket to merge-ready changes in one repo or several, and you decide only at gates and at merge.

## Milestones

| id  | name                           | outcome                                                                                         | state  |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------- | ------ |
| M1  | Core loop on the Ark repo      | One Ark ticket goes from Master Chief to a merged pull request.                                 | done   |
| M1a | First design                   | The old ledger design, superseded by the redesign of 2026-10-29.                                | done   |
| M2  | Multi-repo on Clara, first cut | Bootstrap and parsers for Clara.                                                                | done   |
| M3  | Self-improvement               | Retro, close check, deep interview and learnings.                                               | done   |
| M4  | Hub                            | A read-only hub shows live runs, plans and the backlog.                                         | done   |
| M5  | Reliable runs                  | A run starts, plans, builds and closes with no manual repair.                                   | active |
| M6  | MR follow-up                   | After an MR opens, Ark handles CI, review comments and conflicts until you merge.               | later  |
| M7  | Multi-repo                     | One ticket goes across a multi-repo workspace (Smart QC first, then Clara) in dependency order. | later  |
| M8  | Models and vendors             | Each step reports its real model, and a provider limit does not stop a run.                     | later  |
| M9  | See the work                   | The hub shows what is next, why, and what each run did.                                         | active |

## Now

- ARK-304
- ARK-290

## Next

- ARK-291
- ARK-303
- ARK-293

## Later

- ARK-202
- ARK-158
- ARK-159
```

## tickets/README.md (on disk now)

```markdown
# Ark tickets

Each `ARK-<number>.md` file is one ticket. Its `status:` field is the only status. The hub Roadmap page and `../ROADMAP.md` show the backlog, the milestones and the ranks. This file keeps no copy of them.

Ticket status is `proposed`, `ready`, `in_progress`, `done` or `superseded`.

- `proposed`: the ticket comes from brainstorming. It needs Master Chief evaluation and human approval before it becomes `ready`.
- `ready`: the human approved it. A run can start.
- `in_progress`: a run is open. `ark run start` sets it.
- `done`: a run merged. `ark run close` sets it.
- `superseded`: a later ticket or design replaced it.

A ticket joins a milestone by its `milestone:` field. The rank of an open ticket is its place in Now, Next or Later in `../ROADMAP.md`. Only the human changes a rank.
```
