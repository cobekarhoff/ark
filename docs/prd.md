# Ark product requirements

Owner: @Cobe Karhoff · Date: October 29, 2026 · Status: Draft, redesign in progress on branch `master-chief-redesign`

## Overview

Ark takes a ticket to merge-ready changes in one repo or across several dependent repos. You talk to one session, Master Chief. Master Chief starts one run lead per ticket, and each run lead plans the work and starts workers to build, test, and review it. A small `ark` command handles the mechanical parts: run state, worktrees, tests, merge requests, and metrics. Skills hold the judgment. Every run ends in a retro, and you approve the improvements that come out of it.

This document describes the product and tracks the tickets that build it.

## Problem

The old Ark treated agents as untrusted and the product as regulated. It built a hash-chained ledger, hashed gate packets, a launcher with tool restrictions, credential scrubbing, and a rule that a gate answer needs a terminal. The machinery was hard to build and hard to change.

It also blocked work. One in-progress run blocked 25 tickets. A tool meant to speed up delivery had become the slowest part of it.

Three facts make that machinery unnecessary:

- Ark itself is not regulated. The product repos keep their own end-to-end tests and validation documents.
- Agents act on your behalf with your access. The only hard line is that you merge, and the git host enforces that with branch protection.
- Your records of what happened live in the merge request, the test results, and a plain event log.

## Goals

1. Take a ticket to merge requests, one per repo, with you approving the plan and the merge.
2. Run many tickets at once without one run blocking the others.
3. Prove each acceptance criterion with integration or end-to-end tests that pass at the head of the composed workspace.
4. Work on a single repo, such as Ark, and on a multi-repo workspace, such as Clara.
5. Let you stop a run and resume it in a new session at the first unfinished step.
6. Keep the `ark` command small and deterministic. Put judgment in skills.
7. Improve with use. Every run ends in a retro, and changes happen only when you approve a proposal.

## Non-goals

- Auto-merge. Only you merge.
- Hard cost caps. Ark shows cost while a run is live and judges it in retros. It sets no estimates, alerts, or limits.
- Audit machinery of the kind the FDA expects. Ark is not regulated, and the product repos keep their own validation.
- A custom web interface that watches agents, answers gates or changes a run. Orca shows agents, Plannotator takes gate answers, and Ark may show a read-only overview (ADR 0007).
- An enforced rule that the reviewer uses a different vendor from the implementer. Plans default to a different vendor, and you can change it per step.
- Red-green proof, preservation proof, or acceptance criterion kinds. Passing tests at head are the proof.

## Users and scenarios

**You, on the Ark repo.** The workspace is one GitHub repo. You approve a ticket, Master Chief queues it, a run lead plans it, you review the plan, workers build and test it, and Ark opens one pull request. You merge it.

**You, on Clara.** The workspace is the GitLab meta-repo `clara-agentic-environment`, with repos under `repos/*` cloned from a GitLab group. One ticket needs changes in two or more repos. The run lead plans steps per repo in dependency order. Ark builds the run folder as a mirror of the workspace, with a worktree for each repo the ticket touches, so downstream repos build against upstream changes through docker compose. Ark opens a merge request per repo in dependency order.

**You, reviewing retros.** After a run closes, you read the retro. It shows cost, time, rework, your own interventions, and any escaped defects, compared with earlier runs. You answer three close questions and approve or reject each improvement proposal.

## Requirements

Tickets are on the Ark backlog. Acceptance summaries are short. Each ticket holds its own acceptance criteria.

