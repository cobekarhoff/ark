---
status: accepted
---

# Orca hosts and connects agents; Plannotator is the review surface

Master Chief, run leads and workers need their own sessions, a way to message each other and the human, a durable task graph, and a place you can watch them. We designed this ourselves first: a tmux window per agent plus `ark` commands for spawning, waiting and an inbox. Orca already does all of it. It starts claude, codex, omp and pi agents in worktrees or folders, has durable ask and reply, gates, task dependencies, liveness, a desktop UI and a headless server. Plannotator already renders a plan and a Mermaid DAG for annotation with a machine-readable approval, reviews GitLab and GitHub MRs, and has an inbox for questions you answer later. A survey of about 30 alternatives found nothing better. Gas Town was closest, but it needs Dolt and tmux and assumes agents merge. So Ark builds on both and keeps only the deterministic, Ark-specific parts in its own CLI: run state, side-by-side worktrees, tests and AC results, merge requests in DAG order, and metrics.

## Considered options

- tmux plus Ark's own messaging commands: no dependency on Orca, but about four more commands to build and no UI.
- The harness's own subagents: OMP only, agents die with Master Chief's process, and you can't watch them.
- Headless processes with a JSON stream: there is no terminal to step into, and each harness needs its own adapter.

## Consequences

- The Orca app or `orca serve` must be running. Bootstrap checks for it.
- Two spikes gate the decision: side-by-side worktrees in the Clara meta-repo (ARK-150), and Master Chief → run lead → worker within Orca's nesting limit (ARK-151). If either fails, fall back to a tmux host.
- The planned Ark Console is dropped unless Orca's UI falls short.
- Each gate has one place it is answered. The plan gate goes through Plannotator or chat. Criteria and escalation go through Master Chief, using Orca's `ask`.
