# Ark product requirements

Owner: @Cobe Karhoff · Updated: November 6, 2026 · Status: in use; 107 runs on this repo; M1 to M4 done, M5 and M9 active

## Overview

Ark takes a ticket to merge-ready changes in one repo or across several dependent repos. You talk to one session, Master Chief. Master Chief starts one run lead per ticket, and each run lead plans the work and starts workers to build, test and review it. A small `ark` command handles the mechanical parts; skills hold the judgment. Every run ends in a retro, and you approve the improvements that come out of it.

This page states what Ark promises, in EARS form, with the tickets that built each promise and the check that holds it. [Why Ark](why-ark.md) says what it is for; the [architecture](explanation/architecture.md) says how; the [vision](explanation/vision.md) says where it goes.

## Problem

The old Ark treated agents as untrusted and the product as regulated. It built a hash-chained ledger, hashed gate packets, a launcher with tool restrictions, credential scrubbing and a rule that a gate answer needs a terminal. The machinery was hard to build and hard to change, and one in-progress run blocked 25 tickets.

Three facts made that machinery unnecessary. Ark itself is not regulated; the product repos keep their own validation. Agents act on your behalf with your access, and the one hard line, that you merge, is enforced by the git host. The record of what happened is the merge request, the test results and a plain event log.

## Goals

1. Take a ticket to merge requests, one per repo, with you approving the criteria, the plan and the merge.
2. Run many tickets at once without one run blocking the others.
3. Prove each acceptance criterion with test cases that pass at the head of the composed workspace.
4. Work on a single repo, such as Ark, and on a multi-repo workspace, such as Clara or Smart QC.
5. Let you stop a run and resume it in a new session at the first unfinished step.
6. Keep the `ark` command small and deterministic. Put judgment in skills.
7. Improve with use. Every run ends in a retro, and changes happen only when you approve a proposal.

## Non-goals

- Auto-merge. Only you merge. The guarded auto-merger acts only on MRs you have cleared.
- Hard cost caps. Ark shows cost while a run is live and judges it in retros.
- Audit machinery of the kind the FDA expects of a regulated system. Ark is not regulated; it produces evidence for the product repos' own validation.
- A custom web interface that watches agents, answers gates or changes a run. Orca shows agents, Plannotator takes gate answers, and the hub only reads (ADR 0009).
- An enforced cross-vendor rule. Plans default to a different vendor for the reviewer, and you can change it per step.
- Red-green proof, preservation proof or acceptance criterion kinds. Passing test cases at head are the proof (ADR 0010).

## Users and scenarios

