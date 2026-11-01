---
status: accepted
---

# The hub steers agents through Master Chief

ADR 0007 made the control center read-only. The human now wants to guide agents from the same page, and nothing made sure a project has one Master Chief. A hub that writes run state would duplicate Master Chief and break ADR 0002 and ADR 0003. Orca already has `orca terminal send`, which types into a terminal.

## Decision

- **The hub steers by typing into Orca terminals.** A message from the hub goes to the live Master Chief terminal, or to a run lead terminal, with `orca terminal send`. The hub never changes `state.json`, `events.ndjson` or a gate itself.
- **Master Chief and run leads stay the only writers of run state.** Fixed buttons (approve and queue, reorder queue, pause, resume, retry stuck agent, abort) send a readable instruction to Master Chief. Abort sends nothing until the human confirms.
- **The hub picks the terminal.** The page never names a handle. The live Master Chief is the connected coordinator of the Orca Run whose objective is exactly "Master Chief: <project> tickets", in the project workspace; a stray terminal in the workspace does not count. With no live Master Chief the hub refuses and sends nothing.
- **The hub can spawn Master Chief** for a project that has none, from `roles.chief` in `ark.yml`. The role is optional for old configs and required when it is used.
- **Each project has one Master Chief.** The chief playbook creates the "Master Chief: <project> tickets" Run at start, so the hub can steer a fresh Master Chief before it queues anything. It stops when a live Master Chief already runs, and takes over the Run when its terminal is dead.
- **The name is "hub".** "Control center" is retired.

## Considered options

- Keep the hub read-only (ADR 0007): the human has to leave the page to steer.
- The hub writes run state directly: a second writer next to Master Chief, and gate answers behind a new surface.

## Consequences

- ADR 0007 is superseded in part: its read-only rule and its name. Its three-tools split stays.
- ADR 0005 stays accepted and is unchanged.
- `orca terminal send` gives no proof of delivery beyond its exit code, so the hub shows "sent", not "read".
