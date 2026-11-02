---
status: accepted
---

# Hub is a read-only live view

ADR 0008 let the hub steer agents by typing into Orca terminals. The hub grew views (Timeline, Metrics, Search, Projects) and notifications that Orca and Master Chief already cover, and a second path to steer work next to Master Chief. The human wants the hub small again.

## Decision

- **The hub shows Home, Run, Backlog and Map.** No Timeline, Metrics, Search or Projects view.
- **The hub is read-only.** No steering, no buttons that send into a terminal, no notifications. It never changes `state.json`, `events.ndjson` or a gate.
- **Master Chief stays the only path to queue or steer work.** The human talks to Master Chief in its Orca terminal, as ADR 0002 and ADR 0003 say.

## Considered options

- Keep steering from the hub (ADR 0008): a second path next to Master Chief, and a larger surface to keep correct.
- Keep the extra views: each one repeats data Orca or Master Chief already gives.

## Consequences

- ADR 0008 is superseded. ADR 0007's three-tools split stays.
- The hub has no `orca terminal send` code.
