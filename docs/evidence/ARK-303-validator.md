# ARK-303 validator report

## ARK-303-AC7: feature map of `~/.ark/projects/ark/verify.md`

The bootstrap step 12 wrote `~/.ark/projects/ark/verify.md` for the hub (`ark ui`) and the CLI. The file is outside the repo. Its feature map, quoted from the file:

## Feature map

### Hub

Open each page in a browser tab on the live hub, with no console errors. The header has three views: Home, Runs, Backlog.

| Feature                  | Command or page                                                                                                       | A working result shows                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Live snapshot            | `curl -sf <hub>/api/snapshot`                                                                                         | JSON with `generated_at`, `sources` (each with `ok: true`), `runs` and `tickets` for the real projects                      |
| Home                     | `<hub>/#/`                                                                                                            | Tiles for what needs you, then blockers, the review queue and run progress. Counts match `ark status` and `ark chief state` |
| Runs board               | `<hub>/#/runs`                                                                                                        | Every run in `~/.ark/projects/*/runs/` on one board, with its phase, and the cross-run dependency graph                     |
| Run page                 | `<hub>/#/run/<run>` for a closed run and an open run                                                                  | Progress strip, plan, agents, MR evidence, decisions and files of that run. A closed run loads with no error                |
| Backlog                  | `<hub>/#/backlog`                                                                                                     | Tickets of every project from `~/.ark/projects/*/tickets/`, with their status                                               |
| Ticket page              | `<hub>/#/ticket/<id>`, for example `#/ticket/ARK-303`                                                                 | The ticket's ACs and text, in the same words as `ticket.md`                                                                 |
| Retired map route        | `<hub>/#/map`                                                                                                         | The address changes to `#/runs`                                                                                             |
| Read-only hub (ADR 0009) | `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Host: evil.example' -d '{"terminal":"x"}' <hub>/api/open-in-orca` | `403`. The hub changes no run state                                                                                         |

### CLI

| Feature       | Command                                            | A working result shows                                                                                              |
| ------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Help          | `bun cli/ark.ts --help`                            | `Usage: ark <command>` and one line for each command family, from `run start` to `ui uninstall`                     |
| Run status    | `bun cli/ark.ts status <run>`                      | Lines `run:`, `ticket:`, `kind:`, `phase:` and `round:` for the run. Exit 0                                         |
| All runs      | `bun cli/ark.ts status`                            | One line for each open run: run, phase, current step and age. Exit 0                                                |
| Chief state   | `bun cli/ark.ts chief state --project ark`         | `# Chief state: ark` with the sections Open runs, Run leads, Queued Orca Tasks, Workspace main and Config           |
| Test proof    | `bun cli/ark.ts test <run>`                        | Each AC listed as passing, failing, missing, manual pending, manual ok or manual problem. Exit 0 only when all pass |
| Plan check    | `bun cli/ark.ts plan check <run>`                  | Exit 0 for a valid plan, one line for each problem and exit 1 for an invalid one                                    |
| Retro metrics | `bun cli/ark.ts retro <run>`                       | Writes `metrics.json` in the run folder. Exit 0                                                                     |
| Unknown run   | `bun cli/ark.ts status no-such-run`                | `ark: <reason>` on stderr and exit 1                                                                                |
| MR status     | `bun cli/ark.ts merge-request status <run> --json` | JSON for each MR of the run, from `gh`. Needs `gh auth status` to pass                                              |

## ARK-303-AC8

Proved by the `ark test` checks: `bun test`, `bun run typecheck`, `bun run lint` and `bun run format:check`. No tagged test: a test that runs the suite inside the suite is not deterministic.

## ARK-303-AC9: Master Chief catch-up reply

pending
