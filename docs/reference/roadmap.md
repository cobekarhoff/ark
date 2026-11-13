# Roadmap file format

`$ARK_HOME/projects/<project>/ROADMAP.md` holds the vision, the milestones and the rank of the open work of one project. `ARK_HOME` defaults to `~/.ark`. The file is in `ARK_HOME`, not in a repo. `readRoadmap(markdown, tickets)` in `hub/roadmap.ts` reads it. It reads text only, so the hub passes it the file and the ticket list. This page describes the format of the file. It is not a roadmap.

Any project can have a `ROADMAP.md`. The hub reads it for every project. Without one, the hub shows a line that says the project's roadmap lives in its ticket source (`local`, `github` or `jira`, from `ark.yml`).

## Format

```markdown
## Vision

Ark takes a ticket to merge-ready changes in one repo or several, and you decide only at gates and at merge.

## Milestones

| id  | name         | outcome                                                 | state  |
| --- | ------------ | ------------------------------------------------------- | ------ |
| M9  | See the work | The hub shows what is next, why, and what each run did. | active |

## Now

- ARK-290

## Next

- ARK-291

## Later

- ARK-202
```

- `## Vision` has one paragraph. The file is an error without it.
- `## Milestones` is a table with the columns `id`, `name`, `outcome` and `state`, in roadmap order. `state` is `done`, `active` or `later`. Any other value is an error with its line number. A ticket belongs to a milestone by its `milestone:` field.
- `## Now`, `## Next` and `## Later` are lists of `- <ticket id>` lines. The place in the list is the rank: the first line is the first to do.

## Rules

- Only the human changes a rank, the vision or a milestone. An agent that writes a ticket adds it to no list.
- A finished ticket (`done` or `superseded`) can stay listed. It does not show in its horizon, and it gives a `finished_listed` warning.
- An open ticket in no list is Unranked. A `proposed` ticket in no list is not Unranked: it is in Review.
- A `proposed` ticket in a list keeps its place and is marked `proposed: true`.
- A ticket file with no readable front matter (no `id` or no `title`), or with no `status:`, counts as `proposed`. It waits in Review until you give it a status. A ticket that the hub cannot read hides no other ticket.

## Result

`readRoadmap` returns the error list (each error has a line number) or the roadmap:

| Field                  | Content                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `vision`               | The vision paragraph.                                                  |
| `milestones`           | Each milestone with its `done`, `superseded` and `open` ticket counts. |
| `now`, `next`, `later` | The open tickets of each list, in list order.                          |
| `unranked`             | Open tickets that are not `proposed` and are in no list.               |
| `review`               | Every `proposed` ticket.                                               |
| `shipped`              | The `done` and `superseded` tickets of each milestone.                 |
| `warnings`             | `{ kind, ids, message }`, with the ticket IDs.                         |

| Warning                 | When                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `missing_ticket`        | A listed ID has no ticket file.                                                                                                 |
| `unranked`              | An open ticket that is not `proposed` is in no list.                                                                            |
| `rank_above_dependency` | A ticket is ranked above a ticket in its `depends_on` that is not finished: in an earlier horizon, or earlier in the same list. |
| `finished_listed`       | A `done` or `superseded` ticket is listed.                                                                                      |
