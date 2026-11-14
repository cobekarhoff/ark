# Ark product requirements

Owner: @Cobe Karhoff · Updated: November 12, 2026 · Status: in use

## Problem

Agents write code fast, but nothing else got faster: a ticket still waits for someone to read it, decide how to do it, write the tests, review the change, open the merge request, chase the pipeline and merge. When an agent does the middle part in an hour, the rest of the week is the new bottleneck, and the agent's work arrives as a diff nobody can judge without redoing it.

## Overview

Ark takes a ticket to merge-ready changes in one repo or across several dependent repos. You talk to one session, Master Chief. Master Chief starts one run lead per ticket, and each run lead plans the work and starts workers to build, test and review it. A small `ark` command handles the mechanical parts; skills hold the judgment. Every run ends in a retro, and you approve the improvements that come out of it.

This page states what Ark promises, in EARS form, with the tickets that built each promise and the test cases that hold it. [Why Ark](why-ark.md) says what it is for; the [architecture](explanation/architecture.md) says how; the [vision](explanation/vision.md) says where it goes. On GitHub an MR is a pull request.

## Goals

1. Take a ticket to merge requests, one per repo, with you approving the criteria and the plan and merging on the git host.
2. Run many tickets at once without one run blocking the others.
3. Prove each acceptance criterion with test cases that pass at the head of the composed workspace.
4. Work on a single repo, such as Ark, and on a multi-repo workspace, such as Clara or Smart QC.
5. Let you stop a run and resume it in a new session at the first unfinished step.
6. Keep the `ark` command small and deterministic. Put judgment in skills.
7. Improve with use. Every run ends in a retro, and changes happen only when you approve a proposal.

## Non-goals

- Merging by an Ark agent or command. No agent and no `ark` command merges. The optional auto-merger service (`scripts/auto-merger.sh`, installed by you with `ark services install` on macOS) merges an MR only when the host reports it CLEAN under your branch protection, the run's `retro.md` exists, the ticket is not done or superseded and the run is still in `merge_requests_open`.
- Hard cost caps. Ark shows cost while a run is live and judges it in retros.
- Audit machinery of the kind the FDA expects of a regulated system. Ark is not regulated; it produces evidence for the product repos' own validation.
- A custom web interface that watches agents, answers gates or changes a run. Orca shows agents, you answer gates through Master Chief or Plannotator, and the hub only reads, with one action, "Open in Orca" ([ADR 0009](adr/0009-hub-is-a-read-only-live-view.md)).
- An enforced cross-vendor rule. Plans default to a different vendor for the reviewer, and you can change it per step.
- Red-green proof for every run. Only a `bug` run with a `method: test` AC must show a failing `ark test` before its implementer starts, and only a `refactor` run with a `method: test` AC must pass at base (R6.7, R6.8). Other kinds are decided at head; a base failure is recorded as data ([ADR 0010](adr/0010-test-cases-describe-the-product.md)).

## Users and scenarios

| Scenario                                                                                                                 | What happens                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **You, on the Ark repo.** One GitHub repo.                                                                               | You name a ticket, Master Chief queues it, a run lead plans it, you accept the criteria and the plan, workers build and prove it, Ark opens one MR, you merge on the host. [Scenario 1](explanation/scenarios.md) walks through a real run.                                                                                                                |
| **You, on a multi-repo workspace.** A GitLab meta-repo with repos under `repos/*`; one ticket changes two or more repos. | The run lead plans steps per repo in merge order (the repo edges of the plan, upstream first). The run folder mirrors the workspace with a worktree per touched repo, and tests run through docker compose against the composed worktrees. Ark opens one MR per repo in order. [Scenario 2](explanation/scenarios.md).                                     |
| **You, on a repo Ark may not push to.** The project sets `merge_requests: none`.                                         | The run does everything up to the host and leaves `building` with the branches (`ark/<ticket id>-<slug>`) in their clones. After you say you took them, Master Chief closes the run `handed_off`. [Scenario 3](explanation/scenarios.md).                                                                                                                  |
| **You, reviewing retros.**                                                                                               | While a run's MRs are open, the run lead writes `retro.md`: cost, time, rework, your own interventions, escaped defects, compared with earlier runs. Nobody asks you questions after a single run. Every 10 closed runs, or on request, Master Chief runs a deep interview of at most 8 questions, one at a time, and you approve or reject each proposal. |

