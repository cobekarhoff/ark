# Ark

A generic, harness-agnostic software factory, shipped as an installable plugin stack (skills, role agents, commands per harness) over one core that spawns the local service and dashboard. It takes a ticket to merge-ready, evidence-backed change requests across a product's repos. Ark knows nothing about any specific product; products plug in through their agentic environment.

## Language

### Products

**Agentic environment**:
The per-product repo that holds that product's ark configuration, its knowledge base, and clones of its product repos. Example: `<product>-agentic-environment`.
_Avoid_: Project home, workspace, env repo

### Risk

**Risk rules**:
An agentic environment's deterministic decision table that maps a change (paths, requirement IDs, labels) to a risk class. Changing the rules is itself high-risk.
_Avoid_: Risk model, classifier, risk policy

**Risk class**:
A ticket's regulatory risk level (`standard` or `high-risk`) produced by the risk rules. Humans and agents may raise it, never lower it; re-classification on the real diff takes the higher value.
_Avoid_: Risk level, severity, risk score

**QMS gate**:
The human gate that only fires for high-risk tickets, where traceability evidence is approved before the merge request opens.
_Avoid_: Compliance gate, Gate 5

### Skills

**Core skill**:
An `ark-*` skill shipped by ark, with exactly one maintenance-owning role and explicitly declared consuming roles. Its content and contracts are versioned in ark.
_Avoid_: fx skill, factory skill, base skill

**Add-on skill**:
A product-specific skill that lives in an agentic environment and is attached to an ark role by that environment's role manifest. It never controls flow.
_Avoid_: Plugin, extension, custom skill

### Acceptance

**Acceptance Author**:
The planning-stage role that turns a ticket's intended behavior into executable acceptance checks and records their test-value answers before human approval. It is separate from the Planner, Builder, and QE.
_Avoid_: Test designer, acceptance agent, test writer

**Acceptance check**:
Executable test code that proves one approved behavior. It is locked at plan approval; changing it requires a new human approval.
_Avoid_: Test case, acceptance criteria, verify step

**Evidence bundle**:
The checksummed record of one clean verification run for exact source heads: commands, exit codes, outputs, HTTP exchanges, queries, traces, and the environment used.
_Avoid_: Proof, artifacts, test report

**Repair cap**:
The ticket-wide limit on failed rounds (accepted review blockers, confirmed QE defects, accepted Arbiter blockers) before a human must decide.
_Avoid_: Loop cap, retry limit

### Review

**Arbiter**:
The separate CI/CD code-review product that reviews published MRs. It is not ark's local review role.
_Avoid_: Local Reviewer, local review agent

**Finding**:
One reported issue against a change, produced by local review or Arbiter. Its disposition determines whether it requires repair.
_Avoid_: Comment, issue, review note

**Local Reviewer**:
A fresh read-only review agent that evaluates the exact change and approved intent using ark's shared review rubric. Reviewers may use the same or different models according to engineer configuration.
_Avoid_: Arbiter, CI reviewer

**Review Lead**:
The local review role that assesses and deduplicates reviewer findings, preserves disagreements, and identifies accepted blockers. It never repairs source code.
_Avoid_: Aggregator, Arbiter
