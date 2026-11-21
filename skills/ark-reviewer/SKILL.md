---
name: ark-reviewer
description: Review the run's diff and write the findings file of one plan step. Use when the run lead starts a reviewer step with /skill:ark-reviewer <run> <step>; it edits nothing in the repo.
---

# Ark reviewer

Arguments: `<run> <step>`.

Read [`skills/shared/rules.md`](../shared/rules.md) first, then [`skills/shared/engineering.md`](../shared/engineering.md), then [`skills/shared/worker-protocol.md`](../shared/worker-protocol.md). The repo's own `AGENTS.md` wins on the repo's conventions (commands, style, layout); `engineering.md` wins on evidence and process handling. Before you plan or write, read `$ARK_HOME/projects/<project>/learnings.md` (the project is the folder that holds your run folder) if it exists.

You look for defects in the run's changes and report findings. You never edit.

1. Read the diff of the branch against its base: `git diff $(git merge-base HEAD <base>)..HEAD`. The base is in the `worktree.created` event in `<run folder>/events.ndjson`.
2. Check the diff against each AC the step serves, against the plan, and against the repo's conventions. Judge the AC text in the run's `ticket.md`: a human-approved amendment, listed in the Amended criteria section of `plan.md`, replaces the backlog text. Look for wrong behavior, missing edge cases, security problems, broken contracts between repos, and tests that do not prove what their name says. If the step has a `skills` list in `plan.yml`, read each skill with `skill://<name>` and check the diff against every skill in it. Rank what they find like any other finding.
   - If the spec has a `Rules:` block, check the diff against each rule line in it. A diff that breaks a rule is a finding in the usual form (File, Line and Input of the changed line that breaks it), with `Area` correctness, and its title and Evidence quote the rule. See [`rubrics/reviewer.md`](rubrics/reviewer.md), item 7.
3. Run read-only checks to reproduce what you suspect: read the code, run the tests, run a command. Do not change any file in the worktree. Do not commit, stash, reset or checkout. Read [`skills/shared/principles.md`](../shared/principles.md) in the Ark repo and name the principle a finding breaks, when one applies.
   - Check the code that uses the changed code, including callers and consumers outside the diff. Name the one fact that makes the change safe. Run the real code to check that fact when you can do it without a change to a file. Report the risks you confirmed and the checks that cleared the other risks. The read-only rules of this step still apply.
   - When the plan has no test case (`test_cases: []`), run only the read-only checks: each `checks` entry of the project's `ark.yml` (`$ARK_HOME/projects/<project>/ark.yml`) whose `repo` is the step's repo (an entry is read-only by contract), and each command that the repo's `AGENTS.md` names and that writes no file (skip a formatter, a fix mode and the test suite), then `ark test <run> --quick`. Leave the full suite to the final `ark test <run>` of the run lead. `ark test` runs the project's checks in the worktree, then its suites unless a check failed: a failed check stops it with no suite, and your findings name the failed check. When `git status --short` shows a changed file after it, say so in your findings and change nothing. If `--quick` refuses because a full run is alive (it names `--wait` and `--stop`), do not wait for it, stop it or start another: say so in your findings file.
4. Write the findings to `<run folder>/findings/<step>.md`. It is the only file you create. Rank each finding from P0 (must fix) to P3 (minor):

   | Rank | Meaning                                                       |
   | ---- | ------------------------------------------------------------- |
   | P0   | Must fix. An AC fails, data is lost, or the change is unsafe. |
   | P1   | Should fix before merge. A real defect with a clear impact.   |
   | P2   | Worth fixing. A weakness that is not urgent.                  |
   | P3   | Minor. Style or small cleanup.                                |

   Write each finding in this form:

   ```markdown
   ### P1: <one-line title>

   - **File:** `path/from/repo/root.ts`
   - **Line:** 42
   - **Input:** <the concrete input, state or call that makes the defect happen>
   - **Criterion:** <the AC id the defect threatens, or none>
   - **Repro:** <command, P0 and P1 only>
   - **Evidence:** <the code you read, or the command you ran and its output>
   - **Problem:** <what is wrong and what it breaks>
   - **Suggested fix:** <the direction, not a patch>
   ```

   Every finding, P0 to P3, has a line `- **Input:** <the concrete input, state or call that makes the defect happen>` and a line `- **Criterion:** <the AC id the defect threatens, or none>`. Use `none` when the defect threatens no single AC. For a design finding (an abstraction with one user), the Input is the `grep` that shows it. Keep each line of the form a single-line bullet: never put a `#` heading inside a value. The run lead drops a finding with no File, no Line or no Input.

   A P0 or P1 finding has a line `- **Repro:** <command>` on top of its Input, and its Evidence quotes the output that shows the problem. For a design finding the Repro is the same `grep`. A P0 or P1 without a Repro is written as P2: keep the heading `### P2` and drop the Repro line. A P2 or P3 needs no Repro.

   A finding from a skill in the `skills` list of your step also has the lines `- **Skill:** <skill>` and `- **Rule:** <name of the rule or guideline>`, after `**Line:**`.

   A finding without a file, a line and evidence is not a finding. Do not pad the list. If you find nothing, write `No findings.` in the file.

   Start the file with `Reviewed head: <sha>`. A review reads only `git diff <last reviewed head>..HEAD` (the spec names the head: the previous review's, or for the first review the run's base; `ark run step ... finish` refuses a succeeded review whose range holds no commit), does not report a finding that an earlier findings file of the run already holds, and names the class of a bug so that one fix covers every instance. Add the `## Merge risk` block and end with the `Verdict:` line, as in [`rubrics/reviewer.md`](rubrics/reviewer.md).

   Every changed file outside `test/` and `docs/` that no `where` of `plan.yml` lists needs a line `- Not in plan: <path> — <reason>` in the first `## Merge risk` block of your findings file `findings/<step>.md`. `ark run step ... finish` refuses the review without it, and the run lead sends you back to write the line.

5. Do not decide what sends work back. The run lead decides.
