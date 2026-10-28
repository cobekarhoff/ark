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
The point where a run stops for a human decision because its round budget is spent; the human grants exactly one more round, takes over, or aborts. Its gate id in the command-line interface (CLI) is `GE`; in prose say escalation.
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
_Avoid_: Tester, quality assurance (QA) agent

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
A point in a run where only a human decision lets it continue: setup, acceptance criterion (AC) clarity, plan, escalation and evidence. Merging an MR is the git host's approval, not a gate.
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
The recorded proofs for each AC at the current head (red-green proof, preservation proof, or a signed manual record) and the artifacts they point to: test reports, logs, environment fingerprints and, for user interface (UI) or system behavior, screenshots. Findings and diffs sit beside evidence, not in it.
_Avoid_: Proof bundle, test output, results

## Abbreviations

**AC**:
Acceptance criterion. AC IDs such as `ARK-013-AC2` are a data format and stay as they are.

**ADR**:
Architecture decision record, kept in `docs/adr/`.

**CI**:
Continuous integration: the automated build and test runs a git host performs on every change.

**CLI**:
Command-line interface; here the `ark` command.

**DAG**:
Directed acyclic graph; the shape of a run's plan, shown at the plan gate.

**E2E**:
End-to-end: a test that exercises the real system from its outside edge.

**FDA**:
United States Food and Drug Administration, whose rules for medical-device software shape Ark's audit trail.

**FR**, **NFR**:
Functional requirement, non-functional requirement: numbered lines of `docs/prd.md`, such as FR-24.

**MR**:
Merge request.

**OMP**:
Oh My Pi, the agent harness Ark installs into as a plugin.

**OS**:
Operating system.

**PHI**:
Protected health information.

**PRD**:
Product requirements document, `docs/prd.md`.

**PTY**:
Pseudo-terminal: a terminal a program allocates without a person at it.

**QA**, **RA**:
Quality assurance, regulatory affairs: the people who audit runs after the fact.

**SHA**, **SHA-256**:
Secure hash algorithm. A commit SHA names one git commit; SHA-256 is the 256-bit variant that hashes packets and run manifests.

**UI**:
User interface.

### Scales and names

**Priorities P0 to P3**:
P0 breaks an AC, loses or corrupts data or opens a security hole (must fix); P1 is a likely defect or missing proof for an AC; P2 is worth fixing but never blocks; P3 is minor.

**Tiers T1 to T3**:
The risk tier of a run, proposed at the plan gate, that sets how many reviewers read it: T1 light (one repo, small diff, no risk tags; one reviewer), T2 standard (the default; two reviewers), T3 high (any risk tag such as authentication, patient data or a data migration; two reviewers plus a security reviewer).

**Milestones M0 to M5, M1a**:
M0 the harness spikes that confirm how OMP behaves before building (ARK-101); not a row of the PRD's milestone table. M1a the thin loop: a local ticket reaches a pull request through the plan and evidence gates on Ark's own repo. M1 single repo, complete: setup, resume, the console, Jira and GitLab. M2 multi-repo. M3 review tiers, metrics and merge-request watch. M4 retention and audit outputs: closed runs shipped to write-once storage on Amazon Simple Storage Service (S3). M5 a remote procedure call (RPC) runner, built only if needed.

**Gates**:
Setup (one-time fit of Ark to a repo or project); AC clarity (only when a ticket lacks testable acceptance criteria); plan (before any code); escalation (round budget spent); evidence (loop exits clean, before MRs open). The PRD and the CLI still shorten them to `GS`, `G0`, `G1`, `GE` and `G2` until ARK-119 renames them.
