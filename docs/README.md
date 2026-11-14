# Ark documentation

Ark takes a ticket to merge-ready changes in one repo or across several dependent repos. This page lists every document by what you want to do. Words are defined in [CONTEXT.md](../CONTEXT.md). On GitHub an MR is a pull request.

## Decide whether to use Ark

- [Why Ark](why-ark.md): the problem, how a run goes and what you do, in five minutes.
- [The interactive tour](tour.html): click through a run in a browser, with no install.
- [Requirements](prd.md): what Ark promises, in EARS form, with the tickets that hold each promise.
- [Vision](explanation/vision.md): the closed loop from ticket to telemetry, and which parts exist.

## Understand how it works

- [Architecture](explanation/architecture.md): roles, depth, run lifecycle, gates and the run folder.
- [Scenarios](explanation/scenarios.md): three runs step by step: one repo, a dependency chain, a hand-off.
- [CONTEXT.md](../CONTEXT.md): the glossary people and agents share.
- [Decision records](#decision-records): why each design choice was made.

## Do something

- [Bootstrap a project](how-to/bootstrap-a-project.md): teach Ark a project once.
- [Run a ticket](how-to/run-a-ticket.md): from naming a ticket to a merged MR.
- [Project checks and ticket kinds](how-to/project-checks.md): checks in `ark.yml`, `kind: bug|perf|refactor`, and how `ark test` proves a ticket.
- [Reach the hub by a local name](how-to/local-names.md): open the hub as `http://ark.localhost`.
- [Run background services](how-to/background-services.md): install the auto-merger and the other launchd services.
- [Work on Ark](how-to/work-on-ark.md): install, the four checks, the opt-in hook and the test conventions for a change to Ark.

## Look something up

- [Command reference](reference/cli.md): every `ark` command and the run folder files.
- [Roadmap file](reference/roadmap.md): the format of `ROADMAP.md`.
- [Submodule composition](reference/submodule-composition.md): how a workspace of several repos is composed.

## What agents are told

Agents follow these files. Read them to learn exactly what an agent does.

- [Playbooks](../skills/ark/playbooks/): one file per role: [Master Chief](../skills/ark/playbooks/chief.md), [run lead](../skills/ark/playbooks/run-lead.md), [worker](../skills/ark/playbooks/worker.md), [retro](../skills/ark/playbooks/retro.md), [bootstrap](../skills/ark/playbooks/bootstrap.md) and [brainstorm](../skills/ark/playbooks/brainstorm.md).
- [Principles](../skills/ark/principles.md): one line for each principle, linked to the rule that holds it.
- [Reviewer rubric](../skills/ark/rubrics/reviewer.md): what a reviewer checks.
- [Rules](../rules/): the checklists for code: [naming](../rules/naming.md), [state machines](../rules/state-machines.md) and [test authoring](../rules/test-audit.md).
- [Test case writer](../skills/test-case-writer/SKILL.md) and [test case reviewer](../skills/test-case-reviewer/SKILL.md): the skills of those two workers.
- [PR writing](../skills/pr-writing/SKILL.md): how an MR description is written.

## Research and history

These pages are dated reports and frozen files. They show how Ark was measured or designed at one time. They do not describe how Ark works today.

| Folder                 | What it holds                                                                                                                                                                                                               | Status                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [research/](research/) | Spike reports: [Orca spikes](research/orca-spikes.md), [Master Chief pickup](research/master-chief-pickup.md) and [review panel spike](research/review-panel-spike.md).                                                     | Dated measurements. Check the code before you rely on a number.              |
| [evidence/](evidence/) | Committed copies of manual-AC evidence, one file per AC.                                                                                                                                                                    | Frozen at the date of the run. Hub wording from before ADR 0009 is expected. |
| [design/](design/)     | Hub prototypes. `hub/` and `hub-v2/` predate [ADR 0009](adr/0009-hub-is-a-read-only-live-view.md) and show removed views. `roadmap/` and `rendering/` are the design reference for the current Roadmap page and plan graph. | Frozen prototypes.                                                           |

## Decision records

An ADR records one decision and why it was made. A superseded ADR stays as history.

| ADR                                                    | Title                                                                          | Status                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [0001](adr/0001-cli-tech-stack.md)                     | TypeScript on Bun for the CLI                                                  | Accepted. Parts that name the hook shim, the ledger and `ark doctor` are historical (see 0004). |
| [0002](adr/0002-gate-answers-need-a-terminal.md)       | Human answers require an OMP ask or a controlling terminal                     | Superseded by 0004                                                                              |
| [0003](adr/0003-same-user-trust-for-v1.md)             | v1 trusts the operator's OS user; integrity checks catch mistakes, not forgery | Superseded by 0004                                                                              |
| [0004](adr/0004-trusted-agents-lightweight-harness.md) | Agents are trusted; the only hard line is that only a human merges             | Accepted                                                                                        |
| [0005](adr/0005-orca-and-plannotator.md)               | Orca hosts and connects agents; Plannotator is the review surface              | Accepted                                                                                        |
| [0006](adr/0006-integration-and-e2e-proof-only.md)     | An AC is proven only by integration or E2E tests passing at head               | Superseded by 0010                                                                              |
| [0007](adr/0007-control-center.md)                     | A read-only control center gives the high-level view                           | Superseded in part by 0008 and 0009                                                             |
| [0008](adr/0008-hub-steers-through-master-chief.md)    | The hub steers agents through Master Chief                                     | Superseded by 0009                                                                              |
| [0009](adr/0009-hub-is-a-read-only-live-view.md)       | Hub is a read-only live view                                                   | Accepted                                                                                        |
| [0010](adr/0010-test-cases-describe-the-product.md)    | Test cases describe the product, and an AC is proven through them              | Accepted                                                                                        |

## Writing docs

Prose follows the Google developer documentation style guide. The abbreviations CLI, MR, AC and E2E are never spelled out. See the last paragraph of [Naming](../rules/naming.md). ADRs 0001 to 0003 spell every abbreviation out and are historical.
