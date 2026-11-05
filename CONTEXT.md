# Ark

Ark takes tickets to merge-ready changes. You talk to one Master Chief session. It starts a run lead for each ticket, the run lead plans the work across the project's repos and runs workers, and you decide at gates and merge.

## Work

**Ticket**:
A piece of requested work with acceptance criteria, from the project's ticket source.
_Avoid_: Issue, story, task

**Acceptance criterion (AC)**:
One testable statement of what a ticket must achieve. Its ID, such as `ARK-150-AC2`, never changes.
_Avoid_: Requirement, condition

**Run**:
One attempt to take a ticket from start to a closed outcome. A ticket can have several runs over time, but only one open at once.
_Avoid_: Attempt, session, job

**Outcome**:
How a closed run ended: merged, abandoned, aborted or handed off.
_Avoid_: Result, status

**Merged**:
Every MR of the run was merged by a human.
_Avoid_: Done, shipped

**Abandoned**:
The run's MRs were opened, then closed unmerged by a human.
_Avoid_: Rejected, cancelled

**Aborted**:
The run stopped before any MR was opened.
_Avoid_: Cancelled, failed

**Handed off**:
The run's tests passed and its branches were given to a human without Ark opening MRs. Each branch with commits beyond its base stays in its clone; the worktrees are removed.
_Avoid_: Delivered

**Hub**:
The browser page `ark ui` serves, from `hub/`. Home shows what needs the human, then each open run with its agents, models, MRs and cost; Run shows any run, open or closed, with its plan DAG, decisions, run files and agent transcripts; Runs lists every run on one board with a cross-run dependency graph; Roadmap shows the vision, the milestones and the ranked tickets with their runs, and a ticket opens as a full page. It is a view. Its one action is "Open in Orca", which focuses a live agent's terminal in Orca (live = Orca lists the terminal as connected; an agent session Orca lists only as a worker shows "running in Orca, open it from its chat tab", a released one "ended, not in Orca"). It steers no agent, sends no text and changes no run state (ADR 0009).
The project filter is site-wide: the `project` query of the hash, with "All projects" (no query) the default; the header's Project group sets it, and every link keeps it.
_Avoid_: Control center, dashboard

**Merge request (MR)**:
The request Ark opens for a human to review and merge one repo's changes. On GitHub it's a pull request.
_Avoid_: Change request

**Roadmap**:
The file `$ARK_HOME/projects/<project>/ROADMAP.md`: the vision, the milestones and the human's rank of the open tickets. Only the human changes a rank. Format: `docs/reference/roadmap.md`.
_Avoid_: Backlog table, plan

**Milestone**:
A named outcome in the roadmap, such as M9 "See the work". It is `done`, `active` or `later`. A ticket joins one by its `milestone:` field.
_Avoid_: Release, epic

**Horizon**:
Now, Next or Later: one of the three ranked lists of the roadmap. An open ticket in no horizon is Unranked.
_Avoid_: Priority, sprint

## Roles

**Master Chief**:
The one agent session you talk to. It suggests and queues tickets, starts a run lead for each, and brings you every gate. It never writes product code.
_Avoid_: Orchestrator, main agent, coordinator, master agent

**Brainstorm partner**:
The agent session you open to explore ideas. It writes the ideas you keep as proposed tickets. It never sets a ticket to ready, queues one, or sends to Master Chief.
_Avoid_: PO agent

**Run lead**:
The agent that drives one run across every repo its ticket touches. It plans, starts workers, decides what to do with findings, and asks you for gate decisions through Master Chief. It never writes product code.
_Avoid_: Orchestrator, ticket lead, lead

**Worker**:
An agent a run lead starts for one step: an implementer, validator or reviewer. The run lead also starts one evaluator before it plans, and one Designer when the ticket changes something a person sees, unless the surface is only `none`, or there is one card and the surface is only `document`. A worker never starts other agents.
_Avoid_: Subagent, child agent, helper

**Implementer**:
The worker that writes product code in one repo. You can take over this role at an escalation.
_Avoid_: Coder, developer, builder

**Validator**:
The worker that turns the plan's test cases into tagged integration and E2E tests and makes them pass.
_Avoid_: Tester, QA agent

**Reviewer**:
The worker that looks for defects in a run's changes and reports findings. It never edits.
_Avoid_: Critic, judge, auditor

**Evaluator**:
The worker that checks a ticket before the run lead plans. It reads the ticket and the code, runs read-only probes, and writes `evaluation.md` with blockers and risks. It never edits product code. `ark.yml` sets its harness and model.
_Avoid_: Pre-reviewer, triage agent

**Designer**:
The worker that makes mockups for the strategy cards, and for a question about interaction a running prototype in a throwaway worktree. It revises them in each design round and never edits product code. Mockups never go into an MR. `roles.designer` in `ark.yml` sets its harness and model, and it is optional: it is not needed when the surface is only `none`, or when there is one card and the surface is only `document`.
_Avoid_: UI agent, artist

