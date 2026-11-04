---
status: accepted
---

# Hub is a read-only live view

ADR 0008 let the hub steer agents by typing into Orca terminals. The hub grew views (Timeline, Metrics, Search, Projects) and notifications that Orca and Master Chief already cover, and a second path to steer work next to Master Chief. The human wants the hub small again.

ARK-284 amends this ADR with one exception, a focus action. The human wants to see what an agent did and to jump from the hub to that agent in Orca. Orca has no link to an agent page (its `orca://` scheme opens only skills, plugins and pairing), and `orca terminal switch --terminal <handle>` is the only way to focus a terminal.

## Decision

- **The hub shows Home, Runs and Roadmap.** Roadmap replaces Backlog: it shows the project's vision, milestones and ranked tickets from `ROADMAP.md`, and a ticket opens as a full page. Runs replaces Map: it shows every run on one board with a cross-run dependency graph, and a run opens as its own page. No Timeline, Metrics, Search or Projects view. The run page shows any run, open or closed: its decisions timeline, its files, and the transcript of each agent.
- **The hub is read-only, with one exception: a focus action.** No steering, no text sent into a terminal, no notifications. It never changes `state.json`, `events.ndjson` or a gate.
- **The one action is `POST /api/open-in-orca`** with `{ "terminal": <handle> }`. It runs `orca terminal switch --terminal <handle>` (an argument array, never a shell string) and nothing else. It sends no text into a terminal and changes no run state. It is the hub's only route that accepts a POST; every other route answers a write method with 404 or 405, and this route answers every other method with 405.
- **Only the hub's own page may use it.** The route answers 403 unless the request's Origin and its Host are both `127.0.0.1:<port>` of the hub. A browser always sends Origin on a POST, so a request with no Origin is refused too (curl and scripts do not pass), and `localhost` is refused although the read routes accept it. The hub's own name, given with `--name`, counts as its own address (alone or with port 80, and Origin and Host must still match each other), and no other `*.localhost` name does. It answers 400 when the body is not that JSON or the handle is not listed as live in the current snapshot, and 502 when `orca` fails or times out.
- **Agents carry `terminal` and `live`.** `live` is true when Orca lists the terminal as connected. A released agent stays in the snapshot with `live: false`; the page shows "ended, not in Orca" and no button.
- **A handler reads memory, asks the usage worker thread for one transcript page, or reads one small run file.** The run file route serves only the run's own documents (`plan.md`, `strategies.md`, `retro.md`, `ticket.md`, `evaluation.md`, and the files in `findings/` and `results/`), rejects `..` before it joins a path, and answers 404 for a real path outside the run folder (symlinks included). Closed runs are read when the page asks and are never part of the snapshot. Transcripts show tool calls with name, arguments, `ok` or `error` and the first line of the result; a full tool result never reaches the page.
- **Master Chief stays the only path to queue or steer work.** The human talks to Master Chief in its Orca terminal, as ADR 0002 and ADR 0003 say.

## Considered options

- Keep steering from the hub (ADR 0008): a second path next to Master Chief, and a larger surface to keep correct.
- Keep the extra views: each one repeats data Orca or Master Chief already gives.
- No action at all: the human then finds an agent in Orca by hand.
- Accept a request with no Origin on the focus route: keeps curl simple, but turns the one POST into a route any local process or DNS-rebinding page can call.

## Consequences

- ADR 0008 is superseded. ADR 0007's three-tools split stays.
- The hub has no `orca terminal send` code. Its only call to Orca that acts is `orca terminal switch`.
- Transcripts are read from the session files that ADR 0003 already makes readable by the same user. The hub serves only `127.0.0.1` and does not redact them.
- An Orca feature request for an `orca://terminal/<handle>` link is filed outside Ark. When it ships, the route can go.
