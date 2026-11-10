---
id: ARK-T214
title: ARK-T214 The worker spec of `ark run step <run> <step> start` names the role and step and holds the evaluation risks, the applied learnings, the backticked AC strings and the rules file verbatim
level: integration
technique: equivalence classes (list present, `none (…)` line, no backticks, no rules file) with a fixture per class
priority: high
risk: the run lead has to copy risks, learnings and AC strings by hand and forgets one; the `Risks` or `# Learnings applied` parser drops a line, joins two, or treats `none (…)` as a learning; a backtick-free AC injects text; the AC strings of a step the spec does not serve leak in; a missing rules file fails the start
status: active
changed_by: 2026-11-10-ARK-359-1
---

## Objective

Prove that the spec the fake dispatched worker receives names the role and the step id in words, and holds verbatim the `Risks` list of `evaluation.md`, each line of `# Learnings applied` of `plan.yml`, each backticked string of the ACs that the step serves, and the rules of the rules file when the run has one.

## Preconditions

- A fake `orca` executable on `PATH` (a script over `$FAKE_ORCA_DIR/state.json` that logs every call to `calls.log`), as `test/run.test.ts` does. No real Orca, no real `ark test`, no `omp`, no test-runner. A `worker-start` call from the fake creates a terminal record and writes nothing else.
- A fake session folder in `ARK_OMP_SESSIONS` (a scratch folder under the host temp folder) that the fake Orca fills on demand with one session file for the worktree cwd.
- A scratch `ARK_HOME` with a run folder, `ticket.md`, `evaluation.md`, `plan.yml` and a git worktree. Every child process the case starts is killed in teardown, and the scratch folders are removed.
- An implementer step `<step>` serving AC1 only; the ticket has AC1 with two backticked strings, AC2 with one backticked string (not served) and one AC with no backticks.
- `evaluation.md` has `## Risks` with three bullets (one with backticks and a colon). `plan.yml` has a top comment `# Learnings applied` with two lines and a variant fixture whose line reads `none (no learning fits)`.
- Case A: no rules file. Case B: a rules file fixture at the path the ticket picks, with two rules.
- The fake Orca stores the spec text it received from `worker-start`.

## Steps

1. Run `ark run step <run> <step> start` with the fixtures of case A. Read the spec the fake Orca received.
2. Run it with the `none (…)` learnings fixture on a second step.
3. Run it with the rules file of case B.
4. Compare each required line of the fixtures to the spec text.

## Expected results

- The spec shall name the role (`implementer`) and the step id in words.
- The spec shall hold the three `Risks` lines, each one verbatim and in order.
- The spec shall hold each line of `# Learnings applied` verbatim; the `none (…)` line shall be held as that line, not parsed away.
- The spec shall hold both backticked strings of AC1, and shall not hold the backticked string of AC2 or text of the AC with no backticks.
- Case A: the start shall succeed with no rules file and the spec shall hold no rules section. Case B: the spec shall hold both rules verbatim.

## Screenshot checkpoints

none: integration case on CLI output, run events and the fake Orca call log; there is no UI.
