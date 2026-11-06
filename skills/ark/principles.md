# Ark principles

One line for each principle that Ark already uses, with a link to the rule that holds it. This page adds no rule: a line that disagrees with its link is wrong, and the link wins. Workers read this page, and a reviewer names the principle in a finding.

## Proof

- An AC is proven by the test cases in its `verified_by`, passing at head. Any level can be a test case, but each `method: test` AC needs an integration or E2E one. [ADR 0010](../../docs/adr/0010-test-cases-describe-the-product.md)
- A test with an old AC id in its title converts when a run touches it: a test case, a renamed title, a plan entry. [Reviewer rubric: Proof](rubrics/reviewer.md#what-to-check)
- A criterion with a method other than `test` (or `manual: true`) is proven by the human's `manual` gate answer and its evidence file `results/evidence/<AC id>.md`, not by a test. [Reviewer rubric: Proof](rubrics/reviewer.md#what-to-check)
- A test asserts observable behavior and fails for a credible regression. [Test authoring gate](../../rules/test-audit.md#test-authoring-gate)
- One contract has one owning test, at the strongest practical boundary. [Test authoring gate](../../rules/test-audit.md#test-authoring-gate)
- Never mock the thing a test proves, and never take the expected value from the code under test. [Test authoring gate](../../rules/test-audit.md#test-authoring-gate)
- Add no export, flag or hook that only a test calls: test at the real boundary. [Test authoring gate](../../rules/test-audit.md#test-authoring-gate)

## Code

- Do what the ACs need and no more: no abstraction with one user, no option nobody sets, no dead code. [Reviewer rubric: Complexity](rubrics/reviewer.md#what-to-check)
- Read the callers of changed code, not only the diff. [Reviewer rubric: Correctness](rubrics/reviewer.md#what-to-check)
- Check input at trust boundaries; keep secrets out of code and logs. [Reviewer rubric: Security](rubrics/reviewer.md#what-to-check)
- Use full words for identifiers, commands, flags, gate names and filenames. [Naming gate](../../rules/naming.md#naming-gate)

## Review

- Report each problem once, where it matters most, and never without evidence. [Reviewer rubric: How to report](rubrics/reviewer.md#how-to-report)
- Rank a finding P0 to P3 by what it breaks. [Reviewer rubric: How to report](rubrics/reviewer.md#how-to-report)

## Design

- The plan and its test cases come before code, and the run lead judges each finding. [Architecture: The plan and the proof](../../docs/explanation/architecture.md#the-plan-and-the-proof)
- Repos compose locally in the run's worktrees, one worktree for each repo. [Architecture: Multi-repo by local composition](../../docs/explanation/architecture.md#multi-repo-by-local-composition)
- The hub only reads: it steers through Master Chief, and never writes run state. [ADR 0009](../../docs/adr/0009-hub-is-a-read-only-live-view.md#hub-is-a-read-only-live-view)
