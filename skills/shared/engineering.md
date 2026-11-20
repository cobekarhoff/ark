# Ark engineering principles

How to test, wait, handle processes and prove a claim, for any repo Ark works in. Every worker role and the run lead read this page after [`rules.md`](rules.md). The repo's own `AGENTS.md` wins on the repo's conventions (commands, style, layout). This page wins on evidence and process handling. A command in this page is never named: use the one that the repo's `AGENTS.md` gives.

## Tests

- A test earns its keep: it fails for a credible regression, and no other test already owns that contract. Prefer integration and E2E tests at the real boundary: a unit test of a pure function is the cheap exception. [Test authoring gate](../../rules/test-audit.md#test-authoring-gate), [Principles: Proof](principles.md#proof)
- Wait on an event with a limit, never for a fixed time. A fixed sleep is too short on a loaded host and too long on an idle one, and it hides the event that the test needs.
- A limit that a test must shorten (a timeout, an interval) is set by an environment variable that the code reads, so the test sets a short limit and production keeps its own.
- Prove a race fix with a real load run: repeat the test in parallel, next to the suite. A delay injected into a shared fake lands on whichever call runs first, so the test then fails only part of the time.
- While you iterate, run the tests that the change affects. Before the MR, run the full suite once.
- Report a flaky test, with its name and how it failed. Never rerun until green and call that proof. A retry that the test tool does itself is the tool's report of a flaky test, not your proof.

## Processes

- Stop only a process you started, by its PID, and stop it before your step ends: a leaked loop keeps running after the worker is gone. The rule is in [`rules.md`](rules.md).
- Keep state out of long-lived processes. A process that holds state in memory loses it on a restart or a crash: write what must survive to a file or a store, and read it again when the process starts.

## Evidence

- A claim that CI passes is proved by the CI runs of the MR's own head commit. A run of an earlier commit, of the base branch or of your machine is not that proof.