| ID  | Requirement                                                                                                                                          | Acceptance summary                                                                                                                                                                      | Tickets                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| R1  | Master Chief: one session that you talk to. It starts run leads, relays gate questions, and suggests and queues tickets as Orca Tasks.               | You work with one session. A ticket you approve becomes a queued Orca Task. Gate questions reach you through Master Chief.                                                              | ARK-151, ARK-156                            |
| R2  | Runs: a run folder, a ticket snapshot, an event log with derived state, and resume at the first unfinished step.                                     | `ark run start` creates the run folder. A new run lead resumes a stopped run at the first unfinished step.                                                                              | ARK-152                                     |
| R3  | Run leads and workers on Orca. Depth is 2. Any supported harness works per step.                                                                     | Master Chief runs in an Orca terminal, starts a run lead, and the run lead starts workers. Workers never start agents. A step can name any supported harness and model.                 | ARK-151, ARK-156                            |
| R4  | Plan gate: `plan.yml` holds a graph of steps and test cases. Ark validates and renders it. You review it in chat or Plannotator and you can edit it. | `ark plan check` rejects cycles, unknown `needs`, and criteria with no test case. No code is built before you approve.                                                                  | ARK-153, ARK-156                            |
| R5  | Multi-repo by local composition: the run folder mirrors the workspace, with worktrees for the repos the run touches.                                 | A Clara run's agents see the workspace's context. Docker compose run from the run folder resolves repos against the run's worktrees.                                                    | ARK-150, ARK-154, ARK-159                   |
| R6  | Proof: integration or end-to-end tests tagged with an acceptance criterion pass at head. Each test runner has its own parser.                        | `ark test` maps native test tags to results per criterion. Unit tests never prove a criterion.                                                                                          | ARK-154, ARK-158                            |
| R7  | Merge requests per repo in dependency order. Only you merge.                                                                                         | `ark merge-request open` opens one request per repo in order and records dependencies. No Ark command merges.                                                                           | ARK-155, ARK-159                            |
| R8  | Bootstrap per project. Config lives in `~/.ark/projects/<project>/ark.yml`. Each project names its ticket source.                                    | The bootstrap playbook writes `ark.yml` and asks only what it cannot detect.                                                                                                            | ARK-150, ARK-158                            |
| R9  | Gates: criteria, plan, and escalation, with a round budget. An evaluator checks the ticket before planning.                                          | The criteria gate opens when the ticket has no ACs or the evaluator records a blocker. Escalation opens when the round budget is spent. You choose one more round, take over, or abort. | ARK-152, ARK-170                            |
| R10 | A small deterministic command line. Judgment lives in skills.                                                                                        | The `ark` command is a short list of deterministic command lines, listed by `ark --help`. The old code, tests, typed tools, and extension are deleted.                                  | ARK-152, ARK-153, ARK-154, ARK-155, ARK-157 |
| R11 | A retro and metrics for each run, including orchestration health.                                                                                    | `ark retro` writes `metrics.json` and a comparison with earlier runs. The run lead writes `retro.md` from it.                                                                           | ARK-160, ARK-161                            |
| R12 | Improvement proposals that you approve. They land by scope: project, Ark, or skill.                                                                  | Nothing changes without your approval. An approved proposal lands in `ark.yml`, `learnings.md`, an Ark ticket, or a skill diff.                                                         | ARK-161                                     |

## How it works

You talk to Master Chief. For each approved ticket, Master Chief starts a run lead through Orca. The run lead reads the ticket, plans the work, and asks you to approve the plan. Workers then build, test, and review. When the work passes, the run lead opens merge requests and you merge them.

Orca hosts the agents, carries messages, and holds the queue. Plannotator shows the plan and the merge request review. The `ark` command keeps run state and runs the mechanical steps. Skills tell each agent what to do.

[docs/explanation/architecture.md](explanation/architecture.md) explains the roles, the run lifecycle, the run folder, and multi-repo composition. [docs/reference/cli.md](reference/cli.md) lists the commands.

## Self-improvement

Every run ends in a retro. The run lead writes `retro.md` on top of the numbers from `ark retro`. Master Chief then asks you three questions: what caused the most pain, what to change now, and what surprised you. Ark does not score itself.

Ark measures five things for each run:

- **Cost.** USD and tokens per run, step, role, and model, plus the ratio of review cost to build cost.
- **Time.** Wall time per step, with gate wait shown separately.
- **Rework.** Rounds, escalations, and findings sent back.
- **Human intervention.** Changes you made at the plan gate, and comments or commits on the merge request after it opened.
- **Escaped defects.** When you bring Master Chief a bug ticket, it asks whether the bug traces to an earlier run and links it.

The retro also has an orchestration section: agent crashes and restarts, stalled workers, dead dispatches, tool errors, context overflows, idle gaps, and the cost of Master Chief and run leads. Each fix goes to Ark, Orca, Plannotator, or the harness.

Master Chief interviews you over several retros, on request or every few runs. It asks one question at a time and gives a recommended answer.

An improvement proposal cites evidence and names a scope:

- **Project.** A change to `ark.yml` or `learnings.md`. Run leads read `learnings.md` at plan time.
- **Ark.** A ticket on the Ark backlog.
- **Skill.** A new or changed skill, shown as a diff wherever the skill lives.

Usage parsers read OMP and Claude Code session files first. A Codex parser follows when you use Codex.

## Milestones

