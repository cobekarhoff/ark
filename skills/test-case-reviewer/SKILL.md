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
4. **A contract class has no case and no reason.** A contract class of the writer skill applies to the ticket (an input that makes the changed value empty, missing or last; each exit code; the failure of each command, host or process the change calls; each way into the same view or command; each race `evaluation.md` names; multi-repo, base-only and cross-suite runs; a front matter key the reader does not know; the evidence and ownership files a command writes), and neither a case nor a line of reason in `test-design.md` covers it. Name the class and the AC. Also reject one case for each file where one case for the class would do, and a fake command's assertion that repeats a call shape instead of naming the flags and the scope it proves.

Also check the structure. Each case has an objective, preconditions, steps, expected results, a technique, a level, a priority, screenshot checkpoints and a risk. Each AC with `method: test` has at least one integration or E2E case in its `verified_by` links. Each affected existing case is marked `update`, `reuse` or `retire`.

## Pass 2: the diff (after the validator step, before the code review)

Read the diff and `plan.yml`. Reject the diff when:

1. **The plan misses a touched case.** The diff touches the code of a test case that `test_cases` in `plan.yml` does not name.
2. **An old id was not converted.** A touched test still has an old AC id in its title (the old `ARK-243-AC1` form). It must be converted: a test case is written and the title is renamed to the `<KEY>-T<n>` id.
3. **Junk test code.** The test code the diff adds or changes has one of these patterns. Quote the line as evidence.
   - no assertion
   - a self-comparison
   - an expected value that the code under test made
   - a copied inventory (an export list, a table of names copied from the source)
   - a source or wording grep
   - a call-shape assertion that repeats a boundary proof
   - a test-only export or seam (an export, flag, wrapper or hook with no production caller)
   - a mock that supplies the behaviour the test asserts
   - a fixture that fakes what the owner should produce (ordering, receipts, persistence)
   - a negative control that fails on another guard than the one it names
   - a name that the assertions do not exercise
4. **A test file over its time budget.** A new or changed test file has more than 30 s in the last `ark test` report, and no case names a contract that no cheaper level proves. Report each file over 5 s in the findings file, even when you do not reject it. `ark test` prints no time for a file; read it so:
   - `results/<suite>.report` in the run folder is JUnit with the time of each test case. The time of a file is the sum of its test cases.
   - `ark test-audit inventory --project <name> --json` prints the same time as `durationMs`, one row for each declaration. Join the rows to the changed files by file, and sum the rows of one file. `--project` is required. The command changes no file, so you may run it. It reads only suites with `parser: bun`; read the report of any other suite directly.
   - `durationMs` is null (`last` is `-`) when no report matches: a new file, or no `ark test` yet. Then you cannot judge the budget: write `time unknown` for the file in the findings file, and do not reject for time. Never guess a time.

### The retention bar

Never reject a test for being slow or static. A test of a public API, protocol, config, migration, storage, security, default, ordering or release contract stays. A test that fails on the baseline may be a product bug: report it, and never ask for it to be deleted.

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
