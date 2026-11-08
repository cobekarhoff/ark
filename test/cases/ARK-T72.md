---
id: ARK-T72
title: ARK-T72 run_evals lints the frozen bodies of PR #121, #117 and #109 offline and prints failure rates and the rubric
level: integration
technique: equivalence classes (one fixture per replay body) with a no-network constraint; cross-check of aggregate against per-body lint
priority: medium
risk: the eval calls gh or the network so it breaks offline or drifts when a PR is edited, a fixture is missing or edited, the failure rate is computed over the wrong count, or the rubric is not printed so no grader sees the six questions
status: active
changed_by: 2026-11-07-ARK-317-1
---

## Objective

Prove `skills/pr-writing/evals/run_evals.ts` runs the lint on the three frozen replay bodies with no network, prints a per-check failure rate, and prints the reviewer rubric. Serves ARK-317/AC6.

Expected: When it runs, `run_evals.ts` shall lint the bodies of #121, #117 and #109 from fixture files, call no network command, and print the rubric.

## Preconditions

- Fixture files for PR #121, #117 and #109 under `skills/pr-writing/evals/` (bodies frozen), a rubric file there, and `run_evals.ts`.
- A `PATH` with fake `gh`, `glab` and `curl` that record any call and exit 1, plus no network access needed.
- A hash of each fixture file taken before the run.
- The lint of ARK-316 callable on one body with the evals ledger (for the cross-check).

## Steps

1. Run `bun skills/pr-writing/evals/run_evals.ts` with the fake host tools on `PATH`. Capture exit code, stdout, stderr.
2. Read the fake call log.
3. Count the fixtures the output names. Read the failure rate of each lint check id.
4. Lint each of the three bodies directly with the ARK-316 lint. Count the `fail` result of each check id.
5. Find the rubric in the output.
6. Hash the fixtures again.
7. Run `bun test test/pr-writing-skill.test.ts`.

## Expected results

- Exit 0 even when a body fails lint (the eval measures; it is not a gate). stdout holds the per-check result as one JSON document; prose is on stderr.
- The fake call log is empty: no `gh`, `glab` or `curl` call.
- The output names exactly three bodies: #121, #117, #109. Every check reports `failed`, `total` 3 and a `rate` equal to `failed / 3` (0, 1/3, 2/3 or 1).
- The rates equal the counts from Step 4 for every check id.
- The output holds the rubric of six items: problem first, nothing restated, what is not done, risk and revert, runnable validation, numbers with bounds.
- The fixture hashes are unchanged.
- `bun test test/pr-writing-skill.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output; no screenshot applies.
