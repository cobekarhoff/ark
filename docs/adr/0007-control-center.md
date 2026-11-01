---
status: superseded in part by ADR 0008
---

# A read-only control center gives the high-level view

Orca shows agents and terminals, but not tickets, run phases, steps, waiting gates, test results or MRs. To see Ark as a whole, the human had to ask Master Chief or open many files. ADR 0005 dropped the planned Ark Console "unless Orca's UI falls short". On 2026-10-30 the human found that it falls short for the high-level view, while Orca stays the right place to watch an agent work.

> ADR 0008 supersedes the read-only rule and the name "control center" in this ADR. The page is now the hub, and it steers agents through Master Chief. The rest stays: three tools, three jobs.

## Decision

Three tools, three jobs:

- **Ark control center** (`ark ui`) is the high-level view. It is a local page that reads each run's `state.json` and the `orca` CLI. It shows the ticket, phase, steps, waiting gate, last test, MRs, run lead and workers. It only shows data: it never starts, stops or changes a run.
- **Orca** is where the human watches agents work. The control center shows, for each agent, the command to open it in Orca.
- **Plannotator** is where the human answers gates. The control center shows, for a waiting plan gate, the command to open its review. It shows where to answer the other gates, which still go through Master Chief.

## Considered options

- Orca's own interface alone: no view of tickets, gates, tests or MRs.
- A control center that also answers gates and controls runs: duplicates Plannotator and Orca, and puts gate answers behind a new surface. Not now.

## Consequences

- ADR 0005 stays accepted. Its line about the Ark Console is narrowed by this ADR to a read-only overview.
- ADR 0002 is unchanged.
- `ark ui` adds a command to the CLI.
