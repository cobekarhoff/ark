---
name: test-case-reviewer
description: Review the test cases of a run, and again the diff after the validator step. Use when the run lead starts the test case reviewer, or run /skill:test-case-reviewer on a set of test cases. It rejects cases with no real risk, duplicates and needless unit cases, and records a verdict in a findings file.
---

# Test case reviewer

Arguments: `<run>`, the run name.

Read [`skills/shared/rules.md`](../shared/rules.md) first, then [`skills/shared/engineering.md`](../shared/engineering.md), then [`skills/shared/worker-protocol.md`](../shared/worker-protocol.md). The repo's own `AGENTS.md` wins on the repo's conventions (commands, style, layout); `engineering.md` wins on evidence and process handling. Before you plan or write, read `$ARK_HOME/projects/<project>/learnings.md` (the project is the folder that holds your run folder) if it exists.

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

### First review and later review

"First review" and "later review" count the reviews of one case, in pass 1 and in pass 2, each counted on its own. They are not "Pass 1" and "Pass 2", and they are not the number in the file name. The rule below applies to every review of a case: in pass 1, and in pass 2 for a case file that the diff adds or changes.

A sentence of a case is each sentence in its objective, preconditions, steps, expected results, `risk` and `Expected:` EARS statement. The technique, level, priority and checkpoints are checked by the structure paragraph above.

- **First review of a case:** check every sentence of the case once against the rules above and list every false one in this review. Do not stop at the first finding.
- **Later review of the same case:** reject only for a sentence that the last change made false, or for a listed sentence that is still false, and only when that sentence names a wrong exit code, count, test title, file path or AC link. The last change is what changed after the latest earlier findings file of the same pass: in pass 1 what the writer changed, in pass 2 what the diff changed (its `Reviewed head:` line, when that file has one, names the commit). A sentence that the earlier review read and did not list is not a finding now.
- **Notes in a later review:** List every other false or too-wide sentence of a later review under `## Notes (P2)`. A note does not change the verdict. The writer fixes it before the validator starts, in the same pass as any rejection of that review. When the review approves, no further review follows. In pass 2 the case has no writer: the validator fixes the notes, in the same round as any rejection, or in one fix pass when the review approves, and no further review follows.
- **What a later review keeps:** Rules 1 to 4 of pass 1 and the structure checks still reject in a later review. A note listed in an earlier file never rejects in a later review, also when the sentence is still false.
- Find the earlier review in `findings/test-case-review-<n-1>.md` and the files before it, in the same run folder. They are the only record of which sentences were listed: a case of `test_case_source: zephyr` is a draft with no other record. A case is in its first review of a pass only when no earlier findings file of that pass exists in the run folder, or when it was added, or rewritten from scratch, after the latest such file. Every other case is in a later review, whether or not an earlier file names it: a case that an earlier review read and did not list passed that review. The fix pass of notes starts no review.

### A sentence about a command

A sentence about what a command shows (a negative control, a `-t` pattern, a grep count) is true or false by the output of the command. Check it by running the command once, in the same form as the sentence. Quote the command and its output in the finding or note.

- Run only the command of that sentence. A `bun test` command runs one test file (`bun test <file> -t <pattern>`), never the suite and never `--rerun-each` of a suite.
- The command edits no tracked file. Never stop a process by name (`pkill`, `killall`): stop only a process you started, by its PID.
- A sentence about a test that does not exist yet (the validator writes it later) cannot be run. The sentence must say the result is a plan. A sentence that states it as a shown output is false: list it.

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
   - `results/<suite>.report` in the run folder is JUnit with the time of each test case. The time of a file is the sum of its test cases. This is the source of the 5 s and 30 s budget: it is the run's own report.
   - A new or changed file with no matching test case in the report has no time: write `time unknown` for it in the findings file, and do not reject for time. Never guess a time.
   - `ark test-audit inventory` is not a source for this rule. It reads the `workspace` checkout of `ark.yml` and the newest report of any run of the project, so its `durationMs` may belong to another run or another commit. Use it only to audit the workspace, with `--project <name>` (required); it changes no file, and it reads only suites with `parser: bun`.

### The retention bar

Never reject a test for being slow or static. A test of a public API, protocol, config, migration, storage, security, default, ordering or release contract stays. A test that fails on the baseline may be a product bug: report it, and never ask for it to be deleted.

## Findings file

Each rejection names the case id (or the test file and title in pass 2), the rule it breaks and the evidence (the line or the existing case). Example:

```
- ARK-T21: no real risk (rule 1). Evidence: risk says "check the config", names no defect.
```

Each note, in a later review, is one list line under the heading `## Notes (P2)`: the case id (or the test file and title in pass 2), the false text copied verbatim as one span in double quotes, and what is false. It does not name a rule. The run lead greps the span in the case file to check the fix, so copy it character for character from one line of the case, never paraphrase or quote it from memory, and take a span that has no `"`, `$`, backtick or backslash (a `'` is fine). Example:

```
## Notes (P2)

- ARK-T7: "the negative control fails on the empty file" is false: `bun test test/x.test.ts -t 'empty'` prints 0 tests run. Fix the sentence; this does not change the verdict.
```

End the file with exactly one verdict line:

```
Verdict: approve
```

or

```
Verdict: reject
```

Approve nothing without a verdict line. One finding means `Verdict: reject`. A note under `## Notes (P2)` is not a finding: a review with only notes ends `Verdict: approve`. Report with `worker_done` and name the findings file in `--report-path`.
