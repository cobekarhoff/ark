# Ark

Ark is a software factory that takes a ticket through planning, implementation, real-test validation and cross-vendor review to merge-ready changes, with human gates and an audit trail.

## Language

**Ticket**:
A unit of requested work with acceptance criteria, from one ticket source.
_Avoid_: Issue, story, task

**Run**:
One attempt to carry a ticket from intake to a closed outcome. A ticket has zero or more runs over time; at most one is open.
_Avoid_: Attempt, session, job

**Outcome**:
How a closed run ended: merged, abandoned, aborted or handed off.
_Avoid_: Result, status

**Merged**:
The outcome where every merge request of the run was merged by a human.
_Avoid_: Done, shipped

**Abandoned**:
The outcome where evidence was approved but a human closed the merge requests unmerged.
_Avoid_: Rejected, cancelled

**Aborted**:
The outcome where the run stopped before any merge request existed.
_Avoid_: Cancelled, failed

**Handed off**:
The outcome where evidence was approved and ready branches were given to a human outside Ark, with no merge request opened by Ark.
_Avoid_: Done, delivered

**Merge request (MR)**:
The request Ark opens on a git host for a human to review and merge one repo's changes of a run; on GitHub it is a pull request.
_Avoid_: PR, pull request, change request

## Rework

**Round**:
One return to implementation within a run after the first build: a failed exit check, an evidence send-back, or an escalation granting one more round. Rounds are numbered per run and share one budget.
_Avoid_: Fix round, retry, iteration, attempt

**Round budget**:
The number of rounds a run may use before a human must decide; two by default. Once spent, every further failure escalates.
_Avoid_: Retry limit, max attempts

**Escalation**:
The point where a run stops for a human decision because its round budget is spent; the human grants exactly one more round, takes over, or aborts. Its gate id in the CLI is `GE`; in prose say escalation.
_Avoid_: GE (in prose), failure, stuck run

## Roles

**Role**:
A responsibility in a run that an agent or a human can fill; the role, not who fills it, decides what checks apply.
_Avoid_: Agent type, persona

**Orchestrator**:
The role that drives a run, judges findings and asks for gate decisions, and never writes product code.
_Avoid_: Lead, main agent, coordinator

**Implementer**:
The role that writes product code for one repo of a run; filled by an agent, or by a human who takes over at an escalation.
_Avoid_: Coder, developer, builder

**Validator**:
The role that writes and fixes the tests that prove a run's acceptance criteria, on a different vendor from the implementer.
_Avoid_: Tester, QA agent

**Reviewer**:
The role that hunts for defects in a run's changes and reports findings; never edits.
_Avoid_: Critic, judge, auditor

**Vendor**:
The company whose models fill a role, read from the model's provider; a human has no vendor.
_Avoid_: Provider, model family

**Vendor rule**:
The validator and the cross-vendor reviewer never share a vendor with the implement role's configured model, for the whole run, even when a human takes over.
_Avoid_: Cross-model check

## Gates

**Gate**:
A point in a run where only a human decision lets it continue: setup, AC clarity, plan, escalation and evidence. Merging an MR is the git host's approval, not a gate.
_Avoid_: Checkpoint, approval step, G3

**Packet**:
The fixed, hashed bundle a human sees at a gate; an answer is bound to exactly one packet.
_Avoid_: Summary, report

**Answer**:
A human's decision at a gate, from that gate's fixed choices, given through a human-only channel and bound to a packet. A decision made by an agent is never an answer.
_Avoid_: Approval, sign-off, vote

## Proof

**Acceptance criterion (AC)**:
One testable statement of what a ticket must achieve, with an ID stable for the life of the ticket.
_Avoid_: Requirement, criterion, condition

**AC kind**:
Whether an AC is new behavior (absent before the change) or preserved behavior (present before and after); proposed at intake, confirmed by a human at the plan gate.
_Avoid_: AC type, category

**Red-green proof**:
Evidence that a new-behavior AC's tagged tests fail on the base and pass on the head.
_Avoid_: TDD proof, before/after test

**Preservation proof**:
Evidence that a preserved-behavior AC's tagged tests pass on both the base and the head.
_Avoid_: Regression proof, green-green

## Review

**Finding**:
A defect a reviewer claims in a run's changes, with a priority from P0 (must fix) to P3 (minor).
_Avoid_: Issue, comment, bug report

**Disposition**:
The orchestrator's judgment of a finding: act on, consider, noted or dismissed, always with a reason.
_Avoid_: Bucket, verdict, triage label

**Verified finding**:
An act-on finding backed by a tagged test that fails at the current head, or, where no test can reach it, by a traced path marked as weaker evidence. Only verified P0 and P1 findings send work back.
_Avoid_: Confirmed finding, accepted finding

## Scope

**Project**:
A named set of repos plus the policy that governs their runs: ticket source, models, gates and round budget. Every run belongs to exactly one project.
_Avoid_: Workspace, product, estate

**Repo**:
A git repository with its own Ark configuration; it may belong to several projects.
_Avoid_: Repository, package, component

**Worktree**:
A run's private checkout of one repo, where the implementer and validator work and from which agents cannot push.
_Avoid_: Workspace, checkout, sandbox

**Evidence**:
The recorded proofs for each AC at the current head (red-green proof, preservation proof, or a signed manual record) and the artifacts they point to: test reports, logs, environment fingerprints and, for UI or system behavior, screenshots. Findings and diffs sit beside evidence, not in it.
_Avoid_: Proof bundle, test output, results
