---
id: ARK-T746
title: ARK-T746 an ark process started by the test helper waits up to 60 s for an Orca read, so ark companion advise succeeds when the fake orca answers run-list after 12 s
level: integration
technique: boundary values (a run-list answer at 12 s, past the 10 s production limit and inside the 60 s test limit)
priority: high
risk: "the ark process that spawnArk of test/helpers.ts starts keeps the 10 s production Orca limit (orcaTimeout), because the helper raises only ARK_READER_TIMEOUT_MS, so on a loaded host ARK-T659 (ark companion advise) and ARK-T669 (ark chief state) fail with Orca did not answer or timed out after 10 s and pass on the retry; or the default is set but lost when process.env has no ARK_ORCA_TIMEOUT_MS"
status: active
changed_by: 2026-11-20-ARK-612-1
---

## Objective

Prove AC1 of ARK-612 at the real boundary: the `ark` process that `spawnArk` of `test/helpers.ts` starts (through `ark()`, here `arkP` of `test/companions-fixtures.ts`) gets an Orca limit of 60 s without the test setting `ARK_ORCA_TIMEOUT_MS`. `ark companion advise` reads `run-list` through `readTerminals` (`cli/orca.ts`), whose limit is `orcaTimeout(10_000)`. Against a fake orca that answers `run-list` after 12 s, the command still sends the advice and exits 0.

Before the fix the read is cut at 10 s and the command exits 1 with `Orca did not answer`: the case fails on the baseline for the reason the ticket names.

Expected: When a test starts an ark process through the test helper and does not set `ARK_ORCA_TIMEOUT_MS`, the system shall wait up to 60 s for an Orca read.

## Preconditions

- The advice project of ARK-T659 in `test/companions.test.ts` (`adviceProject`): companion `cortana`, the open run R1 with a live lead `term_lead1`, the live Master Chief terminal `term_chief`, the fake orca and gh of `test/fake-companion-tools.ts`.
- The existing opt-in settings of the fake: `hangVerbs: ["run-list"]` and `hangMilliseconds: 12000`. The fake pauses 12 s, appends the call to `hung-done.jsonl`, then answers `run-list` as usual. `advise` reads `run-list` once (`liveChiefOf`; `readChiefWorkers` gets the runs it read), so the command waits for one hung call. `terminal list` does not hang; it goes through the reader limit (30 s from `spawnArk`).
- `ARK_ORCA_TIMEOUT_MS` is not set in `process.env` of the test process: the test asserts it before the step, so a value left by the runner or an earlier test cannot make the case pass.
- The test file's default timeout of 90 s (`setDefaultTimeout(90_000)`) covers the 12 s wait.

## Steps

1. Configure the fake with `hangVerbs: ["run-list"]` and `hangMilliseconds: 12000`.
2. Run `ark companion advise cortana <R1> <advice> --project <project>` through `arkP`. Read the exit code, stdout, stderr, the messages the fake delivered and `hung-done.jsonl`.

## Expected results

- Exit code 0; stderr empty, so it holds no `Orca did not answer`.
- The fake delivered the advice to `term_lead1` and one copy to `term_chief` (two sends).
- `hung-done.jsonl` holds the `run-list` call: the 12 s pause ran to its end and the command waited for its answer, so the delay was real and past the 10 s production limit.
- The case does not assert the subject, type or body of the sends: ARK-T659 owns them.

## Screenshot checkpoints

none: a CLI case with a fake orca; there is no UI surface.
