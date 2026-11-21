# Ark engineering principles

How to test, keep checks and CI strong, wait, handle processes and prove a claim, for any repo Ark works in. Every worker role and the run lead read this page after [`rules.md`](rules.md). The repo's own `AGENTS.md` wins on the repo's conventions (commands, style, layout). This page wins on evidence and process handling. A command in this page is never named: use the one that the repo's `AGENTS.md` gives.

## Tests

- A test earns its keep: it fails for a credible regression, and no other test already owns that contract. Prefer integration and E2E tests at the real boundary: a unit test of a pure function is the cheap exception. [Test authoring gate](../../rules/test-audit.md#test-authoring-gate), [Principles: Proof](principles.md#proof)
- Wait on an event with a limit, never for a fixed time. A fixed sleep is too short on a loaded host and too long on an idle one, and it hides the event that the test needs.
- A limit that a test must shorten (a timeout, an interval) is set by an environment variable that the code reads, so the test sets a short limit and production keeps its own.
- Prove a race fix with a real load run: repeat the test in parallel, next to the suite. To show the bug before the fix, add an opt-in delay that only the call under test gets, so the test fails every time without the fix. A delay in a shared fake lands on every caller, and on whichever call runs first, so keep it out of the fake. Repeat the proof as separate test processes, because one process keeps module state between repeats.
- While you iterate, run the tests that the change affects. Before the MR, run the full suite once.
- Report a flaky test, with its name and how it failed. Never rerun until green and call that proof. A retry that the test tool does itself is the tool's report of a flaky test, not your proof.
- Log each test failure you fix as a caught regression or a change detector. A caught regression failed because the product was wrong: keep the test. A change detector failed only because the code changed and the behavior did not: delete it, and name its pattern in the repo's `AGENTS.md` so that nobody writes it again. Never delete a test of authorization, privacy, migrations or concurrency. The log shows which tests earn their keep.

## Checks and CI

- Checks only grow. A change never removes or loosens a lint rule, a required check, or a test of authorization, privacy, migrations or concurrency to pass. A check that is removed to make a change pass hides the fault that it found.
- Put a step that a tool can enforce into a pre-commit or pre-push hook that runs the same command as CI. Do not put it into a line of `AGENTS.md`: agents skip written steps, and a hook does not.
- A changed-tests selection (for example, the command that a test runner takes to list the tests that a change reaches) lists the inputs that force a full run. A test shows that the selection fails when a real change is hidden from it on purpose. A selection that nobody proved can skip the test that would fail.
- Before a tool switch, run the old and the new tool side by side. List what the new tool misses. For a speed change, give before and after numbers from real runs, because a number from one run or one machine does not show the change.
- Before you speed up a slow pipeline, split its time into waiting, setup and running, at p50 and p95. Fix the largest part first, because the other parts do not change the total much.

## Processes

- Stop only a process you started, by its PID, and stop it before your step ends: a leaked loop keeps running after the worker is gone. The rule is in [`rules.md`](rules.md).
- Keep state out of long-lived processes. A process that holds state in memory loses it on a restart or a crash: write what must survive to a file or a store, and read it again when the process starts.

## Evidence

- A claim that CI passes is proved by the CI runs of the MR's own head commit. A run of an earlier commit, of the base branch or of your machine is not that proof.
