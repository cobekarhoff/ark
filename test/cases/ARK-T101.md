---
id: ARK-T101
title: ARK-T101 invalid YAML in plan.yml, ark.yml or a test case file names the file and the quoting hint
level: integration
technique: error guessing on an equivalence class of YAML syntax errors
priority: medium
risk: "An agent gets a bare YAML parse error and spends many bash calls finding an unquoted ': ' value"
status: active
changed_by: 2026-11-07-ARK-334-1
---

## Objective

Prove that each of the three YAML readers refuses an unquoted `: ` value with an error that names the offending file and gives one hint: a value that contains `: ` or starts with a backtick needs quotes. The readers are the plan.yml loader (`ark plan check`), the ark.yml loader (`loadConfig`) and the test case file reader (`readCaseEntries`, also reached by `ark plan check` through the workspace's `test/cases`).

Expected: When plan.yml, ark.yml or a test case file is not valid YAML, the error shall name the file and give the quoting hint.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.
- An isolated temp `ARK_HOME` per scenario, so no real project is touched.
- Scenario A: a run folder with a plan.yml whose criteria text is `key: a: b`, and an event log with its line count noted.
- Scenario B: a project folder whose ark.yml has a value `command: bun test: all`.
- Scenario C: a test case file with front matter `risk: a: b`.

## Steps

1. Given scenario A, when `ark plan check <run>` runs, capture exit code, stderr and the event log.
2. Given scenario B, when a command that loads the project's ark.yml runs (for example `ark test <run>`), capture exit code and stderr.
3. Given scenario C, when `readCaseEntries(<repo root>)` from `cli/test-case.ts` loads the file (a test calls it directly; `ark plan check <run>` on a valid plan in that workspace also reaches it and prints the problem on stdout), capture the returned `problems`. There is no `ark test-case check` command: do not use it.
4. Fix each file to quote the value (`"a: b"`) and repeat the command; capture the result.

## Expected results

- Steps 1 and 2 exit 1 with an error that names the file (`plan.yml`, `ark.yml`) and says it is not valid YAML. Step 3 returns a problem that names the case file path and says its frontmatter is not valid YAML; no entry is returned for that file.
- Each error carries the same single hint: a value that contains `: ` or starts with a backtick needs quotes.
- Step 1 leaves the event log unchanged (the plan.yml read fails before `plan.checked` is appended).
- After step 4 the quoted file is accepted: the error does not appear.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