**You, on the Ark repo.** One GitHub repo. You name a ticket, Master Chief queues it, a run lead plans it, you accept the criteria and the plan, workers build and prove it, Ark opens one pull request, you merge. [Scenario 1](explanation/scenarios.md#1-one-repo-a-ticket-on-ark-itself) walks through a real run.

**You, on a multi-repo workspace.** A GitLab meta-repo with repos under `repos/*`. One ticket changes two or more repos. The run lead plans steps per repo in merge order (the repo edges of the plan, upstream first); the run folder mirrors the workspace with a worktree per touched repo; tests run through docker compose against the composed worktrees; Ark opens one MR per repo in order. [Scenario 2](explanation/scenarios.md#2-a-dependency-chain-one-ticket-across-several-repos).

**You, on a repo Ark may not push to.** The project sets `merge_requests: none`. The run does everything up to the host and ends `handed_off`, with the branches in their clones for you to review. [Scenario 3](explanation/scenarios.md#3-a-hand-off-a-repo-where-ark-may-not-push).

**You, reviewing retros.** After a run closes you read `retro.md`: cost, time, rework, your own interventions, escaped defects, compared with earlier runs. You answer three questions and approve or reject each proposal.

## Requirements

Written in EARS. The patterns: **ubiquitous** (the system shall), **event-driven** (when … the system shall), **state-driven** (while … the system shall), **unwanted behaviour** (if … then the system shall), **optional** (where … the system shall). Each requirement names the tickets that built it and the check or decision that holds it. Each ticket holds its own acceptance criteria.

### R1 · Master Chief

|         |                                                                                                                                                                                     |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1.1    | The system shall provide one Master Chief session per project through which you name tickets, receive every gate question and give every gate answer.                               |
| R1.2    | **When** you approve a ticket, Master Chief shall queue it as an Orca Task and start one run lead for it, up to the project's `concurrency`.                                        |
| R1.3    | **If** a second Master Chief is started for a project, **then** it shall refuse to start and name the live terminal.                                                                |
| R1.4    | **While** a run has an open MR, Master Chief shall poll `ark merge-request status` and, on a failed check, a human comment or a conflict, start the run lead again for an MR round. |
| R1.5    | Master Chief shall never write product code.                                                                                                                                        |
| Tickets | ARK-151, ARK-156, ARK-177, ARK-202, ARK-281                                                                                                                                         |
| Held by | `skills/ark/playbooks/chief.md`; `ark chief state`; ADR 0008, ADR 0009                                                                                                              |

### R2 · Runs and resume

|         |                                                                                                                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2.1    | **When** `ark run start <ticket>` runs, the system shall create the run folder with a snapshot of the ticket, an empty event log and derived state.                                                 |
| R2.2    | The system shall derive `state.json` from `events.ndjson` so that the state can be rebuilt from the log alone.                                                                                      |
| R2.3    | **When** a new run lead takes over a stopped run, it shall resume at the phase and the first unfinished step that `ark status <run>` shows, and shall not ask for a gate the log shows as answered. |
| R2.4    | The system shall allow at most one open run per ticket.                                                                                                                                             |
| Tickets | ARK-152, ARK-170                                                                                                                                                                                    |
| Held by | `cli/events.ts`, `cli/transitions.ts`; `ark status`; `test/run.test.ts`                                                                                                                             |

### R3 · Run leads and workers on Orca

|         |                                                                                                                                                                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R3.1    | The system shall run Master Chief, run leads and workers as Orca agents with a nesting depth of two: Master Chief starts run leads, run leads start workers, and a worker shall never start an agent.       |
| R3.2    | **When** a run lead starts a worker, it shall name the worker's role and step in words and shall read `roles` in `ark.yml` for the harness and model at that moment, not from an earlier copy.              |
| R3.3    | **Where** a ticket changes something a person sees, the run lead shall start a Designer unless the surface is only `none`, or there is one card and the surface is only `document`, `cli_output` or `none`. |
| R3.4    | **If** a worker hits a provider usage limit, **then** the run lead shall not change models itself and shall ask Master Chief, which asks you.                                                               |
| Tickets | ARK-151, ARK-156, ARK-173, ARK-174, ARK-217, ARK-239, ARK-282                                                                                                                                               |
| Held by | `ark plan check` roles refusal (ARK-282); `learnings.md` 2026-11-01 and 2026-11-03                                                                                                                          |

### R4 · Strategy and plan gates

|         |                                                                                                                                                                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4.1    | **When** `strategies.md` has two or more cards, the system shall open the strategy gate and shall not plan until you pick a card or ask for a design round.                                                                                                          |
| R4.2    | The system shall refuse a plan with a cycle, an unknown `needs`, a step with no repo or role, a missing summary, a `method: test` criterion with no integration or E2E test case in its `verified_by`, an interface with no name or no callers, or an open decision. |
| R4.3    | **When** a plan passes `ark plan check`, the system shall render `plan.md` with the summary, the change table, the design block, the step diagram and the test cases as Gherkin.                                                                                     |
| R4.4    | The system shall not enter `building` before you approve the plan, and shall not approve a plan while a decision is open.                                                                                                                                            |
| Tickets | ARK-153, ARK-156, ARK-173, ARK-311                                                                                                                                                                                                                                   |
| Held by | `ark plan check`; `cli/transitions.ts`; `test/plan.test.ts`; Plannotator for review                                                                                                                                                                                  |

### R5 · Multi-repo by local composition

|         |                                                                                                                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R5.1    | **When** a run touches a repo in a multi-repo workspace, `ark worktree create` shall mirror the workspace into `<run>/workspace/` with a worktree at the repo's usual path and a symlink for every other repo and root file. |
| R5.2    | **While** tests run, the system shall run docker compose with `--project-directory <run>/workspace` so that every `./repos/*` path resolves to the run's worktrees.                                                          |
| R5.3    | **Where** the workspace is a single repo, `<run>/workspace` shall itself be the worktree.                                                                                                                                    |
| Tickets | ARK-150, ARK-154, ARK-159                                                                                                                                                                                                    |
| Held by | `cli/worktree.ts`; spike findings in [orca-spikes.md](explanation/orca-spikes.md)                                                                                                                                            |

### R6 · Proof

|         |                                                                                                                                                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R6.1    | The system shall decide each acceptance criterion from the results of the test cases in its `verified_by`, at every level, at head.                                                                                                                      |
| R6.2    | The system shall require at least one integration or E2E test case in the `verified_by` of each `method: test` criterion.                                                                                                                                |
| R6.3    | **Where** a criterion has `manual: true` or a method other than `test`, the system shall treat your `manual ok` gate answer as its proof and shall treat `manual problem` as a finding.                                                                  |
| R6.4    | The system shall read each test runner's native report through its own parser: `bun test` today, pytest and behave for Python repos.                                                                                                                     |
| R6.5    | **If** a test that carries an old AC id in its title is changed by a run, **then** the reviewer shall reject the diff as P0 unless the run converts it to a test case.                                                                                   |
| R6.6    | The validator shall audit every new or changed test against `rules/test-audit.md`: it asserts observable behaviour at the real boundary, fails for a credible regression, takes no expected value from the code under test, and mocks nothing it proves. |
| Tickets | ARK-154, ARK-158, ARK-243, ARK-311, ARK-312, ARK-315                                                                                                                                                                                                     |
| Held by | `ark test`; `cli/parsers/*`; `skills/ark/rubrics/reviewer.md` Proof; ADR 0010                                                                                                                                                                            |

### R7 · Merge requests

|         |                                                                                                                                                                                                                                                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R7.1    | **When** the last `ark test` passed at the latest commit and no review sent work back, `ark merge-request open` shall push each repo's branch and open one MR per repo in merge order (the repo edges of the plan, upstream first), recording each dependency.                                                                                                |
| R7.2    | The system shall refuse to open an MR if there is no test result, any non-manual criterion is not `passing`, any manual criterion is not `ok`, the last test did not pass, any repo changed since the last test, any backticked AC literal is in no tracked file, a `perf` run lacks `baseline.md` or `compare.md`, or a `refactor` run did not pass at base. |
| R7.3    | **Where** a project sets `merge_requests: none`, the system shall refuse to open an MR and shall close the run `handed_off` with its branches in their clones, after the same refusals as R7.2.                                                                                                                                                               |
| R7.4    | No `ark` command shall merge.                                                                                                                                                                                                                                                                                                                                 |
| Tickets | ARK-155, ARK-159, ARK-233, ARK-262                                                                                                                                                                                                                                                                                                                            |
| Held by | `assertShippable` in `cli/merge-request.ts`; branch protection on the host                                                                                                                                                                                                                                                                                    |

### R8 · Bootstrap

|         |                                                                                                                                                                                                      |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R8.1    | The system shall keep each project's configuration in `~/.ark/projects/<project>/ark.yml`: workspace, ticket source, setup command, suites with their parsers, roles, gates, concurrency and checks. |
| R8.2    | **When** a project is bootstrapped, the playbook shall detect the stack, suites and repos, and ask only what it cannot detect.                                                                       |
| R8.3    | **When** a worktree is created, the system shall run the project's `setup` command in it.                                                                                                            |
| Tickets | ARK-150, ARK-158, ARK-198                                                                                                                                                                            |
| Held by | `skills/ark/playbooks/bootstrap.md`; `cli/config.ts`; [bootstrap-a-project.md](how-to/bootstrap-a-project.md)                                                                                        |

### R9 · Gates and rounds

|         |                                                                                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R9.1    | The system shall open the criteria gate on every run and shall not plan until you accept each criterion's `method` and `verified_by`.                                                                                                             |
| R9.2    | **When** the evaluator reports a blocker, the criteria gate shall show it.                                                                                                                                                                        |
| R9.3    | The system shall count a round on each return to `building` after the first build, and shall open the escalation gate when the round budget (default two) is spent.                                                                               |
| R9.4    | **Where** `gates.escalation` is `auto`, the system shall answer `one_more_round` for the first two spent budgets of a run, shall never answer an escalation that `ark escalate` requested, and shall not count a merge-only start toward the two. |
| R9.5    | The system shall record a gate answer only from you, through Master Chief or Plannotator, and never from an agent.                                                                                                                                |
| Tickets | ARK-152, ARK-170, ARK-173, ARK-288, ARK-311                                                                                                                                                                                                       |
| Held by | `ark gate record`; `ark escalate`; `cli/transitions.ts`; `test/gate.test.ts`                                                                                                                                                                      |

### R10 · A small deterministic command line

|         |                                                                                                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R10.1   | The system shall expose its mechanical steps as the commands `ark --help` lists, each deterministic for the same inputs, and shall keep judgment in skills.                       |
| R10.2   | **When** a command refuses, it shall print `ark: <reason>` on stderr and exit 1.                                                                                                  |
| R10.3   | The system shall generate `docs/reference/cli.md` from the command descriptions, and the `cli-reference` check shall fail when the committed file differs from the generated one. |
| R10.4   | **When** a project lists `checks` in `ark.yml`, `ark test` shall run each and record its exit status, and the implementer shall run them before every commit.                     |
| Tickets | ARK-152, ARK-153, ARK-154, ARK-155, ARK-157, ARK-173, ARK-209, ARK-276                                                                                                            |
| Held by | `cli/ark.ts`; `cli/commands/`; `scripts/cli-reference.ts`; `ark test check *`                                                                                                     |

### R11 · Retro and metrics

|         |                                                                                                                                                                                                                                                                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R11.1   | **When** a run closes, `ark retro` shall write `metrics.json` with cost and tokens per run, step, role and model; wall time per step, and wall time split into waiting on you, working, waiting to merge and idle; rounds, escalations and findings sent back; your interventions; orchestration health; and a comparison with earlier runs. |
| R11.2   | The run lead shall write `retro.md` on top of those numbers before the run is closed, and shall not rewrite it in an MR round.                                                                                                                                                                                                               |
| R11.3   | **When** you bring a bug ticket, Master Chief shall ask whether it traces to an earlier run and link it as an escaped defect.                                                                                                                                                                                                                |
| Tickets | ARK-160, ARK-161, ARK-173, ARK-288                                                                                                                                                                                                                                                                                                           |
| Held by | `ark retro`; `skills/ark/playbooks/retro.md`                                                                                                                                                                                                                                                                                                 |

### R12 · Improvement proposals

|         |                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| R12.1   | The system shall change nothing from a retro until you approve the proposal.                                                                     |
| R12.2   | **When** you approve a proposal, it shall land in its scope: `ark.yml` or `learnings.md` for a project, a ticket for Ark, or a diff for a skill. |
| R12.3   | **Where** a learning can be checked by a command, it shall carry an `Enforced by:` line naming the refusal or check that holds it.               |
| Tickets | ARK-161, ARK-288, ARK-302                                                                                                                        |
| Held by | `learnings.md` on each project; the named refusals                                                                                               |

### R13 · Hub

|         |                                                                                                                                                                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R13.1   | The system shall serve one browser page, `ark ui`, that shows what needs you across projects, every open run with its agents, models, MRs and cost, every run on one board with the cross-run dependency graph, and the roadmap. |
| R13.2   | **While** the hub is open, it shall reflect changes in Ark, Orca and Plannotator within 5 seconds; **if** a source does not answer, **then** it shall keep the last good value and show its age.                                 |
| R13.3   | The hub's one action shall be "Open in Orca" for a live agent; it shall send no text and change no run state, and shall refuse any request that is not local.                                                                    |
| Tickets | ARK-176, ARK-177, ARK-179, ARK-277, ARK-290, ARK-300, ARK-314                                                                                                                                                                    |
| Held by | `hub/`; ADR 0009; `isLocalRequest`; [verify.md](https://github.com/cobekarhoff/ark) live checks                                                                                                                                  |

## Traceability

| Requirement                | Tickets                               | Milestone  |
| -------------------------- | ------------------------------------- | ---------- |
| R1 Master Chief            | ARK-151, 156, 177, 202, 281           | M1, M6     |
| R2 Runs and resume         | ARK-152, 170                          | M1, M5     |
| R3 Leads and workers       | ARK-151, 156, 173, 174, 217, 239, 282 | M1, M5, M8 |
| R4 Strategy and plan gates | ARK-153, 156, 173, 311                | M1         |
| R5 Multi-repo              | ARK-150, 154, 159                     | M2, M7     |
| R6 Proof                   | ARK-154, 158, 243, 311, 312, 315      | M1, M7     |
| R7 Merge requests          | ARK-155, 159, 233, 262                | M1, M6     |
| R8 Bootstrap               | ARK-150, 158, 198                     | M2         |
| R9 Gates and rounds        | ARK-152, 170, 173, 288, 311           | M1, M5     |
| R10 Command line           | ARK-152 to 157, 173, 209, 276         | M1         |
| R11 Retro                  | ARK-160, 161, 173, 288                | M3         |
| R12 Proposals              | ARK-161, 288, 302                     | M3         |
| R13 Hub                    | ARK-176, 177, 179, 277, 290, 300, 314 | M4, M9     |

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

## Decisions

- [0004 Trusted agents and a lightweight harness](adr/0004-trusted-agents-lightweight-harness.md)
- [0005 Orca and Plannotator](adr/0005-orca-and-plannotator.md)
- [0009 The hub is a read-only live view](adr/0009-hub-is-a-read-only-live-view.md)
- [0010 Test cases describe the product](adr/0010-test-cases-describe-the-product.md), which replaces [0006](adr/0006-integration-and-e2e-proof-only.md)

ADRs 0001 to 0003 describe the old design. 0007 and 0008 are superseded by 0009.
