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
The run's tests passed and its branches were given to a human without Ark opening MRs.
_Avoid_: Delivered

**Merge request (MR)**:
The request Ark opens for a human to review and merge one repo's changes. On GitHub it's a pull request.
_Avoid_: Change request

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
An agent a run lead starts for one step: an implementer, validator or reviewer. A worker never starts other agents.
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
A point where the run waits for your decision. The gates are criteria (the ticket lacks testable ACs), plan (before any code) and escalation (the round budget is spent). Merging an MR is your approval on the git host, not a gate.
_Avoid_: Checkpoint, approval step

**Answer**:
Your decision at a gate. A decision made by an agent is never an answer.
_Avoid_: Approval, sign-off, vote

**Round**:
One return to implementation after the first build, caused by a failing test case, a finding the run lead sends back, or an extra round granted at an escalation.
_Avoid_: Retry, iteration, attempt

**Round budget**:
How many rounds a run may use before you must decide. The default is two.
_Avoid_: Retry limit, max attempts

**Escalation**:
The gate a run reaches when its round budget is spent. You grant one more round, take over, or abort.
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