| Milestone                    | Outcome                                                                                                                                            | Tickets                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| M1 Core loop on the Ark repo | Two spikes, the command line, the router skill and playbooks. One Ark ticket goes from Master Chief to a merged pull request.                      | ARK-150, ARK-151, ARK-152, ARK-153, ARK-154, ARK-155, ARK-156, ARK-157 |
| M2 Multi-repo on Clara       | Bootstrap, pytest and behave parsers, side-by-side compose. One Clara ticket across at least two repos reaches merge requests in dependency order. | ARK-158, ARK-159                                                       |
| M3 Self-improvement          | `ark retro`, the retro playbook, the close check, the deep interview, and learnings.                                                               | ARK-160, ARK-161                                                       |
| M4 Later                     | A web view over run folders and Orca state, only if Orca's interface falls short. Onboarding for smart-qc.                                         | Not yet ticketed                                                       |

| Ticket  | Title                                                                                                    | Depends on                         | Milestone |
| ------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------- |
| ARK-150 | Spike: side-by-side worktrees for a Clara run, driven by Orca                                            | None                               | M1        |
| ARK-151 | Spike: Master Chief, run lead, and worker on Orca, with gate relay                                       | None                               | M1        |
| ARK-152 | CLI core: `run start`, `status`, `run close`, event log, transition table, project config                | None                               | M1        |
| ARK-153 | Plan file: `plan check`, `plan.mmd`, `gate record`                                                       | ARK-152                            | M1        |
| ARK-154 | Worktrees and tests: `worktree create` builds the workspace mirror, `ark test` with the bun parser       | ARK-150, ARK-152                   | M1        |
| ARK-155 | Merge requests in dependency order on GitHub and GitLab                                                  | ARK-152                            | M1        |
| ARK-156 | Router skill and playbooks: chief, run-lead, worker, with Orca and Plannotator                           | ARK-151, ARK-153, ARK-154, ARK-155 | M1        |
| ARK-157 | Cutover: delete the old design's code, tests, typed tools, and extension; generate the command reference | none                               | M1        |
| ARK-158 | Bootstrap playbook, pytest and behave parsers, onboard Clara                                             | ARK-156                            | M2        |
| ARK-159 | First Clara ticket across repos to merge requests in dependency order                                    | ARK-158                            | M2        |
| ARK-160 | `ark retro`, `metrics.json`, and session usage parsers                                                   | ARK-152                            | M3        |
| ARK-161 | Retro playbook, close check, deep interview, and learnings                                               | ARK-156, ARK-160                   | M3        |

ARK-109 is superseded by this redesign.

## Dependencies

- **Orca.** Hosts agents and carries messages. It also holds the queue. Ark uses the `orca` command, including `orchestration run-create`, `task-create`, `worker-start`, `ask`, `reply`, `gate-create`, and `check --wait`. Orca supports the harnesses claude, codex, omp, and pi, and it runs headless with `orca serve`.
- **Plannotator.** Shows the plan gate with `plannotator annotate`, reviews merge requests with `plannotator review`, and gives you an Inbox for questions when you are away from the chat.
- **Harnesses.** Claude Code, Codex, OMP, and pi. Each step in a plan names its harness and model.
- **`gh` and `glab`.** Open and check pull requests and merge requests.
- **docker compose.** Composes repos for multi-repo projects such as Clara.
- **Bun.** Runs the `ark` command and its tests.

## Risks and open questions

**Two spikes decided the base.** Both passed on 2026-10-29; see [the findings](explanation/orca-spikes.md).

- ARK-150: Ark-made worktrees work with Orca and docker compose once the run folder mirrors the workspace.
- ARK-151: Master Chief, run lead and worker fit once Orca's nesting depth is 2. Gate questions relay from the run lead to Master Chief to you and back. Master Chief must run in an Orca terminal.

Still open: OMP doesn't load a workspace's `.claude/skills` from the mirror (ARK-158), and image builds from a worktree are untested (ARK-159).

**Open questions.**

- Does Clara's GitLab tier support merge request dependencies? If not, Ark writes `Depends on !N` in the description. On GitHub it writes `Depends on #N`.
- Do the harnesses write usage in formats that Ark can parse the same way? OMP and Claude Code come first. Codex follows.
- How well does `ark test` map pytest marks and behave tags to criteria? ARK-158 settles this on real Clara suites.

## Decisions

- [0004 Trusted agents and a lightweight harness](adr/0004-trusted-agents-lightweight-harness.md)
- [0005 Orca and Plannotator](adr/0005-orca-and-plannotator.md)
- [0006 Integration and end-to-end proof only](adr/0006-integration-and-e2e-proof-only.md)
- [0007 Control center](adr/0007-control-center.md)

ADRs 0001 to 0003 stay in `docs/adr/`. ADRs 0002 and 0003 describe the old design.