## Requirements

Written in EARS. The patterns: **ubiquitous** (the system shall), **event-driven** (when … the system shall), **state-driven** (while … the system shall), **unwanted behaviour** (if … then the system shall), **optional** (where … the system shall).

Each table also has these rows:

| Row     | Meaning                                                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tickets | The tickets that built the requirement. Tickets are the files in `$ARK_HOME/projects/ark/tickets/` (`ARK_HOME` defaults to `~/.ark`), not in this repo. Each ticket holds its own acceptance criteria. |
| Held by | The command, file or decision that enforces it.                                                                                                                                                        |
| Cases   | IDs of test cases in [`test/cases/`](../test/cases/) that hold it. A requirement with no Cases row has no test case matched to it yet.                                                                 |

Milestones M1 to M9 in the last table below are defined in `$ARK_HOME/projects/ark/ROADMAP.md`; the format is in the [roadmap reference](reference/roadmap.md).

### R1 · Master Chief

| ID      | Requirement                                                                                                                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1.1    | The system shall provide one Master Chief session per project through which you name tickets, receive every gate question and give every gate answer.                                                                            |
| R1.2    | **When** you approve a ticket, Master Chief shall queue it as an Orca task (Orca's own object, not an Ark run) and start one run lead for it, up to the project's `concurrency`.                                                 |
| R1.3    | **If** a second Master Chief is started for a project, **then** it shall refuse to start and name the live terminal.                                                                                                             |
| R1.4    | **While** a run has an open MR, Master Chief shall poll `ark merge-request status` and, on a failed check, a human comment or a conflict, start the run lead again for an MR round.                                              |
| R1.5    | Master Chief shall never write product code.                                                                                                                                                                                     |
| Tickets | ARK-151, ARK-156, ARK-177, ARK-202, ARK-281                                                                                                                                                                                      |
| Held by | `skills/ark/playbooks/chief.md`; `ark chief state`; [ADR 0008](adr/0008-hub-steers-through-master-chief.md) (one Master Chief per project; the rest of it is superseded by [ADR 0009](adr/0009-hub-is-a-read-only-live-view.md)) |

### R2 · Runs and resume

| ID      | Requirement                                                                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2.1    | **When** `ark run start <ticket>` runs, the system shall create the run folder with a snapshot of the ticket, an empty event log and derived state.                                                 |
| R2.2    | The system shall derive `state.json` from `events.ndjson` so that the state can be rebuilt from the log alone.                                                                                      |
| R2.3    | **When** a new run lead takes over a stopped run, it shall resume at the phase and the first unfinished step that `ark status <run>` shows, and shall not ask for a gate the log shows as answered. |
| R2.4    | The system shall allow at most one open run per ticket.                                                                                                                                             |
| Tickets | ARK-152, ARK-170                                                                                                                                                                                    |
| Held by | `cli/events.ts`, `cli/transitions.ts`; `ark status`; `test/run.test.ts`                                                                                                                             |

### R3 · Run leads and workers on Orca

| ID      | Requirement                                                                                                                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R3.1    | The system shall run Master Chief, run leads and workers as Orca agents with a nesting depth of two: Master Chief starts run leads, run leads start workers, and a worker shall never start an agent.       |
| R3.2    | **When** a run lead starts a worker, it shall name the worker's role and step in words and shall read `roles` in `ark.yml` for the harness and model at that moment, not from an earlier copy.              |
| R3.3    | **Where** a ticket changes something a person sees, the run lead shall start a Designer unless the surface is only `none`, or there is one card and the surface is only `document`, `cli_output` or `none`. |
| R3.4    | **If** a worker hits a provider usage limit, **then** the run lead shall not change models itself and shall ask Master Chief, which asks you.                                                               |
| Tickets | ARK-151, ARK-156, ARK-173, ARK-174, ARK-217, ARK-239, ARK-282                                                                                                                                               |
| Held by | `ark plan check` roles refusal (ARK-282); `~/.ark/projects/ark/learnings.md` entries of 2026-11-01 and 2026-11-03                                                                                           |

### R4 · Strategy and plan gates

| ID      | Requirement                                                                                                                                                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4.1    | **When** `strategies.md` has two or more cards, the system shall open the strategy gate and shall not plan until you pick a card or ask for a design round. **Where** `gates.strategy` is `auto`, Ark shall record the recommended card by auto instead.             |
| R4.2    | The system shall refuse a plan with a cycle, an unknown `needs`, a step with no repo or role, a missing summary, a `method: test` criterion with no integration or E2E test case in its `verified_by`, an interface with no name or no callers, or an open decision. |
| R4.3    | **When** a plan passes `ark plan check`, the system shall render `plan.md` with the summary, the change table, the design block, the step diagram and the test cases as Gherkin.                                                                                     |
| R4.4    | The system shall not enter `building` before the plan gate is answered `approve`, by you or, **where** `gates.plan` is `auto` and the plan has no open decision, by auto. It shall not approve a plan while a decision is open.                                      |
| Tickets | ARK-153, ARK-156, ARK-173, ARK-311                                                                                                                                                                                                                                   |
| Held by | `ark plan check`; `cli/transitions.ts`; `test/plan.test.ts`; Plannotator for review                                                                                                                                                                                  |
| Cases   | R4.4: ARK-T219                                                                                                                                                                                                                                                       |

### R5 · Multi-repo by local composition

| ID      | Requirement                                                                                                                                                                                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R5.1    | **When** a run touches a repo in a multi-repo workspace, `ark worktree create` shall mirror the workspace into `<run>/workspace/` with a worktree at the repo's usual path and a symlink for every other repo and root file. |
| R5.2    | **While** tests run, the system shall run docker compose with `--project-directory <run>/workspace` so that every `./repos/*` path resolves to the run's worktrees.                                                          |
| R5.3    | **Where** the workspace is a single repo, `<run>/workspace` shall itself be the worktree.                                                                                                                                    |
| Tickets | ARK-150, ARK-154, ARK-159                                                                                                                                                                                                    |
| Held by | `cli/worktree.ts`; the spike that found the layout is in [orca-spikes.md](research/orca-spikes.md)                                                                                                                           |

### R6 · Proof

| ID      | Requirement                                                                                                                                                                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R6.1    | The system shall decide each acceptance criterion from the results of the test cases in its `verified_by`, at every level, at head.                                                                                                                      |
| R6.2    | The system shall require at least one integration or E2E test case in the `verified_by` of each `method: test` criterion.                                                                                                                                |
| R6.3    | **Where** a criterion has `manual: true` or a method other than `test`, the system shall treat your `manual ok` gate answer as its proof and shall treat `manual problem` as a finding.                                                                  |
| R6.4    | The system shall read each test runner's native report through its own parser: `bun test` today, pytest and behave for Python repos.                                                                                                                     |
| R6.5    | **If** a test that carries an old AC id in its title is changed by a run, **then** the reviewer shall reject the diff as P0 unless the run converts it to a test case.                                                                                   |
| R6.6    | The validator shall audit every new or changed test against `rules/test-audit.md`: it asserts observable behaviour at the real boundary, fails for a credible regression, takes no expected value from the code under test, and mocks nothing it proves. |
| R6.7    | **Where** a ticket has `kind: bug` and a `method: test` AC, `ark run step <run> <implementer step> start` shall refuse until one `ark test` shows every `method: test` AC failing.                                                                       |
| R6.8    | **Where** a ticket has `kind: refactor` and a `method: test` AC, `ark test` shall run the suites at the base commit and exit 1 when they fail there, and the system shall refuse to open an MR unless the suites passed at base.                         |
| Tickets | ARK-154, ARK-158, ARK-243, ARK-311, ARK-312, ARK-315, ARK-351                                                                                                                                                                                            |
| Held by | `ark test`; `cli/parsers/*`; `skills/ark/rubrics/reviewer.md` Proof; [ADR 0010](adr/0010-test-cases-describe-the-product.md); `cli/transitions.ts` and `cli/test-run.ts` for R6.7 and R6.8                                                               |
| Cases   | R6.4: ARK-T134 · R6.5: ARK-T207 · R6.7: ARK-T62, ARK-T64 · R6.8: ARK-T12, ARK-T63                                                                                                                                                                        |

### R7 · Merge requests

| ID      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R7.1    | **When** the last `ark test` passed at the latest commit and no review sent work back, `ark merge-request open` shall push each repo's branch and open one MR per repo in merge order (the repo edges of the plan, upstream first), recording each dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R7.2    | The system shall refuse to open an MR if there is no test result, any non-manual criterion is not `passing`, any manual criterion is not `ok`, the last test did not pass, any repo changed since the last test (a head that moved only by clean `ark worktree sync` merges of the target branch is not changed; a merge that regenerated a `generated` file is not clean), any backticked AC literal is in no tracked file, a `perf` run lacks `baseline.md` or `compare.md`, a `refactor` run with a `method: test` AC did not pass at base, gitleaks finds a secret in a commit the run branch added, osv-scanner finds a high or critical vulnerability in a lockfile of the head (a finding that `security.accepted` of `ark.yml` lists does not count), a scanner fails, or gitleaks or osv-scanner is not installed. Medium and low vulnerabilities and the licences of new packages go to a `Security` section of the MR body. |
| R7.3    | **Where** a project sets `merge_requests: none`, the system shall refuse to open an MR and shall close the run `handed_off` with its branches in their clones, after the same refusals as R7.2, the security scan included.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| R7.4    | No `ark` command shall merge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Tickets | ARK-155, ARK-159, ARK-233, ARK-262                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Held by | `assertShippable` in `cli/merge-request.ts`; branch protection on the host. The optional auto-merger (`scripts/auto-merger.sh`) is a separate service, not an `ark` command; see the non-goals.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Cases   | R7.1: ARK-T48, ARK-T49, ARK-T107 · R7.2: ARK-T7, ARK-T8, ARK-T12, ARK-T246 · R7.3: ARK-T116                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### R8 · Bootstrap

| ID      | Requirement                                                                                                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R8.1    | The system shall keep each project's configuration in `~/.ark/projects/<project>/ark.yml`: workspace, ticket source, setup command, suites with their parsers, roles, gates, concurrency and checks. |
| R8.2    | **When** a project is bootstrapped, the playbook shall detect the stack, suites and repos, and ask only what it cannot detect.                                                                       |
| R8.3    | **When** a worktree is created, the system shall run the project's `setup` command in it.                                                                                                            |
| Tickets | ARK-150, ARK-158, ARK-198                                                                                                                                                                            |
| Held by | `skills/ark/playbooks/bootstrap.md`; `cli/config.ts`; [bootstrap-a-project.md](how-to/bootstrap-a-project.md)                                                                                        |

### R9 · Gates and rounds

| ID      | Requirement                                                                                                                                                                                                                                                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R9.1    | The system shall open the criteria gate on every run and shall not plan until you accept each criterion's `method` and `verified_by`.                                                                                                                                                                                                                                     |
| R9.2    | **When** the evaluator reports a blocker, the criteria gate shall show it.                                                                                                                                                                                                                                                                                                |
| R9.3    | The system shall count a round on each return to `building` after the first build, and shall open the escalation gate when the round budget (default two) is spent.                                                                                                                                                                                                       |
| R9.4    | **Where** `gates.escalation` is `auto`, the system shall answer `one_more_round` for the first `escalation_rounds` spent budgets of a run (default two), shall never answer an escalation that `ark escalate` requested or while the newest reviewer findings file holds a P0 or P1 finding with no `Repro:` line, and shall not count a merge-only start toward the cap. |
| R9.5    | The system shall record a gate answer only from you, through Master Chief or Plannotator, and never from an agent. The one exception is a gate that `ark.yml` sets to `auto` (strategy, plan or escalation): Ark records that answer itself, marked `by: auto`. The criteria gate always waits for you.                                                                   |
| Tickets | ARK-152, ARK-170, ARK-173, ARK-288, ARK-311                                                                                                                                                                                                                                                                                                                               |
| Held by | `ark gate record`; `ark escalate`; `cli/transitions.ts`; `test/gate.test.ts`                                                                                                                                                                                                                                                                                              |
| Cases   | R9.4: ARK-T220, ARK-T224                                                                                                                                                                                                                                                                                                                                                  |

### R10 · A small deterministic command line

| ID      | Requirement                                                                                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R10.1   | The system shall expose its mechanical steps as the commands `ark --help` lists, each deterministic for the same inputs, and shall keep judgment in skills.                       |
| R10.2   | **When** a command refuses, it shall print `ark: <reason>` on stderr and exit 1.                                                                                                  |
| R10.3   | The system shall generate `docs/reference/cli.md` from the command descriptions, and the `cli-reference` check shall fail when the committed file differs from the generated one. |
| R10.4   | **When** a project lists `checks` in `ark.yml`, `ark test` shall run each and record its exit status, and the implementer shall run them before every commit.                     |
| Tickets | ARK-152, ARK-153, ARK-154, ARK-155, ARK-157, ARK-173, ARK-209, ARK-276                                                                                                            |
| Held by | `cli/ark.ts`; `cli/commands/`; `scripts/cli-reference.ts`; `ark test check *`                                                                                                     |
| Cases   | R10.3: ARK-T44                                                                                                                                                                    |

### R11 · Retro and metrics

| ID      | Requirement                                                                                                                                                                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R11.1   | **When** the run lead runs `ark retro`, the system shall write `metrics.json` with cost and tokens per run, step, role and model; wall time per step, and wall time split into waiting on you, working, waiting to merge and idle; rounds, escalations and findings sent back; your interventions; orchestration health; and a comparison with earlier runs. |
| R11.2   | The run lead shall write `retro.md` on top of those numbers before the run is closed, and shall not rewrite it in an MR round.                                                                                                                                                                                                                               |
| R11.3   | **When** you bring a bug ticket, Master Chief shall ask whether it traces to an earlier run and link it as an escaped defect.                                                                                                                                                                                                                                |
| Tickets | ARK-160, ARK-161, ARK-173, ARK-288                                                                                                                                                                                                                                                                                                                           |
| Held by | `ark retro`; `skills/ark/playbooks/retro.md`                                                                                                                                                                                                                                                                                                                 |
| Cases   | R11.1: ARK-T170, ARK-T174, ARK-T178, ARK-T195                                                                                                                                                                                                                                                                                                                |

### R12 · Improvement proposals

| ID      | Requirement                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| R12.1   | The system shall change nothing from a retro until you approve the proposal.                                                                     |
| R12.2   | **When** you approve a proposal, it shall land in its scope: `ark.yml` or `learnings.md` for a project, a ticket for Ark, or a diff for a skill. |
| R12.3   | **Where** a learning can be checked by a command, it shall carry an `Enforced by:` line naming the refusal or check that holds it.               |
| Tickets | ARK-161, ARK-288, ARK-302                                                                                                                        |
| Held by | `~/.ark/projects/<project>/learnings.md` on each project; the named refusals                                                                     |

### R13 · Hub

| ID      | Requirement                                                                                                                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R13.1   | The system shall serve one browser page, `ark ui`, that shows what needs you across projects, every open run with its agents, models, MRs and cost, every run on one board with the cross-run dependency graph, and the roadmap. |
| R13.2   | **While** the hub is open, it shall reflect changes in Ark, Orca and Plannotator within 5 seconds; **if** a source does not answer, **then** it shall keep the last good value and show its age.                                 |
| R13.3   | The hub's one action shall be "Open in Orca" for a live agent; it shall send no text and change no run state, and shall refuse any request that is not local.                                                                    |
| Tickets | ARK-176, ARK-177, ARK-179, ARK-277, ARK-290, ARK-300, ARK-314                                                                                                                                                                    |
| Held by | `hub/`; [ADR 0009](adr/0009-hub-is-a-read-only-live-view.md); `isLocalRequest`; live checks in `~/.ark/projects/ark/verify.md`                                                                                                   |

## Milestones

Each requirement belongs to the milestones that built it. The state of a milestone (done, active, later) is in `ROADMAP.md` and changes; this page describes what the code does today.

| Requirement                | Milestones                                            |
| -------------------------- | ----------------------------------------------------- |
| R1 Master Chief            | M1 Core loop; M6 MR follow-up                         |
| R2 Runs and resume         | M1 Core loop; M5 Reliable runs                        |
| R3 Leads and workers       | M1 Core loop; M5 Reliable runs; M8 Models and vendors |
| R4 Strategy and plan gates | M1 Core loop                                          |
| R5 Multi-repo              | M2 Multi-repo on Clara, first cut; M7 Multi-repo      |
| R6 Proof                   | M1 Core loop; M7 Multi-repo                           |
| R7 Merge requests          | M1 Core loop; M6 MR follow-up                         |
| R8 Bootstrap               | M2 Multi-repo on Clara, first cut                     |
| R9 Gates and rounds        | M1 Core loop; M5 Reliable runs                        |
| R10 Command line           | M1 Core loop                                          |
| R11 Retro                  | M3 Self-improvement                                   |
| R12 Proposals              | M3 Self-improvement                                   |
| R13 Hub                    | M4 Hub; M9 See the work                               |

## Dependencies

- **Orca.** Hosts agents and carries messages; holds the queue. Harnesses: claude, codex, omp, pi.
- **Plannotator.** Plan gate and MR review in a browser; an inbox for questions when you are away.
- **`gh` and `glab`.** Open and check pull requests and merge requests.
- **docker compose.** Composes repos for multi-repo projects.
- **Bun.** Runs the `ark` command and its tests.

## Risks and open questions

- Run leads show as "no live run lead" in `ark chief state` while structured workers report liveness `unverifiable` (known gap).
- `same_vendor_review` reads true when the harness also ran a Sonnet model inside a Codex review session (ARK-293).
- A GitLab tier without MR dependencies falls back to `Depends on !N` in the description.
- Usage parsers read OMP and Claude Code session files; Codex follows.

## Why the first design was replaced

The first Ark treated agents as untrusted and the product as regulated. It built a hash-chained ledger, hashed gate packets, a launcher with tool restrictions, credential scrubbing and a rule that a gate answer needs a terminal. The machinery was hard to build and hard to change, and one in-progress run blocked 25 tickets.

Three facts made that machinery unnecessary:

| Fact                                                                              | Consequence                                                                                                                                                          |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ark itself is not regulated; the product repos keep their own validation.         | Ark produces evidence and no audit trail of its own.                                                                                                                 |
| Agents act on your behalf with your access.                                       | Agents get normal tools and credentials. The one hard line is that no Ark agent or command merges; the git host's branch protection decides when a merge is allowed. |
| The record of what happened is already the MR, the test results and an event log. | The event log is a plain append-only file.                                                                                                                           |

## Decisions

| ADR                                                                                             | Date       | Status                                                                                   |
| ----------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| [0001 TypeScript on Bun for the CLI](adr/0001-cli-tech-stack.md)                                | 2026-10-21 | Accepted, amended by 0004 (the hook shim, the ledger and `ark doctor` it names are gone) |
| [0002 Gate answers need a terminal](adr/0002-gate-answers-need-a-terminal.md)                   | 2026-10-26 | Superseded by 0004                                                                       |
| [0003 Same-user trust for v1](adr/0003-same-user-trust-for-v1.md)                               | 2026-10-26 | Superseded by 0004                                                                       |
| [0004 Trusted agents and a lightweight harness](adr/0004-trusted-agents-lightweight-harness.md) | 2026-10-29 | Accepted; supersedes 0002 and 0003                                                       |
| [0005 Orca and Plannotator](adr/0005-orca-and-plannotator.md)                                   | 2026-10-29 | Accepted, amended by 0007 and 0009                                                       |
| [0006 Integration and E2E proof only](adr/0006-integration-and-e2e-proof-only.md)               | 2026-10-29 | Superseded by 0010                                                                       |
| [0007 A read-only control center](adr/0007-control-center.md)                                   | 2026-10-30 | Superseded in part by 0008 and 0009; the three-tools split stays                         |
| [0008 The hub steers through Master Chief](adr/0008-hub-steers-through-master-chief.md)         | 2026-11-01 | Superseded in part by 0009; the name "hub" and one Master Chief per project stay         |
| [0009 The hub is a read-only live view](adr/0009-hub-is-a-read-only-live-view.md)               | 2026-11-02 | Accepted                                                                                 |
| [0010 Test cases describe the product](adr/0010-test-cases-describe-the-product.md)             | 2026-11-05 | Accepted; supersedes 0006                                                                |
