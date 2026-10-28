---
title: Agents and models
description: Separate product work, independent validation, review and human decisions.
---

Ark separates judgment from mechanics. Oh My Pi (OMP) runs the agents; Ark's
command-line interface (CLI) records artifacts, owns transitions and checks evidence.

| Actor | Responsibility | Boundary |
| --- | --- | --- |
| Orchestrator | Intake, analysis, plan, handoffs, finding dispositions and gate questions | Does not implement the product or author acceptance tests |
| Implementer (`@implement`) | Product changes in the assigned repository worktree | Must not edit tests tagged with an acceptance criterion (AC) ID |
| Validator (`@validate`) | AC-tagged tests, red-green or preservation proof, test audit | Independent vendor from implementation; tests run through `ark test` |
| Reviewer (`@review-x`) | Review changed code against specification and ACs | Independent vendor from implementation; findings are not automatically blockers |
| Human | Gate decisions and host merge | Exact approval proof, never an agent's self-approval |

The configured `review-s` role is same-vendor review in a fresh context. The ticket
playbook's numbered review step spawns `reviewer-x`; it does not promise an
additional same-vendor reviewer on every run.

## Current project model roles

`.omp/config.yml` maps roles as follows. These are this repository's configured
selectors, not claims about a model available to every installation:

| Role | Selector | Configured fallback |
| --- | --- | --- |
| `implement` | `openai-codex/gpt-6.1-sol:high` | `openai-codex/gpt-6-sol` |
| `validate` | `anthropic/claude-sonnet-5-5:high` | `anthropic/claude-sonnet-5` |
| `review-x` | `anthropic/claude-opus-5-5:high` | `anthropic/claude-sonnet-5-5` |
| `review-s` | `openai-codex/gpt-6.1-sol:high` | `openai-codex/gpt-6-sol` |

`ark preflight` uses OMP's real resolver and fallback functions. It checks every
reachable candidate from comma selectors and fallback chains across global and
project configuration, not just the first selector. Validation and cross-vendor
review must remain on another vendor from implementation; same-vendor review must
remain on the implementer's vendor. Missing OMP or an invalid reachable chain
is a refusal, not a silent fallback.

## Handoffs and attribution

Each specialist receives a brief with the approved contract, AC IDs, worktree,
branch and relevant findings. Agent outputs are schema-checked with
`ark artifact record`. The implementer commits a clean worktree and returns its
head; `implementer.completed` records that step. The validator's `ark test --as validator`
records its own step, which is what attributes its AC-tagged test changes.

Trace checks and approvals refuse dirty worktrees or product commits beyond the
last attributed implementer head. This keeps changes tied to the actor that
actually made them; an unrecorded commit is not accepted evidence. Human takeover
at escalation uses the same attribution boundary, with explicit confirmation.

These controls catch mistakes and make honest runs auditable. Agents still run as
the user's operating-system account: they are **not** a security sandbox against
a deliberate same-user forger. See [implementation details](/reference/implementation/)
and architecture decision record 0003 in `docs/adr/` for that trust boundary.
