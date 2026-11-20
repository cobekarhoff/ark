---
id: ARK-T740
title: ARK-T740 a quick ark test --keep-going on a suite with changed_command keeps a bug run's red proof, and an AC test outside the affected set reads not run with no false hint
level: integration
technique: equivalence classes of quick-run criterion status (every AC failing in the affected set, one AC test outside it) over the readers of the quick head run (caseStatus, quickStatus, the red proof gate)
priority: high
risk: the quick branch with `changed_command` does not set the file-selection flag, so an AC whose test is outside the affected set reads `missing` and prints `no test title starts with <id>` although the test exists; or a validator's new failing tests are not selected by `--changed` and the bug run's red proof reads `not run` and the implementer cannot start; or an AC test outside the affected set reads `failing` or `passing` and is accepted as proof that never ran
status: active
changed_by: 2026-11-20-ARK-580-1
---

## Objective

Prove that for a suite with `changed_command` a quick `ark test <run> --quick --keep-going` in a bug run records every AC whose test is in the affected set as `failing` (the red proof of ARK-T720 holds), that an AC whose test is outside the affected set reads `not run` with `via <case> missing` and no `no test title starts with` hint, and that the quick run still gates nothing it did not run. Serves ARK-580/AC1.

Authoring gate:

1. Protects: the readers of a quick head run (the red-proof gate of `ark run step ... start`, `caseStatus`, `quickStatus`) with the new selection source.
2. Fails when: the `changed_command` branch of `cli/test-run.ts` leaves `fileSelection` unset (the false hint and `missing`), or `mode` is not `quick`, or the new files are not in the selection.
3. Existing proof misses it: ARK-T720 and ARK-T388 reach the readers with `base_files` selection only; the source of the selection is the new contract. This case adds the transport of the new key, not a second owner of the red-proof gate (ARK-T720) or the hint text (ARK-T388).
4. No test-only export, flag or hook: the case runs the real `ark` process against the fixture.

## Preconditions

- Fixture of ARK-T720 (`bugRun`, `kind: bug`, two criteria `AC1` and `AC2`, `FAKE-T1` and `FAKE-T2`, `installFakeOrca()`), with the e2e suite configured with a `changed_command` and no `base_files`. The `changed_command` is a stub that selects the files that the validator commit changed (read from `git diff --name-only {base}`) and runs only them, writing a JUnit report with `file` on each test.
- Fixture A: the validator commit adds `e2e.test.ts` with failing `FAKE-T1 ...` and `FAKE-T2 ...` tests; the check fails (the failure switch exists), as in ARK-T720.
- Fixture B: the validator commit changes `e2e.test.ts` (failing `FAKE-T1 ...`) and adds `other.test.ts` with a failing `FAKE-T2 ...`, but the stub selects `e2e.test.ts` only. The check passes.

## Steps

1. Fixture A. Run `ark test <run> --quick --keep-going`. Read the exit code, stdout and the last `test.completed`. Then run `ark run step <run> build start`.
2. Fixture B (fresh run). Run `ark test <run> --quick --keep-going`. Read stdout and the last `test.completed`. Then run `ark run step <run> build start`.

## Expected results

- Step 1: exit 1; `FAKE-1/AC1  failing` and `FAKE-1/AC2  failing`; `test.completed` has `mode: "quick"` and both criteria `failing`; `build` starts (exit 0).
- Step 2: exit 1; `FAKE-1/AC1` is `failing` and `FAKE-1/AC2` is `not run` with `via FAKE-T2 missing`; no `no test title starts with` line in stdout (a quick selection ran, so `missing` is not proven); `ark run step <run> build start` exits 1 with the bug-run refusal, and no `step.started` is recorded for `build`.
- This case does not assert the refusal wording beyond ARK-T720's, or the files line (ARK-T737).

## Screenshot checkpoints

none: CLI and event-log case; no UI surface.
