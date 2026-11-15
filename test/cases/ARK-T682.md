---
id: ARK-T682
title: ARK-T682 the spec that `ark run step <run> <step> start` writes for a validator step holds the host-safety rules, and the spec of an implementer or reviewer step holds none of them
level: integration
technique: equivalence classes (validator step, validator step with a rules file, validator start after an interrupt, implementer step, reviewer step) with one fixture per class
priority: high
risk: a validator starts without the rules and runs a bare `bun test` or `pkill -f 'bun test'`, which kills the test children of every other run on the host (the ARK-496 defect); the rules reach the spec of an implementer or of a reviewer step (a block guarded by `role !== "implementer"` would reach every reviewer spec; `ARK-T214` pins no `Rules` only for an implementer step); a validator block replaces or is replaced by the `rules.md` text of the run when both exist; the block is lost on the start that takes over from a dead worker
status: active
changed_by: 2026-11-14-ARK-508-1
---

## Objective

Prove that the spec the fake dispatched worker receives from `ark run step <run> <step> start` for a validator step holds four rules, and that neither the implementer nor the reviewer gets them: never run a bare `bun test`, never kill by name (`pkill`, `killall`), stop only a PID the validator started, and prove an analysis AC that names `bun test` with the `cli` suite command of `ark.yml` (with its `<cores>` and `{report}` placeholders filled in, not a bare `bun test` and not `bun run test`). The case reads the spec the fake Orca received through `worker-start`, not the output of `buildSpec` called directly (`ARK-T214` owns the spec of an implementer step, `ARK-T409` reads lines 0 and 1 of a validator spec, `ARK-T302` reads the `Last reviewed head` line of a reviewer spec; none starts a validator and reads its rules).

Serves ARK-508/AC3.

Expected: When `ark run step <run> <step> start` starts a validator step, the system shall put the validator rules in the spec the worker receives, beside the `rules.md` text of the run when the run has one, and shall put them in the spec of no implementer or reviewer step.

## Preconditions

- The fixtures of `test/worker-start.test.ts` (`ARK-T210` to `ARK-T216`): a fake `orca` executable on `PATH` that logs every call and stores the spec text of each `worker-start` call; a fake session folder in `ARK_OMP_SESSIONS`; a scratch `ARK_HOME` with a run folder, `ticket.md`, `evaluation.md`, `plan.yml` and a git worktree; the test clock in `ARK_NOW`. No real Orca, no real `ark test`, no `omp` and no test runner start. Every child process the case starts is killed in teardown by its PID (never by name), and the scratch folders are removed.
- A plan with one validator step `v`, one implementer step and one reviewer step, each serving an AC of the ticket. The harness and model of each step are a pair that `roles` of the scratch `ark.yml` allows (the fixture `ark.yml` has `roles.reviewer`).
- Class 1: no `rules.md` in the run folder. Class 2: a `rules.md` with two rules, as `ARK-T214` case B has. Class 3: the validator step `v` started once, its worker gone from the fake Orca, the step marked `interrupted`, then started again (the harness has no restore command, so the second start is a fresh worker with the interrupt brief). Class 4: the implementer step and the reviewer step each started with the same fixtures as class 2. A validator has no `--merge` start: `cli/transitions.ts:126-129` refuses it, and `ARK-211-AC1` in `test/sync.test.ts` owns that refusal, so this case has no merge class.

## Steps

1. Class 1: run `ark run step <run> v start`. Read the spec the fake Orca received (`orca.workers().at(-1)`).
2. Class 2: add the `rules.md`, run `ark run step <run> v start` on a fresh run, and read the spec.
3. Class 3: start `v`, make its worker disappear from the fake Orca, run `ark run step <run> v interrupted`, run `ark run step <run> v start` again, and read the spec of the second `worker-start` call.
4. Class 4: run `ark run step <run> <implementer step> start` and `ark run step <run> <reviewer step> start` with the `rules.md` of step 2, and read each spec.

## Expected results

- Each `start` exits 0. The spec read is the one of the `worker-start` call that this start made.
- Class 1: the spec states, in words, that the validator never runs a bare `bun test`, never kills a process by name (it names both `pkill` and `killall`), stops only a process it started and only by its PID, and proves an analysis AC that names `bun test` with the `cli` suite command of `ark.yml` and says to fill in its `<cores>` and `{report}` placeholders. The spec still holds the first line `/skill:ark-validator <run> v` and the role sentence.
- Class 2: the spec holds the four validator rules and both `rules.md` lines, each line verbatim, and neither text replaces the other.
- Class 3: the spec of the second start holds the four validator rules and the interrupt brief.
- Class 4: the implementer spec and the reviewer spec each hold both `rules.md` lines and none of the four validator rules (no `pkill`, no `killall`, no `PID`, no `cli` suite instruction).

## Screenshot checkpoints

none: integration case on CLI output and the fake Orca call log; there is no UI.

## Authoring gate

1. Protects the contract of the spec text a validator worker starts from: the four host-safety rules reach the validator, and only the validator.
2. A change that drops the block, builds it for the wrong role (or for every role but the implementer), builds it only when `rules.md` is absent (or only when it is present), or builds it on the fresh path but not the takeover path makes it fail.
3. `ARK-T214` proves the spec content of an implementer step and asserts no `Rules` text for it; `ARK-T409` builds a validator spec through `buildSpec` and reads only its first lines; `ARK-T302` builds a reviewer spec and reads only its `Last reviewed head` line. No case starts a validator through `ark run step ... start` (fresh or after an interrupt) and reads the rules the worker received, and nothing pins a reviewer spec free of them. This case owns the validator rules; it adds no second copy of `ARK-T214` and does not repeat the `worker-start` call count of `ARK-T210`.
4. No test-only export, flag or hook: the case uses `ark run step start` and the fake Orca that `ARK-T214` already uses.
