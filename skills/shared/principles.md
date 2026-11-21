# Ark principles

One line for each principle that Ark already uses, with a link to the rule that holds it. This page adds no rule: a line that disagrees with its link is wrong, and the link wins. Workers read this page, and a reviewer names the principle in a finding.

## Proof

- An AC is proven by the test cases in its `verified_by`, passing at head. Any level can be a test case, but each `method: test` AC needs an integration or E2E one. [ADR 0010](../../docs/adr/0010-test-cases-describe-the-product.md)
- A test with an old AC id in its title converts when a run touches it: a test case, a renamed title, a plan entry. [Reviewer rubric: Proof](../ark-reviewer/rubrics/reviewer.md#what-to-check)
- A criterion with a method other than `test` (or `manual: true`) is proven by the human's `manual` gate answer and its evidence file `results/evidence/<AC id>.md`, not by a test. [Reviewer rubric: Proof](../ark-reviewer/rubrics/reviewer.md#what-to-check)
- A test asserts observable behavior and fails for a credible regression. [Test authoring gate](../../rules/test-audit.md#test-authoring-gate)
- One contract has one owning test, at the strongest practical boundary. [Test authoring gate](../../rules/test-audit.md#test-authoring-gate)
- Never mock the thing a test proves, and never take the expected value from the code under test. [Test authoring gate](../../rules/test-audit.md#test-authoring-gate)
- Add no export, flag or hook that only a test calls: test at the real boundary. [Test authoring gate](../../rules/test-audit.md#test-authoring-gate)
- Log each fixed test failure as a caught regression or a change detector; delete a change detector, and never delete a test of authorization, privacy, migrations or concurrency. [Engineering: Tests](engineering.md#tests)
- Checks only grow: a change never removes or loosens a lint rule, a required check, or a test of authorization, privacy, migrations or concurrency to pass. [Engineering: Checks and CI](engineering.md#checks-and-ci)
- A step that a tool can enforce goes into a hook that runs the same command as CI, not into a line of `AGENTS.md`. [Engineering: Checks and CI](engineering.md#checks-and-ci)
- A changed-tests selection lists the inputs that force a full run, and a test shows that it fails when a real change is hidden from it. [Engineering: Checks and CI](engineering.md#checks-and-ci)
- Before a tool switch, run the old and the new tool side by side, list what the new tool misses, and give before and after numbers for a speed change. [Engineering: Checks and CI](engineering.md#checks-and-ci)
- Split a slow pipeline's time into waiting, setup and running at p50 and p95, and fix the largest part first. [Engineering: Checks and CI](engineering.md#checks-and-ci)

## Code

- Do what the ACs need and no more: no abstraction with one user, no option nobody sets, no dead code. [Reviewer rubric: Complexity](../ark-reviewer/rubrics/reviewer.md#what-to-check)
- Read the callers of changed code, not only the diff. [Reviewer rubric: Correctness](../ark-reviewer/rubrics/reviewer.md#what-to-check)
- Check input at trust boundaries; keep secrets out of code and logs. [Reviewer rubric: Security](../ark-reviewer/rubrics/reviewer.md#what-to-check)
- Use full words for identifiers, commands, flags, gate names and filenames. [Naming gate](../../rules/naming.md#naming-gate)
- Keep each set of states, and the moves between them, in one typed list and one table or function; a refusal names the state and what allows the action. [State machine gate](../../rules/state-machines.md#state-machine-gate)

## Review

- Report each problem once, where it matters most, and never without evidence. [Reviewer rubric: How to report](../ark-reviewer/rubrics/reviewer.md#how-to-report)
- Rank a finding P0 to P3 by what it breaks. [Reviewer rubric: How to report](../ark-reviewer/rubrics/reviewer.md#how-to-report)

## Design

- The plan and its test cases come before code, and the run lead judges each finding. [Architecture: The plan and the proof](../../docs/explanation/architecture.md#the-plan-and-the-proof)
- Repos compose locally in the run's worktrees, one worktree for each repo. [Architecture: Multi-repo by local composition](../../docs/explanation/architecture.md#multi-repo-by-local-composition)
- The hub only reads. Its actions are "Open in Orca" and the three writes of the Companions page (approve a proposed ticket to `ready`, dismiss, ask), and you steer through Master Chief. [ADR 0009](../../docs/adr/0009-hub-is-a-read-only-live-view.md#hub-is-a-read-only-live-view)