**Strategy**:
A whole way to do the ticket, written as a short card in `strategies.md`: approach, interfaces, tradeoffs, rough steps, optional mockup links and a recommendation. With one possible strategy, the file has one card and a reason.
_Avoid_: Option, proposal

**Strategy gate**:
The gate that opens when `strategies.md` has 2 or more cards. The phase is `awaiting_strategy`. You answer with a card ID or abort. With one card, no gate opens.

**Design round**:
One more `ark strategy record` before you answer the strategy gate, after you annotated the cards or mockups and the same Designer revised them. Design rounds have no budget and never open an escalation.
_Avoid_: Strategy round

**Decision**:
A smaller choice inside the chosen strategy, in the `decisions` list of `plan.yml`: a question, 2 to 4 options with tradeoffs, a recommended option and, after you answer, the chosen one. You answer open decisions at the plan gate, and `plan approve` is refused while one is open.
_Avoid_: Question, open point

**Blocker**:
A problem the evaluator finds in an AC: it is not possible, no integration or E2E test can prove it (a criterion with `manual: true` is exempt), or it conflicts with other code. A blocker opens the criteria gate.

**Risk**:
A problem the evaluator finds that the plan must handle. `plan.md` lists each risk.

**Vendor**:
The company whose model runs a worker, such as Anthropic or OpenAI.
_Avoid_: Provider, model family

**Cross-vendor review**:
The default that validators and reviewers use a different vendor from the implementers. The plan sets it per step, and you can change it at the plan gate.
_Avoid_: Vendor rule

## Planning and proof

**Plan**:
A run's graph of steps and its test cases, written by the run lead. You review, edit and approve it at the plan gate before any code is written.
_Avoid_: Task list, workflow, pipeline

**Step**:
One piece of a plan: one role's work in one repo, the steps it waits for, and the ACs it serves.
_Avoid_: Task, node, job, stage

**Test case**:
One integration or E2E scenario that proves an AC, with its steps and expected result. Unit tests never prove an AC.
_Avoid_: Spec, scenario

**Evidence**:
The results of a run's test cases at the latest commit on the composed workspace, with the reports, logs and screenshots they point to.
_Avoid_: Proof bundle, test output

**Finding**:
A defect a reviewer reports, ranked from P0 (must fix) to P3 (minor).
_Avoid_: Issue, comment, bug report

## Gates and rework

**Gate**:
A point where the run waits for your decision. The gates are criteria (the ticket lacks testable ACs, or the evaluator found a blocker), strategy (2 or more strategy cards), manual (a criterion with `manual: true` waits for your `ok`; it shows `manual pending`, `manual ok` or `manual problem`), plan (before any code) and escalation (the round budget is spent). Merging an MR is your approval on the git host, not a gate.
_Avoid_: Checkpoint, approval step

**Answer**:
Your decision at a gate. A decision made by an agent is never an answer.
_Avoid_: Approval, sign-off, vote

**Round**:
One return to implementation after the first build, caused by a failing test case, a finding the run lead sends back, or an extra round granted at an escalation, by you or by auto (up to 2).
_Avoid_: Retry, iteration, attempt

**Round budget**:
How many rounds a run may use before you must decide. The default is two.
_Avoid_: Retry limit, max attempts

**Escalation**:
The gate a run reaches when its round budget is spent. You grant one more round, take over, or abort. With `gates.escalation: auto`, Ark grants the first 2 extra rounds itself (`by: auto`) and asks you after that. It never answers an escalation that `ark escalate` requested.
_Avoid_: Failure, stuck run

## Projects

**Project**:
One workspace plus the settings for its runs: ticket source, models, test suites and round budget.
_Avoid_: Product, estate, manifest

**Workspace**:
The directory a project lives in: a single repo, or a meta-repo that holds several repos. Run leads find the repos by reading it.
_Avoid_: Monorepo, environment

**Repo**:
A git repository in a project's workspace.
_Avoid_: Package, component

**Worktree**:
A run's own checkout of one repo. A run folder mirrors its workspace: the repos the run touches are worktrees, and everything else links to the workspace.
_Avoid_: Checkout, sandbox

**Bootstrap**:
The one-time work that teaches Ark a project: its stack, its integration and E2E suites, how its repos run together, and its ticket source.
_Avoid_: Setup, onboarding, init

## Improvement

**Retro**:
The review written when a run closes: its cost, time, rework, how much you had to step in, and any escaped defects, compared with earlier runs, plus improvement proposals.
_Avoid_: Postmortem, report

**Improvement proposal**:
A change Master Chief or a run lead suggests, backed by retro evidence: to a project's settings or learnings, to Ark's own process, or to a skill. It takes effect only after you approve it.
_Avoid_: Suggestion, tweak, auto-tune

**Escaped defect**:
A bug found after a run merged and traced back to that run.
_Avoid_: Regression, leak
