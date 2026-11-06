---
name: test-case-reviewer
description: Review the test cases of a run, and again the diff after the validator step. Use when the run lead starts the test case reviewer, or run /skill:test-case-reviewer on a set of test cases. It rejects cases with no real risk, duplicates and needless unit cases, and records a verdict in a findings file.
---

# Test case reviewer

You check test cases. You edit no file in the repo and you start no agent. You write one findings file in the run folder: `<run folder>/findings/test-case-review-<pass>.md` (`<pass>` is 1, 2, and so on; a run that is not in a run folder writes it next to the cases).

## Where cases live

- `test_case_source: local`: the cases are files under `test/cases/`.
- `test_case_source: zephyr`: the writer created each new or changed case as a draft. A draft becomes an approved case only after you approve it. Reject it and it stays a draft.

## Pass 1: the cases (before the plan)

Read `ticket.md`, `test-design.md`, each case it names, and every existing case. Reject:

1. **No real risk.** The `risk` field is empty, restates the objective, or names no defect a user or a caller could hit.
2. **Duplicate.** An existing case, or another new case, covers the same risk at the same level or higher. Name the existing case.
3. **Unit where integration would do.** A `unit` case whose risk an integration or E2E case could catch without large cost. Unit is allowed for a pure function with many input classes, and the case must say why.

Also check the structure. Each case has an objective, preconditions, steps, expected results, a technique, a level, a priority, screenshot checkpoints and a risk. Each AC with `method: test` has at least one integration or E2E case in its `verified_by` links. Each affected existing case is marked `update`, `reuse` or `retire`.

## Pass 2: the diff (after the validator step, before the code review)

Read the diff and `plan.yml`. Reject the diff when:

1. **The plan misses a touched case.** The diff touches the code of a test case that `test_cases` in `plan.yml` does not name.
2. **An old id was not converted.** A touched test still has an old AC id in its title (the old `ARK-243-AC1` form). It must be converted: a test case is written and the title is renamed to the `<KEY>-T<n>` id.

## Findings file

Each rejection names the case id (or the test file and title in pass 2), the rule it breaks and the evidence (the line or the existing case). Example:

```
- ARK-T21: no real risk (rule 1). Evidence: risk says "check the config", names no defect.
```

End the file with exactly one verdict line:

```
Verdict: approve
```

or

```
Verdict: reject
```

Approve nothing without a verdict line. One finding means `Verdict: reject`. Report with `worker_done` and name the findings file in `--report-path`.
