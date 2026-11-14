---
id: ARK-T381
title: "ARK-T381 a validator step finish refuses for what the step owns and finishes for a pending manual answer, a later evidence file, a red bug test, and --failed"
level: integration
technique: decision table over finish case (malformed served file, malformed unserved file, bug-run first validator with the fix's string absent, second validator, pending manual answer, reviewer inspection not written, implementer step, --failed) with state transition of the step (running, finished)
priority: high
risk: "finish refuses for something that a later step or the human owns (the first validator of a bug run is blocked by the string the fix creates, a pending manual criterion or a reviewer file), so the run lead loops on the finish; or it lets a malformed demonstration file through, so the D12 refusal comes back at open; or a refusal still writes a step.finished event, or --failed is refused"
status: active
changed_by: 2026-11-13-ARK-405-1
---

## Objective

Prove `ark run step <run> <step> finish` for a validator step calls stage `step` for that step and refuses, unless the call is `--failed`, when the stage lists a problem about an AC that the step serves; and that it finishes in the cases the ticket names. The refusal does not extend to what a later step or the human owns: stage `step` for a served non-test AC may list `evidence missing` for reviewer-owned inspection evidence that is not written yet (a `val-2` that serves `AC3`), and the finish must still exit 0 (AC3 of the ticket: it never refuses for "reviewer-owned inspection evidence that is not written yet", a manual criterion with no answer, or evidence that a later step writes). A refusal writes no event.

## Preconditions

- Fixture of `test/finish-dirty-guard.test.ts` (`openRun`: a temp project, a ticket `ARK-900`, a plan written as `plan.yml` and recorded with an appended `plan.checked`, `plan approve`, a real worktree, a clean committed worktree, steps started with `ark run step`; with `plan.yml` holding only `steps`, a start launches no worker), changed to a plan of the steps below. A step is started before it is finished; only the steps a variant names are started. The ACs are written with `writeTicket` (`method` per AC, kind `bug` in variants C and D) and read as `ARK-900/AC1` to `ARK-900/AC4`. Each variant says which ACs the finishing step serves in its `criteria`; a step is never refused for an AC it does not serve. `fix` (implementer) serves `AC1` (and `AC4` in variant F).
- Plan: an implementer `fix`, a validator `val-2` that needs `fix`, and, in the bug variants C and D only, a validator `val-1` before `fix` that serves `AC1` to `AC4` (as `cli/plan-check.ts` requires of the first step of a bug run; the plan is recorded by an appended `plan.checked`, so plan check is not run).
- ACs: `AC1` (`test`) whose text holds `` `created-by-fix-405` `` that no tracked file holds until `fix` finishes; `AC2` (`demonstration`, manual); `AC3` (`inspection`, owned by the reviewer); `AC4` (`demonstration`).
- Shared files (written by the test in `results/evidence/` of the run folder, not in the worktree; variants C and D replace them with their own): `AC4.md` malformed (a non-empty `What the human did`, `Before` and `After` section, no `What the human saw` section); `AC2.md` well-formed with no last line `human: ok` and no manual answer recorded; `AC3.md` not written.
- Bug variants (C, D) need a red proof before `fix` may start (`step.started refused: bug run: record a failing ark test`, `cli/transitions.ts:112`): the test appends a `test.completed` event with `passed: false` and `criteria: { "ARK-900/AC1": "failing", "ARK-900/AC2": "manual pending", "ARK-900/AC3": "manual pending", "ARK-900/AC4": "manual pending" }` (every non-manual criterion failing, as `deriveState` reads it, `cli/events.ts:376`).
- The test counts lines of `events.ndjson` and compares `step.finished` events before and after each call.

## Steps

1. Variant A (malformed served file): `val-2` serves `AC4` only; the worktree is clean. Run `ark run step <run> val-2 finish`. Assert exit 1 and a line `evidence malformed: AC4: ...` that names `What the human saw`; assert `events.ndjson` has the same line count, the step state is still `running`, and no file changed.
2. In variant A run `... val-2 finish --failed`. Assert it finishes (exit 0, one `step.finished` event) even though the file is still malformed.
3. In a fresh variant A write a well-formed `AC4.md` (all four sections, a screenshot path under `Before` and `After`, no last line) in the run folder. The file is outside the worktree, so nothing is committed and the head does not move. Run finish without `--failed`. Assert exit 0 and one `step.finished` event.
4. Variant B (unserved problems): `val-2` serves `AC1` only, `AC4.md` is malformed, `AC1`'s string exists in a tracked file, and the title of the run is too long: the title is the `title` of the `run.started` event, so the test writes this variant's ticket itself before `ark run start` (`openRun` starts the run from a fixed title), with a long title as the fourth argument of `writeTicket` (`project, id, criteria, title, kind`; for example 70 characters, so `ARK-900: <title>` is over 72) and a `summary:` line of that length added to the frontmatter of the ticket file, which the run copies. With both the summary and the title over 72 characters `buildTitle` has no usable title, so stage `head` lists `ticket has no summary: pass --summary`. Assert finish exits 0 with one event: a problem of an AC the step does not serve, and a title problem, are not its refusal.
5. Variant C (bug run, first validator, own files): kind `bug`, `val-1` is the first step and serves `AC1` to `AC4`, runs before `fix`, the red proof above is recorded (the last `test.completed` has `passed: false`), and `` `created-by-fix-405` `` is in no tracked file. The files of this variant: `AC2.md` and `AC4.md` well-formed with no last line `human: ok`; `AC3.md` well-formed with a non-empty `Verdict` section that holds a sentence but no `reviewer:` line (so only the `reviewer:` line is missing, never an empty section). The only problem the stage could list for `val-1` is the AC string of `AC1`, because `fix`, the implementer step that makes it true, has not finished. Assert `ark run step <run> val-1 finish` exits 0 and writes one `step.finished` event. Repeat in a fresh copy with `--failed`: exit 0.
6. Variant D (the same bug run, variant C's files, after the first validator): `val-1` is finished (as in step 5); start and finish `fix` (an implementer step; the worktree is clean and the string is still absent); start `val-2`, which serves `AC1` only. Run `val-2` finish without `--failed`. Assert exit 1 and a line `AC string in no tracked file at head: ARK-900/AC1 ...` and no new event. (The AC string counts when every implementer step that serves the AC has finished.) Add a tracked file in the worktree that holds the string, commit, finish again: exit 0.
7. Variant E (pending, not due): the shared files; `val-2` serves `AC2` (manual, no answer, file without `human: ok`) and `AC3` (reviewer inspection, no file). Stage `step` for `val-2` may list `evidence missing: AC3 (inspection)`; the test does not assert that line either way. Assert finish exits 0 with one event.
8. Variant F (not a validator): the shared files, the string absent, `fix` serves `AC1` and `AC4`. Finish `fix` (role `implementer`). Assert exit 0: only the role `validator` runs the check.
9. Existing refusal order: in variant A with an uncommitted change in the worktree, assert the finish is refused for the dirty worktree with its old text (ARK-T332), not for the evidence.

## Expected results

- If stage `step` lists a problem about an AC that the finishing validator step serves, then `ark run step <run> <step> finish` shall refuse with the text of that line and shall write no event and no file.
- The system shall not refuse a validator finish for a manual criterion with no answer, an evidence file that a later step or the reviewer writes, a problem of an AC the step does not serve, or an AC string whose implementer step has not finished (the first validator of a bug run).
- When the call has `--failed`, the system shall not run the check and shall finish the step.
- The system shall not run the check for a step whose role is not `validator`.

## Screenshot checkpoints

none: integration case on CLI output, events and step state; no UI surface.
